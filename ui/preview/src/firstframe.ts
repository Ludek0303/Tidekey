// The first frame of a video, drawn on a canvas (PODGLAD-PLAN §4.4, PODGLAD §2.2). mkv and avi go through our own
// demuxer and WebCodecs (keyframe.ts); mp4, mov and webm go through the browser's <video>.
import { videoContainer, type VideoContainer } from "../../src/preview/formats";
import { keyframeFrame, type PreviewAsset } from "./keyframe";
import { PreviewError } from "./viewers/index";

export const FRAME_TIMEOUT_MS = 5000;
export const MAX_DECODE_SIDE = 8192;
export const THUMB_SIDE = 480;

export interface FirstFrame { width: number; height: number; pixels: ArrayBuffer; durationMs?: number }

interface FrameCallbackVideo { requestVideoFrameCallback(cb: () => void): number }

const MIME_BY_CONTAINER: Record<VideoContainer, string> = {
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
};

// The element has to be in the document for the browser to decode it, but it must not show.
const OFFSCREEN: Partial<CSSStyleDeclaration> = {
  position: "fixed", left: "-10000px", width: "2px", height: "2px", opacity: "0", pointerEvents: "none",
};

/** Thumbnail size: the longer side at most THUMB_SIDE, the proportions kept, each side at least 1 px. */
export function thumbSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The browser needs a type to start decoding; an empty or generic one is replaced with the one the bytes show.
function blobType(bytes: ArrayBuffer, mime: string): string {
  if (mime && mime !== "application/octet-stream") return mime;
  const container = videoContainer(new Uint8Array(bytes), "");
  return container ? MIME_BY_CONTAINER[container] : "application/octet-stream";
}

function hasFrameCallback(video: HTMLVideoElement): video is HTMLVideoElement & FrameCallbackVideo {
  return "requestVideoFrameCallback" in video;
}

/** Draws a picture (video element, bitmap or decoded frame) at thumbnail size and returns its pixels. */
export function thumbPixels(source: CanvasImageSource, width: number, height: number): { width: number; height: number; pixels: ArrayBuffer } {
  const size = thumbSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(source, 0, 0, size.width, size.height);
  const pixels = ctx.getImageData(0, 0, size.width, size.height).data.buffer as ArrayBuffer;
  return { ...size, pixels };
}

/** Rejects with PreviewError (unsupported, codec, corrupt, too-large, timeout) or AbortError. */
export async function firstFrame(bytes: ArrayBuffer, mime: string, signal: AbortSignal, asset: PreviewAsset): Promise<FirstFrame> {
  const container = videoContainer(new Uint8Array(bytes), "");
  if (container !== "mkv" && container !== "avi") return videoFrame(bytes, mime, signal);
  try {
    return await keyframeFrame(bytes, asset, signal);
  } catch (err) {
    // the demuxer or WebCodecs does not know this codec; the browser's <video> may still play it (webm inside mkv)
    if (err instanceof PreviewError && (err.code === "unsupported" || err.code === "codec")) {
      return videoFrame(bytes, mime, signal);
    }
    throw err;
  }
}

/** Rejects with PreviewError (codec, too-large, timeout) or AbortError; always removes its element and frees the URL. */
function videoFrame(bytes: ArrayBuffer, mime: string, signal: AbortSignal): Promise<FirstFrame> {
  return new Promise<FirstFrame>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const video = document.createElement("video");
    const url = URL.createObjectURL(new Blob([bytes], { type: blobType(bytes, mime) }));
    const listeners: [string, () => void][] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let durationMs: number | undefined;
    let drawn = false;
    let settled = false;

    const finish = (err: unknown, frame?: FirstFrame): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      for (const [type, fn] of listeners) video.removeEventListener(type, fn);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      video.remove();
      if (frame) resolve(frame);
      else reject(err);
    };
    const onAbort = (): void => finish(new DOMException("aborted", "AbortError"));

    const draw = (): void => {
      if (drawn) return;
      drawn = true;
      try {
        finish(undefined, { ...thumbPixels(video, video.videoWidth, video.videoHeight), durationMs });
      } catch (err) {
        finish(err);
      }
    };

    const on = (type: string, fn: () => void): void => {
      listeners.push([type, fn]);
      video.addEventListener(type, fn);
    };
    on("error", () => finish(new PreviewError("codec")));
    on("loadedmetadata", () => {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        finish(new PreviewError("codec"));
      } else if (video.videoWidth > MAX_DECODE_SIDE || video.videoHeight > MAX_DECODE_SIDE) {
        finish(new PreviewError("too-large"));
      } else if (Number.isFinite(video.duration)) {
        durationMs = Math.round(video.duration * 1000);
      }
    });
    on("loadeddata", () => {
      if (hasFrameCallback(video)) video.requestVideoFrameCallback(() => draw());
      video.currentTime = 0;
    });
    on("seeked", () => draw());

    signal.addEventListener("abort", onAbort);
    timer = setTimeout(() => finish(new PreviewError("timeout")), FRAME_TIMEOUT_MS);
    Object.assign(video.style, OFFSCREEN);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("aria-hidden", "true");
    video.src = url;
    document.body.append(video);
  });
}
