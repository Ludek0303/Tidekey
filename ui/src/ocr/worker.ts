// OCR module worker (OCR-PLAN §2 A, B): holds the ONNX sessions and runs ocrPage on pixels. Started by engine.ts; the
// model files are this app's own hashed assets, fetched from the app's server.
import * as ort from "onnxruntime-web";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import det16 from "../../../vendor/ocr-models/PP-OCRv5_mobile_det.fp16.onnx?url";
import rec16 from "../../../vendor/ocr-models/latin_PP-OCRv5_mobile_rec.fp16.onnx?url";
import det32 from "../../../vendor/ocr-models/PP-OCRv5_mobile_det.fp32.onnx?url";
import rec32 from "../../../vendor/ocr-models/latin_PP-OCRv5_mobile_rec.fp32.onnx?url";
import dictUrl from "../../../vendor/ocr-models/ppocrv5_latin_dict.txt?url";
import { loadDict } from "./pipeline/ctc";
import { cropQuad, recBatchTensor } from "./pipeline/crop";
import { detTensor, type Rgb } from "./pipeline/image";
import { ocrPage, type InferenceSessionLike, type Models, type TensorLike } from "./pipeline/run";
import type { Quad } from "./pipeline/db";
import { agrees, batchSize, describeAdapter, detSide, pageMs, pickFaster, requestGpuAdapter, threadCount, variantFor, type Provider, type Variant } from "./hw";
import type { FromOcrWorker, MeasureReply, PageReply, ToOcrWorker } from "./workerproto";

// Set before the first session: without them ORT would fetch its WASM from a CDN.
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
ort.env.wasm.numThreads = threadCount(crossOriginIsolated, navigator.hardwareConcurrency);

type Stage = "det" | "rec";
const URLS: Record<Variant, Record<Stage, string>> = {
  fp16: { det: det16, rec: rec16 },
  fp32: { det: det32, rec: rec32 },
};
// A session exists only for a stage, variant and provider that were measured or chosen; so a device that never uses
// WebGPU never downloads the fp32 pair.
interface Entry {
  stage: Stage;
  variant: Variant;
  provider: Provider;
  s: ort.InferenceSession;
}
const sessions = new Map<string, Entry>();
const keyOf = (stage: Stage, v: Variant, p: Provider) => `${stage}|${v}|${p}`;
let chars: string[] | null = null;
let f16: boolean | null = null;
// Set by a page with fault injection (engine.ts): the next WebGPU run throws.
let faultNext = false;

interface Timed {
  ms: number;
  out: Float32Array;
}

// A WebGPU stage failed; page() moves that stage to wasm and runs the page again.
class GpuFailure extends Error {
  constructor(readonly stage: Stage) {
    super("gpu");
  }
}

// Reference page (OCR-PLAN §2 E): 12 lines of text, drawn here so the measurement needs no file.
const REF_W = 1240;
const REF_H = 1754;
const REF_TEXT = "Zażółć gęślą jaźń, strona wzorcowa do pomiaru.";
const REF_LINES = 12;
const refQuads: Quad[] = Array.from({ length: REF_LINES }, (_, i) => {
  const y0 = 150 + i * 120 - 4;
  const y1 = y0 + 44;
  return { pts: [[90, y0], [800, y0], [800, y1], [90, y1]], score: 1 };
});

const post = (m: FromOcrWorker) => postMessage(m);
const tensor = (data: Float32Array, dims: number[]): TensorLike => new ort.Tensor("float32", data, dims);

function canvasRgb(c: OffscreenCanvas): Rgb {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas");
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: img.data };
}

function referencePage(): Rgb {
  const c = new OffscreenCanvas(REF_W, REF_H);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, REF_W, REF_H);
  ctx.fillStyle = "#000";
  ctx.font = "28px sans-serif";
  ctx.textBaseline = "top";
  for (let i = 0; i < REF_LINES; i++) ctx.fillText(REF_TEXT, 100, 150 + i * 120);
  return canvasRgb(c);
}

async function shaderF16(): Promise<boolean> {
  if (f16 === null) f16 = (await requestGpuAdapter())?.features.has("shader-f16") ?? false;
  return f16;
}

// The variant of a provider on this adapter (hw.ts variantFor). ORT requests shader-f16 on the device by itself when the
// adapter has it, so no extra device feature is asked for here.
async function modelVariant(p: Provider): Promise<Variant> {
  return variantFor(p, await shaderF16());
}

