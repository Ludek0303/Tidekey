import { emit, on } from "./bus";
import { CommandPalette, installHotkeys, registerCommand } from "./commands";
import { MockBridge, type Bridge, type ProjectProtection, type TreeItem } from "./bridge";
import { loadDemoFixtures } from "./demofixtures";
import { embedAt } from "./attachments";
import { embeddedIds, previewEmbeds } from "./preview/triggers";
import { filesOf, textLayersOf } from "./filestore";
import { mountOcrStatus } from "./ocr/status";
import { CalendarView } from "./calendar/view";
import { isCalendarText } from "./calendar/model";
import { dueReminders } from "./calendar/reminders";
import { createCalendar, findCalendar, newCalendar, type CalendarDeps } from "./calendar/open";
import { browserTargets, showMyCalendar } from "./allspaces";
import { takePending, type EventTarget } from "./calendar/target";
import { createMeeting, setMeetingSource } from "./calendar/meeting";
import { GRAPH_TAB, GraphTab } from "./graphtab";
import { EditorHost, SAVE_TEXT, Saver, countWriting, focusedPane, openSession, setEditorReadOnly, setShown, setSourceMode, type NoteSession } from "./editor";
import { SplitView } from "./splitview";
import { Explorer } from "./explorer";
import { iconButton } from "./icons";
import { rememberNote, rememberedNote } from "./lastnote";
import { backupReminder } from "./backup";
import { editPermissions } from "./projects";
import { formulasReady, initFormula } from "./formula";
import { NoteIndex } from "./noteindex";
import { buildLayout, setCrumbs, setModeButton, setViewModeButton, showSpaceName, toggleFocus, toggleSide } from "./layout";
import { KANBAN_NAME, KANBAN_TEXT, askKanbanName, fillKanban, folderOf, isKanbanText } from "./kanban";
import { renderKanban } from "./projectpage";
import { editDone } from "./orgedit";
import { dayOf } from "./orgtasks";
import { QuickOpen } from "./quickopen";
import { applyTemplate, openDailyNote, templateNotes, titleOf } from "./templates";
import { ReadingView, findNote } from "./reading";
import { getSetting, onSettingChanged, openSettings, setSetting } from "./settings";
import { TabBar } from "./tabs";
import { chooseBridge, inTauri, reportSmoke } from "./tauribridge";
import { setupFeatures, type Features } from "./features";
import { mountFolderPanel } from "./filefolders-view";
import { mountGithubBar } from "./github/notebar";
import { openGithubConflict } from "./github/conflict";
import { githubService } from "./github/service";
import { FileTree } from "./tree";
import { Toolbar } from "./toolbar";
import { errorText, openMenu, toast } from "./widgets";
import { type SpaceItem, openSwitcher, switchSpace as switchSpaceTo } from "./spaces";
import { OrgViews, ORG_CALENDARS } from "./orgviews";
import { installShellKeys } from "./keys";
import { chooseLogout, isBrowserBridge, type BrowserBridge } from "./browserauth";
import { ROLE_LABEL, fetchServerVersion, goToVault, homeVaultId, openVaultMenu, vaultUrl, type Role } from "./vaults";
import { readPairingLink } from "./agentpairing";
import { agentsOffBanner, openPairingAccept } from "./agentsview";
import { exportAll, importMarkdown, pickMarkdown } from "./transfer";
import { requestOrgEvent, setTableNotes } from "./modules";

// A failed wasm load only disables table formulas; the editor still works.
await initFormula().catch((e: unknown) => console.error("formulas disabled", e));
if (inTauri()) void reportSmoke(formulasReady());


