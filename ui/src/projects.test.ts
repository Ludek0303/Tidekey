// @vitest-environment jsdom
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "./bridge";
import type { ProjectProtection } from "./bridge";
import { askNewProject, askProjectMembers, createProject, editPermissions, groupLines, projectNameError, projectPath, projectText, projectViewers } from "./projects";
import type { Group, OrganizationSnapshot } from "./taskhistory";
import { KANBAN_TEXT } from "./kanban";

describe("project notes", () => {
  it("refuses names that are not plain file names", () => {
    expect(projectNameError("  ")).toBe("Podaj nazwę projektu.");
    expect(projectNameError("a/b")).toMatch(/nie może zawierać/);
    expect(projectNameError("..")).toMatch(/nie może zawierać/);
    expect(projectNameError("Koniec.")).toMatch(/kropką/);
    expect(projectNameError("Sonda")).toBeNull();
  });

  it("makes the note at Projekty/<Nazwa>/<Nazwa>.md with its front matter and headings", async () => {
    expect(projectPath("Plan")).toBe("Projekty/Plan/Plan.md");
    const text = projectText("Plan");
    expect(text).toContain("typ: projekt\nstatus: aktywny\nprowadzacy:\n");
    expect(text).toContain("# Plan\n\n## Cel projektu\n\n## Zadania\n");

    const bridge = new MockBridge([]);
    const made = await createProject(bridge, "Plan");
    expect(made.path).toBe("Projekty/Plan/Plan.md");
    const check = new Y.Doc();
    Y.applyUpdate(check, await bridge.call<Uint8Array>("open_note", { id: made.id }));
    expect(check.getText("content").toString()).toBe(text);
    // the project's board: a kanban note in the same folder
    const board = (await bridge.call<{ notes: { id: string; path: string }[] }>("list_tree")).notes.find((n) => n.path === "Projekty/Plan/Tablica.md");
    const boardText = new Y.Doc();
    Y.applyUpdate(boardText, await bridge.call<Uint8Array>("open_note", { id: board!.id }));
    expect(boardText.getText("content").toString()).toBe(KANBAN_TEXT);
  });
});

const snapshot = {
  me: "A",
  owner: "A",
  space_id: "s",
  verified: true,
  members: [
    { user_id: "A", name: "Ala", role: "Owner" },
    { user_id: "B", name: "Basia", role: "Member" },
    { user_id: "C", name: "Czesio", role: "Member" },
    { user_id: "D", name: "Darek", role: "Member" },
  ],
  events: [],
  fields: {},
  aliases: { C: ["Cezary"] },
  groups: [
    { id: "g1", name: "Zespół", member_ids: ["C", "D"] },
    { id: "g2", name: "Stary", member_ids: ["B"], archived: true },
  ],
} as unknown as OrganizationSnapshot;

const candidates = [
  { userId: "A", name: "Ala", ready: true },
  { userId: "B", name: "Basia", ready: true },
  { userId: "C", name: "Czesio", ready: true },
  { userId: "D", name: "Darek", ready: false },
];

describe("project viewers", () => {
  it("resolves names, aliases, the lead and group members to ready vault members", () => {
    expect(projectViewers(snapshot, ["Basia", "Cezary"], ["g1"], "Ala", candidates).sort()).toEqual(["A", "B", "C"]);
    // D has no key yet, so cannot be given the project even through a group
    expect(projectViewers(snapshot, [], ["g1"], null, candidates)).toEqual(["C"]);
    expect(projectViewers(snapshot, ["Nikt"], [], null, candidates)).toEqual([]);
  });
});

