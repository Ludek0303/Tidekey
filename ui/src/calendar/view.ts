// The calendar in the main area: header, mini month, the four views, and the writes to the note.
// Reads come from the note's Y.Text on every render; writes are text changes in one transaction.
import { CALENDAR_ORIGIN, type NoteSession } from "../editor";
import { icon } from "../icons";
import { errorText, toast } from "../widgets";
import { el, type ViewCtx } from "./chips";
import { addMonths, dayOf, dayNumber, dayTitle, MINUTES, monthGrid, monthTitle, nextFullHour, plural, shortDate, startOfWeek, weekTitle, WEEKDAYS_SHORT, ymdOf } from "./dates";
import {
  addEvent, assignId, COUNT_SPAN_DAYS, deleteEvent, isRealId, keepsSeriesStart, ruleOf, updateEvent, writeChanges, type Change, type EventInput, type Scope,
} from "./edit";
// A rule that cannot be split (kept as text, or a counted series too long to count) only offers one occurrence or the whole series.
const scopesOf = (ev: CalEvent, occDay: number): Scope[] => {
  const rule = ruleOf(ev);
  if (rule === null || (rule.count !== null && occDay - ev.startDay > COUNT_SPAN_DAYS)) return ["this", "all"];
  return ["this", "following", "all"];
};
import { openDetails } from "./details";
import { openEventForm, openScopeDialog } from "./dialog";
import { closePopover, openPopover } from "./popover";
import { load, parseCalendar, type CalEvent, type Occurrence } from "./model";
import { fromIcs, toIcs } from "./ics";
import { renderAgenda } from "./agenda";
import { renderMonth } from "./month";
import { HOUR_PX, renderTime } from "./timegrid";
import { chipButton } from "./chips";

type Mode = "day" | "week" | "month" | "agenda";

// The lines of a new event, with an id no other event (in `taken`) has: addEvent's id is checked against the note only.
function freshLines(input: EventInput, taken: Set<string>): string {
  for (;;) {
    const insert = addEvent("", input)[0].insert;
    const id = /\^(e[0-9a-z]+)/.exec(insert)?.[1];
    if (id === undefined) return insert;
    if (!taken.has(id)) {
      taken.add(id);
      return insert;
    }
  }
}
const MODES: [Mode, string][] = [
  ["day", "Dzień"],
  ["week", "Tydzień"],
  ["month", "Miesiąc"],
  ["agenda", "Harmonogram"],
];
const AGENDA_DAYS = 60;
const NOTICE = "Nie wszystkie wydarzenia mogą być widoczne — zbyt złożone powtarzanie";
const RENDER_MS = 100;
const NOW_MS = 60_000;

