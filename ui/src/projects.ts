//! Project notes: `Projekty/<Nazwa>/<Nazwa>.md` with `typ: projekt`, created from the Przegląd screen and the palette.

import * as Y from "yjs";
import type { Bridge, ProjectProtection } from "./bridge";
import { el } from "./dom";
import { KANBAN_NAME, fillKanban } from "./kanban";
import { type Group, type Member, type OrganizationSnapshot, nameLookup, orderedGroups } from "./taskhistory";
import { confirmDialog, errorText, openDialog, toast } from "./widgets";

const FORBIDDEN = /[\\/:*?"<>|\0-\x1f]/;

/** Why `name` cannot name a project, or null when it can. */
export function projectNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Podaj nazwę projektu.";
  if (FORBIDDEN.test(trimmed) || trimmed === "." || trimmed === ".." || /[. ]$/.test(trimmed)) {
    return "Nazwa projektu nie może zawierać znaków \\ / : * ? \" < > | ani kończyć się kropką lub spacją.";
  }
  return null;
}

export const projectPath = (name: string): string => `Projekty/${name}/${name}.md`;

export function projectText(name: string, lead = ""): string {
  return `---\ntyp: projekt\nstatus: aktywny\nprowadzacy:${lead ? ` ${lead}` : ""}\n---\n# ${name}\n\n## Cel projektu\n\n## Zadania\n\n`;
}

/** Creates the project note and its board (`Tablica.md`, a kanban note in the folder), and writes the first text. Returns the project note's id and path. */
export async function createProject(bridge: Bridge, name: string, lead = ""): Promise<{ id: string; path: string }> {
  const trimmed = name.trim();
  const path = projectPath(trimmed);
  const id = await bridge.call<string>("create_note", { path });
  const doc = new Y.Doc();
  doc.getText("content").insert(0, projectText(trimmed, lead));
  await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
  await fillKanban(bridge, await bridge.call<string>("create_note", { path: `${path.slice(0, path.lastIndexOf("/"))}/${KANBAN_NAME}.md` }));
  return { id, path };
}

/** The "Nowy projekt" dialog: the name and, with `github`, an optional repository address to connect at once (empty when
 *  not given). Resolves with both, or null when cancelled. */
export function askNewProject(github: boolean): Promise<{ name: string; address: string } | null> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value: { name: string; address: string } | null, close: () => void) => {
      answered = true;
      resolve(value);
      close();
    };
    openDialog({
      label: "Nowy projekt",
      className: "modal-confirm",
      render(box, close) {
        const name = el("input", "task-input");
        name.type = "text";
        name.autocomplete = "off";
        const nameLabel = el("label", "gh-field");
        nameLabel.append(el("span", "", "Nazwa projektu"), name);
        const address = el("input", "task-input");
        address.type = "text";
        address.autocomplete = "off";
        address.placeholder = "https://github.com/właściciel/repo";
        const addressLabel = el("label", "gh-field");
        addressLabel.append(el("span", "", "Połącz z GitHubem (opcjonalnie)"), address);
        const error = el("p", "firstrun-error");
        error.setAttribute("role", "alert");
        const cancel = el("button", "btn", "Anuluj");
        cancel.type = "button";
        cancel.addEventListener("click", () => finish(null, close));
        const ok = el("button", "btn btn-primary", "Utwórz");
        ok.type = "button";
        ok.addEventListener("click", () => {
          const why = projectNameError(name.value);
          if (why) error.textContent = why;
          else finish({ name: name.value.trim(), address: address.value.trim() }, close);
        });
        name.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          ok.click();
        });
        const actions = el("div", "modal-actions");
        actions.append(cancel, ok);
        box.append(el("h2", "", "Nowy projekt"), nameLabel, ...(github ? [addressLabel] : []), error, actions);
        name.focus();
      },
      onClose: () => {
        if (!answered) resolve(null);
        answered = true;
      },
    });
  });
}

/** Who sees a protected folder or note, as the members dialog returns it. */
export interface ProjectMembers {
  members: string[];
  editors: string[];
}

