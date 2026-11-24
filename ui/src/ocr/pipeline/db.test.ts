// @vitest-environment node
import { describe, expect, it } from "vitest";
import { boxesFromMap, minAreaRect, type Quad } from "./db";

type P = [number, number];
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const area = (c: P[]) => dist(c[0], c[1]) * dist(c[0], c[3]);

describe("minAreaRect", () => {
  it("returns the box of an axis-aligned rectangle", () => {
    const c = minAreaRect([[0, 0], [4, 0], [4, 2], [0, 2], [2, 1]]);
    expect(area(c)).toBeCloseTo(8, 6);
    expect(dist(c[0], c[1])).toBeCloseTo(4, 6);
    expect(dist(c[0], c[3])).toBeCloseTo(2, 6);
  });

  it("finds the tilted box of a 45 degree square", () => {
    const c = minAreaRect([[0, -1], [1, 0], [0, 1], [-1, 0]]);
    expect(area(c)).toBeCloseTo(2, 6);
    expect(dist(c[0], c[1])).toBeCloseTo(Math.SQRT2, 6);
  });

  it("finds the box of a rectangle rotated 30 degrees", () => {
    const th = Math.PI / 6;
    const rot = ([x, y]: P): P => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)];
    const rect: P[] = [[0, 0], [2, 0], [2, 1], [0, 1]];
    const c = minAreaRect(rect.map(rot));
    expect(area(c)).toBeCloseTo(2, 6);
    expect([dist(c[0], c[1]), dist(c[0], c[3])].sort()).toEqual([expect.closeTo(1, 6), expect.closeTo(2, 6)]);
  });
});

function blobMap(w: number, h: number, inside: (x: number, y: number) => number): Float32Array {
  const prob = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) prob[y * w + x] = inside(x, y);
  return prob;
}

describe("boxesFromMap", () => {
  it("turns a rotated blob into one quad with the right angle and size after unclip", () => {
    const W = 100, H = 80, a = 30, b = 8, th = Math.PI / 6;
    const prob = blobMap(W, H, (x, y) => {
      const dx = x - 50, dy = y - 40;
      const u = dx * Math.cos(th) + dy * Math.sin(th);
      const v = -dx * Math.sin(th) + dy * Math.cos(th);
      return Math.abs(u) <= a && Math.abs(v) <= b ? 0.9 : 0;
    });
    const quads = boxesFromMap(prob, W, H, 2, 2);
    expect(quads).toHaveLength(1);
    const [tl, tr, , bl] = quads[0].pts;
    // blob 60 x 16 px in the map; unclip d = 60*16*1.5/(2*76) = 9.5 px per side; scale 2
    expect(dist(tl, tr)).toBeGreaterThan(152);
    expect(dist(tl, tr)).toBeLessThan(164);
    expect(dist(tl, bl)).toBeGreaterThan(64);
    expect(dist(tl, bl)).toBeLessThan(76);
    const angle = (Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180) / Math.PI;
    expect(Math.abs(angle - 30)).toBeLessThan(2);
    expect(quads[0].score).toBeCloseTo(0.9, 6);
  });

  it("returns two quads for two blobs", () => {
    const prob = blobMap(120, 80, (x, y) => {
      const a = x >= 20 && x < 40 && y >= 20 && y < 30;
      const b = x >= 80 && x < 100 && y >= 50 && y < 60;
      return a || b ? 0.8 : 0;
    });
    expect(boxesFromMap(prob, 120, 80, 1, 1)).toHaveLength(2);
  });

  it("drops a blob whose mean score is below the box threshold", () => {
    const prob = blobMap(60, 40, (x, y) => (x >= 10 && x < 40 && y >= 10 && y < 25 ? 0.45 : 0));
    expect(boxesFromMap(prob, 60, 40, 1, 1)).toHaveLength(0);
  });

  it("drops a tiny blob", () => {
    const prob = blobMap(60, 40, (x, y) => (x >= 10 && x < 12 && y >= 10 && y < 12 ? 0.9 : 0));
    expect(boxesFromMap(prob, 60, 40, 1, 1)).toHaveLength(0);
  });

  it("maps quads back to the original image pixels in tl, tr, br, bl order", () => {
    const prob = blobMap(60, 40, (x, y) => (x >= 10 && x < 40 && y >= 10 && y < 25 ? 0.9 : 0));
    const q: Quad[] = boxesFromMap(prob, 60, 40, 3, 3);
    expect(q).toHaveLength(1);
    const [tl, tr, br, bl] = q[0].pts;
    expect(tl[0]).toBeLessThan(tr[0]);
    expect(tl[1]).toBeLessThan(bl[1]);
    expect(br[0]).toBeGreaterThan(bl[0]);
    expect(Math.min(tl[0], bl[0])).toBeLessThan(40);
  });
});
