//! Projekt: one project's own screen. A summary of its tasks, a kanban board of them and the timeline of each task from
//! its first event to its end. Everything is computed from the project's task rows (orgtasks.ts) and the organization's
//! events (taskhistory.ts); the page changes a task only through `toggleDone`. Styles: projectpage.css.

import { el } from "./dom";
import { card, taskList, type OverviewActions } from "./overview";
import { type ProjectRow, type TaskRow, byDue, dayOf, dueState, shortDate } from "./orgtasks";
import { groupLines } from "./projects";
import { type BoardNote, addTask, columnIndex, columnsOf, folderOf, folderTasks, moveTask, openColumnsDialog, saveColumns } from "./kanban";
import type { TaskEdits } from "./orgedit";
import { errorText, openMenu, toast } from "./widgets";
import { GROUP_COLORS, type Group, type Member, type TaskEvent, orderedGroups, validGroupColor } from "./taskhistory";

const SOON_DAYS = 7;
const NEXT = 5;

export interface ProjectPageData {
  today: number;
  project: ProjectRow;
  /** The project's tasks: the rows whose `project_note` is the project's note. */
  tasks: TaskRow[];
  /** The organization's events; a task's timeline starts at the first event that names it (`after.task_id`). */
  events: TaskEvent[];
  groups: Group[];
  /** The organization's members with their names, to name the people of each group. */
  members?: Member[];
  /** The columns of the project folder's board note, in order. Without them the page shows its four fixed columns. */
  columns?: string[];
}

export interface ProjectPageActions {
  back(): void;
  openNote(path: string): void;
  open(task: TaskRow): void;
  toggleDone(task: TaskRow): void;
  /** The project menu's GitHub entry; absent where no GitHub service is open, and then the menu is not drawn. */
  connectGithub?(): void;
}

/**
 * What a card of the board does: its title opens the task, its button changes the done state. On a board note with its
 * own columns, a drop (or Alt+arrows) moves the card to column `column`, and "+ Dodaj zadanie" adds one there.
 */
export interface BoardActions extends Pick<ProjectPageActions, "open" | "toggleDone"> {
  move?(task: TaskRow, column: number): void;
  add?(column: number, title: string): void;
  /** The department of a person named on a card; without it the chips keep the default look. */
  department?: DepartmentOf;
}

/** A person's department as a card chip shows it: the colour of the group and the group's name. */
export interface Department {
  hex: string;
  group: string;
}
export type DepartmentOf = (name: string) => Department | undefined;

/** The department of the member a name stands for: the first active coloured group they are in (as personColor decides). */
export function departmentLookup(groups: Group[], members: Member[]): DepartmentOf {
  return (name) => {
    const id = members.find((m) => m.name === name)?.user_id;
    if (!id) return undefined;
    for (const g of orderedGroups(groups)) {
      const color = validGroupColor(g.color);
      if (color && !g.archived && g.member_ids.includes(id)) return { hex: GROUP_COLORS[color].hex, group: g.name };
    }
    return undefined;
  };
}

export type KanbanKey = "unassigned" | "todo" | "overdue" | "done";
export interface KanbanColumn {
  key: KanbanKey;
  title: string;
  tasks: TaskRow[];
}

export interface TimelineRow {
  task: TaskRow;
  /** Days since 1970-01-01. */
  start: number;
  end: number;
  state: "done" | "overdue" | "open";
}

const STATE_LABEL: Record<TimelineRow["state"], string> = { done: "zrobione", overdue: "po terminie", open: "otwarte" };
const taskKey = (t: TaskRow) => `${t.path}:${t.line}`;
const isUnassigned = (t: TaskRow) => t.assignees.length === 0 && (t.group_ids ?? []).length === 0;
const isOverdue = (t: TaskRow, today: number) => !t.done && t.due !== null && t.due < today;

/** The four columns in board order. Each open task sits in exactly one: unassigned tasks first, then overdue ones. */
export function kanbanColumns(tasks: TaskRow[], today: number): KanbanColumn[] {
  const keyOf = (t: TaskRow): KanbanKey => (t.done ? "done" : isUnassigned(t) ? "unassigned" : isOverdue(t, today) ? "overdue" : "todo");
  const titles: [KanbanKey, string][] = [
    ["unassigned", "Nieprzypisane"],
    ["todo", "Do zrobienia"],
    ["overdue", "Po terminie"],
    ["done", "Zrobione"],
  ];
  return titles.map(([key, title]) => ({ key, title, tasks: tasks.filter((t) => keyOf(t) === key).sort(byDue) }));
}

