import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resumeDownload, type ByteStore } from "./modelstore";
import type { ModelFile } from "./models";
import { VoiceError } from "./types";

const SIZE = 300_000;
const body = Uint8Array.from({ length: SIZE }, (_, i) => (i * 31 + (i >> 8)) & 0xff);
const file: ModelFile = {
  name: "test.bin",
  size: SIZE,
  sha256: createHash("sha256").update(body).digest("hex"),
  source: { repo: "test/test", rev: "main", path: "test.bin" },
};

// A byte store in memory, like the OPFS sync access handle the worker uses.
function memStore(initial: Uint8Array = new Uint8Array()) {
  let data = new Uint8Array(initial);
  return {
    size: () => data.length,
    read: (offset: number, length: number) => data.slice(offset, offset + length),
    write(offset: number, chunk: Uint8Array) {
      if (offset + chunk.length > data.length) {
        const grown = new Uint8Array(offset + chunk.length);
        grown.set(data);
        data = grown;
      }
      data.set(chunk, offset);
    },
    truncate: (n: number) => {
      data = data.slice(0, n);
    },
    flush: () => {},
    bytes: () => data,
  } satisfies ByteStore & { bytes(): Uint8Array };
}

// A response body in small chunks; it honors the signal like a real fetch stream.
function streamOf(part: Uint8Array, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
      if (at >= part.length) return c.close();
      c.enqueue(part.slice(at, at + 64 * 1024));
      at += 64 * 1024;
    },
  });
}

// Fake server for `data`: answers Range with 206, or with 200 and the whole file when it ignores Range.
function serve(data: Uint8Array, opts: { ignoreRange?: boolean; status?: number } = {}) {
  const calls: { headers: Record<string, string>; signal?: AbortSignal }[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ headers, signal: init?.signal ?? undefined });
    if (opts.status) return new Response("", { status: opts.status });
    const from = !opts.ignoreRange && headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)![1]) : 0;
    return new Response(streamOf(data.slice(from), init?.signal ?? undefined), { status: from > 0 ? 206 : 200 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const never = new AbortController().signal;

describe("resumeDownload", () => {
  it("downloads from zero and reports exactly the file size", async () => {
    const store = memStore();
    const { fetchFn, calls } = serve(body);
    const onBytes = vi.fn();
    await resumeDownload(fetchFn, store, file, "/models/x/test.bin", onBytes, never);
    expect(store.bytes()).toEqual(body);
    expect(calls[0].headers.Range).toBeUndefined();
    expect(onBytes.mock.calls.reduce((sum, [n]) => sum + n, 0)).toBe(SIZE);
  });

  it("resumes from the bytes already stored, with a Range request", async () => {
    const cut = 120_000;
    const store = memStore(body.slice(0, cut));
    const { fetchFn, calls } = serve(body);
    await resumeDownload(fetchFn, store, file, "/models/x/test.bin", () => {}, never);
    expect(calls[0].headers.Range).toBe(`bytes=${cut}-`);
    expect(store.bytes()).toEqual(body);
  });

  it("restarts from zero when the server ignores Range", async () => {
    const store = memStore(body.slice(0, 120_000));
    const { fetchFn } = serve(body, { ignoreRange: true });
    await resumeDownload(fetchFn, store, file, "/models/x/test.bin", () => {}, never);
    expect(store.bytes()).toEqual(body);
  });

  it("drops a wrong file: checksum error and an empty store", async () => {
    const store = memStore();
    const bad = { ...file, sha256: "0".repeat(64) };
    const { fetchFn } = serve(body);
    const run = resumeDownload(fetchFn, store, bad, "/models/x/test.bin", () => {}, never);
    await expect(run).rejects.toMatchObject({ code: "checksum" });
    expect(store.size()).toBe(0);
  });

  it("reports a server error as a download error", async () => {
    const { fetchFn } = serve(body, { status: 500 });
    const run = resumeDownload(fetchFn, memStore(), file, "/models/x/test.bin", () => {}, never);
    await expect(run).rejects.toBeInstanceOf(VoiceError);
    await expect(run).rejects.toMatchObject({ code: "download" });
  });

  it("aborts with AbortError, keeps the bytes, and resumes from them", async () => {
    const store = memStore();
    const { fetchFn, calls } = serve(body);
    const ctrl = new AbortController();
    let got = 0;
    const onBytes = (n: number) => {
      got += n;
      if (got > 100_000) ctrl.abort();
    };
    await expect(resumeDownload(fetchFn, store, file, "/models/x/test.bin", onBytes, ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const kept = store.size();
    expect(kept).toBeGreaterThan(100_000);
    expect(kept).toBeLessThan(SIZE);

    await resumeDownload(fetchFn, store, file, "/models/x/test.bin", () => {}, never);
    expect(calls[1].headers.Range).toBe(`bytes=${kept}-`);
    expect(store.bytes()).toEqual(body);
  });
});
