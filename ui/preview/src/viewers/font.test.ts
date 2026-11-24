import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fontFacts } from "./font";

const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(resolve(import.meta.dirname, "../../../../fixtures/preview", name));
  return new Uint8Array(b).buffer;
};
const NONE = { family: null, style: null, glyphs: null, version: null };

describe("fontFacts", () => {
  it("TTF: rodzina, liczba glifów", () => {
    const facts = fontFacts(fixture("font.ttf"));
    expect(facts.family).toBe("Podgląd Test");
    expect(facts.glyphs).toBe(82);
  });

  it("WOFF czytany przez opentype.js tak samo jak TTF", () => {
    expect(fontFacts(fixture("font.woff")).family).toBe("Podgląd Test");
  });

  it("losowe bajty → same nulle, bez wyjątku", () => {
    let seed = 3;
    const noise = new Uint8Array(512).map(() => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    });
    expect(fontFacts(noise.buffer)).toEqual(NONE);
  });

  it("nagłówek wOF2 → same nulle (opentype.js nie czyta WOFF2)", () => {
    const bytes = new Uint8Array(256);
    bytes.set([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
    expect(fontFacts(bytes.buffer)).toEqual(NONE);
  });
});
