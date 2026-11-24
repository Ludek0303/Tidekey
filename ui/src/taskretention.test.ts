import { beforeAll, describe, expect, it } from "vitest";
import { parseDay, type TaskRow } from "./orgtasks";
import { cutoffDay, expired, removeTasks, retentionMonths, trustedRetention } from "./taskretention";
import type { ModuleData } from "./records";
import type { OrganizationSnapshot } from "./taskhistory";
import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

const OLD = parseDay("2025-05-01");
function row(over: Partial<TaskRow>): TaskRow {
  return {
    note: "n", path: "Zadania.md", line: 1, depth: 0, done: true, text: "Zadanie", assignees: [], supervisor: null,
    difficulty: null, due: null, done_on: null, priority: null, block: null, project: "", project_note: null, ...over,
  };
}

const data = (months: unknown, actor: string, status?: "ok" | "unverified"): ModuleData => ({
  records: { "org-settings": { id: "org-settings", kind: "settings", task_retention_months: months } },
  revisions: {}, markdown: {}, empty_revision: "none",
  operations: [{ event_id: "e1", actor_user_id: actor, time_ms: 1, record: { before: null, after: { id: "org-settings", kind: "settings" } } }],
  checks: status ? { e1: { status, reason: "" } } : undefined,
});
const org: OrganizationSnapshot = {
  me: "admin", owner: "admin", space_id: "s", verified: true, events: [], fields: {},
  members: [{ user_id: "admin", name: "A", role: "Owner" }, { user_id: "ed", name: "E", role: "Editor" }],
};

describe("task retention", () => {
  it("counts back whole months from today", () => {
    expect(cutoffDay(new Date(2026, 9, 29), 12)).toBe(parseDay("2025-10-29"));
    expect(cutoffDay(new Date(2026, 9, 29), 3)).toBe(parseDay("2026-07-29"));
  });

  it("acts only on a setting an administrator saved, and never on a bad value", () => {
    expect(trustedRetention(data(12, "admin"), org)).toBe(12);
    expect(trustedRetention(data(12, "ed"), org)).toBe(0);
    expect(trustedRetention(data(12, "admin", "unverified"), org)).toBe(0);
    expect(retentionMonths(data(500, "admin"))).toBe(0);
    expect(retentionMonths(data("x", "admin"))).toBe(0);
  });

  it("picks done tasks finished before the cutoff, never open ones or ones without a date", () => {
    const cut = parseDay("2026-01-01")!;
    const rows = [
      row({ block: "z-a", done_on: parseDay("2025-05-01") }),
      row({ block: "z-b", done_on: parseDay("2026-03-01") }),
      row({ block: "z-c", done: false, done_on: parseDay("2025-05-01") }),
      row({ block: "z-d", done_on: null }),
    ];
    expect([...expired(rows, cut).get("n")!].map((r) => r.block)).toEqual(["z-a"]);
  });

  it("removes the lines, and keeps a task that still has lines under it", () => {
    const text = [
      "# Zadania",
      "- [x] Stare ✅ 2025-05-01 ^z-a",
      "- [x] Rodzic ✅ 2025-05-01 ^z-p",
      "  - [ ] Otwarte dziecko ^z-k",
      "- [ ] Otwarte ^z-o",
    ].join("\n");
    const rows = [row({ block: "z-a", text: "Stare", line: 2, done_on: OLD }), row({ block: "z-p", text: "Rodzic", line: 3, done_on: OLD })];
    expect(removeTasks(text, rows)).toBe(["# Zadania", "- [x] Rodzic ✅ 2025-05-01 ^z-p", "  - [ ] Otwarte dziecko ^z-k", "- [ ] Otwarte ^z-o"].join("\n"));
  });

  it("removes a done parent together with its done children", () => {
    const text = ["- [x] Rodzic ✅ 2025-05-01 ^z-p", "  - [x] Dziecko ✅ 2025-05-01 ^z-k", "- [ ] Inne ^z-o"].join("\n");
    const rows = [row({ block: "z-p", text: "Rodzic", line: 1, done_on: OLD }), row({ block: "z-k", text: "Dziecko", line: 2, depth: 1, done_on: OLD })];
    expect(removeTasks(text, rows)).toBe("- [ ] Inne ^z-o");
  });
});
