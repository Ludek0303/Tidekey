//! The task panel: the fields of one task. Each change is written into the task's source line by `edit`.

import { el } from "./dom";
import { STAR, type TaskField, type TaskRow, isoOf } from "./orgtasks";
import { type EventCheck, verificationBadge } from "./signing";
import type { Group } from "./taskhistory";
import { count } from "./transfer";
import { errorText, toast } from "./widgets";

export type FieldEdit = (field: TaskField, value: string | null) => Promise<void>;

/** Adds one task per title after the task, for `assignee` (null: none). */
export type AddTasks = (titles: string[], assignee: string | null) => Promise<void>;

/** Adds one subtask under the task. */
export type AddSubtask = (title: string) => Promise<void>;

// The subtask box: a name and a button; the subtask goes under the task, after its own subtasks.
function subtaskBox(addSubtask: AddSubtask, notify: (message: string) => void): HTMLElement {
  const section = el("section", "task-more");
  const input = el("input", "task-input");
  input.type = "text";
  input.setAttribute("aria-label", "Nazwa podzadania");
  input.placeholder = "Nazwa podzadania";
  const add = el("button", "btn", "Dodaj podzadanie");
  add.type = "button";
  const submit = () => {
    const title = input.value.trim();
    if (!title) return;
    addSubtask(title).then(() => {
      input.value = "";
      toast(`Dodano podzadanie: ${title}.`);
    }, (e: unknown) => notify(errorText(e)));
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  const row = el("div", "task-add-row");
  row.append(input, add);
  section.append(el("h3", "task-field-label", "Podzadania"), row);
  return section;
}

/** What the "more tasks" box remembers across renders of the panel: the owner keeps it per task. */
export interface TaskAdds {
  // The id of the last task added from the box: the next one goes after it.
  after: string | null;
  // The titles added from the box, in order: the "Dodane:" list.
  titles: string[];
  // The input had focus when the last add was made: the next render focuses its input again.
  focus: boolean;
  busy: boolean;
}

/** A card of the task's history. Its badge comes first when the event's signature did not verify (it is still shown). */
export function historyCard(check: EventCheck | undefined): HTMLElement {
  const card = el("section", "org-card");
  const badge = verificationBadge(check);
  if (badge) card.append(badge);
  return card;
}

const DIFFICULTIES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// A text or date field is a label around its input. The rating is a group named by its label: a label around
// buttons would make a click on the label's text press the first button (a rating of 0).
function field(label: string, control: HTMLElement): HTMLElement {
  if (control instanceof HTMLInputElement) {
    const row = el("label", "task-field");
    row.append(el("span", "task-field-label", label), control);
    return row;
  }
  const row = el("div", "task-field");
  const name = el("span", "task-field-label", label);
  name.id = `task-field-${label.replace(/\s/g, "-")}`;
  control.setAttribute("aria-labelledby", name.id);
  row.append(name, control);
  return row;
}

function textInput(value: string, list: string, onChange: (value: string) => void): HTMLInputElement {
  const input = el("input", "task-input");
  input.type = "text";
  input.value = value;
  input.setAttribute("list", list);
  input.autocomplete = "off";
  input.addEventListener("change", () => onChange(input.value.trim()));
  return input;
}

const UNITS: [string, string][] = [["m", "min"], ["h", "godz."], ["d", "dni"]];

// The largest unit that holds the minutes exactly: 1440 min is shown as 1 dzień.
function splitMinutes(min: number): { n: number; unit: string } {
  if (min % 1440 === 0) return { n: min / 1440, unit: "d" };
  if (min % 60 === 0) return { n: min / 60, unit: "h" };
  return { n: min, unit: "m" };
}

/** The reminder field: when before the due date, the repeat (empty: once) and how many times. Saves `!przypomnij:`. */
function reminderBox(task: TaskRow, run: (f: TaskField, value: string | null) => void): HTMLElement {
  const numberInput = (label: string, value: string, min: number, max: number) => {
    const input = el("input", "task-input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = value;
    input.setAttribute("aria-label", label);
    return input;
  };
  const unitSelect = (label: string, value: string) => {
    const select = el("select", "task-input");
    select.setAttribute("aria-label", label);
    select.append(...UNITS.map(([v, text]) => {
      const option = el("option", "", text);
      option.value = v;
      return option;
    }));
    select.value = value;
    return select;
  };
  const r = task.reminder;
  const before = r ? splitMinutes(r.before_min) : null;
  const every = r?.every_min ? splitMinutes(r.every_min) : null;
  const beforeN = numberInput("Ile wcześniej", before ? String(before.n) : "", 1, 999);
  const beforeU = unitSelect("Ile wcześniej: jednostka", before?.unit ?? "h");
  const everyN = numberInput("Powtarzaj co", every ? String(every.n) : "", 1, 999);
  const everyU = unitSelect("Powtarzaj co: jednostka", every?.unit ?? "h");
  const times = numberInput("Ile razy", String(r?.count ?? 1), 1, 20);
  const save = el("button", "btn", "Zapisz");
  save.type = "button";
  // an empty "Ile wcześniej" removes the reminder; the core checks the rest (its bounds are the inputs' ones)
  save.addEventListener("click", () => {
    const n = beforeN.value.trim();
    if (n === "") return run("reminder", null);
    const gap = everyN.value.trim();
    const repeats = Number(times.value);
    run("reminder", `${n}${beforeU.value}` + (gap ? `/${gap}${everyU.value}` : "") + (gap && repeats > 1 ? `x${repeats}` : ""));
  });
  const remove = el("button", "btn", "Usuń");
  remove.type = "button";
  remove.addEventListener("click", () => run("reminder", null));
  const noDue = task.due === null;
  for (const control of [beforeN, beforeU, everyN, everyU, times, save, remove]) control.disabled = noDue;
  const box = el("div", "task-reminder");
  const parts = [["Ile wcześniej", beforeN, beforeU], ["Powtarzaj co", everyN, everyU], ["Ile razy", times]] as const;
  for (const [label, ...controls] of parts) {
    const wrap = el("span", "task-reminder-part");
    wrap.append(el("span", "task-field-label", label), ...controls);
    box.append(wrap);
  }
  box.append(save, remove);
  if (noDue) box.append(el("p", "muted task-hint", "Ustaw najpierw termin."));
  return box;
}

/**
 * The panel's content for `task`. `people` are profile names and legacy handles offered by person fields.
 * `single` (a personal space, one person): no people, groups, supervisor or reminder; the added tasks have no person.
 */
export function taskPanelBody(task: TaskRow, people: string[], groups: Group[], edit: FieldEdit, notify: (message: string) => void, addTasks: AddTasks, adds: TaskAdds = { after: null, titles: [], focus: false, busy: false }, addSubtask?: AddSubtask, single = false): HTMLElement[] {
  const run = (f: TaskField, value: string | null) => {
    edit(f, value).catch((e: unknown) => notify(errorText(e)));
  };
  const heading = el("h2", "task-panel-title", "Zadanie");
  const where = el("p", "muted", `${task.project} · ${task.path}, wiersz ${task.line}`);
  // the name is written when the field loses focus or Enter is pressed, like the other fields
  const name = el("input", "task-input");
  name.type = "text";
  name.value = task.text;
  name.addEventListener("change", () => run("title", name.value.trim()));

  const list = el("datalist");
  list.id = "task-people";
  list.append(...people.map((p) => {
    const option = el("option");
    option.value = p;
    return option;
  }));

  const due = el("input", "task-input");
  due.type = "date";
  due.value = task.due === null ? "" : isoOf(task.due);
  due.addEventListener("change", () => run("due", due.value || null));

  const group = el("select", "task-input");
  group.setAttribute("aria-label", "Grupa wykonawców");
  const none = el("option", "", "Bez grupy");
  none.value = "";
  group.append(none, ...groups.filter((g) => !g.archived).map((g) => {
    const option = el("option", "", g.name);
    option.value = g.id;
    return option;
  }));
  group.value = task.group_ids?.[0] ?? "";
  group.addEventListener("change", () => run("group", group.value || null));

  const difficulty = el("div", "task-difficulty");
  difficulty.setAttribute("role", "group");
  difficulty.setAttribute("aria-label", "Trudność");
  const rated = (value: number | null) => {
    const button = el("button", "task-diff-btn", value === null ? "nieocenione" : String(value));
    button.type = "button";
    button.setAttribute("aria-pressed", String(task.difficulty === value));
    button.addEventListener("click", () => run("difficulty", value === null ? null : String(value)));
    return button;
  };
  difficulty.append(...DIFFICULTIES.map(rated), rated(null));

  const important = task.priority === "high";
  const star = el("button", "btn task-star", important ? "★ Ważne" : "☆ Oznacz jako ważne");
  star.type = "button";
  star.setAttribute("aria-pressed", String(important));
  star.addEventListener("click", () => run("priority", important ? null : STAR));

  const assignee = textInput(task.assignees[0] ?? "", "task-people", (v) => run("assignee", v || null));

  const more = el("section", "task-more");
  const input = el("input", "task-input");
  input.type = "text";
  input.setAttribute("aria-label", "Nowe zadanie dla tej samej osoby");
  input.placeholder = "Wpisz zadanie i naciśnij Enter";
  const add = el("button", "btn", "Dodaj zadanie");
  add.type = "button";
  const addedList = el("ul", "task-added");
  addedList.append(...adds.titles.map((title) => el("li", "", title)));
  const added = el("div", "task-added-box");
  added.append(el("p", "muted", "Dodane:"), addedList);
  added.hidden = adds.titles.length === 0;
  // a re-render replaces the input: the focus moves to the new one (after the render has attached it)
  if (adds.focus) setTimeout(() => input.focus());
  input.addEventListener("blur", () => { adds.focus = false; });
  // Adds the titles of `raw`: a typed line, or a pasted list with one title per line, without list markers.
  const submit = (raw: string) => {
    const titles = raw.split("\n").map((line) => line.trim().replace(/^[-*] (\[[ xX]\] )?/, "").trim()).filter((title) => title !== "");
    if (titles.length === 0 || adds.busy) return;
    adds.busy = true;
    adds.focus = true;
    addTasks(titles, single ? null : (task.assignees[0] ?? assignee.value.trim()) || null).then(() => {
      adds.busy = false;
      input.value = "";
      input.focus();
      adds.titles.push(...titles);
      addedList.append(...titles.map((title) => el("li", "", title)));
      added.hidden = false;
      toast(titles.length === 1 ? `Dodano zadanie: ${titles[0]}.` : `Dodano ${count(titles.length, "zadanie", "zadania", "zadań")}.`);
    }, (e: unknown) => {
      adds.busy = false;
      notify(errorText(e));
    });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit(input.value);
  });
  // a plain input drops line breaks from a paste, so a pasted list is taken from the clipboard
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!text.includes("\n")) return;
    e.preventDefault();
    submit(text);
  });
  add.addEventListener("click", () => submit(input.value));
  const row = el("div", "task-add-row");
  row.append(input, add);
  more.append(el("h3", "task-field-label", single ? "Więcej zadań" : "Więcej zadań dla tej samej osoby"), row, added);

  return [
    heading,
    where,
    field("Nazwa", name),
    star,
    ...(single ? [] : [
      list,
      field("Wykonawca", assignee),
      ...(task.assignees.length > 1 ? [el("p", "muted task-also", `także: ${task.assignees.slice(1).join(", ")}`)] : []),
      field("Grupa", group),
    ]),
    field("Termin", due),
    ...(single ? [] : [
      field("Nadzorujący", textInput(task.supervisor ?? "", "task-people", (v) => run("supervisor", v || null))),
      field("Przypomnienie", reminderBox(task, run)),
    ]),
    field("Trudność", difficulty),
    more,
    ...(addSubtask ? [subtaskBox(addSubtask, notify)] : []),
  ];
}
