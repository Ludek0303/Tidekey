import type { TreeItem } from "./bridge";

const MAX_RESULTS = 50;

// Subsequence match: every query char must appear in order. Consecutive chars and
// word starts (after "/", " ", "-", "_", ".") score higher; long gaps score lower.
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const p = path.toLowerCase();
  let score = 0;
  let pos = -1;
  let prev = -2;
  for (const ch of q) {
    const idx = p.indexOf(ch, pos + 1);
    if (idx < 0) return null;
    score += 1;
    if (idx === prev + 1) score += 5;
    if (idx === 0 || "/ _-.".includes(p[idx - 1])) score += 4;
    score -= Math.min(idx - pos - 1, 10) * 0.2;
    prev = idx;
    pos = idx;
  }
  return score - path.length * 0.01;
}

/** The name the quick switcher creates: the query trimmed, without a trailing ".md". */
export const noteNameFromQuery = (query: string): string => query.trim().replace(/\.md$/i, "").trim();

// Dialog for Ctrl+P. Focus stays in the input; onClose lets the caller return focus to the editor.
// onCreate (the quick switcher only) makes a note at a path; the bridge refuses a bad path, and the caller shows why.
export class QuickOpen {
  private root: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private items: TreeItem[] = [];
  private results: TreeItem[] = [];
  private sel = 0;

  constructor(
    private readonly onPick: (item: TreeItem) => void,
    private readonly onClose: () => void,
    private readonly onCreate?: (path: string) => void,
  ) {}

  open(items: TreeItem[], label = "Otwórz notatkę"): void {
    if (this.root) return;
    this.items = items;
    const root = document.createElement("div");
    root.className = "qo-backdrop";
    root.innerHTML = `
      <div class="qo" role="dialog" aria-modal="true" aria-labelledby="qo-title">
        <span id="qo-title" class="sr-only">${label}</span>
        <input class="qo-input" type="text" role="combobox" aria-autocomplete="list"
          aria-expanded="true" aria-controls="qo-list" aria-label="Znajdź notatkę" placeholder="${label}…" />
        <ul class="qo-list" id="qo-list" role="listbox" aria-label="Wyniki"></ul>
        <p class="qo-empty" role="status" hidden></p>
        <p class="qo-hint"><kbd>↑</kbd> <kbd>↓</kbd> wybierz &nbsp; <kbd>Enter</kbd> otwórz &nbsp; ${this.onCreate ? "<kbd>Shift</kbd>+<kbd>Enter</kbd> utwórz &nbsp; " : ""}<kbd>Esc</kbd> zamknij</p>
      </div>`;
    this.root = root;
    this.input = root.querySelector<HTMLInputElement>(".qo-input");
    this.list = root.querySelector<HTMLElement>(".qo-list");
    this.input!.addEventListener("input", () => this.filter());
    this.input!.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    document.body.append(root);
    this.filter();
    this.input!.focus();
  }

  close(): void {
    if (!this.root) return;
    this.root.remove();
    this.root = this.input = this.list = null;
    this.onClose();
  }

  private filter(): void {
    const query = this.input?.value ?? "";
    const scored: { item: TreeItem; score: number }[] = [];
    for (const item of this.items) {
      const score = fuzzyScore(query, item.path);
      if (score !== null) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.item.path < b.item.path ? -1 : 1));
    this.results = scored.slice(0, MAX_RESULTS).map((s) => s.item);
    this.sel = 0;
    this.renderList();
  }

  private renderList(): void {
    if (!this.list || !this.input) return;
    const opts = this.results.map((item, i) => {
      const li = document.createElement("li");
      li.id = `qo-opt-${i}`;
      li.className = `qo-option${i === this.sel ? " is-sel" : ""}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === this.sel));
      li.textContent = item.path;
      li.addEventListener("click", () => this.pick(i));
      return li;
    });
    this.list.replaceChildren(...opts);
    const empty = this.root?.querySelector<HTMLElement>(".qo-empty");
    if (empty) {
      const name = noteNameFromQuery(this.input.value);
      empty.textContent = name && this.onCreate ? `Nie znaleziono notatki. Enter utworzy „${name}”.` : "Nie znaleziono notatki. Spróbuj wpisać krótszą nazwę.";
      empty.hidden = this.results.length > 0;
    }
    if (this.results.length > 0) this.input.setAttribute("aria-activedescendant", `qo-opt-${this.sel}`);
    else this.input.removeAttribute("aria-activedescendant");
  }

  private pick(i: number): void {
    const item = this.results[i];
    if (item) this.choose(item);
  }

  private choose(item: TreeItem): void {
    this.close();
    this.onPick(item);
  }

  // Enter with nothing found, or Shift+Enter: the note the query names. A note already at that path opens instead.
  private createFromQuery(): void {
    const name = noteNameFromQuery(this.input?.value ?? "");
    if (!name || !this.onCreate) return;
    const path = `${name}.md`;
    const existing = this.items.find((i) => i.path.toLowerCase() === path.toLowerCase());
    if (existing) return this.choose(existing);
    this.close();
    this.onCreate(path);
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        this.close();
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const n = this.results.length;
        if (n === 0) break;
        this.sel = (this.sel + dir + n) % n;
        this.renderList();
        this.list?.children[this.sel]?.scrollIntoView({ block: "nearest" });
        break;
      }
      case "Enter":
        if (e.shiftKey || this.results.length === 0) this.createFromQuery();
        else this.pick(this.sel);
        break;
      case "Tab":
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
