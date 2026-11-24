// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorHost, Saver, openSession } from "./editor";
import { MockBridge } from "./bridge";
import { initFormula } from "./formula";
import { deleteColumn, deleteRow, insertColumn, insertRow, tableExtension } from "./table";

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

const DOC = `Tekst przed tabelą\n\n${TABLE}\n\nKoniec.`;

function mount(doc: string, head = 0): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [markdown({ base: markdownLanguage }), tableExtension()],
    }),
  });
}

/** Position of `needle` in the document, searching from the first occurrence of `after`. */
function at(view: EditorView, needle: string, after = ""): number {
  const doc = view.state.doc.toString();
  const from = after ? doc.indexOf(after) : 0;
  return doc.indexOf(needle, from);
}

function key(view: EditorView, name: string, mods: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...mods });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function results(view: EditorView): string[] {
  return [...view.contentDOM.querySelectorAll(".cm-formula-result")].map((e) => e.textContent ?? "");
}

function rowNumbers(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(".cm-table-gutter .cm-table-row")].map((e) => e.textContent ?? "");
}

function letters(view: EditorView): string[] {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-col")].map((e) => e.dataset.col ?? "");
}

describe("table extension", () => {
  it("shows formula results when the caret is outside the table and keeps the source", () => {
    const view = mount(DOC);
    expect(results(view)).toEqual(["18", "02.11.2026", "14", "32"]);
    expect(view.state.doc.toString()).toContain("=C2-B2");
    view.destroy();
  });

  it("shows the raw formula in the cell with the caret and results elsewhere", () => {
    const view = mount(DOC);
    const d2 = at(view, "=C2-B2");
    view.dispatch({ selection: { anchor: d2 + 2 } });
    expect(view.contentDOM.textContent).toContain("=C2-B2");
    expect(results(view)).toEqual(["02.11.2026", "14", "32"]);
    view.destroy();
  });

  it("puts row numbers in the gutter and column letters on the header only while the caret is in the table", () => {
    const view = mount(DOC);
    expect(rowNumbers(view)).toEqual([]);
    expect(letters(view)).toEqual([]);

    view.dispatch({ selection: { anchor: at(view, "Projekt") } });
    expect(rowNumbers(view)).toEqual(["1", "2", "3", "4"]);
    expect(letters(view)).toEqual(["A", "B", "C", "D"]);
    expect(view.dom.querySelector(".cm-table-gutter .cm-table-row")?.getAttribute("aria-hidden")).toBe("true");

    view.dispatch({ selection: { anchor: 0 } });
    expect(rowNumbers(view)).toEqual([]);
    expect(letters(view)).toEqual([]);
    view.destroy();
  });

  it("Tab and Shift+Tab move between cells, skipping the delimiter row", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: at(view, "Projekt") } });
    key(view, "Tab");
    expect(view.state.selection.main.head).toBe(at(view, "2026-10-01"));
    key(view, "Shift-Tab");
    expect(view.state.selection.main.head).toBe(at(view, "Projekt"));
    view.destroy();
  });

  it("Shift+Tab from the first cell stays put", () => {
    const view = mount(DOC);
    const first = at(view, "Zadanie");
    view.dispatch({ selection: { anchor: first } });
    key(view, "Shift-Tab");
    expect(view.state.selection.main.head).toBe(first);
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("Tab on the last cell of the last row stays and reports handled", () => {
    const view = mount(DOC);
    const last = at(view, "=SUMA(D2:D3)");
    view.dispatch({ selection: { anchor: last } });
    const before = view.state.doc.toString();
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.selection.main.head).toBe(last);
    view.destroy();
  });

  it("Enter from the last row appends a row with the same cell count", () => {
    const view = mount(DOC);
    const linesBefore = view.state.doc.lines;
    view.dispatch({ selection: { anchor: at(view, "=SUMA(D2:D3)") } });
    key(view, "Enter");
    expect(view.state.doc.lines).toBe(linesBefore + 1);
    const newLine = view.state.doc.line(view.state.doc.lineAt(view.state.selection.main.head).number);
    expect(newLine.text).toBe("|  |  |  |  |");
    // Enter keeps the column: the caret was in D4, so the new row gets the caret in its 4th cell (13 chars in).
    expect(view.state.selection.main.head).toBe(newLine.from + 11);
    view.destroy();
  });

  it("Enter moves to the same column in the next row", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: at(view, "Projekt") } });
    key(view, "Enter");
    expect(view.state.selection.main.head).toBe(at(view, "Testy"));
    expect(view.state.doc.lines).toBe(DOC.split("\n").length);
    view.destroy();
  });

  it("shows an error cell with the error class", () => {
    const view = mount("| x |\n|---|\n| =1/0 |");
    const el = view.contentDOM.querySelector(".cm-formula-error");
    expect(el?.textContent).toBe("#DZIEL/0!");
    expect(el?.getAttribute("title")).toBe("=1/0");
    expect(el?.getAttribute("aria-label")).toBe("#DZIEL/0!, formuła =1/0");
    view.destroy();
  });

  it("adds no decorations to a document without tables", () => {
    const view = mount("Zwykły tekst\n\n- lista\n- druga");
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.dom.querySelectorAll(".cm-formula-result, .cm-table-row, .cm-table-col").length).toBe(0);
    view.destroy();
  });

  it("types normally and shows no results when wasm never loaded", async () => {
    // A fresh module instance has formulas switched off, as if initFormula() had failed.
    vi.resetModules();
    const [state, view, lang, table] = await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/lang-markdown"),
      import("./table"),
    ]);
    const parent = document.createElement("div");
    document.body.append(parent);
    const v = new view.EditorView({
      parent,
      state: state.EditorState.create({
        doc: TABLE,
        selection: { anchor: 0 },
        extensions: [lang.markdown({ base: lang.markdownLanguage }), table.tableExtension()],
      }),
    });
    v.dispatch({ changes: { from: v.state.doc.length, insert: "x" } });
    expect(v.state.doc.toString()).toBe(TABLE + "x");
    expect(v.dom.querySelectorAll(".cm-formula-result").length).toBe(0);
    v.destroy();
  });
});

