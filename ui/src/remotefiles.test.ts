// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CIPHER_CHUNK, PLAIN_CHUNK, keySecret, migrationId, openMeta, scopeOf, sealMeta, textLayerId } from "./filecrypto";
import { RemoteFileStore, migrateAttachments, type FileKeys, type ProjectRef } from "./remotefiles";
import { MemoryFileStore, newFileId, type FileStore } from "./filestore";
import { serialize } from "./ocr/filetext";
import { MockBridge } from "./bridge";
import { ApiError } from "./vaults";

const VAULT = `v-${"a".repeat(32)}`;
const noSleep = async () => undefined;
const aesKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const MARKER = "PLAINTEXT-MARKER-7f3a";

// ---- an in-test server that follows docs/PLIKI.md §3 and keeps only what the client sends --------------------------

interface Rec { id: string; state: "uploading" | "ready" | "trashed"; size: number; chunks: number; received: number; scope: string | null; meta: string; createdBy: string; createdAt: number; completedAt: number | null; deletedAt: number | null; parts: Uint8Array[]; parent: string | null; kind?: string | null }
class FakeServer {
  records = new Map<string, Rec>();
  scopes = new Map<string, string[]>();
  calls: { method: string; path: string; status: number }[] = [];
  // the query of the request being answered (`?kinds=text` lists the text layers, as notes-node does)
  private query = "";
  // Every chunk PUT as it arrived, failed attempts included.
  wires: { id: string; n: number; bytes: Uint8Array }[] = [];
  // Chunk failures to inject: "<fileId>/<n>" → how many network errors come first.
  failures = new Map<string, number>();

  fetchFor(user: string): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input), "https://notes.test");
      const method = init?.method ?? "GET";
      const body = init?.body;
      this.query = url.search;
      const res = await this.route(user, method, url.pathname, body as string | ArrayBuffer | undefined, init?.signal ?? undefined);
      this.calls.push({ method, path: url.pathname, status: res.status });
      return res;
    };
  }

  private visible(rec: Rec, user: string): boolean {
    return rec.scope === null || (this.scopes.get(rec.scope) ?? []).includes(user);
  }
  private view(rec: Rec) {
    const { parts: _parts, ...rest } = rec;
    return rest;
  }
  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }
  private error(status: number, message: string): Response { return this.json({ error: message }, status); }

  private async route(user: string, method: string, path: string, body: string | ArrayBuffer | undefined, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new DOMException("Anulowano", "AbortError");
    const scopeMatch = /^\/api\/vaults\/[^/]+\/file-scopes\/([0-9a-f]{32})$/.exec(path);
    if (scopeMatch && method === "PUT") {
      const members = (JSON.parse(body as string) as { members: string[] }).members;
      const known = this.scopes.get(scopeMatch[1]);
      if (known && !known.includes(user)) return this.error(403, "Nie jesteś członkiem tego zakresu.");
      this.scopes.set(scopeMatch[1], members);
      return this.json({ scope: scopeMatch[1], members });
    }
    if (path.endsWith("/files") && method === "GET") {
      const withText = this.query.includes("kinds=text");
      const files = [...this.records.values()].filter((r) => this.visible(r, user) && (r.state !== "uploading" || r.createdBy === user) && (withText || r.kind !== "text")).map((r) => this.view(r));
      return this.json({ files, used: [...this.records.values()].reduce((n, r) => n + r.size, 0), quota: null, trashDays: 30 });
    }
    if (path.endsWith("/files") && method === "POST") {
      const req = JSON.parse(body as string) as { id: string; size: number; meta: string; scope?: string; parent?: string; kind?: string };
      const known = this.records.get(req.id);
      if (known) {
        if (known.createdBy === user && known.size === req.size) return this.json(this.view(known), 200);
        return this.error(409, "Identyfikator jest zajęty.");
      }
      if (req.scope && !(this.scopes.get(req.scope) ?? []).includes(user)) return this.error(403, "Nie należysz do zakresu.");
      // The stored size is 32 + plaintext + 17 per chunk, so this gives the chunk count back (docs/PLIKI.md §2).
      const rec: Rec = { id: req.id, state: "uploading", size: req.size, chunks: Math.max(1, Math.ceil((req.size - 32) / CIPHER_CHUNK)), received: 0, scope: req.scope ?? null, meta: req.meta, createdBy: user, createdAt: 1, completedAt: null, deletedAt: null, parts: [], parent: req.parent ?? null, kind: req.kind ?? null };
      this.records.set(rec.id, rec);
      return this.json(this.view(rec), 201);
    }
    const chunk = /^\/api\/vaults\/[^/]+\/files\/([0-9a-f]{32})\/chunks\/(\d+)$/.exec(path);
    if (chunk && method === "PUT") {
      const rec = this.records.get(chunk[1]);
      const n = Number(chunk[2]);
      if (!rec || rec.createdBy !== user) return this.error(404, "Nie ma takiego pliku.");
      const data = new Uint8Array(body as ArrayBuffer);
      this.wires.push({ id: rec.id, n, bytes: data });
      const left = this.failures.get(`${rec.id}/${n}`) ?? 0;
      if (left > 0) { this.failures.set(`${rec.id}/${n}`, left - 1); throw new TypeError("network down"); }
      if (n < rec.received) return this.json({ received: rec.received }, 200);
      if (n > rec.received) return this.json({ received: rec.received }, 409);
      rec.parts.push(data);
      rec.received++;
      return this.json({ received: rec.received }, 200);
    }
    const complete = /^\/api\/vaults\/[^/]+\/files\/([0-9a-f]{32})\/complete$/.exec(path);
    if (complete && method === "POST") {
      const rec = this.records.get(complete[1]);
      if (!rec || rec.createdBy !== user) return this.error(404, "Nie ma takiego pliku.");
      if (rec.received !== rec.chunks) return this.error(400, "Brakuje porcji.");
      rec.state = "ready"; rec.completedAt = 2;
      return this.json(this.view(rec));
    }
    const content = /^\/api\/vaults\/[^/]+\/files\/([0-9a-f]{32})\/content$/.exec(path);
    if (content && method === "GET") {
      const rec = this.records.get(content[1]);
      if (!rec || !this.visible(rec, user)) return this.error(404, "Nie ma takiego pliku.");
      const all = new Uint8Array(rec.parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of rec.parts) { all.set(p, off); off += p.length; }
      return new Response(all, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    const one = /^\/api\/vaults\/[^/]+\/files\/([0-9a-f]{32})(\/restore|\/purge)?$/.exec(path);
    if (one) {
      const rec = this.records.get(one[1]);
      if (!rec || !this.visible(rec, user)) return this.error(404, "Nie ma takiego pliku.");
      if (method === "GET") return this.json(this.view(rec));
      if (method === "PATCH") { rec.meta = (JSON.parse(body as string) as { meta: string }).meta; return this.json(this.view(rec)); }
      if (method === "DELETE") {
        if (rec.state === "uploading") { for (const r of this.family(rec)) this.records.delete(r.id); return this.json({}); }
        for (const r of this.family(rec)) { r.state = "trashed"; r.deletedAt = 3; }
        return this.json(this.view(rec));
      }
      if (method === "POST" && one[2] === "/restore") { for (const r of this.family(rec)) { r.state = "ready"; r.deletedAt = null; } return this.json(this.view(rec)); }
      if (method === "POST" && one[2] === "/purge") { for (const r of this.family(rec)) this.records.delete(r.id); return this.json({}); }
    }
    return this.error(404, "Nie ma takiego zasobu.");
  }

  // The file and its thumbnail: the server moves them together.
  family(rec: Rec): Rec[] { return [...this.records.values()].filter((r) => r === rec || r.parent === rec.id); }

  stored(): string {
    // Everything the server keeps as text or bytes, for the check that the plaintext never reaches it.
    const dec = new TextDecoder("utf-8", { fatal: false });
    return [...this.records.values()].map((r) => r.meta + r.parts.map((p) => dec.decode(p)).join("")).join("\n");
  }
}

function keysFor(vaultKey: CryptoKey, epoch = 1, projects: ProjectRef[] = []): FileKeys {
  return {
    vault: () => ({ key: vaultKey, keyEpoch: epoch }),
    vaultKey: async (e) => (e === epoch ? vaultKey : null),
    projects: async () => projects,
  };
}
const fileOf = (parts: (string | Uint8Array)[], name = "notatki.txt", type = "text/plain") =>
  new File(parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p)) as BlobPart[], name, { type });

