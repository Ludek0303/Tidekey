// Voice worker: Silero VAD cuts the audio into speech fragments, the engine turns each one into text (docs/DYKTOWANIE.md §4).
import * as ort from "onnxruntime-web";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { asrEntries, fileUrl, missing, pruneOld, downloadToOpfs, vadEntry, type Entry } from "./modelstore";
import { createParakeet, mockAsr, type AsrEngine } from "./engine";
import { DEFAULT_ASR, VAD_MODEL } from "./models";
import { SileroVad, Segmenter } from "./vad";
import { finishPartial, newGate, shouldPartial, type PartialGate } from "./partial";
import { VoiceError, type FromWorker, type StartOptions, type ToWorker, type VoiceStatus } from "./types";

// Set before any parakeet.js call: it keeps wasmPaths when present, and would otherwise fetch WASM from a CDN.
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
// Threads need COOP/COEP (docs/DYKTOWANIE.md §7); without them one thread is all the browser allows.
const threads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
ort.env.wasm.numThreads = threads;

const post = (m: FromWorker) => postMessage(m);
const status = (value: VoiceStatus) => post({ type: "status", value });

let vad: SileroVad | null = null;
let asr: AsrEngine = mockAsr;
let asrKey: string | null = null; // "mock" or the variant that `asr` was built for
const segmenter = new Segmenter();
let listening = false;
let gate: PartialGate = newGate();
let abort: AbortController | null = null;
// Everything runs in this queue, so frames wait for the model and a stop comes after the frames already queued.
let chain: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  chain = chain.then(task).catch((err: unknown) => {
    post({ type: "error", value: { code: "internal", detail: String(err) } });
    status(listening ? "listening" : "idle");
  });
}

async function transcribe(fragment: Float32Array): Promise<void> {
  status("processing");
  const text = await asr.transcribe(fragment);
  if (text) post({ type: "final", value: text });
  if (listening) status("listening");
}

// Recognises the open fragment for the words on screen before its final. It runs in the queue, so the segmenter is
// as the frames before it left it: a fragment that closed meanwhile has already sent its final, and nothing is shown.
async function partial(): Promise<void> {
  if (!segmenter.open()) {
    gate.busy = false;
    return;
  }
  const t0 = performance.now();
  try {
    const text = await asr.transcribe(segmenter.openAudio(), true);
    if (text) post({ type: "partial", value: text });
  } finally {
    finishPartial(gate, performance.now(), performance.now() - t0);
  }
}

async function handleFrame(frame: Float32Array): Promise<void> {
  if (!vad) return;
  const prob = await vad.prob(frame);
  for (const fragment of segmenter.push(frame, prob)) await transcribe(fragment);
  const open = segmenter.open();
  if (open && shouldPartial(gate, performance.now(), open)) {
    gate.busy = true;
    enqueue(partial);
  }
}

// Gives the blob URLs of `entries` to `use`, then revokes them: the session has read what it needs by then.
async function withBlobUrls<T>(entries: Entry[], use: (urls: string[]) => Promise<T>): Promise<T> {
  const urls = await Promise.all(entries.map((e) => fileUrl(e.id, e.file)));
  try {
    return await use(urls);
  } finally {
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function download(need: Entry[], signal: AbortSignal): Promise<void> {
  const total = need.reduce((n, e) => n + e.file.size, 0);
  let loaded = 0;
  let last = 0;
  // Progress messages come at most every 200 ms; the final one is sent by the caller.
  const report = (force: boolean) => {
    const now = Date.now();
    if (!force && now - last < 200) return;
    last = now;
    post({ type: "progress", value: { loaded, total } });
  };
  status("downloading");
  for (const { id, file } of need) {
    await downloadToOpfs(id, file, (n) => {
      loaded += n;
      report(false);
    }, signal);
  }
  report(true);
}

// The model lives in OPFS (sync access handles) and runs on WebAssembly; a browser without either cannot dictate.
function unsupported(): boolean {
  return (
    typeof WebAssembly === "undefined" ||
    typeof FileSystemFileHandle === "undefined" ||
    !navigator.storage?.getDirectory ||
    !("createSyncAccessHandle" in FileSystemFileHandle.prototype)
  );
}

function start(opts: StartOptions): void {
  listening = true;
  gate = newGate();
  enqueue(async () => {
    // A stop that came before this task ran already ended the session.
    if (!listening) return;
    if (unsupported()) {
      listening = false;
      post({ type: "error", value: { code: "unsupported", detail: "brak OPFS lub WebAssembly" } });
      status("idle");
      return;
    }
    const parakeet = opts.engine === "parakeet";
    const entries = [vadEntry, ...(parakeet ? asrEntries(opts.variant) : [])];
    abort = new AbortController();
    try {
      const need = await missing(entries);
      if (need.length && !opts.download) throw new VoiceError("model", "brak plików modelu");
      if (need.length) await download(need, abort.signal);
      await pruneOld([VAD_MODEL.id, DEFAULT_ASR.id]).catch(() => {});

      status("loading");
      vad ??= await withBlobUrls([vadEntry], ([url]) => SileroVad.create(ort, url));
      const key = parakeet ? opts.variant : "mock";
      if (key !== asrKey) {
        asr = parakeet
          ? await withBlobUrls(asrEntries(opts.variant), ([encoder, decoder, vocab]) =>
              createParakeet({ encoder, decoder, vocab }, opts.variant, threads),
            )
          : mockAsr;
        asrKey = key;
      }
      if (listening) status("listening");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        status("idle");
        return;
      }
      listening = false;
      const e = err instanceof VoiceError ? { code: err.code, detail: err.message } : { code: "model" as const, detail: String(err) };
      post({ type: "error", value: e });
      status("idle");
    }
  });
}

function stop(): void {
  listening = false;
  abort?.abort();
  enqueue(async () => {
    for (const fragment of segmenter.flush()) await transcribe(fragment);
    vad?.reset();
    status("idle");
  });
}

onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "start") start(msg);
  else if (msg.type === "audio") {
    if (listening) enqueue(() => handleFrame(msg.pcm));
  } else if (msg.type === "stop") stop();
};
