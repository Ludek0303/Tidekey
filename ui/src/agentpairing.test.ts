// @vitest-environment jsdom
// docs/MCP.md §3.2 (pairing link), §3.9 (scope), §12: the browser side of "Połącz Claude".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ownChoices,
  EXPIRED_TEXT, MIGRATE_TEXT, NOT_STARTED_TEXT, NO_SPACE_TEXT, SWAPPED_TEXT, checkPairingLink, finishPairing, pendingPairing, readPairingLink,
  spaceOptions, startPairing, summaryText, type PairingLink, type SpaceChoice,
} from "./agentpairing";
import { checkCode, generateAgentKeys, openForAgent, openScope, verifyCert, type AgentKeyPair } from "./agentcrypto";
import type { BrowserBridge } from "./browserauth";
import type { SigningIdentity } from "./signing";
import { newRecoveryKey } from "./browserauth";
import { personalVaultId, randomVaultKey, wrapPersonalVaultKey } from "./vaults";

const USER = "anna-user";
const CLUB = `v-${"d".repeat(32)}`;
const TOKEN = "e".repeat(64);
const CODE = "K7QMH3XR";

type Call = { method: string; url: string; body?: any };
function serve(handle: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handle(call) ?? Response.json({ message: "nieznane" }, { status: 404 });
  }));
  return calls;
}
const json = (body: unknown, status = 200): Response => (status === 204 ? new Response(null, { status }) : Response.json(body, { status }));

async function identity(userId: string): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { userId, privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}
const linkFor = (keys: AgentKeyPair, code = CODE): PairingLink => ({ pairToken: TOKEN, signKey: keys.signKey, boxKey: keys.boxKey, code });
const claimed = (keys: AgentKeyPair, ip = "10.0.0.2") => ({ state: "claimed", claim: { signKey: keys.signKey, boxKey: keys.boxKey, device: { name: "laptop", os: "linux" }, mcpVersion: "1.0.0", ip, claimedAt: 1 }, requestIp: "10.0.0.1" });

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

// Starts a pairing in this tab as the server answers it.
async function started(expiresAt = Date.now() + 600_000): Promise<void> {
  serve((c) => (c.method === "POST" ? json({ pairingId: "p1", code: "K7QM-H3XR", expiresAt }, 201) : undefined));
  await startPairing();
}

