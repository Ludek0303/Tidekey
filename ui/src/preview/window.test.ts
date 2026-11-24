// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PreviewFailure, type FrameEvents } from "./frame";
import type { PreviewItem } from "./items";
import { serialize } from "../ocr/filetext";
import type { TextLayerInfo } from "../remotefiles";
import { VIDEO_HEAD_BYTES, openPreview, splitName, type PreviewDeps } from "./window";

const MIB = 1024 * 1024;
type ReadOpts = { signal?: AbortSignal; onProgress?: (done: number, total: number) => void };
type Still = { width: number; height: number; pixels: ArrayBuffer; durationMs?: number };

// A ZIP local header with one entry: the viewer tells "zip" from the entry names alone.
function zipBytes(): Uint8Array<ArrayBuffer> {
  const name = new TextEncoder().encode("notatki.txt");
  const out = new Uint8Array(30 + name.length);
  out.set([0x50, 0x4b, 0x03, 0x04]);
  out[26] = name.length;
  out.set(name, 30);
  return out;
}

interface FakeFrame {
  element: HTMLIFrameElement;
  events: FrameEvents;
  open: Mock;
  frame: Mock;
  command: Mock;
  dispose: Mock;
  destroy: Mock;
}

// Behaviour of the next fake frame; each test sets it before opening a window.
let frameOpen: () => Promise<void>;
let frameStill: () => Promise<Still>;
let frames: FakeFrame[];
let online: boolean;
let encodeThumb: Mock;
let closers: Array<() => void>;

function createFrame(parent: HTMLElement, events: FrameEvents): FakeFrame {
  const element = document.createElement("iframe");
  parent.append(element);
  const fake: FakeFrame = {
    element,
    events,
    open: vi.fn(() => frameOpen()),
    frame: vi.fn(() => frameStill()),
    command: vi.fn(),
    dispose: vi.fn(),
    destroy: vi.fn(),
  };
  frames.push(fake);
  return fake;
}

