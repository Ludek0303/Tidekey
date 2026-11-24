import type { Bridge, TreeListing } from "./bridge";
import { emit } from "./bus";
import { isCalendarText } from "./calendar/model";
import { isKanbanText } from "./kanban";
import init, { WasmIndex } from "./wasm/notes_web.js";
import type { ProjectRow, TasksJson } from "./orgtasks";
import { type TableCheckItem, parseTableChecks } from "./tablechecks";
import { guardedLines } from "./github/core";

// Links and tags as the core index sees them (`graph_json` of crates/web).
export interface RawGraph {
  nodes: { id: string; path: string; tags: string[] }[];
  edges: [string, string][];
  ghosts: { name: string; from: string[] }[];
}

const DEBOUNCE_MS = 300;

let loaded: Promise<unknown> | null = null;

// Notes from GitHub (docs/GITHUB.md §9): the short hashes of the task and mention lines of GitHub's version, set by the
// browser bridge from its links. Those lines make no task and no mention: only what members added counts.
let githubGuard: (noteId: string) => string[] | null = () => null;
export function setGithubGuard(fn: (noteId: string) => string[] | null): void { githubGuard = fn; }

// GitHub's guarded lines become empty lines (line numbers stay). Counted with multiplicity: a line the note holds more
// often than GitHub's version is the user's, and the extra copies stay.
export function withoutGuarded(text: string, guarded: string[] | null): string {
  if (!guarded?.length) return text;
  const left = new Map<string, number>();
  for (const h of guarded) left.set(h, (left.get(h) ?? 0) + 1);
  return text.split("\n").map((line) => {
    // a task needs "[" and a mention "@": other lines skip the hash
    const hash = /[[@]/.test(line) ? guardedLines(line)[0] : undefined;
    const n = hash === undefined ? 0 : left.get(hash) ?? 0;
    if (n === 0) return line;
    left.set(hash!, n - 1);
    return "";
  }).join("\n");
}

// Keeps the wasm link index in step with the tree (create, rename, move, delete) and with the open note's edits.
export class NoteIndex {
  private index: WasmIndex | null = null;
  // id -> path of every note the index holds.
  private known = new Map<string, string>();
  // Edited text of the open note, written once the typing pauses.
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  // The parsed graph_json, kept until the index changes.
  private cache: RawGraph | null = null;
  private tasksCache: TasksJson | null = null;
  private projectsCache: ProjectRow[] | null = null;
  // Ids of the notes whose front matter says `typ: kalendarz`.
  private calendars = new Set<string>();
  // Ids of the notes whose front matter says `typ: kanban` (the boards of kanban.ts).
  private kanbans = new Set<string>();
  // Checkbox cells of the tables of each note that has any (see tablechecks.ts).
  private tables = new Map<string, TableCheckItem[]>();
  // The GitHub guard each note was indexed with: a new one (the link saved after its notes) reads the note again.
  private guards = new Map<string, string>();

  constructor(
    private readonly bridge: Bridge,
    private readonly onChange: () => void = () => {},
  ) {}

  async start(): Promise<void> {
    // Shared with the formula engine's init: wasm-bindgen returns the loaded module on a second call.
    loaded ??= init().catch((e: unknown) => {
      loaded = null;
      throw e;
    });
    await loaded;
    this.index = new WasmIndex();
    this.bridge.on("tree_changed", () => void this.sync());
    await this.sync();
  }

  /** Brings the index in line with the tree: new notes are read, renamed ones moved, deleted ones removed. */
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.doSync()).catch((e: unknown) => console.error("index sync failed", e));
    return this.queue;
  }

  /** Records an edit of the open note; the index takes it after the typing pauses. */
  edited(id: string, text: string): void {
    if (!this.index) return;
    this.pending.set(id, text);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  /** Writes the pending edits now. */
  flush(): void {
    clearTimeout(this.timer);
    for (const [id, text] of this.pending) {
      this.setKinds(id, text);
      this.setTables(id, text);
      const path = this.known.get(id);
      const indexed = withoutGuarded(text, githubGuard(id));
      if (this.index && path !== undefined) this.index.upsert(id, path, indexed);
      // the search index (ocr/appsearch.ts) takes the same text
      emit("index:edited", { id, text: indexed });
    }
    const wrote = this.pending.size > 0;
    this.pending.clear();
    if (wrote) this.changed();
  }

  /** The checkbox cells of the tables in every note that has some, with each note's path. */
  tableChecks(): { note: string; path: string; items: TableCheckItem[] }[] {
    return [...this.tables].flatMap(([note, items]) => {
      const path = this.known.get(note);
      return path === undefined ? [] : [{ note, path, items }];
    });
  }

  /** Whether the note is a calendar (its text was read by the index). */
  isCalendar(id: string): boolean {
    return this.calendars.has(id);
  }

  /** Whether the note is a kanban board (its text was read by the index). */
  isKanban(id: string): boolean {
    return this.kanbans.has(id);
  }

  /** The link graph of the index, or `null` before `start()` has loaded it. Parsed once per change. */
  graph(): RawGraph | null {
    if (!this.index) return null;
    this.cache ??= JSON.parse(this.index.graph_json()) as RawGraph;
    return this.cache;
  }

  /** The tasks of every note and their parse warnings (`tasks_json`), or `null` before `start()`. */
  tasks(): TasksJson | null {
    if (!this.index) return null;
    this.tasksCache ??= JSON.parse(this.index.tasks_json()) as TasksJson;
    return this.tasksCache;
  }

  /** The project notes (`typ: projekt`), or `null` before `start()`. */
  projects(): ProjectRow[] | null {
    if (!this.index) return null;
    this.projectsCache ??= JSON.parse(this.index.projects_json()) as ProjectRow[];
    return this.projectsCache;
  }

  private setKinds(id: string, text: string): void {
    if (isCalendarText(text)) this.calendars.add(id);
    else this.calendars.delete(id);
    if (isKanbanText(text)) this.kanbans.add(id);
    else this.kanbans.delete(id);
  }

  private setTables(id: string, text: string): void {
    const items = text.includes("[ ]") || text.includes("!zaznacza") ? parseTableChecks(text) : [];
    if (items.length) this.tables.set(id, items);
    else this.tables.delete(id);
  }

  private changed(): void {
    this.cache = null;
    this.tasksCache = null;
    this.projectsCache = null;
    this.onChange();
  }

  private async doSync(): Promise<void> {
    const index = this.index;
    if (!index) return;
    const { notes } = await this.bridge.call<TreeListing>("list_tree");
    const live = new Set<string>();
    for (const note of notes) {
      live.add(note.id);
      const prev = this.known.get(note.id);
      const guard = githubGuard(note.id);
      const sig = guard?.join(",") ?? "";
      if (prev === undefined || sig !== (this.guards.get(note.id) ?? "")) {
        const text = await this.bridge.call<string>("note_text", { id: note.id });
        if (sig) this.guards.set(note.id, sig);
        else this.guards.delete(note.id);
        // An edit that arrived while the text was read is newer; flush() writes it.
        if (!this.pending.has(note.id)) {
          index.upsert(note.id, note.path, withoutGuarded(text, guard));
          this.setKinds(note.id, text);
          this.setTables(note.id, text);
        }
        this.known.set(note.id, note.path);
      } else if (prev !== note.path) {
        index.rename(note.id, note.path);
        this.known.set(note.id, note.path);
      }
    }
    for (const id of [...this.known.keys()]) {
      if (live.has(id)) continue;
      index.remove(id);
      this.calendars.delete(id);
      this.kanbans.delete(id);
      this.tables.delete(id);
      this.guards.delete(id);
      this.known.delete(id);
      this.pending.delete(id);
    }
    this.changed();
  }
}
