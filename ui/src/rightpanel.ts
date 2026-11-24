//! The right panel of the note: linked and unlinked mentions, the outline of the open note, its tags, and its
//! versions with a preview and restore (ARCHITEKTURA §4.13, §4.15).

import type { Bridge, SearchHit, VersionItem } from "./bridge";
import { blocks } from "./linediff";
import type { RawGraph } from "./noteindex";
import { confirmDialog, errorText, toast } from "./widgets";

export type PanelTab = "backlinks" | "outline" | "tags" | "versions" | "task";

/** Runs `fn` once, `ms` after the last call. Used where updates arrive in bursts (remote keystrokes). */
export function trailing(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

const TABS: Array<[PanelTab, string]> = [
  ["backlinks", "Odnośniki zwrotne"],
  ["outline", "Konspekt"],
  ["tags", "Tagi"],
  ["versions", "Wersje"],
];

export interface NoteRef {
  id: string;
  path: string;
  text: string;
}

export interface PanelDeps {
  bridge: Bridge;
  graph: () => RawGraph | null;
  open: (id: string, path: string) => void;
  jump: (line: number) => void;
  search: (query: string) => void;
  restored: () => void;
}

export class RightPanel {
  private tab: PanelTab = "backlinks";
  private note: NoteRef | null = null;
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly body = document.createElement("div");
  // Each render counts, so that a slow answer for an earlier note or tab is dropped.
  private seq = 0;
  private taskContent: (() => Promise<HTMLElement[]>) | null = null;
  private taskNote: string | null = null;

  constructor(
    root: HTMLElement,
    private readonly deps: PanelDeps,
  ) {
    const list = document.createElement("div");
    list.className = "rp-tabs";
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-label", "Panel notatki");
    for (const [tab, label] of TABS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rp-tab";
      b.setAttribute("role", "tab");
      b.dataset.tab = tab;
      b.textContent = label;
      b.addEventListener("click", () => this.show(tab));
      b.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const index = e.key === "Home" ? 0 : e.key === "End" ? this.tabs.length - 1
          : (this.tabs.indexOf(b) + (e.key === "ArrowRight" ? 1 : -1) + this.tabs.length) % this.tabs.length;
        this.tabs[index].click();
        this.tabs[index].focus();
      });
      this.tabs.push(b);
      list.append(b);
    }
    this.body.className = "rp-body";
    this.body.setAttribute("role", "tabpanel");
    root.replaceChildren(list, this.body);
    this.mark();
  }

  /** The open note, or null when none is open. A task of another note is dropped: the panel shows the active note. */
  setNote(note: NoteRef | null): void {
    this.note = note;
    if (this.tab === "task" && note?.id !== this.taskNote) this.clearTask();
    void this.render();
  }

  show(tab: PanelTab): void {
    this.tab = tab;
    this.mark();
    void this.render();
  }

  /** Shows a task of note `noteId` (tab "task"): `content` builds the panel's body each time it is shown. */
  showTask(content: () => Promise<HTMLElement[]>, noteId: string): void {
    this.tab = "task";
    this.taskContent = content;
    this.taskNote = noteId;
    this.mark();
    void this.render();
  }

  /** Drops the task view; the panel goes back to the backlinks. */
  clearTask(): void {
    if (this.tab !== "task") return;
    this.tab = "backlinks";
    this.taskContent = null;
    this.taskNote = null;
    this.mark();
    void this.render();
  }

  private mark(): void {
    for (const b of this.tabs) {
      const on = b.dataset.tab === this.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  private async render(): Promise<void> {
    const seq = ++this.seq;
    const content = await this.content();
    if (seq === this.seq) this.body.replaceChildren(...content);
  }

  private async content(): Promise<HTMLElement[]> {
    if (this.tab === "task") return this.taskContent ? this.taskContent() : [];
    const note = this.note;
    if (!note) return [para("Otwórz notatkę, aby zobaczyć jej odnośniki, konspekt, tagi i wersje.")];
    switch (this.tab) {
      case "backlinks":
        return this.backlinks(note);
      case "outline":
        return this.outline(note);
      case "tags":
        return this.tags();
      case "versions":
        return this.versions(note);
    }
  }

  private async backlinks(note: NoteRef): Promise<HTMLElement[]> {
    const graph = this.deps.graph();
    if (!graph) return [para("Indeks linków jeszcze się ładuje.")];
    const paths = new Map(graph.nodes.map((n) => [n.id, n.path]));
    const linked = graph.edges.filter(([, target]) => target === note.id).map(([source]) => source);
    const linkedSet = new Set(linked);
    const title = note.path.split("/").pop()!.replace(/\.md$/, "");
    const mentions = await this.deps.bridge.call<SearchHit[]>("search", { query: title, limit: 30 });
    const unlinked = mentions.filter((h) => h.id !== note.id && !linkedSet.has(h.id));
    return [
      heading("Linki"),
      ...(linked.length ? linked.map((id) => this.noteButton(id, paths.get(id) ?? id)) : [para("Brak linków.")]),
      heading("Wzmianki bez linku"),
      ...(unlinked.length ? unlinked.map((h) => this.noteButton(h.id, h.path, h.snippet)) : [para("Brak wzmianek.")]),
    ];
  }

  private outline(note: NoteRef): HTMLElement[] {
    const heads: HTMLElement[] = [];
    note.text.split("\n").forEach((line, i) => {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!m) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rp-item rp-heading";
      b.style.paddingLeft = `${(m[1].length - 1) * 12}px`;
      b.textContent = m[2];
      b.addEventListener("click", () => this.deps.jump(i));
      heads.push(b);
    });
    return heads.length ? heads : [para("Notatka nie ma nagłówków.")];
  }

  private tags(): HTMLElement[] {
    const graph = this.deps.graph();
    if (!graph) return [para("Indeks linków jeszcze się ładuje.")];
    const counts = new Map<string, number>();
    for (const n of graph.nodes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (counts.size === 0) return [para("Brak tagów.")];
    return [...counts]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([tag, n]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rp-item";
        b.textContent = `#${tag} (${n})`;
        b.addEventListener("click", () => this.deps.search(tag));
        return b;
      });
  }

  private async versions(note: NoteRef): Promise<HTMLElement[]> {
    const items = await this.deps.bridge.call<VersionItem[]>("list_versions", { id: note.id });
    if (items.length === 0) return [para("Brak zapisanych wersji.")];
    return items.map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rp-item";
      const when = new Date(v.time_ms).toLocaleString("pl-PL");
      b.textContent = `${when}, ${v.reason}`;
      b.addEventListener("click", () => void this.preview(note, v));
      return b;
    });
  }

  // The version against the current text: lines only in the version are marked "−", lines only now "+".
  private async preview(note: NoteRef, v: VersionItem): Promise<void> {
    try {
      const old = await this.deps.bridge.call<string>("version_text", { vid: v.id });
      const diff = blocks(old, note.text).flatMap((block): HTMLElement[] => {
        if ("same" in block) return block.same.map((line) => diffLine(" ", line, ""));
        return [...block.ours.map((line) => diffLine("−", line, "rp-del")), ...block.theirs.map((line) => diffLine("+", line, "rp-add"))];
      });
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn";
      restore.textContent = "Przywróć";
      restore.addEventListener("click", () => void this.restore(note, v));
      this.body.replaceChildren(heading(`Wersja: ${v.reason}`), ...diff, restore);
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  private async restore(note: NoteRef, v: VersionItem): Promise<void> {
    const ok = await confirmDialog("Przywrócić tę wersję? Obecna treść zostanie zapisana jako wersja.", "Przywróć");
    if (!ok) return;
    try {
      await this.deps.bridge.call("restore_version", { id: note.id, vid: v.id });
      this.deps.restored();
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  private noteButton(id: string, path: string, snippet?: string): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rp-item";
    b.textContent = path;
    if (snippet) b.title = snippet.replace(/[\u0002\u0003]/g, "");
    b.addEventListener("click", () => this.deps.open(id, path));
    return b;
  }
}

function para(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "muted rp-note";
  p.textContent = text;
  return p;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "rp-heading-title";
  h.textContent = text;
  return h;
}

function diffLine(mark: string, line: string, cls: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `rp-line ${cls}`.trim();
  div.textContent = `${mark} ${line}`;
  return div;
}
