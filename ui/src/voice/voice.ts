import { startCapture } from "./capture";
import type { FromWorker, StartOptions, ToWorker, VoiceEngine, VoiceEventMap, VoiceEventName } from "./types";
import { VoiceError } from "./types";

// The part of a Worker the client uses; a test passes a fake one.
export interface WorkerLike {
  postMessage(m: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  terminate(): void;
}

// Runs the engine in a Web Worker. The worker starts on the first start(), so an unused dictation costs nothing.
export class WorkerVoice implements VoiceEngine {
  private worker: WorkerLike | null = null;
  private listeners = new Map<VoiceEventName, Set<(value: unknown) => void>>();
  private session: { stop(): void } | null = null;
  // Bumped by every start and stop: a capture that resolves after a stop is released at once, so the mic never stays on.
  private run = 0;
  // Settles the start() that waits for the worker: true once it listens, false on error or stop.
  private ready: ((ok: boolean) => void) | null = null;

  constructor(
    private readonly makeWorker: () => WorkerLike = () =>
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    private readonly capture: typeof startCapture = startCapture,
  ) {}

  async start(opts: StartOptions): Promise<void> {
    const worker = this.ensureWorker();
    const run = ++this.run;
    this.settle(false);
    // The mic opens only once the worker listens: a first run may download about 1 GB, and nothing is recorded meanwhile.
    const listening = new Promise<boolean>((resolve) => (this.ready = resolve));
    worker.postMessage({ type: "start", ...opts });
    if (!(await listening) || run !== this.run) return;
    try {
      const session = await this.capture((pcm) => worker.postMessage({ type: "audio", pcm }, [pcm.buffer as ArrayBuffer]));
      if (run === this.run) this.session = session;
      else session.stop();
    } catch (err) {
      if (run !== this.run) return;
      this.emit("error", err instanceof VoiceError ? { code: err.code } : { code: "internal", detail: String(err) });
      this.emit("status", "idle");
      this.stop();
    }
  }

  stop(): void {
    this.run++;
    this.settle(false);
    this.session?.stop();
    this.session = null;
    this.worker?.postMessage({ type: "stop" });
  }

  on<K extends VoiceEventName>(name: K, cb: (value: VoiceEventMap[K]) => void): () => void {
    const set = this.listeners.get(name) ?? new Set<(value: unknown) => void>();
    this.listeners.set(name, set);
    const listener = cb as (value: unknown) => void;
    set.add(listener);
    return () => set.delete(listener);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private emit<K extends VoiceEventName>(name: K, value: VoiceEventMap[K]): void {
    for (const cb of this.listeners.get(name) ?? []) cb(value);
  }

  private settle(ok: boolean): void {
    const ready = this.ready;
    this.ready = null;
    ready?.(ok);
  }

  private ensureWorker(): WorkerLike {
    if (!this.worker) {
      this.worker = this.makeWorker();
      this.worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "status" && msg.value === "listening") this.settle(true);
        if (msg.type === "error") this.settle(false);
        for (const cb of this.listeners.get(msg.type) ?? []) cb(msg.value);
      };
    }
    return this.worker;
  }
}