// ?big=10000 seeds a large tree for the virtualization check.
const big = Number(new URLSearchParams(location.search).get("big") ?? 0);
// The desktop app's Rust backend (after its first-run screen), or the browser mock.
const bridge: Bridge = await chooseBridge(big);
// Before the tree is read: the test notes are in the tree at the start (demofixtures.ts, development only).
if (import.meta.env.DEV && new URLSearchParams(location.search).get("pliki") === "test" && bridge instanceof MockBridge) {
  await loadDemoFixtures(bridge).catch((e: unknown) => console.error("demo fixtures not loaded", e));
}
const layout = buildLayout(document.getElementById("app")!);
const browser: BrowserBridge | null = !inTauri() && isBrowserBridge(bridge) ? bridge : null;
const browserAccount = browser !== null;
const savedLabel = inTauri() && big <= 0 ? SAVE_TEXT.saved : browserAccount ? "Zapisano lokalnie" : "Zapisano w sesji";
layout.saveStatus.textContent = savedLabel;
if (browser) {
  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "web-logout";
  logout.textContent = "Wyloguj";
  logout.title = "Wyloguj z konta";
  logout.setAttribute("aria-label", "Wyloguj z konta");
  // Saves the open vault, then asks whether this device keeps its encrypted copy (see chooseLogout).
  logout.onclick = () => chooseLogout(browser.user.id, () => browser.flush());
  layout.app.querySelector(".side-footer")?.append(logout);
}
// Viewer mode: the editor is read-only and the creation controls are hidden (the bridge refuses the writes as well).
function applyRole(role: Role | null): void {
  document.body.classList.toggle("viewer-mode", role === "viewer");
  setEditorReadOnly(role === "viewer", browser ? (path) => browser.editRefused(path) : undefined);
}
if (browser) {
  applyRole(browser.role);
  // A protection change (who may edit which note) arrives as a tree change.
  bridge.on("tree_changed", () => applyRole(browser.role));
  // Removal ends this vault for the user: the personal vault opens. A role change applies at once.
  browser.onVaultAccess(({ role, voluntary, personal }) => {
    applyRole(role);
    if (role === null) {
      if (!voluntary) toast(personal ? "Własne notatki nie są włączone dla tego konta." : "Usunięto Cię z tej organizacji.", true);
      setTimeout(() => location.assign(vaultUrl(homeVaultId(browser.user))), voluntary ? 0 : 1800);
    } else toast(`Twoja rola w tej organizacji: ${ROLE_LABEL[role]}.`);
  });
}
// OCR of the files (docs/OCR.md §3.4): only where the store keeps text layers. Editors and up run the queue; the module
// (engine, frame, recognition) loads on first use, so the main bundle does not grow.
const ocrStore = filesOf(bridge);
if (textLayersOf(ocrStore)) {
  mountOcrStatus(layout.saveStatus.parentElement!);
  const writable = browser ? browser.role === "owner" || browser.role === "admin" || browser.role === "editor" : true;
  void import("./ocr/service")
    .then(({ startOcr }) => startOcr(ocrStore, { me: browser?.user.id ?? null, writable }))
    .catch((e: unknown) => console.error("ocr disabled", e));
}
// Claude chats (docs/MCP.md §3.2, §18.4): a pairing link opens its acceptance screen; the operator's switch shows a banner.
if (browser) {
  if (new URLSearchParams(location.search).has("pair-agent")) {
    const link = readPairingLink(location.href);
    if (link) openPairingAccept(browser, link);
    else toast("Ten link parowania jest nieprawidłowy.", true);
  }
  void fetchServerVersion().then((v) => { if (v.agentsDisabled) layout.app.prepend(agentsOffBanner()); }, () => undefined);
}
let browserSyncLabel = "Zapisano lokalnie";
if (browser) {
  browser.onSyncStatus((state) => {
    const labels: Record<string, string> = { local: "Zapisano lokalnie · oczekuje na sieć", connecting: "Łączenie z synchronizacją…", syncing: "Synchronizowanie…", synced: "Zapisano i zsynchronizowano", offline: "Offline · zapisano lokalnie", error: "Błąd synchronizacji · dane lokalne zachowane" };
    browserSyncLabel = labels[state] ?? "Zapisano lokalnie";
    layout.saveStatus.textContent = browserSyncLabel;
    layout.saveStatus.dataset.state = state === "error" ? "error" : state === "syncing" || state === "connecting" ? "saving" : "saved";
    layout.saveStatus.title = "Vault jest szyfrowany na tym urządzeniu przed wysłaniem.";
  });
}
const saver = new Saver(bridge, (s) => {
  if (browserAccount) {
    if (s === "saving") layout.saveStatus.dataset.state = "saving";
    else { layout.saveStatus.textContent = browserSyncLabel; layout.saveStatus.dataset.state = browserSyncLabel.startsWith("Błąd") ? "error" : "saved"; }
  } else {
    layout.saveStatus.textContent = s === "saved" ? savedLabel : SAVE_TEXT[s];
    layout.saveStatus.dataset.state = s;
  }
});
const host = new EditorHost(layout.editor);
// The split pane beside the tab's note (splitview.ts). The focused editor (the split or the tab) is the one the
// commands and the toolbar act on; the tab's note stays the one the tab strip, reading mode and breadcrumbs show.
const splitView = new SplitView(layout);
const focused = () => focusedPane() ?? { view: host.view, session: host.session };
layout.editor.addEventListener("focusin", () => {
  if (active) setShown(host.view, active);
});
layout.splitClose.addEventListener("click", closeSplit);
// The folders of files above the note (filefolders-view.ts); refreshed on every edit and mode change.
const folders = mountFolderPanel(layout.editor, layout.reading, bridge, () => host.view);
// The GitHub bar above the note (github/notebar.ts); shown on a note or mode change, not on every key.
const githubBar = mountGithubBar(layout.editor, layout.reading, githubService, {
  currentText: () => host.view.state.doc.toString(),
  onConflict: (noteId) => void openGithubConflict(noteId).then(() => githubBar.show(active?.id ?? null)),
});
// No note open means no view to format: the palette's formatting commands then do nothing.
const toolbar = new Toolbar(
  layout.formatBar,
  () => (active ? focused().view : null),
  () => focused().session?.undo ?? null,
);
const noteIndex = new NoteIndex(bridge, () => emit("index:changed"));

const loading = new Map<string, Promise<NoteSession>>();
let opened: NoteSession[] = [];
let active: NoteSession | null = null;
// Every note open on screen: the tabs, and the note in the split. The board, the org views and the index read these.
const openSessions = (): NoteSession[] => (splitView.session && !opened.includes(splitView.session) ? [...opened, splitView.session] : opened);
// Ids of the tabs in reading mode; every other tab shows its source editor.
const reading = new Set<string>();
// Wikilinks and relative links, in the reading view and in the editor, open the note they name.
function followLink(target: string): void {
  const item = findNote(explorer.notes, target);
  if (item) void openNote(item);
}
const readingView = new ReadingView(layout.reading, followLink, undefined, (el, text) => features?.paintReading(el, text));
// Calendar notes show their calendar; Ctrl+E switches one to its text (rawCalendar).
const calendarView = new CalendarView(layout.calendar, () => onEdit(), followLink);
const rawCalendar = new Set<string>();
// Kanban notes (`typ: kanban`) show their board unless Ctrl+E switched them to their text (rawKanban).
const rawKanban = new Set<string>();
const CALENDAR_BUTTON = { label: "Kalendarz", icon: "calendar" } as const;
const BOARD_BUTTON = { label: "Tablica", icon: "folder-kanban" } as const;
// Remote typing re-renders every 150 ms of quiet, and at least once per second while it lasts.
const READING_DEBOUNCE_MS = 150;
const READING_MAX_WAIT_MS = 1000;
let readingTimer: ReturnType<typeof setTimeout> | undefined;
let readingSince = 0;
// Notes shown so far, in order; back and forward walk it. navigating stops a walk from adding entries.
let trail: string[] = [];
let trailAt = -1;
let navigating = false;

