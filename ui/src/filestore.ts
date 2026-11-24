//! Server files (docs/PLIKI.md): the contract every part of the UI codes against. A file gets a random id when it is
//! picked, the note holds `![[plik:<id>#<embedId>]]` (an image may add its size and placement, `…|320x200 center]]`), and the bytes
//! live in the backend's `FileStore`: the server (encrypted, browserauth.ts → remotefiles.ts), memory (demo, tests) or
//! none (the desktop app keeps its `assets/` attachments, attachments.ts).

import type { Bridge } from "./bridge";
import { parse as parseFileText } from "./ocr/filetext";
import type { TextLayerFields, TextLayerInfo } from "./remotefiles";

export const MIN_WIDTH = 40;
export const MAX_WIDTH = 4000;

export type ImageAlign = "left" | "center" | "right" | "wrap-left" | "wrap-right";

/**
 * An image's alias: exact size in CSS px (height only with width), where it sits, and its horizontal position
 * (0 = left edge at the note's left edge, 50 = right edge at the right edge; see attachments.css `.file-pos`). Each part may be absent.
 * Rule: a position overrides the align. The UI sets one and clears the other, so a note never holds both from the UI.
 */
export interface ImageAlias {
  width?: number | null;
  height?: number | null;
  align?: ImageAlign | null;
  position?: number | null;
}

export const MAX_POSITION = 50;

// The alias grammar (docs/PLIKI.md §1): `W`, `WxH`, `W <align>`, `<align>`, and any of them followed by ` pozN` (N = 0..50),
// or `pozN` alone. Built once, used by every pattern below.
const ALIGN_RE = "left|center|right|wrap-left|wrap-right";
const SIZE_ALIGN = String.raw`\d{1,4}(?:x\d{1,4})?(?: (?:${ALIGN_RE}))?|(?:${ALIGN_RE})`;
export const ALIAS_PATTERN = String.raw`(?:(?:${SIZE_ALIGN})(?: poz\d{1,3})?|poz\d{1,3})`;
// Groups: 1 width, 2 height, 3 align after a size, 4 align alone, 5 position after a size or align, 6 position alone.
const ALIAS_PARSE = new RegExp(
  String.raw`^(?:(?:(\d{1,4})(?:x(\d{1,4}))?(?: (${ALIGN_RE}))?|(${ALIGN_RE}))(?: poz(\d{1,3}))?|poz(\d{1,3}))$`,
);

/** The source of the embed regex for one file id (or a pattern for any); then the embed id and alias groups. */
export function embedPattern(id: string): string {
  return String.raw`!\[\[plik:${id}(?:#([0-9a-f]{8}))?(?:\|(${ALIAS_PATTERN}))?\]\]`;
}

/**
 * `![[plik:<id>#<embedId>|<alias>]]`, the embed id and the alias optional (docs/PLIKI.md §1).
 * Groups: 1 the file id, 2 the embed id (8 hex), 3 the alias (see parseImageAlias).
 */
export const FILE_EMBED = new RegExp(embedPattern("([0-9a-f]{32})"), "g");

/** The alias of an embed as written, or null when it has no size, placement or position (or is not an alias). */
export function parseImageAlias(alias: string): ImageAlias | null {
  const m = ALIAS_PARSE.exec(alias);
  if (!m) return null;
  const align = (m[3] ?? m[4]) as ImageAlign | undefined;
  const position = m[5] ?? m[6];
  return {
    width: m[1] ? clampWidth(Number(m[1])) : null,
    height: m[2] ? clampWidth(Number(m[2])) : null,
    align: align ?? null,
    position: position === undefined ? null : clampPosition(Number(position)),
  };
}

