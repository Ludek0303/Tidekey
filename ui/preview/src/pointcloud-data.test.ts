// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { heightColors, kindOf, readCloud, sampleStep, subsample, type Cloud } from "./pointcloud-data";
import { PreviewError } from "./viewers/index";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/preview");

// A copy made by the typed array constructor: under jsdom a Buffer's ArrayBuffer is not `instanceof ArrayBuffer`,
// and loaders.gl (PLY) checks for that.
function fixture(name: string): ArrayBuffer {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name))).buffer;
}

function bytesOf(text: string): ArrayBuffer {
  return new Uint8Array(new TextEncoder().encode(text)).buffer;
}

// n points on a line: point i has x = i, y = 0, z = 0 and the colour (i, 0, 0).
function line(n: number): Cloud {
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = i;
    colors[i * 3] = i % 256;
  }
  return { positions, colors, count: n, bounds: { min: [0, 0, 0], max: [Math.max(0, n - 1), 0, 0] } };
}

describe("subsample", () => {
  it("keeps every point when the cloud is within the limit", () => {
    const cloud = line(5);
    expect(subsample(cloud, 10)).toBe(cloud);
  });

  it("keeps every point when the count is exactly the limit", () => {
    expect(subsample(line(10), 10).count).toBe(10);
  });

  it("takes every third point when the count is three times the limit", () => {
    const out = subsample(line(30), 10);
    expect(out.count).toBe(10);
    expect(Array.from(out.positions.subarray(0, 6))).toEqual([0, 0, 0, 3, 0, 0]);
    expect(out.colors?.length).toBe(30);
    expect(out.colors?.[3]).toBe(3);
  });

  it("never returns more than the limit, also just past it", () => {
    const out = subsample(line(11), 10);
    expect(out.count).toBeLessThanOrEqual(10);
    expect(out.positions.length).toBe(out.count * 3);
    expect(out.colors?.length).toBe(out.count * 3);
  });

  it("works without colours", () => {
    const cloud = { ...line(30), colors: null };
    expect(subsample(cloud, 10).colors).toBeNull();
  });
});

describe("sampleStep", () => {
  it("is 1 up to the limit, then the smallest step that fits", () => {
    expect(sampleStep(10, 10)).toBe(1);
    expect(sampleStep(11, 10)).toBe(2);
    expect(sampleStep(30, 10)).toBe(3);
  });
});

describe("heightColors", () => {
  it("maps the lowest point to the low colour and the highest to the high colour", () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 5, 0, 0, 10]);
    const out = heightColors(positions, 2, 0, 10, "#000000", "#ffffff");
    expect(Array.from(out)).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255]);
  });

  it("reads the axis it is given", () => {
    const positions = new Float32Array([0, 0, 0, 0, 10, 0]);
    const out = heightColors(positions, 1, 0, 10, "#102030", "#405060");
    expect(Array.from(out.subarray(3))).toEqual([0x40, 0x50, 0x60]);
  });

  it("clamps values outside min and max", () => {
    const out = heightColors(new Float32Array([0, 0, -5, 0, 0, 50]), 2, 0, 10, "#000000", "#ff0000");
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 0, 0]);
  });

  it("gives a flat cloud the low colour without dividing by zero", () => {
    const out = heightColors(new Float32Array([1, 2, 7, 3, 4, 7]), 2, 7, 7, "#101010", "#f0f0f0");
    expect(Array.from(out)).toEqual([0x10, 0x10, 0x10, 0x10, 0x10, 0x10]);
  });
});

describe("kindOf", () => {
  it("recognises the three formats from their bytes", () => {
    expect(kindOf(new Uint8Array(fixture("chmura.las")), "x.bin")).toBe("las");
    expect(kindOf(new Uint8Array(fixture("chmura.pcd")), "x.bin")).toBe("pcd");
    expect(kindOf(new Uint8Array(fixture("chmura.ply")), "x.bin")).toBe("ply");
  });

  it("falls back to the file name when the bytes have no signature", () => {
    const bytes = new TextEncoder().encode("0 0 0\n");
    expect(kindOf(bytes, "punkty.LAZ")).toBe("las");
    expect(kindOf(bytes, "punkty.pcd")).toBe("pcd");
    expect(kindOf(bytes, "punkty.ply")).toBe("ply");
  });

  it("returns null for anything else", () => {
    expect(kindOf(new TextEncoder().encode("zwykły tekst"), "notatka.txt")).toBeNull();
  });
});

describe("readCloud", () => {
  it.each([
    ["chmura.las", 20000],
    ["chmura.pcd", 10000],
    ["chmura.ply", 20000],
  ])("reads %s with %i points", async (name, count) => {
    const { cloud, total } = await readCloud(fixture(name), name);
    expect(total).toBe(count);
    expect(cloud.count).toBe(count);
    expect(cloud.positions.length).toBe(count * 3);
    expect(cloud.colors?.length).toBe(count * 3);
  });

  it("reads the 16-bit colours of a LAS file as 8-bit RGB", async () => {
    // the first record holds RGB 50432, 28416, 55808 (LAS colours are 16-bit): 197, 111, 218 once divided by 256
    const { cloud } = await readCloud(fixture("chmura.las"), "chmura.las");
    expect(Array.from(cloud.colors?.subarray(0, 3) ?? [])).toEqual([197, 111, 218]);
  });

  it("gives bounds that contain every point", async () => {
    const { cloud } = await readCloud(fixture("chmura.las"), "chmura.las");
    const { min, max } = cloud.bounds;
    for (let i = 0; i < cloud.count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = cloud.positions[i * 3 + a];
        expect(v).toBeGreaterThanOrEqual(min[a]);
        expect(v).toBeLessThanOrEqual(max[a]);
      }
    }
  });

  it("refuses a LAS 1.4 file as unsupported", async () => {
    const bytes = new Uint8Array(fixture("chmura.las")).slice();
    bytes[25] = 4;
    await expect(readCloud(bytes.buffer, "chmura.las")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refuses a LAS header with more than 50 million points before parsing", async () => {
    const bytes = new Uint8Array(fixture("chmura.las")).slice();
    new DataView(bytes.buffer).setUint32(107, 60_000_000, true);
    const err = await readCloud(bytes.buffer, "chmura.las").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect((err as PreviewError).code).toBe("too-large");
  });

  it("refuses a PCD header with more than 50 million points before parsing", async () => {
    const text = new TextDecoder().decode(fixture("chmura.pcd")).replace(/^POINTS \d+$/m, "POINTS 60000000");
    await expect(readCloud(bytesOf(text), "chmura.pcd")).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses bytes it does not know as unsupported", async () => {
    await expect(readCloud(bytesOf("abc"), "abc.txt")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports a truncated LAS file as corrupt", async () => {
    const cut = fixture("chmura.las").slice(0, 300);
    await expect(readCloud(cut, "chmura.las")).rejects.toMatchObject({ code: "corrupt" });
  });
});
