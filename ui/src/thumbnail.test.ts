// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThumbnail, makeVideoThumbnail, thumbnailFor } from "./thumbnail";

// The frame is not run here: firstFrameOf is replaced, and the canvas and ImageData are stubbed.
const frameStub = vi.hoisted(() => ({ firstFrameOf: vi.fn() }));
vi.mock("./preview/framejob", () => frameStub);

// jsdom has no image decoding or canvas: a bitmap of a given size, and a canvas that records what is drawn.
function stubImage(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  const drawn: number[][] = [];
  const ctx = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn((_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push([w, h])) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    // the browser may refuse WebP and hand back PNG: the code then asks for JPEG
    cb(new Blob(["x"], { type: type === "image/webp" && !webpOk ? "image/png" : type }));
  });
  return { bitmap, drawn };
}
let webpOk = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  webpOk = true;
});

describe("thumbnail", () => {
  it("is null for SVG and any non-raster file, without decoding it", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    expect(await makeThumbnail(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).toBeNull();
    expect(await makeThumbnail(new File(["x"], "a.pdf", { type: "application/pdf" }))).toBeNull();
    expect(await makeThumbnail(new File(["x"], "a.txt", { type: "text/plain" }))).toBeNull();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("fits the longest side into 480 px, keeping the proportions, and returns WebP", async () => {
    const { bitmap, drawn } = stubImage(1200, 600);
    const thumb = await makeThumbnail(new File(["img"], "foto.png", { type: "image/png" }));
    expect(thumb).not.toBeNull();
    expect(thumb!.width).toBe(480);
    expect(thumb!.height).toBe(240);
    expect(drawn).toEqual([[480, 240]]);
    expect(thumb!.blob.type).toBe("image/webp");
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("does not enlarge a small picture", async () => {
    stubImage(100, 50);
    const thumb = await makeThumbnail(new File(["img"], "mala.jpg", { type: "image/jpeg" }));
    expect([thumb!.width, thumb!.height]).toEqual([100, 50]);
  });

  it("falls back to JPEG where the browser cannot write WebP", async () => {
    webpOk = false;
    stubImage(300, 300);
    const thumb = await makeThumbnail(new File(["img"], "foto.png", { type: "image/png" }));
    expect(thumb!.blob.type).toBe("image/jpeg");
  });

  it("is null when the picture cannot be decoded", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("nie obraz"); }));
    expect(await makeThumbnail(new File(["x"], "zepsuty.png", { type: "image/png" }))).toBeNull();
  });
});

describe("thumbnailFor and video thumbnails", () => {
  function stubEncode() {
    vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback, type?: string) => cb(new Blob(["x"], { type })));
  }

  it("a picture goes to the picture path", async () => {
    const bitmap = stubImage(100, 50).bitmap;
    const thumb = await thumbnailFor(new File(["img"], "foto.png", { type: "image/png" }));
    expect(createImageBitmap).toHaveBeenCalled();
    expect(thumb).toMatchObject({ width: 100, height: 50 });
    expect(bitmap.close).toHaveBeenCalled();
    expect(frameStub.firstFrameOf).not.toHaveBeenCalled();
  });

  it("a video by MIME or by extension (with an empty MIME) goes to the first frame", async () => {
    stubEncode();
    frameStub.firstFrameOf.mockResolvedValue({ width: 4, height: 2, pixels: new ArrayBuffer(32), durationMs: 4000 });
    const mp4 = new File(["x"], "klip.mp4", { type: "video/mp4" });
    expect(await thumbnailFor(mp4)).toMatchObject({ width: 4, height: 2, durationMs: 4000 });
    expect(frameStub.firstFrameOf).toHaveBeenLastCalledWith(mp4, "klip.mp4", "video/mp4");
    const mkv = new File(["x"], "film.mkv", { type: "" });
    expect(await thumbnailFor(mkv)).toMatchObject({ width: 4, height: 2 });
    expect(frameStub.firstFrameOf).toHaveBeenLastCalledWith(mkv, "film.mkv", "");
  });

  it("other files get no thumbnail and no frame", async () => {
    expect(await thumbnailFor(new File(["x"], "a.txt", { type: "text/plain" }))).toBeNull();
    expect(frameStub.firstFrameOf).not.toHaveBeenCalled();
  });

  it("a frame error gives no thumbnail", async () => {
    frameStub.firstFrameOf.mockRejectedValue(Object.assign(new Error("timeout"), { code: "timeout" }));
    expect(await makeVideoThumbnail(new File(["x"], "zly.mp4", { type: "video/mp4" }))).toBeNull();
  });
});
