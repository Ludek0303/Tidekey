import type { LockedFolder, TreeFile, TreeItem } from "./bridge";
import { fileKind, formatSize } from "./filestore";
import { icon, type IconName } from "./icons";
import { verificationBadge } from "./signing";

// Two clicks on one file row within this time open it (the system default is about 500 ms).
const DOUBLE_CLICK_MS = 450;
export const ROW_H = 34;
const OVERSCAN = 8;
// The chevron's width plus its gap: where a note's icon starts in its row.
const NOTE_LEAD = 20;
const INDENT = 14;

export interface FolderNode {
  kind: "folder";
  name: string;
  path: string;
  children: Node[];
  // A protected project folder (Stage E).
  locked?: LockedFolder;
}

export interface NoteNode {
  kind: "note";
  name: string;
  path: string;
  id: string;
  // A kanban board (kanban.ts): it sorts first in its folder and shows the board icon.
  board: boolean;
}

// A file that lies in a folder (folderfiles.ts): its key is its path, its name is the store's name.
export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  fileId: string;
  size?: number;
  mime?: string;
}

export type Node = FolderNode | NoteNode | FileNode;

// A listed file with what the tree shows of it: its size and type, from the file store (absent on the desktop).
export type TreeFileRow = TreeFile & { size?: number; mime?: string };

export interface Row {
  node: Node;
  depth: number;
  pos: number;
  size: number;
}

// Actions the explorer owns. Keys are note or folder paths; "" as a folder means the space root.
export interface TreeHooks {
  onRename?: (key: string, name: string) => void;
  // The dragged keys (the whole selection when the dragged row is in it), dropped into the folder.
  onMove?: (keys: string[], folder: string) => void;
  onDelete?: (key: string) => void;
  onContext?: (key: string | null, x: number, y: number) => void;
  // Files dragged in from the computer, dropped into the folder ("" is the root).
  onDropFiles?: (data: DataTransfer, folder: string) => void;
  onDownload?: (keys: string[]) => void;
  // A file in a folder was opened (click or Enter); bySpace when the space bar asked for it (the preview then closes with it).
  onOpenFile?: (fileId: string, name: string, bySpace?: boolean) => void;
}

// Files dragged from the computer carry "Files" in their types; an internal note drag carries only text.
const isFileDrag = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");

const collator = new Intl.Collator("pl", { numeric: true, sensitivity: "base" });

export function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

// Boards first, then folders, then notes, then files; desc reverses the order of names within each group.
const RANK: Record<Node["kind"], number> = { folder: 0, note: 1, file: 2 };
const rank = (n: Node): number => (n.kind === "note" && n.board ? -1 : RANK[n.kind]);
function compareNodes(a: Node, b: Node, desc: boolean): number {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const c = collator.compare(a.name, b.name);
  return desc ? -c : c;
}

function sortTree(folder: FolderNode, desc: boolean): void {
  folder.children.sort((a, b) => compareNodes(a, b, desc));
  for (const child of folder.children) if (child.kind === "folder") sortTree(child, desc);
}

// folders lists every folder, including empty ones, which the notes alone cannot show.
export function buildTree(items: TreeItem[], folders: string[] = [], desc = false, locked: LockedFolder[] = [], files: TreeFileRow[] = [], isBoard: (id: string) => boolean = () => false): FolderNode {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };
  const folderMap = new Map<string, FolderNode>([["", root]]);
  const folderFor = (dir: string): FolderNode => {
    const hit = folderMap.get(dir);
    if (hit) return hit;
    const slash = dir.lastIndexOf("/");
    const node: FolderNode = { kind: "folder", name: dir.slice(slash + 1), path: dir, children: [] };
    folderFor(slash < 0 ? "" : dir.slice(0, slash)).children.push(node);
    folderMap.set(dir, node);
    return node;
  };
  for (const dir of folders) folderFor(dir);
  for (const l of locked) folderFor(l.path).locked = l;
  for (const item of items) {
    const slash = item.path.lastIndexOf("/");
    const note: NoteNode = { kind: "note", name: item.path.slice(slash + 1), path: item.path, id: item.id, board: isBoard(item.id) };
    folderFor(slash < 0 ? "" : item.path.slice(0, slash)).children.push(note);
  }
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const node: FileNode = { kind: "file", name: file.path.slice(slash + 1), path: file.path, fileId: file.fileId, size: file.size, mime: file.mime };
    folderFor(slash < 0 ? "" : file.path.slice(0, slash)).children.push(node);
  }
  sortTree(root, desc);
  return root;
}

