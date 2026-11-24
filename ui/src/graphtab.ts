//! The graph tab: the global graph replaces the editor while it is shown. The plugin switch in the settings hides it. main.ts only calls into this class.

import { on } from "./bus";
import { GraphView } from "./graph";
import type { Layout } from "./layout";
import { setCrumbs } from "./layout";
import type { NoteIndex } from "./noteindex";
import type { AppSearch } from "./ocr/appsearch";
import { getSetting, onSettingChanged } from "./settings";

export const GRAPH_TAB = "__graph__";

export interface GraphTabDeps {
  layout: Layout;
  noteIndex: NoteIndex;
  // The note on screen, or null.
  activeId: () => string | null;
  openById: (id: string, path: string) => void;
  // Shows the note that the graph was opened from (or the empty state).
  reopen: () => void;
  // Hides the editor's toolbar and the calendar, and redraws the tab bar.
  setToolbar: (on: boolean) => void;
  hideCalendar: () => void;
  renderTabs: () => void;
  // Hides the organization views before the graph is shown.
  hideOrg: () => void;
  // The app's search index, which feeds the files, people and mentions; null before the features are wired.
  appSearch: () => AppSearch | null;
  openFile: (fileId: string) => void;
}

export class GraphTab {
  // The tab is open (in the tab bar); shown is whether it is the view on screen.
  private open = false;
  shown = false;
  private readonly global: GraphView;

  constructor(private readonly d: GraphTabDeps) {
    this.global = new GraphView(d.layout.graph, {
      data: () => d.noteIndex.graph(),
      extra: () => d.appSearch()?.edges() ?? null,
      active: () => d.activeId(),
      open: d.openById,
      openFile: d.openFile,
      onEscape: () => this.close(),
    });
    // Tree changes and saved edits reach the index; the graph follows them while it is on screen.
    on("index:changed", () => {
      if (this.shown) this.global.refresh();
    });
    on("ui:open-graph", () => this.show());
    onSettingChanged((key) => {
      if (key === "plugins") this.applyPlugin();
    });
    this.applyPlugin();
  }

  /** The tab's entry for the tab bar, or none when the tab is closed. */
  tabs(): { id: string; title: string }[] {
    return this.open ? [{ id: GRAPH_TAB, title: "Widok grafu" }] : [];
  }

  /** The search index changed (a note or a file layer): the graph follows it while it is on screen. */
  searchChanged(): void {
    if (this.shown) this.global.refresh();
  }

  show(): void {
    if (!getSetting("plugins").graph) return;
    this.d.hideOrg();
    this.open = true;
    this.shown = true;
    // Loads the index for the files and people; the graph follows through searchChanged when it is ready.
    void this.d.appSearch()?.ensure();
    const { layout } = this.d;
    layout.graphBtn.setAttribute("aria-pressed", "true");
    layout.modeBtn.disabled = true;
    setCrumbs(layout, "Widok grafu", () => undefined);
    layout.empty.hidden = true;
    layout.editor.hidden = true;
    layout.reading.hidden = true;
    this.d.hideCalendar();
    layout.graph.hidden = false;
    this.d.setToolbar(false);
    this.global.refresh();
    this.global.show(true);
    this.d.renderTabs();
    this.global.focus();
  }

  // A hidden graph stops its frames, so the editor gets the whole main thread.
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.d.layout.graphBtn.setAttribute("aria-pressed", "false");
    this.d.layout.graph.hidden = true;
    this.global.show(false);
  }

  // Esc and the tab's close button: the graph tab goes and the note it came from is shown again.
  close(): void {
    if (!this.open) return;
    this.open = false;
    if (!this.shown) {
      this.d.renderTabs();
      return;
    }
    this.d.reopen();
  }

  // The graph plugin switch hides its ribbon button; with it off the graph tab closes and the command does nothing.
  applyPlugin(): void {
    const { layout } = this.d;
    const enabled = getSetting("plugins").graph;
    layout.graphBtn.hidden = !enabled;
    if (!enabled) this.close();
  }
}
