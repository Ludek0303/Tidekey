// @vitest-environment jsdom
import * as Y from "yjs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MockBridge } from "./bridge";
import { addTaskLines } from "./orgedit";
import { parseDay, type TaskRow } from "./orgtasks";
import { taskPanelBody } from "./taskpanel";
import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

const task: TaskRow = {
  note: "n", path: "P.md", line: 3, depth: 0, done: false, text: "Schemat", assignees: ["Jan", "Piotr"], supervisor: null,
  difficulty: 8, due: null, done_on: null, priority: null, block: "z-7f3a", project: "Triton", project_note: null,
};

describe("the task panel", () => {
  it("names the difficulty group by its label, not a <label> around the buttons", async () => {
    const edit = vi.fn(async () => undefined);
    const body = taskPanelBody(task, ["Jan", "Piotr"], [], edit, () => {}, async () => undefined);
    const panel = document.createElement("div");
    panel.append(...body);
    document.body.replaceChildren(panel);
    const group = panel.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.closest("label")).toBeNull();
    const named = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    expect(named?.textContent).toBe("Trudność");
  });

  it("does not write a rating when the label's text is clicked", async () => {
    const edit = vi.fn(async () => undefined);
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, [], [], edit, () => {}, async () => undefined));
    const label = [...panel.querySelectorAll<HTMLElement>(".task-field-label")].find((l) => l.textContent === "Trudność")!;
    label.click();
    expect(edit).not.toHaveBeenCalled();
  });

  it("shows the other assignees and edits the first one", async () => {
    const edit = vi.fn(async () => undefined);
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, [], [], edit, () => {}, async () => undefined));
    expect(panel.textContent).toContain("także: Piotr");
  });

  it("writes the name typed in the panel's name field", async () => {
    const edit = vi.fn(async () => undefined);
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, [], [], edit, () => {}, async () => undefined));
    const name = [...panel.querySelectorAll<HTMLInputElement>("input")].find((i) => i.closest("label")?.querySelector(".task-field-label")?.textContent === "Nazwa")!;
    expect(name.value).toBe("Schemat");
    name.value = "Schemat elektroniki";
    name.dispatchEvent(new Event("change"));
    expect(edit).toHaveBeenCalledWith("title", "Schemat elektroniki");
  });

  it("assigns an active organization group to the whole task", async () => {
    const edit = vi.fn(async () => undefined);
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, [], [{ id: "team", name: "Projektanci", member_ids: ["a", "b"] }], edit, () => {}, async () => undefined));
    const select = [...panel.querySelectorAll("select")].find((item) => item.getAttribute("aria-label") === "Grupa wykonawców")!;
    select.value = "team";
    select.dispatchEvent(new Event("change"));
    expect(edit).toHaveBeenCalledWith("group", "team");
  });
});

