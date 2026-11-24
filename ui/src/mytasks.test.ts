// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type CachedSpace, type MyTasksData, groupViewRows, renderMyTasks, viewRows } from "./mytasks";
import { parseDay, type TaskRow } from "./orgtasks";

const TODAY = parseDay("2026-10-25")!;

function row(over: Partial<TaskRow>): TaskRow {
  return {
    note: "n", path: "Projekty/Triton/Triton.md", line: 1, depth: 0, done: false, text: "Zadanie", assignees: [],
    supervisor: null, difficulty: null, due: null, done_on: null, priority: null, block: null,
    project: "Sonda", project_note: "p", ...over,
  };
}

const live: TaskRow[] = [
  row({ note: "a", line: 16, text: "Przygotować schemat", assignees: ["Jan"], supervisor: "Stanisław", due: TODAY + 11, difficulty: 8 }),
  row({ note: "b", line: 15, text: "Uzupełnić protokół", assignees: ["Stanisław"], supervisor: "Jan", due: TODAY - 1, difficulty: 2 }),
  row({ note: "c", line: 17, text: "Opisać interfejs", assignees: ["Piotr"], supervisor: "Jan" }),
  row({ note: "d", line: 14, text: "Ustalić zakres", assignees: ["Jan"], done: true, due: TODAY }),
];
const copies: CachedSpace[] = [
  { name: "Autopilot", path: "/spaces/autopilot", updated: "2026-10-22", me: "Jan", rows: [row({ note: "x", line: 3, text: "Moduł telemetrii", assignees: ["Jan"], due: TODAY + 3 })] },
];
const data: MyTasksData = { me: "Jan", today: TODAY, live, cached: copies };

describe("viewRows", () => {
  it("shows my open tasks and the copies of other spaces on the Moje tab", () => {
    const texts = viewRows(data, { tab: "mine", done: false }).map((v) => v.row.text);
    expect(texts).toEqual(["Przygotować schemat", "Moduł telemetrii"]);
  });

  it("shows the tasks I supervise on the Nadzorowane tab, and done ones on the Wykonane filter", () => {
    expect(viewRows(data, { tab: "supervised", done: false }).map((v) => v.row.text)).toEqual(["Uzupełnić protokół", "Opisać interfejs"]);
    expect(viewRows(data, { tab: "mine", done: true }).map((v) => v.row.text)).toEqual(["Ustalić zakres"]);
  });

  it("marks the rows of a copy as read-only and keeps where they came from", () => {
    const copy = viewRows(data, { tab: "mine", done: false }).find((v) => v.cached !== null)!;
    expect(copy.cached).toEqual({ space: "Autopilot", path: "/spaces/autopilot", updated: "2026-10-22" });
  });
});

describe("groupViewRows", () => {
  it("groups by due date in the order of the design, undated last", () => {
    const groups = groupViewRows(viewRows(data, { tab: "mine", done: false }), TODAY);
    expect([...groups.keys()]).toEqual(["Zaległe", "Dziś", "Najbliższe 7 dni", "Później", "Bez terminu"]);
    expect(groups.get("Najbliższe 7 dni")!.map((v) => v.row.text)).toEqual(["Moduł telemetrii"]);
    expect(groups.get("Później")!.map((v) => v.row.text)).toEqual(["Przygotować schemat"]);
    expect(groups.get("Bez terminu")!).toHaveLength(0);
  });
});

describe("renderMyTasks", () => {
  function render(state = { tab: "mine" as const, done: false }, d = data) {
    const host = document.createElement("div");
    const actions = { setState: vi.fn(), toggle: vi.fn(), open: vi.fn() };
    renderMyTasks(host, d, state, actions);
    return { host, actions };
  }

  it("disables the checkbox of a copy and offers Otwórz for it", () => {
    const { host, actions } = render();
    const copy = [...host.querySelectorAll<HTMLLIElement>(".org-row.is-cached")][0];
    expect((copy.querySelector("input[type=checkbox]") as HTMLInputElement).disabled).toBe(true);
    expect(copy.textContent).toContain("Autopilot · stan z 22 paź");
    (copy.querySelector(".org-open-btn") as HTMLButtonElement).click();
    expect(actions.open).toHaveBeenCalledTimes(1);
  });

  it("ticks a live task through the actions", () => {
    const { host, actions } = render();
    const live = host.querySelector<HTMLLIElement>(".org-row:not(.is-cached)")!;
    const box = live.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(box.disabled).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(actions.toggle).toHaveBeenCalledWith(expect.objectContaining({ cached: null }), true);
  });

  it("asks for the handle when none is set", () => {
    const { host } = render(undefined, { ...data, me: "" });
    expect(host.textContent).toContain("Ustaw nazwę wyświetlaną w ustawieniach konta");
  });
});

