// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "../bridge";
import { CALENDAR_TEXT, createCalendar, findCalendar, freeCalendarPath, newCalendar, type CalendarDeps } from "./open";
import type { TreeItem } from "../bridge";

// A calendar deps set over a MockBridge; `calendars` are the ids whose text is a calendar.
function setup(seed: { path: string; text: string }[], calendars: string[] = []) {
  const bridge = new MockBridge(seed);
  const items: TreeItem[] = seed.map((s, i) => ({ id: `note-${i + 1}`, path: s.path }));
  const open = vi.fn(async (_item: TreeItem) => undefined);
  const deps: CalendarDeps = {
    bridge,
    items: () => items,
    isCalendar: (id) => calendars.includes(id),
    create: async (path) => {
      const id = await bridge.call<string>("create_note", { path });
      const item = { id, path };
      items.push(item);
      return item;
    },
    open,
  };
  return { bridge, items, open, deps };
}

describe("calendar note paths", () => {
  it("takes the first free name in the folder", () => {
    const items = [
      { id: "1", path: "Kalendarz.md" },
      { id: "2", path: "kalendarz 2.md" },
      { id: "3", path: "Projekt/Kalendarz.md" },
    ];
    expect(freeCalendarPath(items)).toBe("Kalendarz 3.md");
    expect(freeCalendarPath(items, "Projekt")).toBe("Projekt/Kalendarz 2.md");
    expect(freeCalendarPath([], "Praca")).toBe("Praca/Kalendarz.md");
  });

  it("finds the calendar that comes first by path", () => {
    const items = [
      { id: "z", path: "Zeta.md" },
      { id: "b", path: "Beta.md" },
      { id: "a", path: "Alfa.md" },
    ];
    expect(findCalendar(items, (id) => id !== "x")).toEqual({ id: "a", path: "Alfa.md" });
    expect(findCalendar(items, () => false)).toBeUndefined();
  });
});

describe("the ribbon's calendar", () => {
  it("creates a second calendar in a folder under a free name", async () => {
    const { bridge, open, deps } = setup([{ path: "Kalendarz.md", text: CALENDAR_TEXT }]);
    await createCalendar(deps, "");
    await createCalendar(deps, "");
    expect(open).toHaveBeenCalledTimes(0);
    const paths = (await bridge.call<{ notes: TreeItem[] }>("list_tree")).notes.map((n) => n.path);
    expect(paths).toEqual(["Kalendarz 2.md", "Kalendarz 3.md", "Kalendarz.md"]);
  });
});

describe("one calendar per organization", () => {
  it("opens the organization's calendar instead of creating a second one", async () => {
    const { deps, items, open } = setup([{ path: "Kalendarz.md", text: CALENDAR_TEXT }], ["note-1"]);
    const notice = vi.fn();
    await newCalendar({ ...deps, single: () => true, notice }, "Projekt");
    expect(items).toHaveLength(1);
    expect(open).toHaveBeenCalledWith(items[0]);
    expect(notice).toHaveBeenCalledOnce();
  });

  it("still creates the first one, and a personal space may have more", async () => {
    const first = setup([]);
    await newCalendar({ ...first.deps, single: () => true });
    expect(first.items.map((i) => i.path)).toEqual(["Kalendarz.md"]);
    const personal = setup([{ path: "Kalendarz.md", text: CALENDAR_TEXT }], ["note-1"]);
    await newCalendar({ ...personal.deps, single: () => false });
    expect(personal.items).toHaveLength(2);
  });
});
