//! Attachments. Desktop: files pasted or dropped into a note are saved under `assets/` and linked as `![[assets/...]]`.
//! Browser (a backend with a FileStore, docs/PLIKI.md): the note gets `![[plik:<id>#<embedId>]]` at once and the bytes
//! upload behind it. The embed is the file's place in the note, so edits around it never move it. Live Preview and the
//! reading view show images and chips for both kinds.

import { EditorState, Facet, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import type { Bridge } from "./bridge";
import {
  ALIAS_PATTERN, clampWidth, embedPattern, FILE_EMBED, fileEmbed, type FileInfo, fileKind, type FileStore, filesOf, formatImageAlias,
  clampPosition, formatSize, type ImageAlias, type ImageAlign, isImageMime, KIND_LABEL, MAX_POSITION, MAX_WIDTH, MIN_WIDTH, newEmbedId,
  newFileId, parseImageAlias, positionAt,
} from "./filestore";
import { foldedFolders } from "./filefolders";
import { embeddedIds, previewEmbeds } from "./preview/triggers";
import { autoLoadImages, onSettingChanged } from "./settings";
import { thumbnailFor, type Thumbnail } from "./thumbnail";
import { errorText, type MenuEntry, openDialog, openMenu, toast } from "./widgets";

// `![[assets/name.png]]`: the embed of a desktop attachment. `|W`, `|WxH` and a placement give an image its alias.
export const EMBED = new RegExp(String.raw`!\[\[(assets\/[^\]\n|]+)(?:\|(${ALIAS_PATTERN}))?\]\]`, "g");
// Both kinds: a server file (groups of FILE_EMBED: id, embed id, alias), or a desktop attachment (group 4; alias in 5).
const ANY = new RegExp(String.raw`${FILE_EMBED.source}|!\[\[(assets/[^\]\n|]+)(?:\|(${ALIAS_PATTERN}))?\]\]`, "g");
const TEXT_PREVIEW_BYTES = 512 * 1024;
const DOUBLE_CLICK_MS = 400; // a click on a picture opens it after this, unless a double click follows
const URL_LIFETIME_MS = 60_000;
const PROGRESS_MS = 250;
// Decrypted files kept in this tab (docs/PLIKI.md §6): the least recently used go first when the limit is reached.
const CACHE_BYTES = 64 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

export function embedText(rel: string): string {
  return `![[${rel}]]`;
}

export function isImage(rel: string): boolean {
  return rel.slice(rel.lastIndexOf(".") + 1).toLowerCase() in MIME;
}

/** The server file of the embed `pos` is in (its borders count), or null: the palette's "Podgląd pliku" uses it. */
export function embedAt(text: string, pos: number): string | null {
  for (const m of text.matchAll(FILE_EMBED)) {
    const start = m.index ?? 0;
    if (pos >= start && pos <= start + m[0].length) return m[1];
  }
  return null;
}

/** Saves each file and returns its embed, in order. */
export async function saveFiles(bridge: Bridge, files: File[]): Promise<string[]> {
  const embeds: string[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rel = await bridge.call<string>("save_attachment", { name: file.name || "plik", bytes });
    embeds.push(embedText(rel));
  }
  return embeds;
}

/** An object URL with the image's bytes. The caller revokes it when the image is no longer shown. */
export async function imageUrl(bridge: Bridge, rel: string): Promise<string> {
  const bytes = await bridge.call<Uint8Array>("read_attachment", { rel });
  const type = MIME[rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}


// What the editor needs to upload: the bridge (its store), how to report errors, and the note's project.
interface AttachConfig {
  bridge: Bridge;
  onError(message: string): void;
  project(): string | null;
}
const attachConfig = Facet.define<AttachConfig, AttachConfig | null>({ combine: (values) => values[0] ?? null });

const storeOf = (view: EditorView): FileStore | null => {
  const cfg = view.state.facet(attachConfig);
  return cfg ? filesOf(cfg.bridge) : null;
};

/** The bridge the note's attachments go through (null before the editor has its attachment handlers). */
export const bridgeOf = (state: EditorState): Bridge | null => state.facet(attachConfig)?.bridge ?? null;

// SVG is shown only as an <img> (scripts do not run there); every other type that is not an allowed picture is a chip.
const showsAsImage = (mime: string): boolean => isImageMime(mime) || mime === "image/svg+xml";

// --- Uploads in progress. The registry is the source of truth for the upload widgets; the document holds the embeds.

interface Upload {
  id: string;
  file: File;
  project: string | null;
  sent: number;
  total: number;
  error: string | null;
  abort: AbortController;
  thumb?: Promise<Thumbnail | null>;
}
const uploads = new Map<string, Upload>();

// Every live editor view redraws when this runs (progress, a finished file, a change on the server).
const redraws = new Set<() => void>();
const redrawAll = (): void => {
  for (const cb of redraws) cb();
};
const redrawEffect = StateEffect.define<null>();

// The file info the embeds show, per id. It is dropped when the store reports a change.
let infoStore: FileStore | null = null;
const infos = new Map<string, FileInfo | null>();
const loading = new Set<string>();

/** undefined while the info loads (the embed redraws when it arrives). */
function infoOf(store: FileStore, id: string): FileInfo | null | undefined {
  if (store !== infoStore) {
    infoStore = store;
    infos.clear();
    loading.clear();
  }
  if (infos.has(id)) return infos.get(id);
  if (!loading.has(id)) {
    loading.add(id);
    store
      .info(id)
      .then((info) => infos.set(id, info), () => infos.set(id, null))
      .finally(() => {
        loading.delete(id);
        redrawAll();
      });
  }
  return undefined;
}

function startUpload(store: FileStore, u: Upload): void {
  let shown = 0;
  const abort = new AbortController();
  u.abort = abort;
  u.error = null;
  u.sent = 0;
  const thumb = (u.thumb ??= thumbnailFor(u.file));
  void thumb
    .then((thumbnail) =>
      store.upload(u.file, {
        id: u.id,
        project: u.project,
        signal: abort.signal,
        thumbnail,
        onProgress(sent, total) {
          u.sent = sent;
          u.total = total;
          // a redraw rebuilds every editor's embeds: a few times a second is enough for a progress bar
          const now = Date.now();
          if (sent < total && now - shown < PROGRESS_MS) return;
          shown = now;
          redrawAll();
        },
      }),
    )
    .then(
      () => {
        infos.delete(u.id);
        if (uploads.get(u.id) === u) uploads.delete(u.id);
        redrawAll();
      },
      (e: unknown) => {
        // a cancelled upload already left the registry; its error is not shown
        if (abort.signal.aborted || uploads.get(u.id) !== u) return;
        u.error = `Nie udało się wysłać pliku: ${errorText(e)}`;
        redrawAll();
      },
    );
}

// The embed text for this id, as it stands in the document (every copy of it).
function removeEmbeds(view: EditorView, id: string): void {
  const text = view.state.doc.toString();
  const changes = [...text.matchAll(new RegExp(embedPattern(id), "g"))].map((m) => ({
    from: m.index ?? 0,
    to: (m.index ?? 0) + m[0].length,
  }));
  if (changes.length) view.dispatch({ changes });
}

export function dropUpload(view: EditorView, id: string): void {
  uploads.get(id)?.abort.abort();
  uploads.delete(id);
  void storeOf(view)?.cancel(id).catch(() => {});
  removeEmbeds(view, id);
  redrawAll();
}

// Writes the embed text at `at` (the cursor when omitted) and leaves the cursor after it.
function place(view: EditorView, text: string, at?: number): void {
  if (at === undefined) {
    view.dispatch(view.state.replaceSelection(text));
    return;
  }
  const pos = Math.min(at, view.state.doc.length);
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
}

/** Writes the embed text somewhere in the note (see placeLater). */
type Put = (text: string) => void;

// Where the files picked now go. The system dialog keeps the note open, so typing and remote edits may move the text:
// a Yjs position follows the note's Y.Text; without a Y.Doc a CodeMirror position follows every change (anchorField).
const anchorEffect = StateEffect.define<number>();
const anchorField = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(anchorEffect)) return e.value;
    return pos === null ? null : tr.changes.mapPos(pos, 1);
  },
});

