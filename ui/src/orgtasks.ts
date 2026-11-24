//! Tasks of an organization space: the rows of the core index (`tasks_json`), the token reader of a task line
//! (`task_line_tokens` in crates/web, the same reader the index uses) and the rules the views share. Edits rewrite
//! only the spans of the tokens they change. Days are days since 1970-01-01, as the index counts them.

import * as Y from "yjs";
import { task_line_tokens } from "./wasm/notes_web.js";
import { nameKey } from "./taskhistory";
import { DAY_MS, ymdOf } from "./calendar/dates";

export { DAY_MS };

export type Priority = "high" | "medium" | "low";

/** From `!przypomnij:2h/30mx3`: minutes before the due moment, the gap between repeats (null: once), and the count. */
export interface Reminder {
  before_min: number;
  every_min: number | null;
  count: number;
}

export interface TaskRow {
  assignee_user_ids?: string[];
  effective_assignees?: string[];
  group_ids?: string[];
  supervisor_user_id?: string | null;
  note: string;
  path: string;
  line: number;
  depth: number;
  done: boolean;
  text: string;
  assignees: string[];
  supervisor: string | null;
  difficulty: number | null;
  due: number | null;
  done_on: number | null;
  priority: Priority | null;
  block: string | null;
  /** Null or missing when the task has no `!przypomnij:` token (older WASM leaves it out). */
  reminder?: Reminder | null;
  /** The board column from `!etap:` (`!etap:W_toku` is `W toku`); null or missing without one (older WASM leaves it out). */
  stage?: string | null;
  project: string;
  project_note: string | null;
}

export interface TaskWarning {
  note: string;
  path: string;
  line: number;
  message: string;
}

export interface TasksJson {
  tasks: TaskRow[];
  warnings: TaskWarning[];
}

export interface ProjectRow {
  note: string;
  path: string;
  name: string;
  /** The folder the project owns (`Projekty/X` for `Projekty/X/X.md`); null when it has none, and so can't be protected. */
  folder: string | null;
  status: string | null;
  lead: string | null;
  /** Assigned in the project note's front matter (`osoby:`, `grupy:` with group ids). Older WASM leaves them out. */
  people?: string[];
  groups?: string[];
}

// shortcut: the list holds one week of due dates, the same number the design shows; a setting would add a choice nobody asked for yet
const SOON_DAYS = 7;

