// The extractor frame (docs/OCR-PLAN.md §4.1, OCR §3.5): reads the one file the app sends and answers page by page, with
// the text of a PDF page or the page drawn as pixels for OCR in the app's worker. It gets bytes only: no key, id, token or
// network. Parsing untrusted files happens here, in the sandbox. Decoders are the preview's own (pdf.js, UTIF, libheif).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import UTIF, { type Ifd } from "utif";
import {
  EXTRACT_PROTOCOL, MAX_EXTRACT_TEXT_BYTES, isToExtractor, type ExtractErrorCode, type ExtractOptions,
  type FromExtractor, type ToExtractor,
} from "../../src/ocr/protocol";
import { imageSize } from "./imagesize";
import { lgplAssetPath, loadLgplScript } from "./lgpl";
import { pdfBinaryFactory, PDFJS_DATA_URLS } from "./pdfdata";
import { startPdfWorker, type PdfWorkerHandle } from "./pdfworker";
import { pageRuns, pageText, textVerdict, type TextRun } from "./pdftext";
import { checkTiffPage, readTiffIfds, TiffError } from "./tiffguard";
import { releaseWorker, spawnWorker } from "./worker";

// No WebRTC in the frame. Module code runs before any message is handled, so nothing parses a file while these exist.
const frameGlobals = globalThis as unknown as Record<string, unknown>;
for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
  delete frameGlobals[name];
  if (name in frameGlobals) Object.defineProperty(frameGlobals, name, { value: undefined, configurable: true, writable: true });
}

// The frame has an opaque origin (location.origin reads "null"), so the server's address comes from this module's URL.
const SERVER = new URL(import.meta.url).origin;
const PAGE_TIMEOUT_MS = 60_000;
const PDF = "application/pdf";
const TIFF = "image/tiff";
const HEIC = new Set(["image/heic", "image/heif"]);
const PICTURE = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"]);

type ExtractMsg = Extract<ToExtractor, { type: "extract" }>;
type PageOut = Omit<Extract<FromExtractor, { type: "page" }>, "type" | "v" | "jobId">;
// `resume` is set while the job waits for the app's `next` after a page (flow control, docs/OCR-PLAN.md §4.1).
interface Job { id: number; cancelled: boolean; resume: (() => void) | null }
interface Done { pages: number; truncated: boolean }
interface Ctx { job: Job; options: ExtractOptions; emit(page: PageOut): Promise<void> }

/** A failure with the code the app receives. Anything else thrown while reading a file is "corrupt". */
class Fail extends Error {
  constructor(readonly code: ExtractErrorCode) {
    super(code);
  }
}
/** The job was cancelled: it stops without another message. */
class Stop extends Error {}

const post = (m: FromExtractor, transfer: Transferable[] = []): void => window.parent.postMessage(m, SERVER, transfer);

let job: Job | null = null;
// Assets the app could not give: a job that fails after one did reports "unavailable", not the file's fault.
let assetFailures = 0;
// Asset answers in the order they were asked for, per path (the app answers each request once).
const waiting = new Map<string, ((bytes: ArrayBuffer | null) => void)[]>();

/** pdf.js data and libheif come from the app's own asset list: the frame has no network to fetch them. */
function asset(path: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const list = waiting.get(path) ?? [];
    list.push((bytes) => {
      if (bytes) return resolve(bytes);
      assetFailures++;
      reject(new Error("asset"));
    });
    waiting.set(path, list);
    post({ type: "asset", v: EXTRACT_PROTOCOL, path });
  });
}

const check = (job: Job): void => {
  if (job.cancelled) throw new Stop();
};

/** Work on one page or image: a page that takes longer than PAGE_TIMEOUT_MS fails the job with "timeout". */
function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Fail("timeout")), PAGE_TIMEOUT_MS);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

function checkPixels(width: number, height: number, maxPixels: number): void {
  if (width <= 0 || height <= 0) throw new Fail("corrupt");
  if (width * height > maxPixels) throw new Fail("too-large");
}

/** The text capped at the 2 MB of the protocol; `cut` tells the job that the file's text was cut. */
function capText(text: string): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_EXTRACT_TEXT_BYTES) return { text, cut: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, MAX_EXTRACT_TEXT_BYTES)).replace(/�$/u, ""), cut: true };
}

