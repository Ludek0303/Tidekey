// Text line crops: perspective warp of a quad to an upright image, and the recognizer's batch tensor.
import { assertRgb, checkedSize, sample, srcCoord, type Rgb } from "./image";
import { quadSize, type Quad } from "./db";


type P = [number, number];
export const REC_H = 48;
const REC_MIN_W = 320;
const TALL_RATIO = 1.5;
const GUTTER_FRAC = 0.04; // an ink-free gap this wide (share of the page width) splits a box into two

// Homography H (row-major 3×3 with H[8] = 1, returned as 8 numbers) that maps the four `dst` points onto `src`.
function homography(dst: P[], src: P[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [X, Y] = src[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const p = A[col][col];
    if (Math.abs(p) < 1e-12) throw new Error("shape"); // degenerate quad
    for (let r = 0; r < n; r++) {
      if (r === col || A[r][col] === 0) continue;
      const f = A[r][col] / p;
      for (let k = col; k < n; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Turns the crop 90 degrees counter-clockwise (np.rot90), for tall text.
function rotateCcw(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < h; x++) {
      const s = (x * w + (w - 1 - y)) * 4;
      out.set(data.subarray(s, s + 4), (y * h + x) * 4);
    }
  return out;
}

export function cropQuad(img: Rgb, q: Quad): Rgb {
  assertRgb(img);
  const { w: qw, h: qh } = quadSize(q);
  const w = Math.max(1, Math.trunc(qw)), h = Math.max(1, Math.trunc(qh));
  const H = homography(
    [[0, 0], [w, 0], [w, h], [0, h]],
    q.pts,
  );
  const data = new Uint8ClampedArray(checkedSize(w, h, 4));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const den = H[6] * x + H[7] * y + 1;
      const sx = (H[0] * x + H[1] * y + H[2]) / den;
      const sy = (H[3] * x + H[4] * y + H[5]) / den;
      const o = (y * w + x) * 4;
      data[o] = sample(img, sx, sy, 2);
      data[o + 1] = sample(img, sx, sy, 1);
      data[o + 2] = sample(img, sx, sy, 0);
      data[o + 3] = 255;
    }
  if (h / w >= TALL_RATIO) return { width: h, height: w, data: rotateCcw(data, w, h) };
  return { width: w, height: h, data };
}

// Batch [N, 3, 48, W] for the recognizer: crops at height 48, BGR, (x/255 - 0.5)/0.5, zero padding on the right.
export function recBatchTensor(crops: Rgb[]): { data: Float32Array; dims: [number, 3, 48, number] } {
  const widths = crops.map((c) => {
    assertRgb(c);
    return Math.max(1, Math.ceil((REC_H * c.width) / c.height));
  });
  const W = widths.reduce((m, v) => Math.max(m, v), REC_MIN_W);
  const N = crops.length;
  const data = new Float32Array(checkedSize(N, 3, REC_H, W));
  crops.forEach((c, i) => {
    const wn = widths[i];
    for (let y = 0; y < REC_H; y++)
      for (let x = 0; x < wn; x++) {
        const sx = srcCoord(x, c.width, wn), sy = srcCoord(y, c.height, REC_H);
        for (let bgr = 0; bgr < 3; bgr++) {
          const v = sample(c, sx, sy, bgr) / 255;
          data[((i * 3 + bgr) * REC_H + y) * W + x] = (v - 0.5) / 0.5;
        }
      }
  });
  return { data, dims: [N, 3, REC_H, W] };
}

// The detector can merge two columns into one box across an empty gutter. Splits a horizontal box at every
// ink-free column run of at least GUTTER_FRAC of the page width (ink: mean RGB below 128), so each column is cropped
// and read on its own.
export function splitAtGutters(img: Rgb, q: Quad): Quad[] {
  const { w, h } = quadSize(q);
  if (w < 2 * h) return [q];
  const [tl, tr, , bl] = q.pts;
  const W = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const H = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const ux = (tr[0] - tl[0]) / W, uy = (tr[1] - tl[1]) / W;
  const vx = (bl[0] - tl[0]) / H, vy = (bl[1] - tl[1]) / H;
  const cols = Math.ceil(W);
  const rows = Math.ceil(H);
  const ink: boolean[] = [];
  for (let k = 0; k < cols; k++) {
    let dark = false;
    for (let j = 0; j < rows && !dark; j++) {
      const x = Math.round(tl[0] + (k + 0.5) * ux + (j + 0.5) * vx);
      const y = Math.round(tl[1] + (k + 0.5) * uy + (j + 0.5) * vy);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      dark = img.data[o] + img.data[o + 1] + img.data[o + 2] < 3 * 128;
    }
    ink.push(dark);
  }
  const minGap = GUTTER_FRAC * img.width;
  const segments: [number, number][] = [];
  let start = ink.indexOf(true);
  let k = start;
  while (start >= 0 && k < cols) {
    if (ink[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < cols && !ink[end]) end++;
    if (end < cols && end - k >= minGap) {
      segments.push([start, k]);
      start = end;
    }
    k = end;
  }
  if (start >= 0) segments.push([start, ink.lastIndexOf(true) + 1]);
  if (segments.length < 2) return [q];
  const at = (s: number, t: number): [number, number] => [tl[0] + s * ux + t * vx, tl[1] + s * uy + t * vy];
  return segments.map(([a, b]) => ({ pts: [at(a, 0), at(b, 0), at(b, H), at(a, H)], score: q.score }));
}