// The session of a stage, variant and provider, created on first use. A WebGPU failure here counts as a GPU failure too.
async function session(stage: Stage, v: Variant, p: Provider): Promise<ort.InferenceSession> {
  const k = keyOf(stage, v, p);
  const have = sessions.get(k);
  if (have) return have.s;
  try {
    const res = await fetch(URLS[v][stage]);
    if (!res.ok) throw new Error("model");
    const s = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: [p] });
    sessions.set(k, { stage, variant: v, provider: p, s });
    return s;
  } catch (err) {
    if (p === "webgpu") throw new GpuFailure(stage);
    throw err;
  }
}

// Releases the sessions that match `drop`.
async function release(drop: (e: Entry) => boolean): Promise<void> {
  for (const [k, e] of [...sessions]) {
    if (!drop(e)) continue;
    sessions.delete(k);
    await e.s.release();
  }
}

async function dict(): Promise<string[]> {
  if (!chars) {
    const res = await fetch(dictUrl);
    if (!res.ok) throw new Error("model");
    chars = loadDict(await res.text());
  }
  return chars;
}

// Runs a session as the pipeline sees it. A WebGPU failure is rethrown tagged with its stage.
function wrap(stage: Stage, p: Provider, s: ort.InferenceSession): InferenceSessionLike {
  return {
    async run(feeds) {
      try {
        if (p === "webgpu" && faultNext) {
          faultNext = false;
          throw new Error("injected device loss");
        }
        return (await s.run(feeds as unknown as Record<string, ort.Tensor>)) as unknown as Record<string, TensorLike>;
      } catch (err) {
        if (p === "webgpu") throw new GpuFailure(stage);
        throw err;
      }
    },
  };
}

async function models(det: Provider, rec: Provider): Promise<Models> {
  const d = wrap("det", det, await session("det", await modelVariant(det), det));
  const r = wrap("rec", rec, await session("rec", await modelVariant(rec), rec));
  return { det: d, rec: r, chars: await dict() };
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
}

// One warm-up run, then one timed run. Outputs are read back on the CPU, so GPU work is inside the time.
async function timed(run: () => Promise<Record<string, TensorLike>>, signal: AbortSignal): Promise<Timed> {
  check(signal);
  await run();
  check(signal);
  const t0 = performance.now();
  const out = await run();
  const ms = performance.now() - t0;
  const first = Object.values(out)[0];
  if (!first || !(first.data instanceof Float32Array)) throw new Error("shape");
  return { ms, out: first.data };
}

// `side` and `batch` are explicit: the agreement check runs both providers at the same shape, the timing at each
// provider's own (detSide, batchSize).
async function timeDet(side: number, v: Variant, p: Provider, ref: Rgb, signal: AbortSignal): Promise<Timed> {
  const t = detTensor(ref, side);
  const s = wrap("det", p, await session("det", v, p));
  return timed(() => s.run({ x: tensor(t.data, [...t.dims]) }), signal);
}

async function timeRec(batch: number, v: Variant, p: Provider, crops: Rgb[], signal: AbortSignal): Promise<Timed> {
  const b = recBatchTensor(Array.from({ length: batch }, (_, i) => crops[i % crops.length]));
  const s = wrap("rec", p, await session("rec", v, p));
  return timed(() => s.run({ x: tensor(b.data, [...b.dims]) }), signal);
}

// A WebGPU candidate that fails to run is left out.
async function gpuTry<T>(f: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  try {
    return await f();
  } catch {
    check(signal);
    return undefined;
  }
}

