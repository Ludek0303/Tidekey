// Which viewer handles a file. Bytes beat the extension and MIME; the extension decides only when the bytes say nothing.
// Pure code: no DOM, no dependencies. The preview frame and the app both use it.

export const VIEWER_IDS = [
  "image", "tiff", "psd", "heic", "text", "csv", "audio", "font", "zip", "video", "pdf", "docx",
  "doc", "sheet", "pptx", "ppt", "model3d", "step", "pointcloud", "cad", "none",
] as const;
export type ViewerId = (typeof VIEWER_IDS)[number];
export const HEAD_BYTES = 64 * 1024;
export interface FormatInfo { viewer: ViewerId; maxSize: number; label: string }
export type VideoContainer = "mp4" | "mov" | "webm" | "mkv" | "avi";

const MIB = 1024 * 1024;
const TEXT_SNIFF_BYTES = 8 * 1024;

export const MAX_SIZE: Record<ViewerId, number> = {
  image: 50 * MIB, tiff: 50 * MIB, psd: 100 * MIB, heic: 30 * MIB, text: 10 * MIB, csv: 20 * MIB,
  audio: 100 * MIB, font: 20 * MIB, zip: 100 * MIB, video: 16 * MIB, pdf: 100 * MIB, docx: 30 * MIB,
  doc: 30 * MIB, sheet: 30 * MIB, pptx: 50 * MIB, ppt: 50 * MIB, model3d: 100 * MIB, step: 50 * MIB,
  pointcloud: 100 * MIB, cad: 50 * MIB, none: 0,
};

export const VIEWER_LABEL: Record<ViewerId, string> = {
  image: "Obraz", tiff: "Obraz", psd: "Obraz", heic: "Obraz", text: "Tekst", csv: "Tabela CSV", audio: "Dźwięk",
  font: "Font", zip: "Archiwum ZIP", video: "Wideo", pdf: "PDF", docx: "Dokument", doc: "Dokument",
  sheet: "Arkusz", pptx: "Prezentacja", ppt: "Prezentacja", model3d: "Model 3D", step: "Model 3D",
  pointcloud: "Chmura punktów", cad: "Rysunek CAD", none: "Plik",
};

const BY_EXTENSION = new Map<string, ViewerId>();
function extensions(viewer: ViewerId, list: string): void {
  for (const ext of list.split(" ")) BY_EXTENSION.set(ext, viewer);
}
extensions("image", "png jpg jpeg gif webp avif bmp ico svg");
extensions("tiff", "tif tiff");
extensions("psd", "psd");
extensions("heic", "heic heif");
extensions("text", "txt md markdown json jsonc log xml yaml yml toml ini cfg conf env js mjs cjs ts tsx jsx py rs go java kt kts c h cc cpp hpp cs rb php sh bash zsh fish ps1 bat sql css scss less html htm vue svelte swift r lua pl dart scala gradle dockerfile makefile cmake tex rst diff patch srt vtt");
extensions("csv", "csv tsv");
extensions("audio", "mp3 wav ogg oga opus flac m4a aac");
extensions("video", "mp4 m4v mov webm mkv avi ogv");
extensions("font", "ttf otf woff woff2");
extensions("zip", "zip");
extensions("pdf", "pdf");
extensions("docx", "docx docm dotx");
extensions("doc", "doc dot");
extensions("sheet", "xlsx xlsm xls xlsb ods");
extensions("pptx", "pptx pptm ppsx");
extensions("ppt", "ppt pps");
// 3dm is not shown: rhino3dm needs eval (its embind glue), which the preview frame never allows (PODGLAD-PLAN D11)
extensions("model3d", "obj stl ply gltf glb fbx 3ds 3mf amf dae wrl off ifc");
// step stp iges igs brep brp: occt-import-js needs eval too, so they get the download card (PODGLAD.md §6)
extensions("pointcloud", "las laz pcd");
extensions("cad", "dxf dwg");

