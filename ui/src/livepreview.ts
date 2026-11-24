import { syntaxTree } from "@codemirror/language";
import { Facet, StateField, type EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { evaluateTable, renderHtml } from "./formula";
import { frontMatterEnd } from "./frontmatter";
import { colName, deleteColumn, deleteRow, insertColumn, insertRow, rowOf } from "./table";
import { cellSpans, checkersOf, mayTick } from "./tablechecks";
import { getSetting } from "./settings";
import { iconButton } from "./icons";
import { download } from "./records";
import { xlsxBytes, type XlsxCell } from "./xlsx";
import { openMenu, toast } from "./widgets";
import { openSubtasks, openSubtasksMessage } from "./orgtasks";
import { compactTaskCell } from "./taskchips";
import { FOLDER_HEAD, foldedFolders } from "./filefolders";
import { folderCardsField } from "./filefolders-view";
import { chartBox, numericHeaders, resolveChart, type ResolvedChart } from "./charts";
import { insertChartBlock, openChartDialog } from "./chartdialog";
import { diagramBox, diagramBody, isDiagramInfo, parseDiagram, type Diagram } from "./diagram";
import { openDiagramDialog } from "./diagramdialog";

// Opens a note by its link target (wikilink or relative Markdown link); editor.ts provides it per tab.
export const linkHandler = Facet.define<(target: string) => void, (target: string) => void>({
  combine: (values) => values[0] ?? (() => {}),
});

type NodeRef = Parameters<Parameters<ReturnType<typeof syntaxTree>["iterate"]>[0]["enter"]>[0];

const CALLOUT = /^\s{0,3}>\s*\[!(note|tip|warning|danger|info)\]\s*(.*)$/i;
const WIKILINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;
const HIGHLIGHT = /==([^=\n]+)==/g;
const CACHE_MAX = 32;
const LINK = "[data-target], [data-href], a[href]";

const HIDDEN = Decoration.replace({});
const CODE = Decoration.mark({ class: "cm-lp-code" });
const MARK = Decoration.mark({ class: "cm-lp-mark" });

// Polish typography: a 1-3 letter word stays on the line with the word after it. The pair is a nowrap mark,
// not a widget: CodeMirror draws buffer images around widgets, and a line can break at those.
// The lookahead matches each start, so "a w domu" marks both "a w" and "w domu".
const SHORT_PAIR = /(?<![\p{L}\p{N}])(?=(\p{L}{1,3} \S+))/gu;
// Reading view only (it has no widgets): the match ends with the space after the short word.
export const SHORT_WORD_SPACE = /(?<![\p{L}\p{N}])\p{L}{1,3} (?=[\p{L}\p{N}]|$)/gu;
const NOWRAP = Decoration.mark({ class: "cm-lp-nowrap" });

/**
 * Opens what a rendered link stands for; the reading view and live preview share it.
 * Note links go to `open`, web links open in a new window, other schemes do nothing.
 * Returns false when `el` is not a link.
 */
export function openLink(el: Element, open: (target: string) => void): boolean {
  const target = el.getAttribute("data-target");
  if (target !== null) {
    open(target.split("#")[0]);
    return true;
  }
  const href = el.getAttribute("href") ?? el.getAttribute("data-href");
  if (href === null) return false;
  if (/^(https?:|mailto:)/i.test(href)) {
    // shortcut: web fallback; Tauri should open these through its opener plugin.
    window.open(href, "_blank", "noopener,noreferrer");
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    open(safeDecode(href).split("#")[0]);
  }
  return true;
}

function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

const SHORT_URL_MAX = 40;
const WEB_URL = /^(?:https?:\/\/|www\.)/i;
// A web address in running text (the reading view has no parser nodes for it); trailing punctuation is left out.
export const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]]/gi;

/** A web address as the view shows it: no scheme or `www.`, cut to 40 characters with an ellipsis. */
export function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return bare.length <= SHORT_URL_MAX ? bare : `${bare.slice(0, SHORT_URL_MAX - 1)}…`;
}

/** The address a click opens: a `www.` address gets its scheme, so openLink takes it as a web link. */
export const webHref = (url: string): string => (/^www\./i.test(url) ? `https://${url}` : url);

// A bare web address shown short. Its href is the full address, so Ctrl+click opens it through `links`.
class LinkWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }

  eq(o: LinkWidget): boolean {
    return o.url === this.url;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-lp-link";
    el.dataset.href = webHref(this.url);
    el.title = this.url;
    el.textContent = shortUrl(this.url);
    return el;
  }

  // Not ignored, or CodeMirror drops the Ctrl+mousedown that `links` needs.
  ignoreEvent(): boolean {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-lp-bullet";
    el.setAttribute("aria-hidden", "true");
    el.textContent = "•";
    return el;
  }
}

