//! Thumbnails of pictures and videos (docs/PLIKI.md §2, docs/PODGLAD.md §2.2): a small WebP (or JPEG) made on this device,
//! uploaded encrypted as its own file. A video's is its first frame, decoded in the hidden preview frame. SVG and anything
//! else gets none, and any failure gives none (the upload goes on without).

import { isImageMime } from "./filestore";
import { encodeThumb } from "./preview/items";
import { firstFrameOf } from "./preview/framejob";

const MAX_SIDE = 480;

export interface Thumbnail {
  blob: Blob;
  width: number;
  height: number;
  /** Videos: the length in ms, when the frame knows it. */
  durationMs?: number;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

/** The thumbnail `UploadOptions.thumbnail` takes: a picture's, a video's first frame, or none. */
export function thumbnailFor(file: File): Promise<Thumbnail | null> {
  const video = file.type.startsWith("video/") || VIDEO_EXT.test(file.name);
  return video ? makeVideoThumbnail(file) : makeThumbnail(file);
}

/** The first frame of a video. Only the start of the file goes to the frame; any failure gives null. */
export async function makeVideoThumbnail(file: File): Promise<Thumbnail | null> {
  try {
    const frame = await firstFrameOf(file, file.name, file.type);
    const blob = await encodeThumb(frame.pixels, frame.width, frame.height);
    return blob ? { blob, width: frame.width, height: frame.height, durationMs: frame.durationMs } : null;
  } catch {
    return null;
  }
}

export async function makeThumbnail(file: File): Promise<Thumbnail | null> {
  if (!isImageMime(file.type)) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const blob = await encode(bitmap, width, height);
    return blob ? { blob, width, height } : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

// White under the picture: JPEG has no alpha, and WebP is only kept when the browser can write it.
async function encode(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
    return webp.type === "image/webp" ? webp : canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const webp = await toBlob(canvas, "image/webp");
  return webp?.type === "image/webp" ? webp : toBlob(canvas, "image/jpeg");
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, 0.8));
}
