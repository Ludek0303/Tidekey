//! Moving notes in and out of the space as plain files: a ZIP of every note (`Notatka.md`, `Folder/X.md`) with its attached
//! files under `pliki/` (server files) or `assets/` (desktop attachments), and `.md` files dropped on the file tree.
//! The export writes decrypted text to disk, so it always asks first.

import * as Y from "yjs";
import type { Bridge, TreeListing } from "./bridge";
import { plural } from "./calendar/dates";
import { filesOf, textLayersOf } from "./filestore";
import { getSetting } from "./settings";
import type { TextLayerInfo } from "./remotefiles";
import { confirmDialog, errorText, toast } from "./widgets";
import { emit } from "./bus";

// --- ZIP (STORE, no compression): CRC-32, local headers, central directory, end record. UTF-8 names (flag bit 11).

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** The archive as parts, so a Blob can join them without another copy of the data. */
export function zipParts(entries: ZipEntry[], now = new Date()): Uint8Array[] {
  if (entries.length > 0xffff) throw new Error("Za dużo plików do jednego archiwum.");
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(12, dosTime, true);
    header.setUint16(14, dosDate, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  if (offset > 0xffffffff) throw new Error("Archiwum jest za duże.");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...parts, ...central, new Uint8Array(end.buffer)];
}

// --- Export

