// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DAY_MS, type ProjectRow, type TaskRow, chipsOf } from "./orgtasks";
import { GROUP_COLORS, type Group, type TaskEvent } from "./taskhistory";
import { departmentLookup, kanbanBoard, kanbanColumns, renderProjectPage, summaryCounts, timelineRows } from "./projectpage";
import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

const TODAY = 100;
const row = (text: string, extra: Partial<TaskRow> = {}) =>
  ({ text, path: "P/a.md", line: 1, done: false, due: null, done_on: null, assignees: ["Ala"], group_ids: [], block: null, ...extra }) as TaskRow;
// local noon of a day number, so the local calendar day the page reads is that day
const noonOf = (day: number) => {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).getTime();
};
const event = (task_id: string, day: number): TaskEvent =>
  ({ kind: "edit", time_ms: noonOf(day), after: { task_id } }) as unknown as TaskEvent;
const project = { note: "P", path: "P/P.md", name: "Pierwszy", folder: null, status: "w toku", lead: "Ala", people: ["Ala"], groups: ["g1"] } as ProjectRow;

describe("kanban columns", () => {
  it("sorts each open task into one column and puts done tasks in Zrobione", () => {
    const tasks = [
      row("nikt", { assignees: [] }),
      row("grupa", { assignees: [], group_ids: ["g1"] }),
      row("zaległe", { due: 90 }),
      row("plan", { due: 105 }),
      row("bez terminu"),
      row("gotowe", { done: true, due: 80 }),
    ];
    const cols = kanbanColumns(tasks, TODAY);
    expect(cols.map((c) => c.title)).toEqual(["Nieprzypisane", "Do zrobienia", "Po terminie", "Zrobione"]);
    const texts = cols.map((c) => c.tasks.map((t) => t.text).sort());
    expect(texts).toEqual([["nikt"], ["bez terminu", "grupa", "plan"], ["zaległe"], ["gotowe"]]);
  });
});

describe("summary counts", () => {
  it("counts open, overdue, this week, unassigned and done tasks", () => {
    const tasks = [row("a", { due: 90 }), row("b", { due: 103 }), row("c", { due: 150, assignees: [] }), row("d", { done: true })];
    expect(summaryCounts(tasks, TODAY)).toEqual([
      ["Wszystkie", 4],
      ["Otwarte", 3],
      ["Po terminie", 1],
      ["Na ten tydzień", 1],
      ["Bez przypisania", 1],
      ["Zrobione", 1],
    ]);
  });
});

describe("timeline rows", () => {
  it("starts at the first event, ends at done day or due, and leaves undated tasks out", () => {
    const tasks = [
      row("z zdarzeniem", { block: "t1", due: 104 }),
      row("zrobione", { block: "t2", done: true, done_on: 99 }),
      row("bez dat", { block: "t3" }),
      row("tylko termin", { due: 95 }),
    ];
    const events = [event("t1", 98), event("t1", 97), event("t2", 96)];
    const rows = timelineRows(tasks, events, TODAY);
    expect(rows.map((r) => [r.task.text, r.start, r.end, r.state])).toEqual([
      ["tylko termin", 95, 95, "overdue"],
      ["zrobione", 96, 99, "done"],
      ["z zdarzeniem", 97, 104, "open"],
    ]);
  });
});

describe("project page", () => {
  const base = { today: TODAY, project, events: [] as TaskEvent[], groups: [{ id: "g1", name: "Zespół", member_ids: [] }] as never };
  const actions = () => ({ back: vi.fn(), openNote: vi.fn(), open: vi.fn(), toggleDone: vi.fn() });

  it("shows a hint for a project without tasks", () => {
    const host = document.createElement("div");
    renderProjectPage(host, { ...base, tasks: [] }, actions());
    expect(host.textContent).toContain("Ten projekt nie ma jeszcze zadań. Dodaj je w notatce projektu.");
  });

  it("toggles a task from its button and from a drop on Zrobione, not on the open columns", () => {
    const host = document.createElement("div");
    const a = actions();
    const open = row("otwarte", { line: 2 });
    const done = row("zrobione", { line: 3, done: true });
    renderProjectPage(host, { ...base, tasks: [open, done] }, a);
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Zrobione ✓")!;
    button.click();
    expect(a.toggleDone).toHaveBeenCalledWith(open);

    const drop = (column: string, key: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => key } });
      host.querySelector<HTMLElement>(`[data-column="${column}"]`)!.dispatchEvent(event);
    };
    drop("todo", "P/a.md:2");
    expect(a.toggleDone).toHaveBeenCalledTimes(1);
    drop("done", "P/a.md:2");
    expect(a.toggleDone).toHaveBeenLastCalledWith(open);
    drop("todo", "P/a.md:3");
    expect(a.toggleDone).toHaveBeenLastCalledWith(done);
  });
});

describe("project menu", () => {
  const data = { today: TODAY, project, tasks: [row("zadanie", { due: 105 })], events: [], groups: [] };
  const plain = () => ({ back: vi.fn(), openNote: vi.fn(), open: vi.fn(), toggleDone: vi.fn() });
  const more = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Więcej");

  it("has no menu without a GitHub service", () => {
    const host = document.createElement("div");
    renderProjectPage(host, data, plain());
    expect(more(host)).toBeUndefined();
  });

  it("offers the GitHub connection in the menu", () => {
    const connectGithub = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    renderProjectPage(host, data, { ...plain(), connectGithub });
    more(host)!.click();
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Połącz z GitHubem…");
    entry!.click();
    expect(connectGithub).toHaveBeenCalledOnce();
    document.body.replaceChildren();
  });
});

