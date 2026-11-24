// Signed organization history (Stage D, contract: docs/WEB-WSPOLDZIELENIE.md). Each user has an ECDSA P-256 key: the
// public half is on the server (GET/PUT /api/me/signing-key, members[].signingKey), the private half is wrapped with the
// personal key. Events are signed over their canonical JSON without `signature`; verification is cached by event_id.
import { el } from "./dom";
import { canonicalJson } from "./bridge";
import { ApiError, api, base64ToBytes, bufferSource, bytesToBase64, unwrapBytes, wrapBytes, type KeyEnvelope } from "./vaults";
import { verifyAgentSigned, verifyCert, type AgentCert } from "./agentcrypto";

// Anything signed as a whole: an organization event, or a protected project entry (browserauth.ts).
export interface Signed {
  signerUserId?: string;
  signature?: string;
  // Set only when a Claude chat signed (Ed25519 under its cert, docs/MCP.md §6); otherwise ECDSA by signerUserId.
  signerAgentId?: string;
  alg?: string;
}
// An organization event as it is signed: a TaskEvent or a record operation.
export interface SignableEvent extends Signed {
  event_id: string;
}
// Set on a bridge (MockBridge.eventSigner): fills in signerUserId and signature before the event is persisted.
export type EventSigner = (event: SignableEvent) => Promise<void>;
export interface SigningIdentity { userId: string; privateKey: CryptoKey; publicJwk: JsonWebKey }
// `agents`: the member's Claude chats from GET /api/vaults/:id (the cert's signature may come beside it).
export interface SignerAgent { agentId: string; cert: AgentCert; signature?: string; revokedAt?: number | null }
export interface SignerMember { userId: string; signingKey: JsonWebKey | null; agents?: SignerAgent[] }
// "ok" when the event may be trusted as its author's; "unverified" otherwise. Unverified events are shown, never dropped.
export interface EventCheck { status: "ok" | "unverified"; reason: string }

const ECDSA: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGN: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
interface StoredSigningKey { publicJwk: JsonWebKey; wrappedPrivate: KeyEnvelope }

// The canonical bytes an event is signed over: every field but `signature`, keys sorted at every level.
export function signedBytes(value: Signed): Uint8Array {
  const { signature: _signature, ...rest } = value;
  return new TextEncoder().encode(canonicalJson(rest));
}

/** Signs `event` as `identity`: sets signerUserId, then signature (base64 of the raw r||s ECDSA value). */
export async function signEvent(event: Signed, identity: SigningIdentity): Promise<void> {
  event.signerUserId = identity.userId;
  delete event.signature;
  const signature = await crypto.subtle.sign(SIGN, identity.privateKey, bufferSource(signedBytes(event)));
  event.signature = bytesToBase64(new Uint8Array(signature));
}

// Verification cache by event_id. An entry is reused only while the event and its signer's key are unchanged, so a
// tampered copy under the same id is checked again.
const cache = new Map<string, { canon: string; signer: string; check: EventCheck }>();

async function checkSignature(event: Signed, key: JsonWebKey): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey("jwk", key, ECDSA, false, ["verify"]);
  return crypto.subtle.verify(SIGN, publicKey, bufferSource(base64ToBytes(String(event.signature))), bufferSource(signedBytes(event)));
}

function judge(event: Signed, members: SignerMember[], requireSignature: boolean): Promise<EventCheck> | EventCheck {
  if (!event.signature) {
    return requireSignature
      ? { status: "unverified", reason: "Zdarzenie w przestrzeni organizacji nie ma podpisu. Mogło powstać bez kontroli autora." }
      : { status: "ok", reason: "Przestrzeń osobista: podpis nie jest wymagany." };
  }
  const signer = members.find((m) => m.userId === event.signerUserId);
  if (!signer) return { status: "unverified", reason: "Podpisujący nie jest członkiem tej organizacji." };
  if (!signer.signingKey) return { status: "unverified", reason: "Podpisujący nie ma klucza podpisu." };
  if (event.alg === "ed25519") return judgeAgent(event, signer, signer.signingKey);
  if (event.alg !== undefined || event.signerAgentId !== undefined) return { status: "unverified", reason: "Nieznany rodzaj podpisu." };
  return checkSignature(event, signer.signingKey).then(
    (valid): EventCheck => (valid ? { status: "ok", reason: "Podpis zgodny z kluczem członka." } : { status: "unverified", reason: "Podpis nie zgadza się z treścią zdarzenia." }),
    (): EventCheck => ({ status: "unverified", reason: "Podpis nie daje się odczytać." }),
  );
}