function placeLater(view: EditorView): Put {
  const head = view.state.selection.main.head;
  const sync = view.state.facet(ySyncFacet);
  if (sync) {
    const ytext = sync.ytext as Y.Text;
    const rel = Y.createRelativePositionFromTypeIndex(ytext, head);
    return (text) => {
      const index = Y.createAbsolutePositionFromRelativePosition(rel, ytext.doc!)?.index ?? ytext.length;
      if (view.state.facet(ySyncFacet) === sync) place(view, text, index);
      // the note is not on screen any more: its Y.Text takes the text, and its view follows when shown again
      else ytext.doc!.transact(() => ytext.insert(index, text), sync);
    };
  }
  view.dispatch({ effects: anchorEffect.of(head) });
  return (text) => place(view, text, view.state.field(anchorField) ?? undefined);
}

/**
 * Paste, drop and the slash menu. With a server store each file's embed goes in at once, then its upload runs in
 * the background; the embed stays where it was put. On the desktop the files are saved first, as before.
 */
export async function insertFiles(view: EditorView, files: File[], put: Put = (text) => place(view, text)): Promise<void> {
  const cfg = view.state.facet(attachConfig);
  if (!cfg || files.length === 0) return;
  const store = filesOf(cfg.bridge);
  if (!store) {
    try {
      put((await saveFiles(cfg.bridge, files)).join("\n"));
    } catch (e) {
      cfg.onError(errorText(e));
    }
    return;
  }
  const started: Upload[] = files.map((file) => ({
    id: newFileId(),
    file,
    project: cfg.project(),
    sent: 0,
    total: file.size,
    error: null,
    abort: new AbortController(),
  }));
  for (const u of started) uploads.set(u.id, u);
  put(started.map((u) => fileEmbed(u.id, undefined, newEmbedId())).join("\n"));
  for (const u of started) startUpload(store, u);
}

let picker: HTMLInputElement | null = null;

/** The slash menu's "Dodaj plik": the system picker; the files go in where the command was typed. */
export function pickFiles(view: EditorView): void {
  if (!view.state.facet(attachConfig)) return;
  if (!picker?.isConnected) {
    picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    document.body.append(picker);
  }
  const input = picker;
  const put = placeLater(view);
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    void insertFiles(view, files, put);
  };
  input.click();
}

// A pasted embed whose embed id is already in the note is a copy: it gets a new id (docs/PLIKI.md §1). A cut and
// paste (a move) keeps the id, since the original is gone. Only pastes and drops are touched, never remote text.
const EMBED_ID = /(!\[\[plik:[0-9a-f]{32}#)([0-9a-f]{8})(?=[|\]])/g;

function embedIdCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(EMBED_ID)) counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
  return counts;
}

const copyGetsNewEmbed = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop"))) return tr;
  const inserted: Array<{ from: number; to: number; text: string }> = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, text) => inserted.push({ from, to, text: text.toString() }));
  const pasted = embedIdCounts(inserted.map((i) => i.text).join("\n"));
  if (pasted.size === 0) return tr;
  const inDoc = embedIdCounts(tr.newDoc.toString());
  const fresh = new Map<string, string>();
  for (const [id, n] of pasted) if ((inDoc.get(id) ?? 0) > n) fresh.set(id, newEmbedId());
  if (fresh.size === 0) return tr;
  // same length (8 hex for 8 hex), so the selection and the other changes stay where they are
  return {
    changes: inserted.map(({ from, to, text }) => ({
      from,
      to,
      insert: text.replace(EMBED_ID, (_all, head: string, id: string) => head + (fresh.get(id) ?? id)),
    })),
    selection: tr.selection,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});

