// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { Segmenter, SileroVad } from "./vad";

const MODEL = fileURLToPath(new URL("../../../models/silero-vad-v6.2.3/silero_vad.onnx", import.meta.url));
const WAV = fileURLToPath(new URL("./fixtures/jfk.wav", import.meta.url));

// Reads PCM16 mono WAV and returns Float32 samples in [-1, 1).
function readWav(path: string): Float32Array {
  const buf = readFileSync(path);
  let at = 12;
  while (at < buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "data") {
      const n = size / 2;
      return Float32Array.from({ length: n }, (_, i) => buf.readInt16LE(at + 8 + i * 2) / 32768);
    }
    at += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

ort.env.wasm.numThreads = 1;

describe.skipIf(!existsSync(MODEL))("SileroVad on jfk.wav", () => {
  it("finds the speech and keeps silence out of it", async () => {
    const pcm = readWav(WAV);
    const vad = await SileroVad.create(ort, new Uint8Array(readFileSync(MODEL)));
    const seg = new Segmenter();
    const frags: Float32Array[] = [];
    for (let at = 0; at + 512 <= pcm.length; at += 512) {
      const frame = pcm.slice(at, at + 512);
      frags.push(...seg.push(frame, await vad.prob(frame)));
    }
    frags.push(...seg.flush());
    const secs = frags.map((f) => f.length / 16000);
    console.log("[vad] fragmenty (s):", secs.map((s) => s.toFixed(2)).join(", "));
    expect(frags.length).toBeGreaterThanOrEqual(1);
    const total = secs.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(5);
    expect(total).toBeLessThan(11.5);

    vad.reset();
    let max = 0;
    for (let i = 0; i < 31; i++) max = Math.max(max, await vad.prob(new Float32Array(512)));
    expect(max).toBeLessThan(0.1);
  });
});