// Server files: `![[plik:<32 hex>#<8 hex>|<alias>]]`, the embed id and the alias optional (the alias is kept verbatim).
const SERVER_EMBED = /!\[\[plik:([0-9a-f]{32})(?:#[0-9a-f]{8})?(?:\|([^\]\n]*))?\]\]/g;
// Desktop attachments: `![[assets/<name>|<alias>]]`, copied as they are.
const DESKTOP_EMBED = /!\[\[(assets\/[^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;

const FORBIDDEN_NAME = /[\\/:*?"<>|\0-\x1f]/g;

// "name.ext" → "name (2).ext", "name (3).ext", … while the name is taken.
function uniqueName(taken: Set<string>, name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate);
  return candidate;
}

export interface ExportResult {
  entries: ZipEntry[];
  notes: number;
  files: number;
  missing: string[];
  /** The folders of the space when the export was listed. */
  folders: string[];
}

/** Every note (or those `keep` accepts) and their attachments, as zip entries. Files are read one at a time. */
export async function buildExport(
  bridge: Bridge,
  progress: (done: number, total: number) => void = () => undefined,
  keep: (path: string) => boolean = () => true,
): Promise<ExportResult> {
  const { notes: all, folders } = await bridge.call<TreeListing>("list_tree");
  const notes = all.filter((note) => keep(note.path));
  const store = filesOf(bridge);
  const texts: string[] = [];
  let done = 0;
  for (const note of notes) {
    texts.push(await bridge.call<string>("note_text", { id: note.id }));
    progress(++done, notes.length);
  }

  const serverIds = new Set<string>();
  const desktopRels = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(SERVER_EMBED)) serverIds.add(m[1]);
    for (const m of text.matchAll(DESKTOP_EMBED)) desktopRels.add(m[1]);
  }
  const total = notes.length + serverIds.size + desktopRels.size;
  const missing: string[] = [];
  const entries: ZipEntry[] = [];
  const names = new Map<string, string>(); // server file id → name in the zip
  const taken = new Set<string>();
  // Recognised text of the files (docs/OCR.md §3.6): a failed read only leaves that file's `.tekst.md` out.
  const textStore = getSetting("ocrZipText") && textLayersOf(store) ? store : null;
  const layers = textStore ? await textStore.textLayers().catch(() => new Map<string, TextLayerInfo>()) : new Map<string, TextLayerInfo>();
  const textEntries: ZipEntry[] = [];

  for (const id of serverIds) {
    try {
      const info = await store?.info(id);
      if (!info) throw new Error("nie ma takiego pliku albo nie jest dostępny");
      const name = uniqueName(taken, `pliki/${safeName(info.name)}`);
      const data = new Uint8Array(await (await store!.read(id)).arrayBuffer());
      names.set(id, name);
      entries.push({ name, data });
      const layer = layers.get(id);
      if (layer && textStore) {
        try {
          const markdown = await textStore.readTextLayer(layer.id, id);
          textEntries.push({ name: uniqueName(taken, `${name}.tekst.md`), data: new TextEncoder().encode(markdown) });
        } catch {
          // no text for this file: the export goes on without its `.tekst.md`
        }
      }
    } catch (e) {
      missing.push(`${id}: ${errorText(e)}`);
    }
    progress(++done, total);
  }

  for (const rel of desktopRels) {
    try {
      if (rel.split("/").includes("..")) throw new Error("zła ścieżka");
      const data = await bridge.call<Uint8Array>("read_attachment", { rel });
      entries.push({ name: rel, data });
    } catch (e) {
      missing.push(`${rel}: ${errorText(e)}`);
    }
    progress(++done, total);
  }

  const encoder = new TextEncoder();
  const noteEntries = notes.map((note, i) => ({
    name: note.path,
    data: encoder.encode(texts[i].replace(SERVER_EMBED, (whole, id: string, alias?: string) => {
      const name = names.get(id);
      if (!name) return whole; // missing file: the embed stays as it was
      return `![[${name}${alias === undefined ? "" : `|${alias}`}]]`;
    })),
  }));
  const result = [...noteEntries, ...entries, ...textEntries];
  if (missing.length) result.push({ name: "BRAKUJACE-PLIKI.txt", data: encoder.encode(`${missing.join("\n")}\n`) });
  return { entries: result, notes: notes.length, files: entries.length, missing, folders };
}

// A file name that can be stored on any system: no path separators or control characters.
function safeName(name: string): string {
  return name.replace(FORBIDDEN_NAME, "_").trim() || "plik";
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "1 notatka", "2 notatki", "5 notatek": Polish count forms (one, few, many). */
export function count(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}
const ASK_ALL = "Pobierzesz niezaszyfrowaną kopię wszystkich notatek i plików tej przestrzeni. Przechowuj ją bezpiecznie.";
const ASK_SELECTED = "Pobierzesz niezaszyfrowaną kopię zaznaczonych notatek i ich plików. Przechowuj ją bezpiecznie.";

// Builds the ZIP for `keep` and downloads it as `fileName`; the toast tells what went in. True when it was downloaded.
async function deliver(bridge: Bridge, fileName: (folders: string[]) => Promise<string> | string, keep?: (path: string) => boolean): Promise<boolean> {
  try {
    toast("Przygotowuję eksport…");
    const result = await buildExport(bridge, () => undefined, keep);
    if (result.notes === 0) { toast("W zaznaczeniu nie ma notatek do pobrania.", true); return false; }
    const blob = new Blob(zipParts(result.entries) as BlobPart[]);
    download(await fileName(result.folders), blob);
    const skipped = result.missing.length;
    toast(
      `Wyeksportowano: ${count(result.notes, "notatka", "notatki", "notatek")}, ${count(result.files, "plik", "pliki", "plików")}.${skipped ? ` Brakujące pliki: ${skipped} (lista w BRAKUJACE-PLIKI.txt).` : ""}`,
      skipped > 0,
    );
    return true;
  } catch (e) {
    toast(errorText(e), true);
    return false;
  }
}

// `notatki-kopia-<space>-YYYY-MM-DD.zip` for a named space, `notatki-YYYY-MM-DD.zip` otherwise.
const stamp = (space = ""): string => {
  const part = cleanPart(space);
  return `${part ? `notatki-kopia-${part}` : "notatki"}-${new Date().toISOString().slice(0, 10)}.zip`;
};

/** Asks first (the copy is not encrypted), then downloads the whole space. False when cancelled or not made. */
export async function exportAll(bridge: Bridge, space = ""): Promise<boolean> {
  if (!(await confirmDialog(ASK_ALL, "Pobierz", false))) return false;
  return deliver(bridge, () => stamp(space));
}

/**
 * Downloads the selected notes and the notes inside the selected folders. A folder is `path/` as a prefix, so
 * selecting `Projekty/A` does not take `Projekty/AB/x.md`. One selected folder names the file after itself.
 */
export async function exportNotes(bridge: Bridge, keys: string[]): Promise<void> {
  if (keys.length === 0 || !(await confirmDialog(ASK_SELECTED, "Pobierz", false))) return;
  const inside = (path: string): boolean => keys.some((key) => path === key || path.startsWith(`${key}/`));
  const name = (folders: string[]) =>
    keys.length === 1 && folders.includes(keys[0]) ? `${keys[0].slice(keys[0].lastIndexOf("/") + 1)}.zip` : stamp();
  await deliver(bridge, name, inside);
}

// --- Import

const isMarkdown = (file: File): boolean => /\.md$/i.test(file.name);

/** A file to import and the folder it sits in, relative to the import folder: `Top/Sub` for `Top/Sub/X.md`. */
export interface ImportFile {
  file: File;
  dir: string;
}

/** The folder a file comes from, when it was picked as a folder: `Top/Sub/X.md` gives `Top/Sub`. */
const relativeDir = (file: File): string => {
  const path = file.webkitRelativePath ?? ""; // jsdom and plain file pickers leave it unset
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
};

const readEntry = <T>(read: (ok: (value: T) => void, fail: (e: DOMException) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => read(resolve, reject));

// Reads a dropped folder: readEntries returns at most 100 entries per call, so it runs until it returns none.
async function readDir(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await readEntry<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/**
 * The files of a drop, folders included: each file keeps the path of its folders under the dropped folder's name.
 * Must run during the drop event (the entries go away after it). Without entries, plain `files` are used.
 */
export async function collectDropped(data: DataTransfer): Promise<ImportFile[]> {
  const roots = Array.from(data.items ?? [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  const plain = Array.from(data.files ?? []);
  if (roots.length === 0) return plain.map((file) => ({ file, dir: "" }));

  const out: ImportFile[] = [];
  const walk = async (entry: FileSystemEntry, parent: string): Promise<void> => {
    if (entry.isFile) {
      const file = await readEntry<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      out.push({ file, dir: parent });
      return;
    }
    const dir = parent ? `${parent}/${entry.name}` : entry.name;
    for (const child of await readDir(entry as FileSystemDirectoryEntry)) await walk(child, dir);
  };
  for (const root of roots) await walk(root, "");
  return out;
}

// Characters a note or folder name cannot hold; they become "_".
export const cleanPart = (part: string): string => part.replace(FORBIDDEN_NAME, "_").trim();

/**
 * Creates one note per `.md` file under `folder` and the file's own `dir`. Names that are taken get " (2)", " (3)"…
 * A byte order mark is dropped and CRLF becomes LF. Returns the number of notes made.
 */
export async function importMarkdown(bridge: Bridge, items: ImportFile[], folder = ""): Promise<number> {
  const markdown = items.filter(({ file }) => isMarkdown(file));
  const others = items.filter(({ file }) => !isMarkdown(file));
  if (others.length) toast(`Pominięto pliki, które nie są .md: ${others.map(({ file }) => file.name).join(", ")}`);
  if (!markdown.length) {
    if (items.length) toast("Nie wybrano plików .md.", true);
    return 0;
  }

  let imported = 0;
  try {
    const { notes, folders } = await bridge.call<TreeListing>("list_tree");
    const taken = new Set([...notes.map((n) => n.path), ...folders].map((p) => p.toLowerCase()));
    const ensureFolder = async (dir: string): Promise<void> => {
      let path = "";
      for (const part of dir.split("/").filter(Boolean)) {
        path = path ? `${path}/${part}` : part;
        if (taken.has(path.toLowerCase())) continue;
        await bridge.call("create_folder", { path });
        taken.add(path.toLowerCase());
      }
    };

    for (const { file, dir: fromDir } of markdown) {
      const dir = [folder, fromDir].filter(Boolean).map((d) => d.split("/").map(cleanPart).join("/")).join("/");
      await ensureFolder(dir);
      const stem = cleanPart(file.name.replace(/\.md$/i, "")) || "Notatka";
      const base = dir ? `${dir}/${stem}` : stem;
      let path = `${base}.md`;
      for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${base} (${n}).md`;
      taken.add(path.toLowerCase());

      const text = (await file.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
      const id = await bridge.call<string>("create_note", { path });
      if (text) {
        const doc = new Y.Doc();
        doc.getText("content").insert(0, text);
        await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
      }
      imported++;
    }
  } catch (e) {
    toast(errorText(e), true);
  }
  if (imported) { emit("ui:tree-reload"); toast(`Zaimportowano: ${count(imported, "notatka", "notatki", "notatek")}.`); }
  return imported;
}

/** Opens the system file picker for `.md` files, or for a folder (its `.md` files keep their folders). */
export function pickMarkdown(folderMode: boolean, onFiles: (files: ImportFile[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (folderMode) input.setAttribute("webkitdirectory", "");
  else input.accept = ".md,text/markdown";
  input.addEventListener("change", () => onFiles([...(input.files ?? [])].map((file) => ({ file, dir: relativeDir(file) }))));
  input.click();
}
