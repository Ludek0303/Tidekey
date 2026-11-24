// The optimized detTensor and boxesFromMap paths against the plain formulas they replace (OCR-PLAN §2 E: JS pre- and
// post-processing). The tensor must match bit for bit; the hull must not change when interior pixels are dropped.
import { describe, expect, it } from "vitest";
import { detTensor, pyRound, sample, srcCoord, checkedSize, type Rgb } from "./image";
import { minAreaRect } from "./db";

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// The per-pixel version detTensor replaced.
function naiveDetTensor(img: Rgb, side: number): Float32Array {
  const { width: w, height: h } = img;
  const r = Math.max(h, w) > side ? side / Math.max(h, w) : 1;
  const nh = Math.max(32, pyRound((h * r) / 32) * 32);
  const nw = Math.max(32, pyRound((w * r) / 32) * 32);
  const plane = checkedSize(nh, nw);
  const data = new Float32Array(checkedSize(3, plane));
  for (let c = 0; c < 3; c++)
    for (let dy = 0; dy < nh; dy++)
      for (let dx = 0; dx < nw; dx++) {
        const v = sample(img, srcCoord(dx, w, nw), srcCoord(dy, h, nh), c) / 255;
        data[c * plane + dy * nw + dx] = (v - MEAN[c]) / STD[c];
      }
  return data;
}

// Deterministic pseudo-random numbers, so a failure reproduces.
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
}

describe("detTensor fast path", () => {
  it("is bit-identical to the per-pixel formula, for odd sizes and downscaled and upscaled inputs", () => {
    const rnd = rng(3);
    for (const [w, h, side] of [[37, 21, 64], [100, 70, 96], [9, 130, 128], [50, 50, 1600]] as const) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256);
      const img: Rgb = { width: w, height: h, data };
      expect(detTensor(img, side).data).toEqual(naiveDetTensor(img, side));
    }
  });
});

describe("boxesFromMap boundary pixels", () => {
  it("the minimum-area rectangle of boundary pixels equals that of all pixels", () => {
    const rnd = rng(11);
    for (let trial = 0; trial < 60; trial++) {
      const inside = new Set<number>();
      const W = 40;
      for (let d = 0; d < 6; d++) {
        const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * W), r = 1 + Math.floor(rnd() * 6);
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++)
            if (x >= 0 && y >= 0 && x < W && y < W && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) inside.add(y * W + x);
      }
      const all: [number, number][] = [];
      const boundary: [number, number][] = [];
      for (const i of inside) {
        const x = i % W, y = (i - x) / W;
        all.push([x, y]);
        let edge = false;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= W || !inside.has(ny * W + nx)) edge = true;
          }
        if (edge) boundary.push([x, y]);
      }
      expect(minAreaRect(boundary)).toEqual(minAreaRect(all));
    }
  });
});
