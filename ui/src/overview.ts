//! Przegląd: the organization's overview. Every number comes from the index rows (`overview` in orgtasks.ts).

import { el } from "./dom";
import { type ProjectRow, type TaskRow, dueState, overview, shortDate } from "./orgtasks";

export interface OverviewData {
  space: string;
  me: string;
  // every name of the user (see namesOf); `me` alone when absent
  names?: string[];
  // the current name of a person a task names (see currentNameOf)
  displayName?: (name: string) => string;
  today: number;
  live: TaskRow[];
  projects: ProjectRow[];
  // May this user make a new project? Absent or true shows the button (see ProjectsData.canCreate).
  canCreate?: boolean;
  now: Date;
}

export interface OverviewActions {
  open(path: string, line?: number): void;
  tasks(): void;
  newProject(): void;
}

export function card(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el("section", "org-card");
  const body = el("div", "org-card-body");
  box.append(el("h3", "", title), body);
  return { box, body };
}

function taskLine(task: TaskRow, today: number, actions: OverviewActions): HTMLElement {
  const li = el("li", "org-card-row");
  const title = el("button", "org-row-title", task.text);
  title.type = "button";
  title.addEventListener("click", () => actions.open(task.path, task.line));
  li.append(title, el("span", "org-row-meta", task.project));
  if (task.due !== null) li.append(el("span", `task-due task-due-${dueState(task.due, today)}`, `📅 ${shortDate(task.due)}`));
  return li;
}

export function taskList(tasks: TaskRow[], today: number, actions: OverviewActions): HTMLElement {
  const list = el("ul", "org-card-list");
  list.append(...tasks.map((t) => taskLine(t, today, actions)));
  return list;
}

export function renderOverview(host: HTMLElement, data: OverviewData, actions: OverviewActions): void {
  const model = overview(data.live, data.projects, data.names ?? data.me, data.today, data.displayName);
  const head = el("header", "org-view-head overview-head");
  const actionsRow = el("div", "org-actions");
  const tasks = el("button", "btn", "Moje zadania");
  tasks.type = "button";
  tasks.addEventListener("click", () => actions.tasks());
  const project = el("button", "btn firstrun-primary", "Nowy projekt");
  project.type = "button";
  project.addEventListener("click", () => actions.newProject());
  project.hidden = data.canCreate === false;
  actionsRow.append(tasks, project);
  const day = data.now.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });
  head.append(el("p", "eyebrow", day), el("h2", "", `${data.space} — przegląd`), actionsRow);
  host.replaceChildren(head);

  const grid = el("div", "org-cards overview-grid");
  const mine = card("Moje zadania");
  if (!data.me) mine.body.append(el("p", "org-hint", "Ustaw nazwę wyświetlaną w ustawieniach konta, aby rozpoznawać swoje zadania."));
  else if (model.mine.length === 0) mine.body.append(el("p", "org-hint", "Nie masz otwartych zadań."));
  else mine.body.append(taskList(model.mine, data.today, actions));

  const projects = card("Projekty");
  if (model.projects.length === 0) projects.body.append(el("p", "org-hint", "Nie ma jeszcze projektów."));
  for (const p of model.projects) {
    const item = el("div", "org-project");
    const name = el("button", "org-row-title", p.name);
    name.type = "button";
    name.addEventListener("click", () => actions.open(p.path));
    const bar = el("div", "org-progress");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Postęp projektu ${p.name}`);
    bar.setAttribute("aria-valuenow", String(p.percent));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const fill = el("div", "org-progress-bar");
    fill.style.width = `${p.percent}%`;
    bar.append(fill);
    item.append(name, el("span", "org-row-meta", `${p.done} z ${p.done + p.open} wykonane`), bar);
    projects.body.append(item);
  }

  const upcoming = card("Najbliższe terminy");
  if (model.upcoming.length === 0) upcoming.body.append(el("p", "org-hint", "Brak terminów."));
  else upcoming.body.append(taskList(model.upcoming, data.today, actions));

  const starred = card("Ważne ★");
  const starRows = data.live.filter((t) => !t.done && t.priority === "high").sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
  starred.body.append(starRows.length ? taskList(starRows.slice(0, 5), data.today, actions) : el("p", "org-hint", "Brak zadań oznaczonych gwiazdką."));

  const load = card("Obciążenie zespołu");
  if (model.load.length === 0) load.body.append(el("p", "org-hint", "Nikt nie ma otwartych zadań."));
  else {
    const table = el("table", "org-load");
    const head = el("tr");
    head.append(el("th", "", "Osoba"), el("th", "", "Otwarte"), el("th", "", "Trudność"));
    table.append(head);
    for (const row of model.load) {
      const tr = el("tr");
      // an unrated task adds no difficulty: it is counted apart, on a line of its own under the number
      const difficulty = el("td");
      difficulty.append(String(row.difficulty));
      if (row.unrated > 0) difficulty.append(el("span", "org-unrated", `+${row.unrated} nieocenione`));
      tr.append(el("td", "", row.name), el("td", "", String(row.open)), difficulty);
      table.append(tr);
    }
    load.body.append(table);
  }
  grid.append(mine.box, projects.box, upcoming.box, starred.box, load.box);
  host.append(grid);
}
