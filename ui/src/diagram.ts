//! Diagrams in notes: a fenced block with the info string `schemat` (alias `diagram`) keeps the diagram as plain text:
//! `kierunek:` and `tytuł:` lines, one line per box (`[id] Etykieta | kolor | kol,wiersz`) and one per connection
//! (`a -> b : etykieta`). This file reads that text, places the boxes on a grid and draws the diagram as SVG; the
//! editor and the reading view both call it. Parsing, layout and routing are plain functions, tested without a DOM.

export type DiagramDirection = "right" | "down";
export type DiagramColor = "szary" | "niebieski" | "zielony" | "żółty" | "czerwony" | "fioletowy" | "różowy" | "pomarańczowy";
export type DiagramOp = "->" | "<-" | "<->" | "--" | "..>" | "..";
export interface DiagramPos { col: number; row: number }
/** `pos` is null for a box the layout places; a box with a position keeps its cell. */
export interface DiagramBox { id: string; label: string; color: DiagramColor; pos: DiagramPos | null }
export interface DiagramEdge { from: string; to: string; op: DiagramOp; label: string }
export interface Diagram { direction: DiagramDirection; title: string; boxes: DiagramBox[]; edges: DiagramEdge[]; skipped: number }
export interface Point { x: number; y: number }
/** A column's or a row's band: where it starts and how wide (or high) it is, in pixels. */
export interface Band { at: number; size: number }
export interface PlacedBox { box: DiagramBox; col: number; row: number; x: number; y: number; w: number; h: number; lines: string[] }
/** `points` are the connection's ends on the boxes' edges; `d` is the drawn path, shortened where an arrow sits. */
export interface PlacedEdge { edge: DiagramEdge; points: Point[]; d: string; label: Point; arrowStart: boolean; arrowEnd: boolean; dashed: boolean }
export interface DiagramLayout { width: number; height: number; boxes: PlacedBox[]; edges: PlacedEdge[]; cols: Band[]; rows: Band[] }

export const MAX_BOXES = 60;
export const MAX_EDGES = 120;
const MAX_CELL = 99;
const CHAR_W = 7.4; // px per character at 13 px
const PAD = 16;
const GAP_X = 64;
const GAP_Y = 32;
const MIN_W = 112;
const MAX_W = 208;
const TEXT_PAD = 32;
const ARROW = 9;
const SPREAD = 10; // px between connections that leave the same side of a box
const LOOP_H = 30; // how high a connection loops above its own box
const CLEAR = 6; // a route keeps this far from the boxes it does not join
const DETOUR_GAP = 20; // a detour's channel lies this far below (or right of) the boxes it passes
const CHANNEL_STEP = 12; // between two detours in one channel

const COLORS: Record<string, DiagramColor> = {
  szary: "szary", niebieski: "niebieski", zielony: "zielony", "żółty": "żółty", zolty: "żółty", czerwony: "czerwony",
  fioletowy: "fioletowy", "różowy": "różowy", rozowy: "różowy", "pomarańczowy": "pomarańczowy", pomaranczowy: "pomarańczowy",
};
const DIRECTIONS: Record<string, DiagramDirection> = { prawo: "right", poziomo: "right", right: "right", dół: "down", dol: "down", pionowo: "down", down: "down" };
const META = new Map<string, "direction" | "title">([["kierunek", "direction"], ["tytuł", "title"], ["tytul", "title"], ["title", "title"]]);
const ID = /^[\p{L}\p{N}_-]+$/u;
const BOX = /^\[([^\]]*)\]\s*(.*)$/;
const EDGE = /^([\p{L}\p{N}_-]+)\s*(<->|\.\.>|->|<-|--|\.\.)\s*([\p{L}\p{N}_-]+)\s*(?::(.*))?$/u;
const POS = /^(\d+)\s*,\s*(\d+)$/;
const OPS: Record<DiagramOp, { start: boolean; end: boolean; dashed: boolean }> = {
  "->": { start: false, end: true, dashed: false },
  "<-": { start: true, end: false, dashed: false },
  "<->": { start: true, end: true, dashed: false },
  "--": { start: false, end: false, dashed: false },
  "..>": { start: false, end: true, dashed: true },
  "..": { start: false, end: false, dashed: true },
};