/** The alias as written in a note (the inverse of parseImageAlias); "" when there is nothing to write. */
export function formatImageAlias(alias: ImageAlias | null | undefined): string {
  const width = alias?.width ? clampWidth(alias.width) : 0;
  const height = width && alias?.height ? clampWidth(alias.height) : 0;
  const size = width ? (height ? `${width}x${height}` : `${width}`) : "";
  const position = alias?.position != null ? `poz${clampPosition(alias.position)}` : "";
  return [size, alias?.align ?? "", position].filter(Boolean).join(" ");
}

/** A position in 0..50, whole. */
export function clampPosition(position: number): number {
  return Math.round(Math.min(MAX_POSITION, Math.max(0, position)));
}

/** The position that puts the left edge at `left` px: the inverse of the `.file-pos` flex share, clamped to 0..50 (not rounded). */
export function positionAt(left: number, text: number, image: number): number {
  const room = text - image;
  return room > 0 ? Math.min(MAX_POSITION, Math.max(0, (left / room) * MAX_POSITION)) : 0;
}

export function fileEmbed(id: string, alias?: ImageAlias | null, embedId?: string | null): string {
  const use = embedId ? `#${embedId}` : "";
  const written = formatImageAlias(alias);
  return written ? `![[plik:${id}${use}|${written}]]` : `![[plik:${id}${use}]]`;
}

const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A new embed id: one use of a file in a note (8 hex). */
export const newEmbedId = (): string => randomHex(4);

export function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
}

/** A new file id: 128 random bits, lowercase hex. The id never changes; renaming changes only the name. */
export const newFileId = (): string => randomHex(16);

export type FileState = "uploading" | "ready" | "trashed" | "missing";

export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  /** Plaintext bytes. */
  size: number;
  /** The project folder the file belongs to (`Projekty/X`), or null for the whole space. */
  project: string | null;
  state: FileState;
  createdAt: number;
  createdBy: string | null;
  /** When it went to the trash; it is purged `trashDays` later. */
  deletedAt: number | null;
  /** Images: the id of the encrypted thumbnail file, and the original's pixel size, when known. */
  thumb?: string | null;
  width?: number | null;
  height?: number | null;
  /** Set on a thumbnail: the image it belongs to. Lists leave thumbnails out. */
  thumbOf?: string | null;
  /** Video: its length in ms, when known. */
  durationMs?: number | null;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Plaintext bytes decrypted so far, and the total; called after each 1 MiB chunk, the last call with done === total. */
  onProgress?(done: number, total: number): void;
}

export interface FileHead { blob: Blob; complete: boolean }

/** A video's first-frame thumbnail, with the length of the video when it is known. */
export interface VideoThumb { blob: Blob; width: number; height: number; durationMs?: number }

export interface FileList {
  files: FileInfo[];
  /** Bytes stored for this space (encrypted size, trash included) and the space's limit (null: none). */
  used: number;
  quota: number | null;
  trashDays: number;
}

export interface UploadOptions {
  /** The id already written into the note. Uploading the same id again resumes or returns the finished file. */
  id: string;
  /** The project folder of the note it goes into (protected projects encrypt it with the project key). */
  project?: string | null;
  onProgress?(sent: number, total: number): void;
  signal?: AbortSignal;
  /** Images and videos: a small preview made on this device (thumbnail.ts), uploaded encrypted as its own file; a video's
   * length comes with it. */
  thumbnail?: { blob: Blob; width: number; height: number; durationMs?: number } | null;
}

