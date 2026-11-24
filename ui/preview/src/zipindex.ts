// The central directory of a ZIP file, read without unpacking anything (PODGLAD-PLAN §5): names and sizes only.
// Every offset and length is checked against the buffer; a bad file throws PreviewError("corrupt").
import { PreviewError } from "./viewers/index";

export interface ZipEntry { name: string; size: number; compressed: number; dir: boolean; encrypted: boolean }
export interface ZipIndex { entries: ZipEntry[]; total: number; more: boolean }

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const EOCD_SIZE = 22;
const EOCD_WINDOW = EOCD_SIZE + 0xffff; // the end record is followed by a comment of at most 65535 bytes
const LOCATOR_SIZE = 20;
const EOCD64_SIZE = 56;
const CENTRAL_SIZE = 46;
const ZIP64_EXTRA = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const TWO_32 = 0x100000000;
const FLAG_ENCRYPTED = 1;
const FLAG_UTF8 = 0x800;
const DOS_DIR = 0x10;

function corrupt(): never {
  throw new PreviewError("corrupt");
}

// Little-endian reads. Each one checks the bounds first, so a short or cut buffer throws instead of reading past it.
class Bytes {
  private readonly view: DataView;

  constructor(readonly b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  has(at: number, n: number): boolean {
    return at >= 0 && at + n <= this.b.byteLength;
  }

  u16(at: number): number {
    if (!this.has(at, 2)) corrupt();
    return this.view.getUint16(at, true);
  }

  u32(at: number): number {
    if (!this.has(at, 4)) corrupt();
    return this.view.getUint32(at, true);
  }

  u64(at: number): number {
    const v = this.u32(at + 4) * TWO_32 + this.u32(at);
    if (!Number.isSafeInteger(v)) corrupt();
    return v;
  }

  sig(at: number, s: number): boolean {
    return this.has(at, 4) && this.view.getUint32(at, true) === s;
  }
}

// The end record is the last signature that leaves room for its comment inside the buffer.
function findEocd(z: Bytes): number {
  const len = z.b.byteLength;
  for (let at = len - EOCD_SIZE; at >= 0 && at >= len - EOCD_WINDOW; at--) {
    if (z.sig(at, SIG_EOCD) && at + EOCD_SIZE + z.u16(at + 20) <= len) return at;
  }
  return -1;
}

// Offset of the ZIP64 end record, found through the locator that sits just before the end record.
function zip64Record(z: Bytes, eocd: number): number {
  const locator = eocd - LOCATOR_SIZE;
  if (locator < 0 || !z.sig(locator, SIG_LOCATOR)) corrupt();
  const at = z.u64(locator + 8);
  if (!z.has(at, EOCD64_SIZE) || !z.sig(at, SIG_EOCD64)) corrupt();
  return at;
}

// The 64-bit values of the ZIP64 extra field (id 0x0001), in order. Values are present only where the 32-bit field is 0xFFFFFFFF.
function zip64Values(extra: Uint8Array): number[] {
  const z = new Bytes(extra);
  for (let at = 0; at + 4 <= extra.byteLength; ) {
    const id = z.u16(at);
    const len = z.u16(at + 2);
    const body = at + 4;
    if (body + len > extra.byteLength) corrupt();
    if (id === ZIP64_EXTRA) {
      const values: number[] = [];
      for (let p = body; p + 8 <= body + len; p += 8) values.push(z.u64(p));
      return values;
    }
    at = body + len;
  }
  return [];
}

// Names with bit 11 are UTF-8. Without it, valid UTF-8 is still taken as UTF-8; otherwise each byte is one character.
// shortcut: legacy DOS names (CP437/CP852) come out as Latin-1 characters, upgrade if such archives show up.
function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    if (utf8Flag) return new TextDecoder().decode(raw);
    return Array.from(raw, (c) => String.fromCharCode(c)).join("");
  }
}

export function readZipIndex(bytes: Uint8Array, maxEntries: number): ZipIndex {
  const z = new Bytes(bytes);
  const eocd = findEocd(z);
  if (eocd < 0) corrupt();
  let count = z.u16(eocd + 10);
  let cdSize = z.u32(eocd + 12);
  let cdOffset = z.u32(eocd + 16);
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const at = zip64Record(z, eocd);
    count = z.u64(at + 32);
    cdSize = z.u64(at + 40);
    cdOffset = z.u64(at + 48);
  }
  if (!z.has(cdOffset, cdSize)) corrupt();
  const cdEnd = cdOffset + cdSize;
  const n = Math.min(count, Math.max(0, maxEntries));
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < n; i++) {
    if (at + CENTRAL_SIZE > cdEnd || !z.sig(at, SIG_CENTRAL)) corrupt();
    const flags = z.u16(at + 8);
    let compressed = z.u32(at + 20);
    let size = z.u32(at + 24);
    const nameLen = z.u16(at + 28);
    const extraLen = z.u16(at + 30);
    const commentLen = z.u16(at + 32);
    const attrs = z.u32(at + 38);
    const nameAt = at + CENTRAL_SIZE;
    const extraAt = nameAt + nameLen;
    const next = extraAt + extraLen + commentLen;
    if (next > cdEnd) corrupt();
    if (size === U32_MAX || compressed === U32_MAX) {
      const values = zip64Values(bytes.subarray(extraAt, extraAt + extraLen));
      let k = 0;
      if (size === U32_MAX) size = values[k++] ?? corrupt();
      if (compressed === U32_MAX) compressed = values[k++] ?? corrupt();
    }
    const name = decodeName(bytes.subarray(nameAt, extraAt), (flags & FLAG_UTF8) !== 0);
    const dir = name.endsWith("/") || (attrs & DOS_DIR) !== 0;
    entries.push({ name, size, compressed, dir, encrypted: (flags & FLAG_ENCRYPTED) !== 0 });
    at = next;
  }
  return { entries, total: count, more: count > n };
}

export const OOXML_MAX_UNPACKED = 300 * 1024 * 1024;
export const OOXML_MAX_ENTRIES = 10_000;

/** Before a library unpacks an Office file (a ZIP): too many entries or too many bytes once unpacked, declared in the
 * central directory, is "too-large", so a zip bomb never reaches the library. A damaged directory is "corrupt". */
export function guardZip(bytes: Uint8Array, maxUnpacked = OOXML_MAX_UNPACKED, maxEntries = OOXML_MAX_ENTRIES): void {
  const index = readZipIndex(bytes, maxEntries);
  if (index.more) throw new PreviewError("too-large");
  let unpacked = 0;
  for (const entry of index.entries) {
    unpacked += entry.size;
    if (unpacked > maxUnpacked) throw new PreviewError("too-large");
  }
}