export const SAMPLE_DIAGRAM: Diagram = {
  direction: "right",
  title: "",
  boxes: [
    { id: "a", label: "Pomysł", color: "niebieski", pos: null },
    { id: "b", label: "Projekt", color: "żółty", pos: null },
    { id: "c", label: "Gotowe", color: "zielony", pos: null },
  ],
  edges: [{ from: "a", to: "b", op: "->", label: "" }, { from: "b", to: "c", op: "->", label: "" }],
  skipped: 0,
};

/** Reads a diagram's text. A line that is not a meta line, box or connection is counted in `skipped`. */
export function parseDiagram(source: string): Diagram {
  const d: Diagram = { direction: "right", title: "", boxes: [], edges: [], skipped: 0 };
  const seen = new Set<string>();
  let started = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const meta = /^([^:]+):(.*)$/.exec(line);
    const key = META.get(meta?.[1].trim().toLowerCase() ?? "");
    // meta lines count only before the first box or connection, so a label that looks like one still reads as a label
    if (meta && key && !seen.has(key) && !started) {
      seen.add(key);
      const value = meta[2].trim();
      if (key === "direction") d.direction = DIRECTIONS[value.toLowerCase()] ?? "right";
      else d.title = value;
      continue;
    }
    const box = BOX.exec(line);
    if (box) {
      const id = box[1].trim();
      const at = d.boxes.findIndex((b) => b.id === id);
      if (!ID.test(id) || (at < 0 && d.boxes.length >= MAX_BOXES)) {
        d.skipped++;
        continue;
      }
      started = true;
      const parts = box[2].split("|").map((s) => s.trim());
      let color: DiagramColor = "szary";
      let pos: DiagramPos | null = null;
      for (const option of parts.slice(1)) {
        const p = POS.exec(option);
        const col = Number(p?.[1]);
        const row = Number(p?.[2]);
        if (p && col >= 1 && col <= MAX_CELL && row >= 1 && row <= MAX_CELL) pos = { col, row };
        else color = COLORS[option.toLowerCase()] ?? color; // an unknown colour is the default one
      }
      const next: DiagramBox = { id, label: parts[0] || id, color, pos };
      if (at >= 0) d.boxes[at] = next; // a later line with the same id wins
      else d.boxes.push(next);
      continue;
    }
    const edge = EDGE.exec(line);
    if (edge) {
      const ends = [edge[1], edge[3]].filter((id, i, all) => all.indexOf(id) === i && !d.boxes.some((b) => b.id === id));
      if (d.edges.length >= MAX_EDGES || d.boxes.length + ends.length > MAX_BOXES) {
        d.skipped++;
        continue;
      }
      // an id that is not a box yet makes one, labelled with its id
      for (const id of ends) d.boxes.push({ id, label: id, color: "szary", pos: null });
      started = true;
      d.edges.push({ from: edge[1], to: edge[3], op: edge[2] as DiagramOp, label: (edge[4] ?? "").trim() });
      continue;
    }
    d.skipped++;
  }
  return d;
}

/** The diagram's canonical text: meta lines first (kierunek only when down), then boxes, then connections. */
export function diagramSource(d: Diagram): string {
  const lines: string[] = [];
  if (d.direction === "down") lines.push("kierunek: dół");
  if (d.title) lines.push(`tytuł: ${d.title}`);
  for (const b of d.boxes) {
    lines.push([`[${b.id}] ${b.label || b.id}`, ...(b.color !== "szary" ? [b.color] : []), ...(b.pos ? [`${b.pos.col},${b.pos.row}`] : [])].join(" | "));
  }
  for (const e of d.edges) lines.push(`${e.from} ${e.op} ${e.to}${e.label ? ` : ${e.label}` : ""}`);
  return lines.join("\n");
}

