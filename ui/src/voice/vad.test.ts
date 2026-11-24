import { describe, expect, it } from "vitest";
import { Segmenter } from "./vad";

// Each frame is filled with a marker, so a test can tell which frames a fragment holds.
const frame = (marker: number) => new Float32Array(512).fill(marker);
const SPEECH = 0.9;
const SILENCE = 0.1;

// Feeds (prob, marker) pairs; returns every fragment the segmenter closes, plus the final flush.
function run(seq: Array<[number, number]>, opts?: ConstructorParameters<typeof Segmenter>[0]): Float32Array[] {
  const seg = new Segmenter(opts);
  const out: Float32Array[] = [];
  for (const [prob, marker] of seq) out.push(...seg.push(frame(marker), prob));
  return [...out, ...seg.flush()];
};
const repeat = (n: number, prob: number, marker: number): Array<[number, number]> => Array.from({ length: n }, () => [prob, marker]);

describe("Segmenter", () => {
  it("returns one fragment for silence, speech and silence, with lead-in and lead-out padding", () => {
    const seq = [...repeat(10, SILENCE, 0), ...repeat(40, SPEECH, 1), ...repeat(25, SILENCE, 2)];
    const [frag, ...rest] = run(seq);
    expect(rest).toEqual([]);
    // 200 ms (6 frames) of silence on each side of the 40 frames of speech.
    expect(frag.length).toBe((6 + 40 + 6) * 512);
    expect(frag[0]).toBe(0);
    expect(frag[6 * 512 - 1]).toBe(0);
    expect(frag[6 * 512]).toBe(1);
    expect(frag[46 * 512 - 1]).toBe(1);
    expect(frag[46 * 512]).toBe(2);
    expect(frag.length).toBe(52 * 512);
  });

  it("drops a click shorter than minSpeechMs", () => {
    const seq = [...repeat(10, SILENCE, 0), ...repeat(1, SPEECH, 1), ...repeat(25, SILENCE, 2)];
    expect(run(seq)).toEqual([]);
  });

  it("cuts speech of 25 s into fragments of at most 20 s", () => {
    const frags = run(repeat(782, SPEECH, 1));
    expect(frags.map((f) => f.length / 512)).toEqual([625, 157]);
    expect(Math.max(...frags.map((f) => f.length / 16000))).toBeLessThanOrEqual(20);
  });

  it("flush returns the fragment still open", () => {
    const seg = new Segmenter();
    for (const f of repeat(20, SPEECH, 1)) seg.push(frame(f[1]), f[0]);
    const out = seg.flush();
    expect(out.map((f) => f.length)).toEqual([20 * 512]);
    expect(seg.flush()).toEqual([]);
  });

  it("does not split a fragment at a pause shorter than minSilenceMs", () => {
    const seq = [...repeat(20, SPEECH, 1), ...repeat(10, SILENCE, 2), ...repeat(20, SPEECH, 3), ...repeat(25, SILENCE, 4)];
    const frags = run(seq);
    expect(frags).toHaveLength(1);
    expect(frags[0].length).toBe((20 + 10 + 20 + 6) * 512);
  });

  it("reports the open fragment: its length, whether speech goes on, and its audio so far", () => {
    const seg = new Segmenter();
    for (const [prob, marker] of repeat(10, SILENCE, 0)) seg.push(frame(marker), prob);
    expect(seg.open()).toBeNull();

    for (const [prob, marker] of repeat(3, SPEECH, 1)) seg.push(frame(marker), prob);
    // 6 frames of lead-in silence (200 ms) plus 3 speech frames.
    expect(seg.open()).toEqual({ ms: 9 * 32, ongoing: true });
    const audio = seg.openAudio();
    expect(audio.length).toBe(9 * 512);
    expect(audio[6 * 512 - 1]).toBe(0);
    expect(audio[6 * 512]).toBe(1);
  });

  it("marks the open fragment as not ongoing once a silence has begun, and closes it after minSilenceMs", () => {
    const seg = new Segmenter();
    for (const [prob, marker] of repeat(3, SPEECH, 1)) seg.push(frame(marker), prob);
    for (const [prob, marker] of repeat(2, SILENCE, 2)) seg.push(frame(marker), prob);
    expect(seg.open()?.ongoing).toBe(false);

    for (const [prob, marker] of repeat(20, SILENCE, 2)) seg.push(frame(marker), prob);
    expect(seg.open()).toBeNull();
  });
});
