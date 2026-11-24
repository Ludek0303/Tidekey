// Writes to a calendar note as text changes. Each function reads the text it is given, finds the
// event and returns the changes; nothing is written here. The caller writes them to the Y.Text in
// one transaction (writeChanges), so line numbers are never kept between actions.
import type * as Y from "yjs";
import { calendar_format_event_json } from "../wasm/notes_web.js";
import { load, parseCalendar, type CalEvent } from "./model";
import { editableRule, formatRule, presetOf, presetRule, representable, type Rule } from "./recur";

export interface EventInput {
  title: string;
  startDay: number;
  /** `null` for an all-day event. */
  startMin: number | null;
  endDay: number;
  endMin: number | null;
  rule: Rule | null;
  /** The RRULE text kept as it is (a rule the form cannot write back); it wins over `rule` when set. */
  rawRule?: string;
  /** Lower-case palette name, or `null`. */
  color: string | null;
  /** Minutes before the start, or `null` for none. Absent (undefined) only in a new event's form, which then takes the default. */
  reminder?: number | null;
  description: string;
}

/** `this`: one occurrence; `following`: it and the later ones; `all`: the whole series. */
export type Scope = "this" | "following" | "all";

/** Replaces `from..to` of the text with `insert`. Positions are UTF-16 units, as in Y.Text. */
export interface Change {
  from: number;
  to: number;
  insert: string;
}

/** The event as the user saw it when it was rendered. A write finds the event again from this. */
export type EventRef = Pick<CalEvent, "id" | "line" | "raw">;

export const STALE = "Wydarzenie zmieniło się — odśwież";
// shortcut: a COUNT series is counted by expanding it over at most this many days (the core's range
// limit); upgrade: the core counts the occurrences before a day itself.
export const COUNT_SPAN_DAYS = 3700;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Id of a line written by this app: `e` and base-36 characters. Other ids (`#L…`) get a new one on the first write. */
export const isRealId = (id: string): boolean => /^e[0-9a-z]+$/.test(id);

function randomChars(n: number): string {
  let out = "";
  while (out.length < n) {
    // 252 = 36 * 7: bytes above it are dropped so every character is equally likely.
    for (const b of crypto.getRandomValues(new Uint8Array(n))) {
      if (b < 252 && out.length < n) out += ALPHABET[b % 36];
    }
  }
  return out;
}

/** `e` and five base-36 characters, not in `taken`. */
export function newEventId(taken: Set<string>): string {
  for (;;) {
    const id = `e${randomChars(5)}`;
    if (!taken.has(id)) return id;
  }
}

const idsOf = (text: string): Set<string> => new Set(parseCalendar(text).events.map((e) => e.id));

/**
 * The event a write is about, in the current text. A real id is looked up as it is. Without one,
 * the event must still be on its line and read the same; else the only event with the same text;
 * anything else (changed, gone, or ambiguous) is refused, never written by a line number alone.
 */
export function resolve(text: string, ref: EventRef): CalEvent {
  const events = parseCalendar(text).events;
  if (isRealId(ref.id)) {
    const ev = events.find((e) => e.id === ref.id);
    if (ev) return ev;
    throw new Error(STALE);
  }
  const same = events.find((e) => e.line === ref.line && e.raw === ref.raw);
  if (same) return same;
  const byText = events.filter((e) => e.raw === ref.raw);
  if (byText.length === 1) return byText[0];
  throw new Error(STALE);
}

/** The rule the form can edit; `null` for a single event and for a rule kept as text. */
export function ruleOf(ev: CalEvent): Rule | null {
  if (ev.rrule === null || !ev.ruleSupported) return null;
  const rule = editableRule(ev.rrule);
  return rule !== null && representable(rule, ev.startDay) ? rule : null;
}

/** Canonical lines of an event (the core's `format_event`); throws if the core rejects the fields. */
function formatLines(input: EventInput, id: string, exdates: number[]): string[] {
  const json = JSON.stringify({
    id,
    title: input.title,
    startDay: input.startDay,
    startMin: input.startMin,
    endDay: input.endDay,
    endMin: input.endMin,
    rrule: input.rawRule ?? (input.rule === null ? null : formatRule(input.rule)),
    exdates,
    color: input.color,
    reminder: input.reminder ?? null,
    description: input.description,
  });
  const out = calendar_format_event_json(json);
  if (out === "") throw new Error("Nieprawidłowe wydarzenie");
  return out.split("\n");
}

function inputOf(ev: CalEvent): EventInput {
  const rule = ruleOf(ev);
  return {
    title: ev.title,
    startDay: ev.startDay,
    startMin: ev.startMin,
    endDay: ev.endDay,
    endMin: ev.endMin,
    rule,
    rawRule: ev.rrule !== null && rule === null ? ev.rrule : undefined,
    color: ev.color,
    reminder: ev.reminder,
    description: ev.description,
  };
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  return starts;
}

