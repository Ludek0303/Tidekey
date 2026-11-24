// One update run of a GitHub link (docs/GITHUB.md §4, steps 1–9). Everything it touches comes in through UpdateDeps,
// so the run is testable without a network or a server: the caller passes the bridge, the lease and the fetch.
import * as Y from "yjs";
import {
  getBlob,
  getCommitMessage,
  getCommitSha,
  getRepo,
  getTree,
  rateLimitStatus,
  type GithubAuth,
  type GithubFail,
} from "./api";
import {
  guardedLines,
  isMarkdownPath,
  merge3,
  normalizeRepoPath,
  planUpdate,
  replaceText,
  stripMarkers,
  type Merge,
  type PlanAction,
  type TrackedFile,
  type TreeEntry,
} from "./core";
import { linkFolder, validLink, type GithubFile, type GithubLink } from "./link";

export interface UpdateDeps {
  // The bridge's call (Bridge.call): github_links, github_save_link, list_tree, create_note, rename, delete, open_note,
  // apply_update, github_save_version.
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  takeLease(name: string, ttlSeconds: number): Promise<boolean>; // POST /api/vaults/:id/leases
  releaseLease(name: string): Promise<void>;
  catchUp(): Promise<void>; // brings the local state up to the newest revision
  persistNow(): Promise<void>; // one save of the state to the server
  // The file store, under a deterministic id (docs/GITHUB.md §6a). A failure only goes into the status.
  archive(link: GithubLink, blobSha: string, bytes: Uint8Array, path?: string): Promise<void>;
  readArchive(link: GithubLink, blobSha: string): Promise<Uint8Array | null>; // the merge base
  auth: GithubAuth;
  fetch?: typeof fetch;
  userId: string;
  now(): number;
}

export type UpdateOutcome =
  | { kind: "unchanged" }
  | { kind: "busy" }
  | { kind: "applied"; commit: string; changed: number; conflicts: number; skipped: number }
  | { kind: "failed"; status: string; resetAt?: number };

const LEASE_SECONDS = 120;
const LEASE_RENEW_MS = 60_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface ListTree {
  notes: { id: string; path: string }[];
  folders: string[];
}

// A change to the notes, computed before anything is written (step 7).
type Write =
  | { op: "create"; path: string; text: string; file: GithubFile }
  | { op: "text"; id: string; before: string; after: string }
  | { op: "rename"; id: string; path: string }
  | { op: "trash"; id: string };

// What a failed GitHub call says: the kind and, for a rate limit, when it ends.
type Refusal = { kind: GithubFail; resetAt?: number };

// The default branch as GitHub reports it now. `note` is the status line for a change of branch, shown once.
interface Branch {
  name: string;
  note: string | null;
}

export async function runUpdate(linkId: string, deps: UpdateDeps): Promise<UpdateOutcome> {
  const start = await readLink(deps, linkId);
  if (!start) return { kind: "failed", status: "Połączenie nie istnieje." };

  // 1. Is there a new commit? A link without a ref follows the default branch, which is read first.
  let ref = start.ref;
  let branch: Branch | null = null;
  if (ref === null) {
    const repo = await getRepo(start.repo, deps.auth, deps.fetch);
    if (!repo.ok) return refused(deps, start, repo);
    ref = repo.value.defaultBranch;
    const moved = start.defaultBranch !== undefined && start.defaultBranch !== null && start.defaultBranch !== ref;
    branch = { name: ref, note: moved ? `Domyślna gałąź: ${ref}` : null };
  }
  const head = await getCommitSha(start.repo, ref, start.etag ?? null, deps.auth, deps.fetch);
  if (!head.ok && head.kind !== "notModified") return refused(deps, start, head);
  const etag = head.ok ? head.etag : undefined;
  let sha: string;
  if (head.ok) sha = head.value;
  else if (start.pendingCommit) sha = start.pendingCommit; // 304 while an import in parts is unfinished: finish that commit
  else {
    await keepRecord(deps, start, branch, undefined);
    return { kind: "unchanged" };
  }
  if (sha === start.lastCommit && !start.pendingCommit) {
    await keepRecord(deps, start, branch, etag);
    return { kind: "unchanged" };
  }

  // 2. One device applies an update at a time. The lease is renewed while the run lasts.
  if (!(await deps.takeLease(linkId, LEASE_SECONDS))) return { kind: "busy" };
  const renew = setInterval(() => {
    deps.takeLease(linkId, LEASE_SECONDS).catch(() => false);
  }, LEASE_RENEW_MS);
  try {
    return await applyCommit(deps, linkId, sha, etag, branch);
  } finally {
    clearInterval(renew);
    await deps.releaseLease(linkId);
  }
}

