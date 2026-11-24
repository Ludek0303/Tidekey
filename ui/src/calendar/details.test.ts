// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { openDetails } from "./details";
import type { Occurrence } from "./model";
import { dayOf } from "./dates";

describe("event details", () => {
  it("opens the note a wikilink of the event names", () => {
    const day = dayOf(2026, 11, 5);
    const occ: Occurrence = {
      event: {
        id: "e1", line: 0, lineEnd: 1, title: "Plan", startDay: day, startMin: 840, endDay: day, endMin: 900,
        rrule: null, ruleSupported: true, exdates: [], color: null, reminder: null, description: "[[Notatka]]", raw: "",
      },
      startDay: day, startMin: 840, endDay: day, endMin: 900,
    };
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const openNote = vi.fn();
    openDetails(occ, anchor, { edit: vi.fn(), remove: vi.fn(), openNote });
    const link = [...document.querySelectorAll("button")].find((b) => b.textContent === "Powiązana notatka: Notatka")!;
    expect(link).toBeDefined();
    link.click();
    expect(openNote).toHaveBeenCalledWith("Notatka");
  });
});
