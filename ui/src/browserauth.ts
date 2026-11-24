import * as Y from "yjs";
import { MockBridge, canonicalJson, mergeOrganizationSnapshots, type BrowserVaultSnapshot, type Bridge, type ProjectProtection, type TrashEntry, type TreeListing } from "./bridge";
import { loadSigningIdentity, signEvent, verifySigned, verifyEvents, type EventCheck, type SignerAgent, type SignerMember, type SigningIdentity } from "./signing";
import { projectSlot as chatSlot, sealForAgent, verifyCert, type WriteMode } from "./agentcrypto";
import { PROTECTED_FILE_TEXT } from "./folderfiles";
const FILES_BEFORE_PROTECT_TEXT = "W tym folderze leżą pliki. Przenieś je do notatki albo do innego folderu, zanim go ochronisz.";
import { LEAD_SCHEMA, TOP_TEXT, ancestorsOf, dropFolders, dropIds, inside, landsTop, noteIdsOf, openPayload, payloadKey, payloadOf, scrubDeleted, sealPayload, under, validEntry, type LeadAppointment, type ProtectedEntry, type ProtectedMark, type ProtectedPayload } from "./protected";
import { parentOf } from "./tree";
import { asBoxPublicKey, loadBoxIdentity, openSealed, sealTo, type BoxIdentity } from "./sealed";
import type { ModuleData } from "./records";
import type { OrganizationSnapshot } from "./taskhistory";
import { ORG_AGENT_POLICY, READ_ONLY_TEXT, ApiError, type AgentPolicy, api, deleteAgent, disconnectMemberAgent, fetchPersonalKeys, listMyAgents, type AgentKeyOut, putPersonalKey, unwrapPersonalVaultKey, wrapPersonalVaultKey, bufferSource, base64ToBytes, bytesToBase64, fetchVault, hasInviteParam, importVaultKey, isSharedVaultId, openAccess, parseInviteHref, personalAccess, personalVaultId, putMyKey, putMyProfile, randomVaultKey, adoptPending, completeAssignment, listAssignments, listSharedVaults, personalAllowed, personalNotesControl, type PersonalState, rememberVault, rememberedVault, rotateVaultKey, runInvite, unwrapVaultKey, unwrapBytes, wrapBytes, wrapVaultKey, type KeyEnvelope, type RemoteMember, type Role, type VaultAccess, type VaultDetail, type VaultInfo } from "./vaults";
import { keepLastName, openLastName, openProfile, profileChange, sealLastName } from "./profile";
import { errorText, openDialog, toast } from "./widgets";
import { RemoteFileStore, migrateAttachments, type ProjectRef } from "./remotefiles";
import { keySecret } from "./filecrypto";
import { browserSpaces } from "./allspaces";
import { linkOfNote, validLink } from "./github/link";
import { setGithubService } from "./github/service";
import { createGithubService, type BrowserGithubService } from "./github/browser-service";
import { githubToken, preferencesLoaded, setGithubToken } from "./preferences";
import { setGithubGuard } from "./noteindex";

// lastName: the legacy plaintext copy (cleared once moved); profileSecret: the encrypted one (profile.ts).
export interface BrowserUser { id: string; email: string; name: string; lastName?: string; profileSecret?: KeyEnvelope | null; preferences?: KeyEnvelope | null; personal?: PersonalState }
// registration: who may sign up on this server (signed-out replies only); missing on older servers.
interface AuthMe { authenticated: boolean; user?: BrowserUser; registration?: "open" | "invite" | "closed" }
// keyEpoch: the vault key epoch the snapshot is encrypted with (shared vaults only; Stage E).
export interface Envelope { schema: "notes-encrypted-v1"; nonce: string; ciphertext: string; keyEpoch?: number }
interface Stored { userId: string; vaultId: string; envelope: Envelope; revision: number; updatedAt: number }
const DB_NAME = "notes-browser-local-v1";
// How often an owner's or admin's open organization looks for assignments to complete (besides once on open).
const ASSIGNMENTS_EVERY = 5 * 60_000;
// Version 3 adds `vaults`, one record per (user, vault). `workspaces` (one record per user, the personal vault) stays readable.
// Version 4 adds `epochKeys`: the vault keys of older epochs, wrapped with the personal key (Stage E).
// Version 5 adds `projectKeys`: the protected project keys this user holds, wrapped with the personal key (Stage E).
const DB_VERSION = 5;
const PROJECT_KEYS = "projectKeys";
const WORKSPACES = "workspaces";
const VAULTS = "vaults";
const KEYS = "keys";
const EPOCH_KEYS = "epochKeys";
const VAULT_SCHEMA = "notes-encrypted-v1";
// Text edits reach the others at once as live deltas (relay), so the full snapshot that keeps the server's copy can wait:
// SLOW after a pause in typing, at most SLOW_MAX. Other changes (a new note, a rename) go FAST, since only the snapshot
// carries them.
const PERSIST = { fast: { pause: 200, max: 1000 }, slow: { pause: 2000, max: 10_000 } };
const RELAY_SCHEMA = "notes-relay-v1";
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORKSPACES)) db.createObjectStore(WORKSPACES, { keyPath: "userId" });
      if (!db.objectStoreNames.contains(VAULTS)) db.createObjectStore(VAULTS, { keyPath: ["userId", "vaultId"] });
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: "userId" });
      if (!db.objectStoreNames.contains(EPOCH_KEYS)) db.createObjectStore(EPOCH_KEYS, { keyPath: ["userId", "vaultId", "keyEpoch"] });
      if (!db.objectStoreNames.contains(PROJECT_KEYS)) db.createObjectStore(PROJECT_KEYS, { keyPath: ["userId", "vaultId"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Nie udało się otworzyć lokalnego magazynu."));
  });
}
function transaction<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode); const req = run(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transakcja lokalna została przerwana."));
  });
}
// The record a vault opens from. The personal vault falls back to the legacy per-user record until a record exists in
// `vaults` (the first save there supersedes it). Pure, so the migration can be tested on its own.
export function pickStored(vaultRecord: Stored | undefined, legacy: Stored | undefined, userId: string, vaultId: string): Stored | undefined {
  if (vaultRecord) return vaultRecord;
  if (legacy && vaultId === personalVaultId(userId)) return { ...legacy, vaultId };
  return undefined;
}
export async function readStored(db: IDBDatabase, userId: string, vaultId: string): Promise<Stored | undefined> {
  const [own, legacy] = await Promise.all([
    transaction<Stored | undefined>(db, VAULTS, "readonly", (s) => s.get([userId, vaultId])),
    transaction<Stored | undefined>(db, WORKSPACES, "readonly", (s) => s.get(userId)),
  ]);
  return pickStored(own, legacy, userId, vaultId);
}
interface KeyRecord { userId: string; key: CryptoKey; pendingRecoveryCode?: string }
function readKeyRecord(db: IDBDatabase, userId: string): Promise<KeyRecord | undefined> { return transaction(db, KEYS, "readonly", (s) => s.get(userId)); }
async function writeKey(db: IDBDatabase, userId: string, key: CryptoKey, pendingRecoveryCode?: string): Promise<void> { await transaction(db, KEYS, "readwrite", (s) => s.put({ userId, key, pendingRecoveryCode } satisfies KeyRecord)); }
async function clearPendingRecoveryCode(db: IDBDatabase, userId: string, key: CryptoKey): Promise<void> { await writeKey(db, userId, key); }
// The keys of older epochs of one vault, by epoch (raw bytes for re-wrapping, and the imported key for decryption).
type Keyring = Map<number, { raw: Uint8Array; key: CryptoKey }>;
interface EpochKeyRecord { userId: string; vaultId: string; keyEpoch: number; wrapped: KeyEnvelope }
async function putEpochKey(db: IDBDatabase, userId: string, vaultId: string, keyEpoch: number, raw: Uint8Array, personal: CryptoKey): Promise<void> {
  const wrapped = await wrapBytes(raw, personal);
  await transaction(db, EPOCH_KEYS, "readwrite", (s) => s.put({ userId, vaultId, keyEpoch, wrapped } satisfies EpochKeyRecord));
}
export async function readEpochKeys(db: IDBDatabase, userId: string, vaultId: string, personal: CryptoKey): Promise<Keyring> {
  const rows = await transaction<EpochKeyRecord[]>(db, EPOCH_KEYS, "readonly", (s) => s.getAll(IDBKeyRange.bound([userId, vaultId, 0], [userId, vaultId, Number.MAX_SAFE_INTEGER])));
  const ring: Keyring = new Map();
  for (const row of rows) { const raw = await unwrapVaultKey(row.wrapped, personal); ring.set(row.keyEpoch, { raw, key: await importVaultKey(raw) }); }
  return ring;
}
// A protected project's key this user holds, by project and epoch. `raw` is kept to seal it to new members.
interface ProjectKey { path: string; keyEpoch: number; raw: Uint8Array; key: CryptoKey }
const projectSlot = (path: string, keyEpoch: number): string => `${path}\0${keyEpoch}`;
interface ProjectKeyRecord { userId: string; vaultId: string; wrapped: KeyEnvelope }
// What this device last verified of a protected entry (who is in it, who edits, its lead): the baseline the next
// change of it is checked against, kept across reloads so a change flagged once is not trusted after a reload.
// `keys` and `agentKeys`: a chat may sign an entry only when these stay exactly as verified (docs/MCP.md §6).
type Baseline = Pick<ProtectedEntry, "path" | "keyEpoch" | "members" | "editors" | "lead" | "keys" | "agentKeys">;
// All of a vault's project keys and baselines in one record: one JSON document, wrapped with the personal key. An older
// record is a bare array of keys.
async function writeProjectKeys(db: IDBDatabase, userId: string, vaultId: string, keys: Map<string, ProjectKey>, personal: CryptoKey, trusted: Map<string, Baseline>): Promise<void> {
  const items = [...keys.values()].map(({ path, keyEpoch, raw }) => ({ path, keyEpoch, raw: bytesToBase64(raw) }));
  const wrapped = await wrapBytes(new TextEncoder().encode(JSON.stringify({ keys: items, trusted: [...trusted.values()] })), personal);
  await transaction(db, PROJECT_KEYS, "readwrite", (s) => s.put({ userId, vaultId, wrapped } satisfies ProjectKeyRecord));
}
async function readProjectKeys(db: IDBDatabase, userId: string, vaultId: string, personal: CryptoKey): Promise<{ keys: Map<string, ProjectKey>; trusted: Map<string, Baseline> }> {
  const keys = new Map<string, ProjectKey>();
  const trusted = new Map<string, Baseline>();
  const row = await transaction<ProjectKeyRecord | undefined>(db, PROJECT_KEYS, "readonly", (s) => s.get([userId, vaultId]));
  if (!row) return { keys, trusted };
  type Item = { path: string; keyEpoch: number; raw: string };
  const value = JSON.parse(new TextDecoder().decode(await unwrapBytes(row.wrapped, personal))) as Item[] | { keys: Item[]; trusted?: Baseline[] };
  const items = Array.isArray(value) ? value : value.keys;
  for (const item of items) {
    const raw = base64ToBytes(item.raw);
    keys.set(projectSlot(item.path, item.keyEpoch), { path: item.path, keyEpoch: item.keyEpoch, raw, key: await importVaultKey(raw) });
  }
  for (const b of Array.isArray(value) ? [] : value.trusted ?? []) trusted.set(b.path, b);
  return { keys, trusted };
}
function writeStored(db: IDBDatabase, item: Stored): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULTS, "readwrite"); tx.objectStore(VAULTS).put(item);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("Zapis lokalny został przerwany."));
  });
}
const toHex = (b: Uint8Array): string => [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
function hexBytes(s: string): Uint8Array { if (!/^[a-f\d]{64}$/i.test(s)) throw new Error("Kod odzyskiwania musi mieć 64 znaki szesnastkowe."); return Uint8Array.from(s.match(/.{2}/g)!, (x) => parseInt(x,16)); }
export async function keyFromRecovery(code: string): Promise<CryptoKey> { return crypto.subtle.importKey("raw", bufferSource(hexBytes(code)), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); }
export async function newRecoveryKey(): Promise<{ key: CryptoKey; code: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { key: await crypto.subtle.importKey("raw", bufferSource(raw), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]), code: toHex(raw) };
}
function aad(ownerUserId: string, vaultId: string): Uint8Array { return new TextEncoder().encode(`${VAULT_SCHEMA}\0${ownerUserId}\0${vaultId}`); }
// The snapshot is gzipped before it is encrypted (ciphertext doesn't compress). A plain one starts with "{", a gzipped
// one with 1f 8b, so older uncompressed copies still read.
async function through(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // written while the output is read: the write only completes as it drains, and a failed write fails the whole call
  const writing = writer.write(new Uint8Array(bufferSource(bytes))).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reading = (async () => { for (const reader = transform.readable.getReader(); ;) { const { done, value } = await reader.read(); if (done) return; chunks.push(value); } })();
  await Promise.all([writing, reading]);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
  return out;
}
const gzipped = (raw: Uint8Array): boolean => raw[0] === 0x1f && raw[1] === 0x8b;

export async function encryptSnapshot(snapshot: BrowserVaultSnapshot, key: CryptoKey, keyEpoch?: number): Promise<Envelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const payload = await through(new TextEncoder().encode(JSON.stringify(snapshot)), new CompressionStream("gzip"));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), additionalData: bufferSource(aad(snapshot.vault.ownerUserId, snapshot.vault.id)), tagLength: 128 }, key, bufferSource(payload));
  if (cipher.byteLength + nonce.byteLength > MAX_ENVELOPE_BYTES) throw new Error("Przestrzeń przekracza limit synchronizacji 16 MiB.");
  return { schema: VAULT_SCHEMA, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)), ...(keyEpoch === undefined ? {} : { keyEpoch }) };
}
interface RelayPayload { schema: typeof RELAY_SCHEMA; notes: { id: string; update: string }[] }
// Live deltas have their own AAD, so a delta can never pass for a snapshot or the other way round.
const relayAad = (vault: { ownerUserId: string; id: string }) => new TextEncoder().encode(`${RELAY_SCHEMA}\0${vault.ownerUserId}\0${vault.id}`);
async function sealRelay(payload: RelayPayload, vault: { ownerUserId: string; id: string }, key: CryptoKey, keyEpoch?: number): Promise<Envelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), additionalData: bufferSource(relayAad(vault)), tagLength: 128 }, key, bufferSource(new TextEncoder().encode(JSON.stringify(payload))));
  return { schema: VAULT_SCHEMA, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)), ...(keyEpoch === undefined ? {} : { keyEpoch }) };
}
async function openRelay(envelope: Envelope, vault: { ownerUserId: string; id: string }, key: CryptoKey): Promise<RelayPayload> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(base64ToBytes(envelope.nonce)), additionalData: bufferSource(relayAad(vault)), tagLength: 128 }, key, bufferSource(base64ToBytes(envelope.ciphertext)));
  const payload = JSON.parse(new TextDecoder().decode(plain)) as RelayPayload;
  if (payload.schema !== RELAY_SCHEMA || !Array.isArray(payload.notes)) throw new Error("Nieprawidłowa zmiana na żywo.");
  return payload;
}

// The AAD names the vault's owner (from the server), not the reader: every member decrypts with the same owner.
export async function decryptSnapshot(envelope: Envelope, ownerUserId: string, vaultId: string, key: CryptoKey): Promise<BrowserVaultSnapshot> {
  if (envelope.schema !== VAULT_SCHEMA) throw new Error("Nieobsługiwany format zaszyfrowanej przestrzeni.");
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(base64ToBytes(envelope.nonce)), additionalData: bufferSource(aad(ownerUserId, vaultId)), tagLength: 128 }, key, bufferSource(base64ToBytes(envelope.ciphertext))));
  const raw = gzipped(plain) ? await through(plain, new DecompressionStream("gzip")) : plain;
  const value = JSON.parse(new TextDecoder().decode(raw)) as BrowserVaultSnapshot;
  if (value.schema !== "browser-vault-snapshot" || value.schemaVersion !== 1 || value.vault.ownerUserId !== ownerUserId || value.vault.id !== vaultId) throw new Error("Dane przestrzeni nie pasują do tego konta.");
  return value;
}

