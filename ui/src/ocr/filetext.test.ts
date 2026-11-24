import { describe, expect, it } from "vitest";
import { FILETEXT_SCHEMA, joinHyphenated, parse, sanitizeLine, serialize } from "./filetext";
import type { FileTextDoc, FileTextPage, Flag } from "./filetext";

const SOURCE = "3f9c0a1b2c3d4e5f60718293a4b5c6d7";
const ENGINE = "PP-OCRv5 mobile / onnxruntime-web det:webgpu rec:wasm";
const CREATED = "2026-11-19T15:02:11Z";

function pdfDoc(overrides: Partial<FileTextDoc> = {}): FileTextDoc {
  const pages: FileTextPage[] = [
    { n: 1, text: "FAKTURA VAT nr 12/03/2026\nSprzedawca: Zażółć gęślą jaźń", lowQuality: false },
    { n: 2, text: "Pozycje\n\\# nie nagłówek", lowQuality: true },
    { n: 3, text: "", lowQuality: false },
  ];
  return {
    source: SOURCE,
    name: "Faktura-2026-03.pdf",
    mime: "application/pdf",
    method: "mixed",
    pages,
    lang: "latin",
    quality: 0.91,
    flags: [],
    extractor: 1,
    engine: ENGINE,
    createdAt: CREATED,
    ...overrides,
  };
}

function imageDoc(overrides: Partial<FileTextDoc> = {}): FileTextDoc {
  return {
    source: SOURCE,
    name: "zdjecie.jpg",
    mime: "image/jpeg",
    method: "ocr",
    pages: [{ n: 1, text: "SKLEP\nRazem 12,50", lowQuality: false }],
    lang: "latin",
    quality: 0.78,
    flags: [],
    extractor: 1,
    engine: ENGINE,
    createdAt: CREATED,
    image: true,
    ...overrides,
  };
}

/** Replaces the first occurrence of `from` in the serialized text; fails the test if it is absent. */
function edit(md: string, from: string, to: string): string {
  if (!md.includes(from)) throw new Error(`fixture does not contain: ${from}`);
  return md.replace(from, to);
}