/** Replaces the lines `a..=b` (0-based) with `lines`. */
function replaceLines(text: string, a: number, b: number, lines: string[]): Change {
  const all = text.split("\n");
  const starts = lineStarts(all);
  return { from: starts[a], to: starts[b] + all[b].length, insert: lines.join("\n") };
}

/** Removes the lines `a..=b` together with one newline. */
function removeLines(text: string, a: number, b: number): Change {
  const all = text.split("\n");
  const starts = lineStarts(all);
  if (b + 1 < all.length) return { from: starts[a], to: starts[b + 1], insert: "" };
  // The last line has no newline after it, so the newline before the first removed line goes instead.
  return a > 0 ? { from: starts[a] - 1, to: text.length, insert: "" } : { from: 0, to: text.length, insert: "" };
}

/** Appends lines at the end, after a newline if the text does not end with one. */
function appendLines(text: string, lines: string[]): Change {
  const sep = text !== "" && !text.endsWith("\n") ? "\n" : "";
  return { from: text.length, to: text.length, insert: `${sep}${lines.join("\n")}\n` };
}

function replaceEvent(text: string, ev: CalEvent, patch: Partial<EventInput> & { exdates: number[]; id: string }): Change {
  const { id, exdates, ...rest } = patch;
  return replaceLines(text, ev.line, ev.lineEnd, formatLines({ ...inputOf(ev), ...rest }, id, exdates));
}

function appendEvent(text: string, input: EventInput, id: string, exdates: number[]): Change {
  return appendLines(text, formatLines(input, id, exdates));
}

/** Occurrences of this event that start before `day`, from the series start (as the core expands them). */
function countBefore(text: string, ev: CalEvent, day: number): number {
  const loaded = load(text, ev.startDay, day - 1);
  if (loaded.truncated) throw new Error("Nie da się policzyć wystąpień tej serii");
  return loaded.occurrences.filter((o) => o.event.line === ev.line && o.startDay < day).length;
}

const mod7 = (n: number): number => ((n % 7) + 7) % 7;

/**
 * The rule with every occurrence moved by `delta` days, or `null` when no exact shift exists. A
 * shifted weekly rule moves its weekdays; a monthly one its day of the month (within 1..28).
 */
export function shiftRule(rule: Rule, delta: number): Rule | null {
  if (delta === 0) return rule;
  if (rule.byMonth.length > 0) return null;
  const plain = rule.byDay.length === 0 && rule.byMonthDay.length === 0;
  switch (rule.freq) {
    case "DAILY":
    case "YEARLY":
      return plain ? rule : null;
    case "WEEKLY": {
      // Weeks of interval 2 or more are aligned to the start's week, so a shift would move them too.
      const weekdays = rule.byDay.every((d) => d.n === null);
      if (rule.interval > 1 || rule.byMonthDay.length > 0 || !weekdays) return null;
      const byDay = rule.byDay.map((d) => ({ n: null, wd: mod7(d.wd + delta) })).sort((a, b) => a.wd - b.wd);
      return { ...rule, byDay };
    }
    case "MONTHLY": {
      if (rule.byDay.length > 0 || rule.byMonthDay.length !== 1) return null;
      const day = rule.byMonthDay[0] + delta;
      return day >= 1 && day <= 28 ? { ...rule, byMonthDay: [day] } : null;
    }
  }
}

/**
 * Where a series goes when its occurrence is moved to another day (scope "all"). A preset follows
 * the new start; a custom rule is shifted; when that is not exact, the start stays and only the times apply.
 */
function planStart(ev: CalEvent, occDay: number, input: EventInput): { startDay: number; rule: Rule | null; fixed: boolean } {
  const delta = input.startDay - occDay;
  if (delta === 0) return { startDay: ev.startDay, rule: input.rule, fixed: false };
  const startDay = ev.startDay + delta;
  if (input.rule === null) return { startDay: ev.startDay, rule: null, fixed: true };
  const preset = presetOf(input.rule, input.startDay);
  if (preset !== "custom") return { startDay, rule: presetRule(preset, startDay), fixed: false };
  const shifted = shiftRule(input.rule, delta);
  return shifted === null ? { startDay: ev.startDay, rule: input.rule, fixed: true } : { startDay, rule: shifted, fixed: false };
}

/** `true` when a "all" edit with a moved date keeps the series' start (the form then shows a notice). */
export function keepsSeriesStart(ev: CalEvent, occDay: number, input: EventInput): boolean {
  return ev.rrule !== null && planStart(ev, occDay, input).fixed;
}

/** Adds an event at the end of the note. */
export function addEvent(text: string, input: EventInput): Change[] {
  return [appendEvent(text, input, newEventId(idsOf(text)), [])];
}

/**
 * Gives an event without a real id one: the ` ^e…` suffix at the end of its first line, and nothing
 * else, so the rest of the event stays byte for byte (it is canonicalised only on a real save).
 */
