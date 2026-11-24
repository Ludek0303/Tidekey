import { describe, expect, it } from "vitest";
import { aggregate, cer, normalize, wer, werCased } from "./wer";

describe("normalize", () => {
  it("lowercases with Polish rules, drops punctuation and collapses spaces", () => {
    expect(normalize("  Żółć,  ŁÓDŹ!\n\tok ")).toBe("żółć łódź ok");
  });
});

describe("wer", () => {
  it("is zero for identical text", () => {
    expect(wer("ala ma kota", "ala ma kota")).toEqual({ errors: 0, total: 3, rate: 0 });
  });

  it("counts one substitution in three words as 1/3", () => {
    expect(wer("ala ma kota", "ala ma psa")).toEqual({ errors: 1, total: 3, rate: 1 / 3 });
  });

  it("counts an insertion and a deletion", () => {
    expect(wer("ala ma kota", "ala ma bardzo kota").errors).toBe(1);
    expect(wer("ala ma kota", "ala kota").errors).toBe(1);
  });

  it("ignores case and punctuation", () => {
    expect(wer("Żółć.", "żółć")).toEqual({ errors: 0, total: 1, rate: 0 });
  });

  it("gives rate 0 for an empty reference", () => {
    expect(wer("", "coś")).toEqual({ errors: 1, total: 0, rate: 0 });
  });
});

describe("cer", () => {
  it("counts characters, spaces included", () => {
    // "kot" vs "kat": one substitution out of 3 characters
    expect(cer("kot", "kat")).toEqual({ errors: 1, total: 3, rate: 1 / 3 });
    expect(cer("ala ma", "ala ma")).toEqual({ errors: 0, total: 6, rate: 0 });
  });
});

describe("werCased", () => {
  it("counts a missing comma and a lowercase letter", () => {
    // ref tokens: Tak , to; hyp tokens: tak to → "Tak" substituted, "," deleted
    expect(werCased("Tak, to", "tak to")).toEqual({ errors: 2, total: 3, rate: 2 / 3 });
  });

  it("is zero for identical text", () => {
    expect(werCased("Dzień dobry.", "Dzień dobry.").errors).toBe(0);
  });
});

describe("aggregate", () => {
  it("sums errors and totals (micro-average)", () => {
    const a = wer("a b c d", "a b c x"); // 1/4
    const b = wer("e", "e f"); // 1/1
    expect(aggregate([a, b])).toEqual({ errors: 2, total: 5, rate: 0.4 });
  });
});
