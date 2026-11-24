// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewError } from "./viewers/index";
import { previewWasm } from "./previewwasm";
import { keyframeFrame } from "./keyframe";
import { FRAME_TIMEOUT_MS } from "./firstframe";

vi.mock("./previewwasm", () => ({ previewWasm: vi.fn() }));

// jsdom has no WebCodecs, no createImageBitmap and no canvas: the WASM module, the decoder and the bitmap are stubs
// that record what they were given; the canvas context is a stub that returns zeroed pixels.

type Keyframe = {
  codec: string;
  description: Uint8Array | undefined;
  width: number;
  height: number;
  data: Uint8Array;
  durationMs: number | undefined;
  free: () => void;
};

const asset = async (): Promise<ArrayBuffer> => new ArrayBuffer(0);
const signal = (): AbortSignal => new AbortController().signal;
const bytes = (): ArrayBuffer => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]).buffer;

let key: Keyframe;
let decoders: FakeDecoder[];
let flushes: { resolve: () => void; reject: (e: unknown) => void }[];
let bitmapClose: ReturnType<typeof vi.fn>;

// The decoder's output and error callbacks are kept so a test can call them, the way the browser would.
class FakeDecoder {
  static isConfigSupported = vi.fn(async (_config: unknown) => ({ supported: true }));
  configure = vi.fn();
  decode = vi.fn();
  close = vi.fn();
  flush = vi.fn(() => new Promise<void>((resolve, reject) => flushes.push({ resolve, reject })));
  constructor(readonly init: { output: (f: FakeFrame) => void; error: (e: unknown) => void }) {
    decoders.push(this);
  }
}

class FakeFrame {
  close = vi.fn();
  constructor(readonly displayWidth: number, readonly displayHeight: number) {}
}

class FakeChunk {
  constructor(readonly init: { type: string; timestamp: number; data: Uint8Array }) {}
}

function wasmReturns(k: Keyframe): void {
  vi.mocked(previewWasm).mockResolvedValue({
    videoFirstKeyframe: vi.fn(() => k),
  } as unknown as Awaited<ReturnType<typeof previewWasm>>);
}

function wasmThrows(err: unknown): void {
  vi.mocked(previewWasm).mockResolvedValue({
    videoFirstKeyframe: vi.fn(() => {
      throw err;
    }),
  } as unknown as Awaited<ReturnType<typeof previewWasm>>);
}

