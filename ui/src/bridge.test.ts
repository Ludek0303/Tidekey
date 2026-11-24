import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { makeBigMock, MockBridge, type TreeListing } from "./bridge";
import { newLink, type GithubLink } from "./github/link";

const ID = "0123456789abcdef0123456789abcdef";

describe("MockBridge", () => {
  it("list_tree returns items sorted by path", async () => {
    const bridge = new MockBridge([
      { path: "b.md", text: "" },
      { path: "a/z.md", text: "" },
      { path: "a/c.md", text: "" },
    ]);
    const { notes: items } = await bridge.call<TreeListing>("list_tree");
    expect(items.map((i) => i.path)).toEqual(["a/c.md", "a/z.md", "b.md"]);
  });

  it("round-trips an update made in a separate Y.Doc", async () => {
    const bridge = new MockBridge([]);
    const id = await bridge.call<string>("create_note", { path: "x.md" });

    const state = await bridge.call<Uint8Array>("open_note", { id });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, state);
    const before = Y.encodeStateVector(remote);
    remote.getText("content").insert(0, "hello");
    const update = Y.encodeStateAsUpdate(remote, before);

    await bridge.call("apply_update", { id, update });

    const again = await bridge.call<Uint8Array>("open_note", { id });
    const check = new Y.Doc();
    Y.applyUpdate(check, again);
    expect(check.getText("content").toString()).toBe("hello");
  });

  it("seeds the sample tree with a Markdown table and wikilinks", async () => {
    const bridge = new MockBridge();
    const { notes: items } = await bridge.call<TreeListing>("list_tree");
    const spotkanie = items.find((i) => i.path === "Projekty/Spotkanie.md");
    expect(items.length).toBeGreaterThanOrEqual(5);
    const state = await bridge.call<Uint8Array>("open_note", { id: spotkanie!.id });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const text = doc.getText("content").toString();
    expect(text).toContain("| Kolumna | Wartość |");
    expect(text).toContain("[[Plan]]");
  });

  it("merges concurrent browser snapshots without dropping either Yjs edit", async () => {
    const base = new MockBridge([], false);
    base.setBrowserAccount("user-a", "a@example.test");
    const noteId = await base.call<string>("create_note", { path: "shared.md" });
    const initial = base.exportBrowserSnapshot("user-a");
    const left = new MockBridge([], false); left.setBrowserAccount("user-a", "a@example.test"); left.mergeBrowserSnapshot(initial);
    const right = new MockBridge([], false); right.setBrowserAccount("user-a", "a@example.test"); right.mergeBrowserSnapshot(initial);
    const leftDoc = new Y.Doc(); Y.applyUpdate(leftDoc, await left.call<Uint8Array>("open_note", { id: noteId }));
    const rightDoc = new Y.Doc(); Y.applyUpdate(rightDoc, await right.call<Uint8Array>("open_note", { id: noteId }));
    const leftVector = Y.encodeStateVector(leftDoc); leftDoc.getText("content").insert(0, "left");
    const rightVector = Y.encodeStateVector(rightDoc); rightDoc.getText("content").insert(0, "right");
    await left.call("apply_update", { id: noteId, update: Y.encodeStateAsUpdate(leftDoc, leftVector) });
    await right.call("apply_update", { id: noteId, update: Y.encodeStateAsUpdate(rightDoc, rightVector) });
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    const merged = new Y.Doc(); Y.applyUpdate(merged, await left.call<Uint8Array>("open_note", { id: noteId }));
    expect(merged.getText("content").toString()).toContain("left");
    expect(merged.getText("content").toString()).toContain("right");
  });

  it("makeBigMock seeds n notes", async () => {
    const { notes: items } = await makeBigMock(10000).call<TreeListing>("list_tree");
    expect(items).toHaveLength(10000);
  }, 30_000); // 10 000 Yjs documents take several seconds on a slow machine
});

describe("the organization demo", () => {
  it("is called Przykładowa organizacja at the top and in the switcher", async () => {
    const bridge = new MockBridge();
    expect(await bridge.call<string>("space_name")).toBe("Przykładowa organizacja");
    const [space] = await bridge.call<{ name: string }[]>("list_spaces");
    expect(space.name).toBe("Przykładowa organizacja");
  });
});

