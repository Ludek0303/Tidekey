// @vitest-environment jsdom
import * as Y from "yjs";
import { beforeAll, describe, expect, it } from "vitest";
import { MockBridge } from "./bridge";
import { TASK_CHANGED, addSubtask, editDone, editField } from "./orgedit";
import { type TaskRow, parseLine } from "./orgtasks";
import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

// The row the index would have for the task on `line` of `note`: built from the same reader, so every field matches.
function rowFrom(text: string, line: number, note = "n"): TaskRow {
  const l = text.split("\n")[line - 1];
  const p = parseLine(l)!;
  const last = (kind: string) => p.tokens.filter((t) => t.kind === kind && t.value !== null).at(-1)?.value ?? null;
  return {
    note, path: "P.md", line, depth: 0, done: /\[[xX]\]/.test(l), text: p.text, assignees: p.tokens.filter((t) => t.kind === "assignee").map((t) => t.value as string),
    group_ids: p.tokens.filter((t) => t.kind === "group").map((t) => t.value as string),
    supervisor: (last("supervisor") as string | null) ?? null, difficulty: (last("difficulty") as number | null) ?? null,
    due: (last("due") as number | null) ?? null, done_on: (last("done") as number | null) ?? null, priority: (last("priority") as TaskRow["priority"]) ?? null,
    block: p.id, project: "P", project_note: null,
  };
}

async function noteText(bridge: MockBridge, id: string): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await bridge.call<Uint8Array>("open_note", { id }));
  return doc.getText("content").toString();
}

describe("editField", () => {
  it("writes into an open note's document in one update, changing only that line", async () => {
    const text = "# P\n- [ ] Plan @Jan ^z-1111\n- [ ] Schemat @Jan ^z-7f3a\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    let updates = 0;
    doc.on("update", () => updates++);
    await editField({ bridge: new MockBridge([]), openDoc: () => doc }, rowFrom(text, 3), "assignee", "Anna");
    expect(updates).toBe(1);
    expect(doc.getText("content").toString()).toBe("# P\n- [ ] Plan @Jan ^z-1111\n- [ ] Schemat @Anna ^z-7f3a\n");
  });

  it("loads a note that is not open, changes it and saves it through the bridge", async () => {
    const bridge = new MockBridge();
    const { notes } = await bridge.call<{ notes: { id: string; path: string }[] }>("list_tree");
    const id = notes.find((n) => n.path === "Projekty/Sonda/Sonda.md")!.id;
    const before = await noteText(bridge, id);
    const line = before.split("\n").findIndex((l) => l.includes("Przygotować schemat")) + 1;
    await editDone({ bridge, openDoc: () => null }, rowFrom(before, line, id), true, 1_000);
    const after = (await noteText(bridge, id)).split("\n");
    expect(after[line - 1]).toContain("- [x] Przygotować schemat elektroniki");
    expect(after[line - 1]).toContain("✅");
    expect(after[line - 2]).toBe(before.split("\n")[line - 2]);
  });
});

describe("an edit lands on the task the row describes, after a remote change above it", () => {
  it("finds a task with an id by the id, so the edit goes to B and A keeps Jan", async () => {
    const shared = "# P\n- [ ] A @Jan ^z-aaaa\n- [ ] B @Piotr ^z-bbbb\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, shared);
    const row = rowFrom(shared, 3);
    doc.getText("content").insert(0, "Nowe\n");
    await editField({ bridge: new MockBridge([]), openDoc: () => doc }, row, "assignee", "Anna");
    expect(doc.getText("content").toString()).toBe("Nowe\n# P\n- [ ] A @Jan ^z-aaaa\n- [ ] B @Anna ^z-bbbb\n");
  });

  it("two tasks with the same title and no id: after a remote insert above them the edit refuses, and changes nothing", async () => {
    const same = "# P\n- [ ] Przegląd\n- [ ] Przegląd\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, same);
    const row = rowFrom(same, 3);
    doc.getText("content").insert(0, "Nowe\n");
    await expect(editField({ bridge: new MockBridge([]), openDoc: () => doc }, row, "assignee", "Anna")).rejects.toThrow(TASK_CHANGED);
    expect(doc.getText("content").toString()).toBe("Nowe\n# P\n- [ ] Przegląd\n- [ ] Przegląd\n");
  });

  it("two tasks with the same title but different people: the one that reads as the row is edited", async () => {
    const shared = "# P\n- [ ] A @Jan\n- [ ] A @Piotr\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, shared);
    const row = rowFrom(shared, 3);
    doc.getText("content").insert(0, "Nowe\n");
    await editField({ bridge: new MockBridge([]), openDoc: () => doc }, row, "assignee", "Anna");
    expect(doc.getText("content").toString()).toBe("Nowe\n# P\n- [ ] A @Jan\n- [ ] A @Anna\n");
  });
});

describe("subtasks", () => {
  it("refuses to tick a task with open subtasks: the text stays and the toast says how many are left", async () => {
    const text = "# P\n- [ ] Plan ^z-1111\n  - [ ] Krok 1 ^z-2222\n  - [x] Krok 2 ^z-3333\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    await editDone({ bridge: new MockBridge([]), openDoc: () => doc }, rowFrom(text, 2), true, 1_000);
    expect(doc.getText("content").toString()).toBe(text);
    expect(document.querySelector(".toasts")?.textContent).toContain("Najpierw zakończ podzadania (zostało: 1).");
  });

  it("ticks a task once its subtasks are done", async () => {
    const text = "# P\n- [ ] Plan ^z-1111\n  - [x] Krok 1 ^z-2222\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    await editDone({ bridge: new MockBridge([]), openDoc: () => doc }, rowFrom(text, 2), true, 1_000);
    expect(doc.getText("content").toString()).toContain("- [x] Plan");
  });

  it("adds a subtask after the task's subtree, indented two spaces deeper", async () => {
    const text = "# P\n- [ ] Plan ^z-1111\n  - [x] Krok 1 ^z-2222\n    - [ ] Głębszy\n- [ ] Dalej\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    await addSubtask({ bridge: new MockBridge([]), openDoc: () => doc }, rowFrom(text, 2), "Krok 2");
    expect(doc.getText("content").toString()).toBe("# P\n- [ ] Plan ^z-1111\n  - [x] Krok 1 ^z-2222\n    - [ ] Głębszy\n  - [ ] Krok 2\n- [ ] Dalej\n");
  });
});

describe("addSubtask under an ordered parent", () => {
  it("indents to the content column: 3 spaces under `1. `, 4 under `10. `", async () => {
    const text = "# P\n1. [ ] Plan ^z-1111\n10. [ ] Inny ^z-4444\n";
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    await addSubtask({ bridge: new MockBridge([]), openDoc: () => doc }, rowFrom(text, 2), "Krok");
    await addSubtask({ bridge: new MockBridge([]), openDoc: () => doc }, rowFrom(text, 3), "Krok 2");
    expect(doc.getText("content").toString()).toBe("# P\n1. [ ] Plan ^z-1111\n   - [ ] Krok\n10. [ ] Inny ^z-4444\n    - [ ] Krok 2\n");
  });
});
