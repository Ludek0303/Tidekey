import { describe, expect, it } from "vitest";
import { decodeTokens } from "./detok";

describe("decodeTokens", () => {
  it("keeps the space before a word that starts with a Polish letter", () => {
    expect(decodeTokens(["▁Wcale", "▁nie", "▁jest", "▁ła", "two", "."])).toBe("Wcale nie jest łatwo.");
    expect(decodeTokens(["▁Pał", "karze", "▁ś", "rod", "kowego", "▁rzędu"])).toBe("Pałkarze środkowego rzędu");
    expect(decodeTokens(["▁Ż", "ółw", "▁ó", "smy"])).toBe("Żółw ósmy");
  });

  it("drops the space before closing punctuation, as the reference decoder does", () => {
    expect(decodeTokens(["▁Tak", "▁,", "▁oczywiście", "▁."])).toBe("Tak, oczywiście.");
    expect(decodeTokens(["▁Czy", "▁tak", "▁?"])).toBe("Czy tak?");
    expect(decodeTokens(["▁don", "'", "t"])).toBe("don't");
  });

  it("keeps the space before an opening bracket or quote", () => {
    expect(decodeTokens(["▁litera", "▁„", "H", "”", "▁w", "▁skrócie", "▁(", "pH", ")"])).toBe("litera „H” w skrócie (pH)");
  });

  it("skips unknown ids and trims", () => {
    expect(decodeTokens([undefined, "▁ala", undefined, "▁ma", "▁"])).toBe("ala ma");
  });
});
