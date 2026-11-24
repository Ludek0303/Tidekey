// Agenda view: the days of the range that have events, each with its events in time order.
import { dayTitle, hhmm } from "./dates";
import type { Occurrence } from "./model";
import { el, evColor, titleOf, type ViewCtx } from "./chips";

export function renderAgenda(from: number, occs: Occurrence[], ctx: ViewCtx, days: number): HTMLElement {
  const byDay = new Map<number, Occurrence[]>();
  for (const occ of occs) {
    for (let d = Math.max(occ.startDay, from); d <= Math.min(occ.endDay, from + days - 1); d++) {
      byDay.set(d, [...(byDay.get(d) ?? []), occ]);
    }
  }
  const root = el("div", "cal-agenda");
  const order = [...byDay.keys()].sort((a, b) => a - b);
  if (order.length === 0) {
    root.append(el("p", "muted cal-empty", `Brak wydarzeń w ciągu ${days} dni.`));
    return root;
  }
  for (const day of order) {
    const section = el("section", "cal-agenda-day");
    section.append(el("h3", `cal-agenda-head${day === ctx.today ? " is-today" : ""}`, dayTitle(day)));
    const list = el("ul", "cal-agenda-list");
    const items = byDay.get(day)!.sort((a, b) => (a.startMin ?? -1) - (b.startMin ?? -1) || a.startDay - b.startDay);
    for (const occ of items) {
      const li = el("li");
      const btn = el("button", "cal-agenda-row");
      btn.type = "button";
      btn.style.setProperty("--ev", evColor(occ));
      btn.append(
        el("span", "cal-agenda-time", occ.startMin === null ? "Cały dzień" : `${hhmm(occ.startMin)}–${hhmm(occ.endMin ?? 0)}`),
        el("span", "cal-dot"),
        el("span", "cal-agenda-title", titleOf(occ)),
      );
      btn.addEventListener("click", () => ctx.details(occ, btn));
      li.append(btn);
      list.append(li);
    }
    section.append(list);
    root.append(section);
  }
  return root;
}