const BARE_NAMES = new Set(["dockerfile", "makefile", "readme", "license"]);
// Binary formats whose files have no signature: with no readable text, the extension is the only clue.
const BINARY_WITHOUT_SIGNATURE = new Set(["obj", "3ds", "fbx", "3mf", "off", "las", "laz", "amf", "dae", "wrl", "stl"]);
const HEIC_BRANDS = ["heic", "heix", "heim", "heis", "mif1", "msf1"];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PK_LOCAL = "PK\x03\x04";
const PK_EOCD = "PK\x05\x06";
const PK_CENTRAL = "PK\x01\x02";
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const ZIP_MAX_ENTRIES = 10000;
const ZIP_EOCD_WINDOW = 65557; // 22-byte EOCD plus a comment of at most 65535 bytes
const ODS_SHEET_MIME = "application/vnd.oasis.opendocument.spreadsheet";

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function viewerForMime(mime: string): ViewerId | undefined {
  const m = mime.toLowerCase();
  if (m === "image/tiff") return "tiff";
  if (m === "image/heic" || m === "image/heif") return "heic";
  if (m.startsWith("image/")) return "image";
  if (m === "text/csv" || m === "text/tab-separated-values") return "csv";
  if (m.startsWith("text/") || m === "application/json" || m === "application/xml") return "text";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("font/")) return "font";
  if (m === "application/zip") return "zip";
  if (m === "application/pdf") return "pdf";
  return undefined;
}

/** From name and MIME alone (before download): whether to try, and with which size limit. */
export function guess(mime: string, name: string): FormatInfo {
  const ext = extOf(name);
  const viewer: ViewerId =
    BY_EXTENSION.get(ext) ?? (!ext && BARE_NAMES.has(name.toLowerCase()) ? "text" : undefined) ?? viewerForMime(mime) ?? "none";
  // DWG is capped at 30 MiB, below the 50 MiB of the other CAD formats.
  const maxSize = ext === "dwg" ? 30 * MIB : MAX_SIZE[viewer];
  return { viewer, maxSize, label: VIEWER_LABEL[viewer] };
}

/** From bytes (whole file or its head), MIME and name. Bytes win over extension and MIME. */
export function detect(bytes: Uint8Array, mime: string, name: string): ViewerId {
  const ext = extOf(name);
  const magic = sniff(bytes, ext, mime);
  if (magic) return magic;
  const guessed = guess(mime, name).viewer;
  if (bytes.length === 0) return guessed === "none" ? "text" : guessed;
  if (looksText(bytes)) return isHtml(bytes) || guessed === "none" ? "text" : guessed;
  return BINARY_WITHOUT_SIGNATURE.has(ext) ? guessed : "none";
}

/** Video container from bytes; without a matching signature the extension decides. */
export function videoContainer(bytes: Uint8Array, name: string): VideoContainer | null {
  if (at(bytes, 0, EBML)) return ebmlDocType(bytes) === "webm" ? "webm" : "mkv";
  if (at(bytes, 0, "RIFF") && at(bytes, 8, "AVI ")) return "avi";
  if (at(bytes, 4, "ftyp")) return at(bytes, 8, "qt  ") ? "mov" : "mp4";
  switch (extOf(name)) {
    case "mp4":
    case "m4v":
      return "mp4";
    case "mov":
      return "mov";
    case "webm":
      return "webm";
    case "mkv":
      return "mkv";
    case "avi":
      return "avi";
    default:
      return null;
  }
}

