// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "./bridge";
import { FILE_EMBED, MemoryFileStore } from "./filestore";
import type { NoteSession } from "./editor";
import type { Features } from "./features";
import { buildLayout } from "./layout";
import type { NoteIndex } from "./noteindex";
import { ORG_FILES, ORG_OVERVIEW, ORG_TASKS, OrgViews, currentTask, indexNewNote, isTaskRow, pendingApproval, shouldWriteCache } from "./orgviews";
import type { ProjectProtection } from "./bridge";
import type { OrganizationSnapshot } from "./taskhistory";
import type { ProjectRow } from "./orgtasks";
import type { TaskRow } from "./orgtasks";

function setup() {
  const layout = buildLayout(document.createElement("div"));
  const clearTask = vi.fn();
  const features = { clearTask, showTask: vi.fn() } as unknown as Features;
  const noteIndex = { tasks: () => null, projects: () => null } as unknown as NoteIndex;
  const views = new OrgViews({
    bridge: new MockBridge([]),
    layout,
    noteIndex,
    features: () => features,
    sessions: () => [],
    active: () => null,
    notes: () => [],
    open: vi.fn(async () => undefined),
    reveal: vi.fn(),
    flush: () => Promise.resolve(true),
    showTab: vi.fn(),
    renderTabs: vi.fn(),
    insert: vi.fn(),
  });
  return { layout, views, clearTask };
}

