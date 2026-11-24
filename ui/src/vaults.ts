// Shared organization vaults in the browser (contract: docs/WEB-WSPOLDZIELENIE.md): the vault key, the REST calls,
// invite links and the dialogs (switcher, new organization, members and invites). The sync itself is in browserauth.ts.
import type { BrowserBridge } from "./browserauth";
import { openSealed, type BoxIdentity, type SealedBox } from "./sealed";
import type { ProfileEnvelope } from "./profile";
import type { AgentCert, AgentSealed, SealedScope, WriteMode } from "./agentcrypto";
import type { Proposal } from "./proposals";
import { KIND_LABEL } from "./spaces";
import { confirmDialog, errorText, openDialog, openMenu, toast, type MenuEntry } from "./widgets";

export type Role = "owner" | "admin" | "editor" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "editor", "viewer"];
export const ROLE_LABEL: Record<Role, string> = { owner: "właściciel", admin: "administrator", editor: "edytor", viewer: "czytelnik" };
export type VaultKind = "notatki" | "organizacja";
// keyEpoch: the vault's current key epoch (Stage E); absent for the personal vault.
export interface VaultInfo { id: string; name: string; kind: VaultKind; ownerUserId: string; keyEpoch?: number }
export type VaultRow = VaultInfo & { role: Role };
// signingKey: the member's public ECDSA P-256 JWK (Stage D), null when they have none yet. boxKey: the public ECDH P-256
// JWK for sealed boxes (Stage E), same rule.
// email comes only to admins, owners and the member themself: it may be missing from the list. profile: the member's
// name card (profile.ts), encrypted; its last name is shown once a browser opens it.
// agents: the member's Claude chats with this vault in scope (docs/MCP.md §3.3), not revoked or revoked in the last 90 days; the cert's signature
// comes beside it.
export interface RemoteMember { userId: string; email?: string | null; name: string; role: Role; profile?: ProfileEnvelope | null; signingKey?: JsonWebKey | null; boxKey?: JsonWebKey | null; agents?: MemberAgent[] }
export interface MemberAgent { agentId: string; cert: AgentCert; signature: string; revokedAt: number | null }
// What the owner allows chats in a vault (WEB-WSPOLDZIELENIE "Claude chats"). A personal vault is always the widest.
export interface AgentPolicy { enabled: boolean; maxHours: number; maxWriteMode: WriteMode; allowProtected: boolean }
export const ORG_AGENT_POLICY: AgentPolicy = { enabled: false, maxHours: 8, maxWriteMode: "proposals", allowProtected: false };
export const PERSONAL_AGENT_POLICY: AgentPolicy = { enabled: true, maxHours: 24, maxWriteMode: "direct", allowProtected: true };
// What a browser bridge needs to open a vault: its info, this user's role, the members, and the raw vault key (null for
// the personal vault, which is encrypted with the personal key itself) with its epoch.
export interface VaultAccess { vault: VaultInfo; role: Role; members: RemoteMember[]; rawKey: Uint8Array | null; keyEpoch: number }
export interface KeyEnvelope { schema: "notes-key-v1"; nonce: string; ciphertext: string }
export interface PendingKey { keyEpoch: number; sealedKey: SealedBox }
// Stage E: wrappedKeyEpoch is the epoch of this member's wrappedKey; pendingKey holds the key of a newer epoch for them.
export interface VaultDetail { vault: VaultInfo; role: Role; wrappedKey: KeyEnvelope; wrappedKeyEpoch?: number; pendingKey?: PendingKey | null; needsRotation?: boolean; members: RemoteMember[]; agentPolicy?: AgentPolicy }
export interface InvitePreview { vault: VaultInfo; role: Role; expiresAt: number }
export interface InviteRow { id: string; role: Role; createdBy: string; createdAt: number; expiresAt: number; maxUses: number; uses: number }
export interface InviteLink { token: string; key: Uint8Array; keyEpoch: number }

const KEY_SCHEMA = "notes-key-v1";
const LAST_VAULT_KEY = (userId: string) => `notes.lastVault.v1.${userId}`;
const SAVE_FAILED = "Nie udało się zapisać zmian. Przełączanie anulowane.";
export const READ_ONLY_TEXT = "Masz dostęp tylko do odczytu.";

// ---- bytes and encodings -------------------------------------------------------------------------------------------

export const bytesToBase64 = (b: Uint8Array): string => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
export const base64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const bufferSource = (b: Uint8Array): ArrayBuffer => Uint8Array.from(b).buffer as ArrayBuffer;
// base64url without padding, as the invite fragment carries it.
export const toBase64Url = (b: Uint8Array): string => bytesToBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("Nieprawidłowe kodowanie klucza.");
  return base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
}

// ---- vault key ---------------------------------------------------------------------------------------------------

export const personalVaultId = (userId: string): string => `browser-${userId}`;
export const isSharedVaultId = (id: string): boolean => /^v-[0-9a-f]{32}$/.test(id);
export const randomVaultKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
export const importVaultKey = (raw: Uint8Array): Promise<CryptoKey> => crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, ["encrypt", "decrypt"]);

