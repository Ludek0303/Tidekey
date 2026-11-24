// The record that connects a project to a GitHub repository. It lives in the encrypted vault state (state.github,
// or the protected project's payload), so the server never sees it. Files are tracked by note id, not by path.

export interface GithubFile {
  path: string;
  blobSha: string;
  // Short hashes of the task and mention lines of the GitHub version: they do not count as the user's notes.
  guarded: string[];
  deleted?: boolean;
  conflict?: { blobSha: string; commit: string };
}

export interface GithubLink {
  id: string; // 32 hex: the lock name on the server
  projectPath: string; // "Projekty/Alfa"
  repo: string; // "owner/repo"
  ref: string | null; // null = the default branch
  repoPath: string; // "" or a folder in the repository
  target: string; // "GitHub" or "GitHub/<repo>", relative to projectPath; "" = the files go straight into projectPath
  include: string[];
  onDelete: "keep" | "trash";
  allowEdits: boolean;
  lastCommit: string | null;
  // The commit an import in parts is working on (GitHub's limit stopped it): lastCommit stays the old one until it is done.
  pendingCommit?: string | null;
  etag?: string | null; // the last ETag of the commit request
  lastAppliedAt: number | null;
  lastAppliedBy: string | null;
  files: Record<string, GithubFile>; // note id -> file
  ignored: string[];
  status: string;
  // The default branch GitHub reported the last time a link with ref null ran (its change goes to the status once).
  defaultBranch?: string | null;
  rev: number; // grows with every save
  // "Odłącz": the record stays as a tombstone with a higher rev, so other devices drop it too instead of sending it back
  removed?: boolean;
}

const HEX32 = /^[0-9a-f]{32}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA8 = /^[0-9a-f]{8}$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

// A relative path: no empty, "." or ".." segments, no leading "/", no "\", ":" or control characters.
function relPath(p: unknown, allowEmpty = false): boolean {
  if (typeof p !== "string") return false;
  if (p === "") return allowEmpty;
  if (p.startsWith("/") || /[\\:\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown, each: (s: unknown) => boolean = (s) => typeof s === "string"): v is string[] => Array.isArray(v) && v.every(each);

function validFile(v: unknown): v is GithubFile {
  if (!isObject(v)) return false;
  if (!relPath(v.path) || typeof v.blobSha !== "string" || !SHA40.test(v.blobSha)) return false;
  if (!isStrings(v.guarded, (s) => typeof s === "string" && SHA8.test(s))) return false;
  if (v.deleted !== undefined && typeof v.deleted !== "boolean") return false;
  if (v.conflict === undefined) return true;
  return isObject(v.conflict) && typeof v.conflict.blobSha === "string" && SHA40.test(v.conflict.blobSha)
    && typeof v.conflict.commit === "string" && SHA40.test(v.conflict.commit);
}

// Checks the shape of a record from storage or another device. Trust boundary: nothing here is trusted.
export function validLink(v: unknown): v is GithubLink {
  if (!isObject(v)) return false;
  if (typeof v.id !== "string" || !HEX32.test(v.id)) return false;
  if (!relPath(v.projectPath)) return false;
  // Owner and name, neither "." nor "..": the repository name goes into the API URL.
  if (typeof v.repo !== "string" || !/^[^/]+\/[^/]+$/.test(v.repo)) return false;
  if (!v.repo.split("/").every((s) => REPO_NAME.test(s) && s !== "." && s !== "..")) return false;
  if (v.ref !== null && !(typeof v.ref === "string" && v.ref.length <= 200 && relPath(v.ref))) return false;
  if (!relPath(v.repoPath, true)) return false;
  if (!relPath(v.target, true)) return false;
  if (!isStrings(v.include, (s) => typeof s === "string" && s !== "")) return false;
  if (v.onDelete !== "keep" && v.onDelete !== "trash") return false;
  if (typeof v.allowEdits !== "boolean") return false;
  if (v.lastCommit !== null && !(typeof v.lastCommit === "string" && SHA40.test(v.lastCommit))) return false;
  if (v.pendingCommit !== undefined && v.pendingCommit !== null && !(typeof v.pendingCommit === "string" && SHA40.test(v.pendingCommit))) return false;
  if (v.etag !== undefined && v.etag !== null && typeof v.etag !== "string") return false;
  if (v.lastAppliedAt !== null && !(typeof v.lastAppliedAt === "number" && Number.isFinite(v.lastAppliedAt))) return false;
  if (v.lastAppliedBy !== null && typeof v.lastAppliedBy !== "string") return false;
  if (!isObject(v.files) || !Object.values(v.files).every(validFile)) return false;
  if (!isStrings(v.ignored, (s) => relPath(s))) return false;
  if (typeof v.status !== "string") return false;
  if (v.defaultBranch !== undefined && v.defaultBranch !== null && !(typeof v.defaultBranch === "string" && v.defaultBranch.length <= 200 && relPath(v.defaultBranch))) return false;
  if (v.removed !== undefined && typeof v.removed !== "boolean") return false;
  return Number.isSafeInteger(v.rev) && (v.rev as number) >= 1;
}

export function newLink(projectPath: string, repo: string, opts: { ref?: string | null; repoPath?: string; target?: string; onDelete?: "keep" | "trash"; allowEdits?: boolean }): GithubLink {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const link: GithubLink = {
    id: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    projectPath,
    repo,
    ref: opts.ref ?? null,
    repoPath: opts.repoPath ?? "",
    target: opts.target ?? "GitHub",
    include: ["**/*.md", "**/*.markdown", "**/README"],
    onDelete: opts.onDelete ?? "keep",
    allowEdits: opts.allowEdits ?? true,
    lastCommit: null,
    lastAppliedAt: null,
    lastAppliedBy: null,
    files: {},
    ignored: [],
    status: "ok",
    rev: 1,
  };
  if (!validLink(link)) throw new Error("Nieprawidłowe połączenie z GitHubem.");
  return link;
}

// The remote record replaces the local one only when it is newer: a higher rev, or the same rev applied later.
// A full tie keeps the local record. Invalid remote records are dropped.
export function mergeLinks(local: GithubLink[], remote: GithubLink[]): GithubLink[] {
  const byId = new Map(local.map((l) => [l.id, l]));
  for (const r of remote) {
    if (!validLink(r)) continue;
    const mine = byId.get(r.id);
    const newer = !mine || (r.rev !== mine.rev ? r.rev > mine.rev : (r.lastAppliedAt ?? -Infinity) > (mine.lastAppliedAt ?? -Infinity));
    if (newer) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function linkFolder(link: GithubLink): string {
  return link.target ? `${link.projectPath}/${link.target}` : link.projectPath;
}

export function linksOfProject(links: GithubLink[], projectPath: string): GithubLink[] {
  return links.filter((l) => !l.removed && l.projectPath === projectPath);
}

// The link that tracks a note, with the note's file in it (a deleted file counts too; the caller reads `deleted`).
export function linkOfNote(links: GithubLink[], noteId: string): { link: GithubLink; file: GithubFile } | null {
  for (const link of links) {
    if (link.removed) continue;
    if (Object.hasOwn(link.files, noteId)) return { link, file: link.files[noteId] };
  }
  return null;
}
