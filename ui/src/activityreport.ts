//! The "Raport osoby" of the activity view: one person's signed task events in a date range, as Markdown. It reads the
//! same events as the activity view (taskhistory), so the report and the view agree. Pure: the download is in insights.ts.

import type { TaskRow } from "./orgtasks";
import { belongs, completionDay, completions, currentEvents, ordered, personName, stats, type OrganizationSnapshot, type TaskEvent } from "./taskhistory";

export interface ReportOptions {
  organization: string;
  /** A member's user_id. */
  person: string;
  /** Inclusive calendar days, YYYY-MM-DD, in `zone`. */
  from: string;
  to: string;
  generatedAt: Date;
  zone: string;
}

const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
const pad = (n: number): string => String(n).padStart(2, "0");
/** A local calendar day as YYYY-MM-DD. */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The day of a `due` value: days since 1970, as the task rows keep them. */
const dueDay = (days: number): string => new Date(days * 86400000).toISOString().slice(0, 10);
const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The note a task lives in, by its file name without `.md`. */
function noteName(tasks: TaskRow[], taskId: string): string {
  const row = tasks.find((t) => t.block === taskId);
  return row ? row.path.replace(/^.*\//, "").replace(/\.md$/, "") : "";
}

export function activityReport(s: OrganizationSnapshot, tasks: TaskRow[], o: ReportOptions): string {
  const mine = (e: TaskEvent): boolean => {
    const day = completionDay(e, o.zone);
    return belongs(e, o.person) && day >= o.from && day <= o.to;
  };
  const done = completions(s.events, tasks).filter(mine);
  const current = currentEvents(s.events, tasks).filter(mine);
  const assigned = current.filter((e) => e.kind === "TaskAssigned");
  const dues = current.filter((e) => e.kind === "TaskDueChanged");
  const reopened = current.filter((e) => e.kind === "TaskReopened");

  const line = (e: TaskEvent): string => {
    const title = oneLine(e.after.title);
    switch (e.kind) {
      case "TaskCompleted": {
        const note = noteName(tasks, e.after.task_id);
        return `- ✅ Zrobione: ${title}${note ? ` (${oneLine(note)})` : ""}`;
      }
      case "TaskAssigned":
        return `- 📌 Przypisano: ${title}`;
      case "TaskDueChanged":
        return `- 📅 Nowy termin: ${title} — ${e.after.due === null ? "bez terminu" : dueDay(e.after.due)}`;
      default:
        return `- ↩ Ponownie otwarte: ${title}`;
    }
  };

  const byDay = new Map<string, string[]>();
  for (const e of ordered([...done, ...assigned, ...dues, ...reopened])) {
    const day = completionDay(e, o.zone);
    byDay.set(day, [...(byDay.get(day) ?? []), line(e)]);
  }

  const st = stats(done);
  const out = [
    `# Raport aktywności: ${oneLine(personName(s, o.person))}`,
    `Organizacja: ${oneLine(o.organization)} · Okres: ${o.from} – ${o.to} · Wygenerowano: ${o.generatedAt.toLocaleString("pl-PL", { timeZone: o.zone, dateStyle: "medium", timeStyle: "short" })}`,
    "",
    "## Podsumowanie",
    `- Zrobione: ${done.length} (punkty trudności: ${st.points}, nieocenione: ${st.unrated})`,
    `- Przypisane: ${assigned.length}`,
    `- Zmiany terminu: ${dues.length}`,
    `- Ponownie otwarte: ${reopened.length}`,
    "",
  ];
  if (byDay.size === 0) out.push("Brak aktywności w tym okresie.", "");
  for (const day of [...byDay.keys()].sort()) out.push(`## ${dayLabel(day)}`, ...byDay.get(day)!, "");
  return out.join("\n");
}

/** `raport-<imie>-<od>-<do>.md`: Polish letters folded to ASCII, every other run of characters becomes one dash. */
export function reportFileName(name: string, from: string, to: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `raport-${slug || "osoba"}-${from}-${to}.md`;
}

/** The quick ranges of the report form, as local calendar days (inclusive). Weeks run Monday to Sunday. */
export function presetRange(preset: "last7" | "week" | "month" | "lastMonth", today: Date): { from: string; to: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  if (preset === "last7") return { from: dayKey(new Date(y, m, d - 6)), to: dayKey(today) };
  if (preset === "week") {
    const monday = new Date(y, m, d - ((today.getDay() + 6) % 7));
    return { from: dayKey(monday), to: dayKey(new Date(y, m, d - ((today.getDay() + 6) % 7) + 6)) };
  }
  const first = preset === "month" ? 0 : -1;
  return { from: dayKey(new Date(y, m + first, 1)), to: dayKey(new Date(y, m + first + 1, 0)) };
}
