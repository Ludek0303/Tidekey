// iCalendar (RFC 5545) for calendar notes: toIcs writes the events of a note, fromIcs reads a file into
// EventInputs. The app stores local time without a zone (ARCHITEKTURA §4.16b), so timed events are floating.
import { dayAndMinute, MINUTES, parseIsoDay, ymdOf } from "./dates";
import { isRealId, type EventInput } from "./edit";
import type { CalEvent } from "./model";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 5000;
const DEFAULT_TITLE = "(bez tytułu)";

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const dateStr = (day: number): string => {
  const { y, m, d } = ymdOf(day);
  return `${pad(y, 4)}${pad(m)}${pad(d)}`;
};
const timeStr = (day: number, min: number): string => `${dateStr(day)}T${pad(Math.floor(min / 60))}${pad(min % 60)}00`;

/** A property with a date value: all-day when `min` is `null`. */
const when = (name: string, day: number, min: number | null): string =>
  min === null ? `${name};VALUE=DATE:${dateStr(day)}` : `${name}:${timeStr(day, min)}`;

// RFC 5545 §3.3.11: backslash, semicolon and comma are escaped; a line break becomes `\n`.
const escapeText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
const unescapeText = (s: string): string => s.replace(/\\(.)/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** UTF-8 octets of one code point. */
const octets = (ch: string): number => {
  const c = ch.codePointAt(0)!;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};

/** Folds a line at 75 octets; continuation lines start with a space and never split a character. */
function fold(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let size = 0;
  let max = 75;
  for (const ch of line) {
    const n = octets(ch);
    if (size + n > max) {
      parts.push(cur);
      cur = "";
      size = 0;
      max = 74;
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/** A stable UID for an event without a real id (FNV-1a over its title and start). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const uidOf = (ev: CalEvent): string =>
  isRealId(ev.id) ? `${ev.id}@notes` : `${hash(`${ev.title}|${ev.startDay}|${ev.startMin}`)}@notes`;

/** The events of a calendar note as an iCalendar file (CRLF line endings, folded lines). */
export function toIcs(events: CalEvent[], name: string, now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Notes//Kalendarz//PL",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const ev of events) {
    const allDay = ev.startMin === null;
    lines.push("BEGIN:VEVENT", `UID:${uidOf(ev)}`, `DTSTAMP:${stamp}`);
    lines.push(when("DTSTART", ev.startDay, ev.startMin));
    // All-day DTEND is exclusive: the day after the last one.
    lines.push(allDay ? when("DTEND", ev.endDay + 1, null) : when("DTEND", ev.endDay, ev.endMin ?? ev.startMin ?? 0));
    lines.push(`SUMMARY:${escapeText(ev.title)}`);
    if (ev.description !== "") lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.rrule !== null) lines.push(`RRULE:${ev.rrule}`);
    for (const d of ev.exdates) lines.push(when("EXDATE", d, ev.startMin));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** One unfolded content line: `NAME;PARAM=V:value`, the value starting after the first colon outside quotes. */
function parseLine(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rest] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/"/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

interface At {
  day: number;
  /** `null` for a date (all-day) value. */
  min: number | null;
}

/** A DATE or DATE-TIME value; `…Z` is converted to local time, anything else is floating local time. */
function parseAt(value: string): At {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z?))?$/i.exec(value.trim());
  if (!m) throw new Error("Zła data w pliku .ics");
  const day = parseIsoDay(`${m[1]}-${m[2]}-${m[3]}`);
  if (day === null) throw new Error("Zła data w pliku .ics");
  if (m[4] === undefined) return { day, min: null };
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) throw new Error("Zła godzina w pliku .ics");
  if (m[7] !== "") {
    const [utcDay, min] = dayAndMinute(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi));
    return { day: utcDay, min };
  }
  // shortcut: a TZID zone is ignored and its wall time is read as local time; upgrade: convert the zone when zones are stored.
  return { day, min: h * 60 + mi };
}

