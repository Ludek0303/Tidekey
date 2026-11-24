// A fake notes-node for the tests: it follows the chat contract (WEB-WSPOLDZIELENIE.md "Claude chats"), checks every
// request proof, and makes real ciphertexts with the browser's own functions (ui/src).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import * as Y from "yjs";
import { MockBridge, type BrowserVaultSnapshot } from "../../ui/src/bridge";
import { decryptSnapshot, encryptSnapshot, type Envelope } from "../../ui/src/browserauth";
import { blake2bHex, fromB64u, generateAgentKeys, newAgentId, projectSlot, sealForAgent, sealScope, signCert, type AgentKeyPair, type AgentScope, type WriteMode } from "../../ui/src/agentcrypto";
import { payloadOf, sealPayload, type ProtectedEntry } from "../../ui/src/protected";
import { importVaultKey } from "../../ui/src/vaults";
import type { SigningIdentity } from "../../ui/src/signing";
import { AgentClient } from "../src/client";
import { Session } from "../src/session";
import { LocalState } from "../src/state";
import { Tools, type Ask } from "../src/tools";
import { noteText } from "../src/session";

export const ORIGIN = "https://notatki.test";
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
type Seed = { path: string; text: string };

export interface VaultOptions {
  notes: Seed[];
  writeMode?: WriteMode;
  scope?: Partial<Pick<AgentScope, "include" | "exclude" | "tools" | "tasks" | "updatedAt">>;
  projects?: { path: string; notes: Seed[]; forChat: boolean }[];
  /** A personal vault (browser-<userId>) instead of a shared one. */
  personal?: boolean;
  name?: string;
}
export interface WorldOptions extends VaultOptions {
  latest?: string;
  /** More vaults in the same cert (each with its own key, scope and write mode). */
  others?: VaultOptions[];
}
export interface Logged { method: string; path: string; headers: Record<string, string>; body: string }