function sniff(b: Uint8Array, ext: string, mime: string): ViewerId | null {
  if (at(b, 0, "%PDF")) return "pdf";
  if (at(b, 0, PK_LOCAL) || at(b, 0, PK_EOCD)) return zipKind(b);
  if (at(b, 0, OLE)) return oleKind(b);
  if (at(b, 0, "AC10") && isDigit(b[4]) && isDigit(b[5])) return "cad";
  if (at(b, 0, EBML)) return "video";
  if (at(b, 0, "RIFF")) {
    if (at(b, 8, "AVI ")) return "video";
    if (at(b, 8, "WAVE")) return "audio";
    if (at(b, 8, "WEBP")) return "image";
  }
  if (at(b, 4, "ftyp")) {
    if (HEIC_BRANDS.some((brand) => at(b, 8, brand))) return "heic";
    return at(b, 8, "M4A ") || at(b, 8, "M4B ") ? "audio" : "video";
  }
  if (at(b, 0, "II*\0") || at(b, 0, "MM\0*")) return "tiff";
  if (at(b, 0, "8BPS")) return "psd";
  if (at(b, 0, "\x89PNG") || at(b, 0, [0xff, 0xd8, 0xff]) || at(b, 0, "GIF8") || (ext === "bmp" && at(b, 0, "BM"))) return "image";
  if (at(b, 0, "wOFF") || at(b, 0, "wOF2") || at(b, 0, "OTTO")) return "font";
  // shortcut: "true" is also a common word, so TrueType signatures count only for font files.
  const fontFile = ext === "ttf" || ext === "otf" || mime.toLowerCase().startsWith("font/");
  if (fontFile && (at(b, 0, [0, 1, 0, 0]) || at(b, 0, "true"))) return "font";
  if (at(b, 0, "glTF")) return "model3d";
  if (at(b, 0, "ply\n") || at(b, 0, "ply\r\n")) return plyKind(b);
  if (at(b, 0, "LASF")) return "pointcloud";
  const head = textAt(b, 0, 1024);
  if (/^(?:# \.PCD|VERSION (?:0?\.7))/m.test(head)) return "pointcloud";
  if (at(b, 0, "ISO-10303-21")) return ext === "ifc" ? "model3d" : "none";
  if (at(b, 0, "solid ") && ext === "stl") return "model3d";
  if (at(b, 0, "ID3") || at(b, 0, [0xff, 0xfb]) || at(b, 0, [0xff, 0xf3]) || at(b, 0, [0xff, 0xf2]) || at(b, 0, "OggS") || at(b, 0, "fLaC")) return "audio";
  if (/^\s*0\r?\nSECTION\b/.test(head)) return "cad";
  if (/^\s*<(?:svg|\?xml)/i.test(head) && /<svg/i.test(head)) return "image";
  return null;
}

function zipKind(b: Uint8Array): ViewerId {
  const names = zipNames(b);
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("xl/"))) return "sheet";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  if (isOpenDocumentSheet(b)) return "sheet";
  if (names.includes("3D/3dmodel.model")) return "model3d";
  return "zip";
}

/** Names from the central directory. With no EOCD in the bytes (only the head of a file), the local headers instead. */
function zipNames(b: Uint8Array): string[] {
  const names: string[] = [];
  const eocd = findEocd(b);
  if (eocd >= 0) {
    // An offset outside the array gives no names, so the result stays "zip" rather than reading further.
    let p = u32(b, eocd + 16);
    const count = Math.min(u16(b, eocd + 10), ZIP_MAX_ENTRIES);
    for (let i = 0; i < count && p >= 0 && p + 46 <= b.length && at(b, p, PK_CENTRAL); i++) {
      const nameLen = u16(b, p + 28);
      const next = p + 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
      if (nameLen < 0 || p + 46 + nameLen > b.length) break;
      names.push(textAt(b, p + 46, p + 46 + nameLen));
      p = next;
    }
    return names;
  }
  let p = 0;
  for (let i = 0; i < ZIP_MAX_ENTRIES && p + 30 <= b.length && at(b, p, PK_LOCAL); i++) {
    const flags = u16(b, p + 6);
    const csize = u32(b, p + 18);
    const nameLen = u16(b, p + 26);
    const extra = u16(b, p + 28);
    if (p + 30 + nameLen > b.length) break;
    names.push(textAt(b, p + 30, p + 30 + nameLen));
    // Bit 3 means the sizes sit after the data, so the next header cannot be found from here.
    if (flags & 8) break;
    p = p + 30 + nameLen + extra + csize;
  }
  return names;
}

