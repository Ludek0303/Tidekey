// Proposals of a Claude chat in the `proposals` write mode (docs/MCP.md §7.1, contract: docs/WEB-WSPOLDZIELENIE.md
// "Proposals"). Sealed to the chat's person's box key, never to a vault key, so only that person opens one. WebCrypto
// only (ECDH P-256, HKDF-SHA256, AES-GCM-256, gzip): runs in the browser and in the MCP under Node 22.
import { blake2bHex, signAsAgent, verifyAgentSigned } from "./agentcrypto";
import { base64ToBytes, bufferSource, bytesToBase64 } from "./vaults";

export type ProposalOp = "create" | "append" | "edit" | "move" | "trash" | "tasks";
export interface ProposalChange { op: ProposalOp; path: string; noteId: string; baseHash: string; text?: string; to?: string }
export interface ProposalBody { createdAt: number; summary: string; changes: ProposalChange[] }
export interface Proposal {
  schema: "notes-proposal-v1"; proposalId: string; agentId: string; epk: JsonWebKey; nonce: string; ciphertext: string;
  signerUserId: string; signerAgentId: string; alg: "ed25519"; signature: string;
}

const SCHEMA = "notes-proposal-v1";
const OPS: readonly string[] = ["create", "append", "edit", "move", "trash", "tasks"];
const ECDH: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };
const MAX_CIPHERTEXT = 1 << 20; // the base64 field, as the server limits it
const MAX_PLAIN = 16 << 20; // a gzip bomb stops here
const BAD = "Propozycja jest uszkodzona lub podrobiona.";
const enc = new TextEncoder();
const publicOnly = (jwk: JsonWebKey): JsonWebKey => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
const info = (vaultId: string, proposalId: string): string => `${SCHEMA}\0${vaultId}\0${proposalId}`;

/** baseHash of a note's current text: hex(H(utf8(text))). */
export const textHash = (text: string): Promise<string> => blake2bHex(enc.encode(text));

async function aesKey(publicJwk: JsonWebKey, privateKey: CryptoKey, vaultId: string, proposalId: string): Promise<CryptoKey> {
  const other = await crypto.subtle.importKey("jwk", publicOnly(publicJwk), ECDH, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: other }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  new Uint8Array(secret).fill(0);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: bufferSource(enc.encode(info(vaultId, proposalId))) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const gcm = (nonce: Uint8Array, vaultId: string, proposalId: string, agentId: string): AesGcmParams =>
  ({ name: "AES-GCM", iv: bufferSource(nonce), additionalData: bufferSource(enc.encode(`${info(vaultId, proposalId)}\0${agentId}`)), tagLength: 128 });

// Runs bytes through a (de)compression stream; refuses output above `limit`.
async function through(bytes: Uint8Array, transform: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const writing = writer.write(new Uint8Array(bufferSource(bytes))).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reading = (async () => {
    for (const reader = transform.readable.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > limit) { void reader.cancel(); throw new Error("too large"); }
      chunks.push(value);
    }
  })();
  await Promise.all([writing, reading]);
  const out = new Uint8Array(size);
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
  return out;
}

/** Seals a proposal to the person's box key and signs it as the chat. The ephemeral key never leaves this function. */
export async function sealProposal(body: ProposalBody, opts: { vaultId: string; agentId: string; userId: string; personBoxKey: JsonWebKey; signSecret: Uint8Array }): Promise<Proposal> {
  const proposalId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const plain = await through(enc.encode(JSON.stringify(body)), new CompressionStream("gzip"));
  const ephemeral = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  const key = await aesKey(opts.personBoxKey, ephemeral.privateKey, opts.vaultId, proposalId);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(gcm(nonce, opts.vaultId, proposalId, opts.agentId), key, bufferSource(plain));
  const ciphertext = bytesToBase64(new Uint8Array(cipher));
  if (ciphertext.length > MAX_CIPHERTEXT) throw new Error("Propozycja jest za duża (najwyżej 1 MiB po zaszyfrowaniu). Podziel ją na mniejsze.");
  const epk = publicOnly(await crypto.subtle.exportKey("jwk", ephemeral.publicKey));
  return signAsAgent({ schema: SCHEMA, proposalId, agentId: opts.agentId, epk, nonce: bytesToBase64(nonce), ciphertext }, opts.userId, opts.agentId, opts.signSecret);
}

const validBody = (b: ProposalBody): boolean =>
  Number.isFinite(b?.createdAt) && typeof b.summary === "string" && Array.isArray(b.changes) && b.changes.every((c) =>
    OPS.includes(c?.op) && typeof c.path === "string" && typeof c.noteId === "string" && typeof c.baseHash === "string"
    && (c.text === undefined || typeof c.text === "string") && (c.to === undefined || typeof c.to === "string"));

/**
 * Opens a proposal with the person's box private key. `agentSignKey` must come from the chat's verified, unrevoked
 * cert. Checks the schema, the chat and person, the signature and the AAD (vault, proposal, chat).
 */
export async function openProposal(p: Proposal, opts: { vaultId: string; boxPrivateKey: CryptoKey; agentSignKey: string; agentId: string; userId: string }): Promise<ProposalBody> {
  try {
    if (p?.schema !== SCHEMA || !/^[0-9a-f]{32}$/.test(p.proposalId) || p.agentId !== opts.agentId || p.signerAgentId !== opts.agentId || p.signerUserId !== opts.userId) throw new Error("fields");
    if (typeof p.ciphertext !== "string" || p.ciphertext.length > MAX_CIPHERTEXT || !(await verifyAgentSigned(p, opts.agentSignKey))) throw new Error("signature");
    const nonce = base64ToBytes(p.nonce);
    if (nonce.length !== 12) throw new Error("nonce");
    const key = await aesKey(p.epk, opts.boxPrivateKey, opts.vaultId, p.proposalId);
    const plain = new Uint8Array(await crypto.subtle.decrypt(gcm(nonce, opts.vaultId, p.proposalId, p.agentId), key, bufferSource(base64ToBytes(p.ciphertext))));
    const body = JSON.parse(new TextDecoder().decode(await through(plain, new DecompressionStream("gzip"), MAX_PLAIN))) as ProposalBody;
    if (validBody(body)) return body;
  } catch { /* falls through */ }
  throw new Error(BAD);
}