// Any bytes, encrypted with the personal key as a notes-key-v1 envelope (12-byte nonce, AES-GCM). Used for vault keys
// and for the signing key's PKCS#8 (signing.ts).
// `aad`: the context the bytes are bound to (a key of Moje notatki: its user and epoch), so a server cannot pass another
// wrapped key of this user for it; the same `aad` must be given to unwrap.
export async function wrapBytes(raw: Uint8Array, personal: CryptoKey, aad?: Uint8Array): Promise<KeyEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), tagLength: 128, ...(aad ? { additionalData: bufferSource(aad) } : {}) }, personal, bufferSource(raw));
  return { schema: KEY_SCHEMA, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

export async function unwrapBytes(envelope: KeyEnvelope, personal: CryptoKey, aad?: Uint8Array): Promise<Uint8Array> {
  if (envelope?.schema !== KEY_SCHEMA) throw new Error("Nieobsługiwany format klucza sejfu.");
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(base64ToBytes(envelope.nonce)), tagLength: 128, ...(aad ? { additionalData: bufferSource(aad) } : {}) }, personal, bufferSource(base64ToBytes(envelope.ciphertext)));
  } catch { throw new Error("Nie udało się odblokować klucza tego sejfu."); }
  return new Uint8Array(raw);
}

// The raw vault key, wrapped for one member.
export const wrapVaultKey = (raw: Uint8Array, personal: CryptoKey): Promise<KeyEnvelope> => wrapBytes(raw, personal);

export async function unwrapVaultKey(envelope: KeyEnvelope, personal: CryptoKey, aad?: Uint8Array): Promise<Uint8Array> {
  const key = await unwrapBytes(envelope, personal, aad);
  if (key.length !== 32) throw new Error("Klucz sejfu ma nieprawidłowy rozmiar.");
  return key;
}

// A key of Moje notatki on the server (docs/MCP.md §3.7) is bound to its user and epoch: a vault key of a shared vault,
// or another epoch's, does not unwrap as one.
const personalKeyAad = (userId: string, keyEpoch: number): Uint8Array => new TextEncoder().encode(`notes-personal-vault-key-v1\0${userId}\0${keyEpoch}`);
export const wrapPersonalVaultKey = (raw: Uint8Array, personal: CryptoKey, userId: string, keyEpoch: number): Promise<KeyEnvelope> =>
  wrapBytes(raw, personal, personalKeyAad(userId, keyEpoch));
export const unwrapPersonalVaultKey = (envelope: KeyEnvelope, personal: CryptoKey, userId: string, keyEpoch: number): Promise<Uint8Array> =>
  unwrapVaultKey(envelope, personal, personalKeyAad(userId, keyEpoch));

// ---- REST ---------------------------------------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string } & T;
  if (!response.ok) throw new ApiError(data.message ?? data.error ?? `Błąd serwera (${response.status}).`, response.status);
  return data;
}

export const listSharedVaults = async (): Promise<VaultRow[]> => (await api<{ vaults: VaultRow[] }>("/api/vaults")).vaults;
// A chat an admin took out of this vault (`detachedAt`) counts here as disconnected at that time: its older events still
// verify, newer ones do not, and it gets no new key (docs/WEB-WSPOLDZIELENIE.md, DELETE /api/vaults/:id/agents/:agentId).
export async function fetchVault(vaultId: string): Promise<VaultDetail> {
  const detail = await api<VaultDetail>(`/api/vaults/${encodeURIComponent(vaultId)}`);
  for (const m of detail.members ?? []) for (const a of m.agents ?? []) {
    const detached = (a as MemberAgent & { detachedAt?: number | null }).detachedAt;
    if (detached != null) a.revokedAt = a.revokedAt == null ? detached : Math.min(a.revokedAt, detached);
  }
  return detail;
}
const membersPath = (vaultId: string, userId: string) => `/api/vaults/${encodeURIComponent(vaultId)}/members/${encodeURIComponent(userId)}`;
const invitesPath = (vaultId: string) => `/api/vaults/${encodeURIComponent(vaultId)}/invites`;

export async function createVault(name: string, personal: CryptoKey): Promise<VaultRow> {
  const wrappedKey = await wrapVaultKey(randomVaultKey(), personal);
  return (await api<{ vault: VaultRow }>("/api/vaults", "POST", { name, kind: "organizacja", wrappedKey })).vault;
}

export async function createInvite(vaultId: string, role: Role, maxUses: number): Promise<{ id: string; token: string; expiresAt: number }> {
  return (await api<{ invite: { id: string; token: string; expiresAt: number } }>(invitesPath(vaultId), "POST", { role, maxUses })).invite;
}
export const listInvites = async (vaultId: string): Promise<InviteRow[]> => (await api<{ invites: InviteRow[] }>(invitesPath(vaultId))).invites;
export const revokeInvite = (vaultId: string, inviteId: string): Promise<unknown> => api(`${invitesPath(vaultId)}/${encodeURIComponent(inviteId)}`, "DELETE");
export const removeMember = (vaultId: string, userId: string): Promise<unknown> => api(membersPath(vaultId, userId), "DELETE");
// agentKeys: the new key sealed for every unrevoked chat of a remaining member whose cert has the vault (409 otherwise).
export interface AgentKeyOut { agentId: string; sealedKey: AgentSealed }
export const rotateVaultKey = (vaultId: string, keyEpoch: number, keys: { userId: string; sealedKey: SealedBox }[], agentKeys: AgentKeyOut[] = []): Promise<unknown> => api(`/api/vaults/${encodeURIComponent(vaultId)}/rotate`, "POST", { keyEpoch, keys, agentKeys });
// The personal vault's own keys (docs/MCP.md §3.7): random keys wrapped with the personal key, from epoch 2. Epoch 1 is
// the personal key itself. A PUT takes only the next epoch and never replaces one (409: another device was first).
export interface PersonalKeyRow { keyEpoch: number; wrappedKey: KeyEnvelope; createdAt?: number }
export const fetchPersonalKeys = async (): Promise<PersonalKeyRow[]> => (await api<{ keys: PersonalKeyRow[] }>("/api/me/personal-key")).keys;
// agentKeys: the new key for the person's own chats with Moje notatki (an empty list when there are none).
export const putPersonalKey = (keyEpoch: number, wrappedKey: KeyEnvelope, agentKeys: AgentKeyOut[] = []): Promise<unknown> => api("/api/me/personal-key", "PUT", { keyEpoch, wrappedKey, agentKeys });
export const putMyKey = (vaultId: string, keyEpoch: number, wrappedKey: KeyEnvelope): Promise<unknown> => api(`/api/vaults/${encodeURIComponent(vaultId)}/my-key`, "PUT", { keyEpoch, wrappedKey });
export const putMyProfile = (vaultId: string, profile: ProfileEnvelope | null): Promise<unknown> => api(`/api/vaults/${encodeURIComponent(vaultId)}/my-profile`, "PUT", { profile });
export const changeMemberRole = (vaultId: string, userId: string, role: Role): Promise<unknown> => api(membersPath(vaultId, userId), "PATCH", { role });

