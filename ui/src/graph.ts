import { buildView, type GraphModel, type GraphNode, type MapExtra } from "./graphdata";
import { LayoutClient, type SimNode } from "./graphclient";
import { drawnRadius, type LayoutForces } from "./graphlayout";
import { mountGraphPanel } from "./graphpanel";
import { getGraphSettings, onGraphSettings, type GraphSettings } from "./graphsettings";
import type { RawGraph } from "./noteindex";

export interface GraphOptions {
  data: () => RawGraph | null;
  // Files, people and mentions of the search index, or null while it is not loaded.
  extra?: () => MapExtra | null;
  active: () => string | null;
  open: (id: string, path: string) => void;
  openFile?: (fileId: string) => void;
  onEscape?: () => void;
}

interface Edge {
  source: SimNode;
  target: SimNode;
}

const MIN_K = 0.05;
const MAX_K = 8;
const DRAG_PX = 4;
// Labels fade in between this zoom and the next 0.25 above it, measured from the text fade setting.
const LABEL_SPAN = 0.25;
// Draws per second while the layout moves: about 30.
const DRAW_GAP_MS = 33;
// Labels drawn per frame at most, so a zoomed-out big graph costs the same as a small one.
const LABEL_CAP = 400;
// Share of the remaining distance the view covers per draw while it eases to fit the graph.
const FIT_EASE = 0.15;
const FIT_PAD = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
// Reduced motion: the layout is settled at once and the view jumps to fit, with no animation.
// one query object, read on each frame (matchMedia allocates a new one per call)
const motionQuery = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
const reducedMotion = (): boolean => motionQuery?.matches ?? false;
const isNote = (n: GraphNode): boolean => !n.ghost && !n.tag && !n.file && !n.person;
const forcesOf = (s: GraphSettings): LayoutForces => ({
  centerForce: s.centerForce,
  repelForce: s.repelForce,
  linkForce: s.linkForce,
  linkDistance: s.linkDistance,
});

// Colours and font come from the theme's CSS variables, read on each redraw so dark and light both work.
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return { text: v("--text"), muted: v("--muted"), accent: v("--accent"), font: v("--font-ui") };
}

interface Drag {
  node: SimNode | null;
  // Index of the node in the layout's list (the worker addresses nodes by it).
  i: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  moved: boolean;
}

