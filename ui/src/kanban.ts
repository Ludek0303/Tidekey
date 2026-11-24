//! Tablica: a note with `typ: kanban` in its front matter shows the tasks of every note under its folder, in the
//! columns its `kolumny:` line names (the default three when it has none). A task's column is its `!etap:` token; the
//! last column is "zrobione" (done). The board's text stays plain Markdown, so it is an ordinary note otherwise.

import * as Y from "yjs";
import type { Bridge } from "./bridge";
import { el } from "./dom";
import { setFrontMatter } from "./frontmatter";
import { TASK_CHANGED, type TaskEdits, editNote, tickLine } from "./orgedit";
import { type TaskRow, locateTask, parseLine, setTaskField } from "./orgtasks";
import { projectNameError } from "./projects";
import { confirmDialog, askName, openDialog, toast } from "./widgets";

export const KANBAN_NAME = "Tablica";
export const KANBAN_TEXT = "---\ntyp: kanban\n---\nTablica zbiera zadania ze wszystkich notatek w tym folderze i jego podfolderach. Ctrl+E pokazuje tekst notatki.\n";
export const DEFAULT_COLUMNS = ["Do zrobienia", "W toku", "Gotowe"];

/** The board note a view draws: its id, its path and its text. */
export interface BoardNote {
  id: string;
  path: string;
  text: string;
}

/** Whether the text's front matter says `typ: kanban`. */
export function isKanbanText(text: string): boolean {
  const end = text.indexOf("\n---", 3);
  return text.startsWith("---\n") && end > 0 && text.slice(4, end).split("\n").some((line) => line.trim() === "typ: kanban");
}

/** The lines between the front matter's fences; none without front matter. */
function frontLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return [];
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  return end < 0 ? [] : lines.slice(1, end);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The column names of a board, in order: its `kolumny:` line (comma-separated), else the defaults. Repeats are dropped. */
export function columnsOf(text: string): string[] {
  const line = frontLines(text).find((l) => l.trim().startsWith("kolumny:"));
  const names = (line?.trim().slice("kolumny:".length) ?? "").split(",").map((n) => n.trim().replace(/\s+/g, " ")).filter(Boolean);
  const unique = names.filter((n, i) => names.findIndex((m) => same(m, n)) === i);
  return unique.length ? unique : DEFAULT_COLUMNS;
}

/** The folder a note lives in: "" for the top of the space. */
export { parentOf as folderOf } from "./tree";

/** The tasks of every note under `folder`, its sub-folders too. "" is the whole space. */
export function folderTasks(tasks: TaskRow[], folder: string): TaskRow[] {
  return folder === "" ? tasks : tasks.filter((t) => t.path.startsWith(`${folder}/`));
}

/**
 * The column a task sits in: the last one when it is done, else the one its `!etap:` names (without a match, or
 * without a token, the first one).
 */
export function columnIndex(task: Pick<TaskRow, "done" | "stage">, names: string[]): number {
  if (task.done) return names.length - 1;
  const stage = task.stage ?? "";
  const at = stage ? names.findIndex((n) => same(n, stage)) : -1;
  return at < 0 ? 0 : at;
}

const isTicked = (line: string): boolean => /\[([ xX])\]/.exec(line)?.[1].toLowerCase() === "x";

/**
 * The task line moved to column `target`. The last column ticks it and drops its token; any other column unticks a
 * done task and sets its token (the first column has none). A tick waits for open subtasks, as everywhere else: the
 * line then stays as it is.
 */
export function moveLine(line: string, lines: string[], index: number, names: string[], target: number, today: number): string {
  if (target === names.length - 1) {
    if (isTicked(line)) return setTaskField(line, "stage", null);
    const ticked = tickLine(line, lines, index, true, today);
    return ticked === line ? line : setTaskField(ticked, "stage", null);
  }
  const unticked = isTicked(line) ? tickLine(line, lines, index, false, today) : line;
  return setTaskField(unticked, "stage", target === 0 ? null : names[target]);
}

