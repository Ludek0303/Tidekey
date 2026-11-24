// Recurrence: the RRULE subset of the core (ARCHITEKTURA §4.16b), the form presets that map to it,
// and the Polish text of a rule. Pure functions; `startDay` is the day the series starts on.
import { daysInMonth, dayOf, longDate, plural, shortDate, WEEKDAYS_ACC, weekdayOf, ymdOf } from "./dates";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** Mirror of the core `Rule`. Weekdays are Monday = 0; `n` is an ordinal (`-1` = the last one). */
export interface Rule {
  freq: Freq;
  interval: number;
  /** 1–12 */
  byMonth: number[];
  byDay: { n: number | null; wd: number }[];
  byMonthDay: number[];
  count: number | null;
  /** Inclusive day number. */
  until: number | null;
}

/** Shown instead of a rule this app cannot edit (ruleSupported false). */
export const READ_ONLY_RULE = "Niestandardowa reguła (tylko do odczytu)";

/** Form presets of the "Powtarzanie" select, in the order Google Calendar shows them. */
export type Preset = "none" | "daily" | "weekly" | "monthly-nth" | "monthly-day" | "yearly" | "weekdays" | "custom";

const CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const FREQS: Freq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const PRESETS: Preset[] = ["daily", "weekly", "monthly-nth", "monthly-day", "yearly", "weekdays"];

const pad = (n: number): string => String(n).padStart(2, "0");

/** The rule as the core writes it, e.g. `FREQ=WEEKLY;BYDAY=WE,FR;COUNT=5`. `null` for an invalid FREQ. */
export function parseRule(s: string): Rule | null {
  let freq: Freq | null = null;
  const rule: Rule = { freq: "DAILY", interval: 1, byMonth: [], byDay: [], byMonthDay: [], count: null, until: null };
  for (const part of s.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim().toUpperCase();
    if (key === "FREQ") {
      if (!FREQS.includes(value as Freq)) return null;
      freq = value as Freq;
    } else if (key === "INTERVAL") {
      const n = Number(value);
      rule.interval = Number.isInteger(n) && n >= 1 ? n : 1;
    } else if (key === "BYMONTH") {
      for (const token of value.split(",")) {
        const n = Number(token.trim());
        if (Number.isInteger(n) && n >= 1 && n <= 12 && !rule.byMonth.includes(n)) rule.byMonth.push(n);
      }
    } else if (key === "BYDAY") {
      for (const token of value.split(",")) {
        const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token.trim());
        const n = m?.[1] ? Number(m[1]) : null;
        if (m && (n === null || (n !== 0 && Math.abs(n) <= 53))) rule.byDay.push({ n, wd: CODES.indexOf(m[2]) });
      }
    } else if (key === "BYMONTHDAY") {
      for (const token of value.split(",")) {
        const n = Number(token.trim());
        if (Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31) rule.byMonthDay.push(n);
      }
    } else if (key === "COUNT") {
      const n = Number(value);
      rule.count = Number.isInteger(n) && n >= 1 ? n : null;
    } else if (key === "UNTIL") {
      const m = /^(\d{4})(\d{2})(\d{2})(T.*)?$/.exec(value);
      if (!m) return null;
      rule.until = dayOf(Number(m[1]), Number(m[2]), Number(m[3]));
    }
  }
  if (freq === null) return null;
  rule.freq = freq;
  return rule;
}

/**
 * Whether the form shows every part of the rule and writes it back the same: a rule with more (BYMONTH,
 * a weekly ordinal, a monthly day that is not the start's) is kept as text and shown read-only.
 */
export function representable(rule: Rule, startDay: number): boolean {
  if (rule.byMonth.length > 0) return false;
  const { d } = ymdOf(startDay);
  const wd = weekdayOf(startDay);
  switch (rule.freq) {
    case "DAILY":
      return rule.byDay.length === 0 && rule.byMonthDay.length === 0;
    case "WEEKLY":
      return rule.byMonthDay.length === 0 && rule.byDay.every((x) => x.n === null);
    case "MONTHLY":
      return (
        (rule.byDay.length === 1 && rule.byMonthDay.length === 0 && rule.byDay[0].n === ordinalOf(startDay) && rule.byDay[0].wd === wd) ||
        (rule.byDay.length === 0 && rule.byMonthDay.length === 1 && rule.byMonthDay[0] === d)
      );
    case "YEARLY":
      return rule.byDay.length === 0 && rule.byMonthDay.length === 0;
  }
}

/** The rule as its own text, for the form: `null` unless writing it back gives the very same text. */
export function editableRule(text: string): Rule | null {
  const rule = parseRule(text);
  return rule !== null && formatRule(rule) === text ? rule : null;
}

