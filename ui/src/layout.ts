import { runCommand } from "./commands";
import { icon, type IconName } from "./icons";

export interface Layout {
  app: HTMLElement;
  sidebar: HTMLElement;
  tree: HTMLElement;
  tabs: HTMLElement;
  editor: HTMLElement;
  reading: HTMLElement;
  graph: HTMLElement;
  orgView: HTMLElement;
  calendar: HTMLElement;
  kanban: HTMLElement;
  graphBtn: HTMLButtonElement;
  empty: HTMLElement;
  formatBar: HTMLElement;
  modeBtn: HTMLButtonElement;
  moreBtn: HTMLButtonElement;
  backBtn: HTMLButtonElement;
  forwardBtn: HTMLButtonElement;
  newTabBtn: HTMLButtonElement;
  crumbs: HTMLElement;
  saveStatus: HTMLElement;
  backlinks: HTMLElement;
  words: HTMLElement;
  chars: HTMLElement;
  vaultName: HTMLElement;
  vaultIcon: HTMLElement;
  workspaceName: HTMLElement;
  searchHost: HTMLElement;
  panelTabs: HTMLElement;
  // The split pane, inside the editor: a second note beside the first (splitview.ts).
  split: HTMLElement;
  splitEditor: HTMLElement;
  splitTitle: HTMLElement;
  splitClose: HTMLButtonElement;
}

const MIN_W = 160;
const MAX_W = 480;

