// Pure rules for the OCR engine's hardware choice (OCR §2.2, OCR-PLAN §2 E): which provider wins, what size and batch
// each one gets, and when a stored measurement still counts. No DOM or ORT here, so the rules are unit-tested.
import type { Measurement } from "./engine";

export type Provider = "webgpu" | "wasm";

// Must equal the onnxruntime-web pin in ui/package.json (hw.test.ts checks it).
export const ORT_VERSION = "1.24.1";
// OCR §2.2: after three GPU failures in pages, WebGPU is banned for this environment (until it changes).
export const GPU_FAILURE_LIMIT = 3;
// Lines on an A4 page (OCR-PLAN §2 E), for the msPerPage estimate.
export const PAGE_LINES = 40;

// The model pair a provider runs (OCR-PLAN §2 E): wasm runs fp16; WebGPU runs fp16 only when the adapter has shader-f16
// (ORT then enables the f16 shaders), otherwise fp32, because fp16 kernels fail WGSL validation without it.
export type Variant = "fp16" | "fp32";
export const variantFor = (p: Provider, shaderF16: boolean): Variant => (p === "wasm" || shaderF16 ? "fp16" : "fp32");

// Trial constants (OCR-PLAN §2 E): the detector side and the recognizer batch that were fastest per provider.
export const detSide = (p: Provider): number => (p === "webgpu" ? 1600 : 960);
export const batchSize = (p: Provider): number => (p === "webgpu" ? 32 : 8);

// The faster provider. A GPU without a time (failed or not tried) loses to wasm.
export function pickFaster(t: { webgpu?: number; wasm?: number }): Provider {
  const g = t.webgpu;
  if (g === undefined || !Number.isFinite(g)) return "wasm";
  return t.wasm === undefined || g < t.wasm ? "webgpu" : "wasm";
}

// Threads need cross-origin isolation (OCR-PLAN §2 B); without it one thread is all the browser allows.
export function threadCount(isolated: boolean, cores: number): number {
  return isolated ? Math.min(4, cores || 1) : 1;
}

// A GPU output counts only when it matches wasm's on the same input. The same fp16 model differs from wasm by well under
// these bounds; a broken GPU kernel gives zeros, which fail the largest-difference bound (the mean alone passes them,
// since most probabilities are near zero).
export function agrees(a: Float32Array, b: Float32Array): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return sum / a.length < 0.02 && max < 0.1;
}

// Time for one page: the detector once, the recognizer once per batch of lines.
export function pageMs(det: number, recBatch: number, batch: number): number {
  return det + recBatch * Math.ceil(PAGE_LINES / batch);
}

export interface AdapterLike {
  info?: { readonly vendor: string; readonly architecture: string };
  features?: { has(name: string): boolean };
}

// The adapter's identity for the measurement key: vendor, architecture and whether it has shader-f16 (it decides the
// model variant on WebGPU, OCR-PLAN §2 E). Nothing user-specific.
export function describeAdapter(a: AdapterLike | null | undefined): string {
  const i = a?.info;
  if (!i) return "";
  const f16 = a?.features?.has("shader-f16") ? " f16" : "";
  return `${i.vendor} ${i.architecture}${f16}`.trim();
}

// navigator.gpu may be missing (no WebGPU) or refuse (policy); both mean no adapter.
export async function requestGpuAdapter(): Promise<GPUAdapter | null> {
  try {
    return (await navigator.gpu?.requestAdapter()) ?? null;
  } catch {
    return null;
  }
}

export interface MeasurementEnv {
  ortVersion: string;
  modelsSum: string;
  adapter: string;
  cpuOnly: boolean;
}

// A stored measurement counts for the same runtime, the same model files, the same adapter and the same cpuOnly choice.
// GPU failures and the GPU ban do not invalidate it: they are stored with it (see gpuBanned in engine.ts).
export function isValid(m: Measurement, env: MeasurementEnv): boolean {
  return (
    m.ortVersion === env.ortVersion &&
    m.modelsSum === env.modelsSum &&
    m.adapter === env.adapter &&
    (m.cpuOnly ?? false) === env.cpuOnly
  );
}
