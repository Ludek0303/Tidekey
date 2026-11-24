import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GITHUB_API,
  getRepo,
  getCommitSha,
  getCommitMessage,
  getTree,
  getBlob,
  gitBlobSha1,
  rateLimitStatus,
} from "./api";

// Tests never touch the network: every call gets a fake fetch.
interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
}
interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: Reply | Error): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (reply instanceof Error) throw reply;
    // A 304 response must not carry a body.
    const body = reply.status === 304 ? null : (reply.body ?? null);
    return new Response(body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return { f, calls };
}

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf8");
}

const NO_AUTH = { token: null };
const TOKEN = "ghp_TESTOWY_TOKEN_123456";
const AUTH = { token: TOKEN };
const REPO = "przyklad/notatki";
const COMMIT_SHA = "a3f1c9e2b7d4061f58c2e9a0d3b7f4e6c1a8d2b5";
const TREE_SHA = "9fb037999f264ba9a7fc6274d0e2ea0de9b1d9fd";
const HELLO_SHA = "ce013625030ba8dba906f756967f9e9ca394464a"; // git hash-object of "hello\n"
const HELLO = new TextEncoder().encode("hello\n");
const MAX_BLOB = 1024 * 1024;

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRepo", () => {
  it("reads default branch and visibility from the fixture", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("repo.json") });
    const r = await getRepo(REPO, NO_AUTH, f);
    expect(r).toEqual({ ok: true, value: { defaultBranch: "main", private: false } });
    expect(calls[0].url).toBe(`${GITHUB_API}/repos/przyklad/notatki`);
    expect(headersOf(calls[0])["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("rejects a bad repo name without a request", async () => {
    for (const bad of ["notatki", "a/b/c", "../x", "a b/c", "przyklad/"]) {
      const { f, calls } = fakeFetch({ status: 200, body: fixture("repo.json") });
      expect(await getRepo(bad, NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
      expect(calls).toHaveLength(0);
    }
  });

  it("maps 404 and 401 to notFound", async () => {
    for (const status of [404, 401]) {
      const { f } = fakeFetch({ status });
      expect(await getRepo(REPO, NO_AUTH, f)).toEqual({ ok: false, kind: "notFound" });
    }
  });

  it("maps broken JSON to invalid", async () => {
    const { f } = fakeFetch({ status: 200, body: "{nie json" });
    expect(await getRepo(REPO, NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
  });

  it("maps a thrown fetch to network", async () => {
    const { f } = fakeFetch(new TypeError("Failed to fetch"));
    expect(await getRepo(REPO, NO_AUTH, f)).toEqual({ ok: false, kind: "network" });
  });
});

describe("getCommitSha", () => {
  const shaBody = JSON.parse(fixture("commit.json")).sha as string;

  it("returns the sha with Accept sha and stores the ETag", async () => {
    const { f, calls } = fakeFetch({
      status: 200,
      body: shaBody,
      headers: { ETag: '"etag-1"' },
    });
    const r = await getCommitSha(REPO, "main", null, NO_AUTH, f);
    expect(r).toEqual({ ok: true, value: COMMIT_SHA, etag: '"etag-1"' });
    expect(headersOf(calls[0]).Accept).toBe("application/vnd.github.sha");
    expect(calls[0].init.cache).toBe("no-cache");
    expect(headersOf(calls[0])["If-None-Match"]).toBeUndefined();
  });

  it("sends the saved ETag back in If-None-Match and returns notModified on 304", async () => {
    const { f, calls } = fakeFetch({ status: 304, headers: { ETag: '"etag-1"' } });
    const r = await getCommitSha(REPO, "main", '"etag-1"', NO_AUTH, f);
    expect(r).toEqual({ ok: false, kind: "notModified" });
    expect(headersOf(calls[0])["If-None-Match"]).toBe('"etag-1"');
  });

  it("encodes each segment of a ref with a slash", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: shaBody });
    await getCommitSha(REPO, "gh/h4 api", null, NO_AUTH, f);
    expect(calls[0].url).toBe(`${GITHUB_API}/repos/przyklad/notatki/commits/gh/h4%20api`);
  });

  it("rejects a body that is not a sha", async () => {
    const { f } = fakeFetch({ status: 200, body: "<html>nie sha</html>" });
    expect(await getCommitSha(REPO, "main", null, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("maps 404 to notFound", async () => {
    const { f } = fakeFetch({ status: 404 });
    expect(await getCommitSha(REPO, "main", null, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "notFound",
    });
  });

  it("maps 403 with x-ratelimit-remaining 0 to rateLimited with resetAt in ms", async () => {
    const { f } = fakeFetch({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794000000" },
    });
    expect(await getCommitSha(REPO, "main", null, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "rateLimited",
      resetAt: 1794000000 * 1000,
    });
  });

  it("maps 429 with retry-after to rateLimited, resetAt = now + seconds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { f } = fakeFetch({ status: 429, headers: { "retry-after": "30" } });
    expect(await getCommitSha(REPO, "main", null, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "rateLimited",
      resetAt: 1_000_000 + 30_000,
    });
  });

  it("maps a plain 403 (no rate-limit headers) to notFound", async () => {
    const { f } = fakeFetch({ status: 403, headers: { "x-ratelimit-remaining": "42" } });
    expect(await getCommitSha(REPO, "main", null, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "notFound",
    });
  });

  it("maps a 5xx to network", async () => {
    const { f } = fakeFetch({ status: 503 });
    expect(await getCommitSha(REPO, "main", null, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "network",
    });
  });
});

describe("getCommitMessage", () => {
  it("returns the first line of the commit message", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("commit.json") });
    const r = await getCommitMessage(REPO, COMMIT_SHA, NO_AUTH, f);
    expect(r).toEqual({ ok: true, value: "Dodaj plan na listopad" });
    expect(calls[0].url).toBe(`${GITHUB_API}/repos/przyklad/notatki/commits/${COMMIT_SHA}`);
  });

  it("rejects a bad sha without a request", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("commit.json") });
    expect(await getCommitMessage(REPO, "main", NO_AUTH, f)).toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps a response without commit.message to invalid", async () => {
    const { f } = fakeFetch({ status: 200, body: JSON.stringify({ sha: COMMIT_SHA }) });
    expect(await getCommitMessage(REPO, COMMIT_SHA, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "invalid",
    });
  });
});