// ---- PDF ----

function openPdf(bytes: ArrayBuffer, handle: PdfWorkerHandle | null, options: ExtractOptions): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    worker: handle?.pdf,
    BinaryDataFactory: pdfBinaryFactory(asset),
    ...PDFJS_DATA_URLS,
    useWorkerFetch: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: true,
    // images above the pixel limit are not drawn; the canvas limit is RGBA bytes for the same pixels
    maxImageSize: options.maxPixels,
    canvasMaxAreaInBytes: 4 * options.maxPixels,
    verbosity: 0,
  });
}

/** The document of a loading task; no password is asked for, so an encrypted file is reported and not opened. */
async function loadPdf(task: pdfjs.PDFDocumentLoadingTask): Promise<pdfjs.PDFDocumentProxy> {
  try {
    return await task.promise;
  } catch (err) {
    throw new Fail(err instanceof pdfjs.PasswordException ? "encrypted" : "corrupt");
  }
}

/** The text layer of a page inside its box; `cut` when runs were dropped at the text limit. A page whose text cannot be read has none. */
async function textOf(page: pdfjs.PDFPageProxy): Promise<{ text: string; cut: boolean }> {
  try {
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      runs.push({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height });
    }
    const [x0, y0, x1, y1] = page.view;
    const kept = pageRuns(runs, { x0, y0, x1, y1 });
    return { text: pageText(kept.runs), cut: kept.cut };
  } catch {
    return { text: "", cut: false };
  }
}

/** The page drawn at the long side `renderLongSide`, and within `maxPixels`, as a bitmap for OCR. */
async function renderPage(page: pdfjs.PDFPageProxy, options: ExtractOptions): Promise<ImageBitmap> {
  const base = page.getViewport({ scale: 1 });
  if (base.width <= 0 || base.height <= 0) throw new Fail("corrupt");
  const scale = Math.min(options.renderLongSide / Math.max(base.width, base.height), Math.sqrt(options.maxPixels / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
  // no context or a failed bitmap is the device (out of memory), not the file: passing
  const g = canvas.getContext("2d");
  if (!g) throw new Fail("unavailable");
  // pdf.js types its target as DOM elements; an OffscreenCanvas and its context draw the same way. The print intent
  // draws without animation frames: a display render waits for them, and a hidden or background frame gets none.
  const target = {
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: g as unknown as CanvasRenderingContext2D,
    viewport,
    intent: "print" as const,
  };
  await page.render(target).promise;
  try {
    return canvas.transferToImageBitmap();
  } catch {
    throw new Fail("unavailable");
  }
}

async function pdfPage(page: pdfjs.PDFPageProxy, n: number, pages: number, options: ExtractOptions): Promise<PageOut & { cut: boolean }> {
  try {
    const found = await textOf(page);
    const verdict = textVerdict(found.text);
    if (verdict === "ok") {
      const capped = capText(found.text);
      return { page: n, pages, text: capped.text, cut: capped.cut || found.cut };
    }
    const bitmap = await renderPage(page, options);
    return { page: n, pages, bitmap, reason: verdict === "garbled" ? "garbled" : "no-text", cut: false };
  } finally {
    page.cleanup();
  }
}

async function readPdf(ctx: Ctx, bytes: ArrayBuffer): Promise<Done> {
  const handle = await startPdfWorker(pdfjs, spawnWorker);
  let task: pdfjs.PDFDocumentLoadingTask | null = null;
  try {
    task = openPdf(bytes, handle, ctx.options);
    const doc = await loadPdf(task);
    const count = doc.numPages;
    if (count < 1) throw new Fail("corrupt");
    const pages = Math.min(count, ctx.options.maxPages);
    let truncated = count > pages;
    for (let n = 1; n <= pages; n++) {
      check(ctx.job);
      const { cut, ...out } = await within(doc.getPage(n).then((page) => pdfPage(page, n, pages, ctx.options)));
      truncated ||= cut;
      await ctx.emit(out);
    }
    return { pages, truncated };
  } finally {
    await task?.destroy();
    if (handle) releaseWorker(handle.worker);
  }
}

// ---- pictures ----

async function decodePicture(bytes: ArrayBuffer, mime: string, maxPixels: number): Promise<ImageBitmap> {
  const size = imageSize(new Uint8Array(bytes));
  if (!size) throw new Fail("corrupt");
  checkPixels(size.width, size.height, maxPixels);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: "from-image" }).catch(() => {
    throw new Fail("corrupt");
  });
  return checkBitmap(bitmap, maxPixels);
}

