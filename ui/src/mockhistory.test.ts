import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MockBridge } from "./bridge";
import { parseLine } from "./orgtasks";
import type { OrganizationSnapshot, TaskEvent } from "./taskhistory";
import { loadWasm } from "./testwasm";

// Counts the line parses of the task history (mockhistory.ts reads every line through parseLine).
vi.mock("./orgtasks", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./orgtasks")>();
  return { ...mod, parseLine: vi.fn(mod.parseLine) };
});

beforeAll(async () => {
  await loadWasm();
});

afterEach(() => {
  vi.useRealTimers();
});

// Replaces the whole text of a note with one Yjs update, as the editor sends it.
async function setText(b: MockBridge, id: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
  const before = Y.encodeStateVector(doc);
  const t = doc.getText("content");
  t.delete(0, t.length);
  t.insert(0, text);
  await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
}

async function events(b: MockBridge): Promise<TaskEvent[]> {
  return (await b.call<OrganizationSnapshot>("organization_snapshot")).events;
}

// The kinds recorded, once each, and the last state of every task.
function summary(list: TaskEvent[]) {
  const last = new Map<string, unknown>();
  for (const e of list) last.set(e.after.task_id, e.after);
  return { kinds: [...new Set(list.map((e) => e.kind))].sort(), last: Object.fromEntries(last) };
}

const STEPS = [
  "",
  "- [ ] Zadanie ^z-1\n",
  "- [ ] Zadanie ^z-1 @Jan\n",
  "- [ ] Zadanie ^z-1 @Jan @Anna\n",
  "- [x] Zadanie ^z-1 @Jan @Anna\n",
];

describe("MockBridge task history", () => {
  it("rapid edits end with the same history as a read after every edit", async () => {
    const rapid = new MockBridge([]);
    const rapidId = await rapid.call<string>("create_note", { path: "Projekty/Zadania.md" });
    for (const text of STEPS) await setText(rapid, rapidId, text);

    const stepped = new MockBridge([]);
    const steppedId = await stepped.call<string>("create_note", { path: "Projekty/Zadania.md" });
    for (const text of STEPS) {
      await setText(stepped, steppedId, text);
      await events(stepped);
    }

    expect(summary(await events(rapid))).toEqual(summary(await events(stepped)));
    expect(summary(await events(rapid)).kinds).toEqual(["TaskAssigned", "TaskCompleted"]);
  });

  it("a read right after an edit already holds it, before the pause", async () => {
    const b = new MockBridge([]);
    const id = await b.call<string>("create_note", { path: "Projekty/Zadania.md" });
    await setText(b, id, "- [x] Zadanie ^z-2 @Jan\n");
    expect((await events(b)).map((e) => e.kind)).toContain("TaskCompleted");
  });

  it("the pause records the history and signs it without a read", async () => {
    vi.useFakeTimers();
    const b = new MockBridge([]);
    const id = await b.call<string>("create_note", { path: "Projekty/Zadania.md" });
    await setText(b, id, "- [ ] Zadanie ^z-3 @Jan\n");
    await events(b);
    const signed: string[] = [];
    b.eventSigner = async (e) => { signed.push(e.event_id); };

    await setText(b, id, "- [x] Zadanie ^z-3 @Jan\n");
    expect(signed).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(signed).toHaveLength(1);
    expect((await events(b)).at(-1)?.event_id).toBe(signed[0]);
  });

  it("a 2000-line note is not tokenized per keystroke", async () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i % 5 === 0 ? `- [ ] Zadanie ${i} @Jan 📅 2026-11-05 ^z-${i}` : `Akapit ${i}`,
    );
    const b = new MockBridge([]);
    const id = await b.call<string>("create_note", { path: "Projekty/Duża.md" });
    await setText(b, id, lines.join("\n"));
    await events(b);
    vi.mocked(parseLine).mockClear();

    for (let i = 0; i < 50; i++) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
      const before = Y.encodeStateVector(doc);
      doc.getText("content").insert(doc.getText("content").length, "a");
      await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
    }
    expect(vi.mocked(parseLine)).not.toHaveBeenCalled();

    await events(b);
    // one comparison per note: the text before the edits and the text after, line by line
    expect(vi.mocked(parseLine).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(parseLine).mock.calls.length).toBeLessThanOrEqual(2 * lines.length);
  });
});
