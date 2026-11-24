// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { MockBridge } from "./bridge";
import { EditorHost, Saver, openSession, setSourceMode } from "./editor";
import { initFormula, renderHtml } from "./formula";
import { SHORT_WORD_SPACE, shortUrl } from "./livepreview";
import { setTableCheckAccess } from "./tablechecks";

// Node has no fetch for file: URLs, so init reads the real .wasm through a stubbed fetch.
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

const TABLE = `| Zadanie | Start | Koniec | Dni |
|---|---|---|---|
| Projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |
| Testy | 19.10.2026 | =B3+14 | =C3-B3 |
| **Razem** | | | =SUMA(D2:D3) |`;

/** A note opened the way the app opens it, so Yjs and undo are in the loop. */
async function open(doc: string, head?: number, onLink: (target: string) => void = () => {}): Promise<EditorView> {
  const bridge = new MockBridge([]);
  const id = await bridge.call<string>("create_note", { path: "L.md" });
  const host = new EditorHost(document.body.appendChild(document.createElement("div")));
  const session = await openSession(bridge, new Saver(bridge, () => {}), id, "L.md", () => {}, onLink);
  host.show(session, null);
  host.view.dispatch({ changes: { from: 0, insert: doc }, selection: { anchor: head ?? doc.length } });
  return host.view;
}

const at = (view: EditorView, needle: string) => view.state.doc.toString().indexOf(needle);
const text = (view: EditorView) => view.contentDOM.textContent ?? "";

describe("shortUrl", () => {
  it("drops the scheme and www., and keeps a short address whole", () => {
    expect(shortUrl("https://www.example.com/a/b")).toBe("example.com/a/b");
    expect(shortUrl("http://example.com")).toBe("example.com");
  });

  it("cuts a long address to 40 characters with an ellipsis", () => {
    const short = shortUrl("https://example.com/very/long/path/that/goes/on/and/on/forever/index.html");
    expect(short).toBe("example.com/very/long/path/that/goes/on…");
    expect([...short]).toHaveLength(40);
  });
});

describe("live preview links", () => {
  const down = (el: Element, init: MouseEventInit = { ctrlKey: true }) =>
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init }));

  it("a Markdown link shows only its name off the caret line, and Ctrl+click opens the full URL", async () => {
    const open$ = vi.spyOn(window, "open").mockReturnValue(null);
    const doc = "Zobacz [nazwa](https://example.com/a/b) tu.\n\nKoniec";
    const view = await open(doc, doc.length);
    expect(text(view)).toContain("Zobacz nazwa tu.");
    expect(text(view)).not.toContain("](");
    down(view.contentDOM.querySelector(".cm-lp-link")!);
    expect(open$).toHaveBeenCalledWith("https://example.com/a/b", "_blank", "noopener,noreferrer");
    open$.mockRestore();
  });

  it("an autolink <https://…> shows the short form and opens the full URL", async () => {
    const open$ = vi.spyOn(window, "open").mockReturnValue(null);
    const doc = "Zobacz <https://example.com/a/b> tu.\n\nKoniec";
    const view = await open(doc, doc.length);
    expect(text(view)).toContain("Zobacz example.com/a/b tu.");
    expect(text(view)).not.toContain("<");
    down(view.contentDOM.querySelector(".cm-lp-link")!);
    expect(open$).toHaveBeenCalledWith("https://example.com/a/b", "_blank", "noopener,noreferrer");
    open$.mockRestore();
  });

  it("a bare URL shows its short form off the caret line and the raw text on it", async () => {
    const url = "https://example.com/bardzo/dlugi/adres/strony/ktora/ma/duzo/znakow";
    const doc = `Patrz ${url} tu.\n\nKoniec`;
    const view = await open(doc, doc.length);
    expect(text(view)).toContain(shortUrl(url));
    expect(text(view)).not.toContain(url);
    expect(view.contentDOM.querySelector(".cm-lp-link")!.getAttribute("data-href")).toBe(url);

    view.dispatch({ selection: { anchor: at(view, "bardzo") } });
    expect(text(view)).toContain(url);
  });

  it("Ctrl+click on a bare www. address opens it with https://", async () => {
    const open$ = vi.spyOn(window, "open").mockReturnValue(null);
    const doc = "Patrz www.example.com/a tu.\n\nKoniec";
    const view = await open(doc, doc.length);
    down(view.contentDOM.querySelector(".cm-lp-link")!);
    expect(open$).toHaveBeenCalledWith("https://www.example.com/a", "_blank", "noopener,noreferrer");
    open$.mockRestore();
  });

  it("a plain URL inside code stays verbatim", async () => {
    const doc = "Kod `https://example.com/a` i koniec\n\nKoniec";
    const view = await open(doc, doc.length);
    expect(text(view)).toContain("https://example.com/a");
    expect(view.contentDOM.querySelector(".cm-lp-link")).toBeNull();
  });

  it("pasting a URL over a selection makes it a Markdown link", async () => {
    const view = await open("Zobacz nazwa tu.\n\nKoniec", 0);
    view.dispatch({ selection: { anchor: at(view, "nazwa"), head: at(view, "nazwa") + 5 } });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => "https://example.com/a/b" } });
    view.contentDOM.dispatchEvent(paste);
    expect(view.state.doc.toString()).toContain("Zobacz [nazwa](https://example.com/a/b) tu.");
  });

  it("pasting a URL without a selection pastes it as it is", async () => {
    const view = await open("Zobacz tu.\n\nKoniec", 6);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => "https://example.com/a" } });
    view.contentDOM.dispatchEvent(paste);
    expect(view.state.doc.toString()).not.toContain("](");
  });
});

