import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GRAPH_SETTINGS } from "./graphsettings";

const KEY = "notes.graph.v1";

// The module reads storage when it loads, so each test loads it again.
async function fresh() {
  vi.resetModules();
  return import("./graphsettings");
}

beforeEach(() => localStorage.clear());

describe("graph settings", () => {
  it("shows files and hides people and mentions by default", () => {
    expect(DEFAULT_GRAPH_SETTINGS).toMatchObject({ files: true, people: false, mentions: false });
  });

  it("starts from the defaults with empty storage", async () => {
    const m = await fresh();
    expect(m.getGraphSettings()).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it("stores a change and reads it back after a reload", async () => {
    const m = await fresh();
    m.setGraphSettings({ ...m.getGraphSettings(), nodeSize: 2, groups: [{ query: "path:Projekty", color: "#123456" }] });
    expect(JSON.parse(localStorage.getItem(KEY)!).nodeSize).toBe(2);
    const again = await fresh();
    expect(again.getGraphSettings().nodeSize).toBe(2);
    expect(again.getGraphSettings().groups).toEqual([{ query: "path:Projekty", color: "#123456" }]);
  });

  it("falls back to the default for values of the wrong type or bad groups", async () => {
    localStorage.setItem(KEY, JSON.stringify({ nodeSize: "duży", tags: true, groups: [{ query: 1 }, { query: "a", color: "red" }, { query: "tag:x", color: "#abcdef" }] }));
    const m = await fresh();
    expect(m.getGraphSettings().nodeSize).toBe(DEFAULT_GRAPH_SETTINGS.nodeSize);
    expect(m.getGraphSettings().tags).toBe(true);
    expect(m.getGraphSettings().groups).toEqual([{ query: "tag:x", color: "#abcdef" }]);
  });

  it("survives broken storage", async () => {
    localStorage.setItem(KEY, "{nie json");
    const m = await fresh();
    expect(m.getGraphSettings()).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it("tells listeners about each change", async () => {
    const m = await fresh();
    const seen: number[] = [];
    const off = m.onGraphSettings((s) => seen.push(s.linkWidth));
    m.setGraphSettings({ ...m.getGraphSettings(), linkWidth: 3 });
    off();
    m.setGraphSettings({ ...m.getGraphSettings(), linkWidth: 4 });
    expect(seen).toEqual([3]);
  });
});
