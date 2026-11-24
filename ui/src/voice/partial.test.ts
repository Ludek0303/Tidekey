import { describe, expect, it } from "vitest";
import { PARTIAL_MAX_MS, finishPartial, newGate, shouldPartial } from "./partial";

const open = (ms: number, ongoing = true) => ({ ms, ongoing });

describe("shouldPartial", () => {
  it("waits for 800 ms of speech and stops after 20 s of one fragment", () => {
    const g = newGate();
    expect(shouldPartial(g, 0, open(799))).toBe(false);
    expect(shouldPartial(g, 0, open(800))).toBe(true);
    expect(shouldPartial(g, 0, open(PARTIAL_MAX_MS))).toBe(true);
    expect(shouldPartial(g, 0, open(PARTIAL_MAX_MS + 32))).toBe(false);
  });

  it("does not run while the fragment is in a silence", () => {
    expect(shouldPartial(newGate(), 0, open(2000, false))).toBe(false);
  });

  it("allows at most one partial in the queue", () => {
    const g = newGate();
    g.busy = true;
    expect(shouldPartial(g, 0, open(2000))).toBe(false);
  });

  it("waits 700 ms after a fast partial and twice the cost after a slow one", () => {
    const g = newGate();
    finishPartial(g, 1000, 100);
    expect(shouldPartial(g, 1699, open(2000))).toBe(false);
    expect(shouldPartial(g, 1700, open(2000))).toBe(true);

    const slow = newGate();
    finishPartial(slow, 1000, 500);
    expect(shouldPartial(slow, 1999, open(2000))).toBe(false);
    expect(shouldPartial(slow, 2000, open(2000))).toBe(true);
  });

  it("stays off for the session once one partial took more than 2.5 s", () => {
    const g = newGate();
    finishPartial(g, 1000, 2500);
    expect(g.off).toBe(false);
    finishPartial(g, 5000, 2600);
    expect(g.off).toBe(true);
    expect(shouldPartial(g, 1e9, open(2000))).toBe(false);
  });
});