/** The whole fenced block that holds the diagram. */
export const diagramBlock = (d: Diagram): string => "```schemat\n" + diagramSource(d) + "\n```";

/** The fence info strings that mark a diagram block. */
export const isDiagramInfo = (info: string): boolean => ["schemat", "diagram"].includes(info.trim().toLowerCase());

/** The text between a block's fences; an unclosed block has no closing fence. */
export function diagramBody(block: string): string {
  const lines = block.split("\n");
  const closed = lines.length > 1 && /^ {0,3}(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]);
  return lines.slice(1, closed ? -1 : undefined).join("\n");
}

/** The diagram of a whole block's text (fences included). */
export const diagramOf = (block: string): Diagram => parseDiagram(diagramBody(block));

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Offsets of the diagram blocks of a note, in order: the reading view pairs them with its code elements. */
export function diagramFences(note: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let open: { marker: string; from: number; info: string } | null = null;
  let at = 0;
  for (const line of note.split("\n")) {
    const start = at;
    at += line.length + 1;
    if (open) {
      const close = CLOSE.exec(line);
      if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
        if (isDiagramInfo(open.info)) out.push({ from: open.from, to: start + line.length });
        open = null;
      }
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) open = { marker: fence[1], from: start, info: line.trim().slice(fence[1].length).trim() };
  }
  if (open && isDiagramInfo(open.info)) out.push({ from: open.from, to: note.length });
  return out;
}

/** Wraps a label to at most two lines of `perLine` characters; a longer rest ends in an ellipsis. */
function wrapLabel(label: string, perLine: number): string[] {
  const words = label.split(/\s+/).flatMap((w) => Array.from({ length: Math.ceil(w.length / perLine) }, (_, i) => w.slice(i * perLine, (i + 1) * perLine)));
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= perLine) cur = next;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  lines.push(cur);
  if (lines.length <= 2) return lines;
  return [lines[0], `${lines.slice(1).join(" ").slice(0, perLine - 1)}…`];
}

/** Layers by the longest path from the sources, without the edges that close a cycle (found by a DFS in entry order). */
function layerOf(d: Diagram): { layer: number[]; back: boolean[] } {
  const n = d.boxes.length;
  const idx = new Map(d.boxes.map((b, i) => [b.id, i]));
  const out: number[][] = d.boxes.map(() => []);
  d.edges.forEach((e, k) => out[idx.get(e.from)!].push(k));
  const state = new Array<number>(n).fill(0); // 0 unseen, 1 on the stack, 2 done
  const back = new Array<boolean>(d.edges.length).fill(false);
  const post: number[] = [];
  const visit = (v: number): void => {
    state[v] = 1;
    for (const k of out[v]) {
      const w = idx.get(d.edges[k].to)!;
      if (state[w] === 1) back[k] = true;
      else if (state[w] === 0) visit(w);
    }
    state[v] = 2;
    post.push(v);
  };
  for (let v = 0; v < n; v++) if (state[v] === 0) visit(v);
  const layer = new Array<number>(n).fill(0);
  for (const v of post.reverse()) {
    for (const k of out[v]) {
      if (back[k]) continue;
      const w = idx.get(d.edges[k].to)!;
      layer[w] = Math.max(layer[w], layer[v] + 1);
    }
  }
  return { layer, back };
}

