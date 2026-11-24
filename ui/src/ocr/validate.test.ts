import { describe, expect, it } from "vitest";
import { parse, type FileTextDoc } from "./filetext";
import { MAX_LAYER_BYTES, cleanPageText, finalizeLayer } from "./validate";

const doc = (texts: string[]): FileTextDoc => ({
  source: "0123456789abcdef0123456789abcdef", name: "Faktura.pdf", mime: "application/pdf", method: "pdf-text",
  pages: texts.map((text, i) => ({ n: i + 1, text, lowQuality: false })), lang: "latin", quality: 1, flags: [],
  extractor: 1, engine: "pdf.js", createdAt: "2026-11-19T15:02:11Z",
});

describe("cleanPageText", () => {
  it("sanitizes every line and trims blank ends", () => {
    expect(cleanPageText("\n\n# Nagłówek\u0007\r\nprzedsię-\nbiorstwo  \n\n")).toBe("\\# Nagłówek\nprzedsiębiorstwo");
  });
  it("turns a fake page marker into text", () => {
    const text = cleanPageText("wstęp\n## Strona 2\nkoniec")!;
    expect(parse(finalizeLayer(doc([text])))!.pages).toHaveLength(1);
  });
  it("refuses what is not a string or is over the limit", () => {
    expect(cleanPageText(42)).toBeNull();
    expect(cleanPageText({ toString: () => "x" })).toBeNull();
    expect(cleanPageText("a".repeat(MAX_LAYER_BYTES + 1))).toBeNull();
  });
});

describe("finalizeLayer", () => {
  it("writes a layer that parses back", () => {
    const md = finalizeLayer(doc(["Strona pierwsza", "", "Zażółć gęślą jaźń"]));
    expect(parse(md)!.pages.map((p) => p.text)).toEqual(["Strona pierwsza", "", "Zażółć gęślą jaźń"]);
  });
  it("cuts from the end and flags it over 2 MB", () => {
    const line = "ą".repeat(1000);
    const big = Array.from({ length: 700 }, () => line).join("\n");
    const md = finalizeLayer(doc(["krótka strona", big, big]));
    expect(new TextEncoder().encode(md).length).toBeLessThanOrEqual(MAX_LAYER_BYTES);
    const back = parse(md)!;
    expect(back.flags).toContain("ucięte");
    expect(back.pages[0].text).toBe("krótka strona");
    expect(back.pages).toHaveLength(3);
  });
  it("throws on text that was not cleaned (a raw page marker would change the pages)", () => {
    expect(() => finalizeLayer(doc(["wstęp\n## Strona 2\nkoniec"]))).toThrow("błąd");
  });
});
