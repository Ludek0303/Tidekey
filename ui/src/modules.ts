import * as Y from "yjs";
import type { Bridge, TreeItem } from "./bridge";
import { el } from "./dom";
import { openDialog, errorText, toast } from "./widgets";
import { editNote } from "./orgedit";
import { fromGroupsText, peopleAndGroupsFields } from "./projects";
import { type CalendarDeps } from "./calendar/open";
import { cleanNoteName } from "./calendar/model";
import {
  type DataRecord,
  type ModuleData,
  download,
  ids,
  cancelledIds,
  inventoryBalance,
  inventoryCsv,
  inventoryNote,
  moduleMarkdown,
  num,
  str,
  participantsFor,
  recordConflicts,
  inOrgCalendar,
  type RecordConflict,
} from "./records";
import { verificationBadge } from "./signing";
import { CalendarView, type CalendarSource } from "./calendar/view";
import { dayAndMinute, localMidnight } from "./calendar/dates";
import { unsavedEvent, type Occurrence } from "./calendar/model";
import { canAdminister, type OrganizationSnapshot, personName } from "./taskhistory";
import {
  type Slot,
  type Override,
  localParts,
  occurrences,
  proposeMeetings,
  wallTimeToIso,
} from "./availability";

export type ModulePage = "calendars" | "inventory" | "availability";
interface Source {
  path: string | null;
  name: string;
  data: ModuleData;
  identity: OrganizationSnapshot;
}
interface Field {
  key: string;
  label: string;
  value?: string;
  type?: string;
  options?: [string, string][];
  required?: boolean;
}
export interface ModuleState {
  selected: string;
  month: string;
  view: string;
  search: string;
}
function button(
  text: string,
  action: () => void,
  cls = "btn",
): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
function select(
  label: string,
  value: string,
  options: [string, string][],
  action: (v: string) => void,
): HTMLElement {
  const wrap = el("label", "insight-filter", label);
  const input = el("select", "task-input");
  for (const [v, text] of options) {
    const opt = el("option", "", text);
    opt.value = v;
    input.append(opt);
  }
  input.value = value;
  input.addEventListener("change", () => action(input.value));
  wrap.append(input);
  return wrap;
}
function form(
  title: string,
  fields: Field[],
  submit: (values: Record<string, string>) => Promise<void>,
  extra?: HTMLElement,
): void {
  openDialog({
    label: title,
    className: "modal-module",
    render(box, close) {
      const f = el("form", "module-form");
      f.append(el("h2", "", title));
      const inputs = new Map<
        string,
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >();
      for (const field of fields) {
        const label = el("label", "insight-filter", field.label);
        const input = field.options
          ? el("select", "task-input")
          : field.type === "textarea"
            ? el("textarea", "task-input")
            : el("input", "task-input");
        if (input instanceof HTMLSelectElement)
          for (const [v, text] of field.options!) {
            const opt = el("option", "", text);
            opt.value = v;
            input.append(opt);
          }
        if (input instanceof HTMLInputElement) {
          input.type = field.type ?? "text";
          if (field.type === "number") input.step = "any";
        }
        input.value = field.value ?? field.options?.[0]?.[0] ?? "";
        input.required = field.required ?? false;
        label.append(input);
        f.append(label);
        inputs.set(field.key, input);
      }
      if (extra) f.append(extra);
      const error = el("p", "firstrun-error");
      error.setAttribute("role", "alert");
      const save = el("button", "btn btn-primary", "Zapisz");
      save.type = "submit";
      const actions = el("div", "modal-actions");
      actions.append(button("Anuluj", close), save);
      f.append(error, actions);
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!f.reportValidity()) return;
        save.disabled = true;
        error.textContent = "";
        void submit(
          Object.fromEntries(
            [...inputs].map(([key, input]) => [key, input.value.trim()]),
          ),
        )
          .then(close)
          .catch((e) => {
            error.textContent = errorText(e);
          })
          .finally(() => {
            save.disabled = false;
          });
      });
      box.append(f);
      inputs.values().next().value?.focus();
    },
  });
}

