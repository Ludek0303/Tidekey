// pdf.js binary data (CMaps, standard fonts, wasm) inside the frame. The frame has no network, so each request
// becomes a file of the app's own asset list (PODGLAD-PLAN §2, vite-pdfjs.ts copies the files there).
import { ASSET_PATH } from "../../src/preview/protocol";

const DATA_FILE = /^pdfjs-(cmaps|fonts|wasm|icc)\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,99})$/;

/** The base URLs given to getDocument: pdf.js joins them with a file name, and the factory maps them to assets. */
export const PDFJS_DATA_URLS = {
  cMapUrl: "pdfjs-cmaps/",
  standardFontDataUrl: "pdfjs-fonts/",
  wasmUrl: "pdfjs-wasm/",
  iccUrl: "pdfjs-icc/",
} as const;

/** The asset path of a pdf.js data URL ("pdfjs-cmaps/x.bcmap" → "assets/pdfjs-cmaps-x.bcmap"); null for anything else. */
export function assetPathFor(url: string): string | null {
  const m = DATA_FILE.exec(url);
  if (!m) return null;
  const path = `assets/pdfjs-${m[1]}-${m[2]}`;
  return ASSET_PATH.test(path) ? path : null;
}

/**
 * The binary data factory pdf.js calls on the frame's thread (useWorkerFetch: false): each request is answered
 * with the app's asset of the same name.
 */
export function pdfBinaryFactory(asset: (path: string) => Promise<ArrayBuffer>) {
  return class PdfBinaryData {
    constructor(private readonly urls: Record<string, string | null | undefined>) {}

    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const base = this.urls[kind];
      const path = base ? assetPathFor(base + filename) : null;
      if (!path) throw new Error(`Nieznany zasób pdf.js: ${kind}`);
      return new Uint8Array(await asset(path));
    }
  };
}
