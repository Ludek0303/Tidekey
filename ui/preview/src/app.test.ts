// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, FromFrame, Theme } from "../../src/preview/protocol";
import { MAX_SIZE, type ViewerId } from "../../src/preview/formats";
import { FrameApp } from "./app";
import { PreviewError, type Viewer, type ViewerContext, type ViewerModule } from "./viewers/index";
import { firstFrame } from "./firstframe";

vi.mock("./firstframe", () => ({ firstFrame: vi.fn() }));

const LIGHT: Theme = {
  name: "light",
  colors: { bg: "#ffffff", panel: "#f0f0f0", text: "#111111", muted: "#666666", accent: "#3366ff", border: "#cccccc" },
};

interface FakeOptions {
  run?: (ctx: ViewerContext) => Promise<void>;
  key?: (e: KeyboardEvent) => boolean;
  swipe?: () => boolean;
  commands?: Command[];
}
interface Probe { ctx?: ViewerContext; disposed: number; loads: number }

// A viewer module that records what the app does with it.
function fake(id: ViewerId, opts: FakeOptions = {}): { mod: ViewerModule; probe: Probe } {
  const probe: Probe = { disposed: 0, loads: 0 };
  const mod: ViewerModule = {
    id,
    load: async (): Promise<Viewer> => {
      probe.loads++;
      return {
        open: async (_bytes, ctx) => {
          probe.ctx = ctx;
          await opts.run?.(ctx);
        },
        key: opts.key,
        swipe: opts.swipe,
        command: (name) => {
          opts.commands?.push(name);
        },
        dispose: () => {
          probe.disposed++;
        },
      };
    },
  };
  return { mod, probe };
}

function harness(viewers: Partial<Record<ViewerId, ViewerModule>> = {}, timeoutMs?: number) {
  const sent: FromFrame[] = [];
  const host = document.createElement("main");
  document.body.append(host);
  const app = new FrameApp(host, (m) => sent.push(m), { viewers, timeoutMs });
  return { app, sent, host };
}

const openMsg = (id: number, extra: Record<string, unknown> = {}) => ({
  v: 1, type: "open", id, name: "plik.png", mime: "image/png", size: 4, viewer: "image", bytes: new ArrayBuffer(4), ...extra,
});

// Lets queued promise callbacks run; the app has no timers on this path.
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(firstFrame).mockReset();
  document.body.replaceChildren();
});

