// Lines from recognized boxes: cleaning, reading order (with the two-column rule) and the page quality.
import { quadSize, type Quad } from "./db";

export interface Line {
  quad: Quad;
  text: string;
  conf: number;
}

const MIN_CHARS = 2; // letters or digits per line (docs/OCR-PLAN.md §3 pkt 4)
const MIN_CONF = 0.5;
const COLUMN_SPAN = 0.6; // the free band spans this share of the page height (OCR-PLAN §3 pkt 5)
const COLUMN_GAP = 0.02; // the free band is at least this share of the page width
const COLUMN_MIN_ROWS = 2; // each side holds at least two text rows, so a word gap in one line is no column
const NO_TEXT_MIN_QUADS = 3; // OCR §2.4 pkt 2
const TEXT_ASPECT = 2;
const TEXT_MIN_HEIGHT = 8;

const isAlnum = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

export function cleanLines(lines: Line[]): Line[] {
  return lines.filter((l) => [...l.text].filter(isAlnum).length >= MIN_CHARS && l.conf >= MIN_CONF);
}

// Average confidence weighted by text length; 1 without text.
export function pageQuality(lines: Line[]): number {
  let weight = 0, sum = 0;
  for (const l of lines) {
    const n = [...l.text].length;
    weight += n;
    sum += n * l.conf;
  }
  return weight > 0 ? sum / weight : 1;
}

// The detector found no text: no quads, or fewer than 3 and none is a text-like box.
export function detectorSaysNoText(quads: Quad[]): boolean {
  if (quads.length === 0) return true;
  if (quads.length >= NO_TEXT_MIN_QUADS) return false;
  return !quads.some((q) => {
    const { w, h } = quadSize(q);
    return w >= TEXT_ASPECT * h && h >= TEXT_MIN_HEIGHT;
  });
}

interface Item {
  top: number;
  bottom: number;
  left: number;
  right: number;
  text: string;
}

// Boxes → text lines (ocr_ref.reading_order): a box starts a new line when its top is below the middle of the
// previous box; inside a line, left to right.
function groupLines(items: Item[]): string[] {
  const sorted = [...items].sort((a, b) => a.top + a.bottom - (b.top + b.bottom));
  const lines: Item[][] = [];
  let cur: Item[] = [];
  for (const it of sorted) {
    const last = cur[cur.length - 1];
    if (last && it.top > (last.top + last.bottom) / 2) {
      lines.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) lines.push(cur);
  return lines.map((l) =>
    [...l]
      .sort((a, b) => a.left - b.left)
      .map((i) => i.text)
      .join(" "),
  );
}

// The widest horizontal gap that no box crosses and that splits the boxes into two sides, each with text rows. A gap
// no box crosses is free over the whole page height, so the 60%-of-height rule of OCR-PLAN §3 holds by construction;
// the rows check keeps word gaps inside one line out.
function findColumnSplit(items: Item[], pageWidth: number, pageHeight: number): [Item[], Item[]] | null {
  if (items.length < 2) return null;
  const byLeft = [...items].sort((a, b) => a.left - b.left);
  const gaps: { at: number; to: number }[] = [];
  let reach = byLeft[0].right;
  for (const it of byLeft.slice(1)) {
    if (it.left > reach && it.left - reach >= COLUMN_GAP * pageWidth) gaps.push({ at: reach, to: it.left });
    reach = Math.max(reach, it.right);
  }
  gaps.sort((a, b) => b.to - b.at - (a.to - a.at));
  for (const g of gaps) {
    const left = items.filter((it) => it.right <= g.at);
    const right = items.filter((it) => it.left >= g.to);
    if (left.length + right.length !== items.length) continue;
    // the band is free over the whole page height here (no box crosses it)
    if (pageHeight < COLUMN_SPAN * pageHeight) continue;
    if (groupLines(left).length < COLUMN_MIN_ROWS || groupLines(right).length < COLUMN_MIN_ROWS) continue;
    return [left, right];
  }
  return null;
}

export function readingOrder(lines: Line[], pageWidth: number, pageHeight: number): string[] {
  const items: Item[] = lines
    .map((l) => {
      const xs = l.quad.pts.map((p) => p[0]);
      const ys = l.quad.pts.map((p) => p[1]);
      return {
        top: Math.min(...ys),
        bottom: Math.max(...ys),
        left: Math.min(...xs),
        right: Math.max(...xs),
        text: l.text.trim(),
      };
    })
    .filter((it) => it.text !== "");
  const split = findColumnSplit(items, pageWidth, pageHeight);
  if (!split) return groupLines(items);
  return [...groupLines(split[0]), ...groupLines(split[1])];
}
