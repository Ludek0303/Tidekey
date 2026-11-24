import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWav } from "./wav";

// A RIFF chunk with its id and size; odd-sized bodies get the padding byte.
function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  out.set(new TextEncoder().encode(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

// Builds a RIFF/WAVE file; `chunks` are extra chunks put before "data" (e.g. LIST), to check they are skipped.
function wav(opts: { format: number; bits: number; channels: number; rate: number; samples: number[]; chunks?: Uint8Array[] }): ArrayBuffer {
  const bytes = opts.bits / 8;
  const data = new DataView(new ArrayBuffer(opts.samples.length * bytes));
  opts.samples.forEach((s, i) => {
    if (opts.format === 3) data.setFloat32(i * 4, s, true);
    else data.setInt16(i * 2, s, true);
  });
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, opts.format, true);
  fmt.setUint16(2, opts.channels, true);
  fmt.setUint32(4, opts.rate, true);
  fmt.setUint32(8, opts.rate * opts.channels * bytes, true);
  fmt.setUint16(12, opts.channels * bytes, true);
  fmt.setUint16(14, opts.bits, true);
  const parts = [chunk("fmt ", new Uint8Array(fmt.buffer)), ...(opts.chunks ?? []), chunk("data", new Uint8Array(data.buffer))];
  const body = parts.reduce((n, p) => n + p.length, 4);
  const out = new Uint8Array(12 + body - 4);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

describe("parseWav", () => {
  it("reads PCM16 stereo as the mean of the channels", () => {
    // frames: (16384, 0) → 0.5 and (-32768, 32767) → about -0.5
    const buf = wav({ format: 1, bits: 16, channels: 2, rate: 16000, samples: [16384, 0, -32768, 32767] });
    const { rate, pcm } = parseWav(buf);
    expect(rate).toBe(16000);
    expect(pcm.length).toBe(2);
    expect(pcm[0]).toBeCloseTo(0.25, 4);
    expect(pcm[1]).toBeCloseTo(-0.00002, 4);
  });

  it("reads IEEE float32 stereo and skips an odd-sized chunk with padding", () => {
    const list = new Uint8Array([1, 2, 3]); // odd size: one pad byte follows
    const buf = wav({
      format: 3,
      bits: 32,
      channels: 2,
      rate: 44100,
      samples: [0.5, -0.25, 1, 0],
      chunks: [chunk("LIST", list)],
    });
    const { rate, pcm } = parseWav(buf);
    expect(rate).toBe(44100);
    expect(Array.from(pcm)).toEqual([0.125, 0.5]);
  });

  it("rejects an unsupported format in Polish", () => {
    const buf = wav({ format: 1, bits: 24, channels: 1, rate: 16000, samples: [0] });
    expect(() => parseWav(buf)).toThrow(/Nieobsługiwany format WAV/);
  });

  it("rejects a file that is not RIFF/WAVE", () => {
    expect(() => parseWav(new TextEncoder().encode("to nie jest wav").buffer)).toThrow(/WAV/);
  });

  it("reads the bundled 11 s fixture as 16 kHz mono", () => {
    const file = readFileSync(join(import.meta.dirname, "fixtures", "jfk.wav"));
    const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const { rate, pcm } = parseWav(buf);
    expect(rate).toBe(16000);
    expect(pcm.length / rate).toBeGreaterThan(10.5);
    expect(pcm.length / rate).toBeLessThan(11.5);
  });
});