describe("FrameApp: open", () => {
  it("open przed init działa z domyślnymi kolorami", async () => {
    const probe = fake("image");
    const { app, sent } = harness({ image: probe.mod });
    app.receive(openMsg(1));
    await settle();
    expect(probe.probe.ctx?.theme.colors.bg).toBe("#161719");
    expect(sent).toEqual([
      { v: 1, type: "progress", id: 1, phase: "preparing" },
      { v: 1, type: "progress", id: 1, phase: "shown" },
    ]);
  });

  it("init ustawia zmienne CSS na :root i motyw dla kolejnych otwarć", async () => {
    const probe = fake("image");
    const { app } = harness({ image: probe.mod });
    app.receive({ v: 1, type: "init", theme: LIGHT });
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--border")).toBe("#cccccc");
    expect(document.documentElement.dataset.theme).toBe("light");
    app.receive(openMsg(1));
    await settle();
    expect(probe.probe.ctx?.theme.name).toBe("light");
  });

  it("PreviewError z przeglądarki idzie jako jego kod", async () => {
    const { app, sent } = harness({
      image: fake("image", { run: async () => { throw new PreviewError("codec"); } }).mod,
    });
    app.receive(openMsg(3));
    await settle();
    expect(sent.at(-1)).toEqual({ v: 1, type: "error", id: 3, code: "codec" });
  });

  it("zwykły wyjątek przeglądarki to corrupt", async () => {
    const { app, sent } = harness({
      image: fake("image", { run: async () => { throw new Error("zepsute"); } }).mod,
    });
    app.receive(openMsg(1));
    await settle();
    expect(sent.at(-1)).toEqual({ v: 1, type: "error", id: 1, code: "corrupt" });
  });

  it("rozmiar ponad limit: too-large bez ładowania modułu", async () => {
    const probe = fake("image");
    const { app, sent } = harness({ image: probe.mod });
    app.receive(openMsg(1, { size: MAX_SIZE.image + 1 }));
    await settle();
    expect(sent.at(-1)).toEqual({ v: 1, type: "error", id: 1, code: "too-large" });
    expect(probe.probe.loads).toBe(0);
  });

  it("bajty ponad limit: too-large", async () => {
    const probe = fake("text");
    const { app, sent } = harness({ text: probe.mod });
    app.receive(openMsg(1, { viewer: "text", size: 10, bytes: new ArrayBuffer(MAX_SIZE.text + 1) }));
    await settle();
    expect(sent.at(-1)).toEqual({ v: 1, type: "error", id: 1, code: "too-large" });
    expect(probe.probe.loads).toBe(0);
  });

  it("brak modułu w rejestrze: unsupported", async () => {
    const { app, sent } = harness({});
    app.receive(openMsg(1, { viewer: "pdf" }));
    await settle();
    expect(sent.at(-1)).toEqual({ v: 1, type: "error", id: 1, code: "unsupported" });
  });

  it("przeglądarka, która się nie kończy: timeout po limicie i dispose", async () => {
    vi.useFakeTimers();
    const probe = fake("image", { run: () => new Promise<void>(() => undefined) });
    const { app, sent } = harness({ image: probe.mod }, 1000);
    app.receive(openMsg(1));
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(sent.some((m) => m.type === "error")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.at(-1)).toEqual({ v: 1, type: "error", id: 1, code: "timeout" });
    expect(probe.probe.disposed).toBe(1);
  });

  it("drugi open przerywa pierwszy: stary dostaje abort i nic już nie wysyła", async () => {
    let release: () => void = () => undefined;
    const first = fake("image", { run: () => new Promise<void>((r) => { release = r; }) });
    const second = fake("text");
    const { app, sent } = harness({ image: first.mod, text: second.mod });
    app.receive(openMsg(1));
    await settle();
    const firstCtx = first.probe.ctx!;
    app.receive(openMsg(2, { viewer: "text" }));
    await settle();
    expect(firstCtx.signal.aborted).toBe(true);
    expect(first.probe.disposed).toBe(1);
    release();
    await settle();
    expect(sent.filter((m) => "id" in m && m.id === 1)).toEqual([{ v: 1, type: "progress", id: 1, phase: "preparing" }]);
    expect(sent.at(-1)).toEqual({ v: 1, type: "progress", id: 2, phase: "shown" });
  });

  it("zły komunikat jest ignorowany bez odpowiedzi", async () => {
    const probe = fake("image");
    const { app, sent } = harness({ image: probe.mod });
    app.receive("x");
    app.receive(null);
    app.receive({ v: 2, type: "open" });
    app.receive({ v: 1, type: "open", id: "1" });
    app.receive({ v: 1, type: "nieznany" });
    await settle();
    expect(sent).toEqual([]);
    expect(probe.probe.loads).toBe(0);
  });

  it("status z przeglądarki idzie jako progress shown ze statusem", async () => {
    const { app, sent } = harness({
      image: fake("image", { run: async (ctx) => ctx.status("Strona 2 z 9") }).mod,
    });
    app.receive(openMsg(1));
    await settle();
    expect(sent).toContainEqual({ v: 1, type: "progress", id: 1, phase: "shown", status: "Strona 2 z 9" });
  });

  it("dispose zamyka plik i czyści host", async () => {
    const probe = fake("image", {
      run: async (ctx) => {
        ctx.host.append(document.createElement("p"));
      },
    });
    const { app, host } = harness({ image: probe.mod });
    app.receive(openMsg(1));
    await settle();
    expect(host.children.length).toBe(1);
    app.receive({ v: 1, type: "dispose" });
    expect(host.children.length).toBe(0);
    expect(probe.probe.disposed).toBe(1);
  });
});