/** Today as a day number, from the local calendar date. */
function todayDay(): number {
  const now = new Date();
  return dayOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Events from somewhere other than a calendar note (an organization's calendars): what to show and what clicks do.
 *  The look, the views, the navigation and the keys stay the note calendar's own. */
export interface CalendarSource {
  occurrences(fromDay: number, toDay: number): Occurrence[];
  details(occ: Occurrence, anchor: HTMLElement): void;
  create(day: number, startMin: number | null): void;
}

export class CalendarView {
  private source: CalendarSource | null = null;
  /** Called when a view showing a source (showSource) moves to a note or hides. */
  onLeave: (() => void) | null = null;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly mini: HTMLElement;
  private readonly miniTitle: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly importBtn: HTMLButtonElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private readonly modeBtns = new Map<Mode, HTMLButtonElement>();
  private session: NoteSession | null = null;
  private visible = false;
  private mode: Mode = "month";
  private anchor = todayDay();
  private today = todayDay();
  private timeScroll: number | null = null;
  private unobserve: (() => void) | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private nowTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: () => void,
    /** Opens the note a wikilink of an event names. */
    private readonly openLinked: (name: string) => void = () => undefined,
  ) {
    this.title = el("h2", "cal-title");
    // A warning icon: the text is the tooltip and the accessible name, so the header keeps its width.
    this.notice = el("span", "cal-notice");
    this.notice.append(icon("triangle-alert"));
    this.notice.title = NOTICE;
    this.notice.tabIndex = 0;
    this.notice.setAttribute("role", "img");
    this.notice.setAttribute("aria-label", NOTICE);
    this.notice.hidden = true;
    this.body = el("div", "cal-body");
    this.mini = el("div", "cal-mini");
    this.miniTitle = el("span", "cal-mini-title");
    const side = el("aside", "cal-side");
    const create = el("button", "cal-create");
    create.type = "button";
    create.append(icon("plus"), document.createTextNode(" Utwórz"));
    create.addEventListener("click", () => this.createNow());
    const miniHead = el("div", "cal-mini-head");
    miniHead.append(
      this.navBtn("arrow-left", "Poprzedni miesiąc", () => this.shiftMonth(-1)),
      this.miniTitle,
      this.navBtn("arrow-right", "Następny miesiąc", () => this.shiftMonth(1)),
    );
    side.append(miniHead, this.mini);

    const main = el("section", "cal-main");
    const head = el("header", "cal-head");
    const today = el("button", "btn", "Dziś");
    today.type = "button";
    today.addEventListener("click", () => this.goToday());
    this.importBtn = el("button", "btn");
    this.importBtn.type = "button";
    this.importBtn.append(icon("upload"), document.createTextNode(" Importuj .ics"));
    this.importBtn.addEventListener("click", () => this.fileInput.click());
    this.exportBtn = el("button", "btn");
    this.exportBtn.type = "button";
    this.exportBtn.append(icon("download"), document.createTextNode(" Eksportuj .ics"));
    this.exportBtn.addEventListener("click", () => this.exportIcs());
    this.fileInput = el("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".ics,text/calendar";
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) void this.importIcs(file);
    });
    const switcher = el("div", "cal-switch");
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Widok");
    for (const [mode, label] of MODES) {
      const btn = el("button", "btn", label);
      btn.type = "button";
      btn.addEventListener("click", () => this.setMode(mode));
      this.modeBtns.set(mode, btn);
      switcher.append(btn);
    }
    head.append(
      create,
      today,
      this.navBtn("arrow-left", "Wstecz", () => this.moveAnchor(-1)),
      this.navBtn("arrow-right", "Dalej", () => this.moveAnchor(1)),
      this.title,
      el("span", "spacer"),
      this.notice,
      this.importBtn,
      this.exportBtn,
      switcher,
    );
    main.append(head, this.body, this.fileInput);
    root.lang = "pl";
    root.replaceChildren(el("div", "cal"));
    root.firstElementChild!.append(side, main);
    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** Shows the calendar of a note (the note's text is read on every render). */
  show(session: NoteSession): void {
    if (this.source) this.onLeave?.();
    this.source = null;
    if (this.session !== session) {
      this.unobserve?.();
      this.session = session;
      this.timeScroll = null;
      const ytext = session.doc.getText("content");
      const observer = () => this.scheduleRender();
      ytext.observe(observer);
      this.unobserve = () => ytext.unobserve(observer);
    }
    this.visible = true;
    this.root.hidden = false;
    this.render();
    clearInterval(this.nowTimer);
    this.nowTimer = setInterval(() => this.render(), NOW_MS);
  }

  /** Shows events from `source` instead of a note; called again with fresh data, it keeps the view and the date. */
  showSource(source: CalendarSource): void {
    this.unobserve?.();
    this.unobserve = null;
    this.session = null;
    this.source = source;
    this.visible = true;
    this.root.hidden = false;
    this.render();
    clearInterval(this.nowTimer);
    this.nowTimer = setInterval(() => this.render(), NOW_MS);
  }

  hide(): void {
    if (this.source) this.onLeave?.();
    this.source = null;
    this.visible = false;
    this.root.hidden = true;
    closePopover();
    clearInterval(this.nowTimer);
    clearTimeout(this.renderTimer);
    this.unobserve?.();
    this.unobserve = null;
    this.session = null;
  }

  // Remote edits and our own writes arrive as Y.Text changes: one render per quiet period.
  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), RENDER_MS);
  }

  private text(): string {
    return this.session!.doc.getText("content").toString();
  }

  private navBtn(name: "arrow-left" | "arrow-right", label: string, run: () => void): HTMLButtonElement {
    const btn = el("button", "icon-btn");
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.append(icon(name));
    btn.addEventListener("click", run);
    return btn;
  }

  private range(): [number, number] {
    switch (this.mode) {
      case "month": {
        const grid = monthGrid(this.anchor);
        return [grid[0], grid[41]];
      }
      case "week":
        return [startOfWeek(this.anchor), startOfWeek(this.anchor) + 6];
      case "day":
        return [this.anchor, this.anchor];
      case "agenda":
        return [this.anchor, this.anchor + AGENDA_DAYS - 1];
    }
  }

  private titleText(): string {
    switch (this.mode) {
      case "month":
        return monthTitle(this.anchor);
      case "week":
        return weekTitle(this.anchor);
      case "day":
        return dayTitle(this.anchor);
      case "agenda":
        return `${shortDate(this.anchor)} – ${shortDate(this.anchor + AGENDA_DAYS - 1)}`;
    }
  }

  private render(): void {
    if ((!this.session && !this.source) || !this.visible) return;
    this.today = todayDay();
    const [from, to] = this.range();
    const loaded = this.source ? { occurrences: this.source.occurrences(from, to), truncated: false } : load(this.text(), from, to);
    const occs = loaded.occurrences;
    this.notice.hidden = !loaded.truncated;
    // Import writes to the note, so a read-only note (a shared vault's viewer) gets none; export works on any note.
    this.exportBtn.hidden = this.session === null;
    this.importBtn.hidden = this.session === null || this.session.state.readOnly;
    const ctx = this.ctx();
    this.title.textContent = this.titleText();
    for (const [mode, btn] of this.modeBtns) btn.setAttribute("aria-pressed", String(mode === this.mode));
    if (this.mode === "month") {
      this.body.replaceChildren(renderMonth(this.anchor, occs, ctx));
    } else if (this.mode === "agenda") {
      this.body.replaceChildren(renderAgenda(this.anchor, occs, ctx, AGENDA_DAYS));
    } else {
      const days = this.mode === "week" ? 7 : 1;
      const first = this.mode === "week" ? startOfWeek(this.anchor) : this.anchor;
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const scroller = renderTime(first, days, occs, ctx, nowMin);
      this.body.replaceChildren(scroller);
      // The first view scrolls to 07:00 (just below the sticky header, so the label shows); then the user's position is kept.
      scroller.scrollTop = this.timeScroll ?? 7 * HOUR_PX - 12;
      scroller.onscroll = () => (this.timeScroll = scroller.scrollTop);
    }
    this.renderMini();
  }

  private renderMini(): void {
    const grid = monthGrid(this.anchor);
    const month = ymdOf(this.anchor).m;
    const head = el("div", "cal-mini-grid");
    for (const name of WEEKDAYS_SHORT) head.append(el("span", "cal-mini-wd", name[0].toUpperCase()));
    for (const day of grid) {
      const btn = el("button", "cal-mini-day", String(dayNumber(day)));
      btn.type = "button";
      btn.classList.toggle("is-other", ymdOf(day).m !== month);
      btn.classList.toggle("is-today", day === this.today);
      btn.classList.toggle("is-selected", day === this.anchor);
      btn.setAttribute("aria-label", dayTitle(day));
      btn.addEventListener("click", () => {
        this.anchor = day;
        this.render();
      });
      head.append(btn);
    }
    this.miniTitle.textContent = monthTitle(this.anchor);
    this.mini.replaceChildren(head);
  }

  private ctx(): ViewCtx {
    return {
      today: this.today,
      details: (occ, anchor) => this.details(occ, anchor),
      more: (day, occs, anchor) => this.more(day, occs, anchor),
      create: (day, startMin) => this.newEvent(day, startMin),
    };
  }

  private details(occ: Occurrence, anchor: HTMLElement): void {
    if (this.source) { this.source.details(occ, anchor); return; }
    // An event without an id gets one first, so the actions below act on a stable id, not a line number.
    if (!isRealId(occ.event.id)) {
      const ref = occ.event;
      if (!this.apply(() => assignId(this.text(), ref))) return;
      const fresh = load(this.text(), occ.startDay, occ.endDay).occurrences.find((o) => o.startDay === occ.startDay && o.event.line === ref.line);
      if (!fresh) return;
      occ = fresh;
    }
    openDetails(occ, anchor, {
      edit: () => this.editEvent(occ),
      remove: () => this.removeEvent(occ),
      openNote: (name) => this.openLinked(name),
    });
  }

  // "+N więcej": every occurrence of the day, each one opens its details.
  private more(day: number, occs: Occurrence[], anchor: HTMLElement): void {
    openPopover(anchor, dayTitle(day), (box, close) => {
      box.append(el("h3", "cal-pop-title", dayTitle(day)));
      const list = el("div", "cal-pop-list");
      for (const occ of occs) {
        list.append(
          chipButton(occ, (o) => {
            close();
            this.details(o, anchor);
          }),
        );
      }
      box.append(list);
    });
  }

  /** Runs `compute` on the current text and writes its changes in one transaction. A refused write shows why. */
  private apply(compute: () => Change[]): boolean {
    if (!this.session) return false;
    try {
      writeChanges(this.session.doc, compute(), CALENDAR_ORIGIN, this.session.undo);
    } catch (err) {
      toast(errorText(err), true);
      this.render();
      return false;
    }
    this.onChange();
    this.render();
    // Dialogs hand focus back to the page; the calendar keeps its keys (Ctrl+E, undo) after a write.
    this.root.focus({ preventScroll: true });
    return true;
  }

  private editEvent(occ: Occurrence): void {
    const ev = occ.event;
    const init: EventInput = {
      title: ev.title,
      startDay: occ.startDay,
      startMin: occ.startMin,
      endDay: occ.endDay,
      endMin: occ.endMin,
      rule: ruleOf(ev),
      rawRule: ev.rrule === null || ruleOf(ev) !== null ? undefined : ev.rrule,
      color: ev.color,
      description: ev.description,
      reminder: ev.reminder,
    };
    openEventForm({
      title: "Edytuj wydarzenie",
      init,
      editing: true,
      onSave: (next) => {
        if (ev.rrule === null) {
          this.apply(() => updateEvent(this.text(), ev, occ.startDay, "all", next));
          return;
        }
        openScopeDialog({
          title: "Edytować powtarzające się wydarzenie?",
          ok: "Zapisz",
          scopes: scopesOf(ev, occ.startDay),
          onPick: (scope) => {
            const fixed = scope === "all" && keepsSeriesStart(ev, occ.startDay, next);
            if (this.apply(() => updateEvent(this.text(), ev, occ.startDay, scope, next)) && fixed) {
              toast("Data serii nie została zmieniona — reguła niestandardowa");
            }
          },
        });
      },
      onDelete: () => this.removeEvent(occ),
    });
  }

  private removeEvent(occ: Occurrence): void {
    const ev = occ.event;
    // A delete can be undone from the toast as well as with Ctrl+Z.
    const remove = (scope: Scope) => {
      const session = this.session;
      if (this.apply(() => deleteEvent(this.text(), ev, occ.startDay, scope)) && session) {
        toast("Wydarzenie usunięte", false, { label: "Cofnij", run: () => session.undo.undo() });
      }
    };
    if (ev.rrule === null) {
      remove("all");
      return;
    }
    openScopeDialog({
      title: "Usunąć powtarzające się wydarzenie?",
      ok: "Usuń",
      scopes: scopesOf(ev, occ.startDay),
      onPick: remove,
    });
  }

  // The note's events as an .ics file, downloaded as "<note name>.ics".
  private exportIcs(): void {
    const session = this.session;
    if (!session) return;
    const name = session.path.slice(session.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const url = URL.createObjectURL(new Blob([toIcs(parseCalendar(this.text()).events, name)], { type: "text/calendar" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.ics`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // All events of the file are added in one write (one undo step). Events that cannot be written are counted as skipped.
  private async importIcs(file: File): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      const parsed = fromIcs(await file.text());
      if (this.session !== session) return;
      let refused = 0;
      const wrote = this.apply(() => {
        const text = this.text();
        // Lines are formatted without the note's text (as addEvent does at its end); the ids are checked here.
        const taken = new Set(parseCalendar(text).events.map((e) => e.id));
        let lines = "";
        for (const input of parsed.events) {
          try {
            lines += freshLines(input, taken);
          } catch {
            refused++;
          }
        }
        if (lines === "") return [];
        const sep = text === "" || text.endsWith("\n") ? "" : "\n";
        return [{ from: text.length, to: text.length, insert: sep + lines }];
      });
      if (!wrote) return;
      const added = parsed.events.length - refused;
      const skipped = parsed.skipped + refused;
      toast(`Zaimportowano ${added} ${plural(added, "wydarzenie", "wydarzenia", "wydarzeń")}.${skipped > 0 ? ` Pominięto ${skipped}.` : ""}`);
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  /** A new event as an empty-slot click makes it, for the note on screen (main.ts "Mój kalendarz"). */
  createAt(day: number, startMin: number | null): void {
    this.newEvent(day, startMin);
  }

  // A new event: all-day on a month cell, one hour long in the time views.
  private newEvent(day: number, startMin: number | null): void {
    if (this.source) { this.source.create(day, startMin); return; }
    const startAbs = day * MINUTES + (startMin ?? 0);
    const endAbs = startMin === null ? day * MINUTES : startAbs + 60;
    const init: EventInput = {
      title: "",
      startDay: day,
      startMin,
      endDay: Math.floor(endAbs / MINUTES),
      endMin: startMin === null ? null : endAbs % MINUTES,
      rule: null,
      color: null,
      description: "",
    };
    openEventForm({
      title: "Nowe wydarzenie",
      init,
      editing: false,
      onSave: (next) => this.apply(() => addEvent(this.text(), next)),
      onDelete: () => undefined,
    });
  }

  // "Utwórz" and the "c" key: the next full hour today.
  private createNow(): void {
    const { day, startMin } = nextFullHour(new Date());
    this.newEvent(day, startMin);
  }

  private goToday(): void {
    this.anchor = todayDay();
    this.render();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.render();
  }

  // Month view moves by months; the other views by their own unit.
  private moveAnchor(delta: number): void {
    if (this.mode === "month") this.shiftMonth(delta);
    else this.anchor += delta * (this.mode === "day" ? 1 : 7);
    this.render();
  }

  private shiftMonth(delta: number): void {
    this.anchor = addMonths(this.anchor, delta);
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    // isConnected: a calendar that is not on screen (another view took its place) takes no keys
    if (!this.visible || (!this.session && !this.source) || !this.root.isConnected || e.altKey) return;
    // Only when the calendar has the focus, and never while an input, a dialog or a popover is open.
    const active = document.activeElement;
    if (active !== null && active !== document.body && !this.root.contains(active)) return;
    if (document.querySelector('[role="dialog"]')) return;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
    if ((e.ctrlKey || e.metaKey) && !this.session) return;
    if (e.ctrlKey || e.metaKey) {
      // Undo and redo of the note's own history, as in the editor.
      const k = e.key.toLowerCase();
      const undo = this.session!.undo;
      if (k === "z" && !e.shiftKey) undo.undo();
      else if ((k === "z" && e.shiftKey) || k === "y") undo.redo();
      else return;
      e.preventDefault();
      return;
    }
    const keys: Record<string, () => void> = {
      t: () => this.goToday(),
      j: () => this.moveAnchor(1),
      n: () => this.moveAnchor(1),
      k: () => this.moveAnchor(-1),
      p: () => this.moveAnchor(-1),
      d: () => this.setMode("day"),
      w: () => this.setMode("week"),
      m: () => this.setMode("month"),
      a: () => this.setMode("agenda"),
      c: () => this.createNow(),
    };
    const run = keys[e.key.toLowerCase()];
    if (!run) return;
    e.preventDefault();
    run();
  }
}