// The box is a real input: a click toggles `[ ]`/`[x]` with a normal transaction (Yjs and undo see it).
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(o: TaskWidget): boolean {
    return o.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "cm-lp-task";
    el.checked = this.checked;
    el.setAttribute("aria-label", "Zadanie");
    el.addEventListener("click", (e) => {
      e.preventDefault(); // the view redraws the box from the document
      const from = view.posAtDOM(el);
      const box = view.state.sliceDoc(from, from + 3);
      if (!/^\[[ xX]\]$/.test(box)) return;
      // a tick waits for the open subtasks of the task (see openSubtasks)
      const doc = view.state.doc;
      const open = box === "[ ]" ? openSubtasks(doc.toString().split("\n"), doc.lineAt(from).number - 1) : 0;
      if (open > 0) return toast(openSubtasksMessage(open));
      view.dispatch({ changes: { from, to: from + 3, insert: box === "[ ]" ? "[x]" : "[ ]" } });
      view.focus(); // so the next Ctrl+Z undoes the toggle
    });
    return el;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("hr");
    el.className = "cm-lp-hr";
    return el;
  }
}

class CalloutWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly title: string,
  ) {
    super();
  }

  eq(o: CalloutWidget): boolean {
    return o.type === this.type && o.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-lp-callout-title";
    el.textContent = this.title || this.type[0].toUpperCase() + this.type.slice(1);
    // The box is not text: a click puts the caret at the line start, which shows the raw callout.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
}

// The core renders a box cell's `[ ]` as plain text, so the widget swaps that text for a real checkbox.
function checkBox(checked: boolean, checkers: string[]): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "cm-lp-task";
  box.checked = checked;
  box.toggleAttribute("checked", checked);
  box.disabled = !mayTick(checkers);
  if (box.disabled) box.title = `Zaznaczyć może: ${checkers.join(", ")} lub administrator`;
  box.setAttribute("aria-label", "Zaznaczenie");
  return box;
}

// Cell text as Markdown: a line break is stored as `<br>`, a bare pipe is escaped (an escaped one stays escaped).
// A trailing line break is left out: it shows nothing.
function cellMarkdown(value: string): string {
  return value.replace(/\n+$/, "").replace(/\s*\n\s*/g, "<br>").replace(/(?<!\\)\|/g, "\\|");
}

// Edit mode shows a stored `<br>` as a newline.
const editText = (raw: string): string => raw.replace(/<br\s*\/?>/gi, "\n");

// The text typed into a cell: the line break Shift+Enter makes in the browser (a BR element) is a newline.
const cellText = (node: Node): string =>
  [...node.childNodes].map((n) => (n.nodeName === "BR" ? "\n" : n.nodeType === Node.TEXT_NODE ? (n.textContent ?? "") : cellText(n))).join("");

// The "+" on a border of the letters (a column) or the numbers (a row): visible on hover or keyboard focus.
function addButton(label: string, edge: "col" | "row", run: () => void): HTMLButtonElement {
  const btn = iconButton("plus", label, `cm-lp-add cm-lp-add-${edge}`);
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // the letter or number under it would open its menu
    run();
  });
  return btn;
}

/** A rendered table cell, in the live preview and the reading view: a stored `<br>` (escaped by the renderer, so it
 * arrives as text) becomes a line break, a short cell without spaces (a date, a number, an id) is marked so it does not
 * wrap at a hyphen, and a cell holding one task gets its short form. `raw` is the cell's Markdown. */
export function tidyCell(cell: HTMLElement, raw = cell.textContent ?? ""): void {
  if (/^\S{1,24}$/.test(cell.textContent ?? "")) cell.classList.add("cm-lp-short");
  for (const node of [...cell.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !/<br\s*\/?>/i.test(node.textContent ?? "")) continue;
    const parts = (node.textContent ?? "").split(/<br\s*\/?>/i).flatMap((s, i) => (i ? [document.createElement("br"), document.createTextNode(s)] : [document.createTextNode(s)]));
    node.replaceWith(...parts);
  }
  compactTaskCell(cell, raw);
}

class TableWidget extends WidgetType {
  constructor(readonly md: string, readonly html: string) {
    super();
  }

  eq(o: TableWidget): boolean {
    return o.md === this.md && o.html === this.html;
  }

