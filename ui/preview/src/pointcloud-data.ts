// Point clouds without the screen: format detection, header limits, parsing with loaders.gl and the two pure
// helpers the viewer draws with (subsample, height colours). Nothing here touches the DOM or WebGL.
import { parse } from "@loaders.gl/core";
import { LASLoader } from "@loaders.gl/las";
import { PCDLoader } from "@loaders.gl/pcd";
import { PLYLoader } from "@loaders.gl/ply";
import { PreviewError } from "./viewers/index";

export const MAX_POINTS_IN = 50_000_000;
export const MAX_POINTS_OUT = 5_000_000;

const LAS_HEADER_MIN = 227;
// The header of a PCD or PLY file is text; its count is in the first lines.
const TEXT_HEAD_BYTES = 64 * 1024;

export type CloudKind = "las" | "pcd" | "ply";

export interface Cloud {
  positions: Float32Array;
  colors: Uint8Array | null;
  count: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** The format from the bytes first, then from the file name; null when neither says what it is. */
export function kindOf(bytes: Uint8Array, name: string): CloudKind | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  if (head.startsWith("LASF")) return "las";
  if (/^(?:# \.PCD|VERSION)/m.test(head)) return "pcd";
  if (/^ply\r?\n/.test(head)) return "ply";
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  if (ext === "las" || ext === "laz") return "las";
  if (ext === "pcd") return "pcd";
  if (ext === "ply") return "ply";
  return null;
}

/**
 * The point count the header declares, read before anything is parsed. LAS 1.4 is refused here, because its count
 * sits in a field this reader does not follow; a PCD or PLY header without a count gives 0.
 */
export function headerCount(bytes: Uint8Array, kind: CloudKind): number {
  if (kind === "las") {
    if (bytes.byteLength < LAS_HEADER_MIN) throw new PreviewError("corrupt");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(24) !== 1 || view.getUint8(25) >= 4) throw new PreviewError("unsupported");
    return view.getUint32(107, true);
  }
  const text = new TextDecoder().decode(bytes.subarray(0, TEXT_HEAD_BYTES));
  const m = kind === "pcd" ? /^POINTS\s+(\d+)/m.exec(text) : /^element vertex (\d+)/m.exec(text);
  return m ? Number(m[1]) : 0;
}

/** Every `step`-th point, so that at most `max` are left. */
export function sampleStep(count: number, max: number): number {
  return Math.max(1, Math.ceil(count / max));
}

/** A cloud with at most `max` points: every n-th one, colours with their points. */
export function subsample(cloud: Cloud, max: number): Cloud {
  if (cloud.count <= max) return cloud;
  const step = sampleStep(cloud.count, max);
  const count = Math.ceil(cloud.count / step);
  const positions = new Float32Array(count * 3);
  const colors = cloud.colors ? new Uint8Array(count * 3) : null;
  for (let k = 0; k < count; k++) {
    const i = k * step;
    positions.set(cloud.positions.subarray(i * 3, i * 3 + 3), k * 3);
    if (colors && cloud.colors) colors.set(cloud.colors.subarray(i * 3, i * 3 + 3), k * 3);
  }
  return { ...cloud, positions, colors, count };
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * RGB per point, the colour of its height along `axis` (Z for LAS, Y for PLY and PCD with Y up): a gradient from
 * `low` at `min` to `high` at `max`. A flat cloud (min === max) gets `low` everywhere.
 */
export function heightColors(
  positions: Float32Array,
  axis: 0 | 1 | 2,
  min: number,
  max: number,
  low: string,
  high: string,
): Uint8Array {
  const [r0, g0, b0] = hexRgb(low);
  const [r1, g1, b1] = hexRgb(high);
  const count = Math.floor(positions.length / 3);
  const out = new Uint8Array(count * 3);
  const span = max - min;
  for (let i = 0; i < count; i++) {
    const t = span > 0 ? Math.min(1, Math.max(0, (positions[i * 3 + axis] - min) / span)) : 0;
    out[i * 3] = Math.round(r0 + (r1 - r0) * t);
    out[i * 3 + 1] = Math.round(g0 + (g1 - g0) * t);
    out[i * 3 + 2] = Math.round(b0 + (b1 - b0) * t);
  }
  return out;
}

interface Attribute {
  value: ArrayLike<number>;
  size: number;
}

interface Parsed {
  attributes: { POSITION?: Attribute; COLOR_0?: Attribute };
}

function toCloud(parsed: Parsed): Cloud {
  const pos = parsed.attributes.POSITION;
  if (!pos) throw new PreviewError("corrupt");
  const positions = Float32Array.from(pos.value);
  const count = Math.floor(positions.length / 3);
  if (count === 0) throw new PreviewError("corrupt");

  let colors: Uint8Array | null = null;
  const col = parsed.attributes.COLOR_0;
  if (col) {
    // LAS keeps an alpha byte after each colour; the viewer needs RGB only
    colors = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) colors[i * 3 + c] = col.value[i * col.size + c];
    }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (!Number.isFinite(v)) continue;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  // a cloud with no finite coordinate at all has no bounds to show
  if (!Number.isFinite(min[0])) throw new PreviewError("corrupt");
  return { positions, colors, count, bounds: { min, max } };
}

/**
 * Reads a LAS (up to 1.3, LAZ included), PCD or PLY point cloud from its bytes. Refuses the file before parsing when
 * its header declares more than MAX_POINTS_IN points; keeps at most MAX_POINTS_OUT points. `total` is the count in
 * the file, before sampling.
 */
export async function readCloud(bytes: ArrayBuffer, name: string): Promise<{ cloud: Cloud; total: number }> {
  const view = new Uint8Array(bytes);
  const kind = kindOf(view, name);
  if (!kind) throw new PreviewError("unsupported");
  if (headerCount(view, kind) > MAX_POINTS_IN) throw new PreviewError("too-large");
  const loader = kind === "las" ? LASLoader : kind === "pcd" ? PCDLoader : PLYLoader;
  let parsed: unknown;
  try {
    // worker: false, because loaders.gl workers come from a CDN, which the frame may not reach;
    // colorDepth 16: LAS colours are 16-bit (the default keeps the low byte only)
    parsed = await parse(bytes, loader, { worker: false, las: { skip: 1, fp64: false, colorDepth: 16 } });
  } catch {
    throw new PreviewError("corrupt");
  }
  const cloud = toCloud(parsed as Parsed);
  return { cloud: subsample(cloud, MAX_POINTS_OUT), total: cloud.count };
}