// Static skeleton only; all user data is written with textContent elsewhere.
// Buttons carry data-icon (filled by fillIcons) and, where they run a command, data-command.
export function buildLayout(host: HTMLElement): Layout {
  host.innerHTML = `
    <div class="app right-collapsed">
      <div class="workspace">
        <nav class="ribbon" aria-label="Pasek boczny">
          <button type="button" class="ribbon-btn" id="btn-toggle-left" data-icon="panel-left"
            title="Pokaż lub ukryj lewy panel" aria-label="Pokaż lub ukryj lewy panel" aria-pressed="true" aria-expanded="true" aria-controls="sidebar"></button>
          <button type="button" class="ribbon-btn" id="btn-quick" data-command="quick.open" data-icon="file-search"
            title="Otwórz szybki przełącznik" aria-label="Otwórz szybki przełącznik"></button>
          <button type="button" class="ribbon-btn" data-command="search.open" data-icon="search"
            title="Szukaj w notatkach" aria-label="Szukaj w notatkach"></button>
          <button type="button" class="ribbon-btn" id="btn-graph" data-command="graph.open" data-icon="git-fork"
            title="Otwórz widok grafu" aria-label="Otwórz widok grafu"></button>
          <button type="button" class="ribbon-btn" data-command="tasks.open" data-icon="list-checks"
            title="Moje zadania" aria-label="Moje zadania"></button>
          <button type="button" class="ribbon-btn" data-command="calendar.open" data-icon="calendar"
            title="Kalendarz" aria-label="Kalendarz"></button>
          <button type="button" class="ribbon-btn" data-command="palette.open" data-icon="terminal"
            title="Paleta poleceń" aria-label="Paleta poleceń"></button>
        </nav>
        <aside class="sidebar" id="sidebar">
          <header class="workspace-heading"><span class="eyebrow">TWOJA PRZESTRZEŃ</span><button type="button" class="workspace-name" id="workspace-name" aria-haspopup="menu" aria-label="Przełącz przestrzeń" title="Przełącz przestrzeń">Notatki</button></header>
          <button type="button" class="workspace-search" data-command="quick.open" title="Otwórz notatkę (Ctrl+P)" aria-label="Otwórz notatkę">
            <span data-icon="search" aria-hidden="true"></span><span>Znajdź notatkę</span><kbd>Ctrl P</kbd>
          </button>
          <div class="side-tabs" role="tablist" aria-label="Panel boczny">
            <button type="button" class="side-tab" role="tab" data-pane="files" aria-selected="true" aria-controls="pane-files"
              data-icon="folder" title="Pliki" aria-label="Pliki"></button>
            <button type="button" class="side-tab" role="tab" data-pane="search" aria-selected="false" aria-controls="pane-search"
              data-icon="search" title="Szukaj" aria-label="Szukaj"></button>
            <button type="button" class="side-tab" role="tab" data-pane="bookmarks" aria-selected="false" aria-controls="pane-bookmarks"
              data-icon="bookmark" title="Zakładki" aria-label="Zakładki"></button>
          </div>
          <section class="side-pane" id="pane-files" role="tabpanel">
            <div class="section-heading">Biblioteka</div>
            <header class="explorer-head">
              <button type="button" class="icon-btn" data-action="new-note" data-icon="square-pen"
                title="Nowa notatka" aria-label="Nowa notatka"></button>
              <button type="button" class="icon-btn" data-action="new-folder" data-icon="folder-plus"
                title="Nowy folder" aria-label="Nowy folder"></button>
              <button type="button" class="icon-btn" data-action="sort" data-icon="arrow-up-narrow-wide" aria-haspopup="menu"
                title="Zmień kolejność sortowania" aria-label="Zmień kolejność sortowania"></button>
              <button type="button" class="icon-btn" data-action="collapse-all" data-icon="chevrons-down-up"
                title="Zwiń wszystko" aria-label="Zwiń wszystko"></button>
              <button type="button" class="icon-btn" data-action="expand-all" data-icon="chevrons-up-down"
                title="Rozwiń wszystko" aria-label="Rozwiń wszystko"></button>
            </header>
            <div class="tree" id="tree"></div>
          </section>
          <section class="side-pane" id="pane-search" role="tabpanel" hidden>
            <div id="search-host" class="search-host"></div>
          </section>
          <section class="side-pane" id="pane-bookmarks" role="tabpanel" hidden>
            <div class="pane-empty"><span data-icon="bookmark" aria-hidden="true"></span><strong>Ważne rzeczy pod ręką</strong><p>Zapisywanie zakładek będzie dostępne w kolejnej wersji. Na razie znajdziesz notatki przez <kbd>Ctrl P</kbd>.</p></div>
          </section>
          <footer class="side-footer">
            <button type="button" class="vault-icon" id="vault-icon" data-icon="chevrons-up-down" aria-haspopup="menu" title="Przełącz przestrzeń" aria-label="Przełącz przestrzeń"></button>
            <button type="button" class="vault-name" id="vault-name" aria-haspopup="menu" title="Przełącz przestrzeń" aria-label="Przełącz przestrzeń"></button>
            <button type="button" class="icon-btn" id="btn-help" data-icon="circle-help" title="Pomoc" aria-label="Pomoc"></button>
            <button type="button" class="icon-btn" id="btn-settings" data-command="settings.open" data-icon="settings"
              title="Ustawienia" aria-label="Ustawienia"></button>
          </footer>
        </aside>
        <div class="resizer" data-side="left" role="separator" aria-orientation="vertical"
          aria-label="Szerokość lewego panelu" aria-valuemin="${MIN_W}" aria-valuemax="${MAX_W}" tabindex="0"></div>
        <main class="main">
          <div class="tab-bar">
            <div class="tabs" id="tabs"></div>
            <button type="button" class="icon-btn" id="btn-newtab" data-icon="plus" title="Nowa karta" aria-label="Nowa karta"></button>
            <span class="spacer"></span>
            <button type="button" class="icon-btn" id="btn-toggle-right" data-icon="panel-right"
              title="Pokaż lub ukryj prawy panel" aria-label="Pokaż lub ukryj prawy panel" aria-pressed="false" aria-expanded="false" aria-controls="panel"></button>
          </div>
          <div class="view-header">
            <button type="button" class="icon-btn" id="btn-back" data-icon="arrow-left" title="Wstecz" aria-label="Wstecz"></button>
            <button type="button" class="icon-btn" id="btn-forward" data-icon="arrow-right" title="Dalej" aria-label="Dalej"></button>
            <nav class="crumbs" id="crumbs" aria-label="Ścieżka notatki"></nav>
            <span class="spacer"></span>
            <button type="button" class="icon-btn" id="btn-mode" aria-pressed="false"></button>
            <button type="button" class="icon-btn" id="btn-more" data-icon="more-vertical" aria-haspopup="menu"
              title="Więcej opcji" aria-label="Więcej opcji"></button>
          </div>
          <div class="format-bar" id="format-bar"></div>
          <div class="editor" id="editor">
            <section class="split" id="split" aria-label="Notatka obok" hidden>
              <header class="split-head">
                <span class="split-title" id="split-title"></span>
                <button type="button" class="icon-btn" id="btn-split-close" data-icon="x" title="Zamknij podział" aria-label="Zamknij podział"></button>
              </header>
              <div class="editor split-editor" id="split-editor"></div>
            </section>
          </div>
          <div class="reading-view" id="reading" tabindex="-1" hidden></div>
          <div class="graph-view" id="graph" hidden></div>
          <div class="org-view" id="org-view" hidden></div>
          <div class="calendar-view" id="calendar" tabindex="-1" hidden></div>
          <div class="org-view kanban-view" id="kanban" tabindex="-1" hidden></div>
          <div class="empty-state" id="empty" hidden>
            <div class="empty-content"><span class="empty-symbol" data-icon="square-pen" aria-hidden="true"></span>
              <span class="eyebrow">MIEJSCE NA TWOJE MYŚLI</span><h1>Od czego zaczniemy?</h1>
              <p>Otwórz notatkę z biblioteki lub zapisz nowy pomysł.<br />Reszta może poczekać.</p>
              <div class="empty-actions"><button type="button" class="btn btn-primary" data-command="note.new" title="Utwórz nową notatkę" aria-label="Utwórz nową notatkę">Nowa notatka</button>
                <button type="button" class="btn" data-command="quick.open" title="Otwórz notatkę" aria-label="Otwórz notatkę">Otwórz notatkę <kbd>Ctrl P</kbd></button></div>
            </div>
          </div>
        </main>
        <div class="resizer" data-side="right" role="separator" aria-orientation="vertical"
          aria-label="Szerokość prawego panelu" aria-valuemin="${MIN_W}" aria-valuemax="${MAX_W}" tabindex="0"></div>
        <aside class="panel" id="panel">
          <div class="section-heading">Kontekst notatki</div>
          <div id="panel-tabs" class="panel-tabs"></div>
        </aside>
      </div>
      <div class="drawer-backdrop" aria-hidden="true"></div>
      <footer class="statusbar">
        <span id="backlinks">linki zwrotne: –</span>
        <span id="save-status" role="status" aria-live="polite" data-state="saved">Zapisano lokalnie</span>
        <span class="spacer"></span>
        <span id="words"></span>
        <span id="chars"></span>
      </footer>
    </div>`;

  fillIcons(host);
  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const layout: Layout = {
    app: q(".app"),
    sidebar: q("#sidebar"),
    tree: q("#tree"),
    tabs: q("#tabs"),
    editor: q("#editor"),
    reading: q("#reading"),
    graph: q("#graph"),
    orgView: q("#org-view"),
    calendar: q("#calendar"),
    kanban: q("#kanban"),
    graphBtn: q("#btn-graph"),
    empty: q("#empty"),
    formatBar: q("#format-bar"),
    modeBtn: q("#btn-mode"),
    moreBtn: q("#btn-more"),
    backBtn: q("#btn-back"),
    forwardBtn: q("#btn-forward"),
    newTabBtn: q("#btn-newtab"),
    crumbs: q("#crumbs"),
    saveStatus: q("#save-status"),
    backlinks: q("#backlinks"),
    words: q("#words"),
    chars: q("#chars"),
    vaultName: q("#vault-name"),
    vaultIcon: q("#vault-icon"),
    workspaceName: q("#workspace-name"),
    searchHost: q("#search-host"),
    panelTabs: q("#panel-tabs"),
    split: q("#split"),
    splitEditor: q("#split-editor"),
    splitTitle: q("#split-title"),
    splitClose: q<HTMLButtonElement>("#btn-split-close"),
  };
  setModeButton(layout.modeBtn, false);
  for (const handle of host.querySelectorAll<HTMLElement>(".resizer")) attachResizer(handle);
  for (const btn of host.querySelectorAll<HTMLElement>("[data-command]")) {
    btn.addEventListener("click", () => runCommand(btn.dataset.command ?? ""));
  }
  bindSidebar(layout);
  // Narrow windows start with the library tucked away; the toggle always stays reachable.
  if (window.innerWidth <= 900) toggleSide(layout, "left");
  q<HTMLButtonElement>("#btn-help").addEventListener("click", () => window.open("/pomoc", "_blank", "noopener"));
  q<HTMLButtonElement>("#btn-toggle-left").addEventListener("click", () => toggleSide(layout, "left"));
  q<HTMLButtonElement>("#btn-toggle-right").addEventListener("click", () => toggleSide(layout, "right"));
  // On small screens the library is a drawer: a tap on the backdrop, Escape or a pick inside it closes it.
  q(".drawer-backdrop").addEventListener("click", () => closeDrawer(layout));
  layout.sidebar.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest('[role="treeitem"]:not([aria-expanded]), .org-nav button, .search-hit')) closeDrawer(layout);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(layout); });
  // Keeps the active tab in view when the tab strip scrolls (narrow screens).
  new MutationObserver(() => layout.tabs.querySelector<HTMLElement>(".tab.is-active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }))
    .observe(layout.tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  // Overlay panels on small windows close when returning to the note; that click still reaches the editor.
  q(".main").addEventListener("pointerdown", (e) => {
    if (window.innerWidth > 900 || (e.target as HTMLElement).closest("#btn-toggle-right")) return;
    if (!layout.app.classList.contains("left-collapsed")) toggleSide(layout, "left");
    if (!layout.app.classList.contains("right-collapsed")) toggleSide(layout, "right");
  });
  return layout;
}

// Replaces each [data-icon] placeholder with its Lucide icon.
function fillIcons(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    el.replaceChildren(icon(el.dataset.icon as IconName));
  }
}

// Sidebar tabs (Pliki, Szukaj, Zakładki) switch the visible pane.
function bindSidebar(layout: Layout): void {
  const tabs = [...layout.sidebar.querySelectorAll<HTMLButtonElement>(".side-tab")];
  for (const tab of tabs) {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("click", () => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const pane = layout.sidebar.querySelector<HTMLElement>(`.side-pane[id="${t.getAttribute("aria-controls")}"]`);
        if (pane) pane.hidden = !on;
      }
    });
    tab.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const index = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1
        : (tabs.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].click();
      tabs[index].focus();
    });
  }
}

