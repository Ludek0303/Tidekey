//! The organization side of the shell: the Zadania and Przegląd tabs, the library's sections, the task panel, the
//! space settings' organization part, and the copy of this device's tasks that the other spaces' "Moje zadania" read.

import type { Bridge, ProjectProtection, TreeItem, TreeListing } from "./bridge";
import { el } from "./dom";
import type { NoteSession } from "./editor";
import type { Features } from "./features";
import { setCrumbs, type Layout } from "./layout";
import type { NoteIndex } from "./noteindex";
import { emit, on } from "./bus";
import { registerCommand } from "./commands";
import { type CachedSpace, type MyTasksData, type ViewRow, type ViewState, renderMyTasks } from "./mytasks";
import { type ProjectRow, type TaskRow, dayOf, handlesIn, isoOf, mineOf, runTaskReminders, sameHandle, shortDate, supervisedBy } from "./orgtasks";
import { TASK_CHANGED, addSubtask, addTaskLines, editDone, editExternalTask, editField, editNote, tickLine } from "./orgedit";
import { setFrontMatter } from "./frontmatter";
import { renderProjectsPage } from "./projectsview";
import { type Department, departmentLookup, renderProjectPage } from "./projectpage";
import { newFilesViewState, renderFilesPage, scanUsages, type FilesViewState } from "./filesview";
import { filesOf } from "./filestore";
import { setTaskField } from "./orgtasks";
import { OrgNav, type Section } from "./orgnav";
import { renderOverview } from "./overview";
import { askNewProject, createProject, editPermissions, projectText, projectViewers } from "./projects";
import { openConnectDialog } from "./github/connect-view";
import { renderGithubStatus } from "./github/project-status";
import { githubService } from "./github/service";
import { type SpaceKind, type SwitchDeps, switchSpace } from "./spaces";
import type { SpaceSettings } from "./settings";
import { setTaskSpace, setTaskLineHandler } from "./taskchips";
import { setTableCheckAccess, type TableCheckItem } from "./tablechecks";
import { type TaskAdds, historyCard, taskPanelBody } from "./taskpanel";
import { confirmDialog, errorText, toast } from "./widgets";
import { notificationCard, renderInsights, type Insight, type InsightState } from "./insights";
import { REASON_LABEL, markNotificationsRead, unreadNotifications } from "./notifications";
import { canAdminister, currentNameOf, delegator, nameLookup, namesOf, personName, resolveTaskPeople, type OrganizationSnapshot, type TaskEvent } from "./taskhistory";
import { renderModules, type ModuleState, type ModulePage } from "./modules";
import { type ModuleData, participantsFor, str, num } from "./records";
import { occurrences } from "./availability";
import { SETTINGS_ID, cutoffDay, expired, removeTasks, retentionMonths, settingsRecord, trustedRetention } from "./taskretention";
import { TOP_TEXT } from "./protected";
export const ORG_CALENDARS = "__org_calendars__";
const MODULES: Record<string, ModulePage> = { [ORG_CALENDARS]: "calendars", __org_inventory__: "inventory", __org_availability__: "availability" };
const MODULE_LABELS: Record<ModulePage,string> = { calendars: "Kalendarze", inventory: "Inwentarze", availability: "Dostępność" };

const INSIGHTS: Record<string, Insight> = { __org_people__: "people", __org_notifications__: "notifications", __org_activity__: "activity", __org_graphs__: "graphs" };
const INSIGHT_LABELS: Record<Insight, string> = { people: "Osoby i grupy", notifications: "Powiadomienia", activity: "Aktywność", graphs: "Grafy" };

export const ORG_TASKS = "__org_tasks__";
export const ORG_OVERVIEW = "__org_overview__";
export const ORG_PROJECTS = "__org_projects__";
export const ORG_FILES = "__org_files__";
// A project's own screen: `__org_project__:<project note path>` (projectpage.ts).
export const ORG_PROJECT = "__org_project__:";
// Set before a switch of space: the note to open once the other space is on screen (sessionStorage survives the reload).
const OPEN_AT = "notes.openAt";
const CACHE_DELAY_MS = 1500;
// An event a Claude chat signed shows as "<person> (przez Claude)" (docs/MCP.md §9).
const byWhom = (s: Parameters<typeof personName>[0], event: { actor_user_id: string; signerAgentId?: string }): string =>
  `${personName(s, event.actor_user_id)}${event.signerAgentId ? " (przez Claude)" : ""}`;
const ACTIVITY_ADMINS_ONLY = "Aktywność widzą tylko właściciel i administratorzy organizacji.";
const NOT_ORGANIZATION = "Zadania są w przestrzeni organizacji. Zmień typ przestrzeni w Ustawieniach → Ogólne.";

export interface OrgDeps {
  bridge: Bridge;
  layout: Layout;
  noteIndex: NoteIndex;
  features: () => Features | null;
  sessions: () => NoteSession[];
  active: () => NoteSession | null;
  notes: () => TreeItem[];
  open: (item: TreeItem) => Promise<void>;
  reveal: (line: number) => void;
  // Saves what the open note still has to send; false when a save failed.
  flush: () => Promise<boolean>;
  // Shows an org tab: the shell hides the graph and the calendar, then calls `OrgViews.show`.
  showTab: (id: string) => void;
  renderTabs: () => void;
  // Writes text at the cursor of the open note (the Pliki page inserts a file embed).
  insert: (text: string) => void;
}

export interface CopyRow {
  assignees?: unknown;
  text?: unknown;
  line?: unknown;
  done?: unknown;
}

/** A copy's row is used only when its fields have the shape the views read. */
export function isTaskRow(r: CopyRow): boolean {
  return Array.isArray(r.assignees) && typeof r.text === "string" && typeof r.line === "number" && typeof r.done === "boolean";
}

/** The panel's task as the index reads it now. Edits of the open note reach the index after a pause, so the
 * pending ones are written first: a second quick edit must not see the task as it was before the first. */
export function currentTask(
  index: Pick<NoteIndex, "flush" | "tasks">,
  ref: { note: string; block: string | null; line: number; text: string },
): TaskRow | undefined {
  index.flush();
  return (index.tasks()?.tasks ?? []).find((t) =>
    // a task first seen without an id is still the same task once it has one
    t.note === ref.note && (ref.block ? t.block === ref.block : t.line === ref.line && t.text === ref.text),
  );
}

/** A note made and filled by the app: the index learnt of it when it was still empty (the tree changed on create),
 * so it is told the text now. Without this a new project is not a project until it is edited. */
