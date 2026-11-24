// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadWasm } from "../testwasm";
import { CALENDAR_ORIGIN } from "../editor";
import { addEvent, applyChanges, assignId, deleteEvent, keepsSeriesStart, ruleOf, shiftRule, EventRef, newEventId, STALE, updateEvent, writeChanges, type EventInput, type Scope } from "./edit";
import { load, parseCalendar } from "./model";
import { editableRule, formatRule, parseRule, presetRule } from "./recur";
import { dayOf } from "./dates";

beforeAll(loadWasm);


// The ref a render would hold for the event with this id.
const refOf = (text: string, id: string): EventRef => {
  const ev = parseCalendar(text).events.find((e) => e.id === id)!;
  return { id: ev.id, line: ev.line, raw: ev.raw };
};
const updateById = (text: string, id: string, ...rest: [number, Scope, EventInput]) => updateEvent(text, refOf(text, id), ...rest);
const deleteById = (text: string, id: string, ...rest: [number, Scope]) => deleteEvent(text, refOf(text, id), ...rest);

const HEAD = "---\ntyp: kalendarz\n---\n";
const SERIES = "- 2026-10-21 10:00 Spotkanie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5 ^e7k2p\n";
const OTHER = "- 2026-11-01 Urodziny ^e1q9x\n";
const TEXT = HEAD + SERIES + OTHER;
const WED = dayOf(2026, 10, 21);
const FRI_AFTER = dayOf(2026, 10, 28);

const input = (over: Partial<EventInput>): EventInput => ({
  title: "Spotkanie",
  startDay: WED,
  startMin: 600,
  endDay: WED,
  endMin: 660,
  rule: parseRule("FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5"),
  color: null,
  description: "",
  ...over,
});

// The id of the last line written by an action is random, so tests compare the rest of the text.
const withoutNewId = (text: string, id: string) => text.replace(`^${id}`, "^NEW");
const lastId = (text: string) => /\^(e[0-9a-z]+)\n?$/.exec(text.trimEnd())![1];

