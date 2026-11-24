//! Charts in notes: a fenced block with the info string `wykres` keeps the chart as plain text (`typ:`, `tytuł:` and one
//! `label: value` line per point), so sync, undo and Obsidian see only text. A linked block (`tabela: powyżej`) keeps no
//! values: it reads the table above it, so the chart follows the table. This file reads that text and draws the chart
//! as SVG in a fixed 640-wide space; the editor and the reading view both call it.

import { evaluateTable } from "./formula";

export type ChartType = "bar" | "pie";
export interface ChartPoint { label: string; value: number }
/** `source` is null for a chart with its own values; a linked chart reads the table above it (`column` null: the first numeric column). */
export interface Chart { type: ChartType; title: string; points: ChartPoint[]; skipped: number; source: { column: string | null } | null }
/** A chart ready to draw: `error` says why a linked chart has no data (and then `chart.points` is empty). */
export interface ResolvedChart { chart: Chart; error: string | null }
/** A table's cells, header row first, as the formula engine evaluates them. */
export type TableRows = { text: string; kind: string }[][];

export const MAX_POINTS = 50;
const W = 640;
const NS = "http://www.w3.org/2000/svg";
const TYPES: Record<string, ChartType> = { słupkowy: "bar", slupkowy: "bar", bar: "bar", kołowy: "pie", kolowy: "pie", pie: "pie" };
const META = new Map<string, "type" | "title" | "table" | "column">([
  ["typ", "type"], ["tytuł", "title"], ["tytul", "title"], ["title", "title"],
  ["tabela", "table"], ["źródło", "table"], ["zrodlo", "table"], ["source", "table"], ["kolumna", "column"],
]);
const LINKED = new Set(["powyżej", "powyzej", "tabela"]);
const NO_TABLE = "Nad wykresem nie ma tabeli. Wstaw tabelę nad blokiem wykresu albo wpisz wartości.";
const NO_NUMBERS = "Tabela nad wykresem nie ma kolumny z liczbami.";

export const SAMPLE_CHART: Chart = {
  type: "bar",
  title: "Nowy wykres",
  points: [{ label: "A", value: 10 }, { label: "B", value: 20 }, { label: "C", value: 15 }],
  skipped: 0,
  source: null,
};

/** A number as the notes write it: a decimal comma or dot, spaces between thousands, a leading minus. Null if it is not one. */
export function parseValue(text: string): number | null {
  const t = text.replace(/[\s  ]/g, "").replace("−", "-");
  if (!/^[-+]?\d+([.,]\d+)?$/.test(t)) return null;
  return Number(t.replace(",", "."));
}

/** A value as the note writes it: a decimal comma and no thousand separators, the form parseValue reads back. */
export const formatValue = (n: number): string => String(n).replace(".", ",");

/**
 * The chart in a block's text. Meta lines (`typ:`, `tytuł:`) count only before the first point, so a point whose label
 * is one of those words still reads as a point. Lines that do not parse are counted in `skipped`, and so are points
 * over MAX_POINTS.
 */
export function parseChart(source: string): Chart {
  const chart: Chart = { type: "bar", title: "", points: [], skipped: 0, source: null };
  const seen = new Set<string>();
  let linked = false;
  let column: string | null = null;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const meta = /^([^:]+):(.*)$/.exec(line);
    const key = META.get(meta?.[1].trim().toLowerCase() ?? "");
    if (meta && key && !seen.has(key) && chart.points.length === 0) {
      seen.add(key);
      const value = meta[2].trim();
      if (key === "type") chart.type = TYPES[value.toLowerCase()] ?? "bar";
      else if (key === "title") chart.title = value;
      else if (key === "table") linked = LINKED.has(value.toLowerCase());
      else column = value || null;
      continue;
    }
    // the value follows the last colon, so a label may contain one ("10:30: 5")
    const colon = line.lastIndexOf(":");
    const label = colon > 0 ? line.slice(0, colon).trim() : "";
    const value = colon > 0 ? parseValue(line.slice(colon + 1)) : null;
    if (!label || value === null || chart.points.length >= MAX_POINTS) chart.skipped++;
    else chart.points.push({ label, value });
  }
  // a linked chart keeps no values of its own: the points above are ignored
  return linked ? { ...chart, points: [], skipped: 0, source: { column } } : chart;
}

