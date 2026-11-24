import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../bridge";
import { MemoryFileStore } from "../filestore";
import init from "../wasm/notes_web.js";
import { emit } from "../bus";
import { AppSearch, firstTerm, pageOf } from "./appsearch";
import { serialize } from "./filetext";

// Node has no fetch for file: URLs, so init reads the real .wasm through a stubbed fetch (as search.wasm.test.ts does).
beforeAll(async () => {
  const bytes = readFileSync(resolve(__dirname, "../wasm/notes_web_bg.wasm"));
  vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }));
  await init();
  vi.unstubAllGlobals();
});

const ID = "d".repeat(32);
const ID2 = "e".repeat(32);
const fields = { extractor: 1, method: "pdf-text" as const, pages: 1, lang: "latin" as const, quality: 1, flags: [], engine: "pdf.js" };
const layerOf = (source: string, text: string) =>
  serialize({ source, name: "Faktura.pdf", mime: "application/pdf", method: "pdf-text", pages: [{ n: 1, text, lowQuality: false }], lang: "latin", quality: 1, flags: [], extractor: 1, engine: "pdf.js", createdAt: "2026-11-19T15:02:11Z" });
const pdf = (name: string) => new File([new Uint8Array(10)], name, { type: "application/pdf" });

// A bridge with two notes; the file store is the in-memory one (it keeps the text layers).
function setup(texts: Record<string, string>) {
  const files = new MemoryFileStore("ana");
  const tree = Object.keys(texts).map((id) => ({ id, path: `${id}.md` }));
  const call = vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === "list_tree") return { notes: tree, folders: [], files: [] };
    if (cmd === "note_text") return texts[(args as { id: string }).id];
    throw new Error(`unexpected ${cmd}`);
  });
  const bridge = { call, on: () => () => undefined, files } as unknown as Bridge;
  return { files, bridge, app: new AppSearch(bridge) };
}

describe("AppSearch (notes and text layers of the files in one index)", () => {
  it("finds a file by its text layer, filters by kind, and drops a file in the trash", async () => {
    const { files, app } = setup({ n1: "# Koszty\nSerwer dedykowany.\n" });
    const info = await files.upload(pdf("Faktura.pdf"), { id: ID });
    await files.writeTextLayer(info.id, layerOf(info.id, "FAKTURA VAT, termin płatności 14 dni."), fields);
    expect(await app.ensure()).toBe(true);
    await app.syncFiles();

    const hits = app.search("platnosci", 10);
    expect(hits?.hits).toHaveLength(1);
    expect(hits?.hits[0]).toMatchObject({ kind: "file", docId: ID, title: "Faktura.pdf", place: "s.1" });
    expect(app.search("w:notatki platnosci", 10)?.hits).toHaveLength(0);
    expect(app.search("serwer", 10)?.hits.map((h) => h.kind)).toEqual(["note"]);
    expect(app.fileProgress()).toEqual({ done: 1, total: 1 });

    await files.trash(info.id);
    await app.syncFiles();
    expect(app.search("platnosci", 10)?.hits).toHaveLength(0);
  });

  it("shows a layer written later without rebuilding the index, and lists the notes that embed a file", async () => {
    const { files, app, bridge } = setup({ n1: `Umowa ![[plik:${ID2}]]\n` });
    const pending = await files.upload(pdf("Skan.pdf"), { id: ID2 });
    await app.ensure();
    await app.syncFiles();
    expect(app.search("kontrahent", 10)?.hits).toHaveLength(0);
    expect(app.fileProgress()).toEqual({ done: 1, total: 1 });
    expect(app.embedsOf(pending.id)).toEqual(["n1.md"]);

    await files.writeTextLayer(pending.id, layerOf(pending.id, "Kontrahent Zielony."), fields);
    emit("ocr:status", { fileId: pending.id, status: "tekst", detail: "" });
    await app.syncFiles();
    expect(app.search("kontrahent", 10)?.hits[0]).toMatchObject({ kind: "file", docId: ID2 });
    expect(bridge.call).toHaveBeenCalledWith("list_tree");
  });

  it("follows notes: an edit replaces the text, a removed note leaves the index", async () => {
    const { app } = setup({ n1: "# A\nZielony.\n" });
    await app.ensure();
    expect(app.search("zielony", 10)?.hits).toHaveLength(1);
    emit("index:edited", { id: "n1", text: "# A\nNiebieski.\n" });
    expect(app.search("zielony", 10)?.hits).toHaveLength(0);
    expect(app.search("niebieski", 10)?.hits).toHaveLength(1);
  });
});

describe("helpers for the file hits", () => {
  it("takes the first plain word of a query and the page of a hit", () => {
    expect(firstTerm('typ:pdf "Termin płatności" -szkic')).toBe("Termin");
    expect(firstTerm("typ:pdf")).toBe("");
    expect(pageOf("s.3")).toBe(3);
    expect(pageOf("")).toBe(1);
  });
});

describe("AppSearch edges (the map of the graph view)", () => {
  it("gives the embeds of a note and the mentions of a file, once the index is loaded", async () => {
    const { files, app } = setup({ n1: `Umowa ![[plik:${ID}]]\n`, n2: "# Umowa\nTekst.\n" });
    await files.upload(pdf("Faktura.pdf"), { id: ID });
    expect(app.edges()).toBeNull();
    await app.ensure();
    await app.syncFiles();
    const map = app.edges();
    expect(map?.edges).toContainEqual({ from: "n:n1", to: `f:${ID}`, kind: "embed" });
    expect(map?.nodes).toContainEqual({ id: `f:${ID}`, kind: "file", label: "Faktura.pdf" });
  });
});
