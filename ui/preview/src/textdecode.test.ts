import { describe, expect, it } from "vitest";
import { TEXT_SHOWN_BYTES, decodeText } from "./textdecode";

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];
const utf16 = (s: string, big: boolean): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    out.push(big ? u >> 8 : u & 255, big ? u & 255 : u >> 8);
  }
  return out;
};

describe("decodeText", () => {
  it("UTF-8 z polskimi znakami", () => {
    expect(decodeText(new Uint8Array(utf8("zażółć gęślą jaźń")))).toEqual({
      text: "zażółć gęślą jaźń",
      encoding: "utf-8",
      truncated: false,
    });
  });

  it("BOM UTF-8 jest usuwany z tekstu", () => {
    const r = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("ok")]));
    expect(r).toEqual({ text: "ok", encoding: "utf-8", truncated: false });
  });

  it("UTF-16LE z BOM", () => {
    const r = decodeText(new Uint8Array([0xff, 0xfe, ...utf16("zażółć", false)]));
    expect(r).toEqual({ text: "zażółć", encoding: "utf-16le", truncated: false });
  });

  it("UTF-16BE z BOM", () => {
    const r = decodeText(new Uint8Array([0xfe, 0xff, ...utf16("zażółć", true)]));
    expect(r).toEqual({ text: "zażółć", encoding: "utf-16be", truncated: false });
  });

  it("bez BOM i nie-UTF-8: windows-1250", () => {
    // "zażółć" w windows-1250
    const r = decodeText(new Uint8Array([0x7a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]));
    expect(r).toEqual({ text: "zażółć", encoding: "windows-1250", truncated: false });
  });

  it("limit tnący znak UTF-8 w połowie: bez znaku zastępczego, truncated", () => {
    // "aąb": 61 C4 85 62; limit 2 kończy się w połowie "ą"
    const r = decodeText(new Uint8Array(utf8("aąb")), 2);
    expect(r).toEqual({ text: "a", encoding: "utf-8", truncated: true });
  });

  it("limit na granicy znaku zostawia cały znak", () => {
    const r = decodeText(new Uint8Array(utf8("aąb")), 3);
    expect(r).toEqual({ text: "aą", encoding: "utf-8", truncated: true });
  });

  it("limit w UTF-16 nie tnie pary zastępczej", () => {
    // BOM, "a", wysoka połowa pary "😀" (D83D); limit 6 kończy się na wysokiej połowie
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8, 0x00, 0xde]);
    expect(decodeText(bytes, 6)).toEqual({ text: "a", encoding: "utf-16le", truncated: true });
  });

  it("domyślny limit to 2 MB", () => {
    const r = decodeText(new Uint8Array(TEXT_SHOWN_BYTES + 1).fill(0x61));
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(TEXT_SHOWN_BYTES);
  });

  it("pusty plik", () => {
    expect(decodeText(new Uint8Array(0))).toEqual({ text: "", encoding: "utf-8", truncated: false });
  });
});
