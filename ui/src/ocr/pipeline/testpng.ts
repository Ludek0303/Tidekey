// Test-only PNG decoder for the OCR fixtures: 8-bit gray, gray+alpha, RGB or RGBA, non-interlaced.
// Node's zlib does the inflate; the rest is the PNG spec's five scanline filters.
import { inflateSync } from "node:zlib";
import type { Rgb } from "./image";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(bytes: Uint8Array): Rgb {
  if (SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, colorType = -1;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      if (bytes[pos + 16] !== 8) throw new Error("only 8-bit PNG");
      colorType = bytes[pos + 17];
      if (bytes[pos + 20] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`unsupported PNG color type ${colorType}`);
  const total = idat.reduce((n, b) => n + b.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const b of idat) {
    joined.set(b, off);
    off += b.length;
  }
  const raw = inflateSync(joined);
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error("PNG data size mismatch");
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      px[y * stride + x] = (raw[src + x] + pred) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch;
    const gray = ch < 3;
    data[i * 4] = px[s];
    data[i * 4 + 1] = gray ? px[s] : px[s + 1];
    data[i * 4 + 2] = gray ? px[s] : px[s + 2];
    data[i * 4 + 3] = ch === 2 ? px[s + 1] : ch === 4 ? px[s + 3] : 255;
  }
  return { width, height, data };
}
