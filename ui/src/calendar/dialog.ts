// The event form (Google Calendar look) and the scope question for recurring events.
import { openDialog } from "../widgets";
import { el } from "./chips";
import { customForm } from "./recurform";
import { hhmm, isoDay, MINUTES, parseHm, parseIsoDay } from "./dates";
import { type EventInput, type Scope } from "./edit";
import { PALETTE, WIKILINK, cleanNoteName } from "./model";
import { presetOptions, presetOf, presetRule, READ_ONLY_RULE, type Preset, type Rule } from "./recur";

let seq = 0;
const DEFAULT_MIN = 10 * 60;
// The reminder choices in minutes before the start; 0 is "Bez przypomnienia" (stored as null).
const REMINDERS: [minutes: number, label: string][] = [
  [0, "Bez przypomnienia"],
  [5, "5 minut wcześniej"],
  [15, "15 minut wcześniej"],
  [60, "Godzinę wcześniej"],
  [1440, "Dzień wcześniej"],
];
const DEFAULT_REMINDER = 15;

interface FormState {
  allDay: boolean;
  /** Absolute minutes from day 0; for an all-day event the end is the start of its last day. */
  startAbs: number;
  endAbs: number;
  preset: Preset;
  rule: Rule | null;
  color: string | null;
  reminder: number | null;
  /** The rule text of a read-only event: the form shows it and saves it unchanged. */
  readOnly: string | null;
}

const dayOfAbs = (abs: number): number => Math.floor(abs / MINUTES);

/** The description with the linked note's wikilink at its end; the field is the only place the link is edited. */
function withNote(description: string, note: string): string {
  const name = cleanNoteName(note);
  return name === "" ? description : [description.trim(), `[[${name}]]`].filter((line) => line !== "").join("\n");
}

/** The dialog's fields as the core's event input, or the error to show. */
function toInput(st: FormState, title: string, description: string, note: string): EventInput | string {
  if (st.endAbs < st.startAbs) return "Koniec musi być po początku.";
  const startDay = dayOfAbs(st.startAbs);
  const endDay = dayOfAbs(st.endAbs);
  return {
    title,
    startDay,
    startMin: st.allDay ? null : st.startAbs - startDay * MINUTES,
    endDay,
    endMin: st.allDay ? null : st.endAbs - endDay * MINUTES,
    rule: st.readOnly === null ? st.rule : null,
    rawRule: st.readOnly ?? undefined,
    color: st.color,
    reminder: st.reminder,
    description: withNote(description, note),
  };
}