function storeFor(server: FakeServer, user: string, keys: FileKeys): RemoteFileStore {
  return new RemoteFileStore({ vaultId: VAULT, who: user, keys, fetch: server.fetchFor(user), sleep: noSleep });
}

// Byte comparison by hand: deep equality is slow on megabytes and fails across jsdom's realms.
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
async function readText(blob: Blob): Promise<Uint8Array> { return new Uint8Array(await blob.arrayBuffer()); }

describe("RemoteFileStore", () => {
  it("uploads 2.5 MiB in chunks and reads it back equal", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const data = new Uint8Array(2.5 * PLAIN_CHUNK).map((_, i) => (i * 31) & 0xff);
    const progress: number[] = [];
    const info = await store.upload(new File([data], "duzy.bin", { type: "application/octet-stream" }), { id: "1".repeat(32), onProgress: (sent) => progress.push(sent) });
    expect(info).toMatchObject({ name: "duzy.bin", size: data.length, state: "ready", project: null });
    expect(progress.at(-1)).toBe(data.length);
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(3);
    expect(same(await readText(await store.read(info.id)), data)).toBe(true);
  });

  it("keeps the content and the name off the server", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const name = `tajny-${MARKER}.txt`;
    await store.upload(fileOf([`${MARKER} ${"x".repeat(100)}`], name), { id: "2".repeat(32) });
    expect(server.stored()).not.toContain(MARKER);
    expect(server.stored()).not.toContain("tajny");
  });

  it("uploads an empty file and reads it back empty", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const info = await store.upload(fileOf([], "pusty.txt"), { id: "3".repeat(32) });
    expect(info.size).toBe(0);
    expect((await store.read(info.id)).size).toBe(0);
  });

  it("refuses a chunk that was altered, reordered or cut on the server", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "4".repeat(32);
    await store.upload(new File([new Uint8Array(PLAIN_CHUNK + 10).fill(5)], "dwa.bin"), { id });
    const rec = server.records.get(id)!;
    const [first, second] = rec.parts;
    rec.parts[0] = first.slice(); rec.parts[0][9] ^= 1;
    await expect(store.read(id)).rejects.toThrow("uszkodzony");
    rec.parts = [second, first];
    await expect(store.read(id)).rejects.toThrow("uszkodzony");
    rec.parts = [first];
    await expect(store.read(id)).rejects.toThrow("uszkodzony");
    // bytes after the final chunk: a whole read rejects them; a head that never reaches the end does not see them
    rec.parts = [first, second, new Uint8Array([1, 2, 3])];
    await expect(store.read(id)).rejects.toThrow("uszkodzony");
    const head = await store.readHead(id, PLAIN_CHUNK);
    expect(head.complete).toBe(false);
    expect(head.blob.size).toBe(PLAIN_CHUNK);
  });

  it("starts an unfinished upload again when the same id is uploaded, with a new key", async () => {
    const server = new FakeServer();
    const vaultKey = await aesKey();
    const store = storeFor(server, "ana", keysFor(vaultKey));
    const id = "5".repeat(32);
    const data = new Uint8Array(2 * PLAIN_CHUNK + 5).fill(9);
    server.failures.set(`${id}/1`, 4); // more than the retries: the first try fails
    await expect(store.upload(new File([data], "p.bin"), { id })).rejects.toThrow();
    const firstKey = (await openMeta(VAULT, id, server.records.get(id)!.meta, async () => vaultKey))?.key;
    expect(server.records.get(id)).toMatchObject({ state: "uploading", received: 1 });
    const info = await store.upload(new File([data], "p.bin"), { id });
    expect(info.state).toBe("ready");
    expect(server.calls.some((c) => c.method === "DELETE" && c.path.endsWith(id))).toBe(true);
    const secondKey = (await openMeta(VAULT, id, server.records.get(id)!.meta, async () => vaultKey))?.key;
    expect(secondKey).toBeDefined();
    expect(secondKey).not.toBe(firstKey);
    expect(same(await readText(await store.read(id)), data)).toBe(true);
  });

  it("restarts after a cancel: the old record goes, the new upload has a new key", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "f5".repeat(16);
    server.failures.set(`${id}/0`, 4);
    await expect(store.upload(fileOf(["abc"], "a.txt"), { id })).rejects.toThrow();
    await store.cancel(id);
    expect(server.records.has(id)).toBe(false);
    server.failures.clear();
    expect((await store.upload(fileOf(["abc"], "a.txt"), { id })).state).toBe("ready");
  });

  it("retries a chunk after a network error and carries on", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "6".repeat(32);
    server.failures.set(`${id}/0`, 1);
    const info = await store.upload(fileOf(["krótki"]), { id });
    expect(info.state).toBe("ready");
    expect(same(await readText(await store.read(id)), new TextEncoder().encode("krótki"))).toBe(true);
  });

  it("cancels on abort: the upload is dropped on the server with DELETE", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "7".repeat(32);
    const controller = new AbortController();
    const data = new Uint8Array(3 * PLAIN_CHUNK).fill(1);
    await expect(store.upload(new File([data], "x.bin"), {
      id, signal: controller.signal,
      onProgress: (sent) => { if (sent >= PLAIN_CHUNK) controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(server.calls.some((c) => c.method === "DELETE" && c.path.endsWith(id))).toBe(true);
    expect(server.records.has(id)).toBe(false);
  });

  it("lists only what this user can open: a file under another key is left out", async () => {
    const server = new FakeServer();
    const ana = storeFor(server, "ana", keysFor(await aesKey()));
    const eve = storeFor(server, "eve", keysFor(await aesKey()));
    await ana.upload(fileOf(["moje"], "moje.txt"), { id: "8".repeat(32) });
    const list = await eve.list();
    expect(list.files).toEqual([]);
    const own = await ana.list();
    expect(own.files.map((f) => f.name)).toEqual(["moje.txt"]);
    expect(own.trashDays).toBe(30);
  });

  it("gives a protected project's file only to the scope's members", async () => {
    const server = new FakeServer();
    const projectKey = await aesKey();
    const scope = await scopeOf(VAULT, "Projekty/X");
    const projects: ProjectRef[] = [{ path: "Projekty/X", keyEpoch: 1, current: true, members: ["ana", "bart"], key: projectKey }];
    const ana = storeFor(server, "ana", keysFor(await aesKey(), 1, projects));
    const bart = storeFor(server, "bart", keysFor(await aesKey(), 1, [{ ...projects[0], key: projectKey }]));
    const outsider = storeFor(server, "carol", keysFor(await aesKey(), 1, []));
    const info = await ana.upload(fileOf(["tajne"], "plan.txt"), { id: "9".repeat(32), project: "Projekty/X" });
    expect(info.project).toBe("Projekty/X");
    expect(server.records.get(info.id)?.scope).toBe(scope);
    expect(server.scopes.get(scope)).toEqual(["ana", "bart"]);
    expect((await bart.list()).files.map((f) => f.name)).toEqual(["plan.txt"]);
    expect((await bart.read(info.id)).size).toBe(5);
    expect((await outsider.list()).files).toEqual([]);
    expect(await outsider.info(info.id)).toBeNull();
  });

  it("puts a note's file under the innermost protected folder or note holding it", async () => {
    const server = new FakeServer();
    const key = await aesKey();
    const projects: ProjectRef[] = [
      { path: "Kadry", keyEpoch: 1, current: true, members: ["ana"], key },
      { path: "Kadry/Płace.md", keyEpoch: 1, current: true, members: ["ana"], key },
    ];
    const ana = storeFor(server, "ana", keysFor(await aesKey(), 1, projects));
    const inFolder = await ana.upload(fileOf(["a"]), { id: "1".repeat(32), project: "Kadry/Umowy/x.md" });
    const inNote = await ana.upload(fileOf(["b"]), { id: "2".repeat(32), project: "Kadry/Płace.md" });
    const plain = await ana.upload(fileOf(["c"]), { id: "3".repeat(32), project: "Projekty/Y/notatka.md" });
    expect([inFolder.project, inNote.project, plain.project]).toEqual(["Kadry", "Kadry/Płace.md", "Projekty/Y"]);
    expect(server.records.get(inNote.id)?.scope).toBe(await scopeOf(VAULT, "Kadry/Płace.md"));
    expect(server.records.get(plain.id)?.scope ?? null).toBeNull();
  });

  it("refuses to write into a protected project whose key this user does not hold", async () => {
    const server = new FakeServer();
    const projects: ProjectRef[] = [{ path: "Projekty/X", keyEpoch: 1, current: true, members: ["bart"], key: null }];
    const store = storeFor(server, "ana", keysFor(await aesKey(), 1, projects));
    await expect(store.upload(fileOf(["x"]), { id: "a".repeat(32), project: "Projekty/X" })).rejects.toThrow("klucza tego projektu");
    expect(server.records.size).toBe(0);
  });

  it("renames without changing the id, and the new name is what list shows", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "b".repeat(32);
    await store.upload(fileOf(["treść"], "stara.txt"), { id });
    await store.rename(id, "nowa.txt");
    expect((await store.info(id))?.name).toBe("nowa.txt");
    expect((await store.list()).files.map((f) => [f.id, f.name])).toEqual([[id, "nowa.txt"]]);
  });

  it("trashes, restores and cancels: a finished file is not cancelled", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "c".repeat(32);
    await store.upload(fileOf(["x"]), { id });
    await store.cancel(id);
    expect((await store.info(id))?.state).toBe("ready");
    await store.trash(id);
    expect((await store.info(id))?.state).toBe("trashed");
    await store.restore(id);
    expect((await store.info(id))?.state).toBe("ready");
  });

  it("notifies listeners after changes", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    let calls = 0;
    const stop = store.onChange(() => calls++);
    await store.upload(fileOf(["x"]), { id: "d".repeat(32) });
    expect(calls).toBe(1);
    stop();
    await store.rename("d".repeat(32), "y.txt");
    expect(calls).toBe(1);
  });

  it("re-seals envelopes of older epochs with the current key, and only once", async () => {
    const server = new FakeServer();
    const k1 = await aesKey();
    const k2 = await aesKey();
    const old = storeFor(server, "ana", keysFor(k1, 1));
    await old.upload(fileOf(["stare"], "stary.txt"), { id: "e".repeat(32) });
    // After the rotation: the current key is epoch 2, epoch 1 is still held on this device.
    const rotated: FileKeys = {
      vault: () => ({ key: k2, keyEpoch: 2 }),
      vaultKey: async (e) => (e === 2 ? k2 : e === 1 ? k1 : null),
      projects: async () => [],
    };
    const store = storeFor(server, "ana", rotated);
    expect(await store.rewrapAll()).toBe(1);
    expect(await store.rewrapAll()).toBe(0);
    // A device with only the new key now opens the file.
    const onlyNew = storeFor(server, "ana", { vault: () => ({ key: k2, keyEpoch: 2 }), vaultKey: async (e) => (e === 2 ? k2 : null), projects: async () => [] });
    expect((await onlyNew.info("e".repeat(32)))?.name).toBe("stary.txt");
    expect(JSON.parse(server.records.get("e".repeat(32))!.meta).keyEpoch).toBe(2);
  });

  it("does not re-seal a file whose old key this device lacks", async () => {
    const server = new FakeServer();
    await storeFor(server, "ana", keysFor(await aesKey(), 1)).upload(fileOf(["x"]), { id: "f".repeat(32) });
    const other = await aesKey();
    const newer = storeFor(server, "ana", { vault: () => ({ key: other, keyEpoch: 2 }), vaultKey: async () => null, projects: async () => [] });
    expect(await newer.rewrapAll()).toBe(0);
  });
});