export async function indexNewNote(index: Pick<NoteIndex, "sync" | "edited" | "flush">, id: string, text: string): Promise<void> {
  await index.sync();
  index.edited(id, text);
  index.flush();
}

/**
 * Whether the copy of this device's tasks is written. Not without an index: nothing true to copy, and an empty copy
 * would replace a good one. Not without a handle: the copy could not say whose tasks it holds.
 */
export function shouldWriteCache(organization: boolean, me: string, indexReady: boolean): boolean {
  return organization && me !== "" && indexReady;
}

export class OrgViews {
  private identity: OrganizationSnapshot | null = null;
  private moduleState: ModuleState = { selected: "", month: new Date().toISOString().slice(0,10), view: "month", search: "" };
  private insightState: InsightState = { year: new Date().getFullYear(), person: "", group: "", project: "", points: false, graph: "delegation", expanded: new Set(), taskState: "done", timelineStart: new Date().toLocaleDateString("sv-SE"), timelineRange: "week" };
  private accountName: string | undefined;
  readonly nav: OrgNav;
  private shown: string | null = null;
  private kind: SpaceKind = "notatki";
  private me = "";
  private tasksState: ViewState = { tab: "mine", done: false };
  private cacheTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  // The Pliki page keeps its filters and uploads between renders.
  private readonly filesState: FilesViewState = newFilesViewState();
  // Event ids seen by the last notification check; a notification of an event not among them is new (a toast).
  private knownEvents: Set<string> | null = null;
  // The latest task reminder moment shown per task block in this run; the localStorage keeps it across runs (see taskReminders).
  private readonly remindedTasks = new Map<string, number>();
  // The names this device goes by and the lookup of the people, built once per identity snapshot (see nameIndex).
  private namesIndex: { of: OrganizationSnapshot | null; me: string; lookup: (name: string) => string | undefined; names: string[] } | null = null;
  private pruned = false;
  // The deps of a switch of space: the open note is saved first, then the other space opens and the window reloads.
  readonly switchDeps: SwitchDeps;

  constructor(private readonly d: OrgDeps) {
    // The process ends on a space switch. Reminders never read a closed space or request OS notification permissions.
    window.setInterval(() => { void this.reminders(); this.taskReminders(); }, 60_000);
    this.nav = new OrgNav(d.layout.sidebar.querySelector<HTMLElement>("#pane-files")!, {
      section: (s) => this.section(s),
    });
    this.nav.setSectionVisible("files", filesOf(d.bridge) !== null);
    this.switchDeps = { bridge: d.bridge, flush: d.flush, reload: () => location.reload() };
    setTaskLineHandler((line) => this.openTask(line));
    // A merge brings events from other members (new notifications); verification results re-draw the shown view.
    d.bridge.on("remote_changed", () => void this.updateNotifications());
    d.bridge.on("org_verified", () => { if (this.shown !== null) this.render(); });
    on("ui:open-tasks", () => this.showTasks());
    on("ui:open-overview", () => this.showOverview());
    registerCommand({ id: "overview.open", name: "Przegląd organizacji", run: () => this.showOverview() });
    registerCommand({ id: "project.new", name: "Nowy projekt", run: () => void this.newProject() });
  }

  get isOrganization(): boolean {
    return this.kind === "organizacja";
  }

  /** The department of a person by name, from the identity snapshot (none outside an organization). */
  department(name: string): Department | undefined {
    const s = this.identity;
    return s ? departmentLookup(s.groups ?? [], s.members)(name) : undefined;
  }

  private async reminders(): Promise<void> {
    if (!this.isOrganization || !this.identity) return;
    const identity = this.identity;
    try {
      const data = await this.d.bridge.call<ModuleData>("organization_records");
      const now = Date.now();
      for (const event of Object.values(data.records).filter((r) => r.kind === "event" && !r.deleted && num(r,"reminder_minutes") > 0 && participantsFor(r,identity).includes(identity.me))) {
        const reply = data.records[`rsvp-${event.id}-${identity.me}`];
        if (reply?.response === "no") continue;
        for (const occurrence of occurrences(event, now, now + num(event,"reminder_minutes") * 60_000)) {
          if (occurrence.start < now) continue;
          const key = `notes.reminder.${identity.space_id}.${identity.me}.${event.id}.${occurrence.start}`;
          if (sessionStorage.getItem(key)) continue;
          sessionStorage.setItem(key,"1");
          toast(`Przypomnienie: ${str(event,"name")} · ${new Date(occurrence.start).toLocaleTimeString("pl-PL",{hour:"2-digit",minute:"2-digit"})}`);
        }
      }
    } catch { /* Retry after the next tick; closed/unavailable spaces must not expose cached content. */ }
  }

  // Task reminders (ORGANIZACJA §6): the open tasks of this user whose `!przypomnij:` time has come, each moment shown once.
  // Only while the app is open. Per space, user and task, localStorage keeps one key: the latest moment shown.
  private taskReminders(): void {
    if (!this.isOrganization || !this.identity) return;
    const s = this.identity;
    const storageKey = (block: string) => `notes.taskreminder.${s.space_id}.${s.me}.${block}`;
    const shownAt = (block: string): number => {
      let stored = -Infinity;
      try { const raw = localStorage.getItem(storageKey(block)); if (raw !== null) stored = Number(raw); } catch { /* the run keeps it in memory */ }
      return Math.max(this.remindedTasks.get(block) ?? -Infinity, stored);
    };
    // Only the open tasks with a reminder are resolved to their people.
    const open = (this.d.noteIndex.tasks()?.tasks ?? []).filter((t) => !t.done && t.block !== null && !!t.reminder && t.due !== null);
    const isMine = (row: TaskRow) => (row.effective_assignees ?? row.assignees).some((a) => this.namedMe(a));
    runTaskReminders(open.map((task) => resolveTaskPeople(task, s)), isMine, Date.now(), shownAt, ({ key, row, at }) => {
      this.remindedTasks.set(key, at);
      try { localStorage.setItem(storageKey(key), String(at)); } catch { /* the run keeps it in memory */ }
      toast(`Przypomnienie: ${row.text} — termin ${shortDate(row.due!)}`, false, { label: "Pokaż", run: () => void this.openPath(row.path, row.line) });
    });
  }

  /** This device's handle in the open space ("" when none). */
  get handle(): string {
    return this.me;
  }