// ---- Claude chats (docs/MCP.md §3, contract: WEB-WSPOLDZIELENIE "Claude chats"); the logic is in agentpairing.ts ----

export interface PairingClaim { signKey: string; boxKey: string; device: { name: string; os: string } | null; mcpVersion: string; ip: string; claimedAt: number }
export interface PairingState { state: "waiting" | "claimed" | "burned" | "expired" | "done"; claim: PairingClaim | null; requestIp: string }
export interface AgentRow {
  agentId: string; device: { name: string; os: string } | null; mcpVersion: string; cert: AgentCert; signature: string; createdAt: number;
  sessionExpiresAt: number; lastUsedAt: number | null; lastIp: string | null; revokedAt: number | null; paused: null | "ip" | "limit";
  knownIps: string[]; fetches: number; writes: number;
  // the person's own copy of each scope (agentpairing.ts ownScope), opaque to the server and never given to the chat
  scopes?: { vaultId: string; ownScope: KeyEnvelope }[];
}
export interface AgentKeyIn { vaultId: string; keyEpoch: number; sealedKey: AgentSealed }
export interface AgentScopeIn { vaultId: string; sealedScope: SealedScope; ownScope: KeyEnvelope }
export interface AgentScopeBody { cert: AgentCert; signature: string; keys: AgentKeyIn[]; scopes: AgentScopeIn[] }
export interface ProposalRow { proposalId: string; agentId: string; createdAt: number; expiresAt: number; state: string; proposal: Proposal }
export interface ServerVersion { server: string; agentMin: string; agentLatest: string; agentsDisabled: boolean; update: { npm: string; mcpb: string } }
const agentPath = (agentId: string) => `/api/me/agents/${encodeURIComponent(agentId)}`;
const pairingPath = (pairingId: string) => `/api/me/agent-pairings/${encodeURIComponent(pairingId)}`;
const vaultPath = (vaultId: string) => `/api/vaults/${encodeURIComponent(vaultId)}`;

export const startAgentPairing = (): Promise<{ pairingId: string; code: string; expiresAt: number }> => api("/api/me/agent-pairings", "POST", {});
export const fetchAgentPairing = (pairingId: string): Promise<PairingState> => api(pairingPath(pairingId));
export const cancelAgentPairing = (pairingId: string): Promise<unknown> => api(pairingPath(pairingId), "DELETE");
export const createAgent = (body: AgentScopeBody & { pairingId: string; sessionHours: number }): Promise<{ agentId: string }> => api("/api/me/agents", "POST", body);
export const listMyAgents = async (): Promise<AgentRow[]> => (await api<{ agents: AgentRow[] }>("/api/me/agents")).agents;
export const updateAgentScope = (agentId: string, body: AgentScopeBody): Promise<unknown> => api(agentPath(agentId), "PUT", body);
export const renewAgentSession = async (agentId: string, hours: number): Promise<number> => (await api<{ sessionExpiresAt: number }>(`${agentPath(agentId)}/renew`, "POST", { hours })).sessionExpiresAt;
export const confirmAgentSession = (agentId: string): Promise<unknown> => api(`${agentPath(agentId)}/confirm`, "POST");
export const deleteAgent = (agentId: string): Promise<unknown> => api(agentPath(agentId), "DELETE");
export const deleteAllAgents = (): Promise<unknown> => api("/api/me/agents", "DELETE");
/** Admin and up: takes this vault out of a member's chat (its keys and scope here go, the vault needs a rotation); the chat keeps the person's other spaces. */
export const disconnectMemberAgent = (vaultId: string, agentId: string): Promise<unknown> => api(`${vaultPath(vaultId)}/agents/${encodeURIComponent(agentId)}`, "DELETE");
/** Owner: the chats' limits in this vault. */
export const setAgentPolicy = (vaultId: string, policy: AgentPolicy): Promise<unknown> => api(`${vaultPath(vaultId)}/agent-policy`, "PUT", policy);
export const listVaultProposals = async (vaultId: string): Promise<ProposalRow[]> => (await api<{ proposals: ProposalRow[] }>(`${vaultPath(vaultId)}/proposals`)).proposals;
export const decideVaultProposal = (vaultId: string, proposalId: string, decision: "approved" | "rejected"): Promise<unknown> =>
  api(`${vaultPath(vaultId)}/proposals/${encodeURIComponent(proposalId)}/decision`, "POST", { decision });
export const fetchServerVersion = (): Promise<ServerVersion> => api("/api/version");

