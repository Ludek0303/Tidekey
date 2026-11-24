import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import init, { WasmSearch } from "../wasm/notes_web.js";

// Node has no fetch for file: URLs, so init reads the real .wasm through a stubbed fetch (as formula.test.ts does).
beforeAll(async () => {
  const bytes = readFileSync(resolve(__dirname, "../wasm/notes_web_bg.wasm"));
  vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }));
  await init();
  vi.unstubAllGlobals();
});

const LAYER = "---\nschema: notes-filetext-v1\nmethod: pdf-text\n---\n## Strona 1\nFAKTURA VAT, serwer dedykowany.\n\n## Strona 2 · niska jakość\nTermin płatności 14 dni.\n";

describe("WasmSearch (notes-core search over the wasm bridge)", () => {
  it("indexes two notes and one text layer and searches them", () => {
    const s = new WasmSearch();
    s.upsert_note("n1", "Projekty/Budżet.md", "# Budżet\nBudżet projektu na II kwartał.\n");
    s.upsert_note("n2", "Kuchnia/Kawa.md", "# Kawa\nFrench press, mielenie średnie.\n");
    expect(s.upsert_file_text("f1", "Faktura.pdf", "application/pdf", LAYER)).toBe(true);

    const notes = JSON.parse(s.search_json("budzetu", 10, 0, "*"));
    expect(notes.total).toBe(1);
    expect(notes.hits[0]).toMatchObject({ docId: "n1", kind: "note", title: "Projekty/Budżet.md", place: "Budżet" });

    const files = JSON.parse(s.search_json("typ:pdf serwer", 10, 0, "*"));
    expect(files.hits[0]).toMatchObject({ chunkId: "f:f1#s1", kind: "file", docId: "f1", place: "s.1", title: "Faktura.pdf" });

    const outline = JSON.parse(s.outline_json("f1", "*"));
    expect(outline.map((i: { place: string }) => i.place)).toEqual(["s.1", "s.2"]);
    expect(outline[1].lowQuality).toBe(true);
    expect(s.outline_json("brak", "*")).toBe("null");

    const page2 = JSON.parse(s.read_json("f1", 2, undefined, 0, 0, "*"));
    expect(page2.text.startsWith("## Strona 2 · niska jakość")).toBe(true);
    expect(s.read_json("f1", 9, undefined, 0, 0, "*")).toBe("null");
  });

  it("refuses a text layer that does not parse and removes documents", () => {
    const s = new WasmSearch();
    expect(s.upsert_file_text("f2", "x.pdf", "application/pdf", "bez nagłówka")).toBe(false);
    expect(s.outline_json("f2", "*")).toBe("null");
    s.upsert_note("n3", "a.md", "# Koszty\nSerwer dedykowany.\n");
    s.remove_note("n3");
    s.remove_file("f2");
    expect(JSON.parse(s.search_json("serwer", 10, 0, "*")).total).toBe(0);
  });

  it("hides everything outside a scope, and treats malformed scope JSON as empty", () => {
    const s = new WasmSearch();
    s.upsert_note("n1", "Jawny/Plan.md", "# Plan\nBudżet jawny.\n");
    s.upsert_note("n2", "Tajne/Plan.md", "# Tajny\nBudżet tajny.\n");
    s.set_links("n1", JSON.stringify(["n2"]));
    s.set_file("f9", "Skan.pdf", "application/pdf", "pending");
    const scope = JSON.stringify({ notes: ["n1"], files: [] });
    expect(JSON.parse(s.search_json("budzet", 10, 0, scope)).hits.map((h: { docId: string }) => h.docId)).toEqual(["n1"]);
    expect(s.outline_json("n2", scope)).toBe("null");
    expect(s.read_json("n2", undefined, undefined, 0, 0, scope)).toBe("null");
    const graph = JSON.parse(s.neighbors_json("n1", 2, "", 30, scope));
    expect(graph).not.toBeNull();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(graph)).not.toContain("Tajne");
    expect(JSON.stringify(graph)).not.toContain("tajny");
    const map = JSON.parse(s.map_json(scope));
    expect(map.filesTotal).toBe(0);
    expect(map.folders).toEqual([{ path: "Jawny", notes: 1 }]);
    expect(JSON.parse(s.find_files_json("", "", "", 10, 0, scope)).total).toBe(0);
    expect(JSON.parse(s.find_files_json("", "", "", 10, 0, "*")).total).toBe(1);
    // Malformed scope JSON: nothing is visible (never everything).
    // "" (a caller that forgot the scope) and malformed JSON: nothing is visible (never everything); only "*" is all
    for (const bad of ["", "{", "[1,2", "not json", "42", "null"]) {
      expect(JSON.parse(s.search_json("budzet", 10, 0, bad)).total).toBe(0);
      expect(s.outline_json("n1", bad)).toBe("null");
      expect(JSON.parse(s.map_json(bad)).folders).toEqual([]);
    }
  });

  it("builds edges from links, tags, tasks and embeds", () => {
    const s = new WasmSearch();
    s.upsert_note("a", "P/A.md", "---\ntags: [x]\n---\nTekst.\n- [ ] coś @ola\n![[plik:0123456789abcdef0123456789abcdef]]\n");
    s.upsert_note("b", "P/Druga.md", "Odnośnik do Druga.\n");
    s.set_links("a", JSON.stringify(["b"]));
    s.set_file("0123456789abcdef0123456789abcdef", "Faktura.pdf", "application/pdf", "text");
    const n = JSON.parse(s.neighbors_json("n:a", 1, "link,embed", 30, "*"));
    const kinds = n.edges.map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(["embed", "link"]);
    expect(s.set_links("a", "{bez")).toBe(false);
    expect(s.set_people('["Ola"]')).toBe(true);
  });

  it("with a scope, knows only the people the scope lists or its notes name", () => {
    const s = new WasmSearch();
    s.upsert_note("a", "A.md", "Spotkanie z Kowalskim i Kowalski dzwonił.\n");
    s.set_people(JSON.stringify(["Kowalski"]));
    const people = (scope: string) => JSON.stringify(JSON.parse(s.map_json(scope)).people);
    expect(people("*")).toContain("kowalski");
    expect(people(JSON.stringify({ notes: ["a"], files: [] }))).not.toContain("kowalski");
    expect(people(JSON.stringify({ notes: ["a"], files: [], people: ["@Kowalski"] }))).toContain("kowalski");
  });
});
