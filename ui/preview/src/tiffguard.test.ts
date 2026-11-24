// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTiffPage, readTiffIfds, TiffError } from "./tiffguard";

const FIXTURE = new URL("../../../fixtures/ocr/wielostronicowy.tiff", import.meta.url);

type Entry = [tag: number, type: number, count: number, value: number];
interface Ifd { entries: Entry[]; next?: number }

// Little-endian classic TIFF; the IFDs follow the header one after another. `next` overrides the pointer of an IFD.
function tiff(ifds: Ifd[], magic = 42): ArrayBuffer {
  const starts: number[] = [];
  let at = 8;
  for (const ifd of ifds) {
    starts.push(at);
    at += 2 + 12 * ifd.entries.length + 4;
  }
  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49]);
  view.setUint16(2, magic, true);
  view.setUint32(4, starts[0] ?? 0, true);
  ifds.forEach((ifd, i) => {
    const start = starts[i];
    view.setUint16(start, ifd.entries.length, true);
    ifd.entries.forEach(([tag, type, count, value], e) => {
      const o = start + 2 + 12 * e;
      view.setUint16(o, tag, true);
      view.setUint16(o + 2, type, true);
      view.setUint32(o + 4, count, true);
      view.setUint32(o + 8, value, true);
    });
    view.setUint32(start + 2 + 12 * ifd.entries.length, ifd.next ?? starts[i + 1] ?? 0, true);
  });
  return out.buffer;
}

const PAGE: Entry[] = [
  [256, 3, 1, 8],
  [257, 3, 1, 8],
  [258, 3, 1, 8],
  [259, 3, 1, 1],
  [262, 3, 1, 1],
  [273, 4, 1, 0],
  [277, 3, 1, 1],
  [278, 3, 1, 8],
  [279, 4, 1, 0],
];

/** The code of the refusal a call throws, or "none" when it passes. */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    return err instanceof TiffError ? err.code : "other";
  }
}

describe("readTiffIfds", () => {
  it("IFD wskazujący na siebie: odrzucony od razu jako corrupt", () => {
    const bytes = tiff([{ entries: PAGE, next: 8 }]);
    const started = performance.now();
    expect(refusal(() => readTiffIfds(bytes, 300))).toBe("corrupt");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("dwa IFD na siebie nawzajem (pętla dłuższa) też jest corrupt", () => {
    const bytes = tiff([{ entries: PAGE, next: 8 + 2 + 12 * 9 + 4 }, { entries: PAGE, next: 8 }]);
    expect(refusal(() => readTiffIfds(bytes, 300))).toBe("corrupt");
  });

  it("pętla przez SubIFDs (tag 330) jest corrupt", () => {
    const bytes = tiff([{ entries: [...PAGE, [330, 4, 1, 8]] }]);
    expect(refusal(() => readTiffIfds(bytes, 300))).toBe("corrupt");
  });

  it("tag z liczbą wartości 2^32-1 wykracza poza bufor: corrupt", () => {
    const bytes = tiff([{ entries: [[273, 4, 0xffffffff, 8]] }]);
    expect(refusal(() => readTiffIfds(bytes, 300))).toBe("corrupt");
  });

  it("wartość tagu poza buforem (offset) jest corrupt", () => {
    const bytes = tiff([{ entries: [[273, 4, 100, 0xfffff000]] }]);
    expect(refusal(() => readTiffIfds(bytes, 300))).toBe("corrupt");
  });

  it("więcej IFD w łańcuchu niż maxPages: too-large", () => {
    const bytes = tiff([{ entries: PAGE }, { entries: PAGE }, { entries: PAGE }]);
    expect(refusal(() => readTiffIfds(bytes, 1))).toBe("too-large");
  });

  it("BigTIFF (magia 43) nieobsługiwany", () => {
    const bytes = tiff([{ entries: PAGE }], 43);
    expect(refusal(() => readTiffIfds(bytes, 300))).toBe("unsupported");
  });

  it("zła kolejność bajtów i śmieci: corrupt", () => {
    expect(refusal(() => readTiffIfds(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 300))).toBe("corrupt");
    expect(refusal(() => readTiffIfds(new Uint8Array(4).buffer, 300))).toBe("corrupt");
  });

  it("wielostronicowy TIFF z fixtures/ocr: dwie strony, każda przechodzi kontrolę", () => {
    const bytes = readFileSync(FIXTURE);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const ifds = readTiffIfds(buffer, 300).filter((ifd) => ifd.t256 && ifd.t257);
    expect(ifds).toHaveLength(2);
    for (const ifd of ifds) expect(refusal(() => checkTiffPage(ifd, 50_000_000))).toBe("none");
  });
});

describe("checkTiffPage", () => {
  it("zwykła strona przechodzi", () => {
    expect(refusal(() => checkTiffPage({ t256: [2480], t257: [3508], t258: [1], t277: [1] }, 50_000_000))).toBe("none");
  });

  it("za dużo pikseli: too-large", () => {
    expect(refusal(() => checkTiffPage({ t256: [100000], t257: [100000] }, 50_000_000))).toBe("too-large");
  });

  it("zerowy albo brakujący wymiar: corrupt", () => {
    expect(refusal(() => checkTiffPage({ t256: [0], t257: [10] }, 1000))).toBe("corrupt");
    expect(refusal(() => checkTiffPage({ t256: [10], t257: [Number.NaN] }, 1000))).toBe("corrupt");
  });

  it("więcej niż 5 próbek na piksel: corrupt", () => {
    expect(refusal(() => checkTiffPage({ t256: [10], t257: [10], t277: [6] }, 1000))).toBe("corrupt");
    expect(refusal(() => checkTiffPage({ t256: [10], t257: [10], t277: [5] }, 1000))).toBe("none");
  });

  it("więcej niż 16 bitów na próbkę: corrupt", () => {
    expect(refusal(() => checkTiffPage({ t256: [10], t257: [10], t258: [8, 32, 8] }, 1000))).toBe("corrupt");
    expect(refusal(() => checkTiffPage({ t256: [10], t257: [10], t258: [16] }, 1000))).toBe("none");
  });

  it("kafel większy niż obraz albo ponad 4096: corrupt", () => {
    expect(refusal(() => checkTiffPage({ t256: [100], t257: [50], t322: [200] }, 1e9))).toBe("corrupt");
    expect(refusal(() => checkTiffPage({ t256: [100], t257: [50], t323: [60] }, 1e9))).toBe("corrupt");
    expect(refusal(() => checkTiffPage({ t256: [10000], t257: [10000], t322: [8192], t323: [256] }, 1e9))).toBe("corrupt");
    expect(refusal(() => checkTiffPage({ t256: [100], t257: [100], t322: [64], t323: [64] }, 1e9))).toBe("none");
  });
});
