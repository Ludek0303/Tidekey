//! Edits to a task's source line. The line is found again in the note's text before every edit: by the task's
//! `^id`, or, without one, by checking that the line at the row still reads as the same task. A note that is open in
//! a tab is changed in its document (the editor saves it); any other note is loaded, changed and saved through the
//! bridge in one update.

import * as Y from "yjs";
import type { Bridge } from "./bridge";
import { newTaskId } from "./taskchips";
import { type TaskField, type TaskRow, isoOf, locateTask, openSubtasks, openSubtasksMessage, parseLine, rewriteLine, setTaskDone, setTaskField, setTaskText, subtreeEnd } from "./orgtasks";
import { toast } from "./widgets";

export const TASK_CHANGED = "Zadanie zmieniło się — odśwież widok";

export interface TaskEdits {
  bridge: Bridge;
  // The document of the note when it is open in a tab, otherwise null.
  openDoc: (noteId: string) => Y.Doc | null;
}

export function editField(edits: TaskEdits, task: TaskRow, field: TaskField, value: string | null): Promise<void> {
  return rewriteTask(edits, task, (line) => setTaskField(line, field, value));
}

/**
 * Adds a task line per title right after `task`'s line, or after the line with id `after` (the last line added before).
 * Each new line has the same indentation and list marker, unticked, with the assignee and the due date of `task`.
 * Resolves to the id of the last added line; null when tasks carry no ids (shortcut: such lines go right after `task`).
 */
export function addTaskLines(edits: TaskEdits, task: TaskRow, titles: string[], assignee: string | null, after: string | null = null): Promise<string | null> {
  let last: string | null = null;
  return editNote(edits, task.note, (text) => {
    const lines = text.split("\n");
    let line = after === null ? locateTask(text, task) : null;
    if (after !== null) {
      const index = lines.findIndex((l) => parseLine(l)?.id === after);
      if (index >= 0) line = index + 1;
    }
    if (line === null) throw new Error(TASK_CHANGED);
    const source = lines[line - 1];
    const marker = source.slice(0, source.indexOf("["));
    const seen: string[] = [];
    const added = titles.map((title) => {
      let next = `${marker}[ ] ${title}`;
      if (assignee) next = setTaskField(next, "assignee", assignee);
      if (task.due !== null) next = setTaskField(next, "due", isoOf(task.due));
      // An id like the one the editor gives a typed task, so the new task keeps its history (only where tasks carry ids).
      if (!task.block) return next;
      const id = newTaskId(text + seen.join(" "));
      seen.push(`^${id}`);
      return `${next} ^${id}`;
    });
    lines.splice(line, 0, ...added);
    last = seen.length ? seen[seen.length - 1].slice(1) : null;
    return lines.join("\n");
  }).then(() => last);
}

/** Adds an unticked subtask under `task`: a line right after its subtree, indented two spaces deeper than the task. */
export function addSubtask(edits: TaskEdits, task: TaskRow, title: string): Promise<void> {
  return editNote(edits, task.note, (text) => {
    const lines = text.split("\n");
    const line = locateTask(text, task);
    if (line === null) throw new Error(TASK_CHANGED);
    // the child goes to the parent's content column: under `1. ` that is 3 spaces, under `10. ` 4 (CommonMark)
    const head = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(lines[line - 1])?.[0] ?? "";
    const indent = head ? head.replace(/\S/g, " ") : "  ";
    lines.splice(subtreeEnd(lines, line - 1), 0, `${indent}${setTaskText("- [ ] ", title)}`);
    return lines.join("\n");
  });
}

export function editDone(edits: TaskEdits, task: TaskRow, done: boolean, today: number): Promise<void> {
  return rewriteTask(edits, task, (line, lines, index) => tickLine(line, lines, index, done, today));
}

/**
 * The line ticked or unticked. A tick waits for the open subtasks: the toast says how many are left, and the line stays
 * as it is. Every tick of a task goes through here, so the rule holds wherever the task is shown.
 */
export function tickLine(line: string, lines: string[], index: number, done: boolean, today: number): string {
  const open = done ? openSubtasks(lines, index) : 0;
  if (open > 0) {
    toast(openSubtasksMessage(open));
    return line;
  }
  return setTaskDone(line, done, today);
}

/** Read the real source before editing a cached task; the backend compares it again before committing. */
export async function editExternalTask(bridge: Bridge, path: string, task: TaskRow, transform: (line: string, lines: string[], index: number) => string): Promise<void> {
  if (!task.block) throw new Error("Otwórz zadanie i nadaj mu trwały identyfikator przed edycją z innej przestrzeni.");
  const expected = await bridge.call<string>("external_task_note", { path, id: task.note });
  const line = locateTask(expected, task);
  if (line === null) throw new Error(TASK_CHANGED);
  const lines = expected.split("\n");
  lines[line - 1] = transform(lines[line - 1], lines, line - 1);
  const replacement = lines.join("\n");
  if (replacement !== expected) await bridge.call("external_task_edit", { path, id: task.note, expected, replacement });
}

/**
 * Rewrites a whole note's text (e.g. its front matter): in its open document, or loaded and saved through the bridge.
 * `origin` is the Yjs transaction origin of the write (the calendar's undo manager tracks CALENDAR_ORIGIN).
 */
export async function editNote(edits: TaskEdits, noteId: string, transform: (text: string) => string, origin?: unknown): Promise<void> {
  const replace = (doc: Y.Doc): boolean => {
    const ytext = doc.getText("content");
    const before = ytext.toString(), after = transform(before);
    if (after === before) return false;
    // only the changed middle is replaced, so a concurrent edit elsewhere in the note survives the merge
    let a = 0; while (a < before.length && a < after.length && before[a] === after[a]) a++;
    let b = 0; while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    doc.transact(() => { ytext.delete(a, before.length - a - b); ytext.insert(a, after.slice(a, after.length - b)); }, origin);
    return true;
  };
  const open = edits.openDoc(noteId);
  if (open) { replace(open); return; }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await edits.bridge.call<Uint8Array>("open_note", { id: noteId }));
  const before = Y.encodeStateVector(doc);
  if (replace(doc)) await edits.bridge.call("apply_update", { id: noteId, update: Y.encodeStateAsUpdate(doc, before) });
}

async function rewriteTask(edits: TaskEdits, task: TaskRow, transform: (line: string, lines: string[], index: number) => string): Promise<void> {
  const open = edits.openDoc(task.note);
  if (open) {
    apply(open, task, transform);
    return;
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await edits.bridge.call<Uint8Array>("open_note", { id: task.note }));
  const before = Y.encodeStateVector(doc);
  if (!apply(doc, task, transform)) return;
  await edits.bridge.call("apply_update", { id: task.note, update: Y.encodeStateAsUpdate(doc, before) });
}

// Returns false when nothing changed. Throws TASK_CHANGED when the task is not where the row says.
function apply(doc: Y.Doc, task: TaskRow, transform: (line: string, lines: string[], index: number) => string): boolean {
  const ytext = doc.getText("content");
  const text = ytext.toString();
  const line = locateTask(text, task);
  if (line === null) throw new Error(TASK_CHANGED);
  const lines = text.split("\n");
  return rewriteLine(ytext, line, (current) => transform(current, lines, line - 1));
}