  /** What the general settings pane shows and changes for the open space. */
  settings(): SpaceSettings {
    const self = this;
    return {
      get kind() {
        return self.kind;
      },
      get handle() {
        return self.me;
      },
      get accountName() {
        return self.accountName;
      },
      setKind: async (kind) => {
        await this.d.bridge.call("set_space_kind", { kind });
        this.setKind(kind);
      },
      setHandle: (handle) => this.setHandle(handle),
      setAccountName: this.accountName === undefined ? undefined : (name) => this.setAccountName(name),
      lastName: this.accountName === undefined ? undefined : {
        load: () => this.d.bridge.call<string>("account_last_name"),
        save: (last) => this.d.bridge.call<void>("set_account_last_name", { last }),
      },
      taskRetention: async () => {
        const data = await this.d.bridge.call<ModuleData>("organization_records");
        return { months: retentionMonths(data), canEdit: !!this.identity && canAdminister(this.identity) };
      },
      setTaskRetention: async (months) => {
        const data = await this.d.bridge.call<ModuleData>("organization_records");
        // A stored activity_visibility from before the option was removed is dropped on save.
        const { activity_visibility: _legacy, ...kept } = settingsRecord(data) ?? { id: SETTINGS_ID, kind: "settings" };
        const record = { ...kept, task_retention_months: months };
        await this.d.bridge.call("organization_save_record", { record, expected: data.revisions[SETTINGS_ID] ?? data.empty_revision, path: null });
        this.pruned = false;
        await this.pruneTasks();
      },
      exportNotes: async () => {
        const { notes } = await this.d.bridge.call<TreeListing>("list_tree");
        const out: Record<string, string> = {};
        for (const n of notes) out[n.path] = await this.d.bridge.call<string>("note_text", { id: n.id });
        return out;
      },
    };
  }

  /** The type and the handle of this device in the open space, from the backend. */
  async load(): Promise<void> {
    const kind = await this.d.bridge.call<SpaceKind>("space_kind");
    this.accountName = await this.d.bridge.call<string>("account_name").catch(() => undefined);
    this.me = (await this.d.bridge.call<string | null>("my_handle").catch(() => null)) ?? "";
    try {
      this.identity = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
      const profile = this.identity.members.find((m) => m.user_id === this.identity?.me);
      if (profile?.name) this.me = profile.name;
      else if (this.me && this.identity.me === this.identity.owner) {
        await this.d.bridge.call("organization_person", { userId: this.identity.me, name: this.me });
        this.identity = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
      }
    } catch { /* Older bridges have no authenticated member directory. */ }
    this.applyRole();
    this.setKind(kind);
  }

  setKind(kind: SpaceKind): void {
    this.kind = kind;
    setTaskSpace(this.isOrganization ? "organization" : "personal");
    setTableCheckAccess(this.isOrganization ? (checkers) => this.mayTickColumn(checkers) : null);
    this.nav.setMode(this.isOrganization ? "organization" : "personal");
    this.refresh();
    void this.updateNotifications();
  }

  // The unread count on the Powiadomienia button; a toast for notifications whose events were not known before.
  private async updateNotifications(): Promise<void> {
    if (!this.isOrganization) return;
    try {
      const snapshot = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
      const unread = unreadNotifications(snapshot);
      this.nav.setCount("notifications", unread.length + this.tableTodos().length);
      const known = this.knownEvents;
      this.knownEvents = new Set(snapshot.events.map((e) => e.event_id));
      const fresh = known ? unread.filter((n) => !known.has(n.event.event_id)) : [];
      if (fresh.length === 1) toast(`Nowe powiadomienie: ${REASON_LABEL[fresh[0].reason]}.`, false, { label: "Pokaż", run: () => void this.openNotified(fresh[0].event, snapshot) });
      else if (fresh.length) toast(`Nowe powiadomienia: ${fresh.length}.`, false, { label: "Pokaż", run: () => this.d.showTab("__org_notifications__") });
    } catch { /* The count follows the next change; an unavailable space shows nothing. */ }
  }

  // A notification's task: its line when the index still knows the task, else just its note.
  private async openNotified(event: TaskEvent, snapshot: OrganizationSnapshot): Promise<void> {
    markNotificationsRead(snapshot, [event.event_id]);
    const task = this.tasks().find((t) => t.block === event.after.task_id);
    if (task) { await this.openPath(task.path, task.line); return; }
    const note = this.d.notes().find((n) => n.id === event.note_id);
    if (note) await this.d.open(note);
  }

  async setHandle(handle: string): Promise<void> {
    if (this.identity?.me === this.identity?.owner && this.identity) {
      await this.d.bridge.call("organization_person", { userId: this.identity.me, name: handle });
      this.identity = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
    }
    await this.d.bridge.call("set_my_handle", { handle });
    this.me = handle;
    this.refresh();
  }

  private async setAccountName(name: string): Promise<void> {
    await this.d.bridge.call("set_account_name", { name });
    this.accountName = name;
    this.me = name;
    this.identity = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot").catch(() => this.identity);
    this.refresh();
  }

  // Zadania is in a personal space too (one person's tasks); only the organization's sections toast without one.
  showTasks(): void {
    this.d.showTab(ORG_TASKS);
  }

  showOverview(): void {
    if (this.isOrganization) this.d.showTab(ORG_OVERVIEW);
    else toast(NOT_ORGANIZATION);
  }

  /** Shows an org tab. The task panel is dropped: it belongs to a note. */
  show(id: string): void {
    this.shown = id;
    const { layout } = this.d;
    layout.orgView.hidden = false;
    // the calendar module fills the main area like the note calendar does
    layout.orgView.classList.toggle("is-calendar", id === ORG_CALENDARS);
    layout.formatBar.hidden = true;
    // the calendar module says where the user is, as "Mój kalendarz" does
    layout.crumbs.hidden = id !== ORG_CALENDARS;
    if (id === ORG_CALENDARS) setCrumbs(layout, "Kalendarz organizacji", () => undefined);
    layout.modeBtn.disabled = true;
    const section = INSIGHTS[id] ?? MODULES[id] ?? (id === ORG_TASKS ? "tasks" : id === ORG_PROJECTS ? "projects" : id === ORG_FILES ? "files" : id.startsWith(ORG_PROJECT) ? "projects" : "overview");
    this.nav.select(section);
    this.d.features()?.clearTask();
    this.render();
    this.d.renderTabs();
  }

