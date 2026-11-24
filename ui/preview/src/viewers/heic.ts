// HEIC and HEIF. Safari decodes them natively, so the browser is tried first; elsewhere libheif-js decodes them. Its
// script and wasm are separate, unchanged LGPL-3.0 files, loaded by lgpl.ts (PODGLAD-PLAN §5, vendor/lgpl/README.md).
import { lgplAssetPath, loadLgplScript } from "../lgpl";
import { checkDims, showStill, type StillView } from "../still";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

// The part of the libheif-js API used here (libheif-wasm/libheif.js of the package, version 1.23.5).
interface RgbaTarget {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}
interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(target: RgbaTarget, done: (out: RgbaTarget | null) => void): void;
  free(): void;
}
interface HeifDecoder {
  /** The heif context of the last decode; it is freed once the pixels are read. */
  decoder: unknown;
  decode(bytes: Uint8Array): HeifImage[];
}
interface LibHeif {
  HeifDecoder: new () => HeifDecoder;
  heif_context_free(context: unknown): void;
}
type LibHeifFactory = (options: { wasmBinary: ArrayBuffer }) => LibHeif;

/** The browser's own decoder (Safari). Elsewhere createImageBitmap rejects the blob and libheif takes over. */
async function nativeBitmap(bytes: ArrayBuffer): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes], { type: "image/heic" }));
  } catch {
    return null;
  }
}

function bitmapCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = bitmap.width;
  el.height = bitmap.height;
  const g = el.getContext("2d");
  if (!g) throw new PreviewError("internal");
  g.drawImage(bitmap, 0, 0);
  return el;
}

function pixelsCanvas(px: RgbaTarget): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = px.width;
  el.height = px.height;
  const g = el.getContext("2d");
  if (!g) throw new PreviewError("internal");
  g.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
  return el;
}

/** The pixels of the main image. The size check comes before the pixel buffer is allocated. */
async function decodeWithLibheif(bytes: ArrayBuffer, ctx: ViewerContext): Promise<RgbaTarget | null> {
  try {
    await loadLgplScript("libheif");
  } catch {
    throw new PreviewError("unsupported");
  }
  if (ctx.signal.aborted) return null;
  const wasmBinary = await ctx.asset(lgplAssetPath("libheif", "libheif.wasm"));
  if (ctx.signal.aborted) return null;
  const factory = (globalThis as { libheif?: unknown }).libheif;
  if (typeof factory !== "function") throw new PreviewError("unsupported");
  let heif: LibHeif;
  try {
    heif = (factory as LibHeifFactory)({ wasmBinary });
  } catch {
    throw new PreviewError("unsupported");
  }

  const decoder = new heif.HeifDecoder();
  let images: HeifImage[];
  try {
    images = decoder.decode(new Uint8Array(bytes));
  } catch {
    throw new PreviewError("corrupt");
  }
  try {
    const image = images.find((i) => i.is_primary()) ?? images[0];
    if (!image) throw new PreviewError("corrupt");
    const width = image.get_width();
    const height = image.get_height();
    if (width <= 0 || height <= 0) throw new PreviewError("corrupt");
    checkDims(width, height);
    const target: RgbaTarget = { data: new Uint8ClampedArray(width * height * 4), width, height };
    const out = await new Promise<RgbaTarget | null>((resolve) => image.display(target, resolve));
    if (!out) throw new PreviewError("corrupt");
    return ctx.signal.aborted ? null : out;
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) heif.heif_context_free(decoder.decoder);
  }
}

async function decodeToCanvas(bytes: ArrayBuffer, ctx: ViewerContext): Promise<HTMLCanvasElement | null> {
  const bitmap = await nativeBitmap(bytes);
  if (bitmap) {
    try {
      checkDims(bitmap.width, bitmap.height);
      return ctx.signal.aborted ? null : bitmapCanvas(bitmap);
    } finally {
      bitmap.close();
    }
  }
  const px = await decodeWithLibheif(bytes, ctx);
  return px && !ctx.signal.aborted ? pixelsCanvas(px) : null;
}

export function createHeicViewer(): Viewer {
  let view: StillView | null = null;
  let canvas: HTMLCanvasElement | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const el = await decodeToCanvas(bytes, ctx);
      if (!el || ctx.signal.aborted) return;
      canvas = el;
      view = showStill(ctx.host, el, el.width, el.height);
    },

    resize(): void {
      view?.resize();
    },

    command: (name) => view?.command(name),

    swipe: () => view?.swipe() ?? false,

    dispose(): void {
      view?.dispose();
      view = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    },
  };
}
