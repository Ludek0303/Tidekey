// @vitest-environment jsdom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorAfterFrontMatter, frontMatterEnd, frontMatterPairs } from "./frontmatter";
import { liveTaskExtensions, taskExtensions } from "./taskchips";

const NOTE = "---\ntyp: projekt\nstatus: aktywny\n---\n# Triton\n";
const views: EditorView[] = [];

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

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  document.body.replaceChildren();
});

describe("the front matter", () => {
  it("finds the closing line by the core's rule and reads the pairs", () => {
    const state = EditorState.create({ doc: NOTE });
    expect(frontMatterEnd(state.doc)).toBe(4);
    expect(frontMatterPairs(state.doc, 4)).toEqual([["typ", "projekt"], ["status", "aktywny"]]);
    // no closing line: not front matter
    expect(frontMatterEnd(EditorState.create({ doc: "---\ntyp: x\n# brak" }).doc)).toBe(0);
  });

  it("shows as a properties block while the cursor is outside it", () => {
    const view = editor(NOTE, NOTE.length);
    const block = view.contentDOM.querySelector(".cm-props");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("typ");
    expect(block?.textContent).toContain("projekt");
    expect(view.contentDOM.textContent).not.toContain("---");
  });

  it("shows the raw text while the cursor is inside the block", () => {
    const view = editor(NOTE, "---\ntyp".length);
    expect(view.contentDOM.querySelector(".cm-props")).toBeNull();
  });

  it("a click on the block focuses the editor, so the next keys go into the front matter", () => {
    const view = editor(NOTE, NOTE.length);
    const focus = vi.spyOn(view, "focus");
    view.contentDOM.querySelector<HTMLElement>(".cm-props")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(focus).toHaveBeenCalled();
  });

  it("a click on the block puts the cursor at the start of the front matter, where the raw text is", () => {
    const view = editor(NOTE, NOTE.length);
    view.contentDOM.querySelector<HTMLElement>(".cm-props")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.selection.main.head).toBe(0);
    expect(view.contentDOM.querySelector(".cm-props")).toBeNull();
  });

  it("a note starts its cursor below the front matter, and at 0 without front matter", () => {
    expect(cursorAfterFrontMatter(NOTE)).toBe(NOTE.length); // below the title, never in front of it
    expect(cursorAfterFrontMatter("---\ntyp: x\n---\nTekst")).toBe("---\ntyp: x\n---\n".length);
    expect(cursorAfterFrontMatter("# bez\n")).toBe("# bez\n".length);
    expect(cursorAfterFrontMatter("# bez")).toBe("# bez".length); // a lone title line: at its end, not its start
    expect(cursorAfterFrontMatter("zwykły tekst")).toBe(0);
    expect(cursorAfterFrontMatter("---\ntyp: x\n---")).toBe("---\ntyp: x\n---".length);
    const project = "---\ntyp: projekt\n---\n# Tajny\n\n## Cel projektu\n";
    expect(project.slice(cursorAfterFrontMatter(project))).toBe("\n## Cel projektu\n");
  });
});

describe("setFrontMatter", () => {
  it("sets, replaces and removes a key, and adds front matter to a note without it", async () => {
    const { setFrontMatter } = await import("./frontmatter");
    const note = "---\ntyp: projekt\nstatus: aktywny\n---\n# T\n";
    expect(setFrontMatter(note, "osoby", "Anna, Jan")).toBe("---\ntyp: projekt\nstatus: aktywny\nosoby: Anna, Jan\n---\n# T\n");
    expect(setFrontMatter(setFrontMatter(note, "osoby", "Anna"), "osoby", "Jan")).toBe("---\ntyp: projekt\nstatus: aktywny\nosoby: Jan\n---\n# T\n");
    expect(setFrontMatter(setFrontMatter(note, "osoby", "Anna"), "osoby", "")).toBe(note);
    expect(setFrontMatter("# T\n", "osoby", "Anna")).toBe("---\nosoby: Anna\n---\n# T\n");
  });
});