// The vault this user opens: the personal one, or a shared one with its key unwrapped from the member's wrappedKey.
export function personalAccess(userId: string): VaultAccess {
  return { vault: { id: personalVaultId(userId), name: "Moje notatki", kind: "notatki", ownerUserId: userId }, role: "owner", members: [], rawKey: null, keyEpoch: 1 };
}
// A membership from an assignment (docs/PANEL-ADMINA.md "Przydział do organizacji") has wrappedKeyEpoch 0 and only a
// pending key sealed to this user's box key: it is opened with `box`, stored as this user's own copy (PUT my-key), and
// only then used. Its wrappedKey is no notes-key-v1 envelope and is never unwrapped.
export async function openAccess(vaultId: string | null, userId: string, personal: CryptoKey, box?: BoxIdentity): Promise<VaultAccess> {
  if (!vaultId || vaultId === personalVaultId(userId)) return personalAccess(userId);
  const detail = await fetchVault(vaultId);
  if (detail.wrappedKeyEpoch === 0 || detail.wrappedKey?.schema !== "notes-key-v1") {
    const pending = detail.pendingKey;
    if (!pending) throw new Error("Klucz tej organizacji jeszcze na Ciebie czeka. Spróbuj ponownie za chwilę.");
    const raw = await adoptPending(vaultId, pending, box, personal);
    return { vault: detail.vault, role: detail.role, members: detail.members, rawKey: raw, keyEpoch: pending.keyEpoch };
  }
  return { vault: detail.vault, role: detail.role, members: detail.members, rawKey: await unwrapVaultKey(detail.wrappedKey, personal), keyEpoch: detail.wrappedKeyEpoch ?? detail.vault.keyEpoch ?? 1 };
}

/** Opens a pending vault key with the box key and stores this user's own copy (PUT my-key); the raw key comes back. */
export async function adoptPending(vaultId: string, pending: PendingKey, box: BoxIdentity | undefined, personal: CryptoKey): Promise<Uint8Array> {
  if (!box) throw new Error("Brak klucza szyfrowania na tym urządzeniu.");
  const raw = await openSealed(pending.sealedKey, box.privateKey);
  if (raw.length !== 32) throw new Error("Klucz sejfu ma nieprawidłowy rozmiar.");
  await putMyKey(vaultId, pending.keyEpoch, await wrapVaultKey(raw, personal));
  return raw;
}

// Moje notatki need the server admin's consent for accounts registered from an invite (docs/PANEL-ADMINA.md "Własne
// notatki"). An account the server says nothing about (an older server) keeps them.
export type PersonalState = "allowed" | "requested" | "off";
export const personalAllowed = (user: { personal?: PersonalState }): boolean => (user.personal ?? "allowed") === "allowed";
/** Moje notatki as a list entry, or nothing without the consent. */
export const ownVaults = (user: { id: string; personal?: PersonalState }): VaultInfo[] => (personalAllowed(user) ? [personalAccess(user.id).vault] : []);
/** The vault to fall back to: Moje notatki, or "" (the first organization) without them. */
export const homeVaultId = (user: { id: string; personal?: PersonalState }): string => (personalAllowed(user) ? personalVaultId(user.id) : "");
export async function fetchPersonalState(): Promise<PersonalState> {
  return (await api<{ user?: { personal?: PersonalState } }>("/api/auth/me")).user?.personal ?? "allowed";
}
/** Asks the server admin for Moje notatki; the server answers with the state after the call. */
export const requestPersonalNotes = async (): Promise<PersonalState> => (await api<{ personal?: PersonalState }>("/api/me/personal-request", "POST", {})).personal ?? "requested";
export const PERSONAL_WAITING_TEXT = "Czeka na zgodę administratora serwera.";
/** The request button (off), the waiting line (requested), or null (allowed). `onRequested` gets the new state. */
export function personalNotesControl(state: PersonalState, onRequested?: (state: PersonalState) => void): HTMLElement | null {
  if (state === "allowed") return null;
  const waiting = () => el("p", "muted", PERSONAL_WAITING_TEXT);
  if (state === "requested") return waiting();
  const ask = button("Poproś o własne notatki", "btn", async () => {
    ask.disabled = true;
    try {
      const next = await requestPersonalNotes();
      // already allowed meanwhile: a reload opens Moje notatki
      ask.replaceWith(next === "allowed" ? el("p", "muted", "Własne notatki są włączone. Odśwież stronę.") : waiting());
      onRequested?.(next);
    }
    catch (e) { toast(errorText(e), true); ask.disabled = false; }
  });
  return ask;
}

// Assignments by the server admin (docs/PANEL-ADMINA.md "Przydział do organizacji"): an owner's or admin's browser seals
// the vault key to the person's box key, the same way as for members on rotation, and completes them.
export interface Assignment { userId: string; email?: string | null; name?: string; role: Role; boxKey: unknown }
export const listAssignments = (vaultId: string): Promise<Assignment[]> => api<Assignment[]>(`${vaultPath(vaultId)}/assignments`);
export const completeAssignment = (vaultId: string, userId: string, sealedKey: SealedBox, keyEpoch: number): Promise<unknown> =>
  api(`${vaultPath(vaultId)}/assignments/${encodeURIComponent(userId)}/complete`, "POST", { sealedKey, keyEpoch });

// The vault the user opened last on this device (a per-viewer convenience; the server does not need it).
export function rememberedVault(userId: string): string | null { try { return localStorage.getItem(LAST_VAULT_KEY(userId)); } catch { return null; } }
export function rememberVault(userId: string, vaultId: string): void { try { localStorage.setItem(LAST_VAULT_KEY(userId), vaultId); } catch { /* not remembered */ } }

