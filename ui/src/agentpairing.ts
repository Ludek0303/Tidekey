// Claude chats in the browser, without screens (docs/MCP.md §3.2 pairing, §3.5/§3.9 scope, §3.6 disconnect, §7.1
// proposals, §7.2 undo; wire contract: docs/WEB-WSPOLDZIELENIE.md "Claude chats"). The screens call these functions; the
// parts that need the open vault's state (protected projects, versions, Moje notatki's key) are BrowserBridge methods:
// agentProjects, projectsOfChat, grantProjectToChat, revokeProjectsFromChats, rotatePersonalKey, chatVersions.
//
// Decisions beyond the contract:
// - A pairing link is checked (checkPairingLink) before it is finished; finishPairing takes only a link checked in this
//   tab and fetches the claim once more.
// - Write modes and the session are cut to the policy: the narrowest mode of a space, the longest allowed session of
//   {1, 4, 8, 24} hours not above every chosen space's maximum. A viewer's chat is read-only ("none").
// - Proposals: `append` and `tasks` carry the text to add at the end, `edit` the note's whole new text, `move` the new
//   path in `to`. A proposal with a stale change or a permission mark is never applied in part: the stale one waits for
//   a refresh, the one with marks is rejected on the server at once.
// - "Cofnij zmiany czatu": a note the chat created (kept as an empty version) goes to the trash.
import * as Y from "yjs";
import type { BrowserBridge } from "./browserauth";
import type { TreeListing } from "./bridge";
import { checkCode, fromB64u, newAgentId, normalizeCode, sealForAgent, sealScope, signCert, validCode, verifyCert, type AgentCert, type WriteMode } from "./agentcrypto";
import { openProposal, textHash, type ProposalBody, type ProposalChange } from "./proposals";
import { MARKS_TEXT, touchesPermissionMarks } from "./permissionmarks";
import {
  ORG_AGENT_POLICY, PERSONAL_AGENT_POLICY, cancelAgentPairing, confirmAgentSession, createAgent, decideVaultProposal, deleteAgent,
  deleteAllAgents, fetchAgentPairing, fetchPersonalKeys, fetchVault, isSharedVaultId, listMyAgents, listSharedVaults,
  listVaultProposals, openAccess, ownVaults, personalVaultId, renewAgentSession, startAgentPairing, unwrapBytes, unwrapPersonalVaultKey, updateAgentScope, wrapBytes,
  type AgentKeyIn, type AgentRow, type AgentScopeIn,
} from "./vaults";

export type { AgentRow } from "./vaults";
export interface PairingStart { pairingId: string; code: string; expiresAt: number }
export interface PairingLink { pairToken: string; signKey: string; boxKey: string; code: string }
export interface PairingCheck { ok: boolean; reason: string | null; device: { name: string; os: string } | null; mcpVersion: string; claimIp: string; myIp: string; otherNetwork: boolean; checkCode: string }
export interface SpaceChoice { vaultId: string; include: string[]; exclude: string[]; projects: string[]; writeMode: WriteMode; tools: string[]; tasks: "mine" | "all" }
// hint: why the protected projects list is empty (the organization does not allow them, or the vault is not open here).
export interface SpaceOption { vaultId: string; name: string; kind: string; disabledReason: string | null; maxWriteMode: WriteMode; maxHours: number; allowProtected: boolean; projects: string[]; folders: string[]; hint?: string | null }
export interface ProposalView { proposalId: string; agentId: string; createdAt: number; state: string; body: ProposalBody | null; problem: string | null; stale: boolean[] }

export const NOT_STARTED_TEXT = "Nie rozpocząłeś parowania. Jeśli ktoś przysłał Ci ten link, zamknij stronę i nic nie klikaj.";
export const SWAPPED_TEXT = "Klucze z linku różnią się od zgłoszonych na serwerze. Ktoś mógł je podmienić. Parowanie przerwano.";
export const EXPIRED_TEXT = "Kod parowania wygasł. Rozpocznij parowanie od nowa.";
export const NO_SPACE_TEXT = "Wybierz co najmniej jedną przestrzeń.";
export const MIGRATE_TEXT = "Najpierw trzeba przenieść Moje notatki na osobny klucz";
export const STALE_TEXT = "Propozycja jest nieaktualna: notatka zmieniła się od jej utworzenia. Odśwież ją.";
const NOT_CLAIMED_TEXT = "Parowanie nie czeka na potwierdzenie. Rozpocznij je od nowa.";
const DISABLED_TEXT = "Właściciel tej organizacji nie włączył czatów Claude.";
const MODES: WriteMode[] = ["none", "proposals", "append", "direct"];
const MODE_LABEL: Record<WriteMode, string> = { none: "tylko odczyt", proposals: "propozycje", append: "dopisywanie", direct: "zmiany bezpośrednie" };
const SESSION_HOURS = [24, 8, 4, 1];
const CERT_DAYS = 90;
const narrower = (a: WriteMode, b: WriteMode): WriteMode => MODES[Math.min(MODES.indexOf(a), MODES.indexOf(b))] ?? "none";