describe("FrameApp: wiadomości w obie strony", () => {
  it("asset rozwiązuje ctx.asset", async () => {
    let got = -1;
    const { app, sent } = harness({
      image: fake("image", { run: async (ctx) => { got = (await ctx.asset("assets/a.wasm")).byteLength; } }).mod,
    });
    app.receive(openMsg(1));
    await settle();
    expect(sent).toContainEqual({ v: 1, type: "asset", path: "assets/a.wasm" });
    app.receive({ v: 1, type: "asset", path: "assets/a.wasm", bytes: new ArrayBuffer(3) });
    await settle();
    expect(got).toBe(3);
  });

  it("asset z null odrzuca się jako internal, a odpowiedź trafia do pamięci podręcznej", async () => {
    let caught: unknown = null;
    let second = -1;
    const { app, sent } = harness({
      image: fake("image", {
        run: async (ctx) => {
          try {
            await ctx.asset("assets/b.wasm");
          } catch (e) {
            caught = e;
          }
          second = (await ctx.asset("assets/c.wasm")).byteLength;
        },
      }).mod,
    });
    app.receive(openMsg(1));
    await settle();
    app.receive({ v: 1, type: "asset", path: "assets/b.wasm", bytes: null });
    await settle();
    expect(caught).toBeInstanceOf(PreviewError);
    expect((caught as PreviewError).code).toBe("internal");
    app.receive({ v: 1, type: "asset", path: "assets/c.wasm", bytes: new ArrayBuffer(5) });
    await settle();
    expect(second).toBe(5);
    expect(sent.filter((m) => m.type === "asset")).toHaveLength(2);
  });

  it("drugi ctx.asset tej samej ścieżki idzie z pamięci podręcznej bez nowej prośby", async () => {
    const got: number[] = [];
    const { app, sent } = harness({
      image: fake("image", {
        run: async (ctx) => {
          got.push((await ctx.asset("assets/d.wasm")).byteLength);
          got.push((await ctx.asset("assets/d.wasm")).byteLength);
        },
      }).mod,
    });
    app.receive(openMsg(1));
    await settle();
    app.receive({ v: 1, type: "asset", path: "assets/d.wasm", bytes: new ArrayBuffer(7) });
    await settle();
    expect(got).toEqual([7, 7]);
    expect(sent.filter((m) => m.type === "asset")).toHaveLength(1);
  });

  it("frame: pierwsza klatka wraca z pikselami, a bajty idą z transferem", async () => {
    const pixels = new ArrayBuffer(480 * 270 * 4);
    vi.mocked(firstFrame).mockResolvedValueOnce({ width: 480, height: 270, pixels, durationMs: 4000 });
    const posted: { m: FromFrame; transfer?: Transferable[] }[] = [];
    const host = document.createElement("main");
    const app = new FrameApp(host, (m, transfer) => posted.push({ m, transfer }));
    app.receive({ v: 1, type: "frame", id: 4, name: "film.mp4", mime: "video/mp4", bytes: new ArrayBuffer(4) });
    await settle();
    expect(firstFrame).toHaveBeenCalledWith(expect.any(ArrayBuffer), "video/mp4", expect.any(AbortSignal), expect.any(Function));
    expect(posted).toEqual([{ m: { v: 1, type: "frame", id: 4, width: 480, height: 270, pixels, durationMs: 4000 }, transfer: [pixels] }]);
  });

  it("frame: błąd z firstFrame idzie jako frame-error z kodem", async () => {
    vi.mocked(firstFrame).mockRejectedValueOnce(new PreviewError("codec"));
    const { app, sent } = harness({});
    app.receive({ v: 1, type: "frame", id: 5, name: "film.mp4", mime: "video/mp4", bytes: new ArrayBuffer(4) });
    await settle();
    expect(sent).toEqual([{ v: 1, type: "frame-error", id: 5, code: "codec" }]);
  });

  it("frame: zwykły wyjątek to corrupt", async () => {
    vi.mocked(firstFrame).mockRejectedValueOnce(new Error("zepsute"));
    const { app, sent } = harness({});
    app.receive({ v: 1, type: "frame", id: 5, name: "film.mp4", mime: "video/mp4", bytes: new ArrayBuffer(4) });
    await settle();
    expect(sent).toEqual([{ v: 1, type: "frame-error", id: 5, code: "corrupt" }]);
  });

  it("frame: bajty ponad 16 MiB to too-large bez dekodowania", () => {
    const { app, sent } = harness({});
    app.receive({ v: 1, type: "frame", id: 6, name: "film.mp4", mime: "video/mp4", bytes: new ArrayBuffer(MAX_SIZE.video + 1) });
    expect(sent).toEqual([{ v: 1, type: "frame-error", id: 6, code: "too-large" }]);
    expect(firstFrame).not.toHaveBeenCalled();
  });

  it("nowy frame przerywa poprzedni: stary dostaje abort i nic nie wysyła", async () => {
    let resolveFirst: (v: { width: number; height: number; pixels: ArrayBuffer }) => void = () => undefined;
    vi.mocked(firstFrame)
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ width: 1, height: 1, pixels: new ArrayBuffer(4) });
    const { app, sent } = harness({});
    app.receive({ v: 1, type: "frame", id: 1, name: "a.mp4", mime: "video/mp4", bytes: new ArrayBuffer(4) });
    const firstSignal = vi.mocked(firstFrame).mock.calls[0]?.[2];
    app.receive({ v: 1, type: "frame", id: 2, name: "b.mp4", mime: "video/mp4", bytes: new ArrayBuffer(4) });
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst({ width: 1, height: 1, pixels: new ArrayBuffer(4) });
    await settle();
    expect(sent.map((m) => ("id" in m ? m.id : null))).toEqual([2]);
  });

  it("nowy open przerywa frame: frame nic nie wysyła", async () => {
    let resolveFrame: (v: { width: number; height: number; pixels: ArrayBuffer }) => void = () => undefined;
    vi.mocked(firstFrame).mockImplementationOnce(() => new Promise((r) => { resolveFrame = r; }));
    const probe = fake("image");
    const { app, sent } = harness({ image: probe.mod });
    app.receive({ v: 1, type: "frame", id: 7, name: "a.mp4", mime: "video/mp4", bytes: new ArrayBuffer(4) });
    const frameSignal = vi.mocked(firstFrame).mock.calls[0]?.[2];
    app.receive(openMsg(8));
    expect(frameSignal?.aborted).toBe(true);
    resolveFrame({ width: 1, height: 1, pixels: new ArrayBuffer(4) });
    await settle();
    expect(sent.some((m) => m.type === "frame")).toBe(false);
    expect(sent.at(-1)).toEqual({ v: 1, type: "progress", id: 8, phase: "shown" });
  });

  it("command trafia do bieżącej przeglądarki tylko przy zgodnym id", async () => {
    const commands: Command[] = [];
    const { app } = harness({ image: fake("image", { commands }).mod });
    app.receive(openMsg(1));
    await settle();
    app.receive({ v: 1, type: "command", id: 1, name: "zoom-in" });
    app.receive({ v: 1, type: "command", id: 9, name: "fit" });
    expect(commands).toEqual(["zoom-in"]);
  });
});

