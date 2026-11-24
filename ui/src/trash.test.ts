import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MockBridge, TRASH_DAYS, type TrashEntry, type TreeListing } from "./bridge";

const DAY = 24 * 60 * 60 * 1000;
// Time is controlled: every stamp the bridges write comes from `now`.
let now = 1_800_000_000_000;
const tick = (ms = 1000): void => { now += ms; };

beforeEach(() => { vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); });

function bridge(): MockBridge {
  const b = new MockBridge([], false);
  b.setBrowserAccount("user-a", "a@example.test");
  return b;
}
async function note(b: MockBridge, path: string, text: string): Promise<string> {
  const id = await b.call<string>("create_note", { path });
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
  return id;
}
async function textOf(b: MockBridge, id: string): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
  return doc.getText("content").toString();
}
const trashOf = (b: MockBridge) => b.call<TrashEntry[]>("list_trash");
const paths = async (b: MockBridge): Promise<string[]> => (await b.call<TreeListing>("list_tree")).notes.map((n) => n.path).sort();
// What `from` sends to `to` as the server's update.
const sync = (from: MockBridge, to: MockBridge): void => { to.mergeBrowserSnapshot(from.exportBrowserSnapshot("user-a")); };

describe("the trash (MockBridge)", () => {
  it("delete → list_trash shows the note → restore brings back the same text", async () => {
    const b = bridge();
    const id = await note(b, "Notatki/Plan.md", "# Plan\n\nTekst do odzyskania.");
    await b.call("delete", { id });
    expect(await paths(b)).toEqual([]);
    expect(await trashOf(b)).toEqual([{ id, path: "Notatki/Plan.md", deleted_at: now }]);
    expect(await b.call<string>("restore_note", { id })).toBe("Notatki/Plan.md");
    expect(await paths(b)).toEqual(["Notatki/Plan.md"]);
    expect(await textOf(b, id)).toContain("Tekst do odzyskania.");
    expect(await trashOf(b)).toEqual([]);
  });

  it("list_trash is newest first", async () => {
    const b = bridge();
    const old = await note(b, "A.md", "a");
    await b.call("delete", { id: old });
    tick();
    const fresh = await note(b, "B.md", "b");
    await b.call("delete", { id: fresh });
    expect((await trashOf(b)).map((t) => t.id)).toEqual([fresh, old]);
  });

  it("a restore into a taken path takes a suffix beside it, and a missing folder comes back", async () => {
    const b = bridge();
    const id = await note(b, "Archiwum/2025/Plan.md", "stary");
    await b.call("delete_folder", { path: "Archiwum" });
    expect((await b.call<TreeListing>("list_tree")).folders).not.toContain("Archiwum/2025");
    expect(await b.call<string>("restore_note", { id })).toBe("Archiwum/2025/Plan.md");
    expect((await b.call<TreeListing>("list_tree")).folders).toEqual(expect.arrayContaining(["Archiwum", "Archiwum/2025"]));

    const other = await note(b, "Nowa.md", "x");
    await b.call("delete", { id: other });
    await note(b, "Nowa.md", "nowy na miejscu");
    expect(await b.call<string>("restore_note", { id: other })).toBe("Nowa (przywrócona).md");
    expect(await paths(b)).toContain("Nowa (przywrócona).md");
  });

  it("delete_folder puts all its notes in the trash and keeps the rest", async () => {
    const b = bridge();
    const a = await note(b, "Projekt/A.md", "a");
    const c = await note(b, "Projekt/Sub/C.md", "c");
    await note(b, "Inny.md", "i");
    await b.call("delete_folder", { path: "Projekt" });
    expect((await trashOf(b)).map((t) => t.id).sort()).toEqual([a, c].sort());
    expect(await paths(b)).toEqual(["Inny.md"]);
  });

  it("the trash is purged after TRASH_DAYS days (183), on the list and on export", async () => {
    expect(TRASH_DAYS).toBe(183);
    const b = bridge();
    const id = await note(b, "Stara.md", "x");
    await b.call("delete", { id });
    now += TRASH_DAYS * DAY - 1000;
    expect(await trashOf(b)).toHaveLength(1);
    now += 2000;
    expect(await trashOf(b)).toEqual([]);
    expect(b.exportBrowserSnapshot("user-a").state.trash).toEqual([]);
    expect(b.exportBrowserSnapshot("user-a").state.versions.map(([noteId]) => noteId)).not.toContain(id);
  });

  it("purge_note removes one item for good", async () => {
    const b = bridge();
    const id = await note(b, "Do usunięcia.md", "x");
    const keep = await note(b, "Zostaje.md", "y");
    await b.call("delete", { id });
    await b.call("delete", { id: keep });
    await b.call("purge_note", { id });
    expect((await trashOf(b)).map((t) => t.id)).toEqual([keep]);
    await expect(b.call("restore_note", { id })).rejects.toThrow("Nie ma takiej notatki w koszu.");
  });
});

describe("the trash across devices (merge)", () => {
  it("a restore on one device, merged, brings the note back on the other", async () => {
    const left = bridge(), right = bridge();
    const id = await note(left, "A.md", "tekst");
    tick();
    await left.call("delete", { id });
    sync(left, right);
    expect(await paths(right)).toEqual([]);
    tick();
    await right.call("restore_note", { id });
    // the device that still holds the old delete takes the restore
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect(await paths(left)).toEqual(["A.md"]);
    expect(await textOf(left, id)).toBe("tekst");
    expect(await trashOf(left)).toEqual([]);
  });

  it("a delete newer than an earlier restore wins on both devices", async () => {
    const a = bridge(), b = bridge();
    const id = await note(a, "N.md", "x");
    sync(a, b);
    tick();
    await a.call("delete", { id });
    tick();
    await a.call("restore_note", { id });
    tick();
    await b.call("delete", { id }); // b still had the note alive
    const deletedAt = now;
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot("user-a"));
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot("user-a"));
    for (const device of [a, b]) {
      expect(await paths(device)).toEqual([]);
      expect(await trashOf(device)).toEqual([{ id, path: "N.md", deleted_at: deletedAt }]);
    }
  });

  it("a purged item is not brought back by a merge from an older copy", async () => {
    const a = bridge(), b = bridge();
    const id = await note(a, "P.md", "x");
    await a.call("delete", { id });
    const older = a.exportBrowserSnapshot("user-a");
    b.mergeBrowserSnapshot(older);
    tick();
    await b.call("purge_note", { id });
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot("user-a"));
    expect(await trashOf(a)).toEqual([]);
    // the old copy comes again, from a device that never got the purge
    b.mergeBrowserSnapshot(older);
    expect(await trashOf(b)).toEqual([]);
    expect(await paths(b)).toEqual([]);
  });

  it("a trash copy of an older delete does not come back after the note was deleted again", async () => {
    const a = bridge(), b = bridge();
    const id = await note(a, "R.md", "x");
    await a.call("delete", { id });
    const first = a.exportBrowserSnapshot("user-a");
    tick();
    await a.call("restore_note", { id });
    tick();
    await a.call("delete", { id });
    b.mergeBrowserSnapshot(first); // the first delete reaches b
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot("user-a"));
    expect((await trashOf(b)).map((t) => t.deleted_at)).toEqual([now]);
  });
});