function makeItem(name: string, extra: { mime?: string; size?: number; thumb?: string | null; durationMs?: number | null } = {}) {
  return {
    key: name,
    name,
    mime: extra.mime ?? "application/pdf",
    size: extra.size ?? 2 * MIB,
    durationMs: extra.durationMs ?? null,
    thumb: extra.thumb ?? null,
    read: vi.fn(async (o: ReadOpts) => {
      o.onProgress?.(MIB, 2 * MIB);
      return new Blob([zipBytes()]);
    }),
    readHead: vi.fn(async () => ({ blob: new Blob([new Uint8Array(8)]), complete: false })),
    readThumb: vi.fn((): Promise<Blob> | null => null),
    saveThumb: vi.fn(async () => {}),
    text: null,
    download: vi.fn(),
    open: vi.fn(),
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("brak elementu");
  return value;
}
const root = (): HTMLElement => must(document.querySelector<HTMLElement>(".podglad"));
const stan = (): HTMLElement => must(document.querySelector<HTMLElement>(".podglad-stan"));
const counter = (): string | null | undefined => root().querySelector(".podglad-licznik")?.textContent;
const srRegion = (): HTMLElement => must(root().querySelector<HTMLElement>(".sr-only"));
// Finds a button of the bar or of a card by its aria-label or its visible text.
const btn = (label: string): HTMLButtonElement =>
  must([...root().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label));
const stanButtons = (): string[] => [...stan().querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

function key(k: string, init: KeyboardEventInit = {}, target: HTMLElement = root()): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

function deps(): Partial<PreviewDeps> {
  return { createFrame, encodeThumb: encodeThumb as PreviewDeps["encodeThumb"], online: () => online };
}

function open(items: PreviewItem[], index = 0, bySpace = false): () => void {
  const close = openPreview(items, index, { bySpace, deps: deps() });
  closers.push(close);
  return close;
}

beforeEach(() => {
  frames = [];
  online = true;
  closers = [];
  frameOpen = async () => {};
  frameStill = async () => ({ width: 4, height: 3, pixels: new ArrayBuffer(48), durationMs: 5000 });
  encodeThumb = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
});

afterEach(() => {
  for (const close of closers) close();
  document.body.replaceChildren();
});

describe("openPreview: otwarcie", () => {
  it("nazywa dialog nazwą pliku, wstawia ją jako tekst i ustawia fokus na Zamknij", async () => {
    const name = `<img src=x onerror="window.hit=1">.pdf`;
    open([makeItem(name)]);
    const okno = must(document.querySelector<HTMLElement>(".podglad-okno"));
    expect(okno.getAttribute("role")).toBe("dialog");
    expect(okno.getAttribute("aria-modal")).toBe("true");
    const title = must(document.getElementById(must(okno.getAttribute("aria-labelledby"))));
    expect(title.textContent).toBe(name);
    expect(title.title).toBe(name);
    expect(document.querySelector("img")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Zamknij");
    await tick();
  });

  it("Tab out of the frame reaches the first control of the bar, not the outside of the window", async () => {
    open([makeItem("a.pdf"), makeItem("b.pdf")]);
    const guard = must(document.querySelector<HTMLElement>(".podglad-straznik"));
    // the guard comes after the frame in tab order
    expect(guard.tabIndex).toBe(0);
    guard.focus();
    const first = document.activeElement as HTMLElement;
    expect(first.closest(".podglad-pasek")).not.toBeNull();
    expect(first.getAttribute("aria-label")).not.toBe("Zamknij");
    await tick();
  });

  it("passes a theme switch to the frame while the window is open, and stops at close", async () => {
    const setTheme = vi.fn();
    const close = openPreview([makeItem("a.pdf")], 0, { deps: { ...deps(), createFrame: (parent, events) => ({ ...createFrame(parent, events), setTheme }) } });
    document.documentElement.setAttribute("data-theme", "light");
    await tick();
    expect(setTheme).toHaveBeenCalledWith(expect.objectContaining({ name: "light" }));
    close();
    setTheme.mockClear();
    document.documentElement.setAttribute("data-theme", "dark");
    await tick();
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("dzieli nazwę tak, by koniec zawierał ostatnie 12 znaków", () => {
    const long = "Raport z przeglądu instalacji elektrycznej budynek B piętro 3.pdf";
    const [start, end] = splitName(long);
    expect(end).toBe("piętro 3.pdf");
    expect(start + end).toBe(long);
    expect(splitName("a.pdf")).toEqual(["", "a.pdf"]);
    const noExt = "Notatka bez rozszerzenia do podglądu";
    const [s2, e2] = splitName(noExt);
    expect(e2).toHaveLength(12);
    expect(s2 + e2).toBe(noExt);
  });

  it("nie dzieli polskich znaków", () => {
    expect(splitName("Zażółć gęślą jaźń.docx")).toEqual(["Zażółć gęś", "lą jaźń.docx"]);
  });

  it("nieobsługiwany format to karta bez pobierania", async () => {
    const it = makeItem("instalator.exe", { mime: "application/octet-stream" });
    open([it]);
    await tick();
    expect(stan().textContent).toContain("Tego rodzaju pliku nie da się podejrzeć.");
    expect(it.read).not.toHaveBeenCalled();
  });

  it("za duży PDF to karta z limitem, bez odczytu", async () => {
    const it = makeItem("raport.pdf", { size: 200 * MIB });
    open([it]);
    await tick();
    expect(stan().textContent).toContain("Ten plik jest za duży na podgląd (limit 100 MB).");
    expect(it.read).not.toHaveBeenCalled();
  });
});

describe("openPreview: ładowanie i błędy", () => {
  it("pokazuje postęp w MB, potem ramkę z typem z bajtów, a po pokazaniu chowa stan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const it = makeItem("raport.pdf");
    it.read.mockImplementation(async (o: ReadOpts) => {
      o.onProgress?.(MIB, 2 * MIB);
      await gate;
      return new Blob([zipBytes()]);
    });
    open([it]);
    await tick();
    expect(stan().textContent).toContain("1 z 2 MB");
    release();
    await tick();
    // PDF name, but the bytes are a ZIP: the bytes win.
    expect(frames[0].open).toHaveBeenCalledWith(expect.objectContaining({ name: "raport.pdf", viewer: "zip" }));
    expect(stan().hidden).toBe(true);
  });

  it("błąd ramki corrupt to karta błędu z powodem i Pobierz", async () => {
    frameOpen = async () => {
      throw new PreviewFailure("corrupt");
    };
    open([makeItem("raport.pdf")]);
    await tick();
    expect(stan().querySelector("h2")?.textContent).toBe("Nie można wyświetlić tego pliku");
    expect(stan().textContent).toContain("Plik jest uszkodzony albo ma nieznany format.");
    expect(stanButtons()).toContain("Pobierz");
  });

  it("brak sieci to karta, a Spróbuj ponownie ponawia odczyt", async () => {
    online = false;
    const it = makeItem("raport.pdf");
    it.read.mockRejectedValueOnce(new Error("Plik jest niedostępny bez połączenia."));
    open([it]);
    await tick();
    expect(stan().querySelector("h2")?.textContent).toBe("Plik jest niedostępny bez połączenia");
    online = true;
    const retry = must([...stan().querySelectorAll("button")].find((b) => b.textContent === "Spróbuj ponownie"));
    retry.click();
    await tick();
    expect(it.read).toHaveBeenCalledTimes(2);
    expect(frames[0].open).toHaveBeenCalled();
  });
});

describe("openPreview: wideo", () => {
  it("wideo z miniaturą pokazuje ją bez czytania pliku", async () => {
    const it = makeItem("film.mp4", { mime: "video/mp4", size: 300 * MIB, thumb: "t1", durationMs: 83000 });
    it.readThumb.mockReturnValue(Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" })));
    open([it]);
    await tick();
    expect(it.readThumb).toHaveBeenCalled();
    expect(it.read).not.toHaveBeenCalled();
    expect(it.readHead).not.toHaveBeenCalled();
    expect(frames[0].open).toHaveBeenCalledWith(expect.objectContaining({ viewer: "image", label: "first-frame", durationMs: 83000 }));
  });

  it("wideo bez miniatury: początek pliku, ramka, miniatura, zapis w tle", async () => {
    const it = makeItem("film.mp4", { mime: "video/mp4", size: 300 * MIB });
    open([it]);
    await tick();
    expect(it.readHead).toHaveBeenCalledWith(VIDEO_HEAD_BYTES, expect.anything());
    expect(it.read).not.toHaveBeenCalled();
    expect(frames[0].frame).toHaveBeenCalled();
    expect(encodeThumb).toHaveBeenCalledWith(expect.any(ArrayBuffer), 4, 3);
    expect(frames[0].open).toHaveBeenCalledWith(expect.objectContaining({ viewer: "image", label: "first-frame", durationMs: 5000 }));
    expect(it.saveThumb).toHaveBeenCalledWith(expect.objectContaining({ width: 4, height: 3 }));
  });

  it("odrzucony zapis miniatury nic nie pokazuje", async () => {
    const it = makeItem("film.mp4", { mime: "video/mp4", size: 300 * MIB });
    it.saveThumb.mockRejectedValue(new Error("brak prawa zapisu"));
    open([it]);
    await tick();
    expect(frames[0].open).toHaveBeenCalled();
    expect(stan().hidden).toBe(true);
    expect(document.querySelector(".podglad-karta")).toBeNull();
  });

  it("błąd ramki dla wideo to karta wideo z Otwórz i Pobierz", async () => {
    frameStill = async () => {
      throw new PreviewFailure("codec");
    };
    open([makeItem("film.mp4", { mime: "video/mp4", size: 300 * MIB })]);
    await tick();
    expect(stan().textContent).toContain("Pierwszej klatki nie da się pokazać.");
    expect(stanButtons()).toEqual(["Otwórz", "Pobierz"]);
  });
});

describe("openPreview: nawigacja i klawiatura", () => {
  it("strzałka przerywa odczyt poprzedniego pliku, zmienia licznik i wyłącza ‹ na pierwszym", async () => {
    const a = makeItem("a.pdf");
    a.read.mockImplementation((o: ReadOpts) => new Promise<Blob>((_, reject) => o.signal?.addEventListener("abort", () => reject(new DOMException("Anulowano", "AbortError")))));
    const b = makeItem("b.pdf");
    const c = makeItem("c.pdf");
    open([a, b, c]);
    await tick();
    expect(counter()).toBe("1 z 3");
    expect(btn("Poprzedni plik").disabled).toBe(true);
    key("ArrowRight");
    await tick();
    expect(a.read.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(counter()).toBe("2 z 3");
    expect(b.read).toHaveBeenCalled();
    expect(btn("Poprzedni plik").disabled).toBe(false);
  });

  it("‹ › nie zawijają się na końcach", async () => {
    open([makeItem("a.pdf"), makeItem("b.pdf")]);
    await tick();
    key("ArrowLeft");
    expect(counter()).toBe("1 z 2");
    key("ArrowRight");
    await tick();
    key("ArrowRight");
    expect(counter()).toBe("2 z 2");
    expect(btn("Następny plik").disabled).toBe(true);
  });

  it("licznik i strzałki są ukryte przy jednym pliku", () => {
    open([makeItem("a.pdf")]);
    const nav = must(root().querySelector<HTMLElement>(".podglad-nav"));
    expect(nav.hidden).toBe(true);
  });

  it("Esc zamyka okno", () => {
    open([makeItem("a.pdf")]);
    key("Escape");
    expect(document.querySelector(".podglad")).toBeNull();
  });

  it("spacja zamyka tylko okno otwarte spacją i tylko poza przyciskiem", async () => {
    open([makeItem("a.pdf")], 0, false);
    await tick();
    key(" ");
    expect(document.querySelector(".podglad")).not.toBeNull();
    key("Escape");
    open([makeItem("b.pdf")], 0, true);
    await tick();
    key(" ", {}, btn("Zamknij"));
    expect(document.querySelector(".podglad")).not.toBeNull();
    key(" ");
    expect(document.querySelector(".podglad")).toBeNull();
  });

  it("Ctrl+S pobiera i blokuje domyślne zapisanie strony", async () => {
    const it = makeItem("a.pdf");
    open([it]);
    await tick();
    const ev = key("s", { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(it.download).toHaveBeenCalled();
  });

  it("+ = - 0 sterują przybliżeniem ramki", async () => {
    open([makeItem("a.pdf")]);
    await tick();
    key("+");
    key("=");
    key("-");
    key("0");
    expect(frames[0].command.mock.calls.map((c) => c[0])).toEqual(["zoom-in", "zoom-in", "zoom-out", "zoom-reset"]);
  });
});

describe("openPreview: zdarzenia ramki i zamknięcie", () => {
  it("nav przełącza plik, status trafia do regionu, download pobiera, close zamyka tylko gdy wolno", async () => {
    const items = [makeItem("a.pdf"), makeItem("b.pdf")];
    open(items);
    await tick();
    frames[0].events.onNav(1);
    await tick();
    expect(counter()).toBe("2 z 2");
    frames[0].events.onStatus("Strona 2 z 4");
    expect(srRegion().textContent).toBe("Strona 2 z 4");
    frames[0].events.onDownload();
    expect(items[1].download).toHaveBeenCalled();
    frames[0].events.onClose(true);
    expect(document.querySelector(".podglad")).not.toBeNull();
    frames[0].events.onClose(false);
    expect(document.querySelector(".podglad")).toBeNull();
  });

  it("zamknięcie niszczy ramkę, usuwa okno i oddaje fokus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const close = open([makeItem("a.pdf")]);
    await tick();
    close();
    expect(frames[0].destroy).toHaveBeenCalled();
    expect(document.querySelector(".podglad")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("drugie otwarcie zamyka pierwsze okno", async () => {
    open([makeItem("a.pdf")]);
    open([makeItem("b.pdf")]);
    await tick();
    expect(document.querySelectorAll(".podglad")).toHaveLength(1);
    expect(frames[0].destroy).toHaveBeenCalled();
  });

  it("Tab z ostatniego elementu wraca na pierwszy, a fokus spoza okna wraca na Zamknij", async () => {
    open([makeItem("a.pdf")]);
    await tick();
    frames[0].element.focus();
    key("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pobierz");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Zamknij");
  });
});

describe("Tekst tab", () => {
  const layer: TextLayerInfo = { id: "l1", textOf: "a".repeat(32), createdAt: 0, createdBy: "ana", extractor: 1, method: "ocr", pages: 2, lang: "latin", quality: 0.5, flags: [], engine: "pp" };
  const markdown = serialize({ source: "a".repeat(32), name: "a.pdf", mime: "application/pdf", method: "ocr", pages: [{ n: 1, text: "Pierwsza strona", lowQuality: false }, { n: 2, text: "Druga", lowQuality: true }], lang: "latin", quality: 0.5, flags: [], extractor: 1, engine: "pp", createdAt: "2026-11-19T15:02:11Z" });

  it("shows the layer page by page, marks low quality, and offers no recognition to a viewer", async () => {
    const item = { ...makeItem("a.pdf", { mime: "application/pdf" }), key: "a".repeat(32), text: { load: vi.fn(async () => ({ info: layer, markdown })) } };
    const close = openPreview([item], 0, { deps: deps() });
    closers.push(close);
    btn("Tekst").click();
    await tick();
    await tick();
    const pane = must(document.querySelector<HTMLElement>(".podglad-tekst"));
    expect(pane.hidden).toBe(false);
    expect(pane.textContent).toContain("Pierwsza strona");
    expect(pane.textContent).toContain("niska jakość");
    expect(pane.textContent).toContain("Kopiuj tekst");
    expect([...pane.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Rozpoznaj tekst");
    btn("Tekst").click();
    expect(pane.hidden).toBe(true);
  });

  it("is absent when the store keeps no text layers", () => {
    const close = openPreview([makeItem("a.pdf")], 0, { deps: deps() });
    closers.push(close);
    expect(must(document.querySelector<HTMLButtonElement>(".podglad-tekst-przycisk")).hidden).toBe(true);
  });
});

describe("Tekst tab opened on a search hit", () => {
  const markdown = serialize({ source: "a".repeat(32), name: "a.pdf", mime: "application/pdf", method: "ocr", pages: [{ n: 1, text: "Pierwsza strona", lowQuality: false }, { n: 2, text: "Termin płatności 14 dni", lowQuality: false }], lang: "latin", quality: 0.9, flags: [], extractor: 1, engine: "pp", createdAt: "2026-11-19T15:02:11Z" });

  it("opens on the page of the hit, with the first match of the term marked (diacritics folded)", async () => {
    const info = { id: "l1", textOf: "a".repeat(32), createdAt: 0, createdBy: "ana", extractor: 1, method: "ocr", pages: 2, lang: "latin", quality: 0.9, flags: [], engine: "pp" } as TextLayerInfo;
    const item = { ...makeItem("a.pdf", { mime: "application/pdf" }), key: "a".repeat(32), text: { load: vi.fn(async () => ({ info, markdown })) } };
    const close = openPreview([item], 0, { deps: deps(), text: { page: 2, mark: "platnosci" } });
    closers.push(close);
    await tick();
    await tick();
    const pane = must(document.querySelector<HTMLElement>(".podglad-tekst"));
    expect(pane.hidden).toBe(false);
    expect(must(pane.querySelector("mark")).textContent).toBe("płatności");
    expect(must(pane.querySelector("[data-strona='2'] mark")).textContent).toBe("płatności");
    expect(pane.querySelector("[data-strona='1'] mark")).toBeNull();
  });
});
