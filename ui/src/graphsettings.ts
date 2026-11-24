// Graph view options, as in Obsidian's graph panel. Shared by the global and the local graph; kept in localStorage.

export interface GraphGroup {
  query: string;
  color: string;
}

export interface GraphSettings {
  search: string;
  tags: boolean;
  existingOnly: boolean;
  orphans: boolean;
  // Files, people and mentions from the search index (OCR §4.4); off by default so the graph does not thicken.
  files: boolean;
  people: boolean;
  mentions: boolean;
  arrows: boolean;
  textFade: number;
  nodeSize: number;
  linkWidth: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  groups: GraphGroup[];
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  search: "",
  tags: false,
  existingOnly: false,
  orphans: true,
  files: true,
  people: false,
  mentions: false,
  arrows: false,
  textFade: 40,
  nodeSize: 1,
  linkWidth: 1,
  centerForce: 0.5,
  repelForce: 150,
  linkForce: 0.5,
  linkDistance: 80,
  groups: [],
};

const STORAGE_KEY = "notes.graph.v1";
const COLOR = /^#[0-9a-f]{6}$/i;

const isGroup = (g: unknown): g is GraphGroup =>
  typeof g === "object" &&
  g !== null &&
  typeof (g as GraphGroup).query === "string" &&
  typeof (g as GraphGroup).color === "string" &&
  COLOR.test((g as GraphGroup).color);

// Each stored key is kept only if its type matches the default; anything else falls back to the default.
function load(): GraphSettings {
  const out: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, groups: [] };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_GRAPH_SETTINGS) as (keyof GraphSettings)[]) {
      if (key !== "groups" && typeof stored[key] === typeof DEFAULT_GRAPH_SETTINGS[key]) Object.assign(out, { [key]: stored[key] });
    }
    if (Array.isArray(stored.groups)) out.groups = stored.groups.filter(isGroup).map((g) => ({ query: g.query, color: g.color }));
  } catch {
    // Storage may be blocked or hold junk; the defaults are good enough.
  }
  return out;
}

let current = load();
const listeners = new Set<(s: GraphSettings) => void>();

export function getGraphSettings(): GraphSettings {
  return current;
}

// Stores the settings and tells both graph views; storage that cannot be written still applies for this session.
export function setGraphSettings(next: GraphSettings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Not persisted, but the change still applies for this session.
  }
  for (const cb of listeners) cb(current);
}

export function onGraphSettings(cb: (s: GraphSettings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