/** Days since 1970-01-01 of a local calendar date. */
export function dayOf(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

const MONTHS = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

/** "5 lis": a day as the views show it. */
export function shortDate(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** `YYYY-MM-DD` of a day number. */
export function isoOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The day number of a `YYYY-MM-DD` date, or null when the text is not a real date. */
export function parseDay(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const day = Date.UTC(y, m - 1, d) / DAY_MS;
  return isoOf(day) === text ? day : null;
}

export type DueState = "overdue" | "soon" | "later" | "none";

/** Overdue before today, soon within a week, otherwise later; `none` without a due date. */
export function dueState(due: number | null, today: number): DueState {
  if (due === null) return "none";
  if (due < today) return "overdue";
  return due <= today + SOON_DAYS ? "soon" : "later";
}

export const GROUPS = ["Zaległe", "Dziś", "Najbliższe 7 dni", "Później", "Bez terminu"] as const;
export type Group = (typeof GROUPS)[number];

export function groupOf(due: number | null, today: number): Group {
  if (due === null) return "Bez terminu";
  if (due < today) return "Zaległe";
  if (due === today) return "Dziś";
  return due <= today + SOON_DAYS ? "Najbliższe 7 dni" : "Później";
}

/** Earliest due first, tasks without a date last, then by note path and line. */
export function byDue(a: TaskRow, b: TaskRow): number {
  const ad = a.due ?? Number.POSITIVE_INFINITY;
  const bd = b.due ?? Number.POSITIVE_INFINITY;
  return ad - bd || a.path.localeCompare(b.path) || a.line - b.line;
}

// Names are compared through nameKey (case, NFC, surrounding spaces), the same way the people of a space are named once in the tasks.
export function sameHandle(a: string | null | undefined, b: string): boolean {
  return !!a && nameKey(b) !== "" && nameKey(a) === nameKey(b);
}

/** The user's names: the current one and the aliases kept after renames (see namesOf in taskhistory.ts). */
export type Names = string | readonly string[];
const asNames = (me: Names): readonly string[] => (typeof me === "string" ? [me] : me);

export const mineOf = (rows: TaskRow[], me: Names): TaskRow[] => {
  const names = asNames(me);
  return rows.filter((r) => (r.effective_assignees ?? r.assignees).some((a) => names.some((n) => sameHandle(a, n))));
};

export const supervisedBy = (rows: TaskRow[], me: Names): TaskRow[] => {
  const names = asNames(me);
  return rows.filter((r) => names.some((n) => sameHandle(r.supervisor, n)));
};

/** Every handle used in the tasks, as the people the token editors offer. */
export function handlesIn(rows: TaskRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    r.assignees.forEach((a) => set.add(a));
    if (r.supervisor) set.add(r.supervisor);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pl"));
}

export interface ProjectStat {
  note: string;
  path: string;
  name: string;
  status: string | null;
  open: number;
  done: number;
  percent: number;
}

export interface LoadRow {
  name: string;
  open: number;
  difficulty: number;
  // open tasks without a difficulty: they are counted apart, never as 0
  unrated: number;
}

export interface Overview {
  mine: TaskRow[];
  upcoming: TaskRow[];
  projects: ProjectStat[];
  load: LoadRow[];
}

const TOP = 5;

/** The numbers of the Przegląd view, all from the index rows. */
// `displayName` maps a name in a task to the person's current name, so a renamed person's load is counted once.
export function overview(rows: TaskRow[], projects: ProjectRow[], me: Names, today: number, displayName: (name: string) => string = (n) => n): Overview {
  const open = rows.filter((r) => !r.done).sort(byDue);
  const load = new Map<string, LoadRow>();
  for (const r of open) {
    for (const a of r.effective_assignees ?? r.assignees) {
      const name = displayName(a);
      const row = load.get(name) ?? { name, open: 0, difficulty: 0, unrated: 0 };
      row.open += 1;
      if (r.difficulty === null) row.unrated += 1;
      else row.difficulty += r.difficulty;
      load.set(name, row);
    }
  }
  return {
    mine: mineOf(open, me).slice(0, TOP),
    upcoming: open.filter((r) => r.due !== null && r.due >= today).slice(0, TOP),
    projects: projects.map((p) => {
      const inside = rows.filter((r) => r.project_note === p.note);
      const done = inside.filter((r) => r.done).length;
      const total = inside.length;
      return {
        note: p.note,
        path: p.path,
        name: p.name,
        status: p.status,
        open: total - done,
        done,
        percent: total === 0 ? 0 : Math.round((done / total) * 100),
      };
    }),
    load: [...load.values()].sort((a, b) => a.name.localeCompare(b.name, "pl")),
  };
}

// --- the tokens of a task line, as the core reads them ---------------------------------------------------------

export type TokenKind = "assignee" | "group" | "supervisor" | "due" | "done" | "difficulty" | "reminder" | "priority" | "id" | "stage";

/** A token of a task line: its kind, its UTF-16 range in the line, and what it says (a day, a handle, a number, a reminder). */
export interface LineToken {
  kind: TokenKind;
  from: number;
  to: number;
  value: string | number | Reminder | null;
}

export interface LineTask {
  text: string;
  id: string | null;
  tokens: LineToken[];
}

/**
 * The task on `line` as the core parses it, or null when the line is not a task. The only reader of task tokens in
 * the UI: chips, edits and the lookup of a task all use these spans. Needs the WASM module (see the shell's start).
 */
export function parseLine(line: string): LineTask | null {
  if (!line.includes("[")) return null;
  try {
    // The core reads a line alone, where four spaces make a code block: so the marker is read after the indent,
    // and the token spans are moved back to the whole line.
    const lead = line.length - line.trimStart().length;
    const parsed = JSON.parse(task_line_tokens(line.trimStart())) as LineTask | null;
    if (!parsed) return parsed;
    for (const token of parsed.tokens) {
      token.from += lead;
      token.to += lead;
    }
    if (parsed.tokens.some((token) => token.kind === "group")) return parsed;
    // Rolling upgrades can briefly serve a new UI with the preceding WASM. Recognize the additive group token
    // here too; the new core remains the canonical parser once its artifact is loaded.
    for (const match of line.matchAll(/(^|\s)!grupa:([\p{L}\p{N}_-]+)/gu)) {
      const from = (match.index ?? 0) + match[1].length;
      parsed.tokens.push({ kind: "group", from, to: from + match[0].length - match[1].length, value: match[2] });
      parsed.text = parsed.text.split(/\s+/).filter((word) => word !== `!grupa:${match[2]}`).join(" ");
    }
    parsed.tokens.sort((a, b) => a.from - b.from);
    return parsed;
  } catch {
    // the WASM module is not loaded: no task is read, so chips and edits are off
    return null;
  }
}

export const isTaskLine = (line: string): boolean => parseLine(line) !== null;

// "title" is the task's name: the words of the line that are not tokens (see setTaskText).
export type TaskField = "title" | "assignee" | "group" | "due" | "supervisor" | "difficulty" | "reminder" | "priority" | "stage";

const HANDLE = /^[\p{L}\p{N}._-]+$/u;
const DIFFICULTY = /^(10|[0-9])$/;
// the same bounds the core reads: 1–999 in m, h or d; the count 1–20
const REMINDER = /^[1-9]\d{0,2}[mhd](\/[1-9]\d{0,2}[mhd])?(x([1-9]|1\d|20))?$/;
const PREFIX: Record<TaskField, string> = { title: "", assignee: "@", group: "!grupa:", supervisor: "!nadzor:@", difficulty: "!trudnosc:", reminder: "!przypomnij:", due: "📅 ", priority: "", stage: "!etap:" };
/** The star that marks a task important (the core reads it as high priority, like ⏫). */
export const STAR = "⭐";

function checkValue(field: TaskField, value: string): void {
  if ((field === "assignee" || field === "supervisor") && !HANDLE.test(value)) {
    throw new Error("Nieprawidłowa nazwa osoby (np. Jan): użyj liter, cyfr, kropki, _ lub -.");
  }
  if (field === "group" && !/^[\p{L}\p{N}_-]+$/u.test(value)) throw new Error("Nieprawidłowa grupa.");
  if (field === "due" && parseDay(value) === null) throw new Error("Termin musi być datą RRRR-MM-DD.");
  if (field === "difficulty" && !DIFFICULTY.test(value)) throw new Error("Trudność musi być liczbą 0–10.");
  if (field === "reminder" && !REMINDER.test(value)) throw new Error("Przypomnienie: np. 1d albo 2h/30mx3 (m, h, d; 1–999; x 1–20).");
  if (field === "priority" && value !== STAR) throw new Error("Nieprawidłowy priorytet.");
  if (field === "stage" && !/^[\p{L}\p{N}_-]+$/u.test(value)) throw new Error("Nieprawidłowy etap: użyj liter, cyfr, - lub _.");
}

// Removes a token's text and the whitespace before it, so no double space is left behind.
function cut(line: string, from: number, to: number): string {
  let start = from;
  while (start > 0 && /\s/.test(line[start - 1])) start--;
  return line.slice(0, start) + line.slice(to);
}

/**
 * Removes the tokens `drop` (the last of them is replaced by `put` when there is one). Without a token to replace,
 * `put` goes before the id, or at the end of the line. Everything else in the line stays as it is.
 */
function rewrite(line: string, parsed: LineTask, drop: LineToken[], put: string | null): string {
  let out = line;
  const last = drop.at(-1);
  const rest = drop.slice(0, -1).reverse();
  if (last && put !== null) out = out.slice(0, last.from) + put + out.slice(last.to);
  else if (last) rest.unshift(last);
  // from the end, so the positions still to be cut stay right
  for (const t of rest) out = cut(out, t.from, t.to);
  if (!last && put !== null) {
    const id = parsed.tokens.find((t) => t.kind === "id");
    out = id ? `${out.slice(0, id.from)}${put} ${out.slice(id.from)}` : `${out.replace(/\s+$/, "")} ${put}`;
  }
  return out;
}

/**
 * The line with one field set to `value` (null or "" removes it). The assignee field edits the first `@handle`:
 * the others stay. The other single-valued fields replace the token the index reads (the last one).
 */
export function setTaskField(line: string, field: TaskField, value: string | null): string {
  if (field === "title") return setTaskText(line, value ?? "");
  const parsed = parseLine(line);
  if (!parsed) throw new Error("To nie jest zadanie.");
  // a column name keeps its spaces as `_` in the token (`!etap:W_toku`), which the core reads back as spaces
  const v = field === "stage" ? (value ?? "").trim().replace(/\s+/g, "_") : (value?.trim() ?? "");
  if (v) checkValue(field, v);
  const spans = parsed.tokens.filter((t) => t.kind === field);
  const drop = field === "assignee" ? spans.slice(0, 1) : spans;
  return rewrite(line, parsed, drop, v ? PREFIX[field] + v : null);
}

/**
 * The line with its name set to `value`: the name goes right after the checkbox, and the tokens stay in their order
 * after it. A name that the task would read as a token (`@`, `📅`, `^id`…) is refused, so no field changes by it.
 */
export function setTaskText(line: string, value: string): string {
  const parsed = parseLine(line);
  if (!parsed) throw new Error("To nie jest zadanie.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Nazwa zadania nie może być pusta.");
  const box = line.indexOf("]") + 1;
  const out = [line.slice(0, box), name, ...parsed.tokens.map((t) => line.slice(t.from, t.to))].join(" ");
  const next = parseLine(out);
  if (next?.text !== name || next.tokens.length !== parsed.tokens.length) throw new Error("Nazwa zadania nie może zawierać znaków, które zadanie czyta jako swoje pola (np. @, # albo 📅).");
  return out;
}

/** The line with its checkbox ticked or cleared; a done task gets `✅ <day>` before any `^id`. */
export function setTaskDone(line: string, done: boolean, today: number): string {
  const parsed = parseLine(line);
  if (!parsed) throw new Error("To nie jest zadanie.");
  // the checkbox is the first one on the line, and `[x]` is as long as `[ ]`, so the spans still hold
  const box = line.replace(/\[[ xX]\]/, done ? "[x]" : "[ ]");
  const drop = parsed.tokens.filter((t) => t.kind === "done");
  if (done && drop.length > 0) return box;
  return rewrite(box, parsed, drop, done ? `✅ ${isoOf(today)}` : null);
}

// --- subtasks -----------------------------------------------------------------------------------------------------

/** What a tick says while the task still has open subtasks (see openSubtasks). */
export const openSubtasksMessage = (open: number): string => `Najpierw zakończ podzadania (zostało: ${open}).`;

// The indentation of a line in columns: a tab goes to the next multiple of 4, as Markdown counts it.
function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Index just after the last line of the subtree of `lines[index]`: the lines after it indented deeper. Blank lines do not end it. */
export function subtreeEnd(lines: string[], index: number): number {
  const level = indentOf(lines[index]);
  let end = index + 1;
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= level) break;
    end = i + 1;
  }
  return end;
}

