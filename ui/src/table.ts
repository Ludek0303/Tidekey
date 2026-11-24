import { syntaxTree } from "@codemirror/language";
import { Prec, RangeSet, StateField, type EditorState, type Line, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { evaluateTable, formulasReady, type Table } from "./formula";

// Span of one cell: a..b is the raw text between pipes, from..to the trimmed content.
interface Span {
  a: number;
  b: number;
  from: number;
  to: number;
}

interface Row {
  line: Line;
  cells: Span[];
}

interface TableRange {
  from: number;
  to: number;
}

const DELIMITER = 1; // index of the `|---|` row inside a table
const CACHE_MAX = 32;

/** Cells between unescaped pipes (GFM: a backslash escapes the next character); outer pipes do not create cells. */
export function cellSpans(text: string, base: number): Span[] {
  const cuts = [-1];
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && !esc) cuts.push(i);
    esc = !esc && text[i] === "\\";
  }
  const bounds = [...cuts, text.length];
  const leading = text.trimStart().startsWith("|");
  const trailing = cuts.length > 1 && text.slice(cuts[cuts.length - 1] + 1).trim() === "";
  const spans: Span[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    if ((k === 0 && leading) || (k === bounds.length - 2 && trailing)) continue;
    const a = bounds[k] + 1;
    const b = bounds[k + 1];
    const raw = text.slice(a, b);
    const blank = raw.trim() === "";
    // A blank cell puts the caret just after its first space, e.g. "|  |" -> between the spaces.
    const from = blank ? Math.min(a + 1, b) : a + raw.length - raw.trimStart().length;
    const to = blank ? from : a + raw.trimEnd().length;
    spans.push({ a: base + a, b: base + b, from: base + from, to: base + to });
  }
  return spans;
}

type TreeNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

export function tableAt(state: EditorState, pos: number): TableRange | null {
  for (let n: TreeNode | null = syntaxTree(state).resolveInner(pos, 0); n; n = n.parent) {
    if (n.name === "Table") return { from: n.from, to: n.to };
  }
  return null;
}

function parseTable(state: EditorState, t: TableRange): Row[] {
  const rows: Row[] = [];
  const last = state.doc.lineAt(t.to).number;
  for (let n = state.doc.lineAt(t.from).number; n <= last; n++) {
    const line = state.doc.line(n);
    rows.push({ line, cells: cellSpans(line.text, line.from) });
  }
  return rows;
}

// Table under the caret; the only table that gets address widgets.
const cursorTable = StateField.define<TableRange | null>({
  create: (state) => tableAt(state, state.selection.main.head),
  update: (value, tr) => (tr.docChanged || tr.selection ? tableAt(tr.state, tr.state.selection.main.head) : value),
});

// Cache by table text: unchanged tables are not re-evaluated on each keystroke.
const cache = new Map<string, Table | null>();

function evaluated(text: string): Table | null {
  if (!formulasReady()) return null; // not cached, so the table is evaluated once wasm is up
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let table: Table | null;
  try {
    table = evaluateTable(text);
  } catch (err) {
    console.error("table formulas failed", err);
    return null;
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, table);
  return table;
}

export function colName(c: number): string {
  return (c >= 26 ? colName(Math.floor(c / 26) - 1) : "") + String.fromCharCode(65 + (c % 26));
}

// Structural edits on the table's lines (line 0 header, line 1 delimiter). Cells keep their source text, so `\|` survives.
const cellsOf = (line: string): string[] => cellSpans(line, 0).map((s) => line.slice(s.from, s.to));
export const rowOf = (cells: string[]): string => `| ${cells.join(" | ")} |`;

/** Inserts an empty column before column `at`; the delimiter row gets a `---` cell there. */
export function insertColumn(lines: string[], at: number): string[] {
  return lines.map((line, i) => {
    const cells = cellsOf(line);
    const fill = i === DELIMITER ? "---" : "";
    while (cells.length < at) cells.push(fill); // a short row is padded so the column lands at `at`
    cells.splice(at, 0, fill);
    return rowOf(cells);
  });
}

/** Removes column `at`; a table keeps at least one column. */
export function deleteColumn(lines: string[], at: number): string[] {
  if (cellsOf(lines[0] ?? "").length < 2) return lines;
  return lines.map((line) => {
    const cells = cellsOf(line);
    cells.splice(at, 1);
    return rowOf(cells);
  });
}

