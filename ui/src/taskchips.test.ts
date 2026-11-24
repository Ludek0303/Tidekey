// @vitest-environment jsdom
import { EditorSelection, EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ySyncAnnotation } from "y-codemirror.next";
import { loadWasm } from "./testwasm";
import { compactTaskCell, liveTaskExtensions, setTaskSpace, setTaskLineHandler, taskExtensions } from "./taskchips";

const TASK = "- [ ] Przygotować schemat @Jan 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a";
const views: EditorView[] = [];

beforeAll(async () => {
  await loadWasm();
});

function editor(doc: string, cursor: number): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.single(cursor), extensions: [...taskExtensions(), ...liveTaskExtensions()] }),
  });
  views.push(view);
  return view;
}

// The text of an edited note with the cursor parked on its last line, so that no chip hides the lines under test.
function typed(doc: string, at: number, insert: string, cursor?: number): string {
  const state = EditorState.create({ doc, selection: EditorSelection.single(cursor ?? at), extensions: taskExtensions() });
  return state.update({ changes: { from: at, insert }, selection: EditorSelection.single(cursor ?? at + insert.length) }).state.doc.toString();
}

afterEach(() => {
  vi.useRealTimers();
  views.splice(0).forEach((v) => v.destroy());
  document.body.replaceChildren();
  setTaskSpace("off");
  setTaskLineHandler(null);
});

describe("task chips in Live Preview", () => {
  it("replaces the tokens with chips while the cursor is on another line", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 20), toFake: ["Date"] }); // the due date is "later" from here
    setTaskSpace("organization");
    const view = editor(`${TASK}\nZwykły tekst`, `${TASK}\nZwykły`.length);
    const chips = [...view.contentDOM.querySelectorAll(".task-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["@Jan", "📅 5 lis", "nadzór: Stanisław", "8/10"]);
    expect(view.contentDOM.querySelector('[data-due="later"]')).not.toBeNull();
  });

  it("hides the id and shows a done chip with its day, so no raw token is left on the line", () => {
    setTaskSpace("organization");
    const done = "- [x] Wybrać hasło ✅ 2026-10-20 ^z-0b77";
    const view = editor(`${done}\nZwykły tekst`, `${done}\nZwykły`.length);
    expect(view.contentDOM.querySelector(".task-chip-done")?.textContent).toBe("wykonane 20 paź");
    const line = view.contentDOM.textContent ?? "";
    expect(line).not.toContain("^z-0b77");
    expect(line).not.toContain("✅");
  });

  it("shows the chips and the task-line click in a personal space too", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 20), toFake: ["Date"] });
    setTaskSpace("personal");
    const view = editor(`${TASK}\nZwykły tekst`, `${TASK}\nZwykły`.length);
    expect(view.contentDOM.querySelectorAll(".task-chip")).toHaveLength(4);
    const onLine = vi.fn(() => true);
    setTaskLineHandler(onLine);
    // jsdom has no layout: the click's position is given directly
    view.posAtCoords = () => view.state.doc.line(1).from + 2;
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onLine).toHaveBeenCalledWith(1);
  });

  it("shows the raw tokens on the cursor's line, and no chips with the space off", () => {
    setTaskSpace("organization");
    const view = editor(`${TASK}\nZwykły`, 3);
    expect(view.contentDOM.querySelectorAll(".task-chip")).toHaveLength(0);
    setTaskSpace("off");
    const plain = editor(TASK, TASK.length);
    expect(plain.contentDOM.querySelectorAll(".task-chip")).toHaveLength(0);
  });

  it("draws no chips inside a code fence", () => {
    setTaskSpace("organization");
    const doc = "```\n- [ ] przykład @Jan\n```\nZwykły";
    const view = editor(doc, doc.length);
    expect(view.contentDOM.querySelectorAll(".task-chip")).toHaveLength(0);
  });
});

