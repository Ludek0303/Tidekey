// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detTensor, type Rgb } from "./image";

function solid(width: number, height: number, rgb: [number, number, number]): Rgb {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { width, height, data };
}

describe("detTensor", () => {
  it("upscales a 2x2 image to the 32 px minimum and normalizes in BGR order", () => {
    const t = detTensor(solid(2, 2, [255, 255, 255]), 960);
    expect(t.dims).toEqual([1, 3, 32, 32]);
    expect(t.ratioH).toBeCloseTo(2 / 32, 6);
    expect(t.ratioW).toBeCloseTo(2 / 32, 6);
    const plane = 32 * 32;
    expect(t.data[0]).toBeCloseTo((1 - 0.485) / 0.229, 4); // plane 0 is blue, mean/std of index 0
    expect(t.data[plane]).toBeCloseTo((1 - 0.456) / 0.224, 4);
    expect(t.data[2 * plane + 5]).toBeCloseTo((1 - 0.406) / 0.225, 4);
  });

  it("feeds red into the third plane (BGR), not the first", () => {
    const t = detTensor(solid(40, 32, [255, 0, 0]), 960);
    const plane = 32 * 40;
    expect(t.data[0]).toBeCloseTo((0 - 0.485) / 0.229, 4);
    expect(t.data[2 * plane]).toBeCloseTo((1 - 0.406) / 0.225, 4);
  });

  it("rounds each side to a multiple of 32 with Python's round (half to even)", () => {
    expect(detTensor(solid(100, 50, [0, 0, 0]), 960).dims).toEqual([1, 3, 64, 96]);
    expect(detTensor(solid(32, 80, [0, 0, 0]), 960).dims).toEqual([1, 3, 64, 32]); // 80/32 = 2.5 -> 2
  });

  it("scales the long side down to the limit", () => {
    const t = detTensor(solid(1920, 1000, [0, 0, 0]), 960);
    expect(t.dims).toEqual([1, 3, 512, 960]);
    expect(t.ratioW).toBeCloseTo(2, 6);
    expect(t.ratioH).toBeCloseTo(1000 / 512, 6);
  });

  it("rejects an image whose data does not match its size", () => {
    const bad: Rgb = { width: 2, height: 2, data: new Uint8ClampedArray(4) };
    expect(() => detTensor(bad, 960)).toThrow("shape");
  });
});
