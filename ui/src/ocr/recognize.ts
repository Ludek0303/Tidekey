// One file's text layer from its plain bytes (docs/OCR.md §2.3, §3.4, §3.5): the sandboxed frame reads the file into
// page texts and page pixels, the OCR worker reads the pixels, every page is cleaned and the whole layer checked
// (validate.ts) before anything is written. Only this module joins the three; it never logs or reports page text.
import type { ExtractOptions } from "./protocol";
import type { ExtractFile, ExtractPage, ExtractResult } from "./extracthost";
import type { PageResult } from "./engine";
import { EXTRACTOR_VERSION, parse, type FileTextDoc, type FileTextPage, type Flag, type Method } from "./filetext";
import { cleanPageText, finalizeLayer } from "./validate";
import type { TextLayerFields } from "../remotefiles";

/** A page below this quality is marked "niska jakość" (OCR §2.3). */
export const LOW_QUALITY = 0.6;
// Error codes of the frame that are a property of the file: a layer with the flag is written, so the file is not read
// again. Anything else ("timeout", "unavailable", "protocol", an OCR worker failure) writes nothing: the next run tries
// again, because the layer's id is fixed and a written "błąd" would stay until an admin removes it.
const LASTING: Record<string, Flag> = { encrypted: "zabezpieczony", corrupt: "błąd", unsupported: "błąd", "too-large": "błąd" };

export interface RecognizeDeps {
  extract(file: ExtractFile, options: ExtractOptions, onPage: (page: ExtractPage) => Promise<void>, signal?: AbortSignal): Promise<ExtractResult>;
  ocr(bitmap: ImageBitmap, signal?: AbortSignal): Promise<PageResult>;
  now(): Date;
}

export interface RecognizeInput { originalId: string; name: string; mime: string; bytes: ArrayBuffer }
export interface RecognizeProgress { page: number; pages: number }
export interface Recognized { markdown: string; fields: TextLayerFields }

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";
// the engine string is checked by every reader (at most 200 characters): only known names go in
const providerName = (p: unknown): string => (p === "webgpu" || p === "wasm" ? p : "?");
const PDF = "application/pdf";

/**
 * The text layer of one file, ready for `RemoteFileStore.writeTextLayer`. Rejects with AbortError when the signal
 * fires and with the frame's code on a passing failure ("timeout"); anything lasting becomes a layer with a flag.
 * The bytes are transferred to the frame.
 */
export async function recognizeFile(
  input: RecognizeInput,
  options: ExtractOptions,
  deps: RecognizeDeps,
  onProgress?: (p: RecognizeProgress) => void,
  signal?: AbortSignal,
): Promise<Recognized> {
  const pages: FileTextPage[] = [];
  const weights: { quality: number; length: number }[] = [];
  const flags = new Set<Flag>();
  let fromText = 0;
  let fromOcr = 0;
  let engine = "";
  let result: ExtractResult | null = null;

  const onPage = async (page: ExtractPage): Promise<void> => {
    onProgress?.({ page: page.page, pages: page.pages });
    let text: string | null;
    let quality = 1;
    if (page.bitmap) {
      fromOcr++;
      let read: PageResult;
      try {
        read = await deps.ocr(page.bitmap, signal);
      } catch (error) {
        // a fixed message: only the frame's codes may decide what is lasting, and nothing the worker says goes on
        if (isAbort(error)) throw error;
        throw new Error("ocr");
      } finally {
        // a no-op once the worker has it; frees the pixels when OCR failed before taking them
        page.bitmap.close();
      }
      engine = `pp-ocrv5 det:${providerName(read.provider?.det)} rec:${providerName(read.provider?.rec)}`;
      quality = Number.isFinite(read.quality) ? Math.min(1, Math.max(0, read.quality)) : 0;
      text = read.noText ? "" : cleanPageText(Array.isArray(read.lines) ? read.lines.filter((l) => typeof l === "string").join("\n") : null);
    } else {
      fromText++;
      text = cleanPageText(page.text);
    }
    if (text === null) {
      flags.add("błąd");
      text = "";
    }
    pages.push({ n: page.page, text, lowQuality: text !== "" && quality < LOW_QUALITY });
    weights.push({ quality, length: text.length });
  };

  try {
    result = await deps.extract({ mime: input.mime, bytes: input.bytes }, options, onPage, signal);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (isAbort(error) || !Object.hasOwn(LASTING, code)) throw error;
    // the pages read before the failure stay
    flags.add(LASTING[code]);
  }
  if (result?.truncated) flags.add("ucięte");

  const anyText = pages.some((p) => p.text !== "");
  if (!anyText && !flags.has("zabezpieczony") && !flags.has("błąd")) flags.add("brak tekstu");
  const method: Method = !anyText ? "none" : fromOcr === 0 ? "pdf-text" : fromText === 0 ? "ocr" : "mixed";
  const length = weights.reduce((sum, w) => sum + w.length, 0);
  const quality = length === 0 ? 0 : weights.reduce((sum, w) => sum + w.quality * w.length, 0) / length;
  const doc: FileTextDoc = {
    source: input.originalId, name: input.name, mime: input.mime, method, pages, lang: "latin",
    quality: Math.round(quality * 100) / 100, flags: [...flags], extractor: EXTRACTOR_VERSION,
    engine: [fromText ? "pdf.js" : "", fromOcr ? engine || "pp-ocrv5" : ""].filter(Boolean).join(" + ") || "none",
    createdAt: deps.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(input.mime !== PDF && pages.length === 1 ? { image: true } : {}),
  };
  // aborted after the last page: nothing to write
  signal?.throwIfAborted();
  const markdown = finalizeLayer(doc);
  // the fields come from what was written: finalizeLayer may add "ucięte"
  const written = parse(markdown);
  if (!written) throw new Error("błąd");
  return {
    markdown,
    fields: {
      extractor: written.extractor, method: written.method, pages: written.pages.length, lang: "latin",
      quality: written.quality, flags: [...written.flags], engine: written.engine,
    },
  };
}