// Back and forward buttons follow the trail position.
function syncNavButtons(): void {
  layout.backBtn.disabled = trailAt <= 0;
  layout.forwardBtn.disabled = trailAt >= trail.length - 1;
}

// A deleted note leaves the history; the position moves with the entries before it.
function dropFromTrail(id: string): void {
  trailAt = trail.slice(0, trailAt + 1).filter((x) => x !== id).length - 1;
  trail = trail.filter((x) => x !== id);
  syncNavButtons();
}

function isReading(): boolean {
  return active !== null && reading.has(active.id);
}

// The board's edits go to the note they change: the open tab's document, or the note itself.
const boardEdits = { bridge, openDoc: (id: string) => openSessions().find((s) => s.id === id)?.doc ?? null };

// The board of the active kanban note: the tasks of the whole index, read again on each draw.
function drawBoard(): void {
  if (!layout.kanban.hidden) {
    renderKanban(
      layout.kanban,
      () => (active ? { id: active.id, path: active.path, text: active.doc.getText("content").toString() } : null),
      () => noteIndex.tasks()?.tasks ?? [],
      {
        edits: boardEdits,
        department: (name) => org.department(name),
        openPath: (path, line) => {
          const item = explorer.notes.find((n) => n.path === path);
          if (item) void openNote(item).then(() => revealLine(line));
        },
        toggleTask: async (task) => {
          await editDone(boardEdits, task, !task.done, dayOf(new Date()));
          await refreshNotes([task.note]);
        },
        changed: refreshNotes,
      },
    );
  }
}

// The index learns the new text of the notes an edit changed, so the board shows it at once.
async function refreshNotes(ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    const open = boardEdits.openDoc(id);
    noteIndex.edited(id, open ? open.getText("content").toString() : await bridge.call<string>("note_text", { id }));
  }
  noteIndex.flush();
}
on("index:changed", drawBoard);

// Shows the active tab's mode; the reading view is rendered from the editor's current text.
// A calendar note shows its calendar, and a kanban note its board, unless Ctrl+E switched it to its text.
function showMode(): void {
  const text = active?.doc.getText("content").toString() ?? "";
  const isCal = active !== null && isCalendarText(text);
  const cal = isCal && !rawCalendar.has(active!.id);
  const isBoard = active !== null && !isCal && isKanbanText(text);
  const board = isBoard && !rawKanban.has(active!.id);
  const on = !cal && !board && isReading();
  layout.editor.hidden = cal || board || on;
  layout.reading.hidden = cal || board || !on;
  toolbar.setActive(!cal && !board);
  if (cal) calendarView.show(active!);
  else calendarView.hide();
  layout.kanban.hidden = !board;
  if (board) drawBoard();
  if (isCal) setViewModeButton(layout.modeBtn, cal, CALENDAR_BUTTON);
  else if (isBoard) setViewModeButton(layout.modeBtn, board, BOARD_BUTTON);
  else setModeButton(layout.modeBtn, on);
  layout.modeBtn.setAttribute("aria-pressed", String(on));
  if (on) readingView.show(host.view.state.doc.toString());
  folders.refresh();
  void githubBar.show(active?.id ?? null);
}

function toggleMode(): void {
  if (!active) return;
  if (isCalendarText(active.doc.getText("content").toString())) {
    if (!rawCalendar.delete(active.id)) rawCalendar.add(active.id);
    showMode();
    if (layout.calendar.hidden) host.focus();
    else layout.calendar.focus();
    return;
  }
  if (isKanbanText(active.doc.getText("content").toString())) {
    if (!rawKanban.delete(active.id)) rawKanban.add(active.id);
    showMode();
    if (layout.kanban.hidden) host.focus();
    else layout.kanban.focus();
    return;
  }
  if (!reading.delete(active.id)) reading.add(active.id);
  showMode();
  // the reading view takes focus so Ctrl+E (and PgDn/arrows) keep working there
  if (isReading()) layout.reading.focus();
  else host.focus();
}

// Remote or local edits re-render the reading view, debounced so a burst of edits costs one render.
function scheduleReading(): void {
  const now = Date.now();
  if (readingTimer === undefined) readingSince = now;
  clearTimeout(readingTimer);
  const wait = Math.min(READING_DEBOUNCE_MS, readingSince + READING_MAX_WAIT_MS - now);
  readingTimer = setTimeout(() => {
    readingTimer = undefined;
    if (isReading()) readingView.show(host.view.state.doc.toString());
  }, Math.max(0, wait));
}

function onEdit(): void {
  updateWords();
  folders.refresh();
  scheduleReading();
  // the focused editor's note, not the active one: a board on screen leaves the view on another note, which can still change
  const pane = focused();
  if (pane.session) noteIndex.edited(pane.session.id, pane.view.state.doc.toString());
}