  // CodeMirror drops widget events unless told otherwise; Ctrl/Cmd+mousedown on a link must reach `links`.
  ignoreEvent(e: Event): boolean {
    const mouse = e as MouseEvent;
    const onLink = e.target instanceof Element && e.target.closest(LINK) !== null;
    return !(e.type === "mousedown" && (mouse.ctrlKey || mouse.metaKey) && onLink);
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-lp-table";
    el.innerHTML = this.html;
    const lines = this.md.split("\n");
    const edits = new Map<string, string>();
    // Formula bar: address and raw source of the cell being edited, announced to screen readers.
    const bar = document.createElement("div");
    bar.className = "cm-lp-bar";
    bar.setAttribute("aria-live", "polite");
    el.prepend(bar);
    const tableCells = [...el.querySelectorAll<HTMLElement>("th, td")];
    const rows = [...el.querySelectorAll("tr")];
    // Taken before the helper row and column are added, so the indexes used for editing stay correct.
    const grid = rows.map((row) => [...row.querySelectorAll<HTMLElement>("th, td")]);
    const headers = cellSpans(lines[0] ?? "").map((c) => c.text);
    // A box ticks by a normal transaction on its `[ ]`/`[x]` in the note; the widget is redrawn from the new text.
    const tick = (box: HTMLElement) => {
      const cell = box.closest<HTMLElement>("th, td")!;
      const shownRow = grid.findIndex((cells) => cells.includes(cell));
      if (shownRow < 0) return;
      const col = grid[shownRow].indexOf(cell);
      const sourceRow = shownRow === 0 ? 0 : shownRow + 1;
      const span = cellSpans(lines[sourceRow] ?? "")[col];
      if (!span || !mayTick(checkersOf(headers[col] ?? ""))) return;
      const from = view.posAtDOM(el) + lines.slice(0, sourceRow).reduce((n, l) => n + l.length + 1, 0) + span.from;
      const mark = view.state.sliceDoc(from, from + 3);
      if (!/^\[[ xX]\]$/.test(mark)) return;
      view.dispatch({ changes: { from, to: from + 3, insert: mark === "[ ]" ? "[x]" : "[ ]" }, userEvent: "input.check" });
      view.focus(); // so the next Ctrl+Z undoes the tick
    };
    const address = (shownRow: number, col: number) => `${colName(col)}${shownRow === 0 ? 1 : shownRow + 1}`;
    const show = (shownRow: number, col: number, value: string) => {
      bar.textContent = `${address(shownRow, col)}: ${value}`;
    };
    // A cell reached by keyboard has its whole text selected; the arrow moves to the next cell only from there or the caret's edge.
    const atCellEdge = (cell: HTMLElement, dir: number): boolean => {
      const sel = getSelection();
      if (!sel || sel.rangeCount === 0 || !cell.contains(sel.anchorNode) || !cell.contains(sel.focusNode)) return false;
      const range = sel.getRangeAt(0);
      const text = cell.textContent ?? "";
      if (!range.collapsed) return range.toString() === text;
      const before = document.createRange();
      before.selectNodeContents(cell);
      before.setEnd(range.startContainer, range.startOffset);
      const offset = before.toString().length;
      return dir < 0 ? offset === 0 : offset === text.length;
    };
    for (const cell of tableCells) {
      const row = cell.closest("tr")!;
      const shownRow = rows.indexOf(row);
      const sourceRow = shownRow === 0 ? 0 : shownRow + 1;
      const col = [...row.querySelectorAll("th, td")].indexOf(cell);
      const key = `${sourceRow}:${col}`;
      const raw = cellSpans(lines[sourceRow] ?? "")[col]?.text ?? "";
      const box = sourceRow > 0 ? /^\[([ xX])\]/.exec(raw) : null; // the header row has no boxes
      if (box) {
        const label = cell.firstChild;
        if (label?.nodeType === Node.TEXT_NODE) label.textContent = (label.textContent ?? "").replace(/^\[[ xX]\]\s?/, "");
        cell.prepend(checkBox(box[1] !== " ", checkersOf(headers[col] ?? "")));
      } else if (sourceRow === 0 && checkersOf(raw).length) {
        // The header shows its name and a lock; the !zaznacza: tokens stay in the source, shown while the cell is edited.
        const label = cell.firstChild;
        if (label?.nodeType === Node.TEXT_NODE) label.textContent = (label.textContent ?? "").replace(/\s*!zaznacza:\S+/gu, "");
        const lock = document.createElement("span");
        lock.className = "cm-lp-checkers";
        lock.textContent = " 🔒";
        lock.title = `Zaznaczyć może: ${checkersOf(raw).join(", ")} lub administrator`;
        cell.append(lock);
      }
      tidyCell(cell, raw);
      const preview = cell.innerHTML;
      cell.contentEditable = "true";
      cell.setAttribute("contenteditable", "true");
      cell.spellcheck = getSetting("spellcheck");
      cell.tabIndex = 0;
      cell.setAttribute("role", "textbox");
      cell.setAttribute("aria-label", `Komórka ${shownRow + 1}, ${col + 1}`);
      let byMouse = false;
      cell.addEventListener("mousedown", () => (byMouse = true));
      cell.addEventListener("focus", () => {
        mark(shownRow, col, true);
        show(shownRow, col, edits.get(key) ?? editText(raw));
        if (cell.dataset.editing === "true") return;
        cell.dataset.editing = "true";
        cell.textContent = edits.get(key) ?? editText(raw);
        // like a spreadsheet: reached by Tab or Enter, the cell is selected and typing replaces it; a click edits in place
        if (!byMouse) { const range = document.createRange(); range.selectNodeContents(cell); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); }
        byMouse = false;
      });
      cell.addEventListener("input", () => {
        const value = cellText(cell);
        if (value === editText(raw)) edits.delete(key); else edits.set(key, value);
        show(shownRow, col, value);
      });
      cell.addEventListener("blur", () => {
        mark(shownRow, col, false);
        delete cell.dataset.editing;
        if (!edits.has(key)) cell.innerHTML = preview;
      });
      cell.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const next = grid[shownRow + 1]?.[col];
          if (next) next.focus(); else cell.blur();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          grid[shownRow + (event.key === "ArrowDown" ? 1 : -1)]?.[col]?.focus();
        } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && atCellEdge(cell, event.key === "ArrowLeft" ? -1 : 1)) {
          // At the row's first or last cell there is no neighbour: the key is consumed and the cell keeps focus.
          event.preventDefault();
          grid[shownRow]?.[col + (event.key === "ArrowLeft" ? -1 : 1)]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cell.blur();
        }
      });
    }
    // Column letters above and row numbers beside the table; CSS shows them only while a cell has focus.
    const cols = Math.max(0, ...grid.map((cells) => cells.length));
    const letterRow = document.createElement("tr");
    letterRow.className = "cm-lp-letters";
    letterRow.setAttribute("aria-hidden", "true");
    const corner = document.createElement("th"); // above the row numbers: the Excel export button
    letterRow.append(corner);
    const letters = Array.from({ length: cols }, (_, c) => {
      const th = document.createElement("th");
      th.textContent = colName(c);
      letterRow.append(th);
      return th;
    });
    rows[0]?.before(letterRow);
    const numbers = rows.map((row, shownRow) => {
      const th = document.createElement("th");
      th.className = "cm-lp-rownum";
      th.setAttribute("aria-hidden", "true");
      th.textContent = String(shownRow === 0 ? 1 : shownRow + 1);
      row.prepend(th);
      return th;
    });
    // Like Excel: the active cell's letter and number are accented, its row and column tinted.
    const mark = (shownRow: number, col: number, on: boolean) => {
      letters[col]?.classList.toggle("cm-lp-active", on);
      numbers[shownRow]?.classList.toggle("cm-lp-active", on);
      grid.forEach((cells, r) => cells.forEach((cell, c) => cell.classList.toggle("cm-lp-tint", on && (r === shownRow || c === col))));
    };
    // The note's lines with the typed cells merged in.
    const merged = (): string[] => {
      const next = [...lines];
      for (const [key, value] of edits) {
        const [row, col] = key.split(":").map(Number);
        const cells = cellSpans(next[row] ?? "").map((c) => c.text);
        cells[col] = cellMarkdown(value);
        next[row] = rowOf(cells);
      }
      return next;
    };
    const replaceTable = (next: string[]) => {
      edits.clear(); // before the dispatch: the cell that is removed must not flush again
      const from = view.posAtDOM(el);
      // typed, so the table guard refuses a rewrite that changes a box the user may not tick
      view.dispatch({ changes: { from, to: from + this.md.length, insert: next.join("\n") }, userEvent: "input" });
    };
    // Row and column changes: the typed cells go in with them, in one transaction, so undo takes both back.
    const restructure = (change: (src: string[]) => string[]) => {
      const next = change(merged());
      if (next.join("\n") !== this.md) replaceTable(next);
      else edits.clear(); // refused (or nothing to change): no transaction
    };
    el.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
      if (edits.size) replaceTable(merged());
    });
    // Letters and numbers: a "+" on each border adds a column or a row there, a click opens the delete menu.
    // mousedown keeps the cell's focus, so the click does not flush the typed cells first.
    const head = (th: HTMLElement, menu: () => void) => {
      th.addEventListener("mousedown", (e) => e.preventDefault());
      th.addEventListener("click", (e) => {
        if (!edits.size) return menu();
        // typed cells are saved first (the menu would take the focus); the table is redrawn, so the click goes to the new one
        replaceTable(merged());
        requestAnimationFrame(() => (document.elementFromPoint(e.clientX, e.clientY)?.closest(".cm-lp-letters th, .cm-lp-rownum") as HTMLElement | null)?.click());
      });
    };
    letters.forEach((th, c) => {
      head(th, () => {
        if (cols < 2) return;
        const r = th.getBoundingClientRect();
        openMenu(r.left, r.bottom + 4, [{ label: `Usuń kolumnę ${colName(c)}`, icon: "trash-2", run: () => restructure((src) => deleteColumn(src, c)) }]);
      });
      th.append(addButton(c + 1 < cols ? `Wstaw kolumnę przed ${colName(c + 1)}` : `Wstaw kolumnę po ${colName(c)}`, "col", () => restructure((src) => insertColumn(src, c + 1))));
    });
    numbers.forEach((th, r) => {
      head(th, () => {
        if (r === 0 || lines.length < 4) return; // the header and the last body row stay
        const b = th.getBoundingClientRect();
        openMenu(b.left, b.bottom + 4, [{ label: `Usuń wiersz ${r + 1}`, icon: "trash-2", run: () => restructure((src) => deleteRow(src, r + 1)) }]);
      });
      // after header row r: the header's border is the spot between the header and the first body row
      th.append(addButton(`Wstaw wiersz po ${r + 1}`, "row", () => restructure((src) => insertRow(src, r === 0 ? 2 : r + 2))));
    });
    // A box keeps the focus where it is: the cell's own edit handling would otherwise take it.
    el.addEventListener("mousedown", (e) => {
      if (e.target instanceof HTMLInputElement && e.target.classList.contains("cm-lp-task")) e.preventDefault();
    });
    el.addEventListener("click", (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target instanceof HTMLInputElement && e.target.classList.contains("cm-lp-task")) {
        e.preventDefault(); // the view redraws the box from the document
        tick(e.target);
        return;
      }
      // Links never navigate the app window. Ctrl/Cmd+click opens them on mousedown (`links`).
      const link = e.target.closest(".wikilink, a[href]");
      if (link) e.preventDefault();
    });
    // The typed cells count; without wasm the cell texts go out as they are (the Excel export and the chart).
    const cellRows = (): XlsxCell[][] => {
      const src = merged();
      const table = evaluateTable(src.join("\n"));
      return table
        ? Array.from({ length: table.rows }, (_, r) => Array.from({ length: table.cols }, (_, c) => table.cell(r, c)))
        : [src[0], ...src.slice(2)].map((line) => cellSpans(line).map((c): XlsxCell => ({ kind: c.text ? "text" : "empty", text: c.text })));
    };
    // Export to Excel.
    const xlsx = iconButton("file-spreadsheet", "Pobierz jako plik Excel (.xlsx)", "cm-lp-table-export");
    xlsx.addEventListener("mousedown", (e) => e.preventDefault()); // the cell being typed in keeps its caret
    xlsx.addEventListener("click", () => {
      download("Tabela.xlsx", xlsxBytes(cellRows()), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
    // A chart block after the table, linked to it: it shows the first numeric column and follows the table.
    const chart = iconButton("chart-column", "Wstaw wykres z tej tabeli", "cm-lp-table-export");
    chart.addEventListener("mousedown", (e) => e.preventDefault());
    chart.addEventListener("click", () => {
      const rows = cellRows();
      if (numericHeaders(rows).length === 0) return toast("Tabela nie ma kolumny z liczbami.");
      insertChartBlock(view, view.posAtDOM(el) + this.md.length, { type: "bar", title: "", points: [], skipped: 0, source: { column: null } });
    });
    corner.append(xlsx, chart);
    return el;
  }
}

const chartKey = (r: ResolvedChart): string => JSON.stringify([r.error, r.chart.type, r.chart.title, r.chart.points]);

// A chart block with the caret away: the chart itself. A click, or Enter on it, opens the edit dialog.
class ChartWidget extends WidgetType {
  constructor(readonly md: string, readonly resolved: ResolvedChart) {
    super();
  }

  // the block's length is in the text, so it must match too; a linked chart redraws only when its data changes
  eq(o: ChartWidget): boolean {
    return o.md === this.md && chartKey(o.resolved) === chartKey(this.resolved);
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-lp-chart";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Edytuj wykres");
    const edit = iconButton("pencil", "Edytuj wykres", "cm-lp-table-export cm-lp-chart-edit");
    edit.tabIndex = -1; // the chart itself is the stop
    el.append(chartBox(this.resolved.chart, this.resolved.error), edit);
    const open = () => {
      const from = view.posAtDOM(el);
      openChartDialog(view, from, from + this.md.length);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      open();
    });
    return el;
  }

  // The chart is not text: a click must not move the caret.
  ignoreEvent(): boolean {
    return true;
  }
}