// A chat's signature (WEB-WSPOLDZIELENIE "Claude chats"): the cert verifies under the person's key, the chat was not
// revoked at the event's time and the cert had not expired, and the Ed25519 signature verifies under cert.signKey.
// The event's time is its `time_ms`; a value without one (a protected entry) is judged as of now.
async function judgeAgent(event: Signed & { time_ms?: unknown }, signer: SignerMember, signingKey: JsonWebKey): Promise<EventCheck> {
  const agent = signer.agents?.find((a) => a.agentId === event.signerAgentId);
  if (!agent) return { status: "unverified", reason: "Czat Claude nie jest znanym czatem podpisującego." };
  const cert: AgentCert = { ...agent.cert, signature: agent.cert?.signature ?? agent.signature };
  if (cert.agentId !== agent.agentId || cert.userId !== signer.userId || !(await verifyCert(cert, signingKey)))
    return { status: "unverified", reason: "Certyfikat czatu Claude jest nieprawidłowy." };
  const time = typeof event.time_ms === "number" && Number.isFinite(event.time_ms) ? event.time_ms : Date.now();
  if (agent.revokedAt != null && agent.revokedAt <= time) return { status: "unverified", reason: "Czat Claude został odłączony przed tym zdarzeniem." };
  if (time >= cert.expiresAt) return { status: "unverified", reason: "Certyfikat czatu Claude wygasł przed tym zdarzeniem." };
  return (await verifyAgentSigned(event, cert.signKey))
    ? { status: "ok", reason: "Podpis czatu Claude zgodny z certyfikatem." }
    : { status: "unverified", reason: "Podpis czatu Claude nie zgadza się z treścią zdarzenia." };
}

/** Checks a signed value (a protected entry) against the members' keys: the signer must be a member and the signature valid. */
export async function verifySigned(value: Signed, members: SignerMember[]): Promise<EventCheck> {
  return judge(value, members, true);
}

/**
 * Checks every event against the members' public keys. Returns a check per event_id. `requireSignature` is true in a
 * shared vault (an unsigned event is then unverified) and false in the personal one.
 */
export async function verifyEvents(events: SignableEvent[], members: SignerMember[], requireSignature: boolean): Promise<Map<string, EventCheck>> {
  const result = new Map<string, EventCheck>();
  await Promise.all(events.map(async (event) => {
    const canon = canonicalJson(event);
    // the whole member, its chats (certs, revocations) included, so a revocation is checked again
    const signer = JSON.stringify(members.find((m) => m.userId === event.signerUserId) ?? null) + (requireSignature ? "+" : "-");
    const hit = cache.get(event.event_id);
    if (hit && hit.canon === canon && hit.signer === signer) { result.set(event.event_id, hit.check); return; }
    const check = await judge(event, members, requireSignature);
    cache.set(event.event_id, { canon, signer, check });
    result.set(event.event_id, check);
  }));
  return result;
}

/** A small warning badge with the reason as its tooltip; null when the event is verified. */
export function verificationBadge(check: EventCheck | undefined): HTMLElement | null {
  if (!check || check.status === "ok") return null;
  const badge = el("span", "org-badge is-warning", "niezweryfikowane");
  badge.title = check.reason;
  badge.setAttribute("aria-label", `niezweryfikowane: ${check.reason}`);
  return badge;
}

// ---- the user's key ----------------------------------------------------------------------------------------------

async function importPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", bufferSource(pkcs8), ECDSA, false, ["sign"]);
}

async function fromStored(userId: string, stored: StoredSigningKey, personal: CryptoKey): Promise<SigningIdentity> {
  return { userId, privateKey: await importPrivate(await unwrapBytes(stored.wrappedPrivate, personal)), publicJwk: stored.publicJwk };
}

/**
 * The user's signing key, from the server or made now. Without a stored key a new pair is generated, its private half
 * wrapped with the personal key and PUT (409: another device stored one first, so that one is read). The CryptoKey is
 * kept in memory only and cannot be exported.
 */
export async function loadSigningIdentity(userId: string, personal: CryptoKey): Promise<SigningIdentity> {
  let stored: StoredSigningKey;
  try {
    stored = await api<StoredSigningKey>("/api/me/signing-key");
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const wrappedPrivate = await wrapBytes(pkcs8, personal);
    try {
      await api("/api/me/signing-key", "PUT", { publicJwk, wrappedPrivate });
      return { userId, privateKey: await importPrivate(pkcs8), publicJwk };
    } catch (put) {
      if (!(put instanceof ApiError) || put.status !== 409) throw put;
      stored = await api<StoredSigningKey>("/api/me/signing-key");
    }
  }
  return fromStored(userId, stored, personal);
}
