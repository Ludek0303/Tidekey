// The pdf.js worker in the frame (PODGLAD-PLAN §2). A classic worker from a blob: URL when the browser runs one;
// otherwise the same code runs on the frame's own thread, where pdf.js finds it through globalThis.pdfjsWorker.
// The legacy build: it carries the polyfills pdf.js 6 needs (Map.getOrInsertComputed, Math.sumPrecise…) that current
// browsers lack; without them text falls back to a system font with the wrong glyphs.
import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerModule from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw";

const MODULE_EXPORT = /\s*export\s*\{\s*WorkerMessageHandler\s*\}\s*;?\s*$/;

/** The worker module as a classic script: the trailing export is cut and import.meta.url becomes the script's own URL. */
export function classicWorkerSource(moduleSource: string): string {
  return moduleSource.replace(MODULE_EXPORT, "").replaceAll("import.meta.url", "self.location.href");
}

export interface PdfWorkerHandle {
  /** The web worker; the viewer releases it when the file closes. */
  worker: Worker;
  /** The pdf.js side of the same worker, passed to getDocument. */
  pdf: PdfJs.PDFWorker;
}

/** A pdf.js worker for this file, or null when the frame runs the worker code on its own thread. */
export async function startPdfWorker(
  pdfjs: typeof PdfJs,
  spawn: (source: string) => Promise<Worker | null>,
): Promise<PdfWorkerHandle | null> {
  const worker = await spawn(classicWorkerSource(pdfWorkerModule));
  if (worker) return { worker, pdf: pdfjs.PDFWorker.create({ port: worker }) };
  // no worker here (WebKit): the import sets globalThis.pdfjsWorker, which getDocument then uses as a fake worker
  // the build has no types; the module is loaded only for its side effect
  // @ts-expect-error pdf.js ships the worker build without type declarations
  await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
  return null;
}