describe("members dialog", () => {
  it("picks people, groups and editors, and leaves out members without a key", async () => {
    const info = {
      protected: true,
      member: true,
      manage: true,
      admin: true,
      self: "A",
      members: ["A", "B"],
      candidates,
      editors: ["A", "B"],
      target: "project",
      admins: ["A"],
    } as unknown as ProjectProtection;
    const result = askProjectMembers("Uprawnienia", info, "Zapisz", snapshot.groups ?? []);
    const rows = [...document.querySelectorAll<HTMLElement>(".project-member")];
    expect(rows[0].textContent).toContain("Ala (administrator)");
    // Basia may not edit; Czesio joins through the group Zespół, which picks up Darek without a key too
    const person = (i: number) => rows[i].querySelectorAll("input")[0];
    const edit = (i: number) => rows[i].querySelectorAll("input")[1];
    edit(1).click();
    person(2).click();
    const group = document.querySelectorAll<HTMLInputElement>("fieldset")[1].querySelector<HTMLInputElement>("input")!;
    group.click();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Zapisz")!.click();
    expect(await result).toEqual({ members: ["A", "B", "C"], editors: ["A", "C"] });
  });
});


describe("permissions of a note", () => {
  it("lifts the protection of a note after the confirmation names the note", async () => {
    const info = { protected: true, member: true, manage: true, admin: true, self: "A", members: [], editors: [], target: "note", admins: ["A"], candidates: [] } as unknown as ProjectProtection;
    const bridge = new MockBridge([]);
    const calls: string[] = [];
    vi.spyOn(bridge, "call").mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "project_protection") return info;
      if (cmd === "organization_snapshot") return snapshot;
      return undefined;
    });
    const onChanged = vi.fn();
    const done = editPermissions(bridge, "Plan.md", onChanged);
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Zdejmij ograniczenia")).toBe(true));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Zdejmij ograniczenia")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Zdjąć ograniczenie? Ta notatka będzie widoczna dla wszystkich członków organizacji."));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Zdejmij ochronę")!.click();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(calls).toContain("project_unprotect");
    await done;
  });
});

describe("groups in the members dialog", () => {
  const info = { protected: true, member: true, manage: true, admin: true, self: "A", members: ["B"], candidates, editors: [], target: "project", admins: ["A"] } as unknown as ProjectProtection;
  const person = (name: string) => [...document.querySelectorAll<HTMLLabelElement>(".project-member label")].find((l) => l.textContent === name || l.textContent?.startsWith(`${name} `))!.querySelector("input")!;
  const groupBox = (i: number) => document.querySelectorAll<HTMLInputElement>("fieldset")[1].querySelectorAll<HTMLInputElement>("input")[i];
  const cancel = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Anuluj")!.click();

  it("ticks and locks the members of a ticked group, and unticking restores them", async () => {
    const done = askProjectMembers("Uprawnienia", info, "Zapisz", snapshot.groups ?? []);
    const czesio = person("Czesio");
    const darek = person("Darek");
    groupBox(0).click();
    expect(czesio.checked && czesio.disabled).toBe(true);
    expect(czesio.parentElement!.textContent).toBe("Czesio — z grupy Zespół");
    expect(darek.checked && darek.disabled).toBe(true);
    expect(darek.parentElement!.textContent).toContain("Darek — z grupy Zespół (nie ma jeszcze klucza szyfrowania)");
    expect(document.querySelector(".project-member-group small")!.textContent).toBe("Czesio, Darek");
    groupBox(0).click();
    expect(czesio.checked).toBe(false);
    expect(czesio.disabled).toBe(false);
    expect(darek.disabled).toBe(true);
    cancel();
    expect(await done).toBeNull();
  });

  it("keeps a person ticked by hand, or in another ticked group, when one group is unticked", async () => {
    const groups: Group[] = [...(snapshot.groups ?? []), { id: "g3", name: "Software", member_ids: ["C"] }];
    const done = askProjectMembers("Uprawnienia", info, "Zapisz", groups);
    const czesio = person("Czesio");
    czesio.click();
    groupBox(0).click();
    groupBox(1).click();
    expect(czesio.parentElement!.textContent).toBe("Czesio — z grup: Zespół, Software");
    groupBox(0).click();
    expect(czesio.checked && czesio.disabled).toBe(true);
    expect(czesio.parentElement!.textContent).toBe("Czesio — z grupy Software");
    groupBox(1).click();
    expect(czesio.checked).toBe(true);
    expect(czesio.disabled).toBe(false);
    cancel();
    await done;
  });
});

