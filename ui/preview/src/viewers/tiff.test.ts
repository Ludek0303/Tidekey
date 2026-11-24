// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PreviewError } from "./index";
import { tiffPages } from "./tiff";

const FIXTURE = new URL("../../../../fixtures/preview/obraz.tiff", import.meta.url);

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Little-endian TIFF with one IFD per entry of `pages`: 9 tags each, uncompressed 8-bit gray strips of zeros.
function tiffWith(pages: { width: number; height: number }[]): ArrayBuffer {
  const ifdSize = 2 + 9 * 12 + 4;
  const dataStart = 8 + ifdSize * pages.length;
  const out = new Uint8Array(dataStart + pages.reduce((n, p) => n + p.width * p.height, 0));
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, 8, true);
  let data = dataStart;
  pages.forEach((page, i) => {
    const at = 8 + i * ifdSize;
    const strip = page.width * page.height;
    const entries: [number, number, number, number][] = [
      [256, 3, 1, page.width],
      [257, 3, 1, page.height],
      [258, 3, 1, 8],
      [259, 3, 1, 1],
      [262, 3, 1, 1],
      [273, 4, 1, data],
      [277, 3, 1, 1],
      [278, 3, 1, page.height],
      [279, 4, 1, strip],
    ];
    view.setUint16(at, entries.length, true);
    entries.forEach(([tag, type, count, value], e) => {
      const o = at + 2 + e * 12;
      view.setUint16(o, tag, true);
      view.setUint16(o + 2, type, true);
      view.setUint32(o + 4, count, true);
      view.setUint32(o + 8, value, true);
    });
    view.setUint32(at + 2 + entries.length * 12, i + 1 < pages.length ? at + ifdSize : 0, true);
    data += strip;
  });
  return out.buffer;
}

describe("tiffPages", () => {
  it("obraz.tiff: jedna strona 320 × 240 (jak file i Pillow)", () => {
    const bytes = toBuffer(readFileSync(FIXTURE));
    expect(tiffPages(bytes)).toEqual([{ width: 320, height: 240 }]);
  });

  it("TIFF z dwoma IFD: dwie strony z własnymi wymiarami", () => {
    const pages = tiffPages(tiffWith([{ width: 4, height: 3 }, { width: 2, height: 2 }]));
    expect(pages).toEqual([{ width: 4, height: 3 }, { width: 2, height: 2 }]);
  });

  it("losowe bajty: corrupt", () => {
    const junk = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 0xff);
    let code: unknown = null;
    try {
      tiffPages(toBuffer(junk));
    } catch (err) {
      code = err instanceof PreviewError ? err.code : err;
    }
    expect(code).toBe("corrupt");
  });
});
