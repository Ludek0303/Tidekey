import { describe, expect, it } from "vitest";
import { Framer, Resampler } from "./resample";

const sine = (n: number, rate: number, hz = 440): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

// Sign changes: a 440 Hz sine has 880 per second.
const crossings = (x: Float32Array): number => {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) c++;
  return c;
};

// Deterministic chunk lengths, so a failure reproduces.
const chunks = (x: Float32Array, seed: number): Float32Array[] => {
  const out: Float32Array[] = [];
  let s = seed;
  for (let at = 0; at < x.length; ) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const len = 1 + (s % 3000);
    out.push(x.subarray(at, at + len));
    at += len;
  }
  return out;
};

describe("Resampler", () => {
  it.each([48000, 44100])("%i Hz to 16 kHz keeps the length and the pitch of a sine", (from) => {
    const n = from;
    const out = new Resampler(from).push(sine(n, from));
    expect(Math.abs(out.length - (n * 16000) / from)).toBeLessThanOrEqual(1);
    expect(Math.abs(crossings(out) - 880)).toBeLessThanOrEqual(880 * 0.02);
  });

  it("gives the same samples whether the input comes in pieces or at once", () => {
    const x = sine(48000, 44100);
    const whole = new Resampler(44100).push(x);
    const r = new Resampler(44100);
    const parts: number[] = [];
    for (const c of chunks(x, 7)) parts.push(...r.push(c));
    expect(Math.abs(parts.length - whole.length)).toBeLessThanOrEqual(1);
    for (let i = 0; i < Math.min(parts.length, whole.length); i++) expect(Math.abs(parts[i] - whole[i])).toBeLessThan(1e-6);
  });

  it("returns a copy when the rates are equal", () => {
    const x = sine(100, 16000);
    const out = new Resampler(16000).push(x);
    expect(out).toEqual(x);
    expect(out).not.toBe(x);
  });
});

describe("Framer", () => {
  it("emits full frames and keeps the rest for the next call", () => {
    const f = new Framer(512);
    expect(f.push(new Float32Array(300).fill(1))).toEqual([]);
    const second = f.push(new Float32Array(300).fill(2));
    expect(second.map((x) => x.length)).toEqual([512]);
    expect(second[0][299]).toBe(1);
    expect(second[0][300]).toBe(2);
    const third = f.push(new Float32Array(424).fill(3));
    expect(third.map((x) => x.length)).toEqual([512]);
    expect(f.push(new Float32Array(0))).toEqual([]);
  });
});
