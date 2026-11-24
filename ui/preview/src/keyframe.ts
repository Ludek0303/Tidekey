// The first keyframe of an MKV or AVI file (PODGLAD §2.2): the WASM demuxer finds it, WebCodecs decodes it, and an
// MJPEG frame is a plain JPEG. Errors use the frame's codes; a codec the browser lacks is `codec`.
import type { KeyframeJs } from "../wasm/notes_preview";
import { previewWasm } from "./previewwasm";
import { FRAME_TIMEOUT_MS, MAX_DECODE_SIDE, thumbPixels, type FirstFrame } from "./firstframe";
import { PreviewError } from "./viewers/index";

export type PreviewAsset = Parameters<typeof previewWasm>[0];

/** The first keyframe of an MKV or AVI file as a thumbnail. Rejects with PreviewError or AbortError. */
export async function keyframeFrame(bytes: ArrayBuffer, asset: PreviewAsset, signal: AbortSignal): Promise<FirstFrame> {
  let key: KeyframeJs;
  try {
    key = (await previewWasm(asset)).videoFirstKeyframe(new Uint8Array(bytes));
  } catch (err) {
    throw wasmError(err);
  }
  try {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (key.width > MAX_DECODE_SIDE || key.height > MAX_DECODE_SIDE) throw new PreviewError("too-large");
    return key.codec === "mjpeg" ? await jpegFrame(key, signal) : await decodedFrame(key, signal);
  } finally {
    key.free();
  }
}

// The WASM error is a JS Error whose message is the frame's code; a panic is a RuntimeError, so the file is corrupt.
function wasmError(err: unknown): unknown {
  if (err instanceof DOMException && err.name === "AbortError") return err;
  if (err instanceof WebAssembly.RuntimeError) return new PreviewError("corrupt");
  const code = err instanceof Error ? err.message : "";
  if (code === "too-large" || code === "corrupt" || code === "unsupported") return new PreviewError(code);
  return new PreviewError("internal");
}

async function jpegFrame(key: KeyframeJs, signal: AbortSignal): Promise<FirstFrame> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([key.data.slice()], { type: "image/jpeg" }));
  } catch {
    throw new PreviewError("corrupt");
  }
  try {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return { ...thumbPixels(bitmap, bitmap.width, bitmap.height), durationMs: key.durationMs };
  } finally {
    bitmap.close();
  }
}

async function decodedFrame(key: KeyframeJs, signal: AbortSignal): Promise<FirstFrame> {
  if (typeof VideoDecoder === "undefined") throw new PreviewError("codec");
  const config: VideoDecoderConfig = {
    codec: key.codec,
    codedWidth: key.width,
    codedHeight: key.height,
    description: key.description,
    optimizeForLatency: true,
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new PreviewError("codec");
  if (signal.aborted) throw new DOMException("aborted", "AbortError");

  let shot: FirstFrame | undefined;
  let failed = false;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        shot ??= thumbPixels(frame, frame.displayWidth, frame.displayHeight);
      } catch {
        failed = true;
      } finally {
        frame.close();
      }
    },
    error: () => {
      failed = true;
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  try {
    try {
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: key.data }));
    } catch {
      throw new PreviewError("codec");
    }
    // the timeout and the abort reject this promise; flush itself never does
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("aborted", "AbortError"));
      timer = setTimeout(() => reject(new PreviewError("timeout")), FRAME_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort);
    });
    const flushed = decoder.flush().then(
      () => undefined,
      () => {
        failed = true;
      },
    );
    await Promise.race([flushed, stop]);
    if (failed) throw new PreviewError("codec");
    if (!shot) throw new PreviewError("corrupt");
    return { ...shot, durationMs: key.durationMs };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // an error callback has already closed the decoder, and close() on a closed one throws
    if (decoder.state !== "closed") decoder.close();
  }
}