// The decoded size is checked too: the header says what was asked for, the decoder what was made.
function checkBitmap(bitmap: ImageBitmap, maxPixels: number): ImageBitmap {
  try {
    checkPixels(bitmap.width, bitmap.height, maxPixels);
  } catch (err) {
    bitmap.close();
    throw err;
  }
  return bitmap;
}

/** TIFF pages as the TIFF viewer finds them: the IFDs that carry an image. Every page is checked before any pixel is decoded. */
function tiffPages(bytes: ArrayBuffer, maxPages: number, maxPixels: number): { ifd: Ifd; width: number; height: number }[] {
  try {
    const pages: { ifd: Ifd; width: number; height: number }[] = [];
    for (const ifd of readTiffIfds(bytes, maxPages)) {
      const width = ifd.t256?.[0];
      const height = ifd.t257?.[0];
      if (!width || !height) continue;
      checkTiffPage(ifd, maxPixels);
      pages.push({ ifd, width, height });
    }
    if (pages.length === 0) throw new Fail("corrupt");
    return pages;
  } catch (err) {
    if (err instanceof TiffError) throw new Fail(err.code);
    throw err;
  }
}

async function decodeTiffPage(bytes: ArrayBuffer, page: { ifd: Ifd; width: number; height: number }, maxPixels: number): Promise<ImageBitmap> {
  const { ifd, width, height } = page;
  let rgba: Uint8Array;
  try {
    UTIF.decodeImage(bytes, ifd);
    rgba = UTIF.toRGBA8(ifd);
  } catch {
    throw new Fail("corrupt");
  } finally {
    ifd.data = undefined;
  }
  // a view, not a copy: the buffer is never shared, so the cast is safe
  const pixels = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
  return checkBitmap(await createImageBitmap(new ImageData(pixels, width, height)), maxPixels);
}

// The part of the libheif-js API used here (libheif-wasm/libheif.js of the package, version 1.23.5), as in heic.ts.
interface RgbaTarget { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }
interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(target: RgbaTarget, done: (out: RgbaTarget | null) => void): void;
  free(): void;
}
interface HeifDecoder { decoder: unknown; decode(bytes: Uint8Array): HeifImage[] }
interface LibHeif { HeifDecoder: new () => HeifDecoder; heif_context_free(context: unknown): void }
type LibHeifFactory = (options: { wasmBinary: ArrayBuffer }) => LibHeif;

async function decodeHeic(bytes: ArrayBuffer, maxPixels: number): Promise<ImageBitmap> {
  // The browser sniffs the real format, so a "HEIC" that is a PNG or JPEG bomb would be decoded in full by the native
  // path. Its header size is checked first; without a known size only libheif runs, and it reads the size before pixels.
  const size = imageSize(new Uint8Array(bytes));
  if (size) checkPixels(size.width, size.height, maxPixels);
  // the browser's own decoder first (Safari); elsewhere libheif, as the HEIC viewer does
  const native = size ? await createImageBitmap(new Blob([bytes], { type: "image/heic" })).catch(() => null) : null;
  if (native) return checkBitmap(native, maxPixels);
  await loadLgplScript("libheif").catch(() => {
    throw new Fail("unavailable");
  });
  const wasmBinary = await asset(lgplAssetPath("libheif", "libheif.wasm")).catch(() => {
    throw new Fail("unavailable");
  });
  const factory = (globalThis as { libheif?: unknown }).libheif;
  if (typeof factory !== "function") throw new Fail("unsupported");
  let heif: LibHeif;
  try {
    heif = (factory as LibHeifFactory)({ wasmBinary });
  } catch {
    throw new Fail("unsupported");
  }
  const decoder = new heif.HeifDecoder();
  let images: HeifImage[] = [];
  try {
    try {
      images = decoder.decode(new Uint8Array(bytes));
    } catch {
      throw new Fail("corrupt");
    }
    const image = images.find((i) => i.is_primary()) ?? images[0];
    if (!image) throw new Fail("corrupt");
    const width = image.get_width();
    const height = image.get_height();
    checkPixels(width, height, maxPixels);
    const target: RgbaTarget = { data: new Uint8ClampedArray(width * height * 4), width, height };
    const out = await new Promise<RgbaTarget | null>((resolve) => image.display(target, resolve));
    if (!out) throw new Fail("corrupt");
    return checkBitmap(await createImageBitmap(new ImageData(out.data, out.width, out.height)), maxPixels);
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) heif.heif_context_free(decoder.decoder);
  }
}