describe("the pairing link", () => {
  it("reads token, keys and code, and always clears the address", async () => {
    const keys = await generateAgentKeys();
    const replace = vi.spyOn(history, "replaceState");
    expect(readPairingLink(`https://h/?pair-agent=${TOKEN}#a=${keys.signKey}.${keys.boxKey}&c=k7qm-h3xr`)).toEqual(linkFor(keys));
    expect(readPairingLink(`https://h/?pair-agent=${TOKEN}#a=${keys.signKey}&c=${CODE}`)).toBeNull();
    expect(readPairingLink(`https://h/?pair-agent=short#a=${keys.signKey}.${keys.boxKey}&c=${CODE}`)).toBeNull();
    expect(replace).toHaveBeenCalledTimes(3);
  });

  it("without a pairing started in this browser: refused", async () => {
    const calls = serve(() => undefined);
    const check = await checkPairingLink(linkFor(await generateAgentKeys()));
    expect(check).toMatchObject({ ok: false, reason: NOT_STARTED_TEXT });
    expect(calls.filter((c) => c.method !== "DELETE")).toHaveLength(0);
  });

  it("another code: refused, and the started pairing is cancelled", async () => {
    await started();
    const calls = serve((c) => (c.method === "DELETE" ? json(null, 204) : undefined));
    const check = await checkPairingLink(linkFor(await generateAgentKeys(), "AAAABBBB"));
    expect(check.reason).toBe(NOT_STARTED_TEXT);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["DELETE", "/api/me/agent-pairings/p1"]]);
    expect(pendingPairing()).toBeNull();
  });

  it("expired: refused and cancelled", async () => {
    await started();
    const calls = serve((c) => (c.method === "DELETE" ? json(null, 204) : json({ state: "expired", claim: null, requestIp: "1" })));
    expect((await checkPairingLink(linkFor(await generateAgentKeys()))).reason).toBe(EXPIRED_TEXT);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("keys in the fragment other than the claimed ones: stopped as swapped", async () => {
    await started();
    const claimedKeys = await generateAgentKeys();
    const calls = serve((c) => (c.method === "DELETE" ? json(null, 204) : json(claimed(claimedKeys))));
    const check = await checkPairingLink(linkFor(await generateAgentKeys()));
    expect(check).toMatchObject({ ok: false, reason: SWAPPED_TEXT });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/p1"))).toBe(true);
  });

  it("matching keys: shows who connects and the check code", async () => {
    await started();
    const keys = await generateAgentKeys();
    serve(() => json(claimed(keys)));
    const check = await checkPairingLink(linkFor(keys));
    expect(check).toMatchObject({ ok: true, reason: null, device: { name: "laptop", os: "linux" }, claimIp: "10.0.0.2", myIp: "10.0.0.1", otherNetwork: true });
    expect(check.checkCode).toBe(await checkCode(keys.signKey, keys.boxKey, CODE));
  });

  it("a pairing started in another tab of this browser counts (BroadcastChannel)", async () => {
    const other = new BroadcastChannel("notes-agent-pairing");
    other.onmessage = (e) => { if (e.data?.type === "ask") other.postMessage({ type: "pairing", pairing: { pairingId: "p9", code: CODE, expiresAt: Date.now() + 60_000 } }); };
    const keys = await generateAgentKeys();
    const calls = serve(() => json(claimed(keys, "10.0.0.1")));
    const check = await checkPairingLink(linkFor(keys));
    other.postMessage({ type: "clear", pairingId: "p9" }); // that tab is done with it
    await new Promise((resolve) => setTimeout(resolve, 50));
    other.close();
    expect(pendingPairing()).toBeNull();
    expect(check).toMatchObject({ ok: true, otherNetwork: false });
    expect(calls[0].url).toBe("/api/me/agent-pairings/p9");
  });
});

