// Text layer of OCR files: Markdown with a YAML-like header and one section per page (docs/OCR.md §3.1).
// Pure functions, no DOM. Only the shape serialize writes is accepted by parse.

export const FILETEXT_SCHEMA = "notes-filetext-v1";
export const EXTRACTOR_VERSION = 1;

export type Method = "pdf-text" | "ocr" | "mixed" | "none";
export type Flag = "ucięte" | "zabezpieczony" | "brak tekstu" | "błąd";

export interface FileTextPage {
  n: number; // from 1
  text: string; // sanitized lines joined by "\n"; "" = no text on the page
  lowQuality: boolean;
}

export interface FileTextDoc {
  source: string; // fileId of the original, 32 lowercase hex
  name: string;
  mime: string;
  method: Method;
  pages: FileTextPage[];
  lang: "latin";
  quality: number; // 0..1, two decimals when written
  flags: Flag[];
  extractor: number;
  engine: string;
  createdAt: string; // ISO 8601 UTC, seconds, "Z"
  image?: boolean; // single image: section "## Obraz" instead of "## Strona 1"
}

const METHODS: readonly Method[] = ["pdf-text", "ocr", "mixed", "none"];
const FLAGS: readonly Flag[] = ["ucięte", "zabezpieczony", "brak tekstu", "błąd"];
const KEYS = [
  "schema", "source", "name", "mime", "method", "pages", "lang", "quality",
  "flags", "extractor", "engine", "createdAt",
] as const;
const PLACEHOLDER = "_(brak tekstu)_";
const LOW = " · niska jakość";
const PAGE_RE = /^## Strona (\d+)( · niska jakość)?$/;
const IMAGE_RE = /^## Obraz( · niska jakość)?$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const QUALITY_RE = /^[01]\.\d{2}$/;
const INT_RE = /^(0|[1-9]\d*)$/;
// Control characters except tab (U+0009), plus DEL and the C1 range.
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;
// Bidi controls, zero-width characters and BOM (they hide or reorder text in a note), and lone surrogates (not text).
const INVISIBLE_RE = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function serialize(doc: FileTextDoc): string {
  const sections = doc.pages.map((p) => {
    const heading = doc.image ? "## Obraz" : `## Strona ${p.n}`;
    return `${heading}${p.lowQuality ? LOW : ""}\n${p.text === "" ? PLACEHOLDER : p.text}`;
  });
  const header = [
    "---",
    `schema: ${FILETEXT_SCHEMA}`,
    `source: ${doc.source}`,
    `name: ${JSON.stringify(doc.name)}`,
    `mime: ${doc.mime}`,
    `method: ${doc.method}`,
    `pages: ${doc.pages.length}`,
    `lang: ${doc.lang}`,
    `quality: ${doc.quality.toFixed(2)}`,
    `flags: [${doc.flags.join(", ")}]`,
    `extractor: ${doc.extractor}`,
    `engine: ${JSON.stringify(doc.engine)}`,
    `createdAt: ${doc.createdAt}`,
    "---",
  ];
  return `${header.join("\n")}\n\n${sections.join("\n\n")}\n`;
}