export function openEventForm(opts: {
  title: string;
  init: EventInput;
  editing: boolean;
  onSave: (input: EventInput) => void;
  onDelete: () => void;
}): void {
  const { init } = opts;
  const st: FormState = {
    allDay: init.startMin === null,
    startAbs: init.startDay * MINUTES + (init.startMin ?? 0),
    endAbs: init.endDay * MINUTES + (init.endMin ?? 0),
    preset: presetOf(init.rule, init.startDay),
    rule: init.rule,
    color: init.color,
    // A new timed event is reminded 15 minutes before; the caller passes no reminder for a new event.
    reminder: init.reminder !== undefined ? init.reminder : !opts.editing && init.startMin !== null ? DEFAULT_REMINDER : null,
    readOnly: init.rawRule ?? null,
  };
  openDialog({
    label: opts.title,
    className: "cal-dialog",
    render(box, close) {
      const form = el("form", "cal-form");
      const title = document.createElement("input");
      title.type = "text";
      title.className = "cal-title-input";
      title.placeholder = "Dodaj tytuł";
      title.setAttribute("aria-label", "Tytuł");
      title.value = init.title;

      const allDay = document.createElement("input");
      allDay.type = "checkbox";
      allDay.setAttribute("role", "switch");
      const allDayLabel = el("label", "cal-toggle");
      allDayLabel.append(allDay, document.createTextNode(" Cały dzień"));

      const startDate = dateInput("Data początku");
      const startTime = timeInput("Godzina początku");
      const endDate = dateInput("Data końca");
      const endTime = timeInput("Godzina końca");
      const dates = el("div", "cal-row cal-dates");
      dates.append(startDate, startTime, el("span", "muted", "–"), endDate, endTime);

      const repeat = document.createElement("select");
      repeat.setAttribute("aria-label", "Powtarzanie");
      const repeatRow = el("div", "cal-row");
      repeatRow.append(el("span", "cal-label", "Powtarzanie"), repeat);
      const customHost = el("div");
      customHost.hidden = true;

      const reminder = document.createElement("select");
      reminder.setAttribute("aria-label", "Przypomnienie");
      const reminderRow = el("div", "cal-row");
      reminderRow.append(el("span", "cal-label", "Przypomnienie"), reminder);

      const swatches = el("div", "cal-swatches");
      swatches.setAttribute("role", "group");
      swatches.setAttribute("aria-label", "Kolor");
      const colorChoices: [string | null, string, string | null][] = [
        [null, "Domyślny", null],
        ...PALETTE.map(([name, hex]): [string | null, string, string | null] => [name.toLowerCase(), name, hex]),
      ];
      const swatchBtns = colorChoices.map(([value, label, hex]) => {
        const btn = el("button", "cal-swatch");
        btn.type = "button";
        btn.title = label;
        btn.setAttribute("aria-label", label);
        if (hex) btn.style.background = hex;
        btn.addEventListener("click", () => {
          st.color = value;
          sync();
        });
        swatches.append(btn);
        return btn;
      });

      const description = document.createElement("textarea");
      description.rows = 3;
      description.placeholder = "Dodaj opis";
      description.setAttribute("aria-label", "Opis");
      // The first wikilink of the description is the linked note: it is shown in the field, not in the text.
      const link = WIKILINK.exec(init.description);
      description.value = link ? init.description.replace(WIKILINK, "").trim() : init.description;
      const note = document.createElement("input");
      note.type = "text";
      note.placeholder = "Nazwa notatki";
      note.setAttribute("aria-label", "Powiązana notatka");
      note.value = link ? link[1].trim() : "";
      const noteRow = el("div", "cal-row");
      noteRow.append(el("span", "cal-label", "Powiązana notatka"), note);
      const error = el("p", "cal-error");
      error.setAttribute("role", "alert");

      const actions = el("div", "modal-actions");
      if (opts.editing) {
        const del = el("button", "btn btn-danger", "Usuń");
        del.type = "button";
        del.addEventListener("click", () => {
          close();
          opts.onDelete();
        });
        actions.append(del);
      }
      const cancel = el("button", "btn", "Anuluj");
      cancel.type = "button";
      cancel.addEventListener("click", () => close());
      const save = el("button", "btn btn-primary", "Zapisz");
      save.type = "submit";
      actions.append(el("span", "spacer"), cancel, save);

      form.append(title, allDayLabel, dates, repeatRow, customHost, reminderRow, swatches, noteRow, description, error, actions);
      box.append(form);

      // Shows the state in the fields. Changing a field updates the state and calls this again.
      function sync(): void {
        allDay.checked = st.allDay;
        const sDay = dayOfAbs(st.startAbs);
        const eDay = dayOfAbs(st.endAbs);
        startDate.querySelector("input")!.value = isoDay(sDay);
        endDate.querySelector("input")!.value = isoDay(eDay);
        startTime.hidden = st.allDay;
        endTime.hidden = st.allDay;
        startTime.querySelector("input")!.value = hhmm(st.startAbs - sDay * MINUTES);
        endTime.querySelector("input")!.value = hhmm(st.endAbs - eDay * MINUTES);
        const options = st.readOnly === null ? presetOptions(sDay).map((o) => new Option(o.label, o.value)) : [new Option(READ_ONLY_RULE, "readonly")];
        repeat.replaceChildren(...options);
        repeat.disabled = st.readOnly !== null;
        repeat.value = st.readOnly === null ? st.preset : "readonly";
        // The custom form keeps its focus while the other fields change, so it is built once per choice.
        customHost.hidden = st.preset !== "custom" || st.readOnly !== null;
        if (st.preset !== "custom" || st.readOnly !== null) customHost.replaceChildren();
        else if (customHost.childElementCount === 0 && st.rule) {
          customHost.append(
            customForm(st.rule, sDay, (rule) => {
              st.rule = rule;
              sync();
            }),
          );
        }
        // A value other than the choices (set by another app) is shown as an extra option, so it is not lost.
        const current = st.reminder ?? 0;
        const extra = REMINDERS.some(([m]) => m === current) ? [] : [new Option(`${current} min wcześniej`, String(current))];
        reminder.replaceChildren(...REMINDERS.map(([m, label]) => new Option(label, String(m))), ...extra);
        reminder.value = String(current);
        swatchBtns.forEach((btn, i) => btn.setAttribute("aria-pressed", String(colorChoices[i][0] === st.color)));
        const check = toInput(st, title.value, description.value, note.value);
        error.textContent = typeof check === "string" ? check : "";
      }

      // Moving the start keeps the length of the event.
      function moveStart(abs: number): void {
        const length = st.endAbs - st.startAbs;
        st.startAbs = abs;
        st.endAbs = abs + length;
      }
      function setStartDay(day: number): void {
        const time = st.startAbs - dayOfAbs(st.startAbs) * MINUTES;
        moveStart(day * MINUTES + time);
        // The series starts on the new day: a preset follows it (a custom rule keeps its fields).
        if (st.preset !== "custom") st.rule = presetRule(st.preset, day);
      }

      startDate.querySelector("input")!.addEventListener("change", (e) => {
        const day = parseIsoDay((e.target as HTMLInputElement).value);
        if (day !== null) setStartDay(day);
        sync();
      });
      startTime.querySelector("input")!.addEventListener("change", (e) => {
        const min = parseHm((e.target as HTMLInputElement).value);
        if (min !== null) moveStart(dayOfAbs(st.startAbs) * MINUTES + min);
        sync();
      });
      endDate.querySelector("input")!.addEventListener("change", (e) => {
        const day = parseIsoDay((e.target as HTMLInputElement).value);
        if (day !== null) st.endAbs = day * MINUTES + (st.endAbs - dayOfAbs(st.endAbs) * MINUTES);
        sync();
      });
      endTime.querySelector("input")!.addEventListener("change", (e) => {
        const min = parseHm((e.target as HTMLInputElement).value);
        if (min !== null) st.endAbs = dayOfAbs(st.endAbs) * MINUTES + min;
        sync();
      });
      allDay.addEventListener("change", () => {
        st.allDay = allDay.checked;
        if (st.allDay) {
          st.startAbs = dayOfAbs(st.startAbs) * MINUTES;
          st.endAbs = dayOfAbs(st.endAbs) * MINUTES;
        } else {
          const day = dayOfAbs(st.startAbs);
          st.startAbs = day * MINUTES + DEFAULT_MIN;
          st.endAbs = st.startAbs + 60;
        }
        sync();
      });
      reminder.addEventListener("change", () => {
        const minutes = Number(reminder.value);
        st.reminder = minutes === 0 ? null : minutes;
        sync();
      });
      repeat.addEventListener("change", () => {
        const value = repeat.value as Preset;
        st.preset = value;
        const day = dayOfAbs(st.startAbs);
        if (value === "custom") st.rule ??= presetRule("weekly", day);
        else st.rule = presetRule(value, day);
        sync();
      });
      title.addEventListener("input", sync);
      description.addEventListener("input", sync);
      note.addEventListener("input", sync);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = toInput(st, title.value, description.value, note.value);
        if (typeof input === "string") {
          error.textContent = input;
          return;
        }
        close();
        opts.onSave(input);
      });
      sync();
    },
  });
}