describe("GitHub links in the browser snapshot", () => {
  const SHA = "c".repeat(40);
  const link = (over: Partial<GithubLink> = {}): GithubLink => ({
    ...newLink("Projekty/Alfa", "owner/repo", {}),
    lastCommit: SHA,
    ...over,
  });

  it("an export without links has no github field", () => {
    const bridge = new MockBridge([], false);
    const state = bridge.exportBrowserSnapshot("user-a").state;
    expect("github" in state).toBe(false);
  });

  it("exports the links and a merge brings them to a second bridge", async () => {
    const left = new MockBridge([], false);
    left.setBrowserAccount("user-a", "a@example.test");
    const saved = await left.call<GithubLink>("github_save_link", { link: link() });
    const snapshot = left.exportBrowserSnapshot("user-a");
    expect(snapshot.state.github).toEqual([saved]);

    const right = new MockBridge([], false);
    right.setBrowserAccount("user-a", "a@example.test");
    right.mergeBrowserSnapshot(snapshot);
    expect(await right.call<GithubLink[]>("github_links")).toEqual([saved]);
  });

  it("a merge ignores invalid remote links", async () => {
    const bridge = new MockBridge([], false);
    const snapshot = bridge.exportBrowserSnapshot("user-a");
    snapshot.state.github = [{ nonsense: true } as unknown as GithubLink];
    bridge.mergeBrowserSnapshot(snapshot);
    expect(await bridge.call<GithubLink[]>("github_links")).toEqual([]);
  });

  it("github_save_link bumps rev on each save, the first one included", async () => {
    const bridge = new MockBridge([], false);
    const first = await bridge.call<GithubLink>("github_save_link", { link: link({ rev: 1 }) });
    expect(first.rev).toBe(2);
    const second = await bridge.call<GithubLink>("github_save_link", { link: { ...first, status: "Sprawdzone" } });
    expect(second.rev).toBe(3);
    expect((await bridge.call<GithubLink[]>("github_links"))[0]).toMatchObject({ status: "Sprawdzone", rev: 3 });
  });

  it("github_save_link takes rev from the record it is given when that is higher", async () => {
    const bridge = new MockBridge([], false);
    const saved = await bridge.call<GithubLink>("github_save_link", { link: link({ rev: 7 }) });
    expect(saved.rev).toBe(8);
  });

  it("github_save_link rejects a bad record in Polish and stores nothing", async () => {
    const bridge = new MockBridge([], false);
    await expect(bridge.call("github_save_link", { link: link({ repo: "../x" }) })).rejects.toThrow("Nieprawidłowe połączenie z GitHubem.");
    expect(await bridge.call<GithubLink[]>("github_links")).toEqual([]);
  });

  it("github_links returns copies", async () => {
    const bridge = new MockBridge([], false);
    await bridge.call("github_save_link", { link: link() });
    const copy = await bridge.call<GithubLink[]>("github_links");
    copy[0].status = "zmienione";
    expect((await bridge.call<GithubLink[]>("github_links"))[0].status).toBe("ok");
  });

  it("github_remove_link removes one record by id", async () => {
    const bridge = new MockBridge([], false);
    const keep = link();
    await bridge.call("github_save_link", { link: keep });
    await bridge.call("github_save_link", { link: link({ id: ID }) });
    await bridge.call("github_remove_link", { id: ID });
    expect((await bridge.call<GithubLink[]>("github_links")).map((l) => l.id)).toEqual([keep.id]);
  });

  it("a removed link stays removed after a device that still has it syncs back", async () => {
    const a = new MockBridge([], false);
    const b = new MockBridge([], false);
    await a.call("github_save_link", { link: link({ id: ID }) });
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot("owner", "vault"));
    await a.call("github_remove_link", { id: ID });
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot("owner", "vault"));
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot("owner", "vault"));
    expect(await a.call<GithubLink[]>("github_links")).toEqual([]);
    expect(await b.call<GithubLink[]>("github_links")).toEqual([]);
    await expect(a.call("github_save_link", { link: link({ id: ID }) })).rejects.toThrow("odłączone");
  });
});

describe("writes the editor does not make", () => {
  it("a GitHub write reaches the open editor as a note update; a typed one does not echo back", async () => {
    const bridge = new MockBridge([], false);
    const id = await bridge.call<string>("create_note", { path: "Z GitHuba.md" });
    const seen: string[] = [];
    bridge.on("note_update", (p) => seen.push((p as { id: string }).id));
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "z GitHuba");
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc), github: true });
    const typed = new Y.Doc();
    typed.getText("content").insert(0, "pisane");
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(typed) });
    expect(seen).toEqual([id]);
  });

  it("the open space's own task copy is not listed as another space", async () => {
    const bridge = new MockBridge([], false);
    const me = (bridge as unknown as { organization: { me: string } }).organization.me;
    await bridge.call("save_task_cache", { saved: { updated: "2026-11-15", userId: me, rows: [] } });
    await bridge.call("save_task_cache", { saved: { updated: "2026-11-15", userId: "someone-else", rows: [] } });
    const copies = await bridge.call<{ userId: string }[]>("task_caches");
    expect(copies.map((c) => c.userId)).toEqual(["someone-else"]);
  });
});

