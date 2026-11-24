// Week and day views: an all-day row over a 24 h grid. Timed events are blocks placed by their
// minutes; an event that crosses midnight is cut into one block per day.
import { hhmm, MINUTES, WEEKDAYS_SHORT, dayNumber, weekdayOf } from "./dates";
import { placeEntries } from "./lanes";
import { layoutColumns, type Span } from "./columns";
import type { Occurrence } from "./model";
import { chipButton, el, evColor, titleOf, type ViewCtx } from "./chips";

/** Pixels per hour; the CSS of the grid uses the same value through `--hour`. */
export const HOUR_PX = 48;
const MAX_LANES = 3;
// A zero-length event still gets a block of this many minutes.
const MIN_BLOCK = 30;

/** The part of each timed occurrence that falls on `day`, in minutes. */
function segmentsOn(occs: Occurrence[], day: number): Span<Occurrence>[] {
  const out: Span<Occurrence>[] = [];
  for (const occ of occs) {
    if (occ.startMin === null || occ.startDay > day || occ.endDay < day) continue;
    const start = occ.startDay === day ? occ.startMin : 0;
    let end = occ.endDay === day ? (occ.endMin ?? MINUTES) : MINUTES;
    if (end <= start) {
      // Ends at midnight, or zero-length: the second only counts for a one-day event.
      if (occ.startDay === occ.endDay) end = Math.min(MINUTES, start + MIN_BLOCK);
      else continue;
    }
    out.push({ start, end, item: occ });
  }
  return out;
}

function dayHead(day: number, today: number): HTMLElement {
  const head = el("div", `cal-dayhead${day === today ? " is-today" : ""}`);
  head.append(el("span", "", WEEKDAYS_SHORT[weekdayOf(day)]), el("span", "cal-daynum", String(dayNumber(day))));
  return head;
}

function block(p: ReturnType<typeof layoutColumns<Occurrence>>[number], ctx: ViewCtx): HTMLElement {
  const occ = p.item;
  const btn = el("button", "cal-block");
  btn.type = "button";
  btn.style.setProperty("--ev", evColor(occ));
  btn.style.top = `${(p.start * HOUR_PX) / 60}px`;
  btn.style.height = `${Math.max(18, ((p.end - p.start) * HOUR_PX) / 60 - 2)}px`;
  btn.style.left = `${(p.col / p.cols) * 100}%`;
  btn.style.width = `calc(${100 / p.cols}% - 4px)`;
  btn.append(el("span", "cal-block-time", `${hhmm(p.start)}–${hhmm(p.end)}`), el("span", "cal-block-title", titleOf(occ)));
  btn.title = `${hhmm(p.start)}–${hhmm(p.end)} ${titleOf(occ)}`;
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.details(occ, btn);
  });
  return btn;
}

/** The grid of `n` days from `first`, and the scroll box that holds it. */
export function renderTime(first: number, n: number, occs: Occurrence[], ctx: ViewCtx, nowMin: number | null): HTMLElement {
  const scroll = el("div", "cal-time");
  const grid = el("div", "cal-tg");
  const columns = `56px repeat(${n}, minmax(0, 1fr))`;
  grid.style.gridTemplateColumns = columns;
  grid.style.setProperty("--hour", `${HOUR_PX}px`);
  const days = Array.from({ length: n }, (_, i) => first + i);

  // The day names and the all-day row stay on top while the hours scroll.
  const head = el("div", "cal-tg-head");
  head.style.gridTemplateColumns = columns;
  head.append(el("div", "cal-corner"));
  for (const day of days) head.append(dayHead(day, ctx.today));

  head.append(el("div", "cal-gutter-ad", "cały dzień"));
  const { entries, hidden } = placeEntries(occs, first, n, MAX_LANES, (o) => o.startMin === null);
  const allDay = el("div", "cal-ad");
  allDay.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
  allDay.style.gridTemplateRows = `repeat(${MAX_LANES + 1}, 20px)`;
  allDay.style.gridColumn = "2 / -1";
  allDay.style.gridRow = "2";
  for (const e of entries) {
    const btn = chipButton(e.occ, ctx.details);
    btn.style.gridRow = String(e.lane + 1);
    btn.style.gridColumn = `${e.c0 + 1} / ${e.c1 + 2}`;
    allDay.append(btn);
  }
  hidden.forEach((count, c) => {
    if (count === 0) return;
    const more = el("button", "cal-more", `+${count} więcej`);
    more.type = "button";
    more.style.gridRow = String(MAX_LANES + 1);
    more.style.gridColumn = String(c + 1);
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.more(days[c], occs.filter((o) => o.startDay <= days[c] && days[c] <= o.endDay), more);
    });
    allDay.append(more);
  });
  head.append(allDay);
  grid.append(head);

  const hours = el("div", "cal-hours");
  hours.style.gridRow = "2";
  hours.style.height = `${24 * HOUR_PX}px`;
  for (let h = 0; h < 24; h++) {
    const label = el("span", "cal-hour", hhmm(h * 60));
    label.style.top = `${h * HOUR_PX}px`;
    hours.append(label);
  }
  grid.append(hours);

  for (const [i, day] of days.entries()) {
    const col = el("div", "cal-col");
    col.style.gridRow = "2";
    col.style.gridColumn = String(i + 2);
    col.style.height = `${24 * HOUR_PX}px`;
    col.addEventListener("click", (e) => {
      const r = col.getBoundingClientRect();
      const min = Math.floor(((e.clientY - r.top) * 60) / HOUR_PX / 30) * 30;
      ctx.create(day, Math.min(MINUTES - 30, Math.max(0, min)));
    });
    for (const p of layoutColumns(segmentsOn(occs, day))) col.append(block(p, ctx));
    if (day === ctx.today && nowMin !== null) {
      const now = el("div", "cal-now");
      now.style.top = `${(nowMin * HOUR_PX) / 60}px`;
      col.append(now);
    }
    grid.append(col);
  }
  scroll.append(grid);
  return scroll;
}
