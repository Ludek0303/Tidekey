// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { dueSoon, important, renderProjectsPage } from "./projectsview";
import type { ProjectRow, TaskRow } from "./orgtasks";
import type { ProjectProtection } from "./bridge";

const row = (text: string, due: number | null, extra: Partial<TaskRow> = {}) => ({ text, due, done: false, priority: null, ...extra }) as TaskRow;

describe("projects page lists", () => {
  it("due soon: open tasks of the next week, overdue first; important: the starred open ones", () => {
    const rows = [row("za miesiąc", 140), row("jutro", 101), row("zaległe", 95), row("zrobione", 100, { done: true }), row("bez terminu", null), row("ważne", null, { priority: "high" }), row("ważne zrobione", 102, { priority: "high", done: true })];
    expect(dueSoon(rows, 100).map((r) => r.text)).toEqual(["zaległe", "jutro"]);
    expect(important(rows).map((r) => r.text)).toEqual(["ważne"]);
  });
});

describe("project cards", () => {
  it("the name opens the project screen, the Notatka button the note", () => {
    const project = { note: "P", path: "P/P.md", name: "Pierwszy", folder: null, status: null, lead: null } as ProjectRow;
    const host = document.createElement("div");
    const actions = { open: vi.fn(), openProject: vi.fn(), tasks: vi.fn(), newProject: vi.fn(), assign: vi.fn(), protect: vi.fn(), members: vi.fn(), unprotect: vi.fn(), approve: vi.fn() };
    renderProjectsPage(host, { today: 100, live: [], projects: [project], people: [], groups: [], canAssign: () => false }, actions);
    host.querySelector<HTMLButtonElement>(".project-card-name")!.click();
    expect(actions.openProject).toHaveBeenCalledWith(project);
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Notatka")!.click();
    expect(actions.open).toHaveBeenCalledWith("P/P.md");
  });
});

describe("protection buttons of a project card", () => {
  it("offer what the user may do with the project, and its card says it is protected", () => {
    const project = { note: "P", path: "P/P.md", name: "Pierwszy", folder: "Projekty/P", status: null, lead: null } as ProjectRow;
    const info = (over: Partial<ProjectProtection>) => ({ protected: false, member: false, manage: false, admin: false, ...over }) as ProjectProtection;
    const actions = { open: vi.fn(), openProject: vi.fn(), tasks: vi.fn(), newProject: vi.fn(), assign: vi.fn(), protect: vi.fn(), members: vi.fn(), unprotect: vi.fn(), approve: vi.fn() };
    const labels = (protection: ProjectProtection) => {
      const host = document.createElement("div");
      renderProjectsPage(host, { today: 100, live: [], projects: [project], people: [], groups: [], protection: new Map([["Projekty/P", protection]]), canAssign: () => false }, actions);
      return { host, buttons: [...host.querySelectorAll<HTMLButtonElement>(".project-card button.btn")].map((b) => b.textContent) };
    };
    expect(labels(info({ manage: true })).buttons).toEqual(["Notatka", "Chroń projekt"]);
    const member = labels(info({ protected: true, member: true, manage: true }));
    expect(member.buttons).toEqual(["Notatka", "Członkowie projektu"]);
    // a protected project shows no badge or lock: its members see a normal project
    expect(member.host.querySelector(".project-card")!.textContent).not.toContain("chroniony");
    expect(labels(info({ protected: true, admin: true })).buttons).toEqual(["Notatka", "Zdejmij ochronę"]);
    expect(labels(info({})).buttons).toEqual(["Notatka"]);

    const host = document.createElement("div");
    renderProjectsPage(host, { today: 100, live: [], projects: [project], people: [], groups: [], protection: new Map([["Projekty/P", info({ manage: true })]]), canAssign: () => false }, actions);
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Chroń projekt")!.click();
    expect(actions.protect).toHaveBeenCalledWith("Projekty/P");
  });
});

