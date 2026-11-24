// The details popover of an event (ARCHITEKTURA §4.16b / Google Calendar look): colour, title,
// date and time, the rule in words, the description, and the edit and delete buttons.
import { el, evColor, titleOf } from "./chips";
import { dayTitle, hhmm, shortDate } from "./dates";
import { icon } from "../icons";
import { ruleOf } from "./edit";
import { describeRule, READ_ONLY_RULE } from "./recur";
import { wikilinks, type Occurrence } from "./model";
import { openPopover } from "./popover";

/** `środa, 22 października · 10:00–11:00`, or the range of a multi-day event. */
export function dateLabel(occ: Occurrence): string {
  if (occ.startDay === occ.endDay) {
    const when = occ.startMin === null ? "Cały dzień" : `${hhmm(occ.startMin)}–${hhmm(occ.endMin ?? occ.startMin)}`;
    return `${dayTitle(occ.startDay)} · ${when}`;
  }
  const at = (day: number, min: number | null) => `${shortDate(day)}${min === null ? "" : `, ${hhmm(min)}`}`;
  return `${at(occ.startDay, occ.startMin)} – ${at(occ.endDay, occ.endMin)}`;
}

export function openDetails(occ: Occurrence, anchor: HTMLElement, actions: { edit: () => void; remove: () => void; openNote: (name: string) => void }): void {
  openPopover(anchor, titleOf(occ), (box, close) => {
    const head = el("div", "cal-pop-head");
    const swatch = el("span", "cal-pop-swatch");
    swatch.style.setProperty("--ev", evColor(occ));
    const title = el("h3", "cal-pop-title", titleOf(occ));
    head.append(swatch, title);
    box.append(head, el("p", "cal-pop-date", dateLabel(occ)));
    if (occ.event.rrule !== null) {
      const rule = ruleOf(occ.event);
      const text = rule ? describeRule(rule, occ.event.startDay) : READ_ONLY_RULE;
      box.append(el("p", "cal-pop-repeat", text));
    }
    if (occ.event.description !== "") box.append(el("p", "cal-pop-desc", occ.event.description));
    // A wikilink in the title or the description: a button that opens the note it names.
    for (const name of wikilinks(`${occ.event.title}\n${occ.event.description}`)) {
      const link = el("button", "btn", `Powiązana notatka: ${name}`);
      link.type = "button";
      link.addEventListener("click", () => {
        close();
        actions.openNote(name);
      });
      box.append(link);
    }
    const row = el("div", "cal-pop-actions");
    const button = (name: Parameters<typeof icon>[0], label: string, run: () => void) => {
      const btn = el("button", "icon-btn");
      btn.type = "button";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.append(icon(name));
      btn.addEventListener("click", () => {
        close();
        run();
      });
      return btn;
    };
    const closeBtn = button("x", "Zamknij", () => undefined);
    row.append(button("pencil", "Edytuj", actions.edit), button("trash-2", "Usuń", actions.remove), el("span", "spacer"), closeBtn);
    box.append(row);
  });
}
