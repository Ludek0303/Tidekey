// Spreadsheets (XLSX, XLS, XLSB, ODS): one grid per sheet and a tab for each (PODGLAD-PLAN §5). SheetJS CE reads the file
// and gives each value as Excel shows it. Formulas are not calculated again: the saved results are shown.
import * as XLSX from "xlsx";
import { createGrid } from "../grid";
import { guardZip } from "../zipindex";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

export const MAX_ROWS = 2000;
export const MAX_COLS = 200;
const MAX_SHEETS = 100;
// shortcut: one budget for all shown cells, so many large sheets cannot exhaust the frame's memory; upgrade to a lazy read per sheet when such workbooks show up
const MAX_CELLS = 2_000_000;
const ZIP_MAGIC = [0x50, 0x4b]; // "PK": XLSX, XLSB and ODS are ZIP files
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // XLS is an OLE2 container

export interface SheetData {
  name: string;
  rows: string[][];
  merges: { r: number; c: number; rows: number; cols: number }[];
  numeric: boolean[][];
  rowCount: number;
  colCount: number;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

/** The text of a cell as Excel shows it: the formatted value when SheetJS has one, else the format applied here. */
function cellText(cell: XLSX.CellObject): string {
  if (cell.w !== undefined) return cell.w;
  if (cell.t === "e") return XLSX.utils.format_cell(cell);
  try {
    return XLSX.SSF.format(cell.z ?? "General", cell.v);
  } catch {
    return String(cell.v ?? "");
  }
}

function sheetData(name: string, ws: XLSX.WorkSheet): SheetData {
  // with sheetRows, !ref stops at the rows read and !fullref keeps the whole range of the sheet
  const ref = ws["!fullref"] ?? ws["!ref"];
  if (!ref) return { name, rows: [], merges: [], numeric: [], rowCount: 0, colCount: 0 };
  // counted from A1, as Excel shows the grid, so the count is the whole range
  const end = XLSX.utils.decode_range(ref).e;
  const rowCount = end.r + 1;
  const colCount = end.c + 1;
  const shownRows = Math.min(rowCount, MAX_ROWS);
  const shownCols = Math.min(colCount, MAX_COLS);

  const cells: (XLSX.CellObject | undefined)[][] = ws["!data"] ?? [];
  const rows: string[][] = [];
  const numeric: boolean[][] = [];
  for (let r = 0; r < shownRows; r++) {
    const line: string[] = [];
    const flags: boolean[] = [];
    for (let c = 0; c < shownCols; c++) {
      const cell = cells[r]?.[c];
      line.push(cell ? cellText(cell) : "");
      flags.push(cell?.t === "n");
    }
    rows.push(line);
    numeric.push(flags);
  }

  // a merge is cut to the shown range; one that starts outside it is left out
  const merges: SheetData["merges"] = [];
  for (const m of ws["!merges"] ?? []) {
    if (m.s.r >= shownRows || m.s.c >= shownCols) continue;
    merges.push({
      r: m.s.r,
      c: m.s.c,
      rows: Math.min(m.e.r, shownRows - 1) - m.s.r + 1,
      cols: Math.min(m.e.c, shownCols - 1) - m.s.c + 1,
    });
  }
  return { name, rows, merges, numeric, rowCount, colCount };
}

/** Every visible sheet of the file (at most MAX_SHEETS), with its shown cells. A damaged file is "corrupt", an encrypted one "unsupported". */
export function readSheets(bytes: Uint8Array): SheetData[] {
  if (startsWith(bytes, ZIP_MAGIC)) guardZip(bytes);
  else if (!startsWith(bytes, OLE_MAGIC)) throw new PreviewError("corrupt");

  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, {
      type: "array",
      dense: true,
      cellNF: true,
      cellDates: false,
      cellStyles: false,
      cellHTML: false,
      sheetRows: MAX_ROWS + 1,
      bookVBA: false,
      bookFiles: false,
      WTF: false,
    });
  } catch (err) {
    if (err instanceof Error && /password/i.test(err.message)) throw new PreviewError("unsupported");
    throw new PreviewError("corrupt");
  }

  const props = book.Workbook?.Sheets ?? [];
  const sheets: SheetData[] = [];
  let cells = 0;
  for (let i = 0; i < book.SheetNames.length && sheets.length < MAX_SHEETS; i++) {
    if (props[i]?.Hidden) continue;
    const name = book.SheetNames[i];
    const data = sheetData(name, book.Sheets[name]);
    cells += data.rows.length * Math.min(data.colCount, MAX_COLS);
    if (cells > MAX_CELLS) throw new PreviewError("too-large");
    sheets.push(data);
  }
  return sheets;
}

function fmt(n: number): string {
  return n.toLocaleString("pl-PL");
}

function sheetNote(s: SheetData): string {
  const parts: string[] = [];
  if (s.rowCount > s.rows.length) parts.push(`Pokazano ${fmt(s.rows.length)} z ${fmt(s.rowCount)} wierszy.`);
  const shownCols = Math.min(s.colCount, MAX_COLS);
  if (s.colCount > shownCols) parts.push(`Pokazano ${fmt(shownCols)} z ${fmt(s.colCount)} kolumn.`);
  return parts.join(" ");
}

export function createSheetViewer(): Viewer {
  let root: HTMLElement | null = null;
  let sheets: SheetData[] = [];
  let tabs: HTMLButtonElement[] = [];
  let current = 0;
  let view: ((i: number) => void) | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      sheets = readSheets(new Uint8Array(bytes));
      if (ctx.signal.aborted) return;

      const frame = document.createElement("div");
      frame.className = "r r-arkusz";
      root = frame;
      ctx.host.append(frame);

      if (sheets.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tekst-pusty";
        empty.textContent = "Brak widocznych arkuszy.";
        frame.append(empty);
        return;
      }

      const bar = document.createElement("div");
      bar.className = "zakladki";
      bar.setAttribute("role", "tablist");
      bar.setAttribute("aria-label", "Arkusze");
      tabs = sheets.map((s, i) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.textContent = s.name;
        tab.addEventListener("click", () => show(i));
        return tab;
      });
      bar.append(...tabs);

      const show = (i: number): void => {
        current = i;
        const s = sheets[i];
        tabs.forEach((t, k) => t.setAttribute("aria-selected", String(k === i)));
        tabs[i].scrollIntoView?.({ block: "nearest", inline: "nearest" });
        const grid = createGrid(s.rows, {
          merges: s.merges,
          align: (r, c) => (s.numeric[r]?.[c] ? "right" : "left"),
        });
        const note = sheetNote(s);
        const parts: Node[] = [grid];
        if (note) {
          const uwaga = document.createElement("div");
          uwaga.className = "siatka-uwaga";
          uwaga.textContent = note;
          parts.push(uwaga);
        }
        frame.replaceChildren(...parts, bar);
        ctx.status(`Arkusz: ${s.name}, wierszy: ${fmt(s.rowCount)}`);
      };
      view = show;
      show(0);
    },

    key(e: KeyboardEvent): boolean {
      // Ctrl+PageUp/PageDown move between sheets; the arrows belong to the app (the next file)
      if (!e.ctrlKey || e.altKey || (e.key !== "PageDown" && e.key !== "PageUp")) return false;
      const next = Math.min(sheets.length - 1, Math.max(0, current + (e.key === "PageDown" ? 1 : -1)));
      if (sheets.length && next !== current) view?.(next);
      return true;
    },

    dispose(): void {
      root?.remove();
      root = null;
      sheets = [];
      tabs = [];
      view = null;
    },
  };
}