// The graph tab: the global graph replaces the editor while shown; the tab stays until it is closed.
function updateWords(): void {
  const c = countWriting(focused().view.state);
  layout.words.textContent = c.selected ? `zaznaczono: słowa: ${c.words}` : `słowa: ${c.words}`;
  layout.chars.textContent = `znaki: ${c.chars}`;
}
on("editor:selection", updateWords);

let myCalendarShown = false; // "Mój kalendarz" is on screen (openMyCalendar)
function renderTabs(): void {
  const list = opened.map((s) => ({ id: s.id, title: s.path.split("/").pop()!.replace(/\.md$/, "") }));
  list.push(...graph.tabs());
  const orgTabs = org.tabs();
  list.push(...orgTabs);
  tabs.render(list, orgTabs[0]?.id ?? (graph.shown ? GRAPH_TAB : myCalendarShown ? null : (active?.id ?? null)));
}

function sessionFor(item: TreeItem): Promise<NoteSession> {
  let p = loading.get(item.id);
  if (!p) {
    p = openSession(bridge, saver, item.id, item.path, onEdit, followLink).catch((err: unknown) => {
      loading.delete(item.id);
      throw err;
    });
    loading.set(item.id, p);
  }
  return p;
}

// The tab strip passes focusEditor false, so focus stays on the tab the user is moving through.
function select(session: NoteSession, focusEditor = true): void {
  // The note moves from the split to the tab: the split closes first, so a note is never in both panes.
  if (splitView.session === session) splitView.close();
  const wasGraph = graph.shown;
  graph.hide();
  // the note may already be the active one under an org tab (Zadania → its own task): it must come back on screen
  const wasOrg = org.hide();
  // the note on screen is the one active row of the tree (an org view clears it, see showOrgTab)
  tree.setActive(session.id);
  layout.modeBtn.disabled = false;
  showCrumbs(session.path);
  if (focusEditor && window.innerWidth <= 900) {
    for (const side of ["left", "right"] as const) {
      if (!layout.app.classList.contains(`${side}-collapsed`)) toggleSide(layout, side);
    }
  }
  if (active === session) {
    if (wasGraph || wasOrg || myCalendarShown) {
      renderTabs();
      showMode();
    }
    if (focusEditor && !isReading()) host.focus();
    return;
  }
  host.show(session, active);
  active = session;
  remember(session);
  features?.active(session);
  if (!navigating) {
    trail = trail.slice(0, trailAt + 1);
    trail.push(session.id);
    trailAt = trail.length - 1;
  }
  layout.empty.hidden = true;
  toolbar.setActive(true);
  renderTabs();
  syncNavButtons();
  updateWords();
  showMode();
  if (focusEditor && !isReading()) host.focus();
}

async function openNote(item: TreeItem): Promise<void> {
  const session = await sessionFor(item);
  if (!opened.includes(session)) opened = [...opened, session];
  select(session);
}

// Puts a note beside the tab's note. The split needs a wide window; the tab's own note cannot go in the split.
async function openSide(item: TreeItem): Promise<void> {
  if (window.innerWidth <= 900) return toast("Podział ekranu działa na szerszym oknie.");
  try {
    if (!splitView.open(await sessionFor(item), active)) return toast("Ta notatka jest już otwarta po lewej.");
    splitView.focus();
  } catch (err) {
    toast(errorText(err), true);
  }
}

// The split's close button and command: the focus goes back to the tab's note.
function closeSplit(): void {
  if (!splitView.session) return;
  splitView.close();
  host.focus();
}

// Closing the active tab opens its right neighbour (or the left one); with no tabs left, the empty state shows.
function closeTab(id: string): void {
  if (org.isTab(id)) {
    // select() hides the org view itself, and needs to see that it was shown to bring the editor back
    const next = active ?? opened[0];
    if (next) select(next, false);
    else showEmpty();
    return;
  }
  if (id === GRAPH_TAB) {
    graph.close();
    return;
  }
  const i = opened.findIndex((s) => s.id === id);
  if (i < 0) return;
  const wasActive = active?.id === id;
  opened = opened.filter((s) => s.id !== id);
  if (!wasActive) {
    renderTabs();
    return;
  }
  active = null;
  // The graph stays up; closing it shows a note again.
  if (graph.shown) {
    tree.setActive(null);
    renderTabs();
    return;
  }
  const next = opened[i] ?? opened[i - 1];
  if (next) {
    navigating = true;
    select(next);
    navigating = false;
    return;
  }
  showEmpty();
}

function showEmpty(): void {
  graph.hide();
  org.hide();
  tree.setActive(null);
  renderTabs();
  setCrumbs(layout, null, () => undefined);
  layout.backBtn.disabled = true;
  layout.forwardBtn.disabled = true;
  layout.modeBtn.disabled = true;
  layout.empty.hidden = false;
  layout.editor.hidden = true;
  layout.reading.hidden = true;
  calendarView.hide();
  layout.kanban.hidden = true;
  toolbar.setActive(false);
  // The empty editor has no note, so the counters read zero.
  host.clear();
  updateWords();
}

function renamed(id: string, path: string): void {
  splitView.renamed(id, path);
  const s = opened.find((o) => o.id === id);
  if (!s) return;
  s.path = path;
  renderTabs();
  if (active === s) showCrumbs(path);
}

