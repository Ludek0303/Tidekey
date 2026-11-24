// @vitest-environment jsdom
// Renamed people: tasks written with an old display name still belong to them (aliases, see bridge.ts learnName).
import { describe, expect, it } from "vitest";
import { MockBridge } from "./bridge";
import { initialsOf } from "./insights";
import { mineOf, overview, parseDay, sameHandle, type TaskRow } from "./orgtasks";
import { viewRows, type MyTasksData } from "./mytasks";
import { currentNameOf, namesOf, resolveTaskPeople, type OrganizationSnapshot } from "./taskhistory";
import { notificationsFor } from "./notifications";

const TODAY = parseDay("2026-10-25")!;
const row = (over: Partial<TaskRow>): TaskRow => ({
  note: "n", path: "Projekty/P.md", line: 1, depth: 0, done: false, text: "Zadanie", assignees: [], supervisor: null,
  difficulty: null, due: null, done_on: null, priority: null, block: null, project: "P", project_note: "p", ...over,
} as TaskRow);

async function snapshotOf(bridge: MockBridge): Promise<OrganizationSnapshot> {
  return bridge.call<OrganizationSnapshot>("organization_snapshot");
}

describe("own rename", () => {
  it("keeps a task written with the old name in my tasks, overview and the rows of my names", async () => {
    const bridge = new MockBridge([], false);
    bridge.setBrowserAccount("u-ania", "a@example.test", undefined, "Ania");
    bridge.setBrowserAccount("u-ania", "a@example.test", undefined, "Anna");
    const s = await snapshotOf(bridge);
    const names = namesOf(s, "u-ania");
    expect(names).toEqual(expect.arrayContaining(["Anna", "Ania"]));

    const task = row({ text: "Plan", assignees: ["Ania"] });
    const resolved = resolveTaskPeople(task, s);
    expect(resolved.assignee_user_ids).toEqual(["u-ania"]);
    expect(mineOf([task], names)).toHaveLength(1);
    expect(mineOf([task], "Anna")).toHaveLength(0);
    expect(overview([task], [], names, TODAY).mine).toHaveLength(1);
    expect(overview([task], [], "Anna", TODAY).mine).toHaveLength(0);

    const data: MyTasksData = { me: "Anna", names, today: TODAY, live: [resolved], cached: [] };
    expect(viewRows(data, { tab: "mine", done: false }).map((v) => v.row.text)).toEqual(["Plan"]);
  });

  it("matches the rename case-insensitively and across Unicode normalisation", () => {
    expect(sameHandle("zoé", "Zoé")).toBe(true);
    expect(sameHandle("ANNA ", "anna")).toBe(true);
    expect(sameHandle("", "")).toBe(false);
  });

  it("does not claim a name that now belongs to someone else", async () => {
    const bridge = new MockBridge([], false);
    bridge.setBrowserAccount("u-old", "o@example.test", undefined, "Ola");
    bridge.setBrowserAccount("u-old", "o@example.test", undefined, "Olga");
    bridge.setMembers([{ userId: "u-new", email: "n@example.test", name: "Ola", role: "Editor" }]);
    const s = await snapshotOf(bridge);
    expect(namesOf(s, "u-old")).not.toContain("Ola");
    expect(resolveTaskPeople(row({ assignees: ["Ola"] }), s).assignee_user_ids).toEqual(["u-new"]);
  });

  it("caps the names kept per user", async () => {
    const bridge = new MockBridge([], false);
    for (let i = 0; i < 12; i++) bridge.setBrowserAccount("u-x", "x@example.test", undefined, `Nazwa ${i}`);
    const s = await snapshotOf(bridge);
    expect(s.aliases!["u-x"]).toHaveLength(10);
    expect(s.aliases!["u-x"].at(-1)).toBe("Nazwa 11");
  });
});