async function applyCommit(
  deps: UpdateDeps,
  linkId: string,
  sha: string,
  etag: string | undefined,
  branch: Branch | null,
): Promise<UpdateOutcome> {
  // 3. Catch up first: another device may have applied this commit already.
  await deps.catchUp();
  const link = await readLink(deps, linkId);
  if (!link) return { kind: "failed", status: "Połączenie nie istnieje." };
  if (link.lastCommit === sha && !link.pendingCommit) {
    await keepRecord(deps, link, branch, etag);
    return { kind: "unchanged" };
  }

  // 4. The files of the commit, inside the folder of the repository.
  const tree = await getTree(link.repo, sha, deps.auth, deps.fetch);
  if (!tree.ok) {
    if (tree.kind === "tooLarge") return stop(deps, link, "Repozytorium jest za duże, wybierz podfolder.");
    return refused(deps, link, tree);
  }
  const entries: TreeEntry[] = [];
  let skipped = 0;
  for (const e of tree.value) {
    if (!isMarkdownPath(e.path)) continue;
    const path = normalizeRepoPath(e.path, link.repoPath);
    if (path === null) {
      skipped++;
      continue;
    }
    entries.push({ path, blobSha: e.blobSha, size: e.size });
  }

  // A note in conflict is left alone until the conflict is resolved (docs/GITHUB.md §8). It stays tracked, so the plan
  // still sees its path; its actions are dropped here, before any download.
  const frozen = (action: PlanAction): boolean => "noteId" in action && link.files[action.noteId]?.conflict !== undefined;

  // 5. What the tracked notes look like now, and what the plan says to do.
  const listing = await deps.call<ListTree>("list_tree");
  const noteAt = new Map(listing.notes.map((n) => [n.id, n.path]));
  const files: Record<string, GithubFile> = { ...link.files };
  const ignored = [...link.ignored];
  const tracked: TrackedFile[] = [];
  const bases = new Map<string, string | null>();
  const ours = new Map<string, string>();
  for (const [noteId, file] of Object.entries(link.files)) {
    if (file.deleted) continue;
    if (!noteAt.has(noteId)) {
      // The user deleted the note (to the trash too): its path is not synced again (docs/GITHUB.md §4).
      delete files[noteId];
      ignored.push(file.path);
      continue;
    }
    const base = await baseText(deps, link, file.blobSha);
    const text = await noteText(deps, noteId);
    bases.set(noteId, base);
    ours.set(noteId, text);
    tracked.push({ noteId, path: file.path, blobSha: file.blobSha, hasEdits: base === null || text !== base });
  }
  const planned = planUpdate(tracked, entries, [...new Set(ignored)], link.onDelete === "trash");
  if (!planned.ok) return stop(deps, link, "Nie udało się ustalić zmian.");

  // 6. Download what is new or changed, and archive it. Bad content is skipped, not written.
  const fetched = new Map<PlanAction, string>();
  const notes: string[] = [];
  let markers = 0;
  const downloads = planned.actions.filter((a) => !frozen(a) && (a.kind === "create" || a.kind === "update")).length;
  let done = 0;
  // GitHub's limit stops the downloads: the run applies what it has (step 7) and says where it stopped.
  let limited: { resetAt?: number } | null = null;
  for (const action of planned.actions) {
    if (frozen(action)) continue;
    if (action.kind === "skip") {
      skipped++;
      continue;
    }
    if (action.kind !== "create" && action.kind !== "update") continue;
    const blob = await getBlob(link.repo, action.blobSha, deps.auth, deps.fetch);
    if (!blob.ok) {
      if (blob.kind === "rateLimited") {
        limited = { resetAt: blob.resetAt };
        break;
      }
      if (blob.kind === "invalid") notes.push(`Niezgodna suma pliku: ${action.path}`);
      skipped++;
      done++;
      continue;
    }
    done++;
    try {
      await deps.archive(link, action.blobSha, blob.value, action.path);
    } catch {
      notes.push(`Nie zapisano kopii pliku: ${action.path}`);
    }
    const text = decode(blob.value);
    if (text === null) {
      notes.push(`Pominięto plik spoza UTF-8: ${action.path}`);
      skipped++;
      continue;
    }
    const clean = stripMarkers(text);
    markers += clean.removed;
    fetched.set(action, clean.text);
  }
  // Without a token the limit is per IP, so a run stops at the first refusal; the rest comes in the next run.
  const partial = limited === null ? null : `Import w częściach: ${done} z ${downloads} ${plural(downloads)} · ${limited.resetAt === undefined ? "Limit GitHuba, spróbuj później." : rateLimitStatus(limited.resetAt)}`;

  // 7a. Compute every change on paper first. Nothing is written in this step.
  const folder = linkFolder(link);
  const taken = new Map<string, string>(); // lowercased path -> owning note id, or "folder"
  for (const n of listing.notes) taken.set(n.path.toLowerCase(), n.id);
  for (const f of listing.folders) taken.set(f.toLowerCase(), "folder");
  const freeFor = (owner: string) => (p: string): boolean => {
    const k = taken.get(p.toLowerCase());
    return k === undefined || k === owner;
  };
  const claim = (noteId: string): void => {
    const current = noteAt.get(noteId);
    if (current !== undefined) taken.delete(current.toLowerCase());
  };

  const writes: Write[] = [];
  let changed = 0;
  for (const action of planned.actions) {
    if (frozen(action)) continue;
    switch (action.kind) {
      case "move": {
        const file = files[action.noteId];
        if (!file) break;
        const to = freeName(`${folder}/${noteName(action.to)}`, freeFor(action.noteId));
        claim(action.noteId);
        taken.set(to.toLowerCase(), action.noteId);
        writes.push({ op: "rename", id: action.noteId, path: to });
        files[action.noteId] = { ...file, path: action.to, blobSha: action.blobSha };
        changed++;
        break;
      }
      case "update": {
        const file = files[action.noteId];
        const theirs = fetched.get(action);
        const base = bases.get(action.noteId);
        const mine = ours.get(action.noteId);
        if (!file || theirs === undefined || mine === undefined) break;
        // A clean copy (allowEdits off) takes GitHub's text as it is. Otherwise, no base (the archive has no copy of
        // the old version) keeps the note as it is and makes a conflict.
        const merged: Merge = !link.allowEdits
          ? { clean: theirs }
          : base === null || base === undefined
            ? { conflict: true }
            : base === mine
              ? { clean: theirs }
              : merge3(base, mine, theirs);
        if ("conflict" in merged) {
          files[action.noteId] = { ...file, conflict: { blobSha: action.blobSha, commit: sha } };
          break;
        }
        if (merged.clean !== mine) {
          writes.push({ op: "text", id: action.noteId, before: mine, after: merged.clean });
          changed++;
        }
        files[action.noteId] = { path: action.path, blobSha: action.blobSha, guarded: guardedLines(theirs) };
        break;
      }
      case "create": {
        const text = fetched.get(action);
        if (text === undefined) break;
        // A user's note on that path is never taken over: the GitHub file is named beside it, "(GitHub)".
        const path = freeName(`${folder}/${noteName(action.path)}`, freeFor(""), "GitHub");
        taken.set(path.toLowerCase(), "created");
        writes.push({ op: "create", path, text, file: { path: action.path, blobSha: action.blobSha, guarded: guardedLines(text) } });
        changed++;
        break;
      }
      case "markDeleted": {
        const file = files[action.noteId];
        if (file) files[action.noteId] = { ...file, deleted: true };
        changed++;
        break;
      }
      case "trash": {
        claim(action.noteId);
        writes.push({ op: "trash", id: action.noteId });
        delete files[action.noteId];
        changed++;
        break;
      }
      case "skip":
        break;
    }
  }
  // Every file still in conflict counts, also one whose commit had no action this run.
  const conflicts = Object.values(files).filter((f) => f.conflict !== undefined && !f.deleted).length;

  // 7b. The new record, checked before any note changes. Created notes get their ids only from the bridge, so until then
  // they sit under placeholder keys: validLink checks their content, not their keys.
  const status = partial ?? [
    conflicts > 0 ? `Konflikt: ${conflicts} ${plural(conflicts)}` : "ok",
    ...(markers > 0 ? [`Pominięto znaczniki uprawnień: ${markers}`] : []),
    ...notes,
    ...(branch?.note ? [branch.note] : []),
  ].join(" · ");
  const placeholders: Record<string, GithubFile> = {};
  writes.forEach((w, i) => {
    if (w.op === "create") placeholders[`pending-${i}`] = w.file;
  });
  const record: GithubLink = {
    ...link,
    files: { ...files, ...placeholders },
    ignored: [...new Set(ignored)],
    // A partial run keeps the old commit and names the new one as pending; the next run finishes it.
    lastCommit: partial === null ? sha : link.lastCommit,
    pendingCommit: partial === null ? null : sha,
    etag: etag ?? link.etag ?? null,
    lastAppliedAt: deps.now(),
    lastAppliedBy: deps.userId,
    status,
    defaultBranch: branch?.name ?? link.defaultBranch,
  };
  if (!validLink(record)) return { kind: "failed", status: "Zapis połączenia byłby nieprawidłowy, nic nie zmieniono." };

  // 7c. Apply. A version of each note goes in before its text changes, under the reason that names the commit.
  const title = writes.some((w) => w.op === "text") ? await commitTitle(deps, link, sha) : "";
  const reason = `GitHub ${sha.slice(0, 7)}${title ? `: ${title}` : ""}`;
  const created: Record<string, GithubFile> = {};
  for (const w of writes) {
    if (w.op === "create") {
      const id = await deps.call<string>("create_note", { path: w.path });
      await writeText(deps, id, w.text);
      created[id] = w.file;
    } else if (w.op === "text") {
      await deps.call("github_save_version", { id: w.id, reason, text: w.before });
      await writeText(deps, w.id, w.after);
    } else if (w.op === "rename") {
      await deps.call("rename", { id: w.id, path: w.path });
    } else {
      await deps.call("delete", { id: w.id });
    }
  }

  // 8. One save of the record, straight after the note changes, then the state. A failure here leaves the commit
  // unrecorded: the next run must not create the same notes again (see the report).
  try {
    await save(deps, { ...record, files: { ...files, ...created } });
    await deps.persistNow();
  } catch {
    return { kind: "failed", status: "Nie udało się zapisać aktualizacji." };
  }
  if (partial !== null && limited !== null) {
    return limited.resetAt === undefined ? { kind: "failed", status: partial } : { kind: "failed", status: partial, resetAt: limited.resetAt };
  }
  return { kind: "applied", commit: sha, changed, conflicts, skipped };
}