/** How many task lines under `lines[index]` are not done yet, at any depth: the subtasks a tick of that task waits for. */
export function openSubtasks(lines: string[], index: number): number {
  // the box is the one right after the list marker, so text like `[x]` later in a line does not count as done
  return lines.slice(index + 1, subtreeEnd(lines, index)).filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[ \]/.test(l) && isTaskLine(l)).length;
}

// --- task reminders ----------------------------------------------------------------------------------------------

// shortcut: a task has a day, not an hour, so its due moment is 09:00 local time of that day; a setting would add a choice nobody asked for yet
const DUE_HOUR = 9;
const MINUTE_MS = 60_000;
// a reminder whose time passed longer ago than this is not shown late
const LATE_MS = DAY_MS;

/** The moments (ms) a task's reminders fall due: `before` ahead of the due moment, then every `every` for `count` times. */
export function reminderTimes(row: TaskRow): number[] {
  if (row.due === null || !row.reminder) return [];
  const { y, m, d } = ymdOf(row.due);
  const { before_min, every_min, count } = row.reminder;
  const first = new Date(y, m - 1, d, DUE_HOUR).getTime() - before_min * MINUTE_MS;
  return Array.from({ length: every_min ? count : 1 }, (_, k) => first + k * (every_min ?? 0) * MINUTE_MS);
}