describe("chunks on the wire, thumbnails and offline reads", () => {
  const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
  const thumb = (n = 10) => ({ blob: new Blob([pattern(n) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3 });

  it("sends the chunks at the sizes of docs/PLIKI.md §2, the first one with the prefix", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "10".repeat(16);
    const size = 2 * PLAIN_CHUNK + PLAIN_CHUNK / 2;
    await store.upload(new File([new Uint8Array(size).fill(3)], "w.bin"), { id });
    expect(server.wires.filter((w) => w.id === id).map((w) => w.bytes.length)).toEqual([32 + CIPHER_CHUNK, CIPHER_CHUNK, PLAIN_CHUNK / 2 + 17]);
    expect(server.records.get(id)?.size).toBe(32 + size + 17 * 3);
  });

  it("resends the same bytes when a chunk is retried", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "20".repeat(16);
    server.failures.set(`${id}/1`, 2);
    const data = pattern(PLAIN_CHUNK + 100);
    expect((await store.upload(new File([data], "r.bin"), { id })).state).toBe("ready");
    const tries = server.wires.filter((w) => w.id === id && w.n === 1);
    expect(tries).toHaveLength(3);
    expect(same(tries[0].bytes, tries[1].bytes) && same(tries[1].bytes, tries[2].bytes)).toBe(true);
    expect(same(await readText(await store.read(id)), data)).toBe(true);
  });

  it("uploads the thumbnail first, keeps it out of the list, and gives the image its id and size", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "30".repeat(16);
    const info = await store.upload(fileOf(["obraz"], "zdjecie.png", "image/png"), { id, thumbnail: thumb(300) });
    expect(info).toMatchObject({ id, width: 4, height: 3, thumb: expect.any(String) });
    const thumbId = info.thumb!;
    expect([...server.records.keys()]).toEqual([thumbId, id]);
    expect(await store.info(thumbId)).toMatchObject({ thumbOf: id, mime: "image/jpeg", size: 300 });
    const list = await store.list();
    expect(list.files.map((f) => f.id)).toEqual([id]);
    expect(list.files[0]).toMatchObject({ thumb: thumbId, width: 4, height: 3 });
    expect(same(await readText(await store.read(thumbId)), pattern(300))).toBe(true);
  });

  it("a video sent with its first-frame thumbnail: the original keeps thumb and duration (ms, rounded)", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "6a".repeat(16);
    const info = await store.upload(fileOf(["film"], "klip.mp4", "video/mp4"), { id, thumbnail: { ...thumb(300), durationMs: 4321.4 } });
    expect(info).toMatchObject({ id, thumb: expect.any(String), durationMs: 4321 });
    expect(await store.info(id)).toMatchObject({ thumb: info.thumb, durationMs: 4321 });
    expect(await store.info(info.thumb!)).toMatchObject({ thumbOf: id });
  });

  it("list and info never fetch the content; read does", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "40".repeat(16);
    await store.upload(fileOf(["x"]), { id, thumbnail: thumb() });
    await store.list();
    await store.info(id);
    expect(server.calls.some((c) => c.path.endsWith("/content"))).toBe(false);
    expect((await store.read(id)).type).toBe("text/plain");
    expect(server.calls.some((c) => c.path.endsWith("/content"))).toBe(true);
  });

  it("says the file is unavailable offline when its content cannot be fetched", async () => {
    const server = new FakeServer();
    const vaultKey = await aesKey();
    const id = "50".repeat(16);
    await storeFor(server, "ana", keysFor(vaultKey)).upload(fileOf(["x"]), { id });
    const offline: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/content")) throw new TypeError("Failed to fetch");
      return server.fetchFor("ana")(input, init);
    };
    const store = new RemoteFileStore({ vaultId: VAULT, keys: keysFor(vaultKey), fetch: offline, sleep: noSleep });
    await expect(store.read(id)).rejects.toThrow("Plik jest niedostępny bez połączenia.");
  });

  it("trash, restore and purge go with the thumbnail", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "60".repeat(16);
    const thumbId = (await store.upload(fileOf(["x"]), { id, thumbnail: thumb() })).thumb!;
    await store.trash(id);
    expect(server.records.get(id)?.state).toBe("trashed");
    expect(server.records.get(thumbId)?.state).toBe("trashed");
    await store.restore(id);
    expect(server.records.get(thumbId)?.state).toBe("ready");
    await store.trash(id);
    await store.purge(id);
    expect(server.records.has(id)).toBe(false);
    expect(server.records.has(thumbId)).toBe(false);
  });

  it("cancelling an unfinished image drops its thumbnail too", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "70".repeat(16);
    server.failures.set(`${id}/1`, 4);
    await expect(store.upload(new File([new Uint8Array(PLAIN_CHUNK + 1)], "b.jpg", { type: "image/jpeg" }), { id, thumbnail: thumb() })).rejects.toThrow();
    const thumbId = [...server.records.keys()].find((k) => k !== id)!;
    await store.cancel(id);
    expect(server.records.has(id)).toBe(false);
    expect(server.records.has(thumbId)).toBe(false);
  });
});

