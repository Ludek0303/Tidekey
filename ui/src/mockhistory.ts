//! Browser demo history. These events are deliberately marked unverified by MockBridge.
import { parseLine } from "./orgtasks";
import type {
  OrganizationSnapshot,
  TaskSnapshot,
  TaskEvent,
} from "./taskhistory";

function snapshots(
  text: string,
  s: OrganizationSnapshot,
): Map<string, TaskSnapshot> {
  const result = new Map<string, TaskSnapshot>();
  for (const line of text.split("\n")) {
    const task = parseLine(line);
    if (!task?.id) continue;
    const last = (kind: string) =>
      task.tokens.filter((t) => t.kind === kind).at(-1)?.value ?? null;
    const assignees = task.tokens
      .filter((t) => t.kind === "assignee")
      .map((t) => String(t.value));
    const supervisor = last("supervisor") as string | null;
    const people: Record<string, string> = {};
    for (const name of [...assignees, ...(supervisor ? [supervisor] : [])]) {
      const p = s.members.find(
        (p) => p.name?.toLowerCase() === name.toLowerCase(),
      );
      if (p) people[name] = p.user_id;
    }
    result.set(task.id, {
      task_id: task.id,
      title: task.text,
      assignees,
      supervisor,
      people,
      difficulty: last("difficulty") as number | null,
      due: last("due") as number | null,
      completed_on: last("done") as number | null,
      done: /\[[xX]\]/.test(line),
    });
  }
  return result;
}
export function recordMockEdit(
  s: OrganizationSnapshot,
  note: string,
  before: string,
  after: string,
): void {
  const old = snapshots(before, s);
  for (const [id, next] of snapshots(after, s)) {
    const previous = old.get(id) ?? null;
    const kinds: string[] = [];
    if (
      JSON.stringify(previous?.assignees ?? []) !==
      JSON.stringify(next.assignees)
    )
      kinds.push("TaskAssigned");
    if ((previous && !previous.done && next.done) || (!previous && next.done)) kinds.push("TaskCompleted");
    if (previous?.done && !next.done) kinds.push("TaskReopened");
    if (previous && previous.due !== next.due) kinds.push("TaskDueChanged");
    if (previous && previous.supervisor !== next.supervisor)
      kinds.push("TaskSupervisorChanged");
    if (previous && previous.difficulty !== next.difficulty)
      kinds.push("TaskDifficultyChanged");
    for (const kind of kinds) {
      const completedAt = kind === "TaskCompleted" && next.completed_on !== null
        ? next.completed_on * 86_400_000 + 12 * 60 * 60 * 1000
        : Date.now();
      const e: TaskEvent = {
        event_id: crypto.randomUUID(),
        note_id: note,
        actor_user_id: kind === "TaskCompleted"
          ? next.people[next.assignees[0] ?? ""] ?? s.me
          : s.me,
        device: "browser-demo",
        time_ms: completedAt,
        kind,
        before: previous,
        after: next,
      };
      s.events.push(e);
    }
  }
}
