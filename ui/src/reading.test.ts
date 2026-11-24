// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { initFormula } from "./formula";
import { ReadingView, findNote } from "./reading";
import { shortUrl } from "./livepreview";

const EXAMPLE = `| Zadanie | Start | Koniec | Dni |
|---|---|---|---|
| Projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |
| Testy | 19.10.2026 | =B3+14 | =C3-B3 |
| **Razem** | | | =SUMA(D2:D3) |`;

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const modeBtn = () => $<HTMLButtonElement>("#btn-mode");
const readingEl = () => $("#reading");
const activeTab = () => $(".tab.is-active");
const editor = () => EditorView.findFromDOM($(".editor .cm-editor"))!;

function setText(text: string): void {
  const view = editor();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

function pressCtrlE(): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true });
  $(".cm-content").dispatchEvent(ev);
  return ev;
}

function tabByTitle(title: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>(".tab")].find((t) => t.textContent === title)!;
}

describe("findNote", () => {
  const items = [
    { id: "1", path: "Dziennik/2026-10-18.md" },
    { id: "2", path: "Projekty/Plan.md" },
    { id: "3", path: "Plan.md" },
  ];

  it("matches by name, folder path and case, preferring the root note", () => {
    expect(findNote(items, "Projekty/Plan")?.id).toBe("2");
    expect(findNote(items, "plan.md")?.id).toBe("3");
    expect(findNote(items, "PROJEKTY/plan")?.id).toBe("2");
    expect(findNote(items, "2026-10-18")?.id).toBe("1");
  });

  it("returns undefined for unknown or empty targets", () => {
    expect(findNote(items, "Nie ma")).toBeUndefined();
    expect(findNote(items, "  ")).toBeUndefined();
  });
});

beforeAll(async () => {
  // jsdom has no layout; CodeMirror measures selections through these.
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  const bytes = readFileSync(resolve(__dirname, "wasm/notes_web_bg.wasm"));
  vi.stubGlobal(
    "fetch",
    async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }),
  );
  await initFormula();
  vi.unstubAllGlobals();
});