/** The cell of each box, 1-based: explicit cells first, then the layout's cell, else the nearest free cell. */
function placeBoxes(d: Diagram): { col: number; row: number }[] {
  const n = d.boxes.length;
  const { layer, back } = layerOf(d);
  const idx = new Map(d.boxes.map((b, i) => [b.id, i]));
  const levels = Math.max(0, ...layer) + 1;
  const lists: number[][] = Array.from({ length: levels }, () => []);
  d.boxes.forEach((_, v) => lists[layer[v]].push(v));
  const neighbours: number[][] = d.boxes.map(() => []);
  d.edges.forEach((e, k) => {
    if (back[k]) return;
    const a = idx.get(e.from)!;
    const b = idx.get(e.to)!;
    neighbours[a].push(b);
    neighbours[b].push(a);
  });
  // one barycentric pass per layer: a box goes next to the average place of its neighbours in the layer before
  const pos = new Array<number>(n).fill(0);
  lists.forEach((list) => list.forEach((v, i) => (pos[v] = i)));
  for (let L = 1; L < levels; L++) {
    const key = (v: number): number => {
      const above = neighbours[v].filter((u) => layer[u] === L - 1);
      return above.length ? above.reduce((s, u) => s + pos[u], 0) / above.length : pos[v];
    };
    const keys = new Map(lists[L].map((v) => [v, key(v)]));
    lists[L].sort((a, b) => keys.get(a)! - keys.get(b)! || pos[a] - pos[b]);
    lists[L].forEach((v, i) => (pos[v] = i));
  }
  const right = d.direction === "right";
  const auto = d.boxes.map((_, v) => (right ? { col: layer[v] + 1, row: pos[v] + 1 } : { col: pos[v] + 1, row: layer[v] + 1 }));

  const taken = new Map<string, number>();
  const cells: ({ col: number; row: number } | undefined)[] = new Array(n);
  const put = (v: number, c: { col: number; row: number }): void => {
    cells[v] = c;
    taken.set(`${c.col},${c.row}`, v);
  };
  // the free cell nearest to `want` (Manhattan distance, then reading order)
  const free = (want: { col: number; row: number }): { col: number; row: number } => {
    const used = [...cells, ...auto].filter((c): c is { col: number; row: number } => c !== undefined);
    const maxC = Math.min(MAX_CELL, Math.max(want.col, ...used.map((c) => c.col)) + n);
    const maxR = Math.min(MAX_CELL, Math.max(want.row, ...used.map((c) => c.row)) + n);
    let best = { col: 1, row: 1 };
    let bestDist = Infinity;
    for (let row = 1; row <= maxR; row++) {
      for (let col = 1; col <= maxC; col++) {
        if (taken.has(`${col},${row}`)) continue;
        const dist = Math.abs(col - want.col) + Math.abs(row - want.row);
        if (dist < bestDist) {
          best = { col, row };
          bestDist = dist;
        }
      }
    }
    return best;
  };
  d.boxes.forEach((b, v) => {
    if (b.pos) put(v, taken.has(`${b.pos.col},${b.pos.row}`) ? free(b.pos) : { ...b.pos });
  });
  d.boxes.forEach((_, v) => {
    if (!d.boxes[v].pos) put(v, taken.has(`${auto[v].col},${auto[v].row}`) ? free(auto[v]) : auto[v]);
  });
  return cells as { col: number; row: number }[];
}

const along = (from: Point, to: Point, dist: number): Point => {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len === 0) return { ...from };
  const t = Math.min(dist, len / 2) / len;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
};

/** A polyline with a rounded corner (r up to 8) at each bend. */
function pathOf(pts: Point[]): string {
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, p, b] = [pts[i - 1], pts[i], pts[i + 1]];
    const r = Math.min(8, Math.hypot(p.x - a.x, p.y - a.y) / 2, Math.hypot(b.x - p.x, b.y - p.y) / 2);
    if (r < 0.5) d += ` L${p.x} ${p.y}`;
    else {
      const p1 = along(p, a, r);
      const p2 = along(p, b, r);
      d += ` L${p1.x} ${p1.y} Q${p.x} ${p.y} ${p2.x} ${p2.y}`;
    }
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