/** A new task line for column `column`: ticked in the last column (no token), else unticked with its token (none in the first). */
export function newTaskLine(title: string, names: string[], column: number): string {
  const text = title.trim().replace(/\s+/g, " ");
  if (column === names.length - 1) return `- [x] ${text}`;
  return column === 0 ? `- [ ] ${text}` : `- [ ] ${text} !etap:${names[column].replace(/\s+/g, "_")}`;
}

/** The text with `line` added as its last line. */
export function appendLine(text: string, line: string): string {
  return text === "" || text.endsWith("\n") ? `${text}${line}\n` : `${text}\n${line}`;
}

/**
 * The text with the `!etap:` tokens rewritten: each `[from, to]` pair renames a column (`to`), `to` null removes the
 * column's token, so its tasks fall into the first column. Each line is read once, so swapped names do not chain.
 */
export function restageText(text: string, moves: [string, string | null][]): string {
  return text
    .split("\n")
    .map((line) => {
      const stages = parseLine(line)?.tokens.filter((t) => t.kind === "stage") ?? [];
      const hit = moves.find(([from]) => stages.some((t) => same(String(t.value), from)));
      return hit ? setTaskField(line, "stage", hit[1]) : line;
    })
    .join("\n");
}

/** The reason a column name is refused, or null when it can be one. Names are short words; `_` and `,` are not allowed. */
export function columnNameError(name: string, others: string[]): string | null {
  if (!name) return "Nazwa kolumny nie może być pusta.";
  if (!/^[\p{L}\p{N} -]+$/u.test(name)) return "Nazwa kolumny: litery, cyfry, spacje i - (bez przecinków i _).";
  if (others.some((o) => same(o, name))) return "Taka kolumna już jest.";
  return null;
}

/** One column of the columns dialog: its name now, and the name it had (null for a new column). */
export interface ColumnChange {
  name: string;
  was: string | null;
}

/** The old columns that disappear: no change keeps their name, and a new name that matches one (without regard to case) keeps its tokens. */
function removedColumns(oldNames: string[], changes: ColumnChange[]): string[] {
  return oldNames.filter((old) => !changes.some((c) => c.was === old || same(c.name, old)));
}

/**
 * Saves the columns: the board's `kolumny:` gets the names in order, renamed columns move their `!etap:` tokens, and
 * removed ones leave their tasks in the first column. Each note changes in one transaction. Resolves to the ids changed.
 */
export async function saveColumns(edits: TaskEdits, board: BoardNote, rows: TaskRow[], changes: ColumnChange[]): Promise<string[]> {
  const names = changes.map((c) => c.name);
  const moves: [string, string | null][] = [];
  for (const c of changes) if (c.was !== null && c.was !== c.name) moves.push([c.was, c.name]);
  for (const old of removedColumns(columnsOf(board.text), changes)) moves.push([old, null]);
  await editNote(edits, board.id, (text) => setFrontMatter(text, "kolumny", names.join(", ")));
  const touched = new Set([board.id]);
  const holders = new Set(rows.filter((t) => moves.some(([from]) => same(t.stage ?? "", from))).map((t) => t.note));
  for (const id of holders) {
    await editNote(edits, id, (text) => restageText(text, moves));
    touched.add(id);
  }
  return [...touched];
}

/** Moves a task to column `target`: one transaction in its note. Resolves to the ids changed. */
export async function moveTask(edits: TaskEdits, task: TaskRow, names: string[], target: number, today: number): Promise<string[]> {
  await editNote(edits, task.note, (text) => {
    const lines = text.split("\n");
    const at = locateTask(text, task);
    if (at === null) throw new Error(TASK_CHANGED);
    lines[at - 1] = moveLine(lines[at - 1], lines, at - 1, names, target, today);
    return lines.join("\n");
  });
  return [task.note];
}

/** Adds a task to column `column`, at the end of the board note (its folder is the board's, so the task belongs to it). */
export async function addTask(edits: TaskEdits, board: BoardNote, title: string, names: string[], column: number): Promise<string[]> {
  await editNote(edits, board.id, (text) => appendLine(text, newTaskLine(title, names, column)));
  return [board.id];
}