export async function renderModules(
  host: HTMLElement,
  page: ModulePage,
  bridge: Bridge,
  state: ModuleState,
  refresh: () => void,
  isCurrent: () => boolean,
): Promise<void> {
  host.replaceChildren(el("p", "muted", "Wczytywanie…"));
  try {
    const [data, identity] = await Promise.all([
      bridge.call<ModuleData>("organization_records"),
      bridge.call<OrganizationSnapshot>("organization_snapshot"),
    ]);
    if (!isCurrent()) return;
    const source: Source = {
      path: null,
      name: "Bieżąca przestrzeń",
      data,
      identity,
    };
    const save = async (record: DataRecord, from = source) => {
      await bridge.call("organization_save_record", {
        record,
        expected: from.data.revisions[record.id] ?? from.data.empty_revision,
        path: from.path,
      });
      refresh();
    };
    // The calendar page is the calendar alone, as on the ribbon: no module controls, one calendar for the organization.
    host.replaceChildren();
    if (page !== "calendars") host.append(
      el(
        "h2",
        "",
        {
          calendars: "Kalendarze",
          inventory: "Inwentarze",
          availability: "Dostępność i spotkania",
        }[page],
      ),
    );
    if (page !== "calendars" && !identity.verified && identity.space_id === "browser-demo") // real browser vaults are saved and synced
      host.append(
        el(
          "p",
          "org-hint",
          "Podgląd przeglądarkowy: dane demonstracyjne są przechowywane tylko do odświeżenia strony.",
        ),
      );
    if (page === "availability") {
      availability(host, source, save);
      return;
    }
    const kind = page === "calendars" ? "calendar" : "inventory";
    const modules = Object.values(data.records).filter(
      (r) => r.kind === kind && !r.deleted,
    );
    if (!modules.some((r) => r.id === state.selected))
      state.selected = modules[0]?.id ?? "";
    const controls = el("div", "insight-filters");
    controls.append(
      select(
        "Moduł",
        state.selected,
        modules.map((m) => [m.id, str(m, "name")]),
        (v) => {
          state.selected = v;
          refresh();
        },
      ),
    );
    controls.append(
      button("Nowy moduł", () =>
        form(
          kind === "calendar" ? "Nowy kalendarz" : "Nowy inwentarz",
          [{ key: "name", label: "Nazwa", required: true }],
          async (v) => {
            const id = crypto.randomUUID();
            await save({ id, kind, name: v.name });
            state.selected = id;
          },
        ),
      ),
    );
    if (page !== "calendars") host.append(controls);
    const file = el("input");
    file.type = "file";
    file.accept = ".md,text/markdown";
    file.hidden = true;
    controls.append(
      button("Importuj Markdown", () => file.click()),
      file,
    );
    file.addEventListener("change", () => {
      const selected = file.files?.[0];
      if (!selected) return;
      void selected
        .text()
        .then(async (text) => {
          const preview = await bridge.call<{
            version: string;
            name: string;
            changes: { before: DataRecord | null; after: DataRecord }[];
          }>("organization_import_module", {
            text,
            expected: null,
            commit: false,
          });
          const comparison = el("section", "org-card");
          comparison.append(
            el(
              "p",
              "",
              `${preview.name} · ${preview.changes.length} zmian. Pominięte rekordy pozostaną zachowane. Importowane operacje zostaną zapisane jako import wykonany przez Ciebie.`,
            ),
          );
          for (const change of preview.changes)
            comparison.append(
              el(
                "p",
                "muted",
                `${change.before ? "Zmiana" : "Dodanie"}: ${str(change.after, "name") || change.after.id}`,
              ),
            );
          form(
            "Zatwierdź import Markdown",
            [],
            async () => {
              await bridge.call("organization_import_module", {
                text,
                expected: preview.version,
                commit: true,
              });
              refresh();
            },
            comparison,
          );
        })
        .catch((e) => toast(errorText(e), true));
    });
    const module = data.records[state.selected];
    if (module) {
      controls.append(
        button("Eksportuj Markdown", () => {
          form(
            "Eksport jawnej kopii Markdown",
            [],
            async () => {
              download(
                `${str(module, "name")}.md`,
                data.markdown[module.id] ?? moduleMarkdown(module, data),
              );
            },
            el(
              "p",
              "muted",
              "Plik zawiera pełne dane modułu i historię. Zostanie zapisany poza szyfrowanym magazynem.",
            ),
          );
        }),
      );
      controls.append(
        button("Podgląd Markdown", () =>
          openDialog({
            label: "Automatyczny zapis Markdown",
            className: "modal-module",
            render(box, close) {
              const pre = el(
                "pre",
                "module-markdown",
                data.markdown[module.id] ?? moduleMarkdown(module, data),
              );
              box.append(
                el("h2", "", "Automatyczny zapis Markdown"),
                pre,
                button("Zamknij", close),
              );
            },
          }),
        ),
      );
    }
    if (module) conflictPanel(host, source, module, bridge, refresh);
    if (page === "calendars")
      calendar(host, source, save, refresh);
    else if (module) {
      inventory(host, source, module, state, save, bridge, refresh);
      void syncTableNote(module, data, identity).catch((e: unknown) => toast(errorText(e), true));
    } else
      host.append(
        el("p", "org-hint", "Utwórz inwentarz, aby dodać sprzęt i materiały."),
      );
  } catch (e) {
    if (isCurrent()) {
      const error = el("p", "firstrun-error", errorText(e));
      error.setAttribute("role", "alert");
      host.replaceChildren(error, button("Spróbuj ponownie", refresh));
    }
  }
}

