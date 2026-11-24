// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { psdSize } from "./psd";

const FIXTURE = new URL("../../../../fixtures/preview/obraz.psd", import.meta.url);

// The first 26 bytes of a PSD (version 1) or PSB (version 2) file: signature, version, reserved, channels, height, width.
function header(version: number, height: number, width: number): Uint8Array {
  const b = new Uint8Array(26);
  const view = new DataView(b.buffer);
  b.set([0x38, 0x42, 0x50, 0x53]);
  view.setUint16(4, version);
  view.setUint16(12, 3);
  view.setUint32(14, height);
  view.setUint32(18, width);
  view.setUint16(22, 8);
  view.setUint16(24, 3);
  return b;
}

describe("psdSize", () => {
  it("obraz.psd: 640 × 480", () => {
    expect(psdSize(new Uint8Array(readFileSync(FIXTURE)))).toEqual({ width: 640, height: 480 });
  });

  it("PSB (wersja 2): wymiary u32, także ponad 65 535", () => {
    expect(psdSize(header(2, 70000, 50000))).toEqual({ width: 50000, height: 70000 });
  });

  it("za krótki bufor: null", () => {
    expect(psdSize(header(1, 480, 640).subarray(0, 20))).toBeNull();
  });

  it("zła sygnatura: null", () => {
    const b = header(1, 480, 640);
    b[0] = 0x58;
    expect(psdSize(b)).toBeNull();
  });
});