export function toggleSide(layout: Layout, side: "left" | "right"): void {
  const hidden = layout.app.classList.toggle(`${side}-collapsed`);
  const btn = layout.app.querySelector(`#btn-toggle-${side}`);
  btn?.setAttribute("aria-pressed", String(!hidden));
  btn?.setAttribute("aria-expanded", String(!hidden));
  const pane = side === "left" ? layout.sidebar : layout.app.querySelector<HTMLElement>("#panel");
  if (pane?.contains(document.activeElement)) (btn as HTMLElement | null)?.focus();
  // Drawers share the available width on a small screen: opening one closes the other.
  if (!hidden && window.innerWidth <= 900) {
    const other = side === "left" ? "right" : "left";
    layout.app.classList.add(`${other}-collapsed`);
    const otherButton = layout.app.querySelector(`#btn-toggle-${other}`);
    otherButton?.setAttribute("aria-pressed", "false");
    otherButton?.setAttribute("aria-expanded", "false");
  }
}

// Closes the library drawer on small screens; does nothing when it is already closed or the screen is wide.
function closeDrawer(layout: Layout): void {
  if (window.innerWidth <= 900 && !layout.app.classList.contains("left-collapsed")) toggleSide(layout, "left");
}

// A calendar or kanban note's mode button switches between its view and the note's text.
export function setViewModeButton(btn: HTMLElement, showingView: boolean, view: { label: string; icon: IconName }): void {
  const label = showingView ? "Tekst notatki" : view.label;
  const text = document.createElement("span");
  text.className = "sr-only";
  text.textContent = label;
  btn.replaceChildren(icon(showingView ? "code" : view.icon), text);
  btn.title = `${label} (Ctrl+E)`;
  btn.setAttribute("aria-label", label);
}

