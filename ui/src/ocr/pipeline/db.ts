// DB post-processing: probability map → text boxes (ocr_ref.boxes_from_map, without OpenCV or pyclipper).
import { checkedSize } from "./image";
type P = [number, number];
// 4 corners in original image pixels (tl, tr, br, bl) and the mean detector score of the blob
export interface Quad {
  pts: [[number, number], [number, number], [number, number], [number, number]];
  score: number;
}
// Width and height of a quad: the longer of each pair of opposite sides (as crop_quad's w and h).
export function quadSize(q: Quad): { w: number; h: number } {
  const [tl, tr, br, bl] = q.pts;
  const d = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: Math.max(d(tl, tr), d(bl, br)), h: Math.max(d(tl, bl), d(tr, br)) };
}

export interface BoxOptions { thresh?: number; boxThresh?: number; unclip?: number; maxBoxes?: number }

const MIN_SIDE = 3; // map pixels, before unclip
const MIN_SIDE_OUT = 5; // map pixels, after unclip
const MAX_BOXES = 2000;

const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Convex hull, monotone chain, no collinear points.
function hull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: P[] = [], upper: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Minimum-area rectangle of a point set, as 4 corners in cyclic order. The optimum has a side on a hull edge.
export function minAreaRect(points: P[]): [P, P, P, P] {
  const h = hull(points);
  let best: [P, P, P, P] | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < Math.max(h.length, 1); i++) {
    const a = h[i], b = h[(i + 1) % h.length] ?? a;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ex = len > 0 ? (b[0] - a[0]) / len : 1, ey = len > 0 ? (b[1] - a[1]) / len : 0;
    const nx = -ey, ny = ex;
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of h) {
      const e = p[0] * ex + p[1] * ey, n = p[0] * nx + p[1] * ny;
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    const area = (maxE - minE) * (maxN - minN);
    if (area < bestArea) {
      bestArea = area;
      const at = (e: number, n: number): P => [e * ex + n * nx, e * ey + n * ny];
      best = [at(minE, minN), at(maxE, minN), at(maxE, maxN), at(minE, maxN)];
    }
    if (h.length < 3) break;
  }
  return best ?? [[0, 0], [0, 0], [0, 0], [0, 0]];
}

// tl, tr, br, bl, as ocr_ref.order_points
function orderPoints(p: P[]): Quad["pts"] {
  const s = [...p].sort((a, b) => a[0] - b[0]);
  const left = s.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = s.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

// A pixel above the threshold with an 8-neighbour that is off the map or at or below the threshold.
function isBoundary(prob: Float32Array, w: number, h: number, x: number, y: number, thresh: number): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !(prob[ny * w + nx] > thresh)) return true;
    }
  return false;
}

// Boxes from the detector's map (h × w, values 0..1) with the scale back to the original image.
export function boxesFromMap(
  prob: Float32Array,
  w: number,
  h: number,
  ratioH: number,
  ratioW: number,
  o: BoxOptions = {},
): Quad[] {
  const thresh = o.thresh ?? 0.3, boxThresh = o.boxThresh ?? 0.6, unclip = o.unclip ?? 1.5;
  const maxBoxes = o.maxBoxes ?? MAX_BOXES;
  if (prob.length !== checkedSize(w, h)) throw new Error("shape");
  const n = checkedSize(w, h);
  const seen = new Uint8Array(n);
  // one flood fill at a time, so the buffers are allocated once per map: every pixel is pushed at most once
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  const out: Quad[] = [];
  let components = 0;
  for (let start = 0; start < n && components < maxBoxes; start++) {
    if (seen[start] || !(prob[start] > thresh)) continue;
    components++;
    // 8-neighbour flood fill of one component
    let sp = 0, count = 0, sum = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      members[count++] = i;
      sum += prob[i];
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!seen[j] && prob[j] > thresh) {
            seen[j] = 1;
            stack[sp++] = j;
          }
        }
    }
    // Only boundary pixels can be corners of the convex hull (an interior pixel lies inside the hull of its eight
    // neighbours), so the hull, and therefore the box, is the same as with every pixel of the component.
    const pts: P[] = [];
    for (let k = 0; k < count; k++) {
      const i = members[k];
      const x = i % w, y = (i - x) / w;
      if (isBoundary(prob, w, h, x, y, thresh)) pts.push([x, y]);
    }
    const score = sum / count;
    if (score < boxThresh) continue;
    const c = minAreaRect(pts);
    const bw = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
    const bh = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]);
    if (Math.min(bw, bh) < MIN_SIDE) continue;
    // unclip: the rectangle grows by d on every side, d = area * ratio / perimeter (exact for a rectangle)
    const d = (bw * bh * unclip) / (2 * (bw + bh));
    if (Math.min(bw, bh) + 2 * d < MIN_SIDE_OUT) continue;
    const ux = (c[1][0] - c[0][0]) / bw, uy = (c[1][1] - c[0][1]) / bw;
    const vx = (c[3][0] - c[0][0]) / bh, vy = (c[3][1] - c[0][1]) / bh;
    const cx = (c[0][0] + c[2][0]) / 2, cy = (c[0][1] + c[2][1]) / 2;
    const hw = bw / 2 + d, hh = bh / 2 + d;
    const corner = (su: number, sv: number): P => [
      (cx + su * hw * ux + sv * hh * vx) * ratioW,
      (cy + su * hw * uy + sv * hh * vy) * ratioH,
    ];
    out.push({ pts: orderPoints([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]), score });
  }
  return out;
}
