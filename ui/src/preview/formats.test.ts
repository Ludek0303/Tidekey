import { describe, expect, it } from "vitest";
import { HEAD_BYTES, MAX_SIZE, VIEWER_IDS, VIEWER_LABEL, detect, guess, videoContainer } from "./formats";
import type { ViewerId } from "./formats";

const MIB = 1024 * 1024;
const enc = new TextEncoder();

// Test-only byte builders: strings are ASCII (char codes & 0xff), arrays are raw bytes.
type Part = string | ArrayLike<number>;
function bytes(...parts: Part[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (let i = 0; i < p.length; i++) out.push(p.charCodeAt(i) & 0xff);
    else for (let i = 0; i < p.length; i++) out.push(p[i]);
  }
  return Uint8Array.from(out);
}
const pad = (n: number): number[] => new Array<number>(n).fill(0);
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const utf16le = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  return out;
};
const ole = (word: string): Uint8Array =>
  bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], pad(504), utf16le(word), pad(8));

// Stored (uncompressed) ZIP with a central directory and EOCD.
function zip(entries: Array<{ name: string; data?: string }>): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  for (const { name, data = "" } of entries) {
    const n = Array.from(bytes(name));
    const d = Array.from(bytes(data));
    const offset = local.length;
    local.push(
      ...Array.from(bytes("PK\x03\x04")), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...n, ...d,
    );
    central.push(
      ...Array.from(bytes("PK\x01\x02")), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...n,
    );
  }
  const eocd = [
    ...Array.from(bytes("PK\x05\x06")), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(local.length), ...u16(0),
  ];
  return Uint8Array.from([...local, ...central, ...eocd]);
}

function indexOfAscii(b: Uint8Array, s: string): number {
  const p = Array.from(bytes(s));
  for (let i = 0; i + p.length <= b.length; i++) if (p.every((c, j) => b[i + j] === c)) return i;
  return -1;
}