describe("FrameApp: klawisze i gest", () => {
  it("Escape wysyła close", () => {
    const { app, sent } = harness({});
    app.keydown(key("Escape"));
    expect(sent).toEqual([{ v: 1, type: "close" }]);
  });

  it("spacja bez modyfikatorów zamyka z key space i blokuje przewijanie", () => {
    const { app, sent } = harness({});
    const e = key(" ");
    app.keydown(e);
    expect(sent).toEqual([{ v: 1, type: "close", key: "space" }]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("spacja w polu tekstowym nic nie robi", () => {
    const { app, sent } = harness({});
    const input = document.createElement("input");
    document.body.append(input);
    input.addEventListener("keydown", (e) => app.keydown(e));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(sent).toEqual([]);
  });

  it("strzałki wysyłają nav, a Ctrl+S download z blokadą domyślnej akcji", () => {
    const { app, sent } = harness({});
    app.keydown(key("ArrowRight"));
    app.keydown(key("ArrowLeft"));
    expect(sent).toEqual([
      { v: 1, type: "nav", dir: 1 },
      { v: 1, type: "nav", dir: -1 },
    ]);
    const save = key("s", { ctrlKey: true });
    app.keydown(save);
    expect(save.defaultPrevented).toBe(true);
    expect(sent.at(-1)).toEqual({ v: 1, type: "download" });
  });

  it("klawisz obsłużony przez viewer.key nie idzie do rodzica", async () => {
    const { app, sent } = harness({ image: fake("image", { key: () => true }).mod });
    app.receive(openMsg(1));
    await settle();
    const before = sent.length;
    const e = key("Escape");
    app.keydown(e);
    expect(sent.length).toBe(before);
    expect(e.defaultPrevented).toBe(true);
  });

  it("plus, minus i zero idą do przeglądarki jako komendy zoom", async () => {
    const commands: Command[] = [];
    const { app } = harness({ image: fake("image", { commands }).mod });
    app.receive(openMsg(1));
    await settle();
    app.keydown(key("+"));
    app.keydown(key("="));
    app.keydown(key("-"));
    app.keydown(key("0"));
    expect(commands).toEqual(["zoom-in", "zoom-in", "zoom-out", "zoom-reset"]);
  });

  it("gest poziomy idzie jako nav, chyba że treść go przejmuje", async () => {
    // swipe() false means the content owns the drag (a zoomed image)
    let zoomed = false;
    const { app, sent } = harness({ image: fake("image", { swipe: () => !zoomed }).mod });
    app.receive(openMsg(1));
    await settle();
    app.swipe(1);
    expect(sent.at(-1)).toEqual({ v: 1, type: "nav", dir: 1 });
    zoomed = true;
    const before = sent.length;
    app.swipe(-1);
    expect(sent.length).toBe(before);
  });
});
