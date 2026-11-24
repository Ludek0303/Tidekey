// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CIPHER_CHUNK, PLAIN_CHUNK, PREFIX_BYTES, chunkCount, cipherSize, metaRefOf, migrationId, newFileKey, openFile, openMeta, scopeOf, sealFile, sealMeta, type FileMeta, type MetaRef } from "./filecrypto";
import { base64ToBytes } from "./vaults";

const VAULT = `v-${"a".repeat(32)}`;
const FILE = "f".repeat(32);
const SCOPE = "5".repeat(32);
const CORRUPT = "Plik jest uszkodzony albo został zmieniony.";
const TAG_MESSAGE = 0;
const TAG_FINAL = 3;
const MAGIC = new TextEncoder().encode("NOTESF2\n");
const encoder = new TextEncoder();
const aesKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const meta = (over: Partial<FileMeta> = {}): FileMeta => ({ format: 2, version: 1, name: "plan.pdf", mime: "application/pdf", size: 3, project: null, key: "", createdAt: 1, ...over });

// libsodium straight from the package, to craft streams the sealer would never produce (wrong tags, spliced chunks).
type Sodium = typeof import("libsodium-wrappers").default;
async function lib(): Promise<Sodium> {
  const m = await import("libsodium-wrappers");
  await m.default.ready;
  return m.default;
}

const pattern = (n: number, seed = 0) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 0xff);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};
const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