export async function identity(userId: string): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { userId, privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

function snapshotOf(seeds: Seed[], vaultId: string, owner: string, name: string, personal = false): BrowserVaultSnapshot {
  const bridge = new MockBridge(seeds);
  if (personal) bridge.setBrowserAccount(owner, "", undefined, "Anna");
  else {
    bridge.setBrowserAccount(owner, "", { id: vaultId, name, kind: "organizacja", ownerUserId: owner });
    bridge.setMembers([{ userId: owner, email: "", name: "Anna", role: "owner" }]);
  }
  return bridge.exportBrowserSnapshot(owner, vaultId);
}

export async function makeWorld(o: WorldOptions) {
  await sodium.ready;
  const userId = "u-anna";
  const person = await identity(userId);
  const box = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const boxJwk = await crypto.subtle.exportKey("jwk", box.publicKey);
  const chat: AgentKeyPair = await generateAgentKeys();
  const agentId = newAgentId();
  const token = crypto.getRandomValues(new Uint8Array(32));
  const tokenHex = Array.from(token, (b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const options = [o, ...(o.others ?? [])];

  const makeVault = async (v: VaultOptions, i: number) => {
    const vaultId = v.personal ? `browser-${userId}` : `v-${hex(16)}`;
    const name = v.name ?? (i === 0 ? "Klub" : `Klub ${i + 1}`);
    const kind = v.personal ? "notatki" : "organizacja";
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importVaultKey(raw);
    const scope: AgentScope = { schema: "notes-agent-scope-v1", agentId, vaultId, include: [], exclude: [], tools: [], tasks: "all", updatedAt: now, ...v.scope };
    const meta = {
      vault: { id: vaultId, name, kind, ownerUserId: userId, keyEpoch: 1 }, role: "editor", writeMode: v.writeMode ?? "direct",
      agentKeys: [{ keyEpoch: 1, sealedKey: await sealForAgent(raw, chat.boxKey, vaultId, "vault", 1) }],
      sealedScope: await sealScope(scope, person, chat.boxKey),
      person: { userId, signingKey: person.publicJwk, boxKey: boxJwk },
      members: [{ userId, name: "Anna", role: "owner", signingKey: person.publicJwk }],
      allowProtected: true,
    };
    const snapshot = snapshotOf(v.notes, vaultId, userId, name, v.personal);
    const projectKeys: { path: string; raw: Uint8Array }[] = [];
    if (v.projects?.length) {
      snapshot.state.protected = [];
      for (const p of v.projects) {
        const pRaw = crypto.getRandomValues(new Uint8Array(32));
        projectKeys.push({ path: p.path, raw: pRaw });
        const payload = payloadOf(snapshotOf(p.notes, vaultId, userId, name, v.personal).state, p.path);
        const entry: ProtectedEntry & { agentKeys: unknown[] } = {
          path: p.path, keyEpoch: 1, members: [userId], keys: [], envelope: await sealPayload(vaultId, p.path, 1, await importVaultKey(pRaw), payload),
          agentKeys: p.forChat ? [{ agentId, userId, sealedKey: await sealForAgent(pRaw, chat.boxKey, vaultId, projectSlot(p.path), 1) }] : [],
        };
        snapshot.state.protected.push(entry);
      }
    }
    /** The vault's current key: rotate() moves it to a new epoch. */
    const current = { raw, key, epoch: 1 };
    return {
      vaultId, name, raw, key, scope, meta, projectKeys, current, writeMode: meta.writeMode, cert: { vaultId, whole: true as const, parts: [], writeMode: v.writeMode ?? "direct" },
      /** Listed in GET /api/agent/me (false: the server leaves it out, as for a vault out of scope); named in the cert. */
      listed: true, inCert: true,
      store: { revision: 1, envelope: await encryptSnapshot(snapshot, key, 1) },
    };
  };
  const vaults: Awaited<ReturnType<typeof makeVault>>[] = [];
  for (const [i, v] of options.entries()) vaults.push(await makeVault(v, i));
  const certBody = () => ({ schema: "notes-agent-cert-v1" as const, agentId, userId, signKey: chat.signKey, boxKey: chat.boxKey, vaults: vaults.filter((v) => v.inCert).map((v) => v.cert), createdAt: now, expiresAt: now + 30 * 86_400_000 });
  let cert = await signCert(certBody(), person);
  const primary = vaults[0];
  const server = Object.assign(primary.store, {
    proposals: [] as unknown[], log: [] as Logged[],
    /** Forced answers for the next requests (status and JSON body). */
    next: [] as { status: number; body: unknown }[],
    sessionExpiresAt: now + 4 * 3_600_000, latest: o.latest ?? "1.0.0",
  });

  const verify = async (method: string, path: string, headers: Record<string, string>, body: Uint8Array): Promise<boolean> => {
    const message = `notes-agent-req-v1\n${method}\n${path}\n${await blake2bHex(body)}\n${headers["notes-agent-time"]}\n${headers["notes-agent-nonce"]}\n${headers["notes-agent-version"]}`;
    try { return sodium.crypto_sign_verify_detached(fromB64u(headers["notes-agent-proof"]), new TextEncoder().encode(message), fromB64u(chat.signKey)); } catch { return false; }
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const scopeHash = async (sealed: unknown) => blake2bHex(new TextEncoder().encode(JSON.stringify(sealed)));

  const fetchFn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = url.pathname + url.search;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes = init.body ? (init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body))) : new Uint8Array();
    const body = new TextDecoder().decode(bytes);
    server.log.push({ method, path, headers, body });
    if (url.pathname === "/api/version") return json(200, { server: "test", agentMin: "1.0.0", agentLatest: server.latest, agentsDisabled: false, update: { npm: "npx --yes @notatki/mcp@9.9.9" } });
    const forced = server.next.shift();
    if (forced) return forced.body === RAW_NULL ? new Response("null", { status: forced.status }) : json(forced.status, forced.body);
    if (!(await verify(method, path, headers, bytes))) return json(401, { code: "proof", message: "x" });
    if (headers.authorization !== `NotesAgent ${tokenHex}`) return json(401, { code: "session", message: "x" });
    if (method === "GET" && url.pathname === "/api/agent/me") {
      const listed = vaults.filter((v) => v.listed);
      return json(200, { agentId, userId, cert: { ...cert, signature: undefined }, signature: cert.signature, sessionExpiresAt: server.sessionExpiresAt,
        vaults: await Promise.all(listed.map(async (v) => ({ vaultId: v.vaultId, name: v.name, kind: v.meta.vault.kind, role: "editor", writeMode: v.meta.writeMode, scopeHash: await scopeHash(v.meta.sealedScope) }))) });
    }
    const vault = vaults.find((v) => v.listed && url.pathname.startsWith(`/api/agent/vaults/${v.vaultId}`));
    if (!vault) return json(404, { code: "scope", message: "x" });
    const base = `/api/agent/vaults/${vault.vaultId}`;
    const { meta, store } = vault;
    if (method === "GET" && url.pathname === base) return json(200, meta);
    if (method === "GET" && url.pathname === `${base}/snapshot`) {
      const since = url.searchParams.get("since");
      return json(200, { revision: store.revision, envelope: since !== null && Number(since) === store.revision ? null : store.envelope, author: null });
    }
    if (method === "POST" && url.pathname === `${base}/snapshot`) {
      if (meta.writeMode !== "append" && meta.writeMode !== "direct") return json(403, { code: "read-only", message: "x" });
      const put = JSON.parse(body) as { baseRevision: number; envelope: Envelope };
      if (put.envelope.keyEpoch !== meta.vault.keyEpoch) return json(409, { code: "stale-key", message: "x" });
      if (put.baseRevision !== store.revision) return json(409, { code: "conflict", message: "x", revision: store.revision, envelope: store.envelope });
      store.envelope = put.envelope;
      store.revision++;
      return json(200, { revision: store.revision });
    }
    if (method === "POST" && url.pathname === `${base}/proposals`) {
      if (meta.writeMode === "none") return json(403, { code: "read-only", message: "x" });
      const { proposal } = JSON.parse(body) as { proposal: { proposalId: string } };
      server.proposals.push(proposal);
      return json(201, { proposalId: proposal.proposalId });
    }
    return json(404, { code: "scope", message: "x" });
  }) as typeof fetch;

  type Vault = (typeof vaults)[number];
  const decrypted = (v: Vault = primary) => decryptSnapshot(v.store.envelope, userId, v.vaultId, v.current.key);
  /** Changes the stored snapshot of a vault directly (fields the engine does not model) and makes a new revision. */
  const mutate = async (change: (s: BrowserVaultSnapshot) => void | Promise<void>, v: Vault = primary) => {
    const s = await decrypted(v);
    await change(s);
    v.store.envelope = await encryptSnapshot(s, v.current.key, v.current.epoch);
    v.store.revision++;
  };
  /** The texts the server holds now, by path (plain notes only). */
  const texts = async (v: Vault = primary): Promise<Map<string, string>> => {
    const s = await decrypted(v);
    return new Map(s.state.notes.map((n) => [n.path, noteText(n.yjsUpdateBase64)]));
  };
  /** Another member's edit on the server (a newer revision the chat has not read). */
  const editOnServer = async (seedChange: (b: MockBridge) => Promise<void>, v: Vault = primary) => {
    const b = new MockBridge([]);
    if (v.vaultId.startsWith("browser-")) b.setBrowserAccount(userId, "", undefined, "Anna");
    else b.setBrowserAccount(userId, "", { id: v.vaultId, name: v.name, kind: "organizacja", ownerUserId: userId });
    const before = await decrypted(v);
    b.mergeBrowserSnapshot(before);
    await seedChange(b);
    const after = b.exportBrowserSnapshot(userId, v.vaultId);
    if (before.state.protected) after.state.protected = before.state.protected;
    v.store.envelope = await encryptSnapshot(after, v.current.key, v.current.epoch);
    v.store.revision++;
  };
  /** A human edit of one note's text on the server (Yjs, like the app). */
  const editNoteOnServer = (path: string, edit: (t: Y.Text) => void, v: Vault = primary) => editOnServer(async (b) => {
    const tree = await b.call<{ notes: { id: string; path: string }[] }>("list_tree");
    const id = tree.notes.find((n) => n.path === path)!.id;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
    const sv = Y.encodeStateVector(doc);
    edit(doc.getText("content"));
    await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, sv) });
  }, v);
  /** Rotates the vault key: a new epoch, the snapshot encrypted with it; sealed for the chat only when `forChat`. */
  const rotate = async (forChat: boolean, v: Vault = primary) => {
    const s = await decrypted(v);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const epoch = v.current.epoch + 1;
    Object.assign(v.current, { raw, key: await importVaultKey(raw), epoch });
    v.meta.vault.keyEpoch = epoch;
    if (forChat) v.meta.agentKeys.push({ keyEpoch: epoch, sealedKey: await sealForAgent(raw, chat.boxKey, v.vaultId, "vault", epoch) });
    v.store.envelope = await encryptSnapshot(s, v.current.key, epoch);
    v.store.revision++;
  };
  /** A new cert signed by the person (e.g. after the scope screen changed the vaults or modes). */
  const resign = async () => { cert = await signCert(certBody(), person); };

  const stateDir = mkdtempSync(join(tmpdir(), "notatki-mcp-test-"));
  const start = (ask?: Ask, stateDirOverride = stateDir, now?: () => number) => {
    const state = new LocalState(stateDirOverride);
    const keys = { agentId, signKey: chat.signKey, boxKey: chat.boxKey, signSecret: Uint8Array.from(chat.signSecret), boxSecret: Uint8Array.from(chat.boxSecret) };
    const client = new AgentClient({ origin: ORIGIN, signSecret: keys.signSecret, token: Uint8Array.from(token), fetch: fetchFn, now });
    const session = new Session(client, keys, state, ORIGIN, now);
    return { state, session, tools: new Tools(session, state, ask, now), client };
  };
  const { vaultId, raw, key, meta, scope, projectKeys } = primary;
  return {
    server, meta, scope, person, box, chat, agentId, token, tokenHex, raw, key, vaultId, userId, fetchFn, texts, editOnServer, editNoteOnServer, mutate, rotate, resign, decrypted,
    vaults, stateDir, start, projectKeys, sealScopeAgain: (s: AgentScope, v: Vault = primary) => sealScope({ ...s, vaultId: v.vaultId }, person, chat.boxKey),
  };
}

/** A forced answer whose body is the JSON literal null. */
export const RAW_NULL = Symbol("null");
/** The text of a tool result, and its wrapped data part. */
export const textOf = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");
