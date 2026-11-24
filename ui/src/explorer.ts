import { within, type Bridge, type LockedFolder, type TreeFile, type TreeItem, type TreeListing, type TrashEntry } from "./bridge";
import { download } from "./attachments";
import { editPermissions } from "./projects";
import { getSetting } from "./settings";
import { parentOf, type FileTree, type TreeFileRow } from "./tree";
import { cleanPart, collectDropped, count, exportNotes, importMarkdown, type ImportFile } from "./transfer";
import { confirmByName, errorText, openDialog, openMenu, toast, type MenuEntry } from "./widgets";
import { type FileInfo, fileEmbed, filesOf, MAX_FILE_BYTES, newEmbedId } from "./filestore";
import { PROTECTED_FILE_TEXT, TOO_BIG, freeName, pickFiles, progressToast, setFilePlaces, uploadTo } from "./folderfiles";
import { previewFiles } from "./preview/triggers";
import { iconButton } from "./icons";
import { openTrash } from "./trashview";
import { TOP_TEXT } from "./protected";
import { el } from "./dom";
import { openConnectDialog } from "./github/connect-view";
import type { GithubLink } from "./github/link";
import { renderGithubStatus } from "./github/project-status";
import { githubService, type GithubService } from "./github/service";
import { editNote } from "./orgedit";
import type { NoteIndex } from "./noteindex";
import { rename_links } from "./wasm/notes_web.js";
import type { Doc } from "yjs";

export const UNTITLED = "Bez nazwy";

const join = (folder: string, name: string): string => (folder ? `${folder}/${name}` : name);
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const cleanFolder = (p: string): string => p.trim().replace(/^\/+|\/+$/g, "");
// The order of the tree's rows (tree.ts sorts its names the same way).
const byName = new Intl.Collator("pl", { numeric: true, sensitivity: "base" });

// Folder path -> the text of its GitHub mark: the repositories its links bring in ("(tylko odczyt)" for a read-only one).
function githubMarks(links: GithubLink[]): Map<string, string> {
  const names = new Map<string, string[]>();
  for (const l of links) names.set(l.projectPath, [...(names.get(l.projectPath) ?? []), `${l.repo}${l.allowEdits ? "" : " (tylko odczyt)"}`]);
  return new Map([...names].map(([path, list]) => [path, `Połączony z GitHubem: ${list.join(", ")}`]));
}


export interface ExplorerDeps {
  bridge: Bridge;
  tree: FileTree;
  // Opens a note in a tab; resolves once the tab is shown.
  open: (item: TreeItem) => Promise<void>;
  renamed: (id: string, path: string) => void;
  removed: (id: string) => void;
  // Makes a kanban board in a folder (main.ts); the menu offers it where a folder may take a note.
  newBoard?: (folder: string) => void;
  // Puts a note beside the open one (the split, main.ts); the note menu offers it.
  openSide?: (item: TreeItem) => void;
  // The link index and the open documents (main.ts): a rename rewrites the links that point at the renamed notes.
  links?: { index: NoteIndex; openDoc: (noteId: string) => Doc | null };
}

const TOP_HINT = `${TOP_TEXT} Wybierz folder udostępniony Tobie.`;
// File explorer: owns the note and folder listing and every file action, and talks to the bridge.
export class Explorer {
  notes: TreeItem[] = [];
  private folders: string[] = [];
  // Protected project folders in the listing (their deletion is permanent, see remove).
  private locked: LockedFolder[] = [];
  // False in a shared vault for an editor: the root and Projekty/ are the owners' and admins' to fill (see mayCreateHere).
  private rootFree = true;
  private desc = false;
  // The count badge of the Kosz button in the header (bindHeader).
  private trashBadge?: HTMLElement;
  // The GitHub links, read with the listing (only where a GitHub service is open): the folder menu and the marks use them.
  private githubLinks: GithubLink[] = [];
  // Whether the space is an organization: only there is the permissions entry shown (read with the listing).
  private organization = false;
  // The files that lie in folders, shown with their store's name (folderfiles.ts).
  private files: TreeFileRow[] = [];