/** The people who see and edit a folder or note: one checkbox per vault member, the groups, and "może edytować" per
 *  person. Admins are always in. Resolves with the picked user ids, or null when cancelled. `unprotect` adds a button
 *  that lifts the protection (offered to administrators of a protected project). */
export function askProjectMembers(
  title: string,
  info: ProjectProtection,
  okLabel: string,
  groups: Group[],
  unprotect?: () => void,
  // A view for the people who may not change it: every box is disabled and the dialog only closes.
  readOnly = false,
): Promise<ProjectMembers | null> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value: ProjectMembers | null, close: () => void) => {
      answered = true;
      resolve(value);
      close();
    };
    openDialog({
      label: title,
      className: "modal-confirm",
      render(box, close) {
        const heading = el("h2", "", title);
        const admins = info.admins ?? [];
        const fixed = (userId: string) => userId === info.self || admins.includes(userId);
        const nameOf = new Map(info.candidates.map((c) => [c.userId, c.name]));
        const { list, groupList, people, groups: groupInputs, error } = peopleAndGroupsFields({
          people: info.candidates,
          addRow(list, c) {
            const row = el("div", "project-member");
            const input = el("input");
            input.type = "checkbox";
            input.value = c.userId;
            const edit = el("input");
            edit.type = "checkbox";
            edit.value = c.userId;
            // a new protection starts with only the managers editing; an existing one keeps its editors (a person added now may edit)
            edit.checked = fixed(c.userId) || (info.protected && (info.editors.length === 0 || info.editors.includes(c.userId) || !info.members.includes(c.userId)));
            const text = el("span");
            const name = el("label");
            name.append(input, text);
            const mayEdit = el("label", "muted");
            mayEdit.append(edit, " może edytować");
            row.append(name, mayEdit);
            list.append(row);
            return { userId: c.userId, name: c.name, ready: c.ready, input, edit, mayEdit, text };
          },
          groups,
          nameOf,
          checked: [],
          manual: new Set(info.members),
          show: (p, from) => {
            p.input.disabled ||= !p.ready;
            p.edit.disabled = !p.input.checked || fixed(p.userId);
            // "może edytować" only for people who have access (fixed people and group members are ticked too)
            p.mayEdit.hidden = !p.input.checked;
            const label = [p.name, fixed(p.userId) ? "(administrator)" : "", fromGroupsText(from), p.ready ? "" : "(nie ma jeszcze klucza szyfrowania)"];
            p.text.textContent = label.filter(Boolean).join(" ");
          },
          locked: fixed,
          emptyGroups: "Brak grup.",
        });
        const actions = el("div", "modal-actions");
        if (!readOnly && unprotect && info.protected && info.admin) {
          const lift = el("button", "btn", "Zdejmij ograniczenia");
          lift.type = "button";
          lift.addEventListener("click", () => {
            finish(null, close);
            unprotect();
          });
          actions.append(lift);
        }
        const cancel = el("button", "btn", readOnly ? "Zamknij" : "Anuluj");
        cancel.type = "button";
        cancel.addEventListener("click", () => finish(null, close));
        const ok = el("button", "btn btn-primary", okLabel);
        ok.type = "button";
        ok.addEventListener("click", () => {
          // Members of the picked groups count too; only vault members with a key can be given the project.
          const usable = new Set(info.candidates.filter((c) => c.ready).map((c) => c.userId));
          const picked = people.filter((p) => p.input.checked).map((p) => p.userId);
          const fromGroups = groupInputs.filter((g) => g.input.checked).flatMap((g) => g.group.member_ids);
          const members = [...new Set([...picked, ...fromGroups])].filter((id) => usable.has(id));
          const noEdit = new Set(people.filter((p) => !p.edit.checked).map((p) => p.userId));
          finish({ members, editors: members.filter((id) => !noEdit.has(id)) }, close);
        });
        if (readOnly) {
          // Only the close button, and every box shows the state as it is.
          actions.append(cancel);
          for (const input of [...list.querySelectorAll("input"), ...groupList.querySelectorAll("input")]) input.disabled = true;
          const hint = el("p", "muted", "Tylko podgląd: uprawnienia zmienia właściciel, administrator albo prowadzący projektu.");
          box.append(heading, hint, list, groupList, error, actions);
        } else {
          actions.append(cancel, ok);
          box.append(heading, list, groupList, error, actions);
        }
      },
      onClose: () => {
        if (!answered) resolve(null);
        answered = true;
      },
    });
  });
}