const htmlCache = new Map<string, string>();

// null while wasm is not ready: the table then stays as source. Not cached, so it renders once wasm is up.
function tableHtml(md: string): string | null {
  const hit = htmlCache.get(md);
  if (hit !== undefined) return hit;
  const html = renderHtml(md);
  if (html === null) return null;
  if (htmlCache.size >= CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value!);
  htmlCache.set(md, html);
  return html;
}

// Block widgets must come from a StateField, so tables live in one. Only top-level tables, the caret's table stays raw.
function tableBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== "Table") continue;
    if (state.selection.ranges.some((r) => r.from <= n.to && r.to >= n.from)) continue;
    const html = tableHtml(state.sliceDoc(n.from, n.to));
    if (html !== null) out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(n.from, n.to), html), block: true }).range(n.from, n.to));
  }
  return Decoration.set(out, true);
}

// Whether a tree has a table in [from, to]. Lezer's iterate only enters nodes that overlap the range.
function touchesTable(tree: ReturnType<typeof syntaxTree>, from: number, to: number): boolean {
  let hit = false;
  tree.iterate({ from, to, enter: (n) => { if (n.name === "Table") hit = true; return !hit; } });
  return hit;
}

// A typed edit can move a table only if it touches a table (before or after) or adds or removes a `|`: a delimiter row needs one.
function tableEditRisky(tr: Transaction): boolean {
  const before = syntaxTree(tr.startState);
  const after = syntaxTree(tr.state);
  let risky = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    risky ||= inserted.toString().includes("|") || tr.startState.sliceDoc(fromA, toA).includes("|")
      || touchesTable(before, fromA, toA) || touchesTable(after, fromB, toB);
  });
  return risky;
}

