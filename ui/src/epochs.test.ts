// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge, encryptSnapshot, newRecoveryKey, type Envelope } from "./browserauth";
import { MockBridge } from "./bridge";
import { sealTo, openSealed, type BoxIdentity } from "./sealed";
import { importVaultKey, randomVaultKey, unwrapVaultKey, type Role, type VaultAccess, type VaultDetail, type RemoteMember } from "./vaults";

const OWNER = "owner-user";
const MEMBER = "member-user";
const VAULT = `v-${"b".repeat(32)}`;
const vaultInfo = { id: VAULT, name: "Zespół", kind: "organizacja" as const, ownerUserId: OWNER };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

// Box keys for the test users: the public JWK goes to the server, the private half stays with the user.
async function boxFor(userId: string): Promise<BoxIdentity & { userId: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { userId, privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey };
}

// An in-memory stand-in for the local IndexedDB: only what the key store uses (get, put, getAll with a key range).
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
// Routes every fetch: `handle` answers with a Response for each call; the calls are recorded.
function serve(handle: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handle(call);
  }));
  return calls;
}
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const detailFor = (role: Role, members: RemoteMember[], over: Partial<VaultDetail> & { keyEpoch?: number } = {}): VaultDetail => ({
  vault: { ...vaultInfo, keyEpoch: over.keyEpoch ?? 1 },
  role, members, wrappedKey: { schema: "notes-key-v1", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" },
  ...over,
});

type Internals = any;
// A bridge over a fake local store, with the persist step stubbed (its storage is covered elsewhere).
async function bridgeAt(userId: string, role: Role, rawKey: Uint8Array, epoch: number, box?: BoxIdentity): Promise<Internals> {
  const personal = (await newRecoveryKey()).key;
  const access: VaultAccess = { vault: { ...vaultInfo, keyEpoch: epoch }, role, members: [], rawKey, keyEpoch: epoch };
  const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => Internals;
  const bridge = new Ctor({ id: userId, email: `${userId}@example.test`, name: userId }, personal, fakeDb(), await importVaultKey(rawKey), access);
  bridge.persist = vi.fn(async () => undefined);
  bridge.box = box;
  bridge.personalKeyForTest = personal;
  return bridge;
}

describe("rotation (admin side)", () => {
  it("seals a new key for exactly the current members and posts the next epoch", async () => {
    const owner = await boxFor(OWNER), member = await boxFor(MEMBER), viewer = await boxFor("viewer-user");
    const members: RemoteMember[] = [
      { userId: OWNER, email: "o@example.test", name: "Owner", role: "owner", boxKey: owner.publicJwk },
      { userId: MEMBER, email: "m@example.test", name: "Member", role: "editor", boxKey: member.publicJwk },
      { userId: "viewer-user", email: "v@example.test", name: "Viewer", role: "viewer", boxKey: viewer.publicJwk },
    ];
    const calls = serve((call) => {
      if (call.method === "GET") return json(detailFor("owner", members, { needsRotation: true, keyEpoch: 1 }));
      return json({ vault: vaultInfo });
    });
    const oldRaw = randomVaultKey();
    const bridge = await bridgeAt(OWNER, "owner", oldRaw, 1, owner);
    await bridge.catchUp();

    const rotate = calls.find((c) => c.url.endsWith("/rotate"))!;
    expect(rotate.body.keyEpoch).toBe(2);
    expect(rotate.body.keys.map((k: { userId: string }) => k.userId).sort()).toEqual([MEMBER, OWNER, "viewer-user"].sort());
    const sealedFor = (userId: string) => rotate.body.keys.find((k: { userId: string }) => k.userId === userId).sealedKey;
    const newRaw = await openSealed(sealedFor(MEMBER), member.privateKey);
    expect(newRaw).toHaveLength(32);
    expect(await openSealed(sealedFor("viewer-user"), viewer.privateKey)).toEqual(newRaw);
    // the admin's own copy moves to the new key too, and the old one stays readable
    const myKey = calls.find((c) => c.method === "PUT" && c.url.endsWith("/my-key"))!;
    expect(myKey.body.keyEpoch).toBe(2);
    expect(await unwrapVaultKey(myKey.body.wrappedKey, bridge.personalKeyForTest)).toEqual(newRaw);
    expect(bridge.vaultEpoch).toBe(2);
    expect(bridge.keyring.get(1).raw).toEqual(oldRaw);
    expect(bridge.persist).toHaveBeenCalled();
  });

  it("refuses when a member has no box key: lists them in the message and posts nothing", async () => {
    const owner = await boxFor(OWNER);
    const members: RemoteMember[] = [
      { userId: OWNER, email: "o@example.test", name: "Owner", role: "owner", boxKey: owner.publicJwk },
      { userId: MEMBER, email: "nowy@example.test", name: "Nowy", role: "editor", boxKey: null },
    ];
    const calls = serve(() => json(detailFor("owner", members, { needsRotation: true })));
    const bridge = await bridgeAt(OWNER, "owner", randomVaultKey(), 1, owner);
    await bridge.catchUp();
    expect(calls.some((c) => c.url.endsWith("/rotate"))).toBe(false);
    expect(bridge.vaultEpoch).toBe(1);
    expect(document.querySelector(".toast")?.textContent).toBe("Nie można zmienić klucza: nowy@example.test nie mają jeszcze klucza szyfrowania. Poproś ich o zalogowanie.");
  });

  it("an editor never rotates, even when the vault needs it", async () => {
    const member = await boxFor(MEMBER);
    const calls = serve(() => json(detailFor("editor", [{ userId: MEMBER, email: "m@example.test", name: "Member", role: "editor", boxKey: member.publicJwk }], { needsRotation: true })));
    const bridge = await bridgeAt(MEMBER, "editor", randomVaultKey(), 1, member);
    await bridge.catchUp();
    expect(calls.some((c) => c.url.endsWith("/rotate"))).toBe(false);
  });
});

describe("rekey (member side)", () => {
  it("unseals the pending key, PUTs my-key and decrypts a snapshot under the new epoch", async () => {
    const member = await boxFor(MEMBER);
    const oldRaw = randomVaultKey(), newRaw = randomVaultKey();
    const sealed = await sealTo(member.publicJwk, newRaw);
    // a snapshot written by someone under epoch 2
    const writer = new MockBridge([], false);
    writer.setBrowserAccount(OWNER, "o@example.test", vaultInfo);
    await writer.call("create_note", { path: "wspolna.md" });
    const envelope: Envelope = await encryptSnapshot(writer.exportBrowserSnapshot(OWNER, VAULT), await importVaultKey(newRaw), 2);

    const calls = serve((call) => {
      if (call.method === "GET") return json(detailFor("editor", [], { keyEpoch: 2, wrappedKeyEpoch: 1, pendingKey: { keyEpoch: 2, sealedKey: sealed } }));
      return json({ vault: vaultInfo });
    });
    const bridge = await bridgeAt(MEMBER, "editor", oldRaw, 1, member);
    await bridge.handleMessage({ type: "snapshot", revision: 5, envelope });

    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/my-key"))!;
    expect(put.body.keyEpoch).toBe(2);
    expect(await unwrapVaultKey(put.body.wrappedKey, bridge.personalKeyForTest)).toEqual(newRaw);
    expect(bridge.vaultEpoch).toBe(2);
    expect(bridge.exportBrowserSnapshot(OWNER, VAULT).state.notes.map((n: { path: string }) => n.path)).toEqual(["wspolna.md"]);
  });

  it("an old-epoch local copy stays readable after the switch", async () => {
    const member = await boxFor(MEMBER);
    const oldRaw = randomVaultKey(), newRaw = randomVaultKey();
    const writer = new MockBridge([], false);
    writer.setBrowserAccount(OWNER, "o@example.test", vaultInfo);
    const localEpoch1 = await encryptSnapshot(writer.exportBrowserSnapshot(OWNER, VAULT), await importVaultKey(oldRaw), 1);
    serve(async (call) => call.method === "GET"
      ? json(detailFor("editor", [], { keyEpoch: 2, wrappedKeyEpoch: 1, pendingKey: { keyEpoch: 2, sealedKey: await sealTo(member.publicJwk, newRaw) } }))
      : json({ vault: vaultInfo }));
    const bridge = await bridgeAt(MEMBER, "editor", oldRaw, 1, member);
    expect(await bridge.catchUp()).toBeUndefined();
    const snapshot = await bridge.decryptEnvelope(localEpoch1);
    expect(snapshot.vault.id).toBe(VAULT);
    // and the old key was kept on disk, wrapped with the personal key
    const stored = [...bridge.db.rows.values()].find((r) => r.keyEpoch === 1)!;
    expect(await unwrapVaultKey(stored.wrapped as Parameters<typeof unwrapVaultKey>[0], bridge.personalKeyForTest)).toEqual(oldRaw);
  });

  it("with no pending key and an unknown epoch, decryption is an error on screen, not a loop", async () => {
    const member = await boxFor(MEMBER);
    const calls = serve(() => json(detailFor("editor", [], { keyEpoch: 3 })));
    const bridge = await bridgeAt(MEMBER, "editor", randomVaultKey(), 1, member);
    const writer = new MockBridge([], false);
    writer.setBrowserAccount(OWNER, "o@example.test", vaultInfo);
    const envelope = await encryptSnapshot(writer.exportBrowserSnapshot(OWNER, VAULT), await importVaultKey(randomVaultKey()), 3);
    await expect(bridge.decryptEnvelope(envelope)).rejects.toThrow("Nie udało się odszyfrować");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });
});

describe("stale-key", () => {
  it("runs the rekey path once; a second refusal is an error and does not fetch again", async () => {
    const member = await boxFor(MEMBER);
    const newRaw = randomVaultKey();
    const calls = serve(async (call) => call.method === "GET"
      ? json(detailFor("editor", [], { keyEpoch: 2, wrappedKeyEpoch: 1, pendingKey: { keyEpoch: 2, sealedKey: await sealTo(member.publicJwk, newRaw) } }))
      : json({ vault: vaultInfo }));
    const bridge = await bridgeAt(MEMBER, "editor", randomVaultKey(), 1, member);
    const states: string[] = [];
    bridge.onSyncStatus((s: string) => states.push(s));

    await bridge.handleMessage({ type: "error", code: "stale-key", message: "Stary klucz." });
    expect(bridge.vaultEpoch).toBe(2);
    expect(bridge.persist).toHaveBeenCalledWith(true);

    await bridge.handleMessage({ type: "error", code: "stale-key", message: "Stary klucz." });
    expect(states.at(-1)).toBe("error");
    expect(calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/vaults/"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(bridge.persist).toHaveBeenCalledTimes(1);
  });
});
