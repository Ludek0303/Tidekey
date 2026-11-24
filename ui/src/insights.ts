import { el } from "./dom";
import { foldText } from "./bridge";
import { count } from "./transfer";
import { confirmDialog, openDialog, errorText } from "./widgets";
import { iconButton } from "./icons";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { Group } from "./taskhistory";
import type { TaskRow, ProjectRow } from "./orgtasks";
import { dayOf } from "./orgtasks";
import { activityReport, presetRange, reportFileName } from "./activityreport";
import { download } from "./records";
import { REASON_LABEL, markNotificationsRead, unreadNotifications } from "./notifications";
import { verificationBadge } from "./signing";
import {
  GROUP_COLORS,
  completionDay,
  completions,
  currentEvents,
  canAdminister,
  delegator,
  orderedGroups,
  belongs,
  personColor,
  personName,
  stats,
  conflictingTasks,
  validGroupColor,
  type OrganizationSnapshot,
  type TaskEvent,
} from "./taskhistory";

export type Insight = "people" | "notifications" | "activity" | "graphs";
export interface InsightState {
  year: number;
  person: string;
  group: string;
  project: string;
  points: boolean;
  graph: string;
  expanded: Set<string>;
  taskState: string;
  timelineStart: string;
  timelineRange: "week" | "month";
}
export interface InsightActions {
  refresh(): void;
  open(task: TaskRow): void;
  name(id: string, name: string): Promise<void>;
  group(group: Group): Promise<void>;
  openProject?(path: string): void;
  /** The organization's name, for the header of a personal report. */
  spaceName?(): Promise<string>;
  /** Opens the note by id: the fallback when a notification's task is no longer in the index. */
  openNote?(noteId: string): void;
}
interface NetworkNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: "person" | "group" | "project";
}
interface NetworkLink extends SimulationLinkDatum<NetworkNode> {
  label: string;
}
/** Up to two initials: the first letter of each of the first two words. Code points, not UTF-16 units, so emoji and
 *  astral letters stay whole; a blank name gives "". */
export function initialsOf(name: string): string {
  return name.normalize("NFC").trim().split(/\s+/).slice(0, 2).map((part) => [...part][0] ?? "").join("").toLocaleUpperCase("pl-PL");
}

/** Marks an avatar or chip with a group color (CSS: .colored); no color leaves the default look. */
function tinted<T extends HTMLElement>(node: T, color: string | undefined): T {
  if (color) {
    node.classList.add("colored");
    node.style.setProperty("--group-color", GROUP_COLORS[color].hex);
  }
  return node;
}