/** The counts of the summary, in the order the page shows them. */
export function summaryCounts(tasks: TaskRow[], today: number): [string, number][] {
  const open = tasks.filter((t) => !t.done);
  return [
    ["Wszystkie", tasks.length],
    ["Otwarte", open.length],
    ["Po terminie", open.filter((t) => isOverdue(t, today)).length],
    ["Na ten tydzień", open.filter((t) => t.due !== null && t.due >= today && t.due <= today + SOON_DAYS).length],
    ["Bez przypisania", open.filter(isUnassigned).length],
    ["Zrobione", tasks.length - open.length],
  ];
}

/**
 * One bar per dated task, earliest start first. start = the day of the task's first event, else its due or done day;
 * end = its done day (done), else its due day, else today. Tasks with no date at all are left out.
 */
export function timelineRows(tasks: TaskRow[], events: TaskEvent[], today: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const task of tasks) {
    const own = task.block ? events.filter((e) => e.after.task_id === task.block) : [];
    const first = own.length ? dayOf(new Date(Math.min(...own.map((e) => e.time_ms)))) : null;
    const start = first ?? task.due ?? task.done_on;
    if (start === null) continue;
    const end = Math.max(start, (task.done ? task.done_on : null) ?? task.due ?? today);
    const state = task.done ? "done" : isOverdue(task, today) ? "overdue" : "open";
    rows.push({ task, start, end, state });
  }
  return rows.sort((a, b) => a.start - b.start || a.task.text.localeCompare(b.task.text, "pl"));
}

function chips(names: string[], empty: string): HTMLElement {
  const box = el("div", "project-chips");
  if (!names.length) box.append(el("span", "muted", empty));
  for (const name of names) box.append(el("span", "group-chip", name));
  return box;
}

export function renderProjectPage(host: HTMLElement, data: ProjectPageData, actions: ProjectPageActions): void {
  const { project, tasks, today } = data;
  const done = tasks.filter((t) => t.done).length;
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const back = el("button", "btn", "← Wszystkie projekty");
  back.type = "button";
  back.addEventListener("click", () => actions.back());
  const note = el("button", "btn", "Otwórz notatkę projektu");
  note.type = "button";
  note.addEventListener("click", () => actions.openNote(project.path));
  const bar = el("div", "org-progress");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", `Postęp projektu ${project.name}`);
  bar.setAttribute("aria-valuenow", String(percent));
  const fill = el("div", "org-progress-bar");
  fill.style.width = `${percent}%`;
  bar.append(fill);
  const meta = [project.status, project.lead ? `prowadzi: ${project.lead}` : ""].filter(Boolean).join(" · ");
  const buttons = el("div", "org-actions");
  buttons.append(back, note);
  if (actions.connectGithub) {
    const connect = actions.connectGithub;
    const more = el("button", "btn", "Więcej");
    more.type = "button";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [{ label: "Połącz z GitHubem…", icon: "link", run: connect }]);
    });
    buttons.append(more);
  }
  const head = el("header", "org-view-head project-head");
  head.append(
    el("p", "eyebrow", "PROJEKT"),
    el("h2", "", project.name),
    el("p", "org-row-meta", meta || "—"),
    chips(project.people ?? [], "Nikt nie jest przypisany"),
    chips(groupLines(data.groups, project.groups ?? [], data.members), "Brak grup"),
    bar,
    el("p", "org-row-meta", `${done} z ${tasks.length} wykonane`),
    buttons,
  );
  host.replaceChildren(head);

  if (tasks.length === 0) {
    host.append(el("p", "org-hint", "Ten projekt nie ma jeszcze zadań. Dodaj je w notatce projektu."));
    return;
  }

  // Rows open the task in its note; the shared task list hands back the row by its path and line.
  const navigate: OverviewActions = {
    open: (path, line) => {
      const task = tasks.find((t) => t.path === path && t.line === line);
      if (task) actions.open(task);
    },
    tasks: () => {},
    newProject: () => {},
  };

  const summary = card("Podsumowanie");
  const stats = el("dl", "project-stats");
  for (const [label, value] of summaryCounts(tasks, today)) {
    const cell = el("div", "project-stat");
    cell.append(el("dt", "", label), el("dd", "", String(value)));
    stats.append(cell);
  }
  const next = tasks.filter((t) => !t.done).sort(byDue).slice(0, NEXT);
  summary.body.append(stats, el("h4", "", "Najbliższe zadania"), next.length ? taskList(next, today, navigate) : el("p", "org-hint", "Brak otwartych zadań."));

  const board = el("section", "project-section");
  board.append(el("h3", "", "Tablica"), kanbanBoard(tasks, today, { ...actions, department: departmentLookup(data.groups, data.members ?? []) }, data.columns));

  const timeline = el("section", "project-section");
  timeline.append(el("h3", "", "Przebieg zadań"));
  const rows = timelineRows(tasks, data.events, today);
  timeline.append(rows.length ? ganttChart(rows, today, actions) : el("p", "org-hint", "Zadania nie mają jeszcze dat."));
  const dated = new Set(rows.map((r) => r.task));
  const undated = tasks.filter((t) => !dated.has(t));
  if (undated.length) timeline.append(el("h4", "", "Bez dat"), taskList(undated, today, navigate));

  host.append(el("div", "org-cards project-summary"), board, timeline);
  host.querySelector(".project-summary")!.append(summary.box);
}