  /** Hides the org tab; true when one was shown. The note's own bars come back. */
  hide(): boolean {
    if (this.shown === null) return false;
    this.shown = null;
    this.nav.clear();
    const { layout } = this.d;
    layout.orgView.hidden = true;
    layout.formatBar.hidden = false;
    layout.crumbs.hidden = false;
    return true;
  }

  isTab(id: string): boolean {
    return id === ORG_TASKS || id === ORG_OVERVIEW || id === ORG_PROJECTS || id === ORG_FILES || id.startsWith(ORG_PROJECT) || id in INSIGHTS || id in MODULES;
  }

  /** The tab of the shown org view, for the tab bar. */
  tabs(): { id: string; title: string }[] {
    if (this.shown === null) return [];
    return [{ id: this.shown, title: this.shown.startsWith(ORG_PROJECT) ? (this.projectOf(this.shown.slice(ORG_PROJECT.length))?.name ?? "Projekt") : this.shown in MODULES ? MODULE_LABELS[MODULES[this.shown]] : this.shown in INSIGHTS ? INSIGHT_LABELS[INSIGHTS[this.shown]] : this.shown === ORG_TASKS ? "Zadania" : this.shown === ORG_PROJECTS ? "Projekty" : this.shown === ORG_FILES ? "Pliki" : "Przegląd" }];
  }

  /** The index changed: the shown view and the copy of the tasks follow. */
  refresh(): void {
    if (this.shown !== null) this.render(); // a personal space shows Zadania too
    if (!this.isOrganization) return;
    this.scheduleCache();
    void this.pruneTasks();
  }

  // Once per opened space, on an administrator's device: done tasks older than the organization's setting leave their
  // notes (the note's version history still has them).
  private async pruneTasks(): Promise<void> {
    if (this.pruned || !this.identity || !canAdminister(this.identity) || this.d.noteIndex.tasks() === null) return;
    this.pruned = true;
    try {
      const months = trustedRetention(await this.d.bridge.call<ModuleData>("organization_records"), this.identity);
      if (!months) return;
      const notes = expired(this.tasks(), cutoffDay(new Date(), months));
      for (const [note, rows] of notes) await editNote(this.edits(), note, (text) => removeTasks(text, rows));
    } catch (err) {
      toast(`Nie udało się usunąć starych zadań: ${errorText(err)}`, true);
    }
  }

  private section(section: Section): void {
    if (`__org_${section}__` in INSIGHTS || `__org_${section}__` in MODULES) this.d.showTab(`__org_${section}__`);
    else if (section === "overview") this.d.showTab(ORG_OVERVIEW);
    else if (section === "tasks") this.d.showTab(ORG_TASKS);
    else if (section === "files") this.d.showTab(ORG_FILES);
    else if (section === "projects") this.d.showTab(ORG_PROJECTS);
    else this.nav.select(section);
  }

  private render(): void {
    if (this.shown === ORG_TASKS) void this.renderTasks();
    else if (this.shown === ORG_OVERVIEW) this.renderOverview();
    else if (this.shown === ORG_PROJECTS) void this.renderProjects();
    else if (this.shown?.startsWith(ORG_PROJECT)) void this.renderProject(this.shown.slice(ORG_PROJECT.length));
    else if (this.shown === ORG_FILES) this.renderFiles();
    else if (this.shown && this.shown in INSIGHTS) void this.renderInsight(INSIGHTS[this.shown]);
    else if (this.shown && this.shown in MODULES) {
      const id = this.shown; const seq = ++this.seq;
      void renderModules(this.d.layout.orgView, MODULES[id], this.d.bridge, this.moduleState, () => this.render(), () => this.shown === id && seq === this.seq);
    }
  }

  // The activity view is for the owner and administrators only; members do not see the section.
  private applyRole(): void {
    this.nav.setSectionVisible("activity", !!this.identity && canAdminister(this.identity));
  }

  private async renderInsight(page: Insight): Promise<void> {
    const seq = ++this.seq;
    const host = this.d.layout.orgView;
    host.replaceChildren(el("p", "muted", "Wczytywanie…"));
    try {
      if (!(await this.d.flush())) throw new Error("Nie udało się zapisać zmian. Spróbuj ponownie.");
      const snapshot = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
      this.identity = snapshot;
      this.applyRole();
      if (seq !== this.seq || this.shown !== `__org_${page}__`) return;
      if (page === "activity" && !canAdminister(snapshot)) { host.replaceChildren(el("p", "org-hint", ACTIVITY_ADMINS_ONLY)); return; }
      renderInsights(host, page, snapshot, this.tasks(), this.d.noteIndex.projects() ?? [], this.insightState, {
        refresh: () => this.render(),
        spaceName: () => this.d.bridge.call<string>("space_name"),
        open: (task) => void this.openPath(task.path, task.line),
        name: (userId, name) => this.d.bridge.call("organization_person", { userId, name }),
        group: (group) => this.d.bridge.call("organization_group", { group }),
        openProject: (path) => { const note = this.d.notes().find((n) => n.path === path); if (note) void this.d.open(note); },
        openNote: (id) => { const note = this.d.notes().find((n) => n.id === id); if (note) void this.d.open(note); else toast("Notatka z tym zadaniem już nie istnieje.", true); },
      });
      if (page === "notifications") host.append(this.tableTodoSection());
      void this.updateNotifications();
    } catch (e) {
      if (seq === this.seq) { const error = el("p", "firstrun-error", errorText(e)); error.setAttribute("role", "alert"); host.replaceChildren(error); }
    }
  }

  // Whether this device's user is the person a name stands for: by a handle they went by, or by the alias lookup.
  private namedMe(name: string): boolean {
    const index = this.nameIndex();
    return index.names.some((n) => sameHandle(name, n)) || (!!this.identity && index.lookup(name) === this.identity.me);
  }

  // The name lookup of the space and this device's names, rebuilt only when the identity snapshot or the handle changes.
  private nameIndex() {
    const of = this.identity;
    const cur = this.namesIndex;
    if (cur && cur.of === of && cur.me === this.me) return cur;
    const own = of ? namesOf(of, of.me) : [];
    return (this.namesIndex = { of, me: this.me, lookup: of ? nameLookup(of) : () => undefined, names: [...new Set([this.me, ...own].filter((n) => n.trim() !== ""))] });
  }

