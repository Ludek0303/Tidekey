//! Task lines in Live Preview: their tokens show as chips while the cursor is on another line. In an organization
//! space a task gets a stable `^z-xxxx` id once, on its first edit with text, in the same transaction as that edit.
//! Which lines are tasks is decided by the core (`parseLine`), and code fences and front matter are left out here.

import { type ChangeSpec, EditorState, type Extension, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";
import { frontMatterBlock, frontMatterEnd } from "./frontmatter";
import { type Chip, type DueState, cellTaskOf, chipsOf, parseLine } from "./orgtasks";

/** "organization" and "personal" (notatki) both show the chips; only an organization gives the stable ids. */
export type TaskSpace = "organization" | "personal" | "off";

// Set by the shell: the chips and the task-line click are on in both kinds, the ids in an organization only.
let chipsOn = false;
let idsOn = false;
let onTaskLine: ((line: number) => boolean | void) | null = null;

export function setTaskSpace(space: TaskSpace): void {
  chipsOn = space !== "off";
  idsOn = space === "organization";
}

/** Called with the 1-based line when a task line is clicked. */
export function setTaskLineHandler(handler: ((line: number) => boolean | void) | null): void {
  onTaskLine = handler;
}

/** Opens the task panel of the task on `line` of the note on screen; false while there is none there (yet). */
export function openTaskPanel(line: number): boolean {
  return onTaskLine?.(line) === true;
}

/**
 * The lines inside code fences, by the core's rule: a fence opens with three or more backticks or tildes and closes
 * with the same character, at least as many, and nothing else on the line.
 */
export function fencedLines(doc: Text): Set<number> {
  const out = new Set<number>();
  let open: { ch: string; len: number } | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    const t = doc.line(n).text.trimStart();
    const ch = t[0] ?? "";
    const len = ch === "`" || ch === "~" ? [...t].findIndex((c) => c !== ch) : 0;
    const count = len === -1 ? t.length : len;
    if (open) {
      out.add(n);
      if (count >= 3 && ch === open.ch && count >= open.len && t.slice(count).trim() === "") open = null;
    } else if (count >= 3 && (ch === "`" || ch === "~")) {
      open = { ch, len: count };
      out.add(n);
    }
  }
  return out;
}

class ChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: string,
    readonly state?: DueState,
  ) {
    super();
  }

  eq(other: ChipWidget): boolean {
    return other.label === this.label && other.kind === this.kind && other.state === this.state;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `task-chip task-chip-${this.kind}`;
    if (this.state) span.dataset.due = this.state;
    span.textContent = this.label;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// Lines with the cursor (or any selection end) keep their raw tokens, so they can be edited as text.
function chipDecorations(view: EditorView): DecorationSet {
  if (!chipsOn) return Decoration.none;
  const doc = view.state.doc;
  const front = frontMatterEnd(doc);
  const code = fencedLines(doc);
  const cursorLines = new Set<number>();
  for (const r of view.state.selection.ranges) {
    cursorLines.add(doc.lineAt(r.from).number);
    cursorLines.add(doc.lineAt(r.to).number);
  }
  const today = todayDay();
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number > front && !code.has(line.number) && !cursorLines.has(line.number)) {
        for (const c of chipsOf(line.text, today)) ranges.push(chipRange(line.from, c));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from, r.to)),
    true,
  );
}

function chipRange(lineFrom: number, c: Chip): { from: number; to: number; deco: Decoration } {
  const from = lineFrom + c.from;
  const to = lineFrom + c.to;
  // the id is hidden, not replaced: its text is not shown anywhere on the line
  const deco = c.kind === "hidden" ? Decoration.replace({}) : Decoration.replace({ widget: new ChipWidget(c.label, c.kind, c.state) });
  return { from, to, deco };
}

function todayDay(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}

const chipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = chipDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) this.decorations = chipDecorations(update.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event: MouseEvent, view: EditorView): void {
        if (!chipsOn || !onTaskLine) return;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return;
        const line = view.state.doc.lineAt(pos);
        if (parseLine(line.text)) onTaskLine(line.number);
      },
    },
  },
);

