import { describe, expect, it } from "vitest";
import { PreviewError } from "./viewers/index";
import { guardZip, readZipIndex } from "./zipindex";

// A real ZIP, built by hand: local headers, central directory and end record. Method is "stored".
interface Item {
  name: string | number[]; // a number list is the raw name bytes (no UTF-8 check)
  data?: string;
  dir?: boolean;
  utf8?: boolean; // bit 11; default true
  encrypted?: boolean;
  // ZIP64 sizes: the 32-bit fields are 0xFFFFFFFF and the real values sit in the 0x0001 extra field
  zip64?: { size: number; compressed: number };
}

const enc = new TextEncoder();
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: number): number[] => [...u32(n % 0x100000000), ...u32(Math.floor(n / 0x100000000))];

function zip(items: Item[], opts: { comment?: string; zip64?: boolean } = {}): Uint8Array {
  const out: number[] = [];
  const central: number[] = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? [...enc.encode(item.name)] : item.name;
    const data = [...enc.encode(item.data ?? "")];
    const utf8 = item.utf8 ?? typeof item.name === "string";
    const flags = (utf8 ? 0x800 : 0) | (item.encrypted ? 1 : 0);
    const offset = out.length;
    out.push(0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(0), ...u32(0));
    out.push(...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name, ...data);
    const extAttr = item.dir ? 0x10 : 0;
    const extra = item.zip64 ? [...u16(1), ...u16(16), ...u64(item.zip64.size), ...u64(item.zip64.compressed)] : [];
    const sizes = item.zip64 ? [...u32(0xffffffff), ...u32(0xffffffff)] : [...u32(data.length), ...u32(data.length)];
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(0), ...u32(0));
    central.push(...sizes, ...u16(name.length), ...u16(extra.length), ...u16(0), ...u16(0), ...u16(0), ...u32(extAttr));
    central.push(...u32(offset), ...name, ...extra);
  }
  const cdOffset = out.length;
  const count = items.length;
  let end: number[];
  if (opts.zip64) {
    const eocd64 = out.length + central.length;
    const record = [0x50, 0x4b, 0x06, 0x06, ...u64(44), ...u16(45), ...u16(45), ...u32(0), ...u32(0)];
    record.push(...u64(count), ...u64(count), ...u64(central.length), ...u64(cdOffset));
    const locator = [0x50, 0x4b, 0x06, 0x07, ...u32(0), ...u64(eocd64), ...u32(1)];
    end = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(0xffff), ...u16(0xffff)];
    end.push(...u32(0xffffffff), ...u32(0xffffffff), ...u16(0));
    return new Uint8Array([...out, ...central, ...record, ...locator, ...end]);
  }
  const comment = [...enc.encode(opts.comment ?? "")];
  end = [0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(count), ...u16(count)];
  end.push(...u32(central.length), ...u32(cdOffset), ...u16(comment.length), ...comment);
  return new Uint8Array([...out, ...central, ...end]);
}

const THREE: Item[] = [
  { name: "notatka.txt", data: "Zażółć gęślą" },
  { name: "dane/", dir: true },
  { name: "dane/liczby.csv", data: "1;2;3\n" },
];

