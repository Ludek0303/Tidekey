import { describe, expect, it, vi } from "vitest";
import type { FromWorker, StartOptions, ToWorker } from "./types";
import { VoiceError } from "./types";
import { WorkerVoice, type WorkerLike } from "./voice";

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  transfers: Transferable[][] = [];
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  terminate = vi.fn();
  postMessage(m: ToWorker, transfer?: Transferable[]): void {
    this.sent.push(m);
    this.transfers.push(transfer ?? []);
  }
  emit(m: FromWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  }
}

const opts: StartOptions = { engine: "mock", variant: "cpu", download: false };

// A capture that never fails and does nothing; the tests below replace it where they need to.
const quietCapture = async () => ({ stop: vi.fn() });

// start() waits for the worker to report "listening" before it opens the mic; this plays the worker's part.
async function startListening(voice: WorkerVoice, fake: FakeWorker, o: StartOptions = opts): Promise<void> {
  const started = voice.start(o);
  fake.emit({ type: "status", value: "listening" });
  await started;
}

describe("WorkerVoice", () => {
  it("creates the worker on the first start and passes the options to it", async () => {
    const fake = new FakeWorker();
    const makeWorker = vi.fn(() => fake);
    const voice = new WorkerVoice(makeWorker, quietCapture);
    expect(makeWorker).not.toHaveBeenCalled();
    await startListening(voice, fake);
    expect(makeWorker).toHaveBeenCalledTimes(1);
    expect(fake.sent).toEqual([{ type: "start", ...opts }]);
    voice.stop();
    expect(fake.sent.at(-1)).toEqual({ type: "stop" });
  });

  it("delivers each worker message to the listeners of its type", async () => {
    const fake = new FakeWorker();
    const voice = new WorkerVoice(() => fake, quietCapture);
    await startListening(voice, fake);
    const onFinal = vi.fn();
    const onStatus = vi.fn();
    voice.on("final", onFinal);
    voice.on("status", onStatus);
    fake.emit({ type: "final", value: "tekst" });
    fake.emit({ type: "status", value: "listening" });
    expect(onFinal).toHaveBeenCalledWith("tekst");
    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("stops delivering to a listener after its unsubscribe function runs", async () => {
    const fake = new FakeWorker();
    const voice = new WorkerVoice(() => fake, quietCapture);
    await startListening(voice, fake);
    const cb = vi.fn();
    const off = voice.on("final", cb);
    off();
    fake.emit({ type: "final", value: "tekst" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("dispose terminates the worker", async () => {
    const fake = new FakeWorker();
    const voice = new WorkerVoice(() => fake, quietCapture);
    await startListening(voice, fake);
    voice.dispose();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it("sends captured frames to the worker as audio, transferring their buffers", async () => {
    const fake = new FakeWorker();
    let onFrame: (f: Float32Array) => void = () => {};
    const voice = new WorkerVoice(() => fake, async (cb) => {
      onFrame = cb;
      return { stop: vi.fn() };
    });
    await startListening(voice, fake);
    const frame = new Float32Array(512);
    onFrame(frame);
    expect(fake.sent.at(-1)).toEqual({ type: "audio", pcm: frame });
    expect(fake.transfers.at(-1)).toEqual([frame.buffer]);
  });

  it("reports a refused microphone as an error and goes idle", async () => {
    const fake = new FakeWorker();
    const voice = new WorkerVoice(() => fake, async () => {
      throw new VoiceError("mic-denied");
    });
    const onError = vi.fn();
    const onStatus = vi.fn();
    voice.on("error", onError);
    voice.on("status", onStatus);
    await startListening(voice, fake);
    expect(onError).toHaveBeenCalledWith({ code: "mic-denied" });
    expect(onStatus).toHaveBeenLastCalledWith("idle");
    expect(fake.sent.at(-1)).toEqual({ type: "stop" });
  });

  it("does not open the mic while the worker downloads, and returns when it fails", async () => {
    const fake = new FakeWorker();
    const capture = vi.fn(quietCapture);
    const voice = new WorkerVoice(() => fake, capture);
    const started = voice.start({ ...opts, download: true });
    fake.emit({ type: "status", value: "downloading" });
    fake.emit({ type: "progress", value: { loaded: 1, total: 2 } });
    fake.emit({ type: "error", value: { code: "download" } });
    await started;
    expect(capture).not.toHaveBeenCalled();
  });

  it("never opens the mic when stopped before the worker listens", async () => {
    const fake = new FakeWorker();
    const capture = vi.fn(quietCapture);
    const voice = new WorkerVoice(() => fake, capture);
    const started = voice.start({ ...opts, download: true });
    voice.stop();
    await started;
    fake.emit({ type: "status", value: "listening" });
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
  });

  it("stops a capture that finishes after stop() was called", async () => {
    const fake = new FakeWorker();
    let finish: (s: { stop(): void }) => void = () => {};
    const session = { stop: vi.fn() };
    const voice = new WorkerVoice(() => fake, () => new Promise((resolve) => (finish = resolve)));
    const started = voice.start(opts);
    fake.emit({ type: "status", value: "listening" });
    await new Promise((r) => setTimeout(r, 0)); // the capture has started, and stop() comes after it
    voice.stop();
    finish(session);
    await started;
    expect(session.stop).toHaveBeenCalledTimes(1);
  });
});