describe("MemoryFileStore thumbnails", () => {
  it("keeps a thumbnail out of the list and moves with its image", async () => {
    const store = new MemoryFileStore("ana");
    const id = "80".repeat(16);
    const info = await store.upload(fileOf(["x"]), { id, thumbnail: { blob: new Blob([new Uint8Array(10) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3 } });
    expect(info).toMatchObject({ width: 4, height: 3 });
    expect((await store.list()).files.map((f) => f.id)).toEqual([id]);
    await store.trash(id);
    expect((await store.info(info.thumb!))?.state).toBe("trashed");
    await store.restore(id);
    expect((await store.info(info.thumb!))?.state).toBe("ready");
  });

  it("keeps the video length from the thumbnail", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(["x"], "klip.mp4", "video/mp4"), { id: "81".repeat(16), thumbnail: { blob: new Blob([new Uint8Array(10) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3, durationMs: 900 } });
    expect(info).toMatchObject({ durationMs: 900 });
  });
});

describe("attachment migration", () => {
  it("uploads, reads back and only then drops the bytes; a second run moves nothing", async () => {
    const bridge = new MockBridge([]);
    await bridge.call("save_attachment", { name: "logo.png", bytes: new Uint8Array([1, 2, 3, 4]) });
    const secret = await keySecret(await aesKey());
    const files = new MemoryFileStore("ana");
    const moved = await migrateAttachments(files, secret, bridge.pendingAttachments(), (key, bytes, fileId) => bridge.attachmentMigrated(key, bytes, fileId));
    expect(moved).toBe(1);
    expect(bridge.pendingAttachments()).toEqual([]);
    const snapshot = bridge.exportBrowserSnapshot("ana").state.attachments;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ key: "assets/logo.png", bytesBase64: "" });
    const fileId = snapshot[0].fileId!;
    expect(same(await readText(await files.read(fileId)), new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(await migrateAttachments(files, secret, bridge.pendingAttachments(), () => true)).toBe(0);
  });

  it("keeps the bytes when the read-back fails", async () => {
    const bridge = new MockBridge([]);
    await bridge.call("save_attachment", { name: "a.pdf", bytes: new Uint8Array([9, 9]) });
    const memory = new MemoryFileStore("ana");
    const flaky: FileStore = Object.assign(Object.create(memory), { read: async () => { throw new Error("sieć"); } });
    const secret = await keySecret(await aesKey());
    await expect(migrateAttachments(flaky, secret, bridge.pendingAttachments(), (key, bytes, id) => bridge.attachmentMigrated(key, bytes, id))).rejects.toThrow("sieć");
    expect(bridge.pendingAttachments()).toHaveLength(1);
    expect(bridge.exportBrowserSnapshot("ana").state.attachments[0].bytesBase64).not.toBe("");
  });

  it("treats a 409 on upload (another client already has the id) by reading the file back", async () => {
    const bridge = new MockBridge([]);
    await bridge.call("save_attachment", { name: "b.txt", bytes: new Uint8Array([5]) });
    const memory = new MemoryFileStore("ana");
    const secret = await keySecret(await aesKey());
    const conflicted: FileStore = Object.assign(Object.create(memory), { upload: async () => { throw new ApiError("zajęte", 409); } });
    const [item] = bridge.pendingAttachments();
    const id = await migrationId(secret, item.key, item.bytes);
    await memory.upload(new File([new Uint8Array([5])], "b.txt"), { id });
    expect(await migrateAttachments(conflicted, secret, [item], (key, bytes, fileId) => bridge.attachmentMigrated(key, bytes, fileId))).toBe(1);
  });

  it("an entry with a file id wins over bytes for the same key; old copies of the bytes are kept beside it", async () => {
    const remote = new MockBridge([]);
    await remote.call("save_attachment", { name: "c.png", bytes: new Uint8Array([1]) });
    const [item] = remote.pendingAttachments();
    remote.attachmentMigrated(item.key, item.bytes, "f0".repeat(16));
    const snapshot = remote.exportBrowserSnapshot("ana");

    const local = new MockBridge([]);
    await local.call("save_attachment", { name: "c.png", bytes: new Uint8Array([2, 2]) });
    local.mergeBrowserSnapshot(snapshot);
    expect(local.attachmentFileId("assets/c.png")).toBe("f0".repeat(16));
    expect(local.pendingAttachments().map((a) => a.key)).toEqual([expect.stringContaining("assets/c.png.conflict-")]);

    // bytes arriving later for a key that has a file are not taken again
    const late = new MockBridge([]);
    late.mergeBrowserSnapshot(snapshot);
    late.mergeBrowserSnapshot({ ...snapshot, state: { ...snapshot.state, attachments: [{ key: "assets/c.png", bytesBase64: "AQ==" }] } });
    expect(late.pendingAttachments()).toEqual([]);
    expect(late.attachmentFileId("assets/c.png")).toBe("f0".repeat(16));
  });

  it("an old client's entry with empty bytes and a file id does not break the merge", () => {
    const local = new MockBridge([]);
    const snapshot = new MockBridge([]).exportBrowserSnapshot("ana");
    expect(() => local.mergeBrowserSnapshot({ ...snapshot, state: { ...snapshot.state, attachments: [{ key: "assets/d.png", bytesBase64: "", fileId: "1".repeat(32) }] } })).not.toThrow();
    expect(local.attachmentFileId("assets/d.png")).toBe("1".repeat(32));
  });
});

describe("reads with progress, abort and a head; thumbnails of old videos", () => {
  const MIB = PLAIN_CHUNK;
  const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
  const joined = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };

  it("read reports progress after each 1 MiB, ending at the size", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "30".repeat(16);
    const data = new Uint8Array(2.5 * MIB).map((_, i) => (i * 13) & 0xff);
    await store.upload(new File([data], "p.bin"), { id });
    const calls: [number, number][] = [];
    const blob = await store.read(id, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[MIB, data.length], [2 * MIB, data.length], [2.5 * MIB, data.length]]);
    expect(same(await readText(blob), data)).toBe(true);
  });

  it("read rejects with AbortError when the signal is already aborted, and the fetch gets the signal", async () => {
    const server = new FakeServer();
    const key = await aesKey();
    const id = "31".repeat(16);
    await storeFor(server, "ana", keysFor(key)).upload(fileOf(["abc"], "a.txt"), { id });
    const seen: (AbortSignal | undefined)[] = [];
    const inner = server.fetchFor("ana");
    const store = new RemoteFileStore({ vaultId: VAULT, keys: keysFor(key), sleep: noSleep, fetch: async (input, init) => { seen.push(init?.signal ?? undefined); return inner(input, init); } });
    const before = new AbortController();
    before.abort();
    await expect(store.read(id, { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" });
    // aborted in the middle of the read: the record request gets the caller's signal, and the content request gets one
    // linked to it, which is aborted when the read stops
    const during = new AbortController();
    const start = seen.length;
    await expect(store.read(id, { signal: during.signal, onProgress: () => during.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(seen.length).toBeGreaterThan(start + 1);
    expect(seen[start]).toBe(during.signal);
    expect(seen.slice(start + 1).every((s) => s?.aborted === true)).toBe(true);
  });

  it("readHead stops the download after the chunks it needs and aborts the fetch", async () => {
    const server = new FakeServer();
    const key = await aesKey();
    const id = "40".repeat(16);
    const data = new Uint8Array(3 * MIB + 5).map((_, i) => (i * 17) & 0xff);
    await storeFor(server, "ana", keysFor(key)).upload(new File([data], "film.bin"), { id });
    const wire = joined(server.records.get(id)!.parts);
    // Pieces of CIPHER_CHUNK, counted when pulled; highWaterMark 0 so nothing is read ahead of the consumer.
    let pulled = 0;
    let offset = 0;
    let fetchSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= wire.length) { controller.close(); return; }
        pulled++;
        controller.enqueue(wire.slice(offset, offset + CIPHER_CHUNK));
        offset += CIPHER_CHUNK;
      },
    }, { highWaterMark: 0 });
    const http: typeof fetch = async (input, init) => {
      if (new URL(String(input), "https://notes.test").pathname.endsWith("/content")) {
        fetchSignal = init?.signal ?? undefined;
        return new Response(body, { status: 200 });
      }
      return server.fetchFor("ana")(input, init);
    };
    const store = new RemoteFileStore({ vaultId: VAULT, keys: keysFor(key), fetch: http, sleep: noSleep });
    const head = await store.readHead(id, MIB);
    expect(head.complete).toBe(false);
    expect(head.blob.size).toBe(MIB);
    expect(same(await readText(head.blob), data.subarray(0, MIB))).toBe(true);
    expect(pulled).toBeLessThanOrEqual(2);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("readHead limits: empty, exact 1 MiB, 1 MiB + 1 B, a limit above the size, and a zero limit", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    await store.upload(fileOf([], "pusty.txt"), { id: "41".repeat(16) });
    expect(await store.readHead("41".repeat(16), MIB)).toMatchObject({ complete: true });
    expect((await store.readHead("41".repeat(16), MIB)).blob.size).toBe(0);

    await store.upload(new File([new Uint8Array(MIB).fill(1)], "a.bin"), { id: "42".repeat(16) });
    expect(await store.readHead("42".repeat(16), MIB)).toMatchObject({ complete: true });
    expect((await store.readHead("42".repeat(16), MIB)).blob.size).toBe(MIB);

    const big = pattern(MIB + 1);
    await store.upload(new File([big], "b.bin"), { id: "43".repeat(16) });
    const part = await store.readHead("43".repeat(16), MIB);
    expect(part.complete).toBe(false);
    expect(same(await readText(part.blob), big.subarray(0, MIB))).toBe(true);

    const three = pattern(3 * MIB);
    await store.upload(new File([three], "c.bin"), { id: "44".repeat(16) });
    const all = await store.readHead("44".repeat(16), 16 * MIB);
    expect(all.complete).toBe(true);
    expect(same(await readText(all.blob), three)).toBe(true);

    await expect(store.readHead("44".repeat(16), 0)).rejects.toThrow(RangeError);
  });

  it("readHead reports the plaintext it decrypted, with the total rounded up to a chunk", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "45".repeat(16);
    await store.upload(new File([pattern(3 * MIB)], "d.bin"), { id });
    const calls: [number, number][] = [];
    await store.readHead(id, 1.5 * MIB, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[MIB, 2 * MIB], [2 * MIB, 2 * MIB]]);
  });

  it("readHead rejects a damaged first chunk", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "46".repeat(16);
    await store.upload(new File([pattern(2 * MIB)], "e.bin"), { id });
    const first = server.records.get(id)!.parts[0].slice();
    first[9] ^= 1;
    server.records.get(id)!.parts[0] = first;
    await expect(store.readHead(id, MIB)).rejects.toThrow("Plik jest uszkodzony albo został zmieniony.");
  });

  it("setThumbnail uploads the thumbnail with parent and thumbOf, then re-seals the original with thumb and duration", async () => {
    const server = new FakeServer();
    const key = await aesKey();
    const store = storeFor(server, "ana", keysFor(key));
    const id = "50".repeat(16);
    await store.upload(fileOf(["film"], "klip.mp4", "video/mp4"), { id });
    const thumb = { blob: new Blob([pattern(300) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3, durationMs: 12345.6 };
    await store.setThumbnail(id, thumb);
    const info = await store.info(id);
    const thumbId = info!.thumb!;
    expect(info).toMatchObject({ thumb: expect.any(String), durationMs: 12346 });
    expect(server.records.get(thumbId)?.parent).toBe(id);
    expect(await openMeta(VAULT, thumbId, server.records.get(thumbId)!.meta, async () => key)).toMatchObject({ thumbOf: id });
    expect(await store.info(thumbId)).toMatchObject({ thumbOf: id, mime: "image/jpeg", size: 300 });
    expect(same(await readText(await store.read(thumbId)), pattern(300))).toBe(true);
    expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    const before = server.calls.length;
    await store.setThumbnail(id, thumb);
    expect(server.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(await store.info(id)).toMatchObject({ thumb: thumbId });
  });

  it("setThumbnail: a 403 on the thumbnail's upload is an ApiError, and the original is not re-sealed", async () => {
    const server = new FakeServer();
    const key = await aesKey();
    const id = "51".repeat(16);
    await storeFor(server, "ana", keysFor(key)).upload(fileOf(["film"], "klip.mp4", "video/mp4"), { id });
    let deny = false;
    const inner = server.fetchFor("ana");
    const store = new RemoteFileStore({ vaultId: VAULT, keys: keysFor(key), sleep: noSleep, fetch: async (input, init) => {
      if (deny && init?.method === "POST") return new Response(JSON.stringify({ error: "Brak uprawnień." }), { status: 403, headers: { "content-type": "application/json" } });
      return inner(input, init);
    } });
    deny = true;
    const thumb = { blob: new Blob([pattern(10) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3 };
    await expect(store.setThumbnail(id, thumb)).rejects.toBeInstanceOf(ApiError);
    await expect(store.setThumbnail(id, thumb)).rejects.toMatchObject({ status: 403 });
    expect(server.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect((await store.info(id))?.thumb ?? null).toBeNull();
  });

  it("setThumbnail on a missing file says so", async () => {
    const store = storeFor(new FakeServer(), "ana", keysFor(await aesKey()));
    await expect(store.setThumbnail("52".repeat(16), { blob: new Blob([]), width: 1, height: 1 })).rejects.toThrow("Nie ma takiego pliku.");
  });

  it("info carries the duration of a video from the envelope", async () => {
    const server = new FakeServer();
    const store = storeFor(server, "ana", keysFor(await aesKey()));
    const id = "53".repeat(16);
    await store.upload(fileOf(["film"], "klip.mp4", "video/mp4"), { id });
    expect((await store.info(id))?.durationMs ?? null).toBeNull();
    await store.setThumbnail(id, { blob: new Blob([pattern(5) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3, durationMs: 900 });
    expect(await store.info(id)).toMatchObject({ durationMs: 900 });
  });
});

describe("text layers (docs/OCR.md §3.2)", () => {
  const fields = { extractor: 1, method: "pdf-text", pages: 1, lang: "latin", quality: 1, flags: [], engine: "pdf.js" } as const;
  const layerFor = (source: string, text = "ZAŻÓŁĆ GĘŚLĄ JAŹŃ " + MARKER) => serialize({
    source, name: "Faktura.pdf", mime: "application/pdf", method: "pdf-text", pages: [{ n: 1, text, lowQuality: false }],
    lang: "latin", quality: 1, flags: [], extractor: 1, engine: "pdf.js", createdAt: "2026-11-19T15:02:11Z",
  });
  const setup = async () => {
    const server = new FakeServer();
    const keys = keysFor(await aesKey());
    const anna = storeFor(server, "anna", keys);
    const original = await anna.upload(fileOf(["%PDF-1.7 treść"], "Faktura.pdf", "application/pdf"), { id: newFileId() });
    return { server, keys, anna, piotr: storeFor(server, "piotr", keys), original };
  };

  it("gets a deterministic id from the original's key, hidden from the file list, encrypted on the server", async () => {
    const { server, anna, piotr, original } = await setup();
    const md = layerFor(original.id);
    const id = await anna.writeTextLayer(original.id, md, { ...fields, flags: [] });
    // the same layer again (a retry, another device): same id, no second record
    expect(await anna.writeTextLayer(original.id, md, { ...fields, flags: [] })).toBe(id);
    // another member after Anna: the record there is a real layer, so it is done
    expect(await piotr.writeTextLayer(original.id, layerFor(original.id, "inna treść"), { ...fields, flags: [] })).toBe(id);
    expect([...server.records.values()].filter((r) => r.kind === "text")).toHaveLength(1);
    const rec = server.records.get(id)!;
    expect([rec.parent, rec.kind]).toEqual([original.id, "text"]);
    expect((await anna.list()).files.map((f) => f.id)).toEqual([original.id]);
    expect(server.stored()).not.toContain(MARKER);
    expect(server.stored()).not.toContain("ZAŻÓŁĆ");
    expect((await piotr.textLayers()).get(original.id)).toMatchObject({ id, textOf: original.id, method: "pdf-text", pages: 1, extractor: 1 });
    expect(await piotr.readTextLayer(id, original.id)).toBe(md);
    await expect(piotr.readTextLayer(id, newFileId())).rejects.toThrow();
  });

  it("ignores a layer at an id not derived from the original's key, whatever extractor it claims", async () => {
    const { server, keys, anna, original } = await setup();
    const real = await anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] });
    // Piotr places his own layer at a random id: a valid envelope of a child of the original, created after Anna's
    const fake = newFileId();
    server.records.set(fake, { ...server.records.get(real)!, id: fake, meta: await piotrSeals(keys, fake, original.id), createdBy: "piotr", createdAt: 99 });
    expect((await anna.textLayers()).get(original.id)?.id).toBe(real);
    server.records.delete(real);
    expect((await anna.textLayers()).has(original.id)).toBe(false);
  });

  it("restores its own layer from the trash, and refuses anything else at its id", async () => {
    const { server, anna, piotr, original } = await setup();
    const id = await anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] });
    server.records.get(id)!.state = "trashed";
    expect(await piotr.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] })).toBe(id);
    expect(server.records.get(id)!.state).toBe("ready");
    // junk at the id (a plain file, no parent): never taken for done
    server.records.set(id, { ...server.records.get(id)!, kind: null, parent: null });
    await expect(anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] })).rejects.toThrow("inny zapis");
  });

  it("starts its own unfinished upload at the id again", async () => {
    const { server, anna, original } = await setup();
    const id = await anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] });
    server.records.get(id)!.state = "uploading";
    expect(await anna.writeTextLayer(original.id, layerFor(original.id, "druga próba"), { ...fields, flags: [] })).toBe(id);
    expect(server.records.get(id)!.state).toBe("ready");
  });

  // What a hostile editor's own client can do: write any gzip under the right id, past writeTextLayer's checks.
  type Raw = { sendFile(blob: Blob, id: string, f: object, o: object): Promise<unknown>; originalMeta(id: string): Promise<{ key: string; name: string; project: string | null }> };
  const writeRaw = async (store: RemoteFileStore, originalId: string, gz: Blob): Promise<string> => {
    const raw = store as unknown as Raw;
    const meta = await raw.originalMeta(originalId);
    const id = await textLayerId(meta.key, originalId, 1);
    await raw.sendFile(gz, id, { ...fields, flags: [], name: "x.tekst.md", mime: "text/markdown", project: meta.project, textOf: originalId, encoding: "gzip" }, {});
    return id;
  };
  const gzip = async (text: string): Promise<Blob> => new Blob([await new Response(new Response(text).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()]);

  it("stops reading a layer that inflates past 2 MB", async () => {
    const { anna, piotr, original } = await setup();
    const id = await writeRaw(piotr, original.id, await gzip(layerFor(original.id, "x".repeat(3 * 1024 * 1024))));
    await expect(anna.readTextLayer(id, original.id)).rejects.toThrow("za duży");
    // and the writer does not take that record for done; a ready one only an admin can remove
    await expect(anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] })).rejects.toThrow("Administrator sejfu");
  });

  it("reads back a layer whose gzip spans many slices", async () => {
    const { anna, piotr, original } = await setup();
    // text that does not compress: its gzip is far over one 16 KB slice
    let seed = 7;
    const letters = "aąbcćdeęfghijklłmnńoóprsśtuwyzźż ";
    const text = Array.from({ length: 300_000 }, () => letters[(seed = (seed * 1103515245 + 12345) % 2147483648) % letters.length]).join("");
    const md = layerFor(original.id, text);
    const id = await anna.writeTextLayer(original.id, md, { ...fields, flags: [] });
    expect(await piotr.readTextLayer(id, original.id)).toBe(md);
  });

  it("takes a layer whose text names another extractor than its envelope for damaged", async () => {
    const { anna, piotr, original } = await setup();
    const other = layerFor(original.id).replace("extractor: 1", "extractor: 2");
    expect(other).not.toBe(layerFor(original.id));
    const id = await writeRaw(piotr, original.id, await gzip(other));
    await expect(anna.readTextLayer(id, original.id)).rejects.toThrow("uszkodzony");
  });

  it("does not call a layer damaged when reading it fails", async () => {
    const { anna, original } = await setup();
    await anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] });
    const controller = new AbortController();
    controller.abort();
    const error = await anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] }, controller.signal).catch((e: unknown) => e);
    expect(String(error)).not.toContain("uszkodzony");
  });

  it("writes only a layer a reader would take", async () => {
    const { anna, original } = await setup();
    const write = (md: string, extractor = 1) => anna.writeTextLayer(original.id, md, { ...fields, extractor, flags: [] });
    await expect(anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [], engine: "x".repeat(201) })).rejects.toThrow("uszkodzony");
    await expect(anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [], quality: 2 })).rejects.toThrow("uszkodzony");
    await expect(write("x".repeat(3 * 1024 * 1024))).rejects.toThrow("uszkodzony");
    await expect(write(layerFor(newFileId()))).rejects.toThrow("uszkodzony");
    await expect(write(layerFor(original.id), 2)).rejects.toThrow("uszkodzony");
    await expect(write("nie warstwa")).rejects.toThrow("uszkodzony");
  });

  it("is neither listed nor read once its original is in the trash, and not restored over damaged text", async () => {
    const { server, anna, piotr, original } = await setup();
    const id = await anna.writeTextLayer(original.id, layerFor(original.id), { ...fields, flags: [] });
    server.records.get(original.id)!.state = "trashed";
    expect((await piotr.textLayers()).has(original.id)).toBe(false);
    await expect(piotr.readTextLayer(id, original.id)).rejects.toThrow();
    server.records.get(original.id)!.state = "ready";
    server.records.get(id)!.state = "trashed";
    await expect(piotr.readTextLayer(id, original.id)).rejects.toThrow();
  });

  it("is refused for a file that is not there", async () => {
    const { anna } = await setup();
    await expect(anna.writeTextLayer(newFileId(), "x", { ...fields, flags: [] })).rejects.toThrow();
  });

  it("derives different ids for different files and extractor versions", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const a = await textLayerId(key, "a".repeat(32), 1);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await textLayerId(key, "a".repeat(32), 1)).toBe(a);
    expect(await textLayerId(key, "b".repeat(32), 1)).not.toBe(a);
    expect(await textLayerId(key, "a".repeat(32), 2)).not.toBe(a);
    expect(await textLayerId(btoa(String.fromCharCode(...new Uint8Array(32).fill(8))), "a".repeat(32), 1)).not.toBe(a);
    await expect(textLayerId(key, "not-hex", 1)).rejects.toThrow();
    await expect(textLayerId(btoa("short"), "a".repeat(32), 1)).rejects.toThrow();
  });
});

// A layer envelope Piotr can make: valid fields of a text layer of `original`, sealed with the vault key, at `id`.
async function piotrSeals(keys: FileKeys, id: string, original: string): Promise<string> {
  const meta = { format: 2, version: 1, name: "x.tekst.md", mime: "text/markdown", size: 10, project: null, key: btoa(String.fromCharCode(...new Uint8Array(32))),
    createdAt: 1, textOf: original, extractor: 1, method: "ocr", pages: 1, lang: "latin", quality: 1, flags: [], engine: "x", encoding: "gzip" } as const;
  return sealMeta(VAULT, id, { keyEpoch: 1 }, keys.vault().key, { ...meta, flags: [] });
}