// ---- the pairing in progress (§3.2 pkt 1, 4): this tab's sessionStorage, or another tab of this browser ----------

const STORE = "notes.agentPairing.v1";
const CHANNEL = "notes-agent-pairing";
let heard: PairingStart | null = null;
let channel: BroadcastChannel | null = null;
const validStart = (p: unknown): p is PairingStart => !!p && typeof (p as PairingStart).pairingId === "string" && typeof (p as PairingStart).code === "string" && Number.isFinite((p as PairingStart).expiresAt);
function stored(): PairingStart | null {
  try { const p = JSON.parse(sessionStorage.getItem(STORE) ?? "null") as unknown; return validStart(p) ? p : null; } catch { return null; }
}
// Other tabs of this browser (same origin only) answer "ask" with the pairing this tab started.
function bus(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(CHANNEL);
  (channel as unknown as { unref?: () => void }).unref?.();
  channel.onmessage = (event: MessageEvent) => {
    const m = event.data as { type?: string; pairing?: unknown; pairingId?: string } | null;
    if (m?.type === "ask") { const own = stored(); if (own) channel?.postMessage({ type: "pairing", pairing: own }); }
    else if (m?.type === "pairing" && validStart(m.pairing)) heard = m.pairing;
    // another tab finished or stopped it: this tab forgets it too (its own copy included)
    else if (m?.type === "clear" && typeof m.pairingId === "string") forget(m.pairingId, false);
  };
  channel.postMessage({ type: "ask" });
  return channel;
}
function forget(pairingId?: string, tell = true): void {
  const own = stored();
  if (own && (!pairingId || own.pairingId === pairingId)) { try { sessionStorage.removeItem(STORE); } catch { /* not kept */ } }
  if (heard && (!pairingId || heard.pairingId === pairingId)) heard = null;
  if (pairingId && tell) bus()?.postMessage({ type: "clear", pairingId });
}
// The pairing of this tab, else asks the other tabs and waits a moment for an answer.
async function anyPairing(): Promise<PairingStart | null> {
  const ch = bus();
  if (stored() || heard || !ch) return stored() ?? heard;
  ch.postMessage({ type: "ask" });
  for (let i = 0; i < 10 && !heard; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  return heard;
}

/** Starts a pairing (§3.2 pkt 1): the code is kept in this tab only and announced to the other tabs of this browser. */
export async function startPairing(): Promise<PairingStart> {
  const { pairingId, code, expiresAt } = await startAgentPairing();
  const start: PairingStart = { pairingId, code, expiresAt };
  try { sessionStorage.setItem(STORE, JSON.stringify(start)); } catch { /* the tab keeps it in memory only */ heard = start; }
  bus()?.postMessage({ type: "pairing", pairing: start });
  return start;
}
/** The pairing started in this tab or another tab of this browser; null when none or expired. */
export function pendingPairing(): PairingStart | null {
  bus();
  const p = stored() ?? heard;
  return p && p.expiresAt > Date.now() ? p : null;
}
export async function cancelPairing(): Promise<void> {
  const p = stored() ?? heard;
  if (!p) return;
  try { await cancelAgentPairing(p.pairingId); } finally { forget(p.pairingId); }
}

const key32 = (text: string | undefined): boolean => { try { return !!text && fromB64u(text).length === 32; } catch { return false; } };
/** The link the MCP opens: ?pair-agent=<token>#a=<signKey.boxKey>&c=<code>. The address is cleared in every case. */
export function readPairingLink(href: string): PairingLink | null {
  try {
    const url = new URL(href);
    const pairToken = url.searchParams.get("pair-agent") ?? "";
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const [signKey, boxKey, extra] = (fragment.get("a") ?? "").split(".");
    const code = normalizeCode(fragment.get("c") ?? "");
    if (!/^[0-9a-f]{64}$/.test(pairToken) || extra !== undefined || !validCode(code) || !key32(signKey) || !key32(boxKey)) return null;
    return { pairToken, signKey, boxKey, code };
  } catch { return null; }
  finally { history.replaceState(null, "", location.pathname); }
}

// The link this tab checked last; finishPairing takes no other.
let checked: { pairingId: string; link: PairingLink } | null = null;
const refused = (reason: string): PairingCheck => ({ ok: false, reason, device: null, mcpVersion: "", claimIp: "", myIp: "", otherNetwork: false, checkCode: "" });

/**
 * §3.2 pkt 4–5: the link is taken only for a pairing started in this browser with the same code, and only when its keys
 * are exactly the claimed ones. Otherwise the started pairing (if any) is cancelled on the server and the reason is given.
 */
export async function checkPairingLink(link: PairingLink): Promise<PairingCheck> {
  checked = null;
  const pairing = await anyPairing();
  const stop = async (reason: string): Promise<PairingCheck> => {
    if (pairing) { await cancelAgentPairing(pairing.pairingId).catch(() => undefined); forget(pairing.pairingId); }
    return refused(reason);
  };
  if (!pairing || normalizeCode(pairing.code) !== normalizeCode(link.code)) return stop(NOT_STARTED_TEXT);
  if (pairing.expiresAt <= Date.now()) return stop(EXPIRED_TEXT);
  const state = await fetchAgentPairing(pairing.pairingId);
  if (state.state === "expired") return stop(EXPIRED_TEXT);
  if (state.state !== "claimed" || !state.claim) return stop(NOT_CLAIMED_TEXT);
  if (state.claim.signKey !== link.signKey || state.claim.boxKey !== link.boxKey) return stop(SWAPPED_TEXT);
  checked = { pairingId: pairing.pairingId, link };
  return {
    ok: true, reason: null, device: state.claim.device, mcpVersion: state.claim.mcpVersion, claimIp: state.claim.ip, myIp: state.requestIp,
    otherNetwork: state.claim.ip !== state.requestIp, checkCode: await checkCode(link.signKey, link.boxKey, link.code),
  };
}

// ---- spaces and scope (§3.5, §3.9, §16) ------------------------------------------------------------------------------

/** Every space this person may give a chat, with the organization's limits; the open vault's folders and projects. */
export async function spaceOptions(bridge: BrowserBridge): Promise<SpaceOption[]> {
  const open = bridge.vault.id;
  const tree = await bridge.call<TreeListing>("list_tree").catch(() => null);
  const folders = tree?.folders ?? [];
  const personalId = personalVaultId(bridge.user.id);
  // ownVaults: no Moje notatki to give a chat without the server admin's consent
  const options: SpaceOption[] = [];
  for (const own of ownVaults(bridge.user)) {
    const epochs = (await fetchPersonalKeys().catch(() => [])).map((r) => r.keyEpoch);
    const personalEpoch = Math.max(1, ...epochs, open === personalId ? bridge.vaultEpoch : 1);
    options.push({
      vaultId: own.id, name: own.name, kind: own.kind, disabledReason: personalEpoch < 2 ? MIGRATE_TEXT : null,
      maxWriteMode: PERSONAL_AGENT_POLICY.maxWriteMode, maxHours: PERSONAL_AGENT_POLICY.maxHours, allowProtected: true,
      projects: [], folders: open === personalId ? folders : [], hint: null,
    });
  }
  for (const row of await listSharedVaults()) {
    const base = { vaultId: row.id, name: row.name, kind: row.kind, projects: [] as string[], folders: row.id === open ? folders : [] };
    try {
      const detail = await fetchVault(row.id);
      const policy = detail.agentPolicy ?? ORG_AGENT_POLICY;
      const isOpen = row.id === open;
      options.push({
        ...base, disabledReason: policy.enabled ? null : DISABLED_TEXT,
        maxWriteMode: detail.role === "viewer" ? "none" : policy.maxWriteMode, maxHours: policy.maxHours, allowProtected: policy.allowProtected,
        projects: isOpen && policy.allowProtected ? bridge.agentProjects() : [],
        hint: !policy.allowProtected ? "Organizacja nie pozwala czatom widzieć chronionych projektów." : isOpen ? null : "Chronione projekty wybierzesz po otwarciu tej organizacji.",
      });
    } catch {
      options.push({ ...base, disabledReason: "Nie udało się sprawdzić tej organizacji. Spróbuj ponownie.", maxWriteMode: "none", maxHours: 1, allowProtected: false, hint: null });
    }
  }
  return options;
}

// The choices cut to the options: known and enabled spaces only, each once, the mode and projects within the limits.
function fitChoices(choices: SpaceChoice[], options: SpaceOption[]): { choice: SpaceChoice; option: SpaceOption }[] {
  if (!choices.length) throw new Error(NO_SPACE_TEXT);
  const out: { choice: SpaceChoice; option: SpaceOption }[] = [];
  for (const choice of choices) {
    const option = options.find((o) => o.vaultId === choice.vaultId);
    if (!option) throw new Error("Nie masz dostępu do jednej z wybranych przestrzeni.");
    if (option.disabledReason) throw new Error(option.disabledReason);
    if (out.some((x) => x.choice.vaultId === choice.vaultId)) continue;
    out.push({ option, choice: {
      ...choice, writeMode: narrower(MODES.includes(choice.writeMode) ? choice.writeMode : "none", option.maxWriteMode),
      projects: option.allowProtected ? choice.projects.filter((p) => option.projects.includes(p)) : [],
    } });
  }
  return out;
}
const fitHours = (hours: number, options: SpaceOption[]): number => SESSION_HOURS.find((h) => h <= Math.min(hours, ...options.map((o) => o.maxHours))) ?? 1;

// The current key of a space, raw, with its epoch: Moje notatki from the server's newest key of their own, the open vault
// from the bridge, another organization from this member's wrapped key.
async function spaceKey(bridge: BrowserBridge, vaultId: string): Promise<{ raw: Uint8Array; keyEpoch: number }> {
  if (vaultId === personalVaultId(bridge.user.id)) {
    const top = (await fetchPersonalKeys()).sort((a, b) => b.keyEpoch - a.keyEpoch)[0];
    if (!top || top.keyEpoch < 2) throw new Error(MIGRATE_TEXT);
    return { raw: await unwrapPersonalVaultKey(top.wrappedKey, bridge.personalKey, bridge.user.id, top.keyEpoch), keyEpoch: top.keyEpoch };
  }
  if (vaultId === bridge.vault.id && isSharedVaultId(vaultId) && bridge.vaultKey) return { raw: bridge.vaultKey, keyEpoch: bridge.vaultEpoch };
  const access = await openAccess(vaultId, bridge.user.id, bridge.personalKey, bridge.boxIdentity ?? undefined);
  if (!access.rawKey) throw new Error("Brak klucza tej przestrzeni.");
  return { raw: access.rawKey, keyEpoch: access.keyEpoch };
}

// The signed cert (signature beside it, as the server keeps it), the sealed keys of `withKeys` and every space's scope.
async function scopeBody(bridge: BrowserBridge, cert: AgentCert, fitted: { choice: SpaceChoice }[], withKeys: string[]): Promise<{ cert: AgentCert; signature: string; keys: AgentKeyIn[]; scopes: AgentScopeIn[] }> {
  const identity = bridge.signingIdentity;
  if (!identity) throw new Error("Brak klucza podpisu na tym urządzeniu.");
  const { signature, ...signed } = await signCert(cert, identity);
  const keys: AgentKeyIn[] = [];
  for (const vaultId of withKeys) {
    const { raw, keyEpoch } = await spaceKey(bridge, vaultId);
    keys.push({ vaultId, keyEpoch, sealedKey: await sealForAgent(raw, cert.boxKey, vaultId, "vault", keyEpoch) });
  }
  const updatedAt = Date.now();
  const scopes = await Promise.all(fitted.map(async ({ choice }) => ({
    vaultId: choice.vaultId,
    ownScope: await wrapBytes(new TextEncoder().encode(JSON.stringify(ownOf(choice))), bridge.personalKey, ownAad(cert.agentId, choice.vaultId)),
    sealedScope: await sealScope({ schema: "notes-agent-scope-v1", agentId: cert.agentId, vaultId: choice.vaultId, include: choice.include, exclude: choice.exclude, tools: choice.tools, tasks: choice.tasks, updatedAt }, identity, cert.boxKey),
  })));
  return { cert: signed as AgentCert, signature: signature!, keys, scopes };
}
// The person's own copy of a scope (the chat's copy is sealed to the chat): the scope screen starts from it, so a change
// never widens what the person does not see (docs/WEB-WSPOLDZIELENIE.md, GET /api/me/agents).
type OwnScope = Pick<SpaceChoice, "include" | "exclude" | "tools" | "tasks">;
const ownOf = (c: SpaceChoice): OwnScope => ({ include: c.include, exclude: c.exclude, tools: c.tools, tasks: c.tasks });
const ownAad = (agentId: string, vaultId: string): Uint8Array => new TextEncoder().encode(`notes-agent-own-scope-v1\0${agentId}\0${vaultId}`);
/** The scope in force of each space of a chat, from the person's own copies; a space whose copy cannot be read is left out
 *  (its switch then starts off: the screen never assumes a wider scope). */
export async function ownChoices(bridge: BrowserBridge, agent: AgentRow): Promise<SpaceChoice[]> {
  const out: SpaceChoice[] = [];
  for (const v of agent.cert.vaults) {
    const row = agent.scopes?.find((x) => x.vaultId === v.vaultId);
    if (!row) continue;
    try {
      const own = JSON.parse(new TextDecoder().decode(await unwrapBytes(row.ownScope, bridge.personalKey, ownAad(agent.agentId, v.vaultId)))) as OwnScope;
      if (!Array.isArray(own.include) || !Array.isArray(own.exclude) || !Array.isArray(own.tools) || (own.tasks !== "mine" && own.tasks !== "all")) continue;
      out.push({ vaultId: v.vaultId, ...own, writeMode: v.writeMode, projects: v.vaultId === bridge.vault.id ? bridge.projectsOfChat(agent.agentId) : [] });
    } catch { /* unreadable: left out */ }
  }
  return out;
}
const certVaults = (fitted: { choice: SpaceChoice }[]): AgentCert["vaults"] => fitted.map(({ choice }) => ({ vaultId: choice.vaultId, whole: true, parts: [], writeMode: choice.writeMode }));

/**
 * §3.2 pkt 6–7: signs the chat's cert, seals each chosen space's key and scope to the chat, posts it, then seals the
 * chosen protected projects of the open vault to it (entries signed by this person). Returns the chat's id.
 */
export async function finishPairing(bridge: BrowserBridge, link: PairingLink, choices: SpaceChoice[], sessionHours: number): Promise<string> {
  if (!choices.length) throw new Error(NO_SPACE_TEXT);
  if (!checked || checked.link.pairToken !== link.pairToken || checked.link.signKey !== link.signKey || checked.link.boxKey !== link.boxKey || checked.link.code !== link.code)
    throw new Error("Najpierw sprawdź link parowania.");
  const { pairingId } = checked;
  const state = await fetchAgentPairing(pairingId);
  // the code ran out while the scope was being chosen
  if (state.state === "expired") { checked = null; forget(pairingId); throw new Error(EXPIRED_TEXT); }
  if (state.state !== "claimed" || state.claim?.signKey !== link.signKey || state.claim?.boxKey !== link.boxKey) throw new Error(NOT_CLAIMED_TEXT);
  const fitted = fitChoices(choices, await spaceOptions(bridge));
  const now = Date.now();
  const cert: AgentCert = {
    schema: "notes-agent-cert-v1", agentId: newAgentId(), userId: bridge.user.id, signKey: link.signKey, boxKey: link.boxKey,
    vaults: certVaults(fitted), createdAt: now, expiresAt: now + CERT_DAYS * 86_400_000,
  };
  const body = await scopeBody(bridge, cert, fitted, fitted.map(({ choice }) => choice.vaultId));
  const { agentId } = await createAgent({ pairingId, ...body, sessionHours: fitHours(sessionHours, fitted.map((f) => f.option)) });
  checked = null;
  forget(pairingId);
  for (const project of fitted.find(({ choice }) => choice.vaultId === bridge.vault.id)?.choice.projects ?? []) await bridge.grantProjectToChat(project, agentId, link.boxKey);
  return agentId;
}

/** „Ten czat widzi: Moje notatki (całe, tylko odczyt); Klub: Spotkania/, Zadania/ (propozycje)”. */
export function summaryText(choices: SpaceChoice[], options: SpaceOption[]): string {
  const parts = choices.map((c) => {
    const name = options.find((o) => o.vaultId === c.vaultId)?.name ?? "przestrzeń";
    const folder = (p: string) => (p.endsWith(".md") || p.endsWith("/") ? p : `${p}/`);
    const whole = c.include.length === 0;
    const details = [whole ? "całe" : null, c.projects.length ? `chronione: ${c.projects.map(folder).join(", ")}` : null, MODE_LABEL[c.writeMode] ?? MODE_LABEL.none];
    return `${name}${whole ? "" : `: ${c.include.map(folder).join(", ")}`} (${details.filter(Boolean).join(", ")})`;
  });
  return parts.length ? `Ten czat widzi: ${parts.join("; ")}` : "Ten czat nic nie widzi.";
}

// ---- the person's chats (§5.3–§5.5) ----------------------------------------------------------------------------------

export const listAgents = (): Promise<AgentRow[]> => listMyAgents();
export const renewAgent = (id: string, hours: number): Promise<number> => renewAgentSession(id, hours);
export async function confirmAgent(id: string): Promise<void> { await confirmAgentSession(id); }

// After chats are disconnected: Moje notatki get a new key when one of them had them (shared vaults: the server marks
// them for rotation, an admin rotates), and the open vault's protected projects a new key without them.
async function afterDisconnect(bridge: BrowserBridge, agents: AgentRow[]): Promise<void> {
  const ids = agents.map((a) => a.agentId);
  if (agents.some((a) => a.cert?.vaults?.some((v) => v.vaultId === personalVaultId(bridge.user.id)))) await bridge.rotatePersonalKey(ids);
  const projects = [...new Set(ids.flatMap((id) => bridge.projectsOfChat(id)))];
  if (projects.length) await bridge.revokeProjectsFromChats(projects, ids);
}
export async function disconnectAgent(bridge: BrowserBridge, id: string): Promise<void> {
  const agent = (await listMyAgents()).find((a) => a.agentId === id);
  await deleteAgent(id);
  await afterDisconnect(bridge, agent ? [agent] : []);
}
export async function disconnectAll(bridge: BrowserBridge): Promise<void> {
  const agents = (await listMyAgents()).filter((a) => a.revokedAt == null);
  await deleteAllAgents();
  await afterDisconnect(bridge, agents);
}

/**
 * A new scope for a chat (§3.5): a new cert with the same chat keys and lifetime, keys for the added spaces, every scope
 * sealed again. A dropped space gets a new key (Moje notatki here; shared ones: the server marks them for rotation),
 * and so does a protected project taken out of the scope.
 */
export async function updateScope(bridge: BrowserBridge, id: string, choices: SpaceChoice[]): Promise<void> {
  const fitted = fitChoices(choices, await spaceOptions(bridge));
  const agent = (await listMyAgents()).find((a) => a.agentId === id && a.revokedAt == null);
  if (!agent) throw new Error("Nie ma takiego czatu.");
  const identity = bridge.signingIdentity;
  const old: AgentCert = { ...agent.cert, signature: agent.cert.signature ?? agent.signature };
  // the chat's keys come from the cert this person signed, never from the server's word alone
  if (!identity || old.agentId !== id || old.userId !== bridge.user.id || !(await verifyCert(old, identity.publicJwk))) throw new Error("Certyfikat tego czatu jest nieprawidłowy. Odłącz go i sparuj od nowa.");
  const before = old.vaults.map((v) => v.vaultId);
  const cert: AgentCert = { schema: "notes-agent-cert-v1", agentId: id, userId: bridge.user.id, signKey: old.signKey, boxKey: old.boxKey, vaults: certVaults(fitted), createdAt: old.createdAt, expiresAt: old.expiresAt };
  const added = fitted.map(({ choice }) => choice.vaultId).filter((v) => !before.includes(v));
  await updateAgentScope(id, await scopeBody(bridge, cert, fitted, added));
  const personal = personalVaultId(bridge.user.id);
  if (before.includes(personal) && !cert.vaults.some((v) => v.vaultId === personal)) await bridge.rotatePersonalKey([id]);
  const wanted = fitted.find(({ choice }) => choice.vaultId === bridge.vault.id)?.choice.projects ?? [];
  const current = bridge.projectsOfChat(id);
  const dropped = current.filter((p) => !wanted.includes(p));
  if (dropped.length) await bridge.revokeProjectsFromChats(dropped, [id]);
  for (const project of wanted.filter((p) => !current.includes(p))) await bridge.grantProjectToChat(project, id, old.boxKey);
}

// ---- proposals (§7.1) ------------------------------------------------------------------------------------------------

const BAD_PROPOSAL = "Propozycja jest uszkodzona lub podrobiona.";
export const REVOKED_TEXT = "Czat Claude, który ją utworzył, został odłączony.";
export const DETACHED_TEXT = "Czat Claude, który ją utworzył, nie ma już dostępu do tej przestrzeni.";
// An admin takes one organization out of a chat: its scope row for that vault goes, the chat stays (and its cert too).
const detached = (agent: AgentRow, vaultId: string): boolean => Array.isArray(agent.scopes) && !agent.scopes.some((x) => x.vaultId === vaultId);
export const TWICE_TEXT = "Propozycja zmienia jedną notatkę kilka razy. Odrzuć ją i poproś Claude o nową.";
// Each change is checked against the note as it is now, so two changes of one note (or one path) would apply over each
// other: such a proposal is refused whole (the MCP sends one change per proposal).
function twice(changes: ProposalChange[]): boolean {
  const keys = changes.map((c) => (c.op === "create" ? `path:${c.path.toLowerCase()}` : `id:${c.noteId}`));
  return new Set(keys).size !== keys.length;
}
// Stale: the note is gone, moved, or its text is not the one the chat saw; a new note's path or a move's target is taken.
async function staleChanges(bridge: BrowserBridge, changes: ProposalChange[]): Promise<boolean[]> {
  const tree = await bridge.call<TreeListing>("list_tree");
  const taken = (path: string, self = ""): boolean => tree.notes.some((n) => n.id !== self && n.path.toLowerCase() === path.toLowerCase());
  return Promise.all(changes.map(async (c) => {
    if (c.op === "create") return c.baseHash !== "" || taken(c.path);
    const note = tree.notes.find((n) => n.id === c.noteId);
    if (!note || note.path !== c.path) return true;
    if (c.op === "move" && (typeof c.to !== "string" || taken(c.to, c.noteId))) return true;
    return (await textHash(await bridge.call<string>("note_text", { id: c.noteId }))) !== c.baseHash;
  }));
}

/** How many proposals of this person's chats wait in the open vault: counted from the list, nothing is opened. */
export async function openProposalCount(bridge: BrowserBridge): Promise<number> {
  return (await listVaultProposals(bridge.vault.id)).filter((r) => r.state === "open").length;
}

/** The open vault's proposals of this person's chats, opened with this person's box key and checked against the chat's cert. */
export async function listProposals(bridge: BrowserBridge): Promise<ProposalView[]> {
  const vaultId = bridge.vault.id;
  const [rows, agents] = await Promise.all([listVaultProposals(vaultId), listMyAgents()]);
  const identity = bridge.signingIdentity;
  const box = bridge.boxIdentity;
  const views: ProposalView[] = [];
  for (const row of rows) {
    const view: ProposalView = { proposalId: row.proposalId, agentId: row.agentId, createdAt: row.createdAt, state: row.state, body: null, problem: null, stale: [] };
    const agent = agents.find((a) => a.agentId === row.agentId);
    const cert = agent && { ...agent.cert, signature: agent.cert.signature ?? agent.signature };
    if (!agent || !cert || !identity || !box) view.problem = "Nie można sprawdzić tej propozycji na tym urządzeniu.";
    else if (agent.revokedAt != null) view.problem = REVOKED_TEXT;
    else if (detached(agent, vaultId)) view.problem = DETACHED_TEXT;
    else if (cert.agentId !== row.agentId || cert.userId !== bridge.user.id || !cert.vaults?.some((v) => v.vaultId === vaultId) || !(await verifyCert(cert, identity.publicJwk))) view.problem = BAD_PROPOSAL;
    else if (row.proposal?.proposalId !== row.proposalId) view.problem = BAD_PROPOSAL;
    else {
      try { view.body = await openProposal(row.proposal, { vaultId, boxPrivateKey: box.privateKey, agentSignKey: cert.signKey, agentId: row.agentId, userId: bridge.user.id }); }
      catch (e) { view.problem = e instanceof Error ? e.message : BAD_PROPOSAL; }
      if (view.body && twice(view.body.changes)) view.problem = TWICE_TEXT;
    }
    if (view.body) view.stale = await staleChanges(bridge, view.body.changes);
    views.push(view);
  }
  return views;
}

// The note's text replaced by `text` with this person's client: only the changed middle is rewritten, so a concurrent
// edit elsewhere in the note survives.
async function setText(bridge: BrowserBridge, id: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await bridge.call<Uint8Array>("open_note", { id }));
  const content = doc.getText("content");
  const old = content.toString();
  if (old === text) return;
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  let end = 0;
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => { content.delete(start, old.length - start - end); content.insert(start, text.slice(start, text.length - end)); });
  await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, vector) });
}
// `append` and `tasks` carry the text added at the end (mcp/src/write.ts), `edit` and `create` the whole new text.
const newText = (c: ProposalChange, before: string): string =>
  c.op === "append" || c.op === "tasks" ? before + (c.text ?? "") : c.op === "edit" || c.op === "create" ? c.text ?? "" : before;
