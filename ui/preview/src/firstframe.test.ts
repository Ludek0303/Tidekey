// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewError } from "./viewers/index";
import { FRAME_TIMEOUT_MS, firstFrame, thumbSize } from "./firstframe";
import { keyframeFrame } from "./keyframe";

vi.mock("./keyframe", () => ({ keyframeFrame: vi.fn() }));

const noAsset = async (): Promise<ArrayBuffer> => new ArrayBuffer(0);
const mkv = (): ArrayBuffer => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0, 0, 0]).buffer;

// jsdom has no media decoder and no canvas: the video element is real (events are dispatched on it), the
// canvas context is a stub that returns a black frame of the requested size.
let video: HTMLVideoElement;

function setVideo(width: number, height: number, duration = 4): void {
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
}

const fire = (type: string): void => {
  video.dispatchEvent(new Event(type));
};

const mp4 = (): ArrayBuffer => {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 16], 0);
  b.set(new TextEncoder().encode("ftypisom"), 4);
  return b.buffer;
};

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:test/1");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }) as unknown as CanvasRenderingContext2D,
  );
  video = document.createElement("video");
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) =>
    tag === "video" ? video : realCreate(tag, options)) as typeof document.createElement);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("thumbSize", () => {
  it("skaluje dłuższy bok do 480 z zachowaniem proporcji", () => {
    expect(thumbSize(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(thumbSize(1080, 1920)).toEqual({ width: 270, height: 480 });
  });

  it("nie powiększa małych klatek", () => {
    expect(thumbSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it("każdy bok zostaje co najmniej 1 px", () => {
    expect(thumbSize(5000, 1)).toEqual({ width: 480, height: 1 });
  });
});

describe("firstFrame", () => {
  it("sukces: klatka w rozmiarze miniatury, pełne piksele i długość w ms", async () => {
    setVideo(1920, 1080, 4);
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    fire("loadeddata");
    fire("seeked");
    const frame = await p;
    expect(frame.width).toBe(480);
    expect(frame.height).toBe(270);
    expect(frame.pixels.byteLength).toBe(480 * 270 * 4);
    expect(frame.durationMs).toBe(4000);
  });

  it("bez skończonej długości nie podaje durationMs", async () => {
    setVideo(300, 200, Infinity);
    const p = firstFrame(mp4(), "video/webm", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    fire("seeked");
    const frame = await p;
    expect(frame.durationMs).toBeUndefined();
  });

  it("gdy jest requestVideoFrameCallback, klatka bierze się z callbacku", async () => {
    setVideo(300, 200);
    let callback: (() => void) | undefined;
    Object.defineProperty(video, "requestVideoFrameCallback", {
      value: (cb: () => void) => { callback = cb; return 1; },
      configurable: true,
    });
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    fire("loadeddata");
    expect(video.currentTime).toBe(0);
    callback?.();
    expect((await p).width).toBe(300);
  });

  it("pusty typ MIME: typ Bloba bierze się z bajtów", async () => {
    setVideo(300, 200);
    const p = firstFrame(mp4(), "", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    fire("seeked");
    await p;
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("video/mp4");
  });

  it("błąd elementu wideo to codec", async () => {
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    fire("error");
    await expect(p).rejects.toBeInstanceOf(PreviewError);
    await expect(p).rejects.toMatchObject({ code: "codec" });
  });

  it("wymiary ponad 8192 to too-large", async () => {
    setVideo(9000, 100);
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    await expect(p).rejects.toMatchObject({ code: "too-large" });
  });

  it("zerowa szerokość po metadanych to codec (dźwięk bez obrazu)", async () => {
    setVideo(0, 0);
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    await expect(p).rejects.toMatchObject({ code: "codec" });
  });

  it("brak zdarzeń: timeout po 5 s i sprzątanie", async () => {
    vi.useFakeTimers();
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    const outcome = p.catch((e: unknown) => e);
    expect(document.body.contains(video)).toBe(true);
    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS - 1);
    expect(document.body.contains(video)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ code: "timeout" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
    expect(document.body.contains(video)).toBe(false);
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("przerwanie w trakcie: AbortError i sprzątanie", async () => {
    const ctrl = new AbortController();
    const p = firstFrame(mp4(), "video/mp4", ctrl.signal, noAsset);
    const outcome = p.catch((e: unknown) => e);
    ctrl.abort();
    const err = await outcome;
    expect((err as DOMException).name).toBe("AbortError");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
    expect(document.body.contains(video)).toBe(false);
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("po sprzątaniu zdarzenia nie zmieniają wyniku", async () => {
    setVideo(300, 200);
    const ctrl = new AbortController();
    const p = firstFrame(mp4(), "video/mp4", ctrl.signal, noAsset);
    const outcome = p.catch((e: unknown) => e);
    ctrl.abort();
    fire("seeked");
    fire("error");
    expect(((await outcome) as DOMException).name).toBe("AbortError");
  });
});

describe("firstFrame: wybór drogi dla mkv i avi", () => {
  const aviBytes = (): ArrayBuffer => {
    const b = new Uint8Array(16);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("AVI "), 8);
    return b.buffer;
  };

  it("mkv: najpierw WASM, klatka z WASM wraca bez <video>", async () => {
    const frame = { width: 480, height: 270, pixels: new ArrayBuffer(4), durationMs: 1000 };
    vi.mocked(keyframeFrame).mockResolvedValue(frame);
    const created = vi.spyOn(document, "createElement");
    await expect(firstFrame(mkv(), "video/x-matroska", new AbortController().signal, noAsset)).resolves.toBe(frame);
    expect(keyframeFrame).toHaveBeenCalledTimes(1);
    expect(created.mock.calls.some(([tag]) => tag === "video")).toBe(false);
  });

  it("mkv: WASM unsupported → próba <video>", async () => {
    setVideo(300, 200);
    vi.mocked(keyframeFrame).mockRejectedValue(new PreviewError("unsupported"));
    const p = firstFrame(mkv(), "video/x-matroska", new AbortController().signal, noAsset);
    await vi.waitFor(() => expect(video.hasAttribute("src")).toBe(true));
    fire("loadedmetadata");
    fire("seeked");
    expect((await p).width).toBe(300);
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("avi: WASM codec → próba <video>", async () => {
    setVideo(300, 200);
    vi.mocked(keyframeFrame).mockRejectedValue(new PreviewError("codec"));
    const p = firstFrame(aviBytes(), "video/x-msvideo", new AbortController().signal, noAsset);
    await vi.waitFor(() => expect(video.hasAttribute("src")).toBe(true));
    fire("loadedmetadata");
    fire("seeked");
    expect((await p).width).toBe(300);
  });

  it("mkv: WASM corrupt → corrupt bez próby <video>", async () => {
    vi.mocked(keyframeFrame).mockRejectedValue(new PreviewError("corrupt"));
    const created = vi.spyOn(document, "createElement");
    await expect(firstFrame(mkv(), "video/x-matroska", new AbortController().signal, noAsset)).rejects.toMatchObject({
      code: "corrupt",
    });
    expect(created.mock.calls.some(([tag]) => tag === "video")).toBe(false);
  });

  it("mp4: WASM nie jest używany", async () => {
    setVideo(300, 200);
    const p = firstFrame(mp4(), "video/mp4", new AbortController().signal, noAsset);
    fire("loadedmetadata");
    fire("seeked");
    await p;
    expect(keyframeFrame).not.toHaveBeenCalled();
  });
});