describe("a task in a table cell, short form", () => {
  const cellOf = (html: string): HTMLElement => {
    const td = document.createElement("td");
    td.innerHTML = html;
    return td;
  };

  beforeEach(() => setTaskSpace("organization"));
  afterEach(() => setTaskSpace("off"));

  it("shows a checkbox, the title and the person and date chips, and no id", () => {
    const cell = cellOf("[ ] Zadzwonić @Anna 📅 2026-11-30 ^z-abc");
    compactTaskCell(cell, "[ ] Zadzwonić @Anna 📅 2026-11-30 ^z-abc");
    expect(cell.querySelector<HTMLInputElement>("input.cm-lp-task")!.disabled).toBe(true);
    expect(cell.textContent).toBe("Zadzwonić@Anna30.11");
    expect([...cell.querySelectorAll(".task-chip")].map((c) => [c.className, c.textContent])).toEqual([
      ["task-chip task-chip-who", "@Anna"],
      ["task-chip task-chip-due", "30.11"],
    ]);
  });

  it("keeps the live preview's own checkbox, and leaves cells with other markup and with the space off alone", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    const cell = cellOf("Zadzwonić @Anna");
    cell.prepend(box);
    compactTaskCell(cell, "[x] Zadzwonić @Anna");
    expect(cell.firstChild).toBe(box);
    expect(box.checked).toBe(false); // the box keeps its own state
    expect(cell.querySelectorAll(".task-chip")).toHaveLength(1);

    const bold = cellOf("<strong>Zadzwonić</strong> @Anna");
    compactTaskCell(bold, "[ ] **Zadzwonić** @Anna");
    expect(bold.querySelector("strong")).not.toBeNull();

    setTaskSpace("off");
    const plain = cellOf("[ ] Zadzwonić @Anna");
    compactTaskCell(plain, "[ ] Zadzwonić @Anna");
    expect(plain.textContent).toBe("[ ] Zadzwonić @Anna");
  });
});

