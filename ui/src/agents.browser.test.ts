// @vitest-environment jsdom
// docs/MCP.md §12 (browser side): Claude chats in BrowserBridge — signatures of chats, keys for chats on rotation, the
// append mode, "Cofnij zmiany czatu" and proposals. Helpers copied from protected.test.ts and personalkey.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { APPEND_REFUSED_TEXT, BrowserBridge, agentVersionReason, encryptSnapshot, newRecoveryKey } from "./browserauth";
import type { BrowserVaultSnapshot } from "./bridge";
import { generateAgentKeys, newAgentId, openForAgent, signAsAgent, signCert, type AgentCert, type AgentKeyPair, type WriteMode } from "./agentcrypto";
import { sealProposal, textHash } from "./proposals";
import { MARKS_TEXT } from "./permissionmarks";
import { DETACHED_TEXT, REVOKED_TEXT, STALE_TEXT, TWICE_TEXT, agentChanges, decideProposal, listProposals, undoAgentChanges } from "./agentpairing";
import type { SigningIdentity } from "./signing";
import type { BoxIdentity } from "./sealed";
import {
  base64ToBytes, bytesToBase64, importVaultKey, personalAccess, personalVaultId, randomVaultKey, unwrapPersonalVaultKey, wrapPersonalVaultKey,
  type MemberAgent, type RemoteMember, type Role, type VaultAccess,
} from "./vaults";

const OWNER = "owner-user";
const MEMBER = "member-user";
const VAULT = `v-${"f".repeat(32)}`;
const vaultInfo = { id: VAULT, name: "Klub", kind: "organizacja" as const, ownerUserId: OWNER, keyEpoch: 1 };
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
  } as unknown as IDBDatabase;
}
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

interface Person { box: BoxIdentity; signing: SigningIdentity; member: RemoteMember }
async function person(userId: string, role: Role): Promise<Person> {
  const box = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = async (k: CryptoKey) => { const j = await crypto.subtle.exportKey("jwk", k); return { kty: j.kty, crv: j.crv, x: j.x, y: j.y } as JsonWebKey; };
  const boxKey = await pub(box.publicKey), signingKey = await pub(sign.publicKey);
  return {
    box: { userId, privateKey: box.privateKey, publicJwk: boxKey },
    signing: { userId, privateKey: sign.privateKey, publicJwk: signingKey },
    member: { userId, email: `${userId}@example.test`, name: userId, role, boxKey, signingKey },
  };
}
// A chat of `who`, its cert signed by them, for `vaultId`.
async function chatOf(who: Person, vaultId: string, writeMode: WriteMode, revokedAt: number | null = null): Promise<{ keys: AgentKeyPair; agent: MemberAgent }> {
  const keys = await generateAgentKeys();
  const { signature, ...cert } = await signCert({
    schema: "notes-agent-cert-v1", agentId: newAgentId(), userId: who.signing.userId, signKey: keys.signKey, boxKey: keys.boxKey,
    vaults: [{ vaultId, whole: true, parts: [], writeMode }], createdAt: Date.now() - 1000, expiresAt: Date.now() + 86_400_000,
  }, who.signing);
  return { keys, agent: { agentId: cert.agentId, cert: cert as AgentCert, signature: signature!, revokedAt } };
}
const RAW = randomVaultKey();
async function sharedBridge(me: Person, members: RemoteMember[], raw = RAW): Promise<any> {
  const access: VaultAccess = { vault: vaultInfo, role: me.member.role, members, rawKey: raw, keyEpoch: 1 };
  const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => any;
  const bridge = new Ctor({ id: me.member.userId, email: "x@example.test", name: me.member.userId }, (await newRecoveryKey()).key, fakeDb(), await importVaultKey(raw), access);
  // the organization lets chats write directly (the app cuts a chat's mode to this limit)
  Object.assign(bridge, { persist: vi.fn(async () => undefined), tidyFiles: vi.fn(async () => undefined), box: me.box, signing: me.signing,
    agentPolicy: { enabled: true, maxHours: 24, maxWriteMode: "direct", allowProtected: true } });
  return bridge;
}
async function note(b: any, path: string, text: string): Promise<string> {
  const id = await b.call("create_note", { path });
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
  return id;
}
const textOf = (b: any, id: string): Promise<string> => b.call("note_text", { id });
// The vault as a chat would put it: this bridge's state with `edit` applied to note `id`.
function chatState(b: any, edits: Record<string, (t: Y.Text) => void>, extra: (s: BrowserVaultSnapshot) => void = () => undefined): BrowserVaultSnapshot {
  const snapshot = structuredClone(b.exportBrowserSnapshot(OWNER, VAULT)) as BrowserVaultSnapshot;
  for (const n of snapshot.state.notes) {
    const edit = edits[n.id];
    if (!edit) continue;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToBytes(n.yjsUpdateBase64));
    edit(doc.getText("content"));
    n.yjsUpdateBase64 = bytesToBase64(Y.encodeStateAsUpdate(doc));
  }
  extra(snapshot);
  return snapshot;
}
const frame = async (snapshot: BrowserVaultSnapshot, revision: number, author: unknown, raw = RAW) =>
  ({ type: "update", revision, envelope: await encryptSnapshot(snapshot, await importVaultKey(raw), 1), author });

describe("signatures of chats", () => {
  it("an event signed by a member's chat verifies with the member's chat list; a revoked chat's does not", async () => {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, "direct");
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    const event = await signAsAgent({ event_id: "e1", time_ms: Date.now(), kind: "test" }, MEMBER, chat.agent.agentId, chat.keys.signSecret);
    bridge.signableEvents = () => [event];
    await bridge.verifyOrganization();
    expect(bridge.checks.get("e1").status).toBe("ok");
    chat.agent.revokedAt = Date.now() - 10_000;
    await bridge.verifyOrganization();
    expect(bridge.checks.get("e1").status).toBe("unverified");
  });
});

