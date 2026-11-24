//! Projekty: the organization's projects at a glance — the tasks due soonest, the ones starred important, and every
//! project with its progress and the people and groups assigned to it (in the project note's front matter).

import type { ProjectProtection } from "./bridge";
import { el } from "./dom";
import { card, taskList, type OverviewActions } from "./overview";
import { type ProjectRow, type TaskRow, dueState, shortDate } from "./orgtasks";
import { fromGroupsText, groupLines, peopleAndGroupsFields } from "./projects";
import type { Group, Member } from "./taskhistory";
import { openDialog } from "./widgets";

const SOON_DAYS = 7;
const TOP = 12;

export interface ProjectsData {
  today: number;
  live: TaskRow[];
  projects: ProjectRow[];
  /** The organization's members by name and its groups, to assign and to show. */
  people: string[];
  groups: Group[];
  /** The organization's members with their names, to name the people of each group. */
  members?: Member[];
  /** What this user may do with each project, by its folder; a project without an entry has no protection buttons. */
  protection?: Map<string, ProjectProtection>;
  /** May this user assign people and groups to `project`? (an administrator, or the project's lead) */
  canAssign(project: ProjectRow): boolean;
  /** May this user make a new project? Absent or true shows the button; an editor in a shared vault gets none. */
  canCreate?: boolean;
  /** What the project note asks for and the signed entry does not have yet (people added, a new lead): a manager approves it. null: nothing pending. */
  pending?(project: ProjectRow): string | null;
}

export interface ProjectsActions extends OverviewActions {
  assign(project: ProjectRow, people: string[], groups: string[]): Promise<void>;
  /** Applies the project note's people, groups (and, for an owner or admin, its lead) to the protected project. */
  approve(project: ProjectRow): void;
  /** Opens the project's own screen (projectpage.ts). */
  openProject(project: ProjectRow): void;
  /** The protection actions, by the project's folder (projects.ts). */
  protect(path: string): void;
  members(path: string): void;
  unprotect(path: string): void;
}

const byDue = (a: TaskRow, b: TaskRow) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.text.localeCompare(b.text, "pl");

/** Open tasks due within the next week, the overdue ones first. */
export function dueSoon(rows: TaskRow[], today: number): TaskRow[] {
  return rows.filter((r) => !r.done && r.due !== null && r.due <= today + SOON_DAYS).sort(byDue);
}

/** Open tasks starred important (⭐, or ⏫ from the Obsidian Tasks plugin). */
export function important(rows: TaskRow[]): TaskRow[] {
  return rows.filter((r) => !r.done && r.priority === "high").sort(byDue);
}

/** The protection buttons of a project, by what this user may do with it (see ProjectProtection). */
function protectionButtons(path: string, info: ProjectProtection, actions: ProjectsActions): HTMLElement[] {
  const entries: [string, () => void][] = [];
  if (info.manage && !info.protected) entries.push(["Chroń projekt", () => actions.protect(path)]);
  if (info.protected && info.member && info.manage) entries.push(["Członkowie projektu", () => actions.members(path)]);
  if (info.protected && info.admin) entries.push(["Zdejmij ochronę", () => actions.unprotect(path)]);
  return entries.map(([label, run]) => {
    const button = el("button", "btn", label);
    button.type = "button";
    button.addEventListener("click", run);
    return button;
  });
}

function chips(names: string[], empty: string): HTMLElement {
  const box = el("div", "project-chips");
  if (!names.length) box.append(el("span", "muted", empty));
  for (const name of names) box.append(el("span", "group-chip", name));
  return box;
}

