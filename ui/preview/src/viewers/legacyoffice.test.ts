// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../../../src/preview/protocol";
import { previewWasm } from "../previewwasm";
import { PreviewError, type ViewerContext } from "./index";
import { createDocViewer, parseDocModel } from "./doc";
import { createPptViewer, parseSlides } from "./ppt";

// The WASM module is replaced by a fake: the parsers are tested in Rust, here only the frame side is checked.
vi.mock("../previewwasm", () => ({ previewWasm: vi.fn() }));

const THEME: Theme = {
  name: "dark",
  colors: { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" },
};

function context(host: HTMLElement, status = vi.fn()): ViewerContext {
  return {
    host,
    name: "plik.doc",
    mime: "application/msword",
    size: 1000,
    signal: new AbortController().signal,
    theme: THEME,
    asset: vi.fn(async () => new ArrayBuffer(0)),
    spawnWorker: vi.fn(async () => null),
    status,
    nav: vi.fn(),
  };
}

function wasmWith(fake: Record<string, unknown>): void {
  vi.mocked(previewWasm).mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof previewWasm>>);
}

const docJson = (paragraphs: unknown[]): string => JSON.stringify({ paragraphs });

describe("parseDocModel", () => {
  it("czyta poprawny JSON: akapity zwykłe, zachowują kolejność", () => {
    const pages = parseDocModel(docJson([
      { text: "Pierwszy", kind: "normal" },
      { text: "Drugi", kind: "normal" },
    ]));
    expect(pages).toEqual([[{ kind: "p", text: "Pierwszy" }, { kind: "p", text: "Drugi" }]]);
  });

  it("zły kształt → corrupt", () => {
    const bad = [
      "not json",
      JSON.stringify({ akapity: [] }),
      docJson([{ text: "x", kind: "akapit" }]),
      docJson([{ text: 5, kind: "normal" }]),
      docJson(["tekst"]),
    ];
    for (const json of bad) {
      expect(() => parseDocModel(json)).toThrow(PreviewError);
      expect(() => parseDocModel(json)).toThrow("corrupt");
    }
  });

  it("składa komórki w wiersze tabeli; pusty akapit cell kończy wiersz", () => {
    const pages = parseDocModel(docJson([
      { text: "Lp", kind: "cell" },
      { text: "Nazwa", kind: "cell" },
      { text: "", kind: "cell" },
      { text: "1", kind: "cell" },
      { text: "Wstęp", kind: "cell" },
      { text: "", kind: "cell" },
      { text: "Koniec", kind: "normal" },
    ]));
    expect(pages).toEqual([[
      { kind: "table", rows: [["Lp", "Nazwa"], ["1", "Wstęp"]] },
      { kind: "p", text: "Koniec" },
    ]]);
  });

  it("podział strony (page) zaczyna nową kartkę; tekst przed podziałem zostaje na starej", () => {
    const pages = parseDocModel(docJson([
      { text: "A", kind: "normal" },
      { text: "X", kind: "page" },
      { text: "B", kind: "normal" },
    ]));
    expect(pages).toEqual([
      [{ kind: "p", text: "A" }, { kind: "p", text: "X" }],
      [{ kind: "p", text: "B" }],
    ]);
  });

  it("dokument bez tekstu nie ma kartek", () => {
    expect(parseDocModel(docJson([]))).toEqual([]);
    expect(parseDocModel(docJson([{ text: "", kind: "normal" }, { text: "", kind: "page" }]))).toEqual([]);
  });
});

describe("parseSlides", () => {
  it("czyta tytuł, teksty i obrazy", () => {
    const slides = parseSlides(JSON.stringify({
      slides: [{ title: "Plan", texts: ["Punkt"], pictures: [0] }, { title: null, texts: [], pictures: [] }],
    }), 1);
    expect(slides).toEqual([
      { title: "Plan", texts: ["Punkt"], pictures: [0] },
      { title: null, texts: [], pictures: [] },
    ]);
  });

  it("indeks obrazu poza zakresem jest pomijany", () => {
    const slides = parseSlides(JSON.stringify({ slides: [{ title: null, texts: [], pictures: [0, 2, 7] }] }), 3);
    expect(slides[0]?.pictures).toEqual([0, 2]);
  });

  it("zły kształt → corrupt", () => {
    const bad = [
      "{",
      JSON.stringify({ karty: [] }),
      JSON.stringify({ slides: [{ title: 3, texts: [], pictures: [] }] }),
      JSON.stringify({ slides: [{ title: null, texts: [1], pictures: [] }] }),
      JSON.stringify({ slides: [{ title: null, texts: [], pictures: ["0"] }] }),
      JSON.stringify({ slides: [{ title: null, texts: [], pictures: [0.5] }] }),
    ];
    for (const json of bad) {
      expect(() => parseSlides(json, 1)).toThrow("corrupt");
    }
  });
});