describe("edit scopes produce the expected note text", () => {
  it("'this' adds an exception to the series and a single event with the new fields", () => {
    const out = applyChanges(
      TEXT,
      updateById(TEXT, "e7k2p", FRI_AFTER, "this", input({ title: "Zmienione", startDay: FRI_AFTER, endDay: FRI_AFTER, rule: null })),
    );
    const single = lastId(out);
    expect(withoutNewId(out, single)).toBe(
      HEAD +
        "- 2026-10-21 10:00 Spotkanie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5 ⛔ 2026-10-28 ^e7k2p\n" +
        OTHER +
        "- 2026-10-28 10:00 Zmienione ^NEW\n",
    );
    expect(single).not.toBe("e7k2p");
  });

  it("'following' ends the old series the day before and starts a new one with the rest of the count", () => {
    const out = applyChanges(TEXT, updateById(TEXT, "e7k2p", FRI_AFTER, "following", input({ title: "Po zmianie", startDay: FRI_AFTER, endDay: FRI_AFTER })));
    const lines = out.split("\n");
    expect(lines[3]).toBe("- 2026-10-21 10:00 Spotkanie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;UNTIL=20261027 ^e7k2p");
    expect(lines[5]).toBe("- 2026-10-28 10:00 Po zmianie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;COUNT=3 ^" + lastId(out.split("\n")[5]));
    expect(lines[4]).toBe("- 2026-11-01 Urodziny ^e1q9x");
  });

  it("'all' keeps the series start day and applies the new times to every occurrence", () => {
    const out = applyChanges(TEXT, updateById(TEXT, "e7k2p", FRI_AFTER, "all", input({ startDay: FRI_AFTER, endDay: FRI_AFTER, startMin: 540, endMin: 600 })));
    expect(out).toBe(HEAD + "- 2026-10-21 09:00 Spotkanie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5 ^e7k2p\n" + OTHER);
  });

  it("'this' delete only adds the exception", () => {
    const out = applyChanges(TEXT, deleteById(TEXT, "e7k2p", FRI_AFTER, "this"));
    expect(out).toBe(HEAD + "- 2026-10-21 10:00 Spotkanie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5 ⛔ 2026-10-28 ^e7k2p\n" + OTHER);
  });

  it("'following' delete ends the series before the occurrence", () => {
    const out = applyChanges(TEXT, deleteById(TEXT, "e7k2p", FRI_AFTER, "following"));
    expect(out).toBe(HEAD + "- 2026-10-21 10:00 Spotkanie 🔁 FREQ=WEEKLY;BYDAY=WE,FR;UNTIL=20261027 ^e7k2p\n" + OTHER);
  });

  it("'following' from the first occurrence deletes the whole series", () => {
    expect(applyChanges(TEXT, deleteById(TEXT, "e7k2p", WED, "following"))).toBe(HEAD + OTHER);
  });

  it("deleting a single event removes its line, also when it is the last one", () => {
    expect(applyChanges(TEXT, deleteById(TEXT, "e1q9x", dayOf(2026, 11, 1), "all"))).toBe(HEAD + SERIES);
    expect(applyChanges(HEAD + SERIES + "- 2026-11-01 Ostatni ^e1q9x", deleteById(HEAD + SERIES + "- 2026-11-01 Ostatni ^e1q9x", "e1q9x", 0, "all"))).toBe(HEAD + SERIES.trimEnd());
  });

  it("adds an event at the end, after a newline the text may lack", () => {
    const out = applyChanges(HEAD + "- 2026-11-01 Urodziny ^e1q9x", addEvent(HEAD + "- 2026-11-01 Urodziny ^e1q9x", input({ title: "Nowe", startDay: dayOf(2026, 11, 2), endDay: dayOf(2026, 11, 2), rule: null, startMin: null, endMin: null })));
    expect(out.startsWith(HEAD + "- 2026-11-01 Urodziny ^e1q9x\n- 2026-11-02 Nowe ^e")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("gives an event without a real id one on its first edit", () => {
    const text = HEAD + "- 2026-11-01 Bez id\n";
    const out = applyChanges(text, updateById(text, "#L3", dayOf(2026, 11, 1), "all", input({ title: "Z id", startDay: dayOf(2026, 11, 1), endDay: dayOf(2026, 11, 1), startMin: null, endMin: null, rule: null })));
    expect(out).toMatch(/^---\ntyp: kalendarz\n---\n- 2026-11-01 Z id \^e[0-9a-z]{5}\n$/);
  });

  it("keeps the description lines of the event it replaces", () => {
    const text = HEAD + "- 2026-11-01 Wyjazd ^e4m0c\n    pierwsza linia\n    druga\n";
    const out = applyChanges(text, updateById(text, "e4m0c", dayOf(2026, 11, 1), "all", input({ title: "Wyjazd", startDay: dayOf(2026, 11, 1), endDay: dayOf(2026, 11, 1), startMin: null, endMin: null, rule: null, description: "nowy opis" })));
    expect(out).toBe(HEAD + "- 2026-11-01 Wyjazd ^e4m0c\n    nowy opis\n");
  });
});

describe("rules this app cannot edit", () => {
  const PLAN = HEAD + "- 2026-10-21 Plan 🔁 FREQ=MONTHLY;BYDAY=WE;BYSETPOS=1 ^e9abcd\n";

  it("keeps the rule text when one occurrence is deleted", () => {
    const out = applyChanges(PLAN, deleteById(PLAN, "e9abcd", FRI_AFTER, "this"));
    expect(out).toContain("BYSETPOS=1");
    expect(out).toContain("⛔ 2026-10-28");
  });

  it("refuses to split the series, since the rule cannot be written back", () => {
    expect(() => deleteById(PLAN, "e9abcd", FRI_AFTER, "following")).toThrow();
    expect(() => updateById(PLAN, "e9abcd", FRI_AFTER, "following", input({}))).toThrow();
  });
});

describe("writes to the Y.Text", () => {
  it("applies one action as one transaction that undo can take back", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, TEXT);
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set<unknown>([CALENDAR_ORIGIN]) });
    const updates: number[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u.length));
    writeChanges(doc, updateById(ytext.toString(), "e7k2p", FRI_AFTER, "this", input({ startDay: FRI_AFTER, endDay: FRI_AFTER, rule: null })), CALENDAR_ORIGIN);
    expect(updates).toHaveLength(1);
    expect(parseCalendar(ytext.toString()).events).toHaveLength(3);
    undo.undo();
    expect(ytext.toString()).toBe(TEXT);
  });

  it("reads back the event that was added", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, HEAD);
    writeChanges(doc, addEvent(doc.getText("content").toString(), input({ title: "Dzień", startMin: null, endMin: null, endDay: WED, rule: null })), CALENDAR_ORIGIN);
    const [ev] = parseCalendar(doc.getText("content").toString()).events;
    expect(ev).toMatchObject({ title: "Dzień", startDay: WED, startMin: null, endDay: WED, endMin: null, rrule: null });
  });
});