  // Who may tick a column that names checkers (`!zaznacza`): the owner and administrators, the people named, and the
  // members of a group with that name. The note's own edit rights are checked by the editor.
  private mayTickColumn(checkers: string[]): boolean {
    const s = this.identity;
    if (!s) return false;
    if (canAdminister(s)) return true;
    return checkers.some((c) => this.namedMe(c) || (s.groups ?? []).some((g) => !g.archived && sameHandle(c, g.name) && g.member_ids.includes(s.me)));
  }

  // Unticked table boxes that name this user in `@osoba`: the "do zrobienia" items, in note order.
  private tableTodos(): { path: string; item: TableCheckItem }[] {
    return this.d.noteIndex.tableChecks().flatMap(({ path, items }) => items.filter((item) => !item.checked && item.people.some((p) => this.namedMe(p))).map((item) => ({ path, item })));
  }

  // The "Do zrobienia w tabelach" part of the notifications page; a click opens the note at the box's row.
  private tableTodoSection(): HTMLElement {
    const section = el("section", "org-todo");
    section.append(el("h3", "", "Do zrobienia w tabelach"));
    const todos = this.tableTodos();
    if (!todos.length) section.append(el("p", "org-hint", "Nic do zrobienia."));
    for (const { path, item } of todos) {
      // The same card as a task notification; the whole card opens the note at the box's row.
      const go = () => void this.openPath(path, item.line);
      const meta = [path.replace(/\.md$/, ""), item.due ? `termin ${item.due}` : ""].filter(Boolean).join(" · ");
      section.append(notificationCard("Do zrobienia", `${item.header} · ${item.rowLabel}`, meta, go));
    }
    return section;
  }

  // Every name this user goes by in the space: the current handle and the aliases kept after renames.
  private myNames(): string[] {
    return [...this.nameIndex().names];
  }

  private tasks(): TaskRow[] {
    const tasks = this.d.noteIndex.tasks()?.tasks ?? [];
    return this.identity ? tasks.map((task) => resolveTaskPeople(task, this.identity!)) : tasks;
  }

  private async renderTasks(): Promise<void> {
    const seq = ++this.seq;
    const cached = this.isOrganization ? await this.copies() : [];
    if (seq !== this.seq || this.shown !== ORG_TASKS) return;
    const data: MyTasksData = { me: this.me, names: this.myNames(), userId: this.identity?.me, today: dayOf(new Date()), live: this.tasks(), cached, single: !this.isOrganization };
    renderMyTasks(this.d.layout.orgView, data, this.tasksState, {
      setState: (state) => {
        this.tasksState = state;
        this.render();
      },
      toggle: (view, done) => void this.toggle(view, done),
      open: (view) => void this.openRow(view),
      due: (view, value) => void this.changeDue(view, value),
    });
  }

  private async renderProjects(): Promise<void> {
    const seq = ++this.seq;
    const projects = this.d.noteIndex.projects() ?? [];
    const [snapshot, protection] = await Promise.all([
      this.d.bridge.call<OrganizationSnapshot>("organization_snapshot").catch(() => this.identity),
      this.protectionOf(projects),
    ]);
    if (seq !== this.seq || this.shown !== ORG_PROJECTS) return;
    const admin = !!snapshot && canAdminister(snapshot);
    renderProjectsPage(
      this.d.layout.orgView,
      {
        today: dayOf(new Date()),
        live: this.tasks(),
        projects,
        people: (snapshot?.members ?? []).flatMap((m) => (m.name ? [m.name] : [])),
        groups: snapshot?.groups ?? [],
        members: snapshot?.members ?? [],
        protection,
        // the lead who may assign is the one an owner or admin appointed in the signed entry, not the note's text
        canAssign: (p) => admin || (!!p.folder && !!snapshot && protection.get(p.folder)?.lead === snapshot.me),
        canCreate: admin,
        pending: (p) => (snapshot ? pendingApproval(p, protection.get(p.folder ?? ""), snapshot) : null),
      },
      {
        open: (path, line) => void this.openPath(path, line),
        tasks: () => this.d.showTab(ORG_TASKS),
        newProject: () => void this.newProject(),
        openProject: (p) => this.d.showTab(ORG_PROJECT + p.path),
        protect: (path) => void this.permissions(path),
        members: (path) => void this.permissions(path),
        unprotect: (path) => void this.unprotectProject(path),
        assign: async (p, people, groups) => {
          await editNote(this.edits(), p.note, (text) => setFrontMatter(setFrontMatter(text, "osoby", people.join(", ")), "grupy", groups.join(", ")));
          await this.d.flush();
          if (p.folder) await this.restrictProject(p.folder, people, groups, p.lead);
          this.render();
        },
        approve: async (p) => {
          if (p.folder) await this.restrictProject(p.folder, p.people ?? [], p.groups ?? [], p.lead, true);
          this.render();
        },
      },
    );
    void this.lockOpenProjects(projects, protection);
  }

  private projectOf(path: string): ProjectRow | undefined {
    return (this.d.noteIndex.projects() ?? []).find((p) => p.path === path);
  }

  // The project's own screen: its tasks, the board and the timeline built from the organization's events.
  private async renderProject(path: string): Promise<void> {
    const seq = ++this.seq;
    const snapshot = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot").catch(() => null);
    if (seq !== this.seq || this.shown !== ORG_PROJECT + path) return;
    const project = this.projectOf(path);
    if (!project) {
      this.d.layout.orgView.replaceChildren(el("p", "org-hint", "Nie ma takiego projektu."));
      return;
    }
    // GitHub: the menu entry and the status show only where a GitHub service is open (a shared vault) and the project has a folder.
    const github = githubService();
    const folder = project.folder;
    renderProjectPage(
      this.d.layout.orgView,
      { today: dayOf(new Date()), project, tasks: this.tasks().filter((t) => t.project_note === project.note), events: snapshot?.events ?? [], groups: snapshot?.groups ?? [], members: snapshot?.members ?? [] },
      {
        back: () => this.d.showTab(ORG_PROJECTS),
        openNote: (notePath) => void this.openPath(notePath),
        open: (task) => void this.openPath(task.path, task.line),
        toggleDone: (task) => void this.toggleProjectTask(task),
        ...(github && folder ? { connectGithub: () => void this.connectGithub(folder) } : {}),
      },
    );
    if (github && folder) {
      const status = el("section", "project-section gh-section");
      this.d.layout.orgView.append(status);
      void renderGithubStatus(status, folder, github);
    }
  }

  private async toggleProjectTask(task: TaskRow): Promise<void> {
    try {
      await editDone(this.edits(), task, !task.done, dayOf(new Date()));
      this.render();
    } catch (e) {
      toast(errorText(e), true);
      this.render();
    }
  }

