// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cellAt, diagramBlock, diagramFences, diagramOf, diagramSource, diagramSvg, layoutDiagram, MAX_BOXES, MAX_EDGES, paintReadingDiagrams, parseDiagram, plural, type Diagram, type PlacedEdge } from "./diagram";

const at = (lay: ReturnType<typeof layoutDiagram>, id: string) => lay.boxes.find((p) => p.box.id === id)!;
const onEdge = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number }) =>
  (Math.abs(q.x - p.x) < 0.01 || Math.abs(q.x - (p.x + p.w)) < 0.01 || Math.abs(q.y - p.y) < 0.01 || Math.abs(q.y - (p.y + p.h)) < 0.01) &&
  q.x >= p.x - 0.01 && q.x <= p.x + p.w + 0.01 && q.y >= p.y - 0.01 && q.y <= p.y + p.h + 0.01;

describe("parseDiagram", () => {
  it("reads every connection operator, the aliases and the colours", () => {
    const d = parseDiagram(
      "kierunek: pionowo\ntytul: Obieg\n[a] Zamówienie | niebieski\n[b] Płatność | zolty | 2,1\n[c] Wysyłka | Rozowy\n" +
        "a -> b : opłacone\nb <- c\na <-> c\nb -- c\nc ..> a\na .. b",
    );
    expect(d.direction).toBe("down");
    expect(d.title).toBe("Obieg");
    expect(d.boxes).toEqual([
      { id: "a", label: "Zamówienie", color: "niebieski", pos: null },
      { id: "b", label: "Płatność", color: "żółty", pos: { col: 2, row: 1 } },
      { id: "c", label: "Wysyłka", color: "różowy", pos: null },
    ]);
    expect(d.edges.map((e) => [e.from, e.op, e.to, e.label])).toEqual([
      ["a", "->", "b", "opłacone"],
      ["b", "<-", "c", ""],
      ["a", "<->", "c", ""],
      ["b", "--", "c", ""],
      ["c", "..>", "a", ""],
      ["a", "..", "b", ""],
    ]);
    expect(d.skipped).toBe(0);
  });

  it("aliases: prawo, poziomo, right; unknown direction and colour fall back to the default", () => {
    expect(parseDiagram("kierunek: poziomo").direction).toBe("right");
    expect(parseDiagram("kierunek: right").direction).toBe("right");
    expect(parseDiagram("kierunek: dziwny").direction).toBe("right");
    expect(parseDiagram("[a] A | fiolet").boxes[0].color).toBe("szary");
  });

  it("makes a box for an id that is not declared yet, labelled with the id", () => {
    const d = parseDiagram("x -> y");
    expect(d.boxes.map((b) => [b.id, b.label, b.color])).toEqual([["x", "x", "szary"], ["y", "y", "szary"]]);
  });

  it("a later line with the same id wins", () => {
    const d = parseDiagram("[a] Pierwsza | niebieski\n[a] Druga | zielony");
    expect(d.boxes).toEqual([{ id: "a", label: "Druga", color: "zielony", pos: null }]);
  });

  it("counts lines it cannot read, and the boxes and connections over the limits", () => {
    const boxes = Array.from({ length: MAX_BOXES + 3 }, (_, i) => `[b${i}] B${i}`).join("\n");
    const d = parseDiagram(`${boxes}\nto nie linia\n[] pusty id`);
    expect(d.boxes).toHaveLength(MAX_BOXES);
    expect(d.skipped).toBe(3 + 2);
    const edges = Array.from({ length: MAX_EDGES + 1 }, () => "b0 -> b1").join("\n");
    const e = parseDiagram(edges);
    expect(e.edges).toHaveLength(MAX_EDGES);
    expect(e.skipped).toBe(1);
  });

  it("meta lines count only before the first box or connection", () => {
    const d = parseDiagram("[a] A\nkierunek: dół\ntytuł: Później");
    expect(d.direction).toBe("right");
    expect(d.title).toBe("");
    expect(d.skipped).toBe(2);
  });
});

