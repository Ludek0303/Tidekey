import { describe, expect, it } from "vitest";
import { addMonths, dayOf, dayTitle, isoDay, monthGrid, monthTitle, parseHm, parseIsoDay, plural, weekTitle, weekdayOf, ymdOf } from "./dates";

describe("day numbers", () => {
  it("counts from 1970-01-01 (a Thursday) and starts weeks on Monday", () => {
    expect(dayOf(1970, 1, 1)).toBe(0);
    expect(weekdayOf(0)).toBe(3);
    expect(weekdayOf(dayOf(2026, 10, 19))).toBe(0);
    expect(weekdayOf(dayOf(2026, 10, 25))).toBe(6);
  });

  it("round-trips ISO dates and rejects impossible ones", () => {
    expect(isoDay(dayOf(2026, 10, 22))).toBe("2026-10-22");
    expect(parseIsoDay("2026-02-28")).toBe(dayOf(2026, 2, 28));
    expect(parseIsoDay("2026-02-30")).toBeNull();
    expect(parseIsoDay("22.10.2026")).toBeNull();
    expect(ymdOf(dayOf(2024, 2, 29))).toEqual({ y: 2024, m: 2, d: 29 });
  });

  it("parses HH:MM into minutes and rejects out of range values", () => {
    expect(parseHm("07:30")).toBe(450);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("9:61")).toBeNull();
  });
});

describe("month grid", () => {
  it("is six Monday-first weeks that contain the whole month", () => {
    // October 2026 starts on a Thursday, so the grid starts on Monday 28 September.
    const grid = monthGrid(dayOf(2026, 10, 15));
    expect(grid).toHaveLength(42);
    expect(isoDay(grid[0])).toBe("2026-09-28");
    expect(weekdayOf(grid[0])).toBe(0);
    expect(isoDay(grid[41])).toBe("2026-11-08");
    expect(grid).toContain(dayOf(2026, 10, 1));
    expect(grid).toContain(dayOf(2026, 10, 31));
  });

  it("starts on the first day when the month begins on a Monday", () => {
    // June 2026 begins on a Monday.
    expect(isoDay(monthGrid(dayOf(2026, 6, 10))[0])).toBe("2026-06-01");
  });

  it("keeps the day of the month when moving months, clamped to the shorter month", () => {
    expect(isoDay(addMonths(dayOf(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(isoDay(addMonths(dayOf(2026, 12, 15), 1))).toBe("2027-01-15");
    expect(isoDay(addMonths(dayOf(2026, 3, 15), -3))).toBe("2025-12-15");
  });
});

describe("Polish titles", () => {
  it("names the month, the week and the day", () => {
    expect(monthTitle(dayOf(2026, 10, 21))).toBe("październik 2026");
    expect(weekTitle(dayOf(2026, 10, 21))).toBe("19–25 paź 2026");
    expect(weekTitle(dayOf(2026, 10, 28))).toBe("26 paź – 1 lis 2026");
    expect(weekTitle(dayOf(2026, 12, 30))).toBe("28 gru 2026 – 3 sty 2027");
    expect(dayTitle(dayOf(2026, 10, 21))).toBe("środa, 21 października 2026");
  });

  it("picks the Polish plural form", () => {
    expect([1, 2, 5, 12, 22, 25].map((n) => plural(n, "raz", "razy", "razy"))).toEqual(["raz", "razy", "razy", "razy", "razy", "razy"]);
    expect(plural(3, "tydzień", "tygodnie", "tygodni")).toBe("tygodnie");
    expect(plural(14, "tydzień", "tygodnie", "tygodni")).toBe("tygodni");
  });
});