/**
 * The board of `tasks`: the four fixed columns, or the named `columns` of a board note (a card sits where its `!etap:`
 * says, see kanban.ts). The same drawing for both; a drop changes what the column's rule says and nothing else.
 */
export function kanbanBoard(tasks: TaskRow[], today: number, actions: BoardActions, columns?: string[]): HTMLElement {
  const kanban = el("div", columns ? "project-kanban kanban-board" : "project-kanban");
  const cols = columns
    ? columns.map((title, i) => ({ key: String(i), title, tasks: tasks.filter((t) => columnIndex(t, columns) === i).sort(byDue) }))
    : kanbanColumns(tasks, today);
  cols.forEach((column, i) => {
    const col = el("section", "project-col");
    col.dataset.column = column.key;
    // Dropping a card on this column: a board note moves it there; the project's fixed columns only change the done state.
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("is-drop");
    });
    col.addEventListener("dragleave", () => col.classList.remove("is-drop"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("is-drop");
      const key = e.dataTransfer?.getData("text/plain");
      const task = tasks.find((t) => taskKey(t) === key);
      if (!task) return;
      if (columns) actions.move?.(task, i);
      else if ((column.key === "done") !== task.done) actions.toggleDone(task);
    });
    const list = el("div", "project-col-list");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", column.title);
    const step = columns
      ? (task: TaskRow) => (delta: number) => {
          if (i + delta >= 0 && i + delta < columns.length) actions.move?.(task, i + delta);
        }
      : undefined;
    for (const task of column.tasks) list.append(kanbanCard(task, today, actions, step?.(task)));
    if (columns) {
      const head = el("h4", "");
      head.append(column.title, " ", el("span", "kanban-count", String(column.tasks.length)));
      if (i === cols.length - 1) head.append(el("span", "kanban-done-mark", " ✓"));
      col.append(head, list);
      if (!column.tasks.length) col.append(el("p", "kanban-empty", "Przeciągnij tu zadanie albo dodaj nowe."));
      if (actions.add) col.append(addField(column.title, (title) => actions.add?.(i, title)));
    } else {
      col.append(el("h4", "", `${column.title} (${column.tasks.length})`));
      if (!column.tasks.length) list.append(el("p", "muted", "Brak zadań."));
      col.append(list);
    }
    kanban.append(col);
  });
  return kanban;
}

/** "+ Dodaj zadanie": a button that turns into a text field; Enter adds the task, an empty Enter or Escape cancels. */
function addField(column: string, add: (title: string) => void): HTMLElement {
  const box = el("div", "kanban-add");
  const button = el("button", "btn", "+ Dodaj zadanie");
  button.type = "button";
  button.addEventListener("click", () => {
    const input = el("input", "kanban-add-input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "Tytuł, np. Plan @Jan 📅 2026-11-30";
    input.setAttribute("aria-label", `Nowe zadanie w kolumnie ${column}`);
    const cancel = () => box.replaceChildren(button);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter") {
        e.preventDefault();
        const title = input.value.trim();
        if (title) add(title);
        else cancel();
      }
    });
    box.replaceChildren(input);
    input.focus();
  });
  box.append(button);
  return box;
}

export interface KanbanActions {
  /** The edits of the board's notes: the open documents or the bridge. */
  edits: TaskEdits;
  /** Opens the note of a task at its line. */
  openPath(path: string, line: number): void;
  /** Changes a task's done state in its note; the board is drawn again once this resolves. */
  toggleTask(task: TaskRow): Promise<void>;
  /** Refreshes the index for the notes an edit changed. */
  changed(ids: string[]): Promise<void>;
  /** The department of a person on a card (main.ts, from the organization); absent outside an organization. */
  department?: DepartmentOf;
}

/**
 * The kanban note's screen: the board of the tasks under the note's folder, in its columns. `read` gives the board
 * note as it is now (null when none is open), `tasks` the index rows; both are read again after each change.
 */
