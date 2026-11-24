// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PLAIN_CHUNK } from "./filecrypto";
import { MemoryFileStore } from "./filestore";
import { serialize } from "./ocr/filetext";

const MIB = PLAIN_CHUNK;
const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
async function bytesOf(blob: Blob): Promise<Uint8Array> { return new Uint8Array(await blob.arrayBuffer()); }
const fileOf = (data: Uint8Array, name = "plik.bin", type = "application/octet-stream") => new File([data as BlobPart], name, { type });
const image = (n = 10) => ({ blob: new Blob([pattern(n) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3 });

describe("MemoryFileStore reads", () => {
  it("read reports progress after each 1 MiB, ending at the size", async () => {
    const store = new MemoryFileStore("ana");
    const data = new Uint8Array(2.5 * MIB).map((_, i) => (i * 13) & 0xff);
    const info = await store.upload(fileOf(data), { id: "a0".repeat(16) });
    const calls: [number, number][] = [];
    const blob = await store.read(info.id, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[MIB, data.length], [2 * MIB, data.length], [2.5 * MIB, data.length]]);
    expect(same(await bytesOf(blob), data)).toBe(true);
  });

  it("read rejects with AbortError when the signal is aborted before it starts", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(pattern(10)), { id: "a1".repeat(16) });
    const controller = new AbortController();
    controller.abort();
    await expect(store.read(info.id, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("read stops with AbortError when the signal is aborted in the middle", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(new Uint8Array(3 * MIB)), { id: "a2".repeat(16) });
    const controller = new AbortController();
    const calls: number[] = [];
    await expect(store.read(info.id, { signal: controller.signal, onProgress: (done) => { calls.push(done); controller.abort(); } }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([MIB]);
  });

  it("readHead returns the first bytes, complete only when that is the whole file", async () => {
    const store = new MemoryFileStore("ana");
    const data = pattern(MIB + 1);
    const info = await store.upload(fileOf(data), { id: "b0".repeat(16) });
    const head = await store.readHead(info.id, MIB);
    expect(head.complete).toBe(false);
    expect(head.blob.size).toBe(MIB);
    expect(same(await bytesOf(head.blob), data.subarray(0, MIB))).toBe(true);
  });

  it("readHead limits: empty, exact 1 MiB, 1 MiB + 1 B, a limit above the size, and a zero limit", async () => {
    const store = new MemoryFileStore("ana");
    const empty = await store.upload(fileOf(new Uint8Array(0), "pusty.bin"), { id: "b1".repeat(16) });
    expect(await store.readHead(empty.id, MIB)).toMatchObject({ complete: true });
    expect((await store.readHead(empty.id, MIB)).blob.size).toBe(0);

    const exact = await store.upload(fileOf(new Uint8Array(MIB).fill(1)), { id: "b2".repeat(16) });
    expect(await store.readHead(exact.id, MIB)).toMatchObject({ complete: true });
    expect((await store.readHead(exact.id, MIB)).blob.size).toBe(MIB);

    const over = await store.upload(fileOf(new Uint8Array(MIB + 1).fill(2)), { id: "b3".repeat(16) });
    expect(await store.readHead(over.id, MIB)).toMatchObject({ complete: false });

    const three = pattern(3 * MIB);
    const big = await store.upload(fileOf(three), { id: "b4".repeat(16) });
    const all = await store.readHead(big.id, 16 * MIB);
    expect(all.complete).toBe(true);
    expect(same(await bytesOf(all.blob), three)).toBe(true);

    await expect(store.readHead(big.id, 0)).rejects.toThrow(RangeError);
  });

  it("readHead reports progress with the total rounded up to a chunk", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(new Uint8Array(3 * MIB)), { id: "b5".repeat(16) });
    const calls: [number, number][] = [];
    await store.readHead(info.id, 1.5 * MIB, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[MIB, 2 * MIB], [2 * MIB, 2 * MIB]]);
  });
});

