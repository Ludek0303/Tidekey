// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cleanLines, detectorSaysNoText, pageQuality, readingOrder, type Line } from "./layout";
import type { Quad } from "./db";

const rect = (x: number, y: number, w: number, h: number): Quad => ({
  pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
  score: 0.9,
});
const line = (x: number, y: number, w: number, h: number, text: string, conf = 0.9): Line => ({
  quad: rect(x, y, w, h),
  text,
  conf,
});

describe("readingOrder", () => {
  it("reads one column top to bottom and left to right inside a line", () => {
    // word gaps of 4 px on a 400 px page are below the 2% column gap
    const lines = [
      line(94, 50, 76, 20, "four"),
      line(10, 10, 80, 20, "one"),
      line(94, 10, 76, 20, "two"),
      line(10, 50, 80, 20, "three"),
    ];
    expect(readingOrder(lines, 400, 200)).toEqual(["one two", "three four"]);
  });

  it("reads the left column before the right one when a free band splits the page", () => {
    const lines: Line[] = [];
    [10, 50, 90, 130].forEach((y, i) => {
      lines.push(line(10, y, 180, 20, `L${i + 1}`));
      lines.push(line(300, y, 180, 20, `R${i + 1}`));
    });
    expect(readingOrder(lines, 520, 200)).toEqual(["L1", "L2", "L3", "L4", "R1", "R2", "R3", "R4"]);
  });

  it("does not split a single line whose words have a gap between them", () => {
    const lines = [line(10, 10, 40, 20, "Hel"), line(52, 10, 40, 20, "lo")];
    expect(readingOrder(lines, 520, 200)).toEqual(["Hel lo"]);
  });

  it("skips lines without text", () => {
    expect(readingOrder([line(10, 10, 40, 20, "  ")], 100, 100)).toEqual([]);
  });
});

describe("cleanLines", () => {
  it("drops lines with fewer than two letters or digits and lines under 0.5 confidence", () => {
    const kept = cleanLines([
      line(0, 0, 10, 10, "a"),
      line(0, 20, 10, 10, "ok"),
      line(0, 40, 10, 10, "xx", 0.4),
      line(0, 60, 10, 10, "--"),
      line(0, 80, 10, 10, "12"),
    ]);
    expect(kept.map((l) => l.text)).toEqual(["ok", "12"]);
  });
});

describe("pageQuality", () => {
  it("averages confidence weighted by text length", () => {
    const q = pageQuality([line(0, 0, 1, 1, "aaaaaaaaaa", 0.9), line(0, 0, 1, 1, "bbbbbbbbbb", 0.5)]);
    expect(q).toBeCloseTo(0.7, 6);
  });

  it("is 1 for a page without lines", () => {
    expect(pageQuality([])).toBe(1);
  });
});

describe("detectorSaysNoText", () => {
  const tall = rect(0, 0, 20, 60);
  const wide = rect(0, 0, 200, 20);
  it("is true with no boxes", () => {
    expect(detectorSaysNoText([])).toBe(true);
  });
  it("is true for two or fewer boxes that are not text-like", () => {
    expect(detectorSaysNoText([tall, tall])).toBe(true);
  });
  it("is false for one or two text-like boxes", () => {
    expect(detectorSaysNoText([wide])).toBe(false);
    expect(detectorSaysNoText([wide, wide])).toBe(false);
  });
  it("is false for three or more boxes even if none is text-like", () => {
    expect(detectorSaysNoText([tall, tall, tall])).toBe(false);
  });
  it("does not count a very flat box below 8 px high as text", () => {
    expect(detectorSaysNoText([rect(0, 0, 200, 6)])).toBe(true);
  });
});
