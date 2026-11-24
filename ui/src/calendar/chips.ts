// Shared pieces of the calendar views: the callbacks a view gets from the calendar, and the chips
// and bars that show one occurrence. Titles and descriptions go in with textContent only.
import { colorHex, type Occurrence } from "./model";
import { hhmm } from "./dates";

export interface ViewCtx {
  today: number;
  /** Opens the details popover of an occurrence. */
  details(occ: Occurrence, anchor: HTMLElement): void;
  /** Lists every occurrence of a day that does not fit into its cell. */
  more(day: number, occs: Occurrence[], anchor: HTMLElement): void;
  /** New event at a day; `startMin` `null` makes it an all-day event. */
  create(day: number, startMin: number | null): void;
}

/** The colour of an event: its palette colour, or the accent when it has none (or an unknown one). */
export const evColor = (occ: Occurrence): string => colorHex(occ.event.color) ?? "var(--accent)";

export const titleOf = (occ: Occurrence): string => occ.event.title.trim() || "(bez tytułu)";

/** All-day and multi-day occurrences are bars; a timed one on one day is a chip with its start time. */
export const isBar = (occ: Occurrence): boolean => occ.startMin === null || occ.startDay !== occ.endDay;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The button of one occurrence in a month cell or in the all-day row. */
export function chipButton(occ: Occurrence, onClick: (occ: Occurrence, anchor: HTMLElement) => void): HTMLButtonElement {
  const bar = isBar(occ);
  const btn = el("button", bar ? "cal-bar" : "cal-chip");
  btn.type = "button";
  btn.style.setProperty("--ev", evColor(occ));
  const label = occ.startMin === null ? titleOf(occ) : `${hhmm(occ.startMin)} ${titleOf(occ)}`;
  if (bar) {
    btn.textContent = titleOf(occ);
  } else {
    btn.append(el("span", "cal-dot"), el("span", "cal-chip-text", label));
  }
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(occ, btn);
  });
  return btn;
}