// ---- roles -------------------------------------------------------------------------------------------------------

// Owners change anyone's role and remove anyone; admins only editors and viewers.
export const canManage = (actor: Role, target: Role): boolean => actor === "owner" || (actor === "admin" && (target === "editor" || target === "viewer"));
// The roles this actor may give to a member.
export const assignableRoles = (actor: Role): Role[] => (actor === "owner" ? ROLES : actor === "admin" ? ["editor", "viewer"] : []);
// The roles this actor may give in an invite. Only the owner invites admins.
export const invitableRoles = (actor: Role): Role[] => (actor === "owner" ? ["admin", "editor", "viewer"] : actor === "admin" ? ["editor", "viewer"] : []);
// The role choices of one member's select: the current role, plus the roles the actor may assign to them.
export function memberRoleOptions(actor: Role, current: Role): { role: Role; enabled: boolean }[] {
  const allowed = canManage(actor, current) ? assignableRoles(actor) : [];
  return ROLES.map((role) => ({ role, enabled: role === current || allowed.includes(role) }));
}

// ---- invites ------------------------------------------------------------------------------------------------------

// The link carries the current key and its epoch: #k=<key>&e=<epoch>.
export function inviteLink(origin: string, token: string, rawKey: Uint8Array, keyEpoch: number): string {
  return `${origin}/?invite=${token}#k=${toBase64Url(rawKey)}&e=${keyEpoch}`;
}

// The invite in an address: ?invite=<token> with the vault key in the fragment (#k=) and its epoch (&e=). A link without
// e= is from before key epochs and means epoch 1. Null when any part is malformed.
export function parseInviteHref(href: string): InviteLink | null {
  const url = new URL(href);
  const token = url.searchParams.get("invite") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const key = fromBase64Url(fragment.get("k") ?? "");
    const e = fragment.get("e");
    const keyEpoch = e === null ? 1 : /^[1-9]\d{0,8}$/.test(e) ? Number(e) : NaN;
    return key.length === 32 && Number.isInteger(keyEpoch) ? { token, key, keyEpoch } : null;
  } catch { return null; }
}

export const hasInviteParam = (href: string): boolean => new URL(href).searchParams.has("invite");
// The invite leaves the address bar once it is handled, so a reload does not show it again.
export function clearInviteUrl(): void { history.replaceState(null, "", location.pathname); }

// Joins the vault with the key from the link, wrapped with this user's personal key, and its epoch. 409 means already a
// member, which still opens the vault. 410 (a key change since the link was made) is the server's message.
export async function acceptInvite(token: string, rawKey: Uint8Array, personal: CryptoKey, vaultId: string, keyEpoch: number): Promise<string> {
  const wrappedKey = await wrapVaultKey(rawKey, personal);
  try { return (await api<{ vault: VaultRow }>("/api/invites/accept", "POST", { token, wrappedKey, keyEpoch })).vault.id; }
  catch (e) { if (e instanceof ApiError && e.status === 409) return vaultId; throw e; }
}

function inviteError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return "Ten link zaproszenia nie istnieje.";
  if (e instanceof ApiError && e.status === 410) return e.message;
  return errorText(e);
}

// Handles an invite from the address: shows the vault and role, joins on confirm. Resolves with the vault to open, or
// null for the personal vault. The address is cleared in every case.
export async function runInvite(link: InviteLink | null, personal: CryptoKey, confirm: (message: string) => Promise<boolean> = (m) => confirmDialog(m, "Dołącz", false)): Promise<string | null> {
  try {
    if (!link) { await infoDialog("Ten link zaproszenia jest niepełny. Poproś o nowy."); return null; }
    let preview: InvitePreview;
    try { preview = await api<InvitePreview>(`/api/invites/${link.token}`); }
    catch (e) { await infoDialog(inviteError(e)); return null; }
    if (!(await confirm(`Dołącz do ${preview.vault.name} jako ${ROLE_LABEL[preview.role]}`))) return null;
    try { return await acceptInvite(link.token, link.key, personal, preview.vault.id, link.keyEpoch); }
    catch (e) { await infoDialog(inviteError(e)); return null; }
  } finally { clearInviteUrl(); }
}

// ---- dialogs and menus --------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
const button = (label: string, className = "btn", onClick?: () => void): HTMLButtonElement => {
  const b = el("button", className, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
};
const shortDate = (ms: number): string => new Date(ms).toLocaleDateString("pl-PL");
// "1 osoby", "2 osób", "5 osób": after a number, "osoby" only for 1.
const peopleCount = (n: number): string => `${n} ${n === 1 ? "osoby" : "osób"}`;

export function infoDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    openDialog({
      label: message,
      className: "modal-confirm",
      render(box, close) {
        const row = el("div", "modal-actions");
        row.append(button("OK", "btn btn-primary", () => close()));
        box.append(el("p", "", message), row);
      },
      onClose: () => resolve(),
    });
  });
}

export const vaultUrl = (vaultId: string): string => (vaultId ? `${location.pathname}?vault=${encodeURIComponent(vaultId)}` : location.pathname);

// Opens another vault: the open one saves first, then the page reloads on the other vault.
export async function goToVault(bridge: BrowserBridge, vaultId: string): Promise<boolean> {
  if (!(await bridge.flush())) { toast(SAVE_FAILED, true); return false; }
  location.assign(vaultUrl(vaultId));
  return true;
}

