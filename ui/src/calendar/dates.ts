// Calendar dates are day numbers (days since 1970-01-01), as in the core (ARCHITEKTURA §4.16b).
// A day is a number and a time is minutes since midnight, so no local time zone is involved.

export const DAY_MS = 86_400_000;
export const MINUTES = 1440;

const MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const MONTHS_GEN = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
const MONTHS_SHORT = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
export const WEEKDAYS = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];
export const WEEKDAYS_SHORT = ["pon", "wt", "śr", "czw", "pt", "sob", "niedz"];
// Accusative, as in "w środę": used by the recurrence texts.
export const WEEKDAYS_ACC = ["poniedziałek", "wtorek", "środę", "czwartek", "piątek", "sobotę", "niedzielę"];

export interface Ymd {
  y: number;
  /** 1–12 */
  m: number;
  d: number;
}

export function dayOf(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

/** Local midnight of a day number, as ms since the epoch. */
export function localMidnight(day: number): number {
  const { y, m, d } = ymdOf(day);
  return new Date(y, m - 1, d).getTime();
}

/** A local time in ms as its day number and its minute of that day: the calendar's view of an instant. */
export function dayAndMinute(ms: number): [number, number] {
  const d = new Date(ms);
  return [dayOf(d.getFullYear(), d.getMonth() + 1, d.getDate()), d.getHours() * 60 + d.getMinutes()];
}

/** The next full hour after `now`: its day and its minute of that day. Past midnight the Date constructor makes it tomorrow. */
export function nextFullHour(now: Date): { day: number; startMin: number } {
  const hour = now.getHours() + 1;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.floor(hour / 24));
  return { day: dayOf(next.getFullYear(), next.getMonth() + 1, next.getDate()), startMin: (hour % 24) * 60 };
}

export function ymdOf(day: number): Ymd {
  const t = new Date(day * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday. */
export function weekdayOf(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

export function daysInMonth(y: number, m: number): number {
  return dayOf(y, m + 1, 0) - dayOf(y, m, 1) + 1;
}

export function startOfWeek(day: number): number {
  return day - weekdayOf(day);
}

/** The same day number in another month, clamped to that month's length (31 Jan + 1 month = 28 Feb). */
export function addMonths(day: number, n: number): number {
  const { y, m, d } = ymdOf(day);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return dayOf(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** The six weeks shown by the month view, Monday first. */
export function monthGrid(day: number): number[] {
  const { y, m } = ymdOf(day);
  const first = startOfWeek(dayOf(y, m, 1));
  return Array.from({ length: 42 }, (_, i) => first + i);
}

export function isoDay(day: number): string {
  const { y, m, d } = ymdOf(day);
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

/** `RRRR-MM-DD` to a day number, or `null` for anything else (including 2026-02-30). */
export function parseIsoDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = dayOf(y, mo, d);
  const back = ymdOf(day);
  return back.y === y && back.m === mo && back.d === d ? day : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Minutes since midnight as `GG:MM`. */
export function hhmm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** `GG:MM` as minutes since midnight, or `null`. */
export function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function monthTitle(day: number): string {
  const { y, m } = ymdOf(day);
  return `${MONTHS[m - 1]} ${y}`;
}

/** `20–26 paź 2026`, or across months and years `27 paź – 2 lis 2026`. */
export function weekTitle(day: number): string {
  const a = ymdOf(startOfWeek(day));
  const b = ymdOf(startOfWeek(day) + 6);
  if (a.y !== b.y) return `${a.d} ${MONTHS_SHORT[a.m - 1]} ${a.y} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${MONTHS_SHORT[a.m - 1]} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
  return `${a.d}–${b.d} ${MONTHS_SHORT[a.m - 1]} ${a.y}`;
}

/** `środa, 21 października 2026`. */
export function dayTitle(day: number): string {
  const { y, m, d } = ymdOf(day);
  return `${WEEKDAYS[weekdayOf(day)]}, ${d} ${MONTHS_GEN[m - 1]} ${y}`;
}

/** `22 października`, without the weekday or the year. */
export function shortDate(day: number): string {
  const { m, d } = ymdOf(day);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

/** `5 listopada 2026`, for "do 5 listopada 2026". */
export function longDate(day: number): string {
  const { y, m, d } = ymdOf(day);
  return `${d} ${MONTHS_GEN[m - 1]} ${y}`;
}

export function dayNumber(day: number): number {
  return ymdOf(day).d;
}

/** Polish plural: `plural(n, "dzień", "dni", "dni")` picks the form that goes with n. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const last = n % 10;
  const tens = n % 100;
  return last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? few : many;
}
