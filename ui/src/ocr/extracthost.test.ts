// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTRACT_OPTIONS } from "./protocol";
import { EXTRACT_SILENCE_MS, EXTRACT_SRC, extract, type ExtractPage } from "./extracthost";

class FakeBitmap {
  close = vi.fn();
  constructor(public width = 100, public height = 100) {}
}
beforeAll(() => {
  (globalThis as { ImageBitmap?: unknown }).ImageBitmap = FakeBitmap;
});

type Post = { msg: Record<string, unknown>; transfer: unknown[] };

// The frame's window: records what the app posts to it. The iframe's contentWindow is replaced by this object.
function fakeWindow(): { win: object; posts: Post[] } {
  const posts: Post[] = [];
  const win = {
    postMessage: (msg: Record<string, unknown>, _target: string, transfer: unknown[] = []) => {
      posts.push({ msg, transfer });
    },
  };
  return { win, posts };
}

const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll("iframe")];
const file = () => ({ mime: "application/pdf", bytes: new ArrayBuffer(16) });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Starts a job and attaches the fake frame to it. The job's id is read from the extract message the app posts.
async function start(opts: { onPage?: (p: ExtractPage) => void; signal?: AbortSignal; fetchAsset?: (path: string) => Promise<ArrayBuffer> } = {}) {
  const onPage = opts.onPage ?? vi.fn();
  const { win, posts } = fakeWindow();
  const job = extract(file(), DEFAULT_EXTRACT_OPTIONS, onPage, opts.signal, opts.fetchAsset);
  const iframe = frames()[frames().length - 1];
  Object.defineProperty(iframe, "contentWindow", { value: win, configurable: true });
  const outcome = job.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  const reply = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: win as Window }));
  const ready = async (): Promise<number> => {
    reply({ type: "ready", v: 1 });
    await flush();
    const sent = posts.find((p) => p.msg.type === "extract");
    if (!sent) throw new Error("brak wiadomości extract");
    return sent.msg.jobId as number;
  };
  return { iframe, posts, reply, ready, outcome, onPage };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("extract", () => {
  it("tworzy niewidoczną ramkę w piaskownicy bez dostępu do aplikacji", async () => {
    const job = await start();
    expect(job.iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(job.iframe.getAttribute("src")).toBe(EXTRACT_SRC);
    expect(job.iframe.getAttribute("aria-hidden")).toBe("true");
    expect(job.iframe.style.opacity).toBe("0");
    job.reply({ type: "error", v: 1, jobId: 1, code: "corrupt" });
    await job.outcome;
  });

  it("szczęśliwa ścieżka: bajty przekazane, strony oddane, done kończy i usuwa ramkę", async () => {
    const onPage = vi.fn();
    const job = await start({ onPage });
    const jobId = await job.ready();
    const sent = job.posts.find((p) => p.msg.type === "extract")!;
    expect(sent.msg).toMatchObject({ v: 1, jobId, mime: "application/pdf", options: DEFAULT_EXTRACT_OPTIONS });
    expect(sent.msg).not.toHaveProperty("name");
    expect(sent.transfer).toHaveLength(1);

    job.reply({ type: "page", v: 1, jobId, page: 1, pages: 2, text: "Strona pierwsza", extra: "x" });
    await flush();
    const bitmap = new FakeBitmap() as unknown as ImageBitmap;
    job.reply({ type: "page", v: 1, jobId, page: 2, pages: 2, bitmap, reason: "garbled" });
    await flush();
    job.reply({ type: "done", v: 1, jobId, pages: 2, truncated: false });

    expect(await job.outcome).toEqual({ ok: true, v: { pages: 2, truncated: false } });
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage.mock.calls[1][0]).toMatchObject({ page: 2, pages: 2, reason: "garbled" });
    // only the known fields reach the app
    expect(onPage.mock.calls[0][0]).toEqual({ type: "page", v: 1, jobId, page: 1, pages: 2, text: "Strona pierwsza" });
    expect(job.posts.filter((p) => p.msg.type === "next")).toHaveLength(2);
    expect(frames()).toHaveLength(0);
  });

  it("kod błędu z ramki odrzuca obietnicę kodem jako komunikatem", async () => {
    const job = await start();
    const jobId = await job.ready();
    job.reply({ type: "error", v: 1, jobId, code: "encrypted" });
    const out = await job.outcome;
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.e).toEqual(new Error("encrypted"));
    expect(frames()).toHaveLength(0);
  });

  it("wiadomość z innego źródła jest ignorowana", async () => {
    const onPage = vi.fn();
    const job = await start({ onPage });
    const jobId = await job.ready();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "page", v: 1, jobId, page: 1, pages: 1, text: "obcy" }, source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "done", v: 1, jobId, pages: 1, truncated: false }, source: null }));
    await flush();
    expect(onPage).not.toHaveBeenCalled();
    expect(frames()).toHaveLength(1);
    job.reply({ type: "done", v: 1, jobId, pages: 0, truncated: false });
    await job.outcome;
  });

  it("zniekształcona wiadomość jest pomijana (jej bitmapa zamknięta), obcy numer zadania kończy pracę", async () => {
    const onPage = vi.fn();
    const job = await start({ onPage });
    const jobId = await job.ready();
    const stray = new FakeBitmap();
    job.reply({ type: "page", v: 1, jobId, page: 1, pages: 1, text: "ok", bitmap: stray });
    job.reply({ type: "page", v: 1, jobId, page: 0, pages: 1, text: "zero" });
    expect(stray.close).toHaveBeenCalled();
    expect(frames()).toHaveLength(1);
    job.reply({ type: "page", v: 1, jobId: jobId + 5, page: 1, pages: 1, text: "nie ta praca" });
    expect(String((await job.outcome as { e?: unknown }).e)).toContain("protocol");
    expect(onPage).not.toHaveBeenCalled();
  });

  it("pytanie o zasób od ramki przechodzi przez aplikację i wraca jako bajty", async () => {
    const fetchAsset = vi.fn(async () => new ArrayBuffer(4));
    const job = await start({ fetchAsset });
    await job.ready();
    job.reply({ type: "asset", v: 1, path: "assets/libheif.wasm" });
    await flush();
    expect(fetchAsset).toHaveBeenCalledWith("assets/libheif.wasm");
    const answer = job.posts.find((p) => p.msg.type === "asset")!;
    expect(answer.msg).toMatchObject({ path: "assets/libheif.wasm", v: 1 });
    expect(answer.transfer).toHaveLength(1);
    const jobId = job.posts.find((p) => p.msg.type === "extract")!.msg.jobId as number;
    job.reply({ type: "done", v: 1, jobId, pages: 0, truncated: false });
    expect((await job.outcome).ok).toBe(true);
  });

  it("brak wiadomości przez 90 s: timeout i usunięta ramka", async () => {
    vi.useFakeTimers();
    const job = await start();
    vi.advanceTimersByTime(EXTRACT_SILENCE_MS - 1);
    expect(frames()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const out = await job.outcome;
    expect(out.ok === false && out.e).toEqual(new Error("timeout"));
    expect(frames()).toHaveLength(0);
  });

  it("anulowanie: najpierw cancel do ramki, potem odrzucenie AbortError i usunięcie", async () => {
    const controller = new AbortController();
    const job = await start({ signal: controller.signal });
    const jobId = await job.ready();
    controller.abort();
    const out = await job.outcome;
    expect(out.ok === false && out.e).toMatchObject({ name: "AbortError" });
    const cancel = job.posts.find((p) => p.msg.type === "cancel");
    expect(cancel?.msg).toMatchObject({ v: 1, jobId });
    expect(frames()).toHaveLength(0);
  });

  it("anulowanie przed gotowością ramki nie wysyła cancel, a usuwa ramkę", async () => {
    const controller = new AbortController();
    const job = await start({ signal: controller.signal });
    controller.abort();
    expect((await job.outcome).ok).toBe(false);
    expect(job.posts.some((p) => p.msg.type === "cancel")).toBe(false);
    expect(frames()).toHaveLength(0);
  });

  it("strona ponad limit pikseli, poza liczbą stron albo powtórzona: cancel, błąd protocol, bitmapa zamknięta", async () => {
    for (const bad of [
      (id: number) => ({ type: "page", v: 1, jobId: id, page: 1, pages: 1, bitmap: new FakeBitmap(10_000, 10_000) }),
      (id: number) => ({ type: "page", v: 1, jobId: id, page: 301, pages: 301, bitmap: new FakeBitmap() }),
    ]) {
      const job = await start();
      const id = await job.ready();
      const msg = bad(id);
      job.reply(msg);
      const out = await job.outcome;
      expect(out.ok).toBe(false);
      expect(String((out as { e: unknown }).e)).toContain("protocol");
      expect(msg.bitmap.close).toHaveBeenCalled();
      expect(job.posts.some((p) => p.msg.type === "cancel")).toBe(true);
      expect(frames()).toHaveLength(0);
    }
    const job = await start();
    const id = await job.ready();
    job.reply({ type: "page", v: 1, jobId: id, page: 1, pages: 2, text: "a" });
    await flush();
    job.reply({ type: "page", v: 1, jobId: id, page: 1, pages: 2, text: "b" });
    expect((await job.outcome).ok).toBe(false);
    expect(job.onPage).toHaveBeenCalledTimes(1);
  });

  it("tekst całego pliku ponad 2 MB: strony do limitu zostają, wynik oznaczony jako ucięty", async () => {
    const job = await start();
    const id = await job.ready();
    const page = "x".repeat(1024 * 1024);
    for (let n = 1; n <= 3; n++) {
      job.reply({ type: "page", v: 1, jobId: id, page: n, pages: 3, text: page });
      await flush();
    }
    expect(await job.outcome).toEqual({ ok: true, v: { pages: 2, truncated: true } });
    expect(job.onPage).toHaveBeenCalledTimes(2);
    expect(frames()).toHaveLength(0);
  });

  it("zbyt wiele pytań o zasoby kończy zadanie", async () => {
    const fetchAsset = vi.fn(async () => new ArrayBuffer(1));
    const job = await start({ fetchAsset });
    await job.ready();
    for (let i = 0; i < 65; i++) job.reply({ type: "asset", v: 1, path: `assets/a${i}.bin` });
    expect((await job.outcome).ok).toBe(false);
    await flush();
    expect(fetchAsset.mock.calls.length).toBeLessThanOrEqual(1);
    expect(job.posts.filter((p) => p.msg.type === "asset").length).toBe(0);
  });

  it("anulowanie albo błąd aplikacji w trakcie obsługi strony: bez next, ramka usunięta", async () => {
    const controller = new AbortController();
    const aborted = await start({ signal: controller.signal, onPage: () => new Promise<void>(() => {}) });
    const id = await aborted.ready();
    aborted.reply({ type: "page", v: 1, jobId: id, page: 1, pages: 2, text: "a" });
    await flush();
    controller.abort();
    expect((await aborted.outcome as { e?: unknown }).e).toMatchObject({ name: "AbortError" });
    await flush();
    expect(aborted.posts.some((p) => p.msg.type === "next")).toBe(false);
    expect(frames()).toHaveLength(0);

    const broken = await start({ onPage: async () => { throw new Error("aplikacja"); } });
    const bid = await broken.ready();
    broken.reply({ type: "page", v: 1, jobId: bid, page: 1, pages: 2, text: "a" });
    expect(String((await broken.outcome as { e?: unknown }).e)).toContain("aplikacja");
    expect(broken.posts.some((p) => p.msg.type === "next")).toBe(false);
  });

  it("done w trakcie obsługi strony to złamanie protokołu; done z mniejszą liczbą stron niż zapowiedziana jest ucięte", async () => {
    const early = await start({ onPage: () => new Promise<void>(() => {}) });
    const id = await early.ready();
    early.reply({ type: "page", v: 1, jobId: id, page: 1, pages: 1, text: "a" });
    await flush();
    early.reply({ type: "done", v: 1, jobId: id, pages: 1, truncated: false });
    expect(String((await early.outcome as { e?: unknown }).e)).toContain("protocol");

    const short = await start();
    const sid = await short.ready();
    short.reply({ type: "page", v: 1, jobId: sid, page: 1, pages: 3, text: "a" });
    await flush();
    short.reply({ type: "done", v: 1, jobId: sid, pages: 1, truncated: false });
    expect(await short.outcome).toEqual({ ok: true, v: { pages: 1, truncated: true } });
  });

  it("czas pracy aplikacji nad stroną nie liczy się do ciszy ramki, a po łącznym limicie ramki zostają strony już odczytane", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let first = true;
    const onPage = (): Promise<void> => (first ? new Promise<void>((resolve) => { first = false; release = resolve; }) : Promise.resolve());
    const job = await start({ onPage });
    job.reply({ type: "ready", v: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const id = job.posts.find((p) => p.msg.type === "extract")!.msg.jobId as number;
    job.reply({ type: "page", v: 1, jobId: id, page: 1, pages: 300, text: "a" });
    await vi.advanceTimersByTimeAsync(5 * EXTRACT_SILENCE_MS);
    expect(frames()).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // the frame now sends each page just before the silence limit: the whole-job budget ends it
    let n = 2;
    while (frames().length && n <= 300) {
      await vi.advanceTimersByTimeAsync(EXTRACT_SILENCE_MS - 1000);
      job.reply({ type: "page", v: 1, jobId: id, page: n++, pages: 300, text: "a" });
      await vi.advanceTimersByTimeAsync(0);
    }
    // the pages read so far stay, the result says it was cut
    const out = await job.outcome;
    expect(out).toMatchObject({ ok: true, v: { truncated: true } });
    expect((out as { v: { pages: number } }).v.pages).toBeGreaterThan(1);
    expect(n).toBeLessThan(20);
    expect(job.posts.some((p) => p.msg.type === "cancel")).toBe(true);
  });

  it("następna strona dopiero po obsłużeniu poprzedniej; strona bez zgody kończy pracę", async () => {
    let release!: () => void;
    const onPage = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const job = await start({ onPage });
    const id = await job.ready();
    job.reply({ type: "page", v: 1, jobId: id, page: 1, pages: 3, text: "a" });
    await flush();
    expect(job.posts.some((p) => p.msg.type === "next")).toBe(false);
    release();
    await flush();
    expect(job.posts.filter((p) => p.msg.type === "next")).toHaveLength(1);
    job.reply({ type: "page", v: 1, jobId: id, page: 2, pages: 3, text: "b" });
    await flush();
    // page 3 without the app's `next`: the frame is not following the protocol
    const bitmap = new FakeBitmap();
    job.reply({ type: "page", v: 1, jobId: id, page: 3, pages: 3, bitmap });
    expect(String((await job.outcome as { e?: unknown }).e)).toContain("protocol");
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("druga gotowość, zła liczba stron w done i zmiana liczby stron kończą pracę", async () => {
    const twice = await start();
    await twice.ready();
    twice.reply({ type: "ready", v: 1 });
    expect(String((await twice.outcome as { e?: unknown }).e)).toContain("protocol");

    const done = await start();
    const id = await done.ready();
    done.reply({ type: "done", v: 1, jobId: id, pages: 3, truncated: false });
    expect(String((await done.outcome as { e?: unknown }).e)).toContain("protocol");

    const changed = await start();
    const cid = await changed.ready();
    changed.reply({ type: "page", v: 1, jobId: cid, page: 1, pages: 2, text: "a" });
    await flush();
    changed.reply({ type: "page", v: 1, jobId: cid, page: 2, pages: 5, text: "b" });
    expect(String((await changed.outcome as { e?: unknown }).e)).toContain("protocol");
  });

  it("pytania o zasoby nie podtrzymują zadania: po 90 s ciszy stron jest timeout", async () => {
    vi.useFakeTimers();
    const job = await start({ fetchAsset: async () => new ArrayBuffer(1) });
    job.reply({ type: "ready", v: 1 });
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(EXTRACT_SILENCE_MS / 10);
      job.reply({ type: "asset", v: 1, path: "assets/a.bin" });
    }
    expect(String((await job.outcome as { e?: unknown }).e)).toContain("timeout");
  });

  it("plik ponad limit ramki jest odrzucany od razu, bez ramki", async () => {
    const big = { mime: "application/pdf", bytes: new ArrayBuffer(128 * 1024 * 1024 + 1) };
    await expect(extract(big, DEFAULT_EXTRACT_OPTIONS, vi.fn())).rejects.toThrow("too-large");
    expect(frames()).toHaveLength(0);
  });
});
