// Encryption of server files (docs/PLIKI.md §2, §5). Content: libsodium's secretstream (XChaCha20-Poly1305), one random
// key per file, streamed in PLAIN_CHUNK pieces. Metadata: AES-GCM with the vault key or a protected project's key.
// libsodium is loaded on first use, so the main bundle does not carry it.
import { base64ToBytes, bufferSource, bytesToBase64 } from "./vaults";

type Sodium = typeof import("libsodium-wrappers").default;
let sodiumLoaded: Promise<Sodium> | null = null;
function sodium(): Promise<Sodium> {
  sodiumLoaded ??= import("libsodium-wrappers").then(async (m) => { await m.default.ready; return m.default; })
    .catch((error) => { sodiumLoaded = null; throw error; });
  return sodiumLoaded;
}

export const PLAIN_CHUNK = 1048576;
const ABYTES = 17;
/** A chunk on the wire, except chunk 0 which also carries the 32-byte prefix. */
export const CIPHER_CHUNK = PLAIN_CHUNK + ABYTES;
/** The container prefix: "NOTESF2\n" (8 B) and the secretstream header (24 B). */
export const PREFIX_BYTES = 32;
const MAGIC = new TextEncoder().encode("NOTESF2\n");
const META_SCHEMA = "notes-file-meta-v2";
const META_MAX_BYTES = 4096;
const encoder = new TextEncoder();

/** The metadata inside the envelope: plaintext JSON. `key` is the file key (secretstream, 32 B), base64. */
export interface FileMeta {
  format: 2; version: 1; name: string; mime: string; size: number; project: string | null; key: string; createdAt: number;
  width?: number; height?: number;
  /** On an image: the id of its thumbnail file. */
  thumb?: string;
  /** On a thumbnail: the id of the image it belongs to. */
  thumbOf?: string;
  /** On a video: its length in milliseconds, when known (taken with its first-frame thumbnail; docs/PODGLAD-PLAN.md §4.3). */
  duration?: number;
  /** On a text layer (docs/OCR.md §3.2): the id of the PDF or image it was read from, and what the extractor says. */
  textOf?: string;
  extractor?: number;
  method?: "pdf-text" | "ocr" | "mixed" | "none";
  pages?: number;
  lang?: "latin";
  quality?: number;
  flags?: string[];
  engine?: string;
  /** The content is gzip-compressed (CompressionStream) before the v2 container; only text layers use it. */
  encoding?: "gzip";
}
/** Which key opens an envelope: the vault key of an epoch, or a protected project's key of an epoch (by scope). */
export type MetaRef = { keyEpoch: number } | { scope: string; projectEpoch: number };

const hex = (b: Uint8Array): string => [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes)));
const corrupt = (): Error => new Error("Plik jest uszkodzony albo został zmieniony.");
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

/** The chunks a plaintext of `size` bytes takes: an empty file is one (17-byte) chunk. */
export const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / PLAIN_CHUNK));
/** The stored size: the prefix, the plaintext, and one tag per chunk. */
export const cipherSize = (size: number): number => PREFIX_BYTES + size + ABYTES * chunkCount(size);

/** A new file key: 32 random bytes, base64 (the form the metadata holds). */
export async function newFileKey(): Promise<string> {
  return bytesToBase64((await sodium()).crypto_secretstream_xchacha20poly1305_keygen());
}

// Associated data of every chunk (docs/PLIKI.md §2): binds the object to its vault, file, scope and format version.
const chunkAd = (vaultId: string, fileId: string, scope: string | null): Uint8Array =>
  Uint8Array.from(encoder.encode(["notes-file-v2", vaultId, fileId, scope ?? "", "1"].join("\0")));

/**
 * Seals a file, chunk by chunk: each yielded piece goes to the server as is (piece 0 holds the prefix). The file is read
 * with `slice`, one chunk at a time. Retrying a piece means sending the same bytes again, not sealing it anew.
 */
export async function* sealFile(file: Blob, keyB64: string, vaultId: string, fileId: string, scope: string | null): AsyncGenerator<Uint8Array> {
  const s = await sodium();
  const raw = base64ToBytes(keyB64);
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(raw);
  s.memzero(raw);
  const ad = chunkAd(vaultId, fileId, scope);
  const total = chunkCount(file.size);
  for (let i = 0; i < total; i++) {
    const start = i * PLAIN_CHUNK;
    const plain = new Uint8Array(await file.slice(start, Math.min(file.size, start + PLAIN_CHUNK)).arrayBuffer());
    const tag = i === total - 1 ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const cipher = s.crypto_secretstream_xchacha20poly1305_push(state, plain, ad, tag);
    yield i === 0 ? concat(MAGIC, header, cipher) : cipher;
  }
}