/** The point halfway along a polyline, by length. */
function midpoint(pts: Point[]): Point {
  const total = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (left <= seg && seg > 0) return along(pts[i - 1], pts[i], left);
    left -= seg;
  }
  return pts[0];
}

/** The side of a box a connection leaves from, and where along it: `off` moves it across the side. */
type Side = "r" | "l" | "t" | "b";
const OPPOSITE: Record<Side, Side> = { r: "l", l: "r", t: "b", b: "t" };

function sidePoint(p: PlacedBox, side: Side, off: number): Point {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const lim = (half: number) => Math.max(-half, Math.min(half, off)); // stays on the side, clear of its corners
  if (side === "r") return { x: p.x + p.w, y: cy + lim(p.h / 2 - 8) };
  if (side === "l") return { x: p.x, y: cy + lim(p.h / 2 - 8) };
  if (side === "t") return { x: cx + lim(p.w / 2 - 8), y: p.y };
  return { x: cx + lim(p.w / 2 - 8), y: p.y + p.h };
}

interface Plan { a: PlacedBox; b: PlacedBox; loop: boolean; sa: Side; sb: Side }

/** Whether a segment of `route` comes within CLEAR of a box that is not in `skip`. */
function crosses(route: Point[], boxes: PlacedBox[], skip: PlacedBox[]): boolean {
  return route.slice(1).some((q, i) => {
    const p = route[i];
    const x0 = Math.min(p.x, q.x);
    const x1 = Math.max(p.x, q.x);
    const y0 = Math.min(p.y, q.y);
    const y1 = Math.max(p.y, q.y);
    return boxes.some((b) => !skip.includes(b) && x1 > b.x - CLEAR && x0 < b.x + b.w + CLEAR && y1 > b.y - CLEAR && y0 < b.y + b.h + CLEAR);
  });
}

/** Straight when the two boxes line up across the sides, else right-angle bends through the middle. */
function ordinary(a: PlacedBox, b: PlacedBox, sa: Side, sb: Side, offA: number, offB: number): Point[] {
  const pa = sidePoint(a, sa, offA);
  const pb = sidePoint(b, sb, offB);
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (sa === "r" || sa === "l") {
    if (Math.abs(ca.y - cb.y) <= 2) return [pa, { x: pb.x, y: pa.y }];
    const xm = (pa.x + pb.x) / 2;
    return [pa, { x: xm, y: pa.y }, { x: xm, y: pb.y }, pb];
  }
  if (Math.abs(ca.x - cb.x) <= 2) return [pa, { x: pa.x, y: pb.y }];
  const ym = (pa.y + pb.y) / 2;
  return [pa, { x: pa.x, y: ym }, { x: pb.x, y: ym }, pb];
}

/** A route around the boxes: out of the bottom (direction right) or the right (down), along the channel, into the same side of the target. */
function around(a: PlacedBox, b: PlacedBox, right: boolean, offA: number, offB: number, channel: number): Point[] {
  if (right) {
    const pa = sidePoint(a, "b", offA);
    const pb = sidePoint(b, "b", offB);
    return [pa, { x: pa.x, y: channel }, { x: pb.x, y: channel }, pb];
  }
  const pa = sidePoint(a, "r", offA);
  const pb = sidePoint(b, "r", offB);
  return [pa, { x: channel, y: pa.y }, { x: channel, y: pb.y }, pb];
}

/** The offset of connection `k` among those that leave the same side of a box, SPREAD px apart around its middle. */
function offsetOf(slots: Map<string, number[]>, id: string, side: Side, k: number): number {
  const list = slots.get(`${id}|${side}`) ?? [k];
  return (list.indexOf(k) - (list.length - 1) / 2) * SPREAD;
}

