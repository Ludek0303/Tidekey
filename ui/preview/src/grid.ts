// A table grid for the preview: column letters across the top, row numbers down the side, both sticky.
// Cell text always goes in through textContent, so file contents never become markup.

const DEFAULT_MAX_ROWS = 2000;
const DEFAULT_MAX_COLS = 200;

export interface GridOptions {
  maxRows?: number;
  maxCols?: number;
  merges?: { r: number; c: number; rows: number; cols: number }[];
  /** Cell alignment: numbers go to the right. */
  align?(r: number, c: number): "left" | "right" | "center";
  bold?(r: number, c: number): boolean;
}

/** 0 → "A", 25 → "Z", 26 → "AA" (the column letters of a spreadsheet). */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function createGrid(rows: readonly (readonly string[])[], options: GridOptions = {}): HTMLElement {
  const shownRows = Math.min(rows.length, options.maxRows ?? DEFAULT_MAX_ROWS);
  let widest = 0;
  for (let r = 0; r < shownRows; r++) widest = Math.max(widest, rows[r].length);
  const shownCols = Math.min(widest, options.maxCols ?? DEFAULT_MAX_COLS);

  const key = (r: number, c: number): string => `${r},${c}`;
  const origins = new Map<string, { rows: number; cols: number }>();
  const covered = new Set<string>();
  for (const m of options.merges ?? []) {
    if (m.r >= shownRows || m.c >= shownCols) continue;
    const rowSpan = Math.min(m.rows, shownRows - m.r);
    const colSpan = Math.min(m.cols, shownCols - m.c);
    origins.set(key(m.r, m.c), { rows: rowSpan, cols: colSpan });
    for (let dr = 0; dr < rowSpan; dr++) {
      for (let dc = 0; dc < colSpan; dc++) {
        if (dr || dc) covered.add(key(m.r + dr, m.c + dc));
      }
    }
  }

  const table = document.createElement("table");
  const head = document.createElement("tr");
  head.append(headerCell("w", ""));
  for (let c = 0; c < shownCols; c++) head.append(headerCell("", columnName(c)));
  const thead = document.createElement("thead");
  thead.append(head);

  const body = document.createElement("tbody");
  for (let r = 0; r < shownRows; r++) {
    const tr = document.createElement("tr");
    tr.append(headerCell("w", String(r + 1)));
    for (let c = 0; c < shownCols; c++) {
      if (covered.has(key(r, c))) continue;
      const td = document.createElement("td");
      const origin = origins.get(key(r, c));
      if (origin && origin.rows > 1) td.rowSpan = origin.rows;
      if (origin && origin.cols > 1) td.colSpan = origin.cols;
      const text = rows[r][c] ?? "";
      if (options.bold?.(r, c)) {
        const b = document.createElement("b");
        b.textContent = text;
        td.append(b);
      } else {
        td.textContent = text;
      }
      const align = options.align?.(r, c);
      if (align === "right") td.className = "n";
      else if (align === "center") td.className = "s";
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(thead, body);

  const wrap = document.createElement("div");
  wrap.className = "siatka";
  wrap.append(table);
  return wrap;
}

function headerCell(className: string, text: string): HTMLTableCellElement {
  const th = document.createElement("th");
  if (className) th.className = className;
  th.textContent = text;
  return th;
}