describe("reading mode in the app", () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("./main");
    await vi.waitFor(() => expect(activeTab().textContent).toBe("2026-10-18"));
  });

  it("Ctrl+E toggles the active tab and prevents the browser default", () => {
    expect(readingEl().hidden).toBe(true);
    const ev = pressCtrlE();
    expect(ev.defaultPrevented).toBe(true);
    expect(readingEl().hidden).toBe(false);
    expect($(".editor").hidden).toBe(true);

    pressCtrlE();
    expect(readingEl().hidden).toBe(true);
    expect($(".editor").hidden).toBe(false);
  });

  it("Ctrl+E leaves reading mode again from the keyboard", () => {
    pressCtrlE();
    expect(readingEl().hidden).toBe(false);
    expect(document.activeElement).toBe(readingEl());
    const ev = new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(readingEl().hidden).toBe(true);
  });

  it("the toolbar button toggles and sets aria-pressed", () => {
    expect(modeBtn().getAttribute("aria-pressed")).toBe("false");
    expect(modeBtn().textContent).toBe("Czytanie");

    modeBtn().click();
    expect(modeBtn().getAttribute("aria-pressed")).toBe("true");
    expect(modeBtn().textContent).toBe("Edycja");
    expect(readingEl().hidden).toBe(false);

    modeBtn().click();
    expect(modeBtn().getAttribute("aria-pressed")).toBe("false");
    expect(readingEl().hidden).toBe(true);
  });

  it("renders the example table with formula results and formula errors", () => {
    setText(`${EXAMPLE}\n\n| x |\n|---|\n| =1/0 |\n`);
    modeBtn().click();

    const table = readingEl().querySelector("table");
    expect(table).not.toBeNull();
    expect(table!.textContent).toContain("18");
    expect(table!.textContent).toContain("02.11.2026");
    expect(table!.textContent).toContain("32");
    const error = readingEl().querySelector(".formula-error");
    expect(error?.textContent).toBe("#DZIEL/0!");
    modeBtn().click();
  });

  it("re-renders reading mode when the note text changes", async () => {
    modeBtn().click();
    setText("# Zmieniona wersja\n");
    await vi.waitFor(() => expect(readingEl().innerHTML).toContain("Zmieniona wersja"));
    modeBtn().click();
  });

  it("does not run script from note text", () => {
    delete (window as unknown as { __x?: number }).__x;
    setText("<script>window.__x=1</script>\n\nTekst");
    modeBtn().click();

    expect(readingEl().querySelector("script")).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
    expect(readingEl().textContent).toContain("<script>window.__x=1</script>");
    modeBtn().click();
  });

  it("clicking a wikilink opens the note it names, in source mode", async () => {
    setText("Zobacz [[Plan]].");
    modeBtn().click();
    readingEl().querySelector<HTMLElement>(".wikilink")!.click();

    await vi.waitFor(() => expect(activeTab().textContent).toBe("Plan"));
    expect(modeBtn().getAttribute("aria-pressed")).toBe("false");
  });

  it("the reading mode belongs to each tab", () => {
    tabByTitle("2026-10-18").click();
    expect(modeBtn().getAttribute("aria-pressed")).toBe("true");
    tabByTitle("Plan").click();
    expect(modeBtn().getAttribute("aria-pressed")).toBe("false");
  });

  it("Ctrl+E does not toggle while quick open is showing", () => {
    $<HTMLButtonElement>("#btn-quick").click();
    const input = $<HTMLInputElement>(".qo-input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(readingEl().hidden).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("web links open in a new window and never navigate the app", () => {
    setText("[sajt](https://example.pl/a)");
    modeBtn().click();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const before = window.location.href;
    readingEl().querySelector<HTMLAnchorElement>("a[href]")!.click();

    expect(open).toHaveBeenCalledWith("https://example.pl/a", "_blank", "noopener,noreferrer");
    expect(window.location.href).toBe(before);
    open.mockRestore();
    modeBtn().click();
  });

  it("relative links open the note they name", async () => {
    setText("[dziennik](Dziennik/2026-10-18.md)");
    modeBtn().click();
    readingEl().querySelector<HTMLAnchorElement>("a[href]")!.click();

    await vi.waitFor(() => expect(activeTab().textContent).toBe("2026-10-18"));
  });
});

describe("ReadingView", () => {
  it("a short word's space is non-breaking in the rendered text, code keeps its spaces", () => {
    const host = document.createElement("div");
    const view = new ReadingView(host, () => {}, () => "<p>Ala w <b>domu</b> i <code>x y z</code> na końcu</p>");
    view.show("ignored");
    expect(host.querySelector("p")!.textContent).toBe("Ala\u00a0w\u00a0domu i\u00a0x y z na\u00a0końcu");
    expect(host.querySelector("code")!.textContent).toBe("x y z");
  });
  it("a bare web address shows its short form, and the link keeps the full address", () => {
    const url = "https://www.example.com/bardzo/dlugi/adres/strony/ktora/ma/duzo/znakow";
    const host = document.createElement("div");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = new ReadingView(host, () => {}, () => `<p>Patrz ${url} i www.example.com/a</p>`);
    view.show("ignored");
    const [full, www] = host.querySelectorAll<HTMLAnchorElement>("a[href]");
    expect(full.getAttribute("href")).toBe(url);
    expect(full.textContent).toBe(shortUrl(url));
    expect(www.getAttribute("href")).toBe("https://www.example.com/a");
    www.click();
    expect(open).toHaveBeenCalledWith("https://www.example.com/a", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
  it("shows the text as plain <pre> until formulas are ready, then renders it", async () => {
    const host = document.createElement("div");
    let ready = false;
    const view = new ReadingView(host, () => {}, (md) => (ready ? `<h1>${md}</h1>` : null));

    view.show("<b>tekst</b>");
    expect(host.querySelector("pre")!.textContent).toBe("<b>tekst</b>");
    expect(host.querySelector("b")).toBeNull();

    ready = true;
    await vi.waitFor(() => expect(host.querySelector("h1")).not.toBeNull());
    expect(host.querySelector("pre")).toBeNull();
  });
});
