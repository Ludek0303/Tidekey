// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { openDiagramDialog } from "./diagramdialog";

// jsdom has no layout; CodeMirror measures selections through these.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) }) as DOMRect;

const BLOCK = "```schemat\n[a] A | niebieski\n[b] B\na -> b\n```";
const DOC = `Tekst\n\n${BLOCK}\n\nKoniec`;
const FROM = DOC.indexOf("```schemat");
const TO = FROM + BLOCK.length;

// a real editor with undo history, and a count of the document changes it receives
function editor(doc: string, readOnly = false) {
  const changes: string[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [history(), EditorState.readOnly.of(readOnly), EditorView.updateListener.of((u) => { if (u.docChanged) changes.push(u.state.doc.toString()); })],
    }),
    parent: document.body,
  });
  return { view, changes };
}
const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>(".modal.diagram-dialog button")].find((b) => b.textContent === text)!;

afterEach(() => {
  document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove());
  document.body.replaceChildren();
});

describe("the diagram dialog", () => {
  it("adding a box and Zapisz is one change of the document, and one undo brings the old text back", () => {
    const { view, changes } = editor(DOC);
    openDiagramDialog(view, FROM, TO);
    button("+ Dodaj prostokąt").click();
    expect(changes).toHaveLength(0); // nothing is written before Zapisz
    button("Zapisz").click();
    expect(changes).toHaveLength(1);
    expect(view.state.doc.toString()).toContain("[c] c");
    expect(document.querySelector(".modal.diagram-dialog")).toBeNull();
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("Anuluj changes nothing", () => {
    const { view, changes } = editor(DOC);
    openDiagramDialog(view, FROM, TO);
    button("+ Dodaj prostokąt").click();
    button("Anuluj").click();
    expect(changes).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("a read-only note shows the diagram only: no fields and no Zapisz", () => {
    const { view } = editor(DOC, true);
    openDiagramDialog(view, FROM, TO);
    const dialog = document.querySelector(".modal.diagram-dialog")!;
    expect(dialog.querySelector("input, select, textarea")).toBeNull();
    expect(dialog.querySelector("svg.dg-svg")).not.toBeNull();
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Zapisz");
    button("Zamknij").click();
    expect(document.querySelector(".modal.diagram-dialog")).toBeNull();
  });

  it("dropping a box on a grid cell gives it an explicit cell, and the others keep theirs", () => {
    const { view } = editor(DOC);
    openDiagramDialog(view, FROM, TO);
    const svg = document.querySelector<SVGSVGElement>(".modal.diagram-dialog svg.dg-svg")!;
    const pointer = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { clientX: 0, clientY: y, button: 0, isPrimary: true, pointerId: 1 });
      return e;
    };
    const target = svg.querySelector<SVGRectElement>('g.dg-node[data-id="b"] rect')!;
    // the box is 100 units lower than its place: the nearest cell is the row below the only one, in its own column
    target.dispatchEvent(pointer("pointerdown", 0));
    svg.dispatchEvent(pointer("pointermove", 100));
    svg.dispatchEvent(pointer("pointerup", 100));
    button("Zapisz").click();
    const text = view.state.doc.toString();
    expect(text).toContain("[a] A | niebieski | 1,1");
    expect(text).toContain("[b] B | 2,2");
  });

  it("the automatic layout button leaves no explicit cells", () => {
    const { view } = editor(DOC.replace("[b] B", "[b] B | 2,2"));
    openDiagramDialog(view, FROM, TO);
    button("Układ automatyczny").click();
    button("Zapisz").click();
    expect(view.state.doc.toString()).not.toMatch(/\| \d+,\d+/);
  });
});

describe("the dialog's stylesheet keeps rows inside the box", () => {
  // jsdom applies no CSS, so the rules are checked as text: the grid tracks may shrink and the layout changes below 640px
  const css = readFileSync(resolve(__dirname, "diagram.css"), "utf8");
  it("tracks use minmax(0, …) and fields may shrink", () => {
    expect(css).toContain("minmax(0, 1fr)");
    expect(css).toMatch(/\.dg-row \.task-input \{[^}]*min-width: 0/);
  });
  it("below 640px the connection row takes two lines", () => {
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*\.dg-edge-row \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  });
});
