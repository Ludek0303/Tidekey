// Permissions written as note text (docs/MCP.md §6 "Uprawnienia zapisane w treści notatek"): front matter `osoby:`,
// `grupy:`, `prowadzacy:` and the module type (`typ:`), and the `!zaznacza:` tokens of table column headers. A chat
// never changes them, whether it writes directly (MCP) or through a proposal (checked again when it is approved).
// No DOM: shared by the browser and the MCP.

export const MARKS_TEXT = "Czat nie zmienia osób, prowadzącego ani uprawnień kolumn. Zrób to w aplikacji.";

const KEYS = new Set(["osoby", "grupy", "prowadzacy", "typ", "type"]);

// Front matter lines as crates/core/src/index/parse.rs reads them: a first line "---", up to the next line "---";
// an unclosed block is not front matter.
function frontMatter(lines: string[]): string[] {
  if (lines[0]?.trimEnd() !== "---") return [];
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  return end < 0 ? [] : lines.slice(1, end);
}
// The key of a `key: value` line, lowercase like the index (indented keys count there too).
const keyOf = (line: string): string => { const at = line.indexOf(":"); return at < 0 ? "" : line.slice(0, at).trim().replace(/^["']|["']$/g, "").toLowerCase(); };

/** A canonical extract of every permission mark in `text`; equal extracts mean equal marks. */
export function permissionMarks(text: string): string {
  const lines = text.split("\n");
  const front: string[] = [];
  const fm = frontMatter(lines);
  for (let i = 0; i < fm.length; i++) {
    const key = keyOf(fm[i]);
    if (!KEYS.has(key)) continue;
    front.push(`${key}:${fm[i].slice(fm[i].indexOf(":") + 1).trim()}`);
    // a YAML list or indented value under the key belongs to it
    while (i + 1 < fm.length && /^[\s-]/.test(fm[i + 1])) front.push(`  ${fm[++i].trim()}`);
  }
  // the whole header line, so moving a token to another column counts as a change
  const checks = lines.filter((line) => /!zaznacza:/iu.test(line)).map((line) => line.trim());
  return JSON.stringify({ front, checks });
}

/** True when `after` adds, removes or changes any permission mark of `before`. */
export const touchesPermissionMarks = (before: string, after: string): boolean => permissionMarks(before) !== permissionMarks(after);