// Checks a recovery code against the vault: true when the envelope decrypts with it, or, for Moje notatki with a key of
// their own (docs/MCP.md §3.7), when the code unwraps that key. Nothing to check against means nothing can disprove the
// code, so it is accepted; a copy that can be checked only against a key out of reach refuses every code (a wrong code
// stored here would lock this device out of its own copy).
export async function codeOpens(code: string, verifier: Verifier, userId: string): Promise<boolean> {
  if (verifier.unverifiable) return false;
  // the server could not be asked and nothing here can check the code: refused rather than stored unchecked
  if (!verifier.envelope && !verifier.wrappedKey && !verifier.boxKey) return verifier.checked;
  try {
    const key = await keyFromRecovery(code);
    const wrapped = verifier.wrappedKey;
    if (verifier.boxKey) await unwrapBytes(verifier.boxKey, key);
    else if (wrapped) await (wrapped.bound ? unwrapPersonalVaultKey(wrapped.key, key, userId, wrapped.keyEpoch) : unwrapVaultKey(wrapped.key, key));
    else await decryptSnapshot(verifier.envelope!, userId, verifier.vaultId, key);
    return true;
  } catch { return false; }
}
// `wrappedKey`: a key of Moje notatki the code must open (`bound`: the server's copy, bound to user and epoch; otherwise
// this device's copy). `unverifiable`: there is a copy under a key of their own, and neither copy of that key is at hand.
// `boxKey`: the private half of the account's box key, wrapped with the personal key (accounts without Moje notatki).
export interface Verifier { envelope?: Envelope; vaultId: string; checked: boolean; wrappedKey?: { keyEpoch: number; key: KeyEnvelope; bound: boolean }; boxKey?: KeyEnvelope; unverifiable?: boolean }
// What a code must open: the local copy, else the server's; and the newest key of Moje notatki the server holds, which
// counts as data even before a snapshot under it arrived. checked is false when the server could not be asked.
export async function findVerifier(db: IDBDatabase, userId: string): Promise<Verifier> {
  const vaultId = personalVaultId(userId);
  const stored = await readStored(db, userId, vaultId).catch(() => undefined);
  let envelope = stored?.envelope;
  let checked = true;
  const rows = await fetchPersonalKeys().catch(() => null);
  if (rows === null) checked = false;
  if (!envelope) {
    try { envelope = (await fetchRemoteEnvelope(userId)) ?? undefined; }
    catch { checked = false; }
  }
  const epoch = envelope?.keyEpoch ?? 1;
  const row = rows?.find((r) => r.keyEpoch === epoch) ?? (epoch === 1 ? rows?.at(-1) : undefined);
  if (row) return { envelope, vaultId, checked, wrappedKey: { keyEpoch: row.keyEpoch, key: row.wrappedKey, bound: true } };
  if (epoch > 1) {
    const local = await transaction<EpochKeyRecord | undefined>(db, EPOCH_KEYS, "readonly", (s) => s.get([userId, vaultId, epoch])).catch(() => undefined);
    if (local) return { envelope, vaultId, checked, wrappedKey: { keyEpoch: epoch, key: local.wrapped, bound: false } };
    return { envelope, vaultId, checked: false, unverifiable: true };
  }
  return { envelope, vaultId, checked };
}
// Without Moje notatki nothing of theirs is fetched: the code must open the account's box key, which every login
// before stored (404: none yet, nothing to protect).
export async function findAccountVerifier(userId: string): Promise<Verifier> {
  const vaultId = personalVaultId(userId);
  try { return { vaultId, checked: true, boxKey: (await api<{ wrappedPrivate: KeyEnvelope }>("/api/me/box-key")).wrappedPrivate }; }
  catch (e) { return { vaultId, checked: e instanceof ApiError && e.status === 404 }; }
}
// Asks the server for the vault once, over a short-lived socket (the same hello as BrowserBridge uses).
function fetchRemoteEnvelope(userId: string): Promise<Envelope | null> {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/api/sync/ws`);
    const timer = setTimeout(() => finish(() => reject(new Error("Serwer nie odpowiedział."))), 8000);
    const finish = (then: () => void) => { clearTimeout(timer); socket.close(); then(); };
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", vaultId: personalVaultId(userId) }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "snapshot") finish(() => resolve(message.envelope ?? null));
      else if (message.type === "error") finish(() => reject(new Error(message.message ?? "Błąd synchronizacji.")));
    };
    socket.onerror = () => finish(() => reject(new Error("Nie można połączyć się z synchronizacją.")));
    socket.onclose = () => finish(() => reject(new Error("Połączenie z synchronizacją zostało zamknięte.")));
  });
}
// Storage writes can fail transiently; a few quick attempts cover that before the caller shows an error.
export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await run(); }
    catch (error) { if (i >= attempts) throw error; await new Promise((resolve) => setTimeout(resolve, 200 * i)); }
  }
}

// Backoff after the n-th failed save in a row: 1 s, 2 s, 4 s, ... 30 s at most.
export const retryDelay = (failures: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));

/** Runs saves one after another. A failed save does not block the ones after it, is reported, and schedules a retry
 *  with backoff; the next save that succeeds clears the failure count. */
export class SaveChain {
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly retryLater: () => void, private readonly report: (ok: boolean) => void) {}
  run(step: () => Promise<void>): Promise<void> {
    const next = this.chain.then(step);
    this.chain = next.then(
      () => { this.failures = 0; clearTimeout(this.timer); this.report(true); },
      () => { this.failures++; this.report(false); clearTimeout(this.timer); this.timer = setTimeout(this.retryLater, retryDelay(this.failures)); },
    );
    return next;
  }
}


type SyncState = "local" | "connecting" | "syncing" | "synced" | "offline" | "error";
// author: who wrote the revision, set by the server from the writing session (a chat: agentId); never sent by a client.
export interface RevisionAuthor { userId: string; agentId: string | null }
type ServerMessage = { type: string; revision?: number; envelope?: Envelope | null; unchanged?: boolean; message?: string; code?: string; role?: Role | null; author?: RevisionAuthor | null };
// Keepalive (docs/WEB-WSPOLDZIELENIE.md "Połączenie"): a ping every PING_EVERY; a ping with no frame back within
// PING_ANSWER means a dead link (sleep, Wi-Fi change never says so), and the socket is dropped and opened again. Judged
// by the ping's own answer, not wall time, since a hidden tab's timers run only about once a minute.
const PING_EVERY = 25_000;
const PING_ANSWER = 15_000;
/** The wait before the n-th reconnect in a row: the save backoff plus up to 1 s of jitter, so members don't all come back at once. */
export const reconnectDelay = (attempt: number, random = Math.random()): number => retryDelay(attempt) + Math.floor(random * 1000);
export const APPEND_REFUSED_TEXT = "Odrzucono zmianę czatu Claude: tryb dopisywania nie pozwala zmieniać ani usuwać tekstu.";
/** The reason of the version kept before a chat's revision changes a note (docs/MCP.md §7.2). */
export const agentVersionReason = (agentId: string): string => `Przed zmianą Claude (${agentId})`;
/** The reason of the version kept with the text right after a chat's revision: "Cofnij zmiany czatu" sees a later change. */
export const agentAfterReason = (agentId: string): string => `Po zmianie Claude (${agentId})`;
export interface ChatVersion { noteId: string; path: string; at: number; vid: number; text: string; after: string | null; from: string | null; to: string | null }
/** The reason of the version kept when "Cofnij zmiany czatu" put a note back: the chat's earlier versions are then done. */
export const agentUndoneReason = (agentId: string): string => `Cofnięto zmiany Claude (${agentId})`;
// The chats a new key goes to: every unrevoked chat of `members` whose cert, checked under its person's signing key, has
// `vaultId`. A cert that names the vault but does not verify gets nothing (its box key may be anyone's): `onBad` is told,
// so a rotation the server checks can disconnect it first, and one member's broken cert never blocks a rotation.
export async function liveChats(vaultId: string, members: SignerMember[], onBad?: (agentId: string, userId: string) => Promise<void>): Promise<{ agentId: string; userId: string; boxKey: string }[]> {
  const out: { agentId: string; userId: string; boxKey: string }[] = [];
  for (const m of members) for (const a of m.agents ?? []) {
    if (a.revokedAt != null || !a.cert?.vaults?.some((v) => v.vaultId === vaultId)) continue;
    const cert = { ...a.cert, signature: a.cert.signature ?? a.signature };
    if (!m.signingKey || cert.agentId !== a.agentId || cert.userId !== m.userId || !(await verifyCert(cert, m.signingKey))) {
      await onBad?.(a.agentId, m.userId);
      continue;
    }
    out.push({ agentId: a.agentId, userId: m.userId, boxKey: cert.boxKey });
  }
  return out;
}
const CREATES = new Set(["create_note", "create_folder", "rename", "rename_folder"]);
const GUARDED = new Set(["create_note", "create_folder", "rename", "rename_folder", "delete_folder", "delete", "restore_version", "resolve_conflict"]);
const NO_PROJECT_KEY = "Nie masz klucza tego projektu na tym urządzeniu.";
const MODE_ORDER: WriteMode[] = ["none", "proposals", "append", "direct"];
const CHAT_LIST_MS = 10 * 60_000;
const LEAD_TEXT = "Prowadzącego zmienia właściciel lub administrator.";
const LOCKED_TEXT = "Projekt jest chroniony. Nie masz do niego klucza.";
const LOCKED_FOLDER_TEXT = "Chronionego projektu nie można przemianować ani przenieść.";
const PROTECTED_DELETE_TEXT = "Chroniony projekt usuwa właściciel lub administrator.";
const EDIT_TEXT = "Masz tylko podgląd tej notatki lub folderu.";
const CLEAN_COPY_TEXT = "To czysta kopia z GitHuba (tylko do odczytu).";
// The archive-id secret of Moje notatki (docs/GITHUB.md §5): AES-GCM over 32 zero bytes with a nonce no other code uses
// (every other encryption takes a random 96-bit nonce), so it is the personal key's keystream: stable on every device of
// the owner, unknown to the server, and never used to encrypt anything else.
const ARCHIVE_NONCE = new TextEncoder().encode("notes-gh-arc"); // 12 bytes
export async function personalArchiveSecret(personalKey: CryptoKey): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ARCHIVE_NONCE }, personalKey, new Uint8Array(32));
  return new Uint8Array(out, 0, 32);
}
const LINK_MOVE_TEXT = "Połączenia z GitHubem nie można przenieść do chronionego projektu ani z niego.";
const PROJECT_COMMANDS = new Set(["project_protection", "project_protect", "project_set_members", "project_unprotect"]);
export type ProtectionTarget = ProjectProtection["target"];
const NOTE_PROTECT_TEXT = "Notatki nie mają własnych uprawnień: chroniony jest folder, w którym leżą.";
const MANAGE_TEXT = "Uprawnienia może zmienić właściciel, administrator, prowadzący projektu lub edytor chronionego folderu nadrzędnego.";
const ROOT_NOTE_TEXT = "Notatki w głównym folderze widzą wszyscy członkowie; ograniczać można tylko foldery.";
// What is compared with the server's copy to decide whether to send: the vault's state without the reader's own
// fields (`me`, `organization.me`), which differ for every member and would make each one send the vault straight back.
export function syncCanon(state: BrowserVaultSnapshot["state"]): string {
  const { me: _reader, ...shared } = state;
  return canonicalJson(shared.organization ? { ...shared, organization: { ...shared.organization, me: "" } } : shared);
}

const MUTATIONS = new Set(["project_protect", "project_set_members", "project_unprotect", "set_my_handle","set_space_kind","create_note","create_folder","rename","rename_folder","delete","delete_folder","restore_note","purge_note","apply_update","restore_version","resolve_conflict","save_attachment","organization_group","organization_person","organization_import_module","organization_save_record","organization_movement","organization_cancel_movement","save_task_cache","github_save_link","github_remove_link","github_save_version","folder_file_add","folder_file_rename","folder_file_remove"]);
/** Local snapshots and all server traffic are AES-GCM ciphertext. Login credentials never derive the vault key.
 *  One bridge is one vault: the personal one (keyed by the personal key) or a shared one (keyed by its vault key). */
export class BrowserBridge extends MockBridge {
  private saves = new SaveChain(() => { if (!this.stopped) void this.persist().catch(() => undefined); }, (ok) => this.onSaveResult(ok));
  private saveSeq = 0;
  // Canonical JSON of the last snapshot written locally, and of the last one the server is known to hold.
  private lastCanon?: string;
  private serverState?: string;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private socket?: WebSocket;
  private revision = 0;
  private dirty = false;
  private connected = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private syncState: SyncState = "local";
  private statusListeners = new Set<(state: SyncState) => void>();
  private stopped = false;
  private info: VaultInfo;
  private currentRole: Role | null;
  private rawKey: Uint8Array | null;
  private serverMembers: RemoteMember[];
  private leaving = false;
  private accessListeners = new Set<(payload: unknown) => void>();
  // Stage D: this user's signing key (null when none could be loaded) and the verification of every event (by event_id).
  private signing?: SigningIdentity;
  private checks = new Map<string, EventCheck>();
  private verifySeq = 0;
  // Stage E: the epoch this bridge writes with (`key`), the older epochs it can still read, and this user's box key.
  private epoch: number;
  private keyring: Keyring = new Map();
  private box?: BoxIdentity;
  // Key changes (rekey, rotation) run one at a time; a second one waits and then finds the first one's result.
  private keyTask: Promise<unknown> = Promise.resolve();
  // Set after one stale-key recovery, cleared by the next ack: a second refusal is shown, not retried in a loop.
  private staleRetry = false;
  // Files on the server for this vault (docs/PLIKI.md): sealed with the vault key, or with a protected project's key.
  declare readonly files: RemoteFileStore;
  // Attachments moved to the file store: one run at a time; a failed run is retried after a while.
  private migrating = false;
  private constructor(readonly user: BrowserUser, readonly personalKey: CryptoKey, private db: IDBDatabase, private key: CryptoKey, access: VaultAccess) {
    super([], false);
    this.info = access.vault;
    this.currentRole = access.role;
    this.epoch = access.keyEpoch;
    this.rawKey = access.rawKey;
    this.serverMembers = access.members;
    this.setBrowserAccount(user.id, user.email, access.vault.id === personalVaultId(user.id) ? undefined : access.vault, user.name);
    this.files = new RemoteFileStore({ vaultId: access.vault.id, who: user.id, keys: {
      vault: () => ({ key: this.key, keyEpoch: this.epoch }),
      vaultKey: async (epoch) => this.keyAt(epoch),
      projects: () => this.fileProjects(),
    } });
  }
  static async open(user: BrowserUser, personal: CryptoKey, access: VaultAccess, signing?: SigningIdentity, box?: BoxIdentity): Promise<BrowserBridge> {
    const key = access.rawKey ? await importVaultKey(access.rawKey) : personal;
    const db = await openDb(); const bridge = new BrowserBridge(user, personal, db, key, access);
    const { id: vaultId, ownerUserId } = access.vault;
    if (signing) { bridge.signing = signing; bridge.eventSigner = (event) => signEvent(event, signing); }
    bridge.box = box;
    try {
      bridge.keyring = await readEpochKeys(db, user.id, vaultId, personal);
      // Moje notatki with a key of their own (docs/MCP.md §3.7): the newest one this device keeps is the current one.
      if (!isSharedVaultId(vaultId) && bridge.keyring.size) {
        const top = Math.max(...bridge.keyring.keys());
        const held = bridge.keyring.get(top)!;
        Object.assign(bridge, { key: held.key, rawKey: held.raw, epoch: top });
      }
      ({ keys: bridge.projectKeys, trusted: bridge.trusted } = await readProjectKeys(db, user.id, vaultId, personal));
      const stored = await readStored(db, user.id, vaultId);
      if (stored) {
        if (stored.vaultId && stored.vaultId !== vaultId) throw new Error("Ta przestrzeń należy do innego konta.");
        bridge.revision = Number(stored.revision) || 0;
        if (stored.envelope) {
          const local = await bridge.decryptEnvelope(stored.envelope);
          await bridge.unfold(local);
          bridge.mergeBrowserSnapshot(local);
        }
        else if ((stored as unknown as { snapshot?: BrowserVaultSnapshot }).snapshot) {
          const legacy = (stored as unknown as { snapshot: BrowserVaultSnapshot }).snapshot;
          if (legacy.vault.ownerUserId !== ownerUserId) throw new Error("Zapis lokalny należy do innego konta.");
          await bridge.unfold(legacy); // every merge of a stored copy goes through unfold, this one too
          bridge.mergeBrowserSnapshot(legacy);
          await bridge.persist(false);
        }
      }
      bridge.applyMembers();
      void bridge.verifyOrganization();
      bridge.startSync();
      // closing the tab or leaving the page: the pending delta and snapshot go now, not after the slow wait
      addEventListener("pagehide", () => { void bridge.flushRelay().catch(() => undefined); if (bridge.dirty) void bridge.persist().catch(() => undefined); });
      // A pending key or a needed rotation is taken in the background; the vault is usable meanwhile.
      bridge.startGithub();
      if (isSharedVaultId(vaultId)) {
        bridge.catchUp().then(() => bridge.syncProfileCard()).then(() => bridge.tidyFiles()).catch((e: unknown) => toast(errorText(e), true)).finally(() => void bridge.completeAssignments());
        bridge.syncAssignTimer();
      }
      // Moje notatki get a key of their own on first open (docs/MCP.md §3.7); offline, the next open does it.
      else bridge.catchUp().catch((e: unknown) => console.error("Klucz Moich notatek:", e));
      // A failed first write is retried by the save chain; it must not keep the user out.
      if (!stored) await bridge.persist().catch(() => undefined);
      return bridge;
    } catch (error) { db.close(); throw error; }
  }
  /** The vault this bridge holds, its owner included. */
  get vault(): VaultInfo { return this.info; }
  /** This user's role in the vault; null once access was revoked. */
  get role(): Role | null { return this.currentRole; }
  /** The raw vault key (for building invite links); null for the personal vault. */
  get vaultKey(): Uint8Array | null { return this.rawKey; }
  /** The epoch of the vault key above (Stage E). Invite links carry it. */
  get vaultEpoch(): number { return this.epoch; }
  /** Reports role changes (`{ role }`) and revocation (`{ role: null, voluntary }`). */
  onVaultAccess(cb: (payload: { role: Role | null; voluntary?: boolean; personal?: boolean }) => void): () => void { this.accessListeners.add(cb as (payload: unknown) => void); return () => this.accessListeners.delete(cb as (payload: unknown) => void); }
  /** Called before this user removes themselves, so the revocation is not reported as a removal by someone else. */
  // `false` again when the leave or the deletion it announced failed
  markLeaving(on = true): void { this.leaving = on; }
  /** Saves what is pending before the page moves to another vault; false when the save failed. */
  async flush(): Promise<boolean> { try { await this.persist(); return true; } catch { return false; } }
  // Someone may have joined since the list was read: remote changes refresh it, at most every 10 s. The list from
  // opening counts as the first read.
  private membersAt = Date.now();
  private refreshMembersSoon(): void {
    if (!isSharedVaultId(this.info.id) || Date.now() - this.membersAt < 10_000) return;
    this.membersAt = Date.now();
    void this.refreshMembers().catch(() => undefined);
  }
  /** Reloads the members and this user's role (after the members dialog changed them). Saves only on a change. */
  async refreshMembers(): Promise<void> {
    const detail = await fetchVault(this.info.id);
    this.info = detail.vault;
    this.agentPolicy = detail.agentPolicy;
    const same = detail.role === this.currentRole && JSON.stringify(detail.members) === JSON.stringify(this.serverMembers);
    this.serverMembers = detail.members;
    if (!same) {
      this.setRole(detail.role);
      this.applyMembers();
      this.schedulePersist();
    }
    await this.syncProfileCard();
  }
  /** The vault key of an epoch this device holds (null when it holds none). */
  // Epoch 1 of Moje notatki is the personal key itself (before and after the move to a key of their own).
  keyAt(epoch: number): CryptoKey | null {
    if (epoch === this.epoch) return this.key;
    if (epoch === 1 && !isSharedVaultId(this.info.id)) return this.personalKey;
    return this.keyring.get(epoch)?.key ?? null;
  }
  // The epoch written on envelopes: always in a shared vault; in Moje notatki once they have a key of their own.
  private wireEpoch(): number | undefined { return isSharedVaultId(this.info.id) || this.epoch > 1 ? this.epoch : undefined; }
  /** This user's last name: decrypted from the account copy, or the legacy plaintext until it is moved. */
  async lastName(): Promise<string> { return this.user.profileSecret ? openLastName(this.user.profileSecret, this.personalKey) : this.user.lastName ?? ""; }
  /** Saves the last name on the account (an empty one removes it), then this vault's card. */
  async setLastName(lastName: string): Promise<void> {
    const profileSecret = lastName ? await sealLastName(lastName, this.personalKey) : null;
    await api("/api/auth/me", "PATCH", { profileSecret });
    this.user.profileSecret = profileSecret;
    this.user.lastName = "";
    await this.syncProfileCard();
  }
  // Publishes this user's card in a shared vault when it is missing, under an older epoch, or has another name.
  private async syncProfileCard(): Promise<void> {
    if (!isSharedVaultId(this.info.id)) return;
    try {
      const mine = this.serverMembers.find((m) => m.userId === this.user.id);
      const next = await profileChange(mine?.profile ?? null, await this.lastName(), this.info.id, this.user.id, this.epoch, this.key);
      if (next === undefined) return;
      await putMyProfile(this.info.id, next);
      if (mine) mine.profile = next;
    } catch (e) { console.warn("Nazwiska w sejfie nie udało się zaktualizować:", e); }
  }
  /** Last names from the members' cards (userId → name). A card this device cannot open is left out. */
  async memberLastNames(members: RemoteMember[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    await Promise.all(members.map(async (m) => {
      const key = m.profile ? this.keyAt(m.profile.keyEpoch) : null;
      if (!m.profile || !key) return;
      const last = await openProfile(m.profile, this.info.id, m.userId, key).catch(() => "");
      if (last) names.set(m.userId, last);
    }));
    return names;
  }
  onSyncStatus(cb: (state: SyncState) => void): () => void { this.statusListeners.add(cb); cb(this.syncState); return () => this.statusListeners.delete(cb); }
  private setStatus(state: SyncState): void { this.syncState = state; this.statusListeners.forEach((fn) => fn(state)); }
  // Shared vaults list the server's members; a snapshot merge can bring back a member removed since, so the list is set again.
  private applyMembers(): void { if (this.info.id !== personalVaultId(this.user.id)) this.setMembers(this.serverMembers.map((m) => ({ ...m, email: m.email ?? "" }))); }
  override async call<T>(cmd: string, args?: unknown): Promise<T> {
    if (cmd === "account_name") return this.user.name as T;
    if (cmd === "read_attachment") {
      const fileId = this.attachmentFileId(String((args as { rel?: string } | undefined)?.rel ?? ""));
      if (fileId) return new Uint8Array(await (await this.files.read(fileId)).arrayBuffer()) as T;
    }
    if (cmd === "account_last_name") return (await this.lastName()) as T;
    if (cmd === "set_account_last_name") { await this.setLastName(String((args as { last?: string } | undefined)?.last ?? "").trim()); return undefined as T; }
    if (cmd === "set_account_name") {
      const name = String((args as { name?: string } | undefined)?.name ?? "").trim();
      const result = await api<{ user: BrowserUser }>("/api/auth/me", "PATCH", { name });
      this.user.name = result.user.name;
      const member = this.serverMembers.find((m) => m.userId === this.user.id);
      if (member) member.name = result.user.name;
      await super.call("organization_person", { userId: this.user.id, name: result.user.name });
      this.applyMembers();
      this.schedulePersist();
      return undefined as T;
    }
    if (this.currentRole === "viewer" && MUTATIONS.has(cmd)) {
      // The task cache is this device's derived copy, written after every index change: dropped without a message.
      if (cmd === "save_task_cache") return undefined as T;
      // A dropped edit is not retried by the save queue, so it is accepted here without an error.
      if (cmd === "apply_update") { toast(READ_ONLY_TEXT, true); return undefined as T; }
      toast(READ_ONLY_TEXT, true);
      throw new Error(READ_ONLY_TEXT);
    }
    // A member who may read a protected note but not edit it: the edit is dropped, as for a viewer.
    if (cmd === "apply_update" && this.editRefused(this.pathOfNote(String((args as { id?: string }).id)))) { toast(EDIT_TEXT, true); return undefined as T; }
    // A clean copy of GitHub (allowEdits off) takes only the GitHub run's writes, which say so (docs/GITHUB.md §2).
    if (cmd === "apply_update" && (args as { github?: unknown }).github !== true && linkOfNote(this.githubLinks, String((args as { id?: string }).id))?.link.allowEdits === false) { toast(CLEAN_COPY_TEXT, true); return undefined as T; }
    // The reads of the organization carry the verification of their events.
    if (cmd === "organization_snapshot") return { ...(await super.call<OrganizationSnapshot>(cmd)), checks: this.checkMap() } as T;
    if (cmd === "organization_records") return { ...(await super.call<ModuleData>(cmd)), checks: this.checkMap() } as T;
    // Every vault of this device, read without writing: the module calendar's sources and "Mój kalendarz".
    if (cmd === "organization_global_records") return (await browserSpaces(this)).spaces as T;
    // A record of another vault (listed by organization_global_records) is changed there, never copied into this one.
    if (cmd === "organization_save_record" && (args as { path?: string | null } | undefined)?.path && (args as { path?: string }).path !== this.info.id)
      throw new Error("Tę pozycję zmienisz w jej przestrzeni.");
    // The folder listing shows the protected projects, locked for the members who do not hold their key.
    if (cmd === "list_tree") return this.withLocked(await super.call<TreeListing>(cmd)) as T;
    if (PROJECT_COMMANDS.has(cmd)) {
      const p = args as { path?: string; members?: string[]; editors?: string[]; lead?: string | null };
      const requested = String(p.path);
      // A note has no rights of its own: protecting one is refused, and the other requests are answered for its folder.
      if (cmd === "project_protect" && requested.endsWith(".md")) throw new Error(NOTE_PROTECT_TEXT);
      const { path: folder, target } = this.protectable(requested);
      // the snapshot every member reads holds the places of folder files: their names must leave first
      if (cmd === "project_protect" && this.holdsFolderFiles(folder)) throw new Error(FILES_BEFORE_PROTECT_TEXT);
      if (cmd === "project_protection") return (await this.projectProtection(folder, target)) as T;
      // One at a time: two protects of a project that both pass the "already protected" check would seal two keys.
      if (cmd === "project_protect") await this.locked(() => this.protectProject(folder, p.members ?? [], p.editors ?? [], target, p.lead));
      else if (cmd === "project_set_members") await this.locked(() => this.setProjectMembers(folder, p.members ?? [], p.editors ?? [], target, p.lead));
      else await this.locked(() => this.unprotectProject(folder));
      return undefined as T;
    }
    // A trashed note of a protected project is listed (and so restored or purged) by its key holders only.
    if (cmd === "restore_note" || cmd === "purge_note") await this.guardTrashed(String((args as { id?: string } | undefined)?.id ?? ""));
    if (GUARDED.has(cmd)) { await this.guardProtected(cmd, args); this.guardCreation(cmd, args); }
    if (cmd === "folder_file_add" || cmd === "folder_file_rename") this.guardFolderFile(String((args as { path?: string } | undefined)?.path ?? ""));
    if (cmd === "rename_folder") {
      const { from, to } = (args ?? {}) as { from?: string; to?: string };
      if (this.holdsFolderFiles(String(from)) && [...this.protectedEntries.keys()].some((folder) => inside(String(to), folder))) throw new Error(PROTECTED_FILE_TEXT);
    }
    if (cmd === "github_save_link" || cmd === "github_remove_link") this.guardLink(cmd, args);
    if (cmd === "delete_folder") { await this.deleteFolder(String((args as { path?: string }).path)); return undefined as T; }
    // Queued (after the refusals above) before the bridge's own work on the edit (task parsing of the whole note); it is
    // sealed in a microtask, so it doesn't wait for a rendered frame or a timer.
    if (cmd === "apply_update") { const a = args as { id: string; update: Uint8Array }; this.queueRelay(String(a.id), a.update); }
    const result = await super.call<T>(cmd, args);
    // the task cache is derived data that every member rewrites after others type: it never hurries the snapshot
    if (MUTATIONS.has(cmd)) this.schedulePersist(cmd === "apply_update" || cmd === "save_task_cache" ? "slow" : "fast");
    // The note index reads the GitHub notes again with their new guarded lines (noteindex.ts).
    if (cmd === "github_save_link") this.emit("tree_changed", null);
    return result;
  }
  // A pause in typing sends after PERSIST_PAUSE_MS; typing without a pause still sends every PERSIST_MAX_WAIT_MS, so the
  // others see it live.
  private pendingSince?: number;
  private pendingFast = false;
  private schedulePersist(speed: "fast" | "slow" = "fast"): void {
    this.dirty = true;
    const now = Date.now();
    this.pendingSince ??= now;
    this.pendingFast ||= speed === "fast";
    const { pause, max } = PERSIST[this.pendingFast ? "fast" : "slow"];
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const wait = Math.max(0, Math.min(pause, this.pendingSince + max - now));
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.persist().catch((e) => { console.error(e); this.setStatus("error"); }); }, wait);
  }
  async persist(sendToServer = true): Promise<void> {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    this.pendingSince = undefined; this.pendingFast = false;
    // Events made since the last save are signed first, so the snapshot holds their signatures.
    await this.settleSignatures();
    void this.verifyOrganization();
    await this.sealProtected();
    const snapshot = this.exportBrowserSnapshot(this.info.ownerUserId, this.info.id); const seq = ++this.saveSeq; this.dirty = true;
    // An error stays on screen until a save succeeds.
    if (this.syncState !== "error") this.setStatus(this.connected ? "syncing" : "local");
    const canon = syncCanon(snapshot.state);
    return this.saves.run(async () => {
      const envelope = await encryptSnapshot(snapshot, this.key, this.wireEpoch());
      await writeStored(this.db, { userId: this.user.id, vaultId: this.info.id, envelope, revision: this.revision, updatedAt: Date.now() });
      this.lastCanon = canon;
      if (seq === this.saveSeq) this.dirty = false;
      // Nothing to send when the server already holds exactly this state (avoids put loops between clients).
      if (sendToServer && this.connected && canon !== this.serverState) this.sendPut(envelope, canon);
    });
  }
  // Checks every event against the members' keys (cached by event_id). Views re-read the checks on "org_verified".
  async verifyOrganization(): Promise<void> {
    const seq = ++this.verifySeq;
    const shared = isSharedVaultId(this.info.id);
    const events = this.signableEvents();
    // Moje notatki: this user's own chats sign there too; their certs come from the account (loaded once, when needed)
    if (!shared && !this.ownAgents && events.some((e) => e.signerAgentId)) await this.loadOwnAgents().catch(() => undefined);
    const members: SignerMember[] = shared
      ? this.signerMembers()
      : [{ userId: this.user.id, signingKey: this.signing?.publicJwk ?? null, agents: this.ownAgents ?? [] }];
    const result = await verifyEvents(events, members, shared);
    if (seq !== this.verifySeq) return;
    const changed = JSON.stringify([...result]) !== JSON.stringify([...this.checks]);
    this.checks = result;
    if (changed) this.emit("org_verified", null);
  }
  private checkMap(): Record<string, EventCheck> { return Object.fromEntries(this.checks); }
  // The members as signatures are checked against them: their keys and their Claude chats (certs, revocations).
  private signerMembers(): SignerMember[] { return this.serverMembers.map((m) => ({ userId: m.userId, signingKey: m.signingKey ?? null, agents: m.agents ?? [] })); }
  // This user's own chats (GET /api/me/agents): Moje notatki have no member list to carry them.
  private ownAgents?: SignerAgent[];
  private async loadOwnAgents(): Promise<void> {
    this.ownAgents = (await listMyAgents()).map(({ agentId, cert, signature, revokedAt }) => ({ agentId, cert, signature, revokedAt }));
  }
  private onSaveResult(ok: boolean): void {
    if (!ok) this.setStatus("error");
    else if (this.syncState === "error") this.setStatus(this.connected ? "synced" : "local");
  }
  private reconnects = 0; // reconnects in a row without a snapshot; reset by the server's snapshot
  private lastFrameAt = 0;
  private pingSentAt = 0;
  private pingTimer?: ReturnType<typeof setInterval>;
  private wake?: () => void;
  // The nonces of the puts still waiting for their answer, oldest first, and the nonce of the envelope of `revision`.
  private inflight: string[] = [];
  private putsAtOpen = 0;
  private inflightAtOpen = 0; // puts of the dropped socket: they keep a resume off, and leave with the next full snapshot
  private heldNonce?: string;
  // What a reconnect names in its hello: only when every put was answered, nothing is unsent, and this device holds
  // exactly `revision` (its envelope's nonce known). The server then answers "unchanged" instead of the whole vault.
  private resumable(): { revision: number; nonce: string } | undefined {
    const settled = this.remoteSeen && !this.dirty && this.inflight.length === 0 && this.lastCanon !== undefined && this.lastCanon === this.serverState;
    return settled && this.revision > 0 && this.heldNonce ? { revision: this.revision, nonce: this.heldNonce } : undefined;
  }
  private startSync(): void {
    this.stopped = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/api/sync/ws`); this.socket = socket;
    this.setStatus("connecting");
    this.watchConnection();
    // every handler checks it is still the current socket: a dropped one may still fire, and must not reconnect twice
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.connected = true; this.lastFrameAt = Date.now(); this.pingSentAt = 0; this.putsAtOpen = this.putsSent; this.inflightAtOpen = this.inflight.length;
      socket.send(JSON.stringify({ type: "hello", vaultId: this.info.id, ...this.resumable() }));
      void this.runMigration();
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.lastFrameAt = Date.now();
      this.handling++; void this.handleMessage(JSON.parse(String(event.data)) as ServerMessage).catch((e) => { console.error("Sync error",e); this.setStatus("error"); }).finally(() => { this.handling--; });
    };
    socket.onerror = () => { if (socket === this.socket) this.setStatus("offline"); };
    socket.onclose = () => { if (socket === this.socket) this.lostSocket(); };
  }
  private lostSocket(): void {
    this.connected = false; this.current = false; this.socket = undefined;
    if (this.stopped) return;
    this.setStatus("offline");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.startSync(), reconnectDelay(++this.reconnects));
  }
  // A socket that went silent is given up at once (its close may take minutes on a dead link) and a new one follows.
  private dropSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.lostSocket();
    try { socket.close(); } catch { /* already closing */ }
  }
  // A ping left unanswered for PING_ANSWER drops the socket; otherwise a new ping goes when none is waiting.
  private checkLink(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const waiting = this.pingSentAt > this.lastFrameAt;
    if (waiting && Date.now() - this.pingSentAt > PING_ANSWER) this.dropSocket();
    else if (!waiting) { this.pingSentAt = Date.now(); this.socket.send(JSON.stringify({ type: "ping" })); }
  }
  private watchConnection(): void {
    this.pingTimer ??= setInterval(() => this.checkLink(), PING_EVERY);
    if (this.wake) return;
    // back online, or back from a hidden tab (timers sleep there): reconnect now instead of after the backoff, or
    // check the link at once and again when its ping should have been answered
    this.wake = () => {
      if (this.stopped || document.visibilityState === "hidden") return;
      if (!this.socket) { this.reconnects = 0; this.startSync(); return; }
      this.checkLink();
      setTimeout(() => this.checkLink(), PING_ANSWER + 1000);
    };
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }
  // The key of a snapshot's epoch: this bridge's, or an older one from the keyring. Unknown epochs throw.
  // An envelope without an epoch: the shared vault's current key, or the personal key (Moje notatki before §3.7).
  private keyFor(epoch: number | undefined): CryptoKey {
    const key = epoch === undefined ? (isSharedVaultId(this.info.id) ? this.key : this.personalKey) : this.keyAt(epoch);
    if (!key) throw new Error("Nie masz klucza tej wersji sejfu.");
    return key;
  }
  private async decryptWith(envelope: Envelope): Promise<BrowserVaultSnapshot> {
    const key = this.keyFor(envelope.keyEpoch);
    const snapshot = await decryptSnapshot(envelope, this.info.ownerUserId, this.info.id, key);
    if (key === this.personalKey) this.personalProven = true;
    return snapshot;
  }
  // Moje notatki: the personal key here opened their data (or there is none yet). Only then is a key of their own made: a
  // wrong personal key (an unchecked recovery code) would otherwise wrap a key no other device can open.
  private personalProven = false;
  private migrationTried = false;
  // Decrypts a snapshot, local or from the server. A key this device does not hold, or a failed decrypt, takes one rekey
  // from the server's pending key and one retry. Nothing left to try is an error that stays on screen.
  private async decryptEnvelope(envelope: Envelope): Promise<BrowserVaultSnapshot> {
    try { return await this.decryptWith(envelope); }
    catch {
      await this.locked(() => (isSharedVaultId(this.info.id) ? this.rekeyFrom() : this.personalCatchUp(false))).catch(() => false);
      // retried in any case: a key task queued before this one (catchUp) may have brought the key meanwhile
      try { return await this.decryptWith(envelope); } catch { /* reported below */ }
      const message = "Nie udało się odszyfrować tej przestrzeni kluczem tego urządzenia. Odśwież stronę lub poproś administratora o zmianę klucza.";
      this.setStatus("error"); toast(message, true);
      throw new Error(message);
    }
  }

  // ---- Stage E: key epochs, rekey, rotation ------------------------------------------------------------------------

  // Assignments by the server admin (docs/PANEL-ADMINA.md "Przydział do organizacji"): an owner or admin seals the current
  // vault key to each assigned person's box key, as rotateFrom does for members. Failures stay quiet; the next run retries.
  private assignTimer?: ReturnType<typeof setInterval>;
  private assigning = false;
  // only owners and admins look for assignments: the timer follows the role
  private syncAssignTimer(): void {
    const wanted = !this.stopped && isSharedVaultId(this.info.id) && (this.currentRole === "owner" || this.currentRole === "admin");
    if (wanted && !this.assignTimer) this.assignTimer = setInterval(() => void this.completeAssignments(), ASSIGNMENTS_EVERY);
    else if (!wanted && this.assignTimer) { clearInterval(this.assignTimer); this.assignTimer = undefined; }
  }
  async completeAssignments(): Promise<void> {
    if (this.stopped || this.assigning || !isSharedVaultId(this.info.id) || (this.currentRole !== "owner" && this.currentRole !== "admin")) return;
    this.assigning = true;
    try {
      let done = 0;
      for (const row of await listAssignments(this.info.id)) {
        const boxKey = asBoxPublicKey(row.boxKey);
        if (!boxKey) continue;
        // under the key lock: the key and its epoch cannot change between sealing and sending
        done += await this.locked(async () => {
          if (!this.rawKey) return 0;
          await completeAssignment(this.info.id, row.userId, await sealTo(boxKey, this.rawKey), this.epoch);
          return 1;
        }).catch(() => 0);
      }
      if (done) await this.refreshMembers();
    } catch { /* offline or not allowed now: the next run tries again */ }
    finally { this.assigning = false; }
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const run = this.keyTask.then(task);
    this.keyTask = run.catch(() => undefined);
    return run;
  }
  // Makes `key` the current one at `epoch`. The key it replaces stays readable here and on disk, wrapped with the personal
  // key, for the local copies still encrypted with it.
  private async adoptKey(raw: Uint8Array, epoch: number): Promise<void> {
    if (epoch <= this.epoch) return;
    if (this.rawKey) {
      this.keyring.set(this.epoch, { raw: this.rawKey, key: this.key });
      await putEpochKey(this.db, this.user.id, this.info.id, this.epoch, this.rawKey, this.personalKey);
    }
    const key = await importVaultKey(raw);
    // Moje notatki have no server copy wrapped for this device to open offline: the current key is kept here too.
    if (!isSharedVaultId(this.info.id)) { this.keyring.set(epoch, { raw, key }); await putEpochKey(this.db, this.user.id, this.info.id, epoch, raw, this.personalKey); }
    this.rawKey = raw;
    this.key = key;
    this.epoch = epoch;
  }
  // Moje notatki (docs/MCP.md §3.7): takes the keys of their own that the server holds, newest as current. With none yet,
  // and `migrate`, makes the first one (epoch 2, wrapped with the personal key) and re-encrypts the vault under it. The
  // server takes only the next epoch and never replaces a key, so two devices migrating at once end on the same key.
  // True when this device now has a newer key than before; the caller re-sends the vault under it.
  private async personalCatchUp(migrate = true): Promise<boolean> {
    const before = this.epoch;
    const rows = (await fetchPersonalKeys()).sort((a, b) => a.keyEpoch - b.keyEpoch);
    for (const row of rows) {
      if (this.keyAt(row.keyEpoch)) continue;
      const raw = await unwrapPersonalVaultKey(row.wrappedKey, this.personalKey, this.user.id, row.keyEpoch);
      if (row.keyEpoch > this.epoch) await this.adoptKey(raw, row.keyEpoch);
      else { this.keyring.set(row.keyEpoch, { raw, key: await importVaultKey(raw) }); await putEpochKey(this.db, this.user.id, this.info.id, row.keyEpoch, raw, this.personalKey); }
    }
    if (!rows.length && migrate && this.personalProven) {
      const raw = randomVaultKey();
      // no chat can have Moje notatki before they have a key of their own
      try { await putPersonalKey(2, await wrapPersonalVaultKey(raw, this.personalKey, this.user.id, 2), []); }
      catch (error) {
        if (error instanceof ApiError && error.status === 409) return this.personalCatchUp(false);
        throw error;
      }
      await this.adoptKey(raw, 2);
    }
    // Never saves here: a caller mid-open (a failed decrypt) holds no state yet. catchUp sends the vault again.
    return this.epoch !== before;
  }
  // Member side: opens the server's pending key for this user with the box key, stores it as the wrappedKey (PUT my-key)
  // and switches to it. False when no pending key is waiting.
  private async rekeyFrom(detail?: VaultDetail): Promise<boolean> {
    const current = detail ?? await fetchVault(this.info.id);
    const pending = current.pendingKey;
    if (!pending) return false;
    const raw = await adoptPending(this.info.id, pending, this.box, this.personalKey);
    await this.adoptKey(raw, pending.keyEpoch);
    return true;
  }
  // Admin side: a new vault key sealed for every current member, posted as the next epoch. Our own copy switches at once.
  // A member without a box key stops the rotation; it is retried on the next open.
  private async rotateFrom(detail: VaultDetail): Promise<boolean> {
    if (detail.role !== "owner" && detail.role !== "admin") return false;
    const missing = detail.members.filter((m) => !m.boxKey);
    if (missing.length) {
      toast(`Nie można zmienić klucza: ${missing.map((m) => m.email ?? m.name).join(", ")} nie mają jeszcze klucza szyfrowania. Poproś ich o zalogowanie.`, true);
      return false;
    }
    const raw = randomVaultKey();
    const keyEpoch = (detail.vault.keyEpoch ?? this.epoch) + 1;
    const keys = await Promise.all(detail.members.map(async (m) => ({ userId: m.userId, sealedKey: await sealTo(m.boxKey!, raw) })));
    // every live chat of a remaining member with this vault gets the new key too (the server refuses the rotation otherwise)
    const chats = await liveChats(this.info.id, detail.members.map((m) => ({ userId: m.userId, signingKey: m.signingKey ?? null, agents: m.agents ?? [] })),
      (agentId) => disconnectMemberAgent(this.info.id, agentId).then(() => undefined)); // a chat with a broken cert is taken out of this vault, which is enough: this rotation then needs no key for it
    const agentKeys: AgentKeyOut[] = await Promise.all(chats.map(async (c) => ({ agentId: c.agentId, sealedKey: await sealForAgent(raw, c.boxKey, this.info.id, "vault", keyEpoch) })));
    await rotateVaultKey(this.info.id, keyEpoch, keys, agentKeys);
    await putMyKey(this.info.id, keyEpoch, await wrapVaultKey(raw, this.personalKey));
    await this.adoptKey(raw, keyEpoch);
    // The snapshot is encrypted again with the new key and sent: the server's copy is still the old epoch.
    this.serverState = undefined;
    await this.persist();
    void this.tidyFiles();
    return true;
  }
  /** Brings the key up to date with the server: takes a pending key, and an admin rotates when the vault needs it. */
  catchUp(): Promise<void> {
    if (!isSharedVaultId(this.info.id)) return this.locked(async () => {
      if (!(await this.personalCatchUp())) return;
      // The server's copy is under the old key: the vault is sent again under the new one, and the files follow. Never
      // before the server's snapshot is merged here: a put of this device's state alone would replace the newer one.
      if (this.remoteSeen) await this.resendUnderNewKey();
      else this.resendWhenSeen = true;
    }).then(() => this.personalRevoked());
    return this.locked(async () => {
      const detail = await fetchVault(this.info.id);
      if (detail.pendingKey) await this.rekeyFrom(detail);
      else if (detail.needsRotation) await this.rotateFrom(detail);
    });
  }
  // Moje notatki get a new key when a chat that had them was disconnected after their newest key was made, however it was
  // disconnected (here, from another device, by the operator): the chat must not read what comes next.
  private async personalRevoked(): Promise<void> {
    const rows = await fetchPersonalKeys();
    const newest = Math.max(0, ...rows.map((r) => r.createdAt ?? 0));
    if (!rows.length || !newest) return;
    const vaultId = personalVaultId(this.user.id);
    const gone = (await listMyAgents()).filter((a) => a.revokedAt != null && a.revokedAt > newest && a.cert?.vaults?.some((v) => v.vaultId === vaultId));
    if (gone.length) await this.rotatePersonalKey(gone.map((a) => a.agentId));
  }
  /** Replaces the vault key now (owner or admin, from the members dialog). False when the change was refused. */
  rotateKey(): Promise<boolean> {
    return this.locked(async () => this.rotateFrom(await fetchVault(this.info.id)));
  }
  // ---- Claude chats (docs/MCP.md §3; used by agentpairing.ts) ------------------------------------------------------

  /** This user's signing key (null when none could be loaded). */
  get signingIdentity(): SigningIdentity | null { return this.signing ?? null; }
  /** This user's box key (null when none could be loaded): it opens the chats' proposals. */
  get boxIdentity(): BoxIdentity | null { return this.box ?? null; }
  /**
   * Moje notatki get a new key (the server's newest epoch + 1), sealed for this user's remaining chats with them; the
   * chats in `drop` (being disconnected or narrowed) get none. Open Moje notatki take it at once and are sent again
   * under it (catchUp, after the server's state is merged); elsewhere their next open does. False: still under the
   * personal key, so no chat ever had them.
   */
  async rotatePersonalKey(drop: string[] = []): Promise<boolean> {
    // without the server admin's consent the server keeps no Moje notatki to rotate
    if (!personalAllowed(this.user)) return false;
    const vaultId = personalVaultId(this.user.id);
    const made = await this.locked(async () => {
      const top = Math.max(1, ...(await fetchPersonalKeys()).map((r) => r.keyEpoch));
      if (top < 2) return false;
      if (!this.signing) throw new Error("Brak klucza podpisu na tym urządzeniu.");
      const agents = (await listMyAgents()).filter((a) => !drop.includes(a.agentId));
      const chats = await liveChats(vaultId, [{ userId: this.user.id, signingKey: this.signing.publicJwk, agents }], (agentId) => deleteAgent(agentId).then(() => undefined));
      const raw = randomVaultKey();
      const keyEpoch = top + 1;
      const agentKeys = await Promise.all(chats.map(async (c) => ({ agentId: c.agentId, sealedKey: await sealForAgent(raw, c.boxKey, vaultId, "vault", keyEpoch) })));
      await putPersonalKey(keyEpoch, await wrapPersonalVaultKey(raw, this.personalKey, this.user.id, keyEpoch), agentKeys);
      return true;
    });
    if (made && !isSharedVaultId(this.info.id)) await this.catchUp();
    return made;
  }
  /** The protected projects of this vault a chat of this user may get: verified, held here, and written by this user. */
  agentProjects(): string[] {
    return [...this.protectedEntries.values()].filter((e) => !e.path.endsWith(".md") && this.holds(e) && e.members.includes(this.user.id)
      && this.protectedChecks.get(e.path)?.status !== "unverified" && !this.editRefused(e.path)).map((e) => e.path).sort();
  }
  /** The protected projects whose key is sealed for this chat. */
  projectsOfChat(agentId: string): string[] {
    return [...this.protectedEntries.values()].filter((e) => e.agentKeys?.some((k) => k.agentId === agentId)).map((e) => e.path).sort();
  }
  /** Seals a project's key for this user's chat in the project's signed entry (docs/MCP.md §3.4), then saves. */
  grantProjectToChat(path: string, agentId: string, boxKey: string): Promise<void> {
    return this.locked(async () => {
      const entry = this.protectedEntries.get(path);
      if (!entry || !this.agentProjects().includes(path)) throw new Error("Tego projektu nie można dać czatowi.");
      const key = await this.projectKeyFor(entry);
      if (!key) throw new Error(NO_PROJECT_KEY);
      const sealedKey = await sealForAgent(key.raw, boxKey, this.info.id, chatSlot(path), entry.keyEpoch);
      const agentKeys = [...(entry.agentKeys ?? []).filter((k) => k.agentId !== agentId), { agentId, userId: this.user.id, sealedKey }];
      await this.storeEntry(await this.signEntry({ ...entry, agentKeys }), this.sealedCanon.get(path));
      await this.persist();
    });
  }
  /** Takes projects away from chats: each gets a new key (epoch + 1) without them; the other chats keep it. */
  revokeProjectsFromChats(paths: string[], agentIds: string[]): Promise<void> {
    return this.locked(async () => {
      for (const path of paths) {
        const entry = this.protectedEntries.get(path);
        if (!entry?.agentKeys?.some((k) => agentIds.includes(k.agentId))) continue;
        if (!(await this.projectKeyFor(entry))) throw new Error(NO_PROJECT_KEY);
        const chats = await this.projectChats(entry, agentIds);
        const payload = this.payloadAt(super.exportBrowserSnapshot(this.info.ownerUserId, this.info.id).state, path);
        const keyEpoch = entry.keyEpoch + 1;
        const raw = randomVaultKey();
        await this.holdProjectKey(path, keyEpoch, raw);
        await this.storeEntry(await this.buildEntry(path, keyEpoch, entry.members, entry.editors ?? [], raw, payload, entry.lead, chats), payloadKey(payload));
        void this.files.syncProject(path, entry.members).catch(() => undefined);
      }
      this.emit("tree_changed", null);
      await this.persist();
    });
  }
  /**
   * The versions kept before a chat's revisions since `sinceMs` (agentVersionReason), oldest first: `text` before the
   * revision, `after` the text right after it (agentAfterReason; null when the revision deleted the note or none was kept);
   * `from` and `to` the note's path before and after it (null when not kept).
   */
  async chatVersions(agentId: string, sinceMs: number): Promise<ChatVersion[]> {
    const reason = agentVersionReason(agentId), afterReason = agentAfterReason(agentId);
    const raw = (this as unknown as { versions: Map<string, { id: number; path?: string }[]> }).versions;
    const out: ChatVersion[] = [];
    for (const id of new Set([...this.notes.keys(), ...this.trash.keys()])) {
      const path = this.notes.get(id)?.path ?? this.trash.get(id)?.path ?? "";
      const list = await this.call<{ id: number; time_ms: number; reason: string }[]>("list_versions", { id });
      // versions up to the last undo of this chat's changes are done with
      const undone = Math.max(-1, ...list.filter((x) => x.reason === agentUndoneReason(agentId)).map((x) => x.time_ms));
      const textOf = (vid: number): Promise<string> => this.call<string>("version_text", { vid });
      const pathOf = (vid: number): string | null => raw.get(id)?.find((x) => x.id === vid)?.path ?? null;
      for (const v of list) {
        if (v.reason !== reason || v.time_ms < sinceMs || v.time_ms <= undone) continue;
        const pair = list.find((x) => x.reason === afterReason && x.time_ms === v.time_ms && x.id === v.id + 1);
        out.push({ noteId: id, path, at: v.time_ms, vid: v.id, text: await textOf(v.id), after: pair ? await textOf(pair.id) : null, from: pathOf(v.id), to: pair ? pathOf(pair.id) : null });
      }
    }
    return out.sort((a, b) => a.at - b.at || a.vid - b.vid);
  }
  /** Marks a note as put back by "Cofnij zmiany czatu": a version with its text now (synced like any version). */
  markChatUndone(id: string, agentId: string): void {
    const self = this as unknown as { versions: Map<string, { id: number; time_ms: number; reason: string; text: string }[]>; nextVersion: number };
    const text = this.notes.get(id)?.doc.getText("content").toString() ?? "";
    self.versions.set(id, [{ id: self.nextVersion++, time_ms: Date.now(), reason: agentUndoneReason(agentId), text }, ...(self.versions.get(id) ?? [])]);
    this.schedulePersist();
  }
  /** Whether the note is in the tree here (not deleted, not in a project this device cannot open). */
  hasNote(id: string): boolean { return this.notes.has(id); }

  // ---- Stage E: protected projects ---------------------------------------------------------------------------------
  // Entries are kept as the server sent them, or as sealed here. `projectKeys`: the project keys this user holds (on disk
  // too). `sealedCanon`: the payload this device last sealed or opened for a project; a save seals it again only when the
  // notes changed since, so an unchanged project is not sent again.
  private protectedEntries = new Map<string, ProtectedEntry>();
  private protectedMarks = new Map<string, ProtectedMark>();
  private protectedChecks = new Map<string, EventCheck>();
  private projectKeys = new Map<string, ProjectKey>();
  private trusted = new Map<string, Baseline>();
  // The verified lead of each entry (null: none, or an appointment whose signer is no longer an owner or admin).
  private leads = new Map<string, string | null>();
  private saveKeyStore(): Promise<void> { return writeProjectKeys(this.db, this.user.id, this.info.id, this.projectKeys, this.personalKey, this.trusted); }
  private sealedCanon = new Map<string, string>();
  // Per entry: what this device held back from its last payload (admitPayload), sealed again with it.
  private withheld = new Map<string, ProtectedPayload>();

  private holds(entry: ProtectedEntry): boolean { return this.projectKeys.has(projectSlot(entry.path, entry.keyEpoch)); }
  // The protected folders under `path` (their notes and folders sit in their own payloads, not in the one of `path`).
  private nestedIn(path: string): string[] { return [...this.protectedEntries.keys()].filter((p) => under(p, path) && !p.endsWith(".md")); }
  private payloadAt(state: BrowserVaultSnapshot["state"], path: string): ProtectedPayload { return payloadOf(state, path, this.nestedIn(path)); }
  // The protected entry that holds `path` most closely: a folder nested in a protected folder, over its parent.
  private entryAt(path: string): ProtectedEntry | undefined {
    let found: ProtectedEntry | undefined;
    for (const e of this.protectedEntries.values()) if (inside(path, e.path) && (!found || e.path.length > found.path.length)) found = e;
    return found;
  }
  // A path whose closest protected entry this user does not hold: nothing is written or read there.
  private lockedAt(path: string): boolean { const e = this.entryAt(path); return !!e && !this.holds(e); }
  // A locked entry's notes leave this device: by path, unless a folder this user holds lies under it (its own notes stay),
  // and by id, for the notes moved into it from elsewhere (see takes).
  private forgetLocked(entry: ProtectedEntry): void {
    const nestedHeld = [...this.protectedEntries.values()].some((e) => under(e.path, entry.path) && this.holds(e));
    this.forgetFolder(nestedHeld ? null : entry.path, (entry.noteIds ?? []).filter((id) => this.takes(entry, id)));
  }
  // Whether an entry's signer may take a note out of the plain state: a vault owner, admin or editor (who may write the
  // plain place it came from), on an entry not flagged. A project member who only views the vault may not.
  private takesPlain(entry: ProtectedEntry): boolean {
    if (this.protectedChecks.get(entry.path)?.status === "unverified") return false;
    const role = this.serverMembers.find((m) => m.userId === entry.signerUserId)?.role;
    return role === "owner" || role === "admin" || role === "editor";
  }
  // Whether `entry`, listing `id` in its noteIds, takes that note from this device's plain state. A note held here at a plain
  // place (or arriving only as a plain copy: `plainIn` and not `heldIn`, the ids of the held payloads coming in) is taken
  // only by a signer who may (takesPlain). A note in a folder this user holds is taken only once that folder's own signed
  // noteIds no longer list it (another entry never takes a held project's note away).
  private takes(entry: ProtectedEntry, id: string, plainIn = new Set<string>(), heldIn = new Set<string>()): boolean {
    const n = this.notes.get(id);
    const at = n && this.entryAt(n.path);
    if (at && at !== entry && this.holds(at) && at.noteIds?.includes(id)) return false;
    const plainHere = n ? !at : plainIn.has(id) && !heldIn.has(id);
    return !plainHere || this.takesPlain(entry);
  }
  // The ids the protected entries take out of a plain state (see takes).
  private claimedIds(plainIn?: Set<string>, heldIn?: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const e of this.protectedEntries.values()) for (const id of e.noteIds ?? []) if (!out.has(id) && this.takes(e, id, plainIn, heldIn)) out.add(id);
    return out;
  }
  // What of a held payload comes in: notes, tombstones, trash and folders inside its path and outside the folders nested
  // under it; never a note held here at a plain place from a signer who may not take it (takesPlain), nor one another held
  // project here lists (when this device holds no copy, neither project gets it). What is held back stays in the entry:
  // `withheld`, sealed again with it (withWithheld), so a reseal here never drops a note this device could not place.
  private admitPayload(entry: ProtectedEntry, payload: ProtectedPayload): { admitted: ProtectedPayload; withheld: ProtectedPayload } {
    const nested = this.nestedIn(entry.path);
    const mine = (path: string) => inside(path, entry.path) && !nested.some((n) => inside(path, n));
    const ok = (id: string, path: string) => {
      if (!mine(path)) return false;
      const n = this.notes.get(id);
      const at = n && this.entryAt(n.path);
      if (n && !at) return this.takesPlain(entry);
      if (at) return at === entry || !this.holds(at) || !at.noteIds?.includes(id);
      return ![...this.protectedEntries.values()].some((e) => e !== entry && this.holds(e) && e.noteIds?.includes(id));
    };
    const part = (take: (id: string, path: string) => boolean): ProtectedPayload => {
      const notes = payload.notes.filter((x) => take(x.id, x.path));
      const deleted = payload.deleted.filter((x) => take(x.id, x.path));
      const trash = (payload.trash ?? []).filter((x) => take(x.id, x.path));
      const ids = new Set([...notes, ...deleted, ...trash].map((x) => x.id));
      return { notes, deleted, trash, versions: payload.versions.filter(([id]) => ids.has(id)), events: (payload.events ?? []).filter((e) => ids.has(e.note_id)), folderChanges: [] };
    };
    // a link is the project's (by projectPath), never a note's: it is admitted by place only, and merged by rev (mergeLinks)
    const github = (Array.isArray(payload.github) ? payload.github : []).filter((l) => validLink(l) && mine(l.projectPath));
    const admitted = { ...part(ok), folderChanges: (payload.folderChanges ?? []).filter((f) => mine(f.path)), github };
    // what lies outside the entry's place is not its own: dropped, not held back
    return { admitted, withheld: part((id, path) => mine(path) && !ok(id, path)) };
  }
  // A payload with the items this device held back from the entry's last payload put back (those not in it already).
  private withWithheld(path: string, payload: ProtectedPayload): ProtectedPayload {
    const kept = this.withheld.get(path);
    if (!kept) return payload;
    const have = new Set(noteIdsOf(payload));
    const notes = kept.notes.filter((x) => !have.has(x.id)), deleted = kept.deleted.filter((x) => !have.has(x.id)), trash = (kept.trash ?? []).filter((x) => !have.has(x.id));
    const ids = new Set([...notes, ...deleted, ...trash].map((x) => x.id));
    if (ids.size === 0) return payload;
    return {
      ...payload,
      notes: [...payload.notes, ...notes], deleted: [...payload.deleted, ...deleted], trash: [...(payload.trash ?? []), ...trash],
      versions: [...payload.versions, ...kept.versions.filter(([id]) => ids.has(id))],
      events: [...(payload.events ?? []), ...(kept.events ?? []).filter((e) => ids.has(e.note_id))],
    };
  }

  // The key of an entry: held, or opened from this user's sealed copy and kept. null when this user is not a member.
  private async projectKeyFor(entry: ProtectedEntry): Promise<ProjectKey | null> {
    const held = this.projectKeys.get(projectSlot(entry.path, entry.keyEpoch));
    if (held) return held;
    const mine = entry.keys.find((k) => k.userId === this.user.id);
    if (!mine || !this.box) return null;
    let raw: Uint8Array;
    try { raw = await openSealed(mine.sealedKey, this.box.privateKey); } catch { return null; }
    return this.holdProjectKey(entry.path, entry.keyEpoch, raw);
  }
  private async holdProjectKey(path: string, keyEpoch: number, raw: Uint8Array): Promise<ProjectKey> {
    const held: ProjectKey = { path, keyEpoch, raw, key: await importVaultKey(raw) };
    this.projectKeys.set(projectSlot(path, keyEpoch), held);
    await this.saveKeyStore();
    return held;
  }

  // Runs on a snapshot before its notes merge. A project this user holds is opened and its notes join the snapshot; one
  // this user cannot open loses its plain copy here, so only the entry remains.
  private async unfold(snapshot: BrowserVaultSnapshot): Promise<void> {
    if (!isSharedVaultId(this.info.id)) return;
    const before = this.protectionKey();
    for (const mark of snapshot.state.unprotected ?? []) if (await this.validMark(mark)) this.applyMark(mark);
    const incoming = new Set<string>();
    for (const entry of snapshot.state.protected ?? []) {
      if (!validEntry(entry)) throw new Error("Zapis zawiera nieprawidłowy chroniony projekt.");
      if ((this.protectedMarks.get(entry.path)?.keyEpoch ?? -1) >= entry.keyEpoch) continue;
      if ((this.protectedEntries.get(entry.path)?.keyEpoch ?? 0) > entry.keyEpoch) continue;
      await this.storeEntry(entry);
      incoming.add(entry.path);
    }
    const locked: string[] = [];
    const held: { entry: ProtectedEntry; key: ProjectKey }[] = [];
    for (const entry of [...this.protectedEntries.values()]) {
      const key = await this.projectKeyFor(entry);
      if (!key) { locked.push(entry.path); this.forgetLocked(entry); continue; }
      if (incoming.has(entry.path)) held.push({ entry, key });
    }
    // a locked project's links leave this device too (forgetLocked keeps a locked parent's place when it holds a nested folder)
    if (locked.length) this.githubLinks = this.githubLinks.filter((l) => !this.lockedAt(l.projectPath));
    const opened: { entry: ProtectedEntry; payload: ProtectedPayload }[] = [];
    for (const { entry, key } of held) {
      try {
        const { admitted, withheld } = this.admitPayload(entry, await openPayload(this.info.id, entry, key.key));
        this.withheld.set(entry.path, withheld);
        opened.push({ entry, payload: admitted });
      } catch {
        this.protectedChecks.set(entry.path, { status: "unverified", reason: "Nie udało się odszyfrować projektu. Zapis mógł zostać zmieniony." });
      }
    }
    // Before the held payloads come in: a locked entry's plain copy goes (a held folder nested in it keeps its notes), and so
    // does every plain copy of a note an entry lists (a forged plain copy must not pull a protected note out of its project).
    const heldIn = new Set(opened.flatMap(({ payload }) => noteIdsOf(payload)));
    dropFolders(snapshot.state, locked);
    dropIds(snapshot.state, this.claimedIds(new Set(snapshot.state.notes.map((n) => n.id)), heldIn));
    this.dropPlainLinks(snapshot.state);
    for (const { entry, payload } of opened) {
      if (payload.github?.length) snapshot.state.github = [...(snapshot.state.github ?? []), ...payload.github];
      snapshot.state.notes.push(...payload.notes);
      snapshot.state.versions.push(...payload.versions);
      snapshot.state.deleted = [...(snapshot.state.deleted ?? []), ...payload.deleted];
      snapshot.state.trash = [...(snapshot.state.trash ?? []), ...(payload.trash ?? [])];
      if (snapshot.state.organization) snapshot.state.organization.events.push(...(payload.events ?? []));
      snapshot.state.folderChanges = [...(snapshot.state.folderChanges ?? []), ...(payload.folderChanges ?? [])];
      this.sealedCanon.set(entry.path, payloadKey(this.withWithheld(entry.path, payload)));
    }
    if (before !== this.protectionKey()) this.emit("tree_changed", null);
    void this.healAdmins().catch(() => undefined);
    void this.dropChatKeys().catch(() => undefined);
  }
  private protectionKey(): string {
    return JSON.stringify([[...this.protectedEntries].map(([p, e]) => [p, e.keyEpoch, this.protectedChecks.get(p)?.status]), [...this.protectedMarks.keys()]]);
  }
  // An unsigned mark, or one signed by someone who may not lift the protection, is left out (and so not passed on).
  private async validMark(mark: ProtectedMark): Promise<boolean> {
    if (typeof mark?.path !== "string" || !Number.isInteger(mark.keyEpoch)) return false;
    // a mark lifts protection: never a chat's (docs/MCP.md §6)
    if ((mark as { alg?: unknown }).alg !== undefined) return false;
    if ((await verifySigned(mark, this.signerMembers())).status !== "ok") return false;
    const role = this.serverMembers.find((m) => m.userId === mark.signerUserId)?.role;
    if (role === "owner" || role === "admin") return true;
    // a note protected on its own, taken in by a folder protected around it (protectProject)
    return mark.path.endsWith(".md") && !mark.deleted && [...this.protectedEntries.values()].some((e) =>
      under(mark.path, e.path) && e.members.includes(mark.signerUserId!) && this.protectedChecks.get(e.path)?.status !== "unverified");
  }
  private async signedMark(mark: ProtectedMark): Promise<ProtectedMark> {
    if (!this.signing) throw new Error("Brak klucza podpisu na tym urządzeniu.");
    await signEvent(mark, this.signing);
    return mark;
  }
  private applyMark(mark: ProtectedMark): void {
    if ((this.protectedMarks.get(mark.path)?.keyEpoch ?? -1) < mark.keyEpoch) this.protectedMarks.set(mark.path, mark);
    if ((this.protectedEntries.get(mark.path)?.keyEpoch ?? Infinity) <= mark.keyEpoch) {
      this.dropEntry(mark.path);
      // A deleted project: its notes leave this device too (the tombstones of the same snapshot delete them).
      if (mark.deleted) this.forgetFolder(mark.path, mark.noteIds);
    }
  }
  private dropEntry(path: string): void {
    this.protectedEntries.delete(path);
    this.protectedChecks.delete(path);
    this.sealedCanon.delete(path);
    this.withheld.delete(path);
    this.leads.delete(path);
    if (this.trusted.delete(path)) void this.saveKeyStore().catch(() => undefined);
  }
  // Stores an entry with its check. `canon`: the payload it was sealed from or opened to, when this device knows it.
  // A change is checked against the baseline (the last entry verified here, also from before a reload), else the entry
  // held now if it is not flagged. A verified entry becomes the baseline.
  private async storeEntry(entry: ProtectedEntry, canon?: string): Promise<void> {
    const held = this.protectedEntries.get(entry.path);
    const previous = this.trusted.get(entry.path) ?? (held && this.protectedChecks.get(entry.path)?.status !== "unverified" ? held : undefined);
    this.protectedEntries.set(entry.path, entry);
    const check = await this.checkEntry(entry, previous);
    this.protectedChecks.set(entry.path, check);
    if (check.status !== "unverified") {
      const { path, keyEpoch, members, editors, lead, keys, agentKeys } = entry;
      const baseline: Baseline = { path, keyEpoch, members, editors, keys, ...(agentKeys?.length ? { agentKeys } : {}), ...(lead ? { lead } : {}) };
      if (canonicalJson(baseline) !== canonicalJson(this.trusted.get(path) ?? null)) { this.trusted.set(path, baseline); await this.saveKeyStore().catch(() => undefined); }
    }
    if (canon === undefined) this.sealedCanon.delete(entry.path);
    else this.sealedCanon.set(entry.path, canon);
  }
  // Valid when the signature holds for a vault member, and the signer may write the project: an owner or admin, an editor
  // (when the entry names editors) or a member. Changing who is in it, or who edits, is for its managers: owner, admin or lead.
  private async checkEntry(entry: ProtectedEntry, previous?: Baseline): Promise<EventCheck> {
    const check = await verifySigned(entry, this.signerMembers());
    if (check.status === "unverified") return check;
    const agentKeys = entry.agentKeys ?? [];
    if (!Array.isArray(agentKeys) || agentKeys.some((k) => !entry.members.includes(k?.userId) || typeof k?.agentId !== "string"))
      return { status: "unverified", reason: "Klucz projektu dla czatu Claude ma osobę spoza projektu." };
    const signer = this.serverMembers.find((m) => m.userId === entry.signerUserId);
    // A chat writes notes only: who holds the project, who edits and leads it, and its keys stay as verified (docs/MCP.md §6).
    // Version 1: a chat writes into a protected project only through a proposal (docs/MCP.md §19), so an entry it signed is
    // never one to trust here.
    if (entry.alg === "ed25519") return { status: "unverified", reason: "Czat Claude zmienia chronione projekty tylko przez propozycje." };
    const manages = signer?.role === "owner" || signer?.role === "admin";
    const writers = entry.editors?.length ? entry.editors : entry.members;
    if (!signer || !(manages || writers.includes(signer.userId))) return { status: "unverified", reason: "Podpisujący nie zarządza tym projektem i nie jest jego członkiem." };
    // The lead: an appointment an owner or admin signed for this project, and changed by them only.
    // A forged appointment flags the entry; one whose signer is no longer an owner or admin (or no longer here) has lapsed:
    // the project has no lead until one is appointed again, and the entry stays valid.
    const lead = entry.lead ? await this.leadStatus(entry.lead, entry.path) : "none";
    if (lead === "forged") return { status: "unverified", reason: LEAD_TEXT };
    this.leads.set(entry.path, lead === "ok" ? entry.lead!.userId : null);
    // The lead in effect now, here and in the baseline (an appointment that lapsed since counts as none): a change of it,
    // or a members change by the baseline's lead once that has lapsed, is for owners and admins only.
    const leadNow = lead === "ok" ? entry.lead!.userId : null;
    const leadBefore = previous?.lead && (await this.leadStatus(previous.lead, previous.path)) === "ok" ? previous.lead.userId : null;
    if (previous && leadNow !== leadBefore && !manages) return { status: "unverified", reason: LEAD_TEXT };
    const same = (a: string[] = [], b: string[] = []) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
    const changed = previous && previous.keyEpoch <= entry.keyEpoch && (!same(previous.members, entry.members) || !same(previous.editors, entry.editors));
    // A members change by a lead: the lead of the project as this device verified it before (never the note's text).
    // a project's own entry: its lead before the change; a folder inside a project: the project's lead in effect now
    const isRoot = entry.path.split("/").length === 2 && entry.path.startsWith("Projekty/");
    const leadOfChange = isRoot ? leadBefore : this.leadOf(entry.path);
    if (changed && !manages && leadOfChange !== signer.userId) return { status: "unverified", reason: "Zmiana członków lub edytorów przez osobę bez uprawnień." };
    // A person's chats get the project key from that person only; a manager may take them away (WEB-WSPOLDZIELENIE).
    if (previous) {
      const before = previous.agentKeys ?? [];
      const sameEpoch = previous.keyEpoch === entry.keyEpoch;
      for (const userId of new Set([...before, ...agentKeys].map((k) => k.userId))) {
        if (userId === signer.userId) continue;
        const was = new Map(before.filter((k) => k.userId === userId).map((k) => [k.agentId, canonicalJson(k.sealedKey)]));
        const now = new Map(agentKeys.filter((k) => k.userId === userId).map((k) => [k.agentId, canonicalJson(k.sealedKey)]));
        const added = [...now.keys()].some((id) => !was.has(id));
        const changedKeys = [...was].some(([id, sealed]) => !now.has(id) || (sameEpoch && now.get(id) !== sealed));
        if (added || (changedKeys && !manages && leadOfChange !== signer.userId)) return { status: "unverified", reason: "Klucz projektu dla czatu Claude zmienia tylko osoba tego czatu." };
      }
    }
    return check;
  }

  // Before a save: a project whose notes changed since this device sealed or opened them is sealed and signed again.
  // A copy this device never opened has no baseline, so it is never sealed from: it stays as it came, flagged.
  private async sealProtected(): Promise<void> {
    if (this.protectedEntries.size === 0) return;
    const plain = super.exportBrowserSnapshot(this.info.ownerUserId, this.info.id).state;
    for (const entry of [...this.protectedEntries.values()]) {
      const base = this.sealedCanon.get(entry.path);
      // a flagged entry's key may be known to whoever forged it: nothing is sealed under it again (writes are refused too)
      if (base === undefined || this.protectedChecks.get(entry.path)?.status === "unverified") continue;
      const key = await this.projectKeyFor(entry);
      if (!key) continue;
      const payload = this.withWithheld(entry.path, this.payloadAt(plain, entry.path));
      const canon = payloadKey(payload);
      if (canon === base) continue;
      const envelope = await sealPayload(this.info.id, entry.path, entry.keyEpoch, key.key, payload);
      await this.storeEntry(await this.signEntry({ ...entry, envelope, noteIds: noteIdsOf(payload) }), canon);
    }
  }
  // An entry for `members`: the project key sealed to each of them, the payload sealed under it, signed by this user.
  // `chats`: the members' chats that keep the project (its key sealed to them too); a chat of a non-member is left out.
  private async buildEntry(path: string, keyEpoch: number, members: string[], editors: string[], raw: Uint8Array, payload: ProtectedPayload, lead?: LeadAppointment, chats: { agentId: string; userId: string; boxKey: string }[] = []): Promise<ProtectedEntry> {
    const keys = await Promise.all(members.map(async (userId) => ({ userId, sealedKey: await sealTo(this.boxKeyOf(userId), raw) })));
    const agentKeys = await Promise.all(chats.filter((c) => members.includes(c.userId)).map(async (c) =>
      ({ agentId: c.agentId, userId: c.userId, sealedKey: await sealForAgent(raw, c.boxKey, this.info.id, chatSlot(path), keyEpoch) })));
    const envelope = await sealPayload(this.info.id, path, keyEpoch, await importVaultKey(raw), payload);
    return this.signEntry({ path, keyEpoch, members, editors, keys, envelope, noteIds: noteIdsOf(payload), ...(agentKeys.length ? { agentKeys } : {}), ...(lead ? { lead } : {}) });
  }
  // The chats holding an entry's key now, still live (unrevoked, cert verified), but `drop`.
  private projectChats(entry: ProtectedEntry, drop: string[] = []): Promise<{ agentId: string; userId: string; boxKey: string }[]> {
    const held = (entry.agentKeys ?? []).filter((k) => !drop.includes(k.agentId));
    return liveChats(this.info.id, this.signerMembers().map((m) => ({ ...m, agents: m.agents?.filter((a) => held.some((k) => k.agentId === a.agentId && k.userId === m.userId)) })));
  }
  private async signEntry(entry: ProtectedEntry): Promise<ProtectedEntry> {
    if (!this.signing) throw new Error("Brak klucza podpisu na tym urządzeniu.");
    // signed by this user now, never left marked as a chat's
    const { alg: _alg, signerAgentId: _agent, ...signed } = entry;
    await signEvent(signed, this.signing);
    return signed;
  }
  private boxKeyOf(userId: string): JsonWebKey {
    const member = this.serverMembers.find((m) => m.userId === userId);
    if (!member?.boxKey) throw new Error(`Nie można zaszyfrować projektu dla ${member?.email ?? userId}: brak klucza szyfrowania.`);
    return member.boxKey;
  }
  private adminIds(): string[] { return this.serverMembers.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.userId); }
  // The members a project is sealed for: the ones picked, the owners and admins (who can always open it), and this user.
  // An owner or admin without a box key is left out; a picked member or this user without one is refused.
  private membersFor(picked: string[]): string[] {
    const admins = this.serverMembers.filter((m) => (m.role === "owner" || m.role === "admin") && m.boxKey).map((m) => m.userId);
    for (const id of [...new Set([...picked, this.user.id])]) this.boxKeyOf(id);
    return [...new Set([...picked, ...admins, this.user.id])].sort();
  }
  // The picked editors, the owners and admins and this user, among the members. Never empty: a member not picked is read-only.
  private editorsFor(editors: string[], members: string[]): string[] {
    return [...new Set([...editors, ...this.adminIds(), this.user.id])].filter((id) => members.includes(id)).sort();
  }

  /** Protects `path` for `picked` (and the owners, admins and this user), with `editors` among them. */
  private async protectProject(path: string, picked: string[], editors: string[], target: ProtectionTarget, lead?: string | null): Promise<void> {
    await this.requireManage(path, target);
    if (this.protectedEntries.has(path)) throw new Error("Ten projekt jest już chroniony.");
    const newLead = await this.leadChange(path, undefined, lead, target);
    // A folder may sit inside a protected one (its own members, its own entry), and absorbs the notes protected on their own
    // by older versions (their keys are needed: their notes then sit in the folder's payload, and their entries go).
    const inner = [...this.protectedEntries.values()].filter((e) => e.path.endsWith(".md") && under(e.path, path));
    for (const e of inner) if (!(await this.projectKeyFor(e))) throw new Error(NO_PROJECT_KEY);
    const members = this.membersFor(newLead ? [...picked, newLead.userId] : picked);
    const keyEpoch = (this.protectedMarks.get(path)?.keyEpoch ?? 0) + 1;
    const raw = randomVaultKey();
    const payload = this.payloadAt(super.exportBrowserSnapshot(this.info.ownerUserId, this.info.id).state, path);
    const entry = await this.buildEntry(path, keyEpoch, members, this.editorsFor(newLead ? [...editors, newLead.userId] : editors, members), raw, payload, newLead);
    for (const e of inner) { this.dropEntry(e.path); this.protectedMarks.set(e.path, await this.signedMark({ path: e.path, keyEpoch: e.keyEpoch, unprotectedAt: Date.now() })); }
    await this.holdProjectKey(path, keyEpoch, raw);
    await this.storeEntry(entry, payloadKey(payload));
    this.emit("tree_changed", null);
    void this.files.syncProject(path, members).catch(() => undefined);
    await this.persist();
  }
  /** Adds members or changes editors (the same key, sealed for the new members too), or removes some: then a new key, epoch + 1. */
  private async setProjectMembers(path: string, picked: string[], editors: string[], target: ProtectionTarget, lead?: string | null): Promise<void> {
    await this.requireManage(path, target);
    const entry = this.protectedEntries.get(path);
    if (!entry) throw new Error("Ten projekt nie jest chroniony.");
    const key = await this.projectKeyFor(entry);
    if (!key) throw new Error(NO_PROJECT_KEY);
    const newLead = await this.leadChange(path, entry, lead, target);
    const members = this.membersFor(newLead ? [...picked, newLead.userId] : picked);
    const withEditors = this.editorsFor(newLead ? [...editors, newLead.userId] : editors, members);
    // a flagged entry's key may be known to whoever forged it: setting its members again always makes a new one
    const flagged = this.protectedChecks.get(path)?.status === "unverified";
    if (!flagged && entry.members.every((id) => members.includes(id))) {
      const { lead: _old, ...rest } = entry;
      await this.storeEntry(await this.sameKeyEntry(newLead ? { ...rest, lead: newLead } : rest, key.raw, members, withEditors), this.sealedCanon.get(path));
    } else {
      const payload = this.payloadAt(super.exportBrowserSnapshot(this.info.ownerUserId, this.info.id).state, path);
      const keyEpoch = entry.keyEpoch + 1;
      const raw = randomVaultKey();
      const chats = await this.projectChats(entry);
      await this.holdProjectKey(path, keyEpoch, raw);
      await this.storeEntry(await this.buildEntry(path, keyEpoch, members, withEditors, raw, payload, newLead, chats), payloadKey(payload));
    }
    this.emit("tree_changed", null);
    void this.files.syncProject(path, members).catch(() => undefined);
    await this.persist();
  }
  /** Takes the protection off: the notes become plain state again, and a marker keeps older protected copies out. */
  private async unprotectProject(path: string): Promise<void> {
    const entry = this.protectedEntries.get(path);
    if (!entry) throw new Error("Ten projekt nie jest chroniony.");
    if (this.currentRole !== "owner" && this.currentRole !== "admin") throw new Error("Ochronę zdejmuje właściciel lub administrator.");
    if (!(await this.projectKeyFor(entry))) throw new Error(NO_PROJECT_KEY);
    this.dropEntry(path);
    this.protectedMarks.set(path, await this.signedMark({ path, keyEpoch: entry.keyEpoch, unprotectedAt: Date.now() }));
    this.emit("tree_changed", null);
    await this.persist();
  }
  // The same key for `members`: sealed for those who lack it, and the entry signed again.
  private async sameKeyEntry(entry: ProtectedEntry, raw: Uint8Array, members: string[], editors: string[]): Promise<ProtectedEntry> {
    const keys = entry.keys.filter((k) => members.includes(k.userId));
    for (const userId of members) if (!keys.some((k) => k.userId === userId)) keys.push({ userId, sealedKey: await sealTo(this.boxKeyOf(userId), raw) });
    const { agentKeys: chats, ...rest } = entry;
    const agentKeys = chats?.filter((k) => members.includes(k.userId)) ?? [];
    return this.signEntry({ ...rest, members, editors, keys, ...(agentKeys.length ? { agentKeys } : {}) });
  }
  // Owners and admins are always members of a protected project. One who is missing gets the same key, if this user holds it.
  // Project keys sealed for chats that were disconnected since, or for any chat once the organization no longer lets chats
  // see protected projects: a device that holds the key and may manage the project (or is the chat's person) makes a new
  // key without them (docs/WEB-WSPOLDZIELENIE.md, "Protected projects").
  private async dropChatKeys(): Promise<void> {
    // without the server's list of chats (an older server) nothing is known to be disconnected
    if (!isSharedVaultId(this.info.id) || this.serverMembers.some((m) => !Array.isArray(m.agents))) return;
    // live: unrevoked, of a member, and still with this vault in its cert (a scope narrowed elsewhere drops the vault)
    const liveNow = (): Set<string> => new Set(this.serverMembers.flatMap((m) => (m.agents ?? [])
      .filter((a) => a.revokedAt == null && a.cert?.vaults?.some((v) => v.vaultId === this.info.id)).map((a) => a.agentId)));
    let live = liveNow();
    const known = (): Set<string> => new Set(this.serverMembers.flatMap((m) => (m.agents ?? []).map((a) => a.agentId)));
    const mine = (keys: { userId: string }[]): boolean => keys.every((k) => k.userId === this.user.id);
    // this device makes a new key only when it holds the key and the chats are this user's or it manages the project
    const canAct = async (entry: ProtectedEntry, keys: { userId: string }[]): Promise<boolean> =>
      !!this.projectKeys.get(projectSlot(entry.path, entry.keyEpoch)) && (mine(keys) || await this.canManage(entry.path, entry.path.startsWith("Projekty/") ? "project" : "folder"));
    // A chat this list does not know (paired a moment ago, or gone from it) is taken for gone only on a list loaded now.
    // It is loaded only for an entry this device can act on, and at most once in CHAT_LIST_MS per entry.
    let fresh = false;
    for (const entry of [...this.protectedEntries.values()]) {
      const unknown = (entry.agentKeys ?? []).filter((k) => !known().has(k.agentId));
      if (fresh || !unknown.length || Date.now() - (this.chatListAt.get(entry.path) ?? 0) < CHAT_LIST_MS || !(await canAct(entry, unknown))) continue;
      this.chatListAt.set(entry.path, Date.now());
      await this.refreshMembers();
      if (this.serverMembers.some((m) => !Array.isArray(m.agents))) return;
      live = liveNow();
      fresh = true;
    }
    const all = this.agentPolicy ? !this.agentPolicy.allowProtected : false;
    for (const entry of [...this.protectedEntries.values()]) {
      const gone = (entry.agentKeys ?? []).filter((k) => all || (known().has(k.agentId) ? !live.has(k.agentId) : fresh));
      if (!gone.length || !(await canAct(entry, gone))) continue;
      await this.revokeProjectsFromChats([entry.path], gone.map((k) => k.agentId));
    }
  }
  // When dropChatKeys last loaded the members for an entry's unknown chats (by path).
  private chatListAt = new Map<string, number>();
  private async healAdmins(): Promise<void> {
    if (this.currentRole !== "owner" && this.currentRole !== "admin") return;
    let healed = false;
    for (const entry of [...this.protectedEntries.values()]) {
      const held = this.projectKeys.get(projectSlot(entry.path, entry.keyEpoch));
      // a flagged entry is never signed again here: that would make it valid everywhere
      if (!held || this.protectedChecks.get(entry.path)?.status === "unverified") continue;
      const missing = this.adminIds().filter((id) => !entry.members.includes(id) && this.serverMembers.some((m) => m.userId === id && m.boxKey));
      if (missing.length === 0) continue;
      const members = [...entry.members, ...missing].sort();
      // an entry that names no editors (made before editors were picked) keeps that: every member may edit
      const editors = entry.editors?.length ? this.editorsFor(entry.editors, members) : [];
      await this.storeEntry(await this.sameKeyEntry(entry, held.raw, members, editors), this.sealedCanon.get(entry.path));
      healed = true;
    }
    if (healed) this.schedulePersist();
  }
  private async requireManage(path: string, target: ProtectionTarget): Promise<void> {
    if (!isSharedVaultId(this.info.id)) throw new Error("Chronić projekt można tylko w udostępnionej przestrzeni.");
    if (!(await this.canManage(path, target))) throw new Error(MANAGE_TEXT);
  }
  // Owners and admins manage anything. The lead manages a project: its folder and the folders in it. An editor of a
  // protected folder starts the protection of a folder inside it that has none yet (the editor is its first member).
  private async canManage(path: string, target: ProtectionTarget): Promise<boolean> {
    if (this.currentRole === "owner" || this.currentRole === "admin") return true;
    if (target === "project" && this.leadOf(path) === this.user.id) return true;
    const above = this.entryAt(path);
    return this.currentRole === "editor" && !this.protectedEntries.has(path) && !!above && this.holds(above) && !this.editRefused(path);
  }
  // What a permissions request covers: a folder as it is; a note, its innermost protected folder above it or else its own
  // folder (its rights are the folder's). A note protected on its own (older versions) keeps its entry.
  private protectable(requested: string): { path: string; target: ProtectionTarget } {
    if (!requested.endsWith(".md")) return { path: requested, target: requested.startsWith("Projekty/") ? "project" : "folder" };
    if (this.protectedEntries.has(requested)) return { path: requested, target: "note" };
    if (!requested.includes("/")) throw new Error(ROOT_NOTE_TEXT);
    const path = ancestorsOf(requested).reverse().find((f) => this.protectedEntries.has(f)) ?? parentOf(requested);
    return { path, target: path.startsWith("Projekty/") ? "project" : "folder" };
  }
  // The project lead: the `lead` of the project's signed entry (`Projekty/X`; a folder inside a project is led by the
  // project's lead), only while that entry is verified here. `entry`: the entry to read instead (the one verified before a
  // change). The note's `prowadzacy:` text gives no rights (docs/MCP.md §6): an owner or admin approves it into the entry.
  private leadOf(path: string): string | null {
    const root = path.startsWith("Projekty/") ? path.split("/").slice(0, 2).join("/") : path;
    if (this.protectedChecks.get(root)?.status === "unverified") return null;
    return this.leads.get(root) ?? null;
  }
  private async leadStatus(lead: LeadAppointment, path: string): Promise<"ok" | "lapsed" | "forged"> {
    if (lead?.schema !== LEAD_SCHEMA || lead.vaultId !== this.info.id || lead.path !== path || typeof lead.userId !== "string") return "forged";
    const signer = this.serverMembers.find((m) => m.userId === lead.signerUserId);
    if (!signer?.signingKey) return "lapsed";
    if ((await verifySigned(lead, [{ userId: signer.userId, signingKey: signer.signingKey }])).status !== "ok") return "forged";
    return signer.role === "owner" || signer.role === "admin" ? "ok" : "lapsed";
  }
  // The lead a protect or members change writes: `requested` (undefined keeps the entry's, null clears it). Only an owner
  // or admin changes it, only on a project, and only to a vault member.
  private async leadChange(path: string, entry: ProtectedEntry | undefined, requested: string | null | undefined, target: ProtectionTarget): Promise<LeadAppointment | undefined> {
    const current = entry?.lead;
    if (requested === undefined || (requested ?? undefined) === current?.userId) return current;
    if (this.currentRole !== "owner" && this.currentRole !== "admin") throw new Error(LEAD_TEXT);
    if (target !== "project") throw new Error("Prowadzącego ma tylko projekt.");
    if (requested === null) return undefined;
    if (!this.serverMembers.some((m) => m.userId === requested)) throw new Error("Prowadzący musi być członkiem przestrzeni.");
    const lead: LeadAppointment = { schema: LEAD_SCHEMA, vaultId: this.info.id, path, userId: requested };
    if (!this.signing) throw new Error("Brak klucza podpisu na tym urządzeniu.");
    await signEvent(lead, this.signing);
    return lead;
  }
  private async projectProtection(path: string, target: ProtectionTarget): Promise<ProjectProtection> {
    const entry = this.protectedEntries.get(path);
    const names = new Map((await this.call<OrganizationSnapshot>("organization_snapshot")).members.map((m) => [m.user_id, m.name]));
    return {
      path,
      protected: !!entry,
      member: entry ? this.holds(entry) : true,
      manage: isSharedVaultId(this.info.id) && (await this.canManage(path, target)),
      admin: this.currentRole === "owner" || this.currentRole === "admin",
      self: this.user.id,
      members: entry?.members ?? [],
      editors: entry?.editors ?? [],
      lead: this.leadOf(path),
      target,
      admins: this.adminIds(),
      candidates: this.serverMembers.map((m) => ({ userId: m.userId, name: names.get(m.userId) || m.email || m.userId, ready: !!m.boxKey })),
    };
  }
  // The folder listing: the protected folders this user holds the key of are folders too. A protected folder held by no one
  // here is not listed at all (its members see it as any folder; everyone else does not see it).
  private withLocked(listing: TreeListing): TreeListing {
    const held = [...this.protectedEntries.values()].filter((e) => !e.path.endsWith(".md") && this.holds(e));
    const locked = held.map((e) => ({ path: e.path, check: this.protectedChecks.get(e.path) }));
    // The folders above a held one are listed as bare containers: the rest of them stays hidden from this user.
    const containers = held.flatMap((e) => ancestorsOf(e.path));
    return { ...listing, folders: [...new Set([...listing.folders, ...locked.map((l) => l.path), ...containers])].sort(), locked, rootFree: this.mayCreateTop() };
  }
  // Top-level folders and notes (the root, Projekty/) and new projects are the owners' and admins' to make in a shared vault.
  private mayCreateTop(): boolean {
    return !isSharedVaultId(this.info.id) || this.currentRole === "owner" || this.currentRole === "admin";
  }
  // The path of a note in this vault. A protected note this device cannot open is not held here: its id is listed in its
  // entry, so the path is the entry's (the guards then refuse the write). Empty when neither is known.
  private pathOfNote(id: string): string { return this.notes.get(id)?.path ?? [...this.protectedEntries.values()].find((e) => e.noteIds?.includes(id))?.path ?? ""; }
  // A member who may read a protected path but not write it: an entry names editors, and this user is not one of them.
  // A flagged entry takes no writes from anyone until an owner or admin sets its members again (a new key).
  editRefused(path: string): boolean {
    const e = this.entryAt(path);
    if (e && this.protectedChecks.get(e.path)?.status === "unverified") return true;
    if (this.currentRole === "owner" || this.currentRole === "admin") return false;
    return !!e && this.holds(e) && !!e.editors?.length && !e.editors.includes(this.user.id);
  }
  // Nothing is made in, moved into or out of a protected folder without its key; a moved item is sealed by the folder it
  // lands in on the next save (sealProtected). A protected note is the same for its own path. Writing needs an edit right
  // too (see editRefused), at the source and at the target.
  private async guardProtected(cmd: string, args: unknown): Promise<void> {
    const entries = [...this.protectedEntries.values()];
    if (entries.length === 0) return;
    const a = (args ?? {}) as { path?: string; from?: string; to?: string; id?: string };
    if (cmd === "rename_folder" || cmd === "delete_folder") {
      const touched = cmd === "rename_folder" ? [String(a.from), String(a.to)] : [String(a.path)];
      // The project itself, or a folder above it, is touched: it is renamed, moved or deleted along with its notes.
      const whole = entries.some((e) => touched.some((x) => x === e.path || under(e.path, x)));
      if (cmd === "rename_folder") {
        // A folder moves in, out of or between protected folders and takes the target's protection (the keys of both are
        // checked below). shortcut: an entry's own path (or a folder above one) never moves: its envelope, keys, lead and
        // chat keys are bound to it; moving would need a new entry and a signed mark for the old path.
        if (whole) throw new Error(LOCKED_FOLDER_TEXT);
      } else if (whole && this.currentRole !== "owner" && this.currentRole !== "admin") throw new Error(PROTECTED_DELETE_TEXT);
      if (touched.some((x) => this.lockedAt(x))) throw new Error(LOCKED_TEXT);
      if (touched.some((x) => this.editRefused(x))) throw new Error(EDIT_TEXT);
      return;
    }
    const to = String(a.path ?? "");
    // A note moves in, out of or between protected folders and takes the target's protection; a note protected on its own
    // (older versions) keeps its path, which its entry is bound to.
    const from = cmd === "rename" ? this.pathOfNote(String(a.id)) : "";
    if (from !== to && entries.some((e) => e.path === from)) throw new Error(LOCKED_FOLDER_TEXT);
    // The paths written: where a note is created or renamed to, and where the note named by id is now.
    const written = [to, this.pathOfNote(String(a.id ?? ""))];
    if (written.some((p) => this.lockedAt(p))) throw new Error(LOCKED_TEXT);
    if (written.some((p) => this.editRefused(p))) throw new Error(EDIT_TEXT);
  }
  // A plain copy of a link in a protected place is not taken in (only its payload carries it), nor a plain copy of a link
  // this device holds in a protected place (its id is the server's lock name: a forged copy must not move it out).
  private dropPlainLinks(state: BrowserVaultSnapshot["state"]): void {
    if (!state.github || this.protectedEntries.size === 0) return;
    const sealedIds = new Set(this.githubLinks.filter((l) => this.entryAt(l.projectPath)).map((l) => l.id));
    const kept = (Array.isArray(state.github) ? state.github : []).filter((l) => validLink(l) && !this.entryAt(l.projectPath) && !sealedIds.has(l.id));
    if (kept.length) state.github = kept; else delete state.github;
  }
  // A link writes at its project's path: the guards of a note there (lock, edit right). It stays in its place when that
  // is protected (see dropPlainLinks: a sealed link's id is never taken from a plain copy).
  private guardLink(cmd: string, args: unknown): void {
    const a = (args ?? {}) as { id?: unknown; link?: { id?: unknown; projectPath?: unknown } };
    const id = cmd === "github_save_link" ? a.link?.id : a.id;
    const before = this.githubLinks.find((l) => l.id === id)?.projectPath;
    const after = cmd === "github_save_link" ? a.link?.projectPath : before;
    const paths = [...new Set([before, after])].filter((p): p is string => typeof p === "string");
    if (paths.length === 2 && paths.some((p) => this.entryAt(p))) throw new Error(LINK_MOVE_TEXT);
    if (paths.some((p) => this.lockedAt(p))) throw new Error(LOCKED_TEXT);
    if (paths.some((p) => this.editRefused(p))) throw new Error(EDIT_TEXT);
  }
  // A new general folder, a note in the root or a project: owners and admins only (see mayCreateTop). The folders that
  // exist count as they are; a module's table note (Inwentarze/<name>.md) is the app's own and stays allowed.
  // A file's place in a folder lives in the vault's snapshot, which every member reads: inside a protected project it
  // would show the file's name to members without the project key, so there a file goes into a note instead. Placing
  // follows the same top-level rule as creating a note (guardCreation).
  private guardFolderFile(path: string): void {
    if ([...this.protectedEntries.keys()].some((folder) => inside(path, folder))) throw new Error(PROTECTED_FILE_TEXT);
    this.guardCreation("create_note", { path });
  }
  // A protected note this device cannot read may embed the file: it is then never trashed with its folder entry.
  protected override embedded(fileId: string): boolean {
    const hidden = [...this.withheld.values()].some((p) => p.notes.length > 0 || (p.trash?.length ?? 0) > 0 || p.deleted.length > 0);
    return hidden || [...this.protectedEntries.values()].some((entry) => !this.holds(entry)) || super.embedded(fileId);
  }
  private guardCreation(cmd: string, args: unknown): void {
    if (!CREATES.has(cmd) || this.mayCreateTop()) return;
    const a = (args ?? {}) as { path?: string; to?: string };
    const target = cmd === "rename_folder" ? String(a.to ?? "") : String(a.path ?? "");
    if (cmd === "create_note" && /^Inwentarze\/[^/]+\.md$/.test(target)) return;
    if (!target.includes("/")) throw new Error(TOP_TEXT); // the root itself: no need to list the folders
    const existing = new Set([...this.allFolders(), ...[...this.protectedEntries.keys()].flatMap(ancestorsOf)]);
    if (landsTop(target, existing)) throw new Error(TOP_TEXT);
  }

  // Restoring or purging a trashed note writes its path: the same rules as creating a note there (see guardProtected).
  private async guardTrashed(id: string): Promise<void> {
    const path = (await this.call<TrashEntry[]>("list_trash")).find((t) => t.id === id)?.path ?? this.pathOfNote(id);
    if (!path) return;
    await this.guardProtected("create_note", { path });
    this.guardCreation("create_note", { path });
  }

  // Deleting a folder takes the protected projects inside it along. Each leaves a deleted mark with the ids of its notes:
  // every device drops the entry and forgets those notes (applyMark), and the tombstones of the same snapshot delete them.
  private async deleteFolder(path: string): Promise<void> {
    const gone = await this.projectsIn(path);
    // A protected project held here whose plain notes are not in memory has no plain folder to delete: the mark does it.
    if (this.allFolders().includes(path) || gone.length === 0) await super.call("delete_folder", { path });
    for (const mark of gone) {
      this.dropEntry(mark.path);
      this.protectedMarks.set(mark.path, mark);
      this.forgetFolder(mark.path, mark.noteIds);
    }
    if (gone.length) { this.emit("tree_changed", null); await this.persist(); } else this.schedulePersist();
  }
  // The deleted marks for the protected projects under `path`: their notes' ids, from the entry and the plain notes held here.
  private async projectsIn(path: string): Promise<ProtectedMark[]> {
    const hit = [...this.protectedEntries.values()].filter((e) => inside(e.path, path));
    if (hit.length === 0) return [];
    const marks: ProtectedMark[] = [];
    for (const entry of hit) {
      if (!(await this.projectKeyFor(entry))) throw new Error(NO_PROJECT_KEY);
      // a note moved out since the entry was last sealed is not deleted with it
      const elsewhere = (id: string) => { const n = this.notes.get(id) ?? this.trash.get(id); return !!n && !inside(n.path, entry.path); };
      const noteIds = [...new Set([...(entry.noteIds ?? []).filter((id) => !elsewhere(id)), ...this.plainNoteIds(entry.path)])].sort();
      marks.push(await this.signedMark({ path: entry.path, keyEpoch: entry.keyEpoch, unprotectedAt: Date.now(), deleted: true, noteIds }));
    }
    return marks;
  }

  // The ids of this device's plain notes inside `folder`: live, deleted and kept in the trash (what noteIdsOf reads from an export).
  private plainNoteIds(folder: string): string[] {
    const now = Date.now();
    return [
      ...[...this.notes.values()].filter((n) => inside(n.path, folder)).map((n) => n.id),
      ...[...this.tombstones.values()].filter((t) => inside(t.path, folder)).map((t) => t.id),
      ...[...this.trash.values()].filter((t) => this.keptTrash(t, now) && inside(t.path, folder)).map((t) => t.id),
    ];
  }

  /** The plain state with the protected notes taken out: they go in their entries, sealed (see sealProtected). */
  override exportBrowserSnapshot(ownerUserId: string, vaultId?: string): BrowserVaultSnapshot {
    const snapshot = super.exportBrowserSnapshot(ownerUserId, vaultId);
    const deleted = [...this.protectedMarks.values()].filter((m) => m.deleted);
    if (deleted.length) scrubDeleted(snapshot.state, deleted);
    if (this.protectedEntries.size === 0 && this.protectedMarks.size === 0) return snapshot;
    dropFolders(snapshot.state, [...this.protectedEntries.keys()], this.claimedIds());
    if (this.protectedEntries.size) snapshot.state.protected = [...this.protectedEntries.values()];
    if (this.protectedMarks.size) snapshot.state.unprotected = [...this.protectedMarks.values()];
    return snapshot;
  }

  // The protected projects for the file store: each entry with this user's key (null when not held), and older held epochs.
  private async fileProjects(): Promise<ProjectRef[]> {
    if (!isSharedVaultId(this.info.id)) return [];
    const refs: ProjectRef[] = [];
    for (const entry of [...this.protectedEntries.values()]) {
      refs.push({ path: entry.path, keyEpoch: entry.keyEpoch, current: true, members: entry.members, key: (await this.projectKeyFor(entry))?.key ?? null });
    }
    for (const held of [...this.projectKeys.values()]) {
      if (this.protectedEntries.get(held.path)?.keyEpoch !== held.keyEpoch) refs.push({ path: held.path, keyEpoch: held.keyEpoch, current: false, members: [], key: held.key });
    }
    return refs;
  }
  // After a key change or on load: an editor or better re-seals the file envelopes of older epochs. Errors wait for a later load.
  private async tidyFiles(): Promise<void> {
    if (this.currentRole === "owner" || this.currentRole === "admin" || this.currentRole === "editor") await this.files.rewrapAll().catch(() => undefined);
  }
  // Attachments kept as bytes move to the file store (docs/PLIKI.md §5), by editors and up. A failed run is retried later.
  private async runMigration(): Promise<void> {
    if (this.migrating || this.stopped || !(this.currentRole === "owner" || this.currentRole === "admin" || this.currentRole === "editor")) return;
    const pending = this.pendingAttachments();
    if (pending.length === 0) return;
    this.migrating = true;
    try {
      // Moje notatki keep the personal key's secret after §3.7: a retried move must find the ids it made before.
      const secret = isSharedVaultId(this.info.id) ? this.rawKey! : await keySecret(this.personalKey);
      await migrateAttachments(this.files, secret, pending, (key, bytes, fileId) => {
        const moved = this.attachmentMigrated(key, bytes, fileId);
        if (moved) this.schedulePersist(); // saved as soon as each one is moved: the snapshot then carries the file id
        return moved;
      });
    } catch (error) {
      console.error("Migracja załączników:", error);
      setTimeout(() => void this.runMigration(), 30_000);
    } finally { this.migrating = false; }
  }

  // The server refused a put made under an old epoch: the new key is taken once and the state is sent again.
  // The epoch the last put was made under: a newer key taken meanwhile (catchUp) counts as the refresh.
  private putEpoch = 0;
  private async staleKey(): Promise<void> {
    const message = "Ten sejf ma nowy klucz, a Twojego klucza nie udało się odświeżyć. Odśwież stronę.";
    if (this.staleRetry) { this.setStatus("error"); toast(message, true); return; }
    const refreshed = await this.locked(() => (isSharedVaultId(this.info.id) ? this.rekeyFrom() : this.personalCatchUp(false))).catch(() => false);
    if (!(refreshed || this.epoch > this.putEpoch)) {
      this.setStatus("error"); toast(message, true); return;
    }
    this.staleRetry = true;
    this.serverState = undefined;
    await this.persist(true);
  }
  // The server's state: decrypted, its protected projects opened or dropped, merged in.
  // False when a chat's revision is refused (the append mode, docs/MCP.md §7.1): nothing of it is merged.
  private async takeRemote(envelope: Envelope, author?: RevisionAuthor | null): Promise<boolean> {
    const remote = await this.decryptEnvelope(envelope);
    const canon = syncCanon(remote.state);
    await this.unfold(remote);
    if (author?.agentId && !(await this.takeChatRevision(remote, author.userId, author.agentId))) return false;
    this.serverState = canon;
    this.mergeRemoteSnapshot(remote); this.refreshMembersSoon();
    this.applyMembers();
    return true;
  }
  // A chat's revision, before it merges: every note it changes, moves or deletes keeps a version of its text here first
  // (reason agentVersionReason, for "Cofnij zmiany czatu"); a chat in the append mode may only add. False: refused.
  // shortcut: the revision is compared with this device's state, not with the revision it was based on, so a device that
  // missed earlier revisions counts their changes as the chat's too; exact once the server sends the base revision.
  private async takeChatRevision(remote: BrowserVaultSnapshot, userId: string, agentId: string): Promise<boolean> {
    let mode = await this.chatWriteMode(userId, agentId);
    // after: the note's text once merged (null: deleted), kept beside the version before for "Cofnij zmiany czatu";
    // from/to: its path before and after (from "": a new note)
    const touched: { id: string; text: string; after: string | null; from: string; to: string }[] = [];
    let destructive = false;
    for (const saved of remote.state.notes) {
      const local = this.notes.get(saved.id);
      if (!local) {
        if (this.tombstones.has(saved.id)) continue;
        const made = new Y.Doc();
        Y.applyUpdate(made, base64ToBytes(saved.yjsUpdateBase64));
        touched.push({ id: saved.id, text: "", after: made.getText("content").toString(), from: "", to: saved.path });
        made.destroy();
        continue;
      }
      const before = local.doc.getText("content").toString();
      const merged = new Y.Doc();
      Y.applyUpdate(merged, Y.encodeStateAsUpdate(local.doc));
      Y.applyUpdate(merged, base64ToBytes(saved.yjsUpdateBase64));
      const after = merged.getText("content").toString();
      merged.destroy();
      // the path the merge would take (last writer wins, see mergeBrowserSnapshot)
      const moved = saved.path !== local.path && (Number(saved.pathChangedAt) || 0) >= local.pathChangedAt;
      if (after !== before || moved) touched.push({ id: saved.id, text: before, after, from: local.path, to: moved ? saved.path : local.path });
      if (moved || !after.startsWith(before)) destructive = true;
    }
    for (const t of remote.state.deleted ?? []) {
      const local = this.notes.get(String(t.id));
      const restored = Math.max(Number(t.restoredAt) || 0, this.tombstones.get(String(t.id))?.restoredAt ?? 0);
      if (!local || !(Number(t.deletedAt) > restored)) continue;
      destructive = true;
      const known = touched.find((x) => x.id === local.id);
      if (known) known.after = null;
      else touched.push({ id: local.id, text: local.doc.getText("content").toString(), after: null, from: local.path, to: local.path });
    }
    // In every mode a chat writes notes and task events only: members, groups (they decide access through `grupy:`,
    // docs/MCP.md §6), aliases and fields stay; its signed events are checked like anyone's. Compared through the merge on
    // both sides, so the merge's own normalization is no change.
    let orgChanged = false;
    if (remote.state.organization) {
      const local = super.exportBrowserSnapshot(this.info.ownerUserId, this.info.id).state.organization;
      const org = (o: typeof local): string => canonicalJson({ ...o, events: [] });
      orgChanged = org(mergeOrganizationSnapshots(local, remote.state.organization)) !== org(mergeOrganizationSnapshots(local, local));
    }
    if (orgChanged) return false;
    // none and proposals: the chat writes nothing at all (the server refuses its put; this device too)
    const refused = (m: WriteMode): boolean => (m === "none" || m === "proposals" ? destructive || touched.length > 0 : m !== "direct" && destructive);
    // a refusal takes the change back for everyone: decided on the newest certs and policy, not a list loaded earlier
    if (refused(mode)) mode = await this.chatWriteMode(userId, agentId, true);
    if (refused(mode)) return false;
    if (touched.length) {
      const time_ms = Date.now();
      const reason = agentVersionReason(agentId), afterReason = agentAfterReason(agentId);
      // ids above every one used here and there: a version is found by its id alone (version_text, restore_version)
      let next = Math.max(Number(remote.state.nextVersion) || 1, (this as unknown as { nextVersion: number }).nextVersion);
      for (const { id, text, after, from, to } of touched) {
        const kept: { id: number; time_ms: number; reason: string; text: string; path?: string }[] = [{ id: next++, time_ms, reason, text, ...(from ? { path: from } : {}) }];
        if (after !== null) kept.push({ id: next++, time_ms, reason: afterReason, text: after, path: to });
        remote.state.versions.push([id, kept]);
      }
      remote.state.nextVersion = next;
    }
    return true;
  }
  // The write mode of a chat in this vault, from its cert checked under its person's key. A chat this device cannot
  // check is held to the append mode (it may add, never change).
  private agentPolicy: AgentPolicy | undefined;
  private async chatWriteMode(userId: string, agentId: string, fresh = false): Promise<WriteMode> {
    const shared = isSharedVaultId(this.info.id);
    if (shared && !this.agentPolicy && !fresh) await this.refreshMembers().catch(() => undefined);
    const find = () => (shared ? this.serverMembers.find((m) => m.userId === userId)?.agents : this.ownAgents)?.find((a) => a.agentId === agentId);
    if (fresh || !find()) await (shared ? this.refreshMembers() : this.loadOwnAgents()).catch(() => undefined);
    const agent = find();
    const key = shared ? this.serverMembers.find((m) => m.userId === userId)?.signingKey : userId === this.user.id ? this.signing?.publicJwk : null;
    const cert = agent && { ...agent.cert, signature: agent.cert?.signature ?? agent.signature };
    if (!cert || !key || cert.agentId !== agentId || cert.userId !== userId || !(await verifyCert(cert, key))) return "append";
    const fromCert = cert.vaults.find((v) => v.vaultId === this.info.id)?.writeMode ?? "append";
    // the organization's limit cuts it here too, as on the server (docs/MCP.md §16)
    const cap = shared ? (this.agentPolicy ?? ORG_AGENT_POLICY).maxWriteMode : "direct";
    return MODE_ORDER.indexOf(fromCert) <= MODE_ORDER.indexOf(cap) ? fromCert : cap;
  }
  // A refused chat revision: shown once, the sync marked as failed. When this device merged everything up to the
  // revision the chat wrote on, its own state is put on top of it, which takes the chat's change back for everyone;
  // otherwise the next revision (another member's) is awaited. A refused revision that comes again is not shown again.
  private refusedRevision?: number;
  private async refuseRevision(revision: number | undefined): Promise<void> {
    if (this.refusedRevision !== revision) toast(APPEND_REFUSED_TEXT, true);
    this.refusedRevision = revision;
    this.setStatus("error");
    if (revision !== undefined && this.revision === revision - 1) {
      this.revision = revision;
      this.serverState = undefined;
      await this.persist(true);
    }
  }
  // Set once the server's state is merged here (or the server had none): only then may the vault be sent again under a
  // new key of Moje notatki (resendWhenSeen: a key that came before that).
  private remoteSeen = false;
  private resendWhenSeen = false;
  private async resendUnderNewKey(): Promise<void> {
    this.resendWhenSeen = false;
    this.serverState = undefined;
    await this.persist(true);
    void this.tidyFiles();
  }
  private async remoteMerged(): Promise<void> {
    this.remoteSeen = true;
    if (this.resendWhenSeen) await this.resendUnderNewKey();
    // Moje notatki still under the personal key, now proven: the move to a key of their own runs once more
    if (!isSharedVaultId(this.info.id) && this.epoch === 1 && this.personalProven && !this.migrationTried) {
      this.migrationTried = true;
      this.catchUpSoon();
    }
  }
  private async handleMessage(message: ServerMessage): Promise<void> {
    if (message.type === "snapshot") {
      this.reconnects = 0;
      // The server still holds the revision this reconnect named (resumable): nothing to merge, only what was written
      // while the socket was down goes up.
      if (message.unchanged) {
        // never expected (the server compares revision and nonce): reconnect without resuming, for the whole vault
        if (message.revision !== this.revision) { this.heldNonce = undefined; this.dropSocket(); return; }
        await this.remoteMerged();
        this.current = true;
        this.setStatus("synced");
        if (this.dirty) await this.persist(true);
        return;
      }
      // the dropped socket's puts get no answer: this snapshot holds them, or the merge below sends them again
      this.inflight.splice(0, this.inflightAtOpen); this.inflightAtOpen = 0;
      this.heldNonce = message.envelope?.nonce;
      const putsBefore = this.putsSent;
      // The revision is taken only with its state: a snapshot that cannot be read yet must not make a later put of this
      // device's state pass as based on it.
      if (message.envelope) {
        const hadLocal = !!(await readStored(this.db, this.user.id, this.info.id));
        if (!(await this.takeRemote(message.envelope, message.author))) { await this.refuseRevision(message.revision); return; }
        this.revision = message.revision ?? 0;
        await this.persist(hadLocal);
      } else { this.revision = message.revision ?? 0; this.personalProven = true; await this.persist(true); } // the server has no vault yet (nothing to protect): the local one goes up, and Moje notatki may get a key of their own
      // nothing had to go up again: the server holds this device's state, so a persistNow waiting on a lost put is done
      // (and none went on this socket before the snapshot came: that one may still meet a conflict)
      if (this.putsSent === putsBefore && putsBefore === this.putsAtOpen) this.ackedPut = this.putsSent;
      await this.remoteMerged();
      this.current = true;
      this.setStatus("synced");
    } else if (message.type === "ack" || message.type === "accepted") {
      this.revision = message.revision ?? this.revision; this.setStatus("synced"); this.staleRetry = false; this.ackedPut = this.putsSent;
      this.heldNonce = this.inflight.shift(); // the server answers puts in order: this ack is the oldest one waiting
      const current = await readStored(this.db, this.user.id, this.info.id);
      if (this.dirty && current && this.lastCanon !== undefined) { if (this.lastCanon !== this.serverState) this.sendPut(current.envelope, this.lastCanon); }
      else if (current) await writeStored(this.db, { ...current, revision: this.revision });
    } else if (message.type === "update" || message.type === "conflict") {
      if (message.type === "conflict") this.inflight.shift();
      if (!message.envelope) { this.revision = message.revision ?? this.revision; this.heldNonce = undefined; if (message.type === "conflict") await this.persist(true); return; }
      if (!(await this.takeRemote(message.envelope, message.author))) { this.heldNonce = undefined; await this.refuseRevision(message.revision); return; }
      this.revision = message.revision ?? this.revision;
      this.heldNonce = message.envelope.nonce;
      await this.remoteMerged();
      // A conflict means our base revision is stale: the merged state is put again on the new revision, if it differs.
      // Another member's update while we type does not hurry our put: the live deltas already carry our keystrokes.
      if (message.type === "conflict") await this.persist(true);
      else if (this.dirty) this.schedulePersist("slow");
      else await this.persist(false);
    } else if (message.type === "access") {
      if (message.role === null || message.role === undefined) this.revoked();
      else { this.setRole(message.role); this.catchUpSoon(); }
    } else if (message.type === "relay") {
      if (message.envelope) await this.takeRelay(message.envelope);
    } else if (message.type === "rekey") {
      this.catchUpSoon();
    } else if (message.type === "error") {
      // answers to a put; read-only can also answer a delta, but then every put is refused too, so nothing is lost
      if (message.code === "read-only" || message.code === "stale-key" || message.code === "slow-down") this.inflight.shift();
      // personal-off: the server admin has not allowed (or withdrew) Moje notatki; the socket closes after this frame
      if (message.code === "forbidden" || message.code === "personal-off") this.revoked();
      else if (message.code === "read-only") { this.setRole("viewer"); toast(READ_ONLY_TEXT, true); }
      else if (message.code === "stale-key") await this.staleKey();
      // the server's flood guard: a dropped delta or put comes again with the next snapshot, so nothing is lost
      // a refused put is not on the server: forgetting what it was makes the next persist send it again
      else if (message.code === "slow-down" || message.code === "too-large") { if (message.code === "slow-down") this.serverState = undefined; this.schedulePersist("slow"); }
      else throw new Error(message.message ?? "Błąd synchronizacji.");
    }
  }
  // Key events arrive on the socket; the check runs in the background and a failure is only logged (the next open retries).
  private catchUpSoon(): void { this.catchUp().catch((e: unknown) => console.error("Klucz sejfu:", e)); }
  private setRole(role: Role): void {
    if (role === this.currentRole) return;
    this.currentRole = role;
    this.syncAssignTimer();
    this.syncGithubSchedule();
    this.emitAccess({ role });
  }
  // The member was removed (or the vault is gone for them): no more traffic, no reconnect.
  private revoked(): void {
    if (this.currentRole === null) return;
    this.currentRole = null;
    this.stopped = true;
    this.syncGithubSchedule();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    // Moje notatki cut off (personal-off, or access role:null after the admin's "off"): the page falls back to an
    // organization or the empty state (homeVaultId), and the next load reads /me again
    const personal = !isSharedVaultId(this.info.id);
    if (personal) this.user.personal = "off";
    this.emitAccess({ role: null, voluntary: this.leaving, ...(personal ? { personal } : {}) });
  }
  private emitAccess(payload: { role: Role | null; voluntary?: boolean; personal?: boolean }): void { this.accessListeners.forEach((cb) => cb(payload)); }
  // ---- live deltas ----------------------------------------------------------------------------------------------------
  // A text edit is sent to the others right away as its Yjs update, encrypted with the vault key and never stored. The
  // snapshot stays the record: a delta that is lost (offline, a new note the other side doesn't have yet) arrives
  // with the next put. Notes of a protected project are left out: the vault key would show them to every member.
  private relayQueue = new Map<string, Uint8Array[]>();
  private relayScheduled = false;
  private relaySent: Promise<void> = Promise.resolve(); // the last send: frames leave in the order they were queued
  private queueRelay(id: string, update: Uint8Array): void {
    if (!this.connected || this.currentRole === "viewer" || this.currentRole === null) return;
    const path = this.notes.get(id)?.path;
    if (!path || [...this.protectedEntries.keys()].some((folder) => inside(path, folder))) return;
    this.relayQueue.set(id, [...(this.relayQueue.get(id) ?? []), update]);
    // a microtask, not a timer: the edits of one synchronous dispatch (a paste, an IME burst) still share one delta
    if (!this.relayScheduled) { this.relayScheduled = true; queueMicrotask(() => { this.relayScheduled = false; void this.flushRelay().catch((e) => console.warn("live edit not sent", e)); }); }
  }
  private async flushRelay(): Promise<void> {
    const notes = [...this.relayQueue].map(([id, updates]) => ({ id, update: bytesToBase64(Y.mergeUpdates(updates)) }));
    this.relayQueue.clear();
    if (!notes.length || this.socket?.readyState !== WebSocket.OPEN) return this.relaySent;
    // seals run side by side, sends one after another: a later frame never overtakes an earlier one
    const sealed = sealRelay({ schema: RELAY_SCHEMA, notes }, this.info, this.key, this.wireEpoch());
    this.relaySent = Promise.all([this.relaySent.catch(() => undefined), sealed]).then(([, envelope]) => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "relay", envelope }));
    });
    return this.relaySent;
  }
  private async takeRelay(envelope: Envelope): Promise<void> {
    let payload: RelayPayload;
    try { payload = await openRelay(envelope, this.info, this.keyFor(envelope.keyEpoch)); }
    catch { return; } // an old key or a damaged delta: the next snapshot brings the same text
    for (const { id, update } of payload.notes) {
      const note = this.notes.get(id);
      if (!note) continue; // a note this device doesn't have yet comes with the snapshot
      const bytes = base64ToBytes(update);
      Y.applyUpdate(note.doc, bytes);
      this.emit("note_update", { id, update: bytes });
    }
  }

  private sendPut(envelope: Envelope, canon: string): void {
    // A viewer has no write right: the local copy stays on this device and is never sent.
    if (this.currentRole === "viewer" || this.currentRole === null) return;
    if (this.socket?.readyState === WebSocket.OPEN) { this.serverState = canon; this.putEpoch = this.epoch; this.setStatus("syncing"); this.putsSent++; this.inflight.push(envelope.nonce); this.socket.send(JSON.stringify({ type: "put", baseRevision: this.revision, envelope })); }
  }
  // ---- GitHub (docs/GITHUB.md) ---------------------------------------------------------------------------------------
  // Every vault has the service of its links, Moje notatki too (their owner holds the leases). Editors and up run the
  // schedule; a viewer reads.
  private github?: BrowserGithubService;
  private current = false; // the server's snapshot was taken on this connection; live updates keep it current
  private handling = 0; // server frames still being merged
  private putsSent = 0;
  private ackedPut = 0; // an ack answers the newest put sent so far (a conflict's merged put supersedes the refused one)
  // Moje notatki have no raw vault key: their archive ids use a secret derived from the personal key instead.
  private githubSecret: Uint8Array | null = null;
  private startGithub(): void {
    setGithubGuard((id) => linkOfNote(this.githubLinks, id)?.file.guarded ?? null);
    const shared = isSharedVaultId(this.info.id);
    if (!shared) void personalArchiveSecret(this.personalKey).then((s) => { this.githubSecret = s; }, () => undefined);
    this.github = createGithubService({
      call: (cmd, args) => this.call(cmd, args),
      vaultId: this.info.id,
      userId: this.user.id,
      role: () => this.currentRole,
      files: this.files,
      archiveSecret: () => (shared ? this.rawKey : this.githubSecret),
      catchUp: () => this.syncNow(),
      persistNow: () => this.persistNow(),
      tokenReady: () => preferencesLoaded,
      token: githubToken,
      setToken: setGithubToken,
    });
    setGithubService(this.github);
    this.syncGithubSchedule();
  }
  private syncGithubSchedule(): void {
    const wanted = !this.stopped && (this.currentRole === "owner" || this.currentRole === "admin" || this.currentRole === "editor");
    if (wanted) this.github?.startSchedule(); else this.github?.stopSchedule();
  }
  // Waits (up to 20 s) for a state of the bridge: connected and settled. Throws when the vault closed or the wait ran out.
  private async until(ready: () => boolean): Promise<void> {
    for (let waited = 0; !ready(); waited += 200) {
      if (this.stopped || waited >= 20_000) throw new Error("Brak połączenia z serwerem.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  /** Resolves once this device holds the server's newest state: the snapshot of this connection taken, no frame pending. */
  syncNow(): Promise<void> { return this.until(() => this.connected && this.current && this.handling === 0); }
  // One save that the server took (its ack), so another device that takes the lease next finds this state.
  private async persistNow(): Promise<void> {
    await this.persist();
    const needed = this.putsSent;
    await this.until(() => this.ackedPut >= needed && this.handling === 0);
  }
  /** The GitHub service of this vault, or undefined for Moje notatki. */
  get githubService(): BrowserGithubService | undefined { return this.github; }
  close(): void {
    this.stopped = true; this.syncGithubSchedule(); setGithubService(null); clearInterval(this.assignTimer); clearInterval(this.pingTimer);
    if (this.wake) { window.removeEventListener("online", this.wake); document.removeEventListener("visibilitychange", this.wake); }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.socket?.close(); this.db.close();
  }
}

// The vault to open: an invite in the address first (joined, or declined for the personal vault), then ?vault=, then the
// vault opened last on this device. A shared vault that cannot be opened falls back to the personal one. Without Moje
// notatki (personalAllowed) only organizations open: the asked one when listed, else the first; with none, an empty state.
async function openBrowserVault(user: BrowserUser, personal: CryptoKey): Promise<BrowserBridge> {
  let vaultId: string | null = new URLSearchParams(location.search).get("vault") ?? rememberedVault(user.id);
  // the unlock screen is done; the join question must not sit on top of it
  if (hasInviteParam(location.href)) { document.getElementById("app")?.replaceChildren(); vaultId = await runInvite(parseInviteHref(location.href), personal); }
  const own = personalAllowed(user);
  let shared: string[] = [];
  if (!own) {
    shared = (await listSharedVaults()).map((v) => v.id);
    if (!vaultId || !shared.includes(vaultId)) vaultId = shared[0] ?? null;
    if (!vaultId) return noAccessScreen(document.getElementById("app")!, user);
  }
  // The signing key is needed by every vault (the personal one too). Without it, events are kept unsigned and shown so.
  const signing = await loadSigningIdentity(user.id, personal).catch((e: unknown) => { toast(`Podpisy zdarzeń są wyłączone: ${errorText(e)}`, true); return undefined; });
  // The box key opens sealed vault keys for this user (invites and rotations); without it a member cannot take a new key.
  const box = await loadBoxIdentity(user.id, personal).catch((e: unknown) => { toast(`Klucz szyfrowania sejfów jest niedostępny: ${errorText(e)}`, true); return undefined; });
  try {
    const access = await openAccess(vaultId, user.id, personal, box);
    rememberVault(user.id, access.vault.id);
    return await BrowserBridge.open(user, personal, access, signing, box);
  } catch (error) {
    if (!vaultId || vaultId === personalVaultId(user.id)) throw error;
    history.replaceState(null, "", location.pathname);
    if (!own) {
      // shortcut: only the next organization is tried, not every one; a reload tries again
      const next = shared.find((id) => id !== vaultId);
      if (!next) throw error;
      toast(`Nie udało się otworzyć tej organizacji: ${errorText(error)} Otwarto inną.`, true);
      rememberVault(user.id, next);
      return BrowserBridge.open(user, personal, await openAccess(next, user.id, personal, box), signing, box);
    }
    toast(`Nie udało się otworzyć tej organizacji: ${errorText(error)} Otwarto Twoje notatki.`, true);
    rememberVault(user.id, personalVaultId(user.id));
    return BrowserBridge.open(user, personal, personalAccess(user.id), signing, box);
  }
}

export const NO_ACCESS_TEXT = "Nie masz jeszcze dostępu do żadnej organizacji ani własnych notatek.";
// No organization and no Moje notatki: nothing opens. The page stays here until a reload (after an invite or the consent).
export function noAccessScreen(root: HTMLElement, user: BrowserUser): Promise<never> {
  root.innerHTML = `<main class="web-auth"><section class="web-auth-card"><p class="web-auth-eyebrow">NOTES · WERSJA PRZEGLĄDARKOWA</p><h1>Brak dostępu</h1><p class="web-auth-lead">${NO_ACCESS_TEXT}</p><p class="web-auth-footnote">Poproś kogoś z organizacji o link zaproszenia albo poproś administratora serwera o własne notatki.</p><div class="web-auth-actions" id="no-access-actions"></div><button id="no-access-reload" class="web-auth-switch" type="button">Odśwież</button><button id="auth-logout" class="web-auth-switch" type="button" title="Wyloguj" aria-label="Wyloguj">Wyloguj</button></section></main>`;
  const control = personalNotesControl(user.personal ?? "off", (state) => { user.personal = state; });
  if (control) root.querySelector("#no-access-actions")!.append(control);
  root.querySelector<HTMLButtonElement>("#no-access-reload")!.onclick = () => location.reload();
  root.querySelector<HTMLButtonElement>("#auth-logout")!.onclick = () => chooseLogout(user.id);
  return new Promise<never>(() => undefined);
}

// The server's rules for the display name and the last name: 1 to 64 characters of letters, digits, space, - ' ’ . _.
const PERSON_NAME = /^[\p{L}\p{M}\p{N} '’._-]+$/u;
export function personNameError(value: string, label: string): string | null {
  const length = [...value].length;
  if (length === 0) return `${label}: wpisz co najmniej jeden znak.`;
  if (length > 64 || !PERSON_NAME.test(value)) return `${label}: do 64 znaków, tylko litery, cyfry, spacja, myślnik, apostrof, kropka lub podkreślenie.`;
  return null;
}
export const LASTNAME_VISIBILITY = "Nazwisko jest szyfrowane w przeglądarce — widzą je tylko członkowie organizacji, do których należysz; serwer go nie zna. Możesz je pominąć i dodać później.";

function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]!); }
// needCode: sign-ups need a registration code here (no invite link in the address); closed: nobody can sign up.
function authScreen(root: HTMLElement, needCode: boolean, closed: boolean, invited: boolean): void {
  root.innerHTML = `<main class="web-auth" aria-labelledby="auth-title"><section class="web-auth-card"><div class="web-auth-mark" aria-hidden="true">N</div><p class="web-auth-eyebrow">NOTES · WERSJA PRZEGLĄDARKOWA</p><h1 id="auth-title">Twoja przestrzeń wiedzy</h1><p class="web-auth-lead">Zaloguj się, aby otworzyć swoje zaszyfrowane notatki.</p><form id="auth-form" class="web-auth-form">${invited ? `<p id="auth-invite-note" class="web-auth-note" hidden>Zakładasz konto z zaproszenia do organizacji.</p>` : ""}${needCode ? `<div id="auth-code-row" class="web-auth-code" hidden><label>Kod od administratora<input name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" placeholder="ABCD-EFGH-JKLM" aria-describedby="auth-code-help"></label><p id="auth-code-help" class="web-auth-footnote">Na tym serwerze konto zakłada się z kodem od administratora albo z linku zaproszenia do organizacji. Masz link? Otwórz go, a kod nie będzie potrzebny.</p></div>` : ""}<label id="auth-name-row" hidden>Imię lub nazwa wyświetlana<input name="name" type="text" autocomplete="nickname" maxlength="64" placeholder="np. Ola"></label><label id="auth-lastname-row" hidden>Nazwisko — opcjonalne<input name="lastName" type="text" autocomplete="family-name" maxlength="64"></label><p id="auth-lastname-help" class="web-auth-footnote" hidden>${LASTNAME_VISIBILITY}</p><label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>Hasło<span class="web-auth-pw"><input name="password" type="password" autocomplete="current-password" required minlength="8" aria-describedby="auth-password-help"><span id="auth-password-dot" class="web-auth-dot" aria-hidden="true" hidden></span></span></label><p id="auth-password-help" class="web-auth-footnote" hidden>Co najmniej 8 znaków, jedna wielka litera i jedna cyfra.<span id="auth-password-state"></span></p><label id="auth-password2-row" hidden>Powtórz hasło<span class="web-auth-pw"><input name="password2" type="password" autocomplete="new-password"><span id="auth-password2-dot" class="web-auth-dot" aria-hidden="true" hidden></span></span></label><p id="auth-password2-error" class="web-auth-footnote web-auth-mismatch" hidden>Hasła różnią się.</p><label id="auth-terms-row" class="web-auth-check" hidden><input name="terms" type="checkbox"><span>Akceptuję <a href="/regulamin" target="_blank">regulamin</a> i mam ukończone 16 lat. Informacje o przetwarzaniu danych: <a href="/prywatnosc" target="_blank">polityka prywatności</a>.</span></label><div class="web-auth-actions"><button class="web-auth-submit" type="submit">Zaloguj się</button><button class="web-auth-switch" type="button"${closed ? " hidden" : ""}>Utwórz konto</button></div><p class="web-auth-error" role="alert" hidden></p></form>${closed ? `<p class="web-auth-footnote">Zakładanie nowych kont jest na tym serwerze wyłączone.</p>` : ""}<p class="web-auth-footnote">Hasło służy wyłącznie do logowania. Klucz szyfrujący jest losowy i ma osobny kod odzyskiwania. <a href="/pomoc">Pomoc</a> · <a href="/regulamin">Regulamin</a> · <a href="/prywatnosc">Polityka prywatności</a></p></section></main>`;
}
export interface RecoveryCheck { verify: (code: string) => Promise<boolean>; allowNew?: boolean }
// Resolves with the code: a fresh one to acknowledge, or the entered one once it opens the vault. With allowNew the
// user may resolve null instead, to start a new key (only offered when there is no vault to open).
export function recoveryGate(root: HTMLElement, user: BrowserUser, code: string | null, check?: RecoveryCheck): Promise<string | null> {
  return new Promise((resolve) => {
    const fresh = !!code;
    root.innerHTML = `<main class="web-auth"><section class="web-auth-card"><p class="web-auth-eyebrow">SZYFROWANIE END-TO-END</p><h1>${fresh ? "Twój kod bezpieczeństwa i odzyskiwania" : "Odblokuj swoje notatki"}</h1><p class="web-auth-lead">${fresh ? "Kod jest widoczny poniżej. To jedyna kopia klucza poza tą przeglądarką — zapisz go przed przejściem dalej." : `Zalogowano jako ${escapeHtml(user.email)}. Wprowadź kod odzyskiwania, aby odblokować vault na tym urządzeniu.`}</p>${fresh ? `<div class="web-recovery-code" role="status" aria-label="Kod bezpieczeństwa i odzyskiwania">${code}</div><button id="recovery-copy" class="web-auth-switch" type="button">Kopiuj kod</button><label style="display:flex;gap:10px;margin:18px 0"><input id="recovery-ack" type="checkbox">Zapisałem kod w bezpiecznym miejscu</label>` : `<label>Kod odzyskiwania<input id="recovery-input" autocomplete="off" spellcheck="false" maxlength="64"></label>`}<p class="web-auth-error" role="alert" hidden></p><button id="recovery-continue" class="web-auth-submit" type="button">${fresh ? "Potwierdź i otwórz" : "Odblokuj"}</button>${!fresh && check?.allowNew ? `<button id="recovery-new" class="web-auth-switch" type="button">Utwórz nowy klucz</button>` : ""}<button id="auth-logout" class="web-auth-switch" type="button" title="Wyloguj" aria-label="Wyloguj">Wyloguj</button></section></main>`;
    const button = root.querySelector<HTMLButtonElement>("#recovery-continue")!; const err = root.querySelector<HTMLElement>(".web-auth-error")!;
    const fail = (e: unknown) => { err.textContent = e instanceof Error ? e.message : "Nieprawidłowy kod."; err.hidden = false; };
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (fresh && !root.querySelector<HTMLInputElement>("#recovery-ack")!.checked) throw new Error("Potwierdź zapisanie kodu odzyskiwania.");
        const value = fresh ? code! : root.querySelector<HTMLInputElement>("#recovery-input")!.value.trim();
        hexBytes(value);
        // Nothing is stored before the code is known to open the vault: a wrong code is rejected here, and the user retries.
        if (check && !(await check.verify(value))) throw new Error("Ten kod nie odszyfrowuje Twoich danych.");
        resolve(value);
      } catch (e) { fail(e); button.disabled = false; }
    };
    root.querySelector<HTMLButtonElement>("#recovery-new")?.addEventListener("click", () => resolve(null));
    root.querySelector<HTMLButtonElement>("#recovery-copy")?.addEventListener("click", async (event) => {
      const copy = event.currentTarget as HTMLButtonElement;
      try { await navigator.clipboard.writeText(code!); copy.textContent = "Skopiowano"; }
      catch { fail(new Error("Nie udało się skopiować kodu. Zaznacz go i skopiuj ręcznie.")); }
    });
    root.querySelector<HTMLButtonElement>("#auth-logout")!.onclick = () => chooseLogout(user.id);
  });
}
// Register-form password rule, the same as the input's pattern attribute.
const PASSWORD_PATTERN = "(?=.*[A-ZĄĆĘŁŃÓŚŹŻ])(?=.*[0-9]).{8,}";
const PASSWORD_RULE = new RegExp(`^(?:${PASSWORD_PATTERN})$`);
/** Wires the status dots and the mismatch line of the register form; returns the repaint function for mode switches. */
function wirePasswordChecks(form: HTMLFormElement, registering: () => boolean): () => void {
  const first = form.elements.namedItem("password") as HTMLInputElement;
  const second = form.elements.namedItem("password2") as HTMLInputElement;
  const dots: [HTMLInputElement, HTMLElement][] = [[first, form.querySelector<HTMLElement>("#auth-password-dot")!], [second, form.querySelector<HTMLElement>("#auth-password2-dot")!]];
  const state = form.querySelector<HTMLElement>("#auth-password-state")!;
  const mismatch = form.querySelector<HTMLElement>("#auth-password2-error")!;
  let typing: HTMLInputElement | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => {
    const on = registering(); const firstOk = PASSWORD_RULE.test(first.value); const same = second.value === first.value;
    const stateOf = (input: HTMLInputElement): string => {
      if (!on || !input.value) return "";
      if (input === typing) return "typing";
      return input === first ? (firstOk ? "ok" : "bad") : (firstOk && same ? "ok" : "bad");
    };
    for (const [input, dot] of dots) { dot.hidden = !on; dot.dataset.state = stateOf(input); }
    state.textContent = on && first.value ? (firstOk ? " Hasło spełnia wymagania." : " Hasło nie spełnia wymagań.") : "";
    mismatch.hidden = !on || same || !second.value;
  };
  form.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input !== first && input !== second) return;
    typing = input; clearTimeout(timer);
    timer = setTimeout(() => { typing = null; paint(); }, 600);
    paint();
  });
  return paint;
}
export async function authenticateBrowser(root: HTMLElement): Promise<BrowserBridge> {
  let me: AuthMe = { authenticated: false }; let connectionError = "";
  try { me = await api<AuthMe>("/api/auth/me"); } catch { connectionError = "Nie można połączyć się z usługą kont. Uruchom serwer i spróbuj ponownie."; }
  let user = me.authenticated ? me.user : undefined; let created = false; let typedLastName = "";
  if (!user) {
    // an older server says nothing: the form offers sign-up and the server decides
    const invited = hasInviteParam(location.href); const registration = me.registration ?? "open";
    const needCode = registration === "invite" && !invited;
    authScreen(root, needCode, registration === "closed", invited); const form = root.querySelector<HTMLFormElement>("#auth-form")!; const submit = root.querySelector<HTMLButtonElement>(".web-auth-submit")!; const switchButton = root.querySelector<HTMLButtonElement>(".web-auth-switch")!; const error = root.querySelector<HTMLElement>(".web-auth-error")!;
    if (connectionError) { error.textContent = connectionError; error.hidden = false; }
    let mode: "login" | "register" = "login";
    const paintPasswords = wirePasswordChecks(form, () => mode === "register");
    switchButton.onclick = () => { mode = mode === "login" ? "register" : "login"; const confirm = form.elements.namedItem("password2") as HTMLInputElement; confirm.required = mode === "register"; root.querySelector<HTMLElement>("#auth-password2-row")!.hidden = mode === "login"; paintPasswords();submit.textContent = mode === "login" ? "Zaloguj się" : "Utwórz konto"; switchButton.textContent = mode === "login" ? "Utwórz konto" : "Mam już konto"; const nameRow = root.querySelector<HTMLElement>("#auth-name-row")!; const name = form.elements.namedItem("name") as HTMLInputElement; const help = root.querySelector<HTMLElement>("#auth-password-help")!; nameRow.hidden = mode === "login"; help.hidden = mode === "login"; root.querySelector<HTMLElement>("#auth-lastname-row")!.hidden = mode === "login"; root.querySelector<HTMLElement>("#auth-lastname-help")!.hidden = mode === "login"; root.querySelector<HTMLElement>("#auth-terms-row")!.hidden = mode === "login"; const codeRow = root.querySelector<HTMLElement>("#auth-code-row"); if (codeRow) { codeRow.hidden = mode === "login"; (form.elements.namedItem("code") as HTMLInputElement).required = mode === "register"; } const inviteNote = root.querySelector<HTMLElement>("#auth-invite-note"); if (inviteNote) inviteNote.hidden = mode === "login"; (form.elements.namedItem("terms") as HTMLInputElement).required = mode === "register"; name.required = mode === "register"; const password = form.elements.namedItem("password") as HTMLInputElement; password.setAttribute("autocomplete",mode === "login" ? "current-password" : "new-password"); password.pattern = mode === "register" ? PASSWORD_PATTERN : ""; password.title = mode === "register" ? "Co najmniej 8 znaków, jedna wielka litera i jedna cyfra." : ""; if (mode === "register") (codeRow ? form.elements.namedItem("code") as HTMLInputElement : name).focus(); };
    const result = await new Promise<{ user: BrowserUser; created: boolean; lastName: string }>((resolve) => { form.onsubmit = async (event) => {
        event.preventDefault(); error.hidden = true;
        const values = new FormData(form);
        const displayName = String(values.get("name") ?? "").trim();
        const lastName = String(values.get("lastName") ?? "").trim();
        // The last name is sent only when given; the server rules are mirrored here so the user sees the problem before sending.
        if (mode === "register") {
          const problem = personNameError(displayName, "Imię lub nazwa wyświetlana") ?? (lastName ? personNameError(lastName, "Nazwisko") : null);
          if (problem) { error.textContent = problem; error.hidden = false; return; }
          if (values.get("password") !== values.get("password2")) { error.textContent = "Hasła nie są takie same."; error.hidden = false; return; }
        }
        submit.disabled = switchButton.disabled = true;
        try {
          // The last name is not sent: it is kept on the account encrypted, once the personal key exists (keepLastName).
          const r = await api<{ user: BrowserUser }>(`/api/auth/${mode}`,"POST",{ name:displayName, email:String(values.get("email") ?? "").trim(), password:String(values.get("password") ?? ""), ...(mode === "register" && invited ? { invite: parseInviteHref(location.href)?.token } : {}), ...(mode === "register" && needCode ? { code: String(values.get("code") ?? "").trim() } : {}) });
          resolve({ user:r.user, created:mode === "register", lastName: mode === "register" ? lastName : "" });
        } catch (e) { error.textContent = e instanceof Error ? e.message : "Logowanie nie powiodło się."; error.hidden = false; }
        finally { submit.disabled = switchButton.disabled = false; }
      }; }); user = result.user; created = result.created; typedLastName = result.lastName;
  }
  const db = await openDb();
  try {
    const keyRecord = await readKeyRecord(db,user.id);
    let key = keyRecord?.key;
    const priorWorkspace = await readStored(db,user.id,personalVaultId(user.id));
    const hasLegacyLocalSnapshot = !!(priorWorkspace as unknown as { snapshot?: BrowserVaultSnapshot } | undefined)?.snapshot;
    if (keyRecord?.pendingRecoveryCode) {
      // A fresh key whose code was not acknowledged yet (a refresh or a failed step): show the code again.
      const pendingKey = keyRecord.key;
      await recoveryGate(root,user,keyRecord.pendingRecoveryCode);
      await retry(() => clearPendingRecoveryCode(db,user.id,pendingKey));
      key = pendingKey;
    } else if (!key) {
      if (created || hasLegacyLocalSnapshot) key = await freshKey(root,db,user);
      else {
        const verifier = personalAllowed(user) ? await findVerifier(db,user.id) : await findAccountVerifier(user.id);
        const entered = await recoveryGate(root,user,null,{ verify: (code) => codeOpens(code,verifier,user.id), allowNew: verifier.checked && !verifier.envelope && !verifier.wrappedKey && !verifier.boxKey });
        if (entered === null) key = await freshKey(root,db,user);
        else {
          const enteredKey = await keyFromRecovery(entered);
          await retry(() => writeKey(db,user.id,enteredKey));
          key = enteredKey;
        }
      }
    }
    if (!key) throw new Error("Nie udało się odblokować klucza szyfrującego.");
    await keepLastName(user, key, typedLastName);
    return await openBrowserVault(user,key);
  } finally { db.close(); }
}

