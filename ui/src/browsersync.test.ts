// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MockBridge, type BrowserVaultSnapshot, type TreeListing } from "./bridge";
import { SaveChain, codeOpens, encryptSnapshot, newRecoveryKey, recoveryGate, retryDelay, type Verifier } from "./browserauth";

const USER = "user-a";
const device = (): MockBridge => { const b = new MockBridge([], false); b.setBrowserAccount(USER, "a@example.test"); return b; };
const paths = async (b: MockBridge): Promise<string[]> => (await b.call<TreeListing>("list_tree")).notes.map((n) => n.path).sort();
const textOf = async (b: MockBridge, id: string): Promise<string> => {
  const doc = new Y.Doc(); Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id })); return doc.getText("content").toString();
};
async function typeInto(b: MockBridge, id: string, text: string): Promise<void> {
  const doc = new Y.Doc(); Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
  const before = Y.encodeStateVector(doc); doc.getText("content").insert(0, text);
  await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("tombstones", () => {
  it("a note deleted on one device stays deleted when an old copy arrives from another", async () => {
    const a = device(); const id = await a.call<string>("create_note", { path: "stary.md" });
    const b = device(); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    await a.call("delete", { id });
    a.mergeRemoteSnapshot(b.exportBrowserSnapshot(USER));
    expect(await paths(a)).toEqual([]);
    expect(a.exportBrowserSnapshot(USER).state.deleted?.map((t) => t.id)).toEqual([id]);
  });

  it("the tombstone reaches the device that still holds the note, and removes it there", async () => {
    const a = device(); const id = await a.call<string>("create_note", { path: "x.md" });
    const b = device(); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    await a.call("delete", { id });
    const result = b.mergeRemoteSnapshot(a.exportBrowserSnapshot(USER));
    expect(result.removed).toEqual([id]);
    expect(await paths(b)).toEqual([]);
  });

  it("a deleted id is not re-added even when its copy comes back later with edits", async () => {
    const a = device(); const id = await a.call<string>("create_note", { path: "x.md" });
    const b = device(); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    await a.call("delete", { id });
    await typeInto(b, id, "po usunięciu");
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER));
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER));
    expect(await paths(a)).toEqual([]);
  });

  it("an old snapshot without the new fields still loads", async () => {
    const a = device(); await a.call("create_note", { path: "stary.md" });
    const old = JSON.parse(JSON.stringify(a.exportBrowserSnapshot(USER))) as BrowserVaultSnapshot;
    delete old.state.deleted;
    for (const n of old.state.notes) delete n.pathChangedAt;
    const b = device(); b.mergeBrowserSnapshot(old);
    expect(await paths(b)).toEqual(["stary.md"]);
  });
});

describe("folder synchronization", () => {
  it("propagates a folder deletion, rejects a stale copy and allows a later recreation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const a = device(); await a.call("create_folder", { path: "Zespół/Pusty" });
    const b = device(); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));

    now.mockReturnValue(2000);
    await a.call("delete_folder", { path: "Zespół" });
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER));
    b.mergeRemoteSnapshot(a.exportBrowserSnapshot(USER));
    expect((await a.call<TreeListing>("list_tree")).folders).not.toContain("Zespół");
    expect((await b.call<TreeListing>("list_tree")).folders).not.toContain("Zespół/Pusty");

    now.mockReturnValue(3000);
    await b.call("create_folder", { path: "Zespół" });
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER));
    expect((await a.call<TreeListing>("list_tree")).folders).toContain("Zespół");
  });
});

describe("organization profile synchronization", () => {
  it("keeps the newest user name when an older device comes back", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const a = device(); const b = device();
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    now.mockReturnValue(2000);
    await a.call("organization_person", { userId: USER, name: "Anna" });
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    a.mergeBrowserSnapshot(device().exportBrowserSnapshot(USER));
    expect(a.exportBrowserSnapshot(USER).state.organization.members[0].name).toBe("Anna");
    expect(b.exportBrowserSnapshot(USER).state.organization.members[0].name).toBe("Anna");
  });
});

describe("path merges", () => {
  it("concurrent renames: the later rename wins, nothing throws", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const a = device(); const id = await a.call<string>("create_note", { path: "stary.md" });
    const b = device(); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    now.mockReturnValue(2000); await a.call("rename", { id, path: "lewy.md" });
    now.mockReturnValue(3000); await b.call("rename", { id, path: "prawy.md" });
    expect(() => a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER))).not.toThrow();
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    expect(await paths(a)).toEqual(["prawy.md"]);
    expect(await paths(b)).toEqual(["prawy.md"]);
  });

  it("renames at the same moment: the smaller path wins on both sides", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const a = device(); const id = await a.call<string>("create_note", { path: "stary.md" });
    const b = device(); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    now.mockReturnValue(5000);
    await a.call("rename", { id, path: "zeta.md" }); await b.call("rename", { id, path: "alfa.md" });
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER)); b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    expect(await paths(a)).toEqual(["alfa.md"]);
    expect(await paths(b)).toEqual(["alfa.md"]);
  });

  it("two different notes on one path are both kept, one under a conflict name, and the devices agree", async () => {
    const a = device(); const b = device();
    const idA = await a.call<string>("create_note", { path: "Plan.md" });
    const idB = await b.call<string>("create_note", { path: "Plan.md" });
    await typeInto(a, idA, "z A\n"); await typeInto(b, idB, "z B\n");
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER));
    b.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    a.mergeBrowserSnapshot(b.exportBrowserSnapshot(USER));
    const listed = await paths(a);
    expect(listed).toHaveLength(2);
    expect(listed).toContain("Plan.md");
    expect(listed.some((p) => /^Plan \(konflikt \d+\)\.md$/.test(p))).toBe(true);
    expect(await paths(b)).toEqual(listed);
    // the contents are not merged into each other
    expect(await textOf(a, idA)).toBe("z A\n");
    expect(await textOf(a, idB)).toBe("z B\n");
  });
});