function routeEdges(d: Diagram, boxes: PlacedBox[]): PlacedEdge[] {
  const byId = new Map(boxes.map((p) => [p.box.id, p]));
  const right = d.direction === "right";
  const plans: Plan[] = d.edges.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    if (a === b) return { a, b, loop: true, sa: "t", sb: "t" };
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    const sa: Side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "r" : "l") : dy >= 0 ? "b" : "t";
    return { a, b, loop: false, sa, sb: OPPOSITE[sa] };
  });
  const spread = (): Map<string, number[]> => {
    const slots = new Map<string, number[]>();
    plans.forEach((p, k) => {
      if (p.loop) return;
      for (const key of [`${p.a.box.id}|${p.sa}`, `${p.b.box.id}|${p.sb}`]) slots.set(key, [...(slots.get(key) ?? []), k]);
    });
    return slots;
  };
  let slots = spread();
  // a connection whose route runs through another box goes around it, in a channel below (or right of) the boxes between its ends
  const channels = new Map<number, number>();
  const used = new Map<number, number>(); // channel base -> routes already in it
  plans.forEach((p, k) => {
    if (p.loop) return;
    const ordinaryRoute = ordinary(p.a, p.b, p.sa, p.sb, offsetOf(slots, p.a.box.id, p.sa, k), offsetOf(slots, p.b.box.id, p.sb, k));
    if (!crosses(ordinaryRoute, boxes, [p.a, p.b])) return;
    const lo = right ? Math.min(p.a.col, p.b.col) : Math.min(p.a.row, p.b.row);
    const hi = right ? Math.max(p.a.col, p.b.col) : Math.max(p.a.row, p.b.row);
    const between = boxes.filter((q) => (right ? q.col : q.row) >= lo && (right ? q.col : q.row) <= hi);
    const base = right ? Math.max(...between.map((q) => q.y + q.h)) + DETOUR_GAP : Math.max(...between.map((q) => q.x + q.w)) + DETOUR_GAP;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    channels.set(k, base + n * CHANNEL_STEP);
    p.sa = right ? "b" : "r";
    p.sb = p.sa;
  });
  slots = spread();
  return d.edges.map((edge, k) => {
    const p = plans[k];
    const op = OPS[edge.op];
    if (p.loop) {
      // a loop: a cubic arc over the box's top edge, its ends 28 px apart
      const cx = p.a.x + p.a.w / 2;
      const topY = p.a.y;
      const start = { x: cx - 14, y: op.start ? topY - ARROW : topY };
      const end = { x: cx + 14, y: op.end ? topY - ARROW : topY };
      const path = `M${start.x} ${start.y} C${cx - 14} ${topY - LOOP_H} ${cx + 14} ${topY - LOOP_H} ${end.x} ${end.y}`;
      return { edge, points: [{ x: cx - 14, y: topY }, { x: cx + 14, y: topY }], d: path, label: { x: cx, y: topY - LOOP_H * 0.75 }, arrowStart: op.start, arrowEnd: op.end, dashed: op.dashed };
    }
    const offA = offsetOf(slots, p.a.box.id, p.sa, k);
    const offB = offsetOf(slots, p.b.box.id, p.sb, k);
    const channel = channels.get(k);
    const pts = channel === undefined ? ordinary(p.a, p.b, p.sa, p.sb, offA, offB) : around(p.a, p.b, right, offA, offB, channel);
    // the drawn path stops one arrow short of the box, so the head sits exactly on the edge
    const drawn = pts.map((q) => ({ ...q }));
    if (op.end) drawn[drawn.length - 1] = along(drawn[drawn.length - 1], drawn[drawn.length - 2], ARROW);
    if (op.start) drawn[0] = along(drawn[0], drawn[1], ARROW);
    const label = channel === undefined ? midpoint(pts) : right ? { x: (pts[0].x + pts[3].x) / 2, y: channel } : { x: channel, y: (pts[0].y + pts[3].y) / 2 };
    return { edge, points: pts, d: pathOf(drawn), label, arrowStart: op.start, arrowEnd: op.end, dashed: op.dashed };
  });
}

