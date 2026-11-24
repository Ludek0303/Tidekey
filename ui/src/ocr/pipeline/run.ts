// The ORT-facing part of the pipeline: det → gate → crops in batches → rec → cleanup → reading order.
import { assertRgb, checkedSize, detTensor, type Rgb } from "./image";
import { boxesFromMap, type Quad } from "./db";
import { cropQuad, recBatchTensor, splitAtGutters } from "./crop";
import { ctcDecode } from "./ctc";
import { cleanLines, detectorSaysNoText, pageQuality, readingOrder, type Line } from "./layout";

// Minimal shape of ort.InferenceSession and ort.Tensor, so the pipeline has no ORT import.
export interface TensorLike {
  data: unknown;
  dims: readonly number[];
}
export interface InferenceSessionLike {
  run(feeds: { x: TensorLike }): Promise<Record<string, TensorLike>>;
}
export interface Models {
  det: InferenceSessionLike;
  rec: InferenceSessionLike;
  chars: string[];
}

export const MAX_LINES = 2000;

export interface PageResult {
  lines: string[];
  quality: number;
  noText: boolean;
  ms: { det: number; rec: number };
}

function firstOutput(out: Record<string, TensorLike>): TensorLike {
  const t = Object.values(out)[0];
  if (!t) throw new Error("shape");
  return t;
}

function floats(t: TensorLike, dims: number[]): Float32Array {
  const same = t.dims.length === dims.length && t.dims.every((d, i) => d === dims[i]);
  if (!same || !(t.data instanceof Float32Array) || t.data.length !== checkedSize(...dims)) throw new Error("shape");
  return t.data;
}

export async function ocrPage(
  img: Rgb,
  m: Models,
  makeTensor: (data: Float32Array, dims: number[]) => TensorLike,
  o: { detSide: number; batch: number; signal?: AbortSignal },
): Promise<PageResult> {
  assertRgb(img);
  if (!Number.isSafeInteger(o.batch) || o.batch < 1) throw new Error("batch");
  const abort = () => {
    if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
  };
  abort();

  const t0 = performance.now();
  const det = detTensor(img, o.detSide);
  const [, , nh, nw] = det.dims;
  const dOut = await m.det.run({ x: makeTensor(det.data, [...det.dims]) });
  const prob = floats(firstOutput(dOut), [1, 1, nh, nw]);
  const detected: Quad[] = boxesFromMap(prob, nw, nh, det.ratioH, det.ratioW);
  const detMs = performance.now() - t0;
  if (detectorSaysNoText(detected)) return { lines: [], quality: 1, noText: true, ms: { det: detMs, rec: 0 } };
  const quads = detected.flatMap((q) => splitAtGutters(img, q));

  const t1 = performance.now();
  const crops = quads.map((q) => cropQuad(img, q));
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].width / crops[a].height - crops[b].width / crops[b].height);
  const classes = m.chars.length + 2; // blank, dictionary, space
  const results: ({ text: string; conf: number } | undefined)[] = new Array(quads.length);
  for (let s = 0; s < order.length; s += o.batch) {
    abort();
    const part = order.slice(s, s + o.batch);
    const batch = recBatchTensor(part.map((i) => crops[i]));
    const out = firstOutput(await m.rec.run({ x: makeTensor(batch.data, [...batch.dims]) }));
    const steps = out.dims.length === 3 ? out.dims[1] : 0;
    const probs = floats(out, [part.length, steps, classes]);
    ctcDecode(probs, part.length, steps, classes, m.chars).forEach((r, k) => (results[part[k]] = r));
  }
  const lines: Line[] = [];
  quads.forEach((quad, i) => {
    const r = results[i];
    if (r) lines.push({ quad, text: r.text, conf: r.conf });
  });
  let kept = cleanLines(lines);
  if (kept.length > MAX_LINES) kept = [...kept].sort((a, b) => b.conf - a.conf).slice(0, MAX_LINES);
  return {
    lines: readingOrder(kept, img.width, img.height),
    quality: pageQuality(kept),
    noText: false,
    ms: { det: detMs, rec: performance.now() - t1 },
  };
}