/** The chart's canonical text: meta lines first (both always written, so a point cannot read as one), then the points. */
export function chartSource(chart: Chart): string {
  const type = `typ: ${chart.type === "pie" ? "kołowy" : "słupkowy"}`;
  if (chart.source) {
    return [type, ...(chart.title ? [`tytuł: ${chart.title}`] : []), "tabela: powyżej", ...(chart.source.column ? [`kolumna: ${chart.source.column}`] : [])].join("\n");
  }
  return [type, `tytuł: ${chart.title}`, ...chart.points.map((p) => `${p.label}: ${formatValue(p.value)}`)].join("\n");
}

/** The whole fenced block that holds the chart. */
export const chartBlock = (chart: Chart): string => "```wykres\n" + chartSource(chart) + "\n```";

/** The text between a block's fences; an unclosed block has no closing fence. */
export function chartBody(block: string): string {
  const lines = block.split("\n");
  const closed = lines.length > 1 && lines[lines.length - 1].trim().startsWith("```");
  return lines.slice(1, closed ? -1 : undefined).join("\n");
}

/**
 * Where a block goes at `at` in `doc`: on lines of its own, with a blank line before it when the text above has any,
 * and a blank line after it. `start` is where the block begins in the document after the insert.
 */
export function blockInsertion(doc: string, at: number, block: string): { insert: string; start: number } {
  const lineStart = at > 0 ? doc.lastIndexOf("\n", at - 1) + 1 : 0;
  const head = doc.slice(lineStart, at);
  const aboveStart = lineStart > 1 ? doc.lastIndexOf("\n", lineStart - 2) + 1 : 0;
  const above = lineStart > 0 ? doc.slice(aboveStart, lineStart - 1) : "";
  const pre = head.trim() ? "\n\n" : above.trim() ? "\n" : "";
  const after = doc.slice(at);
  const post = after === "" ? "\n\n" : after.startsWith("\n") ? "\n" : "\n\n";
  return { insert: pre + block + post, start: at + pre.length };
}

const clean = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const headerText = (rows: TableRows, c: number): string => clean(rows[0]?.[c]?.text);

/** The columns after the first (the labels) that hold a number. */
function numericColumns(rows: TableRows): number[] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const out: number[] = [];
  for (let c = 1; c < cols; c++) {
    if (rows.slice(1).some((r) => r[c]?.kind === "number" && parseValue(r[c].text) !== null)) out.push(c);
  }
  return out;
}

/** The headers of the numeric columns, in table order: the choices of the dialog's column list. */
export const numericHeaders = (rows: TableRows): string[] => numericColumns(rows).map((c) => headerText(rows, c)).filter(Boolean);

/**
 * A linked chart from the table above it. Labels are the first column; values are the column named by `kolumna`
 * (case-insensitive), else the first numeric column; the title is `tytuł`, else that column's header. Rows with no label
 * or no number are skipped. `rows` is null when no table is above the chart.
 */
export function linkedChart(chart: Chart, rows: TableRows | null): ResolvedChart {
  const fail = (error: string): ResolvedChart => ({ chart: { ...chart, points: [], skipped: 0 }, error });
  if (!rows) return fail(NO_TABLE);
  const numeric = numericColumns(rows);
  const column = chart.source?.column ?? null;
  let col: number | undefined = numeric[0];
  if (column) {
    const want = clean(column).toLowerCase();
    const cols = Math.max(0, ...rows.map((r) => r.length));
    const found = Array.from({ length: cols }, (_, c) => c).find((c) => headerText(rows, c).toLowerCase() === want);
    if (found === undefined) return fail(`W tabeli nad wykresem nie ma kolumny „${column}”.`);
    col = numeric.includes(found) ? found : undefined;
  }
  if (col === undefined) return fail(NO_NUMBERS);
  const points: ChartPoint[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const label = clean(r[0]?.text);
    const value = r[col]?.kind === "number" ? parseValue(r[col].text) : null;
    if (!label || value === null || points.length >= MAX_POINTS) skipped++;
    else points.push({ label, value });
  }
  return { chart: { type: chart.type, title: chart.title || headerText(rows, col), points, skipped, source: chart.source }, error: null };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

interface Fence { from: number; to: number; info: string }
interface Table { from: number; to: number; lines: string[] }

/** The fenced blocks and the GFM tables of a note, by offsets. A table counts only outside code fences. */
function scanNote(note: string): { fences: Fence[]; tables: Table[] } {
  const lines = note.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const end = (i: number) => starts[i] + lines[i].length;
  const fences: Fence[] = [];
  const tables: Table[] = [];
  let open: { marker: string; from: number; info: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      const close = CLOSE.exec(line);
      if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
        fences.push({ from: open.from, to: end(i), info: open.info });
        open = null;
      }
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      open = { marker: fence[1], from: starts[i], info: line.trim().slice(fence[1].length).trim() };
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && DELIMITER.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && !FENCE.test(lines[j])) j++;
      tables.push({ from: starts[i], to: end(j - 1), lines: lines.slice(i, j) });
      i = j - 1;
    }
  }
  if (open) fences.push({ from: open.from, to: note.length, info: open.info });
  return { fences, tables };
}

