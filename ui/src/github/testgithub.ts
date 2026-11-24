// A fake GitHub for tests: commits made in memory, served the way api.ts asks for them. Shared by the update and
// service tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitBlobSha1 } from "./api";

const enc = new TextEncoder();
const repoJson = readFileSync(resolve(__dirname, "fixtures", "repo.json"), "utf8");

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
}

export class FakeGitHub {
  readonly log: { path: string; status: number }[] = [];
  // Every request gets this status until it is cleared (404, or a rate limit).
  override: { status: number; headers?: Record<string, string> } | null = null;
  // Blob shas served with other bytes than their id, to test the blobSha check.
  readonly corrupt = new Set<string>();
  // Blobs left before GitHub's limit answers 403 (as without a token); null = no limit.
  blobLimit: { left: number; reset: number } | null = null;
  head = "";
  // The default branch: the repo route reports it, and the commits route follows it.
  branch = "main";
  private commits = new Map<string, { message: string; files: Map<string, { text: string; sha: string }> }>();
  private blobs = new Map<string, string>();

  constructor(readonly repo = "acme/notatki") {}

  // Makes a commit on top of the head: `changes` maps a path to its new text, or to null when the file is deleted.
  async commit(message: string, changes: Record<string, string | null>): Promise<string> {
    const files = new Map(this.commits.get(this.head)?.files ?? []);
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) files.delete(path);
      else files.set(path, { text, sha: await gitBlobSha1(enc.encode(text)) });
    }
    for (const f of files.values()) this.blobs.set(f.sha, f.text);
    const sha = (this.commits.size + 1).toString(16).padStart(40, "0");
    this.commits.set(sha, { message, files });
    this.head = sha;
    return sha;
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const reply = this.answer(url.pathname, (init?.headers ?? {}) as Record<string, string>);
    this.log.push({ path: url.pathname + url.search, status: reply.status });
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  private answer(path: string, headers: Record<string, string>): Reply {
    if (this.override) return { status: this.override.status, headers: this.override.headers };
    const base = `/repos/${this.repo}`;
    if (path === base) return { status: 200, body: JSON.stringify({ ...JSON.parse(repoJson), default_branch: this.branch }) };
    if (path === `${base}/commits/${this.branch}`) {
      const etag = `"${this.head}"`;
      if (headers["If-None-Match"] === etag) return { status: 304 };
      return { status: 200, body: this.head, headers: { etag } };
    }
    const commit = path.match(/\/commits\/([0-9a-f]{40})$/);
    if (commit) {
      const c = this.commits.get(commit[1]);
      return c ? { status: 200, body: JSON.stringify({ commit: { message: c.message } }) } : { status: 404 };
    }
    const tree = path.match(/\/git\/trees\/([0-9a-f]{40})$/);
    if (tree) {
      const c = this.commits.get(tree[1]);
      if (!c) return { status: 404 };
      const entries = [...c.files].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha, size: enc.encode(f.text).byteLength }));
      return { status: 200, body: JSON.stringify({ truncated: false, tree: entries }) };
    }
    const blob = path.match(/\/git\/blobs\/([0-9a-f]{40})$/);
    if (blob) {
      if (this.blobLimit) {
        if (this.blobLimit.left <= 0) return { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(this.blobLimit.reset) } };
        this.blobLimit.left--;
      }
      const text = this.blobs.get(blob[1]);
      if (text === undefined) return { status: 404 };
      return { status: 200, body: enc.encode(this.corrupt.has(blob[1]) ? "podmieniona treść\n" : text) };
    }
    return { status: 404 };
  }
}