describe("diagramSource round-trip", () => {
  it("parse(serialize(x)) equals x", () => {
    const x: Diagram = {
      direction: "down",
      title: "Obieg zamówienia",
      boxes: [
        { id: "a", label: "Zamówienie", color: "niebieski", pos: null },
        { id: "b", label: "Płatność", color: "żółty", pos: { col: 2, row: 1 } },
        { id: "c", label: "Wysyłka", color: "szary", pos: { col: 1, row: 3 } },
      ],
      edges: [
        { from: "a", to: "b", op: "->", label: "opłacone" },
        { from: "b", to: "c", op: "<->", label: "" },
        { from: "c", to: "a", op: "..>", label: "zwrot" },
      ],
      skipped: 0,
    };
    expect(parseDiagram(diagramSource(x))).toEqual(x);
    expect(diagramOf(diagramBlock(x))).toEqual(x);
  });

  it("writes the default direction and colour as nothing", () => {
    expect(diagramSource({ direction: "right", title: "", boxes: [{ id: "a", label: "A", color: "szary", pos: null }], edges: [], skipped: 0 })).toBe("[a] A");
  });
});

describe("layoutDiagram", () => {
  const chain = (direction: "right" | "down"): Diagram =>
    parseDiagram(`${direction === "down" ? "kierunek: dół\n" : ""}[a] A\n[b] B\n[c] C\na -> b\nb -> c`);

  it("a chain goes left to right in the right direction, at one height", () => {
    const lay = layoutDiagram(chain("right"));
    const [a, b, c] = ["a", "b", "c"].map((id) => at(lay, id));
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
  });

  it("a chain goes top to bottom in the down direction, in one column", () => {
    const lay = layoutDiagram(chain("down"));
    const [a, b, c] = ["a", "b", "c"].map((id) => at(lay, id));
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);
    expect(a.x).toBe(b.x);
    expect(b.x).toBe(c.x);
  });

  it("a cycle does not hang and makes two layers", () => {
    const lay = layoutDiagram(parseDiagram("a -> b\nb -> a"));
    expect(new Set(lay.boxes.map((p) => p.col)).size).toBe(2);
  });

  it("an explicit position is kept", () => {
    const lay = layoutDiagram(parseDiagram("[a] A | 3,2\n[b] B\na -> b"));
    expect(at(lay, "a").col).toBe(3);
    expect(at(lay, "a").row).toBe(2);
  });

  it("two boxes on one cell: the second moves to the nearest free cell", () => {
    const lay = layoutDiagram(parseDiagram("[a] A | 1,1\n[b] B | 1,1"));
    const [a, b] = [at(lay, "a"), at(lay, "b")];
    expect([a.col, a.row]).toEqual([1, 1]);
    expect(b.col === 1 && b.row === 1).toBe(false);
    expect(Math.abs(b.col - 1) + Math.abs(b.row - 1)).toBe(1);
  });

  it("a long label wraps to two lines at most and then ends in an ellipsis", () => {
    const lay = layoutDiagram(parseDiagram("[a] " + "słowo ".repeat(40)));
    const p = at(lay, "a");
    expect(p.lines.length).toBe(2);
    expect(p.lines[1].endsWith("…")).toBe(true);
    expect(p.h).toBe(62);
    expect(p.w).toBeLessThanOrEqual(208);
    expect(at(layoutDiagram(parseDiagram("[b] Krótko")), "b").w).toBe(112);
  });
});

describe("connection routes", () => {
  const route = (lay: ReturnType<typeof layoutDiagram>, from: string): PlacedEdge => lay.edges.find((e) => e.edge.from === from)!;

  it("ends sit exactly on the boxes' edges", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\n[b] B\n[c] C\na -> b\na -> c"));
    for (const e of lay.edges) {
      const [first, last] = [e.points[0], e.points[e.points.length - 1]];
      expect(onEdge(at(lay, e.edge.from), first)).toBe(true);
      expect(onEdge(at(lay, e.edge.to), last)).toBe(true);
    }
  });

  it("aligned boxes are joined by a straight line", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\n[b] B\na -> b"));
    const e = route(lay, "a");
    expect(e.points).toHaveLength(2);
    expect(e.points[0].y).toBe(e.points[1].y);
  });

  it("boxes off the line are joined by a right-angle route with rounded corners", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\n[b] B | 2,2\na -> b"));
    const e = route(lay, "a");
    expect(e.points).toHaveLength(4);
    expect(e.d).toContain("Q");
    const [p0, p1, p2, p3] = e.points;
    expect(p1.y).toBe(p0.y);
    expect(p1.x).toBe(p2.x);
    expect(p2.y).toBe(p3.y);
  });

  it("a self loop is an arc above its box", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\na -> a"));
    const e = route(lay, "a");
    expect(e.d.startsWith("M")).toBe(true);
    expect(e.d).toContain(" C");
    expect(e.label.y).toBeLessThan(at(lay, "a").y);
  });

  it("an arrowhead shortens the drawn path, not the route's end on the edge", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\n[b] B\na -> b"));
    const e = route(lay, "a");
    const end = e.points[e.points.length - 1];
    expect(e.d.endsWith(`L${end.x} ${end.y}`)).toBe(false);
    expect(e.arrowEnd).toBe(true);
    expect(route(layoutDiagram(parseDiagram("[a] A\n[b] B\na -- b")), "a").arrowEnd).toBe(false);
  });

  it("a cell click picks the nearest cell, and a point past the drawing is a new column", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\n[b] B\na -> b"));
    const a = at(lay, "a");
    expect(cellAt(lay, a.x + a.w / 2, a.y + a.h / 2)).toEqual({ col: 1, row: 1 });
    const right = lay.cols[lay.cols.length - 1].at + lay.cols[lay.cols.length - 1].size + 200;
    expect(cellAt(lay, right, 20).col).toBe(lay.cols.length + 1);
  });
});