/** The `wykres` blocks of a note as offsets, in order: the reading view pairs them with its chart elements. */
export const chartFences = (note: string): { from: number; to: number }[] =>
  scanNote(note).fences.filter((f) => f.info.toLowerCase() === "wykres");

// shortcut: without wasm a cell with an escaped pipe splits in two; formulas come back once wasm is ready
const splitCells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());

/** The rows of the nearest table that ends before `from`, evaluated when wasm is ready; null if there is none. */
export function tableAbove(note: string, from: number): TableRows | null {
  const table = scanNote(note).tables.filter((t) => t.to <= from).pop();
  if (!table) return null;
  const evaluated = evaluateTable(table.lines.join("\n"));
  if (evaluated) {
    return Array.from({ length: evaluated.rows }, (_, r) => Array.from({ length: evaluated.cols }, (_, c) => evaluated.cell(r, c)));
  }
  return [table.lines[0], ...table.lines.slice(2)].map((line) =>
    splitCells(line).map((text) => ({ text, kind: !text ? "empty" : parseValue(text) !== null ? "number" : "text" })),
  );
}

/** The drawable chart of the block at [from, to) of `note`: a linked block reads the table above it. */
export function resolveChart(note: string, from: number, to: number): ResolvedChart {
  const chart = parseChart(chartBody(note.slice(from, to)));
  return chart.source ? linkedChart(chart, tableAbove(note, from)) : { chart, error: null };
}

const fmt = (n: number): string => n.toLocaleString("pl-PL");
const pctText = (value: number, total: number): string => {
  const p = (value / total) * 100;
  return `${(p < 10 ? Math.round(p * 10) / 10 : Math.round(p)).toLocaleString("pl-PL")}%`;
};
// 1, 2 or 5 times a power of ten: the steps an axis may use.
const STEPS = Array.from({ length: 41 }, (_, i) => i - 20).flatMap((e) => [1, 2, 5].map((m) => Number(`${m}e${e}`)));

/** Nice tick values from `min` to `max` (both include zero), with at most five intervals. */
function niceTicks(min: number, max: number): number[] {
  let step = STEPS.find((s) => s >= (max - min) / 4) ?? STEPS[STEPS.length - 1];
  for (;;) {
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const n = Math.round((hi - lo) / step);
    if (n <= 5) return Array.from({ length: n + 1 }, (_, i) => Number((lo + i * step).toPrecision(12)));
    step = STEPS[STEPS.indexOf(step) + 1];
  }
}

