import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseDay, reminderTimes, runTaskReminders, setTaskField, type TaskRow } from "./orgtasks";

import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

afterEach(() => {
  vi.useRealTimers();
});

const LINE = "- [ ] Schemat @Jan 📅 2026-11-05 ^z-7f3a";
const MIN = 60_000;
const nine = (day: number, hour = 9) => {
  const d = new Date(day * 86_400_000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour).getTime();
};

function row(over: Partial<TaskRow>): TaskRow {
  return {
    note: "n", path: "Projekty/Triton/Triton.md", line: 1, depth: 0, done: false, text: "Schemat", assignees: ["Jan"],
    supervisor: null, difficulty: null, due: parseDay("2026-11-05"), done_on: null, priority: null, block: "z-7f3a",
    project: "Triton", project_note: "p", reminder: { before_min: 1440, every_min: null, count: 1 }, ...over,
  };
}

describe("setTaskField reminder", () => {
  it("writes the token after the other tokens and before the id", () => {
    expect(setTaskField(LINE, "reminder", "2h/30mx3")).toBe("- [ ] Schemat @Jan 📅 2026-11-05 !przypomnij:2h/30mx3 ^z-7f3a");
  });

  it("replaces an earlier reminder and removes it on null", () => {
    const line = "- [ ] Schemat @Jan !przypomnij:1d ^z-7f3a";
    expect(setTaskField(line, "reminder", "3h")).toBe("- [ ] Schemat @Jan !przypomnij:3h ^z-7f3a");
    expect(setTaskField(line, "reminder", null)).toBe("- [ ] Schemat @Jan ^z-7f3a");
  });

  it("refuses a value the core would not read", () => {
    for (const bad of ["0d", "1000m", "2h/30mx21", "1 d", "1w"]) {
      expect(() => setTaskField(LINE, "reminder", bad), bad).toThrow();
    }
  });
});

describe("reminderTimes", () => {
  it("is 09:00 local of the due day, less the lead time, then every gap for count times", () => {
    const due = parseDay("2026-11-05")!;
    expect(reminderTimes(row({}))).toEqual([nine(due) - 1440 * MIN]);
    expect(reminderTimes(row({ reminder: { before_min: 120, every_min: 30, count: 3 } }))).toEqual([
      nine(due) - 120 * MIN,
      nine(due) - 90 * MIN,
      nine(due) - 60 * MIN,
    ]);
  });

  it("has no times without a due date or a reminder", () => {
    expect(reminderTimes(row({ due: null }))).toEqual([]);
    expect(reminderTimes(row({ reminder: null }))).toEqual([]);
  });
});

describe("runTaskReminders", () => {
  const due = parseDay("2026-11-05")!;
  const runAt = (now: number, rows: TaskRow[], shown = new Map<string, number>()) => {
    const out: string[] = [];
    runTaskReminders(rows, (r) => r.assignees.includes("Jan"), now, (b) => shown.get(b) ?? -Infinity, (r) => {
      shown.set(r.key, r.at);
      out.push(`${r.key}@${r.at}`);
    });
    return out;
  };

  it("shows a due reminder once, when its time has come", () => {
    vi.useFakeTimers();
    vi.setSystemTime(nine(due) - 1440 * MIN - 1);
    const rows = [row({})];
    const shown = new Map<string, number>();
    expect(runAt(Date.now(), rows, shown)).toEqual([]);
    vi.setSystemTime(nine(due) - 1440 * MIN);
    expect(runAt(Date.now(), rows, shown)).toEqual([`z-7f3a@${nine(due) - 1440 * MIN}`]);
    vi.advanceTimersByTime(60_000);
    expect(runAt(Date.now(), rows, shown)).toEqual([]);
  });

  it("does not show a reminder that passed more than a day ago", () => {
    const at = nine(due) - 1440 * MIN;
    expect(runAt(at + 25 * 60 * MIN, [row({})])).toEqual([]);
    expect(runAt(at + 23 * 60 * MIN, [row({})])).toHaveLength(1);
  });

  it("skips done tasks, other people's tasks and tasks without an id", () => {
    const at = nine(due) - 1440 * MIN;
    expect(runAt(at, [row({ done: true }), row({ assignees: ["Anna"] }), row({ block: null })])).toEqual([]);
  });

  it("shows each repeat of a reminder at its own moment", () => {
    const at = nine(due) - 120 * MIN;
    const rows = [row({ reminder: { before_min: 120, every_min: 30, count: 3 } })];
    expect(runAt(at + 31 * MIN, rows)).toHaveLength(2);
  });

  it("shows only the repeats later than the latest moment already shown", () => {
    const at = nine(due) - 120 * MIN;
    const rows = [row({ reminder: { before_min: 120, every_min: 30, count: 3 } })];
    expect(runAt(at + 31 * MIN, rows, new Map([["z-7f3a", at]]))).toEqual([`z-7f3a@${at + 30 * MIN}`]);
  });
});