// Seals a blob into the wire bytes, the way the upload sends them (all pieces joined).
async function sealAll(bytes: Uint8Array, key: string, scope: string | null = null, file = FILE, vault = VAULT): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const piece of sealFile(blobOf(bytes), key, vault, file, scope)) pieces.push(piece);
  return concat(...pieces);
}
// The stream as network pieces of `size` bytes, so the reader has to cut across them.
async function* streamOf(bytes: Uint8Array, size = 65536): AsyncGenerator<Uint8Array> {
  for (let off = 0; off < bytes.length; off += size) yield bytes.subarray(off, off + size);
}
async function openAll(wire: Uint8Array, key: string, size: number, scope: string | null = null, file = FILE, vault = VAULT, pieceSize = 65536): Promise<Uint8Array> {
  return concat(...await collect(openFile(streamOf(wire, pieceSize), key, vault, file, scope, size)));
}
async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const p of gen) out.push(p);
  return out;
}
async function expectCorrupt(promise: Promise<unknown>, key?: string): Promise<void> {
  const err = await promise.then(() => null, (e: unknown) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect(err?.message).toBe(CORRUPT);
  if (key) expect(err?.message).not.toContain(key);
}
// The additional data of a chunk, built by hand from the contract (docs/PLIKI.md §2).
const adOf = (scope: string, file = FILE, vault = VAULT) => Uint8Array.from(encoder.encode(["notes-file-v2", vault, file, scope, "1"].join("\0")));

// Crafts a stream from explicit pieces: each with its message and tag, sealed under the file's key.
async function craft(key: string, scope: string, parts: { plain: Uint8Array; tag: number }[]): Promise<Uint8Array> {
  const s = await lib();
  const raw = base64ToBytes(key);
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(raw);
  const ad = adOf(scope);
  const out = [MAGIC, header];
  for (const p of parts) out.push(s.crypto_secretstream_xchacha20poly1305_push(state, p.plain, ad, p.tag));
  return concat(...out);
}

describe("file container", () => {
  it("round-trips the sizes of the contract: 0 B, 1 B, one chunk, one chunk plus one byte, and 3.5 MiB", async () => {
    const key = await newFileKey();
    for (const size of [0, 1, PLAIN_CHUNK, PLAIN_CHUNK + 1, 3.5 * PLAIN_CHUNK]) {
      const data = pattern(size, size);
      const wire = await sealAll(data, key);
      expect(wire.length).toBe(cipherSize(size));
      expect(same(await openAll(wire, key, size), data)).toBe(true);
    }
  });

  it("starts with the magic, then a 24-byte header, and writes chunks of the contract's size", async () => {
    const key = await newFileKey();
    const pieces: Uint8Array[] = [];
    for await (const p of sealFile(blobOf(pattern(2 * PLAIN_CHUNK + 5)), key, VAULT, FILE, SCOPE)) pieces.push(p);
    expect(pieces.map((p) => p.length)).toEqual([PREFIX_BYTES + CIPHER_CHUNK, CIPHER_CHUNK, 5 + 17]);
    expect(same(pieces[0].subarray(0, 8), MAGIC)).toBe(true);
    expect(CIPHER_CHUNK).toBe(1048593);
  });

  it("makes an empty file one 17-byte final chunk", async () => {
    const key = await newFileKey();
    const wire = await sealAll(new Uint8Array(0), key);
    expect(wire.length).toBe(PREFIX_BYTES + 17);
    expect(chunkCount(0)).toBe(1);
  });

  it("gives an exact multiple of the chunk size exactly that many chunks", async () => {
    expect(chunkCount(2 * PLAIN_CHUNK)).toBe(2);
    expect(cipherSize(2 * PLAIN_CHUNK)).toBe(32 + 2 * PLAIN_CHUNK + 2 * 17);
  });

  it("makes a new 32-byte key each time", async () => {
    const a = await newFileKey();
    const b = await newFileKey();
    expect(base64ToBytes(a).length).toBe(32);
    expect(a).not.toBe(b);
  });

  it("reads through pieces of any size", async () => {
    const key = await newFileKey();
    const data = pattern(PLAIN_CHUNK + 777);
    const wire = await sealAll(data, key);
    for (const size of [4093, 65536, 1 << 20]) expect(same(await openAll(wire, key, data.length, null, FILE, VAULT, size), data)).toBe(true);
  });

  it("refuses the wrong key", async () => {
    const key = await newFileKey();
    const wire = await sealAll(pattern(100), key);
    await expectCorrupt(openAll(wire, await newFileKey(), 100), key);
  });

  it("refuses one flipped byte in any chunk, and in the prefix", async () => {
    const key = await newFileKey();
    const size = 2 * PLAIN_CHUNK + 5;
    const wire = await sealAll(pattern(size), key);
    // the magic, the header, and a byte inside each of the three chunks
    const at = [3, PREFIX_BYTES - 1, PREFIX_BYTES + 40, PREFIX_BYTES + CIPHER_CHUNK + 40, PREFIX_BYTES + 2 * CIPHER_CHUNK + 5];
    for (const i of at) {
      const bad = wire.slice();
      bad[i] ^= 0x01;
      await expectCorrupt(openAll(bad, key, size), key);
    }
    // the tag at the very end
    {
      const bad = wire.slice();
      bad[wire.length - 1] ^= 0x80;
      await expectCorrupt(openAll(bad, key, size), key);
    }
  });

  it("refuses an object encrypted for another file, vault or scope", async () => {
    const key = await newFileKey();
    const data = pattern(300);
    const wire = await sealAll(data, key, SCOPE);
    await expectCorrupt(openAll(wire, key, data.length, SCOPE, "e".repeat(32)));
    await expectCorrupt(openAll(wire, key, data.length, SCOPE, FILE, `v-${"b".repeat(32)}`));
    await expectCorrupt(openAll(wire, key, data.length, "6".repeat(32)));
    await expectCorrupt(openAll(wire, key, data.length, null));
    expect(same(await openAll(wire, key, data.length, SCOPE), data)).toBe(true);
  });

  it("refuses a truncated stream, a short one and a long one", async () => {
    const key = await newFileKey();
    const size = 2 * PLAIN_CHUNK + 5;
    const wire = await sealAll(pattern(size), key);
    await expectCorrupt(openAll(wire.subarray(0, wire.length - 22), key, size));
    await expectCorrupt(openAll(wire.subarray(0, wire.length - 1), key, size));
    await expectCorrupt(openAll(wire.subarray(0, PREFIX_BYTES + 100), key, size));
    await expectCorrupt(openAll(wire, key, size + 1)); // metadata says more than there is
    await expectCorrupt(openAll(wire, key, size - 1)); // metadata says less: the last chunk is longer than that
  });

  it("accepts a crafted stream with a final chunk where it should be, and refuses the same chunks with final tags in the middle", async () => {
    const key = await newFileKey();
    const full = pattern(PLAIN_CHUNK, 1);
    const tail = pattern(5, 2);
    const good = await craft(key, "", [{ plain: full, tag: TAG_MESSAGE }, { plain: tail, tag: TAG_FINAL }]);
    expect(same(await openAll(good, key, PLAIN_CHUNK + 5), concat(full, tail))).toBe(true); // control: the crafting is right
    // a final tag before the last chunk: a file cut in the middle, then more
    const spliced = await craft(key, "", [{ plain: full, tag: TAG_FINAL }, { plain: full, tag: TAG_MESSAGE }, { plain: tail, tag: TAG_FINAL }]);
    await expectCorrupt(openAll(spliced, key, 2 * PLAIN_CHUNK + 5));
    // a stream that ends without a final chunk
    const unfinished = await craft(key, "", [{ plain: full, tag: TAG_MESSAGE }, { plain: tail, tag: TAG_MESSAGE }]);
    await expectCorrupt(openAll(unfinished, key, PLAIN_CHUNK + 5));
    // the stream is cut after a message chunk, and the metadata claims more
    const cut = await craft(key, "", [{ plain: full, tag: TAG_MESSAGE }]);
    await expectCorrupt(openAll(cut, key, PLAIN_CHUNK + 5));
  });

  it("refuses a file that is a short file's final chunk spliced into a longer one", async () => {
    const key = await newFileKey();
    const short = await sealAll(pattern(5), key);
    const longWire = await sealAll(pattern(2 * PLAIN_CHUNK + 5), key);
    // the first chunk of the long file, then the short file's final chunk in place of the middle one
    const spliced = concat(longWire.subarray(0, PREFIX_BYTES + CIPHER_CHUNK), short.subarray(PREFIX_BYTES), longWire.subarray(PREFIX_BYTES + 2 * CIPHER_CHUNK));
    await expectCorrupt(openAll(spliced, key, 2 * PLAIN_CHUNK + 5));
  });

  it("refuses reordered chunks", async () => {
    const key = await newFileKey();
    const size = 3 * PLAIN_CHUNK;
    const wire = await sealAll(pattern(size), key);
    const c = (i: number) => wire.subarray(PREFIX_BYTES + i * CIPHER_CHUNK, PREFIX_BYTES + (i + 1) * CIPHER_CHUNK);
    const swapped = concat(wire.subarray(0, PREFIX_BYTES), c(0), c(2), c(1));
    await expectCorrupt(openAll(swapped, key, size));
  });

  it("refuses duplicated chunks", async () => {
    const key = await newFileKey();
    const size = 3 * PLAIN_CHUNK;
    const wire = await sealAll(pattern(size), key);
    const c = (i: number) => wire.subarray(PREFIX_BYTES + i * CIPHER_CHUNK, PREFIX_BYTES + (i + 1) * CIPHER_CHUNK);
    const doubled = concat(wire.subarray(0, PREFIX_BYTES), c(0), c(1), c(1), c(2));
    await expectCorrupt(openAll(doubled, key, size));
  });

  it("refuses any byte after the final chunk", async () => {
    const key = await newFileKey();
    const wire = await sealAll(pattern(40), key);
    await expectCorrupt(openAll(concat(wire, new Uint8Array([0])), key, 40));
    const extra = await sealAll(pattern(40, 9), key);
    await expectCorrupt(openAll(concat(wire, extra), key, 40));
  });

  it("refuses the wrong magic and a wrong header", async () => {
    const key = await newFileKey();
    const wire = await sealAll(pattern(40), key);
    const badMagic = wire.slice();
    badMagic[7] = "3".charCodeAt(0); // NOTESF3
    await expectCorrupt(openAll(badMagic, key, 40));
    const badHeader = wire.slice();
    badHeader[PREFIX_BYTES - 1] ^= 1;
    await expectCorrupt(openAll(badHeader, key, 40));
    await expectCorrupt(openAll(wire.subarray(0, 10), key, 40));
  });
});

describe("file metadata", () => {
  it("seals with the vault key of an epoch and opens with it", async () => {
    const key = await aesKey();
    const ref: MetaRef = { keyEpoch: 3 };
    const text = await sealMeta(VAULT, FILE, ref, key, meta({ name: "Umowa.pdf", size: 12 }));
    expect(JSON.parse(text)).toMatchObject({ schema: "notes-file-meta-v2", keyEpoch: 3 });
    expect(text).not.toContain("Umowa");
    expect(metaRefOf(text)).toEqual({ keyEpoch: 3 });
    expect(await openMeta(VAULT, FILE, text, async () => key)).toMatchObject({ format: 2, version: 1, name: "Umowa.pdf", size: 12 });
  });

  it("seals with a project key under its scope and epoch", async () => {
    const key = await aesKey();
    const scope = await scopeOf(VAULT, "Projekty/X");
    const text = await sealMeta(VAULT, FILE, { scope, projectEpoch: 2 }, key, meta({ project: "Projekty/X" }));
    expect(metaRefOf(text)).toEqual({ scope, projectEpoch: 2 });
    expect(await openMeta(VAULT, FILE, text, async (ref) => ("scope" in ref ? key : null))).toMatchObject({ project: "Projekty/X" });
  });

  it("keeps the thumbnail links and the image size in the envelope", async () => {
    const key = await aesKey();
    const text = await sealMeta(VAULT, FILE, { keyEpoch: 1 }, key, meta({ thumb: "t".repeat(32), width: 640, height: 480 }));
    expect(await openMeta(VAULT, FILE, text, async () => key)).toMatchObject({ thumb: "t".repeat(32), width: 640, height: 480 });
    const thumb = await sealMeta(VAULT, "t".repeat(32), { keyEpoch: 1 }, key, meta({ thumbOf: FILE }));
    expect(await openMeta(VAULT, "t".repeat(32), thumb, async () => key)).toMatchObject({ thumbOf: FILE });
  });

  it("is not opened without a key (null), and throws when the key or the envelope is wrong", async () => {
    const key = await aesKey();
    const other = await aesKey();
    const text = await sealMeta(VAULT, FILE, { keyEpoch: 1 }, key, meta());
    expect(await openMeta(VAULT, FILE, text, async () => null)).toBeNull();
    await expect(openMeta(VAULT, FILE, text, async () => other)).rejects.toThrow();
    // another file id or vault: the AAD does not match
    await expect(openMeta(VAULT, "e".repeat(32), text, async () => key)).rejects.toThrow();
    await expect(openMeta(`v-${"b".repeat(32)}`, FILE, text, async () => key)).rejects.toThrow();
  });

  it("refuses a changed envelope and the old schema", async () => {
    const key = await aesKey();
    const text = await sealMeta(VAULT, FILE, { keyEpoch: 1 }, key, meta());
    const v = JSON.parse(text) as { ciphertext: string; schema: string };
    const bytes = base64ToBytes(v.ciphertext);
    bytes[3] ^= 1;
    await expect(openMeta(VAULT, FILE, JSON.stringify({ ...JSON.parse(text), ciphertext: btoa(String.fromCharCode(...bytes)) }), async () => key)).rejects.toThrow();
    await expect(openMeta(VAULT, FILE, JSON.stringify({ ...JSON.parse(text), schema: "notes-file-meta-v1" }), async () => key)).rejects.toThrow("Nieprawidłowe metadane");
  });

  it("refuses a plaintext that is not format 2", async () => {
    const key = await aesKey();
    const text = await sealMeta(VAULT, FILE, { keyEpoch: 1 }, key, { ...meta(), format: 1 } as unknown as FileMeta);
    await expect(openMeta(VAULT, FILE, text, async () => key)).rejects.toThrow("Nieprawidłowe metadane");
  });

  it("keeps the file key inside the envelope, and the file key opens the file", async () => {
    const key = await aesKey();
    const fileKey = await newFileKey();
    const text = await sealMeta(VAULT, FILE, { keyEpoch: 1 }, key, meta({ key: fileKey }));
    expect(text).not.toContain(fileKey);
    const opened = await openMeta(VAULT, FILE, text, async () => key);
    expect(opened?.key).toBe(fileKey);
    const data = pattern(64);
    expect(same(await openAll(await sealAll(data, opened!.key), opened!.key, 64), data)).toBe(true);
  });

  it("refuses an envelope over 4 KiB", async () => {
    const key = await aesKey();
    await expect(sealMeta(VAULT, FILE, { keyEpoch: 1 }, key, meta({ name: "x".repeat(5000) }))).rejects.toThrow("za długa");
  });

  it("keeps the key and the name out of the error messages", async () => {
    const key = await newFileKey();
    const wire = await sealAll(pattern(100), key);
    const bad = wire.slice();
    bad[PREFIX_BYTES + 50] ^= 1;
    await expectCorrupt(openAll(bad, key, 100), key);
    await expectCorrupt(openAll(wire, await newFileKey(), 100), key);
  });
});

describe("scopes and migration ids", () => {
  it("gives a stable 32-hex scope per vault and folder", async () => {
    const scope = await scopeOf(VAULT, "Projekty/X");
    expect(scope).toMatch(/^[0-9a-f]{32}$/);
    expect(await scopeOf(VAULT, "Projekty/X")).toBe(scope);
    expect(await scopeOf(VAULT, "Projekty/Y")).not.toBe(scope);
    expect(await scopeOf(`v-${"b".repeat(32)}`, "Projekty/X")).not.toBe(scope);
  });

  it("gives the same migration id for the same key and bytes, and another id for other bytes or key", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const id = await migrationId(secret, "assets/a.png", pattern(4, 1));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await migrationId(secret, "assets/a.png", pattern(4, 1))).toBe(id);
    expect(await migrationId(secret, "assets/a.png", pattern(4, 2))).not.toBe(id);
    expect(await migrationId(secret, "assets/b.png", pattern(4, 1))).not.toBe(id);
    expect(await migrationId(crypto.getRandomValues(new Uint8Array(32)), "assets/a.png", pattern(4, 1))).not.toBe(id);
  });
});

describe("metadata envelope head is authenticated", () => {
  it("rejects an envelope whose key epoch was relabelled", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const meta = { format: 2, version: 1, name: "a.txt", mime: "text/plain", size: 1, project: null, key: "AA==", createdAt: 1 } as const;
    const sealed = await sealMeta("v-1", "f".repeat(32), { keyEpoch: 1 }, key, meta);
    expect((await openMeta("v-1", "f".repeat(32), sealed, async () => key))?.name).toBe("a.txt");
    const relabelled = JSON.stringify({ ...JSON.parse(sealed), keyEpoch: 2 });
    await expect(openMeta("v-1", "f".repeat(32), relabelled, async () => key)).rejects.toThrow();
  });
});
