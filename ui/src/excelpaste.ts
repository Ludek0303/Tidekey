import { EditorView } from "@codemirror/view";
import { colName, rowOf, tableAt } from "./table";
import { fencedLines } from "./taskchips";

/** Parses clipboard TSV (quotes as Excel writes them: `""` is one quote, a quoted cell may hold tabs and line breaks). */
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") { row.push(cell); cell = ""; }
    else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  // one trailing empty line (a clipboard ends with a line break) is not a row
  if (rows.length > 1 && rows[rows.length - 1].join("") === "" && rows[rows.length - 1].length === 1) rows.pop();
  return rows;
}

/**
 * A Markdown table from spreadsheet cells, or null for anything else (plain text with no tab is left to the normal
 * paste). The first row is the header; an empty header row gets column letters.
 */
export function tsvToTable(text: string, fromSheet = false): string | null {
  const rows = parseTsv(text);
  // without a spreadsheet's HTML table on the clipboard, only a clear grid converts: 2+ rows, the same 2+ cells in each
  // (text with a stray tab, or indented code, stays text)
  const grid = rows.length > 1 && rows[0].length > 1 && rows.every((r) => r.length === rows[0].length);
  if (!(fromSheet ? rows.some((r) => r.length > 1) : grid)) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const cellText = (c: string) => c.trim().replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const padded = rows.map((r) => Array.from({ length: width }, (_, i) => cellText(r[i] ?? "")));
  const header = padded[0].every((c) => c === "") ? Array.from({ length: width }, (_, i) => colName(i)) : padded[0];
  return [rowOf(header), rowOf(Array.from({ length: width }, () => "---")), ...padded.slice(1).map(rowOf)].join("\n");
}

// Spreadsheet cells paste as a Markdown table. Not inside a code block or a table, where the text is kept as it is.
export const excelPaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return false;
    const table = tsvToTable(event.clipboardData?.getData("text/plain") ?? "", /<table/i.test(event.clipboardData?.getData("text/html") ?? ""));
    if (table === null) return false;
    const { state } = view;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.from);
    if (fencedLines(state.doc).has(line.number) || tableAt(state, sel.from)) return false;
    event.preventDefault();
    // Text left on the caret's line decides the blank lines: the table starts and ends on its own paragraph.
    const end = state.doc.lineAt(sel.to);
    const before = state.sliceDoc(line.from, sel.from);
    const after = state.sliceDoc(sel.to, end.to);
    const prev = line.number > 1 ? state.doc.line(line.number - 1).text : "";
    const next = end.number < state.doc.lines ? state.doc.line(end.number + 1).text : "";
    const lead = before !== "" ? "\n\n" : prev !== "" ? "\n" : "";
    const tail = after !== "" ? "\n\n" : next !== "" ? "\n" : "";
    const insert = lead + table + tail;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + lead.length + table.length },
      userEvent: "input.paste",
    });
    return true;
  },
});
