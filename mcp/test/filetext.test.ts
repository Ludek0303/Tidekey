// The text of files for a chat (docs/OCR.md §5.2–§5.4): the visibility rule and the checks of each layer, with real
// envelopes and ciphertexts made by the browser's own functions.
import { describe, expect, it } from "vitest";
import { cipherSize, newFileKey, sealFile, sealMeta, textLayerId, type FileMeta } from "../../ui/src/filecrypto";
import { serialize } from "../../ui/src/ocr/filetext";
import { importVaultKey } from "../../ui/src/vaults";
import { AgentError } from "../src/client";
import { embedsOf, fileVisible, loadFileTexts } from "../src/filetext";
import type { NoteView, VaultView } from "../src/session";

const VAULT = "v-0123456789abcdef0123456789abcdef";
const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const SECRET = "TAJNA-TRESC-SKANU";

async function gzip(text: string): Promise<Blob> {
  return new Blob([await new Response(new Response(text).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()]);
}
async function collect(parts: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const list: Uint8Array[] = [];
  for await (const p of parts) list.push(p);
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of list) { out.set(p, at); at += p.length; }
  return out;
}

interface Rec { id: string; state: string; size: number; meta: string; parent?: string | null; kind?: string | null; scope: string | null; createdAt: number; createdBy: string | null }

/** A vault with files: records as the server lists them, and the ciphertexts it serves. */
async function world() {
  const vaultKey = await importVaultKey(crypto.getRandomValues(new Uint8Array(32)));
  const records: Rec[] = [];
  const bodies = new Map<string, Uint8Array>();
  const fetched: string[] = [];
  const base = (name: string, mime: string, size: number, key: string): FileMeta =>
    ({ format: 2, version: 1, name, mime, size, project: null, key, createdAt: 1 }) as FileMeta;
  async function original(name: string, project: string | null = null): Promise<{ id: string; key: string }> {
    const id = hex();
    const key = await newFileKey();
    records.push({ id, state: "ready", size: cipherSize(10), meta: await sealMeta(VAULT, id, { keyEpoch: 1 }, vaultKey, { ...base(name, "application/pdf", 10, key), project }), scope: null, createdAt: 1, createdBy: "u" });
    return { id, key };
  }
  async function layer(of: { id: string; key: string }, markdown: string, opts: { extractor?: number; id?: string } = {}): Promise<string> {
    const extractor = opts.extractor ?? 1;
    const id = opts.id ?? await textLayerId(of.key, of.id, extractor);
    const key = await newFileKey();
    const gz = await gzip(markdown);
    const cipher = await collect(sealFile(gz, key, VAULT, id, null));
    bodies.set(id, cipher);
    const meta: FileMeta = { ...base("x.tekst.md", "text/markdown", gz.size, key), textOf: of.id, extractor, method: "ocr", pages: 1, lang: "latin", quality: 1, flags: [], engine: "pp-ocrv5", encoding: "gzip" };
    records.push({ id, state: "ready", size: cipher.length, meta: await sealMeta(VAULT, id, { keyEpoch: 1 }, vaultKey, meta), parent: of.id, kind: "text", scope: null, createdAt: 2, createdBy: "u" });
    return id;
  }
  const client = {
    async request<T>(_method: string, path: string): Promise<T> {
      if (path !== `/api/agent/vaults/${VAULT}/files`) throw new AgentError("scope", "scope", 404);
      return { files: records } as T;
    },
    async requestBytes(path: string, max: number): Promise<Uint8Array> {
      fetched.push(path);
      const id = path.split("/").at(-2)!;
      const body = bodies.get(id);
      if (!body || body.length > max) throw new AgentError("scope", "scope", 404);
      return body;
    },
  };
  const view = (notes: NoteView[], over: Partial<VaultView> = {}): VaultView => ({
    id: VAULT, name: "Klub", kind: "organizacja", ownerUserId: "u", keyEpoch: 1, role: "editor", writeMode: "none",
    scope: { schema: "notes-agent-scope-v1", agentId: "a", vaultId: VAULT, include: [], exclude: [], tools: [], tasks: "all", updatedAt: 1 },
    person: { userId: "u", signingKey: {}, boxKey: {} }, members: [], keys: new Map([[1, vaultKey]]), revision: 1, snapshot: null,
    projects: [], locked: [], notes, fetchedAt: 1, allowProtected: true, scopeHash: "", fileText: true, layers: new Map(), files: null, filesAt: 0, trashedEmbeds: new Set(), filesLoading: null, ...over,
  });
  return { records, bodies, fetched, client, original, layer, view };
}
const md = (source: string, text: string, extractor = 1) => serialize({
  source, name: "Skan.pdf", mime: "application/pdf", method: "ocr", pages: [{ n: 1, text, lowQuality: false }], lang: "latin",
  quality: 1, flags: [], extractor, engine: "pp-ocrv5", createdAt: "2026-11-23T10:00:00Z",
});
const note = (id: string, path: string, text: string): NoteView => ({ id, path, text, project: null });

