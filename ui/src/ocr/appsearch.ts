// The app's search index (docs/OCR.md §3.6, §4.3): one WasmSearch per space, fed with the notes (from the bridge) and
// with the text layers of the files (from the store). It loads on the first search; without the WASM module
// `ensure()` resolves false and the search pane keeps the bridge's search.

import type { Bridge, TreeListing } from "../bridge";
import { on } from "../bus";
import { FILE_EMBED, filesOf, textLayersOf, type FileInfo, type FileStore, type TextLayers } from "../filestore";
import type { MapExtra } from "../graphdata";
import type { TextLayerInfo } from "../remotefiles";
import init, { WasmSearch } from "../wasm/notes_web.js";

// Files change in bursts (an upload, a recognition): one pass after the burst.
const FILES_DEBOUNCE_MS = 300;

/** A hit as `search_json` returns it: a note (`kind` "note", `title` its path) or a file (`title` its name, `place` "s.N"). */
export interface AppHit {
  chunkId: string;
  kind: "note" | "file";
  docId: string;
  title: string;
  place: string;
  snippet: string;
}

/** The note as the index holds it; `edited` comes from NoteIndex.flush (noteindex.ts). */
export interface IndexEdit { id: string; text: string }

type TextState = "text" | "none" | "pending" | "error";

