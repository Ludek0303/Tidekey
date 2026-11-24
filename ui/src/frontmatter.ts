//! The YAML front matter of a note, in Live Preview: a small block of `key: value` pairs, muted, as Obsidian shows
//! it. Raw text while the cursor is inside it. The rule of the block is the core's (`front_matter` in parse.rs).

import { type DecorationSet, Decoration, EditorView, WidgetType } from "@codemirror/view";
import { EditorState, StateField, type Text } from "@codemirror/state";

/**
 * Where a note's cursor starts: after its front matter (the start of the line below the closing `---`), so the
 * properties show until the cursor is put into them, and below a title heading right there, so typing never lands
 * in front of the title. 0 for a note with neither.
 */
export function cursorAfterFrontMatter(text: string): number {
  const lines = text.split("\n");
  const close = lines.length >= 2 && lines[0].trimEnd() === "---" ? lines.findIndex((l, i) => i >= 1 && l.trimEnd() === "---") : -1;
  let body = close + 1; // index of the first body line (0 without front matter)
  if (/^#{1,6}\s/.test(lines[body] ?? "")) { if (body + 1 >= lines.length) return text.length; body++; }
  const at = lines.slice(0, body).reduce((n, l) => n + l.length + 1, 0);
  return Math.min(at, text.length);
}

/** The note's text with front matter `key` set to `value`, or removed when `value` is empty. A note without front
 *  matter gets one. Other keys and the body are kept as they are. */
export function setFrontMatter(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const close = lines[0]?.trimEnd() === "---" ? lines.findIndex((l, i) => i >= 1 && l.trimEnd() === "---") : -1;
  const v = value.trim();
  if (close < 0) return v ? `---\n${key}: ${v}\n---\n${text}` : text;
  const at = lines.findIndex((l, i) => i > 0 && i < close && l.split(":")[0].trim() === key);
  if (at >= 0) { if (v) lines[at] = `${key}: ${v}`; else lines.splice(at, 1); }
  else if (v) lines.splice(close, 0, `${key}: ${v}`);
  return lines.join("\n");
}

/** The number of the closing `---` line of the front matter, or 0 when the note has none. */
export function frontMatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return 0;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text.trimEnd() === "---") return n;
  }
  return 0;
}

/** The `key: value` pairs between the front matter's `---` lines; lines without a value are left out. */
export function frontMatterPairs(doc: Text, end: number): [string, string][] {
  const pairs: [string, string][] = [];
  for (let n = 2; n < end; n++) {
    const text = doc.line(n).text;
    const colon = text.indexOf(":");
    if (colon <= 0) continue;
    const value = text.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (value) pairs.push([text.slice(0, colon).trim(), value]);
  }
  return pairs;
}

class PropsWidget extends WidgetType {
  constructor(
    readonly pairs: [string, string][],
    readonly from: number,
  ) {
    super();
  }

  eq(other: PropsWidget): boolean {
    return other.from === this.from && JSON.stringify(other.pairs) === JSON.stringify(this.pairs);
  }

  // No margins on the widget: the editor measures its height for vertical motion, and margins break that. The box is
  // inside a wrapper that has only padding.
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-props-wrap";
    const box = document.createElement("div");
    box.className = "cm-props";
    for (const [key, value] of this.pairs) {
      const row = document.createElement("div");
      const k = document.createElement("span");
      k.className = "cm-props-key";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "cm-props-value";
      v.textContent = value;
      row.append(k, ": ", v);
      box.append(row);
    }
    wrap.append(box);
    // A click puts the cursor at the start of the front matter, so the raw text is there to edit.
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const view = EditorView.findFromDOM(wrap);
      view?.dispatch({ selection: { anchor: this.from } });
      view?.focus();
    });
    return wrap;
  }
}

function block(state: EditorState): DecorationSet {
  const end = frontMatterEnd(state.doc);
  if (end === 0) return Decoration.none;
  const from = state.doc.line(1).from;
  const to = state.doc.line(end).to;
  // a cursor in the block (or an edge of it) shows the raw text
  if (state.selection.ranges.some((r) => r.from <= to && r.to >= from)) return Decoration.none;
  const pairs = frontMatterPairs(state.doc, end);
  return Decoration.set([Decoration.replace({ widget: new PropsWidget(pairs, from), block: true }).range(from, to)]);
}

/** The properties block of the front matter. A block decoration must come from a state field. */
export const frontMatterBlock = StateField.define<DecorationSet>({
  create: (state) => block(state),
  update: (value, tr) => (tr.docChanged || tr.selection ? block(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});
