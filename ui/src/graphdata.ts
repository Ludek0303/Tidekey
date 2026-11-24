// Pure graph model: turns the index's links into the nodes and links one graph view shows. No DOM here.
import type { RawGraph } from "./noteindex";
import type { GraphGroup, GraphSettings } from "./graphsettings";

export interface GraphNode {
  id: string;
  name: string;
  path: string;
  tags: string[];
  // Unresolved link target (no such note).
  ghost: boolean;
  // Tag node (`#tag`), shown only with the Tagi filter.
  tag: boolean;
  // A file (a square) and a person (a diamond), from the search index (OCR §4.4).
  file?: boolean;
  person?: boolean;
  degree: number;
  color?: string;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphModel {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Files, people and mentions of the search index (`edges_json`): ids as `f:`, `p:`, `n:`; kinds as the index names them. */
export interface MapExtra {
  nodes: { id: string; kind: string; label: string }[];
  edges: { from: string; to: string; kind: string }[];
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** Nodes and links of the view: every filter applied. `extra` adds the files, people and mentions the switches allow. */
export function buildView(raw: RawGraph, s: GraphSettings, extra?: MapExtra): GraphModel {
  const all = new Map<string, GraphNode>();
  for (const n of raw.nodes) {
    all.set(n.id, { id: n.id, name: baseName(n.path), path: n.path, tags: n.tags, ghost: false, tag: false, degree: 0 });
  }
  const links: GraphLink[] = raw.edges.map(([source, target]) => ({ source, target }));
  for (const g of raw.ghosts) {
    const id = `ghost:${g.name}`;
    all.set(id, { id, name: g.name, path: g.name, tags: [], ghost: true, tag: false, degree: 0 });
    for (const from of g.from) links.push({ source: from, target: id });
  }
  for (const n of extra?.nodes ?? []) {
    if (n.kind === "file" && s.files) all.set(n.id, { id: n.id, name: n.label, path: n.label, tags: [], ghost: false, tag: false, file: true, degree: 0 });
    if (n.kind === "person" && s.people) all.set(n.id, { id: n.id, name: n.label, path: n.label, tags: [], ghost: false, tag: false, person: true, degree: 0 });
  }
  for (const e of extra?.edges ?? []) {
    const on = (e.kind === "embed" && s.files) || (e.kind === "assigned" && s.people) || (e.kind === "mention" && s.mentions);
    // A note's id is bare in the raw graph and `n:`-prefixed in the index.
    const ends = [e.from, e.to].map((id) => (id.startsWith("n:") ? id.slice(2) : id));
    if (on && all.has(ends[0]) && all.has(ends[1])) links.push({ source: ends[0], target: ends[1] });
  }
  if (s.tags) {
    for (const n of raw.nodes) {
      for (const t of n.tags) {
        const id = `tag:${t}`;
        if (!all.has(id)) all.set(id, { id, name: `#${t}`, path: `#${t}`, tags: [t], ghost: false, tag: true, degree: 0 });
        links.push({ source: n.id, target: id });
      }
    }
  }
  for (const l of links) {
    all.get(l.source)!.degree++;
    all.get(l.target)!.degree++;
  }

  const q = s.search.trim().toLowerCase();
  const alive = new Set<string>();
  for (const n of all.values()) {
    if (n.ghost && s.existingOnly) continue;
    if (q && !n.path.toLowerCase().includes(q)) continue;
    if (!s.orphans && n.degree === 0) continue;
    alive.add(n.id);
  }

  const nodes: GraphNode[] = [];
  for (const id of alive) {
    const n = all.get(id);
    if (!n) continue;
    // The colour key is always set (undefined when no group matches), so a rebuilt node never keeps an old colour.
    nodes.push({ ...n, color: groupColor(n, s.groups) });
  }
  return {
    nodes,
    links: links.filter((l) => alive.has(l.source) && alive.has(l.target)),
  };
}

/** Colour of the first group whose query matches: `path:Folder`, `tag:#x` (nested tags too), or any text in the name or path. */
export function groupColor(n: GraphNode, groups: GraphGroup[]): string | undefined {
  for (const g of groups) {
    const q = g.query.trim().toLowerCase();
    if (q.startsWith("path:")) {
      const part = q.slice(5).trim();
      if (part && n.path.toLowerCase().includes(part)) return g.color;
    } else if (q.startsWith("tag:")) {
      const tag = q.slice(4).trim().replace(/^#/, "");
      if (tag && n.tags.some((t) => t === tag || t.startsWith(`${tag}/`))) return g.color;
    } else if (q && (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))) {
      return g.color;
    }
  }
  return undefined;
}