// A plain edit keeps the table decorations, mapped through the change; a table edit, a selection move or a parse
// that finished without an edit rescans. shortcut: a parse that changes a far table during typing is caught on the next non-typing update.
const tableBlocksField = StateField.define<DecorationSet>({
  create: (state) => tableBlocks(state),
  update: (value, tr) => {
    if (tr.selection || (tr.docChanged ? tableEditRisky(tr) : syntaxTree(tr.state) !== syntaxTree(tr.startState))) return tableBlocks(tr.state);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The caret's line is always raw Markdown, so markers there are not decorated.
function onCursorLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

// Visible lines plus the caret line (it may be scrolled out of view).
function spans(view: EditorView): { from: number; to: number }[] {
  const out = view.visibleRanges.map((r) => ({ from: r.from, to: r.to }));
  const head = view.state.doc.lineAt(view.state.selection.main.head);
  if (!out.some((r) => r.from <= head.from && head.to <= r.to)) out.push({ from: head.from, to: head.to });
  return out;
}

// After a heading's `#` or a quote's `>`, the space is hidden too.
function spaceEnd(state: EditorState, to: number): number {
  return state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
}

// Chart blocks at the top level, from a StateField like tables: the chart shows while the caret is away from it.
function chartBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  let note: string | null = null; // read only when a chart shows, so a note without charts costs nothing here
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== "FencedCode") continue;
    const info = n.getChild("CodeInfo");
    if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "wykres") continue;
    if (state.selection.ranges.some((r) => r.from <= n.to && r.to >= n.from)) continue;
    note ??= state.doc.toString();
    const widget = new ChartWidget(state.sliceDoc(n.from, n.to), resolveChart(note, n.from, n.to));
    out.push(Decoration.replace({ widget, block: true }).range(n.from, n.to));
  }
  return Decoration.set(out, true);
}