/**
 * The "Osoby" and "Grupy" fieldsets and the error line of the members dialogs, linked by linkGroups. `addRow` appends one
 * person's row to the people fieldset and returns its checkbox and text. The dialog adds the fieldsets, its buttons and
 * the "Brak." lines (emptyPeople is added when there are no people, emptyGroups when no group is active).
 */
export function peopleAndGroupsFields<C, T extends { userId: string; input: HTMLInputElement }>(o: {
  people: C[];
  addRow(list: HTMLElement, person: C): T;
  groups: Group[];
  nameOf: Map<string, string>;
  /** The groups ticked at first. */
  checked: string[];
  /** The people picked by hand: they stay ticked when their group is unticked. */
  manual: Set<string>;
  show(row: T, from: string[]): void;
  locked?(userId: string): boolean;
  emptyPeople?: string;
  emptyGroups: string;
}): { list: HTMLElement; groupList: HTMLElement; people: T[]; groups: { group: Group; input: HTMLInputElement }[]; error: HTMLElement } {
  const list = el("fieldset", "project-members");
  list.append(el("legend", "", "Osoby"));
  const people = o.people.map((c) => o.addRow(list, c));
  if (o.emptyPeople && !o.people.length) list.append(el("p", "muted", o.emptyPeople));
  const groupList = el("fieldset", "project-members");
  groupList.append(el("legend", "", "Grupy"));
  const active = o.groups.filter((g) => !g.archived);
  const groups = groupBoxes(groupList, active, o.nameOf);
  if (!active.length) groupList.append(el("p", "muted", o.emptyGroups));
  for (const g of groups) g.input.checked = o.checked.includes(g.group.id);
  linkGroups(people, groups, o.manual, o.show, o.locked);
  const error = el("p", "firstrun-error");
  error.setAttribute("role", "alert");
  return { list, groupList, people, groups, error };
}

/** The reason a locked person is ticked: "— z grupy Zarząd", "— z grup: Zarząd, Software", or nothing. */
export const fromGroupsText = (from: string[]): string => (from.length > 1 ? `— z grup: ${from.join(", ")}` : from.length ? `— z grupy ${from[0]}` : "");

/** One checkbox per group in `box`, with its members' names under it ("brak osób" when none). */
export function groupBoxes(box: HTMLElement, groups: Group[], nameOf: Map<string, string>): { group: Group; input: HTMLInputElement }[] {
  return groups.map((g) => {
    const row = el("div", "project-member project-member-group");
    const input = el("input");
    input.type = "checkbox";
    input.value = g.id;
    const label = el("label");
    label.append(input, el("span", "", g.name));
    const members = g.member_ids.flatMap((id) => nameOf.get(id) || []);
    row.append(label, el("small", "muted", members.join(", ") || "brak osób"));
    box.append(row);
    return { group: g, input };
  });
}

/** Keeps the people and the groups of a dialog in step. A group's members are ticked and locked while it is ticked;
 *  unticking it restores the people in `manual` (picked by hand) and drops the rest. `locked` people stay ticked and
 *  locked whatever the groups say. `show` sets each row's text and any extra state, given the groups that bring it. */