export function parse(md: string): FileTextDoc | null {
  const lines = md.split("\n");
  if (lines.pop() !== "") return null; // the file must end with a newline
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const header = parseHeader(lines.slice(1, end));
  if (header === null || lines[end + 1] !== "") return null;

  const body = lines.slice(end + 2);
  const heads: { idx: number; n: number; lowQuality: boolean; image: boolean }[] = [];
  for (let idx = 0; idx < body.length; idx++) {
    const line = body[idx];
    if (!line.startsWith("## ")) continue;
    const page = PAGE_RE.exec(line);
    const image = IMAGE_RE.exec(line);
    if (page) heads.push({ idx, n: Number(page[1]), lowQuality: page[2] !== undefined, image: false });
    else if (image) heads.push({ idx, n: 1, lowQuality: image[1] !== undefined, image: true });
    else return null;
  }
  // a file with no pages (a password-protected PDF, a file that does not read): the header and one empty body line
  if (header.pages === 0 && body.length === 1 && body[0] === "") return { ...header, pages: [], lang: "latin" };
  if (heads.length === 0 || heads.length !== header.pages || heads[0].idx !== 0) return null;
  const image = heads[0].image;
  if (heads.some((h) => h.image !== image)) return null;

  const pages: FileTextPage[] = [];
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i];
    if (head.n !== i + 1) return null;
    const next = i + 1 < heads.length ? heads[i + 1].idx : body.length;
    const raw = body.slice(head.idx + 1, next);
    // Every section except the last is followed by one blank separator line.
    if (i + 1 < heads.length && raw.pop() !== "") return null;
    const text = raw.length === 1 && raw[0] === PLACEHOLDER ? "" : raw.join("\n");
    pages.push({ n: i + 1, text, lowQuality: head.lowQuality });
  }

  const doc: FileTextDoc = {
    source: header.source,
    name: header.name,
    mime: header.mime,
    method: header.method,
    pages,
    lang: "latin",
    quality: header.quality,
    flags: header.flags,
    extractor: header.extractor,
    engine: header.engine,
    createdAt: header.createdAt,
  };
  if (image) doc.image = true;
  return doc;
}

interface Header {
  source: string;
  name: string;
  mime: string;
  method: Method;
  pages: number;
  quality: number;
  flags: Flag[];
  extractor: number;
  engine: string;
  createdAt: string;
}

function parseHeader(lines: string[]): Header | null {
  if (lines.length !== KEYS.length) return null;
  const raw: string[] = [];
  for (let i = 0; i < KEYS.length; i++) {
    const prefix = `${KEYS[i]}: `;
    if (!lines[i].startsWith(prefix)) return null;
    raw.push(lines[i].slice(prefix.length));
  }
  const [schema, source, name, mime, method, pages, lang, quality, flags, extractor, engine, createdAt] = raw;
  const nameValue = jsonString(name);
  const engineValue = jsonString(engine);
  const flagList = parseFlags(flags);
  if (
    schema !== FILETEXT_SCHEMA ||
    !HEX32_RE.test(source) ||
    mime === "" ||
    !isMethod(method) ||
    !INT_RE.test(pages) ||
    lang !== "latin" ||
    !QUALITY_RE.test(quality) ||
    Number(quality) > 1 ||
    flagList === null ||
    !INT_RE.test(extractor) ||
    nameValue === null ||
    engineValue === null ||
    !ISO_RE.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    return null;
  }
  return {
    source,
    name: nameValue,
    mime,
    method,
    pages: Number(pages),
    quality: Number(quality),
    flags: flagList,
    extractor: Number(extractor),
    engine: engineValue,
    createdAt,
  };
}

/** A JSON string literal in canonical form; anything else (other escapes, bare text) is rejected. */
function jsonString(raw: string): string | null {
  if (!raw.startsWith('"')) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" && JSON.stringify(value) === raw ? value : null;
  } catch {
    return null;
  }
}

function parseFlags(raw: string): Flag[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
  const inner = raw.slice(1, -1);
  if (inner === "") return [];
  const out: Flag[] = [];
  for (const part of inner.split(", ")) {
    if (!isFlag(part)) return null;
    out.push(part);
  }
  return out;
}

function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

function isFlag(value: string): value is Flag {
  return (FLAGS as readonly string[]).includes(value);
}

export function sanitizeLine(line: string): string {
  const clean = line.normalize("NFC").replace(CONTROL_RE, "").replace(INVISIBLE_RE, "");
  // the empty-page marker as recognized text would read back as an empty page: escaped like "#"
  if (clean.trim() === "_(brak tekstu)_") return clean.replace("_(brak tekstu)_", "\\_(brak tekstu)_");
  return clean.replace(/^([ \t]*)#/, "$1\\#");
}

/** Joins a word hyphenated at the line end ("przedsię-" + "biorstwo") when the next line starts lowercase. */
export function joinHyphenated(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const last = out.length - 1;
    if (last >= 0 && /\p{L}-$/u.test(out[last]) && /^\p{Ll}/u.test(line)) {
      out[last] = out[last].slice(0, -1) + line;
    } else {
      out.push(line);
    }
  }
  return out;
}