describe("finishing the pairing", () => {
  // A bridge of Moje notatki as finishPairing reads it.
  async function fakeBridge(signing: SigningIdentity, personal: CryptoKey): Promise<BrowserBridge> {
    return {
      user: { id: USER }, personalKey: personal, vault: { id: personalVaultId(USER) }, vaultKey: null, vaultEpoch: 2, signingIdentity: signing,
      call: async () => ({ notes: [], folders: ["Spotkania", "Zadania"] }), agentProjects: () => [], grantProjectToChat: vi.fn(),
    } as unknown as BrowserBridge;
  }

  it("needs a space", async () => {
    await expect(finishPairing({} as BrowserBridge, linkFor(await generateAgentKeys()), [], 4)).rejects.toThrow(NO_SPACE_TEXT);
  });

  it("signs the cert, seals each key and scope to the chat, cuts mode and session to the policy, and forgets the code", async () => {
    await started();
    const keys = await generateAgentKeys();
    const signing = await identity(USER);
    const personal = (await newRecoveryKey()).key;
    const myNotes = randomVaultKey();
    const row = { keyEpoch: 3, wrappedKey: await wrapPersonalVaultKey(myNotes, personal, USER, 3) };
    const club = randomVaultKey();
    const { wrapVaultKey } = await import("./vaults");
    const clubWrapped = await wrapVaultKey(club, personal);
    const detail = { vault: { id: CLUB, name: "Klub", kind: "organizacja", ownerUserId: "o", keyEpoch: 5 }, role: "editor", members: [], wrappedKey: clubWrapped, wrappedKeyEpoch: 5,
      agentPolicy: { enabled: true, maxHours: 8, maxWriteMode: "proposals", allowProtected: false } };
    const calls = serve((c) => {
      if (c.url === "/api/me/agent-pairings/p1") return json(claimed(keys));
      if (c.url === "/api/me/personal-key") return json({ keys: [row] });
      if (c.url === "/api/vaults") return json({ vaults: [{ id: CLUB, name: "Klub", kind: "organizacja", ownerUserId: "o", role: "editor" }] });
      if (c.url === `/api/vaults/${CLUB}`) return json(detail);
      if (c.url === "/api/me/agents" && c.method === "POST") return json({ agentId: c.body.cert.agentId }, 201);
      return undefined;
    });
    const link = linkFor(keys);
    expect((await checkPairingLink(link)).ok).toBe(true);
    const bridge = await fakeBridge(signing, personal);
    const choices: SpaceChoice[] = [
      { vaultId: personalVaultId(USER), include: [], exclude: [], projects: [], writeMode: "none", tools: [], tasks: "all" },
      { vaultId: CLUB, include: ["Spotkania", "Zadania"], exclude: [], projects: ["Projekty/X"], writeMode: "direct", tools: [], tasks: "mine" },
    ];
    const agentId = await finishPairing(bridge, link, choices, 24);
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/me/agents")!.body;
    expect(post.pairingId).toBe("p1");
    expect(post.sessionHours).toBe(8);
    expect(post.cert.vaults).toEqual([
      { vaultId: personalVaultId(USER), whole: true, parts: [], writeMode: "none" },
      { vaultId: CLUB, whole: true, parts: [], writeMode: "proposals" },
    ]);
    expect(await verifyCert({ ...post.cert, signature: post.signature }, signing.publicJwk)).toBe(true);
    expect(post.cert.agentId).toBe(agentId);
    const keyOf = (v: string) => post.keys.find((k: any) => k.vaultId === v);
    expect([...await openForAgent(keyOf(personalVaultId(USER)).sealedKey, keys, personalVaultId(USER), "vault", 3)]).toEqual([...myNotes]);
    expect(keyOf(CLUB).keyEpoch).toBe(5);
    expect([...await openForAgent(keyOf(CLUB).sealedKey, keys, CLUB, "vault", 5)]).toEqual([...club]);
    const scope = await openScope(post.scopes.find((s: any) => s.vaultId === CLUB).sealedScope, keys, signing.publicJwk, { agentId, vaultId: CLUB, userId: USER });
    expect(scope).toMatchObject({ include: ["Spotkania", "Zadania"], tasks: "mine" });
    // the person's own copy of the scope: the scope screen starts from it; a copy bound to another chat or space is not read
    const row0 = { agentId, cert: post.cert, signature: post.signature, scopes: post.scopes.map((s: any) => ({ vaultId: s.vaultId, ownScope: s.ownScope })) } as any;
    (bridge as any).projectsOfChat = () => [];
    expect((await ownChoices(bridge, row0)).find((c) => c.vaultId === CLUB)).toMatchObject({ include: ["Spotkania", "Zadania"], tasks: "mine", writeMode: "proposals" });
    const swapped = { ...row0, scopes: row0.scopes.map((s: any) => ({ ...s, vaultId: s.vaultId === CLUB ? personalVaultId(USER) : CLUB })) };
    expect(await ownChoices(bridge, swapped)).toEqual([]);
    expect((bridge as any).grantProjectToChat).not.toHaveBeenCalled(); // projects are not allowed there
    expect(pendingPairing()).toBeNull();
    expect(summaryText(choices.map((c, i) => ({ ...c, writeMode: post.cert.vaults[i].writeMode, projects: [] })), await spaceOptions(bridge)))
      .toBe("Ten czat widzi: Moje notatki (całe, tylko odczyt); Klub: Spotkania/, Zadania/ (propozycje)");
  });

  it("Moje notatki still under the personal key, or an organization without chats, cannot be chosen", async () => {
    serve((c) => {
      if (c.url === "/api/me/personal-key") return json({ keys: [] });
      if (c.url === "/api/vaults") return json({ vaults: [{ id: CLUB, name: "Klub", kind: "organizacja", ownerUserId: "o", role: "owner" }] });
      if (c.url === `/api/vaults/${CLUB}`) return json({ vault: { id: CLUB }, role: "owner", members: [] });
      return undefined;
    });
    const bridge = { ...(await fakeBridge(await identity(USER), (await newRecoveryKey()).key)), vaultEpoch: 1 } as unknown as BrowserBridge;
    const options = await spaceOptions(bridge);
    expect(options.map((o) => o.disabledReason)).toEqual([MIGRATE_TEXT, "Właściciel tej organizacji nie włączył czatów Claude."]);
    expect(options[0].folders).toEqual(["Spotkania", "Zadania"]);
  });
});

