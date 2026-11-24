// Calendar reminders: which events of the calendar notes have their reminder due now. Pure, the caller shows them.
import { dayAndMinute, ymdOf } from "./dates";
import { load } from "./model";

const MINUTE_MS = 60_000;
// The longest reminder is a week ahead, so an event starts at most this many days after today.
const AHEAD_DAYS = 7;

export interface DueReminder {
  /** Stable per event and occurrence: the id and the start in ms. */
  key: string;
  title: string;
  /** Start of the occurrence, ms since the epoch (local time). */
  start: number;
}

/** The start of an occurrence in local time: the minute of its day, or midnight for an all-day event. */
function startMs(day: number, min: number | null): number {
  const { y, m, d } = ymdOf(day);
  return new Date(y, m - 1, d, 0, min ?? 0).getTime();
}

/** The events of the texts (calendar notes) whose reminder window `start - reminder ≤ now < start` holds. */
export function dueReminders(texts: string[], now: number): DueReminder[] {
  const [today] = dayAndMinute(now);
  const due: DueReminder[] = [];
  for (const text of texts) {
    for (const occ of load(text, today, today + AHEAD_DAYS).occurrences) {
      const { reminder, id, title } = occ.event;
      if (reminder === null) continue;
      const start = startMs(occ.startDay, occ.startMin);
      if (start - reminder * MINUTE_MS <= now && now < start) due.push({ key: `${id}@${start}`, title, start });
    }
  }
  return due;
}
