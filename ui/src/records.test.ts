import { it, expect } from "vitest";
import {
  inventoryBalance,
  visibleTo,
  inOrgCalendar,
  moduleMarkdown,
  inventoryCsv,
  inventoryNote,
  type DataRecord,
  type RecordOperation,
  type ModuleData,
} from "./records";
const item: DataRecord = {
  id: "i",
  kind: "item",
  name: "Drone",
  category: "UAV",
  location: "Hangar / półka A",
  quantity: 1,
  module_id: "inventory",
};
const operation = (id: string): RecordOperation => ({
  event_id: id,
  actor_user_id: "u",
  time_ms: 0,
  record: {
    before: null,
    after: {
      id,
      kind: "movement",
      item_id: "i",
      module_id: "inventory",
      quantity: 1,
      issue: true,
    },
  },
});
it("detects two concurrent issues of the last piece without double counting replay", () => {
  expect(inventoryBalance(item, [operation("a"), operation("a")])).toEqual({
    available: 0,
    conflict: false,
  });
  expect(inventoryBalance(item, [operation("a"), operation("b")])).toEqual({
    available: -1,
    conflict: true,
  });
});
it("Markdown includes full records and authenticated history", () => {
  const module: DataRecord = {
    id: "inventory",
    kind: "inventory",
    name: "Lab",
  };
  const data = {
    records: { i: item },
    operations: [operation("a")],
  } as unknown as ModuleData;
  const md = moduleMarkdown(module, data);
  const content = JSON.parse(md.split("```json\n")[1].split("\n```")[0]);
  expect(content.records).toEqual([item]);
  expect(content.history).toEqual(data.operations);
});
it("CSV protects formula-like names and escapes quotes", () => {
  expect(inventoryCsv([{ ...item, name: '=SUM("x")' }], [], (id) => id)).toContain(
    '"\'=SUM(""x"")"',
  );
});
it("CSV and note carry every field, the custodian's name and escaped cells", () => {
  const part: DataRecord = { ...item, name: "A|B", custodian: "u1", price: "10\nzł", notes: "x" };
  const custodian = (id: string) => (id === "u1" ? "Anna" : "");
  const csv = inventoryCsv([part], [], custodian);
  expect(csv.split("\r\n")[0]).toContain('"Producent"');
  expect(csv.split("\r\n")[1]).toContain('"Anna"');
  const module: DataRecord = { id: "inv", kind: "inventory", name: "Lab" };
  const note = inventoryNote(module, [part], [], custodian);
  expect(note.split("\n")[0]).toBe("---");
  expect(note).toContain("modul: inv");
  expect(note).toContain("| i | A\\|B | UAV |");
  expect(note).toContain("| Anna | ");
  expect(note).toContain("```csv\n");
  expect(note).not.toContain("10\nzł");
});

it("shows an event to its participants, its organizer and everyone for an organization-wide one", () => {
  const identity = {
    me: "anna",
    owner: "anna",
    space_id: "s",
    verified: true,
    members: [
      { user_id: "anna" },
      { user_id: "jan" },
      { user_id: "ewa" },
    ],
    groups: [{ id: "g", name: "Zarząd", member_ids: ["jan"] }],
  } as unknown as Parameters<typeof visibleTo>[1];
  const event = (fields: Partial<DataRecord>): DataRecord => ({ id: "e", kind: "event", organizer: "ewa", ...fields });
  expect(visibleTo(event({ participants: ["anna"] }), identity)).toBe(true);
  expect(visibleTo(event({ participants: ["jan"] }), identity)).toBe(false);
  expect(visibleTo(event({ participants: ["jan"], organizer: "anna" }), identity)).toBe(true);
  expect(visibleTo(event({ group_ids: ["g"] }), identity)).toBe(false);
  expect(visibleTo(event({ group_ids: ["g"], participants: ["anna"] }), identity)).toBe(true);
  expect(visibleTo(event({ all_members: true, participants: [] }), identity)).toBe(true);
  expect(visibleTo(event({ participants: [], group_ids: [] }), identity)).toBe(true);
  // the organization calendar: the owner sees an event that is not theirs, a plain member does not
  expect(inOrgCalendar(event({ participants: ["jan"] }), identity)).toBe(true);
  const ewaAdmin = { ...identity, me: "ewa", members: [{ user_id: "anna" }, { user_id: "jan" }, { user_id: "ewa", role: "Admin" }] } as typeof identity;
  expect(inOrgCalendar(event({ participants: ["jan"], organizer: "anna" }), ewaAdmin)).toBe(true);
  expect(inOrgCalendar(event({ participants: ["jan"], organizer: "anna" }), { ...identity, me: "ewa" })).toBe(false);
});
