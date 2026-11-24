import { describe, expect, it, vi } from "vitest";
import { MockBridge, type TreeItem, type TreeListing } from "./bridge";
import { applyTemplate, dailyPath, openDailyNote, templateNotes, titleOf, type DailyDeps } from "./templates";

const now = new Date(2026, 10, 5, 7, 4); // local 2026-11-05 07:04

describe("applyTemplate", () => {
  it("fills {{title}}, {{date}} and {{time}}", () => {
    expect(applyTemplate("# {{title}}\n{{date}} {{time}}", { title: "Plan", now })).toBe("# Plan\n2026-11-05 07:04");
  });

  it("formats {{date:FORMAT}} with YYYY, MM, DD, HH and mm, copying the rest", () => {
    expect(applyTemplate("{{date:DD.MM.YYYY}} {{date:YYYY/MM/DD HH:mm}} {{date:Dzień DD}}", { title: "x", now })).toBe(
      "05.11.2026 2026/11/05 07:04 Dzień 05",
    );
  });

  it("copies anything it does not know and never reads the title's own braces", () => {
    expect(applyTemplate("{{author}} {{title:x}} {{ date }}", { title: "{{date}}", now })).toBe("{{author}} {{title:x}} {{ date }}");
  });
});

describe("template folder and names", () => {
  const items: TreeItem[] = [
    { id: "1", path: "Szablony/Spotkanie.md" },
    { id: "2", path: "Szablony/Projekt/Plan.md" },
    { id: "3", path: "Szablonyy.md" },
    { id: "4", path: "Notatka.md" },
  ];

  it("lists the notes inside the folder, sub-folders too, and nothing for an empty folder", () => {
    expect(templateNotes(items, "Szablony").map((i) => i.id)).toEqual(["1", "2"]);
    expect(templateNotes(items, " /Szablony/ ").map((i) => i.id)).toEqual(["1", "2"]);
    expect(templateNotes(items, "")).toEqual([]);
  });

  it("titles a note by its name without .md, and places the daily note in its folder", () => {
    expect(titleOf("Projekt/Plan.md")).toBe("Plan");
    expect(dailyPath(now, "")).toBe("2026-11-05.md");
    expect(dailyPath(now, "Dziennik/")).toBe("Dziennik/2026-11-05.md");
  });
});

// Template and daily note in a MockBridge; the explorer's create is a stand-in that adds to the list the way its reload does.
async function setup(template = "# {{title}}\nGodzina {{time}}\n") {
  const bridge = new MockBridge([{ path: "Szablony/Dzienna.md", text: template }]);
  const notes: TreeItem[] = (await bridge.call<TreeListing>("list_tree")).notes;
  const create = vi.fn(async (path: string) => {
    const item = { id: await bridge.call<string>("create_note", { path }), path };
    notes.push(item);
    return item;
  });
  const open = vi.fn(async (_item: TreeItem) => {});
  const written = vi.fn();
  const deps: DailyDeps = { bridge, items: () => notes, create, open, written };
  return { bridge, notes, create, open, written, deps };
}

describe("daily note", () => {
  it("creates the day's note from the template once, then opens it", async () => {
    const { bridge, create, open, written, deps } = await setup();

    await openDailyNote(deps, "Dziennik", "Szablony/Dzienna.md", now);
    expect(create).toHaveBeenCalledWith("Dziennik/2026-11-05.md");
    const created = open.mock.calls[0][0];
    expect(created.path).toBe("Dziennik/2026-11-05.md");
    expect(await bridge.call<string>("note_text", { id: created.id })).toBe("# 2026-11-05\nGodzina 07:04\n");
    expect(written).toHaveBeenCalledWith(created.id, "# 2026-11-05\nGodzina 07:04\n");

    await openDailyNote(deps, "Dziennik", "Szablony/Dzienna.md", now);
    expect(create).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1][0]).toEqual(created);
  });

  it("makes an empty note when the template path is empty or names no note", async () => {
    const { bridge, create, open, written, deps } = await setup();
    await openDailyNote(deps, "", "", now);
    await openDailyNote(deps, "", "Szablony/Brak.md", new Date(2026, 10, 6));
    expect(create).toHaveBeenCalledTimes(2);
    expect(written).not.toHaveBeenCalled();
    const [first] = open.mock.calls[0];
    expect(await bridge.call<string>("note_text", { id: first.id })).toBe("");
  });

  it("the template's {{date:...}} is the day of the note too", async () => {
    const { bridge, open, deps } = await setup("{{date:DD.MM.YYYY}}");
    await openDailyNote(deps, "", "Szablony/Dzienna.md", now);
    expect(await bridge.call<string>("note_text", { id: open.mock.calls[0][0].id })).toBe("05.11.2026");
  });
});