  // The Pliki page: the space's files, and the notes that embed each one (read from the notes' text, see scanUsages).
  private renderFiles(): void {
    const store = filesOf(this.d.bridge);
    if (!store) return;
    const notes = this.d.notes();
    // The link index knows which notes embed a file: only those are read.
    const graph = this.d.noteIndex.graph();
    const embedders = graph && new Set(graph.ghosts.filter((g) => g.name.startsWith("plik:")).flatMap((g) => g.from));
    const setUsages = renderFilesPage(
      this.d.layout.orgView,
      { store, notes, usages: null, canInsert: this.d.active() !== null, state: this.filesState },
      {
        open: (path, line) => void this.openPath(path, line),
        insert: (text) => void this.insertText(text),
      },
    );
    // The open note is saved first, so its text is current. Counted again on each visit of the page.
    void this.d.flush()
      .then(() => scanUsages(embedders ? notes.filter((n) => embedders.has(n.id)) : notes, (id) => this.d.bridge.call<string>("note_text", { id })))
      .then(setUsages);
  }

  // The note the user was on gets the text at its cursor; a file's embed is written, the file is not uploaded again.
  private async insertText(text: string): Promise<void> {
    const session = this.d.active();
    if (!session) {
      toast("Najpierw otwórz notatkę", true);
      return;
    }
    await this.d.open({ id: session.id, path: session.path });
    this.d.insert(text);
  }

  private renderOverview(): void {
    renderOverview(
      this.d.layout.orgView,
      {
        space: this.d.layout.vaultName.textContent ?? "",
        me: this.me,
        names: this.myNames(),
        displayName: this.identity ? currentNameOf(this.identity) : undefined,
        today: dayOf(new Date()),
        live: this.tasks(),
        projects: this.d.noteIndex.projects() ?? [],
        canCreate: !this.identity || canAdminister(this.identity),
        now: new Date(),
      },
      {
        open: (path, line) => void this.openPath(path, line),
        tasks: () => this.d.showTab(ORG_TASKS),
        newProject: () => void this.newProject(),
      },
    );
  }

  // The copies of the other spaces' tasks, as the backend keeps them. Each carries the handle it was made with.
  private async copies(): Promise<CachedSpace[]> {
    const raw = await this.d.bridge
      .call<{ name: string; path: string; saved: { updated: string; me?: string; names?: string[]; userId?: string; rows: CopyRow[] } }[]>("task_caches")
      .catch(() => []);
    return raw.map((c) => ({
      name: c.name,
      path: c.path,
      updated: c.saved.updated,
      me: c.saved.me ?? "",
      names: c.saved.names,
      userId: c.saved.userId,
      rows: (c.saved.rows ?? []).filter(isTaskRow) as TaskRow[],
    }));
  }

  private async toggle(view: ViewRow, done: boolean): Promise<void> {
    try {
      if (view.cached) await editExternalTask(this.d.bridge, view.cached.path, view.row, (line, lines, index) => tickLine(line, lines, index, done, dayOf(new Date())));
      else await editDone(this.edits(), view.row, done, dayOf(new Date()));
      this.render();
    } catch (e) {
      toast(errorText(e), true);
      this.render();
    }
  }

  private async changeDue(view: ViewRow, value: string | null): Promise<void> {
    try {
      if (view.cached) await editExternalTask(this.d.bridge, view.cached.path, view.row, (line) => setTaskField(line, "due", value));
      else await editField(this.edits(), view.row, "due", value);
    } catch (e) { toast(errorText(e), true); }
    this.render();
  }

  private async openRow(view: ViewRow): Promise<void> {
    if (view.cached) {
      this.leaveFor({ path: view.row.path, line: view.row.line });
      if (!(await switchSpace(this.switchDeps, view.cached.path))) this.leaveFor(null);
      return;
    }
    await this.openPath(view.row.path, view.row.line);
  }

  /** Opens a note of the open space, with the cursor on `line` when given. False when there is no such note. */
  async openPath(path: string, line?: number): Promise<boolean> {
    const item = this.d.notes().find((n) => n.path === path);
    if (!item) {
      toast(`Nie ma notatki: ${path}`, true);
      return false;
    }
    await this.d.open(item);
    if (line !== undefined) this.d.reveal(line);
    return true;
  }

  private leaveFor(target: { path: string; line: number } | null): void {
    try {
      if (target) sessionStorage.setItem(OPEN_AT, JSON.stringify(target));
      else sessionStorage.removeItem(OPEN_AT);
    } catch {
      // without storage the other space opens without the note
    }
  }

  /** Opens the note the last switch of space asked for. False when there was none to open. */
  async takeOpenAt(): Promise<boolean> {
    let target: { path: string; line: number } | null = null;
    try {
      target = JSON.parse(sessionStorage.getItem(OPEN_AT) ?? "null");
      sessionStorage.removeItem(OPEN_AT);
    } catch {
      target = null;
    }
    return target !== null && (await this.openPath(target.path, target.line));
  }

  // What the "more tasks" box of a task remembers (its last added id, the list, the focus), by the task's id.
  private readonly taskAdds = new Map<string, TaskAdds>();

