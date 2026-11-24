// Cryptography of Claude chats (MCP), shared by the browser and the MCP server in Node 22, so nothing here touches the
// DOM. Wire contract: docs/WEB-WSPOLDZIELENIE.md "Claude chats"; design: docs/MCP.md §3.2, §3.5, §5.2, §6.
// libsodium (Ed25519, X25519 sealed boxes, BLAKE2b) is loaded on first use, so the main bundle does not carry it.
import { signEvent, signedBytes, verifySigned, type Signed, type SigningIdentity } from "./signing";
import { fromBase64Url, toBase64Url } from "./vaults";

type Sodium = typeof import("libsodium-wrappers").default;
let sodiumLoaded: Promise<Sodium> | null = null;
function sodium(): Promise<Sodium> {
  sodiumLoaded ??= import("libsodium-wrappers").then(async (m) => { await m.default.ready; return m.default; })
    .catch((error) => { sodiumLoaded = null; throw error; });
  return sodiumLoaded;
}

export type WriteMode = "none" | "proposals" | "append" | "direct";
const WRITE_MODES: readonly string[] = ["none", "proposals", "append", "direct"];
/** A chat's keys. Public halves are b64u of 32 bytes; the secrets stay on the chat's computer. */
export interface AgentKeyPair { signKey: string; signSecret: Uint8Array; boxKey: string; boxSecret: Uint8Array }

// Copied into this realm: libsodium refuses a Uint8Array of another realm (jsdom's TextEncoder gives one).
const own = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);
const utf8 = (text: string): Uint8Array => own(new TextEncoder().encode(text));
const HEX32 = /^[0-9a-f]{32}$/;
const randomHex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export const b64u = (bytes: Uint8Array): string => toBase64Url(bytes);
export const fromB64u = (text: string): Uint8Array => fromBase64Url(text);
// A public chat key as it travels: b64u of exactly 32 bytes.
function publicKey(text: string): Uint8Array {
  const bytes = own(fromB64u(text));
  if (bytes.length !== 32) throw new Error("Nieprawidłowy klucz czatu.");
  return bytes;
}

/** H(x): BLAKE2b-256, lowercase hex. */
export async function blake2bHex(bytes: Uint8Array): Promise<string> {
  const s = await sodium();
  return s.to_hex(s.crypto_generichash(32, own(bytes), null));
}

export async function generateAgentKeys(): Promise<AgentKeyPair> {
  const s = await sodium();
  const sign = s.crypto_sign_keypair();
  const box = s.crypto_box_keypair();
  return { signKey: b64u(sign.publicKey), signSecret: sign.privateKey, boxKey: b64u(box.publicKey), boxSecret: box.privateKey };
}

export const newAgentId = (): string => randomHex(16);
export const newNonce = (): string => randomHex(16);

// ---- pairing (§3.2) -------------------------------------------------------------------------------------------------

export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[-\s]/g, "");
export const validCode = (code: string): boolean => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(normalizeCode(code));

/** Proof that the claimer holds the chat's signing key; signed over the normalized code. */
export async function claimProof(code: string, keys: AgentKeyPair): Promise<string> {
  const s = await sodium();
  return b64u(s.crypto_sign_detached(utf8(`notes agent-claim v1\n${normalizeCode(code)}\n${keys.signKey}\n${keys.boxKey}`), keys.signSecret));
}

/** The 6-digit check code shown by both the browser and the MCP. */
export async function checkCode(signKey: string, boxKey: string, code: string): Promise<string> {
  const s = await sodium();
  const h = s.crypto_generichash(32, utf8(`notes agent-pair v1\n${signKey}\n${boxKey}\n${normalizeCode(code)}`), null);
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  return String(n % 1_000_000).padStart(6, "0");
}

// ---- keys sealed to a chat ------------------------------------------------------------------------------------------

export interface AgentSealed { schema: "notes-agent-sealed-v1"; box: string }
const SEALED = "notes-agent-sealed-v1";
const sealContext = (vaultId: string, slot: string, keyEpoch: number): Uint8Array => utf8(`${SEALED}\n${vaultId}\n${slot}\n${keyEpoch}\n`);
/** The slot of a protected project's key; a vault key's slot is "vault". */
export const projectSlot = (path: string): string => `project:${path}`;

