// @vitest-environment jsdom
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "./bridge";
import { loadDemoFixtures, mimeByName } from "./demofixtures";
import { MAX_FILE_BYTES, MemoryFileStore } from "./filestore";

const json = (value: unknown) => ({ ok: true, json: async () => value }) as unknown as Response;
const bytes = (blob: Blob) => ({ ok: true, blob: async () => blob }) as unknown as Response;

/** A fake of the demo's fetch: the list, then each file by its name (decoded from the URL, as the dev server does). */
function serve(names: string[], blobs: Record<string, Blob>) {
  const fetch = vi.fn(async (url: string) => {
    if (url === "/__fixtures/list.json") return json(names);
    return bytes(blobs[decodeURIComponent(url.slice("/__fixtures/".length))]);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function fakeBridge(store: MemoryFileStore) {
  const calls: Array<[string, unknown]> = [];
  const bridge = {
    files: store,
    call: vi.fn(async (cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "create_note") return "nota-1";
      if (cmd === "apply_update") return null;
      throw new Error(cmd);
    }),
    on: () => () => {},
  } as unknown as Bridge;
  /** The text of the note the fixtures wrote, read back from its Yjs update. */
  const noteText = () => {
    const update = calls.find(([cmd]) => cmd === "apply_update")?.[1] as { update: Uint8Array };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update.update);
    return doc.getText("content").toString();
  };
  return { bridge, calls, noteText };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo fixtures (?demo=1&pliki=test)", () => {
  it("maps extensions to MIME types, and any other name to application/octet-stream", () => {
    expect(mimeByName("obraz.PNG")).toBe("image/png");
    expect(mimeByName("skrypt.py")).toBe("text/x-python");
    expect(mimeByName("arkusz.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeByName("model.stl")).toBe("model/stl");
    expect(mimeByName("chmura.las")).toBe("application/octet-stream");
    expect(mimeByName("bez-kropki")).toBe("application/octet-stream");
    expect(mimeByName("zagadka.xyz")).toBe("application/octet-stream");
  });

  it("uploads every file with its MIME type and writes a note with one embed of each", async () => {
    const names = ["obraz.png", "notatki.txt", "dane.json", "zagadka.xyz"];
    serve(names, Object.fromEntries(names.map((n) => [n, new Blob(["treść"])])));
    const store = new MemoryFileStore("u1");
    const { bridge, calls, noteText } = fakeBridge(store);

    await loadDemoFixtures(bridge);

    const files = (await store.list()).files;
    expect(files.map((f) => [f.name, f.mime])).toEqual([
      ["obraz.png", "image/png"],
      ["notatki.txt", "text/plain"],
      ["dane.json", "application/json"],
      ["zagadka.xyz", "application/octet-stream"],
    ]);
    expect(calls[0]).toEqual(["create_note", { path: "Załączniki — test.md" }]);
    const text = noteText();
    expect(text.startsWith("# Załączniki — test")).toBe(true);
    const embedded = [...text.matchAll(/!\[\[plik:([0-9a-f]{32})#[0-9a-f]{8}\]\]/g)].map((m) => m[1]);
    expect(embedded).toEqual(files.map((f) => f.id));
    for (const n of names) expect(text).toContain(n);
  });

  it("leaves out a file over 100 MiB", async () => {
    const huge = new Blob(["x"]);
    Object.defineProperty(huge, "size", { value: MAX_FILE_BYTES + 1 });
    serve(["duzy.bin", "maly.txt"], { "duzy.bin": huge, "maly.txt": new Blob(["mały"]) });
    const store = new MemoryFileStore("u1");
    const { bridge, noteText } = fakeBridge(store);

    await loadDemoFixtures(bridge);

    expect((await store.list()).files.map((f) => f.name)).toEqual(["maly.txt"]);
    expect([...noteText().matchAll(/!\[\[plik:/g)]).toHaveLength(1);
  });

  it("the second call does nothing: no fetch, no second note", async () => {
    const fetch = serve(["obraz.png"], { "obraz.png": new Blob(["x"]) });
    const store = new MemoryFileStore("u1");
    const { bridge, calls } = fakeBridge(store);

    await loadDemoFixtures(bridge);
    const fetched = fetch.mock.calls.length;
    await loadDemoFixtures(bridge);

    expect(fetch.mock.calls.length).toBe(fetched);
    expect(calls.filter(([cmd]) => cmd === "create_note")).toHaveLength(1);
    expect((await store.list()).files).toHaveLength(1);
  });
});
