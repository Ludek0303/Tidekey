//! The search pane of the left sidebar: a query box, the hits with their snippets, and the keys to walk them.

import type { Bridge, SearchHit } from "./bridge";
import { MARK_END, MARK_START } from "./bridge";
import { icon } from "./icons";
import type { AppHit, AppSearch } from "./ocr/appsearch";

const DEBOUNCE_MS = 150;
const PROGRESS_MS = 300;
const LIMIT = 50;

/** A result row: a note (as the bridge's search or the app index gives it) or a file of the app index. */
type Row =
  | { kind: "note"; hit: SearchHit; place: string }
  | { kind: "file"; hit: AppHit; note: string; more: number };

/** A snippet as DOM: the note's text as text nodes, the hits in <mark>. Nothing is parsed as HTML. */
export function snippetNodes(snippet: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let marked = false;
  let buf = "";
  const flush = () => {
    if (buf === "") return;
    if (marked) {
      const mark = document.createElement("mark");
      mark.textContent = buf;
      out.append(mark);
    } else {
      out.append(document.createTextNode(buf));
    }
    buf = "";
  };
  for (const ch of snippet) {
    if (ch === MARK_START || ch === MARK_END) {
      flush();
      marked = ch === MARK_START;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

export class SearchView {
  private readonly input = document.createElement("input");
  private readonly status = document.createElement("p");
  private readonly list = document.createElement("ul");
  private rows: Row[] = [];
  // the query the rows on screen answer (not the box's text: that may already be changed)
  private answered = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  /** `app`: the index of the notes and the files; without it (or without WASM) the bridge's search runs. */
  constructor(
    root: HTMLElement,
    private readonly bridge: Bridge,
    private readonly open: (hit: SearchHit) => void,
    private readonly app: AppSearch | null = null,
    private readonly openFile: (hit: AppHit, query: string) => void = () => {},
  ) {
    this.input.type = "search";
    this.input.className = "search-input";
    this.input.placeholder = "Szukaj w notatkach i plikach";
    this.input.setAttribute("aria-label", "Szukaj w notatkach i plikach");
    this.status.className = "muted search-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.textContent = "Wpisz słowo lub fragment, który chcesz znaleźć.";
    this.list.className = "search-results";
    this.list.setAttribute("aria-label", "Wyniki wyszukiwania");
    root.replaceChildren(this.input, this.status, this.list);

    this.input.addEventListener("input", () => this.schedule(DEBOUNCE_MS));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && this.buttons()[0]) {
        e.preventDefault();
        this.buttons()[0].focus();
      } else if (e.key === "Enter" && this.rows[0]) {
        e.preventDefault();
        this.activate(this.rows[0]);
      }
    });
    // the file part fills in the background: a finished file may add hits to the query on screen
    this.app?.subscribe(() => {
      clearTimeout(this.progressTimer);
      this.progressTimer = setTimeout(() => {
        if (this.input.value.trim() !== "") void this.run(this.input.value);
      }, PROGRESS_MS);
    });
    this.list.addEventListener("keydown", (e) => {
      const buttons = this.buttons();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" && at < buttons.length - 1) buttons[at + 1].focus();
      else if (e.key === "ArrowUp" && at > 0) buttons[at - 1].focus();
      else if (e.key === "ArrowUp" && at === 0) this.input.focus();
      else if (e.key === "Escape") this.input.focus();
      else return;
      e.preventDefault();
    });
  }

  /** Puts the cursor in the query box, optionally with a query to search for. */
  focus(query?: string): void {
    if (query !== undefined) {
      this.input.value = query;
      this.schedule(0);
    }
    this.input.focus();
    this.input.select();
  }

  /** The query as typed, for tests and for the palette. */
  get query(): string {
    return this.input.value;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    // Invalidate the previous request as soon as the query changes, including the debounce window.
    this.seq++;
    this.rows = [];
    this.list.replaceChildren();
    this.timer = setTimeout(() => void this.run(this.input.value), delay);
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.list.querySelectorAll<HTMLButtonElement>("button.search-hit")];
  }

  /** Runs the query and shows the hits; a late answer to an older query is dropped. */
  async run(query: string): Promise<void> {
    const seq = ++this.seq;
    this.status.dataset.state = "idle";
    this.list.setAttribute("aria-busy", "false");
    if (query.trim() === "") {
      this.rows = [];
      this.list.replaceChildren();
      this.status.textContent = "Wpisz słowo lub fragment, który chcesz znaleźć.";
      return;
    }
    this.rows = [];
    this.list.replaceChildren();
    this.list.setAttribute("aria-busy", "true");
    this.status.dataset.state = "loading";
    this.status.textContent = "Szukam w notatkach…";
    try {
      const rows = await this.find(query);
      if (seq !== this.seq) return;
      this.rows = rows;
      this.answered = query;
      this.list.replaceChildren(...rows.map((row) => this.item(row)));
      this.status.dataset.state = rows.length === 0 ? "empty" : "ready";
      const count = rows.length === 0 ? "Brak wyników" : `Wyników: ${rows.length}`;
      const files = this.app?.fileProgress();
      const loading = files && files.done < files.total ? ` · Indeks plików: ${files.done} z ${files.total}` : "";
      this.status.textContent = count + loading;
    } catch {
      if (seq !== this.seq) return;
      this.status.dataset.state = "error";
      this.status.textContent = "Nie udało się wyszukać notatek. Zmień zapytanie, aby spróbować ponownie.";
    } finally {
      if (seq === this.seq) this.list.setAttribute("aria-busy", "false");
    }
  }

  /** The rows for `query`: the app index when it loads, else the bridge's search over the notes. */
  private async find(query: string): Promise<Row[]> {
    const app = this.app;
    if (app && (await app.ensure())) {
      const page = app.search(query, LIMIT);
      return (page?.hits ?? []).map((hit): Row => hit.kind === "note"
        ? { kind: "note", hit: { id: hit.docId, path: hit.title, snippet: hit.snippet }, place: hit.place }
        : { kind: "file", hit, note: app.embedsOf(hit.docId)[0] ?? "", more: Math.max(0, app.embedsOf(hit.docId).length - 1) });
    }
    const hits = await this.bridge.call<SearchHit[]>("search", { query, limit: LIMIT });
    return hits.map((hit): Row => ({ kind: "note", hit, place: "" }));
  }

  private activate(row: Row): void {
    if (row.kind === "file") this.openFile(row.hit, this.answered);
    else this.open(row.hit);
  }

  private item(row: Row): HTMLLIElement {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-hit";
    button.addEventListener("click", () => this.activate(row));
    const name = document.createElement("strong");
    const where = document.createElement("span");
    where.className = "muted search-place";
    if (row.kind === "file") {
      name.append(icon("file-text"), document.createTextNode(` ${row.hit.title}`));
      const parts = [row.hit.place, row.note ? `w notatce ${row.note}${row.more ? ` +${row.more}` : ""}` : ""];
      where.textContent = parts.filter((p) => p !== "").map((p) => ` · ${p}`).join("");
    } else {
      name.textContent = row.hit.path;
      where.textContent = row.place === "" ? "" : ` · ${row.place}`;
    }
    const snippet = document.createElement("span");
    snippet.className = "search-snippet";
    snippet.append(snippetNodes(row.hit.snippet));
    button.append(name, where, snippet);
    li.append(button);
    return li;
  }
}
