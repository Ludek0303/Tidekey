import { describe, expect, it } from "vitest";
import { dayAndMinute, dayOf } from "./dates";
import { fromIcs, toIcs } from "./ics";
import type { CalEvent } from "./model";

const base = (over: Partial<CalEvent>): CalEvent => ({
  id: "e1abc", line: 0, lineEnd: 0, title: "", startDay: 0, startMin: null, endDay: 0, endMin: null,
  rrule: null, ruleSupported: true, exdates: [], color: null, description: "", raw: "", ...over,
} as CalEvent);

const NOW = Date.UTC(2026, 10, 18, 9, 30, 0);
const octetLength = (s: string): number => new TextEncoder().encode(s).length;

describe("toIcs and fromIcs round trip", () => {
  const d = dayOf(2026, 11, 5);
  const events: CalEvent[] = [
    base({ id: "e2aaaaa", title: "Urlop", startDay: d, endDay: d + 2 }),
    base({ id: "e3bbbbb", title: "Spotkanie", startDay: d + 1, startMin: 600, endDay: d + 1, endMin: 690, description: "Pokój\nzłoty, a; b\\c" }),
    base({
      id: "e4ccccc", title: "Joga", startDay: d, startMin: 480, endDay: d, endMin: 540,
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE", exdates: [d + 7],
    }),
    base({ id: "L12", title: "Zażółć gęślą jaźń ".repeat(6).trim(), startDay: d + 3, startMin: 0, endDay: d + 3, endMin: 30 }),
  ];

  it("writes CRLF lines, lines of at most 75 octets, and the calendar header", () => {
    const text = toIcs(events, "Moje, notatki", NOW);
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Notes\/\/Kalendarz\/\/PL\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Moje\\, notatki\r\n/);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    for (const line of text.split("\r\n")) expect(octetLength(line)).toBeLessThanOrEqual(75);
    expect(text).toContain("DTSTAMP:20261118T093000Z");
    expect(text).toContain("UID:e2aaaaa@notes");
    expect(text).toMatch(/UID:[0-9a-f]+@notes\r\n/); // an event without a real id gets a hashed one
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
    expect(text).toContain(`EXDATE:${"20261112"}T080000`);
    expect(text).toContain("DTEND;VALUE=DATE:20261108");
  });

  it("reads back what it wrote", () => {
    const { events: back, skipped } = fromIcs(toIcs(events, "Moje", NOW));
    expect(skipped).toBe(0);
    expect(back).toHaveLength(4);
    expect(back[0]).toMatchObject({ title: "Urlop", startDay: d, startMin: null, endDay: d + 2, endMin: null, rule: null, color: null, description: "" });
    expect(back[1]).toMatchObject({ title: "Spotkanie", startDay: d + 1, startMin: 600, endDay: d + 1, endMin: 690, description: "Pokój\nzłoty, a; b\\c" });
    expect(back[2]).toMatchObject({ title: "Joga", startMin: 480, endMin: 540, rawRule: "FREQ=WEEKLY;BYDAY=MO,WE" });
    expect(back[3].title).toBe("Zażółć gęślą jaźń ".repeat(6).trim());
  });
});

describe("fromIcs on a Google-style file", () => {
  const warsawDay = dayOf(2026, 11, 5);
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Warsaw:20261105T100000",
    "DTEND;TZID=Europe/Warsaw:20261105T113000",
    "SUMMARY:Spotkanie z zespo\\, ł",
    " ódź",
    "DESCRIPTION:Linia 1\\nLinia 2\\; koniec",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Przypomnienie",
    "ACTION:DISPLAY",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261106T090000Z",
    "DTEND:20261106T100000Z",
    "SUMMARY:Z czasem UTC",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261107T120000",
    "DURATION:PT1H30M",
    "SUMMARY:Czas trwania",
    "RRULE:FREQ=DAILY;COUNT=3",
    "EXDATE;TZID=Europe/Warsaw:20261108T120000",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261110",
    "DTEND;VALUE=DATE:20261112",
    "SUMMARY:Dwa dni",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261105T100000",
    "STATUS:CANCELLED",
    "SUMMARY:Odwołane",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261232T100000",
    "SUMMARY:Zły dzień",
    "END:VEVENT",
    "BEGIN:VTODO",
    "SUMMARY:Zadanie",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads the events and counts the cancelled and the broken one as skipped", () => {
    const { events, skipped } = fromIcs(text, NOW);
    expect(skipped).toBe(2);
    expect(events.map((e) => e.title)).toEqual(["Spotkanie z zespo, łódź", "Z czasem UTC", "Czas trwania", "Dwa dni"]);
  });

  it("takes a TZID time as local wall time, a Z time as local time, and DURATION as the end", () => {
    const { events } = fromIcs(text, NOW);
    expect(events[0]).toMatchObject({ startDay: warsawDay, startMin: 600, endDay: warsawDay, endMin: 690, description: "Linia 1\nLinia 2; koniec" });
    const [utcDay, utcMin] = dayAndMinute(Date.UTC(2026, 10, 6, 9, 0));
    expect(events[1]).toMatchObject({ startDay: utcDay, startMin: utcMin });
    expect(events[2]).toMatchObject({ startMin: 720, endMin: 810, endDay: events[2].startDay, rawRule: "FREQ=DAILY;COUNT=3" });
  });

  it("reads an all-day event with an exclusive DTEND as the days before it", () => {
    const { events } = fromIcs(text, NOW);
    const start = dayOf(2026, 11, 10);
    expect(events[3]).toMatchObject({ startDay: start, startMin: null, endDay: start + 1, endMin: null });
    expect(events[3].rawRule).toBeUndefined();
  });

  it("ignores the VALARM's description, so the event keeps its own", () => {
    expect(fromIcs(text, NOW).events[0].description).not.toContain("Przypomnienie");
  });

  it("refuses a file over 5 MiB", () => {
    expect(() => fromIcs("x".repeat(5 * 1024 * 1024 + 1), NOW)).toThrow(/5 MiB/);
  });

  it("stops after 5000 events and counts the rest as skipped", () => {
    const one = "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261101\nSUMMARY:x\nEND:VEVENT\n";
    const result = fromIcs(one.repeat(5001), NOW);
    expect(result.events).toHaveLength(5000);
    expect(result.skipped).toBe(1);
  });
});