/** Inserts an empty body row before line `at`; the header and the delimiter (lines 0 and 1) cannot move. */
export function insertRow(lines: string[], at: number): string[] {
  if (at < DELIMITER + 1 || at > lines.length) return lines;
  const blank = rowOf(Array.from({ length: cellsOf(lines[0] ?? "").length }, () => ""));
  return [...lines.slice(0, at), blank, ...lines.slice(at)];
}

/** Removes line `at`; the header and the delimiter stay, and so does the last body row. */
export function deleteRow(lines: string[], at: number): string[] {
  if (at < DELIMITER + 1 || at >= lines.length || lines.length <= DELIMITER + 2) return lines;
  return lines.filter((_, i) => i !== at);
}

class ResultWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly error: boolean,
    readonly raw: string,
  ) {
    super();
  }

  eq(o: ResultWidget): boolean {
    return o.text === this.text && o.error === this.error && o.raw === this.raw;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.error ? "cm-formula-result cm-formula-error" : "cm-formula-result";
    el.textContent = this.text;
    el.title = this.raw;
    el.setAttribute("aria-label", `${this.text}, formuła ${this.raw}`);
    return el;
  }
}

class RowMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }

  eq(o: RowMarker): boolean {
    return o.text === this.text;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-row";
    el.setAttribute("aria-hidden", "true");
    el.textContent = this.text;
    return el;
  }
}

// Fixed-width gutter column, so the margin does not change size when the caret enters a table.
class SpacerMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-spacer";
    el.textContent = "000"; // widest row number up to 999, so the gutter never changes width
    return el;
  }
}

class ColWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }

  eq(o: ColWidget): boolean {
    return o.name === this.name;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-table-col";
    el.setAttribute("aria-hidden", "true");
    el.dataset.col = this.name;
    return el;
  }
}

// Row numbers in the margin, for the visible lines of the table under the caret. The text does not move.
const rowNumbers = gutter({
  class: "cm-table-gutter",
  initialSpacer: () => new SpacerMarker(),
  markers: (view: EditorView): RangeSet<GutterMarker> => {
    const t = view.state.field(cursorTable);
    if (!t) return RangeSet.empty;
    const { doc } = view.state;
    const first = doc.lineAt(t.from).number;
    const last = doc.lineAt(t.to).number;
    const out: Range<GutterMarker>[] = [];
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      if (n - first === DELIMITER) continue;
      if (!view.visibleRanges.some((r) => line.from <= r.to && line.to >= r.from)) continue;
      out.push(new RowMarker(String(Math.max(n - first, 1))).range(line.from));
    }
    return RangeSet.of(out, true);
  },
});

// Column letters sit over the header cells; the widget is zero-width, so the text does not move.
const colLetters = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = letterDecorations(view);
    }

    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = letterDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

function letterDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const t = state.field(cursorTable);
  if (!t) return Decoration.none;
  const header = state.doc.lineAt(t.from);
  if (!view.visibleRanges.some((r) => header.from <= r.to && header.to >= r.from)) return Decoration.none;
  const widgets = cellSpans(header.text, header.from).map((c, i) =>
    Decoration.widget({ widget: new ColWidget(colName(i)), side: -1 }).range(c.from),
  );
  return Decoration.set(widgets, true);
}

// Formula results over the visible tables; the cell with the caret keeps its raw formula.
const formulas = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = formulaDecorations(view);
    }

    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = formulaDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

function formulaDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const heads = state.selection.ranges.map((r) => r.head);
  const out: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        if (n.name !== "Table") return;
        if (seen.has(n.from)) return false;
        seen.add(n.from);
        addFormulas(state, { from: n.from, to: n.to }, heads, out);
        return false;
      },
    });
  }
  return Decoration.set(out, true);
}

