//! "Moje zadania": the tasks of the open space and the copies of the other organization spaces, grouped by due date.
//! Rows of a copy are read-only: their checkbox is disabled and "Otwórz" switches to that space.

import { el } from "./dom";
import { type Group, GROUPS, type TaskRow, byDue, dueState, groupOf, parseDay, sameHandle, shortDate } from "./orgtasks";

export type Tab = "mine" | "supervised";

export interface CachedSpace {
  name: string;
  path: string;
  updated: string;
  // the handle this device had in that space when the copy was made: the copy is filtered by it
  me: string;
  // every name the user went by there (see namesOf); copies made before aliases existed have only `me`
  names?: string[];
  userId?: string;
  rows: TaskRow[];
}

// A row of the view: a task of the open space (cached null), or a copy from another space.
export interface ViewRow {
  row: TaskRow;
  cached: { space: string; path: string; updated: string } | null;
}

export interface MyTasksData {
  me: string;
  names?: string[];
  userId?: string;
  today: number;
  live: TaskRow[];
  cached: CachedSpace[];
  // A personal space: every task is one person's own, so no tabs, no copies and no handle.
  single?: boolean;
}

export interface ViewState {
  tab: Tab;
  done: boolean;
}

export interface MyTasksActions {
  setState(state: ViewState): void;
  toggle(view: ViewRow, done: boolean): void;
  open(view: ViewRow): void;
  due?(view: ViewRow, value: string | null): void;
}

// Whether the row belongs to the tab: the tasks the user is assigned, or the ones they supervise.
function inTab(row: TaskRow, tab: Tab, names: readonly string[], userId?: string): boolean {
  if (userId && tab === "mine" && row.assignee_user_ids?.length) return row.assignee_user_ids.includes(userId);
  if (userId && tab === "supervised" && row.supervisor_user_id) return row.supervisor_user_id === userId;
  return tab === "mine" ? row.assignees.some((a) => names.some((n) => sameHandle(a, n))) : names.some((n) => sameHandle(row.supervisor, n));
}

/** The rows the view shows for a tab and a status, live ones first. Each copy is filtered by its own handle. */
export function viewRows(data: MyTasksData, state: ViewState): ViewRow[] {
  const live = data.live.filter((row) => data.single || inTab(row, state.tab, data.names ?? [data.me], data.userId)).map((row) => ({ row, cached: null }));
  const copies = data.single ? [] : data.cached.flatMap((space) =>
    space.rows
      .filter((row) => inTab(row, state.tab, space.names ?? [space.me], space.userId))
      .map((row) => ({ row, cached: { space: space.name, path: space.path, updated: space.updated } })),
  );
  return [...live, ...copies].filter((v) => v.row.done === state.done);
}

/** How many open tasks a tab has, for its label. */
export function openCount(data: MyTasksData, tab: Tab): number {
  return viewRows(data, { tab, done: false }).length;
}

/** The rows of each group, in the order of GROUPS. Groups without rows are kept. */
export function groupViewRows(rows: ViewRow[], today: number): Map<Group, ViewRow[]> {
  const groups = new Map<Group, ViewRow[]>(GROUPS.map((g) => [g, []]));
  const sorted = [...rows].sort((a, b) => byDue(a.row, b.row));
  for (const v of sorted) groups.get(groupOf(v.row.due, today))!.push(v);
  return groups;
}

/** The meta chips of a row: deadline, supervisor and difficulty, as the design shows them. */
export function metaOf(row: TaskRow, today: number): { label: string; cls: string }[] {
  const out: { label: string; cls: string }[] = [{ label: row.project, cls: "task-meta-project" }];
  if (row.due !== null) out.push({ label: `📅 ${shortDate(row.due)}`, cls: `task-due task-due-${dueState(row.due, today)}` });
  if (row.supervisor) out.push({ label: `nadzór: ${row.supervisor}`, cls: "task-meta-sup" });
  out.push({ label: row.difficulty === null ? "nieocenione" : `${row.difficulty}/10`, cls: "task-meta-diff" });
  return out;
}

export function renderMyTasks(host: HTMLElement, data: MyTasksData, state: ViewState, actions: MyTasksActions): void {
  const head = el("header", "org-view-head");
  head.append(
    el("h2", "", "Zadania"),
    el("p", "muted", data.single ? "Zadania z Twoich notatek. Zmiany trafiają do notatki źródłowej." : "Ze wszystkich przestrzeni, do których masz dostęp. Zmiany trafiają do notatki źródłowej."),
  );
  host.replaceChildren(head);
  if (!data.me && !data.single) {
    host.append(el("p", "org-hint", "Ustaw nazwę wyświetlaną w ustawieniach konta, aby rozpoznawać swoje zadania. Kopie z innych przestrzeni są widoczne."));
  }

  const tabs = el("div", "org-tabs");
  for (const [tab, label] of [["mine", "Moje"], ["supervised", "Nadzorowane przeze mnie"]] as const) {
    const b = el("button", "org-tab", `${label} · ${openCount(data, tab)}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.tab === tab));
    b.addEventListener("click", () => actions.setState({ ...state, tab }));
    tabs.append(b);
  }
  const status = el("div", "org-tabs");
  for (const [done, label] of [[false, "Otwarte"], [true, "Wykonane"]] as const) {
    const b = el("button", "org-chip-btn", label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.done === done));
    b.addEventListener("click", () => actions.setState({ ...state, done }));
    status.append(b);
  }
  host.append(...(data.single ? [] : [tabs]), status);

  const groups = groupViewRows(viewRows(data, state), data.today);
  let shown = 0;
  for (const [group, rows] of groups) {
    if (rows.length === 0) continue;
    shown += rows.length;
    const section = el("section", "org-group");
    section.append(el("h3", "", `${group} · ${rows.length}`));
    const list = el("ul", "org-rows");
    for (const v of rows) list.append(rowItem(v, data.today, actions));
    section.append(list);
    host.append(section);
  }
  if (shown === 0) host.append(el("p", "org-hint", "Nie ma tu zadań."));
}

function rowItem(v: ViewRow, today: number, actions: MyTasksActions): HTMLElement {
  const li = el("li", v.cached ? "org-row is-cached" : "org-row");
  const box = el("input", "");
  box.type = "checkbox";
  box.checked = v.row.done;
  box.disabled = v.cached !== null && !v.row.block;
  box.setAttribute("aria-label", `Oznacz jako wykonane: ${v.row.text}`);
  box.addEventListener("change", () => actions.toggle(v, box.checked));
  const title = el("button", "org-row-title", v.row.text);
  title.type = "button";
  title.addEventListener("click", () => actions.open(v));
  const meta = el("span", "org-row-meta");
  for (const m of metaOf(v.row, today)) meta.append(el("span", m.cls, m.label));
  li.append(box, title, meta);
  if (actions.due) {
    const due = el("input", "task-input"); due.type = "date";
    due.value = v.row.due === null ? "" : new Date(v.row.due * 86400000).toISOString().slice(0, 10);
    due.setAttribute("aria-label", `Termin: ${v.row.text}`); due.disabled = v.cached !== null && !v.row.block;
    due.addEventListener("change", () => actions.due?.(v, due.value || null)); li.append(due);
  }
  if (v.cached) {
    const day = parseDay(v.cached.updated);
    const label = el("span", "org-stale", `${v.cached.space} · stan z ${day === null ? v.cached.updated : shortDate(day)}`);
    const open = el("button", "org-open-btn", "Otwórz");
    open.type = "button";
    open.addEventListener("click", () => actions.open(v));
    li.append(label, open);
  }
  return li;
}