describe("diagramSvg", () => {
  it("draws one rect.dg-box per box, with its colour class and an aria-label", () => {
    const svg = diagramSvg(parseDiagram("kierunek: prawo\n[a] A | niebieski\n[b] B\na -> b"));
    expect(svg.querySelectorAll("rect.dg-box")).toHaveLength(2);
    expect(svg.querySelector("rect.dg-box.dg-c-niebieski")).not.toBeNull();
    expect(svg.getAttribute("aria-label")).toBe("Schemat: 2 prostokąty, 1 połączenie");
    expect(svg.getAttribute("role")).toBe("img");
  });

  it("an arrow on both ends for <->, on none for --, a dashed line for ..", () => {
    const both = diagramSvg(parseDiagram("[a] A\n[b] B\na <-> b")).querySelector("path.dg-line")!;
    expect(both.getAttribute("marker-start")).toBe(both.getAttribute("marker-end"));
    expect(both.getAttribute("marker-start")).not.toBeNull();
    const none = diagramSvg(parseDiagram("[a] A\n[b] B\na -- b")).querySelector("path.dg-line")!;
    expect(none.hasAttribute("marker-start") || none.hasAttribute("marker-end")).toBe(false);
    const dashed = diagramSvg(parseDiagram("[a] A\n[b] B\na .. b")).querySelector("path.dg-line")!;
    expect(dashed.getAttribute("stroke-dasharray")).toBe("5 4");
  });

  it("two diagrams on one page have different marker ids", () => {
    const ids = [0, 1].map(() => {
      const svg = diagramSvg(parseDiagram("[a] A\n[b] B\na -> b"));
      document.body.append(svg);
      return svg.querySelector("marker")!.id;
    });
    expect(ids[0]).not.toBe(ids[1]);
    expect(document.querySelector(`#${ids[0]}`)).not.toBeNull();
    document.querySelectorAll("svg").forEach((s) => s.remove());
  });

  it("an empty diagram shows the hint instead of boxes", () => {
    const svg = diagramSvg(parseDiagram(""));
    expect(svg.querySelectorAll("rect.dg-box")).toHaveLength(0);
    expect(svg.textContent).toContain("Pusty schemat. Kliknij, żeby dodać prostokąty.");
  });
});

describe("diagram blocks in the note", () => {
  it("finds the schemat and diagram blocks, in order, and not the other fences", () => {
    const note = "```wykres\nA: 1\n```\n\n```schemat\n[a] A\n```\n\n```diagram\n[b] B\n```";
    const fences = diagramFences(note);
    expect(fences.map((f) => note.slice(f.from, f.to).split("\n")[0])).toEqual(["```schemat", "```diagram"]);
  });
});

describe("reading view", () => {
  it("each schemat block becomes its diagram, and a chart block next to it is left alone", () => {
    const note = "```wykres\nA: 1\n```\n\n```schemat\n[a] A\n```";
    const root = document.createElement("div");
    root.innerHTML = '<pre><code class="language-wykres">A: 1</code></pre><pre><code class="language-schemat">[a] A</code></pre>';
    paintReadingDiagrams(root, note);
    expect(root.querySelector(".dg-frame svg.dg-svg")).not.toBeNull();
    expect(root.querySelector("code.language-wykres")).not.toBeNull();
  });
});

