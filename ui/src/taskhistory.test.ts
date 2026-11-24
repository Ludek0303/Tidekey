import { describe, it, expect } from "vitest";
import {
  canAdminister,
  completions,
  stats,
  notifications,
  resolveTaskPeople,
  type TaskEvent,
  type OrganizationSnapshot,
} from "./taskhistory";
import type { TaskRow } from "./orgtasks";
const row = { block: "task", done: true } as TaskRow;
const event: TaskEvent = {
  event_id: "a",
  actor_user_id: "actor",
  device: "device",
  note_id: "note",
  time_ms: 1,
  kind: "TaskCompleted",
  before: null,
  after: {
    task_id: "task",
    title: "A",
    assignees: ["Jan"],
    supervisor: "Anna",
    people: { Jan: "jan", Anna: "anna" },
    difficulty: 0,
    due: null,
    done: true,
    completed_on: null,
  },
};
it("counts zero separately from unrated and deduplicates replay", () => {
  const done = completions([event, event], [row]);
  expect(stats(done)).toEqual({ count: 1, points: 0, unrated: 0, average: 0 });
  expect(
    stats([{ ...event, after: { ...event.after, difficulty: null } }]).unrated,
  ).toBe(1);
});
it("reopen removes credit and the next close replaces the previous close", () => {
  const reopened = {
    ...event,
    event_id: "b",
    time_ms: 2,
    kind: "TaskReopened",
  };
  expect(completions([event, reopened], [row])).toEqual([]);
  const last = {
    ...event,
    event_id: "c",
    time_ms: 3,
    after: { ...event.after, difficulty: 8 },
  };
  expect(stats(completions([event, reopened, last], [row])).points).toBe(8);
});
it("later rating changes do not rewrite completion snapshots", () => {
  const change = {
    ...event,
    event_id: "b",
    time_ms: 2,
    kind: "TaskDifficultyChanged",
    after: { ...event.after, difficulty: 10 },
  };
  expect(stats(completions([event, change], [row])).points).toBe(0);
});
it("notifies the stable supervisor, not a matching mutable display name", () => {
  const s = { me: "anna", events: [event] } as OrganizationSnapshot;
  expect(notifications(s, [row], "Renamed")).toHaveLength(1);
  expect(notifications({ ...s, me: "other" }, [row], "Anna")).toHaveLength(0);
});
it("treats every active group member as a task assignee", () => {
  const task = { ...row, assignees: [], group_ids: ["team"] } as TaskRow;
  const snapshot = {
    me: "anna", owner: "owner", space_id: "space", verified: true, members: [], events: [], fields: {},
    groups: [{ id: "team", name: "Zespół", member_ids: ["anna", "piotr"] }],
  } as OrganizationSnapshot;
  expect(resolveTaskPeople(task, snapshot).assignee_user_ids).toEqual(["anna", "piotr"]);
});

describe("canAdminister", () => {
  const snap = (me: string, role: string) => ({ me, owner: "founder", space_id: "v", verified: false, events: [], fields: {}, members: [{ user_id: "founder", name: "F", role: "Owner" }, { user_id: me, name: "X", role }] });
  it("lets the founder, other owners and administrators run the organization, and nobody else", () => {
    expect(canAdminister({ ...snap("founder", "Owner"), members: [] })).toBe(true);
    expect(["Owner", "Admin", "Editor", "Reader"].map((role) => canAdminister(snap("x", role)))).toEqual([true, true, false, false]);
  });
});
