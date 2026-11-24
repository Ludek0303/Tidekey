import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_SRC, FrameHost, PreviewFailure, currentTheme } from "./frame";
import type { Theme } from "./protocol";

const colors = { bg: "#101010", panel: "#1a1a1a", text: "#eeeeee", muted: "#888888", accent: "#3366ff", border: "#333333" };
const theme: Theme = { name: "dark", colors };
const DARK = { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" };
const LIGHT = { bg: "#f0efed", panel: "#f7f6f4", text: "#2c2b33", muted: "#6c6978", accent: "#7052b8", border: "#dedde2" };

type Msg = Record<string, unknown>;
interface Post { msg: Msg; transfer: unknown[] }

// Stands in for the frame's window: records what the app posts to it.
function fakeWindow(): { win: object; posts: Post[] } {
  const posts: Post[] = [];
  const win = {
    postMessage: (msg: Msg, _target: string, transfer: unknown[] = []) => {
      posts.push({ msg, transfer });
    },
  };
  return { win, posts };
}

function events() {
  return { onStatus: vi.fn(), onNav: vi.fn(), onClose: vi.fn(), onDownload: vi.fn() };
}

const bytes = (n = 4): ArrayBuffer => new ArrayBuffer(n);
const pdf = (buf = bytes(6)) => ({ name: "plik.pdf", mime: "application/pdf", size: buf.byteLength, viewer: "pdf" as const, bytes: buf });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The frame's window is replaced by the fake: FrameHost reads `contentWindow` on each access.
function attach(host: FrameHost, win: object): void {
  Object.defineProperty(host.element, "contentWindow", { value: win, configurable: true });
}
function reply(win: object, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: win as Window }));
}
// The outcome of a promise as a value, so a rejection does not surface as unhandled while a test runs.
const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (e: unknown) => e);