// Mode button shows the icon of the mode a click switches to; its text is the same label as before.
export function setModeButton(btn: HTMLElement, reading: boolean): void {
  const label = reading ? "Edycja" : "Czytanie";
  const text = document.createElement("span");
  text.className = "sr-only";
  text.textContent = label;
  btn.replaceChildren(icon(reading ? "pencil" : "book-open"), text);
  btn.title = `${label} (Ctrl+E)`;
  btn.setAttribute("aria-label", label);
}

export function toggleFocus(layout: Layout): void {
  layout.app.classList.toggle("focus-mode");
}

/** Shows the open space's name at the top of the library and in the footer. */
export function showSpaceName(layout: Layout, name: string): void {
  layout.vaultName.textContent = name;
  layout.workspaceName.textContent = name;
  // a long name is clamped in the header; the full one is in the tooltip
  layout.workspaceName.title = name;
}

// Breadcrumb of the note path; a folder crumb reveals that folder in the tree.
export function setCrumbs(layout: Layout, path: string | null, onReveal: (folder: string) => void, onRename?: (name: string) => void): void {
  const parts = path ? path.split("/") : [];
  const nodes: HTMLElement[] = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "/";
      nodes.push(sep);
    }
    if (i < parts.length - 1) {
      const folder = parts.slice(0, i + 1).join("/");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "crumb";
      btn.textContent = part;
      btn.title = `Pokaż folder ${folder} w drzewie`;
      btn.addEventListener("click", () => onReveal(folder));
      nodes.push(btn);
    } else {
      const name = part.replace(/\.md$/, "");
      const last = onRename ? titleCrumb(name, onRename) : document.createElement("span");
      last.className = "crumb is-last";
      last.textContent = name;
      nodes.push(last);
    }
  });
  layout.crumbs.replaceChildren(...nodes);
}

