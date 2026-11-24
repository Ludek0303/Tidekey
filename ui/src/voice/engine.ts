// Turns one speech fragment into text. Stage 1 stand-in: reports the fragment's length; Parakeet replaces it.
import { ParakeetModel } from "parakeet.js/parakeet";
import { decodeTokens } from "./detok";
import { VoiceError, type Variant } from "./types";

export interface AsrEngine {
  /** `partial`: a guess at a fragment still being spoken, shown as a ghost and replaced by the final. */
  transcribe(pcm: Float32Array, partial?: boolean): Promise<string>;
}

export const mockAsr: AsrEngine = {
  async transcribe(pcm, partial) {
    const seconds = (pcm.length / 16000).toFixed(1).replace(".", ",");
    if (partial) return `(mówisz… ${seconds} s)`;
    console.info("[voice] fragment mowy", seconds, "s");
    return `(fragment mowy ${seconds} s)`;
  },
};

// The worker sets ort.env.wasm.wasmPaths before this call: parakeet.js only fills it in when it is empty, and its
// default is a CDN the app may not contact. `threads` must match ort.env.wasm.numThreads, which parakeet.js overwrites.
export async function createParakeet(
  urls: { encoder: string; decoder: string; vocab: string },
  variant: Variant,
  threads: number,
): Promise<AsrEngine> {
  let model: ParakeetModel;
  try {
    model = await ParakeetModel.fromUrls({
      encoderUrl: urls.encoder,
      decoderUrl: urls.decoder,
      tokenizerUrl: urls.vocab,
      backend: variant === "gpu" ? "webgpu" : "wasm",
      preprocessorBackend: "js",
      cpuThreads: threads,
      verbose: false,
    });
  } catch (err) {
    const text = String(err);
    if (err instanceof RangeError || /memory|allocate|OOM/i.test(text)) throw new VoiceError("memory", text);
    throw new VoiceError("model", text);
  }
  // shortcut: patches the library's decoder in place (all its text goes through it), until parakeet.js fixes it upstream
  const tok = (model as unknown as { tokenizer: { id2token: string[]; blankId: number; decode(ids: number[]): string } }).tokenizer;
  tok.decode = (ids) => decodeTokens(ids.filter((id) => id !== tok.blankId).map((id) => tok.id2token[id]));
  return {
    async transcribe(pcm) {
      return (await model.transcribe(pcm, 16000)).utterance_text.trim();
    },
  };
}