function dateInput(label: string): HTMLElement {
  const wrap = el("span", "cal-field");
  const input = document.createElement("input");
  input.type = "date";
  input.lang = "pl";
  input.setAttribute("aria-label", label);
  wrap.append(input);
  return wrap;
}

// A text field, not <input type="time">: the browser's own clock shows AM/PM in some locales.
function timeInput(label: string): HTMLElement {
  const wrap = el("span", "cal-field");
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.placeholder = "GG:MM";
  input.maxLength = 5;
  input.className = "cal-hm";
  input.setAttribute("aria-label", label);
  wrap.append(input);
  return wrap;
}

/** "Edytować to wydarzenie, czy także następne?": the scope of a change to a recurring event. */
export function openScopeDialog(opts: { title: string; ok: string; scopes: Scope[]; onPick: (scope: Scope) => void }): void {
  const name = `cal-scope-${++seq}`;
  openDialog({
    label: opts.title,
    className: "cal-scope",
    render(box, close) {
      const form = el("form", "cal-form");
      form.append(el("p", "cal-scope-title", opts.title));
      const choices: [Scope, string][] = [
        ["this", "To wydarzenie"],
        ["following", "To i następne wydarzenia"],
        ["all", "Wszystkie wydarzenia"],
      ];
      const offered = choices.filter(([scope]) => opts.scopes.includes(scope));
      offered.forEach(([scope, text], i) => {
        const input = document.createElement("input");
        input.type = "radio";
        input.name = name;
        input.value = scope;
        input.checked = i === 0;
        const label = el("label", "cal-radio");
        label.append(input, document.createTextNode(` ${text}`));
        form.append(label);
      });
      const actions = el("div", "modal-actions");
      const cancel = el("button", "btn", "Anuluj");
      cancel.type = "button";
      cancel.addEventListener("click", () => close());
      const ok = el("button", "btn btn-primary", opts.ok);
      ok.type = "submit";
      actions.append(el("span", "spacer"), cancel, ok);
      form.append(actions);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const picked = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value as Scope;
        close();
        opts.onPick(picked);
      });
      box.append(form);
    },
  });
}