export interface FileStore {
  upload(file: File, options: UploadOptions): Promise<FileInfo>;
  /** Everything this user may see; files of protected projects they are not in are left out. */
  list(): Promise<FileList>;
  /** null: no such file, or not this user's to see (the two are not told apart). */
  info(id: string): Promise<FileInfo | null>;
  /** The decrypted bytes, typed with the file's MIME type. */
  read(id: string, options?: ReadOptions): Promise<Blob>;
  /** At most `maxBytes` of plaintext from the start, in whole 1 MiB chunks (the last may be shorter); the download stops
   * after the last chunk needed. `complete` when that is the whole file. */
  readHead(id: string, maxBytes: number, options?: ReadOptions): Promise<FileHead>;
  /** Adds a thumbnail to a file that has none (old videos): it goes up as its own file, then the original's envelope gets
   * `thumb` and `duration`. Does nothing when the file already has a thumbnail. Editor role or higher. */
  setThumbnail(id: string, thumb: VideoThumb): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /** Stops an upload and drops what reached the server. A finished file is not touched. */
  cancel(id: string): Promise<void>;
  /** Called after anything changes (an upload finished, a rename, the trash), with the file's id when it is one file. */
  onChange(cb: (id?: string) => void): () => void;
  /** Called once an upload is ready, with the file as the user gave it (the bytes are not stored again by the caller). */
  onUploaded(cb: (info: FileInfo, file: File) => void): () => void;
}

/** A store that keeps OCR text layers (docs/OCR.md §3.2): optional, so a store without them only lacks the feature. */
export interface TextLayers {
  /** The text layers this user can open, by the id of their original; the newest extractor wins. */
  textLayers(): Promise<Map<string, TextLayerInfo>>;
  /** Writes the layer of `originalId`; returns its id. A layer that already exists is not written again. */
  writeTextLayer(originalId: string, markdown: string, fields: TextLayerFields, signal?: AbortSignal): Promise<string>;
  /** The Markdown of the layer `id` of `originalId`. */
  readTextLayer(id: string, originalId: string, options?: ReadOptions): Promise<string>;
}

export function textLayersOf(store: FileStore | null | undefined): store is FileStore & TextLayers {
  return !!store && typeof (store as Partial<TextLayers>).writeTextLayer === "function" && typeof (store as Partial<TextLayers>).readTextLayer === "function" && typeof (store as Partial<TextLayers>).textLayers === "function";
}

/** The backend's file store, or null when it has none (the desktop app, for now). */
export function filesOf(bridge: Bridge): FileStore | null {
  return (bridge as { files?: FileStore | null }).files ?? null;
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
// The plaintext chunk of a server file (docs/PLIKI.md §2). Copied here, not imported from filecrypto.ts: bridge.ts imports
// this module, and filecrypto.ts pulls in the vault code.
const PLAIN_CHUNK = 1048576;

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(mime); // no SVG inline: it can carry script
}

/** Kind for icons and the type filter. */
export type FileKind = "image" | "pdf" | "document" | "sheet" | "slides" | "archive" | "audio" | "video" | "other";

const BY_EXT: Record<string, FileKind> = {
  pdf: "pdf",
  doc: "document", docx: "document", odt: "document", rtf: "document", txt: "document", md: "document",
  xls: "sheet", xlsx: "sheet", ods: "sheet", csv: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides", key: "slides",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", tgz: "archive",
};

export function fileKind(name: string, mime: string): FileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return BY_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "other";
}