export async function sealForAgent(key: Uint8Array, boxKey: string, vaultId: string, slot: string, keyEpoch: number): Promise<AgentSealed> {
  if (key.length !== 32 || !Number.isSafeInteger(keyEpoch)) throw new Error("Nieprawidłowy klucz dla czatu.");
  const s = await sodium();
  const context = sealContext(vaultId, slot, keyEpoch);
  const message = new Uint8Array(context.length + 32);
  message.set(context);
  message.set(own(key), context.length);
  return { schema: SEALED, box: b64u(s.crypto_box_seal(message, publicKey(boxKey))) };
}

/** Opens a key sealed to this chat; throws unless it was sealed for exactly this vault, slot and epoch. */
export async function openForAgent(sealed: AgentSealed, keys: Pick<AgentKeyPair, "boxKey" | "boxSecret">, vaultId: string, slot: string, keyEpoch: number): Promise<Uint8Array> {
  const s = await sodium();
  let message: Uint8Array;
  try {
    if (sealed?.schema !== SEALED) throw new Error("schema");
    message = s.crypto_box_seal_open(own(fromB64u(sealed.box)), publicKey(keys.boxKey), keys.boxSecret);
  } catch {
    throw new Error("Nie udało się otworzyć klucza dla czatu.");
  }
  const context = sealContext(vaultId, slot, keyEpoch);
  // the exact length makes the context unambiguous even if a path held "\n"
  if (message.length !== context.length + 32 || context.some((b, i) => message[i] !== b))
    throw new Error("Klucz dla czatu jest z innego sejfu, projektu lub epoki.");
  return message.slice(context.length);
}

// ---- certificate and scope (§3.2, §3.5) -----------------------------------------------------------------------------

/** `fileText`: "Tekst z plików" (docs/OCR.md §5.2); left out = off, so certs from before it stay valid. */
export interface AgentVault { vaultId: string; whole: true; parts: string[]; writeMode: WriteMode; fileText?: boolean }
export interface AgentCert {
  schema: "notes-agent-cert-v1"; agentId: string; userId: string; signKey: string; boxKey: string; vaults: AgentVault[];
  createdAt: number; expiresAt: number; signerUserId?: string; signature?: string;
}
const CERT = "notes-agent-cert-v1";
const MAX_CERT_MS = 90 * 86_400_000;
// A user-signed value must not pose as chat-signed (it would be verified the other way round).
const userSignedOnly = (value: object): boolean => (value as { alg?: unknown }).alg === undefined && (value as { signerAgentId?: unknown }).signerAgentId === undefined;

export async function signCert(cert: AgentCert, identity: SigningIdentity): Promise<AgentCert> {
  if (identity.userId !== cert.userId) throw new Error("Certyfikat czatu podpisuje jego osoba.");
  const signed: AgentCert = { ...cert };
  await signEvent(signed, identity);
  return signed;
}

/** True when the cert is well formed (version 1: whole vaults only), at most 90 days long, and signed by its person. */
export async function verifyCert(cert: AgentCert, signingKey: JsonWebKey): Promise<boolean> {
  try {
    if (cert?.schema !== CERT || cert.signerUserId !== cert.userId || typeof cert.userId !== "string" || !userSignedOnly(cert)) return false;
    if (!HEX32.test(cert.agentId)) return false;
    publicKey(cert.signKey);
    publicKey(cert.boxKey);
    if (!Number.isSafeInteger(cert.createdAt) || !Number.isSafeInteger(cert.expiresAt) || cert.expiresAt <= cert.createdAt || cert.expiresAt > cert.createdAt + MAX_CERT_MS) return false;
    const vaultOk = (v: AgentVault): boolean => typeof v?.vaultId === "string" && v.whole === true && Array.isArray(v.parts) && v.parts.length === 0
      && WRITE_MODES.includes(v.writeMode) && (v.fileText === undefined || typeof v.fileText === "boolean");
    if (!Array.isArray(cert.vaults) || cert.vaults.length === 0 || !cert.vaults.every(vaultOk)) return false;
    return (await verifySigned(cert, [{ userId: cert.userId, signingKey }])).status === "ok";
  } catch {
    return false;
  }
}

export interface AgentScope {
  schema: "notes-agent-scope-v1"; agentId: string; vaultId: string; include: string[]; exclude: string[]; tools: string[];
  tasks: "mine" | "all"; updatedAt: number; signerUserId?: string; signature?: string;
}
export interface SealedScope { schema: "notes-agent-sealed-scope-v1"; box: string }
const SCOPE = "notes-agent-scope-v1";
const SEALED_SCOPE = "notes-agent-sealed-scope-v1";