// Flattens only the expanded folders; the result is what the virtualized view indexes into.
export function flatten(root: FolderNode, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (folder: FolderNode, depth: number): void => {
    folder.children.forEach((node, i) => {
      rows.push({ node, depth, pos: i + 1, size: folder.children.length });
      if (node.kind === "folder" && expanded.has(node.path)) walk(node, depth + 1);
    });
  };
  walk(root, 0);
  return rows;
}

export class FileTree {
  hooks: TreeHooks = {};
  private root: FolderNode = { kind: "folder", name: "", path: "", children: [] };
  private expanded = new Set<string>();
  private rows: Row[] = [];
  private focusKey: string | null = null;
  private activeId: string | null = null;
  // Note id -> path, filled with the rows (setItems), so the active note's folder needs no tree walk.
  private readonly paths = new Map<string, string>();
  private desc = false;
  private loaded = false;
  // Whether a note is a kanban board; the index answers it (main.ts). refreshBoards re-sorts when that changes.
  isBoard: (id: string) => boolean = () => false;
  private listing: { items: TreeItem[]; folders: string[]; locked: LockedFolder[]; files: TreeFileRow[] } | null = null;
  private boardIds = new Set<string>();
  private renaming: { key: string; draft: string; onEnter?: () => void } | null = null;
  private rendering = false;
  private dragKeys: string[] | null = null;
  private frame = 0;
  private readonly spacer: HTMLElement;
  private selected = new Set<string>();
  // the file row a plain click picked: a selection of just it is not a bulk selection, so the bar stays hidden
  private picked: string | null = null;
  // the last plain click on a file row: a second one on the same row soon after opens it. The rows are drawn anew on
  // every click, so the browser's dblclick (which needs the same element twice) never reaches them.
  private lastFileClick: { key: string; at: number } | null = null;
  private anchor: string | null = null;
  private selectMode = false;
  private fileDrag = false;
  private dropRow: HTMLElement | null = null;
  // The line showing where a dragged note or folder will land; it lives in the spacer, at absolute row positions.
  private dropLine: HTMLElement | null = null;
  private readonly footer: HTMLElement;
  private readonly footerHint: HTMLElement;
  private readonly footerSel: HTMLElement;
  private readonly footerCount: HTMLElement;
  // Folder path -> the text of its GitHub mark (a link's project folder), set by the explorer.
  private githubMarks = new Map<string, string>();

