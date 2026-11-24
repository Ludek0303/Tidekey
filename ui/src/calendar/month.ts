// Month view: a 6 x 7 grid, Monday first. Bars and chips are grid items placed over the day cells.
import { dayNumber, monthGrid, WEEKDAYS_SHORT, ymdOf } from "./dates";
import { placeEntries } from "./lanes";
import type { Occurrence } from "./model";
import { chipButton, el, type ViewCtx } from "./chips";

// Rows of bars and chips shown per week; the rest is "+N więcej".
const MAX_LANES = 3;

const coversDay = (occ: Occurrence, day: number): boolean => occ.startDay <= day && day <= occ.endDay;

export function renderMonth(anchor: number, occs: Occurrence[], ctx: ViewCtx): HTMLElement {
  const days = monthGrid(anchor);
  const month = ymdOf(anchor).m;
  const root = el("div", "cal-month");
  const head = el("div", "cal-month-head");
  for (const name of WEEKDAYS_SHORT) head.append(el("span", "", name));
  root.append(head);
  for (let w = 0; w < 6; w++) {
    const first = days[w * 7];
    const row = el("div", "cal-week");
    const { entries, hidden } = placeEntries(occs, first, 7, MAX_LANES, () => true);
    for (let c = 0; c < 7; c++) {
      const day = first + c;
      const cell = el("div", `cal-cell${ymdOf(day).m !== month ? " is-other" : ""}`);
      cell.style.gridColumn = String(c + 1);
      cell.style.gridRow = "1 / -1";
      const num = el("span", `cal-daynum${day === ctx.today ? " is-today" : ""}`, String(dayNumber(day)));
      cell.append(num);
      cell.addEventListener("click", (e) => {
        if (e.target === cell || e.target === num) ctx.create(day, null);
      });
      row.append(cell);
    }
    for (const e of entries) {
      const btn = chipButton(e.occ, ctx.details);
      btn.style.gridRow = String(e.lane + 2);
      btn.style.gridColumn = `${e.c0 + 1} / ${e.c1 + 2}`;
      row.append(btn);
    }
    hidden.forEach((count, c) => {
      if (count === 0) return;
      const day = first + c;
      const more = el("button", "cal-more", `+${count} więcej`);
      more.type = "button";
      more.style.gridRow = String(MAX_LANES + 2);
      more.style.gridColumn = String(c + 1);
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.more(day, occs.filter((o) => coversDay(o, day)), more);
      });
      row.append(more);
    });
    root.append(row);
  }
  return root;
}
