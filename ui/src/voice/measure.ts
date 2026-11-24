// Dev-only measurement page: runs one model/encoder/backend over a set of WAV files and reports WER, CER and speed
// (docs/DYKTOWANIE.md §8). Driven by scripts/measure-dictation.cjs through window.runMeasure.
import * as ort from "onnxruntime-web";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { createParakeet } from "./engine";
import { ASR_MODELS, VAD_MODEL, modelUrl } from "./models";
import { Resampler, Framer } from "./resample";
import { SileroVad, Segmenter } from "./vad";
import { parseWav } from "./wav";
import { aggregate, cer, werCased, wer, type Score } from "./wer";
import { joinFragment } from "./insert";

// Same setup as worker.ts: the paths must be set before the first session.
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

export interface MeasureConfig {
  model: string;
  encoder: "encoderGpu" | "encoderCpu" | "encoderQ4";
  backend: "webgpu" | "wasm";
  threads?: number;
}

export interface MeasureFile {
  name: string;
  wav: string;
  ref: string;
}

export interface FileResult {
  name: string;
  audioSec: number;
  procMs: number;
  fragments: { latencyMs: number }[];
  ref: string;
  hyp: string;
  wer: Score;
  cer: Score;
  werCased: Score;
}

export interface MeasureResult {
  config: MeasureConfig;
  loadMs: number;
  files: FileResult[];
  totals: {
    wer: Score;
    cer: Score;
    werCased: Score;
    audioSec: number;
    procMs: number;
    rtf: number;
    latencyMedianMs: number | null;
    latencyP95Ms: number | null;
    fragments: number;
  };
}

// Nearest-rank quantile of a sorted list.
const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;

async function measure(config: MeasureConfig, files: MeasureFile[]): Promise<MeasureResult> {
  const model = ASR_MODELS.find((m) => m.id === config.model);
  if (!model) throw new Error(`nieznany model ${config.model}`);
  const encoder = model.files[config.encoder];
  if (!encoder) throw new Error(`model ${model.id} nie ma pliku ${config.encoder}`);
  // Without cross-origin isolation the browser allows one thread; the same rule as in worker.ts.
  const threads = config.threads ?? (crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1);
  ort.env.wasm.numThreads = threads;

  const t0 = performance.now();
  const vad = await SileroVad.create(ort, modelUrl(VAD_MODEL.id, VAD_MODEL.file));
  const engine = await createParakeet(
    {
      encoder: modelUrl(model.id, encoder),
      decoder: modelUrl(model.id, model.files.decoder),
      vocab: modelUrl(model.id, model.files.vocab),
    },
    config.backend === "webgpu" ? "gpu" : "cpu",
    threads,
  );
  const loadMs = performance.now() - t0;

  const results: FileResult[] = [];
  for (const f of files) {
    const { rate, pcm } = parseWav(await (await fetch(f.wav)).arrayBuffer());
    const frames = new Framer(512).push(new Resampler(rate).push(pcm));
    const segmenter = new Segmenter();
    const fragments: Float32Array[] = [];
    let procMs = 0;
    for (const frame of frames) {
      const t = performance.now();
      const prob = await vad.prob(frame);
      procMs += performance.now() - t;
      fragments.push(...segmenter.push(frame, prob));
    }
    fragments.push(...segmenter.flush());

    // Each fragment is joined as the editor joins it: insert at the end of the text so far.
    let hyp = "";
    const lat: { latencyMs: number }[] = [];
    for (const frag of fragments) {
      const t = performance.now();
      const text = await engine.transcribe(frag);
      const latencyMs = performance.now() - t;
      procMs += latencyMs;
      lat.push({ latencyMs });
      hyp += joinFragment(hyp, "", text);
    }
    results.push({
      name: f.name,
      audioSec: pcm.length / rate,
      procMs,
      fragments: lat,
      ref: f.ref,
      hyp,
      wer: wer(f.ref, hyp),
      cer: cer(f.ref, hyp),
      werCased: werCased(f.ref, hyp),
    });
  }

  const lat = results.flatMap((r) => r.fragments.map((x) => x.latencyMs)).sort((a, b) => a - b);
  const audioSec = results.reduce((n, r) => n + r.audioSec, 0);
  const procMs = results.reduce((n, r) => n + r.procMs, 0);
  return {
    config,
    loadMs,
    files: results,
    totals: {
      wer: aggregate(results.map((r) => r.wer)),
      cer: aggregate(results.map((r) => r.cer)),
      werCased: aggregate(results.map((r) => r.werCased)),
      audioSec,
      procMs,
      rtf: procMs / 1000 / audioSec,
      latencyMedianMs: quantile(lat, 0.5),
      latencyP95Ms: quantile(lat, 0.95),
      fragments: lat.length,
    },
  };
}

export async function runMeasure(config: MeasureConfig, files: MeasureFile[]): Promise<MeasureResult | { config: MeasureConfig; error: string }> {
  try {
    return await measure(config, files);
  } catch (e) {
    return { config, error: String(e) };
  }
}

// Hardware facts for the report; the adapter is null when WebGPU is missing.
export async function hardware() {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated,
    webgpu: adapter
      ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, shaderF16: adapter.features.has("shader-f16") }
      : null,
  };
}

Object.assign(window, { runMeasure, hardware });
