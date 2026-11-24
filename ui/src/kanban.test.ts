// @vitest-environment jsdom
import * as Y from "yjs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { type ColumnChange, KANBAN_TEXT, addTask, appendLine, columnIndex, columnNameError, columnsOf, folderOf, folderTasks, isKanbanText, moveLine, moveTask, newTaskLine, restageText, saveColumns } from "./kanban";
import type { TaskEdits } from "./orgedit";
import { type TaskRow, parseDay, parseLine } from "./orgtasks";
import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

const task = (path: string, over: Partial<TaskRow> = {}): TaskRow => ({
  note: path, path, line: 1, depth: 0, done: false, text: "Zadanie", assignees: [], supervisor: null, difficulty: null,
  due: null, done_on: null, priority: null, block: null, project: "Triton", project_note: null, ...over,
});

const NAMES = ["Pomysły", "W toku", "Do sprawdzenia", "Gotowe"];
const TODAY = parseDay("2026-10-25")!;

// The row the index would have for the task on `line` of `text`, read by the same reader (every field matches).
function rowFrom(text: string, line: number, note = "n"): TaskRow {
  const l = text.split("\n")[line - 1];
  const p = parseLine(l)!;
  const last = (kind: string) => p.tokens.filter((t) => t.kind === kind && t.value !== null).at(-1)?.value ?? null;
  return {
    note, path: "Triton/Tablica.md", line, depth: 0, done: /\[[xX]\]/.test(l), text: p.text,
    assignees: p.tokens.filter((t) => t.kind === "assignee").map((t) => t.value as string), group_ids: [],
    supervisor: null, difficulty: null, due: (last("due") as number | null) ?? null, done_on: (last("done") as number | null) ?? null,
    priority: null, block: p.id, project: "Triton", project_note: null, stage: (last("stage") as string | null) ?? null,
  };
}

