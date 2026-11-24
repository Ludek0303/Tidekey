// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MockBridge } from "./bridge";
import { BrowserBridge, decryptSnapshot, encryptSnapshot, syncCanon } from "./browserauth";
import { importVaultKey, randomVaultKey } from "./vaults";

const VAULT = "v-0123456789abcdef0123456789abcdef";
const OWNER = "owner-user";
const member = (userId: string, email: string) => {
  const b = new MockBridge([], false);
  b.setBrowserAccount(userId, email, { id: VAULT, name: "Zespół", kind: "organizacja", ownerUserId: OWNER });
  return b;
};

afterEach(() => vi.useRealTimers());

describe("what is compared with the server", () => {
  it("two members' copies of the same vault compare equal; a real change does not", async () => {
    const anna = member(OWNER, "anna@example.test"), bartek = member("bartek-user", "bartek@example.test");
    bartek.mergeBrowserSnapshot(anna.exportBrowserSnapshot(OWNER, VAULT));
    const of = (b: MockBridge) => syncCanon(b.exportBrowserSnapshot(OWNER, VAULT).state);
    expect(of(anna)).toBe(of(bartek)); // only `me` and `organization.me` differ: no reason to send it back
    await bartek.call("create_note", { path: "nowa.md" });
    expect(of(bartek)).not.toBe(of(anna));
  });
});

describe("snapshot compression", () => {
  it("is gzipped inside the ciphertext, and an old uncompressed copy still opens", async () => {
    const key = await importVaultKey(randomVaultKey());
    const b = member(OWNER, "anna@example.test");
    await b.call("create_note", { path: "dluga.md" });
    const snapshot = b.exportBrowserSnapshot(OWNER, VAULT);
    const envelope = await encryptSnapshot(snapshot, key);
    expect((await decryptSnapshot(envelope, OWNER, VAULT, key)).state.notes.map((n) => n.path)).toEqual(["dluga.md"]);

    // a copy written before compression: AES-GCM over the plain JSON, same AAD
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`notes-encrypted-v1\0${OWNER}\0${VAULT}`);
    const plain = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(snapshot)));
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const legacy = { schema: "notes-encrypted-v1" as const, nonce: b64(nonce), ciphertext: b64(new Uint8Array(plain)) };
    expect((await decryptSnapshot(legacy, OWNER, VAULT, key)).state.notes.map((n) => n.path)).toEqual(["dluga.md"]);
    expect(envelope.ciphertext.length).toBeLessThan(legacy.ciphertext.length);
  });
});