function findEocd(b: Uint8Array): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - ZIP_EOCD_WINDOW); i--) {
    if (at(b, i, PK_EOCD)) return i;
  }
  return -1;
}

// ODS keeps "mimetype" as the first entry, stored without compression, so its content follows the local header.
function isOpenDocumentSheet(b: Uint8Array): boolean {
  if (!at(b, 0, PK_LOCAL)) return false;
  const nameLen = u16(b, 26);
  return u16(b, 8) === 0 && nameLen === 8 && textAt(b, 30, 38) === "mimetype" && at(b, 30 + 8 + u16(b, 28), ODS_SHEET_MIME);
}

function plyKind(b: Uint8Array): ViewerId {
  const text = textAt(b, 0, 64 * 1024);
  const end = text.indexOf("end_header");
  const header = end < 0 ? text : text.slice(0, end);
  const face = /element face (\d+)/.exec(header);
  return face && Number(face[1]) > 0 ? "model3d" : "pointcloud";
}

function oleKind(b: Uint8Array): ViewerId {
  if (indexOfBytes(b, utf16le("WordDocument")) >= 0) return "doc";
  if (indexOfBytes(b, utf16le("PowerPoint Document")) >= 0) return "ppt";
  // "Book" counts only as a whole word, so it has to end with a zero code unit.
  if (indexOfBytes(b, utf16le("Workbook")) >= 0 || indexOfBytes(b, [...utf16le("Book"), 0, 0]) >= 0) return "sheet";
  return "none";
}

// Text, not a binary blob: no zero byte in the first 8 KiB and valid UTF-8 (or a UTF-16 BOM).
function looksText(b: Uint8Array): boolean {
  if (at(b, 0, [0xff, 0xfe]) || at(b, 0, [0xfe, 0xff])) return true;
  const head = b.subarray(0, Math.min(b.length, TEXT_SNIFF_BYTES));
  if (head.includes(0)) return false;
  try {
    // A head cut inside a multi-byte character is fine: stream mode keeps the partial tail pending.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(head, { stream: b.length > head.length });
    return true;
  } catch {
    return false;
  }
}

function isHtml(b: Uint8Array): boolean {
  const start = textAt(b, 0, 64).trimStart().toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html");
}

// The DocType element (0x4282) sits near the start of the EBML header; its size is read as a one-byte vint.
// shortcut: a DocType longer than 127 bytes is not read, so it counts as mkv, upgrade if such files appear.
function ebmlDocType(b: Uint8Array): string {
  const i = indexOfBytes(b.subarray(0, 64), [0x42, 0x82]);
  if (i < 0 || (b[i + 2] & 0x80) === 0) return "";
  return textAt(b, i + 3, i + 3 + (b[i + 2] & 0x7f));
}

// The bounds check is inside at(), so short arrays never throw.
function at(b: Uint8Array, i: number, pat: string | readonly number[]): boolean {
  if (i < 0 || i + pat.length > b.length) return false;
  for (let j = 0; j < pat.length; j++) {
    const want = typeof pat === "string" ? pat.charCodeAt(j) : pat[j];
    if (b[i + j] !== want) return false;
  }
  return true;
}

function indexOfBytes(b: Uint8Array, pat: readonly number[]): number {
  for (let i = 0; i + pat.length <= b.length; i++) if (at(b, i, pat)) return i;
  return -1;
}

function u16(b: Uint8Array, i: number): number {
  return i >= 0 && i + 2 <= b.length ? b[i] | (b[i + 1] << 8) : -1;
}

function u32(b: Uint8Array, i: number): number {
  return i >= 0 && i + 4 <= b.length ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : -1;
}

function textAt(b: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < Math.min(end, b.length); i++) out += String.fromCharCode(b[i]);
  return out;
}

function utf16le(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  return out;
}

const isDigit = (x: number): boolean => x >= 0x30 && x <= 0x39;
