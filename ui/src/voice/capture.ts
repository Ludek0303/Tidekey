import { VoiceError } from "./types";
import workletUrl from "./capture-worklet.ts?worker&url";

export interface CaptureSession {
  stop(): void;
}

// Microphone to 16 kHz frames. Nothing is recorded: frames go straight to onFrame.
export async function startCapture(onFrame: (frame: Float32Array) => void): Promise<CaptureSession> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new VoiceError("unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new VoiceError("mic-denied");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new VoiceError("no-mic");
    throw new VoiceError("internal", String(err));
  }
  // Native rate: Firefox will not connect a mic stream to a context of another rate, so the worklet resamples.
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    throw new VoiceError("internal", String(err));
  }
  // The click that started dictation is a few awaits back; a context created after them may start suspended.
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "voice-capture");
  // A muted sink: the graph only runs the worklet when it reaches the destination, and nothing is heard.
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(node).connect(silent).connect(ctx.destination);
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      silent.disconnect();
      void ctx.close().catch(() => {});
    },
  };
}