export interface DueReminder {
  /** The task's block id: a task keeps one record, the latest reminder moment shown. */
  key: string;
  row: TaskRow;
  at: number;
}

/**
 * Calls `show` for each reminder of an open task that `isMine` names, whose moment has come (within LATE_MS) and is later
 * than `shownAt(block)`, the latest moment shown for the task (-Infinity when none). Tasks without a block id get no reminder.
 */
export function runTaskReminders(rows: TaskRow[], isMine: (row: TaskRow) => boolean, now: number, shownAt: (block: string) => number, show: (reminder: DueReminder) => void): void {
  for (const row of rows) {
    if (row.done || row.block === null || !isMine(row)) continue;
    for (const at of reminderTimes(row)) {
      if (at > now || at < now - LATE_MS || at <= shownAt(row.block)) continue;
      show({ key: row.block, row, at });
    }
  }
}

// --- chips ----------------------------------------------------------------------------------------------------

export interface Chip {
  from: number;
  to: number;
  kind: "who" | "group" | "due" | "supervisor" | "difficulty" | "done" | "priority" | "stage" | "hidden";
  label: string;
  state?: DueState;
}

const PRIORITY_MARK: Record<Priority, string> = { high: "⭐ ważne", medium: "🔼", low: "🔽" };

/** The chips a task line shows in Live Preview. `hidden` ones (the id) are shown as nothing. */
export function chipsOf(line: string, today: number): Chip[] {
  const parsed = parseLine(line);
  if (!parsed) return [];
  return parsed.tokens.flatMap((t): Chip[] => {
    const { from, to } = t;
    const chip = (c: Chip): Chip[] => [c];
    switch (t.kind) {
      case "assignee":
        return chip({ from, to, kind: "who", label: `@${t.value}` });
      case "group":
        return chip({ from, to, kind: "group", label: "grupa" });
      case "due":
        return chip({ from, to, kind: "due", label: `📅 ${shortDate(t.value as number)}`, state: dueState(t.value as number, today) });
      case "done":
        return chip({ from, to, kind: "done", label: `wykonane ${shortDate(t.value as number)}` });
      case "supervisor":
        return chip({ from, to, kind: "supervisor", label: `nadzór: ${t.value}` });
      // an unreadable rating stays as the text it is, so the line shows the warning
      case "difficulty":
        return t.value === null ? [] : chip({ from, to, kind: "difficulty", label: `${t.value}/10` });
      // the reminder stays as its text: the panel edits it
      case "reminder":
        return [];
      case "priority":
        return chip({ from, to, kind: "priority", label: PRIORITY_MARK[t.value as Priority] });
      case "stage":
        return chip({ from, to, kind: "stage", label: `etap: ${t.value}` });
      case "id":
        return chip({ from, to, kind: "hidden", label: "" });
    }
  });
}

