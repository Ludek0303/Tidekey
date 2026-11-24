import type { TaskRow } from "./orgtasks";
import type { EventCheck } from "./signing";

export interface TaskSnapshot {
  task_id: string;
  title: string;
  assignees: string[];
  groups?: string[];
  supervisor: string | null;
  difficulty: number | null;
  due: number | null;
  done: boolean;
  completed_on: number | null;
  people: Record<string, string>;
}
export interface TaskEvent {
  event_id: string;
  note_id: string;
  device: string;
  actor_user_id: string;
  time_ms: number;
  kind: string;
  clock?: Record<string, number>;
  before: TaskSnapshot | null;
  after: TaskSnapshot;
  // Stage D: the signer and the base64 ECDSA signature over the event without `signature` (absent on demo events).
  signerUserId?: string;
  signature?: string;
}
export interface Member {
  user_id: string;
  name: string | null;
  role: string;
  name_changed_at?: number;
}
export interface Group {
  id: string;
  name: string;
  member_ids: string[];
  archived?: boolean;
  /** A GROUP_COLORS key. Anything else reads as no color (validGroupColor). */
  color?: string;
  /** When the color was last set (ms), so the newer choice wins on sync. Older groups have none. */
  color_at?: number;
  /** Position in the groups grid, 0 first. Lower is heavier: a person gets the color of their first group (orderedGroups). */
  order?: number;
  /** When the order was last set (ms), so the newer order wins on sync. */
  order_at?: number;
}
/** Group colors: the name is stored on the group, the hex here. White initials must read on each (WCAG AA, 4.5:1). */
export const GROUP_COLORS: Record<string, { label: string; hex: string }> = {
  fiolet: { label: "Fioletowy", hex: "#7b3fbf" },
  niebieski: { label: "Niebieski", hex: "#2563eb" },
  turkus: { label: "Turkusowy", hex: "#0f766e" },
  zielony: { label: "Zielony", hex: "#15803d" },
  limonka: { label: "Limonkowy", hex: "#4d7c0f" },
  "żółty": { label: "Żółty", hex: "#a16207" },
  pomarańcz: { label: "Pomarańczowy", hex: "#c2410c" },
  czerwony: { label: "Czerwony", hex: "#b91c1c" },
  róż: { label: "Różowy", hex: "#be185d" },
  szary: { label: "Szary", hex: "#4b5563" },
};
export function validGroupColor(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(GROUP_COLORS, value) ? value : undefined;
}
/** Groups by weight: lower order first, groups without one after them, each tie in list order. */
export function orderedGroups(groups: Group[]): Group[] {
  return [...groups].sort((a, b) => Number(a.order === undefined) - Number(b.order === undefined) || (a.order ?? 0) - (b.order ?? 0));
}
/** The color of a person's first active colored group in weight order; none keeps the default look. */
export function personColor(s: OrganizationSnapshot, userId: string): string | undefined {
  for (const g of orderedGroups(s.groups ?? [])) {
    const color = validGroupColor(g.color);
    if (color && !g.archived && g.member_ids.includes(userId)) return color;
  }
  return undefined;
}
export interface OrganizationSnapshot {
  me: string;
  owner: string;
  space_id: string;
  verified: boolean;
  members: Member[];
  events: TaskEvent[];
  fields: Record<string, string>;
  handles?: Record<string, string>;
  // Names each user_id has gone by in this vault, newest last (capped; bridge.ts learnName). Tasks keep the names
  // they were typed with, so these keep them matched to the person after a rename.
  aliases?: Record<string, string[]>;
  groups?: Group[];
  // Browser only: the verification of each event (signing.ts), filled in by the bridge when the snapshot is read.
  checks?: Record<string, EventCheck>;
}
/** May this user run the organization: groups, other members' names, the activity view? Its founder, and every
 *  member with the owner or administrator role. */
export function canAdminister(s: OrganizationSnapshot): boolean {
  if (s.me === s.owner) return true;
  const role = s.members.find((m) => m.user_id === s.me)?.role;
  return role === "Owner" || role === "Admin";
}

/** The comparable form of a name: NFC, trimmed, case folded. Task tokens and display names compare through it. */
export const nameKey = (name: string): string => name.normalize("NFC").trim().toLowerCase();

/** The user a name stands for: a current member name first, else a name that member went by (an alias). */
export function nameLookup(s: OrganizationSnapshot): (name: string) => string | undefined {
  const current = new Map<string, string>();
  const former = new Map<string, string>();
  for (const m of s.members) if (m.name) current.set(nameKey(m.name), m.user_id);
  for (const [userId, names] of Object.entries(s.aliases ?? {}))
    for (const n of names) if (!former.has(nameKey(n))) former.set(nameKey(n), userId);
  return (name) => {
    const key = nameKey(name);
    return current.get(key) ?? former.get(key);
  };
}

/** Every name a user goes by in this space: the current one and the aliases that still resolve to them. */
export function namesOf(s: OrganizationSnapshot, userId: string): string[] {
  const lookup = nameLookup(s);
  const current = s.members.find((m) => m.user_id === userId)?.name;
  const aliases = (s.aliases?.[userId] ?? []).filter((n) => lookup(n) === userId);
  return [...new Set([...(current ? [current] : []), ...aliases])];
}

/** The current name of the person a name stands for; the name itself when no member matches. */
export function currentNameOf(s: OrganizationSnapshot): (name: string) => string {
  const lookup = nameLookup(s);
  return (name) => {
    const id = lookup(name);
    return s.members.find((m) => m.user_id === id)?.name || name;
  };
}

