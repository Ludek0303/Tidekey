// Speech segmentation on top of Silero VAD (docs/DYKTOWANIE.md §4). Frames are 512 samples at 16 kHz.
import type * as Ort from "onnxruntime-web";

const FRAME_MS = 32; // 512 samples at 16 kHz

export interface SegmenterOptions {
  threshold: number;
  negThreshold: number;
  minSilenceMs: number;
  padMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
}

const DEFAULTS: SegmenterOptions = {
  threshold: 0.5,
  negThreshold: 0.35,
  minSilenceMs: 600,
  padMs: 200,
  minSpeechMs: 250,
  maxSegmentMs: 20000,
};

const concat = (frames: Float32Array[]): Float32Array => {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
};

// Cuts a stream of frames into speech fragments, the way silero-vad's VADIterator does.
export class Segmenter {
  private readonly o: { threshold: number; neg: number; silence: number; pad: number; minSpeech: number; max: number };
  // Last silent frames before the speech; they become the lead-in of the next fragment.
  private pre: Float32Array[] = [];
  // The open fragment, null while silent.
  private seg: Float32Array[] | null = null;
  private speech = 0; // frames with prob >= threshold in seg
  private last = -1; // index in seg of the last such frame
  private silentFrom = -1; // index in seg where the current silence began, -1 if none

  constructor(opts: Partial<SegmenterOptions> = {}) {
    const d = { ...DEFAULTS, ...opts };
    const frames = (ms: number) => Math.round(ms / FRAME_MS);
    this.o = {
      threshold: d.threshold,
      neg: d.negThreshold,
      silence: frames(d.minSilenceMs),
      pad: frames(d.padMs),
      minSpeech: frames(d.minSpeechMs),
      max: frames(d.maxSegmentMs),
    };
  }

  push(frame: Float32Array, prob: number): Float32Array[] {
    const o = this.o;
    if (!this.seg) {
      if (prob < o.threshold) {
        this.pre.push(frame);
        if (this.pre.length > o.pad) this.pre.shift();
        return [];
      }
      this.seg = [...this.pre, frame];
      this.pre = [];
      this.speech = 1;
      this.last = this.seg.length - 1;
      this.silentFrom = -1;
      return [];
    }
    const out: Float32Array[] = [];
    if (this.seg.length >= o.max) {
      // Too long: cut here and keep the speech going in an empty fragment.
      out.push(...this.cut());
      this.seg = [];
      this.speech = 0;
      this.last = -1;
      this.silentFrom = -1;
    }
    const seg = this.seg;
    seg.push(frame);
    const i = seg.length - 1;
    if (prob >= o.threshold) {
      this.speech++;
      this.last = i;
      this.silentFrom = -1;
    } else if (prob < o.neg && this.silentFrom < 0) {
      this.silentFrom = i;
    }
    if (this.silentFrom >= 0 && i - this.silentFrom + 1 >= o.silence) {
      out.push(...this.cut());
      this.seg = null;
      this.pre = [];
    }
    return out;
  }

  // Ends the fragment still open (on stop); the lead-in is cleared so the next session starts clean.
  flush(): Float32Array[] {
    const out = this.seg ? this.cut() : [];
    this.seg = null;
    this.pre = [];
    return out;
  }

  // The fragment still open, if any: its length in ms, and whether speech goes on (no silence run has begun yet).
  open(): { ms: number; ongoing: boolean } | null {
    if (!this.seg) return null;
    return { ms: this.seg.length * FRAME_MS, ongoing: this.silentFrom < 0 };
  }

  // Audio of the open fragment from its first frame to now. A copy, since the fragment keeps growing.
  openAudio(): Float32Array {
    return concat(this.seg ?? []);
  }

  // Keeps the frames up to the lead-out after the last speech; drops fragments with too little speech.
  private cut(): Float32Array[] {
    if (!this.seg || this.speech < this.o.minSpeech) return [];
    return [concat(this.seg.slice(0, this.last + 1 + this.o.pad))];
  }
}

// Silero VAD v5+ (16 kHz): 64 samples of context in front of each 512-sample frame, plus an LSTM state.
export class SileroVad {
  private state: Float32Array<ArrayBuffer> = new Float32Array(2 * 128);
  private context = new Float32Array(64);

  private constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
  ) {}

  static async create(ort: typeof Ort, model: string | Uint8Array<ArrayBuffer>): Promise<SileroVad> {
    // ORT's overloads take a URL or bytes, not both at once, hence the branch.
    const options = { executionProviders: ["wasm"] };
    const session = typeof model === "string" ? await ort.InferenceSession.create(model, options) : await ort.InferenceSession.create(model, options);
    return new SileroVad(ort, session);
  }

  async prob(frame: Float32Array): Promise<number> {
    const input = new Float32Array(64 + 512);
    input.set(this.context);
    input.set(frame, 64);
    this.context = input.slice(512);
    const { output, stateN } = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, 576]),
      state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new this.ort.Tensor("int64", BigInt64Array.from([16000n]), []),
    });
    this.state = (stateN as Ort.Tensor).data as Float32Array<ArrayBuffer>;
    return ((output as Ort.Tensor).data as Float32Array)[0];
  }

  reset(): void {
    this.state = new Float32Array(2 * 128);
    this.context = new Float32Array(64);
  }
}
