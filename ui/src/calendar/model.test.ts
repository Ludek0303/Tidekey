// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { loadWasm } from "../testwasm";
import { colorHex, isCalendarText, load, parseCalendar, wikilinks } from "./model";
import { dayOf } from "./dates";
import { addEvent, applyChanges } from "./edit";

beforeAll(loadWasm);

describe("calendar reading", () => {
  it("knows a calendar note from its front matter only", () => {
    expect(isCalendarText("---\ntyp: kalendarz\n---\n- 2026-10-21 Dzień\n")).toBe(true);
    expect(isCalendarText("# Zwykła notatka\n- 2026-10-21 Dzień\n")).toBe(false);
    expect(isCalendarText("")).toBe(false);
  });

  it("maps a palette name to its colour and leaves unknown names to the accent", () => {
    expect(colorHex("pomidorowy")).toBe("#d50000");
    expect(colorHex("Pomidorowy")).toBe("#d50000");
    expect(colorHex("niebieski")).toBeNull();
    expect(colorHex(null)).toBeNull();
  });

  it("expands only the requested range of a large note", () => {
    const lines = ["---", "typ: kalendarz", "---"];
    for (let i = 0; i < 2000; i++) lines.push(`- 2026-10-${String((i % 28) + 1).padStart(2, "0")} 10:00 Wydarzenie ${i} ^e${i.toString(36).padStart(5, "0")}`);
    lines.push("- 2026-01-01 Cykl 🔁 FREQ=DAILY ^ezzzzz");
    const text = lines.join("\n") + "\n";
    const loaded = load(text, dayOf(2026, 10, 5), dayOf(2026, 10, 5));
    expect(loaded.events).toHaveLength(2001);
    expect(loaded.occurrences.filter((o) => o.event.title === "Wydarzenie 4" || o.startDay === dayOf(2026, 10, 5)).length).toBeGreaterThan(0);
    expect(loaded.occurrences.every((o) => o.startDay === dayOf(2026, 10, 5) || o.event.id === "ezzzzz")).toBe(true);
  });

  it("returns no events for a note that is not a calendar", () => {
    expect(load("- 2026-10-21 Dzień\n", 0, 99999).occurrences).toEqual([]);
  });
});

describe("wikilinks in events", () => {
  it("keeps a wikilink in the title and the description through format and parse", () => {
    const head = "---\ntyp: kalendarz\n---\n";
    const text = applyChanges(head, addEvent(head, {
      title: "Plan [[Plan]]",
      startDay: dayOf(2026, 11, 5),
      startMin: 14 * 60,
      endDay: dayOf(2026, 11, 5),
      endMin: 15 * 60,
      rule: null,
      color: null,
      description: "Notatka [[Plan|alias]]\n[[Projekt#Cele]]",
    }));
    const [ev] = parseCalendar(text).events;
    expect(ev.title).toBe("Plan [[Plan]]");
    expect(ev.description).toBe("Notatka [[Plan|alias]]\n[[Projekt#Cele]]");
    expect(wikilinks(ev.title + "\n" + ev.description)).toEqual(["Plan", "Projekt"]);
  });
});