// Deterministic noise (no Math.random, so failures reproduce).
function noise(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const PLY_HEAD = "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n";
const PLY_FACE = `${PLY_HEAD}element face 1\nproperty list uchar int vertex_indices\nend_header\n`;
const PLY_POINTS = `${PLY_HEAD}end_header\n`;

const SIGNATURES: Array<{ label: string; name: string; data: Uint8Array; viewer: ViewerId }> = [
  { label: "PDF", name: "raport.pdf", data: bytes("%PDF-1.7\n", pad(32)), viewer: "pdf" },
  { label: "PNG", name: "a.png", data: bytes("\x89PNG\r\n\x1a\n", pad(16)), viewer: "image" },
  { label: "JPEG", name: "a.jpg", data: bytes([0xff, 0xd8, 0xff, 0xe0], pad(16)), viewer: "image" },
  { label: "GIF", name: "a.gif", data: bytes("GIF89a", pad(16)), viewer: "image" },
  { label: "WEBP", name: "a.webp", data: bytes("RIFF", u32(100), "WEBP", pad(16)), viewer: "image" },
  { label: "BMP", name: "a.bmp", data: bytes("BM", pad(32)), viewer: "image" },
  { label: "TIFF LE", name: "skan.tif", data: bytes("II*\0", pad(32)), viewer: "tiff" },
  { label: "TIFF BE", name: "skan.tiff", data: bytes("MM\0*", pad(32)), viewer: "tiff" },
  { label: "PSD", name: "projekt.psd", data: bytes("8BPS", pad(32)), viewer: "psd" },
  { label: "HEIC", name: "zdjecie.heic", data: bytes(u32(24), "ftypheic", pad(16)), viewer: "heic" },
  { label: "HEIF mif1", name: "zdjecie.heif", data: bytes(u32(24), "ftypmif1", pad(16)), viewer: "heic" },
  { label: "M4A", name: "nagranie.m4a", data: bytes(u32(24), "ftypM4A ", pad(16)), viewer: "audio" },
  { label: "MP4", name: "film.mp4", data: bytes(u32(24), "ftypisom", pad(16)), viewer: "video" },
  { label: "MOV", name: "film.mov", data: bytes(u32(24), "ftypqt  ", pad(16)), viewer: "video" },
  { label: "AVI", name: "film.avi", data: bytes("RIFF", u32(100), "AVI ", pad(16)), viewer: "video" },
  { label: "WAV", name: "dzwiek.wav", data: bytes("RIFF", u32(100), "WAVE", pad(16)), viewer: "audio" },
  { label: "EBML (mkv)", name: "film.mkv", data: bytes([0x1a, 0x45, 0xdf, 0xa3], pad(32)), viewer: "video" },
  { label: "DWG", name: "rysunek.dwg", data: bytes("AC1032", pad(32)), viewer: "cad" },
  { label: "OLE doc", name: "stary.doc", data: ole("WordDocument"), viewer: "doc" },
  { label: "OLE ppt", name: "stary.ppt", data: ole("PowerPoint Document"), viewer: "ppt" },
  { label: "OLE xls", name: "stary.xls", data: ole("Workbook"), viewer: "sheet" },
  { label: "WOFF", name: "f.woff", data: bytes("wOFF", pad(32)), viewer: "font" },
  { label: "WOFF2", name: "f.woff2", data: bytes("wOF2", pad(32)), viewer: "font" },
  { label: "TTF", name: "f.ttf", data: bytes([0, 1, 0, 0], pad(32)), viewer: "font" },
  { label: "OTF", name: "f.otf", data: bytes("OTTO", pad(32)), viewer: "font" },
  { label: "glTF", name: "model.glb", data: bytes("glTF", u32(2), pad(16)), viewer: "model3d" },
  { label: "LAS", name: "chmura.las", data: bytes("LASF", pad(32)), viewer: "pointcloud" },
  { label: "PCD", name: "chmura.pcd", data: bytes("# .PCD v0.7 - Point Cloud Data file format\nVERSION .7\n"), viewer: "pointcloud" },
  { label: "STEP", name: "czesc.step", data: bytes("ISO-10303-21;\nHEADER;\n"), viewer: "none" }, // occt needs eval: the download card (PODGLAD.md §6)
  { label: "IFC", name: "dom.ifc", data: bytes("ISO-10303-21;\nHEADER;\n"), viewer: "model3d" },
  { label: "STL text", name: "bryla.stl", data: bytes("solid cube\nfacet normal 0 0 1\n"), viewer: "model3d" },
  { label: "ID3", name: "utwor.mp3", data: bytes("ID3\x03\0\0", pad(32)), viewer: "audio" },
  { label: "MP3 frame", name: "utwor.mp3", data: bytes([0xff, 0xfb], pad(32)), viewer: "audio" },
  { label: "OGG", name: "utwor.ogg", data: bytes("OggS", pad(32)), viewer: "audio" },
  { label: "FLAC", name: "utwor.flac", data: bytes("fLaC", pad(32)), viewer: "audio" },
  { label: "DXF", name: "rysunek.dxf", data: bytes("  0\nSECTION\n  2\nHEADER\n"), viewer: "cad" },
  { label: "SVG", name: "logo.svg", data: bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), viewer: "image" },
  { label: "ZIP", name: "archiwum.zip", data: zip([{ name: "notatka.txt", data: "x" }]), viewer: "zip" },
  { label: "DOCX", name: "pismo.docx", data: zip([{ name: "word/document.xml", data: "<w:document/>" }]), viewer: "docx" },
  { label: "XLSX", name: "tabela.xlsx", data: zip([{ name: "[Content_Types].xml" }, { name: "xl/workbook.xml" }]), viewer: "sheet" },
  { label: "PPTX", name: "prezentacja.pptx", data: zip([{ name: "ppt/presentation.xml" }]), viewer: "pptx" },
  {
    label: "ODS",
    name: "tabela.ods",
    data: zip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet" }, { name: "content.xml" }]),
    viewer: "sheet",
  },
  { label: "PLY with face", name: "siatka.ply", data: bytes(PLY_FACE), viewer: "model3d" },
  { label: "PLY points", name: "punkty.ply", data: bytes(PLY_POINTS), viewer: "pointcloud" },
];

