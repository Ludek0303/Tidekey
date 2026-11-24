//! Line differences between two texts: the blocks shown by the conflict and version views.

export type Block = { same: string[] } | { ours: string[]; theirs: string[] };

// Above this many line pairs the diff is one replaced block, so a huge note does not need a huge table.
const MAX_PAIRS = 4_000_000;

/** The text as blocks: lines both texts share, and blocks where `ours` and `theirs` differ. */
export function blocks(ours: string, theirs: string): Block[] {
  const a = ours.split("\n");
  const b = theirs.split("\n");
  const out: Block[] = [];
  const same = (line: string) => {
    const last = out[out.length - 1];
    if (last && "same" in last) last.same.push(line);
    else out.push({ same: [line] });
  };
  const change = (side: "ours" | "theirs", line: string) => {
    let last = out[out.length - 1];
    if (!last || "same" in last) {
      last = { ours: [], theirs: [] };
      out.push(last);
    }
    (last as { ours: string[]; theirs: string[] })[side].push(line);
  };
  if (a.length * b.length > MAX_PAIRS) {
    if (a.join("\n") === b.join("\n")) return [{ same: a }];
    return [{ ours: a, theirs: b }];
  }
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      same(a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      change("ours", a[i++]);
    } else {
      change("theirs", b[j++]);
    }
  }
  while (i < a.length) change("ours", a[i++]);
  while (j < b.length) change("theirs", b[j++]);
  return out;
}

/** The text made of `blocks`, each differing block taken from its side in `picks`, in order (ours by default). */
export function compose(all: Block[], picks: Array<"ours" | "theirs"> = []): string {
  const lines: string[] = [];
  let differing = 0;
  for (const block of all) {
    if ("same" in block) {
      lines.push(...block.same);
    } else {
      lines.push(...(picks[differing++] === "theirs" ? block.theirs : block.ours));
    }
  }
  return lines.join("\n");
}