/**
 * The columns dialog: names in order, with add, move and remove. Refused names are told; a removal that holds tasks
 * is asked first. `onSave` gets the changes once the dialog closes.
 */
export function openColumnsDialog(board: BoardNote, rows: TaskRow[], onSave: (changes: ColumnChange[]) => void): void {
  const oldNames = columnsOf(board.text);
  const items: ColumnChange[] = oldNames.map((name) => ({ name, was: name }));
  openDialog({
    label: "Kolumny tablicy",
    className: "kanban-columns-dialog",
    render(box, close) {
      const list = el("ol", "kanban-cols-list");
      const inputs: HTMLInputElement[] = [];
      const swap = (i: number, j: number) => {
        [items[i], items[j]] = [items[j], items[i]];
      };
      const button = (text: string, label: string, enabled: boolean, run: () => void) => {
        const b = el("button", "btn kanban-cols-btn", text);
        b.type = "button";
        b.disabled = !enabled;
        b.setAttribute("aria-label", label);
        b.title = label;
        b.addEventListener("click", run);
        return b;
      };
      const draw = (focus = -1) => {
        inputs.length = 0;
        list.replaceChildren(
          ...items.map((item, i) => {
            const row = el("li", "kanban-col-row");
            const input = el("input");
            input.type = "text";
            input.autocomplete = "off";
            input.value = item.name;
            input.setAttribute("aria-label", `Nazwa kolumny ${i + 1}`);
            input.addEventListener("input", () => {
              item.name = input.value;
            });
            inputs.push(input);
            row.append(
              input,
              button("↑", "Przesuń w górę", i > 0, () => {
                swap(i, i - 1);
                draw(i - 1);
              }),
              button("↓", "Przesuń w dół", i < items.length - 1, () => {
                swap(i, i + 1);
                draw(i + 1);
              }),
              button("✕", "Usuń kolumnę", true, () => {
                items.splice(i, 1);
                draw();
              }),
            );
            return row;
          }),
        );
        inputs[focus]?.focus();
      };
      draw();

      const add = el("button", "btn", "+ Dodaj kolumnę");
      add.type = "button";
      add.addEventListener("click", () => {
        items.push({ name: "", was: null });
        draw(items.length - 1);
      });
      const cancel = el("button", "btn", "Anuluj");
      cancel.type = "button";
      cancel.addEventListener("click", () => close());
      const save = el("button", "btn btn-primary", "Zapisz");
      save.type = "button";
      save.addEventListener("click", () => {
        const names = items.map((item) => item.name.trim().replace(/\s+/g, " "));
        const problem = names.map((n, i) => columnNameError(n, names.filter((_, j) => j !== i))).find((p) => p !== null) ?? (names.length < 2 ? "Tablica potrzebuje co najmniej dwóch kolumn." : null);
        if (problem) {
          toast(problem, true);
          return;
        }
        const changes = items.map((item, i) => ({ name: names[i], was: item.was }));
        const gone = removedColumns(oldNames, changes);
        const count = rows.filter((t) => gone.some((g) => same(t.stage ?? "", g))).length;
        const ok = count > 0 ? confirmDialog(`Usunięcie kolumny ${gone.join(", ")} przeniesie ${count} zadań do pierwszej kolumny.`, "Usuń kolumnę") : Promise.resolve(true);
        void ok.then((yes) => {
          if (!yes) return;
          close();
          onSave(changes);
        });
      });
      const actions = el("div", "modal-actions");
      actions.append(add, cancel, save);
      box.append(el("p", "", "Kolumny w kolejności. Ostatnia to zrobione."), list, actions);
    },
  });
}

/** Writes the board's text into a new note. */
export async function fillKanban(bridge: Bridge, id: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, KANBAN_TEXT);
  await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
}

/** Asks for the name of a new board note (without `.md`). Resolves with the name, or null when cancelled. */
export const askKanbanName = (initial: string): Promise<string | null> =>
  askName("Nowa tablica kanban", "Nazwa tablicy", (name) => (projectNameError(name) ? "Podaj nazwę bez znaków \\ / : * ? \" < > |." : null), initial);
