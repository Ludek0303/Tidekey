// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { headingRail, headingsOf } from "./headingrail";

type Side = "left" | "right" | "off";

const views: EditorView[] = [];

function editor(doc: string, side: () => Side = () => "right"): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), headingRail(side)] }),
  });
  views.push(view);
  return view;
}

const nav = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-heading-rail");
const ticks = (view: EditorView) => [...view.dom.querySelectorAll<HTMLButtonElement>(".cm-heading-tick")];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

describe("heading rail", () => {
  it("draws one tick per heading with its level", () => {
    const view = editor("# Alfa\n\ntekst\n\n## Beta\n\n### Gamma\n\nDelta\n-----\n");
    expect(ticks(view).map((t) => t.dataset.level)).toEqual(["1", "2", "3", "2"]);
    expect(nav(view)!.getAttribute("aria-label")).toBe("Nagłówki notatki");
  });

  it("a heading inside a code block is not a tick", () => {
    const view = editor("# Prawdziwy\n\n```\n# nie nagłówek\n```\n\n## Drugi\n");
    expect(headingsOf(view.state).map((h) => h.text)).toEqual(["Prawdziwy", "Drugi"]);
    expect(ticks(view)).toHaveLength(2);
  });

  it("a front matter block is not read as a heading", () => {
    const view = editor("---\ntitle: Notatka\n---\n# Tytuł\n\n## Podrozdział\n");
    expect(headingsOf(view.state).map((h) => h.text)).toEqual(["Tytuł", "Podrozdział"]);
  });

  it("no nav for fewer than two headings", () => {
    expect(nav(editor("# Jeden\n\ntekst"))).toBeNull();
    expect(nav(editor("bez nagłówków"))).toBeNull();
    expect(nav(editor("# Jeden\n\n## Dwa"))).not.toBeNull();
  });

  it("aria-labels carry the heading text", () => {
    const view = editor("# Zakupy\n\n## Warzywa i owoce\n");
    expect(ticks(view).map((t) => t.getAttribute("aria-label"))).toEqual(["Zakupy", "Warzywa i owoce"]);
    // the visible dash is the `.dash` span the stylesheet draws (without the class the rail is invisible)
    expect(ticks(view).every((t) => t.querySelector("span.dash") !== null)).toBe(true);
  });

  it("a click moves the cursor to the heading line", () => {
    const view = editor("# A\n\ntekst\n\n## Cel\n\ncośtam");
    const target = view.state.doc.toString().indexOf("## Cel");
    ticks(view)[1].click();
    expect(view.state.selection.main.head).toBe(target);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it("the side setting puts the nav right, left, or nowhere", () => {
    let side: Side = "right";
    const view = editor("# A\n\n## B", () => side);
    expect(nav(view)!.dataset.side).toBe("right");
    side = "left";
    view.dispatch({ changes: { from: 0, insert: " " } });
    expect(nav(view)!.dataset.side).toBe("left");
    side = "off";
    view.dispatch({ changes: { from: 0, insert: " " } });
    expect(nav(view)).toBeNull();
  });

  it("hovering a tick shows its heading text in one label", () => {
    const view = editor("# Pierwszy\n\n## Drugi");
    ticks(view)[0].dispatchEvent(new Event("mouseenter"));
    ticks(view)[1].dispatchEvent(new Event("mouseenter"));
    const labels = view.dom.querySelectorAll<HTMLElement>(".cm-heading-label:not([hidden])");
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe("Drugi");
  });

  it("a narrow editor gets no nav, and the rail comes back when it is wide again", () => {
    const view = editor("# A\n\n## B");
    expect(nav(view)).not.toBeNull();
    Object.defineProperty(view.dom, "clientWidth", { configurable: true, value: 400 });
    view.dispatch({ changes: { from: 0, insert: " " } });
    expect(nav(view)).toBeNull();
    Object.defineProperty(view.dom, "clientWidth", { configurable: true, value: 800 });
    view.dispatch({ changes: { from: 0, insert: " " } });
    expect(nav(view)).not.toBeNull();
  });

  it("the dash of the section at the top of the view is the current one", async () => {
    const view = editor("# A\n\ntekst\n\n## B\n\ntekst");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks(view).map((t) => t.classList.contains("is-current"))).toEqual([true, false]);
  });

  it("past 60 headings only levels 1 and 2 get a tick", () => {
    const body = Array.from({ length: 70 }, (_, i) => `### punkt ${i}`).join("\n");
    const view = editor(`# Start\n\n${body}`);
    expect(ticks(view).map((t) => t.dataset.level)).toEqual(["1"]);
  });
});
