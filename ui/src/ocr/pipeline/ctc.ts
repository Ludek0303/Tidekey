// CTC decoding of the recognizer output (ocr_ref.rec_batch): class 0 is blank, classes 1..dict are the characters,
// and the last class is the space.
import { checkedSize } from "./image";

export function loadDict(text: string): string[] {
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// probs holds [n, t, c] values; chars is the dictionary, so c must be chars.length + 2 (blank and space).
export function ctcDecode(
  probs: Float32Array,
  n: number,
  t: number,
  c: number,
  chars: string[],
): { text: string; conf: number }[] {
  if (c !== chars.length + 2) throw new Error("shape");
  if (probs.length !== checkedSize(n, t, c)) throw new Error("shape");
  const out: { text: string; conf: number }[] = [];
  for (let s = 0; s < n; s++) {
    let last = -1, text = "", sum = 0, kept = 0;
    for (let k = 0; k < t; k++) {
      const base = (s * t + k) * c;
      let best = 0, bestP = -Infinity;
      for (let i = 0; i < c; i++) {
        const v = probs[base + i];
        if (v > bestP) {
          bestP = v;
          best = i;
        }
      }
      if (best !== last && best !== 0) {
        text += best === c - 1 ? " " : chars[best - 1];
        sum += bestP;
        kept++;
      }
      last = best;
    }
    out.push({ text, conf: kept > 0 ? sum / kept : 0 });
  }
  return out;
}
