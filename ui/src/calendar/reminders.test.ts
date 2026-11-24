// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { loadWasm } from "../testwasm";
import { dueReminders } from "./reminders";

beforeAll(loadWasm);

const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const CAL = "---\ntyp: kalendarz\n---\n";

describe("calendar reminders", () => {
  it("is due inside the window before the start, and only there", () => {
    const text = CAL + "- 2026-10-22 10:00 Spotkanie 🔔 15 ^e1\n";
    const start = at(2026, 10, 22, 10);
    expect(dueReminders([text], at(2026, 10, 22, 9, 44))).toEqual([]);
    expect(dueReminders([text], at(2026, 10, 22, 9, 45))).toEqual([{ key: `e1@${start}`, title: "Spotkanie", start }]);
    expect(dueReminders([text], at(2026, 10, 22, 9, 59))).toHaveLength(1);
    expect(dueReminders([text], start)).toEqual([]);
  });

  it("ignores events without a reminder and notes that are not calendars", () => {
    const now = at(2026, 10, 22, 9, 50);
    expect(dueReminders([CAL + "- 2026-10-22 10:00 Bez 🔁 FREQ=DAILY ^e1\n"], now)).toEqual([]);
    expect(dueReminders(["# Notatka\n- 2026-10-22 10:00 Zwykła 🔔 15 ^e1\n"], now)).toEqual([]);
  });

  it("gives each occurrence of a repeated event its own key", () => {
    const text = CAL + "- 2026-10-20 10:00 Codziennie 🔔 5 🔁 FREQ=DAILY ^e2\n";
    const first = dueReminders([text], at(2026, 10, 20, 9, 58));
    const second = dueReminders([text], at(2026, 10, 21, 9, 58));
    expect(first.map((r) => r.key)).toEqual([`e2@${at(2026, 10, 20, 10)}`]);
    expect(second.map((r) => r.key)).toEqual([`e2@${at(2026, 10, 21, 10)}`]);
  });

  it("finds an event beyond tomorrow when its reminder is a week before", () => {
    const text = CAL + "- 2026-10-27 10:00 Za tydzień 🔔 10080 ^e3\n";
    expect(dueReminders([text], at(2026, 10, 21, 10)).map((r) => r.title)).toEqual(["Za tydzień"]);
    expect(dueReminders([text], at(2026, 10, 19, 10))).toEqual([]);
  });

  it("counts an all-day event from its midnight", () => {
    const text = CAL + "- 2026-10-23 Dzień 🔔 1440 ^e4\n";
    expect(dueReminders([text], at(2026, 10, 21, 23, 59))).toEqual([]);
    expect(dueReminders([text], at(2026, 10, 22, 0, 0))).toHaveLength(1);
  });

  it("collects the reminders of several notes", () => {
    const a = CAL + "- 2026-10-22 10:00 A 🔔 15 ^e1\n";
    const b = CAL + "- 2026-10-22 10:05 B 🔔 15 ^e2\n";
    expect(dueReminders([a, b], at(2026, 10, 22, 9, 50)).map((r) => r.title)).toEqual(["A", "B"]);
  });
});
