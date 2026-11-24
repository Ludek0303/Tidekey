import init, { evaluate_markdown_table, render_markdown_html } from "./wasm/notes_web.js";

export type CellKind = "empty" | "number" | "text" | "bool" | "date" | "error";

export interface Cell {
  text: string;
  kind: CellKind;
  isFormula: boolean;
}

export interface Table {
  rows: number;
  cols: number;
  cell(r: number, c: number): Cell;
}

// Index matches the kind codes returned by crates/web.
const KINDS: CellKind[] = ["empty", "number", "text", "bool", "date", "error"];
const EMPTY: Cell = { text: "", kind: "empty", isFormula: false };
const DAY_MS = 86_400_000;

let loaded: Promise<unknown> | null = null;
let ready = false;

export async function initFormula(): Promise<void> {
  // forget a failed load so the next call can retry (e.g. after a network hiccup)
  loaded ??= init().catch((e: unknown) => {
    loaded = null;
    throw e;
  });
  await loaded;
  ready = true;
}

/** False until `initFormula()` has succeeded; formulas are then shown as plain text. */
export function formulasReady(): boolean {
  return ready;
}

/** Days since 1970-01-01 of the local calendar date of `d`. */
function localDays(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** `null` if `md` is not a GFM table, or if `initFormula()` has not succeeded (formulas are then off). */
export function evaluateTable(md: string, today: Date = new Date()): Table | null {
  if (!ready) return null;
  const wasm = evaluate_markdown_table(md, localDays(today));
  if (!wasm) return null;
  try {
    const rows = wasm.rows();
    const cols = wasm.cols();
    const cells: Cell[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          text: wasm.text(r, c),
          kind: KINDS[wasm.kind(r, c)] ?? "empty",
          isFormula: wasm.is_formula(r, c),
        });
      }
    }
    return {
      rows,
      cols,
      cell: (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols ? cells[r * cols + c] : EMPTY),
    };
  } finally {
    wasm.free();
  }
}

/** Reading-view HTML of `md` (escaped by the core). `null` if wasm is not ready or rendering fails. */
export function renderHtml(md: string, today: Date = new Date()): string | null {
  if (!ready) return null;
  try {
    return render_markdown_html(md, localDays(today));
  } catch {
    return null;
  }
}
