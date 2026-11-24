// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cropQuad } from "./crop";
import { recBatchTensor } from "./crop";
import type { Rgb } from "./image";
import type { Quad } from "./db";

function image(width: number, height: number, fn: (x: number, y: number) => [number, number, number]): Rgb {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([...fn(x, y), 255], (y * width + x) * 4);
  return { width, height, data };
}

const quad = (pts: Quad["pts"]): Quad => ({ pts, score: 1 });

describe("cropQuad", () => {
  it("cuts an axis-aligned quad to the same sub-image", () => {
    const src = image(10, 8, (x, y) => [x * 20, y * 30, (x + y) * 10]);
    const out = cropQuad(src, quad([[2, 1], [6, 1], [6, 4], [2, 4]]));
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++)
        for (let c = 0; c < 3; c++) {
          const want = src.data[((y + 1) * 10 + (x + 2)) * 4 + c];
          expect(Math.abs(out.data[(y * 4 + x) * 4 + c] - want)).toBeLessThanOrEqual(1);
        }
  });

  it("rotates a tall crop 90 degrees counter-clockwise", () => {
    // quad 3 px wide and 9 px tall: h/w = 3 >= 1.5, so the result is 9 wide and 3 tall
    const src = image(8, 16, (x, y) => (x === 6 && y === 2 ? [255, 255, 255] : [0, 0, 0]));
    const out = cropQuad(src, quad([[4, 2], [7, 2], [7, 11], [4, 11]]));
    expect(out.width).toBe(9);
    expect(out.height).toBe(3);
    // the top-right corner of the upright crop (source x=6, y=2) ends up top-left after the rotation
    expect(out.data[0]).toBeGreaterThanOrEqual(250);
  });
});

describe("recBatchTensor", () => {
  it("scales each crop to height 48 and pads the batch to at least 320 wide", () => {
    const wide = image(100, 50, () => [128, 128, 128]); // width ceil(48*2) = 96
    const narrow = image(10, 50, () => [128, 128, 128]); // width ceil(9.6) = 10
    const t = recBatchTensor([wide, narrow]);
    expect(t.dims).toEqual([2, 3, 48, 320]);
    expect(t.data.length).toBe(2 * 3 * 48 * 320);
  });

  it("keeps the widest crop when it is wider than 320", () => {
    const t = recBatchTensor([image(1000, 48, () => [0, 0, 0])]);
    expect(t.dims).toEqual([1, 3, 48, 1000]);
  });

  it("normalizes to [-1, 1], puts blue first and pads with zeros", () => {
    const red = image(10, 48, () => [255, 0, 0]);
    const t = recBatchTensor([red]);
    const plane = 48 * 320;
    expect(t.data[5]).toBeCloseTo(-1, 5); // blue plane, red pixel has blue 0
    expect(t.data[2 * plane + 5]).toBeCloseTo(1, 5); // red plane
    expect(t.data[11]).toBe(0); // past the 10 px crop
  });
});
