import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

// The layout knows only ids and positions; it runs in a worker (graphworker.ts), off the main thread.
export interface LayoutNode extends SimulationNodeDatum {
  id: string;
  // Set by setData from the links: the number of links and the collision radius (drawn size plus a gap).
  degree?: number;
  r?: number;
}
export type LayoutLink = SimulationLinkDatum<LayoutNode>;

export interface LayoutForces {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

// Above this many nodes the layout cools faster, so a big graph settles in fewer ticks.
const LARGE = 2000;
const DRAG_ALPHA = 0.3;
// Repulsion is approximated beyond this range and with a wider theta: fewer cells per node, shorter ticks.
const CHARGE_RANGE = 800;
const CHARGE_THETA = 1.3;
// Gap kept between nodes; the drawn radius matches graph.ts.
const NODE_GAP = 4;
export const drawnRadius = (deg: number): number => 2.5 + Math.sqrt(deg) * 1.5;

// The d3-force layout. The caller steps it in time slices, so a big graph never holds a thread for long.
export class GraphLayout {
  readonly sim: Simulation<LayoutNode, LayoutLink> = forceSimulation<LayoutNode>().stop();
  nodes: LayoutNode[] = [];
  links: LayoutLink[] = [];

  // Nodes keep the positions they already have; new ones start where d3 puts them.
  setData(nodes: LayoutNode[], links: LayoutLink[], forces: LayoutForces): void {
    const deg = new Map<string, number>();
    for (const l of links) {
      for (const end of [l.source, l.target]) {
        const id = String(typeof end === "object" ? end.id : end);
        deg.set(id, (deg.get(id) ?? 0) + 1);
      }
    }
    for (const n of nodes) {
      n.degree = deg.get(n.id) ?? 0;
      n.r = drawnRadius(n.degree) + NODE_GAP;
    }
    this.nodes = nodes;
    this.links = links;
    this.sim.nodes(nodes);
    this.sim.alphaDecay(nodes.length > LARGE ? 0.035 : 0.0228);
    // Each tick keeps 60% of the velocity (d3's default, set here on purpose): the layout glides without oscillating.
    this.sim.velocityDecay(0.4);
    this.setForces(forces);
  }

  setForces(f: LayoutForces): void {
    this.sim
      .force("charge", forceManyBody<LayoutNode>().strength(-f.repelForce).theta(CHARGE_THETA).distanceMin(10).distanceMax(CHARGE_RANGE))
      .force("x", forceX<LayoutNode>(0).strength(f.centerForce * 0.2))
      .force("y", forceY<LayoutNode>(0).strength(f.centerForce * 0.2))
      // Nodes never overlap: each pushes apart until their drawn radii plus the gap fit.
      .force("collide", forceCollide<LayoutNode>((n) => n.r ?? 0).iterations(2))
      .force(
        "link",
        forceLink<LayoutNode, LayoutLink>(this.links)
          .id((n) => n.id)
          // Hubs pull less per link, so a big hub does not pull its neighbours into a ball.
          .strength((l) => f.linkForce / Math.min((l.source as LayoutNode).degree ?? 1, (l.target as LayoutNode).degree ?? 1))
          // Rest length grows with the node sizes, so linked nodes sit apart instead of touching.
          .distance((l) => f.linkDistance + ((l.source as LayoutNode).r ?? 0) + ((l.target as LayoutNode).r ?? 0)),
      );
  }

  moving(): boolean {
    return this.sim.alpha() > this.sim.alphaMin();
  }

  heat(alpha: number): void {
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
  }

  // Ticks until the time slice is used up or the layout cools (at least one tick); true while it still moves.
  step(sliceMs: number): boolean {
    const end = performance.now() + sliceMs;
    while (this.moving()) {
      this.sim.tick();
      if (performance.now() >= end) break;
    }
    return this.moving();
  }

  // Runs the layout to rest at once, for reduced motion: the final positions without an animation.
  // shortcut: capped at 2000 ticks, so a huge graph still returns quickly; the rest settles in step().
  settle(): void {
    for (let i = 0; i < 2000 && this.moving(); i++) this.sim.tick();
  }

  // A dragged node is pinned under the pointer; the layout is kept warm while the drag lasts.
  dragStart(n: LayoutNode): void {
    n.fx = n.x;
    n.fy = n.y;
    this.sim.alphaTarget(DRAG_ALPHA);
    this.heat(DRAG_ALPHA);
  }

  dragMove(n: LayoutNode, x: number, y: number): void {
    n.fx = x;
    n.fy = y;
    n.x = x;
    n.y = y;
  }

  dragEnd(n: LayoutNode): void {
    n.fx = null;
    n.fy = null;
    this.sim.alphaTarget(0);
  }
}
