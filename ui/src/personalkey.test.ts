// @vitest-environment jsdom
// docs/MCP.md §3.7: Moje notatki get a random key of their own, wrapped with the personal key, so a chat can later be
// given that key without ever getting the personal key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge, codeOpens, encryptSnapshot, newRecoveryKey, type Envelope } from "./browserauth";
import { importVaultKey, personalAccess, randomVaultKey, unwrapPersonalVaultKey, wrapPersonalVaultKey } from "./vaults";

const USER = "anna-user";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const request = (run: (req: { result?: unknown; onsuccess?: () => void }) => void) => {
    const req: { result?: unknown; onsuccess?: () => void } = {};
    queueMicrotask(() => { run(req); req.onsuccess?.(); });
    return req;
  };
  return {
    rows,
    transaction: () => ({
      objectStore: () => ({
        get: () => request((req) => { req.result = undefined; }),
        put: (item: Record<string, unknown>) => request(() => rows.set(JSON.stringify([item.userId, item.vaultId, item.keyEpoch]), item)),
        getAll: () => request((req) => { req.result = [...rows.values()]; }),
      }),
    }),
  } as unknown as IDBDatabase & { rows: Map<string, Record<string, unknown>> };
}
type Call = { method: string; url: string; body?: any };
function serve(handle: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handle(call);
  }));
  return calls;
}
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

async function personalBridge(personal?: CryptoKey): Promise<any> {
  const key = personal ?? (await newRecoveryKey()).key;
  const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => any;
  const bridge = new Ctor({ id: USER, email: "anna@example.test", name: "Anna" }, key, fakeDb(), key, personalAccess(USER));
  bridge.persist = vi.fn(async () => undefined);
  bridge.tidyFiles = vi.fn(async () => undefined);
  bridge.remoteSeen = true; // the server snapshot is merged (the resend waits for it)
  bridge.personalProven = true; // the personal key opened this vault's data here (a key of its own is made only then)
  return bridge;
}
const snapshotOf = (bridge: any) => bridge.exportBrowserSnapshot(USER, `browser-${USER}`);

