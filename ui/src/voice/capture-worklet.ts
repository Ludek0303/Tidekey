// AudioWorklet that turns the microphone into 512-sample frames at 16 kHz (runs in the audio thread).
import { Framer, Resampler } from "./resample";

// Globals of the AudioWorkletGlobalScope, which the DOM lib does not declare.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new Resampler(sampleRate);
  private readonly framer = new Framer(512);

  process(inputs: Float32Array[][]): boolean {
    // No channel while the input is disconnected; there is nothing to send then.
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const frame of this.framer.push(this.resampler.push(channel))) this.port.postMessage(frame, [frame.buffer as ArrayBuffer]);
    }
    return true;
  }
}

registerProcessor("voice-capture", CaptureProcessor);