describe("widok .doc", () => {
  beforeEach(() => {
    vi.mocked(previewWasm).mockReset();
  });

  it("tekst z HTML nie tworzy elementów: wszystko przez textContent", async () => {
    wasmWith({ docTextJson: () => docJson([{ text: "<img src=x onerror=\"alert(1)\"><b>x</b>", kind: "normal" }]) });
    const host = document.createElement("div");
    document.body.append(host);
    await createDocViewer().open(new ArrayBuffer(8), context(host));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toContain("<img src=x");
    host.remove();
  });

  it("liczy akapity w pasku stanu i pokazuje informację o formacie", async () => {
    wasmWith({ docTextJson: () => docJson([{ text: "A", kind: "normal" }, { text: "B", kind: "normal" }]) });
    const host = document.createElement("div");
    const status = vi.fn();
    await createDocViewer().open(new ArrayBuffer(8), context(host, status));
    expect(status).toHaveBeenCalledWith("Akapitów: 2");
    expect(host.textContent).toContain("Podgląd bez formatowania (stary format .doc).");
  });

  it("pusty dokument", async () => {
    wasmWith({ docTextJson: () => docJson([]) });
    const host = document.createElement("div");
    await createDocViewer().open(new ArrayBuffer(8), context(host));
    expect(host.textContent).toContain("Dokument jest pusty.");
  });

  it("kod błędu z WASM staje się PreviewError z tym kodem", async () => {
    for (const code of ["too-large", "corrupt", "unsupported"]) {
      wasmWith({
        docTextJson: () => {
          throw new Error(code);
        },
      });
      await expect(createDocViewer().open(new ArrayBuffer(8), context(document.createElement("div")))).rejects.toMatchObject({
        code,
      });
    }
  });

  it("panika WASM (RuntimeError) → corrupt", async () => {
    wasmWith({
      docTextJson: () => {
        throw new WebAssembly.RuntimeError("unreachable");
      },
    });
    await expect(createDocViewer().open(new ArrayBuffer(8), context(document.createElement("div")))).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});

describe("widok .ppt", () => {
  const PNG = "image/png";
  let deck: { free: ReturnType<typeof vi.fn> };
  const urls = new Set<string>();

  beforeEach(() => {
    vi.mocked(previewWasm).mockReset();
    let n = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        const url = `blob:test/${++n}`;
        urls.add(url);
        return url;
      }),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn((url: string) => urls.delete(url)),
    });
    deck = { free: vi.fn() };
  });

  afterEach(() => {
    urls.clear();
  });

  function deckWith(slides: unknown, mimes: string[]): void {
    wasmWith({
      pptSlides: () => ({
        ...deck,
        slides_json: () => JSON.stringify({ slides }),
        picture_count: () => mimes.length,
        picture_mime: (i: number) => mimes[i] ?? "",
        picture: () => new Uint8Array([137, 80, 78, 71]),
      }),
    });
  }

  it("obrazy tylko png i jpeg; inne są pominięte", async () => {
    deckWith([{ title: "T", texts: ["x"], pictures: [0, 1] }], [PNG, "image/gif"]);
    const host = document.createElement("div");
    document.body.append(host);
    const viewer = createPptViewer();
    await viewer.open(new ArrayBuffer(8), context(host));
    const imgs = host.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute("src")).toMatch(/^blob:/);
    expect(host.querySelector("h2")?.textContent).toBe("T");
    viewer.dispose();
    host.remove();
  });

  it("dispose zwalnia adresy obrazów i zwalnia moduł WASM", async () => {
    deckWith([{ title: null, texts: [], pictures: [0] }], [PNG]);
    const host = document.createElement("div");
    const viewer = createPptViewer();
    await viewer.open(new ArrayBuffer(8), context(host));
    expect(urls.size).toBe(1);
    viewer.dispose();
    expect(urls.size).toBe(0);
    expect(deck.free).toHaveBeenCalled();
  });

  it("tekst z HTML na slajdzie nie tworzy elementów", async () => {
    deckWith([{ title: "<img src=x onerror=\"alert(1)\">", texts: ["<script>alert(2)</script>"], pictures: [] }], []);
    const host = document.createElement("div");
    await createPptViewer().open(new ArrayBuffer(8), context(host));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("<script>alert(2)</script>");
  });

  it("strzałki w prawo i w lewo zmieniają slajd; na krańcu zwracają false", async () => {
    deckWith([{ title: "A", texts: [], pictures: [] }, { title: "B", texts: [], pictures: [] }], []);
    const host = document.createElement("div");
    const status = vi.fn();
    const viewer = createPptViewer();
    await viewer.open(new ArrayBuffer(8), context(host, status));
    expect(status).toHaveBeenLastCalledWith("Slajd 1 z 2");
    const right = new KeyboardEvent("keydown", { key: "ArrowRight" });
    expect(viewer.key?.(right)).toBe(true);
    expect(status).toHaveBeenLastCalledWith("Slajd 2 z 2");
    expect(viewer.key?.(new KeyboardEvent("keydown", { key: "ArrowRight" }))).toBe(false);
    expect(viewer.key?.(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe(true);
    expect(status).toHaveBeenLastCalledWith("Slajd 1 z 2");
    expect(viewer.key?.(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe(false);
    viewer.dispose();
  });

  it("zły kształt slajdów → corrupt, a moduł WASM jest zwolniony", async () => {
    wasmWith({
      pptSlides: () => ({ ...deck, slides_json: () => "{}", picture_count: () => 0, picture_mime: () => "" }),
    });
    await expect(createPptViewer().open(new ArrayBuffer(8), context(document.createElement("div")))).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(deck.free).toHaveBeenCalled();
  });
});
