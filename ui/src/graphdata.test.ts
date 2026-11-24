import { describe, expect, it } from "vitest";
import { buildView, groupColor, type MapExtra } from "./graphdata";
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from "./graphsettings";
import type { RawGraph } from "./noteindex";

const raw: RawGraph = {
  nodes: [
    { id: "a", path: "Projekty/A.md", tags: ["praca"] },
    { id: "b", path: "Projekty/B.md", tags: ["praca/sub"] },
    { id: "c", path: "Dziennik/C.md", tags: [] },
    { id: "d", path: "D.md", tags: [] },
    { id: "e", path: "E.md", tags: [] },
  ],
  edges: [
    ["a", "b"],
    ["b", "c"],
  ],
  ghosts: [{ name: "Zewn", from: ["a", "d"] }],
};

const settings = (over: Partial<GraphSettings> = {}): GraphSettings => ({ ...DEFAULT_GRAPH_SETTINGS, ...over });
const ids = (v: { nodes: { id: string }[] }) => v.nodes.map((n) => n.id).sort();

describe("buildView filters", () => {
  it("shows notes, ghosts and orphans by default", () => {
    expect(ids(buildView(raw, settings()))).toEqual(["a", "b", "c", "d", "e", "ghost:Zewn"]);
  });

  it("hides orphans when the Sieroty filter is off", () => {
    expect(ids(buildView(raw, settings({ orphans: false })))).not.toContain("e");
  });

  it("hides ghosts and their links with Tylko istniejące pliki", () => {
    const v = buildView(raw, settings({ existingOnly: true }));
    expect(ids(v)).not.toContain("ghost:Zewn");
    expect(v.links.every((l) => !l.target.startsWith("ghost:"))).toBe(true);
  });

  it("filters by path substring", () => {
    expect(ids(buildView(raw, settings({ search: "projekty", orphans: false })))).toEqual(["a", "b"]);
  });

  it("adds tag nodes with the Tagi filter, linked from their notes", () => {
    const v = buildView(raw, settings({ tags: true }));
    expect(ids(v)).toContain("tag:praca");
    expect(ids(v)).toContain("tag:praca/sub");
    expect(v.links).toContainEqual({ source: "a", target: "tag:praca" });
    expect(v.nodes.find((n) => n.id === "tag:praca")!.tag).toBe(true);
  });
});

describe("groups", () => {
  const groups = [
    { query: "path:Projekty", color: "#ff0000" },
    { query: "tag:praca", color: "#00ff00" },
    { query: "dziennik", color: "#0000ff" },
  ];

  it("the first matching group colours the node", () => {
    const v = buildView(raw, settings({ groups }));
    const color = (id: string) => v.nodes.find((n) => n.id === id)!.color;
    expect(color("a")).toBe("#ff0000");
    // b is in Projekty (first group) and also tagged praca/sub (second): the first wins.
    expect(color("b")).toBe("#ff0000");
    expect(color("c")).toBe("#0000ff");
    expect(color("e")).toBeUndefined();
  });

  it("tag queries match nested tags and tag nodes", () => {
    const v = buildView(raw, settings({ groups, tags: true }));
    expect(v.nodes.find((n) => n.id === "tag:praca")!.color).toBe("#00ff00");
    expect(groupColor(v.nodes.find((n) => n.id === "a")!, [{ query: "tag:#praca/sub", color: "#123456" }])).toBeUndefined();
    expect(groupColor(v.nodes.find((n) => n.id === "b")!, [{ query: "tag:#praca", color: "#123456" }])).toBe("#123456");
  });
});

describe("rebuilt colours", () => {
  it("a node that leaves its group loses the colour when merged over its old copy", () => {
    const grouped = buildView(raw, settings({ groups: [{ query: "path:Projekty", color: "#ff0000" }] }));
    const before = { ...grouped.nodes.find((n) => n.id === "a")! };
    const after = buildView(raw, settings()).nodes.find((n) => n.id === "a")!;
    expect(before.color).toBe("#ff0000");
    expect(Object.assign(before, after).color).toBeUndefined();
  });
});


describe("files, people and mentions from the search index", () => {
  const extra: MapExtra = {
    nodes: [
      { id: "f:F1", kind: "file", label: "Faktura.pdf" },
      { id: "p:anna", kind: "person", label: "anna" },
    ],
    edges: [
      { from: "n:a", to: "f:F1", kind: "embed" },
      { from: "n:a", to: "p:anna", kind: "assigned" },
      { from: "f:F1", to: "n:b", kind: "mention" },
      { from: "n:c", to: "n:e", kind: "mention" },
      { from: "n:a", to: "n:zniknela", kind: "embed" },
    ],
  };
  const has = (v: { links: { source: string; target: string }[] }, source: string, target: string) =>
    v.links.some((l) => l.source === source && l.target === target);

  it("defaults show files, hide people and mentions", () => {
    const v = buildView(raw, settings(), extra);
    expect(ids(v)).toContain("f:F1");
    expect(ids(v)).not.toContain("p:anna");
    expect(has(v, "a", "f:F1")).toBe(true);
    expect(has(v, "f:F1", "b")).toBe(false);
    expect(has(v, "c", "e")).toBe(false);
    expect(v.nodes.find((n) => n.id === "f:F1")).toMatchObject({ name: "Faktura.pdf", file: true });
  });

  it("the people switch adds person nodes linked by assignment", () => {
    const v = buildView(raw, settings({ people: true }), extra);
    expect(v.nodes.find((n) => n.id === "p:anna")).toMatchObject({ name: "anna", person: true });
    expect(has(v, "a", "p:anna")).toBe(true);
  });

  it("the mentions switch adds mention links, from files too, but no file node with the files switch off", () => {
    const v = buildView(raw, settings({ mentions: true }), extra);
    expect(has(v, "c", "e")).toBe(true);
    expect(has(v, "f:F1", "b")).toBe(true);
    const off = buildView(raw, settings({ mentions: true, files: false }), extra);
    expect(ids(off)).not.toContain("f:F1");
    expect(off.links.some((l) => l.source.startsWith("f:") || l.target.startsWith("f:"))).toBe(false);
  });

  it("drops the links whose note is not in the raw graph, and keeps the views without extra data", () => {
    const v = buildView(raw, settings({ mentions: true }), extra);
    expect(v.links.some((l) => l.target.includes("zniknela"))).toBe(false);
    expect(buildView(raw, settings())).toEqual(buildView(raw, settings(), { nodes: [], edges: [] }));
  });
});
