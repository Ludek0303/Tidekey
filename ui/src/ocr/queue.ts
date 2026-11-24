// The OCR queue of one user (docs/OCR.md §3.4, §2.4): one file at a time, the newest uploads first, OCR pages only
// on a device that may run them, and nothing written for a job that did not finish. The frame, the engine, the store,
// the clock and the pacing come in through `QueueDeps` (service.ts passes the real ones, the tests pass fakes).
import { DEFAULT_EXTRACT_OPTIONS, type ExtractOptions } from "./protocol";
import type { ExtractFile, ExtractPage, ExtractResult } from "./extracthost";
import type { Measurement, PageResult } from "./engine";
import { recognizeFile, type Recognized, type RecognizeDeps } from "./recognize";
import { EXTRACTOR_VERSION } from "./filetext";
import { isRecognizable, ocrBoard } from "./status";
import type { FileInfo, FileStore, TextLayers } from "../filestore";
import type { TextLayerInfo } from "../remotefiles";

/** Files the scan at start recognizes on its own; larger ones only by hand (OCR §3.4). */
export const AUTO_MAX_BYTES = 50 * 1024 * 1024;
/** A device this slow per page (the reference page, OCR §2.2) or with this little memory (GB) waits (OCR §3.4). */
export const SLOW_MS_PER_PAGE = 20_000;
export const LOW_MEMORY_GB = 4;

/** The settings the queue reads on each job (settings.ts). */
export interface OcrPrefs { enabled: boolean; onThisDevice: boolean; legacy: boolean; maxPages: number }

/** The part of OcrEngine the queue uses (engine.ts's class has all of it). */
export interface PageEngine {
  recognize(bitmap: ImageBitmap, signal?: AbortSignal): Promise<PageResult>;
  measure(signal?: AbortSignal): Promise<Measurement>;
  current(): Measurement | null;
  release(): void;
}

export interface QueueDeps {
  store: FileStore & TextLayers;
  /** This user's id: the scan at start takes the files this user created. */
  me: string | null;
  /** Editor or higher (or the demo). Without it the queue never writes. */
  writable: boolean;
  prefs(): OcrPrefs;
  extract: RecognizeDeps["extract"];
  engine(): Promise<PageEngine>;
  /** A short quiet time before the next page: idle callback and no typing or fast scrolling (service.ts). */
  pace(): Promise<void>;
  /** navigator.deviceMemory in GB, when the browser gives it. */
  memory(): number | undefined;
  now?(): Date;
}

type Source = "upload" | "scan" | "manual";
interface Job { info: FileInfo; source: Source; file?: File }

/** The weak-device rule (OCR §3.4): measured slower than the limit, or little memory. */
export function isWeakDevice(m: Pick<Measurement, "msPerPage">, memory: number | undefined): boolean {
  return m.msPerPage > SLOW_MS_PER_PAGE || (memory !== undefined && memory <= LOW_MEMORY_GB);
}

// Thrown by the OCR step of a deferred job; not an abort of the user, so it is told apart by name here only.
const DEFERRED = "deferred";

export class OcrQueue {
  private readonly jobs: Job[] = [];
  // Automatic jobs that already started in this session: a failure is not tried again until the next start.
  private readonly tried = new Set<string>();
  private layers = new Map<string, TextLayerInfo>();
  private running = false;
  private closed = false;
  private paused = false;
  private gateOpen: Promise<void> = Promise.resolve();
  private openGate: () => void = () => undefined;
  private current: AbortController | null = null;
  // the file being recognized now (its id), so a manual request for it is not queued again
  private active: string | null = null;
  private engineP: Promise<PageEngine> | null = null;

  constructor(private readonly deps: QueueDeps) {}

  /** Reads the layers (the status of every file that has one) and queues this user's files that have none yet. */
  async start(): Promise<void> {
    const layers = await this.deps.store.textLayers();
    if (this.closed) return;
    this.layers = layers;
    for (const layer of layers.values()) ocrBoard.setLayer(layer);
    const prefs = this.deps.prefs();
    if (!prefs.enabled || !prefs.legacy || !this.deps.writable) return;
    const { files } = await this.deps.store.list();
    for (const info of files) {
      if (info.createdBy !== this.deps.me || info.state !== "ready" || !isRecognizable(info.mime) || info.size > AUTO_MAX_BYTES) continue;
      if (!this.hasLayer(info.id)) this.add({ info, source: "scan" }, "back");
    }
    this.kick();
  }

  /** A file of this user was uploaded: its own bytes are recognized, no download (newest first). */
  uploaded(info: FileInfo, file: File): void {
    if (!isRecognizable(info.mime) || this.hasLayer(info.id)) return;
    this.add({ info, source: "upload", file }, "front");
    this.kick();
  }

  /** "Rozpoznaj tekst" by hand, for any file the queue knows. False when OCR is switched off or the type is not supported. */
  request(info: FileInfo): boolean {
    if (!this.deps.writable || !this.deps.prefs().enabled || !isRecognizable(info.mime) || info.state !== "ready") return false;
    if (!this.hasLayer(info.id) && info.id !== this.active) this.add({ info, source: "manual" }, "front");
    this.kick();
    return true;
  }

