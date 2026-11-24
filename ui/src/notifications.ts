// Notifications of the organization, derived locally from its events (Stage D). They concern the current user: tasks
// assigned to or taken from them, the supervision they are given, a changed due date or a completion/reopening of their
// task by someone else. Their own actions never notify. The read state is per user and per vault, on this device only.
import { nameLookup, ordered, type OrganizationSnapshot, type TaskEvent, type TaskSnapshot } from "./taskhistory";

export type NotificationReason = "assigned" | "unassigned" | "supervisor" | "due" | "done" | "reopened";
export interface Notification { event: TaskEvent; reason: NotificationReason }

export const REASON_LABEL: Record<NotificationReason, string> = {
  assigned: "Przypisano Cię do zadania",
  unassigned: "Zdjęto Cię z zadania",
  supervisor: "Ustawiono Cię jako nadzorującego",
  due: "Zmieniono termin Twojego zadania",
  done: "Twoje zadanie ukończono",
  reopened: "Twoje zadanie wznowiono",
};

const KEPT = 1000; // read ids kept per user and vault; older ones fall out

// A handle the author's device could not resolve yet (the member joined later) is resolved through the current members and their aliases.
type Resolve = (name: string, snap: TaskSnapshot) => string | undefined;
const resolver = (s: OrganizationSnapshot): Resolve => {
  const byName = nameLookup(s);
  return (name, snap) => snap.people[name] ?? byName(name);
};
const assigneeIds = (snap: TaskSnapshot | null, id: Resolve): string[] => (snap ? snap.assignees.map((n) => id(n, snap)).filter((x): x is string => !!x) : []);
const supervisorId = (snap: TaskSnapshot | null, id: Resolve): string | null => (snap?.supervisor ? (id(snap.supervisor, snap) ?? null) : null);

/** The notifications of `s.me`, newest first. Unverified events are included: the caller marks them. */
export function notificationsFor(s: OrganizationSnapshot): Notification[] {
  const me = s.me;
  const id = resolver(s);
  const found: Notification[] = [];
  for (const event of ordered(s.events)) {
    if (event.actor_user_id === me) continue;
    const { before, after } = event;
    const mine = assigneeIds(after, id).includes(me);
    const supervised = supervisorId(after, id) === me;
    const concerned = mine || supervised;
    let reason: NotificationReason | null = null;
    switch (event.kind) {
      case "TaskAssigned":
        if (mine && !assigneeIds(before, id).includes(me)) reason = "assigned";
        else if (!mine && assigneeIds(before, id).includes(me)) reason = "unassigned";
        break;
      case "TaskSupervisorChanged":
        if (supervised && supervisorId(before, id) !== me) reason = "supervisor";
        break;
      case "TaskDueChanged":
        if (concerned) reason = "due";
        break;
      case "TaskCompleted":
        if (concerned) reason = "done";
        break;
      case "TaskReopened":
        if (concerned) reason = "reopened";
        break;
    }
    if (reason) found.push({ event, reason });
  }
  return found.reverse();
}

const readKey = (s: OrganizationSnapshot): string => `notes.inbox.${s.space_id}.${s.me}`;

/** The ids of the notifications this user has read in this vault. Unavailable storage reads as nothing read. */
export function readNotificationIds(s: OrganizationSnapshot): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(readKey(s)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Marks the given notifications as read. False when the local storage refused the write. */
export function markNotificationsRead(s: OrganizationSnapshot, ids: string[]): boolean {
  try {
    const all = [...new Set([...readNotificationIds(s), ...ids])];
    localStorage.setItem(readKey(s), JSON.stringify(all.slice(-KEPT)));
    return true;
  } catch {
    return false;
  }
}

/** The notifications not yet read in this vault. */
export function unreadNotifications(s: OrganizationSnapshot): Notification[] {
  const read = readNotificationIds(s);
  return notificationsFor(s).filter((n) => !read.has(n.event.event_id));
}
