import * as Y from "yjs";
import { beforeAll, describe, expect, it } from "vitest";
import { cellTaskOf, chipsOf, dayOf, dueState, groupOf, handlesIn, isoOf, locateTask, openSubtasks, overview, parseDay, rewriteLine, setTaskDone, setTaskField, shortDate, type TaskRow } from "./orgtasks";

import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

const LINE = "- [ ] Przygotować schemat elektroniki @Jan 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a";
const TODAY = parseDay("2026-10-25")!;

function row(over: Partial<TaskRow>): TaskRow {
  return {
    note: "n", path: "Projekty/Triton/Triton.md", line: 1, depth: 0, done: false, text: "Zadanie", assignees: [],
    supervisor: null, difficulty: null, due: null, done_on: null, priority: null, block: null,
    project: "Triton", project_note: "p", ...over,
  };
}

describe("setTaskField", () => {
  it("replaces a field's token and keeps the rest of the line in order", () => {
    // the assignee token is replaced where it stands, the rest of the line is untouched
    expect(setTaskField(LINE, "assignee", "Anna")).toBe(
      "- [ ] Przygotować schemat elektroniki @Anna 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a",
    );
    expect(setTaskField(LINE, "difficulty", "3")).toBe(
      "- [ ] Przygotować schemat elektroniki @Jan 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:3 ^z-7f3a",
    );
    expect(setTaskField(LINE, "due", "2026-11-20")).toBe(
      "- [ ] Przygotować schemat elektroniki @Jan 📅 2026-11-20 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a",
    );
  });

  it("removes a token for an empty value, and never the title", () => {
    expect(setTaskField(LINE, "due", null)).toBe("- [ ] Przygotować schemat elektroniki @Jan !nadzor:@Stanisław !trudnosc:8 ^z-7f3a");
    expect(setTaskField(LINE, "difficulty", null)).not.toContain("!trudnosc");
    expect(setTaskField(LINE, "supervisor", "")).not.toContain("nadzor");
  });

  it("adds a token before the task's id, or at the end when there is none", () => {
    expect(setTaskField("  - [x] Plan", "assignee", "Ania")).toBe("  - [x] Plan @Ania");
    expect(setTaskField("- [ ] Plan ^z-1", "supervisor", "Łukasz.K")).toBe("- [ ] Plan !nadzor:@Łukasz.K ^z-1");
    expect(setTaskField("- [ ] Plan ^z-1", "group", "team-123")).toBe("- [ ] Plan !grupa:team-123 ^z-1");
    // the star marks a task important; a second click takes it off, an old ⏫ included
    expect(setTaskField("- [ ] Plan ^z-1", "priority", "⭐")).toBe("- [ ] Plan ⭐ ^z-1");
    expect(setTaskField("- [ ] Plan ⏫ ^z-1", "priority", null)).toBe("- [ ] Plan ^z-1");
    expect(() => setTaskField("- [ ] Plan", "priority", "x")).toThrow();
  });

  it("refuses values the parser would not read back", () => {
    expect(() => setTaskField(LINE, "difficulty", "11")).toThrow(/0–10/);
    expect(() => setTaskField(LINE, "difficulty", "-1")).toThrow(/0–10/);
    expect(() => setTaskField(LINE, "due", "2026-02-30")).toThrow(/RRRR-MM-DD/);
    expect(() => setTaskField(LINE, "assignee", "Jan Kowalski")).toThrow(/nazwa osoby/);
    expect(() => setTaskField("Zwykły tekst", "assignee", "Jan")).toThrow(/zadanie/);
  });
});

describe("the name of a task", () => {
  it("sets the words that are not tokens, and keeps the tokens after them", () => {
    expect(setTaskField(LINE, "title", "Schemat v2")).toBe("- [ ] Schemat v2 @Jan 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a");
    expect(setTaskField("- [ ] Nowe zadanie ^z-c955", "title", "  Plan   dnia ")).toBe("- [ ] Plan dnia ^z-c955");
  });

  it("refuses an empty name and a name the line would read as a field", () => {
    expect(() => setTaskField(LINE, "title", "  ")).toThrow("Nazwa zadania nie może być pusta.");
    expect(() => setTaskField(LINE, "title", "Plan @Anna")).toThrow("Nazwa zadania nie może zawierać");
  });
});

