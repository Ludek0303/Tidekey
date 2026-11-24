// Browser client for the GitHub REST API (api.github.com, CORS). No login.
// The token, if any, goes only into the Authorization header.

export const GITHUB_API = "https://api.github.com";

const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
const MAX_BLOB_BYTES = 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface GithubAuth {
  token: string | null;
}

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

export type GithubFail =
  | "notModified"
  | "notFound"
  | "rateLimited"
  | "network"
  | "invalid"
  | "tooLarge";

export type GithubResult<T> =
  | { ok: true; value: T; etag?: string }
  | { ok: false; kind: GithubFail; resetAt?: number };

type Failure = { ok: false; kind: GithubFail; resetAt?: number };
const invalid: Failure = { ok: false, kind: "invalid" };

// Commits use "no-cache" instead of "no-store": the browser must still revalidate
// with the server. Our own If-None-Match carries the saved ETag, so a 304 still
// comes back to us. The other endpoints do not need the browser cache at all.
interface GetOptions {
  accept: string;
  cache: RequestCache;
  etag?: string | null;
}

// Sends one GET and maps HTTP status and network errors to GithubResult kinds.
async function get(
  path: string,
  auth: GithubAuth,
  f: typeof fetch,
  opts: GetOptions,
): Promise<GithubResult<Response>> {
  const headers: Record<string, string> = {
    Accept: opts.accept,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (opts.etag) headers["If-None-Match"] = opts.etag;

  let res: Response;
  try {
    res = await f(GITHUB_API + path, { headers, cache: opts.cache });
  } catch {
    return { ok: false, kind: "network" };
  }

  if (res.status === 304) return { ok: false, kind: "notModified" };
  // 401 is treated like no access: a bad token must not be reported as a rate limit.
  if (res.status === 404 || res.status === 401) return { ok: false, kind: "notFound" };
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = seconds(res.headers.get("retry-after"));
    const reset = seconds(res.headers.get("x-ratelimit-reset"));
    if (res.status === 429 || remaining === "0" || retryAfter !== undefined) {
      // retry-after first: GitHub asks clients to honour it over the reset time.
      const resetAt =
        retryAfter !== undefined
          ? Date.now() + retryAfter * 1000
          : reset !== undefined
            ? reset * 1000
            : undefined;
      return { ok: false, kind: "rateLimited", resetAt };
    }
    return { ok: false, kind: "notFound" };
  }
  if (!res.ok) return { ok: false, kind: res.status >= 500 ? "network" : "invalid" };
  return { ok: true, value: res, etag: res.headers.get("etag") ?? undefined };
}

function seconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const n = Number(header);
  return Number.isFinite(n) ? n : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Paths that could escape the target folder (.., absolute, backslash, colon,
// control characters, empty or "." segments) are dropped, not repaired.
function isSafePath(path: string): boolean {
  if (path.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// The regex allows dots, so "." and ".." must be rejected by hand, or they would reach the URL path.
function validRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !/(^|\/)\.{1,2}(\/|$)/.test(repo);
}

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

// A ref may contain "/" (branch names), so each segment is encoded on its own.
function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export async function getRepo(
  repo: string,
  auth: GithubAuth,
  f: typeof fetch = fetch,
): Promise<GithubResult<{ defaultBranch: string; private: boolean }>> {
  if (!validRepo(repo)) return invalid;
  const r = await get(repoPath(repo), auth, f, { accept: JSON_ACCEPT, cache: "no-store" });
  if (!r.ok) return r;
  const data = await readJson(r.value);
  if (!isObj(data)) return invalid;
  const defaultBranch = data.default_branch;
  const isPrivate = data.private;
  if (typeof defaultBranch !== "string" || typeof isPrivate !== "boolean") return invalid;
  return { ok: true, value: { defaultBranch, private: isPrivate } };
}

export async function getCommitSha(
  repo: string,
  ref: string,
  etag: string | null,
  auth: GithubAuth,
  f: typeof fetch = fetch,
): Promise<GithubResult<string>> {
  if (!validRepo(repo) || ref === "") return invalid;
  const r = await get(`${repoPath(repo)}/commits/${encodeRef(ref)}`, auth, f, {
    accept: "application/vnd.github.sha",
    cache: "no-cache",
    etag,
  });
  if (!r.ok) return r;
  let sha: string;
  try {
    sha = (await r.value.text()).trim();
  } catch {
    return { ok: false, kind: "network" };
  }
  if (!SHA_RE.test(sha)) return invalid;
  return { ok: true, value: sha, etag: r.etag };
}

export async function getCommitMessage(
  repo: string,
  sha: string,
  auth: GithubAuth,
  f: typeof fetch = fetch,
): Promise<GithubResult<string>> {
  if (!validRepo(repo) || !SHA_RE.test(sha)) return invalid;
  const r = await get(`${repoPath(repo)}/commits/${sha}`, auth, f, {
    accept: JSON_ACCEPT,
    cache: "no-store",
  });
  if (!r.ok) return r;
  const data = await readJson(r.value);
  if (!isObj(data) || !isObj(data.commit)) return invalid;
  const message = data.commit.message;
  if (typeof message !== "string") return invalid;
  return { ok: true, value: message.split("\n")[0].trim() };
}

export async function getTree(
  repo: string,
  sha: string,
  auth: GithubAuth,
  f: typeof fetch = fetch,
): Promise<GithubResult<TreeEntry[]>> {
  if (!validRepo(repo) || !SHA_RE.test(sha)) return invalid;
  const r = await get(`${repoPath(repo)}/git/trees/${sha}?recursive=1`, auth, f, {
    accept: JSON_ACCEPT,
    cache: "no-store",
  });
  if (!r.ok) return r;
  const data = await readJson(r.value);
  if (!isObj(data) || !Array.isArray(data.tree)) return invalid;
  // A truncated listing is incomplete, so it must not be used at all.
  if (data.truncated === true) return { ok: false, kind: "tooLarge" };

  const entries: TreeEntry[] = [];
  for (const e of data.tree) {
    if (!isObj(e) || typeof e.type !== "string") return invalid;
    if (e.type !== "blob") continue; // folders and submodules
    if (typeof e.path !== "string" || typeof e.sha !== "string" || typeof e.size !== "number") {
      return invalid;
    }
    if (isSafePath(e.path)) entries.push({ path: e.path, blobSha: e.sha, size: e.size });
  }
  return { ok: true, value: entries };
}

export async function getBlob(
  repo: string,
  blobSha: string,
  auth: GithubAuth,
  f: typeof fetch = fetch,
): Promise<GithubResult<Uint8Array>> {
  if (!validRepo(repo) || !SHA_RE.test(blobSha)) return invalid;
  const r = await get(`${repoPath(repo)}/git/blobs/${blobSha}`, auth, f, {
    accept: "application/vnd.github.raw",
    cache: "no-store",
  });
  if (!r.ok) return r;
  // Check the declared size first, so a huge file is never downloaded.
  const declared = r.value.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BLOB_BYTES) return { ok: false, kind: "tooLarge" };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await r.value.arrayBuffer());
  } catch {
    return { ok: false, kind: "network" };
  }
  if (bytes.byteLength > MAX_BLOB_BYTES) return { ok: false, kind: "tooLarge" };
  if ((await gitBlobSha1(bytes)) !== blobSha) return invalid;
  return { ok: true, value: bytes };
}

// Same hash git uses for a blob: sha1("blob <length>\0" + content).
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const data = new Uint8Array(header.byteLength + bytes.byteLength);
  data.set(header, 0);
  data.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function rateLimitStatus(resetAt: number): string {
  const d = new Date(resetAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Limit GitHuba do ${hh}:${mm}`;
}
