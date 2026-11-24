// The last name (nazwisko) stays encrypted in the browser. Two copies: the account's `profileSecret` (under the personal
// key, for this user's own devices) and a card per shared vault (under that vault's key, so its members can read it).
// Contract: docs/WEB-WSPOLDZIELENIE.md.
import type { BrowserUser } from "./browserauth";
import { errorText, toast } from "./widgets";
import { api, base64ToBytes, bufferSource, bytesToBase64, unwrapBytes, wrapBytes, type KeyEnvelope } from "./vaults";

export interface ProfileEnvelope { schema: "notes-profile-v1"; keyEpoch: number; nonce: string; ciphertext: string }
const PROFILE_SCHEMA = "notes-profile-v1";

// A JSON value sealed under a key in the same envelope as a wrapped vault key (also the account's synced settings).
export async function sealJson(value: unknown, key: CryptoKey): Promise<KeyEnvelope> {
  return wrapBytes(new TextEncoder().encode(JSON.stringify(value)), key);
}
export async function openJson<T>(envelope: KeyEnvelope, key: CryptoKey): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await unwrapBytes(envelope, key))) as T;
}

// The account copy: {"lastName"} under the personal key.
export async function sealLastName(lastName: string, personal: CryptoKey): Promise<KeyEnvelope> {
  return sealJson({ lastName }, personal);
}
export async function openLastName(secret: KeyEnvelope, personal: CryptoKey): Promise<string> {
  return (await openJson<{ lastName: string }>(secret, personal)).lastName;
}

// The AAD ties a card to its vault, owner and epoch: a card copied elsewhere does not open.
const cardAad = (vaultId: string, userId: string, keyEpoch: number): ArrayBuffer =>
  bufferSource(new TextEncoder().encode(`${PROFILE_SCHEMA}\0${vaultId}\0${userId}\0${keyEpoch}`));

export async function sealProfile(lastName: string, vaultId: string, userId: string, keyEpoch: number, key: CryptoKey): Promise<ProfileEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ lastName }));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), additionalData: cardAad(vaultId, userId, keyEpoch), tagLength: 128 }, key, bufferSource(data));
  return { schema: PROFILE_SCHEMA, keyEpoch, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

export async function openProfile(card: ProfileEnvelope, vaultId: string, userId: string, key: CryptoKey): Promise<string> {
  if (card.schema !== PROFILE_SCHEMA) throw new Error("Nieobsługiwany format nazwiska.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(base64ToBytes(card.nonce)), additionalData: cardAad(vaultId, userId, card.keyEpoch), tagLength: 128 }, key, bufferSource(base64ToBytes(card.ciphertext)));
  return (JSON.parse(new TextDecoder().decode(plain)) as { lastName: string }).lastName;
}

// The card to publish for this user in a vault, or null to remove it. undefined: the server's card is already right
// (same epoch, same name, or no card and no name).
export async function profileChange(current: ProfileEnvelope | null, lastName: string, vaultId: string, userId: string, keyEpoch: number, key: CryptoKey): Promise<ProfileEnvelope | null | undefined> {
  if (!lastName && !current) return undefined;
  if (current?.keyEpoch === keyEpoch && (await openProfile(current, vaultId, userId, key).catch(() => null)) === lastName) return undefined;
  return lastName ? sealProfile(lastName, vaultId, userId, keyEpoch, key) : null;
}

// Moves the last name onto the account encrypted: a typed one (registration) or the legacy plaintext one (sent once, at
// login). A stored copy is kept. Failures do not block the login.
export async function keepLastName(user: BrowserUser, personal: CryptoKey, typed: string): Promise<void> {
  const legacy = user.lastName ?? "";
  try {
    const body: { profileSecret?: KeyEnvelope; lastName?: "" } = {};
    if (!user.profileSecret && (typed || legacy)) body.profileSecret = await sealLastName(typed || legacy, personal);
    if (legacy) body.lastName = "";
    if (Object.keys(body).length === 0) return;
    await api("/api/auth/me", "PATCH", body);
    if (body.profileSecret) user.profileSecret = body.profileSecret;
    if (legacy) user.lastName = "";
  } catch (e) {
    if (typed) toast(`Nie udało się zapisać nazwiska. ${errorText(e)} Możesz je dodać później w Ustawieniach → Konto.`, true);
    else console.warn("Nazwiska nie udało się przenieść na konto:", e);
  }
}
