import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileInfo } from "../filestore";
import { MemoryFileStore } from "../filestore";
import type { ItemActions } from "./items";
import { encodeThumb, itemsOf } from "./items";

const ID_A = "a0".repeat(16);
const ID_V = "b0".repeat(16);
const fileOf = (data: Uint8Array, name: string, type: string) => new File([data as BlobPart], name, { type });
const jpeg = () => ({ blob: new Blob([new Uint8Array([1, 2, 3]) as BlobPart], { type: "image/jpeg" }), width: 4, height: 3 });
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("brak wartości");
  return x;
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function library() {
  const store = new MemoryFileStore("ana");
  const a = await store.upload(fileOf(new Uint8Array(10), "a.txt", "text/plain"), { id: ID_A });
  const v = await store.upload(fileOf(new Uint8Array(20), "wideo.mp4", "video/mp4"), { id: ID_V, thumbnail: jpeg() });
  const thumb = must(await store.info(must(v.thumb)));
  return { store, a, v, thumb };
}

describe("itemsOf: wybór plików", () => {
  it("pomija miniatury i pliki w przesyłaniu, usuwa powtórzenia", async () => {
    const { store, a, v, thumb } = await library();
    const uploading: FileInfo = { ...a, id: "c0".repeat(16), state: "uploading" };
    const items = itemsOf(store, [a, thumb, uploading, a, v]);
    expect(items.map((i) => i.key)).toEqual([ID_A, ID_V]);
  });

  it("pola elementu z FileInfo; miniatura wideo jako id pliku", async () => {
    const { store, a, v } = await library();
    const [itemA, itemV] = itemsOf(store, [a, v]);
    expect(itemA).toMatchObject({ key: ID_A, name: "a.txt", mime: "text/plain", size: 10, durationMs: null, thumb: null });
    expect(itemV).toMatchObject({ key: ID_V, name: "wideo.mp4", mime: "video/mp4", size: 20, thumb: v.thumb });
  });
});

describe("itemsOf: odczyt", () => {
  it("read i readHead przechodzą do store z opcjami", async () => {
    const { store, a } = await library();
    const [item] = itemsOf(store, [a]);
    const read = vi.spyOn(store, "read");
    const readHead = vi.spyOn(store, "readHead");
    const options = { onProgress: vi.fn() };
    await item!.read(options);
    await item!.readHead(1024, options);
    expect(read).toHaveBeenCalledWith(ID_A, options);
    expect(readHead).toHaveBeenCalledWith(ID_A, 1024, options);
  });

  it("readThumb: null bez miniatury, Blob z miniaturą", async () => {
    const { store, a, v } = await library();
    const [itemA, itemV] = itemsOf(store, [a, v]);
    expect(itemA!.readThumb({})).toBeNull();
    const blob = await must(itemV!.readThumb({}));
    expect(blob.size).toBe(3);
  });

  it("saveThumb zapisuje przez setThumbnail", async () => {
    const { store, a } = await library();
    const [item] = itemsOf(store, [a]);
    const setThumbnail = vi.spyOn(store, "setThumbnail");
    const thumb = { blob: new Blob([new Uint8Array(5) as BlobPart]), width: 2, height: 2, durationMs: 1000 };
    await item!.saveThumb(thumb);
    expect(setThumbnail).toHaveBeenCalledWith(ID_A, thumb);
  });
});

describe("itemsOf: akcje", () => {
  it("download i open wołają podane actions z store i plikiem", async () => {
    const { store, a } = await library();
    const actions: ItemActions = { download: vi.fn(), open: vi.fn() };
    const [item] = itemsOf(store, [a], actions);
    item!.download();
    item!.open();
    expect(actions.download).toHaveBeenCalledWith(store, a);
    expect(actions.open).toHaveBeenCalledWith(store, a);
  });
});

describe("encodeThumb", () => {
  it("odrzuca złe wymiary i długość bufora", async () => {
    expect(await encodeThumb(new ArrayBuffer(0), 0, 0)).toBeNull();
    expect(await encodeThumb(new ArrayBuffer(481 * 4), 481, 1)).toBeNull();
    expect(await encodeThumb(new ArrayBuffer(4 * 4 * 2), 2.5, 2)).toBeNull();
    expect(await encodeThumb(new ArrayBuffer(15), 2, 2)).toBeNull();
    expect(await encodeThumb(new ArrayBuffer(17), 2, 2)).toBeNull();
  });

  it("bez kontekstu canvas zwraca null bez wyjątku", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(encodeThumb(new ArrayBuffer(16), 2, 2)).resolves.toBeNull();
  });
});