describe("adding tasks for the same person", () => {
  const LABEL = "Nowe zadanie dla tej samej osoby";
  const row: TaskRow = { ...task, note: "n", path: "P.md", line: 2, text: "Schemat", assignees: ["Jan"], due: parseDay("2026-11-10"), difficulty: null, block: "z-7f3a" };

  // The panel as the workspace builds it: the same `adds` state is passed on every build, and each add goes after
  // the last task added from the box (as OrgViews does).
  function setup(doc = new Y.Doc(), adds = { after: null as string | null, titles: [] as string[], focus: false, busy: false }) {
    if (doc.getText("content").length === 0) doc.getText("content").insert(0, "# P\n- [ ] Schemat @Jan 📅 2026-11-10 ^z-7f3a\n");
    const edits = { bridge: new MockBridge([]), openDoc: () => doc };
    const notify = vi.fn();
    const build = () => {
      const panel = document.createElement("div");
      panel.append(...taskPanelBody(row, [], [], vi.fn(async () => undefined), notify, async (titles, assignee) => {
        adds.after = await addTaskLines(edits, row, titles, assignee, adds.after);
      }, adds));
      document.body.replaceChildren(panel);
      const input = panel.querySelector<HTMLInputElement>(`input[aria-label="${LABEL}"]`)!;
      const button = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Dodaj zadanie")!;
      return { panel, input, button };
    };
    return { doc, notify, adds, build, ...build() };
  }

  it("adds one task on Enter, clears the input and keeps the focus in it", async () => {
    const { doc, panel, notify, input } = setup();
    input.value = "Pierwsze";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(document.activeElement).toBe(input);
    expect(doc.getText("content").toString()).toMatch(/^# P\n- \[ \] Schemat @Jan 📅 2026-11-10 \^z-7f3a\n- \[ \] Pierwsze @Jan 📅 2026-11-10 \^z-[0-9a-f]{4}\n$/);
    expect([...panel.querySelectorAll(".task-added li")].map((li) => li.textContent)).toEqual(["Pierwsze"]);
    expect(document.body.textContent).toContain("Dodano zadanie: Pierwsze.");
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the order, the list and the focus when the panel is built again after an add", async () => {
    const { doc, build, input } = setup();
    input.value = "Pierwsze";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(input.value).toBe(""));
    // the note's change re-renders the panel: a new body, a new input
    const again = build();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(again.input);
    expect([...again.panel.querySelectorAll(".task-added li")].map((li) => li.textContent)).toEqual(["Pierwsze"]);
    again.input.value = "Drugie";
    again.button.click();
    await vi.waitFor(() => expect(again.input.value).toBe(""));
    const lines = doc.getText("content").toString().split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("- [ ] Schemat @Jan 📅 2026-11-10 ^z-7f3a");
    expect(lines[1]).toMatch(/^- \[ \] Pierwsze @Jan 📅 2026-11-10 \^z-[0-9a-f]{4}$/);
    expect(lines[2]).toMatch(/^- \[ \] Drugie @Jan 📅 2026-11-10 \^z-[0-9a-f]{4}$/);
    expect([...again.panel.querySelectorAll(".task-added li")].map((li) => li.textContent)).toEqual(["Pierwsze", "Drugie"]);
  });

  it("adds the next task after the previous one when the button is clicked", async () => {
    const { doc, input, button } = setup();
    input.value = "Pierwsze";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(input.value).toBe(""));
    input.value = "Drugie";
    button.click();
    await vi.waitFor(() => expect(input.value).toBe(""));
    const text = doc.getText("content").toString();
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("- [ ] Schemat @Jan 📅 2026-11-10 ^z-7f3a");
    expect(lines[1]).toMatch(/^- \[ \] Pierwsze @Jan 📅 2026-11-10 \^z-[0-9a-f]{4}$/);
    expect(lines[2]).toMatch(/^- \[ \] Drugie @Jan 📅 2026-11-10 \^z-[0-9a-f]{4}$/);
    const ids = [...text.matchAll(/\^(z-[0-9a-f]{4})/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(3);
  });

  it("adds each line of a pasted list", async () => {
    const { doc, input } = setup();
    input.value = "Pierwsze";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(input.value).toBe(""));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "- Trzecie\n* Czwarte  \n" } });
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Dodano 2 zadania."));
    const titles = doc.getText("content").toString().split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/ @.*$/, ""));
    expect(titles).toEqual(["- [ ] Schemat", "- [ ] Pierwsze", "- [ ] Trzecie", "- [ ] Czwarte"]);
  });
});

describe("subtasks in the task panel", () => {
  it("adds a subtask with the typed name, trimmed", async () => {
    const addSubtask = vi.fn(async () => undefined);
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, [], [], vi.fn(async () => undefined), () => {}, async () => undefined, undefined, addSubtask));
    panel.querySelector<HTMLInputElement>('input[aria-label="Nazwa podzadania"]')!.value = " Krok 2 ";
    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Dodaj podzadanie")!.click();
    expect(addSubtask).toHaveBeenCalledWith("Krok 2");
  });

  it("shows no subtask box when the owner gives no way to add one", () => {
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, [], [], vi.fn(async () => undefined), () => {}, async () => undefined));
    expect(panel.querySelector('input[aria-label="Nazwa podzadania"]')).toBeNull();
  });
});


describe("the task panel in a personal space (one person)", () => {
  function panelOf(add = vi.fn(async () => undefined)) {
    const panel = document.createElement("div");
    panel.append(...taskPanelBody(task, ["Jan"], [{ id: "team", name: "Projektanci", member_ids: [] }], vi.fn(async () => undefined), () => {}, add, undefined, undefined, true));
    document.body.replaceChildren(panel);
    return panel;
  }

  it("has no assignee, group, supervisor or people inputs, and keeps the rest", () => {
    const panel = panelOf();
    const labels = [...panel.querySelectorAll(".task-field-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Nazwa", "Termin", "Trudność", "Więcej zadań"]);
    expect(panel.querySelector("select")).toBeNull();
    expect(panel.querySelector("datalist")).toBeNull();
    expect(panel.querySelector('input[list="task-people"]')).toBeNull();
    expect(panel.textContent).not.toContain("także: Piotr");
    expect(panel.textContent).not.toContain("Przypomnienie");
  });

  it("adds the tasks of the box without a person, though the task has people", async () => {
    const add = vi.fn(async () => undefined);
    const panel = panelOf(add);
    const input = panel.querySelector<HTMLInputElement>('input[aria-label="Nowe zadanie dla tej samej osoby"]')!;
    input.value = "Kupić mleko";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith(["Kupić mleko"], null));
  });
});