// The switcher on the space name: the personal vault and the shared ones, then the actions.
export async function openVaultMenu(anchor: HTMLElement, bridge: BrowserBridge): Promise<void> {
  let shared: VaultRow[] = [];
  try { shared = await listSharedVaults(); } catch (e) { toast(errorText(e), true); }
  const current = bridge.vault.id;
  // the vault on screen is not offered: the menu is for going elsewhere
  const infos: VaultInfo[] = [...ownVaults(bridge.user), ...shared].filter((info) => info.id !== current);
  const entries: MenuEntry[] = infos.map((info) => ({
    label: `${info.name} · ${KIND_LABEL[info.kind]}`,
    icon: "folder",
    run: () => void goToVault(bridge, info.id),
  }));
  if (entries.length) entries.push("separator");
  // the server refuses it too: an account from an invite link alone founds no organization until the admin agrees
  if (personalAllowed(bridge.user)) entries.push({ label: "Nowa organizacja…", icon: "plus", run: () => newOrganizationDialog(bridge) });
  if (isSharedVaultId(current)) entries.push({ label: "Członkowie i zaproszenia…", icon: "settings", run: () => openMembersDialog(bridge) });
  const r = anchor.getBoundingClientRect();
  openMenu(r.left, r.top - 4, entries);
}

export function newOrganizationDialog(bridge: BrowserBridge): void {
  openDialog({
    label: "Nowa organizacja",
    className: "settings vault-dialog",
    render(box, close) {
      const form = el("form", "vault-form");
      const input = el("input");
      input.required = true;
      input.maxLength = 80;
      input.placeholder = "Nazwa organizacji";
      input.setAttribute("aria-label", "Nazwa organizacji");
      const error = el("p", "web-auth-error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const submit = button("Utwórz", "btn btn-primary");
      submit.type = "submit";
      const actions = el("div", "modal-actions");
      actions.append(button("Anuluj", "btn", () => close()), submit);
      form.append(input, error, actions);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        submit.disabled = true;
        try { await createVault(name, bridge.personalKey).then((vault) => goToVault(bridge, vault.id)); }
        catch (e) { error.textContent = errorText(e); error.hidden = false; submit.disabled = false; }
      });
      box.append(el("h2", "", "Nowa organizacja"), form);
      input.focus();
    },
  });
}

// The name as the lists show it: the display name, then the last name when one could be read.
export const memberLabel = (member: { name: string; lastName?: string | null }): string => [member.name, member.lastName].filter(Boolean).join(" ");

// Members and invites of the open organization. Every member sees the list; owners and admins see invites and may
// change roles and remove members within the rules of canManage.
export function openMembersDialog(bridge: BrowserBridge): void {
  const vaultId = bridge.vault.id;
  openDialog({
    label: "Członkowie i zaproszenia",
    className: "settings vault-dialog",
    render(box, close) {
      const body = el("div", "vault-body");
      const leave = button("Opuść organizację", "btn btn-danger", async () => {
        if (!(await confirmDialog("Opuścić tę organizację? Stracisz do niej dostęp.", "Opuść"))) return;
        try { await api(membersPath(vaultId, bridge.user.id), "DELETE"); }
        catch (e) { toast(errorText(e), true); return; }
        bridge.markLeaving();
        await goToVault(bridge, homeVaultId(bridge.user));
      });
      const footer = el("div", "modal-actions");
      footer.append(leave, button("Zamknij", "btn", () => close()));
      box.append(el("h2", "", "Członkowie i zaproszenia"), body, footer);

      const draw = async (): Promise<void> => {
        body.replaceChildren(el("p", "muted", "Wczytywanie…"));
        let detail: VaultDetail;
        try { detail = await fetchVault(vaultId); }
        catch (e) { body.replaceChildren(el("p", "web-auth-error", errorText(e))); return; }
        const onChange = async (): Promise<void> => { await bridge.refreshMembers().catch(() => undefined); await draw(); };
        const names = await bridge.memberLastNames(detail.members);
        const sections = [membersSection(vaultId, detail, bridge.user.id, onChange, () => bridge.catchUp(), names)];
        if (detail.role === "owner" || detail.role === "admin") {
          sections.push(rotationSection(bridge));
          sections.push(invitesSection(vaultId, detail.role, bridge.vaultKey, bridge.vaultEpoch));
          sections.push(chatsSection(vaultId, detail, onChange));
        }
        if (detail.role === "owner") sections.push(deleteVaultSection(bridge, detail.vault, close));
        body.replaceChildren(...sections);
      };
      void draw();
    },
  });
}

/** Deletes a shared vault for every member (owners only; the server checks the role and the typed name). */
export const deleteVault = (vaultId: string, name: string): Promise<unknown> => api(vaultPath(vaultId), "DELETE", { name });

// The last section, for owners: everything of the vault goes for everyone, so the name must be typed to confirm.
function deleteVaultSection(bridge: BrowserBridge, vault: VaultInfo, closeDialog: () => void): HTMLElement {
  const what = vault.kind === "organizacja" ? "organizację" : "sejf";
  const section = el("section", "vault-section vault-danger");
  section.append(
    el("h3", "", vault.kind === "organizacja" ? "Usuń organizację" : "Usuń sejf"),
    el("p", "muted", `Usunięcie obejmuje wszystkie notatki, pliki, zadania i kalendarz „${vault.name}”. Wszyscy członkowie od razu tracą dostęp. Tego nie da się cofnąć.`),
  );
  section.append(button(`Usuń ${what}…`, "btn btn-danger", async () => {
    if (!(await confirmDialog(`Usunąć ${what} „${vault.name}” na zawsze, razem z notatkami i plikami wszystkich członków?`, `Usuń ${what}`, true, vault.name))) return;
    // before the request: the server tells this tab's socket about the removal before it answers
    bridge.markLeaving();
    try { await deleteVault(vault.id, vault.name); }
    catch (e) { bridge.markLeaving(false); toast(errorText(e), true); return; }
    closeDialog();
    toast(`Usunięto ${what} „${vault.name}”.`);
    await goToVault(bridge, homeVaultId(bridge.user));
  }));
  return section;
}