describe("which files a chat sees (OCR §5.2)", () => {
  it("reads embeds with and without the embed id and size", () => {
    const a = "0123456789abcdef0123456789abcdef";
    expect(embedsOf(`Faktura ![[plik:${a}#0a1b2c3d|300]] i znowu ![[plik:${a}]], nie ![[plik:krótki]]`)).toEqual([a, a]);
  });

  it("a file embedded by a note in scope, or embedded nowhere with its project in scope", () => {
    const all = new Map([["f1", ["n1", "n2"]], ["f2", ["n2"]]]);
    const seen = new Map([["f1", ["n1"]]]);
    const inScope = (p: string | null) => p === "Jawny";
    expect(fileVisible("f1", { project: null }, all, seen, inScope)).toBe(true);
    // embedded only by a hidden note: hidden, whatever its project
    expect(fileVisible("f2", { project: "Jawny" }, all, seen, inScope)).toBe(false);
    expect(fileVisible("f3", { project: "Jawny" }, all, seen, inScope)).toBe(true);
    expect(fileVisible("f4", { project: "Tajne" }, all, seen, inScope)).toBe(false);
  });
});

describe("loadFileTexts", () => {
  it("gives the visible files with their checked text and fetches nothing else", async () => {
    const w = await world();
    const shown = await w.original("Faktura.pdf");
    const hidden = await w.original("Tajna.pdf");
    const layerShown = await w.layer(shown, md(shown.id, "Razem do zapłaty 1240 zł"));
    await w.layer(hidden, md(hidden.id, SECRET));
    const view = w.view([note("n1", "Jawny/Budżet.md", `![[plik:${shown.id}]]`), note("n2", "Tajne/Plan.md", `![[plik:${hidden.id}]]`)]);
    const visible = (p: string) => p.startsWith("Jawny");
    const out = await loadFileTexts(view, w.client, visible, view.layers);
    expect(out.files.map((f) => f.id)).toEqual([shown.id]);
    expect(out.files[0]).toMatchObject({ name: "Faktura.pdf", embeddedIn: ["n1"] });
    expect(out.files[0].markdown).toContain("Razem do zapłaty");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(w.fetched).toEqual([`/api/agent/vaults/${VAULT}/files/${layerShown}/content`]);
    // a second pass reads from the cache
    await loadFileTexts(view, w.client, visible, view.layers);
    expect(w.fetched).toHaveLength(1);
  });

  it("without the permission asks the server for nothing", async () => {
    const w = await world();
    let asked = false;
    const client = { ...w.client, request: async () => { asked = true; return { files: [] } as never; } };
    const out = await loadFileTexts(w.view([], { fileText: false }), client, () => true, new Map());
    expect(out.files).toEqual([]);
    expect(asked).toBe(false);
  });

  it("ignores a layer at an id not derived from the file's key, a layer of another file, and one that does not read", async () => {
    const w = await world();
    const file = await w.original("Skan.pdf");
    const other = await w.original("Inny.pdf");
    // a member's own "layer" at a random id with a higher extractor
    await w.layer(file, md(file.id, "PODSTAWIONY TEKST", 1), { id: hex() });
    // the other file's text sealed as a layer of this one
    await w.layer(file, md(other.id, "CUDZY TEKST"), { extractor: 1 });
    const view = w.view([], {});
    const out = await loadFileTexts(view, w.client, () => true, view.layers);
    const text = out.files.find((f) => f.id === file.id)?.markdown ?? "";
    expect(text).not.toContain("PODSTAWIONY");
    expect(text).not.toContain("CUDZY");
    expect(out.files.find((f) => f.id === file.id)?.markdown).toBeNull();
  });

  it("stops the pass at the server's limit and keeps what it read", async () => {
    const w = await world();
    const a = await w.original("A.pdf");
    const b = await w.original("B.pdf");
    await w.layer(a, md(a.id, "Tekst A"));
    await w.layer(b, md(b.id, "Tekst B"));
    let n = 0;
    const client = { ...w.client, requestBytes: async (path: string, max: number) => {
      if (n++ > 0) throw new AgentError("limit", "limit", 429);
      return w.client.requestBytes(path, max);
    } };
    const view = w.view([]);
    const out = await loadFileTexts(view, client, () => true, view.layers);
    expect(out.read).toBe(1);
    expect(out.layers).toBe(2);
    expect(out.files.filter((f) => f.markdown !== null)).toHaveLength(1);
  });
});