describe("Moje notatki: a key of their own", () => {
  it("the first open makes epoch 2, wraps it with the personal key, and sends the vault again under it", async () => {
    const stored: { keyEpoch: number; wrappedKey: unknown }[] = [];
    const calls = serve((c) => {
      if (c.method === "PUT") { stored.push(c.body); return json({ keyEpoch: c.body.keyEpoch }); }
      return json({ keys: stored });
    });
    const bridge = await personalBridge();
    const old = await encryptSnapshot(snapshotOf(bridge), bridge.personalKey); // a copy from before: no epoch
    await bridge.catchUp();

    expect(calls.filter((c) => c.method === "PUT").map((c) => [c.url, c.body.keyEpoch])).toEqual([["/api/me/personal-key", 2]]);
    const raw = await unwrapPersonalVaultKey(stored[0].wrappedKey as never, bridge.personalKey, USER, 2);
    expect(raw.length).toBe(32);
    expect(bridge.epoch).toBe(2);
    expect(bridge.wireEpoch()).toBe(2);
    expect(bridge.persist).toHaveBeenCalledTimes(1);
    expect(bridge.serverState).toBeUndefined();

    const fresh = await encryptSnapshot(snapshotOf(bridge), await importVaultKey(raw), 2);
    await expect(bridge.decryptEnvelope(fresh)).resolves.toBeTruthy();
    await expect(bridge.decryptEnvelope(old)).resolves.toBeTruthy(); // older copies stay readable
    // the personal key does not open the new copies: a chat given the vault key never needs it
    const { decryptSnapshot } = await import("./browserauth");
    await expect(decryptSnapshot(fresh, USER, `browser-${USER}`, bridge.personalKey)).rejects.toThrow();
    // the current key is kept on this device (wrapped with the personal key), for opening offline
    expect([...bridge.db.rows.values()].map((r: any) => r.keyEpoch)).toEqual([2]);
  });

  it("another device migrated first (409): its key is taken, nothing else is written", async () => {
    const personal = (await newRecoveryKey()).key;
    const theirs = randomVaultKey();
    const row = { keyEpoch: 2, wrappedKey: await wrapPersonalVaultKey(theirs, personal, USER, 2) };
    let first = true;
    const calls = serve((c) => {
      if (c.method === "PUT") return json({ message: "Ten klucz Moich notatek został już zmieniony na innym urządzeniu." }, 409);
      if (first) { first = false; return json({ keys: [] }); }
      return json({ keys: [row] });
    });
    const bridge = await personalBridge(personal);
    await bridge.catchUp();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(bridge.epoch).toBe(2);
    expect([...bridge.rawKey]).toEqual([...theirs]);
    expect(bridge.persist).toHaveBeenCalledTimes(1);
  });

  it("a second device takes the stored key without writing one", async () => {
    const personal = (await newRecoveryKey()).key;
    const raw = randomVaultKey();
    const wrapped = await wrapPersonalVaultKey(raw, personal, USER, 2);
    const calls2 = serve((c) => (c.method === "GET" ? json({ keys: [{ keyEpoch: 2, wrappedKey: wrapped }] }) : json({}, 500)));
    const bridge = await personalBridge(personal);
    await bridge.catchUp();
    expect(calls2.every((c) => c.method === "GET")).toBe(true);
    expect(bridge.epoch).toBe(2);
    expect([...bridge.rawKey]).toEqual([...raw]);
  });

  it("offline: nothing changes and nothing is saved; a failed decrypt never saves either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const bridge = await personalBridge();
    await expect(bridge.catchUp()).rejects.toThrow();
    expect(bridge.epoch).toBe(1);
    expect(bridge.persist).not.toHaveBeenCalled();
    const foreign = await encryptSnapshot(snapshotOf(bridge), await importVaultKey(randomVaultKey()), 2);
    await expect(bridge.decryptEnvelope(foreign)).rejects.toThrow();
    expect(bridge.persist).not.toHaveBeenCalled();
  });

  // review of stage 1, finding 1: a key that arrives while the server's snapshot under it is still unread must not make
  // this device send its own (empty) state over the server's
  it("a new device: the vault is sent again only after the server's snapshot under the new key is merged", async () => {
    const personal = (await newRecoveryKey()).key;
    const raw = randomVaultKey();
    const wrapped = await wrapPersonalVaultKey(raw, personal, USER, 2);
    serve(() => json({ keys: [{ keyEpoch: 2, wrappedKey: wrapped }] }));
    const other = await personalBridge(personal);
    const id = await other.call("create_note", { path: "Plan.md" });
    const server = await encryptSnapshot(snapshotOf(other), await importVaultKey(raw), 2);
    void id;

    const bridge = await personalBridge(personal);
    bridge.remoteSeen = false;
    const seen: number[] = [];
    bridge.persist = vi.fn(async () => { seen.push((await bridge.call("list_tree")).notes.length); });
    await Promise.all([bridge.catchUp(), bridge.handleMessage({ type: "snapshot", revision: 7, envelope: server })]);
    expect(bridge.epoch).toBe(2);
    expect(bridge.revision).toBe(7);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 1)).toBe(true); // every save holds the server's note
  });

  it("a snapshot that cannot be read leaves the revision where it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ keys: [] })));
    const bridge = await personalBridge();
    bridge.revision = 3;
    const foreign = await encryptSnapshot(snapshotOf(bridge), await importVaultKey(randomVaultKey()), 2);
    await expect(bridge.handleMessage({ type: "snapshot", revision: 9, envelope: foreign })).rejects.toThrow();
    expect(bridge.revision).toBe(3);
  });

  // second review, finding B: a personal key that never opened this vault's data (an unchecked code) makes no key
  it("a personal key not proven on this vault's data makes no key of its own", async () => {
    const calls = serve(() => json({ keys: [] }));
    const bridge = await personalBridge();
    bridge.personalProven = false;
    await bridge.catchUp();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(bridge.epoch).toBe(1);
    // once the server's snapshot opens with it, the move runs
    const proof = await encryptSnapshot(snapshotOf(bridge), bridge.personalKey);
    await bridge.decryptEnvelope(proof);
    expect(bridge.personalProven).toBe(true);
  });

  // a new account: the server has no snapshot yet, so the first session already moves Moje notatki to a key of their own
  it("a server with no snapshot yet counts as proven: the first session migrates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ keys: [] })));
    const bridge = await personalBridge();
    bridge.personalProven = false;
    bridge.remoteSeen = false;
    bridge.catchUpSoon = vi.fn();
    await bridge.handleMessage({ type: "snapshot", revision: 0, envelope: null });
    expect(bridge.personalProven).toBe(true);
    expect(bridge.catchUpSoon).toHaveBeenCalled();
  });

  it("the recovery code is checked against the wrapped key once the vault is under a key of its own", async () => {
    const { key, code } = await newRecoveryKey();
    const other = await newRecoveryKey();
    const wrappedKey = { keyEpoch: 2, key: await wrapPersonalVaultKey(randomVaultKey(), key, USER, 2), bound: true };
    const envelope = { schema: "notes-encrypted-v1", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", keyEpoch: 2 } as Envelope;
    const verifier = { envelope, vaultId: `browser-${USER}`, checked: true, wrappedKey };
    expect(await codeOpens(code, verifier, USER)).toBe(true);
    expect(await codeOpens(other.code, verifier, USER)).toBe(false);
    // finding 2: a key bound to another epoch (or a shared vault's key) does not pass for this one
    expect(await codeOpens(code, { ...verifier, wrappedKey: { ...wrappedKey, keyEpoch: 3 } }, USER)).toBe(false);
    // finding 5: a copy under a key of its own with no copy of that key at hand refuses every code
    expect(await codeOpens(code, { envelope, vaultId: `browser-${USER}`, checked: false, unverifiable: true }, USER)).toBe(false);
    // second review, finding B: nothing to check against and the server out of reach: every code is refused
    expect(await codeOpens(code, { vaultId: `browser-${USER}`, checked: false }, USER)).toBe(false);
    expect(await codeOpens(code, { vaultId: `browser-${USER}`, checked: true }, USER)).toBe(true);
    // finding 7: a key on the server with no snapshot yet is still something the code must open
    expect(await codeOpens(other.code, { vaultId: `browser-${USER}`, checked: true, wrappedKey }, USER)).toBe(false);
    expect(await codeOpens(code, { vaultId: `browser-${USER}`, checked: true, wrappedKey }, USER)).toBe(true);
  });
});