export function linkGroups<T extends { userId: string; input: HTMLInputElement }>(
  people: T[],
  groups: { group: Group; input: HTMLInputElement }[],
  manual: Set<string>,
  show: (row: T, from: string[]) => void,
  locked: (userId: string) => boolean = () => false,
): void {
  const sync = () => {
    for (const p of people) {
      const from = groups.filter((g) => g.input.checked && g.group.member_ids.includes(p.userId)).map((g) => g.group.name);
      p.input.checked = locked(p.userId) || from.length > 0 || manual.has(p.userId);
      p.input.disabled = locked(p.userId) || from.length > 0;
      show(p, from);
    }
  };
  for (const p of people)
    p.input.addEventListener("change", () => {
      if (p.input.checked) manual.add(p.userId);
      else manual.delete(p.userId);
      sync();
    });
  for (const g of groups) g.input.addEventListener("change", sync);
  sync();
}

/** The assigned groups with their members, in weight order: "Zarząd (3): Anna, Jan". Names come from `members`; without
 *  them a group shows only its count. */
export function groupLines(groups: Group[], ids: string[], members: Member[] = []): string[] {
  const nameOf = new Map(members.map((m) => [m.user_id, m.name]));
  return orderedGroups(groups.filter((g) => ids.includes(g.id))).map((g) => {
    const names = g.member_ids.flatMap((id) => nameOf.get(id) || []);
    return `${g.name} (${g.member_ids.length})${names.length ? `: ${names.join(", ")}` : ""}`;
  });
}

/** The user ids who see a project that is assigned to `people` (names), `groups` (group ids) and its `lead`: the
 *  members of the groups and the lead count too, and only vault members with a key can be picked. */
export function projectViewers(
  s: OrganizationSnapshot,
  people: string[],
  groups: string[],
  lead: string | null | undefined,
  candidates: { userId: string; ready: boolean }[],
): string[] {
  const lookup = nameLookup(s);
  const named = [...people, ...(lead ? [lead] : [])].flatMap((name) => lookup(name) ?? []);
  const grouped = (s.groups ?? []).filter((g) => groups.includes(g.id)).flatMap((g) => g.member_ids);
  const usable = new Set(candidates.filter((c) => c.ready).map((c) => c.userId));
  return [...new Set([...named, ...grouped])].filter((id) => usable.has(id));
}

/** The permissions of a folder, or of a note (which has its folder's): the members dialog, then the protect or the member
 *  write, on the folder the bridge names. `onChanged` runs after each write (the tree and the project list show the new protection). */
export async function editPermissions(bridge: Bridge, path: string, onChanged: () => void): Promise<void> {
  try {
    const [info, groups] = await Promise.all([
      bridge.call<ProjectProtection>("project_protection", { path }),
      bridge.call<OrganizationSnapshot>("organization_snapshot").then((s) => s.groups ?? [], () => []),
    ]);
    // Outside a shared vault there is no one to show: only its owner or admin may change anything, and the others get the view.
    if (!info.manage && info.candidates.length < 2) {
      toast("Uprawnienia zmienia właściciel lub administrator.");
      return;
    }
    const unprotect = () => void removeProtection(bridge, info.path, info.target, onChanged);
    const picked = await askProjectMembers("Uprawnienia", info, "Zapisz", groups, unprotect, !info.manage);
    if (!picked) return;
    await bridge.call(info.protected ? "project_set_members" : "project_protect", { path: info.path, ...picked });
    toast("Uprawnienia zapisane.");
    onChanged();
  } catch (e) {
    toast(errorText(e), true);
  }
}

async function removeProtection(bridge: Bridge, path: string, target: ProjectProtection["target"], onChanged: () => void): Promise<void> {
  const question = target === "project"
    ? "Zdjąć ochronę? Notatki projektu wrócą do zwykłej przestrzeni i będą widoczne dla wszystkich członków sejfu."
    : `Zdjąć ograniczenie? ${target === "note" ? "Ta notatka będzie widoczna" : "Ten folder będzie widoczny"} dla wszystkich członków organizacji.`;
  const ok = await confirmDialog(question, "Zdejmij ochronę");
  if (!ok) return;
  try {
    await bridge.call("project_unprotect", { path });
    toast("Ograniczenie dostępu zdjęte.");
    onChanged();
  } catch (e) {
    toast(errorText(e), true);
  }
}
