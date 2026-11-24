// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileStore } from "../filestore";
import type { ExtractPage, ExtractResult } from "./extracthost";
import type { Measurement, PageResult } from "./engine";
import { AUTO_MAX_BYTES, OcrQueue, isWeakDevice, type OcrPrefs, type PageEngine, type QueueDeps } from "./queue";
import { ocrBoard } from "./status";

const ID = (n: number): string => n.toString(16).padStart(2, "0").repeat(16);
const FAKE_BITMAP = { close: vi.fn() } as unknown as ImageBitmap;
const decode = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);

type Page = { text: string } | "bitmap";
/** The frame's pages of a file: from its text, or an error the frame would end with. */
type Plan = (body: string) => Page[] | Error;

// The frame stand-in: every page goes to onPage in order, as the real frame sends them.
function fakeExtract(plan: Plan = (body) => [{ text: body }]) {
  const calls: string[] = [];
  const extract = async (file: { bytes: ArrayBuffer }, _options: unknown, onPage: (page: ExtractPage) => void | Promise<void>): Promise<ExtractResult> => {
    const body = decode(file.bytes);
    calls.push(body);
    const pages = plan(body);
    if (pages instanceof Error) throw pages;
    for (const [i, p] of pages.entries()) {
      const base = { type: "page" as const, v: 1 as const, jobId: 1, page: i + 1, pages: pages.length };
      await onPage(p === "bitmap" ? { ...base, bitmap: FAKE_BITMAP } : { ...base, text: p.text });
    }
    return { pages: pages.length, truncated: false };
  };
  return { extract, calls };
}