describe("may-edit box of the members dialog", () => {
  const info = { protected: true, member: true, manage: true, admin: true, self: "A", members: ["B"], candidates, editors: ["B"], target: "project", admins: ["A"] } as unknown as ProjectProtection;
  // rows: Ala (admin), Basia (in the project), Czesio, Darek (no key); each row's "może edytować" label is its last label
  const mayEdit = (i: number) => document.querySelectorAll<HTMLElement>(".project-member")[i].querySelector<HTMLElement>("label.muted")!;
  const person = (i: number) => document.querySelectorAll<HTMLElement>(".project-member")[i].querySelector<HTMLInputElement>("input")!;
  const groupBox = (i: number) => document.querySelectorAll<HTMLInputElement>("fieldset")[1].querySelectorAll<HTMLInputElement>("input")[i];
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

  it("shows the box only for people with access: fixed people, and those ticked by hand or through a group", async () => {
    const done = askProjectMembers("Uprawnienia", info, "Zapisz", snapshot.groups ?? []);
    expect(mayEdit(0).hidden).toBe(false);
    expect(mayEdit(1).hidden).toBe(false);
    expect(mayEdit(2).hidden).toBe(true);
    person(2).click();
    expect(mayEdit(2).hidden).toBe(false);
    person(2).click();
    expect(mayEdit(2).hidden).toBe(true);
    groupBox(0).click();
    expect(mayEdit(2).hidden).toBe(false);
    expect(mayEdit(3).hidden).toBe(false);
    groupBox(0).click();
    expect(mayEdit(2).hidden).toBe(true);
    expect(mayEdit(3).hidden).toBe(true);
    button("Anuluj").click();
    expect(await done).toBeNull();
  });

  it("the read-only view shows the box only for people who have access", async () => {
    const done = askProjectMembers("Uprawnienia", info, "Zapisz", snapshot.groups ?? [], undefined, true);
    expect(mayEdit(0).hidden).toBe(false);
    expect(mayEdit(1).hidden).toBe(false);
    expect(mayEdit(2).hidden).toBe(true);
    button("Zamknij").click();
    expect(await done).toBeNull();
  });
});

describe("group lines of a project", () => {
  it("names each group with its members, and only the count without names", () => {
    expect(groupLines(snapshot.groups ?? [], ["g1", "g2"], snapshot.members)).toEqual(["Zespół (2): Czesio, Darek", "Stary (1): Basia"]);
    expect(groupLines(snapshot.groups ?? [], ["g1"])).toEqual(["Zespół (2)"]);
    expect(groupLines(snapshot.groups ?? [], [])).toEqual([]);
  });
});

describe("new project window", () => {
  const field = (label: string) => [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === label)!.querySelector("input")!;
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === text)!;

  it("resolves with the trimmed name and the GitHub address when GitHub is open", async () => {
    const asked = askNewProject(true);
    field("Nazwa projektu").value = "  Alfa ";
    field("Połącz z GitHubem (opcjonalnie)").value = " owner/repo ";
    button("Utwórz").click();
    expect(await asked).toEqual({ name: "Alfa", address: "owner/repo" });
    document.body.replaceChildren();
  });

  it("has no address field without GitHub, shows a bad name and resolves null when cancelled", async () => {
    const asked = askNewProject(false);
    expect(document.querySelector(".modal")!.textContent).not.toContain("Połącz z GitHubem");
    field("Nazwa projektu").value = "a/b";
    button("Utwórz").click();
    expect(document.querySelector('.modal [role="alert"]')!.textContent).toMatch(/nie może zawierać/);
    button("Anuluj").click();
    expect(await asked).toBeNull();
    document.body.replaceChildren();
  });
});
