// The OCR engine as the rest of the app sees it (OCR §2.2, OCR-PLAN §4.2). It owns one module worker that loads ONNX
// Runtime and the models only when first used, and it is released after an idle minute. Import it with a dynamic import.
import SUMS from "../../../vendor/ocr-models/SHA256SUMS?raw";
import { describeAdapter, GPU_FAILURE_LIMIT, isValid, ORT_VERSION, requestGpuAdapter, type Provider } from "./hw";
import type { FromOcrWorker, MeasureReply, OcrRequest, PageReply, ToOcrWorker } from "./workerproto";

export type { Provider } from "./hw";

export interface Measurement {
  det: Provider;
  rec: Provider;
  msPerPage: number;
  adapter: string;
  ortVersion: string;
  modelsSum: string;
  at: number;
  cpuOnly?: boolean;
  // GPU failures on pages since this measurement; at GPU_FAILURE_LIMIT, WebGPU is banned: `gpuBanned` is kept
  // with the measurement and only a new environment (ORT version, model sums, adapter, cpuOnly) clears it.
  gpuFailures?: number;
  gpuBanned?: boolean;
}
// fellBack: a GPU stage failed on this page and it was run again on wasm (the text is complete either way).
export type PageResult = PageReply;

export interface EngineOptions {
  cpuOnly?: () => boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  makeWorker?: () => Worker;
  idleMs?: number;
  // Test only: the first page's first WebGPU run throws. The app never passes it.
  faultInjection?: boolean;
}

const KEY = "notes.ocr.hw";
const MODELS_SUM = SUMS.trim();

interface Pending {
  w: Worker;
  resolve(v: unknown): void;
  reject(e: Error): void;
}

const abortError = () => new DOMException("aborted", "AbortError");

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    return localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

function parseMeasurement(s: string | null): Measurement | null {
  if (!s) return null;
  const v: unknown = JSON.parse(s);
  if (typeof v !== "object" || v === null) return null;
  const m = v as Partial<Measurement>;
  const isProvider = (x: unknown) => x === "webgpu" || x === "wasm";
  const ok =
    isProvider(m.det) &&
    isProvider(m.rec) &&
    typeof m.msPerPage === "number" &&
    typeof m.adapter === "string" &&
    typeof m.ortVersion === "string" &&
    typeof m.modelsSum === "string" &&
    typeof m.at === "number";
  return ok ? (m as Measurement) : null;
}

export class OcrEngine {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  // The adapter is asked once; until it is known, no measurement counts (recognize waits for it).
  private adapter: string | null = null;
  private readonly probing: Promise<void>;
  private readonly cpuOnly: () => boolean;
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  private readonly makeWorker: () => Worker;
  private readonly idleMs: number;
  private fault: boolean;

  constructor(opts: EngineOptions = {}) {
    this.cpuOnly = opts.cpuOnly ?? (() => false);
    this.storage = opts.storage ?? defaultStorage();
    this.makeWorker = opts.makeWorker ?? (() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
    this.idleMs = opts.idleMs ?? 60_000;
    this.fault = opts.faultInjection ?? false;
    this.probing = requestGpuAdapter().then((a) => {
      this.adapter = describeAdapter(a);
    });
  }

  /** The stored measurement when it is still valid (same ORT version, same model sums, same adapter, same cpuOnly), else null. */
  current(): Measurement | null {
    const m = this.read();
    if (!m || this.adapter === null) return null;
    return isValid(m, this.env()) ? m : null;
  }

  /** Measures now (built-in reference page) and stores the result under "notes.ocr.hw". */
  async measure(signal?: AbortSignal): Promise<Measurement> {
    await this.probing;
    const env = this.env();
    // A ban is kept only for the same environment; a stored ban for another adapter or version does not apply.
    const old = this.read();
    const banned = old !== null && isValid(old, env) && old.gpuBanned === true;
    const cpuOnly = this.cpuOnly();
    const r = await this.call<MeasureReply>({ type: "measure", webgpu: !cpuOnly && !banned }, [], signal);
    const m: Measurement = {
      det: r.det,
      rec: r.rec,
      msPerPage: r.msPerPage,
      adapter: r.adapter,
      ortVersion: ORT_VERSION,
      modelsSum: MODELS_SUM,
      at: Date.now(),
      cpuOnly,
      gpuFailures: 0,
      gpuBanned: banned || r.gpuRejected,
    };
    this.write(m);
    return m;
  }

  /** OCR of one page/image. Measures first when there is no valid measurement. The bitmap is transferred to the worker (the caller must not use it after). */
  async recognize(bitmap: ImageBitmap, signal?: AbortSignal): Promise<PageResult> {
    await this.probing;
    const m = this.current() ?? (await this.measure(signal));
    const fault = this.fault;
    this.fault = false;
    const r = await this.call<PageReply>({ type: "page", bitmap, det: m.det, rec: m.rec, fault }, [bitmap], signal);
    if (r.fellBack) {
      // The stage stays on wasm from now on; after GPU_FAILURE_LIMIT such pages WebGPU is banned for this environment.
      const s = this.read() ?? m;
      const failures = (s.gpuFailures ?? 0) + 1;
      this.write({
        ...s,
        det: r.provider.det,
        rec: r.provider.rec,
        gpuFailures: failures,
        gpuBanned: s.gpuBanned === true || failures >= GPU_FAILURE_LIMIT,
      });
    }
    return r;
  }

  /** Terminates the worker: sessions released, GPU device destroyed. Also called automatically after `idleMs` (60_000) without work. */
  release(): void {
    clearTimeout(this.idle);
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    // The worker answers `released` after its queue has run, and only then is it terminated.
    w.postMessage({ type: "release", id: this.nextId++ } satisfies ToOcrWorker);
  }

  private call<T>(req: OcrRequest, transfer: Transferable[], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const w = (this.worker ??= this.spawn());
    clearTimeout(this.idle);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = (settle: () => void) => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        settle();
        if (this.pending.size === 0) this.idle = setTimeout(() => this.release(), this.idleMs);
      };
      const onAbort = () => {
        w.postMessage({ type: "cancel", id } satisfies ToOcrWorker);
        finish(() => reject(abortError()));
      };
      this.pending.set(id, {
        w,
        resolve: (v) => finish(() => resolve(v as T)),
        reject: (e) => finish(() => reject(e)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      w.postMessage({ ...req, id } satisfies ToOcrWorker, transfer);
    });
  }

  private spawn(): Worker {
    const w = this.makeWorker();
    w.onmessage = (e: MessageEvent<FromOcrWorker>) => this.route(w, e.data);
    w.onerror = () => {
      for (const p of [...this.pending.values()]) if (p.w === w) p.reject(new Error("ocr worker failed"));
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    return w;
  }

  private route(w: Worker, msg: FromOcrWorker): void {
    if (msg.type === "released") {
      w.terminate();
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // cancelled or already settled
    if (msg.type === "error") p.reject(msg.name === "AbortError" ? abortError() : new Error(msg.message));
    else p.resolve(msg.value);
  }

  private env() {
    return { ortVersion: ORT_VERSION, modelsSum: MODELS_SUM, adapter: this.adapter ?? "", cpuOnly: this.cpuOnly() };
  }

  private read(): Measurement | null {
    try {
      return parseMeasurement(this.storage.getItem(KEY));
    } catch {
      return null;
    }
  }

  private write(m: Measurement): void {
    try {
      this.storage.setItem(KEY, JSON.stringify(m));
    } catch {
      // Storage full or blocked: the next use measures again.
    }
  }
}