  /** The user's pause ("Wstrzymaj"): the page in progress finishes, the next one waits for resume. */
  pause(on: boolean): void {
    if (on && !this.paused) {
      this.paused = true;
      this.gateOpen = new Promise<void>((resolve) => { this.openGate = resolve; });
    } else if (!on && this.paused) {
      this.paused = false;
      this.openGate();
    }
    ocrBoard.setPaused(this.paused);
  }

  /** Vault closed: the job in progress is dropped, the queued ones cleared, the engine released. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.splice(0)) ocrBoard.clear(job.info.id);
    this.current?.abort();
    this.pause(false);
    if (this.engineP) void this.engineP.then((e) => e.release(), () => undefined);
  }

  private hasLayer(id: string): boolean {
    return (this.layers.get(id)?.extractor ?? 0) >= EXTRACTOR_VERSION;
  }

  private add(job: Job, where: "front" | "back"): void {
    if (this.closed || !this.deps.writable) return;
    if (job.source !== "manual" && this.tried.has(job.info.id)) return;
    const at = this.jobs.findIndex((j) => j.info.id === job.info.id);
    if (at >= 0) {
      // already queued: an upload keeps its bytes; a manual request moves it to the front
      if (where === "front") this.jobs.unshift(...this.jobs.splice(at, 1));
      return;
    }
    if (where === "front") this.jobs.unshift(job);
    else this.jobs.push(job);
    ocrBoard.set(job.info.id, "w kolejce");
  }

  private kick(): void {
    if (this.running || this.closed) return;
    this.running = true;
    void this.drain().finally(() => { this.running = false; });
  }

  private async drain(): Promise<void> {
    while (this.jobs.length > 0 && !this.closed) {
      await this.gateOpen;
      const job = this.jobs.shift();
      if (!job || this.closed) break;
      // switched off while it waited: nothing runs
      if (!this.deps.prefs().enabled) {
        ocrBoard.clear(job.info.id);
        continue;
      }
      await this.runJob(job);
    }
  }

  private async runJob(job: Job): Promise<void> {
    const id = job.info.id;
    if (job.source !== "manual") this.tried.add(id);
    ocrBoard.set(id, "rozpoznawanie");
    const ctl = new AbortController();
    this.current = ctl;
    this.active = id;
    let deferred = false;
    let writing = false;
    try {
      const bytes = job.file ? await job.file.arrayBuffer() : await (await this.deps.store.read(id, { signal: ctl.signal })).arrayBuffer();
      const result = await this.recognize(job, bytes, ctl.signal, () => { deferred = true; });
      writing = true;
      const layerId = await this.deps.store.writeTextLayer(id, result.markdown, result.fields, ctl.signal);
      const layer: TextLayerInfo = { ...result.fields, flags: [...result.fields.flags], id: layerId, textOf: id, createdAt: Date.now(), createdBy: this.deps.me };
      this.layers.set(id, layer);
      ocrBoard.setLayer(layer);
    } catch (error) {
      if (deferred) ocrBoard.set(id, "czeka na komputer autora");
      else if (ctl.signal.aborted) ocrBoard.clear(id);
      else if (writing) ocrBoard.set(id, "błąd", error instanceof Error ? error.message : "Nie udało się zapisać tekstu.");
      else ocrBoard.set(id, "błąd", "Nie udało się rozpoznać tekstu.");
    } finally {
      this.current = null;
      this.active = null;
    }
  }

  // The layer of one file. Automatic jobs leave OCR pages for a weak device when the settings say so: the first OCR
  // page asks the engine, and then the job stops with nothing written (`onDeferred` tells the caller why).
  private recognize(job: Job, bytes: ArrayBuffer, signal: AbortSignal, onDeferred: () => void): Promise<Recognized> {
    const options: ExtractOptions = { ...DEFAULT_EXTRACT_OPTIONS, maxPages: this.deps.prefs().maxPages };
    let slow: boolean | null = null;
    const deps: RecognizeDeps = {
      extract: (file: ExtractFile, opts: ExtractOptions, onPage: (page: ExtractPage) => void | Promise<void>, sig?: AbortSignal): Promise<ExtractResult> =>
        this.deps.extract(file, opts, async (page) => {
          await this.gate();
          await onPage(page);
        }, sig),
      ocr: async (bitmap, sig) => {
        const engine = await this.engine();
        if (job.source !== "manual" && !this.deps.prefs().onThisDevice) {
          slow ??= isWeakDevice(engine.current() ?? (await engine.measure(sig)), this.deps.memory());
          if (slow) {
            bitmap.close();
            onDeferred();
            throw new DOMException(DEFERRED, "AbortError");
          }
        }
        return engine.recognize(bitmap, sig);
      },
      now: () => this.deps.now?.() ?? new Date(),
    };
    return recognizeFile({ originalId: job.info.id, name: job.info.name, mime: job.info.mime, bytes }, options, deps, (p) => ocrBoard.setProgress(job.info.id, p.page, p.pages), signal);
  }

  private async gate(): Promise<void> {
    await this.gateOpen;
    await this.deps.pace();
  }

  private engine(): Promise<PageEngine> {
    this.engineP ??= this.deps.engine();
    return this.engineP;
  }
}
