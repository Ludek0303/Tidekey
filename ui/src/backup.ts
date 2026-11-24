//! Whole-space backup from the app: every note with its attachments in one ZIP (transfer.ts exportAll), the day of
//! the last copy per space, and a reminder at start. The copy is plain text; Settings says so.

import type { Bridge } from "./bridge";
import { DAY_MS } from "./calendar/dates";
import type { BackupReminder } from "./settings";
import { count, exportAll } from "./transfer";
import { toast } from "./widgets";

const PERIOD: Record<BackupReminder, number> = { week: 7, month: 30, off: Infinity };
// "off" never reaches the toast: reminderDue is false for it.
const REMINDER_TEXT: Record<BackupReminder, string> = {
  week: "Minął tydzień od ostatniej kopii notatek.",
  month: "Minął miesiąc od ostatniej kopii notatek.",
  off: "",
};
const KEY = (spaceKey: string) => `notes.lastBackup.v1.${spaceKey}`;

// The open space, set by backupReminder at start, so the Settings pane can make a copy.
let target: { bridge: Bridge; spaceKey: string } | null = null;
export const backupTarget = (): { bridge: Bridge; spaceKey: string } | null => target;

/** When the space was last copied, or null (never, or the storage is blocked). */
export function lastBackup(spaceKey: string): Date | null {
  try {
    const time = Date.parse(localStorage.getItem(KEY(spaceKey)) ?? "");
    return Number.isNaN(time) ? null : new Date(time);
  } catch {
    return null;
  }
}

function remember(spaceKey: string): void {
  try { localStorage.setItem(KEY(spaceKey), new Date().toISOString()); } catch { /* not remembered */ }
}

/** Due when the reminder is on and the last copy is at least a week (or a month) old. A space never copied is due. */
export function reminderDue(last: Date | null, reminder: BackupReminder, now = new Date()): boolean {
  if (reminder === "off") return false;
  return !last || now.getTime() - last.getTime() >= PERIOD[reminder] * DAY_MS;
}

export function describeLastBackup(spaceKey: string | null, now = new Date()): string {
  const last = spaceKey ? lastBackup(spaceKey) : null;
  if (!last) return "Nie zrobiono jeszcze kopii.";
  const days = Math.floor((now.getTime() - last.getTime()) / DAY_MS);
  const ago = days < 1 ? "dzisiaj" : `${count(days, "dzień", "dni", "dni")} temu`;
  return `Ostatnia kopia: ${last.toLocaleDateString("pl-PL")} (${ago}).`;
}

/** Downloads the copy and remembers the day, when it was made (the user may cancel the confirmation). */
export async function backupNow(bridge: Bridge, spaceKey: string): Promise<boolean> {
  const name = await bridge.call<string>("space_name").catch(() => "");
  const made = await exportAll(bridge, name);
  if (made) remember(spaceKey);
  return made;
}

/** Called at start: remembers the open space and, when a copy is due, offers one in a toast. */
export function backupReminder(bridge: Bridge, spaceKey: string | null, reminder: BackupReminder, now = new Date()): void {
  if (!spaceKey) return;
  target = { bridge, spaceKey };
  const last = lastBackup(spaceKey);
  if (!reminderDue(last, reminder, now)) return;
  const text = last === null ? "Nie masz jeszcze kopii zapasowej notatek." : REMINDER_TEXT[reminder];
  toast(text, false, { label: "Pobierz", run: () => void backupNow(bridge, spaceKey) });
}