describe("MemoryFileStore setThumbnail", () => {
  it("adds the thumbnail as a file of its own, and the duration", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(pattern(20), "klip.mp4", "video/mp4"), { id: "c0".repeat(16) });
    expect(info.thumb ?? null).toBeNull();
    await store.setThumbnail(info.id, { ...image(30), durationMs: 2500.4 });
    const after = await store.info(info.id);
    expect(after).toMatchObject({ durationMs: 2500, thumb: expect.any(String) });
    expect(await store.info(after!.thumb!)).toMatchObject({ thumbOf: info.id, mime: "image/jpeg", size: 30 });
    expect((await store.list()).files.map((f) => f.id)).toEqual([info.id]);
  });

  it("does nothing when the file already has a thumbnail", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(pattern(20), "klip.mp4", "video/mp4"), { id: "c1".repeat(16) });
    await store.setThumbnail(info.id, image(30));
    const thumb = (await store.info(info.id))?.thumb;
    await store.setThumbnail(info.id, { ...image(40), durationMs: 99 });
    expect(await store.info(info.id)).toMatchObject({ thumb });
    expect((await store.info(info.id))?.durationMs ?? null).toBeNull();
  });

  it("says so for a missing file", async () => {
    const store = new MemoryFileStore("ana");
    await expect(store.setThumbnail("c2".repeat(16), image())).rejects.toThrow("Nie ma takiego pliku.");
  });
});

describe("MemoryFileStore text layers", () => {
  const fields = { extractor: 1, method: "pdf-text" as const, pages: 1, lang: "latin" as const, quality: 1, flags: [], engine: "pdf.js" };
  const layerOf = (source: string) => serialize({ source, name: "a.pdf", mime: "application/pdf", method: "pdf-text", pages: [{ n: 1, text: "Tekst", lowQuality: false }], lang: "latin", quality: 1, flags: [], extractor: 1, engine: "pdf.js", createdAt: "2026-11-19T15:02:11Z" });
  const ID = "d".repeat(32);

  it("writes a layer once, lists it by its original and reads it back", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(pattern(10), "a.pdf", "application/pdf"), { id: ID });
    const id = await store.writeTextLayer(info.id, layerOf(info.id), fields);
    expect(await store.writeTextLayer(info.id, layerOf(info.id), fields)).toBe(id);
    const layers = await store.textLayers();
    expect(layers.size).toBe(1);
    expect(layers.get(info.id)).toMatchObject({ id, textOf: info.id, extractor: 1, createdBy: "ana" });
    expect(await store.readTextLayer(id, info.id)).toContain("Tekst");
    expect((await store.list()).files.map((f) => f.id)).toEqual([info.id]);
  });

  it("refuses a layer of another file, an unknown original or a layer read under the wrong original", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(pattern(10), "a.pdf"), { id: ID });
    await expect(store.writeTextLayer(info.id, layerOf("e".repeat(32)), fields)).rejects.toThrow("Tekst pliku jest uszkodzony.");
    await expect(store.writeTextLayer("f".repeat(32), layerOf("f".repeat(32)), fields)).rejects.toThrow();
    const id = await store.writeTextLayer(info.id, layerOf(info.id), fields);
    await expect(store.readTextLayer(id, "f".repeat(32))).rejects.toThrow();
  });

  it("hides the layer of a file in the trash", async () => {
    const store = new MemoryFileStore("ana");
    const info = await store.upload(fileOf(pattern(10), "a.pdf"), { id: ID });
    await store.writeTextLayer(info.id, layerOf(info.id), fields);
    await store.trash(info.id);
    expect((await store.textLayers()).size).toBe(0);
  });

  it("reports each upload with the File the user gave", async () => {
    const store = new MemoryFileStore("ana");
    const seen: { id: string; file: File }[] = [];
    const off = store.onUploaded((info, file) => seen.push({ id: info.id, file }));
    const file = fileOf(pattern(10), "a.pdf");
    const info = await store.upload(file, { id: ID });
    off();
    await store.upload(fileOf(pattern(3), "b.bin"), { id: "e".repeat(32) });
    expect(seen).toEqual([{ id: info.id, file }]);
  });
});
