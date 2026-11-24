// Image helpers for the OCR pipeline: RGBA input, BGR tensors, bilinear sampling like OpenCV's INTER_LINEAR.

export interface Rgb {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} // RGBA, like ImageData

export const MAX_PIXELS = 50_000_000; // OCR §2.3: 50 Mpx per image before scaling
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// byte offset of each BGR channel inside an RGBA pixel
const BGR_OFFSET = [2, 1, 0];

// Product of the sizes, checked: a typed array is only allocated from a safe, bounded integer.
export function checkedSize(...dims: number[]): number {
  let n = 1;
  for (const d of dims) {
    if (!Number.isSafeInteger(d) || d < 0) throw new Error("shape");
    n *= d;
    if (!Number.isSafeInteger(n)) throw new Error("shape");
  }
  return n;
}

export function assertRgb(img: Rgb): void {
  const px = checkedSize(img.width, img.height);
  if (px === 0 || px > MAX_PIXELS || img.data.length !== px * 4) throw new Error("shape");
}

// Python's round(): halves go to the even neighbour (the reference rounds det sides this way).
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// Channel `bgr` (0 = blue, 1 = green, 2 = red) at fractional source position (x, y), 0..255, edge-replicated.
export function sample(img: Rgb, x: number, y: number, bgr: number): number {
  const cx = Math.min(Math.max(x, 0), img.width - 1);
  const cy = Math.min(Math.max(y, 0), img.height - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, img.width - 1), y1 = Math.min(y0 + 1, img.height - 1);
  const fx = cx - x0, fy = cy - y0;
  const o = BGR_OFFSET[bgr];
  const w = img.width;
  const p00 = img.data[(y0 * w + x0) * 4 + o], p01 = img.data[(y0 * w + x1) * 4 + o];
  const p10 = img.data[(y1 * w + x0) * 4 + o], p11 = img.data[(y1 * w + x1) * 4 + o];
  const top = p00 + (p01 - p00) * fx;
  const bottom = p10 + (p11 - p10) * fx;
  return top + (bottom - top) * fy;
}

// For each destination index: the two source indices and the weight of the second, as sample() computes them.
function bilinearAxis(srcSize: number, dstSize: number): [Int32Array, Int32Array, Float64Array] {
  const i0 = new Int32Array(dstSize), i1 = new Int32Array(dstSize), f = new Float64Array(dstSize);
  for (let d = 0; d < dstSize; d++) {
    const c = Math.min(Math.max(srcCoord(d, srcSize, dstSize), 0), srcSize - 1);
    const a = Math.floor(c);
    i0[d] = a;
    i1[d] = Math.min(a + 1, srcSize - 1);
    f[d] = c - a;
  }
  return [i0, i1, f];
}

// Source coordinate of destination pixel index `d` when `src` pixels are stretched over `dst` pixels (cv2 centres).
export function srcCoord(d: number, srcSize: number, dstSize: number): number {
  return (d + 0.5) * (srcSize / dstSize) - 0.5;
}

// Tensor [1, 3, nh, nw] for the detector: long side ≤ side, both sides multiples of 32, BGR, mean/std normalized.
// The source column/row and bilinear weights are computed once per destination column/row, not per pixel; the
// arithmetic is the same as sample(), so the tensor is bit-identical to the per-pixel version.
export function detTensor(
  img: Rgb,
  side: number,
): { data: Float32Array; dims: [1, 3, number, number]; ratioH: number; ratioW: number } {
  assertRgb(img);
  if (!Number.isSafeInteger(side) || side < 32) throw new Error("shape");
  const { width: w, height: h } = img;
  const r = Math.max(h, w) > side ? side / Math.max(h, w) : 1;
  const nh = Math.max(32, pyRound((h * r) / 32) * 32);
  const nw = Math.max(32, pyRound((w * r) / 32) * 32);
  const plane = checkedSize(nh, nw);
  const data = new Float32Array(checkedSize(3, plane));
  const [x0, x1, fx] = bilinearAxis(w, nw);
  const [y0, y1, fy] = bilinearAxis(h, nh);
  const src = img.data;
  for (let dy = 0; dy < nh; dy++) {
    const r0 = y0[dy] * w, r1 = y1[dy] * w, wy = fy[dy];
    for (let dx = 0; dx < nw; dx++) {
      const a = (r0 + x0[dx]) * 4, b = (r0 + x1[dx]) * 4, c = (r1 + x0[dx]) * 4, d = (r1 + x1[dx]) * 4;
      const wx = fx[dx];
      const o = dy * nw + dx;
      for (let ch = 0; ch < 3; ch++) {
        const k = BGR_OFFSET[ch];
        const p00 = src[a + k], p01 = src[b + k], p10 = src[c + k], p11 = src[d + k];
        const top = p00 + (p01 - p00) * wx;
        const bottom = p10 + (p11 - p10) * wx;
        const v = (top + (bottom - top) * wy) / 255;
        data[ch * plane + o] = (v - MEAN[ch]) / STD[ch];
      }
    }
  }
  return { data, dims: [1, 3, nh, nw], ratioH: h / nh, ratioW: w / nw };
}
