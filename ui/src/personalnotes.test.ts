// @vitest-environment jsdom
// Moje notatki gated by the server admin's consent, and assignments completed by an owner's browser (docs/PANEL-ADMINA.md).
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge, NO_ACCESS_TEXT, codeOpens, findAccountVerifier, newRecoveryKey, noAccessScreen, type BrowserUser } from "./browserauth";
import { asBoxPublicKey, openSealed, sealTo, type BoxIdentity, type SealedBox } from "./sealed";
import {
  PERSONAL_WAITING_TEXT, bytesToBase64, openAccess, unwrapVaultKey, fetchPersonalState, homeVaultId, openVaultMenu, ownVaults, personalAllowed, personalNotesControl,
  randomVaultKey, vaultUrl, wrapBytes, type Role, type VaultAccess,
} from "./vaults";

const VAULT = `v-${"b".repeat(32)}`;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

type FetchCall = [string, RequestInit | undefined];
const calls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls as FetchCall[];

describe("personal notes state", () => {
  it("allows Moje notatki only when allowed, or when the server does not say", () => {
    expect(personalAllowed({})).toBe(true);
    expect(personalAllowed({ personal: "allowed" })).toBe(true);
    expect(personalAllowed({ personal: "off" })).toBe(false);
    expect(personalAllowed({ personal: "requested" })).toBe(false);
    expect(ownVaults({ id: "u1" }).map((v) => v.id)).toEqual(["browser-u1"]);
    expect(ownVaults({ id: "u1", personal: "off" })).toEqual([]);
    expect(homeVaultId({ id: "u1", personal: "off" })).toBe("");
    expect(vaultUrl("")).toBe(location.pathname);
  });

  it("reads the state from the user in /api/auth/me", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ authenticated: true, user: { id: "u1", personal: "off" } })));
    expect(await fetchPersonalState()).toBe("off");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ authenticated: true, user: { id: "u1" } })));
    expect(await fetchPersonalState()).toBe("allowed");
  });

  it("asks for personal notes once, then shows the wait", async () => {
    const fetchMock = vi.fn(async () => Response.json({ personal: "requested" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(personalNotesControl("allowed")).toBeNull();
    expect(personalNotesControl("requested")?.textContent).toBe(PERSONAL_WAITING_TEXT);
    const onRequested = vi.fn();
    const ask = personalNotesControl("off", onRequested) as HTMLButtonElement;
    document.body.append(ask);
    expect(ask.textContent).toBe("Poproś o własne notatki");
    ask.click();
    await vi.waitFor(() => expect(document.body.textContent).toBe(PERSONAL_WAITING_TEXT));
    expect(calls(fetchMock)).toEqual([["/api/me/personal-request", expect.objectContaining({ method: "POST" })]]);
    expect(onRequested).toHaveBeenCalledWith("requested");
  });

  it("leaves Moje notatki out of the vault switcher without the consent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ vaults: [{ id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u2", role: "editor" }, { id: "org-2", name: "Sekcja", kind: "organizacja", ownerUserId: "u2", role: "editor" }] })));
    const bridge = { vault: { id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u2" }, user: { id: "u1", personal: "off" } } as unknown as BrowserBridge;
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await openVaultMenu(anchor, bridge);
    const labels = [...document.querySelectorAll("[role^=menuitem]")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("Moje notatki"))).toBe(false);
    expect(labels.some((l) => l.includes("Sekcja"))).toBe(true);
  });

  it("shows the empty state with the request button", () => {
    const root = document.createElement("div");
    document.body.append(root);
    void noAccessScreen(root, { id: "u1", email: "a@example.test", name: "Ola", personal: "off" });
    expect(root.textContent).toContain(NO_ACCESS_TEXT);
    expect([...root.querySelectorAll("button")].map((b) => b.textContent)).toContain("Poproś o własne notatki");
  });
});