describe("live preview", () => {
  it("a typed edit away from a table keeps it rendered; an edit in it re-renders it", async () => {
    const view = await open(`Tekst\n\n${TABLE}\n\nKoniec`);
    expect(view.contentDOM.querySelector(".cm-lp-table")).not.toBeNull();
    view.dispatch({ changes: { from: at(view, "Koniec") + 2, insert: "x" } });
    expect(view.contentDOM.querySelector(".cm-lp-table")).not.toBeNull();
    view.dispatch({ changes: { from: at(view, "Projekt"), insert: "Z" } });
    expect(view.contentDOM.querySelector(".cm-lp-table")!.textContent).toContain("ZProjekt");
  });

  it("hides heading and bold markers off the caret line, and shows them on it", async () => {
    const doc = "Wstęp\n\n## Tytuł **gruby**\n\nKoniec";
    const view = await open(doc, doc.length);
    expect(text(view)).toContain("Tytuł gruby");
    expect(text(view)).not.toContain("#");
    expect(text(view)).not.toContain("**");

    view.dispatch({ selection: { anchor: at(view, "Tytuł") } });
    expect(text(view)).toContain("## Tytuł **gruby**");
  });

  it("a click on a task box toggles [ ] and [x] through a transaction, and undo reverts it", async () => {
    const view = await open("- [ ] zadanie\n\nKoniec");
    await new Promise((resolve) => setTimeout(resolve, 600)); // Yjs merges edits made within 500 ms into one undo step
    const box = view.contentDOM.querySelector<HTMLInputElement>("input.cm-lp-task")!;
    expect(box.checked).toBe(false);
    expect(text(view)).not.toContain("•"); // a task item shows the box, not a bullet too
    expect(text(view).trimStart()).toMatch(/^zadanie/); // the `-` and its space are hidden with the bullet

    box.click();
    expect(view.state.doc.toString().startsWith("- [x] zadanie")).toBe(true);

    yUndoManagerKeymap[0].run!(view);
    expect(view.state.doc.toString().startsWith("- [ ] zadanie")).toBe(true);
  });

  it("a click that would tick a task with open subtasks is refused, and the note keeps its text", async () => {
    const view = await open("- [ ] rodzic\n  - [ ] podzadanie\n\nKoniec");
    await new Promise((resolve) => setTimeout(resolve, 600));
    view.contentDOM.querySelector<HTMLInputElement>("input.cm-lp-task")!.click();
    expect(view.state.doc.toString().startsWith("- [ ] rodzic")).toBe(true);
    expect(document.querySelector(".toasts")?.textContent).toContain("zostało: 1");
  });

  it("a box in a column that names someone else is disabled, and an allowed box ticks its text", async () => {
    setTableCheckAccess((checkers) => !checkers.includes("skarbnik"));
    try {
      const doc = "| Osoba | Składka !zaznacza:@skarbnik | Ankieta |\n|---|---|---|\n| Ania | [ ] | [ ] |\n\nKoniec";
      const view = await open(doc, doc.length);
      const boxes = view.contentDOM.querySelectorAll<HTMLInputElement>(".cm-lp-table input.cm-lp-task");
      expect(boxes).toHaveLength(2);
      expect(boxes[0].disabled).toBe(true);
      expect(boxes[0].title).toBe("Zaznaczyć może: skarbnik lub administrator");
      expect(boxes[1].disabled).toBe(false);
      boxes[1].click();
      expect(view.state.doc.toString()).toContain("| Ania | [ ] | [x] |");
    } finally {
      setTableCheckAccess(null);
    }
  });

  it("shows the alias or the target of a wikilink when the caret is away", async () => {
    const view = await open("Zobacz [[Plan|plan]] i [[Cel]].\n\nKoniec");
    expect(text(view)).toContain("Zobacz plan i Cel.");
    expect(text(view)).not.toContain("[[");
    expect(view.contentDOM.querySelector('[data-target="Plan"]')?.textContent).toBe("plan");
  });

  it("renders a table as HTML with formula results away from the caret, and as source on it", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc);
    const widget = view.contentDOM.querySelector(".cm-lp-table")!;
    expect(widget.querySelector("table")).not.toBeNull();
    expect(widget.textContent).toContain("18");
    expect(text(view)).not.toContain("=C2-B2");

    view.dispatch({ selection: { anchor: at(view, "=C2-B2") } });
    expect(view.contentDOM.querySelector(".cm-lp-table")).toBeNull();
    expect(text(view)).toContain("=C2-B2");
  });

  it("keeps the rendered table visible when a cell is clicked for editing", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const cell = view.contentDOM.querySelector("td")!;
    cell.closest("tr")!.querySelector("td")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.contentDOM.querySelector(".cm-lp-table")).not.toBeNull();
    expect(cell.getAttribute("contenteditable")).toBe("true");
  });

  it("note text with script in a table cell creates no script element", async () => {
    const doc = `| <script>window.__lp=1</script> | x |\n|---|---|\n| a | b |\n\nKoniec`;
    const view = await open(doc, doc.length);
    expect(view.contentDOM.querySelector(".cm-lp-table")).not.toBeNull();
    expect(view.contentDOM.querySelector("script")).toBeNull();
    expect((window as unknown as { __lp?: number }).__lp).toBeUndefined();
  });

  it("Ctrl+mousedown follows a wikilink", async () => {
    const onLink = vi.fn();
    const view = await open("Zobacz [[Plan|plan]].\n\nKoniec", undefined, onLink);
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ctrlKey: true });
    view.contentDOM.querySelector<HTMLElement>('[data-target="Plan"]')!.dispatchEvent(ev);
    expect(onLink).toHaveBeenCalledWith("Plan");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a plain mousedown on a wikilink does not follow it", async () => {
    const onLink = vi.fn();
    const view = await open("Zobacz [[Plan|plan]].\n\nKoniec", undefined, onLink);
    view.contentDOM.querySelector<HTMLElement>('[data-target="Plan"]')!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(onLink).not.toHaveBeenCalled();
  });

  it("a plain click on a link in an editable table does not follow it", async () => {
    const doc = "| [klik](http://example.invalid/x) | x |\n|---|---|\n| a | b |\n\nKoniec";
    const view = await open(doc, doc.length);
    const open$ = vi.spyOn(window, "open").mockReturnValue(null);
    const before = window.location.href;
    const link = view.contentDOM.querySelector<HTMLAnchorElement>(".cm-lp-table a[href]")!;

    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(open$).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(view.contentDOM.querySelector(".cm-lp-table")).not.toBeNull();
    open$.mockRestore();
  });

  it("writes an edited preview cell back to Markdown without opening source mode", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const cell = widget.querySelector<HTMLElement>("tbody td")!;
    cell.dispatchEvent(new FocusEvent("focus"));
    cell.textContent = "Nowy projekt";
    cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: view.contentDOM }));
    expect(view.state.doc.toString()).toContain("| Nowy projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |");
  });

  it("a cell reached by keyboard is selected whole; a clicked one is not", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const [first, second] = view.contentDOM.querySelectorAll<HTMLElement>(".cm-lp-table tbody td");
    first.dispatchEvent(new FocusEvent("focus"));
    expect(getSelection()?.toString()).toBe(first.textContent);
    second.dispatchEvent(new MouseEvent("mousedown"));
    getSelection()?.removeAllRanges();
    second.dispatchEvent(new FocusEvent("focus"));
    expect(getSelection()?.toString()).toBe("");
  });

  it("focused table cell shows its address and raw source in the formula bar", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const testy = widget.querySelectorAll("tr:not(.cm-lp-letters)")[2].querySelectorAll<HTMLElement>("th:not(.cm-lp-rownum), td");
    testy[1].dispatchEvent(new FocusEvent("focus"));
    expect(widget.querySelector(".cm-lp-bar")!.textContent).toBe("B3: 19.10.2026");
    const razem = widget.querySelectorAll("tr:not(.cm-lp-letters)")[3].querySelectorAll<HTMLElement>("th:not(.cm-lp-rownum), td");
    razem[3].dispatchEvent(new FocusEvent("focus"));
    expect(widget.querySelector(".cm-lp-bar")!.textContent).toBe("D4: =SUMA(D2:D3)");
    razem[3].dispatchEvent(new FocusEvent("blur"));
  });

  it("row and column helpers are shown as non-editable elements outside the cell grid", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const letters = [...widget.querySelectorAll(".cm-lp-letters th")].map((th) => th.textContent);
    expect(letters).toEqual(["", "A", "B", "C", "D"]);
    const numbers = [...widget.querySelectorAll(".cm-lp-rownum")].map((th) => th.textContent);
    expect(numbers).toEqual(["1", "2", "3", "4"]);
    expect(widget.querySelectorAll(".cm-lp-letters [contenteditable], .cm-lp-rownum[contenteditable]")).toHaveLength(0);
    expect(widget.querySelectorAll(".cm-lp-rownum[tabindex], .cm-lp-letters [tabindex]")).toHaveLength(0);
  });

  it("a table has a button that exports it to Excel", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const button = view.contentDOM.querySelector<HTMLButtonElement>(".cm-lp-table .cm-lp-table-export")!;
    expect(button.getAttribute("aria-label")).toBe("Pobierz jako plik Excel (.xlsx)");
  });

  it("editing a cell and blurring writes only the cell back, not the helpers", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const cell = widget.querySelectorAll("tr:not(.cm-lp-letters)")[2].querySelectorAll<HTMLElement>("th:not(.cm-lp-rownum), td")[1];
    cell.dispatchEvent(new FocusEvent("focus"));
    cell.textContent = "2026-11-01";
    cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(widget.querySelector(".cm-lp-bar")!.textContent).toBe("B3: 2026-11-01");
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: view.contentDOM }));
    expect(view.state.doc.toString()).toContain("| Testy | 2026-11-01 | =B3+14 | =C3-B3 |");
  });

  it("ArrowDown and ArrowUp move to the same column in the next and previous row", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const rows = () => [...widget.querySelectorAll("tr:not(.cm-lp-letters)")].map((row) => row.querySelectorAll<HTMLElement>("th:not(.cm-lp-rownum), td"));
    const key = (cell: HTMLElement, k: string) => cell.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    rows()[1][1].focus();
    key(rows()[1][1], "ArrowDown");
    expect(document.activeElement).toBe(rows()[2][1]);
    key(rows()[2][1], "ArrowUp");
    expect(document.activeElement).toBe(rows()[1][1]);
    key(rows()[1][1], "ArrowUp");
    expect(document.activeElement).toBe(rows()[0][1]);
    key(rows()[0][1], "ArrowUp");
    expect(document.activeElement).toBe(rows()[0][1]);
    rows()[0][1].blur();
  });

  it("ArrowLeft and ArrowRight move to the neighbour cell from a selected cell, and stay at the row's ends", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const rows = () => [...widget.querySelectorAll("tr:not(.cm-lp-letters)")].map((row) => row.querySelectorAll<HTMLElement>("th:not(.cm-lp-rownum), td"));
    const key = (cell: HTMLElement, k: string, shiftKey = false) => cell.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
    rows()[1][1].focus(); // reached by keyboard: its whole text is selected
    expect(getSelection()!.toString()).toBe("2026-10-01");
    expect(key(rows()[1][1], "ArrowRight")).toBe(false);
    expect(document.activeElement).toBe(rows()[1][2]);
    key(rows()[1][2], "ArrowLeft");
    expect(document.activeElement).toBe(rows()[1][1]);
    rows()[1][0].focus();
    expect(key(rows()[1][0], "ArrowLeft")).toBe(false); // first cell of the row: nothing to move to
    expect(document.activeElement).toBe(rows()[1][0]);
    rows()[1][3].focus();
    expect(key(rows()[1][3], "ArrowRight")).toBe(false); // last cell of the row
    expect(document.activeElement).toBe(rows()[1][3]);
    rows()[1][3].blur();
  });

  it("ArrowLeft and ArrowRight leave the caret alone inside text, but cross cells at the text's edge", async () => {
    const doc = `Tekst\n\n${TABLE}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const widget = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table")!;
    const rows = () => [...widget.querySelectorAll("tr:not(.cm-lp-letters)")].map((row) => row.querySelectorAll<HTMLElement>("th:not(.cm-lp-rownum), td"));
    const key = (cell: HTMLElement, k: string, shiftKey = false) => cell.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
    const caret = (node: Node, offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    };
    // "Testy" in the second row, first column
    rows()[2][0].focus();
    caret(rows()[2][0].firstChild!, 2);
    expect(key(rows()[2][0], "ArrowLeft")).toBe(true); // inside the text: the browser moves the caret
    expect(key(rows()[2][0], "ArrowRight")).toBe(true);
    expect(document.activeElement).toBe(rows()[2][0]);
    expect(key(rows()[2][0], "ArrowRight", true)).toBe(true); // Shift is left to the browser
    caret(rows()[2][0].firstChild!, 5); // at the end: ArrowRight moves on
    expect(key(rows()[2][0], "ArrowRight")).toBe(false);
    expect(document.activeElement).toBe(rows()[2][1]);
    caret(rows()[2][1].firstChild!, 0); // at the start: ArrowLeft moves back
    expect(key(rows()[2][1], "ArrowLeft")).toBe(false);
    expect(document.activeElement).toBe(rows()[2][0]);
    rows()[2][0].blur();
  });

  it("Ctrl+click on a link in a table opens it exactly once", async () => {
    const onLink = vi.fn();
    const doc = "| [[Plan]] | [web](http://example.invalid/x) |\n|---|---|\n| a | b |\n\nKoniec";
    const view = await open(doc, doc.length, onLink);
    const open$ = vi.spyOn(window, "open").mockReturnValue(null);
    const down = (el: Element) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ctrlKey: true }));
    const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));

    const wiki = view.contentDOM.querySelector<HTMLElement>('.cm-lp-table [data-target="Plan"]')!;
    down(wiki);
    click(wiki);
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith("Plan");

    const web = view.contentDOM.querySelector<HTMLElement>(".cm-lp-table a[href]")!;
    down(web);
    click(web);
    expect(open$).toHaveBeenCalledTimes(1);
    expect(open$).toHaveBeenCalledWith("http://example.invalid/x", "_blank", "noopener,noreferrer");
    open$.mockRestore();
  });

  it("keeps decorating after a table: heading, strike, rule and fenced code", async () => {
    const doc = `Tekst\n\n${TABLE}\n\n## Koniec ~~x~~\n\n---\n\n\`\`\`\n[[x]]\n\`\`\`\n\nKoniec`;
    const view = await open(doc, 0);
    expect(view.contentDOM.querySelector(".cm-lp-table")).not.toBeNull();
    expect(text(view)).toContain("Koniec x");
    expect(text(view)).not.toContain("##");
    expect(text(view)).not.toContain("~~");
    expect(view.contentDOM.querySelector("hr.cm-lp-hr")).not.toBeNull();
    expect(text(view)).toContain("[[x]]");
    expect(view.contentDOM.querySelector('[data-target="x"]')).toBeNull();
  });

  it("wikilink and ==highlight== inside a fenced code block stay verbatim", async () => {
    const doc = "```\nif (a === b) { go([[y]]) }\nx ==x==\n```\n\nKoniec";
    const view = await open(doc);
    expect(text(view)).toContain("go([[y]])");
    expect(text(view)).toContain("x ==x==");
    expect(view.contentDOM.querySelector(".cm-lp-wikilink, .cm-lp-mark")).toBeNull();
  });

  it("setSourceMode switches a background tab too, and keeps its undo history", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const host = new EditorHost(document.body.appendChild(document.createElement("div")));
    const idA = await bridge.call<string>("create_note", { path: "A.md" });
    const idB = await bridge.call<string>("create_note", { path: "B.md" });
    const a = await openSession(bridge, saver, idA, "A.md", () => {});
    const b = await openSession(bridge, saver, idB, "B.md", () => {});
    host.show(a, null);
    host.view.dispatch({ changes: { from: 0, insert: "## Tytuł **a**\n\nKoniec" }, selection: { anchor: 20 } });
    host.show(b, a);
    host.view.dispatch({ changes: { from: 0, insert: "## Tytuł **b**\n\nKoniec" }, selection: { anchor: 20 } });

    setSourceMode(true);
    expect(text(host.view)).toContain("## Tytuł **b**");
    host.show(a, b);
    expect(text(host.view)).toContain("## Tytuł **a**");
    yUndoManagerKeymap[0].run!(host.view);
    expect(host.view.state.doc.toString()).toBe("");
    host.show(b, a);
    expect(text(host.view)).toContain("## Tytuł **b**");

    setSourceMode(false);
    expect(text(host.view)).not.toContain("**");
    host.show(a, b);
    expect(text(host.view)).not.toContain("**");
  });

  it("builds decorations for a 5 000-line note in under 50 ms", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) =>
      i % 50 === 0 ? `## Rozdział ${i}` : `Linia **${i}** z [[Plan|plan]] i *kursywą* \`kod\` ==x==`,
    );
    const doc = lines.join("\n");
    const view = await open(doc, 0);
    const mid = at(view, "Linia **2501**");
    const start = performance.now();
    view.dispatch({ changes: { from: mid, insert: "x" } });
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("short words stay with the next word", () => {
  const spaces = (s: string) => [...s.matchAll(SHORT_WORD_SPACE)].map((m) => (m.index ?? 0) + m[0].length - 1);

  it("matches the space after a word of 1-3 letters, Polish letters included", () => {
    expect(spaces("w domu, na łące i żółw ma")).toEqual([1, 10, 17]);
    expect(spaces("Ćma źle")).toEqual([3]);
  });

  it("skips longer words, numbers, words glued to digits and a word at the end", () => {
    expect(spaces("domu ala1 12x x2 w")).toEqual([]);
    expect(spaces("aaa 12 w 5w")).toEqual([3, 8]);
    expect(spaces("pan-i ten")).toEqual([5]);
  });

  it("the document keeps its spaces; a short word is nowrap with the word after it, not in code", async () => {
    const src = "Ala ma w domu kota\n\n| a | w | c |\n|---|---|---|\n| x | y z | 1 |\n\n`w kodzie` na końcu";
    const view = await open(src, 0);
    expect(view.state.doc.toString()).toBe(src);
    // overlapping marks split into several spans, so the check reads all of them together
    const nowrap = [...view.contentDOM.querySelectorAll(".cm-lp-nowrap")].map((e) => e.textContent).join("|");
    expect(nowrap).toContain("w domu");
    expect(nowrap).toContain("na końcu");
    expect(nowrap).not.toContain("kodzie");
  });
});