describe("each copy is filtered by the handle it was made with", () => {
  const copy = (me: string): CachedSpace => ({
    name: "Autopilot", path: "/spaces/autopilot", updated: "2026-10-22", me,
    rows: [row({ note: "x", line: 3, text: "Moduł telemetrii", assignees: ["JK"], due: TODAY + 3 })],
  });

  it("shows JK's task from a space where JK is the handle, though the open space has Jan", () => {
    const rows = viewRows({ ...data, cached: [copy("JK")] }, { tab: "mine", done: false });
    expect(rows.map((v) => v.row.text)).toContain("Moduł telemetrii");
  });

  it("hides a copy's task that is not assigned to the copy's own handle", () => {
    const rows = viewRows({ ...data, cached: [copy("Jan")] }, { tab: "mine", done: false });
    expect(rows.map((v) => v.row.text)).not.toContain("Moduł telemetrii");
  });

  it("shows the copies even when the open space has no handle", () => {
    const rows = viewRows({ ...data, me: "", cached: [copy("JK")] }, { tab: "mine", done: false });
    expect(rows.map((v) => v.row.text)).toEqual(["Moduł telemetrii"]);
    const host = document.createElement("div");
    renderMyTasks(host, { ...data, me: "", cached: [copy("JK")] }, { tab: "mine", done: false }, { setState: vi.fn(), toggle: vi.fn(), open: vi.fn() });
    expect(host.textContent).toContain("Moduł telemetrii");
    expect(host.textContent).toContain("Ustaw nazwę wyświetlaną w ustawieniach konta");
  });
});

describe("the Moje and Nadzorowane tabs are pressed buttons", () => {
  it("marks the tab on screen with aria-pressed, and has no tab roles without panels", () => {
    const host = document.createElement("div");
    renderMyTasks(host, data, { tab: "supervised", done: false }, { setState: vi.fn(), toggle: vi.fn(), open: vi.fn() });
    expect(host.querySelector('[role="tab"]')).toBeNull();
    const pressed = [...host.querySelectorAll("button.org-tab")].filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain("Nadzorowane");
  });
});

describe("Zadania in a personal space: one person, no copies", () => {
  const own: MyTasksData = {
    me: "", today: TODAY, cached: [], single: true,
    live: [
      row({ note: "e", line: 2, text: "Kupić mleko", due: TODAY }),
      row({ note: "f", line: 3, text: "Plan", assignees: ["Piotr"], supervisor: "Jan" }),
    ],
  };

  it("lists every open task of the space, whoever it names, on any tab", () => {
    expect(viewRows(own, { tab: "supervised", done: false }).map((v) => v.row.text)).toEqual(["Kupić mleko", "Plan"]);
    expect(viewRows(own, { tab: "mine", done: false }).map((v) => v.row.text)).toEqual(["Kupić mleko", "Plan"]);
  });

  it("has no Moje or Nadzorowane tabs, no handle hint, and the notatki header", () => {
    const host = document.createElement("div");
    renderMyTasks(host, own, { tab: "mine", done: false }, { setState: vi.fn(), toggle: vi.fn(), open: vi.fn() });
    expect(host.querySelector("button.org-tab")).toBeNull();
    expect(host.textContent).not.toContain("Nadzorowane");
    expect(host.textContent).not.toContain("Ustaw nazwę wyświetlaną");
    expect(host.textContent).toContain("Zadania z Twoich notatek. Zmiany trafiają do notatki źródłowej.");
    expect(host.textContent).toContain("Kupić mleko");
  });
});