// wasm is the reference: it must run, on the fp16 pair (what wasm uses on pages). WebGPU is checked against wasm on the
// same variant as its own, so an fp32 GPU is compared with wasm fp32; wasm fp32 is loaded only for that check.
async function measure(webgpu: boolean, signal: AbortSignal): Promise<MeasureReply> {
  // The adapter is always reported (the engine compares it with the stored measurement), whether WebGPU is tried or not.
  const gpu = await requestGpuAdapter();
  f16 = gpu?.features.has("shader-f16") ?? false;
  const tryGpu = webgpu && gpu !== null;
  const gv = await modelVariant("webgpu");
  const ref = referencePage();
  const crops = refQuads.map((q) => cropQuad(ref, q));
  const det: Partial<Record<Provider, number>> = {};
  const rec: Partial<Record<Provider, number>> = {};
  const wd = await timeDet(detSide("wasm"), "fp16", "wasm", ref, signal);
  const wr = await timeRec(batchSize("wasm"), "fp16", "wasm", crops, signal);
  det.wasm = wd.ms;
  rec.wasm = wr.ms;
  let refD = wd;
  let refR = wr;
  if (tryGpu && gv === "fp32") {
    refD = await timeDet(detSide("wasm"), "fp32", "wasm", ref, signal);
    refR = await timeRec(batchSize("wasm"), "fp32", "wasm", crops, signal);
  }
  if (tryGpu) {
    const dOk = await gpuTry(() => timeDet(detSide("wasm"), gv, "webgpu", ref, signal), signal);
    if (dOk && agrees(dOk.out, refD.out))
      det.webgpu = (await gpuTry(() => timeDet(detSide("webgpu"), gv, "webgpu", ref, signal), signal))?.ms;
    const rOk = await gpuTry(() => timeRec(batchSize("wasm"), gv, "webgpu", crops, signal), signal);
    if (rOk && agrees(rOk.out, refR.out))
      rec.webgpu = (await gpuTry(() => timeRec(batchSize("webgpu"), gv, "webgpu", crops, signal), signal))?.ms;
  }
  const dp = pickFaster(det);
  const rp = pickFaster(rec);
  const keep = new Set([keyOf("det", await modelVariant(dp), dp), keyOf("rec", await modelVariant(rp), rp)]);
  // Only losing WebGPU sessions are released now. Releasing a wasm session while WebGPU sessions live breaks them
  // (ORT's WebGPU kernels fail with "no GPU data for input"; measured); wasm sessions stay until release().
  await release((e) => e.provider === "webgpu" && !keep.has(keyOf(e.stage, e.variant, e.provider)));
  const dms = det[dp];
  const rms = rec[rp];
  if (dms === undefined || rms === undefined) throw new Error("measure");
  const gpuRejected = tryGpu && (det.webgpu === undefined || rec.webgpu === undefined);
  return { det: dp, rec: rp, msPerPage: pageMs(dms, rms, batchSize(rp)), adapter: describeAdapter(gpu), gpuRejected };
}

async function page(bitmap: ImageBitmap, det0: Provider, rec0: Provider, fault: boolean, signal: AbortSignal): Promise<PageReply> {
  // Drawn first: the bitmap is closed here even when the job was cancelled while queued.
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = canvasRgb(c);
  let det = det0;
  let rec = rec0;
  let fellBack = false;
  faultNext = fault;
  try {
    for (;;) {
      try {
        const out = await ocrPage(img, await models(det, rec), tensor, {
          detSide: detSide(det),
          batch: batchSize(rec),
          signal,
        });
        return {
          lines: out.lines,
          quality: out.quality,
          noText: out.noText,
          provider: { det, rec },
          ms: out.ms.det + out.ms.rec,
          fellBack,
        };
      } catch (err) {
        if (!(err instanceof GpuFailure)) throw err;
        fellBack = true;
        await release((e) => e.stage === err.stage && e.provider === "webgpu");
        if (err.stage === "det") det = "wasm";
        else rec = "wasm";
      }
    }
  } finally {
    faultNext = false;
  }
}

async function releaseAll(): Promise<void> {
  await release(() => true);
}

// Requests run one at a time; a cancel aborts the one with that id (between batches) or the one still queued.
const controllers = new Map<number, AbortController>();
let chain: Promise<void> = Promise.resolve();

async function handle(msg: ToOcrWorker, signal: AbortSignal): Promise<void> {
  try {
    if (msg.type === "measure") post({ type: "measured", id: msg.id, value: await measure(msg.webgpu, signal) });
    else if (msg.type === "page")
      post({ type: "page", id: msg.id, value: await page(msg.bitmap, msg.det, msg.rec, msg.fault, signal) });
    else {
      await releaseAll();
      post({ type: "released", id: msg.id });
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error("ocr");
    post({ type: "error", id: msg.id, name: e.name, message: e.message });
  } finally {
    controllers.delete(msg.id);
  }
}

onmessage = (e: MessageEvent<ToOcrWorker>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
    return;
  }
  const ac = new AbortController();
  controllers.set(msg.id, ac);
  chain = chain.then(() => handle(msg, ac.signal));
};