async function readLink(deps: UpdateDeps, linkId: string): Promise<GithubLink | null> {
  const links = await deps.call<GithubLink[]>("github_links");
  return links.find((l) => l.id === linkId) ?? null;
}

const save = (deps: UpdateDeps, link: GithubLink): Promise<GithubLink> => deps.call<GithubLink>("github_save_link", { link });

// Saves what changed on a run that ends without an update: the commit's ETag and the default branch, with its note.
async function keepRecord(deps: UpdateDeps, link: GithubLink, branch: Branch | null, etag: string | undefined): Promise<void> {
  const etagChanged = etag !== undefined && etag !== (link.etag ?? null);
  const branchChanged = branch !== null && branch.name !== link.defaultBranch;
  if (!etagChanged && !branchChanged) return;
  await save(deps, {
    ...link,
    ...(etagChanged ? { etag } : {}),
    ...(branch !== null && branchChanged ? { defaultBranch: branch.name, status: branch.note ? `${link.status} · ${branch.note}` : link.status } : {}),
  });
}

// Saves the status and stops: the record stays as it was except for the status.
async function stop(deps: UpdateDeps, link: GithubLink, status: string, resetAt?: number): Promise<UpdateOutcome> {
  await save(deps, { ...link, status });
  return resetAt === undefined ? { kind: "failed", status } : { kind: "failed", status, resetAt };
}