/** A task in a table cell, short form: its title, its checkbox and the chips a cell shows (the person, the date). */
export interface CellTask {
  done: boolean;
  title: string;
  chips: { kind: "who" | "due"; label: string; state?: DueState }[];
}

/** `30.11`, with the year only when it is not the current one. */
function cellDay(day: number, today: number): string {
  const d = new Date(day * DAY_MS);
  const dm = `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return d.getUTCFullYear() === new Date(today * DAY_MS).getUTCFullYear() ? dm : `${dm}.${d.getUTCFullYear()}`;
}

/** The task in a table cell (`[ ] text @Anna 📅 2026-11-30 …`), or null when the text is not one. Other tokens are hidden. */
export function cellTaskOf(text: string, today: number): CellTask | null {
  // a table cell is not a list item, so the line is read as one (the core reads only list items as tasks)
  const parsed = parseLine(`- ${text}`);
  if (!parsed) return null;
  const chips = parsed.tokens.flatMap((t): CellTask["chips"] => {
    if (t.kind === "assignee") {
      const name = String(t.value);
      const short = [...name].length > 10 ? name.split(/\s+/).map((w) => [...w][0] ?? "").join("").toLocaleUpperCase("pl-PL") : name;
      return [{ kind: "who", label: `@${short}` }];
    }
    if (t.kind === "due") return [{ kind: "due", label: cellDay(t.value as number, today), state: dueState(t.value as number, today) }];
    return [];
  });
  return { done: /^\s*\[[xX]\]/.test(text), title: parsed.text, chips };
}

// --- finding a task again ----------------------------------------------------------------------------------------

// The last value of a token kind, as the index keeps it: a later token of a kind replaces an earlier one, and an
// unreadable rating (null) does not replace a readable one.
function lastValue(line: LineTask, kind: TokenKind): LineToken["value"] {
  const found = line.tokens.filter((t) => t.kind === kind && t.value !== null);
  return found.length > 0 ? found[found.length - 1].value : null;
}

/** Whether the line reads as the row, in every field the row has (the title, the people, the dates and the marks). */
function reads(line: LineTask, lineText: string, row: TaskRow): boolean {
  const box = /\[([ xX])\]/.exec(lineText)?.[1];
  return (
    line.text === row.text &&
    JSON.stringify(line.tokens.filter((t) => t.kind === "assignee").map((t) => t.value)) === JSON.stringify(row.assignees) &&
    JSON.stringify(line.tokens.filter((t) => t.kind === "group").map((t) => t.value)) === JSON.stringify(row.group_ids ?? []) &&
    (lastValue(line, "supervisor") ?? null) === row.supervisor &&
    (lastValue(line, "due") ?? null) === row.due &&
    (lastValue(line, "difficulty") ?? null) === row.difficulty &&
    JSON.stringify(lastValue(line, "reminder") ?? null) === JSON.stringify(row.reminder ?? null) &&
    (lastValue(line, "done") ?? null) === row.done_on &&
    (lastValue(line, "priority") ?? null) === row.priority &&
    (lastValue(line, "stage") ?? null) === (row.stage ?? null) &&
    (box !== undefined && box !== " ") === row.done
  );
}

/**
 * The 1-based line of `text` that holds the task `row` describes, or null when it cannot be told for sure. A task
 * with an id is found by that id, and must still read as the row. Without an id, the line must read as the row and
 * be the only such line in the note: two tasks alike in every field are never told apart, so neither is edited.
 */
export function locateTask(text: string, row: TaskRow): number | null {
  const lines = text.split("\n");
  const hits: number[] = [];
  lines.forEach((l, i) => {
    const parsed = parseLine(l);
    if (!parsed) return;
    const byId = row.block !== null && parsed.id === row.block;
    const byTitle = row.block === null && parsed.id === null;
    if ((byId || byTitle) && reads(parsed, l, row)) hits.push(i + 1);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Rewrites one line of a note's text in one Yjs transaction: one update, so one save and one undo step.
 * `transform` gets the line without its newline. Returns false when the line does not exist or does not change.
 */
export function rewriteLine(ytext: Y.Text, line: number, transform: (text: string) => string): boolean {
  const lines = ytext.toString().split("\n");
  const i = line - 1;
  if (i < 0 || i >= lines.length) return false;
  const next = transform(lines[i]);
  if (next === lines[i]) return false;
  const start = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const apply = () => {
    ytext.delete(start, lines[i].length);
    ytext.insert(start, next);
  };
  if (ytext.doc) ytext.doc.transact(apply);
  else apply();
  return true;
}