/** Notes kept in memory, edited the way the bridge edits them; `writes` counts the updates each note got. */
function fakeEdits(texts: Record<string, string>) {
  const docs = new Map<string, Y.Doc>();
  const writes: Record<string, number> = {};
  for (const [id, text] of Object.entries(texts)) {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    docs.set(id, doc);
  }
  const bridge = {
    call: async (cmd: string, args: { id: string; update?: Uint8Array }) => {
      const doc = docs.get(args.id)!;
      if (cmd === "open_note") return Y.encodeStateAsUpdate(doc);
      if (cmd === "apply_update") {
        writes[args.id] = (writes[args.id] ?? 0) + 1;
        Y.applyUpdate(doc, args.update!);
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    },
  } as unknown as Bridge;
  const edits: TaskEdits = { bridge, openDoc: () => null };
  const text = (id: string) => docs.get(id)!.getText("content").toString();
  return { edits, text, writes };
}

describe("the kanban note", () => {
  it("reads typ: kanban from the front matter only", () => {
    expect(isKanbanText(KANBAN_TEXT)).toBe(true);
    expect(isKanbanText("---\ntyp: kalendarz\n---\n")).toBe(false);
    expect(isKanbanText("# Tablica\n\ntyp: kanban\n")).toBe(false);
    expect(isKanbanText("---\ntitle: x\ntyp: kanban\n---\n")).toBe(true);
  });

  it("collects the tasks of its folder and every sub-folder, and not of a neighbour with a longer name", () => {
    const rows = [
      task("Projekty/Triton/Plan.md"),
      task("Projekty/Triton/Podfolder/Głęboko/Notatka.md"),
      task("Projekty/Triton2/Inny.md"),
      task("Projekty/Plan.md"),
      task("Tablica.md"),
    ];
    expect(folderTasks(rows, "Projekty/Triton").map((t) => t.path)).toEqual([
      "Projekty/Triton/Plan.md",
      "Projekty/Triton/Podfolder/Głęboko/Notatka.md",
    ]);
    expect(folderTasks(rows, "")).toHaveLength(rows.length);
  });

  it("takes the folder of a note, and none for a note at the top of the space", () => {
    expect(folderOf("Projekty/Triton/Tablica.md")).toBe("Projekty/Triton");
    expect(folderOf("Tablica.md")).toBe("");
  });
});

describe("columns of a board", () => {
  it("reads kolumny from the front matter, in order, and falls back to the defaults", () => {
    expect(columnsOf("---\ntyp: kanban\nkolumny: Pomysły, W toku,  Do sprawdzenia , Gotowe\n---\nx")).toEqual(NAMES);
    expect(columnsOf(KANBAN_TEXT)).toEqual(["Do zrobienia", "W toku", "Gotowe"]);
    expect(columnsOf("---\ntyp: kanban\nkolumny:\n---\n")).toEqual(["Do zrobienia", "W toku", "Gotowe"]);
    // a repeat (in any case) is one column; a line in the body is not the front matter
    expect(columnsOf("---\ntyp: kanban\nkolumny: A, a, B\n---\n")).toEqual(["A", "B"]);
    expect(columnsOf("---\ntyp: kanban\n---\nkolumny: X, Y\n")).toEqual(["Do zrobienia", "W toku", "Gotowe"]);
  });

  it("puts a task in the column its token names, the last one when done, the first one without a match", () => {
    expect(columnIndex({ done: false, stage: "w TOKU" }, NAMES)).toBe(1);
    expect(columnIndex({ done: false, stage: null }, NAMES)).toBe(0);
    expect(columnIndex({ done: false, stage: "Nieznany" }, NAMES)).toBe(0);
    expect(columnIndex({ done: true, stage: "Pomysły" }, NAMES)).toBe(3);
  });

  it("moves a task line: the last column ticks it and drops the token, the others set it", () => {
    const names = NAMES;
    const at = (line: string, target: number, lines = [line]) => moveLine(line, lines, 0, names, target, TODAY);
    // into a middle column: the token is added before the id
    expect(at("- [ ] Plan @Jan ^z-1", 1)).toBe("- [ ] Plan @Jan !etap:W_toku ^z-1");
    // the token is replaced, not doubled
    expect(at("- [ ] Plan !etap:W_toku", 2)).toBe("- [ ] Plan !etap:Do_sprawdzenia");
    // the first column removes the token
    expect(at("- [ ] Plan !etap:W_toku ^z-1", 0)).toBe("- [ ] Plan ^z-1");
    // into the last column: ticked, dated and without the token
    expect(at("- [ ] Plan !etap:W_toku ^z-1", 3)).toBe("- [x] Plan ✅ 2026-10-25 ^z-1");
    // out of the last column: unticked, the done date goes, the token comes
    expect(at("- [x] Plan ✅ 2026-10-20 ^z-1", 1)).toBe("- [ ] Plan !etap:W_toku ^z-1");
    // the line is the same when the target is where it is
    expect(at("- [ ] Plan !etap:W_toku", 1)).toBe("- [ ] Plan !etap:W_toku");
  });

  it("does not tick a task with open subtasks", () => {
    const lines = ["- [ ] Plan !etap:W_toku", "  - [ ] Krok"];
    expect(moveLine(lines[0], lines, 0, NAMES, 3, TODAY)).toBe(lines[0]);
  });

  it("writes the line of a new task for its column", () => {
    expect(newTaskLine("Nowe  zadanie", NAMES, 0)).toBe("- [ ] Nowe zadanie");
    expect(newTaskLine("Nowe @Ola", NAMES, 2)).toBe("- [ ] Nowe @Ola !etap:Do_sprawdzenia");
    expect(newTaskLine("Gotowe już", NAMES, 3)).toBe("- [x] Gotowe już");
    expect(appendLine(KANBAN_TEXT, "- [ ] x")).toBe(`${KANBAN_TEXT}- [ ] x\n`);
    expect(appendLine("a", "- [ ] x")).toBe("a\n- [ ] x");
  });

  it("refuses column names the token cannot carry", () => {
    expect(columnNameError("", [])).not.toBeNull();
    expect(columnNameError("W_toku", [])).not.toBeNull();
    expect(columnNameError("A, B", [])).not.toBeNull();
    expect(columnNameError("w toku", ["W toku"])).not.toBeNull();
    expect(columnNameError("Pomysły", ["W toku"])).toBeNull();
  });

  it("rewrites the tokens of a renamed column in one pass, so swapped names do not chain", () => {
    const text = "- [ ] A !etap:X\n- [ ] B !etap:Y\n- [ ] C\n";
    expect(restageText(text, [["X", "Y"], ["Y", "X"]])).toBe("- [ ] A !etap:Y\n- [ ] B !etap:X\n- [ ] C\n");
    expect(restageText(text, [["X", null]])).toBe("- [ ] A\n- [ ] B !etap:Y\n- [ ] C\n");
  });

  it("renames the column in every note of the folder, one update per note", async () => {
    const board = { id: "b", path: "Triton/Tablica.md", text: "---\ntyp: kanban\nkolumny: Pomysły, W toku, Gotowe\n---\n" };
    const notes = {
      b: board.text,
      n1: "# Plan\n- [ ] Szkic @Ola !etap:W_toku ^z-1\n- [ ] Inne\n",
      n2: "- [ ] Test !etap:W_toku\n- [x] Zrobione ✅ 2026-10-01 ^z-2\n",
      n3: "- [ ] Bez zmian !etap:Pomysły\n",
    };
    const fake = fakeEdits(notes);
    const rows = [
      { ...rowFrom(notes.n1, 2, "n1"), stage: "W toku", path: "Triton/n1.md" },
      { ...rowFrom(notes.n2, 1, "n2"), stage: "W toku", path: "Triton/n2.md" },
    ];
    const changes: ColumnChange[] = [
      { name: "Pomysły", was: "Pomysły" },
      { name: "Robota", was: "W toku" },
      { name: "Gotowe", was: "Gotowe" },
    ];
    const touched = await saveColumns(fake.edits, board, rows, changes);
    expect(touched.sort()).toEqual(["b", "n1", "n2"]);
    expect(fake.text("b")).toBe("---\ntyp: kanban\nkolumny: Pomysły, Robota, Gotowe\n---\n");
    expect(fake.text("n1")).toBe("# Plan\n- [ ] Szkic @Ola !etap:Robota ^z-1\n- [ ] Inne\n");
    expect(fake.text("n2")).toBe("- [ ] Test !etap:Robota\n- [x] Zrobione ✅ 2026-10-01 ^z-2\n");
    expect(fake.text("n3")).toBe(notes.n3);
    expect(fake.writes).toEqual({ b: 1, n1: 1, n2: 1 });
  });

  it("removes a column: its tasks fall into the first column, their token goes", async () => {
    const board = { id: "b", path: "Triton/Tablica.md", text: "---\ntyp: kanban\nkolumny: Pomysły, W toku, Gotowe\n---\n" };
    const fake = fakeEdits({ b: board.text, n1: "- [ ] A !etap:W_toku\n" });
    const rows = [{ ...rowFrom("- [ ] A !etap:W_toku", 1, "n1"), stage: "W toku" }];
    await saveColumns(fake.edits, board, rows, [{ name: "Pomysły", was: "Pomysły" }, { name: "Gotowe", was: "Gotowe" }]);
    expect(fake.text("b")).toContain("kolumny: Pomysły, Gotowe");
    expect(fake.text("n1")).toBe("- [ ] A\n");
  });

  it("adds a task at the end of the board note in its column", async () => {
    const fake = fakeEdits({ b: KANBAN_TEXT });
    const board = { id: "b", path: "Triton/Tablica.md", text: KANBAN_TEXT };
    await addTask(fake.edits, board, "Plan @Jan", ["Do zrobienia", "W toku", "Gotowe"], 1);
    expect(fake.text("b")).toBe(`${KANBAN_TEXT}- [ ] Plan @Jan !etap:W_toku\n`);
  });

  it("moves a task in its own note with one update and keeps the rest of the line", async () => {
    const text = "# Zadania\n- [ ] Plan @Jan !etap:W_toku ^z-1\n- [ ] Drugie\n";
    const fake = fakeEdits({ n: text });
    const row = rowFrom(text, 2, "n");
    await moveTask(fake.edits, row, ["Do zrobienia", "W toku", "Gotowe"], 2, TODAY);
    expect(fake.text("n")).toBe("# Zadania\n- [x] Plan @Jan ✅ 2026-10-25 ^z-1\n- [ ] Drugie\n");
    expect(fake.writes).toEqual({ n: 1 });
  });
});
