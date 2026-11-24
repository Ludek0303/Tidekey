// Rows ("lanes") for the all-day bars and chips of a week or of a range of days (pure, tested).
import type { Occurrence } from "./model";

export interface Entry {
  occ: Occurrence;
  /** First and last column (day index inside the range) the entry covers. */
  c0: number;
  c1: number;
  lane: number;
}

/**
 * Places the occurrences that overlap the `n` days from `first`. Entries past `maxLanes` are not
 * returned; `hidden[c]` counts them per column, so the view can show "+N więcej".
 */
export function placeEntries(
  occs: Occurrence[],
  first: number,
  n: number,
  maxLanes: number,
  keep: (occ: Occurrence) => boolean,
): { entries: Entry[]; hidden: number[] } {
  const last = first + n - 1;
  const list: Entry[] = [];
  for (const occ of occs) {
    if (!keep(occ) || occ.endDay < first || occ.startDay > last) continue;
    list.push({ occ, c0: Math.max(occ.startDay, first) - first, c1: Math.min(occ.endDay, last) - first, lane: 0 });
  }
  list.sort((a, b) => a.c0 - b.c0 || b.c1 - a.c1);
  const laneEnds: number[] = [];
  const hidden = new Array<number>(n).fill(0);
  for (const e of list) {
    let lane = laneEnds.findIndex((end) => end < e.c0);
    if (lane < 0) lane = laneEnds.push(e.c1) - 1;
    else laneEnds[lane] = e.c1;
    e.lane = lane;
    if (lane >= maxLanes) for (let c = e.c0; c <= e.c1; c++) hidden[c]++;
  }
  return { entries: list.filter((e) => e.lane < maxLanes), hidden };
}