// One graph on a canvas. The layout runs in a worker; this side only draws, and only while the view is shown.
export class GraphView {
  private readonly canvas = document.createElement("canvas");
  private readonly layout = new LayoutClient((moving) => {
    this.moving = moving;
    this.redraw();
  });
  private moving = false;
  // The view eases to fit the graph while it lays out, until the user pans or zooms.
  private fit = false;
  private nodes: SimNode[] = [];
  private edges: Edge[] = [];
  private byId = new Map<string, SimNode>();
  private raw: RawGraph | null = null;
  private extra: MapExtra | null = null;
  private settings: GraphSettings = getGraphSettings();
  private t = { x: 0, y: 0, k: 1 };
  private size = { w: 0, h: 0 };
  private hover: SimNode | null = null;
  private drag: Drag | null = null;
  private frameId = 0;
  private lastDraw = 0;
  // A hidden view does no work: no draws, and the worker is told to stop.
  private shown = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: GraphOptions,
  ) {
    host.append(this.canvas);
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Graf notatek");
    // shortcut: jsdom has no ResizeObserver; without it the view keeps the size of its first layout, which only tests hit.
    if ("ResizeObserver" in window) new ResizeObserver(() => this.resize()).observe(host);
    this.bindPointer();
    mountGraphPanel(host, () => this.reheat());
    onGraphSettings((s) => this.setSettings(s));
  }

  /** Starts (true) or stops (false) the layout and the drawing; the layout state is kept either way. */
  show(on: boolean): void {
    this.shown = on;
    this.layout.run(on);
    if (on) {
      this.redraw();
    } else if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
  }

  /** Rebuilds the view from the index (`reload`) or from the last copy, keeping the positions of nodes that stay. */
  refresh(reload = true): void {
    if (reload) {
      this.raw = this.opts.data() ?? this.raw;
      this.extra = this.opts.extra?.() ?? null;
    }
    if (!this.raw) return;
    this.setView(buildView(this.raw, this.settings, this.extra ?? undefined));
  }

  /** Puts keyboard focus on the canvas, so Esc reaches the view. */
  focus(): void {
    this.canvas.focus({ preventScroll: true });
  }

  /** Restarts the layout from a hot start ("Animuj"). */
  reheat(): void {
    this.layout.heat(1);
  }

  private setSettings(s: GraphSettings): void {
    const forces = (x: GraphSettings) => [x.centerForce, x.repelForce, x.linkForce, x.linkDistance].join();
    const moved = forces(s) !== forces(this.settings);
    this.settings = s;
    this.refresh(false);
    if (moved) this.layout.setForces(forcesOf(s), 0.5);
    else this.redraw();
  }

  private setView(view: GraphModel): void {
    const prev = this.byId;
    // Object.assign keeps the old position and copies every field, colour included (undefined clears it).
    const nodes = view.nodes.map((n) => Object.assign(prev.get(n.id) ?? {}, n) as SimNode);
    // A layout restart is needed only when the set of nodes or links changed, not on a display change.
    const changed = nodes.length !== prev.size || nodes.some((n) => !prev.has(n.id)) || view.links.length !== this.edges.length;
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.edges = view.links.map((l) => ({ source: this.byId.get(l.source)!, target: this.byId.get(l.target)! }));
    this.hover = (this.hover && this.byId.get(this.hover.id)) || null;
    this.layout.setData(
      nodes,
      this.edges.map((e) => [e.source.id, e.target.id]),
      forcesOf(this.settings),
      changed ? 0.6 : 0,
    );
    if (changed) this.fit = true;
    if (changed && reducedMotion()) this.layout.settle();
    this.redraw();
  }

  private redraw(): void {
    this.schedule();
  }

  private schedule(): void {
    if (!this.frameId && this.shown) this.frameId = requestAnimationFrame(() => this.frame());
  }

  // At most one draw per DRAW_GAP_MS: a moving layout asks for frames all the time, and drawing each one
  // would take the main thread from the editor. Frames that come too early are simply asked again.
  private frame(): void {
    this.frameId = 0;
    const now = performance.now();
    if (now - this.lastDraw < DRAW_GAP_MS) {
      this.schedule();
      return;
    }
    this.lastDraw = now;
    if (this.fit) this.fit = this.stepFit() || this.moving;
    this.draw();
    if (this.fit) this.schedule();
  }

  // Moves the view a step toward the box that holds every node, scaled down to fit (never zoomed in past 1).
  // Returns true while the view is still away from that box.
  private stepFit(): boolean {
    const { w, h } = this.size;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of this.nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    // No nodes: nothing to fit. No size or positions yet: keep waiting for the first layout.
    if (!this.nodes.length) return false;
    if (!w || !h || x0 > x1) return true;
    const k = clamp(Math.min((w - 2 * FIT_PAD) / Math.max(x1 - x0, 1), (h - 2 * FIT_PAD) / Math.max(y1 - y0, 1)), MIN_K, 1);
    const tx = w / 2 - ((x0 + x1) / 2) * k;
    const ty = h / 2 - ((y0 + y1) / 2) * k;
    const ease = reducedMotion() ? 1 : FIT_EASE;
    const t = this.t;
    const away = Math.abs(k - t.k) > 1e-3 || Math.abs(tx - t.x) > 0.5 || Math.abs(ty - t.y) > 0.5;
    t.k += (k - t.k) * ease;
    t.x += (tx - t.x) * ease;
    t.y += (ty - t.y) * ease;
    return away;
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // The origin starts in the middle of the view.
    if (!this.size.w && w) {
      this.t.x = w / 2;
      this.t.y = h / 2;
    }
    this.size = { w, h };
    this.redraw();
  }

  private radius(n: SimNode): number {
    return drawnRadius(n.degree) * this.settings.nodeSize;
  }

  private draw(): void {
    const { t, size, settings: s } = this;
    const ctx = this.canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const c = palette();
    const hov = this.hover;
    // Neighbours of the hovered node, found from the edges (no per-node sets are kept for a big graph).
    const near = new Set<SimNode>();
    if (hov) for (const e of this.edges) if (e.source === hov || e.target === hov) near.add(e.source === hov ? e.target : e.source);
    const lit = (n: SimNode) => !hov || n === hov || near.has(n);
    const active = this.opts.active();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);

    // Links: the ones touching the hovered node are drawn last, in accent colour.
    ctx.lineWidth = s.linkWidth;
    ctx.strokeStyle = c.muted;
    ctx.globalAlpha = hov ? 0.08 : 0.5;
    ctx.beginPath();
    const touching: Edge[] = [];
    for (const e of this.edges) {
      if (hov && (e.source === hov || e.target === hov)) {
        touching.push(e);
        continue;
      }
      ctx.moveTo(e.source.x!, e.source.y!);
      ctx.lineTo(e.target.x!, e.target.y!);
    }
    ctx.stroke();
    ctx.strokeStyle = c.accent;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (const e of touching) {
      ctx.moveTo(e.source.x!, e.source.y!);
      ctx.lineTo(e.target.x!, e.target.y!);
    }
    ctx.stroke();
    if (s.arrows) this.drawArrows(ctx, touching, c.accent);

    // Plain notes share one path (one fill for the whole batch); the rest are drawn one by one with their own style.
    const plain: SimNode[] = [];
    const styled: SimNode[] = [];
    for (const n of this.nodes) {
      const isPlain = lit(n) && !n.ghost && !n.tag && !n.file && !n.person && !n.color && n !== hov && n.id !== active;
      (isPlain ? plain : styled).push(n);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.muted;
    ctx.beginPath();
    for (const n of plain) {
      ctx.moveTo(n.x! + this.radius(n), n.y!);
      ctx.arc(n.x!, n.y!, this.radius(n), 0, Math.PI * 2);
    }
    ctx.fill();
    // Nodes: grey for unresolved links, accent for tags and the active or hovered note, the group colour when a group matches.
    for (const n of styled) {
      ctx.globalAlpha = lit(n) ? (n.ghost ? 0.5 : 1) : 0.15;
      ctx.fillStyle = n === hov || n.id === active ? c.accent : (n.color ?? (n.tag ? c.accent : c.muted));
      ctx.beginPath();
      this.outline(ctx, n);
      ctx.fill();
    }

    // Labels: the hovered note always, the others once the zoom passes the text fade threshold, on screen only.
    const fade = clamp((t.k - (s.textFade / 100) * 2) / LABEL_SPAN, 0, 1);
    // Divided by the zoom, so labels keep their screen size while the nodes move apart.
    ctx.font = `${12 / t.k}px ${c.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = c.text;
    let labels = 0;
    for (const n of this.nodes) {
      const isHover = n === hov;
      if (!isHover && fade <= 0) continue;
      const sx = n.x! * t.k + t.x;
      const sy = n.y! * t.k + t.y;
      if (!isHover && (sx < -50 || sy < -20 || sx > size.w + 50 || sy > size.h + 20)) continue;
      if (!isHover && ++labels > LABEL_CAP) continue;
      ctx.globalAlpha = isHover ? 1 : fade * (lit(n) ? 1 : 0.15);
      ctx.fillText(n.name, n.x!, n.y! + this.radius(n) + 3 / t.k);
    }
    ctx.globalAlpha = 1;
  }

  // The path of a node: a circle for notes, a square for files and a diamond for people.
  private outline(ctx: CanvasRenderingContext2D, n: SimNode): void {
    const r = this.radius(n);
    if (n.file) ctx.rect(n.x! - r, n.y! - r, 2 * r, 2 * r);
    else if (n.person) {
      const d = r * 1.3;
      ctx.moveTo(n.x!, n.y! - d);
      ctx.lineTo(n.x! + d, n.y!);
      ctx.lineTo(n.x!, n.y! + d);
      ctx.lineTo(n.x! - d, n.y!);
      ctx.closePath();
    } else ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
  }

  // Arrowheads point from the source note to the note it links to, at the target's rim.
  private drawArrows(ctx: CanvasRenderingContext2D, edges: Edge[], colour: string): void {
    ctx.fillStyle = colour;
    for (const { source: a, target: b } of edges) {
      const dx = b.x! - a.x!;
      const dy = b.y! - a.y!;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const ux = dx / len;
      const uy = dy / len;
      const tipX = b.x! - ux * this.radius(b);
      const tipY = b.y! - uy * this.radius(b);
      const size = 4 + this.settings.linkWidth;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5);
      ctx.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Nearest node within reach of the pointer (screen px), or null.
  private nodeAt(sx: number, sy: number): SimNode | null {
    const { x, y, k } = this.t;
    const wx = (sx - x) / k;
    const wy = (sy - y) / k;
    const pad = 4 / k;
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const dx = n.x! - wx;
      const dy = n.y! - wy;
      const d = dx * dx + dy * dy;
      const reach = this.radius(n) + pad;
      if (d <= reach * reach && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  private bindPointer(): void {
    const c = this.canvas;
    const local = (e: PointerEvent | WheelEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener("pointerdown", (e) => {
      const [sx, sy] = local(e);
      const node = this.nodeAt(sx, sy);
      c.setPointerCapture(e.pointerId);
      c.focus({ preventScroll: true });
      const i = node ? this.nodes.indexOf(node) : -1;
      this.drag = { node, i, sx: e.clientX, sy: e.clientY, tx: this.t.x, ty: this.t.y, moved: false };
      this.fit = false;
      if (node) this.layout.drag("start", i, node.x!, node.y!);
    });
    c.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) {
        const [sx, sy] = local(e);
        const hit = this.nodeAt(sx, sy);
        if (hit !== this.hover) {
          this.hover = hit;
          c.style.cursor = hit && (isNote(hit) || hit.file) ? "pointer" : "default";
          this.redraw();
        }
        return;
      }
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      d.moved = true;
      if (d.node) {
        const [sx, sy] = local(e);
        const x = (sx - this.t.x) / this.t.k;
        const y = (sy - this.t.y) / this.t.k;
        // Shown at once; the worker confirms the same position on its next slice.
        d.node.x = x;
        d.node.y = y;
        this.layout.drag("move", d.i, x, y);
      } else {
        this.t.x = d.tx + dx;
        this.t.y = d.ty + dy;
      }
      this.redraw();
    });
    const end = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.node) {
        this.layout.drag("end", d.i, 0, 0);
        // A press without movement is a click: open the note (ghosts and tags have nothing to open).
        if (!d.moved && isNote(d.node)) this.opts.open(d.node.id, d.node.path);
        else if (!d.moved && d.node.file) this.opts.openFile?.(d.node.id.slice(2));
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", () => {
      if (this.drag || !this.hover) return;
      this.hover = null;
      this.redraw();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const [sx, sy] = local(e);
        this.fit = false;
        const k = clamp(this.t.k * Math.exp(-e.deltaY * 0.0015), MIN_K, MAX_K);
        const f = k / this.t.k;
        // Zoom around the pointer: the world point under it stays under it.
        this.t.x = sx - (sx - this.t.x) * f;
        this.t.y = sy - (sy - this.t.y) * f;
        this.t.k = k;
        this.redraw();
      },
      { passive: false },
    );
    c.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.opts.onEscape?.();
    });
  }
}