describe("getTree", () => {
  it("returns only blobs with path, blobSha and size", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("tree.json") });
    const r = await getTree(REPO, TREE_SHA, NO_AUTH, f);
    expect(r).toEqual({
      ok: true,
      value: [
        { path: "README.md", blobSha: "e8a2b4c6d0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9", size: 42 },
        { path: "notatki/plan.md", blobSha: "7b1d3f5a9c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d", size: 311 },
        { path: "notatki/zakupy.md", blobSha: "c3e5a7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1", size: 96 },
        { path: "obraz.png", blobSha: "4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a", size: 20480 },
      ],
    });
    expect(calls[0].url).toBe(`${GITHUB_API}/repos/przyklad/notatki/git/trees/${TREE_SHA}?recursive=1`);
  });

  it("maps truncated: true to tooLarge", async () => {
    const { f } = fakeFetch({ status: 200, body: fixture("tree-truncated.json") });
    expect(await getTree("przyklad/duze", TREE_SHA, NO_AUTH, f)).toEqual({
      ok: false,
      kind: "tooLarge",
    });
  });

  it("skips unsafe paths and keeps the safe ones", async () => {
    const tree = JSON.parse(fixture("tree.json")) as { tree: unknown[] };
    const blob = (path: string) => ({ path, type: "blob", sha: HELLO_SHA, size: 1 });
    tree.tree.push(
      blob("../evil.md"),
      blob("/abs.md"),
      blob("a\\b.md"),
      blob("c:x.md"),
      blob("a/../b.md"),
      blob("./x.md"),
      blob("a//b.md"),
      blob("kontrolny\u0001.md"),
      blob("ok/zdrowy.md"),
    );
    const { f } = fakeFetch({ status: 200, body: JSON.stringify(tree) });
    const r = await getTree(REPO, TREE_SHA, NO_AUTH, f);
    expect(r.ok && r.value.map((e) => e.path)).toEqual([
      "README.md",
      "notatki/plan.md",
      "notatki/zakupy.md",
      "obraz.png",
      "ok/zdrowy.md",
    ]);
  });

  it("maps a tree that is not an array to invalid", async () => {
    const { f } = fakeFetch({ status: 200, body: JSON.stringify({ sha: TREE_SHA, tree: "x" }) });
    expect(await getTree(REPO, TREE_SHA, NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
  });

  it("rejects a bad tree sha without a request", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("tree.json") });
    expect(await getTree(REPO, "main", NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("getBlob", () => {
  it("returns bytes whose git sha1 matches blobSha", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: HELLO });
    const r = await getBlob(REPO, HELLO_SHA, NO_AUTH, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.value)).toBe("hello\n");
    expect(headersOf(calls[0]).Accept).toBe("application/vnd.github.raw");
    expect(calls[0].url).toBe(`${GITHUB_API}/repos/przyklad/notatki/git/blobs/${HELLO_SHA}`);
  });

  it("rejects bytes whose sha1 does not match blobSha", async () => {
    const { f } = fakeFetch({ status: 200, body: new TextEncoder().encode("hellO\n") });
    expect(await getBlob(REPO, HELLO_SHA, NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
  });

  it("maps content-length above 1 MiB to tooLarge", async () => {
    const { f } = fakeFetch({
      status: 200,
      body: HELLO,
      headers: { "content-length": String(MAX_BLOB + 1) },
    });
    expect(await getBlob(REPO, HELLO_SHA, NO_AUTH, f)).toEqual({ ok: false, kind: "tooLarge" });
  });

  it("maps a body above 1 MiB without content-length to tooLarge", async () => {
    const { f } = fakeFetch({ status: 200, body: new Uint8Array(MAX_BLOB + 1) });
    expect(await getBlob(REPO, HELLO_SHA, NO_AUTH, f)).toEqual({ ok: false, kind: "tooLarge" });
  });

  it("rejects a bad blob sha or repo without a request", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: HELLO });
    expect(await getBlob(REPO, "../../x", NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
    expect(await getBlob("zla nazwa", HELLO_SHA, NO_AUTH, f)).toEqual({ ok: false, kind: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("maps 404 to notFound", async () => {
    const { f } = fakeFetch({ status: 404 });
    expect(await getBlob(REPO, HELLO_SHA, NO_AUTH, f)).toEqual({ ok: false, kind: "notFound" });
  });
});

describe("gitBlobSha1", () => {
  it("matches git hash-object for hello and for an empty blob", async () => {
    expect(await gitBlobSha1(HELLO)).toBe(HELLO_SHA);
    expect(await gitBlobSha1(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

describe("token handling", () => {
  it("sends the token only in the Authorization header", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("repo.json") });
    const r = await getRepo(REPO, AUTH, f);
    expect(headersOf(calls[0]).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0].init.body ?? "")).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("does not leak the token into an error result", async () => {
    const { f } = fakeFetch({ status: 500 });
    const r = await getRepo(REPO, AUTH, f);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("sends no Authorization header without a token", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: fixture("repo.json") });
    await getRepo(REPO, { token: null }, f);
    expect(headersOf(calls[0])).not.toHaveProperty("Authorization");
  });
});

describe("rateLimitStatus", () => {
  it("formats local time as HH:MM with two digits", () => {
    expect(rateLimitStatus(new Date(2026, 10, 14, 14, 20).getTime())).toBe("Limit GitHuba do 14:20");
    expect(rateLimitStatus(new Date(2026, 10, 14, 9, 5).getTime())).toBe("Limit GitHuba do 09:05");
  });
});