export function assignId(text: string, ref: EventRef): Change[] {
  const ev = resolve(text, ref);
  if (isRealId(ev.id)) return [];
  const lines = text.split("\n");
  // A CRLF note keeps its "\r" at the end of the line: the id goes before it.
  const end = lines[ev.line].length - (lines[ev.line].endsWith("\r") ? 1 : 0);
  const at = lineStarts(lines)[ev.line] + end;
  return [{ from: at, to: at, insert: ` ^${newEventId(idsOf(text))}` }];
}

/** Edits an event. `occDay` is the day of the occurrence that was opened; a single event ignores the scope. */
export function updateEvent(text: string, ref: EventRef, occDay: number, scope: Scope, input: EventInput): Change[] {
  const ev = resolve(text, ref);
  const taken = idsOf(text);
  const eventId = isRealId(ev.id) ? ev.id : newEventId(taken);
  if (ev.rrule === null) return [replaceEvent(text, ev, { ...input, id: eventId, exdates: [] })];

  if (scope === "all" || (scope === "following" && occDay <= ev.startDay)) {
    // The series moves with the occurrence the user edited, when its rule can move exactly.
    const plan = planStart(ev, occDay, input);
    const span = input.endDay - input.startDay;
    return [
      replaceEvent(text, ev, { ...input, startDay: plan.startDay, endDay: plan.startDay + span, rule: plan.rule, id: eventId, exdates: ev.exdates }),
    ];
  }

  const oldRule = ruleOf(ev);
  if (scope === "this") {
    // A rule kept as text stays as it is: replaceEvent keeps the `rawRule` of the event.
    const exdates = ev.exdates.includes(occDay) ? ev.exdates : [...ev.exdates, occDay];
    const single = newEventId(new Set([...taken, eventId]));
    return [
      replaceEvent(text, ev, { id: eventId, exdates, rule: oldRule }),
      appendEvent(text, { ...input, rule: null, rawRule: undefined }, single, []),
    ];
  }

  // "following": the old series ends the day before, the new one starts at the form's start.
  if (oldRule === null) throw new Error("Tej reguły nie można podzielić");
  if (oldRule.count !== null && occDay - ev.startDay > COUNT_SPAN_DAYS) throw new Error("Tej serii nie da się podzielić");
  const before = countBefore(text, ev, occDay);
  const oldEnd = { ...oldRule, count: null, until: occDay - 1 };
  const changes = [replaceEvent(text, ev, { id: eventId, exdates: ev.exdates.filter((d) => d < occDay), rule: oldEnd })];
  const newRule = input.rule === null ? null : { ...input.rule };
  // A counted series keeps its total: the new series gets the occurrences that are left.
  if (newRule !== null && oldRule.count !== null && input.rule?.count === oldRule.count) {
    newRule.count = Math.max(1, oldRule.count - before);
  }
  const single = newEventId(new Set([...taken, eventId]));
  changes.push(appendEvent(text, { ...input, rule: newRule }, single, ev.exdates.filter((d) => d >= occDay)));
  return changes;
}

/** Deletes an event, one occurrence of it, or the occurrence and the later ones. */
export function deleteEvent(text: string, ref: EventRef, occDay: number, scope: Scope): Change[] {
  const ev = resolve(text, ref);
  if (ev.rrule === null || scope === "all" || (scope === "following" && occDay <= ev.startDay)) {
    return [removeLines(text, ev.line, ev.lineEnd)];
  }
  const eventId = isRealId(ev.id) ? ev.id : newEventId(idsOf(text));
  const oldRule = ruleOf(ev);
  if (scope === "this") {
    const exdates = ev.exdates.includes(occDay) ? ev.exdates : [...ev.exdates, occDay];
    return [replaceEvent(text, ev, { id: eventId, exdates, rule: oldRule })];
  }
  if (oldRule === null) throw new Error("Tej reguły nie można podzielić");
  return [
    replaceEvent(text, ev, {
      id: eventId,
      exdates: ev.exdates.filter((d) => d < occDay),
      rule: { ...oldRule, count: null, until: occDay - 1 },
    }),
  ];
}

/** The text after the changes. Changes must not overlap; they may be given in any order. */
export function applyChanges(text: string, changes: Change[]): string {
  return [...changes]
    .sort((a, b) => b.from - a.from)
    .reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text);
}

/**
 * Writes the changes to the note's text in one Y transaction; `origin` is the undo-tracked origin.
 * With `undo`, the action is its own undo step: Yjs would otherwise merge quick actions into one.
 */
export function writeChanges(doc: Y.Doc, changes: Change[], origin: unknown, undo?: Y.UndoManager): void {
  const ytext = doc.getText("content");
  undo?.stopCapturing();
  doc.transact(() => {
    for (const c of [...changes].sort((a, b) => b.from - a.from)) {
      if (c.to > c.from) ytext.delete(c.from, c.to - c.from);
      if (c.insert !== "") ytext.insert(c.from, c.insert);
    }
  }, origin);
  undo?.stopCapturing();
}
