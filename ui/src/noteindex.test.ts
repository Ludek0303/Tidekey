import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MockBridge, type TreeListing } from "./bridge";
import { NoteIndex, setGithubGuard, type RawGraph } from "./noteindex";
import { guardedLines } from "./github/core";

// Node has no fetch for file: URLs, so init reads the real .wasm through a stubbed fetch.
beforeAll(async () => {
  const bytes = readFileSync(resolve(__dirname, "wasm/notes_web_bg.wasm"));
  vi.stubGlobal(
    "fetch",
    async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }),
  );
  await new NoteIndex(new MockBridge([])).start();
  vi.unstubAllGlobals();
});

async function started(): Promise<{ bridge: MockBridge; idx: NoteIndex }> {
  const bridge = new MockBridge();
  const idx = new NoteIndex(bridge);
  await idx.start();
  return { bridge, idx };
}

const idOf = async (bridge: MockBridge, path: string): Promise<string> => {
  const { notes } = await bridge.call<TreeListing>("list_tree");
  return notes.find((n) => n.path === path)!.id;
};

const paths = (g: RawGraph | null): string[] => g!.nodes.map((n) => n.path).sort();

describe("note index sync", () => {
  it("indexes every note and its links at start", async () => {
    const { idx } = await started();
    const g = idx.graph()!;
    expect(paths(g)).toEqual(["Dziennik/2026-10-18.md", "Notatka bez folderu.md", "Projekty/Plan.md", "Projekty/Pomysły.md", "Projekty/Sonda/Sonda.md", "Projekty/Spotkanie.md"]);
    expect(g.ghosts).toEqual([]);
    expect(g.edges.length).toBeGreaterThan(0);
  });

  it("the parsed graph is reused until the index changes", async () => {
    const { bridge, idx } = await started();
    const first = idx.graph();
    expect(idx.graph()).toBe(first);
    await bridge.call("create_note", { path: "Cache.md" });
    await idx.sync();
    expect(idx.graph()).not.toBe(first);
  });

  it("a created note joins the index", async () => {
    const { bridge, idx } = await started();
    await bridge.call("create_note", { path: "Nowa.md" });
    await idx.sync();
    expect(paths(idx.graph())).toContain("Nowa.md");
  });

  it("a renamed note keeps its links under the new path", async () => {
    const { bridge, idx } = await started();
    const id = await idOf(bridge, "Projekty/Plan.md");
    await bridge.call("rename", { id, path: "Projekty/Plan2.md" });
    await idx.sync();
    const g = idx.graph()!;
    expect(paths(g)).toContain("Projekty/Plan2.md");
    expect(paths(g)).not.toContain("Projekty/Plan.md");
    expect(g.edges.some(([s, t]) => s === id || t === id)).toBe(true);
  });

  it("a deleted note leaves the index, and links to it become ghosts", async () => {
    const { bridge, idx } = await started();
    const id = await idOf(bridge, "Projekty/Spotkanie.md");
    await bridge.call("delete", { id });
    await idx.sync();
    const g = idx.graph()!;
    expect(paths(g)).not.toContain("Projekty/Spotkanie.md");
    expect(g.ghosts.map((x) => x.name)).toContain("Spotkanie");
  });

  it("an edit of the open note reaches the index after flush", async () => {
    const { bridge, idx } = await started();
    const id = await idOf(bridge, "Projekty/Plan.md");
    idx.edited(id, "# Plan\n\nZobacz [[Nowy temat]]\n");
    expect(idx.graph()!.ghosts.map((x) => x.name)).not.toContain("Nowy temat");
    idx.flush();
    expect(idx.graph()!.ghosts.map((x) => x.name)).toContain("Nowy temat");
  });

  it("an edit is written by itself after the 300 ms pause", async () => {
    const { bridge, idx } = await started();
    const id = await idOf(bridge, "Projekty/Pomysły.md");
    idx.edited(id, "[[Dalej]]");
    await new Promise((r) => setTimeout(r, 350));
    expect(idx.graph()!.ghosts.map((x) => x.name)).toContain("Dalej");
  });
});

describe("kanban boards in the index", () => {
  it("a note with typ: kanban is a board after an edit, and stops being one when the edit drops it", async () => {
    const { bridge, idx } = await started();
    const id = await idOf(bridge, "Projekty/Plan.md");
    expect(idx.isKanban(id)).toBe(false);
    idx.edited(id, "---\ntyp: kanban\n---\nTablica\n");
    idx.flush();
    expect(idx.isKanban(id)).toBe(true);
    idx.edited(id, "# Plan\n");
    idx.flush();
    expect(idx.isKanban(id)).toBe(false);
  });
});

describe("notes from GitHub (docs/GITHUB.md §9)", () => {
  it("takes no task or mention from GitHub's lines; the same line added in the notebook counts", async () => {
    const { bridge, idx } = await started();
    const fromGithub = "# Plan\n- [ ] Zrób X @Ania\n";
    const id = await bridge.call<string>("create_note", { path: "Projekty/GitHub/plan.md" });
    await idx.sync();
    const guarded = guardedLines(fromGithub);
    expect(guarded).toHaveLength(1);
    setGithubGuard((noteId) => (noteId === id ? guarded : null));
    try {
      const tasksOf = () => idx.tasks()!.tasks.filter((t) => t.note === id);
      idx.edited(id, fromGithub);
      idx.flush();
      expect(tasksOf()).toEqual([]);
      idx.edited(id, `${fromGithub}- [ ] Zrób X @Ania\n`);
      idx.flush();
      expect(tasksOf()).toHaveLength(1);
      expect(tasksOf()[0].line).toBe(3);
    } finally {
      setGithubGuard(() => null);
    }
  });

  it("indexes a note again when its guard arrives after its text", async () => {
    const bridge = new MockBridge();
    const text = "- [ ] Z repozytorium @Ania\n";
    const id = await bridge.call<string>("create_note", { path: "Projekty/GitHub/b.md" });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
    const idx = new NoteIndex(bridge);
    await idx.start();
    expect(idx.tasks()!.tasks.filter((t) => t.note === id)).toHaveLength(1);
    setGithubGuard((noteId) => (noteId === id ? guardedLines(text) : null));
    try {
      await idx.sync();
      expect(idx.tasks()!.tasks.filter((t) => t.note === id)).toEqual([]);
    } finally {
      setGithubGuard(() => null);
    }
  });
});