describe("the stable id of a task", () => {
  it("gets one id on the first edit of a task with text, in the same transaction", () => {
    setTaskSpace("organization");
    let state = EditorState.create({ doc: "- [ ] Nowe", extensions: taskExtensions() });
    state = state.update({ changes: { from: state.doc.length, insert: " pilne" } }).state;
    expect(/\^z-[0-9a-f]{4}$/.test(state.doc.toString())).toBe(true);
    state = state.update({ changes: { from: 0, insert: "x" } }).state;
    expect(state.doc.toString().match(/\^z-/g)).toHaveLength(1);
  });

  it("never adds a second id to a task that has one, even when text is typed after it", () => {
    setTaskSpace("organization");
    const after = typed("- [ ] A ^z-1111", 15, " @Jan");
    expect(after.match(/\^/g)).toHaveLength(1);
    expect(after).toContain("^z-1111");
  });

  it("gets no second id on a task whose user typed an id by hand", () => {
    setTaskSpace("organization");
    expect(typed("- [ ] Plan", 10, " ^abc").match(/\^/g)).toHaveLength(1);
  });

  it("gets no id on a plain line, which is not a task", () => {
    setTaskSpace("organization");
    expect(typed("Zwykły tekst", 12, " dalej")).not.toContain("^");
  });

  it("gets no id inside a code fence or in the front matter", () => {
    setTaskSpace("organization");
    expect(typed("```\n- [ ] przykład\n```", 15, "x")).not.toContain("^z-");
    // the insert is on the task line inside the front matter (after "x")
    expect(typed("---\n- [ ] x\n---", 11, " y")).not.toContain("^z-");
  });

  it("removes an id with Backspace, leaving no stray ^ and no new id", () => {
    setTaskSpace("organization");
    const view = editor("- [ ] A ^z-ab", 13);
    // five Backspaces take `b`, `a`, `-`, `z` and `^` away
    for (let i = 0; i < 5; i++) {
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head - 1, to: head }, selection: { anchor: head - 1 } });
    }
    expect(view.state.doc.toString()).toBe("- [ ] A ");
    // typing on that line afterwards still adds no id while the cursor stays there
    view.dispatch({ changes: { from: 8, insert: "x" }, selection: { anchor: 9 } });
    expect(view.state.doc.toString()).toBe("- [ ] A x");
  });

  it("does not add an id when text is typed right after an id", () => {
    setTaskSpace("organization");
    const view = editor("- [ ] A ^z-33f0", 15);
    view.dispatch({ changes: { from: 15, insert: "!" }, selection: { anchor: 16 } });
    expect(view.state.doc.toString()).toBe("- [ ] A ^z-33f0!");
    // a second key on the same line: still no new id
    view.dispatch({ changes: { from: 16, insert: "x" }, selection: { anchor: 17 } });
    expect(view.state.doc.toString()).toBe("- [ ] A ^z-33f0!x");
  });

  it("still gives an id to a task that never had one when a ^ is deleted from its text", () => {
    setTaskSpace("organization");
    const view = editor("- [ ] a^b", 9);
    view.dispatch({ changes: { from: 7, to: 8 }, selection: { anchor: 8 } });
    expect(view.state.doc.toString()).toMatch(/^- \[ \] ab \^z-[0-9a-f]{4}$/);
  });

  it("gets no id for a task that still has no text", () => {
    setTaskSpace("organization");
    expect(typed("- [ ] ", 6, " ")).not.toContain("^");
  });

  it("gets no id for a task without text, and none on the line Enter makes", () => {
    setTaskSpace("organization");
    const start = EditorState.create({ doc: "- [ ] Plan", extensions: taskExtensions() });
    // Enter at the end of the task makes an empty item below it; the task with text gets its id, the empty item not
    const enter = start.update({ changes: { from: 10, insert: "\n- [ ] " }, selection: EditorSelection.single(17) }).state;
    const [first, second] = enter.doc.toString().split("\n");
    expect(first).toMatch(/^- \[ \] Plan \^z-[0-9a-f]{4}$/);
    expect(second).toBe("- [ ] ");
    // a second Enter on the empty item takes the marker away again: nothing with an id is left behind
    const d = enter.doc.toString();
    const cut = d.lastIndexOf("\n");
    const again = enter.update({ changes: { from: cut, to: d.length }, selection: EditorSelection.single(cut) }).state;
    expect(again.doc.toString().split("\n")).toHaveLength(1);
    expect(again.doc.toString()).toBe(first);
  });

  it("gets no id for a remote change, and a remote change that keeps the task line leaves it a task", () => {
    setTaskSpace("organization");
    const remote = EditorState.create({ doc: "- [ ] Nowe", extensions: taskExtensions() });
    const after = remote.update({
      changes: { from: "- [ ] Nowe".length, insert: " z sieci" },
      annotations: ySyncAnnotation.of({} as never),
    }).state;
    expect(after.doc.toString()).toBe("- [ ] Nowe z sieci");
  });

  it("gets no id on a task line that the same transaction creates, as a paste does", () => {
    setTaskSpace("organization");
    const start = EditorState.create({ doc: "Start", extensions: taskExtensions() });
    const pasted = start.update({ changes: { from: 5, insert: "\n- [ ] Wklejone zadanie" } }).state;
    expect(pasted.doc.toString().split("\n")[1]).toBe("- [ ] Wklejone zadanie");
  });

  it("gets no id in a personal space, where tasks have no stable ids", () => {
    setTaskSpace("personal");
    const state = EditorState.create({ doc: "- [ ] Nowe", extensions: taskExtensions() });
    expect(state.update({ changes: { from: 0, insert: "x" } }).state.doc.toString()).not.toContain("^z-");
  });

  it("keeps an id the user deleted while the cursor stays on that line, and adds one again after it leaves", () => {
    setTaskSpace("organization");
    const view = editor("- [ ] A ^z-1111\nDrugi", "- [ ] A ^z-1111".length);
    // the user deletes the id with the cursor on the line
    view.dispatch({ changes: { from: 7, to: 15 }, selection: { anchor: 7 } });
    expect(view.state.doc.toString()).toBe("- [ ] A\nDrugi");
    // typing on the same line adds nothing
    view.dispatch({ changes: { from: 7, insert: " x" }, selection: { anchor: 9 } });
    expect(view.state.doc.toString()).not.toMatch(/\^z-/);
    // the cursor leaves the line; the next edit on it gets a fresh id
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.dispatch({ changes: { from: 9, insert: "y" }, selection: { anchor: 10 } });
    expect(view.state.doc.toString()).toMatch(/^- \[ \] A xy \^z-[0-9a-f]{4}\nDrugi$/);
  });
});

// A user deletion as the editor makes it (`delete.*`, `delete.cut`, `input.type` over a selection), with the cursor where it ends.
function userEdit(doc: string, from: number, to: number, event = "delete.selection", insert = ""): string {
  const state = EditorState.create({ doc, selection: EditorSelection.single(from), extensions: taskExtensions() });
  return state.update({ changes: { from, to, insert }, selection: EditorSelection.single(from + insert.length), userEvent: event }).state.doc.toString();
}

