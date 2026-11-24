import { describe, expect, it } from "vitest";
import { blocks, compose } from "./linediff";

describe("blocks", () => {
  it("keeps shared lines and groups the differing ones", () => {
    const b = blocks("a\nstara\nc", "a\nnowa\nc");
    expect(b).toEqual([{ same: ["a"] }, { ours: ["stara"], theirs: ["nowa"] }, { same: ["c"] }]);
  });

  it("composes both texts back exactly", () => {
    const ours = "Zażółć\n🐢 gęślą\nkoniec\n";
    const theirs = "Zażółć\nobca linia\n🐢 gęślą\ndodane\n";
    expect(compose(blocks(ours, theirs))).toBe(ours);
    expect(compose(blocks(ours, theirs), ["theirs", "theirs"])).toBe(theirs);
  });

  it("picks a side per differing block", () => {
    const ours = "x\nstara\ny\nmoja\n";
    const theirs = "x\nnowa\ny\ncudza\n";
    const all = blocks(ours, theirs);
    const differing = all.filter((b) => !("same" in b)).length;
    expect(differing).toBe(2);
    expect(compose(all, ["ours", "theirs"])).toBe("x\nstara\ny\ncudza\n");
    expect(compose(all, ["theirs", "ours"])).toBe("x\nnowa\ny\nmoja\n");
  });

  it("handles empty texts", () => {
    expect(compose(blocks("", "tekst"))).toBe("");
    expect(compose(blocks("", "tekst"), ["theirs"])).toBe("tekst");
  });

  it("composes random pairs exactly on both sides", () => {
    const lines = ["a", "b", "ż", "", "🐢"];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const text = () => Array.from({ length: Math.floor(rnd() * 12) }, () => lines[Math.floor(rnd() * lines.length)]).join("\n");
    for (let k = 0; k < 200; k++) {
      const ours = text();
      const theirs = text();
      const all = blocks(ours, theirs);
      expect(compose(all, all.map(() => "ours"))).toBe(ours);
      expect(compose(all, all.map(() => "theirs"))).toBe(theirs);
    }
  });
});
