// Layout worker: the d3-force ticks of a graph run here, so the page never waits for them.
// Protocol: graphclient.ts (ToWorker / FromWorker).
import { GraphLayout, type LayoutNode } from "./graphlayout";
import type { FromWorker, ToWorker } from "./graphclient";

// Ticks per message: short enough that a position update arrives every few milliseconds.
const SLICE_MS = 8;

const scope = self as unknown as {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const layout = new GraphLayout();
let seq = 0;
// Idle until the view is shown; a message with `run` starts it.
let running = false;
let pumping = false;

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case "data": {
      seq = m.seq;
      const nodes: LayoutNode[] = m.ids.map((id, i) => {
        const x = m.pos[2 * i];
        return Number.isNaN(x) ? { id } : { id, x, y: m.pos[2 * i + 1] };
      });
      layout.setData(
        nodes,
        m.links.map(([source, target]) => ({ source, target })),
        m.forces,
      );
      if (m.heat > 0) layout.heat(m.heat);
      break;
    }
    case "forces":
      layout.setForces(m.forces);
      if (m.heat > 0) layout.heat(m.heat);
      break;
    case "heat":
      layout.heat(m.alpha);
      break;
    case "settle":
      layout.settle();
      break;
    case "run":
      running = m.on;
      break;
    case "drag": {
      const n = layout.nodes[m.i];
      if (!n) break;
      if (m.phase === "start") layout.dragStart(n);
      else if (m.phase === "move") layout.dragMove(n, m.x, m.y);
      else layout.dragEnd(n);
      break;
    }
  }
  pump();
};

// Runs slices of ticks, one message after each, until the layout cools or the view is hidden.
function pump(): void {
  if (pumping) return;
  pumping = true;
  const turn = () => {
    if (!running) {
      pumping = false;
      return;
    }
    const moving = layout.step(SLICE_MS);
    post(moving);
    if (moving) setTimeout(turn, 0);
    else pumping = false;
  };
  turn();
}

function post(moving: boolean): void {
  const nodes = layout.nodes;
  const pos = new Float32Array(nodes.length * 2);
  nodes.forEach((n, i) => {
    pos[2 * i] = n.x ?? NaN;
    pos[2 * i + 1] = n.y ?? NaN;
  });
  scope.postMessage({ t: "pos", seq, pos, moving }, [pos.buffer]);
}
