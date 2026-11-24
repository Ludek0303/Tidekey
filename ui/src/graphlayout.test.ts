import { describe, expect, it } from "vitest";
import { GraphLayout, drawnRadius, type LayoutLink, type LayoutNode } from "./graphlayout";

const FORCES = { centerForce: 0.5, repelForce: 150, linkForce: 0.5, linkDistance: 80 };

// A ring of n notes, each linked to the next.
function ring(n: number): { nodes: LayoutNode[]; links: LayoutLink[] } {
  const nodes: LayoutNode[] = Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
  const links: LayoutLink[] = nodes.map((node, i) => ({ source: node.id, target: nodes[(i + 1) % n].id }));
  return { nodes, links };
}

function cooled(n: number): GraphLayout {
  const g = ring(n);
  const layout = new GraphLayout();
  layout.setData(g.nodes, g.links, FORCES);
  for (let guard = 0; guard < 10_000 && layout.step(50); guard++);
  return layout;
}

describe("graph layout", () => {
  it("cools down and stops moving", () => {
    expect(cooled(30).moving()).toBe(false);
  });

  it("a time slice always does at least one tick", () => {
    const g = ring(20);
    const layout = new GraphLayout();
    layout.setData(g.nodes, g.links, FORCES);
    expect(layout.step(0)).toBe(true);
  });

  it("large graphs cool with a faster decay", () => {
    const small = ring(10);
    const big = ring(2500);
    const a = new GraphLayout();
    const b = new GraphLayout();
    a.setData(small.nodes, small.links, FORCES);
    b.setData(big.nodes, big.links, FORCES);
    expect(a.sim.alphaDecay()).toBeCloseTo(0.0228);
    expect(b.sim.alphaDecay()).toBeCloseTo(0.035);
  });

  it("dragging moves a cooled node and wakes the layout", () => {
    const layout = cooled(30);
    expect(layout.moving()).toBe(false);
    const n = layout.nodes[0];
    layout.dragStart(n);
    expect(layout.moving()).toBe(true);
    layout.dragMove(n, 300, -120);
    expect(n.x).toBe(300);
    expect(n.y).toBe(-120);
    layout.step(10);
    // The pinned node stays where the pointer put it while the rest of the layout moves.
    expect(n.x).toBe(300);
    layout.dragEnd(n);
    expect(n.fx).toBeNull();
    expect(n.fy).toBeNull();
  });
});

// Sample graph for measurements: 8 clusters of 25 notes, 40 isolated notes, some links between clusters.
function sample(): { nodes: LayoutNode[]; links: LayoutLink[] } {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const nodes: LayoutNode[] = [];
  const links: LayoutLink[] = [];
  for (let c = 0; c < 8; c++) {
    const base = nodes.length;
    for (let i = 0; i < 25; i++) nodes.push({ id: `c${c}-${i}` });
    for (let i = 1; i < 25; i++) links.push({ source: nodes[base + i].id, target: nodes[base + Math.floor(rnd() * i)].id });
    for (let k = 0; k < 10; k++) links.push({ source: nodes[base + Math.floor(rnd() * 25)].id, target: nodes[base + Math.floor(rnd() * 25)].id });
  }
  for (let i = 0; i < 40; i++) nodes.push({ id: `iso-${i}` });
  for (let k = 0; k < 20; k++) links.push({ source: nodes[Math.floor(rnd() * 200)].id, target: nodes[Math.floor(rnd() * 200)].id });
  return { nodes, links };
}

// Same radius as graph.ts draws a node with (nodeSize 1).
const radius = drawnRadius;

function measure(ticks: number[]) {
  const g = sample();
  const layout = new GraphLayout();
  layout.setData(g.nodes, g.links, FORCES);
  const deg = new Map<string, number>();
  for (const l of g.links) for (const e of [l.source, l.target]) deg.set(e as string, (deg.get(e as string) ?? 0) + 1);
  const snap = () => g.nodes.map((n) => [n.x!, n.y!]);
  let prev = snap();
  const perTick: number[] = [];
  let maxSpeed = 0;
  for (let t = 1; t <= Math.max(...ticks); t++) {
    layout.sim.tick();
    const cur = snap();
    let sum = 0;
    cur.forEach(([x, y], i) => {
      const s = Math.hypot(x - prev[i][0], y - prev[i][1]);
      sum += s;
      if (t > 1) maxSpeed = Math.max(maxSpeed, s);
    });
    perTick.push(sum / g.nodes.length);
    prev = cur;
  }
  let overlaps = 0;
  for (let i = 0; i < g.nodes.length; i++)
    for (let j = i + 1; j < g.nodes.length; j++) {
      const r = radius(deg.get(g.nodes[i].id) ?? 0) + radius(deg.get(g.nodes[j].id) ?? 0);
      if (Math.hypot(g.nodes[i].x! - g.nodes[j].x!, g.nodes[i].y! - g.nodes[j].y!) < r) overlaps++;
    }
  const reach = Math.max(...g.nodes.map((n) => Math.hypot(n.x!, n.y!)));
  return {
    moveAt: Object.fromEntries(ticks.map((t) => [t, +perTick[t - 1].toFixed(3)])),
    maxSpeed: +maxSpeed.toFixed(2),
    overlaps,
    maxRadius: +reach.toFixed(0),
    moving: layout.moving(),
  };
}

describe("graph layout on a sample graph", () => {
  it("settles: movement per note falls below 0.05 within 300 ticks", () => {
    expect(measure([300]).moveAt[300]).toBeLessThan(0.05);
  });

  it("no two notes overlap after settling", () => {
    expect(measure([300]).overlaps).toBe(0);
  });

  it("stays within a bounded radius of the origin", () => {
    expect(measure([300]).maxRadius).toBeLessThan(700);
  });

  it("settle() brings the layout to rest at once", () => {
    const g = sample();
    const layout = new GraphLayout();
    layout.setData(g.nodes, g.links, FORCES);
    layout.settle();
    expect(layout.moving()).toBe(false);
  });
});
