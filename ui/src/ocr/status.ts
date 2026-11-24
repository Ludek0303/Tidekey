// What the app shows of OCR work (docs/OCR.md §3.6): one status per file, the page progress of the running file, the
// pause and the hardware line. Plain state plus bus events (bus.ts): the queue (queue.ts) writes it, the Files tab, the
// preview's "Tekst" tab and the status bar read it. Imports nothing heavy, so the main bundle stays small.
import { emit, on } from "../bus";
import type { TextLayerInfo } from "../remotefiles";

export type OcrStatus = "tekst" | "w kolejce" | "rozpoznawanie" | "czeka na komputer autora" | "brak tekstu" | "zabezpieczony" | "błąd";
export interface OcrProgress { page: number; pages: number }

/** The types the queue recognizes (OCR §2). Other files get no status. */
export const RECOGNIZABLE_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff", "image/heic", "image/heif"];
export const isRecognizable = (mime: string): boolean => RECOGNIZABLE_MIME.includes(mime);

const LABEL: Record<OcrStatus, string> = {
  tekst: "rozpoznany",
  "w kolejce": "w kolejce",
  rozpoznawanie: "rozpoznawanie",
  "czeka na komputer autora": "czeka na komputer autora",
  "brak tekstu": "brak tekstu",
  zabezpieczony: "zabezpieczony",
  błąd: "błąd",
};

/** The status a finished layer shows: its flags first, then its method. */
export function statusOfLayer(layer: Pick<TextLayerInfo, "flags" | "method">): OcrStatus {
  if (layer.flags.includes("zabezpieczony")) return "zabezpieczony";
  if (layer.flags.includes("błąd")) return "błąd";
  if (layer.flags.includes("brak tekstu") || layer.method === "none") return "brak tekstu";
  return "tekst";
}

/** The badge's words; a running file says which page it is on. */
export function badgeText(status: OcrStatus, progress?: OcrProgress): string {
  if (status === "rozpoznawanie" && progress) return `rozpoznawanie s. ${progress.page} z ${progress.pages}`;
  return LABEL[status];
}

export interface OcrStatusEvent { fileId: string; status: OcrStatus | null; detail: string }

export class OcrBoard {
  /** This user may recognize (editor or higher, or the demo). The Files tab and the preview offer it only then. */
  writable = false;
  paused = false;
  /** The measurement line of the settings ("Wykrywanie: …"); "" until a measurement exists. */
  hardware = "";
  private statuses = new Map<string, { status: OcrStatus; detail: string }>();
  private progress = new Map<string, OcrProgress>();

  statusOf(fileId: string): OcrStatus | null {
    return this.statuses.get(fileId)?.status ?? null;
  }

  detailOf(fileId: string): string {
    return this.statuses.get(fileId)?.detail ?? "";
  }

  progressOf(fileId: string): OcrProgress | undefined {
    return this.progress.get(fileId);
  }

  /** The file being recognized now, or null. */
  running(): string | null {
    for (const [id, s] of this.statuses) if (s.status === "rozpoznawanie") return id;
    return null;
  }

  queued(): number {
    return [...this.statuses.values()].filter((s) => s.status === "w kolejce").length;
  }

  set(fileId: string, status: OcrStatus, detail = ""): void {
    this.statuses.set(fileId, { status, detail });
    if (status !== "rozpoznawanie") this.progress.delete(fileId);
    emit("ocr:status", { fileId, status, detail } satisfies OcrStatusEvent);
  }

  clear(fileId: string): void {
    this.statuses.delete(fileId);
    this.progress.delete(fileId);
    emit("ocr:status", { fileId, status: null, detail: "" } satisfies OcrStatusEvent);
  }

  /** A page of the running file is done (not announced: the status bar shows it, the screen reader does not hear each page). */
  setProgress(fileId: string, page: number, pages: number): void {
    this.progress.set(fileId, { page, pages });
    emit("ocr:progress", { fileId, page, pages });
  }

  setLayer(layer: TextLayerInfo): void {
    this.set(layer.textOf, statusOfLayer(layer));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    emit("ocr:paused", { paused });
  }

  setHardware(line: string): void {
    this.hardware = line;
    emit("ocr:hardware", { line });
  }

  reset(): void {
    this.writable = false;
    this.paused = false;
    this.hardware = "";
    this.statuses.clear();
    this.progress.clear();
  }
}

export const ocrBoard = new OcrBoard();

/** Asks the queue to recognize a file now (editor or higher; the queue refuses otherwise). */
export function requestRecognize(fileId: string): void {
  emit("ocr:recognize", { fileId });
}

/** The settings' "Wstrzymaj" and "Zmierz ponownie" (service.ts does them). */
export function requestPause(paused: boolean): void {
  emit("ocr:pause", { paused });
}
export function requestMeasure(): void {
  emit("ocr:measure");
}

/** The part of a measurement the line shows (engine.ts's Measurement has these fields; no import, so the settings do not load the engine). */
export interface HardwareSummary { det: "webgpu" | "wasm"; rec: "webgpu" | "wasm"; msPerPage: number }

/** The measurement as the settings show it: which path finds the lines and which one reads them (OCR §3.6). */
export function hardwareLine(m: HardwareSummary | null): string {
  if (!m) return "";
  const who = (p: "webgpu" | "wasm") => (p === "webgpu" ? "karta graficzna" : "procesor");
  const seconds = (m.msPerPage / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 });
  return `Wykrywanie: ${who(m.det)}, rozpoznawanie: ${who(m.rec)}, ok. ${seconds} s na stronę`;
}

/** The status line under the editor: "Rozpoznawanie tekstu: strona 3 z 12" while a file runs. Hidden when idle. */
export function mountOcrStatus(host: HTMLElement): HTMLElement {
  const line = document.createElement("span");
  line.id = "ocr-status";
  line.hidden = true;
  host.insertBefore(line, host.querySelector("#words"));
  const draw = (): void => {
    const id = ocrBoard.running();
    const progress = id ? ocrBoard.progressOf(id) : undefined;
    const queued = ocrBoard.queued();
    let text = "";
    if (id) text = progress ? `Rozpoznawanie tekstu: strona ${progress.page} z ${progress.pages}` : "Rozpoznawanie tekstu…";
    else if (ocrBoard.paused && queued) text = `Rozpoznawanie tekstu wstrzymane (w kolejce: ${queued})`;
    else if (queued) text = `Tekst w kolejce: ${queued}`;
    line.textContent = text;
    line.hidden = text === "";
  };
  for (const name of ["ocr:status", "ocr:progress", "ocr:paused"]) on(name, draw);
  return line;
}
