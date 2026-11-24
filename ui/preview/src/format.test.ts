import { describe, expect, it } from "vitest";
import { filesWord, formatDuration, formatSize } from "./format";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("formatSize", () => {
  it("bajty, KB, MB i GB z przecinkiem jak w aplikacji", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1,5 KB");
    expect(formatSize(Math.round(8.4 * MIB))).toBe("8,4 MB");
    expect(formatSize(Math.round(1.2 * GIB))).toBe("1,2 GB");
  });
});

describe("formatDuration", () => {
  it("minuty:sekundy, a od godziny h:mm:ss", () => {
    expect(formatDuration(3000)).toBe("0:03");
    expect(formatDuration(167000)).toBe("2:47");
    expect(formatDuration(3725000)).toBe("1:02:05");
  });
});

describe("filesWord", () => {
  it("odmiana słowa „plik” po polsku", () => {
    expect(filesWord(0)).toBe("plików");
    expect(filesWord(1)).toBe("plik");
    expect(filesWord(2)).toBe("pliki");
    expect(filesWord(4)).toBe("pliki");
    expect(filesWord(5)).toBe("plików");
    expect(filesWord(12)).toBe("plików");
    expect(filesWord(14)).toBe("plików");
    expect(filesWord(22)).toBe("pliki");
    expect(filesWord(111)).toBe("plików");
  });
});