function eventForm(
  source: Source,
  module: DataRecord,
  save: (r: DataRecord, s?: Source) => Promise<void>,
  existing?: DataRecord,
  initial?: { start: string; end: string; participants: string[] },
): void {
  const zone = existing
    ? str(existing, "timezone")
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wall = (iso: string) => {
    if (!iso) return "";
    const p = localParts(Date.parse(iso), zone);
    return `${p.date}T${String(Math.floor(p.minute / 60)).padStart(2, "0")}:${String(p.minute % 60).padStart(2, "0")}`;
  };
  let everyone = existing?.all_members === true;
  const nameOf = new Map(source.identity.members.map((m) => [m.user_id, personName(source.identity, m.user_id)]));
  // As in the project dialogs: a ticked group ticks and locks its members, and the people picked by hand stay ticked.
  const { list, groupList, people: rows, groups } = peopleAndGroupsFields({
    people: source.identity.members,
    addRow(box, person) {
      const input = el("input");
      input.type = "checkbox";
      input.value = person.user_id;
      const text = el("span", "", nameOf.get(person.user_id) ?? "");
      const label = el("label");
      label.append(input, text);
      const row = el("div", "project-member");
      row.append(label);
      box.append(row);
      return { userId: person.user_id, input, text };
    },
    groups: source.identity.groups ?? [],
    nameOf,
    checked: existing ? ids(existing, "group_ids") : [],
    manual: new Set(existing ? ids(existing, "participants") : (initial?.participants ?? [source.identity.me])),
    show: (row, from) => {
      row.text.textContent = [nameOf.get(row.userId), fromGroupsText(from)].filter(Boolean).join(" ");
    },
    emptyGroups: "Brak aktywnych grup.",
  });
  // Two sections, groups first: each has its own legend (the fieldsets from peopleAndGroupsFields).
  const people = el("div", "module-sections");
  people.append(groupList, list);
  const allLabel = el("label");
  const allCheck = el("input");
  allCheck.type = "checkbox";
  allCheck.checked = everyone;
  allCheck.addEventListener("change", () => {
    everyone = allCheck.checked;
  });
  allLabel.append(allCheck, document.createTextNode("Wszyscy członkowie"));
  people.append(
    allLabel,
    el(
      "p",
      "muted",
      "Zaproszenia grup i wszystkich członków uwzględniają aktualny skład organizacji.",
    ),
  );
  form(
    existing ? "Edytuj wydarzenie" : "Nowe wydarzenie",
    [
      {
        key: "name",
        label: "Nazwa",
        value: existing ? str(existing, "name") : "",
        required: true,
      },
      {
        key: "start",
        label: "Początek",
        type: "datetime-local",
        value: wall(existing ? str(existing, "start") : (initial?.start ?? "")),
        required: true,
      },
      {
        key: "end",
        label: "Koniec",
        type: "datetime-local",
        value: wall(existing ? str(existing, "end") : (initial?.end ?? "")),
        required: true,
      },
      { key: "timezone", label: "Strefa czasowa", value: zone, required: true },
      {
        key: "location",
        label: "Miejsce lub link",
        value: existing ? str(existing, "location") : "",
      },
      {
        key: "description",
        label: "Opis",
        type: "textarea",
        value: existing ? str(existing, "description") : "",
      },
      {
        key: "reminder_minutes",
        label: "Przypomnienie w otwartej aplikacji",
        value: existing ? String(existing.reminder_minutes ?? 0) : "15",
        options: [
          ["0", "Bez przypomnienia"],
          ["5", "5 minut wcześniej"],
          ["15", "15 minut wcześniej"],
          ["60", "Godzinę wcześniej"],
        ],
      },
      {
        key: "rrule",
        label: "Powtarzanie",
        value: existing ? str(existing, "rrule") : "",
        options: [
          ["", "Jednorazowo"],
          ["FREQ=DAILY", "Codziennie"],
          ["FREQ=WEEKLY", "Co tydzień"],
        ],
      },
      {
        key: "repeat_until",
        label: "Powtarzaj do (opcjonalnie)",
        type: "date",
        value: existing ? str(existing, "repeat_until") : "",
      },
      {
        key: "exceptions",
        label: "Wyjątki: daty RRRR-MM-DD rozdzielone przecinkami",
        value: existing ? ids(existing, "exceptions").join(", ") : "",
      },
    ],
    async (v) => {
      const start = wallTimeToIso(v.start, v.timezone),
        end = wallTimeToIso(v.end, v.timezone);
      if (Date.parse(end) <= Date.parse(start))
        throw new Error("Koniec musi być późniejszy niż początek.");
      const exceptions = v.exceptions
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (exceptions.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x)))
        throw new Error("Nieprawidłowa data wyjątku.");
      await save(
        {
          ...existing,
          ...v,
          id: existing?.id ?? crypto.randomUUID(),
          kind: "event",
          module_id: module.id,
          start,
          end,
          exceptions,
          reminder_minutes: Number(v.reminder_minutes),
          participants: rows.filter((r) => r.input.checked).map((r) => r.userId),
          group_ids: groups.filter((g) => g.input.checked).map((g) => g.group.id),
          all_members: everyone,
          organizer: existing?.organizer ?? source.identity.me,
        },
        source,
      );
    },
    people,
  );
}
// What a record says, for a version in a conflict: its times or its stock, and its place.
const describe = (r: DataRecord): string => [r.start, r.end, r.quantity, r.unit, r.location].filter((v) => v !== undefined && v !== "").map(String).join(" · ");

