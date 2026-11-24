// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MockBridge } from "./bridge";
import { recordConflicts, type ModuleData, type RecordOperation } from "./records";

// Two devices of two members sharing one state, as the sync merges them.
function device(userId: string): MockBridge {
  const b = new MockBridge([], false);
  b.setBrowserAccount(userId, `${userId}@example.test`);
  return b;
}
const data = (b: MockBridge): ModuleData => (b.exportBrowserSnapshot("owner").state.records as unknown as { data: ModuleData }).data;
const save = (b: MockBridge, record: Record<string, unknown>, base?: string[]) =>
  b.call("organization_save_record", { record, expected: data(b).revisions[String(record.id)] ?? data(b).empty_revision, base });
const sync = (from: MockBridge, to: MockBridge) => to.mergeBrowserSnapshot(from.exportBrowserSnapshot("owner"));

const op = (event_id: string, actor: string, base: string | string[] | null | undefined, name: string): RecordOperation => ({
  event_id, actor_user_id: actor, time_ms: 1, base,
  record: { before: null, after: { id: "r1", kind: "event", module_id: "cal", name, start: "2026-01-01T10:00", end: "2026-01-01T11:00" } },
});

describe("record conflicts (pure)", () => {
  it("two operations from different authors on the same base conflict and keep both versions", () => {
    const found = recordConflicts([op("o1", "a", "base", "A"), op("o2", "b", "base", "B")]);
    expect(found.map((c) => [c.a.event_id, c.b.event_id])).toEqual([["o1", "o2"]]);
    expect(found[0].a.record.after.name).toBe("A");
    expect(found[0].b.record.after.name).toBe("B");
  });

  it("an operation based on the other one is not a conflict (the author saw it)", () => {
    expect(recordConflicts([op("o1", "a", "base", "A"), op("o2", "b", "o1", "B")])).toEqual([]);
  });

  it("the same author twice on one base is not a conflict", () => {
    expect(recordConflicts([op("o1", "a", "base", "A"), op("o2", "a", "base", "B")])).toEqual([]);
  });

  it("an operation whose base names both of them resolves the conflict", () => {
    const ops = [op("o1", "a", "base", "A"), op("o2", "b", "base", "B"), op("o3", "a", ["o1", "o2"], "C")];
    expect(recordConflicts(ops)).toEqual([]);
  });

  it("legacy operations without a base never conflict", () => {
    const legacy = [op("o1", "a", undefined, "A"), op("o2", "b", undefined, "B")];
    expect(recordConflicts(legacy)).toEqual([]);
  });

  it("operations on different records do not conflict", () => {
    const other = { ...op("o2", "b", "base", "B"), record: { before: null, after: { id: "r2", kind: "item" } } };
    expect(recordConflicts([op("o1", "a", "base", "A"), other])).toEqual([]);
  });
});

describe("record conflicts across two devices", () => {
  it("both members edit the same record from the same state: kept, shown, and resolved by one choice", async () => {
    const a = device("user-a");
    const b = device("user-b");
    await save(a, { id: "r1", kind: "event", module_id: "cal", name: "Start", start: "2026-01-01T10:00", end: "2026-01-01T11:00" });
    sync(a, b);
    await save(a, { id: "r1", kind: "event", module_id: "cal", name: "A", start: "2026-01-01T10:00", end: "2026-01-01T11:00" });
    await save(b, { id: "r1", kind: "event", module_id: "cal", name: "B", start: "2026-01-01T12:00", end: "2026-01-01T13:00" });
    sync(a, b);
    sync(b, a);

    const conflicts = recordConflicts(data(a).operations);
    expect(conflicts.length).toBe(1);
    expect(new Set([conflicts[0].a.record.after.name, conflicts[0].b.record.after.name])).toEqual(new Set(["A", "B"]));

    // choosing B's version creates an operation based on both; the conflict is gone on both devices
    const { a: first, b: second } = conflicts[0];
    const chosen = [first, second].find((o) => o.record.after.name === "B")!;
    await a.call("organization_save_record", {
      record: { ...chosen.record.after },
      expected: data(a).revisions["r1"],
      base: [first.event_id, second.event_id],
    });
    sync(a, b);
    expect(recordConflicts(data(a).operations)).toEqual([]);
    expect(recordConflicts(data(b).operations)).toEqual([]);
    expect(data(b).records["r1"].name).toBe("B");
  });

  it("a second change made after seeing the first is not a conflict", async () => {
    const a = device("user-a");
    const b = device("user-b");
    await save(a, { id: "r1", kind: "item", name: "Drukarka", category: "x", location: "y", quantity: 1 });
    sync(a, b);
    await save(b, { id: "r1", kind: "item", name: "Drukarka 2", category: "x", location: "y", quantity: 1 });
    sync(b, a);
    await save(a, { id: "r1", kind: "item", name: "Drukarka 3", category: "x", location: "y", quantity: 1 });
    sync(a, b);
    expect(recordConflicts(data(a).operations)).toEqual([]);
  });
});

describe("signing hook on MockBridge", () => {
  it("signs the operations and events a call made before they are persisted; without a signer nothing is signed", async () => {
    const plain = device("user-a");
    await save(plain, { id: "r1", kind: "item", name: "X", category: "c", location: "l", quantity: 1 });
    expect(data(plain).operations[0].signature).toBeUndefined();
    expect(data(plain).operations[0].base).toBeNull();

    const signed = device("user-a");
    signed.eventSigner = async (event) => { event.signerUserId = "user-a"; event.signature = `sig-${event.event_id}`; };
    await save(signed, { id: "r1", kind: "item", name: "X", category: "c", location: "l", quantity: 1 });
    await signed.settleSignatures();
    const operation = data(signed).operations[0];
    expect(operation.signerUserId).toBe("user-a");
    expect(operation.signature).toBe(`sig-${operation.event_id}`);
  });
});
