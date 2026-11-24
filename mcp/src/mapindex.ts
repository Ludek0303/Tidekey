// The chat's own search index (docs/OCR.md §5.1, §5.4): per vault, a WasmSearch and a WasmIndex built ONLY from what the
// chat may see, the visible notes (text as read_note shows it: links to notes out of scope are markers) and the visible
// files with their checked text layers. Every read is given the scope of exactly these ids. Nothing goes to disk; an
// index is freed when it is replaced or its vault is dropped (`prune`).
import { WasmIndex, WasmSearch } from "../../ui/src/wasm/notes_web.js";
import { embedMap, type VisibleFile } from "./filetext";
import type { NoteView, Session, VaultView } from "./session";

/** The file pass of a vault: layers read so far of all layers (`Indeks plików: 140 z 380`). */
export interface Progress { read: number; layers: number; failed: boolean }

export interface VaultIndex {
  search: WasmSearch;
  /** The scope JSON of every read: exactly the visible note and file ids (never "*", never ""). */
  scope: string;
  /** Path of each visible note, by id. */
  paths: Map<string, string>;
  /** Visible files by id. */
  files: Map<string, VisibleFile>;
  /** Paths of the visible notes that embed each file (the index text hides embeds, so the links come from here). */
  embeds: Map<string, string[]>;
}

interface Held { key: string; index: VaultIndex }

/** The text as the chat sees it; `file(id)` says whether an embedded file is one the chat may see (its embed stays). */
export type Shown = (text: string, file: (fileId: string) => boolean) => string;

function build(notes: NoteView[], files: VisibleFile[], shown: Shown): VaultIndex {
  const search = new WasmSearch();
  const links = new WasmIndex();
  const fileIds = new Set(files.map((f) => f.id));
  const seen = (id: string) => fileIds.has(id);
  for (const n of notes) {
    const text = shown(n.text, seen);
    search.upsert_note(n.id, n.path, text);
    links.upsert(n.id, n.path, text);
  }
  // resolved note-to-note links, the way the app resolves them (over the same visible notes only)
  const ids = new Set(notes.map((n) => n.id));
  for (const n of notes) {
    const rows = JSON.parse(links.outgoing_json(n.id)) as { to: string | null }[];
    search.set_links(n.id, JSON.stringify([...new Set(rows.flatMap((r) => (r.to !== null && ids.has(r.to) ? [r.to] : [])))]));
  }
  links.free();
  for (const f of files) {
    const ok = f.markdown !== null && search.upsert_file_text(f.id, f.name, f.mime, f.markdown);
    search.set_file(f.id, f.name, f.mime, ok ? "text" : f.markdown === null ? "pending" : "error");
  }
  const paths = new Map(notes.map((n) => [n.id, n.path]));
  const embeds = new Map([...embedMap(notes)].map(([file, ids2]) => [file, ids2.flatMap((id) => paths.get(id) ?? [])]));
  return {
    search,
    scope: JSON.stringify({ notes: notes.map((n) => n.id), files: files.map((f) => f.id) }),
    paths,
    files: new Map(files.map((f) => [f.id, f])),
    embeds,
  };
}

/** The indexes of the chat's vaults. Built lazily by the tools; the file pass runs in the background. */
export class MapIndex {
  private held = new Map<string, Held>();
  private passes = new Map<VaultView, Promise<void>>();
  private progress = new Map<string, Progress>();
  /** How many indexes were built (rebuilds happen only on a change of revision, visible notes or files). */
  builds = 0;

  constructor(private readonly session: Session) {
    // the indexes hold the text of notes and files: they go with the session's keys (docs/OCR.md §5.4)
    session.onWipe.push(() => this.clear());
  }

  /** Frees every index. shortcut: WasmSearch.free() releases its memory without overwriting it; zeroize in Rust when
   *  the core gets a clear-on-drop for its texts. */
  clear(): void {
    for (const held of this.held.values()) held.index.search.free();
    this.held.clear();
    this.progress.clear();
  }

  /**
   * The index of `view`. Rebuilt only when its revision, its visible notes or its file list changed. While the file
   * list is still being read, the index holds the notes only (see `pending`).
   */
  of(view: VaultView, shown: Shown, pass = true): VaultIndex {
    this.prune();
    // `pass` false: a caller that reads notes only (read_note section) does not fetch the files' text
    if (pass) this.startPass(view);
    const notes = this.session.visibleNotes(view);
    const files: VisibleFile[] | null = view.fileText ? (view.files?.files ?? null) : [];
    const sig = files === null ? "pending" : files.map((f) => `${f.id}${f.markdown === null ? "-" : `+${f.markdown.length}`}`).join(",");
    const key = [view.revision, notes.map((n) => n.id).join(","), sig].join("\u0001");
    const held = this.held.get(view.id);
    if (held?.key === key) return held.index;
    held?.index.search.free();
    const index = build(notes, files ?? [], shown);
    this.builds++;
    this.held.set(view.id, { key, index });
    return index;
  }

  /** The file pass of `view` while it runs (or failed): what the answer says about it; null when there is none. */
  pending(view: VaultView): Progress | null {
    if (!view.fileText || view.files !== null) return null;
    return this.progress.get(view.id) ?? { read: 0, layers: 0, failed: false };
  }

  /** Resolves when no file pass is running (tests, and a caller that wants the whole index). */
  async settled(): Promise<void> {
    await Promise.all([...this.passes.values()]);
  }

  /** Drops the indexes of vaults the session no longer holds (left the scope, session ended). */
  prune(): void {
    for (const [id, held] of this.held) {
      if (this.session.vaults.has(id)) continue;
      held.index.search.free();
      this.held.delete(id);
    }
    for (const id of this.progress.keys()) if (!this.session.vaults.has(id)) this.progress.delete(id);
  }

  private startPass(view: VaultView): void {
    if (!view.fileText || view.files !== null || this.passes.has(view)) return;
    const pass = this.session.fileTexts(view, (read, layers) => this.progress.set(view.id, { read, layers, failed: false }))
      .then(() => undefined, () => { this.progress.set(view.id, { read: 0, layers: 0, failed: true }); })
      .finally(() => this.passes.delete(view));
    this.passes.set(view, pass);
  }
}