/** A table cell with one task, in the short form: its checkbox, its title and the person and date chips. `raw` is the
 * cell's Markdown (the live preview has already drawn its box). Cells with other markup are left as they are. */
export function compactTaskCell(cell: HTMLElement, raw: string): void {
  if (!chipsOn || /<br/i.test(raw)) return;
  const box = cell.querySelector<HTMLInputElement>(":scope > input.cm-lp-task");
  if ([...cell.children].some((child) => child !== box)) return;
  const task = cellTaskOf(raw.replace(/\\\|/g, "|"), todayDay());
  if (!task) return;
  const check = box ?? document.createElement("input");
  if (!box) {
    check.type = "checkbox";
    check.className = "cm-lp-task";
    check.checked = task.done;
    check.disabled = true;
    check.setAttribute("aria-label", "Zaznaczenie");
  }
  const chips = task.chips.map((c) => new ChipWidget(c.label, c.kind, c.state).toDOM());
  cell.replaceChildren(check, document.createTextNode(task.title), ...chips);
}

/** A random `z-xxxx` id, not used in the text yet. */
export function newTaskId(text: string): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(2));
    const id = `z-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (!text.includes(`^${id}`)) return id;
  }
}

// A line whose id was deleted or broken (by a selection, Backspace, or text typed onto it) gets no id again until
// the cursor has left it.
const ID_TEXT = /(^|\s)\^[A-Za-z0-9-]+/;
const idSuppressed = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    const next = value.map((p) => tr.changes.mapPos(p, 1));
    if (tr.docChanged) {
      tr.changes.iterChanges((fromA, toA, fromB) => {
        const removed = tr.startState.doc.sliceString(fromA, toA);
        const line = tr.newDoc.lineAt(fromB);
        const lost = !!parseLine(tr.startState.doc.lineAt(fromA).text)?.id && !parseLine(line.text)?.id;
        if (ID_TEXT.test(removed) || lost) next.push(line.from);
      });
    }
    // the suppression ends when the cursor is no longer on its line
    const cursorLine = tr.state.doc.lineAt(tr.state.selection.main.head).from;
    return next.filter((p) => p === cursorLine);
  },
});

// The id goes on the first edit of a task line that has text and no id yet. Never on a line the same transaction
// created (Enter makes an empty item), never on a remote change, never in code or front matter.
const stableIds = EditorState.transactionFilter.of((tr) => {
  if (!idsOn || !tr.docChanged || tr.annotation(ySyncAnnotation) !== undefined) return tr;
  const doc = tr.newDoc;
  const suppressed = new Set(tr.startState.field(idSuppressed).map((p) => tr.changes.mapPos(p, 1)));
  const created: [number, number][] = [];
  const touched = new Set<number>();
  // lines that had an id at the start of the transaction never get a new one in it
  const hadId = new Set<number>();
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const removed = tr.startState.doc.sliceString(fromA, toA);
    if (parseLine(tr.startState.doc.lineAt(fromA).text)?.id) hadId.add(doc.lineAt(fromB).number);
    if (ID_TEXT.test(removed)) suppressed.add(doc.lineAt(fromB).from);
    if (inserted.toString().includes("\n")) created.push([fromB, toB]);
    for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) touched.add(n);
  });
  const front = frontMatterEnd(doc);
  const code = fencedLines(doc);
  const changes: ChangeSpec[] = [];
  for (const n of touched) {
    const line = doc.line(n);
    if (n <= front || code.has(n) || suppressed.has(line.from) || hadId.has(n)) continue;
    if (created.some(([a, b]) => line.from >= a && line.to <= b)) continue;
    const task = parseLine(line.text);
    if (!task || task.id !== null || task.text.trim() === "") continue;
    changes.push({ from: line.to, insert: ` ^${newTaskId(doc.toString())}` });
  }
  if (changes.length === 0) return tr;
  return [tr, { changes, sequential: true }];
});

// A line with nothing left but its marker, checkbox, tokens and spaces has no text: the task is gone.
function noTextLeft(line: string): boolean {
  const rest = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\])?/, "");
  return (parseLine(`- [ ] ${rest}`)?.text ?? rest).trim() === "";
}

// A user deletion takes every token it touches whole (with the space before it), and a task whose text is gone takes
// its marker and line break too. The extra changes ride in the same transaction, so one undo restores everything.
// shortcut: only the tasks' own lines are read here; a token typed into a plain line is left alone
const taskDeletes = EditorState.transactionFilter.of((tr) => {
  if (!chipsOn || !tr.docChanged || tr.annotation(ySyncAnnotation) !== undefined) return tr;
  if (!tr.isUserEvent("delete") && !tr.isUserEvent("input")) return tr;
  const start = tr.startState.doc;
  const doc = tr.newDoc;
  const removed: [number, number][] = [];
  tr.changes.iterChanges((fromA, toA) => {
    if (toA > fromA) removed.push([fromA, toA]);
  });
  if (removed.length === 0) return tr;
  removed.sort((x, y) => x[0] - y[0]);
  // The whole-document scans (front matter, code fences) run only once a deleted line reads as a task.
  let skip: { front: number; code: Set<number> } | null = null;
  const usable = (n: number) => {
    skip ??= { front: frontMatterEnd(start), code: fencedLines(start) };
    return n > skip.front && !skip.code.has(n);
  };
  // in start coordinates: the tokens a deletion touches, from the space before each to its end
  const whole: [number, number][] = [];
  // in start coordinates: the lines of tasks a deletion touches
  const tasks = new Set<number>();
  for (const [a, b] of removed) {
    for (let n = start.lineAt(a).number; n <= start.lineAt(b).number; n++) {
      const line = start.line(n);
      const parsed = parseLine(line.text);
      const task = parsed && usable(n) ? parsed : null;
      if (!task) continue;
      tasks.add(n);
      for (const t of task.tokens) {
        const from = line.from + t.from;
        const to = line.from + t.to;
        if (from >= b || to <= a) continue;
        let s = from;
        while (s > line.from && /\s/.test(start.sliceString(s - 1, s))) s--;
        whole.push([s, to]);
      }
    }
  }
  // the parts of those tokens that the deletion did not already take, mapped to the new document
  const ranges: [number, number][] = [];
  for (const [s, e] of whole) {
    let p = s;
    for (const [a, b] of removed) {
      if (b <= p || a >= e) continue;
      if (a > p) ranges.push([tr.changes.mapPos(p, 1), tr.changes.mapPos(a, -1)]);
      p = Math.max(p, b);
    }
    if (p < e) ranges.push([tr.changes.mapPos(p, 1), tr.changes.mapPos(e, -1)]);
  }
  // A task line that has no text left goes whole, with its line break. Deleting letter by letter (no selection) only
  // empties the text first, so a title can be retyped keeping its people and dates; the next Backspace removes the task.
  const byCharacter = (tr.isUserEvent("delete.backward") || tr.isUserEvent("delete.forward")) && tr.startState.selection.ranges.every((r) => r.empty);
  for (const n of tasks) {
    const line = start.line(n);
    if (byCharacter && !noTextLeft(line.text)) continue;
    const from = tr.changes.mapPos(line.from, 1);
    const to = tr.changes.mapPos(line.to, -1);
    if (from > to) continue; // the whole line, break included, was deleted already
    const now = doc.lineAt(from);
    if (now.to < to || !noTextLeft(now.text)) continue;
    if (now.number < doc.lines) ranges.push([now.from, now.to + 1]);
    else if (now.number > 1) ranges.push([now.from - 1, now.to]);
    else ranges.push([now.from, now.to]);
  }
  if (ranges.length === 0) return tr;
  // merged, and deleted from the end so the positions still to come stay right
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [f, t] of ranges) {
    const last = merged.at(-1);
    if (last && f <= last[1]) last[1] = Math.max(last[1], t);
    else if (t > f) merged.push([f, t]);
  }
  const changes: ChangeSpec[] = merged.reverse().map(([from, to]) => ({ from, to }));
  return [tr, { changes, sequential: true }];
});

/** The extensions of a note in both modes: stable ids (only in an organization space). */
export function taskExtensions(): Extension[] {
  return [idSuppressed, stableIds, taskDeletes];
}

/** The Live Preview extensions: the chips of the tasks and the properties block. Not in Source mode. */
export function liveTaskExtensions(): Extension[] {
  return [chipPlugin, frontMatterBlock];
}
