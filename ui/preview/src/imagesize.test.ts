import { describe, expect, it } from "vitest";
import { imageSize } from "./imagesize";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const bytes = (list: number[]): Uint8Array => new Uint8Array(list);

const PNG = bytes([...ascii("\x89PNG\r\n\x1a\n"), ...be32(13), ...ascii("IHDR"), ...be32(640), ...be32(480), 8, 6, 0, 0, 0]);
const APP0 = [0xff, 0xe0, ...be16(16), ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
const SOF0 = [0xff, 0xc0, ...be16(11), 8, ...be16(480), ...be16(640), 1, 1, 0x11, 0];
const JPEG = bytes([0xff, 0xd8, ...APP0, ...SOF0]);
const GIF = bytes([...ascii("GIF89a"), ...le16(320), ...le16(200), 0, 0, 0]);
const WEBP_VP8X = bytes([...ascii("RIFF"), ...le32(40), ...ascii("WEBP"), ...ascii("VP8X"), ...le32(10), 0x10, 0, 0, 0, ...le24(799), ...le24(599)]);
// BITMAPINFOHEADER: width 640, height -480 (top-down rows)
const BMP = bytes([...ascii("BM"), ...le32(54), ...le32(0), ...le32(54), ...le32(40), ...le32(640), ...le32(-480)]);
const FTYP = [...be32(20), ...ascii("ftyp"), ...ascii("avif"), ...be32(0), ...ascii("avif")];
const AVIF = bytes([...FTYP, ...be32(20), ...ascii("ispe"), 0, 0, 0, 0, ...be32(1200), ...be32(800)]);

describe("imageSize", () => {
  it("PNG z nagłówka IHDR", () => {
    expect(imageSize(PNG)).toEqual({ width: 640, height: 480 });
  });

  it("JPEG z segmentem APP0 przed SOF0", () => {
    expect(imageSize(JPEG)).toEqual({ width: 640, height: 480 });
  });

  it("GIF z logicznego ekranu", () => {
    expect(imageSize(GIF)).toEqual({ width: 320, height: 200 });
  });

  it("WebP VP8X z rozmiarem płótna", () => {
    expect(imageSize(WEBP_VP8X)).toEqual({ width: 800, height: 600 });
  });

  it("BMP z nagłówka DIB, wysokość ze znakiem", () => {
    expect(imageSize(BMP)).toEqual({ width: 640, height: 480 });
  });

  it("AVIF z pudełka ispe", () => {
    expect(imageSize(AVIF)).toEqual({ width: 1200, height: 800 });
  });

  it("AVIF/HEIF z kilkoma pudełkami ispe (siatka): największe, nie pierwsze", () => {
    // a grid image: the first ispe belongs to a small tile, the largest one is the whole picture
    const tile = [...be32(20), ...ascii("ispe"), 0, 0, 0, 0, ...be32(160), ...be32(120)];
    const whole = [...be32(20), ...ascii("ispe"), 0, 0, 0, 0, ...be32(4000), ...be32(3000)];
    const mid = [...be32(20), ...ascii("ispe"), 0, 0, 0, 0, ...be32(800), ...be32(600)];
    expect(imageSize(bytes([...FTYP, ...tile, ...mid, ...whole]))).toEqual({ width: 4000, height: 3000 });
    expect(imageSize(bytes([...FTYP, ...whole, ...tile]))).toEqual({ width: 4000, height: 3000 });
  });

  it("obcięte nagłówki i śmieci dają null", () => {
    expect(imageSize(PNG.slice(0, 20))).toBeNull();
    expect(imageSize(JPEG.slice(0, 24))).toBeNull();
    expect(imageSize(GIF.slice(0, 7))).toBeNull();
    expect(imageSize(WEBP_VP8X.slice(0, 25))).toBeNull();
    expect(imageSize(BMP.slice(0, 20))).toBeNull();
    expect(imageSize(AVIF.slice(0, 30))).toBeNull();
    expect(imageSize(bytes([]))).toBeNull();
    expect(imageSize(bytes(ascii("to nie jest obraz")))).toBeNull();
  });
});