describe("detect: sygnatury z listy", () => {
  it.each(SIGNATURES)("$label -> $viewer", ({ name, data, viewer }) => {
    expect(detect(data, "", name)).toBe(viewer);
  });
});

describe("detect: ZIP i kontenery", () => {
  it("bajty wygrywają z MIME: ZIP z word/ pod nazwą .pdf to docx, zwykły ZIP to zip", () => {
    expect(detect(zip([{ name: "word/document.xml", data: "x" }]), "application/pdf", "raport.pdf")).toBe("docx");
    expect(detect(zip([{ name: "a.txt" }]), "application/pdf", "raport.pdf")).toBe("zip");
  });

  it("pusty ZIP (sam EOCD) to zip", () => {
    expect(detect(bytes("PK\x05\x06", pad(18)), "", "pusty.zip")).toBe("zip");
  });

  it("ZIP bez katalogu centralnego: czyta nagłówki lokalne", () => {
    const full = zip([{ name: "xl/workbook.xml", data: "<x/>" }]);
    const head = full.slice(0, indexOfAscii(full, "PK\x01\x02"));
    expect(detect(head, "", "obciety.xlsx")).toBe("sheet");
  });

  it("EOCD wskazujący poza tablicę daje zip bez wyjątku", () => {
    const z = zip([{ name: "word/document.xml", data: "x" }]);
    z.set(u32(0xfffff0), z.length - 22 + 16);
    expect(detect(z, "", "uszkodzony.docx")).toBe("zip");
  });

  it("ODS rozpoznawany po wpisie mimetype bez kompresji", () => {
    const z = zip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet" }]);
    expect(detect(z, "", "tabela.ods")).toBe("sheet");
  });

  it("OLE2 z WordDocument w UTF-16LE to doc, bez znanych strumieni none", () => {
    expect(detect(ole("WordDocument"), "", "stary.doc")).toBe("doc");
    expect(detect(ole("Bookshelf"), "", "x.exe")).toBe("none");
  });

  it("OLE2 Book jako całe słowo (po nim 0,0) to sheet", () => {
    expect(detect(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], pad(504), utf16le("Book"), pad(8)), "", "x.xls")).toBe("sheet");
  });

  it("PLY z face o liczbie 0 to pointcloud", () => {
    expect(detect(bytes(PLY_HEAD, "element face 0\nend_header\n"), "", "x.ply")).toBe("pointcloud");
  });

  it("PLY z CRLF w nagłówku", () => {
    expect(detect(bytes(PLY_FACE.replace(/\n/g, "\r\n")), "", "siatka.ply")).toBe("model3d");
  });
});

