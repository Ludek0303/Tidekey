import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Sha256 } from "./sha256";

const nodeSha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

describe("Sha256", () => {
  it("hashes the empty input", () => {
    expect(new Sha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it('hashes "abc"', () => {
    expect(new Sha256().update(new TextEncoder().encode("abc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes one million 'a' fed in pieces", () => {
    const piece = new Uint8Array(1000).fill(0x61);
    const h = new Sha256();
    for (let i = 0; i < 1000; i++) h.update(piece);
    expect(h.digestHex()).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("matches node:crypto for 1 MB of random data split into random pieces", () => {
    const data = randomBytes(1 << 20);
    const sizes = [0, 1, 63, 64, 65];
    const h = new Sha256();
    let pos = 0;
    while (pos < data.length) {
      const want = Math.random() < 0.5 ? sizes[Math.floor(Math.random() * sizes.length)] : Math.floor(Math.random() * 300);
      const len = Math.min(want, data.length - pos);
      h.update(data.subarray(pos, pos + len));
      pos += len;
    }
    expect(h.digestHex()).toBe(nodeSha(data));
  });

  it("throughput on 32 MB is above 50 MB/s", () => {
    const data = randomBytes(32 << 20);
    const chunk = 1 << 20;
    const start = performance.now();
    const h = new Sha256();
    for (let pos = 0; pos < data.length; pos += chunk) h.update(data.subarray(pos, pos + chunk));
    const hex = h.digestHex();
    const seconds = (performance.now() - start) / 1000;
    const mbPerS = 32 / seconds;
    console.log(`SHA-256 (TypeScript): ${mbPerS.toFixed(1)} MB/s`);
    expect(hex).toBe(nodeSha(data));
    expect(mbPerS).toBeGreaterThan(50);
  });
});