describe("modes in the app", () => {
  let view: () => EditorView;
  const pressCtrlE = () =>
    $(".cm-content").dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true }));
  const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("./main");
    await vi.waitFor(() => expect($(".tab.is-active").textContent).toBe("2026-10-18"));
    view = () => EditorView.findFromDOM($(".editor .cm-editor"))!;
    const doc = "## Tytuł **gruby**\n\nKoniec";
    view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: doc }, selection: { anchor: doc.length } });
  });

  it("Ctrl+E goes live, reading, live; source mode and back to live", () => {
    expect(text(view())).not.toContain("**");
    pressCtrlE();
    expect($("#reading").hidden).toBe(false);
    pressCtrlE();
    expect($("#reading").hidden).toBe(true);
    expect(text(view())).not.toContain("**");

    setSourceMode(true);
    expect(text(view())).toContain("## Tytuł **gruby**");
    setSourceMode(false);
    expect(text(view())).not.toContain("**");
  });
});

describe("chart blocks", () => {
  const CHART = "```wykres\ntyp: słupkowy\ntytuł: Sprzedaż\nLuty: 30,5\nMarzec: 18\n```";

  it("the renderer gives a wykres block the class the reading view looks for", () => {
    expect(renderHtml(CHART)).toContain('<pre><code class="language-wykres">');
  });

  it("a wykres block shows its chart with the caret away, and its raw text on the caret's line", async () => {
    const doc = `Tekst\n\n${CHART}\n\nKoniec`;
    const view = await open(doc, doc.length);
    expect(view.contentDOM.querySelector(".cm-lp-chart svg")?.getAttribute("aria-label")).toBe("Wykres słupkowy: Sprzedaż, 2 wartości, najwyższa Luty 30,5");
    expect(text(view)).not.toContain("typ: słupkowy");
    view.dispatch({ selection: { anchor: at(view, "Luty") } });
    expect(view.contentDOM.querySelector(".cm-lp-chart")).toBeNull();
    expect(text(view)).toContain("Luty: 30,5");
  });

  it("Enter on a chart opens its dialog and keeps the caret where it was", async () => {
    const doc = `Tekst\n\n${CHART}\n\nKoniec`;
    const view = await open(doc, 0);
    const chart = view.contentDOM.querySelector<HTMLElement>(".cm-lp-chart")!;
    chart.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(document.querySelector(".modal.chart-dialog")).not.toBeNull();
    expect(view.state.selection.main.head).toBe(0);
    document.querySelector<HTMLButtonElement>(".modal.chart-dialog .modal-actions .btn")?.click();
    expect(document.querySelector(".modal.chart-dialog")).toBeNull();
  });

  it("Zapisz replaces the whole block with its new text, and closes the dialog", async () => {
    const doc = `Tekst\n\n${CHART}\n\nKoniec`;
    const view = await open(doc, 0);
    view.contentDOM.querySelector<HTMLElement>(".cm-lp-chart")!.click();
    const title = document.querySelector<HTMLInputElement>(".modal.chart-dialog label.chart-field input")!;
    title.value = "Nowy";
    title.dispatchEvent(new Event("input"));
    [...document.querySelectorAll<HTMLButtonElement>(".modal.chart-dialog button")].find((b) => b.textContent === "Zapisz")!.click();
    expect(view.state.doc.toString()).toBe(`Tekst\n\n\`\`\`wykres\ntyp: słupkowy\ntytuł: Nowy\nLuty: 30,5\nMarzec: 18\n\`\`\`\n\nKoniec`);
    expect(document.querySelector(".modal.chart-dialog")).toBeNull();
  });
});

