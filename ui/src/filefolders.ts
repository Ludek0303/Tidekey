//! Folders of files in a note: a callout `> [!pliki] Nazwa` whose quote lines hold one embed each
//! (`![[plik:<id>#<embedId>]]`, or `![[assets/…]]` on the desktop). The note's text is the only store, so sync, undo
//! and history work unchanged. These helpers read the text and build the changes the editor applies; the DOM lives in
//! filefolders-view.ts.

import type { EditorState, Text } from "@codemirror/state";
import { ALIAS_PATTERN } from "./filestore";

/** The head line: `> [!pliki] Nazwa`, or nested `> > [!pliki] Nazwa`. Groups: 1 everything before the name, 2 the name. */
export const FOLDER_HEAD = /^(\s{0,3}(?:>\s*)+\[!pliki\]\s*)(.*)$/i;
const CALLOUT_HEAD = /^\s{0,3}(?:>\s*)+\[!/;
// The quote markers at a line's start: their count is the line's depth.
const QUOTE_MARKS = /^\s{0,3}(?:>\s*)+/;
// Groups: 1 the server file id, 2 the desktop attachment (`assets/…`).
const EMBED = new RegExp(String.raw`!\[\[(?:plik:([0-9a-f]{32})(?:#[0-9a-f]{8})?|(assets\/[^\]\n|]+))(?:\|${ALIAS_PATTERN})?\]\]`, "g");

export interface FolderFile {
  /** Server file id, or null for a desktop attachment. */
  id: string | null;
  /** Desktop attachment path (`assets/…`), or null for a server file. */
  rel: string | null;
  /** Offsets of the embed text in the note. */
  from: number;
  to: number;
}

export interface Folder {
  /** Position among the folders of the note (0 first). Only meaningful for the text it was read from. */
  index: number;
  /** The name as written; "" when empty (show folderLabel). */
  title: string;
  /** Offsets: the head line's start, and the end of the folder's last line. */
  from: number;
  to: number;
  /** Offset where the name starts, and the end of the head line. */
  titleFrom: number;
  headEnd: number;
  files: FolderFile[];
  /** Quote depth of the head: 1 for a top-level folder. */
  depth: number;
  /** Index of the folder this one is nested in, or null for a top-level folder. */
  parent: number | null;
  /** End of the folder's last own line before its first subfolder: where new files go. */
  filesEnd: number;
}

export interface Change {
  from: number;
  to: number;
  insert: string;
}

/** Shown for a folder without a name. */
export const folderLabel = (title: string): string => title || "Pliki";

/** A name as the head line keeps it: one line, trimmed, at most 120 characters. */
export function folderName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120) || "Pliki";
}

/** Polish plural: "1 plik", "2 pliki", "5 plików". */
const plural = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return `1 ${one}`;
  return `${n} ${mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many}`;
};

export const countText = (n: number): string => plural(n, "plik", "pliki", "plików");

/** "1 folder", "2 foldery", "5 folderów". */
export const folderCountText = (n: number): string => plural(n, "folder", "foldery", "folderów");

/** A folder's count line: its own files and those of all its subfolders, then the subfolders when it has any. */
export function folderSummary(folders: Folder[], i: number): string {
  const depth = folders[i].depth;
  let files = folders[i].files.length;
  let subs = 0;
  // the subfolders of a folder come right after it in document order
  for (let j = i + 1; j < folders.length && folders[j].depth > depth; j++) {
    files += folders[j].files.length;
    subs++;
  }
  return subs > 0 ? `${countText(files)} · ${folderCountText(subs)}` : countText(files);
}

interface Open {
  depth: number;
  /** Index of the folder this callout is, or null for another callout. */
  folder: number | null;
  /** A subfolder has started inside it. */
  child: boolean;
}

