// Messages between the app and the extractor frame (docs/OCR-PLAN.md §4.1, OCR §3.5). Both sides run every received
// message through isFromExtractor / isToExtractor: a message that fails the check is dropped, never half used.
import { ASSET_PATH, MAX_BYTES, MAX_TEXT } from "../preview/protocol";

/** The largest file the frame takes (the preview's own limit). */
export const MAX_EXTRACT_BYTES = MAX_BYTES;

export const EXTRACT_PROTOCOL = 1;
// OCR §2.3: 2 MB of text per file; a single page message carries at most this much.
export const MAX_EXTRACT_TEXT_BYTES = 2 * 1024 * 1024;

export type ExtractOptions = { maxPages: number; maxPixels: number; renderLongSide: number };
export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = { maxPages: 300, maxPixels: 50_000_000, renderLongSide: 2480 };

// The frame has no network: it asks the app for its own pdf.js data and libheif (`asset`), the app answers with the bytes
// of the preview's asset list (ASSET_PATH) or null. Assets carry no job id, as in the preview protocol.
// Flow control: after each page the frame waits for `next` before it reads the following one, so pages never pile up
// in the app while OCR is slower than rendering. The file's name never goes to the frame (it does not need it).
export type ToExtractor =
  | { type: "extract"; v: 1; jobId: number; mime: string; bytes: ArrayBuffer; options: ExtractOptions }
  | { type: "next"; v: 1; jobId: number }
  | { type: "cancel"; v: 1; jobId: number }
  | { type: "asset"; v: 1; path: string; bytes: ArrayBuffer | null };

// "unavailable": the frame could not get one of its own files (pdf.js data, libheif) from the app — a passing failure,
// not a property of the file.
export const EXTRACT_ERROR_CODES = ["encrypted", "corrupt", "unsupported", "too-large", "timeout", "unavailable"] as const;
export type ExtractErrorCode = (typeof EXTRACT_ERROR_CODES)[number];

export type FromExtractor =
  | { type: "ready"; v: 1 }
  | { type: "page"; v: 1; jobId: number; page: number; pages: number; text?: string; bitmap?: ImageBitmap; reason?: "no-text" | "garbled" }
  | { type: "done"; v: 1; jobId: number; pages: number; truncated: boolean }
  | { type: "error"; v: 1; jobId: number; code: ExtractErrorCode }
  | { type: "asset"; v: 1; path: string };

type Fields = Record<string, unknown>;

const isObject = (x: unknown): x is Fields => typeof x === "object" && x !== null && !Array.isArray(x);
const isPosInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const isNonNegInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isShortText = (x: unknown): x is string => typeof x === "string" && x.length <= MAX_TEXT;
const isPath = (x: unknown): x is string => typeof x === "string" && ASSET_PATH.test(x);
// Checked by tag, not instanceof: the other window has its own ArrayBuffer constructor.
const isBuffer = (x: unknown): x is ArrayBuffer =>
  Object.prototype.toString.call(x) === "[object ArrayBuffer]" && (x as ArrayBuffer).byteLength <= MAX_BYTES;
const isBitmap = (x: unknown): x is ImageBitmap => typeof ImageBitmap !== "undefined" && x instanceof ImageBitmap;

// UTF-16 length is checked first: a text of more units than the limit has at least as many UTF-8 bytes.
const isExtractText = (x: unknown): x is string =>
  typeof x === "string" && x.length <= MAX_EXTRACT_TEXT_BYTES && new TextEncoder().encode(x).byteLength <= MAX_EXTRACT_TEXT_BYTES;

const isOptions = (x: unknown): x is ExtractOptions =>
  isObject(x) && isPosInt(x.maxPages) && isPosInt(x.maxPixels) && isPosInt(x.renderLongSide);

const isErrorCode = (x: unknown): x is ExtractErrorCode =>
  typeof x === "string" && (EXTRACT_ERROR_CODES as readonly string[]).includes(x);

function fromPage(d: Fields): boolean {
  const { jobId, page, pages, text, bitmap, reason } = d;
  if (!isPosInt(jobId) || !isPosInt(page) || !isPosInt(pages) || page > pages) return false;
  if (reason !== undefined && reason !== "no-text" && reason !== "garbled") return false;
  // exactly one of text and bitmap: a page is either its text or its pixels
  if ((text === undefined) === (bitmap === undefined)) return false;
  return text === undefined ? isBitmap(bitmap) : isExtractText(text);
}

/** The app checks what the frame sends. Returns true only for a known message with the right fields. */
export function isFromExtractor(x: unknown): x is FromExtractor {
  if (!isObject(x) || x.v !== EXTRACT_PROTOCOL) return false;
  switch (x.type) {
    case "ready":
      return true;
    case "page":
      return fromPage(x);
    case "done":
      return isPosInt(x.jobId) && isNonNegInt(x.pages) && typeof x.truncated === "boolean";
    case "error":
      return isPosInt(x.jobId) && isErrorCode(x.code);
    case "asset":
      return isPath(x.path);
    default:
      return false;
  }
}

/** The frame checks what the app sends before it uses a single field. */
export function isToExtractor(x: unknown): x is ToExtractor {
  if (!isObject(x) || x.v !== EXTRACT_PROTOCOL) return false;
  switch (x.type) {
    case "extract":
      return isPosInt(x.jobId) && isShortText(x.mime) && isBuffer(x.bytes) && isOptions(x.options);
    case "next":
    case "cancel":
      return isPosInt(x.jobId);
    case "asset":
      return isPath(x.path) && (x.bytes === null || isBuffer(x.bytes));
    default:
      return false;
  }
}