describe("event ids", () => {
  it("are 'e' and five base-36 characters, unique in the note", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 3000; i++) taken.add(newEventId(taken));
    expect(taken.size).toBe(3000);
    for (const id of taken) expect(id).toMatch(/^e[0-9a-z]{5}$/);
  });

  it("does not hand out a taken id", () => {
    const taken = new Set(["e00000", "e00001"]);
    for (let i = 0; i < 200; i++) expect(taken.has(newEventId(taken))).toBe(false);
  });

  it("keeps the expansion of a series consistent after an 'all' edit", () => {
    const out = applyChanges(TEXT, updateById(TEXT, "e7k2p", FRI_AFTER, "all", input({ startDay: FRI_AFTER, endDay: FRI_AFTER })));
    const { occurrences } = load(out, WED, WED + 14);
    expect(occurrences.filter((o) => o.event.id === "e7k2p").map((o) => o.startDay)).toEqual([WED, WED + 2, WED + 7, WED + 9, WED + 14]);
  });
});

describe("rules kept as written, stale events and moved series", () => {
  const THANKS = HEAD + "- 2026-11-26 Dziękczynienie 🔁 FREQ=YEARLY;BYMONTH=11;BYDAY=4TH ^e5thnk\n";
  const NOV26 = dayOf(2026, 11, 26);
  const untouched = (title: string): EventInput => ({
    title,
    startDay: NOV26,
    startMin: null,
    endDay: NOV26,
    endMin: null,
    rule: editableRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"),
    color: null,
    description: "",
  });

  it("keeps BYMONTH when only the title changes, for the series and for one occurrence", () => {
    const all = applyChanges(THANKS, updateById(THANKS, "e5thnk", NOV26, "all", untouched("Dziękczynienie u mamy")));
    expect(all).toContain("- 2026-11-26 Dziękczynienie u mamy 🔁 FREQ=YEARLY;BYMONTH=11;BYDAY=4TH ^e5thnk");
    const one = applyChanges(THANKS, updateById(THANKS, "e5thnk", NOV26, "this", untouched("Dziękczynienie u mamy")));
    expect(one).toContain("- 2026-11-26 Dziękczynienie 🔁 FREQ=YEARLY;BYMONTH=11;BYDAY=4TH ⛔ 2026-11-26 ^e5thnk");
    expect(one).toContain("- 2026-11-26 Dziękczynienie u mamy ^e");
  });

  it("shows the form only the rules it can write back in full", () => {
    expect(ruleOf(parseCalendar(THANKS).events[0])).toBeNull();
    expect(ruleOf(parseCalendar(TEXT).events[0])).not.toBeNull();
  });

  it("writes a rule back unchanged, so a text the form cannot write is not rewritten", () => {
    expect(editableRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")).not.toBeNull();
    expect(editableRule("FREQ=YEARLY;BYSETPOS=-1")).toBeNull();
  });

  it("finds a line-numbered event again after a line was added above it", () => {
    const before = HEAD + "- 2026-11-01 Bez id A\n- 2026-11-02 Bez id B\n";
    const ref = refOf(before, "#L4");
    const after = HEAD + "- 2026-10-30 Nowe ^exyz12\n- 2026-11-01 Bez id A\n- 2026-11-02 Bez id B\n";
    const out = applyChanges(after, updateEvent(after, ref, dayOf(2026, 11, 2), "all", input({ title: "B zmieniony", startDay: dayOf(2026, 11, 2), endDay: dayOf(2026, 11, 2), startMin: null, endMin: null, rule: null })));
    expect(out).toMatch(/^---\ntyp: kalendarz\n---\n- 2026-10-30 Nowe \^exyz12\n- 2026-11-01 Bez id A\n- 2026-11-02 B zmieniony \^e[0-9a-z]{5}\n$/);
  });

  it("refuses an event that changed, and an ambiguous one, without writing", () => {
    const before = HEAD + "- 2026-11-01 Bez id B\n";
    const changed = HEAD + "- 2026-11-02 Bez id B - zmieniony\n";
    expect(() => updateEvent(changed, refOf(before, "#L3"), NOV26, "all", untouched("x"))).toThrow(STALE);
    const moved = HEAD + "- 2026-10-30 X ^exyz12\n- 2026-11-01 Dup\n- 2026-11-01 Dup\n";
    const ref = { id: "#L3", line: 3, raw: "- 2026-11-01 Dup" };
    expect(() => deleteEvent(moved, ref, NOV26, "all")).toThrow(STALE);
  });

  it("gives a line-numbered event a real id before anything else is written", () => {
    const text = HEAD + "- 2026-11-01 Bez id A\n";
    const out = applyChanges(text, assignId(text, refOf(text, "#L3")));
    expect(out).toMatch(/^---\ntyp: kalendarz\n---\n- 2026-11-01 Bez id A \^e[0-9a-z]{5}\n$/);
  });

  it("moves a series with its occurrence: the form's new weekday is the series' start", () => {
    const text = HEAD + "- 2026-10-21 10:00 Plan 🔁 FREQ=WEEKLY;BYDAY=WE ^ewkly1\n";
    const wed = dayOf(2026, 10, 21);
    const thu = wed + 1;
    const form = input({ title: "Plan", startDay: thu, endDay: thu, startMin: 600, endMin: 660, rule: presetRule("weekly", thu) });
    const out = applyChanges(text, updateById(text, "ewkly1", wed, "all", form));
    expect(out).toBe(HEAD + "- 2026-10-22 10:00 Plan 🔁 FREQ=WEEKLY;BYDAY=TH ^ewkly1\n");
  });

  it("does not split a counted series that is older than the counting range", () => {
    const old = HEAD + "- 2000-01-03 Stary 🔁 FREQ=WEEKLY;BYDAY=MO;COUNT=500 ^eold12\n";
    expect(() => updateById(old, "eold12", dayOf(2026, 10, 26), "following", input({ title: "x", startDay: dayOf(2026, 10, 26), endDay: dayOf(2026, 10, 26), rule: null }))).toThrow();
  });
});

describe("assigning an id, undo steps and moved series, by branch", () => {
  const RAW = HEAD + "* 2026-10-15 10:00-11:00 Gwiazdka [[Plan]] #tag ⛔ 2026-10-22 🎨 nieznany\n\tOpis wcięty\n" +
    "- 2026-10-16 Drugi 🔁 FREQ=DAILY;COUNT=2 🔁 FREQ=WEEKLY\n    Drugi opis\n";

  it("only appends the id to the first line; the description and the rest stay byte for byte", () => {
    const first = applyChanges(RAW, assignId(RAW, refOf(RAW, "#L3")));
    expect(first.replace(/ \^e[0-9a-z]{5}\n/, "\n")).toBe(RAW);
    expect(first).toMatch(/ \^e[0-9a-z]{5}\n/);
    const second = applyChanges(first, assignId(first, refOf(first, "#L5")));
    expect(second.replace(/ \^e[0-9a-z]{5}\n/g, "\n")).toBe(RAW);
    // The core reads the event back with the new id, and the rules of the second event are untouched.
    const events = parseCalendar(second).events;
    expect(events.map((e) => e.id)).toEqual([expect.stringMatching(/^e[0-9a-z]{5}$/), expect.stringMatching(/^e[0-9a-z]{5}$/)]);
    expect(events[1].rrule).toBe(parseCalendar(RAW).events[1].rrule);
    expect(events[1].description).toBe("Drugi opis");
  });

  it("puts the id before the carriage return of a CRLF line", () => {
    const crlf = "---\r\ntyp: kalendarz\r\n---\r\n- 2026-11-01 Bez id\r\n";
    const out = applyChanges(crlf, assignId(crlf, refOf(crlf, "#L3")));
    expect(out).toMatch(/^---\r\ntyp: kalendarz\r\n---\r\n- 2026-11-01 Bez id \^e[0-9a-z]{5}\r\n$/);
    expect(parseCalendar(out).events[0].id).toMatch(/^e[0-9a-z]{5}$/);
  });

  it("makes each quick action its own undo step", () => {
    const text = HEAD + "- 2026-11-01 A ^eaaaaa\n- 2026-11-02 B ^ebbbbb\n";
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, text);
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set<unknown>([CALENDAR_ORIGIN]) });
    writeChanges(doc, deleteById(text, "eaaaaa", dayOf(2026, 11, 1), "all"), CALENDAR_ORIGIN, undo);
    writeChanges(doc, deleteById(ytext.toString(), "ebbbbb", dayOf(2026, 11, 2), "all"), CALENDAR_ORIGIN, undo);
    expect(ytext.toString()).toBe(HEAD);
    undo.undo();
    expect(ytext.toString()).toBe(HEAD + "- 2026-11-02 B ^ebbbbb\n");
  });

  it("shifts weekdays, monthly days and plain rules exactly, and refuses the rest", () => {
    const rule = (t: string) => parseRule(t)!;
    expect(formatRule(shiftRule(rule("FREQ=WEEKLY;BYDAY=WE,FR"), 1)!)).toBe("FREQ=WEEKLY;BYDAY=TH,SA");
    expect(formatRule(shiftRule(rule("FREQ=WEEKLY;BYDAY=WE,FR"), -2)!)).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(formatRule(shiftRule(rule("FREQ=MONTHLY;BYMONTHDAY=10"), 3)!)).toBe("FREQ=MONTHLY;BYMONTHDAY=13");
    expect(shiftRule(rule("FREQ=MONTHLY;BYMONTHDAY=10"), 20)).toBeNull();
    expect(shiftRule(rule("FREQ=MONTHLY;BYMONTHDAY=28"), 1)).toBeNull();
    expect(formatRule(shiftRule(rule("FREQ=DAILY"), 5)!)).toBe("FREQ=DAILY");
    expect(formatRule(shiftRule(rule("FREQ=YEARLY"), 5)!)).toBe("FREQ=YEARLY");
    expect(shiftRule(rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE"), 1)).toBeNull();
    expect(shiftRule(rule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), 1)).toBeNull();
    expect(shiftRule(rule("FREQ=MONTHLY;BYDAY=3WE"), 1)).toBeNull();
  });

  it("moves a custom weekly series with its occurrence, and keeps it when the shift is not exact", () => {
    const WED_OCC = dayOf(2026, 10, 21);
    const weekly = HEAD + "- 2026-10-21 10:00 Plan 🔁 FREQ=WEEKLY;BYDAY=WE,FR ^ecust1\n";
    const thu = WED_OCC + 1;
    const moved = updateById(weekly, "ecust1", WED_OCC, "all", input({ title: "Plan", startDay: thu, endDay: thu, startMin: 600, endMin: 660, rule: parseRule("FREQ=WEEKLY;BYDAY=WE,FR") }));
    expect(applyChanges(weekly, moved)).toBe(HEAD + "- 2026-10-22 10:00 Plan 🔁 FREQ=WEEKLY;BYDAY=TH,SA ^ecust1\n");
    expect(keepsSeriesStart(parseCalendar(weekly).events[0], WED_OCC, input({ startDay: thu, endDay: thu, rule: parseRule("FREQ=WEEKLY;BYDAY=WE,FR") }))).toBe(false);

    const biweekly = HEAD + "- 2026-10-21 10:00 Plan 🔁 FREQ=WEEKLY;INTERVAL=2;BYDAY=WE ^ecust2\n";
    const form = input({ title: "Plan", startDay: thu, endDay: thu, startMin: 540, endMin: 600, rule: parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE") });
    expect(keepsSeriesStart(parseCalendar(biweekly).events[0], WED_OCC, form)).toBe(true);
    expect(applyChanges(biweekly, updateById(biweekly, "ecust2", WED_OCC, "all", form))).toBe(HEAD + "- 2026-10-21 09:00 Plan 🔁 FREQ=WEEKLY;INTERVAL=2;BYDAY=WE ^ecust2\n");
  });
});

describe("reminders in edits", () => {
  const SINGLE = HEAD + "- 2026-11-01 10:00 Spotkanie 🔔 15 ^e7k2p\n";

  it("writes the reminder of a new event", () => {
    const added = applyChanges(TEXT, addEvent(TEXT, input({ rule: null, reminder: 5 })));
    expect(added).toContain("🔔 5 ^");
    expect(parseCalendar(added).events.at(-1)!.reminder).toBe(5);
  });

  it("keeps the reminder of an event that is edited without one", () => {
    const next = applyChanges(SINGLE, updateById(SINGLE, "e7k2p", dayOf(2026, 11, 1), "all", input({ title: "Nowy tytuł", rule: null })));
    expect(parseCalendar(next).events[0]).toMatchObject({ title: "Nowy tytuł", reminder: 15 });
  });

  it("sets and clears the reminder", () => {
    const off = applyChanges(SINGLE, updateById(SINGLE, "e7k2p", dayOf(2026, 11, 1), "all", input({ rule: null, reminder: null })));
    expect(parseCalendar(off).events[0].reminder).toBeNull();
    expect(off).not.toContain("🔔");
  });
});