/**
 * The diagram's boxes and connections in pixels, from the top-left corner. Boxes take the width of their label (two lines
 * at most); a column is as wide as its widest box, a row as high as its tallest. Connections run straight when their
 * boxes line up, else in right-angle bends through the middle, between the boxes' sides.
 */
export function layoutDiagram(d: Diagram): DiagramLayout {
  if (d.boxes.length === 0) return { width: 0, height: 0, boxes: [], edges: [], cols: [], rows: [] };
  const cells = placeBoxes(d);
  const placed: PlacedBox[] = d.boxes.map((box, v) => {
    const label = box.label || box.id;
    const w = Math.max(MIN_W, Math.min(MAX_W, label.length * CHAR_W + TEXT_PAD));
    const lines = wrapLabel(label, Math.max(1, Math.floor((w - TEXT_PAD) / CHAR_W)));
    return { box: { ...box, label }, col: cells[v].col, row: cells[v].row, x: 0, y: 0, w, h: lines.length > 1 ? 62 : 44, lines };
  });
  const nc = Math.max(...placed.map((p) => p.col));
  const nr = Math.max(...placed.map((p) => p.row));
  const colW = new Array<number>(nc).fill(0);
  const rowH = new Array<number>(nr).fill(0);
  for (const p of placed) {
    colW[p.col - 1] = Math.max(colW[p.col - 1], p.w);
    rowH[p.row - 1] = Math.max(rowH[p.row - 1], p.h);
  }
  const cols: Band[] = [];
  const rows: Band[] = [];
  let x = PAD;
  for (let c = 0; c < nc; c++) {
    cols.push({ at: x, size: colW[c] });
    x += colW[c] + GAP_X;
  }
  // room above the first row for the arcs of self-loops
  let y = PAD + (d.edges.some((e) => e.from === e.to) ? LOOP_H : 0);
  for (let r = 0; r < nr; r++) {
    rows.push({ at: y, size: rowH[r] });
    y += rowH[r] + GAP_Y;
  }
  for (const p of placed) {
    p.x = cols[p.col - 1].at + (colW[p.col - 1] - p.w) / 2;
    p.y = rows[p.row - 1].at + (rowH[p.row - 1] - p.h) / 2;
  }
  const edges = routeEdges(d, placed);
  // the drawing grows to hold the channels of the detours
  const reach = edges.flatMap((e) => e.points);
  return {
    width: Math.max(x - GAP_X + PAD, ...reach.map((q) => q.x + PAD)),
    height: Math.max(y - GAP_Y + PAD, ...reach.map((q) => q.y + PAD)),
    boxes: placed,
    edges,
    cols,
    rows,
  };
}

/** The cell (1-based) nearest to a point, where a new column or row just past the drawing counts as a cell too. */
export function cellAt(lay: DiagramLayout, x: number, y: number): DiagramPos {
  const nearest = (bands: Band[], at: number, gap: number, half: number): number => {
    const centers = bands.map((b) => b.at + b.size / 2);
    const last = bands[bands.length - 1];
    centers.push(last.at + last.size + gap + half); // the band after the last one, as wide as a typical box
    let best = 0;
    centers.forEach((c, i) => {
      if (Math.abs(c - at) < Math.abs(centers[best] - at)) best = i;
    });
    return best + 1;
  };
  return {
    col: Math.min(MAX_CELL, nearest(lay.cols, x, GAP_X, MIN_W / 2)),
    row: Math.min(MAX_CELL, nearest(lay.rows, y, GAP_Y, 22)),
  };
}

const TITLE_H = 32;