// A failed GitHub call. Not found and a rate limit change the status; a network error leaves it as it was.
async function refused(deps: UpdateDeps, link: GithubLink, r: Refusal): Promise<UpdateOutcome> {
  if (r.kind === "notFound") return stop(deps, link, "Repozytorium niedostępne");
  if (r.kind === "rateLimited") {
    return r.resetAt === undefined ? stop(deps, link, "Limit GitHuba, spróbuj później.") : stop(deps, link, rateLimitStatus(r.resetAt), r.resetAt);
  }
  return { kind: "failed", status: link.status };
}

// The base of a merge: the archived copy of the old blob, without permission markers. Null if there is none.
async function baseText(deps: UpdateDeps, link: GithubLink, blobSha: string): Promise<string | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.readArchive(link, blobSha);
  } catch {
    return null;
  }
  const text = bytes ? decode(bytes) : null;
  return text === null ? null : stripMarkers(text).text;
}

async function noteText(deps: UpdateDeps, id: string): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await deps.call<Uint8Array>("open_note", { id }));
  return doc.getText("content").toString();
}

// Makes the note's text `text`, as one change on its current state (the difference goes as an update).
async function writeText(deps: UpdateDeps, id: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await deps.call<Uint8Array>("open_note", { id }));
  const before = Y.encodeStateVector(doc);
  replaceText(doc, text);
  // `github: true`: the browser bridge lets this run write into a clean copy (allowEdits off), which refuses the user.
  await deps.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before), github: true });
}