// Files in folders (docs/PLIKI.md §7, folderfiles.ts): one entry per file, placed by the folder_file_* commands.
describe("MockBridge: files in folders", () => {
  const A = "0123456789abcdef0123456789abcdef";
  const B = "fedcba9876543210fedcba9876543210";
  const listed = async (bridge: MockBridge) => (await bridge.call<TreeListing>("list_tree")).files ?? [];

  async function withFiles(): Promise<MockBridge> {
    const bridge = new MockBridge([{ path: "Projekty/Plan.md", text: "" }]);
    await bridge.call("create_folder", { path: "Projekty/Sub" });
    await bridge.files.upload(new File(["%PDF"], "umowa.pdf", { type: "application/pdf" }), { id: A });
    await bridge.files.upload(new File(["x"], "obraz.png", { type: "image/png" }), { id: B });
    return bridge;
  }

  it("a file goes into a folder, and list_tree lists it", async () => {
    const bridge = await withFiles();
    await bridge.call("folder_file_add", { fileId: A, path: "Projekty/umowa.pdf" });
    expect(await listed(bridge)).toEqual([{ fileId: A, path: "Projekty/umowa.pdf" }]);
    expect(await bridge.call("folder_files")).toEqual([{ fileId: A, path: "Projekty/umowa.pdf" }]);
  });

  it("refuses a .md name, a name a note or file holds, a missing folder, a second placement and an unknown file", async () => {
    const bridge = await withFiles();
    await bridge.call("folder_file_add", { fileId: A, path: "Projekty/umowa.pdf" });
    await expect(bridge.call("folder_file_add", { fileId: B, path: "Projekty/Plan.md" })).rejects.toThrow();
    await expect(bridge.call("folder_file_add", { fileId: B, path: "Projekty/UMOWA.pdf" })).rejects.toThrow("Ścieżka jest zajęta");
    await expect(bridge.call("folder_file_add", { fileId: B, path: "Nieistnieje/x.png" })).rejects.toThrow("Nie ma folderu");
    await expect(bridge.call("folder_file_add", { fileId: A, path: "Projekty/Sub/inna.pdf" })).rejects.toThrow("już w folderze");
    await expect(bridge.call("folder_file_add", { fileId: "f".repeat(32), path: "Projekty/x.pdf" })).rejects.toThrow("Nie ma takiego pliku");
  });

  it("rename moves a file; remove sends an unembedded file to the Pliki trash", async () => {
    const bridge = await withFiles();
    await bridge.call("folder_file_add", { fileId: A, path: "Projekty/umowa.pdf" });
    await bridge.call("folder_file_rename", { fileId: A, path: "Projekty/Sub/umowa.pdf" });
    expect((await listed(bridge))[0].path).toBe("Projekty/Sub/umowa.pdf");
    expect(await bridge.call("folder_file_remove", { fileId: A })).toBe(true);
    expect(await listed(bridge)).toEqual([]);
    expect((await bridge.files.info(A))?.state).toBe("trashed");
  });

  it("a file a note embeds leaves the folder but stays in Pliki", async () => {
    const bridge = await withFiles();
    const id = await bridge.call<string>("create_note", { path: "Projekty/Notka.md" });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, `![[plik:${B}#abcdef12]]`);
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
    await bridge.call("folder_file_add", { fileId: B, path: "Projekty/obraz.png" });
    expect(await bridge.call("folder_file_remove", { fileId: B })).toBe(false);
    expect(await listed(bridge)).toEqual([]);
    expect((await bridge.files.info(B))?.state).toBe("ready");
  });

  it("renaming a folder moves its files; deleting it takes them out and trashes the unembedded ones", async () => {
    const bridge = await withFiles();
    await bridge.call("folder_file_add", { fileId: A, path: "Projekty/Sub/umowa.pdf" });
    await bridge.call("rename_folder", { from: "Projekty/Sub", to: "Projekty/Inny" });
    expect((await listed(bridge))[0].path).toBe("Projekty/Inny/umowa.pdf");
    await bridge.call("delete_folder", { path: "Projekty/Inny" });
    expect(await listed(bridge)).toEqual([]);
    expect((await bridge.files.info(A))?.state).toBe("trashed");
  });

  it("two devices: the later change of a file's place wins, and a deletion wins a tie", async () => {
    const left = await withFiles();
    await left.call("folder_file_add", { fileId: A, path: "Projekty/umowa.pdf" });
    const right = new MockBridge([], false);
    right.setBrowserAccount("user-a", "a@example.test");
    right.mergeBrowserSnapshot(left.exportBrowserSnapshot("user-a"));
    // the later change is stamped a second later (two changes in one millisecond would be a tie)
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    await right.call("folder_file_rename", { fileId: A, path: "Projekty/Sub/umowa.pdf" });
    later.mockRestore();
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect((await listed(left))[0].path).toBe("Projekty/Sub/umowa.pdf");

    const snap = left.exportBrowserSnapshot("user-a");
    const entry = snap.state.folderFiles!.find((f) => f.fileId === A)!;
    const tie = (deleted: boolean) => ({ ...structuredClone(snap), state: { ...snap.state, folderFiles: [{ ...entry, changedAt: 500, deleted, path: "Projekty/x.pdf" }] } });
    const one = new MockBridge([], false);
    one.setBrowserAccount("user-a", "a@example.test");
    one.mergeBrowserSnapshot(tie(false));
    one.mergeBrowserSnapshot(tie(true));
    expect(await listed(one)).toEqual([]);
    const two = new MockBridge([], false);
    two.setBrowserAccount("user-a", "a@example.test");
    two.mergeBrowserSnapshot(tie(true));
    two.mergeBrowserSnapshot(tie(false));
    expect(await listed(two)).toEqual([]);
  });
});