  constructor(private readonly deps: ExplorerDeps) {
    deps.bridge.on("remote_changed", () => void this.refreshTrash());
    deps.tree.hooks = {
      onRename: (key, name) => void this.rename(key, name),
      onMove: (keys, folder) => void this.move(keys, folder),
      onDelete: (key) => void this.remove(key),
      onContext: (key, x, y) => this.contextMenu(key, x, y),
      onDropFiles: (data, folder) => void this.importDropped(data, folder),
      onDownload: (keys) => void exportNotes(this.deps.bridge, keys),
      onOpenFile: (fileId, _name, bySpace) => void this.previewFolderFile(fileId, bySpace),
    };
    // A file trashed or restored in Pliki changes the folder's listing: the tree follows (only where files are in folders).
    filesOf(deps.bridge)?.onChange(() => {
      if (this.files.length) void this.reload();
    });
  }

  // Files dragged in from the computer: the notes are imported as before, the other files go into the folder.
  private async importDropped(data: DataTransfer, folder: string): Promise<void> {
    try {
      await this.addItems(await collectDropped(data), folder);
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  // Notes (.md) become notes; the other files become files in the folder. Without a file store (desktop) all of them go to
  // the import, which skips what is not .md.
  private async addItems(items: ImportFile[], folder: string): Promise<void> {
    if (!filesOf(this.deps.bridge)) {
      await importMarkdown(this.deps.bridge, items, folder);
      return;
    }
    const notes = items.filter(({ file }) => /\.md$/i.test(file.name));
    if (notes.length) await importMarkdown(this.deps.bridge, notes, folder);
    const files = items.filter(({ file }) => !/\.md$/i.test(file.name));
    if (files.length) await this.addFiles(files, folder);
  }

  // Uploads files into a folder (the menu's "Wgraj pliki…" and drops). Each goes through the file store, then gets its place.
  private async addFiles(items: ImportFile[], folder: string): Promise<void> {
    const store = filesOf(this.deps.bridge);
    if (!store) return;
    if (!this.mayCreateHere(folder)) return toast(TOP_HINT, true);
    if (this.protectedAt(folder)) return toast(PROTECTED_FILE_TEXT, true);
    const taken = this.takenPaths();
    for (const { file, dir } of items) {
      const name = cleanPart(file.name) || "plik";
      if (file.size > MAX_FILE_BYTES) {
        toast(`${name}: ${TOO_BIG}`, true);
        continue;
      }
      const at = [folder, ...dir.split("/").filter(Boolean).map(cleanPart)].filter(Boolean).join("/");
      await this.ensureFolder(at, taken);
      const path = freeName(join(at, name), taken);
      taken.add(path.toLowerCase());
      const line = progressToast(name);
      try {
        const info = await uploadTo(store, file, path, (sent, total) => line.update(sent, total));
        try {
          await this.deps.bridge.call("folder_file_add", { fileId: info.id, path });
        } catch (err) {
          // the file is not in the folder: it goes to the trash, not left in Pliki
          await store.trash(info.id).catch(() => undefined);
          throw err;
        }
        line.done();
      } catch (err) {
        line.fail(`${name}: ${errorText(err)}`);
      }
    }
    await this.reload();
  }

  // Folders of a path that do not exist yet are made, as the import makes them.
  private async ensureFolder(path: string, taken: Set<string>): Promise<void> {
    let at = "";
    for (const part of path.split("/").filter(Boolean)) {
      at = join(at, part);
      if (taken.has(at.toLowerCase())) continue;
      await this.deps.bridge.call("create_folder", { path: at });
      taken.add(at.toLowerCase());
    }
  }

  // Every name in the tree (notes, folders and files), lower case: the names a new one must avoid.
  private takenPaths(): Set<string> {
    return new Set([...this.notes.map((n) => n.path), ...this.folders, ...this.files.map((f) => f.path)].map((p) => p.toLowerCase()));
  }

  // A protected project (held by this user) or a folder inside one: files are added there by the note's insert only.
  private protectedAt(folder: string): boolean {
    return this.locked.some((l) => within(folder, l.path));
  }

  private fileAt(path: string): TreeFileRow | undefined {
    return this.files.find((f) => f.path === path);
  }

  async reload(): Promise<void> {
    const listing = await this.deps.bridge.call<TreeListing>("list_tree");
    this.notes = listing.notes;
    this.folders = listing.folders;
    this.locked = listing.locked ?? [];
    this.rootFree = listing.rootFree !== false;
    this.organization = await this.deps.bridge.call<string>("space_kind").then((kind) => kind === "organizacja", () => false);
    this.files = await this.folderFileRows(listing.files ?? []);
    setFilePlaces(this.files);
    const service = githubService();
    this.githubLinks = service ? await this.deps.bridge.call<GithubLink[]>("github_links").then((links) => links.filter((l) => !l.removed), () => []) : [];
    this.deps.tree.setGithubMarks(githubMarks(this.githubLinks));
    this.deps.tree.emptyText = this.rootFree
      ? "Twoja biblioteka jest pusta. Utwórz pierwszą notatkę przyciskiem powyżej."
      : "Nie masz jeszcze dostępu do żadnego folderu. Właściciel lub administrator może Ci go udostępnić.";
    this.deps.tree.setItems(listing.notes, listing.folders, this.locked, this.files);
  }

  // The files of the folders with the store's name, size and type. A file the store no longer has (or that is in its
  // trash) leaves the tree; without a store (desktop) the listing's own paths are used.
  private async folderFileRows(entries: TreeFile[]): Promise<TreeFileRow[]> {
    if (entries.length === 0) return [];
    const store = filesOf(this.deps.bridge);
    const infos = store ? await store.list().then((list) => list.files, () => null) : null;
    const byId = new Map((infos ?? []).map((f) => [f.id, f]));
    const rows: TreeFileRow[] = [];
    for (const entry of entries) {
      const info = byId.get(entry.fileId);
      if (infos && (!info || info.state !== "ready")) continue;
      rows.push(info
        ? { fileId: entry.fileId, path: join(parentOf(entry.path), info.name), size: info.size, mime: info.mime }
        : entry);
    }
    return rows;
  }

  // The count on the Kosz button: the notes in the trash. Called on start, after a delete, after the trash dialog changes it, and on remote changes.
  private async refreshTrash(): Promise<void> {
    if (!this.trashBadge) return;
    try {
      const items = await this.deps.bridge.call<TrashEntry[]>("list_trash");
      this.trashBadge.textContent = items.length ? String(items.length) : "";
    } catch {
      // the badge keeps its last count; the next refresh tries again
    }
  }

  // Wires the header buttons of the explorer; each carries a data-action attribute.
  bindHeader(root: HTMLElement): void {
    const actions: Record<string, (btn: HTMLElement) => void> = {
      "new-note": () => void this.newNote(),
      "new-folder": () => void this.newFolder(),
      sort: (btn) => this.sortMenu(btn),
      "collapse-all": () => this.deps.tree.collapseAll(),
      "expand-all": () => this.deps.tree.expandAll(),
    };
    for (const btn of root.querySelectorAll<HTMLElement>("[data-action]")) {
      btn.addEventListener("click", () => actions[btn.dataset.action ?? ""]?.(btn));
    }
    // Touch screens have no Ctrl or Shift: this switch makes taps toggle rows instead.
    const pick = iconButton("square-check", "Zaznacz notatki i foldery (do pobrania)", "icon-btn tree-mode-btn");
    pick.setAttribute("aria-pressed", "false");
    pick.addEventListener("click", () => {
      const on = this.deps.tree.toggleSelectMode();
      pick.setAttribute("aria-pressed", String(on));
    });
    // The trash: the button shows how many notes are in it, the dialog lists and restores them.
    const trash = iconButton("trash-2", "Kosz", "icon-btn trash-btn");
    const badge = document.createElement("span");
    badge.className = "trash-count";
    badge.setAttribute("aria-hidden", "true");
    trash.append(badge);
    trash.addEventListener("click", () => openTrash(this.deps.bridge, () => void this.refreshTrash()));
    this.trashBadge = badge;
    root.querySelector(".explorer-head")?.append(pick, trash);
    void this.refreshTrash();
  }

  // Creates a note at a known path (used by the calendar) and returns it.
  async create(path: string): Promise<TreeItem> {
    const id = await this.deps.bridge.call<string>("create_note", { path });
    await this.reload();
    return { id, path };
  }

  // Whether a new note or folder may go into `folder`: the root and Projekty/ only for an owner or admin (see TreeListing.rootFree).
  private mayCreateHere(folder: string): boolean {
    return this.rootFree || (folder !== "" && folder !== "Projekty");
  }

  // New notes go into the given or focused folder, or the folder set in the settings.
  async newNote(folder = this.deps.tree.selectedFolder() ?? cleanFolder(getSetting("newNoteFolder"))): Promise<void> {
    if (!this.mayCreateHere(folder)) return toast(TOP_HINT, true);
    try {
      const item = await this.create(this.freePath(folder, UNTITLED, ".md"));
      await this.deps.open(item);
      this.deps.tree.reveal(item.path);
      // Enter on the new name moves on to writing, like a title field
      this.deps.tree.startRename(item.path, () => document.querySelector<HTMLElement>(".cm-content")?.focus());
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  async newFolder(folder = this.deps.tree.selectedFolder() ?? ""): Promise<void> {
    if (!this.mayCreateHere(folder)) return toast(TOP_HINT, true);
    const path = this.freePath(folder, UNTITLED, "");
    try {
      await this.deps.bridge.call("create_folder", { path });
      await this.reload();
      this.deps.tree.reveal(path);
      this.deps.tree.startRename(path);
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  // Name that no note or folder in the folder uses yet: "Bez nazwy", "Bez nazwy 2", ...
  private freePath(folder: string, base: string, ext: string): string {
    const used = new Set([...this.notes.map((n) => n.path), ...this.folders].map((p) => p.toLowerCase()));
    for (let i = 1; ; i++) {
      const path = join(folder, `${base}${i === 1 ? "" : ` ${i}`}${ext}`);
      if (!used.has(path.toLowerCase())) return path;
    }
  }

  private noteAt(path: string): TreeItem | undefined {
    return this.notes.find((n) => n.path === path);
  }

  /** Renames the note or folder at `key` to `name` in its own folder (a note keeps or gains `.md`). */
  async rename(key: string, name: string): Promise<void> {
    const note = this.noteAt(key);
    const file = this.fileAt(key);
    if (file) return this.renameFile(file, name);
    try {
      if (note) {
        // a name never moves the note: "/" or "\\" typed in it stays part of the name (moving is drag and drop)
        const clean = name.replace(/[\\/]/g, "-");
        const path = join(parentOf(key), clean.endsWith(".md") ? clean : `${clean}.md`);
        if (path === key) return;
        const linking = this.linkingNotes([note.id]);
        await this.deps.bridge.call("rename", { id: note.id, path });
        await this.reload();
        this.deps.renamed(note.id, path);
        this.deps.tree.reveal(path);
        await this.relink([{ id: note.id, from: key, to: path }], linking);
      } else {
        const to = join(parentOf(key), name);
        if (to === key) return;
        await this.renameFolder(key, to);
      }
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  // A file's new name: the store's name follows, and the folder entry takes the new path. A name never moves the file.
  private async renameFile(file: TreeFileRow, name: string): Promise<void> {
    const clean = name.replace(/[\\/]/g, "-").trim();
    const path = join(parentOf(file.path), clean);
    if (!clean || path === file.path) return;
    if (/\.md$/i.test(clean)) return toast("Plik nie może mieć nazwy .md, bo to notatka.", true);
    if (this.protectedAt(parentOf(file.path))) return toast(PROTECTED_FILE_TEXT, true);
    try {
      await this.deps.bridge.call("folder_file_rename", { fileId: file.fileId, path });
      await filesOf(this.deps.bridge)?.rename(file.fileId, clean);
      await this.reload();
      this.deps.tree.reveal(path);
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  // Moves a folder with everything in it; the open tabs of its notes follow their new paths.
  private async renameFolder(from: string, to: string): Promise<void> {
    const moved = this.notes.filter((n) => n.path.startsWith(`${from}/`));
    const linking = this.linkingNotes(moved.map((n) => n.id));
    await this.deps.bridge.call("rename_folder", { from, to });
    await this.reload();
    for (const n of moved) this.deps.renamed(n.id, to + n.path.slice(from.length));
    this.deps.tree.reveal(to);
    await this.relink(moved.map((n) => ({ id: n.id, from: n.path, to: to + n.path.slice(from.length) })), linking);
  }

  // The notes whose links point at the notes `ids` (the index's graph), with the renamed notes themselves: their own
  // links may point at them. Read before the rename; empty without the link index (no WASM).
  private linkingNotes(ids: string[]): string[] {
    const graph = this.deps.links?.index.graph();
    if (!graph) return [];
    const moved = new Set(ids);
    const from = graph.edges.filter(([, to]) => moved.has(to)).map(([source]) => source);
    return [...new Set([...ids, ...from])];
  }

  // Rewrites the links in `notes` that point at the moved notes (`moves`: old and new paths), after the rename. A note
  // that fails is reported and skipped; the rename stands.
  private async relink(moves: { id: string; from: string; to: string }[], notes: string[]): Promise<void> {
    const links = this.deps.links;
    if (!links || !notes.length) return;
    // a bare [[name]] keeps its meaning only while no other note has the same basename
    const pairs = moves.map((m) => ({ ...m, unique: !this.notes.some((n) => n.id !== m.id && baseName(n.path).toLowerCase() === baseName(m.to).toLowerCase()) }));
    let updated = 0;
    for (const id of notes) {
      let changed = null as string | null;
      try {
        await editNote({ bridge: this.deps.bridge, openDoc: links.openDoc }, id, (text) => {
          let next = text;
          for (const p of pairs) next = rename_links(next, p.from, p.to, p.unique) ?? next;
          if (next !== text) changed = next;
          return next;
        });
        if (changed !== null) {
          updated++;
          links.index.edited(id, changed);
        }
      } catch (err) {
        toast(errorText(err), true);
      }
    }
    if (updated) toast(`Zaktualizowano linki w ${updated} ${updated === 1 ? "notatce" : "notatkach"}.`);
  }

  // Drag and drop: the notes, folders and files keep their names and move into the folder. A name taken there is refused by
  // the bridge. A folder moved with its own rows selected takes them along, so those are not moved again.
  private async move(keys: string[], folder: string): Promise<void> {
    const top = keys.filter((key) => !keys.some((other) => other !== key && within(key, other)));
    let moved = 0;
    for (const key of top) if (await this.moveOne(key, folder)) moved++;
    if (keys.length > 1) {
      this.deps.tree.clearSelection();
      if (moved > 1) toast(`Przeniesiono ${count(moved, "element", "elementy", "elementów")} ${folder ? `do „${folder}”` : "do głównego folderu"}.`);
    }
  }

  // One key of a move; false when it did not move (the reason is toasted).
  private async moveOne(key: string, folder: string): Promise<boolean> {
    const note = this.noteAt(key);
    const file = this.fileAt(key);
    const path = join(folder, baseName(key));
    if (path === key) return false;
    if (file) {
      if (this.protectedAt(folder) || this.protectedAt(parentOf(key))) {
        toast(PROTECTED_FILE_TEXT, true);
        return false;
      }
      try {
        await this.deps.bridge.call("folder_file_rename", { fileId: file.fileId, path });
        await this.reload();
        this.deps.tree.reveal(path);
        return true;
      } catch (err) {
        toast(errorText(err), true);
        return false;
      }
    }
    try {
      if (note) {
        const linking = this.linkingNotes([note.id]);
        await this.deps.bridge.call("rename", { id: note.id, path });
        await this.reload();
        this.deps.renamed(note.id, path);
        this.deps.tree.reveal(path);
        await this.relink([{ id: note.id, from: key, to: path }], linking);
      } else {
        if (within(folder, key)) throw new Error("Folder nie może być przeniesiony do siebie samego");
        await this.renameFolder(key, path);
      }
      return true;
    } catch (err) {
      toast(errorText(err), true);
      return false;
    }
  }

  // A file leaves its folder; the file goes to the trash of Pliki unless a note embeds it (the bridge decides).
  private async removeFile(file: TreeFileRow): Promise<void> {
    const name = baseName(file.path);
    try {
      const trashed = await this.deps.bridge.call<boolean>("folder_file_remove", { fileId: file.fileId });
      await this.reload();
      // Not trashed: a note embeds the file, so it only leaves the folder and has no Cofnij.
      if (!trashed) return toast("Plik zniknął z folderu. Zostaje w Plikach, bo osadzają go notatki.");
      toast(`Przeniesiono do kosza plik „${name}”.`, false, { label: "Cofnij", run: () => void this.undoTrash([], [file]) });
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  // Cofnij after a move to the trash: the notes come back from the trash by id; the files go back into their folders, and
  // a file in the file store's trash leaves it first. A folder that is gone comes back with its notes (the bridge makes it).
  private async undoTrash(noteIds: string[], files: TreeFileRow[]): Promise<void> {
    try {
      for (const id of noteIds) await this.deps.bridge.call("restore_note", { id });
      await this.reload();
      const store = filesOf(this.deps.bridge);
      if (store && files.length) {
        const taken = this.takenPaths();
        for (const f of files) {
          if ((await store.info(f.fileId))?.state === "trashed") await store.restore(f.fileId);
          await this.ensureFolder(parentOf(f.path), taken);
          await this.deps.bridge.call("folder_file_add", { fileId: f.fileId, path: f.path });
        }
        await this.reload();
      }
      void this.refreshTrash();
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  // Moves a note or a folder to the trash at once, and Cofnij brings it back. Only a folder with a protected project asks
  // first: that project is deleted for good, so there is nothing to undo for it.
  async remove(key: string): Promise<void> {
    const file = this.fileAt(key);
    if (file) return this.removeFile(file);
    const note = this.noteAt(key);
    const name = baseName(key).replace(/\.md$/, "");
    const descendants = note ? [note] : this.notes.filter((n) => n.path.startsWith(`${key}/`));
    const files = note ? [] : this.files.filter((f) => f.path.startsWith(`${key}/`));
    // A protected project inside the folder is deleted for good: the server-side delete takes it out of the trash.
    const inProject = !note && this.locked.some((l) => l.path === key || l.path.startsWith(`${key}/`));
    const size = [count(descendants.length, "notatka", "notatki", "notatek"), files.length ? count(files.length, "plik", "pliki", "plików") : ""].filter(Boolean).join(" i ");
    if (inProject) {
      const question = `Przenieść folder „${name}” do kosza? Do kosza trafi: ${size}. Chroniony projekt zostanie usunięty na zawsze. Pozostałe notatki można przywrócić przez 6 miesięcy.`;
      if (!(await confirmByName(question, name))) return;
    }
    try {
      if (note) await this.deps.bridge.call("delete", { id: note.id });
      else await this.deps.bridge.call("delete_folder", { path: key });
      await this.reload();
      void this.refreshTrash();
      for (const removed of descendants) this.deps.removed(removed.id);
    } catch (err) {
      return toast(errorText(err), true);
    }
    const undo = inProject ? undefined : { label: "Cofnij", run: () => void this.undoTrash(descendants.map((n) => n.id), files) };
    toast(note ? `Przeniesiono do kosza: „${name}”.` : `Przeniesiono do kosza folder „${name}”${size ? ` (${size})` : ""}.`, false, undo);
  }

  copyPath(key: string): void {
    this.copyText(key, "Skopiowano ścieżkę", "Nie udało się skopiować ścieżki");
  }

  private copyText(text: string, done: string, failed: string): void {
    const clip = navigator.clipboard;
    if (!clip) {
      toast("Schowek jest niedostępny", true);
      return;
    }
    clip.writeText(text).then(() => toast(done), () => toast(failed, true));
  }

  // The file's entries: its download, rename, a link to paste into a note, and removal.
  private fileMenu(file: TreeFileRow): MenuEntry[] {
    return [
      { label: "Podgląd", icon: "eye", run: () => void this.previewFolderFile(file.fileId) },
      { label: "Pobierz", icon: "download", run: () => void this.downloadFile(file.fileId) },
      { label: "Zmień nazwę", icon: "pencil", run: () => { this.deps.tree.reveal(file.path); this.deps.tree.startRename(file.path); } },
      { label: "Kopiuj odnośnik do notatki", icon: "link", run: () => this.copyText(fileEmbed(file.fileId, null, newEmbedId()), "Skopiowano odnośnik do notatki", "Nie udało się skopiować odnośnika") },
      { label: "Usuń", icon: "trash-2", run: () => void this.removeFile(file) },
    ];
  }

  private async downloadFile(fileId: string): Promise<void> {
    const store = filesOf(this.deps.bridge);
    const info = store ? await store.info(fileId).catch(() => null) : null;
    if (!store || !info) return toast("Nie ma takiego pliku.", true);
    await download(store, info);
  }

  // The preview of a file in a folder pages through the files of that folder, in the tree's order.
  private async previewFolderFile(fileId: string, bySpace = false): Promise<void> {
    const store = filesOf(this.deps.bridge);
    const file = this.files.find((f) => f.fileId === fileId);
    if (!store || !file) return toast("Nie ma takiego pliku.", true);
    const folder = parentOf(file.path);
    const siblings = this.files
      .filter((f) => parentOf(f.path) === folder)
      .sort((a, b) => {
        const c = byName.compare(baseName(a.path), baseName(b.path));
        return this.desc ? -c : c;
      });
    const infos = (await Promise.all(siblings.map((f) => store.info(f.fileId).catch(() => null)))).filter((i): i is FileInfo => i !== null);
    const index = infos.findIndex((i) => i.id === fileId);
    if (bySpace) previewFiles(store, infos, index, { bySpace });
    else previewFiles(store, infos, index);
  }

  // Rename, delete and copy path; used by the context menu and the view header.
  noteActions(key: string, _note: boolean): MenuEntry[] {
    const rename = () => {
      this.deps.tree.reveal(key);
      this.deps.tree.startRename(key);
    };
    const actions: MenuEntry[] = [{ label: "Zmień nazwę", icon: "pencil", run: rename }];
    actions.push({ label: "Usuń", icon: "trash-2", run: () => void this.remove(key) });
    actions.push({ label: "Kopiuj ścieżkę", icon: "copy", run: () => this.copyPath(key) });
    return actions;
  }

  private contextMenu(key: string | null, x: number, y: number): void {
    const file = key === null ? undefined : this.fileAt(key);
    if (key !== null && file) return openMenu(x, y, this.fileMenu(file));
    const note = key !== null && this.noteAt(key) !== undefined;
    const folder = key === null ? "" : note ? parentOf(key) : key;
    const entries: MenuEntry[] = this.mayCreateHere(folder) ? [
      { label: "Nowa notatka", icon: "square-pen", run: () => void this.newNote(folder) },
      { label: "Nowy folder", icon: "folder-plus", run: () => void this.newFolder(folder) },
    ] : [];
    // A board is a note: the folders and the empty space take one, a note's row does not.
    if (this.deps.newBoard && !note && this.mayCreateHere(folder)) {
      const newBoard = this.deps.newBoard;
      entries.push({ label: "Nowa tablica kanban", icon: "columns-3", run: () => newBoard(folder) });
    }
    if (key !== null) {
      const github = note ? null : this.githubEntry(key);
      const upload: MenuEntry[] = !note && filesOf(this.deps.bridge) ? [{ label: "Wgraj pliki…", icon: "upload", run: () => pickFiles((picked) => void this.addFiles(picked.map((file) => ({ file, dir: "" })), key)) }] : [];
      const permissions: MenuEntry[] = this.organization ? [{ label: "Uprawnienia…", icon: "lock", run: () => void editPermissions(this.deps.bridge, key, () => void this.reload()) }] : [];
      // On a row of the selection the download covers the whole selection.
      const keys = this.deps.tree.isSelected(key) ? this.deps.tree.selectedKeys() : [key];
      const zip: MenuEntry = { label: "Pobierz (.zip)", icon: "download", run: () => void exportNotes(this.deps.bridge, keys) };
      const openSide = this.deps.openSide;
      const item = this.noteAt(key);
      const side: MenuEntry[] = note && openSide && item ? [{ label: "Otwórz obok", icon: "panel-right", run: () => openSide(item) }] : [];
      entries.push(...(entries.length ? ["separator" as const] : []), ...upload, ...(github ? [github] : []), ...permissions, zip, ...side, ...this.noteActions(key, note));
    }
    if (entries.length) openMenu(x, y, entries);
  }

  // The folder's GitHub entry: its windows when it has links, else the connect window (only where GitHub is open).
  private githubEntry(folder: string): MenuEntry | null {
    const service = githubService();
    if (!service) return null;
    if (this.githubLinks.some((l) => l.projectPath === folder)) {
      return { label: "GitHub…", icon: "git-branch", run: () => this.githubWindow(folder, service) };
    }
    return { label: "Połącz z GitHubem…", icon: "git-branch", run: () => void this.connectFolder(folder, service) };
  }

  private async connectFolder(folder: string, service: GithubService): Promise<void> {
    await openConnectDialog(folder, service, "", { folder: true });
    await this.reload();
  }

  // The folder's links with their buttons (the same rows as on a project's screen), in a window named for the folder.
  private githubWindow(folder: string, service: GithubService): void {
    const name = baseName(folder);
    openDialog({
      label: `GitHub: ${name}`,
      className: "modal-confirm gh-dialog",
      render(box) {
        const status = el("div");
        box.append(el("h2", "", `GitHub: ${name}`), status);
        void renderGithubStatus(status, folder, service);
      },
      onClose: () => void this.reload(),
    });
  }

  private sortMenu(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const pick = (desc: boolean) => () => {
      this.desc = desc;
      this.deps.tree.setSort(desc);
    };
    openMenu(r.left, r.bottom + 4, [
      { label: "Nazwa A–Z", checked: !this.desc, run: pick(false) },
      { label: "Nazwa Z–A", checked: this.desc, run: pick(true) },
    ]);
  }
}