function button(
  label: string,
  run: () => void,
  cls = "btn",
): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", run);
  return b;
}
function select(
  label: string,
  value: string,
  items: [string, string][],
  run: (value: string) => void,
): HTMLElement {
  const wrap = el("label", "insight-filter", label);
  const input = el("select", "task-input");
  for (const [id, name] of items) {
    const opt = el("option", "", name);
    opt.value = id;
    input.append(opt);
  }
  input.value = value;
  input.addEventListener("change", () => run(input.value));
  wrap.append(input);
  return wrap;
}
export function renderInsights(
  host: HTMLElement,
  page: Insight,
  snapshot: OrganizationSnapshot,
  tasks: TaskRow[],
  projects: ProjectRow[],
  state: InsightState,
  actions: InsightActions,
): void {
  const names = {
    people: "Osoby i grupy",
    notifications: "Powiadomienia",
    activity: "Aktywność i obciążenie",
    graphs: "Grafy",
  };
  host.replaceChildren(el("h2", "", names[page]));
  if (!snapshot.verified && snapshot.space_id === "browser-demo") // real browser vaults sign events per user
    host.append(
      el(
        "p",
        "org-hint",
        "Podgląd przeglądarkowy — zdarzenia demonstracyjne nie mają podpisów urządzeń.",
      ),
    );
  const conflicts = conflictingTasks(currentEvents(snapshot.events, tasks));
  if (conflicts.size)
    host.append(
      el(
        "p",
        "firstrun-error",
        `${conflicts.size} zadań ma równoczesne zmiany wymagające sprawdzenia historii. Sprzeczne ukończenia nie są zaliczane do punktów.`,
      ),
    );
  if (page === "people") {
    people(host, snapshot, actions);
    return;
  }
  if (page === "notifications") {
    inbox(host, snapshot, tasks, actions);
    return;
  }
  const filters = el("div", "insight-filters");
  filters.append(
    select(
      "Osoba",
      state.person,
      [
        ["", "Wszystkie"],
        ...snapshot.members.map((m): [string, string] => [
          m.user_id,
          personName(snapshot, m.user_id),
        ]),
      ],
      (v) => {
        state.person = v;
        actions.refresh();
      },
    ),
  );
  if (snapshot.groups?.length) {
    filters.append(select("Grupa", state.group, [["", "Wszystkie grupy"], ...snapshot.groups.filter((g) => !g.archived).map((g): [string, string] => [g.id, g.name])], (v) => { state.group = v; actions.refresh(); }));
  }
  filters.append(
    select(
      "Projekt",
      state.project,
      [
        ["", "Wszystkie"],
        ...projects.map((p): [string, string] => [p.note, p.name]),
      ],
      (v) => {
        state.project = v;
        actions.refresh();
      },
    ),
  );
  host.append(filters);
  const filtered = tasks.filter(
    (t) => !state.project || t.project_note === state.project,
  );
  if (page === "graphs") {
    graph(host, snapshot, filtered, projects, state, actions);
    return;
  }
  const year = el("input", "task-input");
  year.type = "number";
  year.min = "1970";
  year.max = "9998";
  year.value = String(state.year);
  year.setAttribute("aria-label", "Rok aktywności");
  year.addEventListener("change", () => {
    if (year.checkValidity() && year.value) {
      state.year = Number(year.value);
      actions.refresh();
    }
  });
  filters.append(
    year,
    button(
      state.points ? "Miara: punkty trudności" : "Miara: liczba zadań",
      () => {
        state.points = !state.points;
        actions.refresh();
      },
    ),
  );
  activity(host, snapshot, filtered, state, actions);
}
function people(
  host: HTMLElement,
  s: OrganizationSnapshot,
  actions: InsightActions,
): void {
  const activeGroups = orderedGroups(s.groups ?? []).filter((g) => !g.archived);
  const header = el("div", "people-overview-header");
  const heading = el("div");
  heading.append(el("p", "eyebrow", "ZESPÓŁ ORGANIZACJI"), el("h3", "", "Osoby i grupy"), el("p", "muted", "Członkowie, role oraz zespoły w tej przestrzeni."));
  const counts = el("div", "people-overview-counts");
  for (const [value, label] of [[String(s.members.length), "osób"], [String(activeGroups.length), "grup"]]) {
    const chip = el("div", "people-count-chip"); chip.append(el("strong", "", value), el("span", "", label)); counts.append(chip);
  }
  header.append(heading, counts);
  host.append(header);
  const roleName = (role: string) => ({ Owner: "Administrator", Admin: "Koordynator", Editor: "Członek", Reader: "Obserwator" } as Record<string, string>)[role] ?? role;
  const initials = initialsOf;
  const memberGroups = (id: string) => activeGroups.filter((g) => g.member_ids.includes(id));
  const memberList = el("div", "people-grid");
  for (const m of s.members) {
    const name = personName(s, m.user_id);
    const row = el("article", "person-card");
    const top = el("div", "person-card-top");
    top.append(tinted(el("span", "person-avatar", initials(name)), personColor(s, m.user_id)));
    const identity = el("div", "person-identity");
    identity.append(el("h4", "", name));
    if (m.user_id === s.me) identity.append(el("span", "person-you", "Ty"));
    identity.append(el("span", "person-role", roleName(m.role)));
    top.append(identity);
    row.append(top);
    const groups = memberGroups(m.user_id);
    const groupLine = el("div", "person-groups");
    groupLine.append(el("span", "muted", "Grupy"));
    if (groups.length) for (const group of groups) groupLine.append(tinted(el("span", "group-chip", group.name), validGroupColor(group.color)));
    else groupLine.append(el("span", "muted", "Brak przypisania"));
    row.append(groupLine);
    const idDetails = el("details", "person-id-details");
    idDetails.append(el("summary", "", "Identyfikator osoby"), el("code", "person-id", m.user_id));
    row.append(idDetails);
    if (canAdminister(s)) {
      const edit = el("div", "person-name-edit");
      const input = el("input", "task-input");
      input.value = m.name ?? "";
      input.setAttribute("aria-label", "Nazwa osoby");
      input.maxLength = 64;
      input.placeholder = "Nazwa wyświetlana";
      const error = el("p", "firstrun-error");
      error.setAttribute("role", "alert");
      const save = button("Zapisz nazwę", () => {
        save.disabled = true;
        void actions
          .name(m.user_id, input.value.trim())
          .then(actions.refresh)
          .catch((e) => {
            error.textContent = String(e.message ?? e);
          })
          .finally(() => {
            save.disabled = false;
          });
      });
      edit.append(input, save);
      row.append(edit, error);
    }
    memberList.append(row);
  }
  host.append(el("h3", "people-section-title", "Członkowie"), el("p", "muted", "Każda osoba ma trwały identyfikator; nazwa poniżej jest aliasem używanym w notatkach."), memberList);
  const editGroup = (group?: Group) =>
    openDialog({
      label: group ? "Edytuj grupę" : "Nowa grupa",
      className: "modal-module",
      render(box, close) {
        const form = el("form", "module-form");
        const label = el("label", "insight-filter", "Nazwa grupy");
        const input = el("input", "task-input");
        input.required = true;
        input.maxLength = 200;
        input.value = group?.name ?? "";
        label.append(input);
        let color = validGroupColor(group?.color);
        const colorField = el("div", "group-color-field");
        colorField.append(el("span", "insight-filter", "Kolor grupy"));
        const swatches = el("div", "group-color-picker");
        swatches.setAttribute("role", "radiogroup");
        swatches.setAttribute("aria-label", "Kolor grupy");
        const swatch = (value: string, text: string, hex?: string) => {
          const option = el("label", "group-swatch");
          const radio = el("input");
          radio.type = "radio";
          radio.name = "group-color";
          radio.value = value;
          radio.checked = (color ?? "") === value;
          radio.setAttribute("aria-label", text);
          radio.addEventListener("change", () => {
            if (radio.checked) color = value || undefined;
          });
          const dot = el("span", "swatch-dot");
          if (hex) dot.style.setProperty("background", hex);
          else dot.classList.add("swatch-none");
          option.title = text;
          option.append(radio, dot);
          if (!hex) option.append(el("span", "swatch-text", text));
          return option;
        };
        swatches.append(swatch("", "Bez koloru"));
        for (const [value, { label: text, hex }] of Object.entries(GROUP_COLORS)) swatches.append(swatch(value, text, hex));
        colorField.append(swatches);
        const selected = new Set(group?.member_ids ?? []);
        const members = el("fieldset", "module-participants");
        members.append(el("legend", "", "Członkowie"));
        const search = el("input", "task-input");
        search.type = "search";
        search.placeholder = "Szukaj osoby";
        search.setAttribute("aria-label", "Szukaj osoby");
        const noMatch = el("p", "muted", "Nie znaleziono osoby.");
        noMatch.hidden = true;
        // Selected people stay listed while searching, so the choice remains visible.
        const rows: { id: string; name: string; row: HTMLElement; check: HTMLInputElement }[] = [];
        const applySearch = () => {
          const query = foldText(search.value.trim());
          let shown = 0;
          for (const entry of rows) {
            entry.row.hidden = !(selected.has(entry.id) || foldText(entry.name).includes(query));
            if (!entry.row.hidden) shown++;
          }
          noMatch.hidden = shown > 0;
        };
        search.addEventListener("input", applySearch);
        // Enter must not submit the dialog form; with exactly one match it ticks that person.
        search.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const query = foldText(search.value.trim());
          const matches = rows.filter((entry) => foldText(entry.name).includes(query));
          if (matches.length !== 1) return;
          matches[0].check.checked = true;
          selected.add(matches[0].id);
          applySearch();
        });
        for (const member of s.members) {
          const row = el("label");
          const check = el("input");
          check.type = "checkbox";
          check.checked = selected.has(member.user_id);
          check.addEventListener("change", () => {
            if (check.checked) selected.add(member.user_id);
            else selected.delete(member.user_id);
            applySearch();
          });
          const name = personName(s, member.user_id);
          row.append(
            check,
            document.createTextNode(name),
          );
          members.append(row);
          rows.push({ id: member.user_id, name, row, check });
        }
        members.append(noMatch);
        const error = el("p", "firstrun-error");
        error.setAttribute("role", "alert");
        const save = el("button", "btn btn-primary", "Zapisz");
        save.type = "submit";
        form.append(
          el("h2", "", group ? "Edytuj grupę" : "Nowa grupa"),
          label,
          colorField,
          search,
          members,
          error,
          save,
          button("Anuluj", close),
        );
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          if (!form.reportValidity()) return;
          save.disabled = true;
          void actions
            .group({
              id: group?.id ?? crypto.randomUUID(),
              name: input.value.trim(),
              member_ids: [...selected],
              ...(color ? { color } : {}),
            })
            .then(() => {
              close();
              actions.refresh();
            })
            .catch((e) => {
              error.textContent = errorText(e);
              save.disabled = false;
            });
        });
        box.append(form);
        input.focus();
      },
    });
  const groupHeader = el("div", "people-section-heading");
  const groupIntro = el("div");
  groupIntro.append(el("h3", "", "Grupy"), el("p", "muted", "Twórz zespoły z członków organizacji i przypisuj je do całych zadań oraz wydarzeń."));
  groupHeader.append(groupIntro);
  if (canAdminister(s)) groupHeader.append(button("＋ Nowa grupa", () => editGroup(), "btn btn-primary"));
  host.append(groupHeader);
  if (!activeGroups.length) host.append(el("p", "org-hint", "Nie utworzono jeszcze grup."));
  if (canAdminister(s)) host.append(el("p", "muted", "Przeciągnij grupy, aby ustawić kolejność. Kolejność to waga: osoba dostaje kolor pierwszej swojej grupy."));
  const groupList = el("div", "groups-grid");
  // Saves a new order: each group whose place changed gets its index and a fresh order_at (the merge keeps the newer one).
  const saveOrder = async (list: Group[], row: HTMLElement) => {
    const now = Date.now();
    try {
      for (const [order, g] of list.entries()) if (g.order !== order) await actions.group({ ...g, order, order_at: now });
      actions.refresh();
    } catch (e) {
      row.append(el("p", "firstrun-error", errorText(e)));
    }
  };
  let dragId = "";
  for (const [index, group] of activeGroups.entries()) {
    const row = el("article", "group-card");
    const top = el("div", "group-card-top");
    const groupMark = el("span", "group-avatar", initials(group.name));
    const title = el("div", "group-title");
    title.append(el("h4", "", group.name), el("span", "group-count", count(group.member_ids.length, "osoba", "osoby", "osób")));
    top.append(groupMark, title);
    if (canAdminister(s)) {
      const move = (delta: number) => {
        const list = [...activeGroups];
        const to = index + delta;
        [list[index], list[to]] = [list[to], list[index]];
        void saveOrder(list, row);
      };
      const earlier = iconButton("arrow-left", "Przenieś wcześniej");
      const later = iconButton("arrow-right", "Przenieś dalej");
      earlier.disabled = index === 0;
      later.disabled = index === activeGroups.length - 1;
      earlier.addEventListener("click", () => move(-1));
      later.addEventListener("click", () => move(1));
      const moveButtons = el("div", "group-order");
      moveButtons.append(earlier, later);
      top.append(moveButtons);
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        dragId = group.id;
        e.dataTransfer?.setData("text/plain", group.id);
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
      row.addEventListener("dragover", (e) => {
        if (dragId) e.preventDefault();
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const dragged = activeGroups.find((g) => g.id === dragId);
        dragId = "";
        if (!dragged || dragged.id === group.id) return;
        // The upper-left half of the card is the place before it, the lower-right half the place after it.
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) / rect.height + (e.clientX - rect.left) / rect.width < 1;
        const list = activeGroups.filter((g) => g.id !== dragged.id);
        list.splice(list.findIndex((g) => g.id === group.id) + (before ? 0 : 1), 0, dragged);
        void saveOrder(list, row);
      });
    }
    row.append(top);
    const roster = el("div", "group-roster");
    if (!group.member_ids.length) roster.append(el("span", "muted", "Grupa bez członków"));
    else for (const id of group.member_ids) {
      const person = s.members.find((m) => m.user_id === id);
      if (!person) continue;
      const pill = el("span", "group-member-pill");
      pill.append(tinted(el("span", "mini-avatar", initials(personName(s, id))), personColor(s, id)), el("span", "", personName(s, id)));
      roster.append(pill);
    }
    row.append(roster);
    if (canAdminister(s)) {
      const archive = button("Archiwizuj", () => {
        void confirmDialog(`Zarchiwizować grupę „${group.name}”? Grupa zniknie z list wyboru; jej historia zostanie zachowana.`, "Archiwizuj", false).then((ok) => {
          if (!ok) return;
          return actions
            .group({ ...group, archived: true })
            .then(actions.refresh)
            .catch((e) => {
              row.append(el("p", "firstrun-error", errorText(e)));
            });
        });
      });
      const actionRow = el("div", "group-actions", "");
      actionRow.append(button("Edytuj", () => editGroup(group)), archive);
      row.append(actionRow);
    }
    groupList.append(row);
  }
  host.append(groupList);
}
/** A clickable notification card: the whole card and its title call `go`, except a click on another button. */
export function notificationCard(heading: string, rowTitle: string, meta: string, go: () => void, badge: HTMLElement | null = null): HTMLElement {
  const card = el("article", "org-card is-clickable");
  const h = el("h3", "", heading);
  if (badge) h.append(" ", badge);
  card.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button")) go(); });
  card.append(h, button(rowTitle, go, "org-row-title"), el("p", "muted", meta));
  return card;
}

