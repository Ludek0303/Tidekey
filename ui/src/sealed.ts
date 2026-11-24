// Box keys and sealed boxes (Stage E, contract: docs/WEB-WSPOLDZIELENIE.md). Each user has an ECDH P-256 box key: the
// public half is on the server (GET/PUT /api/me/box-key, members[].boxKey), the private half is wrapped with the personal
// key. A vault key is sealed to a member's box key (`notes-sealed-v1`): ephemeral ECDH, HKDF-SHA256, AES-GCM-256.
import { ApiError, api, base64ToBytes, bufferSource, bytesToBase64, unwrapBytes, wrapBytes, type KeyEnvelope } from "./vaults";

const ECDH: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };
const SEALED_SCHEMA = "notes-sealed-v1";
const INFO = new TextEncoder().encode(SEALED_SCHEMA);
export interface SealedBox { schema: typeof SEALED_SCHEMA; epk: JsonWebKey; nonce: string; ciphertext: string }
export interface BoxIdentity { userId: string; privateKey: CryptoKey; publicJwk: JsonWebKey }
interface StoredBoxKey { publicJwk: JsonWebKey; wrappedPrivate: KeyEnvelope }

// Only the public fields of an EC JWK, as the server and the epk field expect them.
const publicOnly = (jwk: JsonWebKey): JsonWebKey => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

// AES-GCM-256 key from the ECDH secret: HKDF-SHA256 with 32 zero bytes of salt and the schema name as info.
async function deriveBoxKey(secret: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: bufferSource(INFO) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** A P-256 public box key (a JWK, as the server hands it out); null for anything else, a private key too. */
export function asBoxPublicKey(value: unknown): JsonWebKey | null {
  if (!value || typeof value !== "object") return null;
  const k = value as JsonWebKey;
  const coord = (c: unknown) => typeof c === "string" && /^[A-Za-z0-9_-]{43}$/.test(c);
  return k.kty === "EC" && k.crv === "P-256" && k.d === undefined && coord(k.x) && coord(k.y) ? publicOnly(k) : null;
}

/** Seals `plaintext` so that only the holder of the private half of `recipient` can open it. */
export async function sealTo(recipient: JsonWebKey, plaintext: Uint8Array): Promise<SealedBox> {
  const ephemeral = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  const recipientKey = await crypto.subtle.importKey("jwk", publicOnly(recipient), ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: recipientKey }, ephemeral.privateKey, 256);
  const aes = await deriveBoxKey(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), tagLength: 128 }, aes, bufferSource(plaintext));
  return { schema: SEALED_SCHEMA, epk: publicOnly(await crypto.subtle.exportKey("jwk", ephemeral.publicKey)), nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

/** Opens a sealed box with the recipient's box private key. Throws when the box is not for this key or was altered. */
export async function openSealed(sealed: SealedBox, privateKey: CryptoKey): Promise<Uint8Array> {
  if (sealed?.schema !== SEALED_SCHEMA) throw new Error("Nieobsługiwany format klucza sejfu.");
  try {
    const epk = await crypto.subtle.importKey("jwk", publicOnly(sealed.epk), ECDH, false, []);
    const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
    const aes = await deriveBoxKey(secret);
    const nonce = base64ToBytes(sealed.nonce);
    if (nonce.length !== 12) throw new Error("nonce");
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(nonce), tagLength: 128 }, aes, bufferSource(base64ToBytes(sealed.ciphertext))));
  } catch {
    throw new Error("Nie udało się otworzyć klucza sejfu.");
  }
}

async function importPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", bufferSource(pkcs8), ECDH, false, ["deriveBits"]);
}

async function fromStored(userId: string, stored: StoredBoxKey, personal: CryptoKey): Promise<BoxIdentity> {
  return { userId, privateKey: await importPrivate(await unwrapBytes(stored.wrappedPrivate, personal)), publicJwk: stored.publicJwk };
}

/**
 * The user's box key, from the server or made now. Same rules as the signing key: 404 generates and PUTs a new pair, 409
 * (another device stored one first) reads the stored key again.
 */
export async function loadBoxIdentity(userId: string, personal: CryptoKey): Promise<BoxIdentity> {
  let stored: StoredBoxKey;
  try {
    stored = await api<StoredBoxKey>("/api/me/box-key");
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
    const publicJwk = publicOnly(await crypto.subtle.exportKey("jwk", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const wrappedPrivate = await wrapBytes(pkcs8, personal);
    try {
      await api("/api/me/box-key", "PUT", { publicJwk, wrappedPrivate });
      return { userId, privateKey: await importPrivate(pkcs8), publicJwk };
    } catch (put) {
      if (!(put instanceof ApiError) || put.status !== 409) throw put;
      stored = await api<StoredBoxKey>("/api/me/box-key");
    }
  }
  return fromStored(userId, stored, personal);
}