export class AppSearch {
  private index: WasmSearch | null = null;
  private loading: Promise<boolean> | null = null;
  // note id -> path, the notes the index holds
  private paths = new Map<string, string>();
  // note id -> the files its text embeds, and file id -> the notes that embed it
  private embedded = new Map<string, string[]>();
  private embeds = new Map<string, Set<string>>();
  // file id -> the layer and name it was indexed with; a change of either reads the file again
  private sigs = new Map<string, string>();
  private ready: string[] = [];
  // ordering of edits against the note reads in flight: a read that began before an edit is stale
  private editAt = new Map<string, number>();
  private tick = 0;
  private notesChain: Promise<void> = Promise.resolve();
  private filesChain: Promise<void> = Promise.resolve();
  private fileTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly bridge: Bridge) {}

  /** Loads the index on the first call: the notes now, the files in the background. False when WASM does not load. */
  ensure(): Promise<boolean> {
    this.loading ??= this.load();
    return this.loading;
  }

  /** The hits of `query` over the notes and the files (scope "*": everything the app can read); null before `ensure()`. */
  search(query: string, limit: number): { hits: AppHit[]; total: number } | null {
    if (!this.index) return null;
    return JSON.parse(this.index.search_json(query, limit, 0, "*")) as { hits: AppHit[]; total: number };
  }

  /** The paths of the notes whose text embeds the file, in the order the notes were read. */
  embedsOf(fileId: string): string[] {
    return [...(this.embeds.get(fileId) ?? [])].map((id) => this.paths.get(id) ?? "").filter((p) => p !== "");
  }

  /** The files, people and mentions of the map (`edges_json`) for the graph view; null before `ensure()`. */
  edges(): MapExtra | null {
    if (!this.index) return null;
    return JSON.parse(this.index.edges_json("embed,assigned,mention", "*")) as MapExtra;
  }

  /** Files read so far out of the ready ones (a file without a layer counts once it is seen). */
  fileProgress(): { done: number; total: number } {
    return { done: this.ready.filter((id) => this.sigs.has(id)).length, total: this.ready.length };
  }

  /** Called after each change of the file part, so an open search pane can show the new hits. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Brings the file part in line with the store: new layers are read, files that left the store are removed. */
  syncFiles(): Promise<void> {
    this.filesChain = this.filesChain.then(() => this.doFiles()).catch((e: unknown) => console.error("file search sync failed", e));
    return this.filesChain;
  }

  private async load(): Promise<boolean> {
    try {
      await init();
    } catch (e) {
      console.error("search index disabled", e);
      return false;
    }
    this.index = new WasmSearch();
    this.bridge.on("tree_changed", () => void this.syncNotes());
    on("index:edited", (detail) => this.edited(detail as IndexEdit));
    const store = filesOf(this.bridge);
    if (textLayersOf(store)) {
      store.onChange(() => this.filesSoon());
      on("ocr:status", () => this.filesSoon());
    }
    await this.syncNotes();
    void this.syncFiles();
    return true;
  }

  private syncNotes(): Promise<void> {
    this.notesChain = this.notesChain.then(() => this.doNotes()).catch((e: unknown) => console.error("note search sync failed", e));
    return this.notesChain;
  }

  private async doNotes(): Promise<void> {
    const { notes } = await this.bridge.call<TreeListing>("list_tree");
    const live = new Set(notes.map((n) => n.id));
    for (const note of notes) {
      if (this.paths.get(note.id) === note.path) continue;
      const at = this.tick;
      const text = await this.bridge.call<string>("note_text", { id: note.id });
      if ((this.editAt.get(note.id) ?? 0) > at) continue; // edited while it was read: the edit is newer
      this.putNote(note.id, note.path, text);
    }
    for (const id of [...this.paths.keys()]) if (!live.has(id)) this.dropNote(id);
    this.notify();
  }

  private edited({ id, text }: IndexEdit): void {
    this.editAt.set(id, ++this.tick);
    const path = this.paths.get(id);
    if (this.index && path !== undefined) {
      this.putNote(id, path, text);
      this.notify();
    }
  }

  private putNote(id: string, path: string, text: string): void {
    this.paths.set(id, path);
    this.index!.upsert_note(id, path, text);
    this.setEmbeds(id, text);
  }

  private dropNote(id: string): void {
    this.index!.remove_note(id);
    this.paths.delete(id);
    this.setEmbeds(id, "");
  }

  private setEmbeds(id: string, text: string): void {
    for (const file of this.embedded.get(id) ?? []) this.embeds.get(file)?.delete(id);
    const files = [...new Set([...text.matchAll(new RegExp(FILE_EMBED.source, "g"))].map((m) => m[1]))];
    this.embedded.set(id, files);
    for (const file of files) {
      const notes = this.embeds.get(file) ?? new Set<string>();
      notes.add(id);
      this.embeds.set(file, notes);
    }
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private filesSoon(): void {
    clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => void this.syncFiles(), FILES_DEBOUNCE_MS);
  }

  private async doFiles(): Promise<void> {
    const store = filesOf(this.bridge);
    if (!this.index || !textLayersOf(store)) return;
    const [{ files }, layers] = await Promise.all([store.list(), store.textLayers()]);
    // a file in the trash is not indexed: only the ready ones count
    const ready = files.filter((f) => f.state === "ready" && !f.thumbOf);
    this.ready = ready.map((f) => f.id);
    const live = new Set(this.ready);
    for (const id of [...this.sigs.keys()]) {
      if (live.has(id)) continue;
      this.index.remove_file(id);
      this.sigs.delete(id);
    }
    for (const file of ready) {
      const layer = layers.get(file.id);
      const sig = `${layer?.id ?? ""}|${file.name}|${file.mime}`;
      if (this.sigs.get(file.id) === sig) continue;
      this.index.remove_file(file.id);
      const state = layer ? await this.addText(store, file, layer) : "pending";
      this.index.set_file(file.id, file.name, file.mime, state);
      this.sigs.set(file.id, sig);
      this.notify();
    }
  }

  private async addText(store: FileStore & TextLayers, file: FileInfo, layer: TextLayerInfo): Promise<TextState> {
    if (layer.flags.includes("zabezpieczony") || layer.flags.includes("brak tekstu") || layer.method === "none") return "none";
    if (layer.flags.includes("błąd")) return "error";
    try {
      const markdown = await store.readTextLayer(layer.id, file.id);
      return this.index!.upsert_file_text(file.id, file.name, file.mime, markdown) ? "text" : "error";
    } catch {
      return "error";
    }
  }
}

/** The first plain word of a query (not an operator like `typ:pdf`, not `-wykluczenie`): the term to show in the file. */
export function firstTerm(query: string): string {
  return query.replace(/"/g, "").split(/\s+/).find((t) => t !== "" && !t.includes(":") && !t.startsWith("-")) ?? "";
}

/** The page a file hit points to: its place "s.N" (an image has one page, "s.1"). */
export function pageOf(place: string): number {
  return Number(/^s\.(\d+)$/.exec(place)?.[1] ?? 1);
}