describe("remote merges", () => {
  it("emit the tree change, a note_update that the open editor applies, and note_removed", async () => {
    const a = device(); const shared = await a.call<string>("create_note", { path: "wspolna.md" });
    const gone = await a.call<string>("create_note", { path: "znikająca.md" });
    const local = device(); local.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));

    // the open editor of "wspolna" is a Y.Doc fed by note_update events
    const editor = new Y.Doc(); Y.applyUpdate(editor, await local.call<Uint8Array>("open_note", { id: shared }));
    const seen: string[] = [];
    local.on("tree_changed", () => seen.push("tree"));
    local.on("note_removed", (p) => seen.push(`removed:${(p as { id: string }).id}`));
    local.on("note_update", (p) => { const { id, update } = p as { id: string; update: Uint8Array }; if (id === shared) Y.applyUpdate(editor, update, "remote"); seen.push(`update:${id}`); });
    local.on("remote_changed", () => seen.push("remote"));

    await typeInto(a, shared, "od drugiego urządzenia\n");
    await a.call("delete", { id: gone });
    const result = local.mergeRemoteSnapshot(a.exportBrowserSnapshot(USER));

    expect(result).toEqual({ removed: [gone], updated: [shared], treeChanged: true });
    expect(editor.getText("content").toString()).toBe("od drugiego urządzenia\n");
    expect(seen).toEqual(expect.arrayContaining(["tree", `removed:${gone}`, `update:${shared}`, "remote"]));
    expect(await paths(local)).toEqual(["wspolna.md"]);
  });

  it("an identical snapshot changes nothing and emits nothing", async () => {
    const a = device(); await a.call("create_note", { path: "x.md" });
    const local = device(); local.mergeBrowserSnapshot(a.exportBrowserSnapshot(USER));
    const spy = vi.fn();
    for (const e of ["tree_changed", "note_update", "note_removed", "remote_changed"]) local.on(e, spy);
    const result = local.mergeRemoteSnapshot(a.exportBrowserSnapshot(USER));
    expect(result).toEqual({ removed: [], updated: [], treeChanged: false });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("save chain", () => {
  it("recovers after one forced failure: later saves run, the error is reported and then cleared", async () => {
    const reports: boolean[] = []; let retries = 0;
    const chain = new SaveChain(() => retries++, (ok) => reports.push(ok));
    const saved: string[] = [];
    await expect(chain.run(async () => { throw new Error("IndexedDB"); })).rejects.toThrow("IndexedDB");
    await chain.run(async () => { saved.push("second"); });
    await chain.run(async () => { saved.push("third"); });
    expect(saved).toEqual(["second", "third"]);
    expect(reports).toEqual([false, true, true]);
  });

  it("retries with backoff until a save succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const chain = new SaveChain(() => { attempts++; void chain.run(async () => { if (attempts < 2) throw new Error("encrypt"); }).catch(() => undefined); }, () => undefined);
    await expect(chain.run(async () => { throw new Error("encrypt"); })).rejects.toThrow();
    vi.advanceTimersByTime(999); expect(attempts).toBe(0);
    vi.advanceTimersByTime(1); expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("the delay doubles from 1 s and stops at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("recovery code", () => {
  it("a code that does not open the vault is rejected; the right one opens it", async () => {
    const right = await newRecoveryKey(); const wrong = await newRecoveryKey();
    const snapshot = device().exportBrowserSnapshot(USER);
    const verifier: Verifier = { envelope: await encryptSnapshot(snapshot, right.key), vaultId: snapshot.vault.id, checked: true };
    expect(await codeOpens(wrong.code, verifier, USER)).toBe(false);
    expect(await codeOpens(right.code, verifier, USER)).toBe(true);
  });

  it("with no vault to check against, any code is accepted; with the server out of reach, none is (docs/MCP.md §3.7)", async () => {
    const code = (await newRecoveryKey()).code;
    expect(await codeOpens(code, { vaultId: `browser-${USER}`, checked: true }, USER)).toBe(true);
    expect(await codeOpens(code, { vaultId: `browser-${USER}`, checked: false }, USER)).toBe(false);
  });

  it("the gate shows the Polish error for a wrong code and resolves only with a right one", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div"); document.body.append(root);
    const right = await newRecoveryKey(); const wrong = await newRecoveryKey();
    const snapshot = device().exportBrowserSnapshot(USER);
    const verifier: Verifier = { envelope: await encryptSnapshot(snapshot, right.key), vaultId: snapshot.vault.id, checked: true };
    let resolved: string | null | undefined;
    void recoveryGate(root, { id: USER, email: "a@example.test", name: "Ala" }, null, { verify: (c) => codeOpens(c, verifier, USER), allowNew: false }).then((v) => (resolved = v));
    const input = root.querySelector<HTMLInputElement>("#recovery-input")!;
    const button = root.querySelector<HTMLButtonElement>("#recovery-continue")!;
    input.value = wrong.code; button.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>(".web-auth-error")!.hidden).toBe(false));
    expect(root.querySelector(".web-auth-error")!.textContent).toBe("Ten kod nie odszyfrowuje Twoich danych.");
    expect(resolved).toBeUndefined();
    expect(root.querySelector("#recovery-new")).toBeNull();
    input.value = right.code; button.click();
    await vi.waitFor(() => expect(resolved).toBe(right.code));
  });
});