// The breadcrumb of the open note; its last part renames the note in place.
function showCrumbs(path: string): void {
  setCrumbs(layout, path, (folder) => tree.reveal(folder), (name) => void explorer.rename(path, name));
  if (org.isOrganization) {
    layout.crumbs.append(lock);
    void refreshLock(path);
  }
}

// The last note written to the memory; a tab switch back to it writes nothing.
let remembered = "";
function remember(session: NoteSession): void {
  const key = `${session.id}\n${session.path}`;
  if (!spaceKey || key === remembered) return;
  remembered = key;
  rememberNote(spaceKey, session);
}

// The space the last-note memory is kept for: the browser's account and vault, or the desktop's space folder.
let spaceKey: string | null = null;
async function spaceKeyOf(): Promise<string | null> {
  if (browser) return `${browser.user.id}:${browser.vault.id}`;
  const spaces = await bridge.call<SpaceItem[]>("list_spaces").catch(() => []);
  return spaces.find((s) => s.current)?.path ?? null;
}

// The lock in the note header: who sees and edits the note (projects.ts editPermissions). Pressed when the note or a folder above it is protected.
const lock = iconButton("lock", "Kto widzi i edytuje");
lock.addEventListener("click", () => {
  if (active) notePermissions(active.path);
});
function notePermissions(path: string): void {
  void editPermissions(bridge, path, () => {
    forgetProtection();
    void refreshLock(path);
  });
}
let lockSeq = 0;
// Protection per path until the tree or the permissions change (the browser build clones the org snapshot per call).
const protection = new Map<string, ProjectProtection>();
let protectionEpoch = 0;
function forgetProtection(): void {
  protection.clear();
  protectionEpoch++;
}
async function refreshLock(path: string): Promise<void> {
  const seq = ++lockSeq;
  let info = protection.get(path) ?? null;
  if (!info) {
    const epoch = protectionEpoch;
    info = await bridge.call<ProjectProtection>("project_protection", { path }).catch(() => null);
    if (info && epoch === protectionEpoch) protection.set(path, info);
  }
  if (seq !== lockSeq || !info) return;
  const label = info.protected ? "Dostęp ograniczony" : "Kto widzi i edytuje";
  lock.setAttribute("aria-pressed", String(info.protected));
  lock.title = label;
  lock.setAttribute("aria-label", label);
}

// A note that is gone: its tab closes, its history entry and pending saves are dropped.
function forgetNote(id: string): void {
  loading.delete(id);
  saver.forget(id);
  dropFromTrail(id);
  splitView.forget(id);
  closeTab(id);
}

async function go(delta: number): Promise<void> {
  const at = trailAt + delta;
  const item = explorer.notes.find((n) => n.id === trail[at]);
  if (!item) return;
  trailAt = at;
  navigating = true;
  try {
    await openNote(item);
  } finally {
    navigating = false;
  }
}

function cycle(delta: number): void {
  if (!active || opened.length < 2) return;
  const i = opened.indexOf(active);
  select(opened[(i + delta + opened.length) % opened.length]);
}

// The calendar's dependencies: the explorer's tree, the index's flag, the bridge for the first write.
const calendarDeps: CalendarDeps = {
  bridge,
  items: () => explorer.notes,
  isCalendar: (id) => noteIndex.isCalendar(id),
  create: (path) => explorer.create(path),
  open: (item) => openNote(item),
  written: (id, text) => noteIndex.edited(id, text),
  single: () => org.isOrganization,
  notice: (m) => toast(m),
};
// An organization's calendar is the Kalendarze module page: no calendar note is opened or made there.
const withCalendar = (run: (deps: CalendarDeps) => Promise<void>) =>
  org.isOrganization ? showOrgTab(ORG_CALENDARS) : void run(calendarDeps).catch((err: unknown) => toast(errorText(err), true));


const tree = new FileTree(layout.tree, (id, path) => void openNote({ id, path }));
tree.isBoard = (id) => noteIndex.isKanban(id);
// The Zadania and Przegląd tabs replace the editor, as the graph does.
// Shows nothing of the note views: the graph, the editor and reading panes, and no active note in the tree.
function hideMainViews(): void {
  graph.hide();
  layout.empty.hidden = true;
  layout.editor.hidden = true;
  layout.reading.hidden = true;
  layout.kanban.hidden = true;
  tree.setActive(null);
}
function showOrgTab(id: string): void {
  hideMainViews();
  calendarView.hide();
  // the org view is on screen, so no note's row in the tree is active (the nav marks the view)
  org.show(id);
}

const tabs = new TabBar(
  layout.tabs,
  (id) => {
    if (id === GRAPH_TAB) {
      graph.show();
      return;
    }
    if (org.isTab(id)) {
      showOrgTab(id);
      return;
    }
    const s = opened.find((o) => o.id === id);
    if (s) select(s, false);
  },
  closeTab,
);
// The organization views, with the sidebar sections of an organization space (orgviews.ts).
const org: OrgViews = new OrgViews({
  bridge,
  layout,
  noteIndex,
  features: () => features,
  sessions: openSessions,
  active: () => active,
  notes: () => explorer.notes,
  open: (item) => openNote(item),
  reveal: revealLine,
  flush: () => saver.flushAll(),
  showTab: showOrgTab,
  renderTabs: () => renderTabs(),
  // "Wstaw do notatki" in Pliki: the file's link at the cursor; a read-only note (viewer) takes nothing
  insert: (text) => {
    const { view } = focused();
    if (view.state.readOnly) return toast("Tej notatki nie możesz edytować.", true);
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  },
});

