import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

// The heading navigator at the editor's edge: one dash per Markdown heading. Hover or focus shows the heading's
// text, a click moves the cursor there, and the dash of the section at the top of the view is highlighted.

interface Heading {
  from: number;
  level: number;
  text: string;
}

const ATX = /^ATXHeading([1-6])$/;
const SETEXT = /^SetextHeading([12])$/;
// Narrower editors get no rail: the text needs the room.
const MIN_WIDTH = 520;
// Big notes rebuild the heading list after a pause in typing, not on every key.
const BIG_DOC_LINES = 2000;
const BIG_DOC_DELAY = 150;
// Over this many headings only levels 1 and 2 get a dash.
const MANY_HEADINGS = 60;
// Over this many dashes the gap shrinks from 6px to 2px.
const DENSE_DASHES = 24;

/** The headings of a note, from the Markdown syntax tree. A front matter block is skipped: the parser reads its
 *  closing `---` under a `key: value` line as a Setext heading. */
export function headingsOf(state: EditorState): Heading[] {
  const doc = state.doc;
  let frontEnd = 0;
  if (doc.lines >= 2 && doc.line(1).text.trimEnd() === "---") {
    for (let n = 2; n <= doc.lines; n++) {
      if (doc.line(n).text.trimEnd() === "---") {
        frontEnd = doc.line(n).to;
        break;
      }
    }
  }
  const out: Heading[] = [];
  // The parser works in chunks: a note too long to parse in 50ms gets its headings from what is parsed so far.
  (ensureSyntaxTree(state, doc.length, 50) ?? syntaxTree(state)).iterate({
    enter(node) {
      const atx = ATX.exec(node.name);
      const setext = SETEXT.exec(node.name);
      if (!atx && !setext) return;
      if (node.from < frontEnd) return false;
      // The first line of the node: the text of an ATX heading, or the text line of a Setext one.
      const first = doc.sliceString(node.from, doc.lineAt(node.from).to);
      const text = atx ? first.replace(/^\s*#{1,6}\s*/, "").replace(/\s+#+\s*$/, "").trim() : first.trim();
      out.push({ from: doc.lineAt(node.from).from, level: Number(atx?.[1] ?? setext![1]), text });
      return false;
    },
  });
  return out;
}

class HeadingRail implements PluginValue {
  private headings: Heading[] = [];
  private nav: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private ticks: HTMLButtonElement[] = [];
  // The headings the ticks were drawn for, so a scroll does not redraw them.
  private drawn: Heading[] | null = null;
  private current: number | null = null;
  private timer = 0;
  private frame = 0;
  private resizer: ResizeObserver | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly side: () => "left" | "right" | "off",
  ) {
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizer = new ResizeObserver(() => this.sync());
      this.resizer.observe(view.dom);
    }
    this.rebuild();
  }

  update(u: ViewUpdate): void {
    if (u.docChanged) {
      clearTimeout(this.timer);
      if (u.state.doc.lines >= BIG_DOC_LINES) this.timer = window.setTimeout(() => this.rebuild(), BIG_DOC_DELAY);
      else this.rebuild();
    } else if (u.viewportChanged) {
      this.scheduleMark();
    }
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.resizer?.disconnect();
    this.unmount();
  }

  private onScroll = (): void => this.scheduleMark();

  // Reading the layout is not allowed during an update, so the current section is found in the next frame.
  private scheduleMark(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.markCurrent();
    });
  }

  private rebuild(): void {
    this.headings = this.side() === "off" ? [] : headingsOf(this.view.state);
    this.sync();
    this.scheduleMark();
  }

  // Shows the rail when it should be, and removes it when it should not.
  private sync(): void {
    const side = this.side();
    const width = this.view.dom.clientWidth;
    const narrow = width > 0 && width < MIN_WIDTH; // 0: not laid out yet, as in jsdom
    if (side === "off" || this.headings.length < 2 || narrow) {
      this.unmount();
      return;
    }
    if (!this.nav) this.mount();
    this.nav!.dataset.side = side;
    if (this.drawn !== this.headings) this.draw();
  }

  private mount(): void {
    this.nav = document.createElement("nav");
    this.nav.className = "cm-heading-rail";
    this.nav.setAttribute("aria-label", "Nagłówki notatki");
    this.label = document.createElement("div");
    this.label.className = "cm-heading-label";
    this.label.setAttribute("aria-hidden", "true");
    this.label.hidden = true;
    this.view.dom.append(this.nav);
  }

  private unmount(): void {
    this.nav?.remove();
    this.nav = null;
    this.label = null;
    this.ticks = [];
    this.drawn = null;
    this.current = null;
  }

  private draw(): void {
    const nav = this.nav!;
    const shown = this.headings.map((h, i) => ({ h, i })).filter(({ h }) => this.headings.length <= MANY_HEADINGS || h.level <= 2);
    this.ticks = shown.map(({ h, i }) => {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "cm-heading-tick";
      tick.dataset.level = String(h.level);
      tick.dataset.index = String(i);
      tick.setAttribute("aria-label", h.text || "Pusty nagłówek");
      const dash = document.createElement("span");
      dash.className = "dash";
      tick.append(dash);
      tick.addEventListener("click", () => this.jump(i));
      tick.addEventListener("mouseenter", () => this.showLabel(tick));
      tick.addEventListener("mouseleave", () => this.hideLabel());
      tick.addEventListener("focus", () => this.showLabel(tick));
      tick.addEventListener("blur", () => this.hideLabel());
      return tick;
    });
    nav.style.gap = this.ticks.length > DENSE_DASHES ? "2px" : "6px";
    nav.replaceChildren(...this.ticks, this.label!);
    this.drawn = this.headings;
    this.current = null;
    this.scheduleMark();
  }

  // The section at the top of the view: the last heading at or above it. Above the first heading, none.
  private markCurrent(): void {
    if (!this.nav) return;
    const top = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from;
    let idx: number | null = null;
    for (let i = 0; i < this.headings.length && this.headings[i].from <= top; i++) idx = i;
    if (idx === this.current) return;
    this.current = idx;
    for (const tick of this.ticks) tick.classList.toggle("is-current", Number(tick.dataset.index) === idx);
  }

  private showLabel(tick: HTMLElement): void {
    if (!this.label) return;
    this.label.textContent = this.headings[Number(tick.dataset.index)].text;
    this.label.style.top = `${tick.offsetTop + tick.offsetHeight / 2}px`;
    this.label.hidden = false;
  }

  private hideLabel(): void {
    if (this.label) this.label.hidden = true;
  }

  private jump(i: number): void {
    const pos = this.headings[i].from;
    this.hideLabel();
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }),
    });
    this.view.focus();
  }
}

/** The heading rail as an extension. `side` is read when the rail is built: a change of the setting rebuilds it. */
export function headingRail(side: () => "left" | "right" | "off"): Extension {
  return ViewPlugin.define((view) => new HeadingRail(view, side));
}