// Same vectors as crates/core/src/formula/tests_gfm.rs: cell splitting must match Rust.
describe("GFM cell splitting", () => {
  it("`\\|` is a literal pipe inside the cell", () => {
    const view = mount("| x\\| y | c |\n|---|---|\n| 1 | =1+1 |");
    expect(results(view)).toEqual(["2"]);
    expect(view.contentDOM.querySelector(".cm-formula-result")?.getAttribute("title")).toBe("=1+1");
    view.destroy();
  });

  it("`\\\\|` keeps the backslashes and the pipe still splits: column C gets the formula, B stays 'y'", () => {
    const view = mount("| x\\\\| y | c |\n|---|---|---|\n| 1 | 2 | =1+1 |");
    expect(results(view)).toEqual(["2"]);
    expect(view.contentDOM.querySelector(".cm-formula-result")?.getAttribute("title")).toBe("=1+1");
    view.destroy();
  });

  it("a pipe inside a code span still splits", () => {
    const view = mount("| `a|b` | c |\n|---|---|---|\n| x | y | =1+1 |");
    expect(results(view)).toEqual(["2"]);
    view.destroy();
  });

  it("leading and trailing pipes are optional", () => {
    const view = mount("a | b\n--- | ---\n1 | =1+1");
    expect(results(view)).toEqual(["2"]);
    expect(view.contentDOM.querySelector(".cm-formula-result")?.getAttribute("title")).toBe("=1+1");
    view.destroy();
  });

  it("unicode cells split on characters", () => {
    const view = mount("| Zażółć | gęś |\n|---|---|\n| 1 | =1+1 |");
    expect(results(view)).toEqual(["2"]);
    view.destroy();
  });
});

describe("editor integration", () => {
  it("undoes an Enter-appended row with the undo keymap", async () => {
    const bridge = new MockBridge([]);
    const id = await bridge.call<string>("create_note", { path: "Tabela.md" });
    const host = new EditorHost(document.body.appendChild(document.createElement("div")));
    const session = await openSession(bridge, new Saver(bridge, () => {}), id, "Tabela.md", () => {});
    host.show(session, null);
    host.view.dispatch({ changes: { from: 0, insert: TABLE } });
    // Y.UndoManager merges edits made within 500 ms, so wait before the Enter edit.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const before = host.view.state.doc.toString();

    host.view.dispatch({ selection: { anchor: at(host.view, "=SUMA(D2:D3)") } });
    key(host.view, "Enter");
    expect(host.view.state.doc.lines).toBe(before.split("\n").length + 1);

    key(host.view, "z", { ctrlKey: true });
    expect(host.view.state.doc.toString()).toBe(before);
  });
});