beforeEach(() => {
  key = {
    codec: "avc1.42C01E",
    description: new Uint8Array([1, 0x42, 0xc0, 0x1e]),
    width: 1920,
    height: 1080,
    data: new Uint8Array([9, 9, 9]),
    durationMs: 4000,
    free: vi.fn(),
  };
  decoders = [];
  flushes = [];
  bitmapClose = vi.fn();
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", FakeChunk);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 320, height: 240, close: bitmapClose })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }) as unknown as CanvasRenderingContext2D,
  );
  FakeDecoder.isConfigSupported.mockClear();
  FakeDecoder.isConfigSupported.mockImplementation(async () => ({ supported: true }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Decoder output as the browser would deliver it: one frame, then flush resolves. */
function deliverFrame(w: number, h: number): FakeFrame {
  const frame = new FakeFrame(w, h);
  decoders[0]?.init.output(frame);
  flushes[0]?.resolve();
  return frame;
}

describe("keyframeFrame: MJPEG", () => {
  it("mjpeg idzie jako JPEG przez createImageBitmap, bez dekodera", async () => {
    wasmReturns({ ...key, codec: "mjpeg", description: undefined, width: 320, height: 240 });
    const frame = await keyframeFrame(bytes(), asset, signal());
    const bitmapFn = vi.mocked(createImageBitmap);
    const blob = bitmapFn.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/jpeg");
    expect(decoders).toHaveLength(0);
    expect(frame).toMatchObject({ width: 320, height: 240, durationMs: 4000 });
    expect(frame.pixels.byteLength).toBe(320 * 240 * 4);
    expect(bitmapClose).toHaveBeenCalled();
    expect(key.free).toHaveBeenCalled();
  });

  it("zepsuty JPEG to corrupt", async () => {
    wasmReturns({ ...key, codec: "mjpeg", description: undefined });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new DOMException("bad", "InvalidStateError"))));
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("keyframeFrame: WebCodecs", () => {
  it("avc z description: isConfigSupported dostaje description i kodek", async () => {
    wasmReturns(key);
    const p = keyframeFrame(bytes(), asset, signal());
    await vi.waitFor(() => expect(decoders).toHaveLength(1));
    deliverFrame(640, 360);
    await p;
    const config = FakeDecoder.isConfigSupported.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      codec: "avc1.42C01E",
      codedWidth: 1920,
      codedHeight: 1080,
      optimizeForLatency: true,
    });
    expect(config.description).toEqual(new Uint8Array([1, 0x42, 0xc0, 0x1e]));
  });

  it("klatka z dekodera rysowana w rozmiarze miniatury, z długością", async () => {
    wasmReturns(key);
    const p = keyframeFrame(bytes(), asset, signal());
    await vi.waitFor(() => expect(decoders).toHaveLength(1));
    const frame = deliverFrame(1920, 1080);
    const result = await p;
    expect(result.width).toBe(480);
    expect(result.height).toBe(270);
    expect(result.pixels.byteLength).toBe(480 * 270 * 4);
    expect(result.durationMs).toBe(4000);
    expect(frame.close).toHaveBeenCalled();
    expect(decoders[0]?.close).toHaveBeenCalled();
    const chunk = decoders[0]?.decode.mock.calls[0]?.[0] as FakeChunk;
    expect(chunk.init).toMatchObject({ type: "key", timestamp: 0 });
  });

  it("nieobsługiwany kodek (isConfigSupported = false) to codec i dekoder nie powstaje", async () => {
    wasmReturns(key);
    FakeDecoder.isConfigSupported.mockResolvedValue({ supported: false });
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "codec" });
    expect(decoders).toHaveLength(0);
  });

  it("brak VideoDecoder to codec", async () => {
    wasmReturns(key);
    vi.stubGlobal("VideoDecoder", undefined);
    const err = await keyframeFrame(bytes(), asset, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect(err).toMatchObject({ code: "codec" });
  });

  it("błąd dekodera to codec i dekoder zamknięty", async () => {
    wasmReturns(key);
    const p = keyframeFrame(bytes(), asset, signal());
    await vi.waitFor(() => expect(decoders).toHaveLength(1));
    decoders[0]?.init.error(new Error("decode"));
    flushes[0]?.reject(new Error("decode"));
    await expect(p).rejects.toMatchObject({ code: "codec" });
    expect(decoders[0]?.close).toHaveBeenCalled();
  });

  it("dekoder bez klatki to corrupt", async () => {
    wasmReturns(key);
    const p = keyframeFrame(bytes(), asset, signal());
    await vi.waitFor(() => expect(flushes).toHaveLength(1));
    flushes[0]?.resolve();
    await expect(p).rejects.toMatchObject({ code: "corrupt" });
    expect(decoders[0]?.close).toHaveBeenCalled();
  });

  it("dekoder zamknięty także przy limicie czasu (5 s)", async () => {
    vi.useFakeTimers();
    wasmReturns(key);
    const p = keyframeFrame(bytes(), asset, signal());
    const outcome = p.catch((e: unknown) => e);
    await vi.waitFor(() => expect(decoders).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS);
    await expect(outcome).resolves.toMatchObject({ code: "timeout" });
    expect(decoders[0]?.close).toHaveBeenCalled();
  });

  it("dekoder zamknięty także przy przerwaniu", async () => {
    wasmReturns(key);
    const ctrl = new AbortController();
    const p = keyframeFrame(bytes(), asset, ctrl.signal);
    const outcome = p.catch((e: unknown) => e);
    await vi.waitFor(() => expect(decoders).toHaveLength(1));
    ctrl.abort();
    expect(((await outcome) as DOMException).name).toBe("AbortError");
    expect(decoders[0]?.close).toHaveBeenCalled();
  });
});

describe("keyframeFrame: błędy WASM", () => {
  it("kod corrupt z WASM to PreviewError corrupt", async () => {
    wasmThrows(new Error("corrupt"));
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "corrupt" });
  });

  it("kod too-large z WASM to PreviewError too-large", async () => {
    wasmThrows(new Error("too-large"));
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "too-large" });
  });

  it("kod unsupported z WASM to PreviewError unsupported", async () => {
    wasmThrows(new Error("unsupported"));
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "unsupported" });
  });

  it("panika WASM (RuntimeError) to corrupt", async () => {
    wasmThrows(new WebAssembly.RuntimeError("unreachable"));
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "corrupt" });
  });

  it("wymiary ponad 8192 to too-large, bez dekodera", async () => {
    wasmReturns({ ...key, width: 9000, height: 100 });
    await expect(keyframeFrame(bytes(), asset, signal())).rejects.toMatchObject({ code: "too-large" });
    expect(decoders).toHaveLength(0);
  });
});