const chartBlocksField = StateField.define<DecorationSet>({
  create: (state) => chartBlocks(state),
  update: (value, tr) => (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? chartBlocks(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

// A diagram block with the caret away: the diagram itself. A click, or Enter on it, opens the edit dialog.
class DiagramWidget extends WidgetType {
  constructor(readonly md: string, readonly diagram: Diagram) {
    super();
  }

  // the diagram is the block's text alone, so the text is the whole comparison
  eq(o: DiagramWidget): boolean {
    return o.md === this.md;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-lp-diagram";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Edytuj schemat");
    const edit = iconButton("pencil", "Edytuj schemat", "cm-lp-table-export cm-lp-diagram-edit");
    edit.tabIndex = -1; // the diagram itself is the stop
    el.append(diagramBox(this.diagram), edit);
    const open = () => {
      const from = view.posAtDOM(el);
      openDiagramDialog(view, from, from + this.md.length);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      open();
    });
    return el;
  }

  // The diagram is not text: a click must not move the caret.
  ignoreEvent(): boolean {
    return true;
  }
}

// Diagram blocks at the top level, from a StateField like charts: the diagram shows while the caret is away from it.
function diagramBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== "FencedCode") continue;
    const info = n.getChild("CodeInfo");
    if (!info || !isDiagramInfo(state.sliceDoc(info.from, info.to))) continue;
    if (state.selection.ranges.some((r) => r.from <= n.to && r.to >= n.from)) continue;
    const md = state.sliceDoc(n.from, n.to);
    const widget = new DiagramWidget(md, parseDiagram(diagramBody(md)));
    out.push(Decoration.replace({ widget, block: true }).range(n.from, n.to));
  }
  return Decoration.set(out, true);
}

