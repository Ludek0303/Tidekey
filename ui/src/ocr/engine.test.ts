// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OcrEngine, type Measurement, type PageResult } from "./engine";
import type { FromOcrWorker, ToOcrWorker } from "./workerproto";
import { ORT_VERSION } from "./hw";

const KEY = "notes.ocr.hw";
const bitmap = () => ({}) as unknown as ImageBitmap;

// Fake module worker: answers each request on a microtask, like a real worker. Options steer the answers.
class FakeWorker {
  onmessage: ((e: MessageEvent<FromOcrWorker>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: ToOcrWorker[] = [];
  terminated = false;
  holdPages = false; // a page never answers (for abort)
  crashOnPage = false; // the worker fails while the page runs
  fellBack = false;
  gpuRejects = false; // measure reports that WebGPU failed its checks
  constructor(readonly index: number) {}

  postMessage(msg: ToOcrWorker): void {
    this.sent.push(msg);
    queueMicrotask(() => this.answer(msg));
  }
  terminate(): void {
    this.terminated = true;
  }
  private deliver(m: FromOcrWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromOcrWorker>);
  }
  private answer(msg: ToOcrWorker): void {
    if (msg.type === "measure") {
      const rejected = this.gpuRejects && msg.webgpu;
      const det: "webgpu" | "wasm" = msg.webgpu && !rejected ? "webgpu" : "wasm";
      this.deliver({ type: "measured", id: msg.id, value: { det, rec: "wasm", msPerPage: 1200, adapter: "", gpuRejected: rejected } });
    } else if (msg.type === "page") {
      if (this.holdPages) return;
      if (this.crashOnPage) {
        this.onerror?.(new Event("error"));
        return;
      }
      this.deliver({
        type: "page",
        id: msg.id,
        value: {
          lines: ["ahoj"],
          quality: 0.9,
          noText: false,
          // a fallback answers with the wasm provider, as the real worker does
          provider: this.fellBack ? { det: "wasm", rec: "wasm" } : { det: msg.det, rec: msg.rec },
          ms: 5,
          fellBack: this.fellBack,
        },
      });
    } else if (msg.type === "release") {
      this.deliver({ type: "released", id: msg.id });
    }
  }
}

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

function harness(opts: { storage?: ReturnType<typeof memStorage>; cpuOnly?: () => boolean; idleMs?: number; gpuRejects?: boolean } = {}) {
  const workers: FakeWorker[] = [];
  const storage = opts.storage ?? memStorage();
  const make = (extra: { fellBack?: boolean } = {}) => {
    const e = new OcrEngine({
      storage,
      cpuOnly: opts.cpuOnly,
      idleMs: opts.idleMs,
      makeWorker: () => {
        const w = new FakeWorker(workers.length);
        w.fellBack = extra.fellBack ?? false;
        w.gpuRejects = opts.gpuRejects ?? false;
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    return e;
  };
  return { storage, workers, make };
}

const kinds = (w: FakeWorker) => w.sent.map((m) => m.type);
const stored = (s: ReturnType<typeof memStorage>): Measurement => JSON.parse(s.raw.get(KEY) ?? "null") as Measurement;

describe("OcrEngine measurement", () => {
  it("stores the measurement and reuses it in the next engine", async () => {
    const h = harness();
    const e1 = h.make();
    const r: PageResult = await e1.recognize(bitmap());
    expect(r.lines).toEqual(["ahoj"]);
    expect(kinds(h.workers[0])).toEqual(["measure", "page"]);
    expect(stored(h.storage).modelsSum).toBeTruthy();

    const e2 = h.make();
    await e2.recognize(bitmap());
    expect(kinds(h.workers[1])).toEqual(["page"]);
  });

  it("invalidates the measurement on another ORT version, model sum, adapter or after three GPU failures", async () => {
    const cases: Array<(m: Measurement) => Measurement> = [
      (m) => ({ ...m, ortVersion: "1.0.0" }),
      (m) => ({ ...m, modelsSum: "old" }),
      (m) => ({ ...m, adapter: "Intel gen9" }),
      (m) => ({ ...m, cpuOnly: true }),
    ];
    for (const change of cases) {
      const h = harness();
      await h.make().measure();
      h.storage.setItem(KEY, JSON.stringify(change(stored(h.storage))));
      const e = h.make();
      await e.recognize(bitmap());
      expect(kinds(h.workers[1])).toEqual(["measure", "page"]);
    }
  });

  it("bans WebGPU after three GPU failures on pages, for this environment only", async () => {
    const h = harness();
    const e = h.make({ fellBack: true });
    await e.measure();
    for (let i = 0; i < 3; i++) await e.recognize(bitmap());
    expect(stored(h.storage)).toMatchObject({ gpuFailures: 3, gpuBanned: true, det: "wasm", rec: "wasm" });
    // the stored measurement stays valid: no measure again, and the next measure (after a change) skips WebGPU
    await e.recognize(bitmap());
    expect(kinds(h.workers[0]).filter((k) => k === "measure")).toHaveLength(1);
    const after = h.make();
    await after.recognize(bitmap());
    expect(kinds(h.workers[1])).toEqual(["page"]);
    h.storage.setItem(KEY, JSON.stringify({ ...stored(h.storage), modelsSum: "changed" }));
    await h.make().recognize(bitmap());
    expect(h.workers[2].sent.find((m) => m.type === "measure")).toMatchObject({ webgpu: true });
  });

  it("does not carry a ban over to another environment", async () => {
    const h = harness();
    h.storage.setItem(KEY, JSON.stringify({ det: "wasm", rec: "wasm", msPerPage: 1, adapter: "", ortVersion: ORT_VERSION, modelsSum: "other", at: 1, gpuBanned: true, gpuFailures: 3 }));
    await h.make().recognize(bitmap());
    expect(h.workers[0].sent.find((m) => m.type === "measure")).toMatchObject({ webgpu: true });
  });

  it("bans WebGPU when measurement finds it failing its checks, so the next measure skips it", async () => {
    const h = harness({ gpuRejects: true });
    const e = h.make();
    await e.measure();
    expect(stored(h.storage)).toMatchObject({ det: "wasm", gpuBanned: true });
    await e.measure();
    expect(h.workers[0].sent.filter((m) => m.type === "measure").map((m) => m.type === "measure" && m.webgpu)).toEqual([true, false]);
  });

  it("cpuOnly forces wasm on both stages", async () => {
    const h = harness({ cpuOnly: () => true });
    const e = h.make();
    await e.recognize(bitmap());
    const measure = h.workers[0].sent.find((m) => m.type === "measure");
    expect(measure).toMatchObject({ type: "measure", webgpu: false });
    expect(stored(h.storage)).toMatchObject({ det: "wasm", rec: "wasm" });
    expect(h.workers[0].sent.find((m) => m.type === "page")).toMatchObject({ det: "wasm", rec: "wasm" });
  });
});

describe("OcrEngine worker lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases the worker after the idle time and starts a new one on the next call", async () => {
    const h = harness({ idleMs: 60_000 });
    const e = h.make();
    await e.recognize(bitmap());
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kinds(h.workers[0]).at(-1)).toBe("release");
    expect(h.workers[0].terminated).toBe(true);
    await e.recognize(bitmap());
    expect(h.workers).toHaveLength(2);
    expect(kinds(h.workers[1])).toEqual(["page"]);
  });

  it("sends cancel and rejects with AbortError when the caller aborts", async () => {
    const h = harness();
    const e = h.make();
    await e.measure();
    h.workers[0].holdPages = true;
    const ac = new AbortController();
    const p = e.recognize(bitmap(), ac.signal);
    await vi.waitFor(() => expect(kinds(h.workers[0])).toContain("page"));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(kinds(h.workers[0])).toContain("cancel");
  });

  it("rejects on a worker error and works again with a new worker", async () => {
    const h = harness();
    const e = h.make();
    await e.measure();
    h.workers[0].crashOnPage = true;
    await expect(e.recognize(bitmap())).rejects.toThrow("ocr worker failed");
    expect(h.workers[0].terminated).toBe(true);
    const r = await e.recognize(bitmap());
    expect(r.lines).toEqual(["ahoj"]);
    expect(h.workers).toHaveLength(2);
  });
});