describe("review: pairing edge cases and scopes per chat (§3.2, §3.9, §12)", () => {
  async function fakeBridge(signing: SigningIdentity, personal: CryptoKey): Promise<BrowserBridge> {
    return {
      user: { id: USER }, personalKey: personal, vault: { id: personalVaultId(USER) }, vaultKey: null, vaultEpoch: 2, signingIdentity: signing,
      call: async () => ({ notes: [], folders: ["Spotkania", "Spotkania/Zarząd"] }), agentProjects: () => [], grantProjectToChat: vi.fn(), projectsOfChat: () => [],
    } as unknown as BrowserBridge;
  }
  // A server with Moje notatki (epoch 3) and the organization Klub; each pairing is claimed by `keys()`.
  async function world(policy: object | undefined, keys: () => AgentKeyPair) {
    const personal = (await newRecoveryKey()).key;
    const signing = await identity(USER);
    const myNotes = randomVaultKey(), club = randomVaultKey();
    const { wrapVaultKey } = await import("./vaults");
    const row = { keyEpoch: 3, wrappedKey: await wrapPersonalVaultKey(myNotes, personal, USER, 3) };
    const detail = { vault: { id: CLUB, name: "Klub", kind: "organizacja", ownerUserId: "o", keyEpoch: 1 }, role: "editor", members: [], wrappedKey: await wrapVaultKey(club, personal), wrappedKeyEpoch: 1, agentPolicy: policy };
    let n = 0;
    const calls = serve((c) => {
      if (c.method === "POST" && c.url === "/api/me/agent-pairings") return json({ pairingId: `p${++n}`, code: CODE, expiresAt: Date.now() + 600_000 }, 201);
      if (c.url.startsWith("/api/me/agent-pairings/") && c.method === "GET") return json(claimed(keys()));
      if (c.method === "DELETE") return json(null, 204);
      if (c.url === "/api/me/personal-key") return json({ keys: [row] });
      if (c.url === "/api/vaults") return json({ vaults: [{ id: CLUB, name: "Klub", kind: "organizacja", ownerUserId: "o", role: "editor" }] });
      if (c.url === `/api/vaults/${CLUB}`) return json(detail);
      if (c.url === "/api/me/agents" && c.method === "POST") return json({ agentId: c.body.cert.agentId }, 201);
      return undefined;
    });
    return { calls, bridge: await fakeBridge(signing, personal), signing, myNotes, club };
  }
  const choice = (vaultId: string, over: Partial<SpaceChoice> = {}): SpaceChoice => ({ vaultId, include: [], exclude: [], projects: [], writeMode: "none", tools: [], tasks: "mine", ...over });

  it("two chats of one person with disjoint scopes: keys, scopes and certs name only their own spaces", async () => {
    let current = await generateAgentKeys();
    const { calls, bridge, signing } = await world({ enabled: true, maxHours: 8, maxWriteMode: "proposals", allowProtected: false }, () => current);
    const laptop = current;
    await startPairing();
    expect((await checkPairingLink(linkFor(laptop))).ok).toBe(true);
    const a = await finishPairing(bridge, linkFor(laptop), [choice(personalVaultId(USER))], 4);
    const work = current = await generateAgentKeys();
    await startPairing();
    expect((await checkPairingLink(linkFor(work))).ok).toBe(true);
    const b = await finishPairing(bridge, linkFor(work), [choice(CLUB, { include: ["Spotkania"], writeMode: "proposals" })], 4);
    const [postA, postB] = calls.filter((c) => c.method === "POST" && c.url === "/api/me/agents").map((c) => c.body);
    expect(postA.cert.vaults.map((v: any) => v.vaultId)).toEqual([personalVaultId(USER)]);
    expect(postB.cert.vaults.map((v: any) => v.vaultId)).toEqual([CLUB]);
    expect(postA.keys.map((k: any) => k.vaultId)).toEqual([personalVaultId(USER)]);
    expect(postB.keys.map((k: any) => k.vaultId)).toEqual([CLUB]);
    expect(postA.scopes.map((x: any) => x.vaultId)).toEqual([personalVaultId(USER)]);
    // neither chat opens what was sealed for the other
    await expect(openForAgent(postA.keys[0].sealedKey, work, personalVaultId(USER), "vault", 3)).rejects.toThrow();
    await expect(openForAgent(postB.keys[0].sealedKey, laptop, CLUB, "vault", 1)).rejects.toThrow();
    await expect(openScope(postB.scopes[0].sealedScope, laptop, signing.publicJwk, { agentId: b, vaultId: CLUB, userId: USER })).rejects.toThrow();
    expect((await openScope(postB.scopes[0].sealedScope, work, signing.publicJwk, { agentId: b, vaultId: CLUB, userId: USER })).include).toEqual(["Spotkania"]);
    expect(a).not.toBe(b);
  });

  it("an organization whose owner turned chats off cannot be chosen, even by a hand-made choice", async () => {
    const keys = await generateAgentKeys();
    const { calls, bridge } = await world(undefined, () => keys);
    await startPairing();
    expect((await checkPairingLink(linkFor(keys))).ok).toBe(true);
    await expect(finishPairing(bridge, linkFor(keys), [choice(CLUB)], 4)).rejects.toThrow("Właściciel tej organizacji nie włączył czatów Claude.");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/me/agents")).toBe(false);
  });

  it("the code runs out while the scope is chosen: told so, and the pairing is forgotten", async () => {
    const keys = await generateAgentKeys();
    await world({ enabled: true, maxHours: 8, maxWriteMode: "none", allowProtected: false }, () => keys);
    await startPairing();
    expect((await checkPairingLink(linkFor(keys))).ok).toBe(true);
    const calls = serve(() => json({ state: "expired", claim: null, requestIp: "1" }));
    await expect(finishPairing({ user: { id: USER } } as BrowserBridge, linkFor(keys), [choice(personalVaultId(USER))], 4)).rejects.toThrow(EXPIRED_TEXT);
    expect(pendingPairing()).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a link opened twice: the second check after the pairing is done is refused", async () => {
    const keys = await generateAgentKeys();
    const { bridge } = await world({ enabled: true, maxHours: 8, maxWriteMode: "none", allowProtected: false }, () => keys);
    await startPairing();
    expect((await checkPairingLink(linkFor(keys))).ok).toBe(true);
    await finishPairing(bridge, linkFor(keys), [choice(personalVaultId(USER))], 4);
    expect((await checkPairingLink(linkFor(keys))).reason).toBe(NOT_STARTED_TEXT);
    await expect(finishPairing(bridge, linkFor(keys), [choice(personalVaultId(USER))], 4)).rejects.toThrow("Najpierw sprawdź link parowania.");
  });

  it("another tab that finished or stopped the pairing makes this tab forget its own copy", async () => {
    await started();
    expect(pendingPairing()?.pairingId).toBe("p1");
    const other = new BroadcastChannel("notes-agent-pairing");
    other.postMessage({ type: "clear", pairingId: "p1" });
    await vi.waitFor(() => expect(pendingPairing()).toBeNull());
    expect(sessionStorage.getItem("notes.agentPairing.v1")).toBeNull();
    other.close();
  });

});