describe("setTaskDone", () => {
  it("ticks a task with its completion day and clears both again", () => {
    const done = setTaskDone("- [ ] Plan @Jan ^z-1", true, TODAY);
    expect(done).toBe("- [x] Plan @Jan ✅ 2026-10-25 ^z-1");
    expect(setTaskDone(done, false, TODAY)).toBe("- [ ] Plan @Jan ^z-1");
  });
});

describe("dates and groups", () => {
  it("counts days like the index and shows them as short dates", () => {
    expect(parseDay("2026-10-25")).toBe(dayOf(new Date(2026, 9, 25)));
    expect(parseDay("2026-02-30")).toBeNull();
    expect(isoOf(TODAY)).toBe("2026-10-25");
    expect(shortDate(parseDay("2026-11-05")!)).toBe("5 lis");
  });

  it("puts a task in exactly one group and marks its due state", () => {
    expect(groupOf(null, TODAY)).toBe("Bez terminu");
    expect(groupOf(TODAY - 1, TODAY)).toBe("Zaległe");
    expect(groupOf(TODAY, TODAY)).toBe("Dziś");
    expect(groupOf(TODAY + 7, TODAY)).toBe("Najbliższe 7 dni");
    expect(groupOf(TODAY + 8, TODAY)).toBe("Później");
    expect(dueState(TODAY - 1, TODAY)).toBe("overdue");
    expect(dueState(TODAY + 3, TODAY)).toBe("soon");
    expect(dueState(TODAY + 30, TODAY)).toBe("later");
  });
});

describe("cellTaskOf", () => {
  it("reads a task in a table cell as its title and the person and date chips, hiding the other tokens", () => {
    const task = cellTaskOf("[ ] Zadzwonić do klienta @Anna 📅 2026-11-30 !nadzor:@Jan !trudnosc:3 ^z-abc", parseDay("2026-11-10")!);
    expect(task).toEqual({
      done: false,
      title: "Zadzwonić do klienta",
      chips: [
        { kind: "who", label: "@Anna" },
        { kind: "due", label: "30.11", state: "later" },
      ],
    });
  });

  it("shows the year only outside the current one, initials of a long name, a done box and an overdue date", () => {
    const task = cellTaskOf("[x] Raport @Bartłomiej 📅 2025-01-05", TODAY)!;
    expect(task.done).toBe(true);
    expect(task.chips).toEqual([
      { kind: "who", label: "@Bartłomiej" },
      { kind: "due", label: "05.01.2025", state: "overdue" },
    ]);
    expect(cellTaskOf("[ ] Długie @Maksymilianowa", TODAY)!.chips).toEqual([{ kind: "who", label: "@M" }]);
  });

  it("is null for text that is not a task", () => {
    expect(cellTaskOf("zwykły tekst", TODAY)).toBeNull();
  });
});

describe("chipsOf", () => {
  it("shows assignee, deadline, supervisor and difficulty as chips, and nothing else", () => {
    // the id is a hidden chip: it shows nothing
    const chips = chipsOf(LINE, TODAY).filter((c) => c.kind !== "hidden").map((c) => [c.kind, c.label]);
    expect(chips).toEqual([
      ["who", "@Jan"],
      ["due", "📅 5 lis"],
      ["supervisor", "nadzór: Stanisław"],
      ["difficulty", "8/10"],
    ]);
    const due = chipsOf(LINE, TODAY)[1];
    expect(LINE.slice(due.from, due.to)).toBe("📅 2026-11-05");
    expect(chipsOf(LINE, TODAY)[1].state).toBe("later");
  });

  it("colours a deadline by its distance and reads the compact date form", () => {
    expect(chipsOf("- [ ] A 📅 2026-10-24", TODAY)[0].state).toBe("overdue");
    expect(chipsOf("- [ ] A 📅 2026-10-30", TODAY)[0].state).toBe("soon");
    expect(chipsOf("- [ ] A 📅2026-10-30", TODAY)[0].label).toBe("📅 30 paź");
  });

  it("leaves an invalid difficulty out, and ignores lines that are not tasks", () => {
    expect(chipsOf("- [ ] A !trudnosc:11", TODAY)).toEqual([]);
    expect(chipsOf("Zwykły @Jan tekst", TODAY)).toEqual([]);
  });
});