/** An RFC 5545 DURATION (`P1W`, `PT1H30M`, …) in minutes. */
function durationMin(value: string): number {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m || m[1] === "-" || !/\d/.test(value)) throw new Error("Zły czas trwania w pliku .ics");
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? 0));
  return w * 7 * MINUTES + d * MINUTES + h * 60 + mi + Math.floor(s / 60);
}

/** One VEVENT's properties as an event. Throws when it is not usable (the caller skips it). */
function toEvent(props: Prop[]): EventInput {
  const get = (name: string): Prop | undefined => props.find((p) => p.name === name);
  const startProp = get("DTSTART");
  if (!startProp) throw new Error("Wydarzenie bez DTSTART");
  const start = parseAt(startProp.value);
  const endProp = get("DTEND");
  const durProp = get("DURATION");
  let endDay: number;
  let endMin: number | null;
  if (start.min === null) {
    // All-day: DTEND is exclusive, DURATION counts whole days.
    let last = start.day;
    if (endProp) last = parseAt(endProp.value).day - 1;
    else if (durProp) last = start.day + Math.ceil(durationMin(durProp.value) / MINUTES) - 1;
    endDay = Math.max(start.day, last);
    endMin = null;
  } else {
    const startAbs = start.day * MINUTES + start.min;
    let endAbs = startAbs + 60;
    if (endProp) {
      const e = parseAt(endProp.value);
      endAbs = e.day * MINUTES + (e.min ?? 0);
    } else if (durProp) endAbs = startAbs + durationMin(durProp.value);
    // An end before the start (or a date-only end on a timed event) gets the default hour.
    if (endAbs < startAbs) endAbs = startAbs + 60;
    endDay = Math.floor(endAbs / MINUTES);
    endMin = endAbs % MINUTES;
  }
  const title = unescapeText(get("SUMMARY")?.value ?? "").replace(/\n/g, " ").trim() || DEFAULT_TITLE;
  const rrule = get("RRULE")?.value.trim();
  const input: EventInput = {
    title,
    startDay: start.day,
    startMin: start.min,
    endDay,
    endMin,
    rule: null,
    color: null,
    description: unescapeText(get("DESCRIPTION")?.value ?? ""),
  };
  // shortcut: EXDATE is not in EventInput, so excluded occurrences come back on import; upgrade: when EventInput takes exdates.
  if (rrule) input.rawRule = rrule;
  return input;
}

/**
 * The events of an iCalendar file. Untrusted input: over 5 MiB is refused, and after 5000 events the rest
 * are counted as skipped. Skipped are also broken events, cancelled ones and those with a "CANCELLED" status.
 * shortcut: the `now` argument is unused; the file's own times are all that counts (no DTSTAMP is read).
 */
export function fromIcs(text: string, _now = Date.now()): { events: EventInput[]; skipped: number } {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("Plik .ics jest za duży (ponad 5 MiB).");
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: EventInput[] = [];
  let skipped = 0;
  // The props of the VEVENT being read; `nested` counts components inside it (VALARM) whose props are not the event's.
  let cur: Prop[] | null = null;
  let nested = 0;
  for (const raw of lines) {
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (cur) nested++;
      else if (p.value.toUpperCase() === "VEVENT") cur = [];
    } else if (p.name === "END") {
      if (cur && nested > 0) nested--;
      else if (cur && p.value.toUpperCase() === "VEVENT") {
        const props = cur;
        cur = null;
        if (events.length >= MAX_EVENTS) skipped++;
        else if (props.find((x) => x.name === "STATUS")?.value.trim().toUpperCase() === "CANCELLED") skipped++;
        else {
          try {
            events.push(toEvent(props));
          } catch {
            skipped++;
          }
        }
      }
    } else if (cur && nested === 0) cur.push(p);
  }
  return { events, skipped };
}