function node(parent: Element, name: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

// A bar from its baseline to its value; the corners at the data end are rounded (4px), the baseline corners are square.
function barPath(x: number, w: number, top: number, bottom: number, positive: boolean): string {
  const r = Math.min(4, w / 2, bottom - top);
  if (positive) return `M${x} ${bottom}V${top + r}A${r} ${r} 0 0 1 ${x + r} ${top}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${top + r}V${bottom}Z`;
  return `M${x} ${top}V${bottom - r}A${r} ${r} 0 0 0 ${x + r} ${bottom}H${x + w - r}A${r} ${r} 0 0 0 ${x + w} ${bottom - r}V${top}Z`;
}

const shorten = (label: string, max: number): string => (label.length <= max ? label : max <= 1 ? "…" : `${label.slice(0, max - 1)}…`);

// Bars on a zero baseline, one series in one colour. Each bar is a group: its hit area, mark, labels and tooltip.
function drawBars(svg: Element, points: ChartPoint[]): void {
  const X0 = 56;
  const X1 = W - 8;
  const Y0 = 40;
  const Y1 = 200;
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values) || 1);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => Y1 - ((v - lo) / (hi - lo)) * (Y1 - Y0);
  for (const t of ticks) {
    node(svg, "line", { class: "chart-grid", x1: X0, x2: X1, y1: y(t), y2: y(t) });
    node(svg, "text", { class: "chart-tick", x: X0 - 8, y: y(t) + 4, "text-anchor": "end" }, fmt(t));
  }
  const slot = (X1 - X0) / points.length;
  const barW = Math.min(64, slot * 0.7, slot - 2); // a gap of at least 2px between bars
  const base = y(0);
  const fits = Math.max(1, Math.floor((slot - 4) / 6.2));
  for (const [i, p] of points.entries()) {
    const cx = X0 + slot * (i + 0.5);
    const top = Math.min(base, y(p.value));
    const bottom = Math.max(base, y(p.value));
    const tip = `${p.label}: ${fmt(p.value)}`;
    const g = node(svg, "g", { class: "chart-item", "data-tip": tip });
    node(g, "title", {}, tip);
    node(g, "rect", { x: X0 + slot * i, y: Y0, width: slot, height: Y1 - Y0, fill: "transparent" });
    node(g, "path", { class: "chart-mark", d: barPath(cx - barW / 2, barW, top, bottom, p.value >= 0) });
    if (points.length <= 12) node(g, "text", { class: "chart-value", x: cx, y: p.value >= 0 ? top - 6 : bottom + 12, "text-anchor": "middle" }, fmt(p.value));
    node(g, "text", { class: "chart-cat", x: cx, y: Y1 + 20, "text-anchor": "middle" }, shorten(p.label, fits));
  }
}

// Pie slices: the positive values in data order; from the eighth on they fold into one slice "Inne".
function foldSlices(points: ChartPoint[]): ChartPoint[] {
  const positive = points.filter((p) => p.value > 0);
  if (positive.length <= 8) return positive;
  return [...positive.slice(0, 7), { label: "Inne", value: positive.slice(7).reduce((s, p) => s + p.value, 0) }];
}

// Slices from 12 o'clock, clockwise, in the fixed colour order; a legend once there are two or more.
function drawPie(svg: Element, points: ChartPoint[]): void {
  const slices = foldSlices(points);
  const total = slices.reduce((s, p) => s + p.value, 0);
  const legend = slices.length >= 2;
  const cx = legend ? 150 : W / 2;
  const cy = 118;
  const r = 88;
  let angle = -Math.PI / 2;
  slices.forEach((p, i) => {
    const share = p.value / total;
    const next = angle + 2 * Math.PI * share;
    const style = `fill: var(--chart-${i + 1})`;
    const tip = `${p.label}: ${fmt(p.value)} (${pctText(p.value, total)})`;
    const g = node(svg, "g", { class: "chart-item", "data-tip": tip });
    node(g, "title", {}, tip);
    if (slices.length === 1) node(g, "circle", { class: "chart-slice", cx, cy, r, style });
    else {
      const [x0, y0] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
      const [x1, y1] = [cx + r * Math.cos(next), cy + r * Math.sin(next)];
      node(g, "path", { class: "chart-slice", d: `M${cx} ${cy}L${x0} ${y0}A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x1} ${y1}Z`, style });
      if (slices.length <= 4 && share >= 0.08) {
        const mid = angle + Math.PI * share;
        const d = r * 0.62;
        node(svg, "text", { class: "chart-slice-label", x: cx + d * Math.cos(mid), y: cy + d * Math.sin(mid), "text-anchor": "middle", "dominant-baseline": "central" }, pctText(p.value, total));
      }
    }
    angle = next;
  });
  if (legend) {
    slices.forEach((p, i) => {
      const y = 52 + i * 18;
      node(svg, "rect", { x: 300, y: y - 9, width: 10, height: 10, rx: 2, style: `fill: var(--chart-${i + 1})` });
      // the share right after the label, so a short legend stays together and a long label cannot run into it
      const label = node(svg, "text", { class: "chart-legend-label", x: 318, y }, p.label.length > 36 ? `${p.label.slice(0, 35)}…` : p.label);
      node(label, "tspan", { class: "chart-legend-share", dx: 8 }, pctText(p.value, total));
    });
  }
}