/** Paste and drop: files go in at the cursor (or the drop point), through the same flow as the slash menu. */
export function attachmentHandlers(
  bridge: Bridge,
  onError: (message: string) => void,
  project: () => string | null = () => null,
): Extension {
  return [
    attachConfig.of({ bridge, onError, project }),
    anchorField,
    copyGetsNewEmbed,
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return false;
        event.preventDefault();
        void insertFiles(view, files);
        return true;
      },
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
        void insertFiles(view, files, (text) => place(view, text, at));
        return true;
      },
    }),
  ];
}

// --- Owners of object URLs: released together by their owner (a widget, or one paint of the reading view).

export class Owner {
  private urls: string[] = [];
  private stops: Array<() => void> = [];
  private done = false;

  /** false (the URL is released at once) when the owner is already gone. */
  add(url: string): boolean {
    if (this.done) {
      URL.revokeObjectURL(url);
      return false;
    }
    this.urls.push(url);
    return true;
  }

  /** Runs `stop` when the owner is released (a lazy load that has not happened yet is cancelled). */
  track(stop: () => void): void {
    if (this.done) stop();
    else this.stops.push(stop);
  }

  release(): void {
    this.done = true;
    for (const url of this.urls) URL.revokeObjectURL(url);
    for (const stop of this.stops) stop();
    this.urls = [];
    this.stops = [];
  }
}

// Decrypted bytes, most recently used last. Plaintext is held only here, never in storage.
export class BlobCache {
  private readonly blobs = new Map<string, Blob>();
  private total = 0;

  constructor(private readonly limit: number) {}

  get bytes(): number {
    return this.total;
  }

  get(key: string): Blob | undefined {
    const blob = this.blobs.get(key);
    if (blob) {
      this.blobs.delete(key);
      this.blobs.set(key, blob);
    }
    return blob;
  }

  set(key: string, blob: Blob): void {
    this.drop(key);
    if (blob.size > this.limit) return;
    this.blobs.set(key, blob);
    this.total += blob.size;
    for (const [old, b] of this.blobs) {
      if (this.total <= this.limit) break;
      this.blobs.delete(old);
      this.total -= b.size;
    }
  }

  clear(): void {
    this.blobs.clear();
    this.total = 0;
  }

  private drop(key: string): void {
    const blob = this.blobs.get(key);
    if (!blob) return;
    this.blobs.delete(key);
    this.total -= blob.size;
  }
}

const cache = new BlobCache(CACHE_BYTES);
let cacheStore: FileStore | null = null;
const reading = new Map<string, Promise<Blob>>();

/** A file's bytes, from this tab's cache when it is there. */
function readCached(store: FileStore, id: string): Promise<Blob> {
  if (store !== cacheStore) {
    cacheStore = store;
    cache.clear();
    reading.clear();
  }
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = reading.get(id);
  if (pending) return pending;
  const read = store
    .read(id)
    .then((blob) => {
      cache.set(id, blob);
      return blob;
    })
    .finally(() => reading.delete(id));
  reading.set(id, read);
  return read;
}

const note = (text: string): HTMLElement => {
  const el = document.createElement("span");
  el.className = "file-note";
  el.textContent = text;
  return el;
};

const unavailable = (): string => (navigator.onLine === false ? "Plik jest niedostępny bez połączenia" : "Plik jest niedostępny");

const canPreview = (info: FileInfo): boolean =>
  info.mime === "application/pdf" || info.mime.startsWith("text/") || /^(audio|video)\//.test(info.mime);

export async function download(store: FileStore, info: FileInfo): Promise<void> {
  try {
    const url = URL.createObjectURL(await store.read(info.id));
    const a = document.createElement("a");
    a.href = url;
    a.download = info.name; // a download, never a navigation: the content is not run
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS);
  } catch (e) {
    toast(`Nie udało się pobrać pliku: ${errorText(e)}`, true);
  }
}

async function preview(store: FileStore, info: FileInfo): Promise<void> {
  try {
    const blob = await store.read(info.id);
    if (info.mime === "application/pdf") {
      // opened in a new tab by the browser's own viewer; typed here, so nothing else can be rendered as it
      const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS);
      return;
    }
    if (info.mime.startsWith("text/")) {
      const text = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
      openDialog({
        label: `Podgląd: ${info.name}`,
        className: "file-preview",
        render(box) {
          const pre = document.createElement("pre");
          pre.className = "file-text";
          pre.textContent = text; // text only, never HTML
          box.append(pre);
        },
      });
      return;
    }
    const url = URL.createObjectURL(blob);
    openDialog({
      label: `Podgląd: ${info.name}`,
      className: "file-preview",
      onClose: () => URL.revokeObjectURL(url),
      render(box) {
        const media = document.createElement(info.mime.startsWith("audio/") ? "audio" : "video");
        media.controls = true;
        media.className = "file-media";
        media.src = url;
        box.append(media);
      },
    });
  } catch (e) {
    toast(`Nie udało się otworzyć podglądu: ${errorText(e)}`, true);
  }
}