  // The task panel of the note on screen: the task whose source line is `line` when the panel opens. Later the
  // panel finds the task again by its id, or by its line and text, so it never shows or edits another task.
  private openTask(line: number): boolean {
    const session = this.d.active();
    if (!session) return false;
    const first = this.tasks().find((t) => t.note === session.id && t.line === line);
    if (!first) return false;
    const ref = { note: first.note, block: first.block, line: first.line, text: first.text };
    const find = (): TaskRow | undefined => currentTask(this.d.noteIndex, ref);
    const key = first.block ?? `${first.note}:${first.line}`;
    const adds = this.taskAdds.get(key) ?? { after: null, titles: [], focus: false, busy: false };
    this.taskAdds.set(key, adds);
    this.d.features()?.showTask(async () => {
      const task = find();
      if (!task) return [el("p", "muted", TASK_CHANGED)];
      // a personal space has no organization: no snapshot, no people, groups or history
      const single = !this.isOrganization;
      const snapshot = single ? null : await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot").catch(() => null);
      const body = taskPanelBody(
        task,
        [...new Set([...snapshot?.members.flatMap((member) => member.name ? [member.name] : []) ?? [], ...handlesIn(this.tasks())])].sort((a, b) => a.localeCompare(b, "pl")),
        snapshot?.groups ?? [],
        async (field, value) => {
          const current = find();
          if (!current) throw new Error(TASK_CHANGED);
          await editField(this.edits(), current, field, value);
        },
        (message) => toast(message, true),
        async (titles, assignee) => {
          const current = find();
          if (!current) throw new Error(TASK_CHANGED);
          adds.after = await addTaskLines(this.edits(), current, titles, assignee, adds.after);
        },
        adds,
        async (title) => {
          const current = find();
          if (!current) throw new Error(TASK_CHANGED);
          await addSubtask(this.edits(), current, title);
        },
        single,
      );
      if (single) return body;
      if (snapshot) {
        const assigned = delegator(snapshot.events, task.block);
        body.push(el("p", "task-field", `Przydzielił: ${assigned ? byWhom(snapshot, assigned) : "nieustalony — brak lub konflikt zdarzeń przypisania"}`));
        const assignedGroups = (task.group_ids ?? []).map((id) => snapshot.groups?.find((g) => g.id === id)?.name ?? id);
        if (assignedGroups.length) body.push(el("p", "task-field", `Przypisane grupy: ${assignedGroups.join(", ")}`));
        const events = snapshot.events.filter((e) => e.after.task_id === task.block);
        const details = el("details", "task-audit"); details.append(el("summary", "", `Historia zadania (${events.length})`));
        const labels: Record<string,string> = { TaskAssigned:"Przydzielenie",TaskCompleted:"Ukończenie",TaskReopened:"Wznowienie",TaskDueChanged:"Zmiana terminu",TaskSupervisorChanged:"Zmiana nadzorującego",TaskDifficultyChanged:"Zmiana trudności" };
        for (const event of [...events].reverse()) {
          const entry = historyCard(snapshot.checks?.[event.event_id]);
          const eventGroups = (event.after.groups ?? []).map((id) => snapshot.groups?.find((g) => g.id === id)?.name ?? id);
          entry.append(el("strong", "", labels[event.kind] ?? event.kind), el("p", "muted", `${byWhom(snapshot, event)} · ${new Date(event.time_ms).toLocaleString("pl-PL")}`), el("p", "", `Wykonawcy: ${event.after.assignees.join(", ") || "brak"}${eventGroups.length ? ` · grupy: ${eventGroups.join(", ")}` : ""} · trudność: ${event.after.difficulty ?? "nieoceniona"}`));
          if (event.after.due !== null) entry.append(el("p", "muted", `Termin: ${isoOf(event.after.due)}`));
          details.append(entry);
        }
        body.push(details);
      } else body.push(el("p", "muted", "Historia przypisania jest niedostępna."));
      return body;
    }, session.id);
    return true;
  }

  private edits() {
    return {
      bridge: this.d.bridge,
      openDoc: (noteId: string) => this.d.sessions().find((s) => s.id === noteId)?.doc ?? null,
    };
  }

  /** What this user may do with each project, by its folder (a project without its own folder has nothing to protect). */
  private async protectionOf(projects: ProjectRow[]): Promise<Map<string, ProjectProtection>> {
    const protection = new Map<string, ProjectProtection>();
    await Promise.all(projects.map(async (p) => {
      if (!p.folder) return;
      try { protection.set(p.folder, await this.d.bridge.call<ProjectProtection>("project_protection", { path: p.folder })); }
      catch { /* no buttons for this project */ }
    }));
    return protection;
  }

  // A project nobody restricted (made before projects started private, or by an older app) is open to every member.
  // A device that may manage it closes it: its assigned people and groups, its lead, the owner and the administrators.
  private locking = false;
  private readonly lockTried = new Set<string>();
  private async lockOpenProjects(projects: ProjectRow[], protection: Map<string, ProjectProtection>): Promise<void> {
    const open = projects.filter((p) => p.folder && !this.lockTried.has(p.folder) && protection.get(p.folder)?.manage && !protection.get(p.folder)?.protected);
    if (this.locking || !open.length) return;
    this.locking = true;
    let locked = 0;
    try {
      const snapshot = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
      for (const p of open) {
        this.lockTried.add(p.folder!); // one try per session: a refusal is not retried on every redraw
        // the note's lead is not counted in: it waits for an approval like any other change of people (docs/MCP.md §6)
        const ids = projectViewers(snapshot, p.people ?? [], p.groups ?? [], null, protection.get(p.folder!)!.candidates);
        try { await this.d.bridge.call("project_protect", { path: p.folder, members: ids, editors: ids }); locked++; }
        catch (e) { console.warn(`project ${p.folder} not protected`, e); }
      }
    } finally { this.locking = false; }
    if (locked) {
      toast(`Projekty widoczne dla wszystkich (${locked}) są teraz dostępne tylko dla przypisanych osób, prowadzącego, właściciela i administratorów.`);
      this.render();
    }
  }

  // Protection actions of the projects page and the explorer share one permissions flow (projects.ts).
  private async permissions(path: string): Promise<void> {
    await editPermissions(this.d.bridge, path, () => this.render());
  }

