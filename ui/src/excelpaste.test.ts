// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { excelPaste, tsvToTable } from "./excelpaste";
import { tableExtension } from "./table";

// jsdom has no layout; CodeMirror measures text on the next frame.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;

describe("tsvToTable", () => {
  it("plain text without a tab is not a table", () => {
    expect(tsvToTable("zwykły tekst\ndrugi wiersz")).toBeNull();
    expect(tsvToTable("")).toBeNull();
    // without a spreadsheet's HTML on the clipboard: one row, or rows of different widths, stay text
    expect(tsvToTable("a\tb")).toBeNull();
    expect(tsvToTable("if (x) {\n\treturn 1;\n}")).toBeNull();
  });

  it("one row with tabs becomes a table with that row as header", () => {
    expect(tsvToTable("a\tb", true)).toBe("| a | b |\n| --- | --- |");
    expect(tsvToTable("a\tb\n1\t2")).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("quoted cells keep tabs, line breaks and doubled quotes", () => {
    const tsv = '"x\ty\nz"\t"say ""hi"""\n1\t2';
    expect(tsvToTable(tsv)).toBe('| x\ty<br>z | say "hi" |\n| --- | --- |\n| 1 | 2 |');
  });

  it("escapes pipes and trims cells", () => {
    expect(tsvToTable(" a|b \t c ", true)).toBe("| a\\|b | c |\n| --- | --- |");
  });

  it("pads ragged rows to the widest row", () => {
    expect(tsvToTable("a\tb\tc\n1\n2\t3", true)).toBe("| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |\n| 2 | 3 |  |");
  });

  it("drops one trailing empty line", () => {
    expect(tsvToTable("a\tb\n1\t2\n")).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("an empty header row gets column letters", () => {
    expect(tsvToTable("\t\n1\t2")).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("CRLF line ends", () => {
    expect(tsvToTable("a\tb\r\n1\t2\r\n")).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
});

describe("excelPaste", () => {
  function paste(doc: string, head: number, text: string): { view: EditorView; defaultPrevented: boolean } {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, selection: { anchor: head }, extensions: [markdown({ base: markdownLanguage }), tableExtension(), excelPaste] }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : ""), files: [] } });
    view.contentDOM.dispatchEvent(event);
    return { view, defaultPrevented: event.defaultPrevented };
  }

  it("pastes a table on its own paragraph and puts the caret after it", () => {
    const { view, defaultPrevented } = paste("Przed\n\nkoniec", 5, "a\tb\n1\t2");
    expect(defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Przed\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nkoniec");
    expect(view.state.selection.main.head).toBe("Przed\n\n| a | b |\n| --- | --- |\n| 1 | 2 |".length);
  });

  it("text before the caret on the same line gets a blank line before the table", () => {
    const { view } = paste("tekst", 5, "a\tb\n1\t2");
    expect(view.state.doc.toString()).toBe("tekst\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  // CodeMirror's own paste inserts the text as it is, so the table must not appear
  it("inside a code fence the normal paste runs", () => {
    const { view } = paste("```\nkod\n```", 6, "a\tb\n1\t2");
    expect(view.state.doc.toString()).toBe("```\nkoa\tb\n1\t2d\n```");
  });

  it("inside an existing table the normal paste runs", () => {
    const doc = "| x | y |\n| --- | --- |\n| 1 | 2 |";
    const { view } = paste(doc, doc.indexOf("| 1") + 2, "a\tb\n1\t2");
    expect(view.state.doc.toString()).not.toContain("| a | b |");
    expect(view.state.doc.toString()).toContain("a\tb");
  });
});
