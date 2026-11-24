//! Checkbox cells of Markdown tables: `[ ]` or `[x]` at the start of a cell, with `@osoba` (who has to tick it) and
//! `📅 YYYY-MM-DD` (its due date). A column header with `!zaznacza:@kto` tokens limits who may tick the column to those
//! people, to members of a group of that name, and to the owner and administrators. Without one, anyone who can edit
//! the note may tick. The live preview ticks the boxes, the note index feeds the "do zrobienia" notifications.

import { EditorState, Text } from "@codemirror/state";
import { fencedLines } from "./taskchips";
import { cellSpans as tableCellSpans } from "./table";

export interface TableCheckItem {
  /** 1-based line of the row in the note. */
  line: number;
  /** 0-based column of the cell. */
  column: number;
  /** Offset of the box's `[` in its line. */
  at: number;
  checked: boolean;
  /** The header text of the column, without `!zaznacza` tokens. */
  header: string;
  /** The first cell of the row, without tokens. */
  rowLabel: string;
  /** The names after `@` in the cell. */
  people: string[];
  /** `YYYY-MM-DD` after `📅`, when the cell has one. */
  due?: string;
  /** The names after `!zaznacza:` in the column header; empty when there are none. */
  checkers: string[];
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BOX = /^\[([ xX])\]/;
const NAME = "[\\p{L}\\p{N}_.-]+";
const CHECKERS = new RegExp(`(?:^|\\s)!zaznacza:@?(${NAME})`, "gu");
const MENTION = new RegExp(`(?:^|\\s)@(${NAME})`, "gu");
const DUE = /📅\s*(\d{4}-\d{2}-\d{2})/u;

/** The cells of a table row with the offset of each one's text (trimmed); escaped pipes stay inside a cell. */
export function cellSpans(line: string): { from: number; text: string }[] {
  return tableCellSpans(line, 0).map((s) => ({ from: s.from, text: line.slice(s.from, s.to) }));
}

/** The names a header cell allows to tick its column. */
export function checkersOf(header: string): string[] {
  return [...header.matchAll(CHECKERS)].map((m) => m[1]);
}

const TOKENS = new RegExp(`(?:^|\\s)(?:!zaznacza:\\S+|@${NAME})`, "gu");

// The text a reader sees: the box, the tokens and the due date left out.
const plain = (text: string): string => text.replace(BOX, " ").replace(TOKENS, " ").replace(DUE, " ").replace(/\s+/g, " ").trim();

/** The table checkbox items of a note's text, in document order. Fenced code and separator rows are not tables. */
export function parseTableChecks(text: string): TableCheckItem[] {
  const lines = text.split("\n");
  const code = fencedLines(Text.of(lines));
  const out: TableCheckItem[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    // header line, then a separator line; the body rows follow until a line without a pipe or a blank one
    if (code.has(i + 1) || !lines[i].includes("|") || !SEPARATOR.test(lines[i + 1]) || code.has(i + 2)) continue;
    const headers = cellSpans(lines[i]);
    let j = i + 2;
    for (; j < lines.length && lines[j].includes("|") && lines[j].trim() !== "" && !code.has(j + 1); j++) {
      const cells = cellSpans(lines[j]);
      const rowLabel = cells[0] ? plain(cells[0].text) : "";
      cells.forEach((cell, column) => {
        const box = BOX.exec(cell.text);
        if (!box) return;
        out.push({
          line: j + 1,
          column,
          at: cell.from,
          checked: box[1] !== " ",
          header: plain(headers[column]?.text ?? ""),
          rowLabel,
          people: [...cell.text.matchAll(MENTION)].map((m) => m[1]),
          due: DUE.exec(cell.text)?.[1],
          checkers: checkersOf(headers[column]?.text ?? ""),
        });
      });
    }
    i = j - 1;
  }
  return out;
}

let access: ((checkers: string[]) => boolean) | null = null;

/** Set by the organization views: whether the current user may tick a column with these names. null lets everyone. */
export function setTableCheckAccess(fn: ((checkers: string[]) => boolean) | null): void {
  access = fn;
}

/** Whether the current user may tick a box of a column with these checkers. */
export function mayTick(checkers: string[]): boolean {
  // shortcut: the column rule is enforced by this app only. Someone who edits the raw text in another program can still
  // change a box; to stop that for good, restrict who may edit the note (Uprawnienia).
  return !access || checkers.length === 0 || access(checkers);
}

/**
 * Drops a typed change that alters the box of a column the user may not tick. A change that only rewrites the box
 * with the same mark (a whole-table replace, for one) passes, and remote or sync changes carry no user event.
 */
export const tableCheckGuard = EditorState.transactionFilter.of((tr) => {
  if (!access || !tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
  const doc = tr.startState.doc;
  // A box lives on a row with a pipe, so a change whose lines have none cannot alter one: skip the parse.
  let nearTable = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (let n = doc.lineAt(fromA).number; !nearTable && n <= doc.lineAt(toA).number; n++) nearTable = doc.line(n).text.includes("|");
  });
  if (!nearTable) return tr;
  const boxes = parseTableChecks(doc.toString())
    .filter((item) => !mayTick(item.checkers))
    .map((item) => {
      const from = doc.line(item.line).from + item.at;
      return { from, mark: doc.sliceString(from, from + 3) };
    });
  if (boxes.length === 0) return tr;
  let blocked = false;
  tr.changes.iterChanges((fromA, toA, fromB) => {
    for (const { from, mark } of boxes) {
      const overlaps = (fromA < from + 3 && toA > from) || (fromA === toA && fromA === from);
      if (!overlaps) continue;
      const shift = from - fromA;
      if (fromA <= from && toA >= from + 3 && tr.newDoc.sliceString(fromB + shift, fromB + shift + 3) === mark) continue;
      blocked = true;
    }
  });
  return blocked ? [] : tr;
});