/** Every folder of the note, in document order (subfolders right after their parent). Offsets are offsets in `text`. */
export function parseFolders(text: string): Folder[] {
  const folders: Folder[] = [];
  let open: Open[] = []; // the callouts the lines so far are inside, outermost first
  let pos = 0;
  for (const line of text.split("\n")) {
    const from = pos;
    const to = from + line.length;
    pos += line.length + 1;
    const marks = QUOTE_MARKS.exec(line);
    if (!marks) {
      open = [];
      continue;
    }
    const depth = marks[0].split(">").length - 1;
    const head = CALLOUT_HEAD.test(line);
    // a callout head ends the callouts at its depth and deeper; any other quote line ends only the deeper ones
    open = open.filter((o) => (head ? o.depth < depth : o.depth <= depth));
    if (head) {
      const up = open.find((o) => o.depth === depth - 1);
      const m = FOLDER_HEAD.exec(line);
      if (m && (depth === 1 || up?.folder != null)) {
        if (up) up.child = true;
        folders.push({
          index: folders.length, title: m[2].trim(), from, to, titleFrom: from + m[1].length, headEnd: to, files: [],
          depth, parent: up?.folder ?? null, filesEnd: to,
        });
        open.push({ depth, folder: folders.length - 1, child: false });
      } else open.push({ depth, folder: null, child: false });
    }
    const own = open.find((o) => o.depth === depth);
    if (own?.folder != null) {
      const f = folders[own.folder];
      if (!own.child) f.filesEnd = to;
      for (const m of line.matchAll(EMBED)) {
        const start = from + (m.index ?? 0);
        f.files.push({ id: m[1] ?? null, rel: m[2] ?? null, from: start, to: start + m[0].length });
      }
    }
    for (const o of open) if (o.folder !== null) folders[o.folder].to = to;
  }
  return folders;
}

// A Text is immutable: the same object means the same note, so each edit is parsed once, not once per decoration pass.
const foldersByDoc = new WeakMap<Text, Folder[]>();

export function foldersOf(doc: Text): Folder[] {
  let folders = foldersByDoc.get(doc);
  if (folders === undefined) {
    const text = doc.toString();
    // shortcut: a note without a folder still gets a full-text regex scan after each edit, not a syntax-tree check
    folders = /\[!pliki\]/i.test(text) ? parseFolders(text) : [];
    foldersByDoc.set(doc, folders);
  }
  return folders;
}

/** Top-level folders the caret (or selection) is not in: each shows as one card. A folder with the caret shows its raw text. */
export function foldedFolders(state: EditorState): Folder[] {
  const { from, to } = state.selection.main;
  return foldersOf(state.doc).filter((f) => f.depth === 1 && (to < f.from || from > f.to));
}

/** Embed lines after the folder's own lines (before its subfolders), one quote line each at the folder's depth. */
export function addEmbedsChange(folder: Folder, embeds: string[]): Change {
  const prefix = `\n${"> ".repeat(folder.depth)}`;
  return { from: folder.filesEnd, to: folder.filesEnd, insert: embeds.map((e) => prefix + e).join("") };
}

/** A new, empty subfolder at the end of the folder: a callout one quote level deeper. */
export function subfolderChange(folder: Folder, name: string): Change {
  return { from: folder.to, to: folder.to, insert: `\n${"> ".repeat(folder.depth + 1)}[!pliki] ${folderName(name)}` };
}

/** Removes a subfolder with its lines and its subfolders. Its files stay in the "Pliki" tab. Its head follows its parent's line. */
export function deleteSubfolderChange(folder: Folder): Change {
  return { from: folder.from - 1, to: folder.to, insert: "" };
}

/** The folder's name, rewritten on its head line. */
export function renameChange(folder: Folder, name: string): Change {
  return { from: folder.titleFrom, to: folder.headEnd, insert: folderName(name) };
}

/** Removes one embed. A line that held only that embed goes with its line break; the file itself stays. */
export function removeFileChange(text: string, file: FolderFile): Change {
  const start = text.lastIndexOf("\n", file.from - 1) + 1;
  const end = text.indexOf("\n", file.to);
  const lineEnd = end === -1 ? text.length : end;
  const rest = text.slice(start, file.from) + text.slice(file.to, lineEnd);
  if (start > 0 && /^\s{0,3}>\s*$/.test(rest)) return { from: start - 1, to: lineEnd, insert: "" };
  return { from: file.from, to: file.to, insert: "" };
}

/**
 * A new, empty folder at `at` (the caret, or the end of the note) on lines of its own: a blank line above it when the
 * line above has text, and a blank line after it. `caret` is the place after it, outside the folder.
 */
export function insertFolderChange(text: string, at: number, name: string): { change: Change; caret: number } {
  // inside a folder's raw lines the new one goes after that folder, so it does not cut it in two
  at = parseFolders(text).find((f) => f.depth === 1 && at >= f.from && at <= f.to)?.to ?? at;
  const before = text.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = before.slice(lineStart);
  // mid-line, the callout goes on a new line; at a line start, the line above is the previous one
  const above = lineBefore !== "" ? lineBefore : lineStart > 0 ? before.slice(before.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1) : "";
  const insert = `${lineBefore !== "" ? "\n" : ""}${above.trim() ? "\n" : ""}> [!pliki] ${folderName(name)}\n\n`;
  return { change: { from: at, to: at, insert }, caret: at + insert.length };
}
