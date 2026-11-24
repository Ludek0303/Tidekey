import { describe, expect, it } from "vitest";
import type { TaskRow } from "./orgtasks";
import { activityReport, presetRange, reportFileName } from "./activityreport";
import type { OrganizationSnapshot, TaskEvent } from "./taskhistory";

const ZONE = "Europe/Warsaw";
const at = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h - 1); // 12:00 Warsaw in November

const row = (block: string, over: Partial<TaskRow> = {}): TaskRow => ({
  note: "n", path: "Projekty/Zadania.md", line: 1, depth: 0, done: true, text: block, assignees: [], supervisor: null,
  difficulty: null, due: null, done_on: null, priority: null, block, project: "", project_note: null, ...over,
});

function event(id: string, kind: string, block: string, title: string, time: number, over: { who?: string; due?: number | null } = {}): TaskEvent {
  const who = over.who ?? "bartek";
  return {
    event_id: id, note_id: "n", device: "d", actor_user_id: "anna", time_ms: time, kind, before: null,
    after: {
      task_id: block, title, assignees: [who], groups: [], supervisor: null, difficulty: 2, due: over.due ?? null,
      done: kind === "TaskCompleted", completed_on: null, people: { [who]: who },
    },
  };
}

const snapshot = (events: TaskEvent[]): OrganizationSnapshot => ({
  me: "anna", owner: "anna", space_id: "s", verified: true, fields: {}, events,
  members: [{ user_id: "anna", name: "Anna", role: "Owner" }, { user_id: "bartek", name: "Bartek Łuczak", role: "Member" }],
});

const base = { organization: "Zespół · Lublin", person: "bartek", generatedAt: new Date(Date.UTC(2026, 10, 14, 9, 0)), zone: ZONE };

describe("the person's activity report", () => {
  it("groups the events by day in chronological order and skips days without any", () => {
    const tasks = [row("z-1", { text: "Faktura" }), row("z-2"), row("z-3")];
    const events = [
      event("bartek:3", "TaskCompleted", "z-2", "Umowa", at(2026, 11, 4)),
      event("bartek:1", "TaskCompleted", "z-1", "Faktura", at(2026, 11, 2, 9)),
      event("bartek:2", "TaskAssigned", "z-3", "Raport", at(2026, 11, 2, 15)),
    ];
    const text = activityReport(snapshot(events), tasks, { ...base, from: "2026-11-01", to: "2026-11-07" });
    expect(text).toBe([
      "# Raport aktywności: Bartek Łuczak",
      "Organizacja: Zespół · Lublin · Okres: 2026-11-01 – 2026-11-07 · Wygenerowano: 14 lis 2026, 10:00",
      "",
      "## Podsumowanie",
      "- Zrobione: 2 (punkty trudności: 4, nieocenione: 0)",
      "- Przypisane: 1",
      "- Zmiany terminu: 0",
      "- Ponownie otwarte: 0",
      "",
      "## poniedziałek, 2 listopada 2026",
      "- ✅ Zrobione: Faktura (Zadania)",
      "- 📌 Przypisano: Raport",
      "",
      "## środa, 4 listopada 2026",
      "- ✅ Zrobione: Umowa (Zadania)",
      "",
    ].join("\n"));
  });

  it("counts a day from its boundary in local time, both ends inclusive", () => {
    const tasks = [row("z-1"), row("z-2")];
    // 23:30 UTC on 31 Oct is 00:30 on 1 Nov in Warsaw; 23:30 UTC on 1 Nov is 00:30 on 2 Nov.
    const events = [
      event("bartek:1", "TaskCompleted", "z-1", "Start", Date.UTC(2026, 9, 31, 23, 30)),
      event("bartek:2", "TaskCompleted", "z-2", "Koniec", Date.UTC(2026, 10, 1, 23, 30)),
    ];
    const one = (from: string, to: string) => activityReport(snapshot(events), tasks, { ...base, from, to });
    expect(one("2026-11-01", "2026-11-01")).toContain("Start");
    expect(one("2026-11-01", "2026-11-01")).not.toContain("Koniec");
    expect(one("2026-11-02", "2026-11-02")).toContain("Koniec");
    expect(one("2026-11-02", "2026-11-02")).not.toContain("Start");
  });

  it("an empty range says so and lists no day", () => {
    const text = activityReport(snapshot([]), [], { ...base, from: "2026-11-01", to: "2026-11-07" });
    expect(text).toContain("Brak aktywności w tym okresie.");
    expect(text.match(/^## /gm)).toEqual(["## "]);
  });

  it("leaves out the events of other people", () => {
    const tasks = [row("z-1")];
    const events = [event("anna:1", "TaskCompleted", "z-1", "Cudza", at(2026, 11, 2), { who: "anna" })];
    expect(activityReport(snapshot(events), tasks, { ...base, from: "2026-11-01", to: "2026-11-07" })).not.toContain("Cudza");
  });

  it("keeps a title with line breaks on one line", () => {
    const tasks = [row("z-1")];
    const events = [event("bartek:1", "TaskCompleted", "z-1", "Pierwsza\r\nDruga\nTrzecia", at(2026, 11, 2))];
    const lines = activityReport(snapshot(events), tasks, { ...base, from: "2026-11-01", to: "2026-11-07" }).split("\n");
    expect(lines).toContain("- ✅ Zrobione: Pierwsza Druga Trzecia (Zadania)");
  });
});

describe("the report's file name and ranges", () => {
  it("folds Polish letters to ASCII and turns spaces into dashes", () => {
    expect(reportFileName("Łukasz Żółć", "2026-11-01", "2026-11-07")).toBe("raport-lukasz-zolc-2026-11-01-2026-11-07.md");
    expect(reportFileName("  ", "2026-11-01", "2026-11-07")).toBe("raport-osoba-2026-11-01-2026-11-07.md");
  });

  it("gives the quick ranges as whole local days", () => {
    const wed = new Date(2026, 10, 4, 15); // Wednesday 4 Nov 2026
    expect(presetRange("last7", wed)).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(presetRange("week", wed)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(presetRange("month", wed)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(presetRange("lastMonth", wed)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});
