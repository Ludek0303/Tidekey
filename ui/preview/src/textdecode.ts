// Text of a file: the encoding comes from a BOM, else UTF-8, else windows-1250 (Polish files from old Windows).
// Pure code, shared by the text and CSV viewers.

export const TEXT_SHOWN_BYTES = 2 * 1024 * 1024;

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1250";

export function decodeText(bytes: Uint8Array, limit = TEXT_SHOWN_BYTES): { text: string; encoding: TextEncoding; truncated: boolean } {
  const truncated = bytes.length > limit;
  const shown = Math.min(limit, bytes.length);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16("utf-16le", bytes, shown), encoding: "utf-16le", truncated };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16("utf-16be", bytes, shown), encoding: "utf-16be", truncated };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const end = truncated ? utf8Cut(bytes, shown) : bytes.length;
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3, end)), encoding: "utf-8", truncated };
  }
  try {
    const end = truncated ? utf8Cut(bytes, shown) : bytes.length;
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)), encoding: "utf-8", truncated };
  } catch {
    // not UTF-8: a single-byte code page, which never splits a character
    return { text: new TextDecoder("windows-1250").decode(bytes.subarray(0, shown)), encoding: "windows-1250", truncated };
  }
}

function decodeUtf16(encoding: "utf-16le" | "utf-16be", bytes: Uint8Array, shown: number): string {
  let end = 2 + Math.floor((shown - 2) / 2) * 2;
  // a high surrogate at the cut would decode to U+FFFD: leave its pair out
  if (end >= 4) {
    const hi = encoding === "utf-16le" ? bytes[end - 1] << 8 | bytes[end - 2] : bytes[end - 2] << 8 | bytes[end - 1];
    if (hi >= 0xd800 && hi <= 0xdbff) end -= 2;
  }
  return new TextDecoder(encoding).decode(bytes.subarray(2, Math.max(2, end)));
}

// The end of the longest run of whole UTF-8 characters that fits in `limit` bytes.
function utf8Cut(bytes: Uint8Array, limit: number): number {
  if (limit <= 0) return 0;
  let lead = limit - 1;
  while (lead > 0 && limit - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
  const b = bytes[lead];
  const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return lead + length > limit ? lead : limit;
}
