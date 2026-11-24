// CSV and TSV as a grid (RFC 4180). The parser works on a string, so file contents reach the DOM only as text.
import { createGrid } from "../grid";
import { decodeText } from "../textdecode";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PARSED_ROWS = 100_000;
const SHOWN_ROWS = 2000;
const GUESS_LINES = 20;
const DELIMITERS = [";", ",", "\t", "|"];
const NUMBER = /^-?[\d\s]+([.,]\d+)?$/;

/** RFC 4180: quoted fields with delimiters and line breaks, "" for a quote, CRLF or LF. */
export function parseCsv(text: string, delimiter: string, maxRows: number): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let open = false; // the current row has started
  let inQuotes = false;
  let more = false;

  // false when the row limit is reached: the row is left out and `more` says there were rows after the limit
  const endRow = (): boolean => {
    if (rows.length >= maxRows) {
      more = true;
      return false;
    }
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    open = false;
    return true;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
      i++;
    } else if (ch === '"' && field === "") {
      inQuotes = true;
      open = true;
      i++;
    } else if (text.startsWith(delimiter, i)) {
      row.push(field);
      field = "";
      open = true;
      i += delimiter.length;
    } else if (ch === "\r" || ch === "\n") {
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      // an empty line at the very end is not a row
      if (!open && i >= text.length) break;
      if (!endRow()) break;
    } else {
      field += ch;
      open = true;
      i++;
    }
  }
  if (open) endRow();
  return { rows, more };
}

/** The delimiter that splits the first lines most often, outside quotes. A .tsv file is always tab-separated. */
export function guessDelimiter(text: string, name: string): string {
  if (/\.tsv$/i.test(name)) return "\t";
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let lines = 0;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "\n" && !inQuotes) {
      lines++;
      if (lines === GUESS_LINES) break;
    } else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export function createCsvViewer(): Viewer {
  let root: HTMLElement | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      if (bytes.byteLength > MAX_BYTES) throw new PreviewError("too-large");
      const { text } = decodeText(new Uint8Array(bytes), bytes.byteLength);
      const { rows, more } = parseCsv(text, guessDelimiter(text, ctx.name), MAX_PARSED_ROWS);
      if (ctx.signal.aborted) return;

      let widest = 0;
      for (const r of rows) widest = Math.max(widest, r.length);
      const count = more ? `ponad ${fmt(rows.length)}` : fmt(rows.length);

      const frame = document.createElement("div");
      frame.className = "r r-csv";
      frame.append(
        createGrid(rows, {
          maxRows: SHOWN_ROWS,
          align: (r, c) => (NUMBER.test(rows[r][c] ?? "") ? "right" : "left"),
        }),
      );
      if (rows.length > SHOWN_ROWS) {
        const note = document.createElement("div");
        note.className = "siatka-uwaga";
        note.textContent = `Pokazano ${fmt(SHOWN_ROWS)} z ${count} wierszy.`;
        frame.append(note);
      }
      ctx.host.append(frame);
      root = frame;
      ctx.status(`Wierszy: ${count}, kolumn: ${fmt(widest)}`);
    },

    dispose(): void {
      root?.remove();
      root = null;
    },
  };
}

function fmt(n: number): string {
  return n.toLocaleString("pl-PL");
}