  // Once the project's people and groups are saved, only they, the lead, the owner and the administrators see it.
  // `approveLead`: an owner or admin also appoints the note's `prowadzacy:` as the lead (only on an explicit approval).
  private async restrictProject(path: string, people: string[], groups: string[], lead: string | null, approveLead = false): Promise<void> {
    try {
      const info = await this.d.bridge.call<ProjectProtection>("project_protection", { path });
      if (!info.manage) return;
      const snapshot = await this.d.bridge.call<OrganizationSnapshot>("organization_snapshot");
      // The lead counted in is the appointed one, by id (the signed entry); the note's `prowadzacy:` text only when an owner
      // or admin approves it (docs/MCP.md §6). Names are never trusted for it: two members may share one.
      const textLead = approveLead && info.admin ? lead : null;
      const ready = new Set(info.candidates.filter((c) => c.ready).map((c) => c.userId));
      const withLead = (list: string[]) => [...new Set([...list, ...(info.lead && ready.has(info.lead) && !textLead ? [info.lead] : [])])];
      const ids = withLead(projectViewers(snapshot, people, groups, textLead, info.candidates));
      if (ids.length) {
        const appointed = textLead !== null || (approveLead && info.admin) ? { lead: (textLead && nameLookup(snapshot)(textLead)) || null } : {};
        await this.d.bridge.call(info.protected ? "project_set_members" : "project_protect", { path, members: ids, editors: ids, ...appointed });
        // people whose encryption key this device does not know yet cannot be given the project: say so, never silently
        const all = projectViewers(snapshot, people, groups, textLead, info.candidates.map((c) => ({ ...c, ready: true })));
        const missing = all.filter((id) => !ids.includes(id)).map((id) => snapshot.members.find((m) => m.user_id === id)?.name ?? id);
        if (missing.length) toast(`Nie można jeszcze udostępnić projektu: ${missing.join(", ")} (brak klucza szyfrowania — niech zalogują się raz, potem przypisz ponownie).`, true);
        else toast("Projekt widzą teraz tylko przypisane osoby, właściciel i administratorzy.");
      } else if (info.protected && info.admin) {
        // Nobody assigned any more: opening the project to the whole vault is asked, never implied.
        if (!(await confirmDialog("Nikt nie jest już przypisany. Zdjąć ograniczenie? Projekt zobaczą wszyscy członkowie sejfu.", "Zdejmij ograniczenie"))) return;
        await this.d.bridge.call("project_unprotect", { path });
        toast("Ochrona projektu została zdjęta.");
      }
    } catch (e) {
      toast(errorText(e), true);
    }
  }
  private async unprotectProject(path: string): Promise<void> {
    const ok = await confirmDialog("Zdjąć ochronę? Notatki projektu wrócą do zwykłej przestrzeni i będą widoczne dla wszystkich członków sejfu.", "Zdejmij ochronę");
    if (!ok) return;
    try {
      await this.d.bridge.call("project_unprotect", { path });
      toast("Ochrona projektu została zdjęta.");
      this.render();
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  /** Asks for a name and creates the project note, then opens it. */
  async newProject(): Promise<void> {
    // Projects are the owners' and admins' to make (the bridge refuses the rest too).
    if (this.identity && !canAdminister(this.identity)) return toast(TOP_TEXT, true);
    const asked = await askNewProject(githubService() !== null);
    if (!asked) return;
    const { name, address } = asked;
    try {
      // The creator leads it, and it starts private: only the lead, the owner and the administrators see it until
      // people or groups are assigned (in a shared space; elsewhere there is nothing to protect).
      const made = await createProject(this.d.bridge, name, this.me);
      await indexNewNote(this.d.noteIndex, made.id, projectText(name.trim(), this.me));
      // The folder is protected, not the note: the notes made in it later are in the folder too.
      const folder = made.path.slice(0, made.path.lastIndexOf("/"));
      const info = await this.d.bridge.call<ProjectProtection>("project_protection", { path: folder }).catch(() => null);
      if (info?.manage && !info.protected) await this.d.bridge.call("project_protect", { path: folder, members: [], editors: [], lead: info.self });
      // never silently open: if this device could not make it private while others share the space, say so
      else if (info && !info.protected && info.candidates.length > 1) toast("Nie udało się ograniczyć widoczności projektu — widzą go wszyscy członkowie. Ustaw osoby w „Kto widzi i edytuje”.", true);
      // The explorer reloads only on its own actions and on ui:tree-reload; this note was made outside it.
      emit("ui:tree-reload");
      await this.d.open({ id: made.id, path: made.path });
      // An address typed in the new-project window is connected at once.
      const github = githubService();
      if (address && github) {
        await openConnectDialog(folder, github, address);
        emit("ui:tree-reload");
      }
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  // The connect window of a project; the project's screen is drawn again after it, so the status shows the new link.
  private async connectGithub(folder: string): Promise<void> {
    const github = githubService();
    if (!github) return;
    await openConnectDialog(folder, github);
    emit("ui:tree-reload");
    this.render();
  }

  // The copy of this device's tasks for the other spaces: written a moment after the index changes.
  private scheduleCache(): void {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => void this.writeCache(), CACHE_DELAY_MS);
  }

  private async writeCache(): Promise<void> {
    if (!shouldWriteCache(this.isOrganization, this.me, this.d.noteIndex.tasks() !== null)) return;
    const names = this.myNames();
    const rows = this.tasks().filter((t) => t.assignee_user_ids?.includes(this.identity?.me ?? "") || t.supervisor_user_id === this.identity?.me || mineOf([t], names).length > 0 || supervisedBy([t], names).length > 0);
    try {
      await this.d.bridge.call("save_task_cache", { saved: { updated: isoOf(dayOf(new Date())), me: this.me, names, userId: this.identity?.me, rows } });
    } catch (e) {
      console.warn("task cache not saved", e);
    }
  }
}

/** What a protected project's note asks for that its signed entry lacks: people it adds, and (for an owner or admin) a new
 *  lead. The note is text anyone with edit rights can change, so this waits for a manager's approval (docs/MCP.md §6). */
export function pendingApproval(p: ProjectRow, info: ProjectProtection | undefined, snapshot: OrganizationSnapshot): string | null {
  if (!info?.protected || !info.manage) return null;
  // a name two members share is told apart by the start of the user id, so a look-alike name cannot pass for someone else
  const name = (id: string) => {
    const n = snapshot.members.find((m) => m.user_id === id)?.name || id;
    return snapshot.members.filter((m) => m.name === n).length > 1 ? `${n} (${id.slice(0, 8)})` : n;
  };
  const lead = (p.lead && nameLookup(snapshot)(p.lead)) || null;
  // what the approval writes: the note's people, groups and (for an owner or admin) lead, with the owners, admins and approver
  // the same people as restrictProject writes: the note's lead only for an owner or admin, else the appointed lead
  const textLead = info.admin ? p.lead : null;
  const ready = new Set(info.candidates.filter((c) => c.ready).map((c) => c.userId));
  const viewers = [...new Set([...projectViewers(snapshot, p.people ?? [], p.groups ?? [], textLead, info.candidates), ...(info.lead && ready.has(info.lead) && !textLead ? [info.lead] : [])])];
  const added = viewers.filter((id) => !info.members.includes(id));
  const removed = info.members.filter((id) => !viewers.includes(id) && !info.admins.includes(id) && id !== info.self);
  const parts = [
    added.length ? `dochodzą: ${added.map(name).join(", ")}` : "",
    removed.length ? `odchodzą: ${removed.map(name).join(", ")}` : "",
    info.admin && lead !== info.lead ? `prowadzący: ${lead ? name(lead) : "brak"}` : "",
  ].filter(Boolean);
  return parts.length ? `Notatka projektu zmienia osoby (${parts.join("; ")}). Bez zatwierdzenia nic się nie zmienia.` : null;
}

