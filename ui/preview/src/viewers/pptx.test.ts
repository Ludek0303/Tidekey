// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pptxOffline } from "../../vite-offline";
import { guardZip } from "../zipindex";
import { slideWidth } from "./pptx";

const LIB = resolve(import.meta.dirname, "../../../node_modules/pptx-browser/src/index.js");
const CALL = "await loadGoogleFontsFor(usedFonts, this.themeData);";
const FIXTURE = resolve(import.meta.dirname, "../../../../fixtures/preview/prezentacja.pptx");

// What Rollup gives a transform hook as `this`: the plugin uses only error().
const ctx = {
  error: (msg: string): never => {
    throw new Error(msg);
  },
};
const transform = (code: string, id: string): string | null | undefined =>
  (pptxOffline().transform as (this: typeof ctx, code: string, id: string) => string | null).call(ctx, code, id);

describe("pptxOffline (wtyczka Vite)", () => {
  it("usuwa wywołanie Google Fonts i nic poza nim", () => {
    const src = readFileSync(LIB, "utf8");
    const out = transform(src, LIB) as string;
    expect(out).not.toContain(CALL);
    expect(out).toContain("/* fonts: offline (preview frame) */");
    const before = src.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
  });

  it("inne pliki zostają bez zmian", () => {
    expect(transform("const a = 1;", "/x/node_modules/pptx-browser/src/slideshow.js")).toBeNull();
  });

  it("render.js: defRPr declared before the bullet reads it, nothing else changes", () => {
    const file = LIB.replace(/index\.js$/, "render.js");
    const src = readFileSync(file, "utf8");
    const out = transform(src, file) as string;
    const decl = out.indexOf("const defRPr = g1(pPr, 'defRPr');");
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(out.indexOf("const bullet = pPr ? parseBullet(pPr, defRPr, themeColors, themeData) : null;"));
    expect(out.split("const defRPr = g1(pPr, 'defRPr');")).toHaveLength(2);
    expect(out.length).toBe(src.length);
    expect(() => transform("const a = 1;", file)).toThrow();
  });

  it("bez wzorca (inna wersja biblioteki) budowa się przerywa", () => {
    expect(() => transform("const a = 1;", LIB)).toThrow();
  });
});

describe("slideWidth", () => {
  it("szerokość obszaru razy zagęszczenie pikseli", () => {
    expect(slideWidth(800, 1)).toBe(800);
    expect(slideWidth(800, 2)).toBe(1600);
    expect(slideWidth(333.4, 1.5)).toBe(500);
  });

  it("nie więcej niż 1920 px", () => {
    expect(slideWidth(1200, 2)).toBe(1920);
    expect(slideWidth(1920, 1)).toBe(1920);
  });

  it("nie mniej niż 1 px", () => {
    expect(slideWidth(0, 1)).toBe(1);
  });
});

describe("guardZip na prezentacji", () => {
  it("przepuszcza prezentacja.pptx", () => {
    expect(() => guardZip(new Uint8Array(readFileSync(FIXTURE)))).not.toThrow();
  });
});