describe("readZipIndex", () => {
  it("katalog centralny: nazwy, rozmiary, foldery", () => {
    const r = readZipIndex(zip(THREE), 10000);
    expect(r.total).toBe(3);
    expect(r.more).toBe(false);
    expect(r.entries).toEqual([
      { name: "notatka.txt", size: enc.encode("Zażółć gęślą").length, compressed: enc.encode("Zażółć gęślą").length, dir: false, encrypted: false },
      { name: "dane/", size: 0, compressed: 0, dir: true, encrypted: false },
      { name: "dane/liczby.csv", size: 6, compressed: 6, dir: false, encrypted: false },
    ]);
  });

  it("polska nazwa z bitem 11 i bez bitu (poprawny UTF-8)", () => {
    const flagged = readZipIndex(zip([{ name: "zażółć gęślą.txt", data: "x" }]), 10);
    const plain = readZipIndex(zip([{ name: "zażółć gęślą.txt", data: "x", utf8: false }]), 10);
    expect(flagged.entries[0].name).toBe("zażółć gęślą.txt");
    expect(plain.entries[0].name).toBe("zażółć gęślą.txt");
  });

  it("bez bitu 11 i niepoprawny UTF-8: bajty jako znaki", () => {
    const r = readZipIndex(zip([{ name: [0x61, 0xe9, 0x2e, 0x74, 0x78, 0x74], data: "x", utf8: false }]), 10);
    expect(r.entries[0].name).toBe("aé.txt");
  });

  it("komentarz archiwum nie psuje odczytu", () => {
    const r = readZipIndex(zip(THREE, { comment: "to jest komentarz do archiwum" }), 10000);
    expect(r.entries.map((e) => e.name)).toEqual(["notatka.txt", "dane/", "dane/liczby.csv"]);
  });

  it("ZIP64: rekord EOCD64, lokalizator i pole 0x0001 z rozmiarem powyżej 4 GB", () => {
    const big = { size: 5_000_000_000, compressed: 4_500_000_000 };
    const r = readZipIndex(zip([{ name: "wielki.bin", data: "x", zip64: big }, { name: "mały.txt", data: "abc" }], { zip64: true }), 10);
    expect(r.total).toBe(2);
    expect(r.entries[0]).toMatchObject({ name: "wielki.bin", size: 5_000_000_000, compressed: 4_500_000_000 });
    expect(r.entries[1]).toMatchObject({ name: "mały.txt", size: 3, compressed: 3 });
  });

  it("maxEntries: najwyżej tyle wpisów, reszta zaznaczona jako more", () => {
    const r = readZipIndex(zip(THREE), 2);
    expect(r.entries).toHaveLength(2);
    expect(r.total).toBe(3);
    expect(r.more).toBe(true);
  });

  it("wpis z flagą szyfrowania", () => {
    const r = readZipIndex(zip([{ name: "tajne.txt", data: "xyz", encrypted: true }, { name: "jawne.txt", data: "xyz" }]), 10);
    expect(r.entries.map((e) => e.encrypted)).toEqual([true, false]);
  });

  it("obcięty katalog centralny → corrupt", () => {
    const z = zip(THREE);
    const eocd = z.length - 22;
    const cut = new Uint8Array([...z.subarray(0, eocd - 30), ...z.subarray(eocd)]);
    expect(() => readZipIndex(cut, 10000)).toThrow(PreviewError);
    expect(() => readZipIndex(cut, 10000)).toThrow("corrupt");
  });

  it("EOCD wskazujący poza bufor → corrupt", () => {
    const z = zip(THREE);
    const eocd = z.length - 22;
    z.set([0x00, 0x00, 0x10, 0x00], eocd + 16); // central directory at 1 MiB, past the end
    expect(() => readZipIndex(z, 10000)).toThrow("corrupt");
  });

  it("zły nagłówek wpisu w katalogu → corrupt", () => {
    const z = zip(THREE);
    const eocd = z.length - 22;
    const cdOffset = z[eocd + 16] | (z[eocd + 17] << 8);
    z[cdOffset] = 0;
    expect(() => readZipIndex(z, 10000)).toThrow("corrupt");
  });

  it("brak EOCD → corrupt", () => {
    const z = zip(THREE);
    expect(() => readZipIndex(z.subarray(0, z.length - 22), 10000)).toThrow("corrupt");
  });

  it("bajty losowe → corrupt", () => {
    let seed = 7;
    const noise = new Uint8Array(200).map(() => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    });
    expect(() => readZipIndex(noise, 10000)).toThrow("corrupt");
  });
});

describe("guardZip", () => {
  it("lets a small Office file through and stops a declared bomb or too many entries", () => {
    expect(() => guardZip(zip(THREE))).not.toThrow();
    const bomb = zip([{ name: "word/document.xml", zip64: { size: 10 * 1024 ** 3, compressed: 10 } }], { zip64: true });
    expect(() => guardZip(bomb)).toThrow("too-large");
    const many = zip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: "x" })));
    expect(() => guardZip(many, 1000, 4)).toThrow("too-large");
    expect(() => guardZip(new Uint8Array(30))).toThrow("corrupt");
  });
});