// Moving or trashing a note that holds permission marks (a project note) changes who sees what: refused like a mark change.
const touchesMarks = (c: ProposalChange, before: string): boolean =>
  c.op === "move" || c.op === "trash" ? touchesPermissionMarks(before, "") : touchesPermissionMarks(before, newText(c, before));

/**
 * Approves (all changes, or `selected`) or rejects a proposal. Approval applies it with this person's own client, then
 * tells the server. A stale change stops it (refresh first); a change of a permission mark rejects it at once.
 */
export async function decideProposal(bridge: BrowserBridge, view: ProposalView, approve: boolean, selected?: number[]): Promise<void> {
  const vaultId = bridge.vault.id;
  if (!approve) { await decideVaultProposal(vaultId, view.proposalId, "rejected"); return; }
  if (view.problem || !view.body) throw new Error(view.problem ?? BAD_PROPOSAL);
  const changes = (selected ?? view.body.changes.map((_, i) => i)).map((i) => view.body!.changes[i]).filter(Boolean);
  if (!changes.length) throw new Error("Zaznacz co najmniej jedną zmianę.");
  if (twice(changes)) throw new Error(TWICE_TEXT);
  // the chat may have been disconnected since the list was shown (here, on another device), or an admin took this
  // organization out of it
  const agent = (await listMyAgents()).find((a) => a.agentId === view.agentId);
  if (!agent || agent.revokedAt != null) throw new Error(REVOKED_TEXT);
  if (detached(agent, vaultId)) throw new Error(DETACHED_TEXT);
  if ((await staleChanges(bridge, changes)).some(Boolean)) throw new Error(STALE_TEXT);
  const befores = await Promise.all(changes.map((c) => (c.op === "create" ? "" : bridge.call<string>("note_text", { id: c.noteId }))));
  if (changes.some((c, i) => touchesMarks(c, befores[i]))) {
    await decideVaultProposal(vaultId, view.proposalId, "rejected");
    throw new Error(MARKS_TEXT);
  }
  for (const [i, c] of changes.entries()) {
    if (c.op === "create") await setText(bridge, await bridge.call<string>("create_note", { path: c.path }), newText(c, ""));
    else if (c.op === "move") await bridge.call("rename", { id: c.noteId, path: c.to });
    else if (c.op === "trash") await bridge.call("delete", { id: c.noteId });
    else await setText(bridge, c.noteId, newText(c, befores[i]));
  }
  await decideVaultProposal(vaultId, view.proposalId, "approved");
}