describe("self-loop room", () => {
  it("a loop above the top row keeps its arc inside the drawing", () => {
    const lay = layoutDiagram(parseDiagram("[a] A\na -> a"));
    const top = Math.min(...lay.boxes.map((p) => p.y));
    expect(top - 30).toBeGreaterThanOrEqual(0);
    expect(lay.edges[0].label.y).toBeGreaterThan(0);
  });
});

describe("detours around boxes", () => {
  const CHAIN = "[z] Z\n[p] P\n[m] M\n[w] W\n[r] R\nz -> p\np -> m\nm -> w\nw <-> r\nr ..> z";
  const others = (lay: ReturnType<typeof layoutDiagram>) => ["p", "m", "w"].map((id) => at(lay, id));
  const crossesInside = (a: { x: number; y: number }, b: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }) => {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return x1 > box.x && x0 < box.x + box.w && y1 > box.y && y0 < box.y + box.h;
  };

  it("in direction right, the backward connection leaves below the row and passes under p, m and w", () => {
    const lay = layoutDiagram(parseDiagram(CHAIN));
    const e = lay.edges.find((x) => x.edge.from === "r" && x.edge.to === "z")!;
    const pts = e.points;
    for (let i = 1; i < pts.length; i++) for (const box of others(lay)) expect(crossesInside(pts[i - 1], pts[i], box)).toBe(false);
    const lowest = Math.max(...others(lay).map((b) => b.y + b.h));
    for (const q of pts.slice(1, -1)) expect(q.y).toBeGreaterThan(lowest);
    // the channel is inside the drawing
    expect(Math.max(...pts.map((q) => q.y))).toBeLessThanOrEqual(lay.height);
  });

  it("in direction down, the backward connection leaves right of the column and passes beside p, m and w", () => {
    const lay = layoutDiagram(parseDiagram("kierunek: dół\n" + CHAIN));
    const e = lay.edges.find((x) => x.edge.from === "r" && x.edge.to === "z")!;
    const pts = e.points;
    for (let i = 1; i < pts.length; i++) for (const box of others(lay)) expect(crossesInside(pts[i - 1], pts[i], box)).toBe(false);
    const rightmost = Math.max(...others(lay).map((b) => b.x + b.w));
    for (const q of pts.slice(1, -1)) expect(q.x).toBeGreaterThan(rightmost);
    expect(Math.max(...pts.map((q) => q.x))).toBeLessThanOrEqual(lay.width);
  });

  it("two detours in one channel are 12 px apart", () => {
    const lay = layoutDiagram(parseDiagram(CHAIN + "\nz ..> r"));
    const back = lay.edges.filter((x) => x.edge.op !== "->" && x.edge.op !== "<->");
    const ys = back.map((e) => e.points[1].y).sort((x, y) => x - y);
    expect(ys[1] - ys[0]).toBe(12);
  });
});

describe("plural", () => {
  it("uses the Polish forms: 1, 2–4 (not 12–14), and the rest, 0 included", () => {
    const f = (n: number) => plural(n, "prostokąt", "prostokąty", "prostokątów");
    expect([1, 2, 5, 12, 22, 25, 0].map(f)).toEqual(["prostokąt", "prostokąty", "prostokątów", "prostokątów", "prostokąty", "prostokątów", "prostokątów"]);
    expect(f(13)).toBe("prostokątów");
    expect(f(14)).toBe("prostokątów");
  });

  it("the aria-label follows the forms for boxes and connections", () => {
    const text = (n: number) => diagramSvg(parseDiagram(Array.from({ length: n }, (_, i) => `[b${i}] B`).join("\n"))).getAttribute("aria-label");
    expect(text(1)).toBe("Schemat: 1 prostokąt, 0 połączeń");
    expect(text(2)).toBe("Schemat: 2 prostokąty, 0 połączeń");
    expect(text(5)).toBe("Schemat: 5 prostokątów, 0 połączeń");
    expect(text(12)).toBe("Schemat: 12 prostokątów, 0 połączeń");
    expect(diagramSvg(parseDiagram("[a] A\n[b] B\na -> b")).getAttribute("aria-label")).toBe("Schemat: 2 prostokąty, 1 połączenie");
  });
});