describe("linked chart blocks", () => {
  const SALES = "| Miesiąc | Sprzedaż |\n|---|---|\n| Styczeń | 12 |\n| Luty | 30 |";
  const LINKED = "```wykres\ntabela: powyżej\n```";
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".modal.chart-dialog button")].find((b) => b.textContent === label)!;

  it("redraws when a value in the table above it changes", async () => {
    const doc = `${SALES}\n\n${LINKED}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const label = () => view.contentDOM.querySelector(".cm-lp-chart svg")?.getAttribute("aria-label");
    expect(label()).toBe("Wykres słupkowy: Sprzedaż, 2 wartości, najwyższa Luty 30");
    view.dispatch({ changes: { from: doc.indexOf("30"), to: doc.indexOf("30") + 2, insert: "45" } });
    expect(label()).toBe("Wykres słupkowy: Sprzedaż, 2 wartości, najwyższa Luty 45");
  });

  it("keeps the drawn chart when an edit elsewhere leaves its data as it is", async () => {
    const doc = `Tekst\n\n${SALES}\n\n${LINKED}\n\nKoniec`;
    const view = await open(doc, 0);
    const chart = view.contentDOM.querySelector(".cm-lp-chart");
    view.dispatch({ changes: { from: doc.length, insert: "!" } });
    expect(view.contentDOM.querySelector(".cm-lp-chart")).toBe(chart);
  });

  it("the table's chart button inserts a block linked to the table, and opens its dialog", async () => {
    const doc = `Tekst\n\n${SALES}\n\nKoniec`;
    const view = await open(doc, doc.length);
    const chartButton = [...view.contentDOM.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Wstaw wykres z tej tabeli")!;
    chartButton.click();
    expect(view.state.doc.toString()).toContain("```wykres\ntyp: słupkowy\ntabela: powyżej\n```");
    expect(document.querySelector(".modal.chart-dialog")).not.toBeNull();
    button("Anuluj").click();
  });

  it("Odłącz od tabeli makes the chart's points its own values, saved only on Zapisz", async () => {
    const doc = `Tekst\n\n${SALES}\n\n${LINKED}\n\nKoniec`;
    const view = await open(doc, 0);
    view.contentDOM.querySelector<HTMLElement>(".cm-lp-chart")!.click();
    button("Odłącz od tabeli").click();
    expect(view.state.doc.toString()).toContain(LINKED);
    button("Zapisz").click();
    expect(view.state.doc.toString()).toContain("```wykres\ntyp: słupkowy\ntytuł: Sprzedaż\nStyczeń: 12\nLuty: 30\n```");
  });

  it("Połącz z tabelą nad wykresem links a chart with its own values to the table above it", async () => {
    const doc = `${SALES}\n\n\`\`\`wykres\ntyp: słupkowy\ntytuł: Własny\nA: 1\n\`\`\`\n\nKoniec`;
    const view = await open(doc, doc.length);
    view.contentDOM.querySelector<HTMLElement>(".cm-lp-chart")!.click();
    button("Połącz z tabelą nad wykresem").click();
    button("Zapisz").click();
    expect(view.state.doc.toString()).toContain("```wykres\ntyp: słupkowy\ntytuł: Własny\ntabela: powyżej\n```");
  });
});

