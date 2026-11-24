import type { SimulationNodeDatum } from "d3-force";
import type { GraphNode } from "./graphdata";
import type { LayoutForces } from "./graphlayout";

// A node on the canvas: the view's fields plus the position the worker reports.
export interface SimNode extends GraphNode, SimulationNodeDatum {}

// Messages to the layout worker. `pos` holds x, y pairs in the order of `ids`; NaN marks a node without a position yet.
export type ToWorker =
  | { t: "data"; seq: number; ids: string[]; pos: Float32Array; links: [string, string][]; forces: LayoutForces; heat: number }
  | { t: "forces"; forces: LayoutForces; heat: number }
  | { t: "heat"; alpha: number }
  | { t: "run"; on: boolean }
  | { t: "settle" }
  | { t: "drag"; phase: "start" | "move" | "end"; i: number; x: number; y: number };

// Positions after a slice of layout; `seq` says which node list they belong to.
export type FromWorker = { t: "pos"; seq: number; pos: Float32Array; moving: boolean };

// The main thread's side of the layout: it sends commands and copies the worker's positions onto the nodes.
// The worker starts on the first data, so a page that never shows a graph never starts it.
export class LayoutClient {
  nodes: SimNode[] = [];
  private worker: Worker | null = null;
  private seq = 0;

  // onMove gets whether the layout still moves, so the view knows when to stop fitting.
  constructor(private readonly onMove: (moving: boolean) => void) {}

  setData(nodes: SimNode[], links: [string, string][], forces: LayoutForces, heat: number): void {
    this.nodes = nodes;
    const pos = new Float32Array(nodes.length * 2);
    nodes.forEach((n, i) => {
      pos[2 * i] = n.x ?? NaN;
      pos[2 * i + 1] = n.y ?? NaN;
    });
    this.send({ t: "data", seq: ++this.seq, ids: nodes.map((n) => n.id), pos, links, forces, heat }, [pos.buffer]);
  }

  setForces(forces: LayoutForces, heat: number): void {
    this.send({ t: "forces", forces, heat });
  }

  heat(alpha: number): void {
    this.send({ t: "heat", alpha });
  }

  // Runs the layout to rest at once (reduced motion); the positions arrive with the next position update.
  settle(): void {
    this.send({ t: "settle" });
  }

  // Stopping a worker that was never started is a no-op, so a page that never shows a graph starts none.
  run(on: boolean): void {
    if (on || this.worker) this.send({ t: "run", on });
  }

  drag(phase: "start" | "move" | "end", i: number, x: number, y: number): void {
    this.send({ t: "drag", phase, i, x, y });
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    if (!this.worker) {
      this.worker = new Worker(new URL("./graphworker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onPos(e.data);
    }
    this.worker.postMessage(msg, transfer);
  }

  private onPos(m: FromWorker): void {
    // Positions of a node list that has been replaced are stale; drop them.
    if (m.seq !== this.seq) return;
    this.nodes.forEach((n, i) => {
      const x = m.pos[2 * i];
      if (Number.isNaN(x)) return;
      n.x = x;
      n.y = m.pos[2 * i + 1];
    });
    this.onMove(m.moving);
  }
}
