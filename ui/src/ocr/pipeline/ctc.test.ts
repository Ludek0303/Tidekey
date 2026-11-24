// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ctcDecode, loadDict } from "./ctc";

// probs of shape [1, T, C]; the winning class of step t gets `peak[t]`, the rest is spread evenly
function probMatrix(classes: number[], peak: number[], c: number): Float32Array {
  const out = new Float32Array(classes.length * c);
  classes.forEach((k, t) => {
    for (let i = 0; i < c; i++) out[t * c + i] = i === k ? peak[t] : (1 - peak[t]) / (c - 1);
  });
  return out;
}

describe("ctcDecode", () => {
  // chars a, b; classes: 0 blank, 1 a, 2 b, 3 space (the last class)
  const chars = ["a", "b"];

  it("collapses repeats, drops blanks, maps the last class to a space and averages the kept confidences", () => {
    const probs = probMatrix([1, 1, 0, 2, 2, 3], [0.9, 0.8, 0.7, 0.6, 0.5, 0.4], 4);
    const [r] = ctcDecode(probs, 1, 6, 4, chars);
    expect(r.text).toBe("ab ");
    expect(r.conf).toBeCloseTo((0.9 + 0.6 + 0.4) / 3, 5);
  });

  it("keeps a repeated character when a blank separates it", () => {
    const probs = probMatrix([1, 0, 1], [0.9, 0.9, 0.9], 4);
    expect(ctcDecode(probs, 1, 3, 4, chars)[0].text).toBe("aa");
  });

  it("returns empty text and zero confidence when every step is blank", () => {
    const probs = probMatrix([0, 0, 0], [0.9, 0.9, 0.9], 4);
    expect(ctcDecode(probs, 1, 3, 4, chars)[0]).toEqual({ text: "", conf: 0 });
  });

  it("decodes each sample of a batch on its own", () => {
    const a = probMatrix([2, 0], [0.8, 0.8], 4);
    const b = probMatrix([1, 1], [0.6, 0.6], 4);
    const both = new Float32Array([...a, ...b]);
    const res = ctcDecode(both, 2, 2, 4, chars);
    expect(res.map((r) => r.text)).toEqual(["b", "a"]);
  });

  it("rejects a class count that does not match the dictionary", () => {
    expect(() => ctcDecode(new Float32Array(3), 1, 1, 3, chars)).toThrow("shape");
  });
});

describe("loadDict", () => {
  it("reads one character per line and ignores the final newline", () => {
    expect(loadDict("a\nł\n ż\n")).toEqual(["a", "ł", " ż"]);
  });
});
