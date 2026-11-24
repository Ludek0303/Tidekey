// Checks a TIFF before UTIF decodes it (the extractor frame and the TIFF viewer). UTIF follows IFD chains and the
// SubIFD, Exif and DNG pointers with no loop check, and reads tag values of any count, all synchronously, so a hostile
// file can hang or exhaust memory inside UTIF.decode. This walks the same structure with bounds first; UTIF runs only
// on a file that passed.
import UTIF, { type Ifd } from "utif";

export type TiffRefusal = "corrupt" | "too-large" | "unsupported";

export class TiffError extends Error {
  constructor(readonly code: TiffRefusal) {
    super(code);
    this.name = "TiffError";
  }
}

const TAG_SUB_IFDS = 330;
const TAG_EXIF_IFD = 34665;
const TAG_DNG_PRIVATE = 50740;
const MAX_SAMPLES = 5;
const MAX_BITS = 16;
const MAX_TILE = 4096;
// bytes per value of the types UTIF reads as offsets (SubIFDs and Exif pointers)
const OFFSET_WIDTH: Record<number, number> = { 1: 1, 3: 2, 4: 4, 7: 1 };
// bytes per value of each TIFF type; unknown types carry no values
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

function refuse(code: TiffRefusal): never {
  throw new TiffError(code);
}

/**
 * The IFDs of a classic TIFF, as UTIF reads them. Throws TiffError: "unsupported" for BigTIFF; "corrupt" for a loop, an
 * IFD listed twice, a tag value or entry outside the file; "too-large" for more than maxPages IFDs in the chain or more
 * than four times that counting sub-IFDs.
 */
export function readTiffIfds(bytes: ArrayBuffer, maxPages: number): Ifd[] {
  const view = new DataView(bytes);
  const size = view.byteLength;
  if (size < 8) refuse("corrupt");
  const [a, b] = [view.getUint8(0), view.getUint8(1)];
  const le = a === 0x49 && b === 0x49;
  if (!le && !(a === 0x4d && b === 0x4d)) refuse("corrupt");
  const magic = view.getUint16(2, le);
  if (magic === 43) refuse("unsupported");
  if (magic !== 42) refuse("corrupt");

  const need = (at: number, n: number): void => {
    if (at < 0 || at + n > size) refuse("corrupt");
  };
  const u16 = (at: number): number => {
    need(at, 2);
    return view.getUint16(at, le);
  };
  const u32 = (at: number): number => {
    need(at, 4);
    return view.getUint32(at, le);
  };
  const offsetAt = (at: number, width: number): number => {
    need(at, width);
    return width === 1 ? view.getUint8(at) : width === 2 ? view.getUint16(at, le) : view.getUint32(at, le);
  };

  const seen = new Set<number>();
  const maxIfds = 4 * (maxPages + 1);
  // Reads one IFD and, as UTIF does, its sub-IFDs. Returns the offset of the IFD's next-IFD pointer.
  const visit = (at: number): number => {
    if (seen.has(at)) refuse("corrupt");
    if (seen.size >= maxIfds) refuse("too-large");
    seen.add(at);
    const count = u16(at);
    need(at, 2 + 12 * count);
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + 12 * i;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      const bytesLen = n * (TYPE_SIZE[type] ?? 0);
      // the values sit in the entry when they fit in four bytes, else at the offset in it
      const valueAt = bytesLen > 4 ? u32(entry + 8) : entry + 8;
      need(valueAt, bytesLen);
      if ((tag === TAG_SUB_IFDS || tag === TAG_EXIF_IFD) && OFFSET_WIDTH[type]) {
        const width = OFFSET_WIDTH[type];
        for (let j = 0; j < n; j++) visit(offsetAt(valueAt + j * width, width));
      } else if (tag === TAG_DNG_PRIVATE && (type === 1 || type === 7) && n >= 4) {
        const sub = u32(valueAt);
        if (u16(sub) < 300) visit(sub);
      }
    }
    return at + 2 + 12 * count;
  };

  let next = u32(4);
  for (let chain = 1; next !== 0; chain++) {
    if (chain > maxPages) refuse("too-large");
    next = u32(visit(next));
  }
  try {
    return UTIF.decode(bytes);
  } catch {
    return refuse("corrupt");
  }
}

/** The size, sample and tile limits of an image page, before UTIF decodes its pixels. Throws TiffError. */
export function checkTiffPage(ifd: Ifd, maxPixels: number): void {
  const width = ifd.t256?.[0] ?? 0;
  const height = ifd.t257?.[0] ?? 0;
  if (!(width >= 1 && height >= 1)) refuse("corrupt");
  if (width * height > maxPixels) refuse("too-large");
  const samples = ifd.t277?.[0] ?? 1;
  if (!(samples >= 1 && samples <= MAX_SAMPLES)) refuse("corrupt");
  if (ifd.t258?.some((bits) => !(bits >= 1 && bits <= MAX_BITS))) refuse("corrupt");
  const tileWidth = ifd.t322?.[0];
  const tileHeight = ifd.t323?.[0];
  if (tileWidth !== undefined && !(tileWidth >= 1 && tileWidth <= Math.min(width, MAX_TILE))) refuse("corrupt");
  if (tileHeight !== undefined && !(tileHeight >= 1 && tileHeight <= Math.min(height, MAX_TILE))) refuse("corrupt");
}