// ---- "Cofnij zmiany czatu" (§7.2) ------------------------------------------------------------------------------------

/** The notes a chat changed since `sinceMs` in the open vault, from the versions kept before its revisions. */
export async function agentChanges(bridge: BrowserBridge, agentId: string, sinceMs: number): Promise<{ noteId: string; path: string; at: number }[]> {
  return (await bridge.chatVersions(agentId, sinceMs)).map(({ noteId, path, at }) => ({ noteId, path, at }));
}

// The chat's change of a note taken out of a text a person changed since: the chat's changed middle (common prefix and
// suffix of `before` and `after` cut off) is put back where it is found, once and only once; null when it is not.
function takeBack(before: string, after: string, current: string): string | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const was = before.slice(start, before.length - end), made = after.slice(start, after.length - end);
  const at = made ? current.indexOf(made) : -1;
  if (at < 0 || current.indexOf(made, at + 1) >= 0) return null;
  return current.slice(0, at) + was + current.slice(at + made.length);
}

/**
 * Puts every note the chat changed since `sinceMs` back to its text before the chat's first change in that window, as a
 * new change of this person (§7.2). A note a person changed after the chat keeps that change: the chat's part is taken
 * out of it when it can be found exactly, otherwise the note is left as it is and listed in `conflicts` (its versions
 * stay in the history). Returns how many notes were put back.
 */