// Moves the cursor to a line of the note on screen, and scrolls it into view.
function revealLine(line: number): void {
  const doc = host.view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
  host.view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
}

const explorer = new Explorer({
  bridge,
  tree,
  open: openNote,
  renamed,
  removed: forgetNote,
  newBoard: (folder) => void newKanban(folder),
  links: { index: noteIndex, openDoc: (id) => openSessions().find((s) => s.id === id)?.doc ?? null },
  openSide: (item) => void openSide(item),
});
explorer.bindHeader(layout.sidebar);
// Changes that arrive from another device (browser build): a note deleted there closes, the tree reloads, and open
// tabs follow renames. Open editors get their Yjs updates from the bridge's note_update events (features.ts).
bridge.on("note_removed", (payload) => {
  const { id } = payload as { id: string };
  if (openSessions().some((s) => s.id === id)) toast("Notatka została usunięta na innym urządzeniu.");
  forgetNote(id);
});
bridge.on("remote_changed", () => void syncRemote().catch((e: unknown) => toast(errorText(e), true)));
bridge.on("tree_changed", forgetProtection);
bridge.on("remote_changed", forgetProtection);
// Notes made outside the explorer (an import of .md files) show up in the tree.
on("ui:tree-reload", () => void explorer.reload());
async function syncRemote(): Promise<void> {
  await explorer.reload();
  for (const s of openSessions()) {
    const item = explorer.notes.find((n) => n.id === s.id);
    if (item && item.path !== s.path) renamed(s.id, item.path);
  }
}
const quick = new QuickOpen(
  (item) => void openNote(item),
  () => host.focus(),
  (path) => void createNote(path),
);
// "Otwórz notatkę obok": the same picker, the choice goes to the split.
const sidePicker = new QuickOpen(
  (item) => void openSide(item),
  () => host.focus(),
);
// Quick switcher: the note the typed name makes. The bridge refuses a bad path, and its message says why.
async function createNote(path: string): Promise<void> {
  try {
    await openNote(await explorer.create(path));
  } catch (err) {
    toast(errorText(err), true);
  }
}
// Wstaw szablon: the template list reuses the quick switcher (no creating from it).
const templatePicker = new QuickOpen(
  (item) => void insertTemplate(item),
  () => host.focus(),
);
const palette = new CommandPalette();
const openById = (id: string, path: string) => void openNote({ id, path });
const graph = new GraphTab({
  layout,
  noteIndex,
  activeId: () => active?.id ?? null,
  openById,
  reopen: () => {
    const next = active ?? opened[0];
    if (next) select(next);
    else showEmpty();
  },
  setToolbar: (on) => toolbar.setActive(on),
  hideCalendar: () => {
    calendarView.hide();
    layout.kanban.hidden = true;
  },
  renderTabs: () => renderTabs(),
  hideOrg: () => org.hide(),
  appSearch: () => features?.appSearch ?? null,
  openFile: (fileId) => features?.openFile(fileId),
});
// Tree changes and saved edits reach the index; both graphs follow them while they are on screen.
on("index:changed", () => {
  tree.refreshBoards();
  org.refresh();
});

layout.newTabBtn.addEventListener("click", () => void explorer.newNote());
layout.backBtn.addEventListener("click", () => void go(-1));
layout.forwardBtn.addEventListener("click", () => void go(1));
layout.modeBtn.addEventListener("click", toggleMode);
layout.moreBtn.addEventListener("click", () => {
  if (!active) return;
  const r = layout.moreBtn.getBoundingClientRect();
  const { id, path } = active;
  openMenu(r.left, r.bottom + 4, [
    { label: "Otwórz w nowej karcie", icon: "external-link", run: () => void openNote({ id, path }) },
    // The active note is the one on the left, so this entry picks the note for the split instead.
    { label: "Otwórz obok", icon: "panel-right", run: () => sidePicker.open(explorer.notes, "Otwórz notatkę obok") },
    "separator",
    ...explorer.noteActions(path, true),
  ]);
});