describe("board note columns", () => {
  const NAMES = ["Pomysły", "W toku", "Gotowe"];
  const card = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLElement>('[role="listitem"]')].find((c) => c.textContent?.includes(text))!;
  const drop = (column: HTMLElement, key: string) => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => key } });
    column.dispatchEvent(event);
  };

  it("draws the named columns, each card where its token says", () => {
    const tasks = [row("szkic", { stage: "W toku", line: 1 }), row("nowe", { line: 2 }), row("gotowe", { done: true, line: 3, stage: "Pomysły" })];
    const host = document.createElement("div");
    host.append(kanbanBoard(tasks, TODAY, { open: vi.fn(), toggleDone: vi.fn() }, NAMES));
    const columns = [...host.querySelectorAll<HTMLElement>("[data-column]")];
    expect(columns.map((c) => c.querySelector("h4")?.textContent)).toEqual(["Pomysły 1", "W toku 1", "Gotowe 1 ✓"]);
    expect(columns[0].querySelector('[role="list"]')?.getAttribute("aria-label")).toBe("Pomysły");
    expect(columns[1].textContent).toContain("szkic");
    expect(columns[2].textContent).toContain("gotowe");
  });

  it("moves a dropped card to its column and Alt+arrows move it one column", () => {
    const move = vi.fn();
    const tasks = [row("szkic", { stage: "W toku", line: 1 })];
    const host = document.createElement("div");
    host.append(kanbanBoard(tasks, TODAY, { open: vi.fn(), toggleDone: vi.fn(), move }, NAMES));
    const columns = [...host.querySelectorAll<HTMLElement>("[data-column]")];
    drop(columns[2], "P/a.md:1");
    expect(move).toHaveBeenLastCalledWith(tasks[0], 2);
    card(host, "szkic").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
    expect(move).toHaveBeenLastCalledWith(tasks[0], 0);
    // no column beyond the last one
    card(host, "szkic").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
    expect(move).toHaveBeenLastCalledWith(tasks[0], 2);
    expect(move).toHaveBeenCalledTimes(3);
  });

  it("adds a task from the field of a column on Enter, and cancels on Escape", () => {
    const add = vi.fn();
    const host = document.createElement("div");
    host.append(kanbanBoard([], TODAY, { open: vi.fn(), toggleDone: vi.fn(), add }, NAMES));
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "+ Dodaj zadanie");
    buttons()[0].click();
    const input = host.querySelector<HTMLInputElement>(".kanban-add-input")!;
    input.value = "Plan @Jan";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(add).toHaveBeenCalledWith(0, "Plan @Jan");
    // the middle column's field, cancelled with Escape, gives its button back
    buttons()[1].click();
    expect(host.querySelectorAll(".kanban-add-input")).toHaveLength(2);
    host.querySelectorAll<HTMLInputElement>(".kanban-add-input")[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelectorAll(".kanban-add-input")).toHaveLength(1);
    expect(buttons()).toHaveLength(2);
  });

  it("names the stage in the chip of a line", () => {
    expect(chipsOf("- [ ] Plan !etap:W_toku", TODAY).map((c) => [c.kind, c.label])).toEqual([["stage", "etap: W toku"]]);
  });
});

describe("department colours on cards", () => {
  const [key] = Object.keys(GROUP_COLORS);
  const groups = [{ id: "g1", name: "Sprzedaż", member_ids: ["u1"], color: key }] as Group[];
  const members = [{ user_id: "u1", name: "Ala", role: "member" }, { user_id: "u2", name: "Bartek", role: "member" }];
  const chipOf = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLElement>(".group-chip")].find((c) => c.textContent === name)!;
  const board = (department?: ReturnType<typeof departmentLookup>) => {
    const host = document.createElement("div");
    const tasks = [row("zadanie", { assignees: ["Ala", "Bartek"] })];
    host.append(kanbanBoard(tasks, TODAY, { open: vi.fn(), toggleDone: vi.fn(), department }));
    return host;
  };

  it("colours a member's chip by their group and names the group in the title", () => {
    const host = board(departmentLookup(groups, members));
    const ala = chipOf(host, "Ala");
    expect(ala.classList.contains("colored")).toBe(true);
    expect(ala.style.getPropertyValue("--group-color")).toBe(GROUP_COLORS[key].hex);
    expect(ala.title).toBe("Ala — Sprzedaż");
  });

  it("leaves a person outside every coloured group with a plain chip", () => {
    const host = board(departmentLookup(groups, members));
    const bartek = chipOf(host, "Bartek");
    expect(bartek.classList.contains("colored")).toBe(false);
    expect(bartek.style.getPropertyValue("--group-color")).toBe("");
    expect(bartek.title).toBe("");
  });

  it("draws plain chips without a lookup", () => {
    const host = board();
    expect(host.querySelector(".colored")).toBeNull();
    expect(chipOf(host, "Ala").title).toBe("");
  });
});
