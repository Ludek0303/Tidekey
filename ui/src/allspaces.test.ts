// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadWasm } from "./testwasm";
import { dayOf } from "./calendar/dates";
import { browserTargets, myCalendarSource, myItems, type MyCalendarInput, type SpaceSource } from "./allspaces";
import { listSharedVaults, ownVaults, type VaultInfo, type VaultRow } from "./vaults";
import type { BrowserBridge } from "./browserauth";

vi.mock("./vaults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vaults")>()),
  ownVaults: vi.fn(),
  listSharedVaults: vi.fn(),
}));
import type { TaskRow } from "./orgtasks";
import type { OrganizationSnapshot } from "./taskhistory";

beforeAll(loadWasm);

const DAY = dayOf(2026, 11, 5);
const at = (h: number) => new Date(2026, 10, 5, h).toISOString();
const identity = {
  me: "anna", owner: "anna", space_id: "org", verified: true, events: [], fields: {},
  members: [{ user_id: "anna", name: "Anna", role: "Owner" }, { user_id: "bartek", name: "Bartek", role: "Member" }],
} as unknown as OrganizationSnapshot;
const records = {
  participant: { id: "p", kind: "event", name: "Przegląd z zespołem", start: at(10), end: at(11), participants: ["anna"], group_ids: [], module_id: "m" },
  orgWide: { id: "w", kind: "event", name: "Ogłoszenie", start: at(12), end: at(13), participants: [], group_ids: [], module_id: "m" },
  deleted: { id: "d", kind: "event", name: "Usunięte", start: at(14), end: at(15), participants: [], group_ids: [], module_id: "m", deleted: true },
};
const task = (text: string, assignee: string[], due: number | null, done = false) =>
  ({ text, due, done, assignee_user_ids: assignee, assignees: [], note: "", path: "Zadania.md", line: 0, depth: 0, supervisor: null, supervisor_user_id: null, difficulty: null, done_on: null, priority: null, block: null, project: "", project_note: null, group_ids: [] }) as unknown as TaskRow;
const firma: SpaceSource = { path: "org-1", name: "Firma", identity, data: { records, revisions: {}, markdown: {}, operations: [], empty_revision: "" } };
const input: MyCalendarInput = {
  me: "anna",
  spaces: [firma],
  notes: [{ space: "Moje notatki", path: "browser-anna", text: "---\ntyp: kalendarz\n---\n- 2026-11-05 16:00 Lekarz\n" }],
  tasks: [{ space: "Firma", path: "org-1", rows: [task("Zadanie Anny", ["anna"], DAY), task("Cudze", ["bartek"], DAY), task("Zrobione", ["anna"], DAY, true), task("Bez terminu", ["anna"], null), task("Inny dzień", ["anna"], DAY + 1)] }],
};

describe("Mój kalendarz", () => {
  it("merges visible events, the calendar notes and the tasks due in the range, each labelled with its space", () => {
    const items = myItems(input, DAY, DAY).map((i) => [i.space, i.occ.event.title]);
    expect(items).toEqual([
      ["Firma", "Przegląd z zespołem"],
      ["Firma", "Ogłoszenie"],
      ["Moje notatki", "Lekarz"],
      ["Firma", "Zadanie Anny"],
    ]);
  });

  it("shows an event only to its participants, its organizer or everyone when it has neither", () => {
    // the notes are the viewer's own, so Bartek's input has none of Anna's
    const bartek = myItems({ ...input, me: "bartek", notes: [] }, DAY, DAY).map((i) => i.occ.event.title);
    expect(bartek).toEqual(["Ogłoszenie", "Cudze"]);
  });

  it("marks the all-day tasks and keeps the space's switch target", () => {
    const task = myItems(input, DAY, DAY).find((i) => i.occ.event.title === "Zadanie Anny");
    expect(task?.occ.startMin).toBeNull();
    expect(task?.path).toBe("org-1");
    expect(myItems(input, DAY + 1, DAY + 1).map((i) => i.occ.event.title)).toEqual(["Inny dzień"]);
  });

  it("leaves out an event outside the range", () => {
    expect(myItems(input, DAY + 2, DAY + 2)).toEqual([]);
  });
});

describe("Mój kalendarz: adding an event", () => {
  it("passes a create of an empty slot to the given callback, without a toast", () => {
    const create = vi.fn();
    const source = myCalendarSource(input, null, async () => undefined, create);
    source.create(DAY, 600);
    expect(create).toHaveBeenCalledWith(DAY, 600);
    expect(document.body.textContent).not.toContain("Wydarzenia dodaje się");
  });

  it("offers the personal space and the shared vaults the user may edit, once each", async () => {
    const personal: VaultInfo = { id: "browser-anna", name: "Moje notatki", kind: "notatki", ownerUserId: "anna" };
    const row = (id: string, role: VaultRow["role"]): VaultRow => ({ id, name: id, kind: "organizacja", ownerUserId: "bartek", role });
    vi.mocked(ownVaults).mockReturnValue([personal]);
    vi.mocked(listSharedVaults).mockResolvedValue([row("v-1", "editor"), row("v-2", "viewer"), row("v-1", "editor")]);
    const bridge = { user: { id: "anna" }, vault: { id: "v-1" } } as unknown as BrowserBridge;
    const targets = await browserTargets(bridge);
    expect(targets).toEqual([
      { path: "browser-anna", name: "Moje notatki", personal: true, organization: false, current: false },
      { path: "v-1", name: "v-1", personal: false, organization: true, current: true },
    ]);
  });

  it("keeps the own vaults when the shared list fails", async () => {
    vi.mocked(ownVaults).mockReturnValue([{ id: "browser-anna", name: "Moje notatki", kind: "notatki", ownerUserId: "anna" } as VaultInfo]);
    vi.mocked(listSharedVaults).mockRejectedValue(new Error("offline"));
    const bridge = { user: { id: "anna" }, vault: { id: "browser-anna" } } as unknown as BrowserBridge;
    expect((await browserTargets(bridge)).map((t) => t.path)).toEqual(["browser-anna"]);
  });
});