// Every command is registered here, so the palette, the ribbon and the hotkeys share one list.
registerCommand({ id: "quick.open", name: "Otwórz notatkę", hotkey: "Ctrl+P", run: () => quick.open(explorer.notes) });
registerCommand({ id: "split.open", name: "Otwórz notatkę obok", run: () => sidePicker.open(explorer.notes, "Otwórz notatkę obok") });
registerCommand({ id: "split.close", name: "Zamknij podział", run: closeSplit });
registerCommand({ id: "palette.open", name: "Paleta poleceń", hotkey: ["Ctrl+Shift+P", "F1"], run: () => palette.open() });
registerCommand({ id: "focus.toggle", name: "Tryb skupienia", hotkey: "Ctrl+Shift+Enter", run: () => toggleFocus(layout) });
registerCommand({ id: "note.new", name: "Nowa notatka", run: () => void explorer.newNote() });
// While "Mój kalendarz" fills the main area its ribbon button is lit, no tab is, and the bar says where the user is.
const myCalendarBtn = layout.app.querySelector<HTMLElement>('[data-command="calendar.open"]');
calendarView.onLeave = () => {
  myCalendarShown = false;
  myCalendarBtn?.setAttribute("aria-pressed", "false");
};
// The desktop's spaces as "Mój kalendarz" targets: the switcher's list, the ones that still exist and the open one.
async function desktopTargets(): Promise<EventTarget[]> {
  const spaces = await bridge.call<SpaceItem[]>("list_spaces");
  return spaces.filter((s) => s.current || s.exists).map((s) => ({ path: s.path, name: s.name, personal: s.kind !== "organizacja", organization: s.kind === "organizacja", current: s.current }));
}
// Adds an event to the open space: the organization's Kalendarze page, or the personal space's calendar note.
async function addEventHere(day: number, startMin: number | null): Promise<void> {
  try {
    if (org.isOrganization) {
      requestOrgEvent(day, startMin);
      showOrgTab(ORG_CALENDARS);
      return;
    }
    const item = findCalendar(explorer.notes, (id) => noteIndex.isCalendar(id)) ?? (await createCalendar(calendarDeps));
    await openNote(item);
    calendarView.createAt(day, startMin);
  } catch (err) {
    toast(errorText(err), true);
  }
}
// "Mój kalendarz" in every space: the organization events the user sees, their calendar notes and their tasks due.
function openMyCalendar(): void {
  void showMyCalendar({
    bridge,
    browser,
    view: calendarView,
    current: browser ? browser.vault.id : null,
    currentName: layout.vaultName.textContent ?? "",
    openNotes: () => (org.isOrganization ? Promise.resolve([]) : Promise.all(explorer.notes.filter((n) => noteIndex.isCalendar(n.id)).map((n) => bridge.call<string>("note_text", { id: n.id })))),
    switchTo: (path) => (browser ? goToVault(browser, path) : switchSpaceTo(org.switchDeps, path)),
    targets: () => (browser ? browserTargets(browser) : desktopTargets()),
    addHere: (_target, day, startMin) => void addEventHere(day, startMin),
    hideOthers: () => {
      hideMainViews();
      org.hide();
      toolbar.setActive(false);
      myCalendarShown = true;
      myCalendarBtn?.setAttribute("aria-pressed", "true");
      setCrumbs(layout, "Jesteś w kalendarzu", () => undefined);
      layout.modeBtn.disabled = true;
      renderTabs();
    },
  }).catch((err: unknown) => toast(errorText(err), true));
}
registerCommand({ id: "calendar.open", name: "Otwórz kalendarz", run: () => openMyCalendar() });

// Reminders of the calendar notes' events (ARCHITEKTURA §4.16b): a toast while the app is open, each occurrence once per session.
// Organizations have their own reminders (orgviews.ts), so they are skipped here.
async function calendarReminders(): Promise<void> {
  if (org.isOrganization) return;
  try {
    const texts = await Promise.all(explorer.notes.filter((n) => noteIndex.isCalendar(n.id)).map((n) => bridge.call<string>("note_text", { id: n.id })));
    for (const r of dueReminders(texts, Date.now())) {
      const key = `notes.calreminder.${r.key}`;
      let shown = false;
      try {
        shown = sessionStorage.getItem(key) !== null;
        sessionStorage.setItem(key, "1");
      } catch { /* no storage: the toast can come again on a later tick */ }
      if (shown) continue;
      toast(`Przypomnienie: ${r.title} · ${new Date(r.start).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}`);
    }
  } catch { /* Retry after the next tick. */ }
}
window.setInterval(() => void calendarReminders(), 60_000);
registerCommand({ id: "calendar.new", name: "Nowy kalendarz", run: () => withCalendar((deps) => newCalendar(deps)) });

