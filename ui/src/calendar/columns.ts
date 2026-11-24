// Side-by-side placement of overlapping timed events in one day column (pure, tested).

export interface Span<T> {
  /** Minutes since midnight, `end` > `start`. */
  start: number;
  end: number;
  item: T;
}

export interface Placed<T> extends Span<T> {
  /** 0-based column of the event inside its cluster. */
  col: number;
  /** Columns of its cluster: the event is `1 / cols` wide. */
  cols: number;
}

/**
 * Greedy column packing: events that overlap (directly or through others) form a cluster, each
 * event takes the first column that is free at its start, and the cluster shares the column count.
 */
export function layoutColumns<T>(spans: Span<T>[]): Placed<T>[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = (): void => {
    for (const p of cluster) p.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
  };
  for (const s of sorted) {
    if (s.start >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= s.start);
    if (col < 0) col = colEnds.push(s.end) - 1;
    else colEnds[col] = s.end;
    cluster.push({ ...s, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  flush();
  return out;
}
