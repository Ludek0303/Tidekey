//! Wiring of the features that follow the open note and the backend's changes: the right panel, the search pane,
//! the conflict banner, edits from other writers, and the jump to a line of the outline.

import type { Bridge, SearchHit } from "./bridge";
import { on } from "./bus";
import { registerCommand } from "./commands";
import { conflictBanner, openConflict } from "./conflictview";
import { embedReadingImages } from "./attachments";
import { foldReadingFolders } from "./filefolders-view";
import { paintReadingCharts } from "./charts";
import { paintReadingDiagrams } from "./diagram";
import { applyRemote, type EditorHost, type NoteSession } from "./editor";
import { EditorView } from "@codemirror/view";
import { type Layout, toggleSide } from "./layout";
import type { NoteIndex } from "./noteindex";
import { type NoteRef, RightPanel, trailing } from "./rightpanel";
import { SearchView } from "./searchview";
import { AppSearch, firstTerm, pageOf, type AppHit } from "./ocr/appsearch";
import { filesOf } from "./filestore";
import { previewFiles } from "./preview/triggers";

const REMOTE_REFRESH_MS = 300;

export interface FeatureDeps {
  bridge: Bridge;
  layout: Layout;
  noteIndex: NoteIndex;
  host: EditorHost;
  sessions: () => NoteSession[];
  open: (id: string, path: string) => void;
}

export interface Features {
  /** The note on screen changed (or none is open). */
  active(session: NoteSession | null): void;
  /** Shows a task of note `noteId` in the right panel; `render` builds its content each time it is shown. */
  showTask(render: () => Promise<HTMLElement[]>, noteId: string): void;
  /** Drops the task view from the right panel. */
  clearTask(): void;
  /** The reading view was painted: its attachment links become images. */
  paintReading(el: HTMLElement, text: string): void;
  /** The app's search index: the graph reads its files, people and mentions from it. */
  appSearch: AppSearch;
  /** Opens a file of the store for preview (the graph's file nodes). */
  openFile(fileId: string): void;
}

/** Opens the file of a search hit on its page in the "Tekst" tab, the query's first word marked. */
function openFileHit(bridge: Bridge, hit: AppHit, query: string): void {
  const store = filesOf(bridge);
  if (!store) return;
  void store.info(hit.docId).then((info) => {
    if (info) previewFiles(store, [info], 0, { text: { page: pageOf(hit.place), mark: firstTerm(query) } });
  });
}

/** Opens a file by its id for preview, from the first page. */
function openFileById(bridge: Bridge, fileId: string): void {
  const store = filesOf(bridge);
  if (!store) return;
  void store.info(fileId).then((info) => {
    if (info) previewFiles(store, [info], 0);
  });
}

export function setupFeatures(d: FeatureDeps): Features {
  const { bridge, layout, host } = d;
  let current: NoteSession | null = null;
  const appSearch = new AppSearch(bridge);

  const showSearch = (query?: string): void => {
    layout.app.classList.remove("left-collapsed");
    layout.app.querySelector("#btn-toggle-left")?.setAttribute("aria-pressed", "true");
    layout.app.querySelector("#btn-toggle-left")?.setAttribute("aria-expanded", "true");
    layout.sidebar.querySelector<HTMLButtonElement>('.side-tab[data-pane="search"]')?.click();
    search.focus(query);
  };
  const panel = new RightPanel(layout.panelTabs, {
    bridge,
    graph: () => d.noteIndex.graph(),
    open: d.open,
    jump: (line) => {
      const doc = d.host.view.state.doc;
      const at = doc.line(Math.min(line + 1, doc.lines)).from;
      d.host.view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start" }) });
    },
    search: (query) => showSearch(query),
    restored: () => refresh(),
  });
  const search = new SearchView(layout.searchHost, bridge, (hit: SearchHit) => d.open(hit.id, hit.path), appSearch, (hit, query) => openFileHit(bridge, hit, query));
  const banner = conflictBanner(() => {
    if (current) void openConflict(bridge, current.id, () => ((banner.hidden = true), refresh()));
  });
  banner.hidden = true;
  layout.editor.before(banner);

  const noteRef = (): NoteRef | null =>
    current ? { id: current.id, path: current.path, text: current.doc.getText("content").toString() } : null;
  const refresh = () => panel.setNote(noteRef());
  // a remote keystroke refreshes the panel after the typing pauses: each refresh reads the task index (a flush)
  const refreshSoon = trailing(refresh, REMOTE_REFRESH_MS);

  registerCommand({ id: "search.open", name: "Szukaj w notatkach", hotkey: "Ctrl+Shift+F", run: () => showSearch() });
  bridge.on("note_update", (payload) => {
    const { id, update } = payload as { id: string; update: Uint8Array };
    const session = d.sessions().find((s) => s.id === id);
    if (session) applyRemote(session, update);
    if (current?.id === id) refreshSoon();
  });
  bridge.on("conflict", (payload) => {
    if (current?.id === (payload as { id: string }).id) banner.hidden = false;
  });
  on("index:changed", refresh);

  return {
    appSearch,
    openFile(fileId) {
      openFileById(bridge, fileId);
    },
    showTask(render, noteId) {
      if (layout.app.classList.contains("right-collapsed")) toggleSide(layout, "right");
      panel.showTask(render, noteId);
    },
    clearTask() {
      panel.clearTask();
    },
    paintReading(el, text) {
      // folder callouts first: their embeds are shown as one card, not drawn in a row
      foldReadingFolders(el, host.view.state.doc.toString(), host.view, bridge);
      paintReadingCharts(el, text);
      paintReadingDiagrams(el, text);
      embedReadingImages(el, bridge);
    },
    active(session) {
      current = session;
      banner.hidden = true;
      refresh();
      if (session) {
        void bridge.call<string[]>("list_conflicts").then((ids) => {
          banner.hidden = !ids.includes(session.id);
        }, () => {});
      }
    },
  };
}
