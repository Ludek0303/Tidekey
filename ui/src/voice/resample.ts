// Streaming linear resampler and fixed-size framer for the capture path. Both keep state between calls,
// so the output does not depend on how the audio was chunked.

export class Resampler {
  private readonly step: number;
  // Position of the next output sample, in input samples, relative to the start of the next chunk.
  private pos = 0;
  // Last input sample of the previous chunk (index -1 of the next one).
  private last = 0;

  constructor(
    private readonly from: number,
    private readonly to = 16000,
  ) {
    this.step = from / to;
  }

  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input.slice();
    const n = input.length;
    const out = new Float32Array(Math.ceil((n + 1) / this.step));
    let k = 0;
    // The interpolation needs the sample after `pos`, so the last sample waits for the next chunk.
    while (this.pos < n - 1) {
      const i = Math.floor(this.pos);
      const a = i < 0 ? this.last : input[i];
      out[k++] = a + (input[i + 1] - a) * (this.pos - i);
      this.pos += this.step;
    }
    this.last = input[n - 1];
    this.pos -= n;
    return out.slice(0, k);
  }
}

export class Framer {
  private rest = new Float32Array(0);

  constructor(private readonly size = 512) {}

  push(input: Float32Array): Float32Array[] {
    const all = new Float32Array(this.rest.length + input.length);
    all.set(this.rest);
    all.set(input, this.rest.length);
    const frames: Float32Array[] = [];
    let i = 0;
    for (; i + this.size <= all.length; i += this.size) frames.push(all.slice(i, i + this.size));
    this.rest = all.slice(i);
    return frames;
  }
}
