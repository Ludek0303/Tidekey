// Image dimensions from the file header, without decoding. Every read checks the bounds and returns null
// past the end, so a cut or hostile file gives null, never an exception.

export interface ImageSize { width: number; height: number }

const has = (b: Uint8Array, at: number, n: number): boolean => at >= 0 && at + n <= b.length;
const u8 = (b: Uint8Array, at: number): number | null => (has(b, at, 1) ? b[at] : null);
const u16be = (b: Uint8Array, at: number): number | null => (has(b, at, 2) ? (b[at] << 8) | b[at + 1] : null);
const u16le = (b: Uint8Array, at: number): number | null => (has(b, at, 2) ? b[at] | (b[at + 1] << 8) : null);
const u24le = (b: Uint8Array, at: number): number | null =>
  has(b, at, 3) ? b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) : null;
const u32be = (b: Uint8Array, at: number): number | null =>
  has(b, at, 4) ? b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) : null;
const u32le = (b: Uint8Array, at: number): number | null =>
  has(b, at, 4) ? b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24) : null;
const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (!has(b, at, s.length)) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

function dims(width: number | null, height: number | null): ImageSize | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

function png(b: Uint8Array): ImageSize | null {
  if (!ascii(b, 0, "\x89PNG\r\n\x1a\n") || !ascii(b, 12, "IHDR")) return null;
  return dims(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageSize | null {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return null;
  return dims(u16le(b, 6), u16le(b, 8));
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (u8(b, 0) !== 0xff || u8(b, 1) !== 0xd8) return null;
  let p = 2;
  while (u8(b, p) === 0xff) {
    let marker = u8(b, p + 1);
    // fill bytes before a marker
    while (marker === 0xff) {
      p++;
      marker = u8(b, p + 1);
    }
    if (marker === null) return null;
    // standalone markers carry no length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      p += 2;
      continue;
    }
    // end of image or start of scan: no frame header came before it
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = u16be(b, p + 2);
    if (len === null || len < 2) return null;
    // C4 (DHT), C8 (JPG) and CC (DAC) are not frame headers
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (len < 8) return null;
      return dims(u16be(b, p + 7), u16be(b, p + 5));
    }
    p += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8X")) {
    // canvas size minus one, 24 bits each
    const w = u24le(b, 24);
    const h = u24le(b, 27);
    return dims(w === null ? null : w + 1, h === null ? null : h + 1);
  }
  if (ascii(b, 12, "VP8L")) {
    if (u8(b, 20) !== 0x2f) return null;
    const v = u32le(b, 21);
    if (v === null) return null;
    return dims((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8 ")) {
    if (!ascii(b, 23, "\x9d\x01\x2a")) return null;
    const w = u16le(b, 26);
    const h = u16le(b, 28);
    return dims(w === null ? null : w & 0x3fff, h === null ? null : h & 0x3fff);
  }
  return null;
}

function bmp(b: Uint8Array): ImageSize | null {
  if (!ascii(b, 0, "BM")) return null;
  const header = u32le(b, 14);
  if (header === null) return null;
  // BITMAPCOREHEADER stores unsigned 16-bit sizes; the later headers store signed 32-bit ones (negative height = top-down)
  if (header === 12) return dims(u16le(b, 18), u16le(b, 20));
  const w = u32le(b, 18);
  const h = u32le(b, 22);
  return dims(w === null ? null : w | 0, h === null ? null : Math.abs(h | 0));
}

function avif(b: Uint8Array): ImageSize | null {
  if (!ascii(b, 4, "ftyp")) return null;
  // the ispe boxes (image spatial extents) are near the start; their type is at p, width and height follow the version/flags.
  // A grid image has one per tile and one for the whole picture, so the largest one is the image.
  const end = Math.min(b.length, 64 * 1024);
  let best: ImageSize | null = null;
  for (let p = 4; p + 4 <= end; p++) {
    if (b[p] !== 0x69 || !ascii(b, p, "ispe")) continue;
    const size = dims(u32be(b, p + 8), u32be(b, p + 12));
    if (size && (!best || size.width * size.height > best.width * best.height)) best = size;
  }
  return best;
}

/** Width and height from the header of a PNG, JPEG, GIF, WebP, BMP or AVIF file; null when the header does not say. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes) ?? bmp(bytes) ?? avif(bytes);
}