function inbox(
  host: HTMLElement,
  s: OrganizationSnapshot,
  tasks: TaskRow[],
  actions: InsightActions,
): void {
  // The notifications not read yet (the contract: read ones are not listed; the read state is this device's).
  const all = unreadNotifications(s);
  host.append(
    el(
      "p",
      "muted",
      "Zmiany Twoich zadań i nadzorowanych zadań, cudze zmiany, nie Twoje. Zdarzenia z innych urządzeń pojawiają się po synchronizacji.",
    ),
  );
  if (!all.length)
    host.append(el("p", "org-hint", "Nie masz powiadomień."));
  host.append(
    button("Oznacz wszystkie jako przeczytane", () => {
      if (markNotificationsRead(s, all.map((n) => n.event.event_id))) actions.refresh();
      else host.append(el("p", "firstrun-error", "Nie można zapisać stanu przeczytania."));
    }),
  );
  for (const { event, reason } of all) {
    const task = tasks.find((t) => t.block === event.after.task_id);
    // The whole card leads to the note with the task, and reading it marks it read.
    const go = () => {
      markNotificationsRead(s, [event.event_id]);
      if (task) actions.open(task);
      else actions.openNote?.(event.note_id);
    };
    host.append(
      notificationCard(
        REASON_LABEL[reason],
        event.after.title,
        `${personName(s, event.actor_user_id)}${(event as { signerAgentId?: string }).signerAgentId ? " (przez Claude)" : ""} · ${new Date(event.time_ms).toLocaleString("pl-PL")}`,
        go,
        verificationBadge(s.checks?.[event.event_id]),
      ),
    );
  }
}
// Raport osoby: one member's events in a date range, downloaded as Markdown (activityreport.ts builds the text).
function personReport(host: HTMLElement, s: OrganizationSnapshot, tasks: TaskRow[], state: InsightState, actions: InsightActions): void {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const panel = el("section", "org-card");
  panel.append(el("h3", "", "Raport osoby"));
  const person = el("select", "task-input");
  person.setAttribute("aria-label", "Osoba w raporcie");
  for (const m of [...s.members].sort((a, b) => personName(s, a.user_id).localeCompare(personName(s, b.user_id), "pl"))) {
    const option = el("option", "", personName(s, m.user_id));
    option.value = m.user_id;
    person.append(option);
  }
  if (state.person) person.value = state.person;
  const from = el("input", "task-input");
  from.type = "date";
  from.setAttribute("aria-label", "Raport od");
  const to = el("input", "task-input");
  to.type = "date";
  to.setAttribute("aria-label", "Raport do");
  const hint = el("p", "org-hint");
  const setRange = (range: { from: string; to: string }) => {
    from.value = range.from;
    to.value = range.to;
    hint.textContent = "";
  };
  const labelled = (text: string, input: HTMLElement) => {
    const wrap = el("label", "insight-filter", text);
    wrap.append(input);
    return wrap;
  };
  const filters = el("div", "insight-filters");
  filters.append(
    labelled("Osoba", person),
    labelled("od", from),
    labelled("do", to),
    button("Ten tydzień", () => setRange(presetRange("week", new Date()))),
    button("Ten miesiąc", () => setRange(presetRange("month", new Date()))),
    button("Poprzedni miesiąc", () => setRange(presetRange("lastMonth", new Date()))),
  );
  setRange(presetRange("last7", new Date()));
  panel.append(
    filters,
    button("Pobierz raport (.md)", async () => {
      if (!from.value || !to.value || from.value > to.value) {
        hint.textContent = "Podaj daty: „od” nie może być późniejsza niż „do”.";
        return;
      }
      hint.textContent = "";
      const organization = (await actions.spaceName?.().catch(() => "")) || "organizacja";
      const text = activityReport(s, tasks, { organization, person: person.value, from: from.value, to: to.value, generatedAt: new Date(), zone });
      download(reportFileName(personName(s, person.value), from.value, to.value), text);
    }),
    hint,
  );
  host.append(panel);
}