/** A picture at full size, in a dialog (Escape or a click outside closes it); its URL is released on close. */
function openImage(store: FileStore, info: FileInfo): void {
  const urls = new Owner();
  openDialog({
    label: `Podgląd: ${info.name}`,
    className: "file-preview",
    onClose: () => urls.release(),
    render(box) {
      const img = document.createElement("img");
      img.className = "file-full";
      img.alt = info.name;
      box.append(img);
      readCached(store, info.id).then(
        (blob) => {
          const url = URL.createObjectURL(blob);
          if (urls.add(url)) img.src = url;
        },
        () => img.replaceWith(note(unavailable())),
      );
    },
  });
}

function chip(store: FileStore, info: FileInfo): HTMLElement {
  const el = document.createElement("span");
  el.className = "file-chip";
  const kind = document.createElement("span");
  kind.className = "file-kind";
  kind.textContent = KIND_LABEL[fileKind(info.name, info.mime)];
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = info.name;
  const size = document.createElement("span");
  size.className = "file-size";
  size.textContent = formatSize(info.size);
  el.append(kind, name, size);
  if (canPreview(info)) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "file-open";
    open.textContent = "Otwórz";
    open.title = `Otwórz: ${info.name}`;
    open.setAttribute("aria-label", `Otwórz plik ${info.name}`);
    open.addEventListener("click", () => void preview(store, info));
    el.append(open);
  }
  const get = document.createElement("button");
  get.type = "button";
  get.className = "file-download";
  get.textContent = "Pobierz";
  get.title = `Pobierz: ${info.name}`;
  get.setAttribute("aria-label", `Pobierz plik ${info.name}`);
  get.addEventListener("click", () => void download(store, info));
  el.append(get);
  return el;
}

/** Calls `load` once the element is on screen (at once where IntersectionObserver is missing). */
function whenVisible(el: Element, load: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    load();
    return () => {};
  }
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    load();
  });
  io.observe(el);
  return () => io.disconnect();
}

/** A picture loads when it is on screen; with the setting off, a button "Wyświetl obraz" loads it on request. */
function lazyLoad(box: HTMLElement, auto: boolean, load: () => void, owner: Owner): void {
  if (auto) {
    owner.track(whenVisible(box, load));
    return;
  }
  const show = document.createElement("button");
  show.type = "button";
  show.className = "file-show";
  show.textContent = "Wyświetl obraz";
  show.addEventListener("click", () => {
    show.remove();
    load();
  });
  box.append(show);
}

// A picture that loads when it comes into view. `frame` puts the image in what is shown once it has loaded.
function lazyPicture(alt: string, alias: ImageAlias | null, urls: Owner, auto: boolean, url: () => Promise<string>, failed: () => string, frame: (img: HTMLImageElement) => HTMLElement): HTMLElement {
  const box = document.createElement("span");
  box.className = "file-image-box";
  const img = document.createElement("img");
  img.className = "embed-image";
  img.alt = alt;
  if (alias?.width) img.style.width = `${alias.width}px`;
  if (alias?.height) {
    img.style.height = `${alias.height}px`;
    img.classList.add("embed-exact"); // a height the note cannot fit keeps its proportions (attachments.css)
  }
  const shown = frame(img);
  shown.hidden = true;
  const status = note("");
  box.append(shown, status);
  lazyLoad(box, auto, () => {
    status.textContent = "Wczytywanie…";
    url().then(
      (src) => {
        if (!urls.add(src)) return;
        img.src = src;
        shown.hidden = false;
        status.remove();
      },
      () => {
        status.textContent = failed();
      },
    );
  }, urls);
  return box;
}

/** A server picture: its thumbnail first (when there is one), the original in the preview on click. */
function imageNode(store: FileStore, id: string, info: FileInfo, alias: ImageAlias | null, urls: Owner, auto: boolean): HTMLElement {
  // the blob's type comes from the allow list (showsAsImage): never inline, see the header
  const url = () => readCached(store, info.thumb || id).then((blob) => URL.createObjectURL(blob));
  return lazyPicture(info.name, alias, urls, auto, url, unavailable, (img) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-image";
    button.title = "Powiększ";
    button.setAttribute("aria-label", `Powiększ obraz ${info.name}`);
    button.append(img);
    // A double click previews the file (previewActions), so the first click waits out the double-click time: the full-size
    // dialog would otherwise cover the second click.
    let wait = 0;
    button.addEventListener("click", () => {
      clearTimeout(wait);
      wait = window.setTimeout(() => openImage(store, info), DOUBLE_CLICK_MS);
    });
    button.addEventListener("dblclick", () => clearTimeout(wait));
    return button;
  });
}

/** A finished file's own DOM: a picture or a chip, or a muted note when it cannot be shown. Object URLs go to `urls`. */
function fileNode(store: FileStore, id: string, info: FileInfo | null | undefined, alias: ImageAlias | null, urls: Owner, auto: boolean): HTMLElement {
  if (info === undefined) return note("Wczytywanie…");
  if (info === null) return note("Plik niedostępny");
  if (info.state === "trashed") return note("Plik w koszu");
  if (info.state !== "ready") return note(info.state === "uploading" ? "Wysyłanie w toku…" : "Plik niedostępny");
  if (!showsAsImage(info.mime)) return chip(store, info);
  return imageNode(store, id, info, alias, urls, auto);
}

/** The paint of a legacy embed (desktop): an image placed by its alias (the URL goes to `urls`). */
function legacyImage(bridge: Bridge, rel: string, alias: ImageAlias | null, urls: Owner, auto: boolean, editor: boolean): HTMLElement {
  const box = lazyPicture(rel, alias, urls, auto, () => imageUrl(bridge, rel), () => `Nie można wczytać obrazu: ${rel}`, (img) => img);
  placeClasses(box, alias, editor);
  return box;
}