function addFormulas(state: EditorState, t: TableRange, heads: number[], out: Range<Decoration>[]): void {
  const table = evaluated(state.sliceDoc(t.from, t.to));
  if (!table) return;
  parseTable(state, t).forEach((row, i) => {
    if (i === DELIMITER) return;
    const r = i === 0 ? 0 : i - 1; // wasm rows: header = 0, first body row = 1
    row.cells.forEach((span, c) => {
      const cell = table.cell(r, c);
      if (!cell.isFormula || heads.some((h) => h >= span.from && h <= span.to)) return;
      const raw = state.sliceDoc(span.from, span.to);
      out.push(
        Decoration.replace({ widget: new ResultWidget(cell.text, cell.kind === "error", raw) }).range(span.from, span.to),
      );
    });
  });
}

function caretCol(cells: Span[], head: number): number {
  let col = 0;
  cells.forEach((c, i) => {
    if (c.a <= head) col = i;
  });
  return col;
}

// Tab/Shift+Tab walk the cells in order; they return false outside tables so normal keys still work.
function moveCell(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const t = tableAt(state, head);
  if (!t) return false;
  const cells = parseTable(state, t).flatMap((row, i) => (i === DELIMITER ? [] : row.cells));
  if (dir === 1) {
    const next = cells.find((c) => c.a > head);
    if (next) view.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
    return true;
  }
  const cur = caretCol(cells, head);
  if (cur > 0) view.dispatch({ selection: { anchor: cells[cur - 1].from }, scrollIntoView: true });
  return true;
}

// Caret into row `next`, in the column the caret has in its own row.
function gotoRow(view: EditorView, rows: Row[], head: number, next: number): void {
  const cur = rows.findIndex((r) => r.line.from <= head && head <= r.line.to);
  const cells = rows[next].cells;
  const span = cells[Math.min(caretCol(rows[cur].cells, head), cells.length - 1)];
  view.dispatch({ selection: { anchor: span ? span.from : rows[next].line.from }, scrollIntoView: true });
}

// ArrowUp/ArrowDown jump over the delimiter; at the first or last row they return false so the caret leaves the table.
function moveRow(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const t = tableAt(state, head);
  if (!t) return false;
  const rows = parseTable(state, t);
  let next = rows.findIndex((r) => r.line.from <= head && head <= r.line.to) + dir;
  if (next === DELIMITER) next += dir;
  if (next < 0 || next >= rows.length) return false;
  gotoRow(view, rows, head, next);
  return true;
}

// Left/Right leave a cell only from its content edge; inside the text they return false and the caret moves as usual.
function moveEdge(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const t = tableAt(state, head);
  if (!t) return false;
  const cells = parseTable(state, t).flatMap((row, i) => (i === DELIMITER ? [] : row.cells));
  const i = cells.findIndex((c) => (dir === 1 ? c.to : c.from) === head);
  const next = cells[i + dir];
  if (i < 0 || !next) return false;
  view.dispatch({ selection: { anchor: dir === 1 ? next.from : next.to }, scrollIntoView: true });
  return true;
}

function enterRow(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const t = tableAt(state, head);
  if (!t) return false;
  const rows = parseTable(state, t);
  const cur = rows.findIndex((r) => r.line.from <= head && head <= r.line.to);
  const col = caretCol(rows[cur].cells, head);
  let next = cur + 1;
  if (next === DELIMITER) next++;
  if (next < rows.length) {
    gotoRow(view, rows, head, next);
    return true;
  }
  // Appending a row is a real edit: it goes through the normal transaction (and Yjs).
  const row = "|" + "  |".repeat(rows[0].cells.length);
  const spans = cellSpans(row, 0);
  const end = state.doc.lineAt(t.to).to;
  const span = spans[Math.min(col, spans.length - 1)];
  view.dispatch({
    changes: { from: end, insert: "\n" + row },
    selection: { anchor: end + 1 + span.from },
    scrollIntoView: true,
  });
  return true;
}

const tableKeys = Prec.highest(
  keymap.of([
    { key: "Tab", run: (v) => moveCell(v, 1) },
    { key: "Shift-Tab", run: (v) => moveCell(v, -1) },
    { key: "Enter", run: enterRow },
    { key: "ArrowUp", run: (v) => moveRow(v, -1) },
    { key: "ArrowDown", run: (v) => moveRow(v, 1) },
    { key: "ArrowLeft", run: (v) => moveEdge(v, -1) },
    { key: "ArrowRight", run: (v) => moveEdge(v, 1) },
  ]),
);

export function tableExtension() {
  return [cursorTable, rowNumbers, colLetters, formulas, tableKeys];
}