const shownPoints = (chart: Chart): ChartPoint[] => (chart.type === "pie" ? chart.points.filter((p) => p.value > 0) : chart.points);

// The summary a screen reader gets, e.g. "Wykres słupkowy: Sprzedaż 2026, 3 wartości, najwyższa Luty 30,5".
function summary(chart: Chart): string {
  const head = `${chart.type === "pie" ? "Wykres kołowy" : "Wykres słupkowy"}${chart.title ? `: ${chart.title}` : ""}`;
  const shown = shownPoints(chart);
  if (shown.length === 0) return `${head}, brak danych`;
  const top = shown.reduce((a, b) => (b.value > a.value ? b : a));
  const total = shown.reduce((s, p) => s + p.value, 0);
  const tail = chart.type === "pie" ? `największa ${top.label} ${pctText(top.value, total)}` : `najwyższa ${top.label} ${fmt(top.value)}`;
  return `${head}, ${shown.length} ${shown.length === 1 ? "wartość" : "wartości"}, ${tail}`;
}

// The HTML tooltip near the pointer; the <title> children stay as the plain fallback.
function hoverTips(svg: SVGSVGElement): void {
  let tip: HTMLElement | null = null;
  const hide = () => {
    tip?.remove();
    tip = null;
  };
  svg.addEventListener("pointermove", (e) => {
    const host = svg.parentElement;
    const label = e.target instanceof Element ? e.target.closest(".chart-item")?.getAttribute("data-tip") : null;
    if (!label || !host) return hide();
    tip ??= document.createElement("div");
    tip.className = "chart-tip";
    tip.textContent = label;
    const box = host.getBoundingClientRect();
    tip.style.left = `${e.clientX - box.left + 12}px`;
    tip.style.top = `${e.clientY - box.top + 12}px`;
    if (!tip.isConnected) host.append(tip);
  });
  svg.addEventListener("pointerleave", hide);
}

/** The chart as SVG. Bars are 240 units high, a pie 220; CSS scales the whole thing to the note's width. An error replaces the data. */
export function chartSvg(chart: Chart, error: string | null = null): SVGSVGElement {
  const pie = chart.type === "pie";
  const H = pie ? 220 : 240;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", error ?? summary(chart));
  if (chart.title) node(svg, "text", { class: "chart-title", x: 12, y: 22 }, chart.title);
  const shown = shownPoints(chart);
  if (error) node(svg, "text", { class: "chart-empty", x: W / 2, y: H / 2, "text-anchor": "middle" }, error);
  else if (shown.length === 0) node(svg, "text", { class: "chart-empty", x: W / 2, y: H / 2, "text-anchor": "middle" }, "Brak danych — kliknij, aby dodać wartości");
  else if (pie) drawPie(svg, shown);
  else drawBars(svg, shown);
  hoverTips(svg);
  return svg;
}

/** The chart in a box of its own: the box is the tooltip's positioning context. */
export function chartBox(chart: Chart, error: string | null = null): HTMLElement {
  const box = document.createElement("div");
  box.className = "chart-box";
  box.append(chartSvg(chart, error));
  return box;
}

/**
 * Reading view: each chart block (`pre > code.language-wykres`) becomes its chart, read from the note `note` (the i-th
 * element is the i-th `wykres` block of the note). Read-only, so no dialog opens.
 */
export function paintReadingCharts(root: HTMLElement, note: string): void {
  const blocks = chartFences(note);
  root.querySelectorAll("pre > code.language-wykres").forEach((code, i) => {
    const block = blocks[i];
    if (!block) return;
    const { chart, error } = resolveChart(note, block.from, block.to);
    code.parentElement?.replaceWith(chartBox(chart, error));
  });
}