describe("recovery code without Moje notatki", () => {
  it("is checked against the account's box key, never against the personal vault", async () => {
    const right = await newRecoveryKey();
    const wrong = await newRecoveryKey();
    const wrappedPrivate = await wrapBytes(crypto.getRandomValues(new Uint8Array(138)), right.key);
    const fetchMock = vi.fn(async () => Response.json({ publicJwk: {}, wrappedPrivate }));
    vi.stubGlobal("fetch", fetchMock);
    const verifier = await findAccountVerifier("u1");
    expect(calls(fetchMock).map(([url]) => url)).toEqual(["/api/me/box-key"]);
    expect(await codeOpens(right.code, verifier, "u1")).toBe(true);
    expect(await codeOpens(wrong.code, verifier, "u1")).toBe(false);
  });

  it("accepts any code when the account has no box key yet, and none when the server cannot be asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "brak" }, { status: 404 })));
    const none = await findAccountVerifier("u1");
    expect(none).toEqual({ vaultId: "browser-u1", checked: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const offline = await findAccountVerifier("u1");
    expect(await codeOpens((await newRecoveryKey()).code, offline, "u1")).toBe(false);
  });
});

describe("box public key check", () => {
  it("accepts a P-256 public JWK and refuses private or malformed keys", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    expect(asBoxPublicKey(pub)).toEqual({ kty: "EC", crv: "P-256", x: pub.x, y: pub.y });
    expect(asBoxPublicKey(JSON.stringify(pub))).toBeNull();
    expect(asBoxPublicKey(priv)).toBeNull();
    expect(asBoxPublicKey({ ...pub, crv: "P-384" })).toBeNull();
    expect(asBoxPublicKey({ ...pub, x: "short" })).toBeNull();
    expect(asBoxPublicKey("not json")).toBeNull();
    expect(asBoxPublicKey(null)).toBeNull();
  });
});

