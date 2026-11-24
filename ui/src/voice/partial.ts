// Partial results (docs/DYKTOWANIE.md §4): while a fragment is spoken, the worker recognises the audio so far and the
// editor shows the words before the pause. These are the rules only; the worker keeps one gate per session.

export const PARTIAL_MIN_MS = 800;
export const PARTIAL_MAX_MS = 20000; // shortcut: past this the fragment's partials stop; a longer fragment would cost more than it shows
export const PARTIAL_GAP_MS = 700;
export const PARTIAL_SLOW_MS = 2500; // a partial this slow means a slow machine: partials stay off for the session

export interface PartialGate {
  /** A partial is queued or being recognised: at most one at a time. */
  busy: boolean;
  /** Off until the session ends, after a partial took longer than PARTIAL_SLOW_MS. */
  off: boolean;
  /** When the last partial finished. */
  lastAt: number;
  /** How long the last partial took. */
  lastCost: number;
}

export const newGate = (): PartialGate => ({ busy: false, off: false, lastAt: -Infinity, lastCost: 0 });

// Whether the open fragment should be recognised now. `open` is what Segmenter.open() returns.
export function shouldPartial(g: PartialGate, now: number, open: { ms: number; ongoing: boolean }): boolean {
  if (g.busy || g.off || !open.ongoing) return false;
  if (open.ms < PARTIAL_MIN_MS || open.ms > PARTIAL_MAX_MS) return false;
  return now - g.lastAt >= Math.max(PARTIAL_GAP_MS, 2 * g.lastCost);
}

// Records a partial that finished at `now` after taking `cost` ms.
export function finishPartial(g: PartialGate, now: number, cost: number): void {
  g.busy = false;
  g.lastAt = now;
  g.lastCost = cost;
  if (cost > PARTIAL_SLOW_MS) g.off = true;
}