// A new key: its code is stored with the key (so a refresh resumes the acknowledgement), shown, then the pending mark is cleared.
async function freshKey(root: HTMLElement, db: IDBDatabase, user: BrowserUser): Promise<CryptoKey> {
  const fresh = await newRecoveryKey();
  await retry(() => writeKey(db,user.id,fresh.key,fresh.code));
  await recoveryGate(root,user,fresh.code);
  await retry(() => clearPendingRecoveryCode(db,user.id,fresh.key));
  return fresh.key;
}
export async function logoutBrowser(): Promise<void> { await api("/api/auth/logout","POST"); }
// How to leave: keep this device's encrypted copy and key (no recovery code next time), or erase them here (shared computers).
// `beforeLogout` saves the open vault first. Erasing runs after the server logout.
export function chooseLogout(userId: string, beforeLogout: () => Promise<unknown> = async () => undefined): void {
  const finish = async (forget: boolean, close: () => void) => {
    try {
      await beforeLogout().catch(() => undefined);
      await logoutBrowser();
      if (forget) await forgetLocalUser(userId);
      close();
      location.reload();
    } catch (e) { toast(errorText(e), true); }
  };
  openDialog({
    label: "Wylogowanie",
    className: "settings",
    render(box, close) {
      const title = document.createElement("h2"); title.textContent = "Wylogować?";
      const keep = document.createElement("p"); keep.textContent = "Wyloguj — zaszyfrowana kopia notatek i klucz zostają na tym urządzeniu, więc przy następnym logowaniu tutaj nie trzeba podawać kodu odzyskiwania.";
      const erase = document.createElement("p"); erase.textContent = "Wyloguj i usuń dane z tego urządzenia — kopia notatek i klucz znikną z tej przeglądarki, a przy następnym logowaniu będzie potrzebny kod odzyskiwania. Wybierz to na komputerze wspólnym.";
      const actions = document.createElement("div"); actions.className = "modal-actions";
      const button = (label: string, className: string, run: () => void) => { const b = document.createElement("button"); b.type = "button"; b.className = className; b.textContent = label; b.title = label; b.setAttribute("aria-label", label); b.addEventListener("click", run); return b; };
      actions.append(
        button("Anuluj", "btn", () => close()),
        button("Wyloguj", "btn", () => void finish(false, close)),
        button("Wyloguj i usuń dane z tego urządzenia", "btn btn-danger", () => void finish(true, close)),
      );
      box.append(title, keep, erase, actions);
    },
  });
}
/** Erases this user's encrypted copies and keys from this browser (after the account was deleted). Other users stay. */
export async function forgetLocalUser(userId: string): Promise<void> {
  // Per-account localStorage keys: the last vault opened, the last note of each vault and the read notifications.
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === `notes.lastVault.v1.${userId}` || key.startsWith(`notes.lastNote.v1.${userId}:`) || (key.startsWith("notes.inbox.") && key.endsWith(`.${userId}`))) localStorage.removeItem(key);
    }
  } catch { /* storage blocked: nothing was remembered */ }
  const db = await openDb();
  const stores = [WORKSPACES, KEYS, VAULTS, EPOCH_KEYS, PROJECT_KEYS];
  const tx = db.transaction(stores, "readwrite");
  tx.objectStore(WORKSPACES).delete(userId); tx.objectStore(KEYS).delete(userId);
  // compound keys start with the user id: [userId] up to [userId, []] spans all of theirs (arrays sort after strings)
  for (const store of [VAULTS, EPOCH_KEYS, PROJECT_KEYS]) tx.objectStore(store).delete(IDBKeyRange.bound([userId], [userId, []]));
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  db.close();
}
export function isBrowserBridge(bridge: Bridge): bridge is BrowserBridge { return bridge instanceof BrowserBridge; }