// The first line of the commit message; a failed request gives an empty title, so the reason still names the commit.
async function commitTitle(deps: UpdateDeps, link: GithubLink, sha: string): Promise<string> {
  const message = await getCommitMessage(link.repo, sha, deps.auth, deps.fetch);
  return message.ok ? message.value : "";
}

function decode(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

// The first free name: "a/nota.md" becomes "a/nota (2).md", and so on. Bases the suffix on the name without extension.
/** A repository path as a note path: notes end in ".md", so "README" becomes "README.md" and "a.markdown" "a.md". */
export function noteName(repoPath: string): string {
  if (/\.md$/i.test(repoPath)) return repoPath;
  return /\.markdown$/i.test(repoPath) ? repoPath.replace(/\.markdown$/i, ".md") : `${repoPath}.md`;
}

// With `tag` the copy is named so instead: "a/nota (GitHub).md", then "a/nota (GitHub 2).md".
function freeName(path: string, isFree: (p: string) => boolean, tag?: string): string {
  if (isFree(path)) return path;
  const nameStart = path.lastIndexOf("/") + 1;
  const dot = path.lastIndexOf(".");
  const cut = dot > nameStart ? dot : path.length;
  for (let n = tag ? 1 : 2; ; n++) {
    const label = tag ? (n === 1 ? tag : `${tag} ${n}`) : String(n);
    const candidate = `${path.slice(0, cut)} (${label})${path.slice(cut)}`;
    if (isFree(candidate)) return candidate;
  }
}

function plural(n: number): string {
  if (n === 1) return "plik";
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "pliki" : "plików";
}