// Owners and admins change the vault key on demand. Removing a member already asks for it (see membersSection).
function rotationSection(bridge: BrowserBridge): HTMLElement {
  const section = el("section", "vault-section");
  section.append(el("h3", "", "Klucz sejfu"), el("p", "muted", "Nowy klucz dostaną wszyscy obecni członkowie. Nieużyte zaproszenia zostaną odwołane, bo ich linki zawierają stary klucz."));
  section.append(button("Zmień klucz sejfu", "btn", async () => {
    if (!(await confirmDialog("Zmienić klucz sejfu? Stary klucz przestanie być używany do nowych zmian.", "Zmień"))) return;
    try { if (await bridge.rotateKey()) toast("Zmieniono klucz sejfu."); }
    catch (e) { toast(errorText(e), true); }
  }));
  return section;
}

// `afterRemove`: the removal marks the vault for a new key, which this admin then takes (BrowserBridge.catchUp).
// `names`: last names read from the members' cards (userId → name); a member missing from it shows the display name only.
export function membersSection(vaultId: string, detail: VaultDetail, me: string, onChange: () => Promise<void>, afterRemove: () => Promise<void>, names = new Map<string, string>()): HTMLElement {
  const section = el("section", "vault-section");
  section.append(el("h3", "", "Członkowie"));
  const list = el("ul", "vault-list");
  for (const member of detail.members) {
    const row = el("li", "vault-row");
    const self = member.userId === me;
    const label = memberLabel({ name: member.name, lastName: names.get(member.userId) });
    const who = el("span", "vault-who", label);
    if (member.email) who.append(" ", el("span", "muted", `(${member.email})`));
    if (self) who.append(" ", el("span", "person-you", "Ty"));
    row.append(who);
    const select = el("select");
    select.setAttribute("aria-label", `Rola: ${label}`);
    for (const { role, enabled } of memberRoleOptions(detail.role, member.role)) {
      const option = el("option", "", ROLE_LABEL[role]);
      option.value = role;
      option.selected = role === member.role;
      option.disabled = !enabled;
      select.append(option);
    }
    select.disabled = !canManage(detail.role, member.role);
    select.addEventListener("change", async () => {
      select.disabled = true;
      try { await changeMemberRole(vaultId, member.userId, select.value as Role); toast("Zmieniono rolę."); }
      catch (e) { toast(errorText(e), true); }
      await onChange();
    });
    row.append(select);
    if (!self && canManage(detail.role, member.role)) {
      row.append(button("Usuń", "btn", async () => {
        if (!(await confirmDialog(`Usunąć ${label} z organizacji? Dostęp zostanie cofnięty od razu.`, "Usuń"))) return;
        try {
          await removeMember(vaultId, member.userId);
          toast("Usunięto członka.");
          await afterRemove();
        }
        catch (e) { toast(errorText(e), true); }
        await onChange();
      }));
    }
    list.append(row);
  }
  section.append(list);
  return section;
}

// Claude chats of the organization (docs/MCP.md §6, §9, §16): the owner sets the limits; owners and admins see the
// members' chats (not their folder scope) and may disconnect one.
const WRITE_LABEL: Record<WriteMode, string> = { none: "tylko odczyt", proposals: "propozycje do zatwierdzenia", append: "dopisywanie", direct: "bezpośrednio" };
export function chatsSection(vaultId: string, detail: VaultDetail, onChange: () => Promise<void>): HTMLElement {
  const section = el("section", "vault-section");
  section.append(el("h3", "", "Czaty Claude"));
  const policy = detail.agentPolicy ?? ORG_AGENT_POLICY;
  if (detail.role === "owner") {
    const form = el("form", "vault-form");
    const check = (label: string, value: boolean) => { const row = el("label", "vault-check"); const box = el("input"); box.type = "checkbox"; box.checked = value; row.append(box, document.createTextNode(` ${label}`)); return { row, box }; };
    const enabled = check("Czaty w organizacji", policy.enabled);
    const protectedOk = check("Czat może widzieć chronione projekty (członków tych projektów)", policy.allowProtected);
    const hours = el("select"); hours.setAttribute("aria-label", "Najdłuższa sesja czatu");
    for (const h of [1, 4, 8, 24]) { const o = el("option", "", `${h} h`); o.value = String(h); o.selected = h === policy.maxHours; hours.append(o); }
    const mode = el("select"); mode.setAttribute("aria-label", "Najszerszy tryb zapisu czatu");
    for (const m of ["none", "proposals", "append", "direct"] as WriteMode[]) { const o = el("option", "", WRITE_LABEL[m]); o.value = m; o.selected = m === policy.maxWriteMode; mode.append(o); }
    const save = el("button", "btn", "Zapisz");
    save.type = "submit";
    form.append(enabled.row, protectedOk.row, el("span", "muted", "Najdłuższa sesja"), hours, el("span", "muted", "Najszerszy tryb zapisu"), mode, save);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void setAgentPolicy(vaultId, { enabled: enabled.box.checked, maxHours: Number(hours.value), maxWriteMode: mode.value as WriteMode, allowProtected: protectedOk.box.checked })
        .then(() => { toast("Zapisano ustawienia czatów."); return onChange(); }, (err) => toast(errorText(err), true));
    });
    section.append(el("p", "muted", "Członek, który połączy Claude, wysyła do Anthropic treść, którą Claude przeczyta, także zadania i nazwiska innych osób. Domyślnie czaty są wyłączone."), form);
  } else section.append(el("p", "muted", policy.enabled ? `Czaty włączone: sesja najwyżej ${policy.maxHours} h, zapis najwyżej: ${WRITE_LABEL[policy.maxWriteMode]}.` : "Czaty w tej organizacji są wyłączone."));
  const chats = detail.members.flatMap((m) => (m.agents ?? []).filter((a) => a.revokedAt == null).map((a) => ({ member: m, agent: a })));
  if (chats.length) {
    const list = el("ul", "vault-list");
    for (const { member, agent } of chats) {
      const row = el("li", "");
      // the server takes only this organization out of the chat; its person's other spaces stay
      const off = el("button", "btn", "Odłącz od tej organizacji");
      off.type = "button";
      off.addEventListener("click", () => void confirmDialog(`Odłączyć czat Claude osoby ${member.name || member.email || member.userId} od tej organizacji? Czat straci dostęp do jej notatek; inne przestrzenie tej osoby zostają.`, "Odłącz od tej organizacji").then((ok) => { if (ok) void disconnectMemberAgent(vaultId, agent.agentId).then(() => { toast("Czat odłączony od tej organizacji."); return onChange(); }, (err) => toast(errorText(err), true)); }));
      row.append(el("span", "", `${member.name || member.email || member.userId}: czat ${agent.agentId.slice(0, 8)}`), off);
      list.append(row);
    }
    section.append(list);
  }
  return section;
}