function activity(
  host: HTMLElement,
  s: OrganizationSnapshot,
  tasks: TaskRow[],
  state: InsightState,
  actions: InsightActions,
): void {
  personReport(host, s, tasks, state, actions);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const events = completions(s.events, tasks).filter(
    (e) =>
      belongs(e, state.person) &&
      (!state.group || e.after.assignees.some((name) => s.groups?.find((g) => g.id === state.group)?.member_ids.includes(e.after.people[name] ?? ""))) &&
      completionDay(e, zone).startsWith(`${state.year}-`),
  );
  const summary = stats(events);
  host.append(
    el(
      "p",
      "insight-summary",
      `${summary.count} ukończonych · ${summary.points} pkt trudności · ${summary.unrated} nieocenionych · średnia: ${summary.average?.toFixed(1) ?? "—"}`,
    ),
  );
  host.append(
    el(
      "p",
      "muted",
      `Strefa czasu: ${zone}. Punkty pochodzą z chwili ukończenia; nie oznaczają godzin pracy. Zadania bez zdarzenia ukończenia nie są zaliczane.`,
    ),
  );
  const days = new Map<string, TaskEvent[]>();
  for (const event of events) {
    const day = completionDay(event, zone);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  const grid = el("div", "activity-heatmap");
  grid.setAttribute("aria-label", `Dzienna aktywność ${state.year}`);
  const detail = el("section", "org-card");
  detail.append(el("p", "muted", "Wybierz dzień, aby zobaczyć zadania."));
  const first = new Date(Date.UTC(state.year, 0, 1));
  for (let i = 0; i < (first.getUTCDay() + 6) % 7; i++) grid.append(el("span"));
  for (
    let d = first;
    d.getUTCFullYear() === state.year;
    d = new Date(d.getTime() + 86400000)
  ) {
    const day = d.toISOString().slice(0, 10);
    const entries = days.get(day) ?? [];
    const value = stats(entries);
    const measure = state.points ? value.points : value.count;
    const cell = button(
      "",
      () => {
        detail.replaceChildren(
          el("h3", "", `${day} · ${count(value.count, "zadanie", "zadania", "zadań")} · ${value.points} pkt`),
        );
        for (const e of entries) {
          const task = tasks.find((t) => t.block === e.after.task_id);
          detail.append(
            button(
              `${e.after.title} · ${e.after.difficulty ?? "nieocenione"}`,
              () => {
                if (task) actions.open(task);
              },
              "org-row-title",
            ),
          );
          const badge = verificationBadge(s.checks?.[e.event_id]);
          if (badge) detail.append(badge);
        }
      },
      "heatmap-day",
    );
    const label = `${day}: ${count(value.count, "zadanie", "zadania", "zadań")}, ${value.points} pkt, ${value.unrated} nieocenionych`;
    cell.title = label;
    cell.setAttribute("aria-label", label);
    cell.dataset.level = String(
      measure === 0 ? 0 : Math.min(4, 1 + Math.floor(Math.log2(measure))),
    );
    grid.append(cell);
  }
  host.append(
    grid,
    el(
      "p",
      "muted",
      `${days.size} dni z aktywnością · jaśniej: mniej, ciemniej: więcej`,
    ),
    detail,
    el("h3", "", "Obciążenie zespołu"),
  );
  const people = s.members.filter((m) => (!state.person || m.user_id === state.person) && (!state.group || s.groups?.find((g) => g.id === state.group)?.member_ids.includes(m.user_id)));
  host.append(el("h3", "", "Plan i wykonanie"), el("p", "muted", "Oś pokazuje terminy otwartych zadań oraz potwierdzone daty ukończenia. Zestawienie niżej podaje bieżące obciążenie; punkty trudności nie są miarą czasu pracy."));
  const localDate = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const from = new Date(`${state.timelineStart || `${state.year}-01-01`}T00:00:00`);
  if (!Number.isFinite(from.getTime())) from.setTime(Date.now());
  const timelineDays = state.timelineRange === "week" ? 7 : 31;
  const rangeBox = el("div", "insight-filters");
  const rangeStart = el("input", "task-input"); rangeStart.type = "date"; rangeStart.value = localDate(from); rangeStart.setAttribute("aria-label", "Początek osi czasu");
  rangeStart.addEventListener("change", () => { if (rangeStart.value) { state.timelineStart = rangeStart.value; actions.refresh(); } });
  rangeBox.append(rangeStart, select("Zakres osi czasu", state.timelineRange, [["week", "7 dni"], ["month", "31 dni"]], (v) => { state.timelineRange = v as "week" | "month"; actions.refresh(); })); host.append(rangeBox);
  const timeline = el("div", "team-timeline-scroll"); const table = el("table", "team-timeline");
  const head = el("tr"); head.append(el("th", "", "Osoba"));
  const dateColumn = localDate;
  for (let offset=0; offset<timelineDays; offset++) { const date=new Date(from); date.setDate(date.getDate()+offset); const th=el("th", "", date.toLocaleDateString("pl-PL",{weekday:"short",day:"numeric",month:"numeric"})); th.title=dateColumn(date); head.append(th); }
  table.append(head);
  for (const member of people) {
    const tr=el("tr"); tr.append(el("th", "", personName(s,member.user_id)));
    for(let offset=0;offset<timelineDays;offset++) {
      const date=new Date(from);date.setDate(date.getDate()+offset);const key=dateColumn(date);const cell=el("td","timeline-cell");
      const due=tasks.filter((task)=>!task.done&&task.due===dayOf(date)&&task.assignee_user_ids?.includes(member.user_id));
      const finished=events.filter((event)=>completionDay(event,zone)===key&&belongs(event,member.user_id));
      for(const task of due)cell.append(button(`📅 ${task.text}`,()=>actions.open(task),"timeline-task"));
      for(const event of finished){const task=tasks.find((candidate)=>candidate.block===event.after.task_id);cell.append(button(`✓ ${event.after.title}`,()=>{if(task)actions.open(task);},"timeline-task is-done"));}
      tr.append(cell);
    }
    table.append(tr);
  }
  timeline.append(table);host.append(timeline);
  const summaryTable = el("table", "insight-table");
  const summaryHead = el("tr");
  for (const h of ["Osoba", "Otwarte", "Punkty otwarte", "Po terminie", "Nieocenione"]) summaryHead.append(el("th", "", h));
  summaryTable.append(summaryHead);
  for (const m of people) {
    const rows = tasks.filter(
      (t) =>
        !t.done &&
        t.assignee_user_ids?.includes(m.user_id),
    );
    const tr = el("tr");
    for (const v of [
      personName(s, m.user_id),
      rows.length,
      rows.reduce((n, t) => n + (t.difficulty ?? 0), 0),
      rows.filter((t) => t.due !== null && t.due < dayOf(new Date())).length,
      rows.filter((t) => t.difficulty === null).length,
    ])
      tr.append(el("td", "", String(v)));
    summaryTable.append(tr);
  }
  host.append(summaryTable);
}

function graph(
  host: HTMLElement,
  s: OrganizationSnapshot,
  tasks: TaskRow[],
  projects: ProjectRow[],
  state: InsightState,
  actions: InsightActions,
): void {
  if (state.group) {
    const memberIds = new Set(s.groups?.find((g) => g.id === state.group)?.member_ids ?? []);
    if (memberIds.size)
      tasks = tasks.filter((task) =>
        task.assignee_user_ids?.some((id) => memberIds.has(id)),
      );
  }
  const controls = el("div", "insight-filters");
  controls.append(
    select(
      "Relacje",
      state.graph,
      [
        ["delegation", "Delegowanie"],
        ["organization", "Osoby i zadania"],
        ["projects", "Projekty i zadania"],
      ],
      (v) => {
        state.graph = v;
        actions.refresh();
      },
    ),
  );
  controls.append(
    select(
      "Zadania pod węzłami",
      state.taskState,
      [
        ["done", "Ukończone"],
        ["open", "Otwarte"],
        ["all", "Wszystkie"],
        ["hidden", "Ukryj"],
      ],
      (v) => {
        state.taskState = v;
        actions.refresh();
      },
    ),
  );
  host.append(controls);
  const events = currentEvents(s.events, tasks);
  const done = completions(events, tasks);
  let nodes =
    state.graph === "projects"
      ? [
          ...new Map(
            tasks.map((t) => [
              t.project_note ?? t.project,
              {
                id: t.project_note ?? t.project,
                label: t.project,
                tasks: tasks.filter((r) => r.project === t.project),
              },
            ]),
          ).values(),
        ]
      : s.members
          .filter((m) => !state.person || m.user_id === state.person)
          .map((m) => ({
            id: m.user_id,
            label: personName(s, m.user_id),
            tasks: tasks.filter((t) => {
              const completion = done.find((e) => e.after.task_id === t.block);
              return t.done && completion
                ? belongs(completion, m.user_id)
                : t.assignee_user_ids?.includes(m.user_id);
            }),
          }));
  if (!nodes.length) {
    host.append(el("p", "org-hint", "Brak danych dla wybranych filtrów."));
    return;
  }
  const graphEdges: { a: string; b: string; label: string }[] = [];
  if (state.graph === "organization") {
    const groups = (s.groups ?? []).filter(
      (g) =>
        !g.archived && (!state.person || g.member_ids.includes(state.person)) && (!state.group || g.id === state.group),
    );
    nodes = [
      ...groups.map((g) => ({
        id: g.id,
        label: g.name,
        tasks: [] as TaskRow[],
      })),
      ...nodes,
    ];
    for (const group of groups)
      for (const member of group.member_ids)
        if (nodes.some((n) => n.id === member))
          graphEdges.push({
            a: group.id,
            b: member,
            label: "członkostwo w grupie",
          });
  }
  if (state.graph === "delegation") {
    const edges = new Map<
      string,
      { a: string; b: string; count: number; points: number }
    >();
    for (const t of tasks) {
      const e = delegator(events, t.block);
      if (!e) continue;
      for (const name of e.after.assignees) {
        const b = e.after.people[name];
        if (
          !b ||
          (state.person &&
            b !== state.person &&
            e.actor_user_id !== state.person)
        )
          continue;
        const key = `${e.actor_user_id}:${b}`;
        const edge = edges.get(key) ?? {
          a: e.actor_user_id,
          b,
          count: 0,
          points: 0,
        };
        edge.count++;
        if (!t.done) edge.points += t.difficulty ?? 0;
        edges.set(key, edge);
      }
    }
    const relations = el("div", "delegation-relations");
    for (const edge of edges.values()) {
      relations.append(
        el(
          "p",
          "delegation-arrow",
          `${personName(s, edge.a)} → ${personName(s, edge.b)} · ${count(edge.count, "zadanie", "zadania", "zadań")} · ${edge.points} pkt otwartych${edge.a === edge.b ? " · własne przypisanie" : ""}`,
        ),
      );
      graphEdges.push({
        a: edge.a,
        b: edge.b,
        label: `${count(edge.count, "zadanie", "zadania", "zadań")} · ${edge.points} pkt otwartych`,
      });
    }
    if (!edges.size)
      relations.append(
        el(
          "p",
          "muted",
          "Brak zarejestrowanych przypisań. Nadzorujący nie jest traktowany jako delegujący.",
        ),
      );
    // Long lists fold away behind a summary; short ones stay open.
    const collapsible = el("details", "delegation-collapsible");
    collapsible.open = edges.size <= 6;
    collapsible.append(el("summary", "", `Przypisania (${edges.size})`), relations);
    host.append(collapsible);
  }
  if (state.graph === "projects") {
    const peopleById = new Map(s.members.map((m) => [m.user_id, personName(s, m.user_id)]));
    for (const project of nodes) {
      const linked = new Set<string>();
      for (const task of project.tasks) {
        for (const id of task.assignee_user_ids ?? []) linked.add(id);
      }
      for (const id of linked) graphEdges.push({ a: project.id, b: id, label: peopleById.get(id) ?? "uczestniczy" });
    }
  }
  const map = el("div", "graph-map");
  const network = new Map<string, NetworkNode>();
  const projectById = new Map(projects.map((p) => [p.note, p]));
  const groupById = new Map((s.groups ?? []).map((g) => [g.id, g]));
  const addNetworkNode = (id: string, label: string, kind: NetworkNode["kind"]) => {
    if (!network.has(id)) network.set(id, { id, label, kind });
  };
  for (const node of nodes) {
    const kind = projectById.has(node.id) ? "project" : groupById.has(node.id) ? "group" : "person";
    addNetworkNode(node.id, node.label, kind);
  }
  for (const edge of graphEdges) {
    if (!network.has(edge.a)) {
      const person = s.members.find((m) => m.user_id === edge.a);
      const group = groupById.get(edge.a);
      const project = projectById.get(edge.a);
      addNetworkNode(edge.a, person ? personName(s, person.user_id) : group?.name ?? project?.name ?? edge.a, person ? "person" : group ? "group" : "project");
    }
    if (!network.has(edge.b)) {
      const person = s.members.find((m) => m.user_id === edge.b);
      const group = groupById.get(edge.b);
      const project = projectById.get(edge.b);
      addNetworkNode(edge.b, person ? personName(s, person.user_id) : group?.name ?? project?.name ?? edge.b, person ? "person" : group ? "group" : "project");
    }
  }
  if (network.size) {
    const ns = "http://www.w3.org/2000/svg";
    const tools = el("div", "graph-tools");
    tools.append(el("span", "muted", "Przeciągnij węzły · przewiń, aby przybliżyć · kliknij osobę, aby filtrować"));
    const zoomReadout = el("span", "graph-zoom-readout", "100%");
    const zoomOut = button("−", () => setZoom(zoom - 0.15), "btn graph-zoom"); zoomOut.setAttribute("aria-label", "Pomniejsz graf");
    const zoomIn = button("＋", () => setZoom(zoom + 0.15), "btn graph-zoom"); zoomIn.setAttribute("aria-label", "Powiększ graf");
    const reset = button("Wyśrodkuj", () => { zoom = 1; panX = 0; panY = 0; setZoom(zoom); }, "btn graph-reset");
    tools.append(zoomOut, zoomReadout, zoomIn, reset);
    const frame = el("div", "graph-network-frame");
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 1000 500");
    svg.setAttribute("aria-label", state.graph === "delegation" ? "Interaktywny graf delegowania zadań" : state.graph === "projects" ? "Interaktywny graf projektów i uczestników" : "Interaktywny graf organizacji");
    svg.setAttribute("role", "application");
    svg.setAttribute("tabindex", "0");
    const defs = document.createElementNS(ns, "defs");
    const markerId = `graph-arrow-${crypto.randomUUID()}`;
    const marker = document.createElementNS(ns, "marker");
    marker.id = markerId; marker.setAttribute("viewBox", "0 0 10 10"); marker.setAttribute("refX", "8"); marker.setAttribute("refY", "5"); marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7"); marker.setAttribute("orient", "auto-start-reverse");
    const tip = document.createElementNS(ns, "path"); tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); tip.setAttribute("fill", "context-stroke"); marker.append(tip); defs.append(marker); svg.append(defs);
    const viewport = document.createElementNS(ns, "g"); viewport.classList.add("graph-viewport"); svg.append(viewport);
    const linkLayer = document.createElementNS(ns, "g"); linkLayer.classList.add("graph-links"); viewport.append(linkLayer);
    const nodeLayer = document.createElementNS(ns, "g"); nodeLayer.classList.add("graph-nodes"); viewport.append(nodeLayer);
    const links: NetworkLink[] = graphEdges.map((edge) => ({ source: edge.a, target: edge.b, label: edge.label }));
    const linkElements = links.map((link) => {
      const group = document.createElementNS(ns, "g"); group.classList.add("graph-link-group");
      const path = document.createElementNS(ns, "path"); path.classList.add("graph-link"); path.setAttribute("marker-end", `url(#${markerId})`);
      const title = document.createElementNS(ns, "title"); title.textContent = `${network.get(String(link.source))?.label ?? link.source} → ${network.get(String(link.target))?.label ?? link.target}: ${link.label}`; path.append(title); group.append(path);
      if (state.graph === "delegation" || state.graph === "projects") { const label = document.createElementNS(ns, "text"); label.classList.add("graph-link-label"); label.textContent = link.label; group.append(label); }
      linkLayer.append(group); return { link, path, label: group.querySelector("text") as SVGTextElement | null };
    });
    const nodeElements = [...network.values()].map((node) => {
      const group = document.createElementNS(ns, "g"); group.classList.add("graph-node", `is-${node.kind}`); group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-label", `${node.label}, ${node.kind === "person" ? "osoba" : node.kind === "group" ? "grupa" : "projekt"}`);
      if (node.id === state.person || node.id === state.group || (state.graph === "projects" && node.id === state.project)) group.classList.add("is-selected");
      const circle = document.createElementNS(ns, "circle"); circle.setAttribute("r", node.kind === "project" ? "35" : "30");
      const label = document.createElementNS(ns, "text"); label.classList.add("graph-node-label"); label.textContent = node.label;
      const meta = document.createElementNS(ns, "text"); meta.classList.add("graph-node-meta"); meta.textContent = node.kind === "person" ? "OSOBA" : node.kind === "group" ? "GRUPA" : "PROJEKT";
      group.append(circle, label, meta); nodeLayer.append(group);
      const activate = () => {
        if (node.kind === "person") { state.person = state.person === node.id ? "" : node.id; actions.refresh(); }
        else if (node.kind === "project") { const project = projectById.get(node.id); if (project) actions.openProject?.(project.path); }
        else { state.group = state.group === node.id ? "" : node.id; actions.refresh(); }
      };
      group.addEventListener("click", (event) => { if (!dragged) activate(); event.stopPropagation(); });
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
      return { node, group };
    });
    let zoom = 1, panX = 0, panY = 0, dragged = false;
    const setZoom = (next: number) => { zoom = Math.max(.55, Math.min(1.8, next)); viewport.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`); zoomReadout.textContent = `${Math.round(zoom * 100)}%`; };
    let pan: { x: number; y: number; startX: number; startY: number } | null = null;
    let dragNode: { node: NetworkNode; startX: number; startY: number } | null = null;
    // Viewbox units via the screen matrix, so letterboxing (preserveAspectRatio meet) is accounted for.
    const pointer = (event: PointerEvent) => {
      const m = svg.getScreenCTM();
      if (m) { const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(m.inverse()); return { x: p.x, y: p.y }; }
      const box = svg.getBoundingClientRect(); return { x: ((event.clientX - box.left) / box.width) * 1000, y: ((event.clientY - box.top) / box.height) * 500 };
    };
    svg.addEventListener("pointerdown", (event) => {
      const target = (event.target as Element).closest(".graph-node") as SVGGElement | null;
      const p = pointer(event); dragged = false;
      if (target) { const node = nodeElements.find((entry) => entry.group === target)?.node; if (node) { target.setPointerCapture(event.pointerId); dragNode = { node, startX: p.x, startY: p.y }; node.fx = node.x; node.fy = node.y; } }
      else { svg.setPointerCapture(event.pointerId); pan = { x: panX, y: panY, startX: p.x, startY: p.y }; }
    });
    svg.addEventListener("pointermove", (event) => {
      const p = pointer(event);
      if (dragNode) { dragged ||= Math.hypot(p.x - dragNode.startX, p.y - dragNode.startY) > 3; dragNode.node.fx = (p.x - panX) / zoom; dragNode.node.fy = (p.y - panY) / zoom; simulation.alpha(.25).restart(); }
      else if (pan) { panX = pan.x + p.x - pan.startX; panY = pan.y + p.y - pan.startY; setZoom(zoom); }
    });
    const endDrag = () => { if (dragNode) { dragNode.node.fx = null; dragNode.node.fy = null; simulation.alpha(.35).restart(); window.setTimeout(() => simulation.stop(), 700); } dragNode = null; pan = null; window.setTimeout(() => { dragged = false; }, 0); };
    svg.addEventListener("pointerup", endDrag); svg.addEventListener("pointercancel", endDrag);
    svg.addEventListener("wheel", (event) => { event.preventDefault(); setZoom(zoom + (event.deltaY < 0 ? .08 : -.08)); }, { passive: false });
    const simulation = forceSimulation([...network.values()])
      .force("link", forceLink<NetworkNode, NetworkLink>(links).id((node) => node.id).distance(state.graph === "organization" ? 90 : 120).strength(.7))
      // Repulsion is capped in range and kept off the singular close-pair kick; damping keeps the layout from oscillating.
      .force("charge", forceManyBody<NetworkNode>().strength(-160).distanceMin(20).distanceMax(300))
      .force("center", forceCenter(500, 240))
      .force("collide", forceCollide<NetworkNode>().radius(62).iterations(2))
      .velocityDecay(0.4)
      .stop();
    const render = () => {
      for (const { link, path, label } of linkElements) {
        const a = link.source as NetworkNode, b = link.target as NetworkNode;
        if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
        path.setAttribute("d", `M${a.x},${a.y} L${b.x},${b.y}`);
        if (label) { label.setAttribute("x", String((a.x! + b.x!) / 2)); label.setAttribute("y", String((a.y! + b.y!) / 2 - 7)); }
      }
      for (const { node, group } of nodeElements) group.setAttribute("transform", `translate(${node.x ?? 500} ${node.y ?? 250})`);
    };
    // Settle off-screen, then fit the viewBox to the nodes plus their labels, so nothing starts clipped.
    for (let i = 0; i < 300; i++) simulation.tick();
    const xs = [...network.values()].map((n) => n.x ?? 500), ys = [...network.values()].map((n) => n.y ?? 250);
    const [minX, maxX] = [Math.min(...xs) - 110, Math.max(...xs) + 110], [minY, maxY] = [Math.min(...ys) - 90, Math.max(...ys) + 90];
    const fitW = Math.max(maxX - minX, 600), fitH = Math.max(maxY - minY, 300);
    svg.setAttribute("viewBox", `${(minX + maxX) / 2 - fitW / 2} ${(minY + maxY) / 2 - fitH / 2} ${fitW} ${fitH}`);
    simulation.on("tick", render);
    render();
    const lifecycle = new MutationObserver(() => { if (!svg.isConnected) { simulation.stop(); lifecycle.disconnect(); } });
    lifecycle.observe(host, { childList: true, subtree: true });
    frame.append(svg); map.append(tools, frame);
  } else {
    map.append(el("p", "org-hint", "Brak relacji do pokazania dla wybranych filtrów."));
  }
  const canvas = el("div", "people-graph");
  for (const node of nodes) {
    const branch = el("section", "graph-branch");
    const completed = done.filter((e) =>
      node.tasks.some((t) => t.block === e.after.task_id),
    );
    const total = stats(completed);
    const project = state.graph === "projects" ? projects.find((p) => p.note === node.id) : undefined;
    branch.append(
      project ? button(node.label, () => actions.openProject?.(project.path), "graph-person graph-project") : el("h3", "graph-person", node.label),
      el(
        "p",
        "muted",
        `${node.tasks.filter((t) => t.done).length} ukończonych · ${total.points} pkt z potwierdzonej historii`,
      ),
    );
    const rows = node.tasks.filter(
      (t) =>
        state.taskState === "all" ||
        (state.taskState === "done"
          ? t.done
          : state.taskState === "open"
            ? !t.done
            : false),
    );
    const shown = state.expanded.has(node.id) ? rows : rows.slice(0, 5);
    const list = el("div", "graph-task-branches");
    for (const task of shown) {
      const event = done.find((e) => e.after.task_id === task.block);
      const date = task.done
        ? event
          ? completionDay(
              event,
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            )
          : "brak zdarzenia ukończenia"
        : task.due === null
          ? "bez terminu"
          : new Date(task.due * 86400000).toISOString().slice(0, 10);
      const b = button(
        `${task.text}\n${task.project} · ${date} · ${task.done ? (event?.after.difficulty ?? "nieocenione") : (task.difficulty ?? "nieocenione")} pkt`,
        () => actions.open(task),
        `graph-task ${task.done ? "is-done" : "is-open"}`,
      );
      list.append(b);
    }
    branch.append(list);
    if (rows.length > 5)
      branch.append(
        button(
          state.expanded.has(node.id)
            ? "Zwiń"
            : `Rozwiń wszystkie (${rows.length})`,
          () => {
            if (state.expanded.has(node.id)) state.expanded.delete(node.id);
            else state.expanded.add(node.id);
            actions.refresh();
          },
        ),
      );
    canvas.append(branch);
  }
  map.append(canvas);
  host.append(map);
}