// Reads exact byte counts from a stream of pieces; a stream that ends early is corrupt.
class Pieces {
  private readonly it: AsyncIterator<Uint8Array>;
  private queue: Uint8Array[] = [];
  private queued = 0;
  constructor(source: AsyncIterable<Uint8Array>) { this.it = source[Symbol.asyncIterator](); }

  async take(n: number): Promise<Uint8Array> {
    while (this.queued < n) {
      const next = await this.it.next();
      if (next.done) throw corrupt();
      if (next.value.length) { this.queue.push(next.value); this.queued += next.value.length; }
    }
    const out = new Uint8Array(n);
    for (let off = 0; off < n;) {
      const head = this.queue[0];
      const m = Math.min(head.length, n - off);
      out.set(head.subarray(0, m), off);
      off += m;
      if (m === head.length) this.queue.shift(); else this.queue[0] = head.subarray(m);
    }
    this.queued -= n;
    return out;
  }

  /** True when a byte follows what was read. */
  async hasMore(): Promise<boolean> {
    if (this.queued) return true;
    for (;;) {
      const next = await this.it.next();
      if (next.done) return false;
      if (next.value.length) return true;
    }
  }
}

/**
 * Opens a sealed file as it streams in, and yields its plaintext chunk by chunk. `size` is the plaintext size from the
 * metadata: it fixes where every chunk ends. Throws on a wrong magic, a failed tag, a chunk marked final too early or
 * missing, a short stream, or any byte after the final chunk. Nothing about the key or the bytes goes into the message.
 */
export async function* openFile(source: AsyncIterable<Uint8Array>, keyB64: string, vaultId: string, fileId: string, scope: string | null, size: number): AsyncGenerator<Uint8Array> {
  const s = await sodium();
  const input = new Pieces(source);
  const prefix = await input.take(PREFIX_BYTES);
  if (!prefix.subarray(0, MAGIC.length).every((b, i) => b === MAGIC[i])) throw corrupt();
  const raw = base64ToBytes(keyB64);
  let state: ReturnType<Sodium["crypto_secretstream_xchacha20poly1305_init_pull"]>;
  try { state = s.crypto_secretstream_xchacha20poly1305_init_pull(prefix.subarray(MAGIC.length), raw); }
  catch { throw corrupt(); }
  finally { s.memzero(raw); }
  const ad = chunkAd(vaultId, fileId, scope);
  const total = chunkCount(size);
  for (let i = 0; i < total; i++) {
    const last = i === total - 1;
    const plainLength = last ? size - i * PLAIN_CHUNK : PLAIN_CHUNK;
    const cipher = await input.take(plainLength + ABYTES);
    let pulled: { message: Uint8Array; tag: number } | false;
    try { pulled = s.crypto_secretstream_xchacha20poly1305_pull(state, cipher, ad); }
    catch { throw corrupt(); }
    const want = last ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    if (!pulled || pulled.tag !== want) throw corrupt();
    yield pulled.message;
  }
  if (await input.hasMore()) throw corrupt();
}

// The envelope's head (which key opens it) is authenticated too, so a server cannot relabel the epoch or the scope.
const refText = (ref: MetaRef): string => ("keyEpoch" in ref ? `k:${ref.keyEpoch}` : `s:${ref.scope}:${ref.projectEpoch}`);
const metaAad = (vaultId: string, fileId: string, ref: MetaRef) => encoder.encode(`notes-file-meta-v2\0${vaultId}\0${fileId}\0${refText(ref)}`);

/** The envelope as text (what the server stores in `meta`). */
export async function sealMeta(vaultId: string, fileId: string, ref: MetaRef, key: CryptoKey, meta: FileMeta): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: metaAad(vaultId, fileId, ref), tagLength: 128 }, key, encoder.encode(JSON.stringify(meta)));
  const text = JSON.stringify({ schema: META_SCHEMA, ...ref, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)) });
  if (encoder.encode(text).length > META_MAX_BYTES) throw new Error("Nazwa pliku jest za długa.");
  return text;
}

