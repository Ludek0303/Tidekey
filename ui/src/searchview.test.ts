// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Bridge, SearchHit } from "./bridge";
import { MARK_END, MARK_START, MockBridge } from "./bridge";
import { type MemoryFileStore } from "./filestore";
import { AppSearch } from "./ocr/appsearch";
import { serialize } from "./ocr/filetext";
import init from "./wasm/notes_web.js";
import { SearchView, snippetNodes } from "./searchview";

const hits: SearchHit[] = [
  { id: "n1", path: "Projekty/Plan.md", snippet: `ala ${MARK_START}żółw${MARK_END} ma <b>kota</b>` },
  { id: "n2", path: "Dziennik.md", snippet: `${MARK_START}żółw${MARK_END}` },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("snippetNodes", () => {
  it("marks the hits and keeps the note's text as text", () => {
    const host = document.createElement("span");
    host.append(snippetNodes(`x ${MARK_START}hit${MARK_END} <i>y</i>`));
    expect(host.querySelectorAll("mark")).toHaveLength(1);
    expect(host.querySelector("mark")?.textContent).toBe("hit");
    expect(host.textContent).toBe("x hit <i>y</i>");
    expect(host.querySelector("i")).toBeNull();
  });
});

describe("SearchView", () => {
  it("announces loading and recovers from a failed request", async () => {
    const root = document.createElement("div");
    let reject!: (reason: Error) => void;
    const call = vi.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no; })).mockResolvedValue(hits);
    const view = new SearchView(root, { call } as unknown as Bridge, vi.fn());
    const pending = view.run("kot");
    expect(root.querySelector(".search-status")?.getAttribute("data-state")).toBe("loading");
    expect(root.querySelector(".search-results")?.getAttribute("aria-busy")).toBe("true");
    reject(new Error("offline"));
    await pending;
    expect(root.querySelector(".search-status")?.getAttribute("data-state")).toBe("error");
    expect(root.querySelector(".search-results")?.getAttribute("aria-busy")).toBe("false");
    await view.run("zolw");
    expect(root.querySelectorAll(".search-hit")).toHaveLength(2);
    expect(root.querySelector(".search-status")?.getAttribute("data-state")).toBe("ready");
  });

  it("ignores an older response while a changed query is debouncing", async () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("div");
      let resolve!: (value: SearchHit[]) => void;
      const call = vi.fn().mockImplementationOnce(() => new Promise((yes) => { resolve = yes; })).mockResolvedValue([]);
      const view = new SearchView(root, { call } as unknown as Bridge, vi.fn());
      const pending = view.run("old");
      const input = root.querySelector<HTMLInputElement>("input")!;
      input.value = "new";
      input.dispatchEvent(new Event("input"));
      resolve(hits);
      await pending;
      expect(root.querySelectorAll(".search-hit")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(root.querySelector(".search-status")?.textContent).toBe("Brak wyników");
    } finally { vi.useRealTimers(); }
  });

  it("runs the query after a pause and lists the hits", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const bridge = { call: vi.fn(async () => hits) } as unknown as Bridge;
    const open = vi.fn();
    const view = new SearchView(root, bridge, open);
    view.focus("zolw");
    await wait(200);
    expect(bridge.call).toHaveBeenCalledWith("search", { query: "zolw", limit: 50 });
    expect(root.querySelector(".search-status")?.textContent).toBe("Wyników: 2");
    expect(root.querySelectorAll("button.search-hit")).toHaveLength(2);
    expect(root.querySelector("mark")?.textContent).toBe("żółw");

    (root.querySelectorAll("button.search-hit")[1] as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(hits[1]);
  });

  it("opens the first hit on Enter and says when nothing matches", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let answer: SearchHit[] = [];
    const bridge = { call: vi.fn(async () => answer) } as unknown as Bridge;
    const open = vi.fn();
    const view = new SearchView(root, bridge, open);
    await view.run("kot");
    expect(root.querySelector(".search-status")?.textContent).toBe("Brak wyników");

    answer = hits;
    await view.run("zolw");
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(open).toHaveBeenCalledWith(hits[0]);
  });
});

describe("SearchView over the app index (files and notes)", () => {
  beforeAll(async () => {
    const bytes = readFileSync(resolve(__dirname, "./wasm/notes_web_bg.wasm"));
    vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }));
    await init();
    vi.unstubAllGlobals();
  });

  it("lists a file hit with its page and the note that embeds it, and opens the file on a click", async () => {
    const bridge = new MockBridge();
    const files = bridge.files as unknown as MemoryFileStore;
    const info = await files.upload(new File([new Uint8Array(10)], "Skan.pdf", { type: "application/pdf" }), { id: "c".repeat(32) });
    const layer = serialize({ source: info.id, name: "Skan.pdf", mime: "application/pdf", method: "pdf-text", pages: [{ n: 1, text: "Pierwsza", lowQuality: false }, { n: 2, text: "Zyrafa42 na stronie drugiej", lowQuality: false }], lang: "latin", quality: 1, flags: [], extractor: 1, engine: "pdf.js", createdAt: "2026-11-19T15:02:11Z" });
    await files.writeTextLayer(info.id, layer, { extractor: 1, method: "pdf-text", pages: 2, lang: "latin", quality: 1, flags: [], engine: "pdf.js" });
    const app = new AppSearch(bridge);
    await app.ensure();
    await app.syncFiles();
    const root = document.createElement("div");
    const openFile = vi.fn();
    const view = new SearchView(root, bridge, vi.fn(), app, openFile);
    await view.run("zyrafa");
    const row = root.querySelector<HTMLButtonElement>("button.search-hit.search-hit")!;
    expect(root.querySelectorAll("button.search-hit")).toHaveLength(1);
    expect(row.querySelector("strong")?.textContent).toContain("Skan.pdf");
    expect(row.querySelector(".search-place")?.textContent).toBe(" · s.2");
    row.click();
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ kind: "file", docId: info.id, place: "s.2" }), "zyrafa");
  });
});