// A board note (`Tablica.md`) in the active note's folder; when that name is taken, the user names the new one.
registerCommand({ id: "kanban.new", name: "Nowa tablica kanban", run: () => void newKanban() });
async function newKanban(folder = active ? folderOf(active.path) : ""): Promise<void> {
  const at = (name: string) => (folder ? `${folder}/${name}.md` : `${name}.md`);
  const taken = (path: string) => explorer.notes.some((n) => n.path === path);
  let name = KANBAN_NAME;
  if (taken(at(name))) {
    const asked = await askKanbanName(`${KANBAN_NAME} 2`);
    if (!asked) return;
    name = asked;
  }
  if (taken(at(name))) {
    toast(`Notatka ${at(name)} już istnieje.`, true);
    return;
  }
  try {
    const item = await explorer.create(at(name));
    await fillKanban(bridge, item.id);
    noteIndex.edited(item.id, KANBAN_TEXT);
    await openNote(item);
  } catch (err) {
    toast(errorText(err), true);
  }
}
// Templates and daily notes (templates.ts): the template goes in at the cursor as one undoable change.
registerCommand({ id: "template.insert", name: "Wstaw szablon", run: () => insertTemplatePick() });
function insertTemplatePick(): void {
  if (!active) return toast("Otwórz notatkę.");
  const folder = getSetting("templateFolder");
  const items = templateNotes(explorer.notes, folder);
  if (items.length === 0) return toast(`Brak szablonów. Utwórz notatki w folderze „${folder.trim()}”.`);
  templatePicker.open(items, "Wstaw szablon");
}
async function insertTemplate(item: TreeItem): Promise<void> {
  if (!active) return toast("Otwórz notatkę.");
  const { view } = focused();
  if (view.state.readOnly) return toast("Tej notatki nie możesz edytować.", true);
  const title = titleOf(active.path);
  try {
    const text = await bridge.call<string>("note_text", { id: item.id });
    view.dispatch(view.state.replaceSelection(applyTemplate(text, { title, now: new Date() })));
    view.focus();
  } catch (err) {
    toast(errorText(err), true);
  }
}
registerCommand({ id: "daily.open", name: "Dzisiejsza notatka", run: () => void openDaily() });
async function openDaily(): Promise<void> {
  try {
    await openDailyNote(
      { bridge, items: () => explorer.notes, create: (p) => explorer.create(p), open: openNote, written: (id, text) => noteIndex.edited(id, text) },
      getSetting("dailyFolder"),
      getSetting("dailyTemplate"),
    );
  } catch (err) {
    toast(errorText(err), true);
  }
}
registerCommand({ id: "graph.open", name: "Otwórz widok grafu", run: () => emit("ui:open-graph") });
registerCommand({ id: "transfer.export", name: "Pobierz wszystkie notatki (.zip)", run: () => void exportAll(bridge) });
registerCommand({ id: "transfer.import", name: "Wgraj pliki .md…", run: () => pickMarkdown(false, (files) => void importMarkdown(bridge, files)) });
registerCommand({ id: "transfer.importFolder", name: "Wgraj folder z notatkami…", run: () => pickMarkdown(true, (files) => void importMarkdown(bridge, files)) });
registerCommand({ id: "tasks.open", name: "Moje zadania", run: () => emit("ui:open-tasks") });
registerCommand({ id: "note.permissions", name: "Kto widzi tę notatkę…", run: () => (active ? notePermissions(active.path) : toast("Otwórz notatkę.")) });
// The file embed under the cursor, else the note's first one; the preview pages through the note's files.
function previewFileAtCursor(): void {
  const store = filesOf(bridge);
  const { view } = focused();
  const text = view.state.doc.toString();
  const ids = embeddedIds(text);
  if (!store || ids.length === 0) return void toast("W tej notatce nie ma plików.");
  void previewEmbeds(store, ids, embedAt(text, view.state.selection.main.head) ?? ids[0]);
}
registerCommand({ id: "file.preview", name: "Podgląd pliku", run: previewFileAtCursor });
setMeetingSource({ deps: calendarDeps, path: () => active?.path ?? null, openDoc: (id) => openSessions().find((s) => s.id === id)?.doc ?? null });
setTableNotes(calendarDeps, (id) => openSessions().find((s) => s.id === id)?.doc ?? null);
registerCommand({ id: "meeting.create", name: "Utwórz spotkanie z tej notatki", run: () => (active ? createMeeting(focused().view) : toast("Otwórz notatkę.")) });
// The browser build switches between vaults (vaults.ts); the desktop app switches between its spaces.
const switchSpace = (anchor: HTMLElement = layout.vaultName): void => {
  if (browser) void openVaultMenu(anchor, browser);
  else void openSwitcher(anchor, org.switchDeps);
};
// the space's name in the footer and at the top of the library open the same switcher
for (const anchor of [layout.vaultName, layout.vaultIcon, layout.workspaceName]) anchor.addEventListener("click", () => switchSpace(anchor));
registerCommand({ id: "space.switch", name: "Przełącz przestrzeń", run: () => switchSpace() });
registerCommand({ id: "settings.open", name: "Ustawienia", run: () => openSettings(layout.vaultName.textContent ?? "", org.settings(), browser ?? undefined) });
// The settings' default edit mode drives Live Preview vs source for every tab; the command flips that setting.
setSourceMode(getSetting("editMode") === "source");
onSettingChanged((key, value) => {
  if (key === "editMode") setSourceMode(value === "source");
});
registerCommand({
  id: "mode.source",
  name: "Przełącz tryb źródłowy i podgląd na żywo",
  run: () => setSetting("editMode", getSetting("editMode") === "source" ? "live" : "source"),
});
registerCommand({ id: "mode.toggle", name: "Przełącz tryb czytania i edycji", hint: "Ctrl+E", run: toggleMode });
registerCommand({ id: "tab.next", name: "Następna karta", hotkey: "Ctrl+Tab", run: () => cycle(1) });
registerCommand({ id: "tab.prev", name: "Poprzednia karta", hotkey: "Ctrl+Shift+Tab", run: () => cycle(-1) });
registerCommand({ id: "history.back", name: "Wstecz", run: () => void go(-1) });
registerCommand({ id: "history.forward", name: "Dalej", run: () => void go(1) });
installHotkeys();
let features: Features | null = null;

installShellKeys(layout, { toggleMode, cycle });

window.addEventListener("beforeunload", (e) => {
  if (!saver.hasUnsaved) return;
  e.preventDefault();
  e.returnValue = "";
});

async function start(): Promise<void> {
  showSpaceName(layout, await bridge.call<string>("space_name"));
  await org.load();
  [, spaceKey] = await Promise.all([explorer.reload(), spaceKeyOf()]);
  backupReminder(bridge, spaceKey, getSetting("backupReminder"));
  // a switch of space asked for a note: that one opens, else the note open last time, else the first note
  if (!(await org.takeOpenAt())) {
    const item = (spaceKey ? rememberedNote(spaceKey, explorer.notes) : null) ?? explorer.notes[0];
    if (item) await openNote(item);
    else showEmpty();
  }
  // an event asked for in "Mój kalendarz" before the switch of space: added once the space's notes are loaded
  const pending = takePending(browser ? browser.vault.id : spaceKey ?? "");
  if (pending) await addEventHere(pending.day, pending.startMin);
}

features = setupFeatures({ bridge, layout, noteIndex, host, sessions: openSessions, open: (id, path) => void openNote({ id, path }) });
features.appSearch.subscribe(() => graph.searchChanged());
void noteIndex.start().catch((err: unknown) => console.error("note index disabled", err));
void start();