describe("keys for chats", () => {
  it("a rotation seals the new key for every live chat of the remaining members (the server refuses it otherwise)", async () => {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const live = await chatOf(member, VAULT, "proposals");
    const revoked = await chatOf(member, VAULT, "direct", Date.now() - 5);
    const elsewhere = await chatOf(member, "v-other", "direct");
    member.member.agents = [live.agent, revoked.agent, elsewhere.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    const detail = { vault: vaultInfo, role: "owner", members: [owner.member, member.member], wrappedKey: { schema: "notes-key-v1", nonce: "", ciphertext: "" } };
    const calls = serve((c) => {
      if (c.url.endsWith("/rotate")) return (c.body.agentKeys ?? []).map((k: any) => k.agentId).join() === live.agent.agentId ? json({}) : json({ message: "409" }, 409);
      if (c.url.endsWith("/my-key")) return json({});
      if (c.url === `/api/vaults/${VAULT}`) return json(detail);
      return undefined;
    });
    expect(await bridge.rotateKey()).toBe(true);
    const sealed = calls.find((c) => c.url.endsWith("/rotate"))!.body.agentKeys[0].sealedKey;
    expect([...await openForAgent(sealed, live.keys, VAULT, "vault", 2)]).toEqual([...bridge.vaultKey]);
  });

  // review of stages 2–8, finding 4: a member's broken cert never blocks a rotation; that chat is disconnected and gets nothing
  it("a chat whose cert does not verify is disconnected and gets no key; the rotation goes on", async () => {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor"), stranger = await person("x", "editor");
    const forged = await chatOf(stranger, VAULT, "direct");
    member.member.agents = [{ ...forged.agent, cert: { ...forged.agent.cert, userId: MEMBER } }];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    const calls = serve((c) => (c.url === `/api/vaults/${VAULT}` ? json({ vault: vaultInfo, role: "owner", members: [owner.member, member.member] }) : json({})));
    await bridge.rotateKey();
    expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/vaults/${VAULT}/agents/${forged.agent.agentId}`)).toBe(true);
    const rotate = calls.find((c) => c.url.endsWith("/rotate"));
    expect(rotate?.body.agentKeys).toEqual([]);
  });

  it("Moje notatki: the move to a key of their own sends no chat keys; disconnecting a chat makes the next epoch for the others only", async () => {
    const me = await person("anna", "owner");
    const kept = await chatOf(me, personalVaultId("anna"), "direct"), gone = await chatOf(me, personalVaultId("anna"), "direct");
    const personal = (await newRecoveryKey()).key;
    const stored: { keyEpoch: number; wrappedKey: unknown }[] = [{ keyEpoch: 2, wrappedKey: await wrapPersonalVaultKey(randomVaultKey(), personal, "anna", 2) }];
    const calls = serve((c) => {
      if (c.url === "/api/me/personal-key" && c.method === "PUT") { stored.push(c.body); return json({ keyEpoch: c.body.keyEpoch }); }
      if (c.url === "/api/me/personal-key") return json({ keys: stored });
      if (c.url === "/api/me/agents") return json({ agents: [kept.agent, gone.agent] });
      return undefined;
    });
    const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => any;
    const bridge = new Ctor({ id: "anna", email: "a@example.test", name: "Anna" }, personal, fakeDb(), personal, personalAccess("anna"));
    Object.assign(bridge, { persist: vi.fn(async () => undefined), tidyFiles: vi.fn(async () => undefined), signing: me.signing, remoteSeen: true });
    expect(await bridge.rotatePersonalKey([gone.agent.agentId])).toBe(true);
    const put = calls.find((c) => c.method === "PUT")!.body;
    expect(put.keyEpoch).toBe(3);
    expect(put.agentKeys.map((k: any) => k.agentId)).toEqual([kept.agent.agentId]);
    const raw = await unwrapPersonalVaultKey(put.wrappedKey, personal, "anna", 3);
    expect([...await openForAgent(put.agentKeys[0].sealedKey, kept.keys, personalVaultId("anna"), "vault", 3)]).toEqual([...raw]);
    // Moje notatki open here: the new key is taken and the vault sent again under it
    expect(bridge.epoch).toBe(3);
    expect(bridge.persist).toHaveBeenCalled();

    // the first move (epoch 2) names no chats: none can have Moje notatki before it
    stored.length = 0;
    const fresh = new Ctor({ id: "anna", email: "a@example.test", name: "Anna" }, personal, fakeDb(), personal, personalAccess("anna"));
    Object.assign(fresh, { persist: vi.fn(async () => undefined), tidyFiles: vi.fn(async () => undefined), remoteSeen: true, personalProven: true });
    await fresh.catchUp();
    expect(calls.filter((c) => c.method === "PUT").at(-1)!.body).toMatchObject({ keyEpoch: 2, agentKeys: [] });
  });
});

describe("revisions written by a chat", () => {
  async function setUpChat(mode: WriteMode) {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, mode);
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    serve(() => undefined);
    const author = { userId: MEMBER, agentId: chat.agent.agentId };
    return { bridge, author, agentId: chat.agent.agentId };
  }

  it("append mode: a revision that changes text is refused (shown once, sync marked failed); one that only adds is merged", async () => {
    const { bridge, author } = await setUpChat("append");
    const id = await note(bridge, "Spotkania/Plan.md", "Ala ma kota.");
    const destructive = chatState(bridge, { [id]: (t) => t.delete(0, 4) });
    await bridge.handleMessage(await frame(destructive, 7, author));
    expect(await textOf(bridge, id)).toBe("Ala ma kota.");
    expect(bridge.syncState).toBe("error");
    expect(bridge.revision).toBe(0);
    expect(bridge.persist).not.toHaveBeenCalled(); // nothing to build on: the next member's revision is awaited
    await bridge.handleMessage({ ...(await frame(destructive, 7, author)), type: "conflict" });
    expect(document.body.textContent?.split(APPEND_REFUSED_TEXT).length).toBe(2); // shown once
    expect(await textOf(bridge, id)).toBe("Ala ma kota.");

    // a move counts as a change too
    const moved = chatState(bridge, {}, (s) => { s.state.notes[0].path = "Inne/Plan.md"; s.state.notes[0].pathChangedAt = Date.now() + 1000; });
    await bridge.handleMessage(await frame(moved, 8, author));
    expect((await bridge.call("list_tree")).notes.map((n: any) => n.path)).toEqual(["Spotkania/Plan.md"]);

    const appended = chatState(bridge, { [id]: (t) => t.insert(t.length, " I psa.") });
    await bridge.handleMessage(await frame(appended, 9, author));
    expect(await textOf(bridge, id)).toBe("Ala ma kota. I psa.");
    expect(bridge.revision).toBe(9);
    const versions = await bridge.call("list_versions", { id });
    expect(versions.map((v: any) => v.reason)).toContain(agentVersionReason(author.agentId));
  });

  it("append mode: a device that holds the revision the chat wrote on takes the change back by putting its own state", async () => {
    const { bridge, author } = await setUpChat("append");
    const id = await note(bridge, "Plan.md", "Tekst.");
    bridge.revision = 6;
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.delete(0, 1) }), 7, author));
    expect(bridge.revision).toBe(7);
    expect(bridge.persist).toHaveBeenCalledWith(true);
    expect(await textOf(bridge, id)).toBe("Tekst.");
  });

  it("the author comes from the server's frame only: a client never sends one, and a person's revision is merged as before", async () => {
    const { bridge } = await setUpChat("append");
    const id = await note(bridge, "Plan.md", "Tekst.");
    const sent: string[] = [];
    bridge.socket = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(m) };
    bridge.sendPut({ schema: "notes-encrypted-v1", nonce: "", ciphertext: "" }, "x");
    expect(Object.keys(JSON.parse(sent[0])).sort()).toEqual(["baseRevision", "envelope", "type"]);
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.delete(0, 1) }), 3, null));
    expect(await textOf(bridge, id)).toBe("ekst.");
  });

  it("Cofnij zmiany czatu: the chat's notes go back to before its first change, later changes of people to other notes stay", async () => {
    const { bridge, author, agentId } = await setUpChat("direct");
    const a = await note(bridge, "A.md", "Pierwotny A.");
    const b = await note(bridge, "B.md", "Pierwotny B.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, { [a]: (t) => { t.delete(0, t.length); t.insert(0, "Claude 1."); } }), 1, author));
    await bridge.handleMessage(await frame(chatState(bridge, { [a]: (t) => t.insert(t.length, " Claude 2.") }, (s) => {
      const doc = new Y.Doc(); doc.getText("content").insert(0, "Nowa od Claude.");
      s.state.notes.push({ id: "chat-made", path: "C.md", yjsUpdateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)) });
    }), 2, author));
    expect(await textOf(bridge, a)).toBe("Claude 1. Claude 2.");
    // a person edits B afterwards
    const edit = new Y.Doc();
    Y.applyUpdate(edit, await bridge.call("open_note", { id: b }));
    const vector = Y.encodeStateVector(edit);
    edit.getText("content").insert(0, "Anna: ");
    await bridge.call("apply_update", { id: b, update: Y.encodeStateAsUpdate(edit, vector) });

    expect((await agentChanges(bridge, agentId, since)).map((c) => c.path).sort()).toEqual(["A.md", "A.md", "C.md"]);
    expect(await undoAgentChanges(bridge, agentId, since)).toEqual({ notes: 2, conflicts: [] });
    expect(await textOf(bridge, a)).toBe("Pierwotny A.");
    expect(await textOf(bridge, b)).toBe("Anna: Pierwotny B.");
    expect((await bridge.call("list_tree")).notes.map((n: any) => n.path).sort()).toEqual(["A.md", "B.md"]);
  });
});

// review of stages 2–8, finding 2: the organization's limit cuts a chat's mode here too, not only on the server
describe("write mode cut to the organization's limit", () => {
  it("a chat whose cert says direct writes only as the policy allows: append refuses a changed text", async () => {
    const me = await person(OWNER, "owner");
    const chat = await chatOf(me, VAULT, "direct");
    const bridge = await sharedBridge({ ...me, member: { ...me.member, agents: [chat.agent] } } as never, [{ ...me.member, agents: [chat.agent] }]);
    bridge.agentPolicy = { enabled: true, maxHours: 8, maxWriteMode: "append", allowProtected: false };
    expect(await bridge.chatWriteMode(OWNER, chat.agent.agentId)).toBe("append");
    bridge.agentPolicy = { enabled: true, maxHours: 8, maxWriteMode: "direct", allowProtected: false };
    expect(await bridge.chatWriteMode(OWNER, chat.agent.agentId)).toBe("direct");
  });
});

// review of stages 2–8, finding 3: a chat that had Moje notatki and was disconnected anywhere (another device, the
// operator) makes their next open rotate the key; one disconnected before the newest key does not
describe("Moje notatki after a disconnect elsewhere", () => {
  it("rotates when a chat with them was revoked after their newest key, not before", async () => {
    const me = await person("anna", "owner");
    const chat = await chatOf(me, personalVaultId("anna"), "none", 5_000);
    const bridge = await sharedBridge(me, []);
    bridge.info = { ...bridge.info, id: personalVaultId("anna") };
    bridge.rotatePersonalKey = vi.fn(async () => true);
    let created = 1_000;
    serve((c) => (c.url === "/api/me/personal-key" ? json({ keys: [{ keyEpoch: 2, wrappedKey: {}, createdAt: created }] }) : c.url === "/api/me/agents" ? json({ agents: [{ ...chat.agent, revokedAt: 5_000 }] }) : undefined));
    await bridge.personalRevoked();
    expect(bridge.rotatePersonalKey).toHaveBeenCalledWith([chat.agent.agentId]);
    created = 9_000;
    bridge.rotatePersonalKey.mockClear();
    await bridge.personalRevoked();
    expect(bridge.rotatePersonalKey).not.toHaveBeenCalled();
  });
});

describe("proposals", () => {
  async function setUpProposals() {
    const me = await person(OWNER, "owner");
    const chat = await chatOf(me, VAULT, "proposals");
    const bridge = await sharedBridge(me, [me.member]);
    const id = await note(bridge, "Plan.md", "Plan spotkania.");
    const rows: unknown[] = [];
    const calls = serve((c) => {
      if (c.url === "/api/me/agents") return json({ agents: [chat.agent] });
      if (c.url === `/api/vaults/${VAULT}/proposals`) return json({ proposals: rows });
      if (c.url.endsWith("/decision")) return json(null, 204);
      return undefined;
    });
    const propose = async (text: string, signSecret = chat.keys.signSecret, op: "edit" | "tasks" | "trash" = "edit", base = "Plan spotkania.") => {
      const proposal = await sealProposal({ createdAt: Date.now(), summary: "zmiana", changes: [{ op, path: "Plan.md", noteId: id, baseHash: await textHash(base), text }] },
        { vaultId: VAULT, agentId: chat.agent.agentId, userId: OWNER, personBoxKey: me.box.publicJwk, signSecret });
      rows.push({ proposalId: proposal.proposalId, agentId: chat.agent.agentId, createdAt: Date.now(), expiresAt: Date.now() + 1e9, state: "open", proposal });
    };
    return { bridge, id, calls, propose };
  }

  it("an up-to-date proposal is applied with the person's client and approved", async () => {
    const { bridge, id, calls, propose } = await setUpProposals();
    await propose("Plan spotkania.\n- [ ] Sala");
    const [view] = await listProposals(bridge);
    expect(view).toMatchObject({ problem: null, stale: [false] });
    await decideProposal(bridge, view, true);
    expect(await textOf(bridge, id)).toBe("Plan spotkania.\n- [ ] Sala");
    expect(calls.find((c) => c.url.endsWith("/decision"))!.body).toEqual({ decision: "approved" });
  });

  // review of stages 2–8, findings 1 and 9
  it("a tasks proposal adds its lines at the end and keeps the note's text", async () => {
    const { bridge, id, propose } = await setUpProposals();
    await propose("\n- [ ] Sala ^z-abc", undefined, "tasks");
    await decideProposal(bridge, (await listProposals(bridge))[0], true);
    expect(await textOf(bridge, id)).toBe("Plan spotkania.\n- [ ] Sala ^z-abc");
  });
  it("trashing a note that holds permission marks is rejected", async () => {
    const { bridge, id, calls, propose } = await setUpProposals();
    const doc = new Y.Doc(); Y.applyUpdate(doc, await bridge.call("open_note", { id }));
    const vector = Y.encodeStateVector(doc);
    doc.getText("content").insert(0, "---\nosoby: Ewa\n---\n");
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, vector) });
    await propose("", undefined, "trash", "---\nosoby: Ewa\n---\nPlan spotkania.");
    await expect(decideProposal(bridge, (await listProposals(bridge))[0], true)).rejects.toThrow(MARKS_TEXT);
    expect(calls.find((c) => c.url.endsWith("/decision"))!.body).toEqual({ decision: "rejected" });
    expect(((await bridge.call("list_tree")) as { notes: { id: string }[] }).notes.some((n) => n.id === id)).toBe(true);
  });

  it("a stale proposal cannot be approved", async () => {
    const { bridge, id, calls, propose } = await setUpProposals();
    await propose("Inny plan.");
    const [view] = await listProposals(bridge);
    const edit = new Y.Doc(); Y.applyUpdate(edit, await bridge.call("open_note", { id }));
    const vector = Y.encodeStateVector(edit);
    edit.getText("content").insert(0, "!");
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(edit, vector) });
    expect((await listProposals(bridge))[0].stale).toEqual([true]);
    await expect(decideProposal(bridge, view, true)).rejects.toThrow(STALE_TEXT);
    expect(calls.some((c) => c.url.endsWith("/decision"))).toBe(false);
  });

  it("a proposal that changes permission marks is rejected", async () => {
    const { bridge, id, calls, propose } = await setUpProposals();
    await propose("---\nosoby: [Ewa]\n---\nPlan spotkania.");
    const [view] = await listProposals(bridge);
    await expect(decideProposal(bridge, view, true)).rejects.toThrow(MARKS_TEXT);
    expect(calls.find((c) => c.url.endsWith("/decision"))!.body).toEqual({ decision: "rejected" });
    expect(await textOf(bridge, id)).toBe("Plan spotkania.");
  });

  it("a forged proposal shows a problem and cannot be approved", async () => {
    const { bridge, propose } = await setUpProposals();
    await propose("Plan.", (await generateAgentKeys()).signSecret);
    const [view] = await listProposals(bridge);
    expect(view.problem).toBe("Propozycja jest uszkodzona lub podrobiona.");
    expect(view.body).toBeNull();
    await expect(decideProposal(bridge, view, true)).rejects.toThrow("podrobiona");
  });
});

// ---- review of the browser side (docs/MCP.md §3.5, §6, §7.1, §7.2, §12) ------------------------------------------------

describe("proposals: revoked chats, other vaults, several changes, taken paths", () => {
  async function setUp() {
    const me = await person(OWNER, "owner");
    const chat = await chatOf(me, VAULT, "proposals");
    const bridge = await sharedBridge(me, [me.member]);
    const id = await note(bridge, "Plan.md", "Plan spotkania.");
    await note(bridge, "Zajęta.md", "Ktoś tu jest.");
    const rows: unknown[] = [];
    let agents: unknown[] = [chat.agent];
    const calls = serve((c) => {
      if (c.url === "/api/me/agents") return json({ agents });
      if (c.url === `/api/vaults/${VAULT}/proposals`) return json({ proposals: rows });
      if (c.url.endsWith("/decision")) return json(null, 204);
      return undefined;
    });
    const propose = async (changes: any[], vaultId = VAULT) => {
      const proposal = await sealProposal({ createdAt: Date.now(), summary: "zmiana", changes },
        { vaultId, agentId: chat.agent.agentId, userId: OWNER, personBoxKey: me.box.publicJwk, signSecret: chat.keys.signSecret });
      rows.push({ proposalId: proposal.proposalId, agentId: chat.agent.agentId, createdAt: Date.now(), expiresAt: Date.now() + 1e9, state: "open", proposal });
    };
    const base = await textHash("Plan spotkania.");
    return { bridge, id, calls, propose, base, chat, setAgents: (a: unknown[]) => { agents = a; } };
  }

  it("a proposal of a revoked chat is shown with the reason and cannot be approved", async () => {
    const { bridge, id, calls, propose, base, chat, setAgents } = await setUp();
    await propose([{ op: "edit", path: "Plan.md", noteId: id, baseHash: base, text: "Inny plan." }]);
    setAgents([{ ...chat.agent, revokedAt: Date.now() - 1 }]);
    const [view] = await listProposals(bridge);
    expect(view.problem).toBe(REVOKED_TEXT);
    await expect(decideProposal(bridge, view, true)).rejects.toThrow(REVOKED_TEXT);
    expect(await textOf(bridge, id)).toBe("Plan spotkania.");
    expect(calls.some((c) => c.url.endsWith("/decision"))).toBe(false);
  });

  it("a chat disconnected after the list was shown: the approval checks again and applies nothing", async () => {
    const { bridge, id, calls, propose, base, chat, setAgents } = await setUp();
    await propose([{ op: "edit", path: "Plan.md", noteId: id, baseHash: base, text: "Inny plan." }]);
    const [view] = await listProposals(bridge);
    expect(view.problem).toBeNull();
    setAgents([{ ...chat.agent, revokedAt: Date.now() }]);
    await expect(decideProposal(bridge, view, true)).rejects.toThrow(REVOKED_TEXT);
    expect(await textOf(bridge, id)).toBe("Plan spotkania.");
    expect(calls.some((c) => c.url.endsWith("/decision"))).toBe(false);
  });

  it("a proposal sealed for another vault does not open here", async () => {
    const { bridge, id, propose, base } = await setUp();
    await propose([{ op: "edit", path: "Plan.md", noteId: id, baseHash: base, text: "x" }], `v-${"a".repeat(32)}`);
    const [view] = await listProposals(bridge);
    expect(view).toMatchObject({ body: null, problem: "Propozycja jest uszkodzona lub podrobiona." });
  });

  it("two changes of one note are refused whole (one would overwrite the other)", async () => {
    const { bridge, id, calls, propose, base } = await setUp();
    await propose([
      { op: "append", path: "Plan.md", noteId: id, baseHash: base, text: " A" },
      { op: "append", path: "Plan.md", noteId: id, baseHash: base, text: " B" },
    ]);
    const [view] = await listProposals(bridge);
    expect(view.problem).toBe(TWICE_TEXT);
    await expect(decideProposal(bridge, view, true)).rejects.toThrow(TWICE_TEXT);
    expect(await textOf(bridge, id)).toBe("Plan spotkania.");
    expect(calls.some((c) => c.url.endsWith("/decision"))).toBe(false);
  });

  it("a move to a taken path or a new note on a taken path is stale; a stale change in the middle applies nothing", async () => {
    const { bridge, id, propose, base } = await setUp();
    await propose([
      { op: "create", path: "Nowa.md", noteId: "", baseHash: "", text: "Nowa." },
      { op: "move", path: "Plan.md", noteId: id, baseHash: base, to: "zajęta.md" },
    ]);
    await propose([{ op: "create", path: "ZAJĘTA.md", noteId: "", baseHash: "", text: "x" }]);
    const [move, create] = await listProposals(bridge);
    expect(move.stale).toEqual([false, true]);
    expect(create.stale).toEqual([true]);
    await expect(decideProposal(bridge, move, true)).rejects.toThrow(STALE_TEXT);
    const paths = ((await bridge.call("list_tree")) as { notes: { path: string }[] }).notes.map((n) => n.path).sort();
    expect(paths).toEqual(["Plan.md", "Zajęta.md"]); // the first change (a new note) was not applied either
  });

  it("a move to a free path is applied", async () => {
    const { bridge, id, propose, base } = await setUp();
    await propose([{ op: "move", path: "Plan.md", noteId: id, baseHash: base, to: "Archiwum/Plan.md" }]);
    await decideProposal(bridge, (await listProposals(bridge))[0], true);
    expect(((await bridge.call("list_tree")) as { notes: { id: string; path: string }[] }).notes.find((n) => n.id === id)?.path).toBe("Archiwum/Plan.md");
  });
});

describe("write modes of a chat's revisions", () => {
  async function setUpChat(mode: WriteMode, vaults?: { vaultId: string; writeMode: WriteMode }[]) {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, mode);
    if (vaults) {
      const { signature, ...cert } = await signCert({ ...chat.agent.cert, signature: undefined, signerUserId: undefined, vaults: vaults.map((v) => ({ ...v, whole: true as const, parts: [] })) }, member.signing);
      chat.agent = { ...chat.agent, cert: cert as AgentCert, signature: signature! };
    }
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    serve(() => undefined);
    return { bridge, author: { userId: MEMBER, agentId: chat.agent.agentId }, chat, member, owner };
  }

  it("none and proposals: even a revision that only adds is refused", async () => {
    for (const mode of ["none", "proposals"] as WriteMode[]) {
      const { bridge, author } = await setUpChat(mode);
      const id = await note(bridge, "Plan.md", "Tekst.");
      await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, " Więcej.") }), 4, author));
      expect(await textOf(bridge, id), mode).toBe("Tekst.");
      expect(bridge.syncState).toBe("error");
    }
  });

  it("append mode, edge cases: whitespace removed, text inserted in the middle, trash: refused; a new note, added whitespace: merged", async () => {
    const { bridge, author } = await setUpChat("append");
    const id = await note(bridge, "Plan.md", "Ala ma kota. ");
    let revision = 10;
    const send = async (snapshot: BrowserVaultSnapshot) => { await bridge.handleMessage(await frame(snapshot, ++revision, author)); return bridge.revision === revision; };
    expect(await send(chatState(bridge, { [id]: (t) => t.delete(t.length - 1, 1) }))).toBe(false); // only whitespace, still a change
    expect(await send(chatState(bridge, { [id]: (t) => t.insert(4, "nie ") }))).toBe(false);
    expect(await send(chatState(bridge, {}, (s) => { s.state.deleted = [...(s.state.deleted ?? []), { id, deletedAt: Date.now() + 1000 } as never]; }))).toBe(false);
    expect(await textOf(bridge, id)).toBe("Ala ma kota. ");
    expect(await send(chatState(bridge, { [id]: (t) => t.insert(t.length, "\n") }))).toBe(true);
    expect(await send(chatState(bridge, {}, (s) => {
      const doc = new Y.Doc(); doc.getText("content").insert(0, "Nowa.");
      s.state.notes.push({ id: "chat-new", path: "Nowa.md", yjsUpdateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)) });
    }))).toBe(true);
    expect(await textOf(bridge, "chat-new")).toBe("Nowa.");
  });

  it("append mode: a change of the organization (a group's members, a member's name, a field) is refused; new events pass", async () => {
    const { bridge, author } = await setUpChat("append");
    await note(bridge, "Plan.md", "Tekst.");
    const org = (s: BrowserVaultSnapshot) => s.state.organization as any;
    const base = chatState(bridge, {}, (s) => { org(s).groups = [{ id: "g1", name: "Zarząd", member_ids: [OWNER] }]; });
    // the group exists here first (as a person made it)
    bridge.mergeRemoteSnapshot(structuredClone(base));
    let revision = 20;
    const send = async (snapshot: BrowserVaultSnapshot) => { await bridge.handleMessage(await frame(snapshot, ++revision, author)); return bridge.revision === revision; };
    expect(await send(chatState(bridge, {}, (s) => { org(s).groups[0].member_ids.push(MEMBER); }))).toBe(false);
    expect(await send(chatState(bridge, {}, (s) => { org(s).fields = { ...org(s).fields, nowe: "x" }; }))).toBe(false);
    expect(await send(chatState(bridge, {}, (s) => { org(s).members = [...org(s).members, { user_id: "kto", name: "Ktoś", role: "Editor", name_changed_at: Date.now() }]; }))).toBe(false);
    expect(bridge.exportBrowserSnapshot(OWNER, VAULT).state.organization.groups[0].member_ids).toEqual([OWNER]);
    expect(await send(chatState(bridge, {}, (s) => { org(s).events.push({ event_id: "e-chat", time_ms: Date.now(), kind: "x" }); }))).toBe(true);
  });

  it("one cert, two spaces, two write modes: each space keeps its own", async () => {
    const OTHER = `v-${"e".repeat(32)}`;
    const { bridge, chat } = await setUpChat("direct", [{ vaultId: VAULT, writeMode: "append" }, { vaultId: OTHER, writeMode: "direct" }]);
    expect(await bridge.chatWriteMode(MEMBER, chat.agent.agentId)).toBe("append");
    bridge.info = { ...bridge.info, id: OTHER };
    expect(await bridge.chatWriteMode(MEMBER, chat.agent.agentId)).toBe("direct");
    bridge.info = { ...bridge.info, id: `v-${"c".repeat(32)}` }; // a space the cert does not name: no direct writing there
    expect(await bridge.chatWriteMode(MEMBER, chat.agent.agentId)).toBe("append");
  });

  it("a refusal is decided on the newest cert: a chat whose mode was widened meanwhile is not taken back", async () => {
    const { bridge, author, chat, member, owner } = await setUpChat("append");
    const id = await note(bridge, "Plan.md", "Tekst.");
    const { signature, ...wider } = await signCert({ ...chat.agent.cert, signature: undefined, signerUserId: undefined, vaults: [{ vaultId: VAULT, whole: true, parts: [], writeMode: "direct" }] }, member.signing);
    const fresh = { ...member.member, agents: [{ ...chat.agent, cert: wider as AgentCert, signature: signature! }] };
    serve((c) => (c.url === `/api/vaults/${VAULT}` ? json({ vault: vaultInfo, role: "owner", members: [owner.member, fresh], agentPolicy: bridge.agentPolicy }) : undefined));
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.delete(0, 1) }), 3, author));
    expect(await textOf(bridge, id)).toBe("ekst.");
  });

  it("an author whose agentId no list knows is held to the append mode", async () => {
    const { bridge } = await setUpChat("direct");
    const id = await note(bridge, "Plan.md", "Tekst.");
    const author = { userId: MEMBER, agentId: newAgentId() };
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.delete(0, 1) }), 3, author));
    expect(await textOf(bridge, id)).toBe("Tekst.");
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, "!") }), 4, author));
    expect(await textOf(bridge, id)).toBe("Tekst.!");
  });
});

describe("Cofnij zmiany czatu with people's changes in the same note (§7.2)", () => {
  async function setUp() {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, "direct");
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    serve(() => undefined);
    return { bridge, author: { userId: MEMBER, agentId: chat.agent.agentId }, agentId: chat.agent.agentId };
  }
  async function personEdits(bridge: any, id: string, edit: (t: Y.Text) => void) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await bridge.call("open_note", { id }));
    const vector = Y.encodeStateVector(doc);
    edit(doc.getText("content"));
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, vector) });
  }

  it("a person's later change elsewhere in the note stays; the chat's part goes; a second undo changes nothing", async () => {
    const { bridge, author, agentId } = await setUp();
    const id = await note(bridge, "A.md", "Wstęp.\nPlan.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, "\nOd Claude.") }), 1, author));
    await personEdits(bridge, id, (t) => t.insert(0, "Anna: "));
    expect(await undoAgentChanges(bridge, agentId, since)).toEqual({ notes: 1, conflicts: [] });
    expect(await textOf(bridge, id)).toBe("Anna: Wstęp.\nPlan.");
    expect(await undoAgentChanges(bridge, agentId, since)).toEqual({ notes: 0, conflicts: [] });
    expect(await textOf(bridge, id)).toBe("Anna: Wstęp.\nPlan.");
  });

  it("a person who changed the chat's own text: a conflict is shown and the note is left as it is", async () => {
    const { bridge, author, agentId } = await setUp();
    const id = await note(bridge, "A.md", "Plan.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, " Od Claude.") }), 1, author));
    await personEdits(bridge, id, (t) => t.insert(t.length - 1, " i Anny"));
    expect(await undoAgentChanges(bridge, agentId, since)).toEqual({ notes: 0, conflicts: ["A.md"] });
    expect(await textOf(bridge, id)).toBe("Plan. Od Claude i Anny.");
  });

  it("a person's change between two of the chat's revisions is not overwritten", async () => {
    const { bridge, author, agentId } = await setUp();
    const id = await note(bridge, "A.md", "Plan.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, " C1.") }), 1, author));
    await personEdits(bridge, id, (t) => t.insert(0, "Anna. "));
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, " C2.") }), 2, author));
    expect((await undoAgentChanges(bridge, agentId, since)).conflicts).toEqual(["A.md"]);
    expect(await textOf(bridge, id)).toBe("Anna. Plan. C1. C2.");
  });

  it("a note the chat put in the trash comes back with its text", async () => {
    const { bridge, author, agentId } = await setUp();
    const id = await note(bridge, "A.md", "Plan.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, {}, (s) => {
      const gone = s.state.notes.find((n) => n.id === id)!;
      s.state.notes = s.state.notes.filter((n) => n.id !== id);
      s.state.deleted = [...(s.state.deleted ?? []), { id, path: "A.md", deletedAt: Date.now() + 1000 }];
      s.state.trash = [...(s.state.trash ?? []), { id, path: "A.md", deletedAt: Date.now() + 1000, state: gone.yjsUpdateBase64 }];
    }), 1, author));
    expect(bridge.hasNote(id)).toBe(false);
    expect(await undoAgentChanges(bridge, agentId, since)).toEqual({ notes: 1, conflicts: [] });
    expect(await textOf(bridge, id)).toBe("Plan.");
  });
});

describe("dropChatKeys", () => {
  async function setUp(agents: MemberAgent[], fresh: MemberAgent[]) {
    const me = await person(OWNER, "owner");
    const bridge = await sharedBridge(me, [{ ...me.member, agents }]);
    const entry = { path: "Projekty/X", keyEpoch: 1, members: [OWNER], agentKeys: (fresh.length ? fresh : agents).map((a) => ({ agentId: a.agentId, userId: OWNER, sealedKey: {} })) };
    bridge.protectedEntries = new Map([[entry.path, entry]]);
    bridge.projectKeys = { get: () => ({}) };
    bridge.revokeProjectsFromChats = vi.fn(async () => undefined);
    const calls = serve((c) => (c.url === `/api/vaults/${VAULT}` ? json({ vault: vaultInfo, role: "owner", members: [{ ...me.member, agents: fresh }], agentPolicy: bridge.agentPolicy }) : undefined));
    return { bridge, calls };
  }

  it("a chat paired a moment ago (not in the list yet) keeps its project key: the list is loaded again first", async () => {
    const me = await person(OWNER, "owner");
    const chat = await chatOf(me, VAULT, "direct");
    const { bridge, calls } = await setUp([], [chat.agent]);
    await bridge.dropChatKeys();
    expect(calls.some((c) => c.url === `/api/vaults/${VAULT}`)).toBe(true);
    expect(bridge.revokeProjectsFromChats).not.toHaveBeenCalled();
    // and no refresh when every chat is known
    calls.length = 0;
    await bridge.dropChatKeys();
    expect(calls).toHaveLength(0);
  });

  it("a chat whose scope no longer has this vault loses the project key", async () => {
    const me = await person(OWNER, "owner");
    const chat = await chatOf(me, `v-${"a".repeat(32)}`, "direct");
    const { bridge } = await setUp([chat.agent], []);
    await bridge.dropChatKeys();
    expect(bridge.revokeProjectsFromChats).toHaveBeenCalledWith(["Projekty/X"], [chat.agent.agentId]);
  });
});

describe("signatures of chats: expired certs and events after a disconnect", () => {
  it("an event after the cert's expiry, or dated after the chat was disconnected, is unverified", async () => {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, "direct");
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    const late = await signAsAgent({ event_id: "late", time_ms: chat.agent.cert.expiresAt + 1, kind: "test" }, MEMBER, chat.agent.agentId, chat.keys.signSecret);
    const future = await signAsAgent({ event_id: "future", time_ms: Date.now() + 3_600_000, kind: "test" }, MEMBER, chat.agent.agentId, chat.keys.signSecret);
    bridge.signableEvents = () => [late, future];
    await bridge.verifyOrganization();
    expect(bridge.checks.get("late").status).toBe("unverified");
    expect(bridge.checks.get("future").status).toBe("ok");
    chat.agent.revokedAt = Date.now();
    await bridge.verifyOrganization();
    expect(bridge.checks.get("future").status).toBe("unverified");
  });
});

// ---- second round: moves undone, organization data in every mode, the member list for unknown chats, detached chats ----

describe("Cofnij zmiany czatu puts a moved note back", () => {
  async function setUp() {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, "direct");
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    serve(() => undefined);
    return { bridge, author: { userId: MEMBER, agentId: chat.agent.agentId }, agentId: chat.agent.agentId };
  }
  const moveTo = (id: string, path: string) => (s: BrowserVaultSnapshot) => {
    const n = s.state.notes.find((x) => x.id === id)!;
    n.path = path; n.pathChangedAt = Date.now() + 1000;
  };
  const pathOf = async (b: any, id: string) => ((await b.call("list_tree")) as { notes: { id: string; path: string }[] }).notes.find((n) => n.id === id)?.path;

  it("a note the chat moved (and changed) goes back to its path and text", async () => {
    const { bridge, author, agentId } = await setUp();
    const id = await note(bridge, "Spotkania/Plan.md", "Plan.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, { [id]: (t) => t.insert(t.length, " C.") }, moveTo(id, "Archiwum/Plan.md")), 1, author));
    expect(await pathOf(bridge, id)).toBe("Archiwum/Plan.md");
    expect(await undoAgentChanges(bridge, agentId, since)).toEqual({ notes: 1, conflicts: [] });
    expect(await pathOf(bridge, id)).toBe("Spotkania/Plan.md");
    expect(await textOf(bridge, id)).toBe("Plan.");
  });

  it("moved again by a person, or the old path taken meanwhile: the path stays and is listed as a conflict", async () => {
    const { bridge, author, agentId } = await setUp();
    const a = await note(bridge, "A.md", "A.");
    const b = await note(bridge, "B.md", "B.");
    const since = Date.now() - 1;
    await bridge.handleMessage(await frame(chatState(bridge, {}, (s) => { moveTo(a, "Inne/A.md")(s); moveTo(b, "Inne/B.md")(s); }), 1, author));
    await bridge.call("rename", { id: a, path: "Moje/A.md" });
    await note(bridge, "b.md", "Ktoś zajął.");
    const result = await undoAgentChanges(bridge, agentId, since);
    expect(result.conflicts.sort()).toEqual(["Inne/B.md", "Moje/A.md"]);
    expect(await pathOf(bridge, a)).toBe("Moje/A.md");
    expect(await pathOf(bridge, b)).toBe("Inne/B.md");
  });
});

describe("organization data in every write mode (§6)", () => {
  it("direct: a group's members, a member's name or a field changed by a chat refuses the revision; task events pass", async () => {
    const owner = await person(OWNER, "owner"), member = await person(MEMBER, "editor");
    const chat = await chatOf(member, VAULT, "direct");
    member.member.agents = [chat.agent];
    const bridge = await sharedBridge(owner, [owner.member, member.member]);
    serve(() => undefined);
    const author = { userId: MEMBER, agentId: chat.agent.agentId };
    const id = await note(bridge, "Plan.md", "Tekst.");
    const org = (s: BrowserVaultSnapshot) => s.state.organization as any;
    bridge.mergeRemoteSnapshot(chatState(bridge, {}, (s) => { org(s).groups = [{ id: "g1", name: "Zarząd", member_ids: [OWNER] }]; }));
    let revision = 30;
    const send = async (snapshot: BrowserVaultSnapshot) => { await bridge.handleMessage(await frame(snapshot, ++revision, author)); return bridge.revision === revision; };
    expect(await send(chatState(bridge, { [id]: (t) => t.delete(0, 1) }, (s) => { org(s).groups[0].member_ids.push(MEMBER); }))).toBe(false);
    expect(await send(chatState(bridge, {}, (s) => { org(s).fields = { ...org(s).fields, nowe: "x" }; }))).toBe(false);
    expect(await send(chatState(bridge, {}, (s) => { org(s).aliases = { [MEMBER]: ["Szef"] }; }))).toBe(false);
    expect(await textOf(bridge, id)).toBe("Tekst.");
    expect(bridge.exportBrowserSnapshot(OWNER, VAULT).state.organization.groups[0].member_ids).toEqual([OWNER]);
    expect(await send(chatState(bridge, { [id]: (t) => t.delete(0, 1) }, (s) => { org(s).events.push({ event_id: "e-chat", time_ms: Date.now(), kind: "x" }); }))).toBe(true);
    expect(await textOf(bridge, id)).toBe("ekst.");
  });
});

describe("dropChatKeys: the member list for unknown chats", () => {
  async function setUp(keyUser: string, manage: boolean) {
    const me = await person(OWNER, "owner");
    const bridge = await sharedBridge(me, [{ ...me.member, agents: [] }]);
    const entry = { path: "Projekty/X", keyEpoch: 1, members: [OWNER, keyUser], agentKeys: [{ agentId: newAgentId(), userId: keyUser, sealedKey: {} }] };
    bridge.protectedEntries = new Map([[entry.path, entry]]);
    bridge.projectKeys = { get: () => ({}) };
    bridge.canManage = vi.fn(async () => manage);
    bridge.revokeProjectsFromChats = vi.fn(async () => undefined);
    const calls = serve((c) => (c.url === `/api/vaults/${VAULT}` ? json({ vault: vaultInfo, role: "owner", members: [{ ...me.member, agents: [] }], agentPolicy: bridge.agentPolicy }) : undefined));
    return { bridge, calls, entry };
  }
  const fetched = (calls: Call[]) => calls.filter((c) => c.url === `/api/vaults/${VAULT}`).length;

  it("a device that cannot take the key away never loads the list for it", async () => {
    const { bridge, calls } = await setUp(MEMBER, false);
    await bridge.dropChatKeys();
    await bridge.dropChatKeys();
    expect(fetched(calls)).toBe(0);
    expect(bridge.revokeProjectsFromChats).not.toHaveBeenCalled();
  });

  it("a device that can: loads it once, takes the gone chat away, and not again within 10 minutes", async () => {
    const { bridge, calls, entry } = await setUp(MEMBER, true);
    await bridge.dropChatKeys();
    expect(fetched(calls)).toBe(1);
    expect(bridge.revokeProjectsFromChats).toHaveBeenCalledWith(["Projekty/X"], [entry.agentKeys[0].agentId]);
    bridge.revokeProjectsFromChats.mockClear();
    await bridge.dropChatKeys();
    expect(fetched(calls)).toBe(1);
    expect(bridge.revokeProjectsFromChats).not.toHaveBeenCalled(); // an unknown chat on an old list is never taken for gone
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    await bridge.dropChatKeys();
    expect(fetched(calls)).toBe(2);
  });
});

describe("a chat an admin took out of this organization", () => {
  it("its proposal here is shown with the reason and cannot be approved; its other spaces stay", async () => {
    const me = await person(OWNER, "owner");
    const chat = await chatOf(me, VAULT, "proposals");
    const bridge = await sharedBridge(me, [me.member]);
    const id = await note(bridge, "Plan.md", "Plan.");
    const proposal = await sealProposal({ createdAt: Date.now(), summary: "z", changes: [{ op: "edit", path: "Plan.md", noteId: id, baseHash: await textHash("Plan."), text: "Inny." }] },
      { vaultId: VAULT, agentId: chat.agent.agentId, userId: OWNER, personBoxKey: me.box.publicJwk, signSecret: chat.keys.signSecret });
    let scopes = [{ vaultId: VAULT, ownScope: {} }, { vaultId: personalVaultId(OWNER), ownScope: {} }];
    const calls = serve((c) => {
      if (c.url === "/api/me/agents") return json({ agents: [{ ...chat.agent, scopes }] });
      if (c.url === `/api/vaults/${VAULT}/proposals`) return json({ proposals: [{ proposalId: proposal.proposalId, agentId: chat.agent.agentId, createdAt: 1, expiresAt: 2e12, state: "open", proposal }] });
      return undefined;
    });
    const [view] = await listProposals(bridge);
    expect(view.problem).toBeNull();
    scopes = scopes.filter((x) => x.vaultId !== VAULT);
    await expect(decideProposal(bridge, view, true)).rejects.toThrow(DETACHED_TEXT);
    expect((await listProposals(bridge))[0].problem).toBe(DETACHED_TEXT);
    expect(await textOf(bridge, id)).toBe("Plan.");
    expect(calls.some((c) => c.url.endsWith("/decision"))).toBe(false);
  });
});