const diagramBlocksField = StateField.define<DecorationSet>({
  create: (state) => diagramBlocks(state),
  update: (value, tr) => (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? diagramBlocks(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const out: Range<Decoration>[] = [];
  const seen = new Set<string>(); // a node that crosses two spans is visited once
  // A folder the caret is outside of is one card (folderCardsField): nothing inside it is decorated here.
  const folded = foldedFolders(state);
  const inFolded = (from: number, to = from): boolean => folded.some((f) => from >= f.from && to <= f.to);
  const tables: { from: number; to: number }[] = [];
  const code: { from: number; to: number }[] = [];
  const hide = (from: number, to: number) => {
    if (to > from) out.push(HIDDEN.range(from, to));
  };

  const link = (from: number, to: number, href: string) => {
    if (to > from) out.push(Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } }).range(from, to));
  };

  // One box per callout: every line of the quote gets the box, the head line gets its title widget.
  const quote = (from: number, to: number) => {
    if (inFolded(from, to)) return; // a subfolder inside a folder that is a card
    const head = doc.lineAt(from);
    if (FOLDER_HEAD.test(head.text)) {
      // a folder with the caret outside it is the card; with the caret inside, its raw lines get the box
      if (folded.some((f) => f.from === head.from)) return;
      for (let ln = head.number; ln <= doc.lineAt(to).number; ln++) {
        out.push(Decoration.line({ class: "cm-lp-quote cm-lp-callout cm-lp-callout-pliki" }).range(doc.line(ln).from));
      }
      return;
    }
    const m = CALLOUT.exec(head.text);
    const type = m?.[1].toLowerCase();
    const cls = type ? `cm-lp-quote cm-lp-callout cm-lp-callout-${type}` : "cm-lp-quote";
    for (let ln = head.number; ln <= doc.lineAt(to).number; ln++) {
      out.push(Decoration.line({ class: cls }).range(doc.line(ln).from));
    }
    if (m && type && !onCursorLine(state, head.from)) {
      out.push(Decoration.replace({ widget: new CalloutWidget(type, m[2].trim()) }).range(head.from, head.to));
    }
  };

  const visit = (n: NodeRef): boolean | void => {
    const key = `${n.name}:${n.from}:${n.to}`;
    // A node that crosses two spans is decorated once; its children may still be new to the second span.
    if (seen.has(key)) return ["Table", "FencedCode", "CodeBlock"].includes(n.name) ? false : undefined;
    seen.add(key);
    if (n.name !== "Blockquote" && inFolded(n.from, n.to)) return false;
    const raw = onCursorLine(state, n.from);
    const parent = n.node.parent;
    switch (n.name) {
      case "Table":
        tables.push({ from: n.from, to: n.to });
        return false; // cells keep their raw Markdown; the block widget covers the table when the caret leaves
      case "FencedCode":
      case "CodeBlock":
        code.push({ from: n.from, to: n.to });
        return false; // code keeps its text verbatim, so nothing inside is decorated
      case "HeaderMark":
        if (parent?.name.startsWith("ATXHeading") && !raw) hide(n.from, spaceEnd(state, n.to));
        return;
      case "EmphasisMark":
      case "StrikethroughMark":
        if (!raw) hide(n.from, n.to);
        return;
      case "CodeMark":
        if (parent?.name === "InlineCode" && !raw) hide(n.from, n.to);
        return;
      case "InlineCode":
        code.push({ from: n.from, to: n.to });
        out.push(CODE.range(n.from, n.to));
        return;
      case "QuoteMark":
        // A callout head line is replaced as a whole, so its `>` is not hidden separately.
        if (!raw && !CALLOUT.test(doc.lineAt(n.from).text) && !FOLDER_HEAD.test(doc.lineAt(n.from).text)) hide(n.from, spaceEnd(state, n.to));
        return;
      case "ListMark": {
        // A task item shows its checkbox instead of a bullet, so its `-` and the space after it go too.
        const task = /^\s+\[[ xX]\]/.test(doc.sliceString(n.to, n.to + 6));
        if (parent?.name === "ListItem" && parent.parent?.name === "BulletList" && !raw) {
          if (task) hide(n.from, spaceEnd(state, n.to));
          else out.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to));
        }
        return;
      }
      case "TaskMarker":
        if (!raw) {
          const checked = /x/i.test(doc.sliceString(n.from, n.to));
          out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(n.from, n.to));
        }
        return;
      case "HorizontalRule":
        if (!raw) out.push(Decoration.replace({ widget: new RuleWidget() }).range(n.from, n.to));
        return;
      case "Link": {
        const marks = n.node.getChildren("LinkMark");
        if (marks.length < 2 || doc.sliceString(n.from, n.from + 2) === "[[") return;
        const [open, close] = marks;
        const url = n.node.getChild("URL");
        if (!raw) {
          hide(n.from, open.to);
          hide(close.from, n.to);
        }
        link(open.to, close.from, url ? doc.sliceString(url.from, url.to) : "");
        return;
      }
      case "LinkMark":
        // `<https://…>`: the angle brackets go, the address is shown short by its own URL node.
        if (parent?.name === "Autolink" && !raw && WEB_URL.test(doc.sliceString(parent.from + 1, parent.to - 1))) hide(n.from, n.to);
        return;
      case "URL": {
        // A Markdown link's address is its name's href; a bare web address is shown short off the caret line.
        const url = doc.sliceString(n.from, n.to);
        if (!raw && WEB_URL.test(url) && parent?.name !== "Link" && parent?.name !== "Image") {
          out.push(Decoration.replace({ widget: new LinkWidget(url) }).range(n.from, n.to));
        }
        return;
      }
      case "Blockquote":
        quote(n.from, n.to);
        return;
    }
  };

  const ranges = spans(view);
  const tree = syntaxTree(state);
  for (const r of ranges) tree.iterate({ from: r.from, to: r.to, enter: visit });

  // Wikilinks and ==highlights== are plain text to the parser, so they are matched per line.
  const inTable = (pos: number) => tables.some((t) => t.from <= pos && pos <= t.to);
  const inCode = (from: number, to: number) => code.some((c) => c.from < to && from < c.to);
  for (const r of ranges) {
    for (let ln = doc.lineAt(r.from).number; ln <= doc.lineAt(r.to).number; ln++) {
      const line = doc.line(ln);
      if (onCursorLine(state, line.from) || inTable(line.from) || inFolded(line.from)) continue;
      for (const m of line.text.matchAll(WIKILINK)) {
        const start = line.from + (m.index ?? 0);
        const end = start + m[0].length;
        if (inCode(start, end)) continue;
        const shown = m[2] ?? m[1];
        const shownFrom = m[2] === undefined ? start + 2 : start + 3 + m[1].length;
        hide(start, shownFrom);
        hide(shownFrom + shown.length, end);
        out.push(
          Decoration.mark({ class: "cm-lp-wikilink", attributes: { "data-target": m[1] } }).range(
            shownFrom,
            shownFrom + shown.length,
          ),
        );
      }
      for (const m of line.text.matchAll(HIGHLIGHT)) {
        const start = line.from + (m.index ?? 0);
        const end = start + m[0].length;
        if (inCode(start, end)) continue;
        hide(start, start + 2);
        hide(end - 2, end);
        out.push(MARK.range(start + 2, end - 2));
      }
    }
  }
  const frontEnd = frontMatterEnd(doc);
  for (const r of ranges) {
    for (let ln = doc.lineAt(r.from).number; ln <= doc.lineAt(r.to).number; ln++) {
      const line = doc.line(ln);
      if (ln <= frontEnd || inTable(line.from) || inFolded(line.from)) continue;
      for (const m of line.text.matchAll(SHORT_PAIR)) {
        const from = line.from + (m.index ?? 0);
        if (!inCode(from, from + m[1].length)) out.push(NOWRAP.range(from, from + m[1].length));
      }
    }
  }
  return Decoration.set(out, true);
}

const livePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = build(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// Ctrl/Cmd+click follows a link. It is handled on mousedown: CodeMirror moves the caret there, so Chrome never sends click.
const links = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    const el = e.target instanceof Element ? e.target.closest(LINK) : null;
    if (!el) return false;
    e.preventDefault();
    return openLink(el, view.state.facet(linkHandler));
  },
});

// Pasting a web address over selected text makes it a Markdown link: `[selected](address)`. Files go to attachments.
export const linkPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    const url = data?.getData("text/plain").trim() ?? "";
    if (!/^https?:\/\/[^\s()]+$/i.test(url) || (data?.files.length ?? 0) > 0) return false;
    const sel = view.state.selection.main;
    const name = view.state.sliceDoc(sel.from, sel.to);
    if (sel.empty || /[[\]\n]/.test(name)) return false;
    event.preventDefault();
    const insert = `[${name}](${url})`;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.paste" });
    return true;
  },
});

/** Live Preview: Markdown markers show only on the caret's line. editor.ts puts this in a Compartment. */
export function livePreview(): Extension[] {
  return [livePlugin, tableBlocksField, chartBlocksField, diagramBlocksField, folderCardsField, links];
}