// Placement choices of an image, as its select shows them.
const ALIGN_LABELS: Array<[string, string]> = [
  ["", "Domyślnie"],
  ["left", "Do lewej"],
  ["center", "Środek"],
  ["right", "Do prawej"],
  ["wrap-left", "Opływ z lewej"],
  ["wrap-right", "Opływ z prawej"],
];

// The placement classes (attachments.css). In the editor a wrap shows as the block on its side: a float would break the line.
function alignClasses(alias: ImageAlias | null, editor: boolean): string[] {
  const align = alias?.align;
  return align ? [`file-align-${editor ? align.replace("wrap-", "") : align}`] : [];
}

const DRAG_START_PX = 4; // a press moves the picture only after this many pixels

// Places an element by its alias: a position (`.file-pos`, its share of the line in --pos) overrides the align classes.
function placeClasses(el: HTMLElement, alias: ImageAlias | null, editor: boolean): void {
  if (alias?.position != null) {
    el.classList.add("file-pos");
    el.style.setProperty("--pos", String(alias.position));
  } else {
    el.classList.add(...alignClasses(alias, editor));
  }
}

// The text box of a note line that a picture sits in: its left edge and width (the content box of the line).
function textBox(el: HTMLElement): { left: number; width: number } {
  const host = el.parentElement ?? el;
  const style = getComputedStyle(host);
  const left = host.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  return { left, width: host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
}

// The height per width of the original picture, when the file records its size.
const ratioOf = (info: FileInfo | null | undefined): number | null => (info?.width && info.height ? info.height / info.width : null);

// Whether the image controls keep the picture's proportions. It stays as chosen while the note is open.
let keepRatio = true;

// The embed text of a file with this id, at the position the widget was drawn for. Nothing is written when the text
// there is not that embed (the note changed under it). A change keeps the embed id, unless another embed of the
// note has it: then this copy gets a new one, so the two can differ.
function commitAlias(el: HTMLElement, alias: ImageAlias): void {
  const view = EditorView.findFromDOM(el);
  const id = el.dataset.id ?? "";
  if (!view || !/^[0-9a-f]{32}$/.test(id)) return;
  const from = view.posAtDOM(el);
  const match = new RegExp(`^${embedPattern(id)}`).exec(view.state.doc.sliceString(from, from + 80));
  if (!match) return;
  const old = match[1];
  const doc = view.state.doc.toString();
  const shared = old !== undefined && [...doc.matchAll(new RegExp(`#${old}(?=[|\\]])`, "g"))].length > 1;
  const text = fileEmbed(id, alias, old && !shared ? old : newEmbedId());
  if (text !== match[0]) view.dispatch({ changes: { from, to: from + match[0].length, insert: text } });
}

/** The controls of a server image: the corner drag, the drag of the picture itself, and the size, ratio, placement and position fields (shown on hover and focus). */
function imageControls(el: HTMLElement, alias: ImageAlias | null, ratio: number | null): HTMLElement[] {
  const cur: ImageAlias = { width: alias?.width ?? null, height: alias?.height ?? null, align: alias?.align ?? null, position: alias?.position ?? null };
  const commit = (patch: Partial<ImageAlias>) => commitAlias(el, { ...cur, ...patch });
  // The height for a width: from the proportions while the ratio is kept, else the height already set.
  const heightFor = (width: number): number | null => (keepRatio ? (ratio ? Math.round(width * ratio) : null) : (cur.height ?? null));

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "file-resize";
  handle.title = "Przeciągnij, aby zmienić rozmiar";
  handle.setAttribute("aria-label", "Zmień rozmiar obrazu");
  handle.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    const img = el.querySelector<HTMLImageElement>("img.embed-image");
    if (!img) return;
    const startX = down.clientX;
    const startWidth = img.getBoundingClientRect().width;
    let next: number | null = null;
    const move = (e: MouseEvent) => {
      next = clampWidth(startWidth + e.clientX - startX);
      img.style.width = `${next}px`;
      const height = heightFor(next);
      img.style.height = height ? `${height}px` : "";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (next !== null) commit({ width: next, height: heightFor(next) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // Dragging the picture moves it left and right inside the line: one commit on release, so one undo step. Moving sets a
  // position (and drops the align), shown where the pointer leaves it while the drag runs. A press that moves is a drag,
  // and its click (the preview) is dropped; a press that does not move stays a click.
  let dragged = false;
  el.addEventListener(
    "click",
    (e) => {
      if (!dragged) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  const picture = el.querySelector<HTMLImageElement>("img.embed-image");
  if (picture) {
    picture.draggable = false; // a native image drag would take the pointer away
    picture.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      dragged = false;
      const text = textBox(el);
      const shown = picture.getBoundingClientRect().width;
      if (text.width <= shown) return; // no room beside the picture
      const startX = down.clientX;
      const startLeft = el.getBoundingClientRect().left - text.left;
      let next: number | null = null;
      const drag = (e: MouseEvent) => {
        if (next === null && Math.abs(e.clientX - startX) < DRAG_START_PX) return;
        dragged = true;
        const at = Math.min(text.width - shown, Math.max(0, startLeft + e.clientX - startX));
        next = positionAt(at, text.width, shown);
        el.classList.remove(...Array.from(el.classList).filter((c) => c.startsWith("file-align-")));
        el.classList.add("file-pos");
        el.style.setProperty("--pos", String(next));
      };
      const up = () => {
        window.removeEventListener("pointermove", drag);
        window.removeEventListener("pointerup", up);
        if (next !== null) commit({ align: null, position: clampPosition(next) });
      };
      window.addEventListener("pointermove", drag);
      window.addEventListener("pointerup", up);
    });
  }

  const sizeBox = (label: string, value: number | null, className: string): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = className;
    input.min = String(MIN_WIDTH);
    input.max = String(MAX_WIDTH);
    input.placeholder = "px";
    input.value = value ? String(value) : "";
    input.title = `${label} w pikselach (Enter zatwierdza)`;
    input.setAttribute("aria-label", `${label} obrazu w pikselach`);
    return input;
  };
  const width = sizeBox("Szerokość", cur.width ?? null, "file-width");
  const height = sizeBox("Wysokość", cur.height ?? null, "file-height");
  const position = document.createElement("input");
  position.type = "number";
  position.className = "file-position";
  position.min = "0";
  position.max = String(MAX_POSITION);
  position.value = cur.position != null ? String(cur.position) : "";
  position.title = "Pozycja w poziomie: 0 lewa krawędź przy lewej krawędzi notatki, 50 prawa przy prawej (Enter zatwierdza)";
  position.setAttribute("aria-label", "Pozycja obrazu w poziomie, 0 do 50");
  const onEnter = (input: HTMLInputElement, apply: (n: number) => void, min = 1) =>
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const n = Number(input.value);
      if (input.value.trim() !== "" && Number.isFinite(n) && n >= min) apply(n);
    });
  onEnter(width, (n) => commit({ width: n, height: heightFor(n) }));
  onEnter(height, (n) => {
    // a typed height sets the width by the ratio; without one the width stays (or is the picture's shown width)
    const shown = el.querySelector("img.embed-image")?.getBoundingClientRect().width ?? 0;
    const w = keepRatio && ratio ? Math.round(n / ratio) : (cur.width ?? Math.round(shown));
    commit({ width: w || null, height: n });
  });
  onEnter(position, (n) => commit({ align: null, position: clampPosition(n) }), 0);

  const ratioBox = document.createElement("input");
  ratioBox.type = "checkbox";
  ratioBox.checked = keepRatio;
  ratioBox.addEventListener("change", () => {
    keepRatio = ratioBox.checked;
  });
  const ratioText = document.createElement("span");
  ratioText.textContent = "Zachowaj proporcje";
  const ratioLabel = document.createElement("label");
  ratioLabel.className = "file-field";
  ratioLabel.append(ratioBox, ratioText);

  const align = document.createElement("select");
  align.setAttribute("aria-label", "Ułożenie obrazu");
  for (const [value, text] of ALIGN_LABELS) align.append(new Option(text, value));
  align.value = cur.align ?? "";
  // choosing a placement clears the position: the align is what shows, as the select says
  align.addEventListener("change", () => commit({ align: (align.value || null) as ImageAlign | null, position: null }));

  const field = (text: string, input: HTMLElement): HTMLLabelElement => {
    const label = document.createElement("label");
    label.className = "file-field";
    const span = document.createElement("span");
    span.textContent = text;
    label.append(span, input);
    return label;
  };
  const panel = document.createElement("div");
  panel.className = "file-controls";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Ustawienia obrazu");
  panel.append(field("Szer.", width), field("Wys.", height), ratioLabel, field("Ułożenie", align), field("Pozycja (0–50)", position));
  return [handle, panel];
}

const infoKey = (info: FileInfo | null | undefined): string =>
  info === undefined ? "loading" : info === null ? "none" : `${info.state}|${info.name}|${info.mime}|${info.size}|${info.thumb ?? ""}`;

class ImageWidget extends WidgetType {
  private readonly urls = new Owner();

  constructor(
    readonly rel: string,
    readonly alias: ImageAlias | null,
    readonly bridge: Bridge,
    readonly auto: boolean,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.rel === this.rel && formatImageAlias(other.alias) === formatImageAlias(this.alias) && other.auto === this.auto;
  }

  toDOM(): HTMLElement {
    return legacyImage(this.bridge, this.rel, this.alias, this.urls, this.auto, true);
  }

  destroy(): void {
    this.urls.release();
  }
}

/**
 * The preview and the menu of a server file's embed, in the editor and in the reading view. `files` gives the note's
 * files in order, which the preview pages through (PODGLAD-PLAN §7); `info` is the file's info once it is known.
 */
function previewActions(el: HTMLElement, store: FileStore, id: string, files: () => string[], info: () => FileInfo | null | undefined): void {
  el.addEventListener("dblclick", (e) => {
    // the chip's buttons and the picture's size controls keep their own clicks (the picture itself is a button too)
    if (e.target instanceof Element && e.target.closest("button:not(.file-image), input, .file-controls")) return;
    void previewEmbeds(store, files(), id);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // the browser's own menu would cover this one
    const found = info();
    const entries: MenuEntry[] = [{ label: "Podgląd", icon: "eye", run: () => void previewEmbeds(store, files(), id) }];
    if (found) {
      entries.push(
        { label: "Otwórz", icon: "file", run: () => openFile(store, found) },
        { label: "Pobierz", icon: "download", run: () => void download(store, found) },
      );
    }
    openMenu(e.clientX, e.clientY, entries);
  });
}

class FileWidget extends WidgetType {
  private readonly urls = new Owner();

  constructor(
    readonly id: string,
    readonly alias: ImageAlias | null,
    readonly info: FileInfo | null | undefined,
    readonly store: FileStore,
    readonly auto: boolean,
  ) {
    super();
  }

  eq(other: FileWidget): boolean {
    return other.id === this.id && formatImageAlias(other.alias) === formatImageAlias(this.alias) && other.auto === this.auto && infoKey(other.info) === infoKey(this.info);
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.classList.add("file-embed");
    placeClasses(el, this.alias, true);
    el.dataset.id = this.id;
    // the controls go in the picture's box, so their corners are the picture's (the wrapper is the line's width when placed)
    const node = fileNode(this.store, this.id, this.info, this.alias, this.urls, this.auto);
    el.append(node);
    if (el.querySelector("img.embed-image")) node.append(...imageControls(el, this.alias, ratioOf(this.info)));
    previewActions(el, this.store, this.id, () => embeddedIds(view.state.doc.toString()), () => this.info);
    return el;
  }

  ignoreEvent(): boolean {
    return true; // the buttons and the controls are the widget's own
  }

  destroy(): void {
    this.urls.release();
  }
}

// An upload in progress. Its progress is updated in place (updateDOM), so the buttons keep focus while it runs.
class UploadWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly pct: number,
    readonly error: string | null,
  ) {
    super();
  }

  eq(other: UploadWidget): boolean {
    return other.id === this.id && other.name === this.name && other.pct === this.pct && other.error === this.error;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "file-upload";
    el.setAttribute("role", "group");
    const name = document.createElement("span");
    name.className = "file-upload-name";
    const bar = document.createElement("span");
    bar.className = "file-upload-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Postęp wysyłania");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.className = "file-upload-fill";
    bar.append(fill);
    const pct = document.createElement("span");
    pct.className = "file-upload-pct";
    const error = document.createElement("span");
    error.className = "file-upload-error";
    error.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "file-upload-retry";
    retry.textContent = "Ponów";
    retry.addEventListener("click", () => {
      const view = EditorView.findFromDOM(el);
      const store = view ? storeOf(view) : null;
      const u = uploads.get(el.dataset.id ?? "");
      if (!store || !u) return;
      // the failed record is dropped first: the store keys an upload by its record, so the retry is a new one
      void store
        .cancel(u.id)
        .catch(() => {})
        .then(() => {
          if (uploads.get(u.id) === u) startUpload(store, u);
          redrawAll();
        });
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "file-upload-cancel";
    cancel.addEventListener("click", () => {
      const view = EditorView.findFromDOM(el);
      if (view) dropUpload(view, el.dataset.id ?? "");
    });
    el.append(name, bar, pct, error, retry, cancel);
    this.paint(el);
    return el;
  }

  updateDOM(dom: HTMLElement): boolean {
    this.paint(dom);
    return true;
  }

  private paint(el: HTMLElement): void {
    el.dataset.id = this.id;
    el.querySelector(".file-upload-name")!.textContent = this.name;
    const bar = el.querySelector<HTMLElement>(".file-upload-bar")!;
    bar.setAttribute("aria-valuenow", String(this.pct));
    bar.hidden = this.error !== null;
    (bar.firstElementChild as HTMLElement).style.width = `${this.pct}%`;
    el.querySelector(".file-upload-pct")!.textContent = `${this.pct}%`;
    const err = el.querySelector<HTMLElement>(".file-upload-error")!;
    err.textContent = this.error ?? "";
    err.hidden = this.error === null;
    const retry = el.querySelector<HTMLButtonElement>(".file-upload-retry")!;
    retry.hidden = this.error === null;
    retry.setAttribute("aria-label", `Ponów wysyłanie pliku ${this.name}`);
    retry.title = `Ponów wysyłanie pliku ${this.name}`;
    const cancel = el.querySelector<HTMLButtonElement>(".file-upload-cancel")!;
    cancel.textContent = this.error ? "Usuń" : "Anuluj";
    cancel.setAttribute("aria-label", `${this.error ? "Usuń plik" : "Anuluj wysyłanie pliku"} ${this.name}`);
    cancel.title = cancel.getAttribute("aria-label") ?? "";
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const uploadWidget = (id: string, u: Upload): UploadWidget =>
  new UploadWidget(id, u.file.name || "plik", u.total ? Math.min(100, Math.round((u.sent / u.total) * 100)) : 0, u.error);

/**
 * Live Preview: image embeds show the image, and file embeds show the file (a chip). An upload in progress shows its
 * progress wherever the cursor is; a finished embed shows on every line but the one the cursor is on.
 */
export function embedImages(bridge: Bridge): Extension {
  const build = (view: EditorView): DecorationSet => {
    const store = filesOf(bridge);
    const auto = autoLoadImages();
    const doc = view.state.doc;
    const cursorLine = doc.lineAt(view.state.selection.main.head).number;
    const builder = new RangeSetBuilder<Decoration>();
    const folded = foldedFolders(view.state);
    for (const { from, to } of view.visibleRanges) {
      for (const m of doc.sliceString(from, to).matchAll(ANY)) {
        const start = from + (m.index ?? 0);
        const end = start + m[0].length;
        // a folder's card stands for its files while the caret is outside it (filefolders-view.ts)
        if (folded.some((f) => start >= f.from && end <= f.to)) continue;
        const onCursor = doc.lineAt(start).number === cursorLine;
        const alias = parseImageAlias(m[3] ?? m[5] ?? "");
        let widget: WidgetType | null = null;
        if (m[1]) {
          const upload = uploads.get(m[1]);
          if (upload) widget = uploadWidget(m[1], upload);
          else if (store && !onCursor) widget = new FileWidget(m[1], alias, infoOf(store, m[1]), store, auto);
        } else if (!onCursor && m[4] && isImage(m[4])) {
          widget = new ImageWidget(m[4], alias, bridge, auto);
        }
        if (widget) builder.add(start, end, Decoration.replace({ widget }));
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private alive = true;
      private queued = false;
      private readonly unsubscribe: Array<(() => void) | undefined>;

      constructor(private readonly view: EditorView) {
        this.decorations = build(view);
        redraws.add(this.redraw);
        this.unsubscribe = [
          filesOf(bridge)?.onChange((id) => {
            if (id) infos.delete(id);
            else infos.clear();
            redrawAll();
          }),
          onSettingChanged((key) => {
            if (key === "autoLoadImages") redrawAll();
          }),
        ];
      }

      // Asks for a redraw in a microtask: a store or upload callback can run while the view is updating.
      private readonly redraw = (): void => {
        if (this.queued || !this.alive) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (this.alive) this.view.dispatch({ effects: redrawEffect.of(null) });
        });
      };

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(redrawEffect)))
        ) {
          this.decorations = build(update.view);
        }
      }

      destroy(): void {
        this.alive = false;
        redraws.delete(this.redraw);
        for (const stop of this.unsubscribe) stop?.();
      }
    },
    { decorations: (p) => p.decorations },
  );
}