describe("a colleague's rename", () => {
  it("keeps the old tasks in the colleague's load and resolves them to the colleague", async () => {
    const bridge = new MockBridge([], false);
    bridge.setBrowserAccount("u-me", "m@example.test", undefined, "Jan");
    bridge.setMembers([{ userId: "u-pi", email: "p@example.test", name: "Piotr", role: "Editor" }]);
    bridge.setMembers([{ userId: "u-pi", email: "p@example.test", name: "Pete", role: "Editor" }]);
    const s = await snapshotOf(bridge);
    expect(resolveTaskPeople(row({ assignees: ["Piotr"] }), s).assignee_user_ids).toEqual(["u-pi"]);

    const tasks = [row({ assignees: ["Piotr"] }), row({ assignees: ["Pete"] })].map((t) => resolveTaskPeople(t, s));
    const load = overview(tasks, [], "Jan", TODAY, currentNameOf(s)).load;
    expect(load).toEqual([expect.objectContaining({ name: "Pete", open: 2 })]);
  });
});

describe("aliases through the vault snapshot", () => {
  it("survive export and merge between two bridges", async () => {
    const left = new MockBridge([], false);
    left.setBrowserAccount("u-ania", "a@example.test", undefined, "Ania");
    left.setBrowserAccount("u-ania", "a@example.test", undefined, "Anna");
    const right = new MockBridge([], false);
    right.setBrowserAccount("u-ania", "a@example.test", undefined, "Anna");
    right.mergeBrowserSnapshot(left.exportBrowserSnapshot("u-ania"));
    expect((await snapshotOf(right)).aliases!["u-ania"]).toEqual(expect.arrayContaining(["Ania", "Anna"]));

    // And the other way round: the older name on the right is kept when the left merges back.
    const rightOnly = new MockBridge([], false);
    rightOnly.setBrowserAccount("u-ania", "a@example.test", undefined, "Anka");
    left.mergeBrowserSnapshot(rightOnly.exportBrowserSnapshot("u-ania"));
    expect((await snapshotOf(left)).aliases!["u-ania"]).toEqual(expect.arrayContaining(["Ania", "Anna", "Anka"]));
  });

  it("loads an old snapshot without the field and keeps the local aliases", async () => {
    const local = new MockBridge([], false);
    local.setBrowserAccount("u-ania", "a@example.test", undefined, "Ania");
    local.setBrowserAccount("u-ania", "a@example.test", undefined, "Anna");
    const old = new MockBridge([], false);
    old.setBrowserAccount("u-ania", "a@example.test", undefined, "Anna");
    const snapshot = old.exportBrowserSnapshot("u-ania");
    delete (snapshot.state.organization as { aliases?: unknown }).aliases;
    expect(() => local.mergeBrowserSnapshot(snapshot)).not.toThrow();
    expect((await snapshotOf(local)).aliases!["u-ania"]).toEqual(expect.arrayContaining(["Ania", "Anna"]));
  });

  it("notifies the assignee who is matched by an old name", async () => {
    const bridge = new MockBridge([], false);
    bridge.setBrowserAccount("u-ania", "a@example.test", undefined, "Ania");
    bridge.setBrowserAccount("u-ania", "a@example.test", undefined, "Anna");
    const s = await snapshotOf(bridge);
    const after = { task_id: "t", title: "Plan", assignees: ["Ania"], supervisor: null, difficulty: null, due: null, done: false, completed_on: null, people: {} };
    const event = { event_id: "e1", note_id: "n", device: "d", actor_user_id: "u-other", time_ms: 1, kind: "TaskAssigned", before: null, after };
    expect(notificationsFor({ ...s, events: [event] as never, me: "u-ania" }).map((n) => n.reason)).toEqual(["assigned"]);
  });
});

describe("initials", () => {
  it("handles a single word, Cyrillic, emoji and astral letters, and an empty name", () => {
    expect(initialsOf("Ania")).toBe("A");
    expect(initialsOf("Анна Петрова")).toBe("АП");
    expect(initialsOf("𝒜lice Bob")).toBe("𝒜B");
    expect(initialsOf("  ")).toBe("");
    expect(initialsOf("")).toBe("");
  });
});