describe("overview", () => {
  const rows: TaskRow[] = [
    row({ note: "a", line: 14, done: true, text: "Ustalić zakres", assignees: ["Jan"], difficulty: 4, project_note: "p" }),
    row({ note: "b", line: 15, text: "Protokół", assignees: ["Stanisław"], due: TODAY - 1, difficulty: 2, project_note: "p" }),
    row({ note: "c", line: 16, text: "Schemat", assignees: ["Jan"], supervisor: "Stanisław", due: TODAY + 11, difficulty: 8, project_note: "p" }),
    row({ note: "d", line: 17, text: "Interfejs", assignees: ["Piotr"], supervisor: "Jan", project_note: "p" }),
    row({ note: "e", line: 3, text: "Luźne", assignees: ["Jan"], project: "Dziennik", project_note: null }),
  ];
  const projects = [{ note: "p", path: "Projekty/Triton/Triton.md", name: "Triton", folder: "Projekty/Triton", status: "aktywny", lead: "Stanisław" }];

  it("counts the project's done and open tasks and the progress", () => {
    const o = overview(rows.slice(0, 4), projects, "Jan", TODAY);
    expect(o.projects[0]).toMatchObject({ open: 3, done: 1, percent: 25 });
  });

  it("sums the open difficulty per person and leaves unrated tasks out of it", () => {
    const o = overview(rows.slice(0, 4), projects, "Jan", TODAY);
    expect(o.load).toEqual([
      { name: "Jan", open: 1, difficulty: 8, unrated: 0 },
      { name: "Piotr", open: 1, difficulty: 0, unrated: 1 },
      { name: "Stanisław", open: 1, difficulty: 2, unrated: 0 },
    ]);
  });

  it("lists my open tasks and the upcoming deadlines, each by due date", () => {
    const o = overview(rows, projects, "Jan", TODAY);
    // undated tasks come last in "mine"; only dated ones are "upcoming"
    expect(o.mine.map((t) => t.text)).toEqual(["Schemat", "Luźne"]);
    expect(o.upcoming.map((t) => t.text)).toEqual(["Schemat"]);
    expect(handlesIn(rows)).toEqual(["Jan", "Piotr", "Stanisław"]);
  });
});

describe("rewriteLine", () => {
  it("changes one line in one transaction and leaves the others as they were", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "# Projekt\n- [ ] Plan\n- [ ] Druga\n");
    let updates = 0;
    doc.on("update", () => updates++);
    expect(rewriteLine(text, 2, (l) => setTaskField(l, "assignee", "Ania"))).toBe(true);
    expect(updates).toBe(1);
    expect(text.toString()).toBe("# Projekt\n- [ ] Plan @Ania\n- [ ] Druga\n");
    expect(rewriteLine(text, 99, (l) => l)).toBe(false);
  });
});

describe("handles of the people", () => {
  it("keeps Polish letters in names", () => {
    expect(setTaskField("- [ ] A", "assignee", "Łukasz")).toBe("- [ ] A @Łukasz");
  });
});

describe("the tokens are the core's, so the edits and the chips agree with the index", () => {
  it("keeps a word after 📅 that is not a date, and leaves it alone when the date changes", () => {
    const line = "- [ ] Spotkanie 📅 jutro rano";
    expect(setTaskField(line, "due", "2026-11-05")).toBe("- [ ] Spotkanie 📅 jutro rano 📅 2026-11-05");
    expect(chipsOf(line, TODAY).some((c) => c.kind === "due")).toBe(false);
  });

  it("does not take `@a/b` for a handle: it stays, and the assignee is added next to it", () => {
    expect(setTaskField("- [ ] Pisz @a/b", "assignee", "Anna")).toBe("- [ ] Pisz @a/b @Anna");
    expect(chipsOf("- [ ] Pisz @a/b", TODAY).some((c) => c.kind === "who")).toBe(false);
  });

  it("edits the first assignee and keeps the others", () => {
    expect(setTaskField("- [ ] Plan @Jan @Piotr", "assignee", "Anna")).toBe("- [ ] Plan @Anna @Piotr");
    expect(setTaskField("- [ ] Plan @Jan @Piotr", "assignee", null)).toBe("- [ ] Plan @Piotr");
  });

  it("finds a token after a tab, as the index does", () => {
    expect(setTaskField("- [ ]\tY\t@Jan", "assignee", "Anna")).toBe("- [ ]\tY\t@Anna");
  });

  it("reads `!trudnosc:08` as 8, `@Ola.` as Ola, and a task in a quote", () => {
    expect(chipsOf("- [ ] x !trudnosc:08", TODAY).map((c) => c.label)).toEqual(["8/10"]);
    expect(chipsOf("- [ ] x @Ola.", TODAY).map((c) => c.label)).toEqual(["@Ola"]);
    expect(chipsOf("> - [ ] cytat @Jan", TODAY).map((c) => c.label)).toEqual(["@Jan"]);
  });
});

