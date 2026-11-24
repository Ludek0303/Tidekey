// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderOverview } from "./overview";
import { type TaskRow, parseDay } from "./orgtasks";

const TODAY = parseDay("2026-10-25")!;
const row = (over: Partial<TaskRow>): TaskRow => ({
  note: "p", path: "Projekty/Triton/Triton.md", line: 1, depth: 0, done: false, text: "Zadanie", assignees: ["Piotr"],
  supervisor: null, difficulty: null, due: null, done_on: null, priority: null, block: null, project: "Triton",
  project_note: "p", ...over,
});
const actions = { open: vi.fn(), tasks: vi.fn(), newProject: vi.fn() };

describe("Przegląd", () => {
  it("counts an unrated task apart from the difficulty", () => {
    const host = document.createElement("div");
    renderOverview(host, { space: "Przykładowa organizacja", me: "Jan", today: TODAY, live: [row({ difficulty: null })], projects: [], now: new Date(2026, 9, 25) }, actions);
    const cells = [...host.querySelectorAll("td")];
    const difficulty = cells[cells.length - 1];
    expect(difficulty.firstChild?.textContent).toBe("0");
    expect(difficulty.querySelector(".org-unrated")?.textContent).toBe("+1 nieocenione");
  });

  it("marks the head and the card grid so the overview styles stay scoped to it", () => {
    const host = document.createElement("div");
    renderOverview(host, { space: "Przykładowa organizacja", me: "Jan", today: TODAY, live: [], projects: [], now: new Date(2026, 9, 25) }, actions);
    expect(host.querySelector(".overview-head")).not.toBeNull();
    expect(host.querySelector(".overview-grid > .org-card:first-child h3")?.textContent).toBe("Moje zadania");
  });

  it("gives each project's progress bar a name", () => {
    const host = document.createElement("div");
    const projects = [{ note: "p", path: "Projekty/Triton/Triton.md", name: "Triton", folder: "Projekty/Triton", status: "aktywny", lead: null }];
    renderOverview(host, { space: "Przykładowa organizacja", me: "Jan", today: TODAY, live: [row({ done: true }), row({})], projects, now: new Date(2026, 9, 25) }, actions);
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Postęp projektu Triton");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
  });
});