export function resolveTaskPeople(
  task: TaskRow,
  s: OrganizationSnapshot,
): TaskRow {
  const byName = nameLookup(s);
  const idOf = (name: string): string | undefined => s.handles?.[name.toLowerCase()] ?? byName(name);
  const assigned = delegator(s.events, task.block);
  const sameAssignment =
    assigned &&
    JSON.stringify(assigned.after.assignees) === JSON.stringify(task.assignees) &&
    JSON.stringify(assigned.after.groups ?? []) === JSON.stringify(task.group_ids ?? []);
  const groupMembers = (task.group_ids ?? []).flatMap((id) => s.groups?.find((group) => group.id === id && !group.archived)?.member_ids ?? []);
  const groupNames = groupMembers.flatMap((id) => s.members.find((member) => member.user_id === id)?.name ?? []);
  const directMembers = task.assignees.flatMap((name) => {
    const id = (sameAssignment ? assigned.after.people[name] : null) ?? idOf(name);
    return id ? [id] : [];
  });
  return {
    ...task,
    assignee_user_ids: [...new Set([...directMembers, ...groupMembers])],
    effective_assignees: [...new Set([...task.assignees, ...groupNames])],
    supervisor_user_id: task.supervisor ? (idOf(task.supervisor) ?? null) : null,
  };
}
export const personName = (s: OrganizationSnapshot, id: string): string =>
  s.members.find((p) => p.user_id === id)?.name ?? `${id.slice(0, 12)}…`;
export function ordered(events: TaskEvent[]): TaskEvent[] {
  return [...new Map(events.map((e) => [e.event_id, e])).values()].sort(
    (a, b) => a.time_ms - b.time_ms || a.event_id.localeCompare(b.event_id),
  );
}
export function currentEvents(
  events: TaskEvent[],
  tasks: TaskRow[],
): TaskEvent[] {
  const ids = new Map<string, number>();
  tasks.forEach((t) => {
    if (t.block) ids.set(t.block, (ids.get(t.block) ?? 0) + 1);
  });
  return ordered(events).filter((e) => ids.get(e.after.task_id) === 1);
}
export function delegator(
  events: TaskEvent[],
  taskId: string | null,
): TaskEvent | undefined {
  const candidates = tips(
    ordered(events).filter(
      (e) => e.after.task_id === taskId && e.kind === "TaskAssigned",
    ),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
function before(a: TaskEvent, b: TaskEvent): boolean {
  if (!a.clock || !b.clock)
    return (
      a.time_ms < b.time_ms ||
      (a.time_ms === b.time_ms && a.event_id < b.event_id)
    );
  const seq = Number(a.event_id.split(":")[1]);
  return Number.isFinite(seq) && (b.clock[a.device] ?? 0) >= seq;
}
export function tips(events: TaskEvent[]): TaskEvent[] {
  return events.filter((a) => !events.some((b) => a !== b && before(a, b)));
}
export function conflictingTasks(events: TaskEvent[]): Set<string> {
  const ids = new Set(events.map((e) => e.after.task_id));
  return new Set(
    [...ids].filter((id) =>
      [
        new Set(["TaskCompleted", "TaskReopened"]),
        new Set(["TaskAssigned"]),
        new Set(["TaskDueChanged"]),
      ].some(
        (kinds) =>
          tips(
            events.filter((e) => e.after.task_id === id && kinds.has(e.kind)),
          ).length > 1,
      ),
    ),
  );
}
/** One current completion per stable task id; reopening removes it. Rating is the signed snapshot. */
export function completions(
  events: TaskEvent[],
  tasks: TaskRow[],
): TaskEvent[] {
  const relevant = currentEvents(events, tasks).filter(
    (e) => e.kind === "TaskCompleted" || e.kind === "TaskReopened",
  );
  const latest = new Map<string, TaskEvent>();
  for (const id of new Set(relevant.map((e) => e.after.task_id))) {
    const candidates = tips(relevant.filter((e) => e.after.task_id === id));
    if (candidates.length === 1 && candidates[0].kind === "TaskCompleted")
      latest.set(id, candidates[0]);
  }
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.block));
  return [...latest.values()].filter((e) => done.has(e.after.task_id));
}
export function completionDay(e: TaskEvent, timezone: string): string {
  // Calendar dates from the signed close event are dates, not UTC instants.
  if (e.after.completed_on !== null)
    return new Date(e.after.completed_on * 86400000).toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(e.time_ms));
}
/** Whether the event concerns the person (a `user_id`; "" means everyone): one of its assignees resolves to them. */
export function belongs(e: TaskEvent, person: string): boolean {
  return !person || e.after.assignees.some((name) => e.after.people[name] === person);
}
export function stats(events: TaskEvent[]): {
  count: number;
  points: number;
  unrated: number;
  average: number | null;
} {
  const rated = events.filter((e) => e.after.difficulty !== null);
  const points = rated.reduce((sum, e) => sum + e.after.difficulty!, 0);
  return {
    count: events.length,
    points,
    unrated: events.length - rated.length,
    average: rated.length ? points / rated.length : null,
  };
}
export function notifications(
  s: OrganizationSnapshot,
  tasks: TaskRow[],
  handle: string,
): TaskEvent[] {
  const kinds = new Set([
    "TaskCompleted",
    "TaskDueChanged",
    "TaskSupervisorChanged",
    "TaskAssigned",
  ]);
  return currentEvents(s.events, tasks)
    .filter((e) => {
      const supervisor = e.after.supervisor;
      if (!supervisor || !kinds.has(e.kind)) return false;
      const id = e.after.people[supervisor];
      return id ? id === s.me : nameKey(supervisor) === nameKey(handle);
    })
    .reverse();
}
