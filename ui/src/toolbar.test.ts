// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { installHotkeys, runCommand } from "./commands";
import { formattingKeymap, registerFormatCommands, Toolbar } from "./toolbar";

// Same keymap order as the editor: formatting first, then CodeMirror's defaults (Ctrl+I is selectParentSyntax there).
function editor(doc: string, from: number, to = from): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const extensions = [formattingKeymap, keymap.of(defaultKeymap), markdown()];
  return new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: from, head: to }, extensions }) });
}

beforeAll(() => {
  installHotkeys();
});

describe("formatting toolbar", () => {
  it("Bold wraps the selection in ** and pressing it again unwraps", () => {
    const view = editor("abc", 0, 3);
    registerFormatCommands(() => view);
    runCommand("fmt.bold");
    expect(view.state.doc.toString()).toBe("**abc**");
    runCommand("fmt.bold");
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("keeps selected whitespace outside every inline formatting marker", () => {
    const cases: [string, string][] = [
      ["fmt.bold", " **tekst** "],
      ["fmt.italic", " *tekst* "],
      ["fmt.strike", " ~~tekst~~ "],
      ["fmt.mark", " ==tekst== "],
      ["fmt.code", " `tekst` "],
    ];
    for (const [command, expected] of cases) {
      const view = editor(" tekst ", 0, 7);
      registerFormatCommands(() => view);
      runCommand(command);
      expect(view.state.doc.toString()).toBe(expected);
      view.destroy();
    }
  });

  it("the toolbar button runs the same command", () => {
    const view = editor("abc", 0, 3);
    const host = document.createElement("div");
    document.body.append(host);
    new Toolbar(host, () => view);
    host.querySelector<HTMLButtonElement>('[aria-label^="Pogrubienie"]')!.click();
    expect(view.state.doc.toString()).toBe("**abc**");
  });

  it("Task prefixes the line with - [ ]", () => {
    const view = editor("Zrobić", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.task");
    expect(view.state.doc.toString()).toBe("- [ ] Zrobić");
  });

  it("puts the caret after a newly inserted list marker", () => {
    const view = editor("", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.list");
    expect(view.state.doc.toString()).toBe("- ");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("Tab and Shift+Tab create and remove a nested list level", () => {
    const view = editor("- rodzic\n- dziecko", 11);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(view.state.doc.toString()).toBe("- rodzic\n  - dziecko");
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(view.state.doc.toString()).toBe("- rodzic\n- dziecko");
  });

  it("Table inserts a 3x3 GFM table", () => {
    const view = editor("", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.table");
    const lines = view.state.doc.toString().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("| Kolumna 1 | Kolumna 2 | Kolumna 3 |");
    expect(lines[1]).toBe("| --- | --- | --- |");
    // every row has the same number of cells as the header
    for (const line of lines) expect(line.split("|").length).toBe(5);
  });

  it("Ctrl+B wraps the selection in bold", () => {
    const view = editor("abc", 0, 3);
    registerFormatCommands(() => view);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    expect(view.state.doc.toString()).toBe("**abc**");
  });

  it("Ctrl+I italicises the selection, not selectParentSyntax", () => {
    const view = editor("abc", 0, 3);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true }));
    expect(view.state.doc.toString()).toBe("*abc*");
    expect(view.state.selection.main.from).toBe(1);
  });

  it("formatting hotkeys are not global: a key without the editor focused does nothing", () => {
    installHotkeys();
    const view = editor("abc", 0, 3);
    registerFormatCommands(() => view);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("List turns a task line into a plain list item", () => {
    const view = editor("- [ ] x", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.list");
    expect(view.state.doc.toString()).toBe("- x");
  });

  it("List on a plain list item removes the marker", () => {
    const view = editor("- x", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.list");
    expect(view.state.doc.toString()).toBe("x");
  });

  it("Task on a done task removes the task marker", () => {
    const view = editor("- [x] x", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.task");
    expect(view.state.doc.toString()).toBe("x");
  });

  it("Task on a plain list item turns it into an open task", () => {
    const view = editor("- x", 0);
    registerFormatCommands(() => view);
    runCommand("fmt.task");
    expect(view.state.doc.toString()).toBe("- [ ] x");
  });

  it("italic inside bold gives ***a*** and toggles back", () => {
    const view = editor("**a**", 2, 3);
    registerFormatCommands(() => view);
    runCommand("fmt.italic");
    expect(view.state.doc.toString()).toBe("***a***");
    runCommand("fmt.italic");
    expect(view.state.doc.toString()).toBe("**a**");
  });

  it("a horizontal rule under a paragraph gets a blank line above it", () => {
    const view = editor("Akapit\n", 7);
    registerFormatCommands(() => view);
    runCommand("fmt.rule");
    expect(view.state.doc.toString()).toBe("Akapit\n\n---\n");
  });

  it("a horizontal rule after text on the same line starts a new paragraph", () => {
    const view = editor("Akapit", 6);
    registerFormatCommands(() => view);
    runCommand("fmt.rule");
    expect(view.state.doc.toString()).toBe("Akapit\n\n---\n");
  });

  it("formatting commands do nothing when no note is open", () => {
    registerFormatCommands(() => null);
    expect(() => runCommand("fmt.bold")).not.toThrow();
  });

  it("the link command wraps the selection in [[...]]", () => {
    const view = editor("Plan", 0, 4);
    registerFormatCommands(() => view);
    runCommand("fmt.link");
    expect(view.state.doc.toString()).toBe("[[Plan]]");
  });
});
