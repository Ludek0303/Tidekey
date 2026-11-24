// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { markNotificationsRead, notificationsFor, readNotificationIds, unreadNotifications } from "./notifications";
import type { OrganizationSnapshot, TaskEvent, TaskSnapshot } from "./taskhistory";

const ME = "user-me";
const OTHER = "user-other";
const people = { Ania: ME, Piotr: OTHER };
const task = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  task_id: "t-1", title: "Plan", assignees: ["Ania"], supervisor: null, difficulty: null, due: 100, done: false, completed_on: null, people, ...over,
});
let seq = 0;
const event = (kind: string, actor: string, before: TaskSnapshot | null, after: TaskSnapshot): TaskEvent => ({
  event_id: `ev-${++seq}`, note_id: "n", device: "d", actor_user_id: actor, time_ms: 1000 + seq, kind, before, after,
});
const snapshot = (events: TaskEvent[]): OrganizationSnapshot => ({ me: ME, owner: ME, space_id: "v-test", verified: false, members: [], events, fields: {} });

afterEach(() => localStorage.clear());

describe("notifications from events", () => {
  it("tell me about assignments to me and removals from me, made by someone else", () => {
    const assigned = event("TaskAssigned", OTHER, task({ assignees: [] }), task());
    const removed = event("TaskAssigned", OTHER, task(), task({ assignees: [] }));
    const reasons = notificationsFor(snapshot([assigned, removed])).map((n) => n.reason);
    expect(reasons).toEqual(["unassigned", "assigned"]);
  });

  it("tell me about a supervisor set to me, and a due date changed on my task", () => {
    const supervised = event("TaskSupervisorChanged", OTHER, task({ supervisor: null }), task({ supervisor: "Ania" }));
    const due = event("TaskDueChanged", OTHER, task(), task({ due: 200 }));
    const reasons = notificationsFor(snapshot([supervised, due])).map((n) => n.reason);
    expect(reasons).toEqual(["due", "supervisor"]);
  });

  it("tell me when someone else completes or reopens my task", () => {
    const done = event("TaskCompleted", OTHER, task(), task({ done: true, completed_on: 5 }));
    const reopened = event("TaskReopened", OTHER, task({ done: true }), task({ done: false }));
    expect(notificationsFor(snapshot([done, reopened])).map((n) => n.reason)).toEqual(["reopened", "done"]);
  });

  it("resolve a handle the author's device didn't know yet through the current members", () => {
    const unknown = { Piotr: OTHER }; // I joined after the task was written: my handle isn't in the event
    const assigned = event("TaskAssigned", OTHER, task({ assignees: [], people: unknown }), task({ people: unknown }));
    const s = { ...snapshot([assigned]), members: [{ user_id: ME, name: "ania", role: "Editor" }] };
    expect(notificationsFor(s).map((n) => n.reason)).toEqual(["assigned"]);
  });

  it("never notify about my own actions", () => {
    const mine = [
      event("TaskAssigned", ME, task({ assignees: [] }), task()),
      event("TaskDueChanged", ME, task(), task({ due: 300 })),
      event("TaskCompleted", ME, task(), task({ done: true })),
    ];
    expect(notificationsFor(snapshot(mine))).toEqual([]);
  });

  it("ignore changes to tasks that are neither mine nor supervised by me", () => {
    const theirs = event("TaskDueChanged", OTHER, task({ assignees: ["Piotr"] }), task({ assignees: ["Piotr"], due: 400 }));
    expect(notificationsFor(snapshot([theirs]))).toEqual([]);
  });
});

describe("read state", () => {
  it("is kept per user and vault, and survives a new read", () => {
    const first = event("TaskDueChanged", OTHER, task(), task({ due: 200 }));
    const second = event("TaskCompleted", OTHER, task(), task({ done: true, completed_on: 5 }));
    const s = snapshot([first]);
    expect(unreadNotifications(s).length).toBe(1);
    expect(markNotificationsRead(s, [first.event_id])).toBe(true);
    expect(readNotificationIds(s).has(first.event_id)).toBe(true);
    // a new device-local read of the same vault still sees it read; a new event is unread
    const later = snapshot([first, second]);
    expect(unreadNotifications(later).map((n) => n.event.event_id)).toEqual([second.event_id]);
    // another vault is a different key
    expect(unreadNotifications({ ...later, space_id: "v-other" }).length).toBe(2);
  });

  it("reads as nothing read when the local storage is broken", () => {
    const s = snapshot([event("TaskDueChanged", OTHER, task(), task({ due: 200 }))]);
    localStorage.setItem(`notes.inbox.${s.space_id}.${s.me}`, "{not json");
    expect(readNotificationIds(s).size).toBe(0);
  });
});

describe("the Powiadomienia page", () => {
  it("opens the task's note on a click on the card, falling back to the note id, and marks it read", async () => {
    const { renderInsights } = await import("./insights");
    const assigned = event("TaskAssigned", OTHER, task({ assignees: [] }), task());
    const s = snapshot([assigned]);
    const opened: string[] = [];
    const host = document.createElement("div");
    const state = { year: 2026, person: "", group: "", project: "", points: false, graph: "", expanded: new Set<string>(), taskState: "", timelineStart: "2026-01-01", timelineRange: "week" as const };
    const actions = { refresh() {}, open: (t: { path: string }) => opened.push(`task:${t.path}`), name: async () => {}, group: async () => {}, openNote: (id: string) => opened.push(`note:${id}`) };
    renderInsights(host, "notifications", s, [], [], state, actions as never);
    host.querySelector<HTMLElement>("article.org-card h3")!.click();
    expect(opened).toEqual(["note:n"]);
    expect(readNotificationIds(s).has(assigned.event_id)).toBe(true);
  });
});