/** Signs the scope as the person and seals it to the chat's box key. */
export async function sealScope(scope: AgentScope, identity: SigningIdentity, boxKey: string): Promise<SealedScope> {
  const s = await sodium();
  const signed: AgentScope = { ...scope };
  await signEvent(signed, identity);
  return { schema: SEALED_SCOPE, box: b64u(s.crypto_box_seal(utf8(JSON.stringify(signed)), publicKey(boxKey))) };
}

/** Opens a sealed scope; throws unless it is signed by `expect.userId` and is for this chat and vault. */
export async function openScope(sealed: SealedScope, keys: Pick<AgentKeyPair, "boxKey" | "boxSecret">, signingKey: JsonWebKey, expect: { agentId: string; vaultId: string; userId: string }): Promise<AgentScope> {
  const s = await sodium();
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
  try {
    if (sealed?.schema !== SEALED_SCOPE) throw new Error("schema");
    const scope = JSON.parse(new TextDecoder().decode(s.crypto_box_seal_open(own(fromB64u(sealed.box)), publicKey(keys.boxKey), keys.boxSecret))) as AgentScope;
    const ok = scope?.schema === SCOPE && scope.agentId === expect.agentId && scope.vaultId === expect.vaultId && scope.signerUserId === expect.userId
      && userSignedOnly(scope) && strings(scope.include) && strings(scope.exclude) && strings(scope.tools)
      && (scope.tasks === "mine" || scope.tasks === "all") && Number.isSafeInteger(scope.updatedAt)
      && (await verifySigned(scope, [{ userId: expect.userId, signingKey }])).status === "ok";
    if (ok) return scope;
  } catch { /* falls through */ }
  throw new Error("Zakres czatu jest uszkodzony lub podrobiony.");
}

// Vault paths compare case-insensitively (bridge.ts keyOf); a trailing "/" names the same folder.
const normPath = (path: string): string => path.replace(/^\/+|\/+$/g, "").toLowerCase();
const covers = (prefix: string, path: string): boolean => { const p = normPath(prefix); return p === "" || path === p || path.startsWith(`${p}/`); };

/** Whether `path` is inside the soft scope: `exclude` wins, empty `include` = everything. No scope = nothing. */
export function inScope(scope: AgentScope | null, path: string): boolean {
  if (!scope) return false;
  const p = normPath(path);
  if (p.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  if (scope.exclude.some((x) => covers(x, p))) return false;
  return scope.include.length === 0 || scope.include.some((x) => covers(x, p));
}

// ---- signed by a chat (§6) and request proof (§5.2) -----------------------------------------------------------------

type AgentSigned = { signerUserId: string; signerAgentId: string; alg: "ed25519"; signature: string };

/** Signs `value` as the chat `agentId` of `userId`: Ed25519 over the canonical JSON without `signature`. */
export async function signAsAgent<T extends object>(value: T, userId: string, agentId: string, signSecret: Uint8Array): Promise<T & AgentSigned> {
  const s = await sodium();
  const out = { ...value, signerUserId: userId, signerAgentId: agentId, alg: "ed25519" } as T & AgentSigned;
  delete (out as Signed).signature;
  out.signature = b64u(s.crypto_sign_detached(own(signedBytes(out)), signSecret));
  return out;
}

/** Checks only the Ed25519 signature under `signKey`; whose chat it is and whether its cert holds is the caller's job. */
export async function verifyAgentSigned(value: object & { signature?: string }, signKey: string): Promise<boolean> {
  try {
    if ((value as { alg?: unknown }).alg !== "ed25519" || typeof value.signature !== "string") return false;
    const signature = fromB64u(value.signature);
    if (signature.length !== 64) return false;
    const s = await sodium();
    return s.crypto_sign_verify_detached(own(signature), own(signedBytes(value)), publicKey(signKey));
  } catch {
    return false;
  }
}

/** `Notes-Agent-Proof` of one request. The method is signed upper-case, as it goes on the wire. */
export async function requestProof(input: { method: string; pathAndQuery: string; body: Uint8Array; time: number; nonce: string; version: string }, signSecret: Uint8Array): Promise<string> {
  const s = await sodium();
  const message = `notes-agent-req-v1\n${input.method.toUpperCase()}\n${input.pathAndQuery}\n${await blake2bHex(input.body)}\n${input.time}\n${input.nonce}\n${input.version}`;
  return b64u(s.crypto_sign_detached(utf8(message), signSecret));
}