export function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.n ?? ""}${CODES[d.wd]}`).join(",")}`);
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) {
    const { y, m, d } = ymdOf(rule.until);
    parts.push(`UNTIL=${String(y).padStart(4, "0")}${pad(m)}${pad(d)}`);
  }
  return parts.join(";");
}

/** The ordinal of a day within its month: 3 for the third Wednesday, -1 for the last one. */
export function ordinalOf(startDay: number): number {
  const { y, m, d } = ymdOf(startDay);
  return d + 7 > daysInMonth(y, m) ? -1 : Math.floor((d - 1) / 7) + 1;
}

/** The rule a preset stands for when the series starts on `startDay`; `null` for "none" and "custom". */
export function presetRule(preset: Preset, startDay: number): Rule | null {
  const base: Rule = { freq: "DAILY", interval: 1, byMonth: [], byDay: [], byMonthDay: [], count: null, until: null };
  const wd = weekdayOf(startDay);
  switch (preset) {
    case "daily":
      return base;
    case "weekly":
      return { ...base, freq: "WEEKLY", byDay: [{ n: null, wd }] };
    case "monthly-nth":
      return { ...base, freq: "MONTHLY", byDay: [{ n: ordinalOf(startDay), wd }] };
    case "monthly-day":
      return { ...base, freq: "MONTHLY", byMonthDay: [ymdOf(startDay).d] };
    case "yearly":
      return { ...base, freq: "YEARLY" };
    case "weekdays":
      return { ...base, freq: "WEEKLY", byDay: [0, 1, 2, 3, 4].map((d) => ({ n: null, wd: d })) };
    default:
      return null;
  }
}

/** The select's options with the labels for this start day. */
export function presetOptions(startDay: number): { value: Preset; label: string }[] {
  const { d } = ymdOf(startDay);
  const wd = WEEKDAYS_ACC[weekdayOf(startDay)];
  const nth = ordinalOf(startDay);
  return [
    { value: "none", label: "Nie powtarza się" },
    { value: "daily", label: "Codziennie" },
    { value: "weekly", label: `Co tydzień w ${wd}` },
    { value: "monthly-nth", label: `Co miesiąc w ${nth === -1 ? "ostatnią" : `${nth}.`} ${wd}` },
    { value: "monthly-day", label: `Co miesiąc dnia ${d}` },
    { value: "yearly", label: `Co roku ${shortDate(startDay)}` },
    { value: "weekdays", label: "W każdy dzień roboczy (pon.–pt.)" },
    { value: "custom", label: "Niestandardowe…" },
  ];
}

/** The preset a stored rule matches for this start day, or "custom" when no preset gives exactly that rule. */
export function presetOf(rule: Rule | null, startDay: number): Preset {
  if (rule === null) return "none";
  const key = formatRule(rule);
  const hit = PRESETS.find((p) => {
    const r = presetRule(p, startDay);
    return r !== null && formatRule(r) === key;
  });
  return hit ?? "custom";
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} i ${items[items.length - 1]}`;
}

/** The rule in words, as the event popover shows it: "Co tydzień w środę i piątek, 5 razy". */
export function describeRule(rule: Rule, startDay: number): string {
  const n = rule.interval;
  let text: string;
  if (rule.freq === "DAILY") {
    text = n === 1 ? "Codziennie" : `Co ${n} ${plural(n, "dzień", "dni", "dni")}`;
  } else if (rule.freq === "WEEKLY") {
    const every = n === 1 ? "Co tydzień" : `Co ${n} ${plural(n, "tydzień", "tygodnie", "tygodni")}`;
    const days = rule.byDay.map((d) => WEEKDAYS_ACC[d.wd]);
    text = days.length > 0 ? `${every} w ${joinList(days)}` : every;
  } else if (rule.freq === "MONTHLY") {
    const every = n === 1 ? "Co miesiąc" : `Co ${n} ${plural(n, "miesiąc", "miesiące", "miesięcy")}`;
    if (rule.byDay.length > 0) {
      const { n: ord, wd } = rule.byDay[0];
      const which = ord === null ? "" : `${ord === -1 ? "ostatnią" : `${ord}.`} `;
      text = `${every} w ${which}${WEEKDAYS_ACC[wd]}`;
    } else {
      text = `${every} dnia ${joinList(rule.byMonthDay.map(String))}`;
    }
  } else {
    const every = n === 1 ? "Co rok" : `Co ${n} ${plural(n, "rok", "lata", "lat")}`;
    text = `${every} ${shortDate(startDay)}`;
  }
  if (rule.count !== null) text += `, ${rule.count} ${plural(rule.count, "raz", "razy", "razy")}`;
  if (rule.until !== null) text += `, do ${longDate(rule.until)}`;
  return text;
}
