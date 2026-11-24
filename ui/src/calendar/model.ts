// Reads calendar notes through the core (WASM): events and their occurrences. Nothing here writes.
import { calendar_expand_json, calendar_parse_json } from "../wasm/notes_web.js";

export interface CalEvent {
  /** `^id` of the line, or `L<line>` when the line has none (see the core's `Event::id`). */
  id: string;
  /** 0-based first line of the event; `lineEnd` is its last line, description included. */
  line: number;
  lineEnd: number;
  title: string;
  startDay: number;
  /** `null` for an all-day event. */
  startMin: number | null;
  endDay: number;
  endMin: number | null;
  /** Canonical RRULE text, or `null` for a single event. */
  rrule: string | null;
  /** `false` for a rule this app cannot edit (e.g. BYSETPOS from Google): it is shown, not changed. */
  ruleSupported: boolean;
  exdates: number[];
  /** Palette name in lower case, or `null` (accent colour). */
  color: string | null;
  /** Minutes before the start when the user is reminded, or `null` for none (the core's `🔔`). */
  reminder: number | null;
  description: string;
  /** The event's lines as they were read (`line`..`lineEnd`): checked before a write, see edit.ts. */
  raw: string;
}

export interface Occurrence {
  event: CalEvent;
  startDay: number;
  startMin: number | null;
  endDay: number;
  endMin: number | null;
}

/** An event that is not a line of a note (an organization record, a task): no line, no colour, no rule the app edits. */
export function unsavedEvent(
  title: string,
  span: Omit<Occurrence, "event">,
  extra: Partial<Pick<CalEvent, "id" | "rrule" | "description">> = {},
): CalEvent {
  return { id: "", line: 0, lineEnd: 0, title, ...span, rrule: null, ruleSupported: false, exdates: [], color: null, reminder: null, description: "", raw: "", ...extra };
}

export interface Loaded {
  isCalendar: boolean;
  events: CalEvent[];
  occurrences: Occurrence[];
  /** A work or step limit cut the occurrences: some may be missing from the range. */
  truncated: boolean;
}

// The palette of the event dialog (like Google Calendar). The stored colour is the lower-case name.
export const PALETTE: [name: string, hex: string][] = [
  ["Pomidorowy", "#d50000"],
  ["Mandarynkowy", "#f4511e"],
  ["Bananowy", "#f6bf26"],
  ["Bazyliowy", "#0b8043"],
  ["Szałwiowy", "#33b679"],
  ["Pawi", "#039be5"],
  ["Jagodowy", "#3f51b5"],
  ["Lawendowy", "#7986cb"],
  ["Winogronowy", "#8e24aa"],
  ["Grafitowy", "#616161"],
];
const HEX = new Map(PALETTE.map(([name, hex]) => [name.toLowerCase(), hex]));

/** The hex colour of a stored colour name; `null` for no colour or an unknown name (the accent is used). */
export function colorHex(name: string | null): string | null {
  return name === null ? null : (HEX.get(name.toLowerCase()) ?? null);
}

export function parseCalendar(text: string): { isCalendar: boolean; events: CalEvent[] } {
  const parsed = JSON.parse(calendar_parse_json(text)) as { isCalendar: boolean; events: Omit<CalEvent, "raw">[] };
  const lines = text.split("\n");
  return {
    isCalendar: parsed.isCalendar,
    events: parsed.events.map((e) => ({ ...e, raw: lines.slice(e.line, e.lineEnd + 1).join("\n") })),
  };
}

/** `true` when the note's front matter says `typ: kalendarz`. Without the wasm (it failed to load) no note is one. */
export function isCalendarText(text: string): boolean {
  if (!text.startsWith("---")) return false;
  try {
    return parseCalendar(text).isCalendar;
  } catch {
    return false;
  }
}

/** Events and the occurrences overlapping `fromDay..=toDay`, so a note with many events costs one range. */
export function load(text: string, fromDay: number, toDay: number): Loaded {
  const { isCalendar, events } = parseCalendar(text);
  if (!isCalendar) return { isCalendar, events: [], occurrences: [], truncated: false };
  const expanded = JSON.parse(calendar_expand_json(text, fromDay, toDay)) as {
    occurrences: {
      event: number;
      startDay: number;
      startMin: number | null;
      endDay: number;
      endMin: number | null;
    }[];
    truncated: boolean;
  };
  const occurrences = expanded.occurrences.map((o) => ({
    event: events[o.event],
    startDay: o.startDay,
    startMin: o.startMin,
    endDay: o.endDay,
    endMin: o.endMin,
  }));
  return { isCalendar, events, occurrences, truncated: expanded.truncated };
}

// A wikilink `[[Notatka]]`, with an optional `|alias` or `#heading` that the target name leaves out.
export const WIKILINK = /\[\[([^\[\]|#\n]+)(?:[|#][^\[\]\n]*)?\]\]/;

/** The distinct note names the texts link to, in order. */
export function wikilinks(text: string): string[] {
  const names = [...text.matchAll(new RegExp(WIKILINK.source, "g"))].map((m) => m[1].trim()).filter((n) => n !== "");
  return [...new Set(names)];
}

/** A note name as a wikilink target: the characters that would end or change the link are removed. */
export const cleanNoteName = (name: string): string => name.replace(/[\[\]|#\n]/g, "").trim();