describe("table line edits", () => {
  const T = ["| A | B |", "|---|:-:|", "| x | y |", "| 2026-11-20 | \\|z |"];

  it("inserts an empty column with a --- delimiter cell and keeps the other alignments", () => {
    expect(insertColumn(T, 1)).toEqual(["| A |  | B |", "| --- | --- | :-: |", "| x |  | y |", "| 2026-11-20 |  | \\|z |"]);
  });

  it("appends a column after the last one", () => {
    expect(insertColumn(T, 2)[1]).toBe("| --- | :-: | --- |");
  });

  it("deletes a column and keeps escaped pipes in the other cells", () => {
    expect(deleteColumn(T, 0)).toEqual(["| B |", "| :-: |", "| y |", "| \\|z |"]);
  });

  it("refuses to delete the last column", () => {
    expect(deleteColumn(["| A |", "|---|", "| x |"], 0)).toEqual(["| A |", "|---|", "| x |"]);
  });

  it("inserts an empty body row before a line and never above the header or delimiter", () => {
    expect(insertRow(T, 3)).toEqual(["| A | B |", "|---|:-:|", "| x | y |", "|  |  |", "| 2026-11-20 | \\|z |"]);
    expect(insertRow(T, 4)[4]).toBe("|  |  |");
    expect(insertRow(T, 1)).toBe(T);
    expect(insertRow(T, 0)).toBe(T);
  });

  it("deletes a body row but keeps the header and the last body row", () => {
    expect(deleteRow(T, 2)).toEqual(["| A | B |", "|---|:-:|", "| 2026-11-20 | \\|z |"]);
    expect(deleteRow(T, 0)).toBe(T);
    expect(deleteRow(T, 1)).toBe(T);
    const one = ["| A |", "|---|", "| x |"];
    expect(deleteRow(one, 2)).toBe(one);
  });
});

describe("arrow keys in tables", () => {
  it("ArrowDown and ArrowUp keep the column and skip the delimiter row", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: at(view, "Zadanie") } });
    key(view, "ArrowDown");
    expect(view.state.selection.main.head).toBe(at(view, "Projekt"));
    key(view, "ArrowUp");
    expect(view.state.selection.main.head).toBe(at(view, "Zadanie"));
    view.destroy();
  });

  it("ArrowDown moves to the same column of the next row, at the cell's content start", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: at(view, "2026-10-01") } });
    key(view, "ArrowDown");
    expect(view.state.selection.main.head).toBe(at(view, "19.10.2026"));
    view.destroy();
  });

  it("ArrowUp and ArrowDown leave the table at its first and last row", () => {
    const view = mount(DOC);
    const top = at(view, "Zadanie");
    view.dispatch({ selection: { anchor: top } });
    expect(key(view, "ArrowUp").defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(top);
    const bottom = at(view, "Razem");
    view.dispatch({ selection: { anchor: bottom } });
    expect(key(view, "ArrowDown").defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(bottom);
    view.destroy();
  });

  it("ArrowLeft at a cell's content start goes to the end of the previous cell", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: at(view, "Projekt") } });
    key(view, "ArrowLeft");
    expect(view.state.selection.main.head).toBe(at(view, "Dni") + "Dni".length);
    view.destroy();
  });

  it("ArrowRight at a cell's content end goes to the start of the next cell, wrapping across rows", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: at(view, "Projekt") + "Projekt".length } });
    key(view, "ArrowRight");
    expect(view.state.selection.main.head).toBe(at(view, "2026-10-01"));
    view.dispatch({ selection: { anchor: at(view, "=C2-B2") + "=C2-B2".length } });
    key(view, "ArrowRight");
    expect(view.state.selection.main.head).toBe(at(view, "Testy"));
    view.destroy();
  });

  it("ArrowLeft and ArrowRight inside the text, and at the table's ends, leave the caret to the default", () => {
    const view = mount(DOC);
    const mid = at(view, "Projekt") + 3;
    view.dispatch({ selection: { anchor: mid } });
    expect(key(view, "ArrowLeft").defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(mid);
    const first = at(view, "Zadanie");
    view.dispatch({ selection: { anchor: first } });
    expect(key(view, "ArrowLeft").defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(first);
    const lastEnd = at(view, "=SUMA(D2:D3)") + "=SUMA(D2:D3)".length;
    view.dispatch({ selection: { anchor: lastEnd } });
    expect(key(view, "ArrowRight").defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(lastEnd);
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("does not bind Shift+arrows and ignores arrows outside tables", () => {
    const view = mount(DOC);
    const head = at(view, "Projekt");
    view.dispatch({ selection: { anchor: head } });
    expect(key(view, "ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(key(view, "ArrowRight", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(view.state.selection.main.head).toBe(head);
    view.dispatch({ selection: { anchor: 0 } });
    expect(key(view, "ArrowDown").defaultPrevented).toBe(false);
    view.destroy();
  });
});