describe("locateTask: a row points at its task, and only at that task", () => {
  const row = (over: Partial<TaskRow>): TaskRow => ({
    note: "n", path: "P.md", line: 2, depth: 0, done: false, text: "B", assignees: ["Piotr"], supervisor: null,
    difficulty: null, due: null, done_on: null, priority: null, block: null, project: "P", project_note: null, ...over,
  });

  it("finds a task with an id by the id, after lines were added above it", () => {
    const text = "# P\n- [ ] A ^z-aaaa\n- [ ] B @Piotr ^z-bbbb";
    expect(locateTask(text, row({ line: 3, block: "z-bbbb" }))).toBe(3);
    expect(locateTask("X\n" + text, row({ line: 3, block: "z-bbbb" }))).toBe(4);
  });

  it("finds a task without an id where it moved to, when it is the only one that reads as the row", () => {
    expect(locateTask("- [ ] A\n- [ ] B @Piotr", row({ line: 1 }))).toBe(2);
  });

  it("refuses when the line changed, when it has an id now, and when more lines read as the row", () => {
    expect(locateTask("- [ ] A\n- [ ] B @Anna", row({ line: 2 }))).toBeNull();
    expect(locateTask("- [ ] A\n- [ ] B @Piotr ^z-zz11", row({ line: 2 }))).toBeNull();
    expect(locateTask("- [ ] B @Piotr\n- [ ] B @Piotr", row({ line: 1 }))).toBeNull();
  });

  it("compares every field of the row, not only the title", () => {
    expect(locateTask("- [ ] B @Piotr 📅 2026-11-05", row({ line: 1 }))).toBeNull();
    expect(locateTask("- [ ] B @Piotr !trudnosc:3", row({ line: 1 }))).toBeNull();
    expect(locateTask("- [x] B @Piotr", row({ line: 1 }))).toBeNull();
  });
});

describe("openSubtasks", () => {
  it("counts the open task lines under a task at any depth, never the task itself", () => {
    const lines = ["- [ ] A", "  - [ ] B", "    - [x] C", "      - [ ] D", "  - [ ] E"];
    expect(openSubtasks(lines, 0)).toBe(3);
    expect(openSubtasks(lines, 1)).toBe(1); // B: only D is open under it, and E is not its child
  });

  it("stops at the first line that is not indented deeper, so later siblings do not count", () => {
    expect(openSubtasks(["- [ ] A", "  - [x] B", "- [ ] C", "  - [ ] D"], 0)).toBe(0);
  });

  it("reads `*` and `-` bullets alike", () => {
    expect(openSubtasks(["* [ ] A", "  - [ ] B", "  * [ ] C"], 0)).toBe(2);
  });

  it("counts a tab as four columns, as Markdown does", () => {
    expect(openSubtasks(["- [ ] A", "\t- [ ] B", "  - [ ] C"], 0)).toBe(2);
    expect(openSubtasks(["\t- [ ] A", "    - [ ] B"], 0)).toBe(0); // same column: a sibling, not a child
  });

  it("skips non-task lines between subtasks and blank lines, which do not end the subtree", () => {
    const lines = ["- [ ] A", "  Opis zadania", "  - [ ] B", "", "  - [x] C", "Akapit", "- [ ] D"];
    expect(openSubtasks(lines, 0)).toBe(1);
  });
});

describe("openSubtasks: the box is the one after the list marker", () => {
  it("counts a task whose text has `[x]` later as open, and a done box as done", () => {
    expect(openSubtasks(["- [ ] A", "  - [ ] sprawdź [x] w opcjach"], 0)).toBe(1);
    expect(openSubtasks(["- [ ] A", "  - [x] zrobione [ ] jeszcze"], 0)).toBe(0);
  });

  it("reads ordered-list subtasks too", () => {
    expect(openSubtasks(["1. [ ] A", "   1. [ ] B", "   2. [x] C"], 0)).toBe(1);
  });
});