function invitesSection(vaultId: string, actor: Role, rawKey: Uint8Array | null, keyEpoch: number): HTMLElement {
  const section = el("section", "vault-section");
  section.append(el("h3", "", "Zaproszenia"), el("p", "muted", "Link zawiera klucz tego sejfu. Kto go zdobędzie przed użyciem, dołączy. Nieużyte zaproszenie można odwołać."));
  const form = el("form", "vault-form");
  const role = el("select");
  role.setAttribute("aria-label", "Rola zaproszenia");
  for (const r of ["admin", "editor", "viewer"] as Role[]) {
    const option = el("option", "", ROLE_LABEL[r]);
    option.value = r;
    option.selected = r === "editor";
    option.disabled = !invitableRoles(actor).includes(r);
    role.append(option);
  }
  const people = el("input");
  people.type = "number";
  people.min = "1";
  people.max = "50";
  people.value = "1";
  people.setAttribute("aria-label", "Na ile osób");
  const peopleField = el("label", "", "Na ile osób ");
  peopleField.append(people);
  const create = button("Utwórz link", "btn btn-primary");
  create.type = "submit";
  form.append(role, peopleField, create);
  const linkBox = el("div", "vault-link-box");
  const list = el("ul", "vault-list");
  const refresh = async (): Promise<void> => {
    list.replaceChildren();
    try {
      const invites = await listInvites(vaultId);
      if (invites.length === 0) list.append(el("li", "muted", "Brak aktywnych zaproszeń."));
      for (const invite of invites) {
        const row = el("li", "vault-row");
        row.append(el("span", "vault-who", `${ROLE_LABEL[invite.role]} · wykorzystano ${invite.uses} z ${invite.maxUses} · wygasa ${shortDate(invite.expiresAt)}`));
        row.append(button("Odwołaj", "btn", async () => {
          try { await revokeInvite(vaultId, invite.id); toast("Odwołano zaproszenie."); }
          catch (e) { toast(errorText(e), true); }
          await refresh();
        }));
        list.append(row);
      }
    } catch (e) { toast(errorText(e), true); }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!rawKey) { toast("Brak klucza tego sejfu na tym urządzeniu.", true); return; }
    // Checked here too: a non-number would be sent as null, which the server reads as "1 person".
    const maxUses = Number(people.value);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 50) { toast("Liczba osób musi być od 1 do 50.", true); return; }
    create.disabled = true;
    try {
      const invite = await createInvite(vaultId, role.value as Role, maxUses);
      linkBox.replaceChildren(
        el("p", "muted", `Link działa dla ${peopleCount(maxUses)}${maxUses > 1 ? " (każda może dołączyć raz)" : ""} i wygasa za 7 dni. Zawiera klucz sejfu — wysyłaj go tylko ${maxUses > 1 ? "tym osobom" : "tej osobie"}.`),
        linkField(inviteLink(location.origin, invite.token, rawKey, keyEpoch)),
      );
      await refresh();
    } catch (e) { toast(errorText(e), true); }
    finally { create.disabled = false; }
  });
  section.append(form, linkBox, list);
  void refresh();
  return section;
}

function linkField(link: string): HTMLElement {
  const wrap = el("div", "vault-link");
  const input = el("input");
  input.readOnly = true;
  input.value = link;
  input.setAttribute("aria-label", "Link zaproszenia");
  input.addEventListener("focus", () => input.select());
  const copy = button("Kopiuj", "btn", async () => {
    try { await navigator.clipboard.writeText(link); toast("Skopiowano link zaproszenia."); }
    catch { input.select(); toast("Nie udało się skopiować. Link jest zaznaczony.", true); }
  });
  wrap.append(input, copy);
  return wrap;
}

