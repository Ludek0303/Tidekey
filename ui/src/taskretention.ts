//! How long a done task stays in its note, set once for the organization. The setting is an organization record
//! (`kind: "settings"`), so it syncs and is signed like the others. An administrator's device does the removal, and
//! only for a setting an administrator saved: a member who edits the record cannot make other people's tasks vanish.

import type { ModuleData, DataRecord } from "./records";
import { canAdminister, type OrganizationSnapshot } from "./taskhistory";
import { dayOf, locateTask, type TaskRow } from "./orgtasks";

export const SETTINGS_ID = "org-settings";
/** 0 = never. The choices the settings pane offers. */
export const RETENTION_CHOICES: [number, string][] = [
  [0, "Nigdy"],
  [1, "Po miesiącu"],
  [3, "Po 3 miesiącach"],
  [6, "Po 6 miesiącach"],
  [12, "Po roku"],
  [24, "Po 2 latach"],
];

export function settingsRecord(data: ModuleData): DataRecord | undefined {
  const r = data.records[SETTINGS_ID];
  return r?.kind === "settings" ? r : undefined;
}

export function retentionMonths(data: ModuleData): number {
  const months = Number(settingsRecord(data)?.task_retention_months ?? 0);
  return Number.isInteger(months) && months > 0 && months <= 120 ? months : 0;
}

/** The months to act on: the setting, but only when its last change came from an administrator (verified in the browser). */
export function trustedRetention(data: ModuleData, identity: OrganizationSnapshot): number {
  return trustedSettings(data, identity) ? retentionMonths(data) : 0;
}

function trustedSettings(data: ModuleData, identity: OrganizationSnapshot): boolean {
  const op = data.operations.filter((o) => o.record.after.id === SETTINGS_ID).at(-1);
  if (!op) return false;
  const author = { ...identity, me: op.actor_user_id };
  return canAdminister(author) && data.checks?.[op.event_id]?.status !== "unverified";
}

/** The first day (days since 1970) a task must have been done on to stay. */
export function cutoffDay(today: Date, months: number): number {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() - months, today.getDate()));
  return dayOf(d);
}

/** Done tasks of `rows` finished before `cutoff`, grouped by note id. Tasks without a done date (`✅`) stay. */
export function expired(rows: TaskRow[], cutoff: number): Map<string, TaskRow[]> {
  const out = new Map<string, TaskRow[]>();
  for (const r of rows) if (r.done && r.done_on !== null && r.done_on < cutoff) out.set(r.note, [...(out.get(r.note) ?? []), r]);
  return out;
}

const indent = (line: string): number => line.length - line.trimStart().length;

/** The note's text without the lines of `rows`. A task with indented lines under it stays, so nothing under it is lost. */
export function removeTasks(text: string, rows: TaskRow[]): string {
  let lines = text.split("\n");
  for (const row of [...rows].sort((a, b) => b.line - a.line)) {
    const at = locateTask(lines.join("\n"), row);
    if (at === null) continue;
    const next = lines[at];
    if (next !== undefined && next.trim() && indent(next) > indent(lines[at - 1])) continue;
    lines = [...lines.slice(0, at - 1), ...lines.slice(at)];
  }
  return lines.join("\n");
}