let parent: HTMLElement;
beforeEach(() => {
  parent = document.createElement("div");
  document.body.append(parent);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("FrameHost: ramka", () => {
  it("iframe ma sandbox dokładnie allow-scripts i żadnych innych uprawnień", () => {
    const host = new FrameHost(parent, events());
    const frame = host.element;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(FRAME_SRC);
    expect(frame.title).toBe("Podgląd pliku");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.className).toBe("podglad-ramka");
    expect(parent.contains(frame)).toBe(true);
  });
});

describe("FrameHost: open", () => {
  it("czeka na ready, potem wysyła init i open z bajtami i bez pól spoza kontraktu", async () => {
    const { win, posts } = fakeWindow();
    const host = new FrameHost(parent, events(), { theme: () => theme });
    attach(host, win);
    const buf = bytes(6);
    const done = host.open(pdf(buf));
    expect(posts).toEqual([]);

    reply(win, { v: 1, type: "ready" });
    expect(posts.map((p) => p.msg.type)).toEqual(["init", "open"]);
    expect(posts[0].msg).toEqual({ v: 1, type: "init", theme });
    expect(Object.keys(posts[1].msg).sort()).toEqual(["bytes", "id", "mime", "name", "size", "type", "v", "viewer"]);
    expect(posts[1].msg).toMatchObject({ v: 1, type: "open", id: 1, name: "plik.pdf", mime: "application/pdf", size: 6, viewer: "pdf" });
    expect(posts[1].msg.bytes).toBe(buf);
    expect(posts[1].transfer).toEqual([buf]);

    reply(win, { v: 1, type: "progress", id: 1, phase: "shown" });
    await expect(done).resolves.toBeUndefined();
  });

  it("przekazuje label i durationMs, gdy są", () => {
    const { win, posts } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    void outcome(host.open({ ...pdf(), label: "first-frame", durationMs: 1500 }));
    reply(win, { v: 1, type: "ready" });
    expect(posts[1].msg).toMatchObject({ label: "first-frame", durationMs: 1500 });
  });

  it("status z progress trafia do onStatus", () => {
    const { win } = fakeWindow();
    const ev = events();
    const host = new FrameHost(parent, ev);
    attach(host, win);
    void outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "progress", id: 1, phase: "preparing", status: "Strona 2 z 9" });
    expect(ev.onStatus).toHaveBeenCalledWith("Strona 2 z 9");
  });

  it("error corrupt odrzuca open z PreviewFailure", async () => {
    const { win } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    const done = outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "error", id: 1, code: "corrupt" });
    const err = await done;
    expect(err).toBeInstanceOf(PreviewFailure);
    expect(err).toMatchObject({ code: "corrupt", message: "corrupt" });
  });

  it("odpowiedź ze starym id jest ignorowana", async () => {
    const { win } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    const first = outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    const second = host.open(pdf());
    const next = fakeWindow();
    attach(host, next.win);
    reply(next.win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "progress", id: 1, phase: "shown" });
    reply(next.win, { v: 1, type: "error", id: 1, code: "corrupt" });
    expect(await first).toMatchObject({ name: "AbortError" });
    let settled = false;
    void second.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    reply(next.win, { v: 1, type: "progress", id: 2, phase: "shown" });
    await expect(second).resolves.toBeUndefined();
  });

  it("each file after the first gets a new frame, so code one file ran never sees the next", async () => {
    const { win } = fakeWindow();
    const host = new FrameHost(parent, events());
    const firstFrame = host.element;
    attach(host, win);
    void outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    void outcome(host.open(pdf()));
    expect(host.element).not.toBe(firstFrame);
    expect(parent.contains(firstFrame)).toBe(false);
    expect(parent.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("drugie open odrzuca pierwsze AbortError", async () => {
    const { win } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    const first = outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    void host.open(pdf());
    const err = await first;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("komunikat od innego source jest ignorowany", () => {
    const { win } = fakeWindow();
    const other = fakeWindow().win;
    const ev = events();
    const host = new FrameHost(parent, ev);
    attach(host, win);
    reply(other, { v: 1, type: "nav", dir: 1 });
    reply(other, { v: 1, type: "download" });
    expect(ev.onNav).not.toHaveBeenCalled();
    expect(ev.onDownload).not.toHaveBeenCalled();
  });

  it("komunikat o złym kształcie jest ignorowany", () => {
    const { win } = fakeWindow();
    const ev = events();
    const host = new FrameHost(parent, ev);
    attach(host, win);
    reply(win, { v: 1, type: "nav", dir: 5 });
    reply(win, { v: 2, type: "nav", dir: 1 });
    reply(win, "junk");
    reply(win, null);
    expect(ev.onNav).not.toHaveBeenCalled();
  });

  it("brak ready w readyTimeoutMs: błąd internal", async () => {
    vi.useFakeTimers();
    const { win, posts } = fakeWindow();
    const host = new FrameHost(parent, events(), { readyTimeoutMs: 1000 });
    attach(host, win);
    const done = outcome(host.open(pdf()));
    await vi.advanceTimersByTimeAsync(999);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await done;
    expect(err).toBeInstanceOf(PreviewFailure);
    expect(err).toMatchObject({ code: "internal" });
    expect(posts).toEqual([]);
  });

  it("zawieszenie: timeout, stara ramka usunięta, nowa czeka na swoje ready", async () => {
    vi.useFakeTimers();
    const first = fakeWindow();
    const host = new FrameHost(parent, events(), { hangTimeoutMs: 500 });
    const oldFrame = host.element;
    attach(host, first.win);
    const done = outcome(host.open(pdf()));
    reply(first.win, { v: 1, type: "ready" });

    await vi.advanceTimersByTimeAsync(400);
    reply(first.win, { v: 1, type: "progress", id: 1, phase: "preparing" });
    await vi.advanceTimersByTimeAsync(400);
    let settled = false;
    void done.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    const err = await done;
    expect(err).toMatchObject({ code: "timeout" });
    expect(host.element).not.toBe(oldFrame);
    expect(parent.contains(oldFrame)).toBe(false);
    expect(parent.querySelectorAll("iframe")).toHaveLength(1);

    const second = fakeWindow();
    attach(host, second.win);
    const next = outcome(host.frame({ name: "v.mp4", mime: "video/mp4", bytes: bytes(2) }));
    expect(second.posts).toEqual([]);
    reply(second.win, { v: 1, type: "ready" });
    expect(second.posts.map((p) => p.msg.type)).toEqual(["init", "frame"]);
    reply(second.win, { v: 1, type: "frame-error", id: 2, code: "codec" });
    expect(await next).toMatchObject({ code: "codec" });
  });
});

describe("FrameHost: asset, frame i zdarzenia", () => {
  it("asset z dobrą ścieżką: fetchAsset i odpowiedź z bajtami", async () => {
    const { win, posts } = fakeWindow();
    const buf = bytes(8);
    const fetchAsset = vi.fn(async (_path: string) => buf);
    const host = new FrameHost(parent, events(), { fetchAsset });
    attach(host, win);
    reply(win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "asset", path: "assets/video.wasm" });
    await flush();
    expect(fetchAsset).toHaveBeenCalledWith("assets/video.wasm");
    expect(posts.at(-1)).toEqual({ msg: { v: 1, type: "asset", path: "assets/video.wasm", bytes: buf }, transfer: [buf] });
  });

  it("asset ze złą ścieżką: nic się nie dzieje", async () => {
    const { win, posts } = fakeWindow();
    const fetchAsset = vi.fn(async (_path: string) => bytes());
    const host = new FrameHost(parent, events(), { fetchAsset });
    attach(host, win);
    reply(win, { v: 1, type: "ready" });
    const before = posts.length;
    reply(win, { v: 1, type: "asset", path: "../secret" });
    reply(win, { v: 1, type: "asset", path: "assets/a b.wasm" });
    await flush();
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(posts.length).toBe(before);
  });

  it("błąd fetchAsset: odpowiedź z bytes null", async () => {
    const { win, posts } = fakeWindow();
    const fetchAsset = vi.fn(async (_path: string): Promise<ArrayBuffer> => { throw new Error("404"); });
    const host = new FrameHost(parent, events(), { fetchAsset });
    attach(host, win);
    reply(win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "asset", path: "assets/a.wasm" });
    await flush();
    expect(posts.at(-1)?.msg).toEqual({ v: 1, type: "asset", path: "assets/a.wasm", bytes: null });
  });

  it("domyślny fetchAsset pobiera z /preview/ bez danych logowania", async () => {
    const { win, posts } = fakeWindow();
    const buf = bytes(3);
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => buf }));
    vi.stubGlobal("fetch", fetchMock);
    const host = new FrameHost(parent, events());
    attach(host, win);
    reply(win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "asset", path: "assets/a.wasm" });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/preview/assets/a.wasm", { credentials: "omit" });
    expect(posts.at(-1)?.msg).toMatchObject({ type: "asset", bytes: buf });
  });

  it("domyślny fetchAsset z odpowiedzią !ok daje bytes null", async () => {
    const { win, posts } = fakeWindow();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const host = new FrameHost(parent, events());
    attach(host, win);
    reply(win, { v: 1, type: "ready" });
    reply(win, { v: 1, type: "asset", path: "assets/a.wasm" });
    await flush();
    expect(posts.at(-1)?.msg).toMatchObject({ type: "asset", bytes: null });
  });

  it("frame zwraca piksele pierwszej klatki", async () => {
    const { win, posts } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    const buf = bytes(4);
    const done = host.frame({ name: "v.mp4", mime: "video/mp4", bytes: buf });
    reply(win, { v: 1, type: "ready" });
    expect(Object.keys(posts[1].msg).sort()).toEqual(["bytes", "id", "mime", "name", "type", "v"]);
    expect(posts[1].msg).toMatchObject({ type: "frame", id: 1, name: "v.mp4", mime: "video/mp4" });
    reply(win, { v: 1, type: "frame", id: 1, width: 1, height: 1, pixels: bytes(4), durationMs: 2000 });
    expect(await done).toMatchObject({ width: 1, height: 1, durationMs: 2000 });
  });

  it("nav, close ze spacją, close bez klucza i download idą do zdarzeń", () => {
    const { win } = fakeWindow();
    const ev = events();
    const host = new FrameHost(parent, ev);
    attach(host, win);
    reply(win, { v: 1, type: "nav", dir: -1 });
    reply(win, { v: 1, type: "close", key: "space" });
    reply(win, { v: 1, type: "close" });
    reply(win, { v: 1, type: "download" });
    expect(ev.onNav).toHaveBeenCalledWith(-1);
    expect(ev.onClose.mock.calls).toEqual([[true], [false]]);
    expect(ev.onDownload).toHaveBeenCalledTimes(1);
  });

  it("command i setTheme idą do ramki po ready", () => {
    const { win, posts } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    void outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    host.command("zoom-in");
    const light: Theme = { name: "light", colors };
    host.setTheme(light);
    expect(posts.at(-2)?.msg).toEqual({ v: 1, type: "command", id: 1, name: "zoom-in" });
    expect(posts.at(-1)?.msg).toEqual({ v: 1, type: "init", theme: light });
  });

  it("dispose wysyła dispose i odrzuca oczekujące open", async () => {
    const { win, posts } = fakeWindow();
    const host = new FrameHost(parent, events());
    attach(host, win);
    const done = outcome(host.open(pdf()));
    reply(win, { v: 1, type: "ready" });
    host.dispose();
    expect(posts.at(-1)?.msg).toEqual({ v: 1, type: "dispose" });
    expect(await done).toMatchObject({ name: "AbortError" });
  });

  it("destroy usuwa iframe, odrzuca oczekujące i zdejmuje nasłuch", async () => {
    const { win } = fakeWindow();
    const ev = events();
    const host = new FrameHost(parent, ev);
    attach(host, win);
    const done = outcome(host.open(pdf()));
    host.destroy();
    expect(parent.querySelector("iframe")).toBeNull();
    expect(await done).toMatchObject({ name: "AbortError" });
    reply(win, { v: 1, type: "nav", dir: 1 });
    expect(ev.onNav).not.toHaveBeenCalled();
    expect(await outcome(host.open(pdf()))).toMatchObject({ name: "AbortError" });
    expect(await outcome(host.frame({ name: "a", mime: "video/mp4", bytes: bytes() }))).toMatchObject({ name: "AbortError" });
  });
});

describe("currentTheme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    for (const v of ["--bg", "--panel", "--text"]) document.documentElement.style.removeProperty(v);
  });

  it("bez data-theme: ciemny z domyślnymi kolorami", () => {
    expect(currentTheme()).toEqual({ name: "dark", colors: DARK });
  });

  it("data-theme=light: jasny z domyślnymi kolorami", () => {
    document.documentElement.dataset.theme = "light";
    expect(currentTheme()).toEqual({ name: "light", colors: LIGHT });
  });

  it("rgb() i #rgb zamienia na #rrggbb", () => {
    document.documentElement.style.setProperty("--bg", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--panel", "#abc");
    const t = currentTheme();
    expect(t.colors.bg).toBe("#010203");
    expect(t.colors.panel).toBe("#aabbcc");
  });

  it("wartość nie do odczytania daje kolor domyślny", () => {
    document.documentElement.style.setProperty("--text", "not-a-color");
    expect(currentTheme().colors.text).toBe(DARK.text);
  });
});
