// Text of one PDF page from its text layer (OCR §2.3): runs grouped into lines by their coordinates, a space where
// the gap is wide, two columns read left one first, and the check whether the text is usable. Pure functions: the
// caller maps pdf.js items to TextRun, so this file has no pdf.js import and runs in Node tests.

export interface TextRun {
  text: string;
  x: number; // left edge, PDF user units (y grows upwards)
  y: number; // baseline
  width: number;
  height: number; // font height
}

export type TextVerdict = "ok" | "no-text" | "garbled";

const LINE_SHARE = 0.5; // runs whose baselines differ by less than this share of the font height share a line
const SPACE_SHARE = 0.25; // a gap wider than this share of the font height is a space
const COLUMN_FREE_SHARE = 0.6; // share of the lines that must leave the gutter free
const COLUMN_MIN_GAP = 1.5; // the gutter is at least this many (median) font heights wide
const MIN_LETTERS = 20;
const MAX_BAD_SHARE = 0.1;
const MIN_GOOD_SHARE = 0.5;

const MAX_GUTTER_SPAN = 100_000; // wider text has no two-column gutter worth a bitmap of its width
// The text of a page is cut at this many units (OCR §2.3's 2 MB); each run counts with a space and a line break.
export const PAGE_RUN_LIMIT = 2 * 1024 * 1024;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const PUNCTUATION = /[.,;:!?'"()[\]{}\-–—/%&@#+*=_°€$£¥…„”“’‘«»]/u;
const BROKEN = /[�-\p{Cc}]/u;
const WHITESPACE = /\s/u;

interface Line { y: number; height: number; runs: TextRun[] }

/** Runs with text, grouped into lines from the top of the page down; each line's runs are sorted left to right. */
export function groupLines(runs: TextRun[]): Line[] {
  const sorted = runs.filter((r) => r.text.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const run of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(run.y - line.y) <= LINE_SHARE * Math.max(line.height, run.height, 1)) {
      line.runs.push(run);
      line.height = Math.max(line.height, run.height);
    } else {
      lines.push({ y: run.y, height: run.height, runs: [run] });
    }
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  return lines;
}

export interface PageBox { x0: number; y0: number; x1: number; y1: number }

/**
 * The runs whose left edge and baseline lie in the page box, in order, up to PAGE_RUN_LIMIT units: `cut` when runs were
 * left out for the limit. Runs outside the box (or with coordinates that are not finite) are dropped.
 */
export function pageRuns(runs: TextRun[], box: PageBox): { runs: TextRun[]; cut: boolean } {
  const kept: TextRun[] = [];
  let total = 0;
  for (const run of runs) {
    const inside = Number.isFinite(run.x) && Number.isFinite(run.y) && run.x >= box.x0 && run.x <= box.x1 && run.y >= box.y0 && run.y <= box.y1;
    if (!inside) continue;
    total += run.text.length + 2;
    if (total > PAGE_RUN_LIMIT) return { runs: kept, cut: true };
    kept.push(run);
  }
  return { runs: kept, cut: false };
}

/** The runs of one line as text: a space where the gap is wider than a quarter of the font height. */
export function joinLine(runs: TextRun[]): string {
  let out = "";
  let prev: TextRun | null = null;
  for (const run of runs) {
    if (prev) {
      const gap = run.x - (prev.x + prev.width);
      const wide = gap > SPACE_SHARE * Math.max(prev.height, run.height, 1);
      if (wide && !/\s$/u.test(out) && !/^\s/u.test(run.text)) out += " ";
    }
    out += run.text;
    prev = run;
  }
  return out.trim();
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 1;
}

/**
 * The vertical gutter of a two-column page, as [start, end) in user units, or null. It must be free of text in most
 * lines, wide enough, have at least two lines of text on each side, and sit in the middle part of the text. A table
 * of labels and values with a steady gutter looks the same by coordinates and is read as two columns (a known limit).
 */
function findGutter(lines: Line[]): [number, number] | null {
  const runs = lines.flatMap((l) => l.runs);
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const r of runs) {
    xMin = Math.min(xMin, r.x);
    xMax = Math.max(xMax, r.x + r.width);
  }
  if (!(xMax - xMin <= MAX_GUTTER_SPAN)) return null;
  const size = Math.ceil(xMax - xMin) + 1;
  // covered[b]: lines with text in the bin b (one bin per user unit, from xMin)
  const diff = new Int32Array(size + 1);
  for (const line of lines) {
    const spans = line.runs.map((r) => [Math.floor(r.x - xMin), Math.ceil(r.x + Math.max(r.width, 1) - xMin)] as const).sort((a, b) => a[0] - b[0]);
    let cur: [number, number] | null = null;
    for (const [a, b] of spans) {
      if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
      else {
        if (cur) { diff[cur[0]]++; diff[cur[1]]--; }
        cur = [a, b];
      }
    }
    if (cur) { diff[cur[0]]++; diff[cur[1]]--; }
  }
  const minWidth = COLUMN_MIN_GAP * median(runs.map((r) => r.height));
  const maxCovered = (1 - COLUMN_FREE_SHARE) * lines.length;
  let best: [number, number] | null = null;
  let covered = 0;
  let start = -1;
  for (let b = 0; b <= size; b++) {
    covered += diff[b];
    const free = b < size && covered <= maxCovered;
    if (free && start < 0) start = b;
    if ((!free || b === size) && start >= 0) {
      const gap: [number, number] = [start + xMin, b + xMin];
      const center = (gap[0] + gap[1]) / 2;
      const share = (center - xMin) / (xMax - xMin || 1);
      const width = gap[1] - gap[0];
      if (width >= minWidth && share >= 0.3 && share <= 0.7 && (!best || width > best[1] - best[0])) best = gap;
      start = -1;
    }
  }
  if (!best) return null;
  const [s, e] = best;
  const mid = (s + e) / 2;
  const leftLines = lines.filter((l) => l.runs.some((r) => r.x + r.width <= mid)).length;
  const rightLines = lines.filter((l) => l.runs.some((r) => r.x >= mid)).length;
  return leftLines >= 2 && rightLines >= 2 ? best : null;
}