function node(parent: Element, name: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

let markerSeq = 0;

/** The diagram as SVG. An empty diagram shows a hint; its arrow heads share one marker, with an id of its own. */
export function diagramSvg(d: Diagram): SVGSVGElement {
  const empty = d.boxes.length === 0;
  const lay = layoutDiagram(d);
  const titleH = d.title ? TITLE_H : 0;
  const width = empty ? 320 : lay.width;
  const height = titleH + (empty ? 120 : lay.height);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "dg-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", summary(d));
  svg.style.maxWidth = `${width}px`;
  if (d.title) node(svg, "text", { class: "dg-title", x: 16, y: 22 }, d.title);
  if (empty) {
    node(svg, "text", { class: "dg-empty", x: width / 2, y: titleH + 60, "text-anchor": "middle" }, "Pusty schemat. Kliknij, żeby dodać prostokąty.");
    return svg;
  }
  const head = `dg-arrow-${++markerSeq}`;
  const defs = node(svg, "defs");
  const marker = node(defs, "marker", { id: head, markerWidth: 9, markerHeight: 9, refX: 0, refY: 4.5, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" });
  node(marker, "path", { class: "dg-head", d: "M0,0 L9,4.5 L0,9 L2.5,4.5 z" });
  const g = node(svg, "g", { transform: `translate(0 ${titleH})` });
  for (const e of lay.edges) {
    const attrs: Record<string, string | number> = { class: "dg-line", d: e.d };
    if (e.arrowStart) attrs["marker-start"] = `url(#${head})`;
    if (e.arrowEnd) attrs["marker-end"] = `url(#${head})`;
    if (e.dashed) attrs["stroke-dasharray"] = "5 4";
    node(g, "path", attrs);
  }
  for (const e of lay.edges) {
    if (!e.edge.label) continue;
    const w = e.edge.label.length * 6.4 + 12;
    node(g, "rect", { class: "dg-edge-bg", x: e.label.x - w / 2, y: e.label.y - 9, width: w, height: 18, rx: 4 });
    node(g, "text", { class: "dg-edge-label", x: e.label.x, y: e.label.y, "text-anchor": "middle", "dominant-baseline": "central" }, e.edge.label);
  }
  for (const p of lay.boxes) {
    const grp = node(g, "g", { class: "dg-node", "data-id": p.box.id });
    node(grp, "rect", { class: `dg-box dg-c-${p.box.color}`, x: p.x, y: p.y, width: p.w, height: p.h, rx: 8 });
    const cy = p.y + p.h / 2;
    p.lines.forEach((line, i) => node(grp, "text", { class: "dg-label", x: p.x + p.w / 2, y: cy + (i - (p.lines.length - 1) / 2) * 16, "text-anchor": "middle", "dominant-baseline": "central" }, line));
  }
  return svg;
}

/** The Polish form of a count: 1 (one), 2–4 but not 12–14 (few), everything else (many); 0 is many. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const units = n % 10;
  const tens = n % 100;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

function summary(d: Diagram): string {
  const boxes = `${d.boxes.length} ${plural(d.boxes.length, "prostokąt", "prostokąty", "prostokątów")}`;
  const edges = `${d.edges.length} ${plural(d.edges.length, "połączenie", "połączenia", "połączeń")}`;
  const counts = `${boxes}, ${edges}`;
  return d.title ? `Schemat: ${d.title}, ${counts}` : `Schemat: ${counts}`;
}

/** The diagram in a box of its own: the frame is the positioning context of the reading view and the editor. */
export function diagramBox(d: Diagram): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "dg-frame";
  frame.append(diagramSvg(d));
  return frame;
}

/** Reading view: each diagram block (`pre > code.language-schemat` or `language-diagram`) becomes its diagram. */
export function paintReadingDiagrams(root: HTMLElement, note: string): void {
  const blocks = diagramFences(note);
  root.querySelectorAll("pre > code.language-schemat, pre > code.language-diagram").forEach((code, i) => {
    const block = blocks[i];
    if (!block) return;
    code.parentElement?.replaceWith(diagramBox(diagramOf(note.slice(block.from, block.to))));
  });
}