describe("assignments", () => {
  type Internals = any; // private members are driven directly, as in vaults.test.ts
  function bridgeFor(role: Role, rawKey: Uint8Array): Internals {
    const access: VaultAccess = { vault: { id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u1" }, role, members: [], rawKey, keyEpoch: 3 };
    const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => Internals;
    const user: BrowserUser = { id: "u1", email: "a@example.test", name: "Ola" };
    const bridge = new Ctor(user, {} as CryptoKey, {} as IDBDatabase, {} as CryptoKey, access);
    bridge.syncProfileCard = async () => undefined;
    return bridge;
  }

  it("seals the vault key to each assigned person's box key and completes them; bad keys are skipped", async () => {
    const raw = randomVaultKey();
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const boxKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/vaults/${VAULT}/assignments`) return Response.json([
        { userId: "u2", email: "b@example.test", name: "Ba", role: "editor", boxKey },
        { userId: "u3", email: "c@example.test", name: "Ce", role: "viewer", boxKey: { kty: "EC", crv: "P-256", x: "bad", y: "bad" } },
      ]);
      if (init?.method === "POST") return Response.json({ ok: true });
      return Response.json({ vault: { id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u1", keyEpoch: 3 }, role: "owner", wrappedKey: {}, members: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await bridgeFor("owner", raw).completeAssignments();
    const posts = calls(fetchMock).filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual([`/api/vaults/${VAULT}/assignments/u2/complete`]);
    const body = JSON.parse(String(posts[0][1]!.body)) as { sealedKey: SealedBox; keyEpoch: number };
    expect(Object.keys(body).sort()).toEqual(["keyEpoch", "sealedKey"]);
    expect(body.keyEpoch).toBe(3);
    expect(await openSealed(body.sealedKey, pair.privateKey)).toEqual(raw);
    // the vault key itself is never sent anywhere
    for (const [, init] of calls(fetchMock)) expect(String(init?.body ?? "")).not.toContain(bytesToBase64(raw));
    // the member list is read again, so the new member shows up
    expect(calls(fetchMock).some(([url, init]) => url === `/api/vaults/${VAULT}` && !init?.method?.match(/POST/))).toBe(true);
  });

  it("runs the timer only for owners and admins, following role changes", () => {
    const editor = bridgeFor("editor", randomVaultKey());
    editor.syncAssignTimer();
    expect(editor.assignTimer).toBeUndefined();
    editor.setRole("admin");
    expect(editor.assignTimer).toBeDefined();
    editor.setRole("viewer");
    expect(editor.assignTimer).toBeUndefined();
  });

  it("does nothing for editors, and stays quiet when the server refuses", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "nie" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await bridgeFor("editor", randomVaultKey()).completeAssignments();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(bridgeFor("admin", randomVaultKey()).completeAssignments()).resolves.toBeUndefined();
    expect(calls(fetchMock).map(([url]) => url)).toEqual([`/api/vaults/${VAULT}/assignments`]);
  });
});

describe("assigned member: the first open", () => {
  it("opens the pending key with the box key, stores its own copy, and never unwraps the placeholder", async () => {
    const owner = { publicJwk: {} as JsonWebKey, ...(await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) };
    const box: BoxIdentity = { userId: "u2", privateKey: owner.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", owner.publicKey) };
    const raw = randomVaultKey();
    const personal = (await newRecoveryKey()).key;
    const sealed = await sealTo(box.publicJwk, raw);
    // the server's row after complete: wrappedKey holds the sealed box (no notes-key-v1), epoch 0, pending at epoch 4
    const detail = { vault: { id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u1", keyEpoch: 4 }, role: "editor", wrappedKey: sealed, wrappedKeyEpoch: 0, pendingKey: { keyEpoch: 4, sealedKey: sealed }, members: [] };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? Response.json({ ok: true }) : Response.json(detail)));
    vi.stubGlobal("fetch", fetchMock);
    const access = await openAccess(VAULT, "u2", personal, box);
    expect(access.rawKey).toEqual(raw);
    expect(access.keyEpoch).toBe(4);
    const put = calls(fetchMock).find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe(`/api/vaults/${VAULT}/my-key`);
    const body = JSON.parse(String(put[1]!.body)) as { keyEpoch: number; wrappedKey: Parameters<typeof unwrapVaultKey>[0] };
    expect(body.keyEpoch).toBe(4);
    expect(await unwrapVaultKey(body.wrappedKey, personal)).toEqual(raw);
  });

  it("refuses without a box key or a pending key, and still opens an ordinary membership", async () => {
    const personal = (await newRecoveryKey()).key;
    const raw = randomVaultKey();
    const base = { vault: { id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u1", keyEpoch: 2 }, role: "editor", members: [] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...base, wrappedKey: { schema: "notes-sealed-v1" }, wrappedKeyEpoch: 0, pendingKey: null })));
    await expect(openAccess(VAULT, "u2", personal)).rejects.toThrow(/czeka/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...base, wrappedKey: { schema: "notes-sealed-v1" }, wrappedKeyEpoch: 0, pendingKey: { keyEpoch: 2, sealedKey: {} } })));
    await expect(openAccess(VAULT, "u2", personal)).rejects.toThrow(/Brak klucza szyfrowania/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...base, wrappedKey: await wrapBytes(raw, personal), wrappedKeyEpoch: 2 })));
    expect((await openAccess(VAULT, "u2", personal)).rawKey).toEqual(raw);
  });
});

describe("personal notes cut off over the socket", () => {
  type Internals = any;
  function personalBridge(): Internals {
    const access: VaultAccess = { vault: { id: "browser-u1", name: "Moje notatki", kind: "notatki", ownerUserId: "u1" }, role: "owner", members: [], rawKey: null, keyEpoch: 1 };
    const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => Internals;
    const bridge = new Ctor({ id: "u1", email: "a@example.test", name: "Ola", personal: "allowed" } satisfies BrowserUser, {} as CryptoKey, {} as IDBDatabase, {} as CryptoKey, access);
    bridge.socket = { readyState: 1, send: () => undefined, close: vi.fn() };
    return bridge;
  }

  for (const frame of [{ type: "error", code: "personal-off", message: "Własne notatki nie są włączone dla tego konta." }, { type: "access", role: null }]) {
    it(`stops syncing and falls back after ${frame.type}`, async () => {
      const bridge = personalBridge();
      const seen: unknown[] = [];
      bridge.onVaultAccess((p: unknown) => seen.push(p));
      await bridge.handleMessage(frame);
      expect(bridge.stopped).toBe(true); // onclose reconnects only while not stopped
      expect(bridge.socket.close).toHaveBeenCalled();
      expect(seen).toEqual([{ role: null, voluntary: false, personal: true }]);
      // the fallback no longer points at Moje notatki
      expect(homeVaultId(bridge.user)).toBe("");
    });
  }
});
