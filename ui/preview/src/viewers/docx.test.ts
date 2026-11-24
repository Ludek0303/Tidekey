import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { guardZip } from "../zipindex";
import { PreviewError } from "./index";
import { fitScale, sanitizeRendered } from "./docx";

const MIB = 1024 * 1024;
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(import.meta.dirname, "../../../../fixtures/preview", name)));

function tree(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// A ZIP with one entry whose central directory declares `declared` bytes unpacked and no data behind it.
function declaredZip(declared: number): Uint8Array {
  const name = [...new TextEncoder().encode("word/document.xml")];
  const central = [
    0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(0), ...u32(declared), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(0), ...name,
  ];
  const end = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(0), ...u16(0)];
  return new Uint8Array([...central, ...end]);
}

describe("sanitizeRendered", () => {
  it("usuwa src spoza dokumentu, zostawia blob: i data:", () => {
    const root = tree('<img id="a" src="http://127.0.0.1:9/x.png"><img id="b" src="blob:null/1"><img id="c" src="data:image/png;base64,AA==">');
    expect(sanitizeRendered(root)).toBe(1);
    expect(root.querySelector("#a")?.hasAttribute("src")).toBe(false);
    expect(root.querySelector("#b")?.getAttribute("src")).toBe("blob:null/1");
    expect(root.querySelector("#c")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });

  it("usuwa srcset spoza dokumentu", () => {
    const root = tree('<img id="a" srcset="http://127.0.0.1:9/x.png 2x"><img id="b" srcset="blob:null/2 2x">');
    expect(sanitizeRendered(root)).toBe(1);
    expect(root.querySelector("#a")?.hasAttribute("srcset")).toBe(false);
    expect(root.querySelector("#b")?.getAttribute("srcset")).toBe("blob:null/2 2x");
  });

  it("usuwa href na adres zewnętrzny, zostawia #id", () => {
    const root = tree('<a id="a" href="https://example.com/">x</a><a id="b" href="#zal">y</a>');
    expect(sanitizeRendered(root)).toBe(1);
    expect(root.querySelector("#a")?.hasAttribute("href")).toBe(false);
    expect(root.querySelector("#b")?.getAttribute("href")).toBe("#zal");
  });

  it("usuwa xlink:href z <use> wskazującego poza dokument, zostawia wskazanie na symbol", () => {
    const root = tree('<svg><use id="a" xlink:href="http://127.0.0.1:9/s.svg#x"></use><use id="b" xlink:href="#sym"></use></svg>');
    expect(sanitizeRendered(root)).toBe(1);
    expect(root.querySelector("#a")?.hasAttribute("xlink:href")).toBe(false);
    expect(root.querySelector("#b")?.getAttribute("xlink:href")).toBe("#sym");
  });

  it("zostawia href z blob: na <image> (obraz rysunku w SVG), usuwa zewnętrzny", () => {
    const root = tree('<svg><image id="a" href="blob:null/9"></image><image id="b" href="http://127.0.0.1:9/x.png"></image></svg>');
    expect(sanitizeRendered(root)).toBe(1);
    expect(root.querySelector("#a")?.getAttribute("href")).toBe("blob:null/9");
    expect(root.querySelector("#b")?.hasAttribute("href")).toBe(false);
  });

  it("usuwa atrybuty zdarzeń on*", () => {
    const root = tree('<a id="a" href="#x" onclick="alert(1)">x</a><img id="b" src="blob:null/3" onerror="alert(2)">');
    expect(sanitizeRendered(root)).toBe(2);
    expect(root.querySelector("#a")?.hasAttribute("onclick")).toBe(false);
    expect(root.querySelector("#b")?.hasAttribute("onerror")).toBe(false);
    expect(root.querySelector("#b")?.getAttribute("src")).toBe("blob:null/3");
  });

  it("zwraca liczbę usuniętych atrybutów, a czysty dokument daje 0", () => {
    expect(sanitizeRendered(tree("<p>Zwykły tekst <b>z pogrubieniem</b></p>"))).toBe(0);
  });
});

describe("docx", () => {
  it("przepuszcza prawdziwy DOCX z fixtures", () => {
    expect(() => guardZip(fixture("dokument.docx"))).not.toThrow();
  });

  it("bomba zip (zadeklarowane > 300 MiB po rozpakowaniu) → too-large", () => {
    expect(() => guardZip(declaredZip(301 * MIB))).toThrow(PreviewError);
    expect(() => guardZip(declaredZip(301 * MIB))).toThrow("too-large");
  });

  it("plik, który nie jest ZIP-em (.doc) → corrupt", () => {
    expect(() => guardZip(fixture("losowe.doc"))).toThrow("corrupt");
  });

  it("skala do szerokości widoku: kartka nie powiększa się, wąskie okno ją zmniejsza", () => {
    expect(fitScale(794, 1100)).toBe(1);
    expect(fitScale(794, 500)).toBeCloseTo((500 - 32) / 794);
    expect(fitScale(0, 500)).toBe(1);
  });
});