interface Envelope { ref: MetaRef; nonce: Uint8Array; ciphertext: Uint8Array }
function parseEnvelope(text: string): Envelope {
  const v = JSON.parse(text) as Record<string, unknown>;
  if (v?.schema !== META_SCHEMA || typeof v.nonce !== "string" || typeof v.ciphertext !== "string") throw new Error("Nieprawidłowe metadane pliku.");
  const ref: MetaRef = typeof v.scope === "string" && Number.isInteger(v.projectEpoch)
    ? { scope: v.scope, projectEpoch: v.projectEpoch as number }
    : { keyEpoch: Number(v.keyEpoch) };
  if ("keyEpoch" in ref && !Number.isInteger(ref.keyEpoch)) throw new Error("Nieprawidłowe metadane pliku.");
  return { ref, nonce: base64ToBytes(v.nonce), ciphertext: base64ToBytes(v.ciphertext) };
}

/** Which key the envelope needs, without opening it. */
export function metaRefOf(text: string): MetaRef { return parseEnvelope(text).ref; }

/**
 * Opens an envelope. `keyFor` gives the key for its ref, or null when this user has none: then the result is null too
 * (not this user's file). A wrong key or a changed envelope throws.
 */
export async function openMeta(vaultId: string, fileId: string, text: string, keyFor: (ref: MetaRef) => Promise<CryptoKey | null>): Promise<FileMeta | null> {
  const env = parseEnvelope(text);
  const key = await keyFor(env.ref);
  if (!key) return null;
  let plain: ArrayBuffer;
  try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(env.nonce), additionalData: metaAad(vaultId, fileId, env.ref), tagLength: 128 }, key, bufferSource(env.ciphertext)); }
  catch { throw new Error("Nie udało się odszyfrować metadanych pliku."); }
  let meta: FileMeta;
  // a fixed message: a parser's own error may quote a piece of the decrypted envelope (a file name)
  try { meta = JSON.parse(new TextDecoder().decode(plain)) as FileMeta; } catch { throw new Error("Nieprawidłowe metadane pliku."); }
  if (meta?.format !== 2 || meta.version !== 1) throw new Error("Nieprawidłowe metadane pliku.");
  return meta;
}

/**
 * The id of a file's text layer (docs/OCR.md §3.2): HMAC-SHA256 under the original's file key over the original's id
 * and the extractor version. Every member who can open the original (and only they) derives the same id, so a retry,
 * another device or a manual "Rozpoznaj tekst" never makes a second layer, and the server cannot predict it.
 */
export async function textLayerId(fileKey: string, fileId: string, extractor: number): Promise<string> {
  if (!/^[0-9a-f]{32}$/.test(fileId) || !Number.isSafeInteger(extractor) || extractor < 1) throw new Error("Nieprawidłowy plik.");
  const raw = base64ToBytes(fileKey);
  if (raw.length !== 32) throw new Error("Nieprawidłowy klucz pliku.");
  const key = await crypto.subtle.importKey("raw", bufferSource(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, bufferSource(encoder.encode(`notes-file-text-v1\0${fileId}\0${extractor}`)));
  return hex(new Uint8Array(mac)).slice(0, 32);
}

/** The scope of a protected project: a 32-hex digest of the vault and the folder path (docs/PLIKI.md §2). */
export async function scopeOf(vaultId: string, projectPath: string): Promise<string> {
  return hex(await sha256(encoder.encode(`notes-scope-v1\0${vaultId}\0${projectPath}`))).slice(0, 32);
}

/** The secret the migration ids are keyed with: the vault's raw key (shared vaults), or a derivation of the personal key. */
export async function keySecret(key: CryptoKey): Promise<Uint8Array> {
  // shortcut: the personal key is not extractable, so its secret is a fixed AES-GCM encryption under it (a deterministic PRF).
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, encoder.encode("notes-migrate-secret-v1"));
  return sha256(new Uint8Array(out));
}

/** The id of an attachment migrated from a snapshot (docs/PLIKI.md §5): the same on every client, so a retry is not a copy. */
export async function migrationId(secret: Uint8Array, key: string, bytes: Uint8Array): Promise<string> {
  const digest = hex(await sha256(bytes));
  const mac = await crypto.subtle.importKey("raw", bufferSource(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", mac, encoder.encode(`migrate\0${key}\0${digest}`)))).slice(0, 32);
}