// Concurrent edits of one record by two members (records.ts recordConflicts). Both versions stay on screen until one is
// chosen; the choice is a new operation based on both, so it resolves the conflict and nothing is overwritten silently.
function conflictPanel(host: HTMLElement, source: Source, module: DataRecord, bridge: Bridge, refresh: () => void): void {
  const conflicts = recordConflicts(source.data.operations).filter((c) => c.a.record.after.module_id === module.id);
  if (!conflicts.length) return;
  const section = el("section", "org-card is-conflict");
  section.append(el("h3", "", `Konflikt · ${conflicts.length}`));
  for (const conflict of conflicts) {
    const row = el("div", "org-card-row");
    row.append(el("strong", "", `${str(conflict.a.record.after, "name") || conflict.record} `), el("span", "org-badge is-warning", "Konflikt"));
    const versions = el("div", "org-conflict-versions");
    for (const op of [conflict.a, conflict.b] as const) {
      const version = el("div", "org-card-row");
      version.append(el("span", "muted", `${personName(source.identity, op.actor_user_id)} · ${new Date(op.time_ms).toLocaleString("pl-PL")}`));
      const badge = verificationBadge(source.data.checks?.[op.event_id]);
      if (badge) version.append(badge);
      version.append(el("p", "", describe(op.record.after) || op.record.after.kind));
      version.append(button("Zachowaj tę wersję", () => void keepVersion(bridge, source, conflict, op.record.after, refresh)));
      versions.append(version);
    }
    row.append(versions);
    section.append(row);
  }
  host.append(section);
}

async function keepVersion(bridge: Bridge, source: Source, conflict: RecordConflict, record: DataRecord, refresh: () => void): Promise<void> {
  try {
    await bridge.call("organization_save_record", {
      record: structuredClone(record),
      expected: source.data.revisions[conflict.record] ?? source.data.empty_revision,
      path: source.path,
      base: [conflict.a.event_id, conflict.b.event_id],
    });
    toast("Zapisano wybraną wersję.");
  } catch (e) {
    toast(errorText(e), true);
  }
  refresh();
}

// The organization's calendars drawn by the note calendar's own view, so both look and work the same; only where the
// events come from and what a click opens differ. One view for the whole session keeps its mode and date across
// refreshes.
let orgCalendar: { root: HTMLElement; view: CalendarView } | null = null;

function openOrgEvent(
  source: Source,
  event: DataRecord,
  occurrence: { start: number; end: number },
  save: (r: DataRecord, s?: Source) => Promise<void>,
): void {
  openDialog({
    label: str(event, "name"),
    className: "modal-module",
    render(box, close) {
      box.append(
        el("h2", "", str(event, "name")),
        el(
          "p",
          "",
          `${new Date(occurrence.start).toLocaleString("pl-PL")} – ${new Date(occurrence.end).toLocaleString("pl-PL")}`,
        ),
        el(
          "p",
          "muted",
          `${str(event, "timezone")} · ${str(event, "location")}`,
        ),
        el("p", "", str(event, "description")),
        el(
          "p",
          "muted",
          `Uczestnicy: ${ids(event, "participants")
            .map((id) => personName(source.identity, id))
            .join(", ")}`,
        ),
      );
      const actions = el("div", "modal-actions");
      actions.append(
        button("Edytuj", () => {
          close();
          const m = source.data.records[str(event, "module_id")];
          if (m) eventForm(source, m, save, event);
        }),
      );
      actions.append(
        button("Usuń wydarzenie", () => {
          close();
          form(
            "Usuń wydarzenie",
            [],
            async () => {
              await save({ ...event, deleted: true }, source);
            },
            el(
              "p",
              "",
              "Wydarzenie zostanie usunięte z kalendarza. Historia pozostanie dostępna.",
            ),
          );
        }),
      );
      if (
        participantsFor(event, source.identity).includes(
          source.identity.me,
        )
      )
        for (const [response, label] of [
          ["yes", "Wezmę udział"],
          ["maybe", "Może"],
          ["no", "Nie wezmę udziału"],
        ])
          actions.append(
            button(label, () => {
              const id = `rsvp-${event.id}-${source.identity.me}`;
              void save(
                {
                  id,
                  kind: "rsvp",
                  module_id: event.module_id,
                  event_id: event.id,
                  user_id: source.identity.me,
                  response,
                },
                source,
              )
                .then(close)
                .catch((e) => toast(errorText(e), true));
            }),
          );
      actions.append(button("Zamknij", close));
      box.append(actions);
    },
  });
}

// An event asked for from "Mój kalendarz" before this organization's calendar page was drawn (main.ts addEventHere).
let pendingOrgEvent: { day: number; startMin: number | null } | null = null;
export function requestOrgEvent(day: number, startMin: number | null): void {
  pendingOrgEvent = { day, startMin };
}