describe("detect: tekst, HTML, SVG", () => {
  const PL = enc.encode("Zażółć gęślą jaźń\nSzybki brązowy lis.\n");

  it("UTF-8 z polskimi znakami w .txt to text", () => {
    expect(detect(PL, "text/plain", "notatka.txt")).toBe("text");
  });

  it("ten sam tekst z rozszerzeniem .csv to csv", () => {
    expect(detect(PL, "text/csv", "dane.csv")).toBe("csv");
  });

  it("tekst bez znanego rozszerzenia to text, a .tsv to csv", () => {
    expect(detect(PL, "", "notatka.xyz")).toBe("text");
    expect(detect(enc.encode("a\tb\n1\t2\n"), "", "dane.tsv")).toBe("csv");
  });

  it("pusty plik .txt to text, pusty .pdf zostaje pdf", () => {
    expect(detect(new Uint8Array(0), "", "pusty.txt")).toBe("text");
    expect(detect(new Uint8Array(0), "", "pusty.pdf")).toBe("pdf");
  });

  it("HTML nigdy nie jest renderowany: to text", () => {
    expect(detect(enc.encode("<!doctype html><html><body><script>1</script></body></html>"), "text/html", "strona.html")).toBe("text");
    expect(detect(enc.encode("<html><body>x</body></html>"), "", "strona.htm")).toBe("text");
  });

  it("SVG to image, także w otoczce XML", () => {
    expect(detect(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml", "logo.svg")).toBe("image");
    expect(detect(enc.encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), "", "logo.xml")).toBe("image");
  });

  it("tekst UTF-16 z BOM to text", () => {
    expect(detect(bytes([0xff, 0xfe], utf16le("Witaj świecie")), "", "tekst.txt")).toBe("text");
  });

  it("wielobajtowy znak przecięty na granicy 8 KiB nadal jest tekstem", () => {
    const long = bytes("a", enc.encode("ż".repeat(5000)));
    // Byte 8192 falls inside a 2-byte character that starts at 8191.
    expect(long.length).toBeGreaterThan(8 * 1024);
    expect(detect(long, "", "dlugi.txt")).toBe("text");
  });

  it("bajt 0 w pliku bez sygnatury nie jest tekstem", () => {
    expect(detect(bytes("abc\0def", pad(16)), "", "x.bin")).toBe("none");
  });
});

describe("detect: bajty nic nie mówią", () => {
  it("losowe bajty z .exe to none", () => {
    expect(detect(noise(1024), "application/octet-stream", "program.exe")).toBe("none");
  });

  it("losowe bajty z .obj to model3d (binarny format bez sygnatury)", () => {
    expect(detect(noise(1024), "", "model.obj")).toBe("model3d");
  });

  it("losowe bajty bez rozszerzenia binarnego to none", () => {
    expect(detect(noise(1024), "", "x.bin")).toBe("none");
  });

  it("bajty wygrywają z MIME i z rozszerzenia", () => {
    expect(detect(bytes("%PDF-1.4", pad(16)), "text/plain", "x.txt")).toBe("pdf");
    expect(detect(bytes("\x89PNG\r\n\x1a\n", pad(16)), "application/pdf", "x.pdf")).toBe("image");
    expect(detect(bytes(u32(24), "ftypheic", pad(16)), "video/mp4", "x.mp4")).toBe("heic");
  });
});

describe("detect: krótkie tablice nie rzucają", () => {
  const inputs = [...SIGNATURES.map((s) => s.data), noise(64), enc.encode("tekst")];
  it.each([0, 1, 3])("długość %i dla każdej gałęzi", (n) => {
    for (const data of inputs) {
      for (const name of ["x.zip", "x.txt", "x.exe", "x.obj", "x.ply", "x.dxf", "x.svg"]) {
        expect(VIEWER_IDS).toContain(detect(data.slice(0, n), "", name));
      }
    }
  });
});

describe("guess", () => {
  it("rozszerzenie bez względu na wielkość liter", () => {
    expect(guess("", "PLIK.PDF")).toEqual({ viewer: "pdf", maxSize: 100 * MIB, label: "PDF" });
  });

  it("DWG ma limit 30 MiB i pozostaje cad", () => {
    expect(guess("", "rysunek.dwg")).toEqual({ viewer: "cad", maxSize: 30 * MIB, label: "Rysunek CAD" });
    expect(guess("", "rysunek.dxf")).toEqual({ viewer: "cad", maxSize: 50 * MIB, label: "Rysunek CAD" });
  });

  it("rozszerzenie wygrywa z MIME", () => {
    expect(guess("application/pdf", "x.txt").viewer).toBe("text");
  });

  it("MIME, gdy brak rozszerzenia", () => {
    expect(guess("application/pdf", "").viewer).toBe("pdf");
    expect(guess("image/tiff", "").viewer).toBe("tiff");
    expect(guess("image/heic", "").viewer).toBe("heic");
    expect(guess("image/webp", "").viewer).toBe("image");
    expect(guess("text/csv", "").viewer).toBe("csv");
    expect(guess("text/plain", "").viewer).toBe("text");
    expect(guess("application/json", "").viewer).toBe("text");
    expect(guess("audio/mpeg", "").viewer).toBe("audio");
    expect(guess("video/mp4", "").viewer).toBe("video");
    expect(guess("font/woff2", "").viewer).toBe("font");
    expect(guess("application/zip", "").viewer).toBe("zip");
  });

  it("nazwy bez rozszerzenia znane jako tekst", () => {
    for (const name of ["Dockerfile", "Makefile", "README", "LICENSE"]) expect(guess("", name).viewer).toBe("text");
  });

  it("nieznany typ to none z zerowym limitem", () => {
    expect(guess("", "x.bin")).toEqual({ viewer: "none", maxSize: 0, label: "Plik" });
  });

  it("tabele limitów i etykiet", () => {
    expect(MAX_SIZE).toEqual({
      image: 50 * MIB, tiff: 50 * MIB, psd: 100 * MIB, heic: 30 * MIB, text: 10 * MIB, csv: 20 * MIB,
      audio: 100 * MIB, font: 20 * MIB, zip: 100 * MIB, video: 16 * MIB, pdf: 100 * MIB, docx: 30 * MIB,
      doc: 30 * MIB, sheet: 30 * MIB, pptx: 50 * MIB, ppt: 50 * MIB, model3d: 100 * MIB, step: 50 * MIB,
      pointcloud: 100 * MIB, cad: 50 * MIB, none: 0,
    });
    expect(VIEWER_LABEL).toEqual({
      image: "Obraz", tiff: "Obraz", psd: "Obraz", heic: "Obraz", text: "Tekst", csv: "Tabela CSV", audio: "Dźwięk",
      font: "Font", zip: "Archiwum ZIP", video: "Wideo", pdf: "PDF", docx: "Dokument", doc: "Dokument",
      sheet: "Arkusz", pptx: "Prezentacja", ppt: "Prezentacja", model3d: "Model 3D", step: "Model 3D",
      pointcloud: "Chmura punktów", cad: "Rysunek CAD", none: "Plik",
    });
    expect(HEAD_BYTES).toBe(64 * 1024);
  });
});

describe("videoContainer", () => {
  const ebml = (doctype: string): Uint8Array =>
    bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80 | (3 + doctype.length)], [0x42, 0x82, 0x80 | doctype.length], doctype);

  it("EBML z DocType webm to webm, z matroska to mkv", () => {
    expect(videoContainer(ebml("webm"), "x")).toBe("webm");
    expect(videoContainer(ebml("matroska"), "x")).toBe("mkv");
  });

  it("EBML bez DocType to mkv, nawet przy nazwie .webm", () => {
    expect(videoContainer(bytes([0x1a, 0x45, 0xdf, 0xa3], pad(16)), "film.webm")).toBe("mkv");
  });

  it("AVI i ftyp (qt to mov, reszta mp4)", () => {
    expect(videoContainer(bytes("RIFF", u32(100), "AVI ", pad(8)), "x")).toBe("avi");
    expect(videoContainer(bytes(u32(20), "ftypqt  ", pad(8)), "x")).toBe("mov");
    expect(videoContainer(bytes(u32(20), "ftypisom", pad(8)), "x")).toBe("mp4");
  });

  it("po rozszerzeniu, gdy bajty nic nie mówią", () => {
    const none = pad(16);
    expect(videoContainer(bytes(none), "clip.webm")).toBe("webm");
    expect(videoContainer(bytes(none), "clip.mkv")).toBe("mkv");
    expect(videoContainer(bytes(none), "clip.avi")).toBe("avi");
    expect(videoContainer(bytes(none), "clip.mov")).toBe("mov");
    expect(videoContainer(bytes(none), "clip.mp4")).toBe("mp4");
    expect(videoContainer(bytes(none), "clip.txt")).toBeNull();
  });

  it("krótkie tablice nie rzucają", () => {
    expect(videoContainer(new Uint8Array(0), "x.mp4")).toBe("mp4");
    expect(videoContainer(new Uint8Array([0x1a]), "x.txt")).toBeNull();
    expect(videoContainer(new Uint8Array([0x1a, 0x45, 0xdf]), "x.webm")).toBe("webm");
  });
});

describe("3dm", () => {
  it("gets the download card at once: rhino3dm would need eval in the frame", () => {
    expect(guess("application/octet-stream", "model.3dm").viewer).toBe("none");
  });
});