export async function undoAgentChanges(bridge: BrowserBridge, agentId: string, sinceMs: number): Promise<{ notes: number; conflicts: string[] }> {
  const byNote = new Map<string, Awaited<ReturnType<BrowserBridge["chatVersions"]>>>();
  for (const v of await bridge.chatVersions(agentId, sinceMs)) {
    const list = byNote.get(v.noteId) ?? [];
    // the same revision kept by another device too: once
    if (!list.some((x) => x.text === v.text && x.after === v.after)) list.push(v);
    byNote.set(v.noteId, list);
  }
  let notes = 0;
  const conflicts: string[] = [];
  for (const [id, list] of byNote) {
    const first = list[0], last = list[list.length - 1];
    // made by the chat: no path was kept before its first revision
    const made = first.text === "" && first.from === null;
    // a person's change (of the text or the path) between two of the chat's revisions breaks the chain: not overwritten
    const chained = list.every((v, i) => i === 0 || (list[i - 1].after === v.text && (list[i - 1].to === null || v.from === null || list[i - 1].to === v.from)));
    try {
      if (!chained) { conflicts.push(last.path); continue; }
      if (!bridge.hasNote(id)) {
        // deleted by the chat (its last revision): back from the trash; deleted by a person after it: left alone
        if (made) continue; // made by the chat and gone already
        if (last.after !== null) { conflicts.push(last.path); continue; }
        await bridge.call("restore_note", { id });
        await bridge.call("restore_version", { id, vid: first.vid });
      } else if (made) {
        // a note the chat made leaves for the trash, unless a person wrote in it since
        if (last.after === null || (await bridge.call<string>("note_text", { id })) !== last.after) { conflicts.push(last.path); continue; }
        await bridge.call("delete", { id });
        notes++;
        continue;
      } else {
        const current = await bridge.call<string>("note_text", { id });
        if (last.after === null) { conflicts.push(last.path); continue; }
        if (current === last.after) await bridge.call("restore_version", { id, vid: first.vid });
        else {
          const text = takeBack(first.text, last.after, current);
          if (text === null) { conflicts.push(last.path); continue; }
          await setText(bridge, id, text);
        }
      }
      bridge.markChatUndone(id, agentId);
      notes++;
      // a note the chat moved goes back, when nobody moved it since and the old path is free
      const before = first.from, after = last.to ?? last.from;
      if (before && after && before !== after) {
        const tree = await bridge.call<TreeListing>("list_tree");
        const now = tree.notes.find((n) => n.id === id)?.path;
        const taken = tree.notes.some((n) => n.id !== id && n.path.toLowerCase() === before.toLowerCase());
        if (now !== after || taken) conflicts.push(now ?? last.path);
        else await bridge.call("rename", { id, path: before });
      }
    } catch {
      conflicts.push(last.path);
    }
  }
  return { notes, conflicts };
}