function calendar(
  host: HTMLElement,
  current: Source,
  save: (r: DataRecord, s?: Source) => Promise<void>,
  refresh: () => void,
): void {
  // the view holds the events it was given, so a write here draws it again with the new ones
  const saveAndShow = (r: DataRecord, s?: Source) => save(r, s).then(refresh);
  // Every calendar module of the organization together: a member sees the events that concern them, an owner or admin all of them.
  const shown = Object.values(current.data.records)
    .filter((r) => r.kind === "event" && !r.deleted && inOrgCalendar(r, current.identity))
    .map((event) => ({ source: current, event }));
  // each occurrence's own record, for its details
  const origin = new WeakMap<object, { source: Source; event: DataRecord; start: number; end: number }>();
  const calendarSource: CalendarSource = {
    occurrences(fromDay, toDay) {
      const from = localMidnight(fromDay), until = localMidnight(toDay + 1);
      return shown.flatMap(({ source, event }) =>
        occurrences(event, from, until).map(({ start, end }) => {
          const [startDay, startMin] = dayAndMinute(start);
          const [endDay, endMin] = dayAndMinute(end);
          const calEvent = unsavedEvent(
            str(event, "name"),
            { startDay, startMin, endDay, endMin },
            { id: event.id, rrule: str(event, "rrule") || null, description: str(event, "description") },
          );
          origin.set(calEvent, { source, event, start, end });
          return { event: calEvent, startDay, startMin, endDay, endMin } satisfies Occurrence;
        }),
      );
    },
    details(occ) {
      const found = origin.get(occ.event);
      if (found) openOrgEvent(found.source, found.event, found, saveAndShow);
    },
    create(day, startMin) {
      const start = localMidnight(day) + (startMin ?? 9 * 60) * 60_000;
      const open = (cal: DataRecord) => eventForm(current, cal, saveAndShow, undefined, { start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString(), participants: [] });
      const cal = Object.values(current.data.records).find((r) => r.kind === "calendar" && !r.deleted);
      if (cal) return open(cal);
      // the organization has one calendar: make it silently; save refreshes the page, the form is a dialog on the new record
      const created = { id: crypto.randomUUID(), kind: "calendar", name: "Kalendarz" };
      void save(created).then(() => open(created)).catch((e: unknown) => toast(errorText(e), true));
    },
  };
  if (!orgCalendar) {
    const root = el("div", "module-calendar");
    orgCalendar = { root, view: new CalendarView(root, () => undefined) };
  }
  host.append(orgCalendar.root);
  orgCalendar.view.showSource(calendarSource);
  if (pendingOrgEvent) {
    const { day, startMin } = pendingOrgEvent;
    pendingOrgEvent = null;
    calendarSource.create(day, startMin);
  }
}

// The notes that mirror an inventory (inventoryNote): the explorer's notes and the documents of the open tabs.
let tableNotes: { deps: CalendarDeps; openDoc: (id: string) => Y.Doc | null } | null = null;

/** main.ts calls it once. */
export function setTableNotes(deps: CalendarDeps, openDoc: (id: string) => Y.Doc | null): void {
  tableNotes = { deps, openDoc };
}

// shortcut: the note is found by the inventory's name, so after a rename the old note stops updating and a new one is made.
const tableNotePath = (module: DataRecord): string => `Inwentarze/${cleanNoteName(str(module, "name")) || "Inwentarz"}.md`;
const tableNoteOf = (module: DataRecord): TreeItem | undefined => tableNotes?.deps.items().find((i) => i.path === tableNotePath(module));
// The custodian's name in the inventory tables; blank when nobody has it.
const custodianName = (identity: OrganizationSnapshot) => (id: string): string => (id ? personName(identity, id) : "");
const itemsOf = (data: ModuleData, module: DataRecord): DataRecord[] =>
  Object.values(data.records).filter((r) => r.kind === "item" && r.module_id === module.id && !r.deleted);

// The text each inventory's note was last written with, so a render with no change does not rewrite the note.
const tableNoteTexts = new Map<string, string>();

/** Rewrites the inventory's note when it exists. A note at that path that is not this inventory's is left alone. */
async function syncTableNote(module: DataRecord, data: ModuleData, identity: OrganizationSnapshot): Promise<void> {
  const item = tableNoteOf(module);
  if (!tableNotes || !item) return;
  const text = inventoryNote(module, itemsOf(data, module), data.operations, custodianName(identity));
  if (tableNoteTexts.get(module.id) === text) return;
  let next = "";
  await editNote(
    { bridge: tableNotes.deps.bridge, openDoc: tableNotes.openDoc },
    item.id,
    (old) => (next = old.includes(`\nmodul: ${module.id}\n`) ? text : old),
  );
  tableNotes.deps.written?.(item.id, next);
  if (next === text) tableNoteTexts.set(module.id, text);
}

async function createTableNote(deps: CalendarDeps, module: DataRecord, data: ModuleData, identity: OrganizationSnapshot): Promise<TreeItem> {
  const item = await deps.create(tableNotePath(module));
  const text = inventoryNote(module, itemsOf(data, module), data.operations, custodianName(identity));
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await deps.bridge.call("apply_update", { id: item.id, update: Y.encodeStateAsUpdate(doc) });
  deps.written?.(item.id, text);
  tableNoteTexts.set(module.id, text);
  return item;
}

