import { describe, it, expect } from "vitest";
import {
  wallTimeToIso,
  availabilityAt,
  proposeMeetings,
  occurrences,
} from "./availability";
import type { DataRecord } from "./records";
const a: DataRecord = {
  id: "a",
  kind: "availability",
  user_id: "jan",
  timezone: "Europe/Warsaw",
  weekly_slots: [{ day: 0, start: 600, end: 720 }],
  date_overrides: [],
};
describe("availability and time zones", () => {
  it("rejects missing and ambiguous DST times", () => {
    expect(() => wallTimeToIso("2026-03-29T02:30", "Europe/Warsaw")).toThrow();
    expect(() => wallTimeToIso("2026-10-25T02:30", "Europe/Warsaw")).toThrow();
    expect(wallTimeToIso("2026-11-02T10:00", "Europe/Warsaw")).toBe(
      "2026-11-02T09:00:00.000Z",
    );
  });
  it("date overrides beat weekly slots; no declaration remains unknown", () => {
    expect(availabilityAt(undefined, Date.parse("2026-11-02T09:00Z"))).toBe(
      "unknown",
    );
    expect(availabilityAt(a, Date.parse("2026-11-02T09:00Z"))).toBe("yes");
    expect(
      availabilityAt(
        {
          ...a,
          date_overrides: [
            { date: "2026-11-02", start: 0, end: 1440, available: false },
          ],
        },
        Date.parse("2026-11-02T09:00Z"),
      ),
    ).toBe("no");
  });
  it("subtracts busy events and never treats missing required people as available", () => {
    const start = Date.parse("2026-11-02T09:00Z"),
      end = Date.parse("2026-11-02T12:00Z");
    expect(
      proposeMeetings(["jan", "anna"], ["anna"], [a], [], start, end, 60),
    ).toEqual([]);
    const busy: DataRecord = {
      id: "event",
      kind: "event",
      start: "2026-11-02T09:00Z",
      end: "2026-11-02T10:00Z",
      timezone: "Europe/Warsaw",
      participants: ["jan"],
    };
    const proposals = proposeMeetings(
      ["jan"],
      ["jan"],
      [a],
      [busy],
      start,
      end,
      60,
    );
    expect(proposals.map((p) => p.start)).toEqual(["2026-11-02T10:00:00.000Z"]);
  });
  it("weekly recurrence follows wall time across DST and skips exceptions", () => {
    const event: DataRecord = {
      id: "e",
      kind: "event",
      start: "2026-10-19T08:00:00Z",
      end: "2026-10-19T09:00:00Z",
      timezone: "Europe/Warsaw",
      rrule: "FREQ=WEEKLY",
      exceptions: ["2026-11-02"],
    };
    const result = occurrences(
      event,
      Date.parse("2026-10-19"),
      Date.parse("2026-11-04"),
    );
    expect(result.map((o) => new Date(o.start).toISOString())).toEqual([
      "2026-10-19T08:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
  });
});