describe("deleting a task with the keyboard, cut or a selection", () => {
  const DOC = "Przed\n- [ ] Zadzwonić @Ania 📅 2026-11-20 ^z-ab12\nPo";
  const at = (s: string) => DOC.indexOf(s);

  it("Backspace letter by letter empties the title first and keeps the people and date; the next one removes the task", () => {
    const one = "Przed\n- [ ] Z @Ania 📅 2026-11-20 ^z-ab12\nPo";
    const z = one.indexOf("Z @");
    const emptied = userEdit(one, z, z + 1, "delete.backward");
    expect(emptied).toBe("Przed\n- [ ]  @Ania 📅 2026-11-20 ^z-ab12\nPo");
    const s = emptied.indexOf(" @Ania");
    expect(userEdit(emptied, s, s + 1, "delete.forward")).toBe("Przed\nPo");
  });

  beforeEach(() => setTaskSpace("organization"));

  it("selecting the task text and deleting it takes the tokens and the marker too", () => {
    expect(userEdit(DOC, at("Zadzwonić"), at("Zadzwonić") + "Zadzwonić".length)).toBe("Przed\nPo");
  });

  it("cutting the visible text with its @person takes the rest of the line too", () => {
    expect(userEdit(DOC, at("Zadzwonić"), at(" 📅"), "delete.cut")).toBe("Przed\nPo");
  });

  it("deleting part of a date leaves no half token", () => {
    const from = at("1-20"); // `📅 2026-1` would be left
    expect(userEdit(DOC, from, from + 4)).toBe("Przed\n- [ ] Zadzwonić @Ania ^z-ab12\nPo");
  });

  it("Backspace after the id removes the whole id, not one character of it", () => {
    const end = at("\nPo");
    expect(userEdit(DOC, end - 1, end, "delete.backward")).toBe("Przed\n- [ ] Zadzwonić @Ania 📅 2026-11-20\nPo");
  });

  it("deleting the last characters of the id leaves no `^z-a`", () => {
    const from = at("b12");
    expect(userEdit(DOC, from, from + 3)).toBe("Przed\n- [ ] Zadzwonić @Ania 📅 2026-11-20\nPo");
  });

  it("deleting a whole task line with its break leaves the other lines", () => {
    const start = at("- [ ]");
    expect(userEdit(DOC, start, at("\nPo") + 1)).toBe("Przed\nPo");
  });

  it("one undo restores the task with all its tokens", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: DOC, extensions: [history(), ...taskExtensions()] }),
    });
    views.push(view);
    view.dispatch({ changes: { from: at("Zadzwonić"), to: at(" 📅") }, userEvent: "delete.cut" });
    expect(view.state.doc.toString()).toBe("Przed\nPo");
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("leaves a remote deletion alone, as the other editors make it", () => {
    const state = EditorState.create({ doc: DOC, extensions: taskExtensions() });
    const after = state.update({
      changes: { from: at("Zadzwonić"), to: at("Zadzwonić") + 9 },
      annotations: ySyncAnnotation.of({} as never),
    }).state;
    expect(after.doc.toString()).toBe("Przed\n- [ ]  @Ania 📅 2026-11-20 ^z-ab12\nPo");
  });

  it("leaves a plain list item and a task inside a code fence alone", () => {
    expect(userEdit("Przed\n- Zadzwonić @Ania\nPo", 8, 17)).toBe("Przed\n-  @Ania\nPo");
    const fence = "```\n- [ ] Zadzwonić @Ania\n```";
    expect(userEdit(fence, 10, 19)).toBe("```\n- [ ]  @Ania\n```");
  });
});

describe("typing over a selection that covers a token", () => {
  it("keeps the typed text and still takes the token it touched whole", () => {
    setTaskSpace("organization");
    const doc = "Przed\n- [ ] Zadzwonić @Ania 📅 2026-11-20 ^z-ab12\nPo";
    const from = doc.indexOf("Zadzwonić");
    const to = doc.indexOf(" 📅");
    // the text and the @person are replaced; the date and the id stay, as they were not touched
    expect(userEdit(doc, from, to, "input.type", "Kupić")).toBe("Przed\n- [ ] Kupić 📅 2026-11-20 ^z-ab12\nPo");
  });
});