describe("the organization tabs replace the note's bars", () => {
  it("hides the format bar and the breadcrumb on Zadania and Przegląd, and gives them back on hide", () => {
    const { layout, views } = setup();
    for (const tab of [ORG_TASKS, ORG_OVERVIEW]) {
      views.show(tab);
      expect(layout.formatBar.hidden).toBe(true);
      expect(layout.crumbs.hidden).toBe(true);
      expect(layout.orgView.hidden).toBe(false);
      views.hide();
      expect(layout.formatBar.hidden).toBe(false);
      expect(layout.crumbs.hidden).toBe(false);
      expect(layout.orgView.hidden).toBe(true);
    }
  });

  it("marks only the nav button of the shown view, and no button once the view is hidden", () => {
    const { views, layout } = setup();
    const marked = () => [...layout.sidebar.querySelectorAll<HTMLButtonElement>(".org-nav-btn")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
    views.show(ORG_TASKS);
    expect(marked()).toEqual(["Zadania"]);
    views.show(ORG_OVERVIEW);
    expect(marked()).toEqual(["Przegląd"]);
    views.hide();
    expect(marked()).toEqual([]);
  });

  it("drops the task panel when an organization tab opens", () => {
    const { views, clearTask } = setup();
    views.show(ORG_OVERVIEW);
    expect(clearTask).toHaveBeenCalledTimes(1);
  });
});

describe("the copy of this device's tasks", () => {
  it("is written only with an organization, a handle and an index", () => {
    expect(shouldWriteCache(true, "Jan", true)).toBe(true);
    // no index: an empty copy would replace a good one
    expect(shouldWriteCache(true, "Jan", false)).toBe(false);
    // no handle: the copy could not say whose tasks it holds
    expect(shouldWriteCache(true, "", true)).toBe(false);
    expect(shouldWriteCache(false, "Jan", true)).toBe(false);
  });

  it("uses only rows of the shape the views read; a malformed row is left out", () => {
    expect(isTaskRow({ assignees: ["Jan"], text: "A", line: 1, done: false })).toBe(true);
    expect(isTaskRow({ text: "bez przydziału", line: 1, done: false })).toBe(false);
    expect(isTaskRow({ assignees: ["Jan"], text: 3, line: 1, done: false })).toBe(false);
  });
});

describe("the task panel's task", () => {
  const row = (over: Partial<TaskRow>): TaskRow =>
    ({ note: "n1", path: "P.md", line: 4, done: false, text: "Schemat", assignees: ["Jan"], supervisor: null,
      difficulty: 8, due: null, done_on: null, priority: null, block: "z-1", project: "P", project_note: null,
      ...over }) as TaskRow;

  it("is read after the pending edits reach the index, so a second quick edit sees the first", () => {
    let rows = [row({})];
    const index = { tasks: () => ({ tasks: rows, warnings: [] }), flush: vi.fn(() => { rows = [row({ assignees: ["Anna"] })]; }) };
    const found = currentTask(index, { note: "n1", block: "z-1", line: 4, text: "Schemat" });
    expect(index.flush).toHaveBeenCalled();
    expect(found?.assignees).toEqual(["Anna"]);
  });

  it("is still found once a task seen without an id has one, and another task on that line is not", () => {
    const index = { tasks: () => ({ tasks: [row({ block: "z-9" })], warnings: [] }), flush: () => {} };
    expect(currentTask(index, { note: "n1", block: null, line: 4, text: "Schemat" })?.block).toBe("z-9");
    expect(currentTask(index, { note: "n1", block: null, line: 4, text: "Inne" })).toBeUndefined();
  });
});

describe("a project made by the app", () => {
  it("reaches the index with its text, after the index has learnt of the empty note", async () => {
    const calls: string[] = [];
    const index = {
      sync: vi.fn(async () => { calls.push("sync"); }),
      edited: vi.fn((id: string, text: string) => { calls.push(`edited ${id} ${text.includes("typ: projekt")}`); }),
      flush: vi.fn(() => { calls.push("flush"); }),
    };
    await indexNewNote(index, "n9", "---\ntyp: projekt\n---\n# X\n");
    expect(calls).toEqual(["sync", "edited n9 true", "flush"]);
  });
});

describe("the Pliki section", () => {
  it("is shown only where the bridge has a file store", () => {
    const pliki = (views: OrgViews) => [...views.nav.nav.querySelectorAll("button")].find((b) => b.textContent === "Pliki") as HTMLButtonElement;
    const make = (files: MemoryFileStore | null) => {
      const bridge = Object.assign(new MockBridge([]), { files });
      const layout = buildLayout(document.createElement("div"));
      const noteIndex = { tasks: () => null, projects: () => null, graph: () => null } as unknown as NoteIndex;
      const views = new OrgViews({
        bridge, layout, noteIndex, features: () => null, sessions: () => [], active: () => null, notes: () => [],
        open: vi.fn(async () => undefined), reveal: vi.fn(), flush: () => Promise.resolve(true), showTab: vi.fn(), renderTabs: vi.fn(), insert: vi.fn(),
      });
      views.setKind("organizacja"); // Pliki is an organization's section
      return views;
    };
    expect(pliki(make(null)).hidden).toBe(true); // the desktop app: no server files
    expect(pliki(make(new MemoryFileStore())).hidden).toBe(false);
  });
});

describe("Pliki inserts a file into the open note", () => {
  const ID = "e".repeat(32);
  const make = (active: NoteSession | null) => {
    const store = new MemoryFileStore("jan");
    void store.upload(new File(["x"], "plan.pdf", { type: "application/pdf" }), { id: ID });
    const bridge = Object.assign(new MockBridge([]), { files: store });
    const layout = buildLayout(document.createElement("div"));
    const noteIndex = { tasks: () => null, projects: () => null, graph: () => null } as unknown as NoteIndex;
    const d = { open: vi.fn(async () => undefined), insert: vi.fn() };
    const views = new OrgViews({
      bridge, layout, noteIndex, features: () => null, sessions: () => [], active: () => active, notes: () => [],
      open: d.open, reveal: vi.fn(), flush: () => Promise.resolve(true), showTab: vi.fn(), renderTabs: vi.fn(), insert: d.insert,
    });
    views.show(ORG_FILES);
    return { d, layout };
  };
  const insertButton = (layout: ReturnType<typeof buildLayout>) =>
    [...layout.orgView.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Wstaw do notatki: plan.pdf")) as HTMLButtonElement;

  it("opens the note and writes a new embed of the file at the cursor", async () => {
    const { d, layout } = make({ id: "n1", path: "Notatka.md" } as NoteSession);
    await new Promise((r) => setTimeout(r, 0));
    insertButton(layout).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.open).toHaveBeenCalledWith({ id: "n1", path: "Notatka.md" });
    const text = d.insert.mock.calls[0][0] as string;
    const [m] = [...text.matchAll(FILE_EMBED)];
    expect(m[1]).toBe(ID);
    expect(m[2]).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is disabled with a hint when no note is open", async () => {
    const { d, layout } = make(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(insertButton(layout).disabled).toBe(true);
    expect(layout.orgView.textContent).toContain("Otwórz notatkę, aby wstawić do niej plik.");
    expect(d.insert).not.toHaveBeenCalled();
  });
});

// docs/MCP.md §6: people or a lead written into a protected project's note wait for a manager's approval.
describe("pendingApproval", () => {
  const snapshot = {
    me: "A", owner: "A", space_id: "s", verified: true, events: [], fields: {}, groups: [],
    members: [{ user_id: "A", name: "Ala", role: "Owner" }, { user_id: "B", name: "Basia", role: "Member" }, { user_id: "C", name: "Czesio", role: "Member" }],
  } as unknown as OrganizationSnapshot;
  const candidates = ["A", "B", "C"].map((userId) => ({ userId, name: userId, ready: true }));
  const info = (over: Partial<ProjectProtection> = {}): ProjectProtection => ({
    protected: true, member: true, manage: true, admin: true, self: "A", members: ["A", "B"], editors: ["A", "B"], path: "Projekty/X",
    target: "project", lead: "B", admins: ["A"], candidates, ...over,
  });
  const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({ note: "n", path: "Projekty/X/X.md", name: "X", folder: "Projekty/X", status: null, lead: "Basia", people: ["Basia"], groups: [], ...over });

  it("is null when the note matches the entry, or when this user does not manage the project", () => {
    expect(pendingApproval(row(), info(), snapshot)).toBeNull();
    expect(pendingApproval(row({ people: ["Czesio"] }), info({ manage: false }), snapshot)).toBeNull();
    expect(pendingApproval(row({ people: ["Czesio"] }), info({ protected: false }), snapshot)).toBeNull();
  });
  it("names the people the note adds, and a new lead for an owner or admin only", () => {
    expect(pendingApproval(row({ people: ["Basia", "Czesio"] }), info(), snapshot)).toContain("dochodzą: Czesio");
    expect(pendingApproval(row({ lead: "Czesio" }), info({ members: ["A", "B", "C"] }), snapshot)).toContain("prowadzący: Czesio");
    const asLead = pendingApproval(row({ lead: "Czesio" }), info({ members: ["A", "B", "C"], admin: false }), snapshot)!;
    expect(asLead).not.toContain("prowadzący");
    expect(asLead).toContain("odchodzą: Czesio");
  });
  it("names the people the approval removes, and tells apart two members of the same name", () => {
    expect(pendingApproval(row({ people: [] , lead: "Basia" }), info({ members: ["A", "B", "C"] }), snapshot)).toContain("odchodzą: Czesio");
    const twins = { ...snapshot, members: [...snapshot.members, { user_id: "D1234567xyz", name: "Basia", role: "Member" }] } as unknown as OrganizationSnapshot;
    expect(pendingApproval(row({ people: ["Basia", "Czesio"] }), info({ candidates: [...candidates, { userId: "D1234567xyz", name: "Basia", ready: true }] }), twins)).toMatch(/Czesio/);
    expect(pendingApproval(row(), info({ members: ["A", "B", "D1234567xyz"], candidates: [...candidates, { userId: "D1234567xyz", name: "Basia", ready: true }] }), twins)).toContain("(D1234567)");
  });
});