/** The text of a page. Lines run top to bottom; on a two-column page the left column's lines come before the right's. */
export function pageText(runs: TextRun[]): string {
  const lines = groupLines(runs);
  const gutter = findGutter(lines);
  const out: string[] = [];
  if (!gutter) return linesText(lines).join("\n");
  // a run is in a column unless it covers the middle of the gutter: a ragged line may reach into the gutter
  const mid = (gutter[0] + gutter[1]) / 2;
  let left: TextRun[] = [];
  let right: TextRun[] = [];
  // the lines of one column block, the left column first; a line that crosses the gutter is full width
  const flush = (): void => {
    out.push(...linesText(groupLines(left)), ...linesText(groupLines(right)));
    left = [];
    right = [];
  };
  for (const line of lines) {
    if (line.runs.some((r) => r.x < mid && r.x + r.width > mid)) {
      flush();
      out.push(joinLine(line.runs));
    } else {
      for (const r of line.runs) (r.x + r.width <= mid ? left : right).push(r);
    }
  }
  flush();
  return out.filter((t) => t !== "").join("\n");
}

function linesText(lines: Line[]): string[] {
  return lines.map((l) => joinLine(l.runs)).filter((t) => t !== "");
}

/**
 * Whether the text of a page can be used. Fewer than 20 letters and digits: no text. Garbled: more than 10% of the
 * characters are U+FFFD, private-use or control characters, or fewer than half of the non-space characters are
 * letters, digits or common punctuation. Otherwise ok.
 */
export function textVerdict(text: string): TextVerdict {
  const chars = [...text];
  const letters = chars.filter((c) => LETTER_OR_DIGIT.test(c)).length;
  if (letters < MIN_LETTERS) return "no-text";
  const broken = chars.filter((c) => !WHITESPACE.test(c) && BROKEN.test(c)).length;
  const visible = chars.filter((c) => !WHITESPACE.test(c));
  const good = visible.filter((c) => LETTER_OR_DIGIT.test(c) || PUNCTUATION.test(c)).length;
  if (broken > MAX_BAD_SHARE * chars.length || good < MIN_GOOD_SHARE * visible.length) return "garbled";
  return "ok";
}