// The alias written in a wikilink (`|320x200 center`), as the reading view gets it: the link's text.
function aliasOf(link: HTMLElement): ImageAlias | null {
  return parseImageAlias(link.textContent?.trim() ?? "");
}

// The object URLs of each reading view's last paint: they are released by the next paint.
const readingUrls = new WeakMap<HTMLElement, Owner>();

/** Releases the object URLs of the reading view's last paint. */
export function releaseReadingImages(root: HTMLElement): void {
  readingUrls.get(root)?.release();
  readingUrls.delete(root);
}

// The server files of a reading view in document order, each once: the preview pages through them.
const embeddedInPage = (root: HTMLElement): string[] => [
  ...new Set([...root.querySelectorAll<HTMLElement>(".file-embed[data-id]")].map((el) => el.dataset.id ?? "")),
];

/**
 * Reading view: the attachment links become images or chips. Called after every paint.
 * A server file arrives as the wikilink `plik:<id>#<embedId>` with the alias as its text (`![[plik:<id>|320x200 center]]`).
 */
export function embedReadingImages(root: HTMLElement, bridge: Bridge): void {
  releaseReadingImages(root);
  const urls = new Owner();
  readingUrls.set(root, urls);
  const store = filesOf(bridge);
  const auto = autoLoadImages();
  const current = () => readingUrls.get(root) === urls;

  for (const link of root.querySelectorAll<HTMLElement>('.wikilink[data-target^="plik:"]')) {
    const id = /^plik:([0-9a-f]{32})(?:#[0-9a-f]{8})?$/.exec(link.dataset.target ?? "")?.[1];
    if (!id) continue;
    const alias = aliasOf(link);
    const wrap = document.createElement("span");
    wrap.classList.add("file-embed");
    placeClasses(wrap, alias, false);
    wrap.dataset.id = id;
    link.replaceWith(wrap);
    if (!store) {
      wrap.append(note("Plik niedostępny"));
      continue;
    }
    let known: FileInfo | null | undefined; // undefined until the info arrives: the menu then has only "Podgląd"
    previewActions(wrap, store, id, () => embeddedInPage(root), () => known);
    (store === infoStore && infos.has(id) ? Promise.resolve(infos.get(id) ?? null) : store.info(id)).then(
      (info) => {
        known = info;
        if (current()) wrap.replaceChildren(fileNode(store, id, info, alias, urls, auto));
      },
      () => {
        if (current()) wrap.replaceChildren(note("Plik niedostępny"));
      },
    );
  }

  for (const link of root.querySelectorAll<HTMLElement>('.wikilink[data-target^="assets/"]')) {
    const prev = link.previousSibling;
    const rel = link.dataset.target ?? "";
    // `embed` marks an image wikilink (the core's rendering); otherwise the `!` is the text before the link
    if (!link.classList.contains("embed")) {
      if (!prev || prev.nodeType !== Node.TEXT_NODE || !prev.textContent?.endsWith("!") || !isImage(rel)) continue;
      prev.textContent = prev.textContent.slice(0, -1);
    } else if (!isImage(rel)) continue;
    link.replaceWith(legacyImage(bridge, rel, aliasOf(link), urls, auto, false));
  }
}

// --- For the folder dialog (filefolders-view.ts): the same previews, downloads and upload progress as the embeds.

/** Opens a finished server file the way its chip does: a picture at full size, a preview, or a download. */
export function openFile(store: FileStore, info: FileInfo): void {
  if (showsAsImage(info.mime)) openImage(store, info);
  else if (canPreview(info)) void preview(store, info);
  else void download(store, info);
}

/** A picture's small preview (the original when there is none) as an object URL that `owner` releases; null for other files. */
export async function thumbOf(store: FileStore, info: FileInfo, owner: Owner): Promise<string | null> {
  if (!showsAsImage(info.mime)) return null;
  const url = URL.createObjectURL(await readCached(store, info.thumb || info.id));
  return owner.add(url) ? url : null;
}

/** The upload of a file that is in progress or failed; null when there is none. */
export function uploadOf(id: string): { name: string; pct: number; error: string | null } | null {
  const u = uploads.get(id);
  if (!u) return null;
  return { name: u.file.name || "plik", pct: u.total ? Math.min(100, Math.round((u.sent / u.total) * 100)) : 0, error: u.error };
}

/** Calls `cb` whenever an upload's progress or state changes. Returns the unsubscribe. */
export function onUploadChange(cb: () => void): () => void {
  redraws.add(cb);
  return () => redraws.delete(cb);
}