export const KIND_LABEL: Record<FileKind, string> = {
  image: "Obraz", pdf: "PDF", document: "Dokument", sheet: "Arkusz", slides: "Prezentacja",
  archive: "Archiwum", audio: "Dźwięk", video: "Wideo", other: "Inny",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("pl-PL", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

// --- In memory: demo (`?demo=1`) and tests. Same rules as the server: ids are fixed, a re-upload of an id resumes.

export class MemoryFileStore implements FileStore, TextLayers {
  private files = new Map<string, { info: FileInfo; bytes: Uint8Array }>();
  private listeners = new Set<(id?: string) => void>();
  private uploadListeners = new Set<(info: FileInfo, file: File) => void>();
  // Text layers by id, kept apart from the files: they are not listed and not counted.
  private layers = new Map<string, { info: TextLayerInfo; markdown: string }>();
  /** Test hooks: delay per upload step (ms), and an error thrown once by the next upload. */
  stepDelay = 0;
  failNext: Error | null = null;
  quota: number | null = 200 * 1024 * 1024;

  constructor(private readonly who: string | null = null) {}

  async upload(file: File, options: UploadOptions): Promise<FileInfo> {
    const done = this.files.get(options.id);
    if (done && done.info.state !== "uploading") return { ...done.info };
    if (file.size > MAX_FILE_BYTES) throw new Error(`Plik jest większy niż ${formatSize(MAX_FILE_BYTES)}.`);
    if (this.quota !== null && this.used() + file.size > this.quota) throw new Error("Brak miejsca na pliki w tej przestrzeni.");
    const thumb = options.thumbnail ? await this.putThumb(options.thumbnail.blob, file.name, options.id, options.project ? projectOfNote(options.project) : null) : null;
    const info: FileInfo = { id: options.id, name: file.name || "plik", mime: file.type || "application/octet-stream", size: file.size, project: options.project ? projectOfNote(options.project) ?? (options.project.endsWith(".md") ? null : options.project) : null, state: "uploading", createdAt: Date.now(), createdBy: this.who, deletedAt: null, thumb, width: options.thumbnail?.width ?? null, height: options.thumbnail?.height ?? null, durationMs: options.thumbnail?.durationMs === undefined ? null : Math.round(options.thumbnail.durationMs) };
    this.files.set(info.id, { info, bytes: new Uint8Array() });
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      if (this.stepDelay) await new Promise((r) => setTimeout(r, this.stepDelay));
      if (options.signal?.aborted) { this.files.delete(info.id); if (thumb) this.files.delete(thumb); throw new DOMException("Anulowano", "AbortError"); }
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      options.onProgress?.(Math.round((file.size * i) / steps), file.size);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    info.state = "ready";
    this.files.set(info.id, { info, bytes });
    this.changed(info.id);
    for (const cb of this.uploadListeners) cb({ ...info }, file);
    return { ...info };
  }

  onUploaded(cb: (info: FileInfo, file: File) => void): () => void {
    this.uploadListeners.add(cb);
    return () => this.uploadListeners.delete(cb);
  }

  async textLayers(): Promise<Map<string, TextLayerInfo>> {
    const out = new Map<string, TextLayerInfo>();
    for (const { info } of this.layers.values()) {
      if (this.files.get(info.textOf)?.info.state !== "ready") continue;
      const known = out.get(info.textOf);
      if (!known || known.extractor < info.extractor) out.set(info.textOf, { ...info, flags: [...info.flags] });
    }
    return out;
  }

  async writeTextLayer(originalId: string, markdown: string, fields: TextLayerFields, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("Anulowano", "AbortError");
    const original = this.files.get(originalId);
    if (!original || original.info.state !== "ready" || original.info.thumbOf) throw new Error("Nie ma tego pliku albo nie można go odczytać.");
    const doc = parseFileText(markdown);
    if (doc?.source !== originalId || doc.extractor !== fields.extractor) throw new Error("Tekst pliku jest uszkodzony.");
    const id = `text-${originalId}-${fields.extractor}`;
    if (!this.layers.has(id)) {
      const info: TextLayerInfo = { ...fields, flags: [...fields.flags], id, textOf: originalId, createdAt: Date.now(), createdBy: this.who };
      this.layers.set(id, { info, markdown });
    }
    return id;
  }

  async readTextLayer(id: string, originalId: string): Promise<string> {
    const layer = this.layers.get(id);
    if (!layer || layer.info.textOf !== originalId) throw new Error("Nie ma tekstu tego pliku.");
    return layer.markdown;
  }

  async list(): Promise<FileList> {
    return { files: [...this.files.values()].filter((f) => f.info.state !== "uploading" && !f.info.thumbOf).map((f) => ({ ...f.info })), used: this.used(), quota: this.quota, trashDays: 30 };
  }

  async info(id: string): Promise<FileInfo | null> {
    const f = this.files.get(id);
    return f ? { ...f.info } : null;
  }

  async read(id: string, options?: ReadOptions): Promise<Blob> {
    return (await this.head(id, Infinity, options)).blob;
  }

  async readHead(id: string, maxBytes: number, options?: ReadOptions): Promise<FileHead> {
    if (!(maxBytes > 0)) throw new RangeError("maxBytes must be positive");
    return this.head(id, Math.max(1, Math.ceil(maxBytes / PLAIN_CHUNK)), options);
  }

  async setThumbnail(id: string, thumb: VideoThumb): Promise<void> {
    const f = this.must(id);
    if (f.info.thumb) return;
    f.info.thumb = await this.putThumb(thumb.blob, f.info.name, id, f.info.project);
    if (thumb.durationMs !== undefined) f.info.durationMs = Math.round(thumb.durationMs);
    this.changed(id);
  }

  // The first `chunks` chunks (all of them for Infinity), copied a chunk at a time with progress and abort after each.
  private async head(id: string, chunks: number, options: ReadOptions = {}): Promise<FileHead> {
    const f = this.files.get(id);
    if (!f || f.info.state !== "ready" && f.info.state !== "trashed") throw new Error("Nie ma takiego pliku.");
    const end = Math.min(f.info.size, chunks * PLAIN_CHUNK);
    const complete = chunks >= Math.max(1, Math.ceil(f.info.size / PLAIN_CHUNK));
    if (options.signal?.aborted) throw new DOMException("Anulowano", "AbortError");
    const parts: Uint8Array[] = [];
    let done = 0;
    do {
      const next = Math.min(end, done + PLAIN_CHUNK);
      parts.push(f.bytes.slice(done, next));
      done = next;
      options.onProgress?.(done, end);
      if (options.signal?.aborted) throw new DOMException("Anulowano", "AbortError");
    } while (done < end);
    return { blob: new Blob(parts as BlobPart[], { type: f.info.mime }), complete };
  }

  async rename(id: string, name: string): Promise<void> {
    this.must(id).info.name = name;
    this.changed(id);
  }

  async trash(id: string): Promise<void> {
    const f = this.must(id);
    for (const x of [f, this.thumbOf(f)]) if (x) { x.info.state = "trashed"; x.info.deletedAt = Date.now(); }
    this.changed(id);
  }

  async restore(id: string): Promise<void> {
    const f = this.must(id);
    for (const x of [f, this.thumbOf(f)]) if (x) { x.info.state = "ready"; x.info.deletedAt = null; }
    this.changed(id);
  }

  async cancel(id: string): Promise<void> {
    const f = this.files.get(id);
    if (f?.info.state !== "uploading") return;
    this.files.delete(id);
    if (f.info.thumb) this.files.delete(f.info.thumb);
  }

  onChange(cb: (id?: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private used(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.info.size;
    return n;
  }

  // A thumbnail is a file of its own, stored under its own id; it follows its image into and out of the trash.
  private async putThumb(blob: Blob, name: string, of: string, project: string | null): Promise<string> {
    const id = newFileId();
    const info: FileInfo = { id, name, mime: blob.type || "image/jpeg", size: blob.size, project, state: "ready", createdAt: Date.now(), createdBy: this.who, deletedAt: null, thumbOf: of };
    this.files.set(id, { info, bytes: new Uint8Array(await blob.arrayBuffer()) });
    return id;
  }

  private thumbOf(f: { info: FileInfo }) {
    return f.info.thumb ? this.files.get(f.info.thumb) : undefined;
  }

  private must(id: string) {
    const f = this.files.get(id);
    if (!f) throw new Error("Nie ma takiego pliku.");
    return f;
  }

  private changed(id?: string): void {
    for (const cb of this.listeners) cb(id);
  }
}

/** The project a note belongs to: `Projekty/<Name>/…` is project `Projekty/<Name>` (the rule of browserauth's projectFolder). */
export function projectOfNote(path: string): string | null {
  return /^(Projekty\/[^/]+)\//.exec(path)?.[1] ?? null;
}
