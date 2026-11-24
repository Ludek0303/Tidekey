// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { clearGhost, dictationGhost, showGhost } from "./ghost";

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures the scrolled-to selection through these.
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

// Counts the transactions that change the document, to show the ghost never does.
function editor(doc: string): { view: EditorView; changes: () => number } {
  let changes = 0;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [dictationGhost, EditorView.updateListener.of((u) => { if (u.docChanged) changes++; })],
    }),
  });
  return { view, changes: () => changes };
}

const ghostOf = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".cm-dictation-ghost");

describe("dictation ghost", () => {
  it("shows the text at the caret, joined the way the final will be", () => {
    const { view } = editor("Kawa");
    view.dispatch({ selection: { anchor: 4 } });
    showGhost(view, "ala ma kota.");
    const span = ghostOf(view);
    expect(span?.textContent).toBe(" ala ma kota.");
    expect(span?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the document and its changes untouched", () => {
    const { view, changes } = editor("Kawa");
    view.dispatch({ selection: { anchor: 4 } });
    showGhost(view, "ala");
    clearGhost(view);
    expect(view.state.doc.toString()).toBe("Kawa");
    expect(changes()).toBe(0);
  });

  it("moves when text is typed before it", () => {
    const { view } = editor("Kawa");
    view.dispatch({ selection: { anchor: 4 } });
    showGhost(view, "ala");
    view.dispatch({ changes: { from: 0, insert: "X" } });
    expect(view.state.doc.toString()).toBe("XKawa");
    expect(view.contentDOM.textContent).toContain("XKawa ala");
  });

  it("is removed by clear, and empty text shows nothing", () => {
    const { view } = editor("Kawa");
    view.dispatch({ selection: { anchor: 4 } });
    showGhost(view, "ala");
    clearGhost(view);
    expect(ghostOf(view)).toBeNull();
    showGhost(view, "   ");
    expect(ghostOf(view)).toBeNull();
  });
});