describe("serialize / parse round trip", () => {
  it("round-trips a PDF with 3 pages, one low quality and one empty", () => {
    const doc = pdfDoc();
    const md = serialize(doc);
    expect(md).toContain("## Strona 2 · niska jakość\n");
    expect(md).toContain("## Strona 3\n_(brak tekstu)_");
    expect(parse(md)).toEqual(doc);
  });

  it("writes the header in the documented shape", () => {
    const md = serialize(pdfDoc({ flags: ["ucięte", "brak tekstu"] }));
    expect(md.startsWith("---\nschema: notes-filetext-v1\nsource: 3f9c")).toBe(true);
    expect(md).toContain('\nname: "Faktura-2026-03.pdf"\n');
    expect(md).toContain("\nmime: application/pdf\n");
    expect(md).toContain("\nmethod: mixed\npages: 3\nlang: latin\nquality: 0.91\n");
    expect(md).toContain("\nflags: [ucięte, brak tekstu]\nextractor: 1\n");
    expect(md).toContain(`\nengine: "${ENGINE}"\ncreatedAt: ${CREATED}\n---\n\n## Strona 1\n`);
  });

  it("round-trips an image as one section '## Obraz'", () => {
    const doc = imageDoc();
    const md = serialize(doc);
    expect(md).toContain("\n## Obraz\nSKLEP\nRazem 12,50");
    expect(md).not.toContain("## Strona");
    expect(parse(md)).toEqual(doc);
  });

  it("round-trips a low quality image", () => {
    const doc = imageDoc({ pages: [{ n: 1, text: "", lowQuality: true }], method: "none", flags: ["brak tekstu"] });
    const md = serialize(doc);
    expect(md).toContain("## Obraz · niska jakość\n_(brak tekstu)_");
    expect(parse(md)).toEqual(doc);
  });

  it("round-trips every flag, in order", () => {
    const flags: Flag[] = ["ucięte", "zabezpieczony", "brak tekstu", "błąd"];
    const doc = pdfDoc({ flags, method: "none" });
    expect(serialize(doc)).toContain("flags: [ucięte, zabezpieczony, brak tekstu, błąd]");
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("round-trips a file name with colon, quote, newline and ---", () => {
    const name = 'raport: "2026"\nlinia --- x.pdf';
    const doc = pdfDoc({ name, engine: 'OCR: "v1"\n---' });
    const md = serialize(doc);
    expect(md.split("\n").filter((l) => l === "---")).toHaveLength(2);
    expect(parse(md)).toEqual(doc);
  });

  it("round-trips quality 0 and 1", () => {
    expect(parse(serialize(pdfDoc({ quality: 0 })))?.quality).toBe(0);
    expect(parse(serialize(pdfDoc({ quality: 1 })))?.quality).toBe(1);
  });

  it("round-trips text that starts or ends with empty lines", () => {
    const doc = pdfDoc({
      pages: [
        { n: 1, text: "\na", lowQuality: false },
        { n: 2, text: "b\n", lowQuality: false },
        { n: 3, text: "\n", lowQuality: false },
      ],
    });
    expect(parse(serialize(doc))).toEqual(doc);
  });
});

describe("sanitizeLine", () => {
  it("normalizes to NFC", () => {
    expect(sanitizeLine("a\u0328")).toBe("\u0105");
  });

  it("removes control characters but keeps tab", () => {
    expect(sanitizeLine("a\u0000b\u0007c\u001bd\u007fe\u0085f")).toBe("abcdef");
    expect(sanitizeLine("a\tb")).toBe("a\tb");
  });

  it("escapes a leading # as \\#", () => {
    expect(sanitizeLine("# Nagłówek")).toBe("\\# Nagłówek");
  });

  it("escapes a # after leading spaces", () => {
    expect(sanitizeLine("   ## x")).toBe("   \\## x");
  });

  it("leaves a # in the middle of a line alone", () => {
    expect(sanitizeLine("numer #12")).toBe("numer #12");
  });

  it("keeps page-like text inside a page from creating a page", () => {
    const doc = pdfDoc({
      pages: [{ n: 1, text: [sanitizeLine("## Strona 2"), sanitizeLine("## Obraz")].join("\n"), lowQuality: false }],
      method: "pdf-text",
    });
    const md = serialize(doc);
    expect(md).toContain("\\## Strona 2\n\\## Obraz");
    expect(parse(md)).toEqual(doc);
  });
});

describe("joinHyphenated", () => {
  it("joins a word split by a hyphen at the line end", () => {
    expect(joinHyphenated(["przedsię-", "biorstwo"])).toEqual(["przedsiębiorstwo"]);
  });

  it("keeps the rest of the continuation line", () => {
    expect(joinHyphenated(["przedsię-", "biorstwo jest"])).toEqual(["przedsiębiorstwo jest"]);
  });

  it("does not join when the next line starts with an uppercase letter", () => {
    expect(joinHyphenated(["e-", "Mail"])).toEqual(["e-", "Mail"]);
  });

  it("does not join when the next line starts with a digit", () => {
    expect(joinHyphenated(["2026-", "03"])).toEqual(["2026-", "03"]);
  });

  it("does not join when there is no word char before the hyphen", () => {
    expect(joinHyphenated(["a --", "b"])).toEqual(["a --", "b"]);
  });

  it("leaves lines without a hyphen at the end unchanged", () => {
    expect(joinHyphenated(["Ala ma", "kota"])).toEqual(["Ala ma", "kota"]);
  });

  it("joins a word split over three lines", () => {
    expect(joinHyphenated(["przed-", "się-", "biorstwo", "dalej"])).toEqual(["przedsiębiorstwo", "dalej"]);
  });
});

describe("parse rejects what serialize does not produce", () => {
  const md = serialize(pdfDoc());

  it("rejects another schema", () => {
    expect(parse(edit(md, `schema: ${FILETEXT_SCHEMA}`, "schema: notes-filetext-v2"))).toBeNull();
  });

  it("rejects a missing header field", () => {
    expect(parse(edit(md, `engine: "${ENGINE}"\n`, ""))).toBeNull();
  });

  it("rejects pages 1 and 3 (a gap)", () => {
    const gap = edit(md, "## Strona 2 · niska jakość", "## Strona 3 · niska jakość");
    expect(parse(gap)).toBeNull();
  });

  it("rejects a page count that differs from the sections", () => {
    expect(parse(edit(md, "pages: 3", "pages: 2"))).toBeNull();
  });

  it("rejects an unknown flag", () => {
    expect(parse(edit(md, "flags: []", "flags: [nieznana]"))).toBeNull();
  });

  it("rejects an unknown method", () => {
    expect(parse(edit(md, "method: mixed", "method: magic"))).toBeNull();
  });

  it("rejects quality above 1", () => {
    expect(parse(edit(md, "quality: 0.91", "quality: 1.50"))).toBeNull();
  });

  it("rejects a non-hex source", () => {
    expect(parse(edit(md, `source: ${SOURCE}`, "source: zzz"))).toBeNull();
    expect(parse(edit(md, `source: ${SOURCE}`, `source: ${SOURCE.toUpperCase()}`))).toBeNull();
  });

  it("rejects text before the header", () => {
    expect(parse(`Tekst przed nagłówkiem\n${md}`)).toBeNull();
  });

  it("rejects a name that is not a JSON string", () => {
    expect(parse(edit(md, 'name: "Faktura-2026-03.pdf"', "name: Faktura-2026-03.pdf"))).toBeNull();
  });

  it("rejects a file without the closing header line", () => {
    expect(parse("---\nschema: notes-filetext-v1\n")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parse("")).toBeNull();
  });
});

describe("property: random docs round-trip", () => {
  it("round-trips 200 seeded random docs built from sanitized Polish text", () => {
    const rand = mulberry32(20261119);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const WORDS = [
      "Faktura", "przedsiębiorstwo", "Zażółć", "gęślą", "jaźń", "NIP:", "kwota", "należność",
      "2026-03", "\"cytat\"", "---", "#", "##", "## Strona 2", "## Obraz", "a\u0328", "\t",
      "\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\n", "\\#", "x", "·", "…", "1,50 zł",
    ];
    const NAME_PARTS = ["raport", ": ", "\"", "\n", "---", "ąę", "C:\\dok\\", "\u0001", " ", ".pdf", "\t"];
    const ENGINE_PARTS = ["PP-OCRv5", " / ", "\"", "\n", "---", "wasm", "ż"];
    const METHODS = ["pdf-text", "ocr", "mixed", "none"] as const;
    const FLAGS: readonly Flag[] = ["ucięte", "zabezpieczony", "brak tekstu", "błąd"];
    const HEX = "0123456789abcdef";

    for (let i = 0; i < 200; i++) {
      const image = rand() < 0.2;
      const pageCount = image ? 1 : 1 + Math.floor(rand() * 5);
      const pages: FileTextPage[] = [];
      for (let p = 1; p <= pageCount; p++) {
        const lineCount = Math.floor(rand() * 6);
        const lines: string[] = [];
        for (let l = 0; l < lineCount; l++) {
          const words = Array.from({ length: Math.floor(rand() * 5) }, () => pick(WORDS));
          const prefix = rand() < 0.2 ? "   " : "";
          lines.push(sanitizeLine(prefix + words.join(" ")));
        }
        pages.push({ n: p, text: lines.join("\n"), lowQuality: rand() < 0.3 });
      }
      const source = Array.from({ length: 32 }, () => HEX[Math.floor(rand() * 16)]).join("");
      const createdMs = Date.UTC(2020, 0, 1) + Math.floor(rand() * 1e10) * 1000;
      const doc: FileTextDoc = {
        source,
        name: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(NAME_PARTS)).join(""),
        mime: pick(["application/pdf", "image/png", "image/jpeg"]),
        method: pick(METHODS),
        pages,
        lang: "latin",
        quality: Math.round(rand() * 100) / 100,
        flags: FLAGS.filter(() => rand() < 0.3),
        extractor: 1,
        engine: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(ENGINE_PARTS)).join(""),
        createdAt: new Date(createdMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
        ...(image ? { image: true } : {}),
      };
      expect(parse(serialize(doc)), `doc #${i}`).toEqual(doc);
    }
  });
});

/** Small seeded PRNG (mulberry32) so the property test is repeatable. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the empty-page marker as text", () => {
  it("is escaped, so it does not read back as an empty page", async () => {
    const { sanitizeLine } = await import("./filetext");
    expect(sanitizeLine("_(brak tekstu)_")).toBe("\\_(brak tekstu)_");
  });

  it("usuwa znaki kierunkowe (bidi), zero-width i BOM", () => {
    expect(sanitizeLine("a\u202Ab\u202Ec\u2066d\u2069e\u200Ef\u200Fg")).toBe("abcdefg");
    expect(sanitizeLine("a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf")).toBe("abcdef");
  });

  it("usuwa samotne surogaty, a poprawne pary (emoji) zostają", () => {
    expect(sanitizeLine("a\uD800b\uDC00c")).toBe("abc");
    expect(sanitizeLine("x\uD83D\uDE00y")).toBe("x\uD83D\uDE00y");
  });

  it("polskie litery przechodzą bez zmian", () => {
    expect(sanitizeLine("Zażółć gęślą jaźń ĄĆĘŁŃÓŚŹŻ")).toBe("Zażółć gęślą jaźń ĄĆĘŁŃÓŚŹŻ");
  });

  it("ukryte znaki usunięte przed sprawdzeniem pustej strony", () => {
    expect(sanitizeLine("\u200B_(brak tekstu)_\uFEFF")).toBe("\\_(brak tekstu)_");
  });
});

describe("a layer with no pages", () => {
  it("round-trips, and is refused when the header and the body disagree", () => {
    const doc = {
      source: "0123456789abcdef0123456789abcdef", name: "Hasło.pdf", mime: "application/pdf", method: "none" as const, pages: [],
      lang: "latin" as const, quality: 0, flags: ["zabezpieczony" as const], extractor: 1, engine: "none", createdAt: "2026-11-23T10:00:00Z",
    };
    const md = serialize(doc);
    expect(parse(md)).toEqual(doc);
    expect(parse(md.replace("pages: 0", "pages: 1"))).toBeNull();
    expect(parse(md.replace(/\n$/, "## Strona 1\nx\n"))).toBeNull();
  });
});