// The note's own name in the breadcrumb: click it, type the new name, Enter (or leaving the field) renames the note.
function titleCrumb(name: string, onRename: (name: string) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Zmień nazwę notatki";
  btn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "crumb-rename";
    input.value = name;
    input.setAttribute("aria-label", "Nazwa notatki");
    input.size = Math.max(8, name.length + 2);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      input.replaceWith(btn);
      if (save && next && next !== name) onRename(next);
      else btn.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    btn.replaceWith(input);
    input.focus();
    input.select();
  });
  return btn;
}

// Drag or arrow keys change the panel width; the width lives in a CSS variable.
function attachResizer(handle: HTMLElement): void {
  const left = handle.dataset.side === "left";
  const pane = () => (left ? handle.previousElementSibling : handle.nextElementSibling) as HTMLElement;
  const setW = (w: number) => {
    const v = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
    document.documentElement.style.setProperty(left ? "--sidebar-w" : "--panel-w", `${v}px`);
    handle.setAttribute("aria-valuenow", String(v));
  };
  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = pane().getBoundingClientRect().width;
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - startX;
      setW(left ? startW + dx : startW - dx);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
  handle.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
    if (step === 0) return;
    e.preventDefault();
    setW(pane().getBoundingClientRect().width + (left ? step : -step));
  });
}