function inventory(
  host: HTMLElement,
  source: Source,
  module: DataRecord,
  state: ModuleState,
  save: (r: DataRecord) => Promise<void>,
  bridge: Bridge,
  refresh: () => void,
): void {
  const { data, identity } = source;
  const items = itemsOf(data, module);
  const edit = (r?: DataRecord) =>
    form(
      r ? "Karta przedmiotu" : "Nowa pozycja",
      (
        [
          { key: "name", label: "Nazwa", required: true },
          { key: "category", label: "Kategoria", required: true },
          { key: "manufacturer", label: "Producent" },
          { key: "model", label: "Model" },
          { key: "serial", label: "Numer seryjny / inwentarzowy" },
          {
            key: "quantity",
            label: "Ilość bazowa",
            type: "number",
            required: true,
            value: "1",
          },
          { key: "unit", label: "Jednostka", required: true, value: "szt." },
          { key: "location", label: "Miejsce przechowywania", required: true },
          {
            key: "status",
            label: "Status",
            options: [
              ["available", "Dostępny"],
              ["repair", "W naprawie"],
              ["damaged", "Uszkodzony"],
              ["retired", "Wycofany"],
            ],
          },
          {
            key: "custodian",
            label: "Opiekun",
            options: [
              ["", "Nieprzypisany"],
              ...identity.members.map((m): [string, string] => [
                m.user_id,
                personName(identity, m.user_id),
              ]),
            ],
          },
          { key: "project", label: "Projekt" },
          { key: "purchase_date", label: "Data zakupu", type: "date" },
          { key: "supplier", label: "Dostawca" },
          { key: "price", label: "Cena" },
          {
            key: "notes",
            label: "Uwagi i linki do dokumentacji",
            type: "textarea",
          },
        ] satisfies Field[]
      ).map((f) => ({ ...f, value: r ? String(r[f.key] ?? "") : f.value })),
      async (v) => {
        if (!v.category.trim()) throw new Error("Podaj kategorię przedmiotu.");
        if (!v.location.trim()) throw new Error("Podaj miejsce przechowywania.");
        const quantity = Number(v.quantity);
        if (!Number.isFinite(quantity) || quantity < 0)
          throw new Error("Ilość musi być nieujemna.");
        await save({
          ...r,
          ...v,
          id: r?.id ?? crypto.randomUUID(),
          kind: "item",
          module_id: module.id,
          quantity,
        });
      },
    );
  const toolbar = el("div", "insight-filters");
  const search = el("input", "task-input");
  search.type = "search";
  search.placeholder = "Szukaj sprzętu lub lokalizacji";
  search.setAttribute("aria-label", "Szukaj w inwentarzu");
  search.value = state.search;
  toolbar.append(
    search,
    button("Dodaj pozycję", () => edit()),
    button("Eksportuj CSV", () =>
      download(
        `${str(module, "name")}.csv`,
        inventoryCsv(items, data.operations, custodianName(identity)),
        "text/csv;charset=utf-8",
      ),
    ),
  );
  const note = tableNoteOf(module);
  if (tableNotes)
    toolbar.append(
      button(note ? "Otwórz notatkę z tabelą" : "Utwórz notatkę z tabelą", () => {
        const deps = tableNotes!.deps;
        void (async () => {
          if (note) return deps.open(note);
          const item = await createTableNote(deps, module, data, identity);
          refresh();
          await deps.open(item);
        })().catch((e: unknown) => toast(errorText(e), true));
      }),
    );
  host.append(toolbar);
  const table = el("table", "insight-table");
  const head = el("tr");
  for (const name of [
    "Nazwa",
    "Kategoria",
    "Dostępne / razem",
    "Miejsce",
    "Status",
    "Działania",
  ])
    head.append(el("th", "", name));
  table.append(head);
  const body = el("tbody");
  table.append(body);
  host.append(table);
  const draw = () => {
    body.replaceChildren();
    const cancelled = cancelledIds(data.operations);
    for (const item of items
      .filter((r) =>
        `${str(r, "name")} ${str(r, "location")} ${str(r, "category")}`
          .toLowerCase()
          .includes(state.search.toLowerCase()),
      )
      .sort((a, b) => str(a, "name").localeCompare(str(b, "name"), "pl"))) {
      const balance = inventoryBalance(item, data.operations, cancelled);
      const row = el("tr");
      const name = el("td");
      name.append(button(str(item, "name"), () => edit(item), "org-row-title"));
      row.append(
        name,
        el("td", str(item, "category") ? "" : "inventory-missing-meta", str(item, "category") || "Uzupełnij kategorię"),
        el(
          "td",
          balance.conflict ? "inventory-conflict" : "",
          balance.conflict
            ? `Konflikt (${balance.available})`
            : `${balance.available} / ${num(item, "quantity")} ${str(item, "unit")}`,
        ),
        el("td", str(item, "location") ? "" : "inventory-missing-meta", str(item, "location") || "Uzupełnij miejsce"),
        el("td", "", str(item, "status")),
      );
      const controls = el("td", "inventory-actions");
      for (const [issue, label] of [
        [true, "Wydaj"],
        [false, "Zwróć"],
      ] as const) {
        const b = button(label, () =>
          form(
            label,
            [
              {
                key: "quantity",
                label: "Ilość",
                type: "number",
                value: "1",
                required: true,
              },
              {
                key: "borrower",
                label: "Odbiorca",
                options: identity.members.map((m) => [
                  m.user_id,
                  personName(identity, m.user_id),
                ]),
              },
            ],
            async (v) => {
              await bridge.call("organization_movement", {
                id: crypto.randomUUID(),
                itemId: item.id,
                quantity: Number(v.quantity),
                issue,
                borrower: v.borrower,
              });
              refresh();
            },
          ),
        );
        b.disabled =
          balance.conflict ||
          (issue &&
            (balance.available <= 0 || str(item, "status") !== "available"));
        controls.append(b);
      }
      controls.append(
        button("Historia", () =>
          openDialog({
            label: "Historia przedmiotu",
            className: "modal-module",
            render(box, close) {
              box.append(el("h2", "", str(item, "name")));
              for (const op of data.operations.filter(
                (op) => op.record.after.item_id === item.id,
              )) {
                const r = op.record.after;
                const row = el("section", "org-card");
                row.append(
                  el(
                    "p",
                    "",
                    `${new Date(op.time_ms).toLocaleString("pl-PL")} · ${r.kind === "movement_cancel" ? "anulowanie operacji" : r.issue ? "wydanie" : "zwrot"} ${num(r, "quantity")} · ${personName(identity, op.actor_user_id)}`,
                  ),
                );
                if (r.kind === "movement_cancel")
                  row.append(el("p", "muted", str(r, "reason")));
                const cancelled = data.operations.some(
                  (o) =>
                    o.record.after.kind === "movement_cancel" &&
                    o.record.after.target_id === r.id,
                );
                if (cancelled)
                  row.append(
                    el(
                      "p",
                      "muted",
                      "Operacja anulowana — zachowana w historii.",
                    ),
                  );
                if (
                  canAdminister(identity) &&
                  r.kind === "movement" &&
                  !cancelled
                )
                  row.append(
                    button("Anuluj tę operację", () => {
                      close();
                      form(
                        "Korekta operacji magazynowej",
                        [
                          {
                            key: "reason",
                            label: "Uzasadnienie",
                            required: true,
                            type: "textarea",
                          },
                        ],
                        async (v) => {
                          await bridge.call("organization_cancel_movement", {
                            targetId: r.id,
                            reason: v.reason,
                          });
                          refresh();
                        },
                      );
                    }),
                  );
                box.append(row);
              }
              box.append(button("Zamknij", close));
            },
          }),
        ),
      );
      row.append(controls);
      body.append(row);
    }
  };
  search.addEventListener("input", () => {
    state.search = search.value;
    draw();
  });
  draw();
  if (!items.length)
    host.append(
      el("p", "org-hint", "Nie ma jeszcze pozycji w tym inwentarzu."),
    );
}