async function readPicture(ctx: Ctx, msg: ExtractMsg): Promise<Done> {
  const { maxPages, maxPixels } = ctx.options;
  if (PICTURE.has(msg.mime)) {
    const bitmap = await within(decodePicture(msg.bytes, msg.mime, maxPixels));
    check(ctx.job);
    await ctx.emit({ page: 1, pages: 1, bitmap });
    return { pages: 1, truncated: false };
  }
  if (HEIC.has(msg.mime)) {
    const bitmap = await within(decodeHeic(msg.bytes, maxPixels));
    check(ctx.job);
    await ctx.emit({ page: 1, pages: 1, bitmap });
    return { pages: 1, truncated: false };
  }
  if (msg.mime === TIFF) {
    const found = tiffPages(msg.bytes, maxPages, maxPixels);
    const pages = Math.min(found.length, maxPages);
    for (let n = 0; n < pages; n++) {
      check(ctx.job);
      const bitmap = await within(decodeTiffPage(msg.bytes, found[n], maxPixels));
      check(ctx.job);
      await ctx.emit({ page: n + 1, pages, bitmap });
    }
    return { pages, truncated: found.length > pages };
  }
  throw new Fail("unsupported");
}

// ---- the job ----

async function run(current: Job, msg: ExtractMsg): Promise<void> {
  // every page leaves through here: nothing goes out for a cancelled job, and its bitmaps are freed
  const ctx: Ctx = {
    job: current,
    options: msg.options,
    emit: (page) => {
      if (current.cancelled) {
        page.bitmap?.close();
        throw new Stop();
      }
      post({ type: "page", v: EXTRACT_PROTOCOL, jobId: current.id, ...page }, page.bitmap ? [page.bitmap] : []);
      // the next page is read only once the app has taken this one: rendering is faster than OCR
      return new Promise<void>((resolve) => { current.resume = resolve; }).then(() => check(current));
    },
  };
  const failuresBefore = assetFailures;
  try {
    const done = msg.mime === PDF ? await readPdf(ctx, msg.bytes) : await readPicture(ctx, msg);
    check(current);
    // pdf.js often survives a missing CMap or font with degraded text: a job that lost an asset never counts as done
    if (assetFailures > failuresBefore) throw new Fail("unavailable");
    post({ type: "done", v: EXTRACT_PROTOCOL, jobId: current.id, pages: done.pages, truncated: done.truncated });
  } catch (err) {
    if (err instanceof Stop || current.cancelled) return;
    current.cancelled = true;
    const code = assetFailures > failuresBefore ? "unavailable" : err instanceof Fail ? err.code : "corrupt";
    post({ type: "error", v: EXTRACT_PROTOCOL, jobId: current.id, code });
  }
}

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || e.origin !== SERVER) return;
  const msg: unknown = e.data;
  if (!isToExtractor(msg)) return;
  if (msg.type === "asset") {
    waiting.get(msg.path)?.shift()?.(msg.bytes);
    return;
  }
  if (msg.type === "cancel") {
    if (job?.id === msg.jobId) {
      job.cancelled = true;
      job.resume?.();
    }
    return;
  }
  if (msg.type === "next") {
    const go = job?.id === msg.jobId ? job.resume : null;
    if (job && go) {
      job.resume = null;
      go();
    }
    return;
  }
  // one job per frame: a new file replaces the one before it
  if (job) {
    job.cancelled = true;
    job.resume?.();
  }
  job = { id: msg.jobId, cancelled: false, resume: null };
  void run(job, msg);
});

post({ type: "ready", v: EXTRACT_PROTOCOL });
