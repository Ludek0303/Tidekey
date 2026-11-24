import { describe, expect, it } from "vitest";
import { embeddedIds } from "./triggers";

describe("embeddedIds", () => {
  it("lists the files of a note in order, each once, with any embed form", () => {
    const a = "a".repeat(32), b = "b".repeat(32);
    const text = `x ![[plik:${b}#0000000a|320]] y ![[plik:${a}]] ![[plik:${b}#0000000b]] [[plik:${"c".repeat(32)}]]`;
    expect(embeddedIds(text)).toEqual([b, a]);
    expect(embeddedIds(text)).toEqual([b, a]); // no regex state carried over
    expect(embeddedIds("")).toEqual([]);
  });
});
