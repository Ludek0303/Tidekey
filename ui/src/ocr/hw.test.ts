import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { agrees, batchSize, describeAdapter, detSide, isValid, ORT_VERSION, pageMs, pickFaster, threadCount, variantFor } from "./hw";
import type { Measurement } from "./engine";

const base: Measurement = {
  det: "webgpu",
  rec: "wasm",
  msPerPage: 900,
  adapter: "NVIDIA ampere",
  ortVersion: ORT_VERSION,
  modelsSum: "sums",
  at: 1,
  gpuFailures: 0,
};

describe("hw rules", () => {
  it("picks the faster provider, and a GPU without a time loses", () => {
    expect(pickFaster({ webgpu: 30, wasm: 900 })).toBe("webgpu");
    expect(pickFaster({ webgpu: 900, wasm: 30 })).toBe("wasm");
    expect(pickFaster({ wasm: 30 })).toBe("wasm");
    expect(pickFaster({ webgpu: Infinity, wasm: 30 })).toBe("wasm");
    expect(pickFaster({ webgpu: 5 })).toBe("webgpu");
  });

  it("accepts GPU output only when it matches wasm: zeros fail even though their mean difference is small", () => {
    const ref = new Float32Array([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(agrees(new Float32Array(ref), ref)).toBe(true);
    expect(agrees(new Float32Array(ref.length), ref)).toBe(false);
    expect(agrees(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.995]), ref)).toBe(true);
    expect(agrees(new Float32Array(0), new Float32Array(0))).toBe(false);
  });

  it("uses the trial sizes per provider (OCR-PLAN §2 E)", () => {
    expect(detSide("webgpu")).toBe(1600);
    expect(detSide("wasm")).toBe(960);
    expect(batchSize("webgpu")).toBe(32);
    expect(batchSize("wasm")).toBe(8);
  });

  it("uses one thread without cross-origin isolation, at most four with it", () => {
    expect(threadCount(false, 16)).toBe(1);
    expect(threadCount(true, 16)).toBe(4);
    expect(threadCount(true, 2)).toBe(2);
    expect(threadCount(true, 0)).toBe(1);
  });

  it("estimates a 40-line page from the detector and one recognizer batch", () => {
    expect(pageMs(100, 50, 32)).toBe(100 + 50 * 2);
    expect(pageMs(100, 50, 8)).toBe(100 + 50 * 5);
  });

  it("picks the model pair: wasm fp16; WebGPU fp16 with shader-f16, fp32 without", () => {
    expect(variantFor("wasm", false)).toBe("fp16");
    expect(variantFor("wasm", true)).toBe("fp16");
    expect(variantFor("webgpu", true)).toBe("fp16");
    expect(variantFor("webgpu", false)).toBe("fp32");
  });

  it("keys the adapter by shader-f16 as well (it decides the variant)", () => {
    const has = (f: string[]) => ({ has: (n: string) => f.includes(n) });
    expect(describeAdapter({ info: { vendor: "nvidia", architecture: "ampere" }, features: has([]) })).toBe("nvidia ampere");
    expect(describeAdapter({ info: { vendor: "nvidia", architecture: "ampere" }, features: has(["shader-f16"]) })).toBe("nvidia ampere f16");
  });

  it("names an adapter by vendor and architecture only", () => {
    expect(describeAdapter({ info: { vendor: "nvidia", architecture: "ampere" } })).toBe("nvidia ampere");
    expect(describeAdapter({ info: { vendor: "", architecture: "" } })).toBe("");
    expect(describeAdapter(null)).toBe("");
    expect(describeAdapter(undefined)).toBe("");
  });

  it("accepts a measurement only for the same runtime, models, adapter and cpuOnly choice", () => {
    const env = { ortVersion: ORT_VERSION, modelsSum: "sums", adapter: "NVIDIA ampere", cpuOnly: false };
    expect(isValid(base, env)).toBe(true);
    expect(isValid(base, { ...env, ortVersion: "1.23.0" })).toBe(false);
    expect(isValid(base, { ...env, modelsSum: "other" })).toBe(false);
    expect(isValid(base, { ...env, adapter: "" })).toBe(false);
    expect(isValid(base, { ...env, cpuOnly: true })).toBe(false);
    expect(isValid({ ...base, cpuOnly: true }, { ...env, cpuOnly: true })).toBe(true);
    expect(isValid({ ...base, cpuOnly: true }, env)).toBe(false);
  });

  it("does not invalidate on GPU failures (the ban is stored, see engine.ts)", () => {
    const env = { ortVersion: ORT_VERSION, modelsSum: "sums", adapter: "NVIDIA ampere", cpuOnly: false };
    expect(isValid({ ...base, gpuFailures: 3, gpuBanned: true }, env)).toBe(true);
  });

  it("pins the ORT version to the one in package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["onnxruntime-web"]).toBe(ORT_VERSION);
  });
});