function availability(
  host: HTMLElement,
  source: Source,
  save: (r: DataRecord) => Promise<void>,
): void {
  const { data, identity } = source;
  const all = Object.values(data.records);
  const own = all.find(
    (r) => r.kind === "availability" && r.user_id === identity.me,
  );
  let slots: Slot[] = structuredClone((own?.weekly_slots ?? []) as Slot[]);
  let overrides: Override[] = structuredClone(
    (own?.date_overrides ?? []) as Override[],
  );
  const timezone = el("input", "task-input");
  timezone.value = own
    ? str(own, "timezone")
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  timezone.setAttribute("aria-label", "Twoja strefa czasowa");
  host.append(
    el(
      "p",
      "muted",
      "Zaznacz dostępne półgodzinne przedziały. Kolejne kliknięcie oznacza termin preferowany, następne usuwa dostępność. Plan jest widoczny w tej organizacji.",
    ),
    timezone,
  );
  const grid = el("div", "availability-grid");
  for (let day = 0; day < 7; day++) {
    const column = el("section");
    column.append(
      el("h3", "", ["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"][day]),
    );
    for (let start = 0; start < 1440; start += 30) {
      const label = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
      const b = button(
        label,
        () => {
          const hit = slots.find((s) => s.day === day && s.start === start);
          if (!hit) slots.push({ day, start, end: start + 30 });
          else if (!hit.preferred) hit.preferred = true;
          else slots = slots.filter((s) => s !== hit);
          paint();
        },
        "availability-slot",
      );
      const paint = () => {
        const hit = slots.find((s) => s.day === day && s.start === start);
        b.dataset.state = hit?.preferred ? "preferred" : hit ? "yes" : "no";
        b.setAttribute(
          "aria-label",
          `${["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota", "Niedziela"][day]} ${label}: ${hit?.preferred ? "preferowany" : hit ? "dostępny" : "niedostępny"}`,
        );
        b.setAttribute("aria-pressed", String(!!hit));
      };
      paint();
      column.append(b);
    }
    grid.append(column);
  }
  host.append(grid);
  const exceptions = el("section", "org-card");
  const draw = () => {
    exceptions.replaceChildren(el("h3", "", "Wyjątki"));
    overrides.forEach((o, i) =>
      exceptions.append(
        button(
          `${o.date} · ${Math.floor(o.start / 60)}:${String(o.start % 60).padStart(2, "0")}–${Math.floor(o.end / 60)}:${String(o.end % 60).padStart(2, "0")} · ${o.available ? "dostępny" : "niedostępny"} · usuń`,
          () => {
            overrides.splice(i, 1);
            draw();
          },
        ),
      ),
    );
  };
  draw();
  host.append(exceptions);
  host.append(
    button("Dodaj wyjątek", () =>
      form(
        "Wyjątek od planu",
        [
          { key: "date", label: "Data", type: "date", required: true },
          {
            key: "start",
            label: "Od",
            type: "time",
            value: "00:00",
            required: true,
          },
          {
            key: "end",
            label: "Do",
            type: "time",
            value: "23:59",
            required: true,
          },
          {
            key: "available",
            label: "Dostępność",
            options: [
              ["no", "Niedostępny"],
              ["yes", "Dostępny"],
            ],
          },
        ],
        async (v) => {
          const minutes = (s: string) =>
            Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
          if (minutes(v.end) <= minutes(v.start))
            throw new Error("Koniec musi być późniejszy.");
          overrides.push({
            date: v.date,
            start: minutes(v.start),
            end: minutes(v.end),
            available: v.available === "yes",
          });
          draw();
        },
      ),
    ),
    button("Zapisz mój plan", () => {
      try {
        new Intl.DateTimeFormat("pl", { timeZone: timezone.value });
      } catch {
        toast("Nieprawidłowa strefa czasowa.", true);
        return;
      }
      void save({
        ...own,
        id: own?.id ?? `availability-${identity.me}`,
        kind: "availability",
        user_id: identity.me,
        timezone: timezone.value,
        weekly_slots: slots,
        date_overrides: overrides,
        updated_at: new Date().toISOString(),
      }).catch((e) => toast(errorText(e), true));
    }),
  );
  host.append(el("h3", "", "Zaplanuj spotkanie"));
  const chosen = new Set(identity.members.map((m) => m.user_id));
  const selectors = el("div", "module-participants");
  for (const m of identity.members) {
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.checked = true;
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(m.user_id);
      else chosen.delete(m.user_id);
    });
    label.append(box, document.createTextNode(personName(identity, m.user_id)));
    selectors.append(label);
  }
  host.append(selectors);
  const results = el("div");
  host.append(
    button("Szukaj wspólnego terminu", () =>
      form(
        "Zakres wyszukiwania",
        [
          {
            key: "from",
            label: "Od",
            type: "date",
            value: new Date().toISOString().slice(0, 10),
            required: true,
          },
          {
            key: "until",
            label: "Do (maksymalnie 31 dni)",
            type: "date",
            required: true,
          },
          {
            key: "minutes",
            label: "Czas trwania w minutach",
            type: "number",
            value: "60",
            required: true,
          },
        ],
        async (v) => {
          const from = Date.parse(
            wallTimeToIso(`${v.from}T00:00`, timezone.value),
          );
          const until = Date.parse(
            wallTimeToIso(`${v.until}T23:30`, timezone.value),
          );
          if (until <= from || until - from > 32 * 86400000)
            throw new Error("Wybierz zakres do 31 dni.");
          const events = all.map((r) =>
            r.kind === "event"
              ? { ...r, participants: participantsFor(r, identity) }
              : r,
          );
          const proposals = proposeMeetings(
            [...chosen],
            [...chosen],
            all,
            events,
            from,
            until,
            Number(v.minutes),
          );
          results.replaceChildren(
            el("h3", "", `Propozycje: ${proposals.length}`),
          );
          if (!proposals.length)
            results.append(
              el(
                "p",
                "org-hint",
                "Brak wspólnego terminu. Brak deklaracji nie jest traktowany jako dostępność.",
              ),
            );
          for (const proposal of proposals)
            results.append(
              button(
                `${new Date(proposal.start).toLocaleString("pl-PL")} · ${proposal.available.length} dostępnych`,
                () => {
                  const calendars = all.filter(
                    (r) => r.kind === "calendar" && !r.deleted,
                  );
                  if (!calendars.length) {
                    toast("Najpierw utwórz kalendarz organizacji.", true);
                    return;
                  }
                  form(
                    "Kalendarz spotkania",
                    [
                      {
                        key: "calendar",
                        label: "Kalendarz",
                        options: calendars.map((r) => [r.id, str(r, "name")]),
                      },
                    ],
                    async (values) => {
                      const module = calendars.find(
                        (r) => r.id === values.calendar,
                      )!;
        setTimeout(() => eventForm(source, module, save, undefined, {
          start: proposal.start,
          end: proposal.end,
          participants: [...chosen],
        }), 0);
                    },
                  );
                },
              ),
            );
          results.append(
            el(
              "p",
              "muted",
              "Propozycja nie rezerwuje terminu. Sprawdź aktualne dane przed zatwierdzeniem spotkania.",
            ),
          );
        },
      ),
    ),
    results,
  );
}