describe("live deltas", () => {
  // a BrowserBridge without IndexedDB: only what the relay path touches
  const bridgeOf = async (userId: string, role = "editor") => {
    const b = Object.create(BrowserBridge.prototype) as Record<string, any>;
    Object.assign(b, member(userId, `${userId}@example.test`));
    Object.assign(b, { info: { id: VAULT, ownerUserId: OWNER }, key: await importVaultKey(randomVaultKey()), epoch: 1, keyring: new Map(),
      connected: true, currentRole: role, protectedEntries: new Map(), protectedMarks: new Map(), protectedChecks: new Map(), projectKeys: new Map(), sealedCanon: new Map(), withheld: new Map(), relayQueue: new Map(), relaySent: Promise.resolve(), sent: [] as string[], persistTimer: undefined, schedulePersist: () => undefined });
    b.socket = { readyState: WebSocket.OPEN, send: (text: string) => (b.sent as string[]).push(text) };
    return b;
  };

  it("an edit goes out as a small delta and lands in the same note on the other side", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const anna = await bridgeOf(OWNER, "owner"), bartek = await bridgeOf("bartek-user");
    bartek.key = anna.key;
    const id = await anna.call("create_note", { path: "wspolna.md" }) as string;
    bartek.mergeBrowserSnapshot(anna.exportBrowserSnapshot(OWNER, VAULT));
    const edit = new Y.Doc(); Y.applyUpdate(edit, Y.encodeStateAsUpdate(anna.notes.get(id).doc));
    let update!: Uint8Array; edit.on("update", (u: Uint8Array) => (update = u)); edit.getText("content").insert(0, "Cześć");
    await anna.call("apply_update", { id, update });
    await anna.relaySent; // no timer to advance: the delta is sealed in a microtask
    const frame = JSON.parse((anna.sent as string[])[0]);
    expect(frame.type).toBe("relay");
    expect(frame.envelope.ciphertext.length).toBeLessThan(400); // the edit, not the vault
    const seen: unknown[] = []; bartek.on("note_update", (p: unknown) => seen.push(p));
    await bartek.takeRelay(frame.envelope);
    expect(bartek.notes.get(id).doc.getText("content").toString()).toBe("Cześć");
    expect(seen).toHaveLength(1);
  });

  it("a viewer sends none, and a protected project's notes are never relayed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const viewer = await bridgeOf("viewer-user", "viewer");
    viewer.queueRelay("x", new Uint8Array([1]));
    expect(viewer.relayQueue.size).toBe(0);
    const anna = await bridgeOf(OWNER, "owner");
    const id = await anna.call("create_note", { path: "Projekty/Tajny/Tajny.md" }) as string;
    anna.protectedEntries.set("Projekty/Tajny", {});
    anna.queueRelay(id, new Uint8Array([1]));
    expect(anna.relayQueue.size).toBe(0);
  });

  const edits = (b: Record<string, any>, id: string, texts: string[]) => {
    const doc = new Y.Doc(); Y.applyUpdate(doc, Y.encodeStateAsUpdate(b.notes.get(id).doc));
    return texts.map((t) => { const before = Y.encodeStateVector(doc); doc.getText("content").insert(doc.getText("content").length, t); return Y.encodeStateAsUpdate(doc, before); });
  };
  const textsOf = async (b: Record<string, any>, from: Record<string, any>, id: string) => {
    const out: string[] = [];
    for (const raw of from.sent as string[]) { await b.takeRelay(JSON.parse(raw).envelope); out.push(b.notes.get(id).doc.getText("content").toString()); }
    return out;
  };

  it("goes out without any timer, the edits of one task share one frame, and frames keep their order", async () => {
    vi.useFakeTimers(); // every timer frozen: a send that waited for one would never happen
    const anna = await bridgeOf(OWNER, "owner"), bartek = await bridgeOf("bartek-user");
    bartek.key = anna.key;
    const id = await anna.call("create_note", { path: "wspolna.md" }) as string;
    bartek.mergeBrowserSnapshot(anna.exportBrowserSnapshot(OWNER, VAULT));
    const [a, b, c, d] = edits(anna, id, ["a", "b", "c", "d"]);
    const one = [anna.call("apply_update", { id, update: a }), anna.call("apply_update", { id, update: b })]; // one dispatch
    await Promise.all(one);
    await anna.call("apply_update", { id, update: c });
    await anna.call("apply_update", { id, update: d });
    await anna.relaySent;
    expect(anna.sent).toHaveLength(3);
    expect(await textsOf(bartek, anna, id)).toEqual(["ab", "abc", "abcd"]);
  });

  it("an edit the bridge refuses is never relayed", async () => {
    const owner = await bridgeOf(OWNER, "owner"), viewer = await bridgeOf("viewer-user", "viewer");
    const id = await owner.call("create_note", { path: "a.md" }) as string;
    viewer.mergeBrowserSnapshot(owner.exportBrowserSnapshot(OWNER, VAULT));
    await viewer.call("apply_update", { id, update: edits(viewer, id, ["x"])[0] });
    const editor = await bridgeOf(OWNER, "owner");
    const nid = await editor.call("create_note", { path: "b.md" }) as string;
    editor.editRefused = () => true; // a protected note this member may read but not edit
    await editor.call("apply_update", { id: nid, update: edits(editor, nid, ["x"])[0] });
    await Promise.all([viewer.relaySent, editor.relaySent]);
    expect(viewer.sent).toHaveLength(0);
    expect(editor.sent).toHaveLength(0);
    expect(editor.notes.get(nid).doc.getText("content").toString()).toBe("");
  });

  it("a delta under another vault's key is ignored, not applied", async () => {
    const anna = await bridgeOf(OWNER, "owner"), other = await bridgeOf("bartek-user");
    const id = await anna.call("create_note", { path: "a.md" }) as string;
    other.mergeBrowserSnapshot(anna.exportBrowserSnapshot(OWNER, VAULT));
    anna.socket.readyState = WebSocket.OPEN;
    anna.relayQueue.set(id, [Y.encodeStateAsUpdate(new Y.Doc())]);
    await anna.flushRelay();
    await expect(other.takeRelay(JSON.parse(anna.sent[0]).envelope)).resolves.toBeUndefined(); // other.key differs
  });
});

describe("when a save is sent", () => {
  // schedulePersist only touches these fields, so it runs on a stand-in without IndexedDB or a socket
  const standIn = () => ({ persist: vi.fn(() => Promise.resolve()), setStatus: vi.fn() } as Record<string, unknown>);
  const schedule = (b: Record<string, unknown>) => (BrowserBridge.prototype as unknown as { schedulePersist(this: unknown): void }).schedulePersist.call(b);

  it("a structural change goes 200 ms after it, typing waits for a 2 s pause", () => {
    vi.useFakeTimers();
    const b = standIn();
    (BrowserBridge.prototype as unknown as { schedulePersist(this: unknown, s: string): void }).schedulePersist.call(b, "slow");
    vi.advanceTimersByTime(1999); expect(b.persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(b.persist).toHaveBeenCalledTimes(1);
  });

  it("goes 200 ms after a structural change", () => {
    vi.useFakeTimers();
    const b = standIn();
    schedule(b);
    vi.advanceTimersByTime(199); expect(b.persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(b.persist).toHaveBeenCalledTimes(1);
  });

  it("goes at least once a second while typing never pauses", () => {
    vi.useFakeTimers();
    const b = standIn();
    for (let t = 0; t < 1000; t += 100) { schedule(b); vi.advanceTimersByTime(100); }
    expect(b.persist).toHaveBeenCalledTimes(1);
  });
});
