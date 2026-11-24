// The last check before a text layer is written (docs/OCR.md §3.5): the text of each page comes from the extractor
// frame (an untrusted file's PDF text) or the OCR worker, so it is cleaned line by line, and the whole layer must parse
// back as exactly what was meant, within 2 MB. Anything else is an error and nothing reaches the server.
import { joinHyphenated, parse, sanitizeLine, serialize, type FileTextDoc, type Flag } from "./filetext";

/** At most this many bytes of UTF-8 in a layer (docs/OCR.md §2.3). */
export const MAX_LAYER_BYTES = 2 * 1024 * 1024;
const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A page's text made safe: lines sanitized (NFC, no control chars, a leading `#` escaped), hyphenation joined, blank
 *  lines at both ends dropped. Not a string, or a string over the layer limit: null (the page counts as an error). */
export function cleanPageText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_LAYER_BYTES) return null;
  const lines = joinHyphenated(raw.split(/\r\n|\r|\n/).map((l) => sanitizeLine(l).replace(/\s+$/u, "")));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * The layer's Markdown. Over the size limit, page texts are cut from the end (whole lines) and the layer gets the flag
 * `ucięte`. Throws when the result would not parse back to the same document (a bug or a hostile page text).
 */
export function finalizeLayer(doc: FileTextDoc): string {
  let current: FileTextDoc = { ...doc, pages: doc.pages.map((p) => ({ ...p })) };
  let md = serialize(current);
  if (bytes(md) > MAX_LAYER_BYTES) {
    const flags: Flag[] = current.flags.includes("ucięte") ? current.flags : [...current.flags, "ucięte"];
    current = { ...current, flags };
    for (let i = current.pages.length - 1; i >= 0 && bytes(md = serialize(current)) > MAX_LAYER_BYTES; i--) {
      const lines = current.pages[i].text.split("\n");
      const over = bytes(md) - MAX_LAYER_BYTES;
      let cut = 0;
      while (lines.length && cut < over) cut += bytes(lines.pop()!) + 1;
      current.pages[i] = { ...current.pages[i], text: lines.join("\n") };
    }
    md = serialize(current);
  }
  const back = parse(md);
  const same = back !== null && back.source === current.source && back.pages.length === current.pages.length
    && back.pages.every((p, i) => p.n === i + 1 && p.text === current.pages[i].text && p.lowQuality === current.pages[i].lowQuality);
  if (!same || bytes(md) > MAX_LAYER_BYTES) throw new Error("błąd");
  return md;
}
