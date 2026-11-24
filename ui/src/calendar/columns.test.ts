import { describe, expect, it } from "vitest";
import { layoutColumns } from "./columns";
import { placeEntries } from "./lanes";
import { dayOf } from "./dates";
import type { Occurrence } from "./model";

describe("layoutColumns", () => {
  it("gives overlapping events side by side and shares the width of the cluster", () => {
    const placed = layoutColumns([
      { start: 600, end: 660, item: "a" },
      { start: 630, end: 700, item: "b" },
      { start: 650, end: 680, item: "c" },
    ]);
    const byItem = Object.fromEntries(placed.map((p) => [p.item, p]));
    expect(byItem.a).toMatchObject({ col: 0, cols: 3 });
    expect(byItem.b).toMatchObject({ col: 1, cols: 3 });
    expect(byItem.c).toMatchObject({ col: 2, cols: 3 });
  });

  it("reuses a column that is free again, so the cluster stays as narrow as it can", () => {
    const placed = layoutColumns([
      { start: 600, end: 630, item: "a" },
      { start: 615, end: 700, item: "b" },
      { start: 640, end: 680, item: "c" },
    ]);
    const byItem = Object.fromEntries(placed.map((p) => [p.item, p]));
    expect(byItem.c.col).toBe(0);
    expect(byItem.c.cols).toBe(2);
    expect(byItem.b.cols).toBe(2);
  });

  it("gives events that do not overlap, or only touch, the full width", () => {
    const placed = layoutColumns([
      { start: 540, end: 600, item: "a" },
      { start: 600, end: 660, item: "b" },
      { start: 900, end: 960, item: "c" },
    ]);
    expect(placed.map((p) => [p.item, p.col, p.cols])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
      ["c", 0, 1],
    ]);
  });

  it("packs a cluster through a chain of overlaps", () => {
    // a overlaps b and b overlaps c, but a and c do not: the cluster is still one group of two columns.
    const placed = layoutColumns([
      { start: 0, end: 100, item: "a" },
      { start: 90, end: 200, item: "b" },
      { start: 190, end: 300, item: "c" },
    ]);
    expect(new Set(placed.map((p) => p.cols))).toEqual(new Set([2]));
    expect(placed.find((p) => p.item === "c")!.col).toBe(0);
  });
});

describe("placeEntries (month and all-day lanes)", () => {
  const first = dayOf(2026, 10, 19); // a Monday
  const occ = (startDay: number, endDay: number, startMin: number | null = null): Occurrence => ({
    event: { id: `e${startDay}${endDay}`, title: "x" } as Occurrence["event"],
    startDay,
    startMin,
    endDay,
    endMin: startMin === null ? null : 600,
  });

  it("clips a bar that spans the week and puts overlapping bars on different lanes", () => {
    const occs = [occ(first + 1, first + 3), occ(first + 2, first + 2), occ(first - 5, first + 1)];
    const { entries, hidden } = placeEntries(occs, first, 7, 3, () => true);
    const lanes = entries.map((e) => [e.c0, e.c1, e.lane]);
    expect(lanes).toContainEqual([0, 1, 0]); // clipped to the week's first day
    expect(lanes).toContainEqual([1, 3, 1]);
    expect(lanes).toContainEqual([2, 2, 0]); // the bar that ended on column 1 has lane 0 free again
    expect(hidden.every((h) => h === 0)).toBe(true);
  });

  it("counts the entries past the lanes per column and leaves them out", () => {
    const occs = [occ(first, first), occ(first, first), occ(first, first), occ(first, first + 1)];
    const { entries, hidden } = placeEntries(occs, first, 7, 3, () => true);
    expect(entries).toHaveLength(3);
    expect(hidden.slice(0, 3)).toEqual([1, 0, 0]);
  });

  it("skips occurrences outside the range and those the filter drops", () => {
    const occs = [occ(first - 10, first - 2), occ(first, first, 600)];
    const { entries } = placeEntries(occs, first, 7, 3, (o) => o.startMin === null);
    expect(entries).toHaveLength(0);
  });
});