describe("diagram blocks", () => {
  const DIAGRAM = "```schemat\n[a] A | niebieski\n[b] B\na -> b\n```";

  it("a schemat block shows its diagram with the caret away, and its raw text on the caret's line", async () => {
    const doc = `Tekst\n\n${DIAGRAM}\n\nKoniec`;
    const view = await open(doc, doc.length);
    expect(view.contentDOM.querySelector(".cm-lp-diagram svg")?.getAttribute("aria-label")).toBe("Schemat: 2 prostokąty, 1 połączenie");
    expect(text(view)).not.toContain("a -> b");
    view.dispatch({ selection: { anchor: at(view, "a -> b") } });
    expect(view.contentDOM.querySelector(".cm-lp-diagram")).toBeNull();
    expect(text(view)).toContain("a -> b");
  });

  it("Enter on a diagram opens its dialog and keeps the caret where it was", async () => {
    const doc = `Tekst\n\n${DIAGRAM}\n\nKoniec`;
    const view = await open(doc, 0);
    const diagram = view.contentDOM.querySelector<HTMLElement>(".cm-lp-diagram")!;
    diagram.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(document.querySelector(".modal.diagram-dialog")).not.toBeNull();
    expect(view.state.selection.main.head).toBe(0);
    [...document.querySelectorAll<HTMLButtonElement>(".modal.diagram-dialog button")].find((b) => b.textContent === "Anuluj")!.click();
    expect(document.querySelector(".modal.diagram-dialog")).toBeNull();
  });
});