export function renderKanban(host: HTMLElement, read: () => BoardNote | null, tasks: () => TaskRow[], actions: KanbanActions): void {
  const board = read();
  if (!board) return;
  const again = () => renderKanban(host, read, tasks, actions);
  // A failed edit is told, and the board is drawn as it is now; a done edit redraws it from the index.
  const run = (job: Promise<string[]>) => void job.then(actions.changed).then(again, (e: unknown) => { toast(errorText(e), true); again(); });
  const mine = folderTasks(tasks(), folderOf(board.path));
  const names = columnsOf(board.text);
  const today = dayOf(new Date());
  const done = mine.filter((t) => t.done).length;
  const columns = el("button", "btn kanban-columns-btn", "Kolumny…");
  columns.type = "button";
  columns.addEventListener("click", () => openColumnsDialog(board, mine, (changes) => run(saveColumns(actions.edits, board, mine, changes))));
  const head = el("header", "org-view-head project-head kanban-head");
  const title = el("div", "kanban-title");
  title.append(
    el("p", "eyebrow", "TABLICA"),
    el("h2", "", folderOf(board.path).slice(folderOf(board.path).lastIndexOf("/") + 1) || "Cała przestrzeń"),
    el("p", "org-row-meta", `${done} z ${mine.length} wykonane`),
  );
  head.append(title, columns);
  host.replaceChildren(head);
  host.append(
    kanbanBoard(
      mine,
      today,
      {
        open: (task) => actions.openPath(task.path, task.line),
        toggleDone: (task) => void actions.toggleTask(task).then(again, (e: unknown) => { toast(errorText(e), true); again(); }),
        move: (task, column) => run(moveTask(actions.edits, task, names, column, today)),
        add: (column, title) => run(addTask(actions.edits, board, title, names, column)),
        department: actions.department,
      },
      names,
    ),
  );
}

// A person's chip on a card: in their department's colour, with the department in the title when there is one.
function personChip(name: string, dept: Department | undefined): HTMLElement {
  const chip = el("span", "group-chip", name);
  if (dept) {
    chip.classList.add("colored");
    chip.style.setProperty("--group-color", dept.hex);
    chip.title = `${name} — ${dept.group}`;
  }
  return chip;
}

function kanbanCard(task: TaskRow, today: number, actions: BoardActions, step?: (delta: number) => void): HTMLElement {
  const box = el("article", "project-task");
  box.draggable = true;
  box.tabIndex = 0;
  box.setAttribute("role", "listitem");
  box.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("text/plain", taskKey(task));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  // Alt+← and Alt+→ move the card one column, as a drop does
  box.addEventListener("keydown", (e) => {
    if (!step || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    step(e.key === "ArrowLeft" ? -1 : 1);
  });
  const title = el("button", "project-task-title", task.text);
  title.type = "button";
  title.addEventListener("click", () => actions.open(task));
  const meta = el("div", "project-chips");
  for (const name of task.assignees) meta.append(personChip(name, actions.department?.(name)));
  if (task.due !== null) meta.append(el("span", `task-due task-due-${dueState(task.due, today)}`, `📅 ${shortDate(task.due)}`));
  const toggle = el("button", "btn", task.done ? "Wznów" : "Zrobione ✓");
  toggle.type = "button";
  toggle.addEventListener("click", () => actions.toggleDone(task));
  box.append(title, meta, toggle);
  return box;
}

function ganttChart(rows: TimelineRow[], today: number, actions: ProjectPageActions): HTMLElement {
  const lo = Math.min(today, ...rows.map((r) => r.start));
  const hi = Math.max(today, ...rows.map((r) => r.end));
  const span = hi - lo + 1;
  const pct = (day: number) => ((day - lo) / span) * 100;
  const todayAt = `${pct(today) + 50 / span}%`;

  const chart = el("div", "project-gantt");
  const axis = el("div", "project-gantt-axis");
  const scale = el("div", "project-gantt-scale");
  const tick = (day: number, text: string, cls: string) => {
    const t = el("span", `project-gantt-tick ${cls}`, text);
    t.style.left = `${pct(day) + (cls === "today" ? 50 / span : 0)}%`;
    return t;
  };
  scale.append(tick(lo, shortDate(lo), "start"), tick(hi, shortDate(hi), "end"), tick(today, "dziś", "today"));
  axis.append(el("span", "project-gantt-spacer"), scale);

  const list = el("ol", "project-gantt-rows");
  for (const row of rows) {
    const item = el("li", "project-gantt-row");
    const label = el("button", "project-gantt-label", row.task.text);
    label.type = "button";
    label.addEventListener("click", () => actions.open(row.task));
    const track = el("div", "project-gantt-track");
    const bar = el("div", `project-gantt-bar project-bar-${row.state}`);
    bar.style.left = `${pct(row.start)}%`;
    bar.style.width = `${((row.end - row.start + 1) / span) * 100}%`;
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${STATE_LABEL[row.state]}: ${shortDate(row.start)} – ${shortDate(row.end)}`);
    const line = el("div", "project-gantt-today");
    line.style.left = todayAt;
    track.append(bar, line);
    item.append(label, track);
    list.append(item);
  }
  chart.append(axis, list);
  return chart;
}