describe("pending approval of a project card", () => {
  it("shows what the project note asks for and approves the project on click", () => {
    const project = { note: "P", path: "P/P.md", name: "Pierwszy", folder: "Projekty/P", status: null, lead: null } as ProjectRow;
    const actions = { open: vi.fn(), openProject: vi.fn(), tasks: vi.fn(), newProject: vi.fn(), assign: vi.fn(), protect: vi.fn(), members: vi.fn(), unprotect: vi.fn(), approve: vi.fn() };
    const host = document.createElement("div");
    renderProjectsPage(host, { today: 100, live: [], projects: [project], people: [], groups: [], canAssign: () => false, pending: () => "dodano: Ala" }, actions);
    const box = host.querySelector<HTMLElement>(".project-pending")!;
    expect(box.getAttribute("role")).toBe("status");
    expect(box.textContent).toContain("dodano: Ala");
    [...box.querySelectorAll("button")].find((b) => b.textContent === "Zatwierdź")!.click();
    expect(actions.approve).toHaveBeenCalledWith(project);
  });

  it("shows nothing when nothing is pending", () => {
    const project = { note: "P", path: "P/P.md", name: "Pierwszy", folder: null, status: null, lead: null } as ProjectRow;
    const actions = { open: vi.fn(), openProject: vi.fn(), tasks: vi.fn(), newProject: vi.fn(), assign: vi.fn(), protect: vi.fn(), members: vi.fn(), unprotect: vi.fn(), approve: vi.fn() };
    const none = document.createElement("div");
    renderProjectsPage(none, { today: 100, live: [], projects: [project], people: [], groups: [], canAssign: () => false, pending: () => null }, actions);
    expect(none.querySelector(".project-pending")).toBeNull();
    const absent = document.createElement("div");
    renderProjectsPage(absent, { today: 100, live: [], projects: [project], people: [], groups: [], canAssign: () => false }, actions);
    expect(absent.querySelector(".project-pending")).toBeNull();
  });
});

describe("assign dialog of a project", () => {
  it("ticks and locks a group's members, names them, and saves only the people picked by hand", async () => {
    const project = { note: "P", path: "P/P.md", name: "Pierwszy", folder: null, status: null, lead: null, people: ["Ala"], groups: [] } as ProjectRow;
    const members = [
      { user_id: "A", name: "Ala", role: "Owner" },
      { user_id: "C", name: "Czesio", role: "Member" },
      { user_id: "D", name: "Darek", role: "Member" },
    ];
    const groups = [{ id: "g1", name: "Zarząd", member_ids: ["C", "D"] }];
    const host = document.createElement("div");
    const actions = { open: vi.fn(), openProject: vi.fn(), tasks: vi.fn(), newProject: vi.fn(), assign: vi.fn().mockResolvedValue(undefined), protect: vi.fn(), members: vi.fn(), unprotect: vi.fn(), approve: vi.fn() };
    renderProjectsPage(host, { today: 100, live: [], projects: [project], people: ["Ala", "Czesio", "Darek"], groups, members, canAssign: () => true }, actions);
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Przypisz osoby i grupy")!.click();

    const person = (name: string) => [...document.querySelectorAll<HTMLLabelElement>("fieldset label")].find((l) => l.textContent === name || l.textContent?.startsWith(`${name} `))!.querySelector("input")!;
    const czesio = person("Czesio");
    const group = document.querySelectorAll<HTMLInputElement>("fieldset")[1].querySelector<HTMLInputElement>("input")!;
    expect(document.querySelector(".project-member-group small")!.textContent).toBe("Czesio, Darek");
    group.click();
    expect(czesio.checked && czesio.disabled).toBe(true);
    expect(czesio.parentElement!.textContent).toBe("Czesio — z grupy Zarząd");
    group.click();
    expect(czesio.checked).toBe(false);
    expect(czesio.disabled).toBe(false);
    group.click();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Zapisz")!.click();
    await vi.waitFor(() => expect(actions.assign).toHaveBeenCalledOnce());
    // Czesio and Darek come in through the group, so they are not saved as people of the project
    expect(actions.assign).toHaveBeenCalledWith(project, ["Ala"], ["g1"]);
  });
});