export function renderProjectsPage(host: HTMLElement, data: ProjectsData, actions: ProjectsActions): void {
  const head = el("header", "org-view-head");
  const add = el("button", "btn firstrun-primary", "Nowy projekt");
  add.type = "button";
  add.addEventListener("click", () => actions.newProject());
  add.hidden = data.canCreate === false;
  const row = el("div", "org-actions");
  row.append(add);
  head.append(el("p", "eyebrow", "PROJEKTY ORGANIZACJI"), el("h2", "", "Projekty"), row);
  host.replaceChildren(head);

  const top = el("div", "org-cards");
  const soon = card("Najbliższe terminy");
  const soonRows = dueSoon(data.live, data.today);
  soon.body.append(soonRows.length ? taskList(soonRows.slice(0, TOP), data.today, actions) : el("p", "org-hint", "Brak zadań na najbliższy tydzień."));
  const star = card("Ważne ★");
  const starRows = important(data.live);
  star.body.append(starRows.length ? taskList(starRows.slice(0, TOP), data.today, actions) : el("p", "org-hint", "Brak zadań oznaczonych gwiazdką. Gwiazdkę dodasz w panelu zadania."));
  top.append(soon.box, star.box);
  host.append(top);

  const grid = el("div", "project-grid");
  if (!data.projects.length) grid.append(el("p", "org-hint", "Nie ma jeszcze projektów."));
  for (const p of data.projects) {
    const inside = data.live.filter((r) => r.project_note === p.note);
    const done = inside.filter((r) => r.done).length;
    const percent = inside.length ? Math.round((done / inside.length) * 100) : 0;
    const next = inside.filter((r) => !r.done && r.due !== null).sort(byDue)[0];
    const box = el("article", "project-card");
    const name = el("button", "org-row-title project-card-name", p.name);
    name.type = "button";
    name.addEventListener("click", () => actions.openProject(p));
    const note = el("button", "btn", "Notatka");
    note.type = "button";
    note.addEventListener("click", () => actions.open(p.path));
    const info = p.folder ? data.protection?.get(p.folder) : undefined;
    const meta = [p.status, p.lead ? `prowadzi: ${p.lead}` : ""].filter(Boolean).join(" · ");
    const bar = el("div", "org-progress");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Postęp projektu ${p.name}`);
    bar.setAttribute("aria-valuenow", String(percent));
    const fill = el("div", "org-progress-bar");
    fill.style.width = `${percent}%`;
    bar.append(fill);
    box.append(name, el("p", "org-row-meta", meta || "—"), bar, el("p", "org-row-meta", `${done} z ${inside.length} wykonane`), note);
    if (info && p.folder) box.append(...protectionButtons(p.folder, info, actions));
    const pending = data.pending?.(p);
    if (pending) {
      const approval = el("div", "project-pending");
      approval.setAttribute("role", "status");
      const approve = el("button", "btn", "Zatwierdź");
      approve.type = "button";
      approve.addEventListener("click", () => actions.approve(p));
      approval.append(el("strong", "", "Zmiana osób projektu w notatce: zatwierdź"), el("p", "muted", pending), approve);
      box.append(approval);
    }
    if (next) {
      const line = el("p", "project-next");
      line.append(el("span", "muted", "Najbliższe: "), document.createTextNode(next.text + " "), el("span", `task-due task-due-${dueState(next.due!, data.today)}`, `📅 ${shortDate(next.due!)}`));
      box.append(line);
    }
    box.append(el("h4", "", "Osoby"), chips(p.people ?? [], "Nikt nie jest przypisany"));
    box.append(el("h4", "", "Grupy"), chips(groupLines(data.groups, p.groups ?? [], data.members), "Brak grup"));
    if (data.canAssign(p)) {
      const assign = el("button", "btn", "Przypisz osoby i grupy");
      assign.type = "button";
      assign.addEventListener("click", () => assignDialog(p, data, actions));
      box.append(assign);
    }
    grid.append(box);
  }
  host.append(el("h3", "people-section-title", "Wszystkie projekty"), grid);
}

function assignDialog(project: ProjectRow, data: ProjectsData, actions: ProjectsActions): void {
  openDialog({
    label: `Przypisz do projektu ${project.name}`,
    className: "modal-confirm",
    render(box, close) {
      const members = data.members ?? [];
      const nameOf = new Map(members.flatMap((m) => (m.name ? [[m.user_id, m.name] as [string, string]] : [])));
      const userOf = new Map(members.flatMap((m) => (m.name ? [[m.name, m.user_id] as [string, string]] : [])));
      // Only people picked by hand are saved; a group's members are saved through the group.
      const manual = new Set((project.people ?? []).map((n) => userOf.get(n) ?? n));
      const { list, groupList, people, groups, error } = peopleAndGroupsFields({
        people: data.people,
        addRow(list, name) {
          const row = el("label", "project-member");
          const input = el("input");
          input.type = "checkbox";
          input.value = name;
          const text = el("span", "", name);
          row.append(input, text);
          list.append(row);
          return { userId: userOf.get(name) ?? name, name, input, text };
        },
        groups: data.groups,
        nameOf,
        checked: project.groups ?? [],
        manual,
        show: (row, from) => {
          row.text.textContent = [row.name, fromGroupsText(from)].filter(Boolean).join(" ");
        },
        emptyPeople: "Brak.",
        emptyGroups: "Brak.",
      });
      const row = el("div", "modal-actions");
      const cancel = el("button", "btn", "Anuluj");
      cancel.type = "button";
      cancel.addEventListener("click", () => close());
      const save = el("button", "btn btn-primary", "Zapisz");
      save.type = "button";
      save.addEventListener("click", () => {
        save.disabled = true;
        const picked = people.filter((p) => manual.has(p.userId)).map((p) => p.name);
        const chosen = groups.filter((g) => g.input.checked).map((g) => g.group.id);
        actions.assign(project, picked, chosen).then(close, (e: unknown) => {
          error.textContent = e instanceof Error ? e.message : String(e);
          save.disabled = false;
        });
      });
      row.append(cancel, save);
      box.append(el("h2", "", project.name), list, groupList, error, row);
    },
  });
}