function fakeEngine(msPerPage = 1000) {
  const m: Measurement = { det: "wasm", rec: "wasm", msPerPage, adapter: "", ortVersion: "", modelsSum: "", at: 0 };
  const recognize = vi.fn(async (): Promise<PageResult> => ({ lines: ["Skan tekstu"], quality: 0.9, noText: false, provider: { det: "wasm", rec: "wasm" }, ms: 1, fellBack: false }));
  const engine: PageEngine = { recognize, measure: vi.fn(async () => m), current: () => m, release: vi.fn() };
  return { engine, recognize };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

interface SetupOptions {
  me?: string;
  writable?: boolean;
  prefs?: Partial<OcrPrefs>;
  plan?: Plan;
  msPerPage?: number;
  store?: MemoryFileStore;
}

function setup(opts: SetupOptions = {}) {
  const store = opts.store ?? new MemoryFileStore(opts.me ?? "ana");
  const prefs: OcrPrefs = { enabled: true, onThisDevice: true, legacy: true, maxPages: 300, ...opts.prefs };
  const ex = fakeExtract(opts.plan);
  const en = fakeEngine(opts.msPerPage);
  const deps: QueueDeps = {
    store,
    me: opts.me ?? "ana",
    writable: opts.writable ?? true,
    prefs: () => prefs,
    extract: ex.extract,
    engine: async () => en.engine,
    pace: async () => undefined,
    memory: () => undefined,
  };
  return { store, queue: new OcrQueue(deps), prefs, ...ex, ...en, release: en.engine.release };
}

const upload = async (store: MemoryFileStore, n: number, body: string, name = `plik${n}.pdf`, type = "application/pdf") =>
  store.upload(new File([body], name, { type }), { id: ID(n) });

beforeEach(() => {
  ocrBoard.reset();
});

describe("OcrQueue: sources and order", () => {
  it("takes an upload from its own bytes and writes the layer", async () => {
    const { store, queue, calls } = setup();
    await queue.start();
    const info = await upload(store, 1, "Faktura nr 7");
    queue.uploaded(info, new File(["Faktura nr 7"], info.name, { type: "application/pdf" }));
    await until(() => ocrBoard.statusOf(info.id) === "tekst");
    expect(calls).toEqual(["Faktura nr 7"]);
    expect((await store.textLayers()).get(info.id)?.extractor).toBe(1);
  });

  it("runs the newest upload first, then the old files of this user", async () => {
    const { store, queue, calls } = setup();
    await upload(store, 5, "stary");
    const c = await upload(store, 6, "nowy-c");
    const d = await upload(store, 7, "nowy-d");
    queue.uploaded(c, new File(["nowy-c"], c.name));
    queue.uploaded(d, new File(["nowy-d"], d.name));
    await queue.start();
    await until(() => calls.length === 3);
    expect(calls).toEqual(["nowy-d", "nowy-c", "stary"]);
  });

  it("the scan takes only the files created by this user", async () => {
    const mine = setup({ me: "ana" });
    await upload(mine.store, 1, "moj");
    await mine.queue.start();
    await until(() => mine.calls.length >= 1);
    expect(mine.calls).toEqual(["moj"]);

    const theirs = setup({ me: "ola", store: new MemoryFileStore("ana") });
    await upload(theirs.store, 2, "cudzy");
    await theirs.queue.start();
    await settle();
    expect(theirs.calls).toEqual([]);
  });

  it("a file over 50 MB is left to a manual request", async () => {
    const { store, queue, calls } = setup();
    const big = await upload(store, 3, "duzy");
    const real = await store.list();
    vi.spyOn(store, "list").mockResolvedValue({ ...real, files: real.files.map((f) => (f.id === big.id ? { ...f, size: AUTO_MAX_BYTES + 1 } : f)) });
    await queue.start();
    await settle();
    expect(calls).toEqual([]);
    expect(queue.request({ ...big, size: AUTO_MAX_BYTES + 1 })).toBe(true);
    await until(() => ocrBoard.statusOf(big.id) === "tekst");
    expect(calls).toEqual(["duzy"]);
  });
});

describe("OcrQueue: devices, statuses, failures", () => {
  it("a slow device waits for OCR pages: nothing is written, the file says so", async () => {
    const { store, queue, recognize } = setup({ msPerPage: 30_000, prefs: { onThisDevice: false }, plan: () => [{ text: "" }, "bitmap"] });
    const info = await upload(store, 1, "skan.png", "skan.png", "image/png");
    queue.uploaded(info, new File(["x"], info.name));
    await until(() => ocrBoard.statusOf(info.id) === "czeka na komputer autora");
    expect(recognize).not.toHaveBeenCalled();
    expect(await store.textLayers()).toEqual(new Map());
  });

  it("a slow device still finishes a PDF with its own text", async () => {
    const { store, queue, recognize } = setup({ msPerPage: 30_000, prefs: { onThisDevice: false } });
    const info = await upload(store, 1, "tekst");
    queue.uploaded(info, new File(["tekst"], info.name));
    await until(() => ocrBoard.statusOf(info.id) === "tekst");
    expect(recognize).not.toHaveBeenCalled();
  });

  it("the weak-device rule covers low memory too", async () => {
    expect(isWeakDevice({ msPerPage: 1000 }, 4)).toBe(true);
    expect(isWeakDevice({ msPerPage: 1000 }, 8)).toBe(false);
    expect(isWeakDevice({ msPerPage: 21_000 }, undefined)).toBe(true);
  });

  it("statuses come from the flags of the layer", async () => {
    const { store, queue } = setup({ plan: (body) => (body === "szyfr" ? new Error("encrypted") : [{ text: "" }]) });
    const locked = await upload(store, 1, "szyfr");
    const empty = await upload(store, 2, "pusty");
    queue.uploaded(locked, new File(["szyfr"], locked.name));
    queue.uploaded(empty, new File(["pusty"], empty.name));
    await until(() => ocrBoard.statusOf(locked.id) === "zabezpieczony" && ocrBoard.statusOf(empty.id) === "brak tekstu");
    expect(ocrBoard.statusOf(locked.id)).toBe("zabezpieczony");
    expect(ocrBoard.statusOf(empty.id)).toBe("brak tekstu");
  });

  it("a failure is shown as błąd and tried again at the next start, not in a loop", async () => {
    const plan: Plan = () => new Error("timeout");
    const first = setup({ plan });
    const info = await upload(first.store, 1, "kapryśny");
    await first.queue.start();
    await until(() => ocrBoard.statusOf(info.id) === "błąd");
    await settle();
    expect(first.calls).toHaveLength(1);
    expect(ocrBoard.detailOf(info.id)).not.toContain("kapryśny");

    const next = new OcrQueue({ ...sameDeps(first), extract: first.extract });
    await next.start();
    await until(() => first.calls.length === 2);
    await settle();
    expect(first.calls).toHaveLength(2);
  });

  it("a write error is shown as błąd with the store's message", async () => {
    const { store, queue } = setup();
    vi.spyOn(store, "writeTextLayer").mockRejectedValue(new Error("Brak miejsca na pliki w tej przestrzeni."));
    const info = await upload(store, 1, "tekst");
    queue.uploaded(info, new File(["tekst"], info.name));
    await until(() => ocrBoard.statusOf(info.id) === "błąd");
    expect(ocrBoard.detailOf(info.id)).toBe("Brak miejsca na pliki w tej przestrzeni.");
  });
});

// The deps of a setup, to start another queue on the same store and frame (a new session).
function sameDeps(s: ReturnType<typeof setup>): QueueDeps {
  return {
    store: s.store,
    me: "ana",
    writable: true,
    prefs: () => s.prefs,
    extract: s.extract,
    engine: async () => s.engine,
    pace: async () => undefined,
    memory: () => undefined,
  };
}

describe("OcrQueue: switches", () => {
  it("a viewer never writes", async () => {
    const { store, queue, calls, recognize } = setup({ writable: false });
    await upload(store, 1, "moj");
    await queue.start();
    const info = await upload(store, 2, "nowy");
    queue.uploaded(info, new File(["nowy"], info.name));
    expect(queue.request(info)).toBe(false);
    await settle();
    expect(calls).toEqual([]);
    expect(recognize).not.toHaveBeenCalled();
    expect(await store.textLayers()).toEqual(new Map());
  });

  it("with OCR switched off nothing runs", async () => {
    const { store, queue, calls } = setup({ prefs: { enabled: false } });
    await upload(store, 1, "moj");
    await queue.start();
    const info = await upload(store, 2, "nowy");
    queue.uploaded(info, new File(["nowy"], info.name));
    expect(queue.request(info)).toBe(false);
    await settle();
    expect(calls).toEqual([]);
  });

  it("the legacy scan can be switched off, uploads still run", async () => {
    const { store, queue, calls } = setup({ prefs: { legacy: false } });
    await upload(store, 1, "stary");
    await queue.start();
    await settle();
    expect(calls).toEqual([]);
    const info = await upload(store, 2, "nowy");
    queue.uploaded(info, new File(["nowy"], info.name));
    await until(() => calls.length === 1);
    expect(calls).toEqual(["nowy"]);
  });

  it("pause holds the queue until resume", async () => {
    const { store, queue, calls } = setup();
    queue.pause(true);
    await upload(store, 1, "moj");
    await queue.start();
    await settle();
    expect(calls).toEqual([]);
    expect(ocrBoard.paused).toBe(true);
    queue.pause(false);
    await until(() => calls.length === 1);
    expect(calls).toEqual(["moj"]);
    expect(ocrBoard.paused).toBe(false);
  });

  it("close drops the queued files", async () => {
    const { store, queue } = setup();
    queue.pause(true);
    const info = await upload(store, 1, "moj");
    queue.uploaded(info, new File(["moj"], info.name));
    queue.close();
    await settle();
    expect(ocrBoard.statusOf(info.id)).toBeNull();
  });
});
