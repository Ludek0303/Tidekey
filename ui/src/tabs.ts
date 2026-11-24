import { registerCommand } from "./commands";
import { icon, iconButton } from "./icons";

export interface TabInfo {
  id: string;
  title: string;
}

// Tab strip only: the caller owns the open list and swaps editor states.
export class TabBar {
  private activeId: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly onSelect: (id: string) => void,
    private readonly onClose: (id: string) => void = () => undefined,
  ) {
    host.setAttribute("role", "tablist");
    host.setAttribute("aria-label", "Otwarte notatki");
    host.setAttribute("aria-orientation", "horizontal");
    host.addEventListener("keydown", (e) => this.onKey(e));
    // Ctrl+W is the browser's own close-tab key, so the tab command takes Ctrl+Alt+W.
    registerCommand({
      id: "tab.close",
      name: "Zamknij kartę",
      hotkey: "Ctrl+Alt+W",
      run: () => {
        if (this.activeId) this.onClose(this.activeId);
      },
    });
  }

  render(tabs: TabInfo[], activeId: string | null): void {
    this.activeId = activeId;
    const els = tabs.map((t) => {
      const el = document.createElement("div");
      const selected = t.id === activeId;
      el.id = `tab-${t.id}`;
      el.className = `tab${selected ? " is-active" : ""}`;
      el.dataset.id = t.id;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(selected));
      el.tabIndex = selected ? 0 : -1;
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = t.title;
      const close = iconButton("x", `Zamknij kartę ${t.title}`, "icon-btn tab-close");
      close.tabIndex = -1;
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onClose(t.id);
      });
      el.append(icon(t.id === "__graph__" ? "git-fork" : "file-text"), title, close);
      el.addEventListener("click", () => this.onSelect(t.id));
      // Middle click closes the tab; the button default (autoscroll) is suppressed.
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault();
      });
      el.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        this.onClose(t.id);
      });
      return el;
    });
    this.host.replaceChildren(...els);
  }

  private onKey(e: KeyboardEvent): void {
    // Delete and Ctrl+F4 close the focused tab, which need not be the active one.
    if (e.key === "Delete" || (e.ctrlKey && e.key === "F4")) {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[role=tab]")?.dataset.id;
      if (!id) return;
      e.preventDefault();
      this.onClose(id);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = [...this.host.querySelectorAll<HTMLElement>("[role=tab]")];
    const cur = tabs.findIndex((el) => el.getAttribute("aria-selected") === "true");
    if (cur < 0 || tabs.length === 0) return;
    const next = (cur + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    const id = tabs[next].dataset.id ?? "";
    this.onSelect(id);
    // onSelect re-renders the strip, so the tab is looked up again; the old element is detached.
    [...this.host.querySelectorAll<HTMLElement>("[role=tab]")].find((el) => el.dataset.id === id)?.focus();
  }
}