  constructor(
    private readonly host: HTMLElement,
    private readonly onOpen: (id: string, path: string) => void,
  ) {
    host.setAttribute("role", "tree");
    host.setAttribute("aria-multiselectable", "true");
    host.setAttribute("aria-label", "Pliki i foldery");
    host.tabIndex = 0;
    this.spacer = document.createElement("div");
    this.spacer.className = "tree-spacer";
    host.append(this.spacer);

    // Under the tree, in the same pane: the drop hint and the bar of the selection.
    this.footer = document.createElement("div");
    this.footer.className = "tree-footer";
    this.footer.hidden = true;
    this.footerHint = document.createElement("p");
    this.footerHint.className = "tree-footer-hint";
    this.footerHint.textContent = "Upuść pliki .md, aby je dodać";
    this.footerSel = document.createElement("div");
    this.footerSel.className = "tree-footer-sel";
    this.footerCount = document.createElement("span");
    this.footerSel.append(
      this.footerCount,
      footerButton("Pobierz (.zip)", () => this.hooks.onDownload?.(this.selectedKeys())),
      footerButton("Wyczyść", () => this.clearSelection()),
    );
    this.footer.append(this.footerHint, this.footerSel);
    host.after(this.footer);

    host.addEventListener("scroll", () => this.scheduleRender());
    host.addEventListener("keydown", (e) => this.onKey(e));
    host.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("input")) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
      if (!el?.dataset.key) return;
      const key = el.dataset.key;
      this.focusKey = key;
      // Shift extends from the anchor; Ctrl/Cmd and select mode toggle one row; a plain click opens or folds it, and a
      // file row only selects (a double click opens it).
      this.picked = null;
      if (e.shiftKey) this.selectRange(key);
      else if (e.ctrlKey || e.metaKey || this.selectMode) {
        this.anchor = key;
        if (this.selected.has(key)) this.selected.delete(key);
        else this.selected.add(key);
      } else {
        this.anchor = key;
        const node = this.nodeAt(key);
        const file = node?.kind === "file";
        this.selected = new Set(file ? [key] : []);
        if (file) this.picked = key;
        const now = Date.now();
        if (node?.kind === "file" && this.lastFileClick?.key === key && now - this.lastFileClick.at < DOUBLE_CLICK_MS) {
          this.lastFileClick = null;
          this.hooks.onOpenFile?.(node.fileId, node.name);
        } else this.lastFileClick = file ? { key, at: now } : null;
        if (!file) this.activateFocused();
      }
      this.render();
    });
    host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
      if (el) {
        this.focusKey = el.dataset.key ?? null;
        this.render();
      }
      this.hooks.onContext?.(el?.dataset.key ?? null, e.clientX, e.clientY);
    });
    host.addEventListener("dragstart", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
      if (!el) return;
      // A row of the selection takes the whole selection along; the dragged row comes first (the drop line follows it).
      const key = el.dataset.key ?? "";
      this.dragKeys = this.selected.has(key) ? [key, ...[...this.selected].filter((k) => k !== key)] : [key];
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.dragKeys.join("\n"));
      }
    });
    host.addEventListener("dragover", (e) => {
      if (this.dragKeys === null) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        this.setFileDrag(true, this.folderAt(e.target as HTMLElement));
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.showMoveTarget(this.folderAt(e.target as HTMLElement));
    });
    host.addEventListener("dragleave", (e) => {
      if (host.contains(e.relatedTarget as globalThis.Node | null)) return;
      this.setFileDrag(false);
      this.clearMoveTarget();
    });
    host.addEventListener("drop", (e) => {
      if (this.dragKeys === null) {
        if (!e.dataTransfer || !isFileDrag(e)) return;
        e.preventDefault();
        this.setFileDrag(false);
        this.hooks.onDropFiles?.(e.dataTransfer, this.folderAt(e.target as HTMLElement));
        return;
      }
      e.preventDefault();
      const keys = this.dragKeys;
      this.dragKeys = null;
      this.clearMoveTarget();
      this.hooks.onMove?.(keys, this.folderAt(e.target as HTMLElement));
    });
    host.addEventListener("dragend", () => {
      this.dragKeys = null;
      this.clearMoveTarget();
    });
  }

  selectedKeys(): string[] {
    return [...this.selected];
  }

  isSelected(key: string): boolean {
    return this.selected.has(key);
  }

  clearSelection(): void {
    this.selected = new Set();
    this.anchor = null;
    this.render();
  }

  // The "Zaznacz" mode for touch screens: plain taps toggle rows and show checkboxes. Returns the new state.
  toggleSelectMode(): boolean {
    this.selectMode = !this.selectMode;
    this.host.classList.toggle("is-select-mode", this.selectMode);
    if (!this.selectMode) this.selected = new Set();
    this.render();
    return this.selectMode;
  }

  /** Shown when the tree has no rows; an editor of an organization cannot create at the root, so the explorer says so. */
  emptyText = "Twoja biblioteka jest pusta. Utwórz pierwszą notatkę przyciskiem powyżej.";

  /** Rebuilds the listing when a note became or stopped being a board (after the index has read an edit). */
  refreshBoards(): void {
    if (!this.listing) return;
    const { items, folders, locked, files } = this.listing;
    const boards = items.filter((i) => this.isBoard(i.id));
    if (boards.length === this.boardIds.size && boards.every((i) => this.boardIds.has(i.id))) return;
    this.setItems(items, folders, locked, files);
  }

  setItems(items: TreeItem[], folders: string[] = [], locked: LockedFolder[] = [], files: TreeFileRow[] = []): void {
    this.listing = { items, folders, locked, files };
    this.boardIds = new Set(items.filter((i) => this.isBoard(i.id)).map((i) => i.id));
    this.root = buildTree(items, folders, this.desc, locked, files, this.isBoard);
    // Rows that were deleted or moved away leave the selection.
    const known = new Set<string>();
    this.paths.clear();
    const walk = (folder: FolderNode): void => {
      for (const child of folder.children) {
        known.add(child.path);
        if (child.kind === "folder") walk(child);
        else if (child.kind === "note" && !this.paths.has(child.id)) this.paths.set(child.id, child.path);
      }
    };
    walk(this.root);
    this.selected = new Set([...this.selected].filter((key) => known.has(key)));
    // Top-level folders start open on the first load; later loads keep what the user opened.
    if (!this.loaded) {
      this.expanded = new Set(this.root.children.filter((n) => n.kind === "folder").map((n) => n.path));
      this.loaded = true;
    }
    this.rebuild();
  }

  /** Marks the folders that hold a GitHub link; `marks` maps a folder path to the mark's text. */
  setGithubMarks(marks: Map<string, string>): void {
    this.githubMarks = marks;
    this.rebuild();
  }

  setSort(desc: boolean): void {
    this.desc = desc;
    sortTree(this.root, desc);
    this.rebuild();
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.render();
  }

  collapseAll(): void {
    this.expanded.clear();
    this.rebuild();
  }

  expandAll(): void {
    const walk = (folder: FolderNode) => {
      for (const child of folder.children) {
        if (child.kind !== "folder") continue;
        this.expanded.add(child.path);
        walk(child);
      }
    };
    walk(this.root);
    this.rebuild();
  }

  // Opens every parent of path and focuses it, so it is visible and selected.
  reveal(path: string): void {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
    this.focusKey = path;
    this.rebuild();
    const idx = this.indexOfFocus();
    if (idx >= 0) this.ensureVisible(idx);
    this.render();
  }

  // The folder that new items go into: the focused folder, or the focused note's folder. null when nothing is focused.
  selectedFolder(): string | null {
    const idx = this.indexOfFocus();
    if (idx < 0) return null;
    const { node } = this.rows[idx];
    return node.kind === "folder" ? node.path : parentOf(node.path);
  }

  // Inline rename: the row's label becomes a text field. Enter or blur commits, Esc cancels.
  startRename(key: string, onEnter?: () => void): void {
    const idx = this.rows.findIndex((r) => r.node.path === key);
    if (idx < 0) return;
    const { node } = this.rows[idx];
    this.focusKey = key;
    const draft = node.kind === "note" ? node.name.replace(/\.md$/, "") : node.name;
    this.renaming = { key, draft, onEnter };
    this.ensureVisible(idx);
    this.render();
  }

  private finishRename(commit: boolean, byEnter = false): void {
    const r = this.renaming;
    if (!r) return;
    this.renaming = null;
    const name = r.draft.trim();
    if (commit && name) this.hooks.onRename?.(r.key, name);
    this.render();
    this.host.focus();
    if (commit && byEnter) r.onEnter?.();
  }

  // Selects the rows from the anchor to key, in the order they are shown.
  private selectRange(key: string): void {
    const from = this.rows.findIndex((r) => r.node.path === this.anchor);
    const to = this.rows.findIndex((r) => r.node.path === key);
    if (from < 0 || to < 0) {
      this.selected = new Set([key]);
      return;
    }
    const [a, b] = from < to ? [from, to] : [to, from];
    this.selected = new Set(this.rows.slice(a, b + 1).map((r) => r.node.path));
  }

  // Shows the drop hint, and marks the folder the files would go into ("" is the whole tree).
  private setFileDrag(on: boolean, folder = ""): void {
    // Only the footer changes: re-rendering the rows would replace the element under the cursor mid-drag.
    if (on !== this.fileDrag) {
      this.fileDrag = on;
      this.updateFooter();
    }
    this.highlightDrop(on ? folder : null);
  }

  private highlightDrop(folder: string | null): void {
    this.dropRow?.classList.remove("is-drop");
    this.dropRow = null;
    this.host.classList.toggle("is-drop-root", folder === "");
    if (!folder) return;
    const row = [...this.spacer.children].find((el): el is HTMLElement => (el as HTMLElement).dataset?.key === folder);
    if (row) {
      row.classList.add("is-drop");
      this.dropRow = row;
    }
  }

  // While a note or folder is dragged inside the tree: highlights the target folder and draws the line where the
  // dragged item would sort among that folder's visible children (just under the folder when it has none shown).
  private showMoveTarget(folder: string): void {
    this.highlightDrop(folder);
    this.dropLine?.remove();
    const dragged = this.rows.find((r) => r.node.path === this.dragKeys?.[0])?.node;
    const fi = folder === "" ? -1 : this.rows.findIndex((r) => r.node.path === folder);
    const parent = fi < 0 ? this.root : this.rows[fi].node;
    const kids = parent.kind === "folder" && (fi < 0 || this.expanded.has(folder)) ? parent.children : [];
    const at = dragged ? kids.findIndex((c) => compareNodes(dragged, c, this.desc) < 0) : -1;
    // The line sits at the top edge of the row it precedes, or below the last visible row of the folder.
    let y = at >= 0 ? this.rows.findIndex((r) => r.node === kids[at]) : fi + 1;
    if (at < 0) while (y < this.rows.length && this.rows[y].depth > (fi < 0 ? -1 : this.rows[fi].depth)) y++;
    const line = document.createElement("div");
    line.className = "tree-drop-line";
    line.style.top = `${y * ROW_H - 1}px`;
    line.style.left = `${(fi < 0 ? 0 : this.rows[fi].depth + 1) * INDENT + 4}px`;
    this.spacer.append(line);
    this.dropLine = line;
  }

  private clearMoveTarget(): void {
    this.highlightDrop(null);
    this.dropLine?.remove();
    this.dropLine = null;
  }

  private folderAt(target: HTMLElement): string {
    const row = target.closest<HTMLElement>("[data-key]");
    if (!row?.dataset.key) return "";
    return row.classList.contains("is-folder") ? row.dataset.key : parentOf(row.dataset.key);
  }

  private rebuild(): void {
    this.rows = flatten(this.root, this.expanded);
    this.render();
  }

  // The first collapsed folder on the way to the active note is the outermost visible one; deeper ones are hidden.
  private markedFolder(): string | null {
    const path = this.activeId === null ? undefined : this.paths.get(this.activeId);
    if (!path) return null;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.expanded.has(dir)) return dir;
    }
    return null;
  }

  private scheduleRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private indexOfFocus(): number {
    return this.rows.findIndex((r) => r.node.path === this.focusKey);
  }

  private nodeAt(key: string): Node | undefined {
    return this.rows.find((r) => r.node.path === key)?.node;
  }

  private render(): void {
    const top = this.host.scrollTop;
    const viewH = this.host.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);
    const focusIdx = this.indexOfFocus();
    const marked = this.markedFolder();

    this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    this.updateFooter();
    const frag = document.createDocumentFragment();
    if (this.rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tree-empty";
      empty.textContent = this.emptyText;
      frag.append(empty);
    }
    for (let i = first; i < last; i++) frag.append(this.rowEl(i, i === focusIdx, marked));
    if (this.dropLine) frag.append(this.dropLine);
    // Replacing the rows detaches the rename field; that must not count as leaving it.
    this.rendering = true;
    this.spacer.replaceChildren(frag);
    this.rendering = false;
    const input = this.spacer.querySelector<HTMLInputElement>(".tree-rename");
    if (input) {
      input.focus();
      input.select();
    }
    if (focusIdx >= 0) this.host.setAttribute("aria-activedescendant", rowId(focusIdx));
    else this.host.removeAttribute("aria-activedescendant");
  }

  private rowEl(i: number, focused: boolean, marked: string | null): HTMLElement {
    const { node, depth, pos, size } = this.rows[i];
    const el = document.createElement("div");
    el.id = rowId(i);
    el.className = "tree-row";
    el.dataset.key = node.path;
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(depth + 1));
    el.setAttribute("aria-posinset", String(pos));
    el.setAttribute("aria-setsize", String(size));
    el.style.top = `${i * ROW_H}px`;
    el.style.height = `${ROW_H}px`;
    // Indentation sits outside the row box, so the highlight starts at the row's icon, not at the tree's edge. A note
    // has no chevron: its box starts NOTE_LEAD further in, and the icon stays where it was (see .tree-row in CSS).
    const lead = depth * INDENT + (node.kind === "folder" ? 0 : NOTE_LEAD);
    el.style.left = `${lead}px`;
    el.style.width = `calc(100% - ${4 + lead}px)`;
    el.classList.toggle("is-focus", focused);
    // Notes and folders drag; a row being renamed does not, so selecting text in its field cannot start a move.
    el.setAttribute("draggable", String(this.renaming?.key !== node.path));
    el.classList.toggle("is-folder", node.kind === "folder");
    const hidesActive = node.kind === "folder" && node.path === marked;
    el.classList.toggle("has-active", hidesActive);
    if (hidesActive) el.setAttribute("aria-description", "Zawiera otwartą notatkę");
    const selected = this.selected.has(node.path);
    el.classList.toggle("is-selected", selected);
    if (this.selected.size > 0) el.setAttribute("aria-selected", String(selected));
    else if (node.kind === "note") el.setAttribute("aria-selected", String(node.id === this.activeId));
    if (this.selectMode) {
      const box = document.createElement("span");
      box.className = selected ? "tree-check is-on" : "tree-check";
      box.setAttribute("aria-hidden", "true");
      el.append(box);
    }

    if (this.renaming?.key === node.path) {
      el.classList.add("is-renaming");
      el.append(this.renameInput(this.renaming.draft));
      return el;
    }

    const label = document.createElement("span");
    label.className = "tree-label";
    const name = document.createElement("span");
    name.className = "tree-label-text";
    name.textContent = node.kind === "note" ? node.name.replace(/\.md$/, "") : node.name;
    el.title = node.path;
    if (node.kind === "file") {
      el.classList.add("is-file");
      label.append(icon(FILE_ICON[fileKind(node.name, node.mime ?? "")]), name);
      if (node.size !== undefined) {
        const size = document.createElement("span");
        size.className = "tree-size";
        size.textContent = formatSize(node.size);
        label.append(size);
      }
      el.append(label);
      return el;
    }
    if (node.kind === "folder") {
      const open = this.expanded.has(node.path);
      el.setAttribute("aria-expanded", String(open));
      const chevron = document.createElement("span");
      chevron.className = "tree-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.append(icon(open ? "chevron-down" : "chevron-right"));
      label.append(chevron, icon("folder"), name);
      // A protected folder shows to its members only, as any folder; the badge is only for a signature that did not check.
      if (node.locked) {
        const badge = verificationBadge(node.locked.check);
        if (badge) label.append(badge);
      }
      const mark = this.githubMarks.get(node.path);
      if (mark) label.append(githubMark(mark));
    } else {
      el.classList.toggle("is-active", node.id === this.activeId);
      label.append(icon(node.board ? "columns-3" : "file-text"), name);
    }
    el.append(label);
    return el;
  }

  private renameInput(draft: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-rename";
    input.setAttribute("aria-label", "Nowa nazwa");
    input.value = draft;
    input.addEventListener("input", () => {
      if (this.renaming) this.renaming.draft = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        if (this.renaming) this.renaming.draft = input.value;
        this.finishRename(e.key === "Enter", true);
      }
    });
    input.addEventListener("blur", () => {
      if (this.rendering) return;
      if (this.renaming) this.renaming.draft = input.value;
      this.finishRename(true);
    });
    return input;
  }

  private updateFooter(): void {
    const n = this.selected.size;
    const bulk = n > 1 || (n === 1 && !this.selected.has(this.picked ?? ""));
    this.footer.hidden = !this.fileDrag && !bulk;
    this.footerHint.hidden = !this.fileDrag;
    this.footerSel.hidden = n === 0;
    this.footerCount.textContent = `Zaznaczono: ${n}`;
  }

  private ensureVisible(i: number): void {
    const top = i * ROW_H;
    const viewH = this.host.clientHeight || 600;
    if (top < this.host.scrollTop) this.host.scrollTop = top;
    else if (top + ROW_H > this.host.scrollTop + viewH) this.host.scrollTop = top + ROW_H - viewH;
  }

  private moveFocus(i: number): void {
    if (this.rows.length === 0) return;
    const idx = Math.min(this.rows.length - 1, Math.max(0, i));
    this.focusKey = this.rows[idx].node.path;
    this.ensureVisible(idx);
    this.render();
  }

  private toggle(path: string, open: boolean): void {
    if (open) this.expanded.add(path);
    else this.expanded.delete(path);
    this.rebuild();
    if (open) {
      this.spacer.classList.add("is-expanding");
      setTimeout(() => this.spacer.classList.remove("is-expanding"), 200);
    }
  }

  private activateFocused(): void {
    const idx = this.indexOfFocus();
    if (idx < 0) return;
    const { node } = this.rows[idx];
    if (node.kind === "folder") this.toggle(node.path, !this.expanded.has(node.path));
    else if (node.kind === "note") this.onOpen(node.id, node.path);
    else this.hooks.onOpenFile?.(node.fileId, node.name);
  }

  private onKey(e: KeyboardEvent): void {
    // Keys typed into the rename field belong to the field, not to the tree.
    if (e.target !== this.host) return;
    const idx = this.indexOfFocus();
    const cur = idx >= 0 ? this.rows[idx] : null;
    let handled = true;
    if (e.key === "Escape" && this.selected.size > 0) {
      this.clearSelection();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      this.selected = new Set(this.rows.map((r) => r.node.path));
      this.render();
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        this.moveFocus(idx + 1);
        break;
      case "ArrowUp":
        this.moveFocus(idx < 0 ? 0 : idx - 1);
        break;
      case "Home":
        this.moveFocus(0);
        break;
      case "End":
        this.moveFocus(this.rows.length - 1);
        break;
      case "ArrowRight":
        if (cur?.node.kind === "folder" && !this.expanded.has(cur.node.path)) this.toggle(cur.node.path, true);
        else this.moveFocus(idx + 1);
        break;
      case "ArrowLeft":
        if (cur?.node.kind === "folder" && this.expanded.has(cur.node.path)) {
          this.toggle(cur.node.path, false);
        } else if (cur && cur.depth > 0) {
          let parent = idx - 1;
          while (parent > 0 && this.rows[parent].depth >= cur.depth) parent--;
          this.moveFocus(parent);
        }
        break;
      case "Enter":
        this.activateFocused();
        break;
      case " ":
        if (cur?.node.kind !== "file") {
          handled = false;
          break;
        }
        this.hooks.onOpenFile?.(cur.node.fileId, cur.node.name, true);
        break;
      case "F2":
        if (cur) this.startRename(cur.node.path);
        break;
      case "Delete":
        if (cur) this.hooks.onDelete?.(cur.node.path);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }
}

// A small branch mark after a folder's name: a folder that is connected to GitHub. Its text is the title and the label.
function githubMark(text: string): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "tree-github";
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", text);
  mark.title = text;
  mark.append(icon("git-branch"));
  return mark;
}

// The icon of a file row by its kind: picture, PDF, sheet, archive, anything else.
const FILE_ICON: Record<ReturnType<typeof fileKind>, IconName> = {
  image: "image", pdf: "file-text", sheet: "sheet", archive: "file-archive", document: "file", slides: "file", audio: "file", video: "file", other: "file",
};

function footerButton(label: string, run: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = label;
  btn.addEventListener("click", run);
  return btn;
}

function rowId(i: number): string {
  return `tree-row-${i}`;
}
