// The GitHub service of an open shared vault in the browser (docs/GITHUB.md): the screens' contract (service.ts) over
// one update run (update.ts), the schedule (schedule.ts), the vault's leases on the server, the file store archive
// (§6a) and the user's personal token (§7). The token goes only to api.github.com, never to the notes server.
import * as Y from "yjs";
import { getBlob, getCommitSha, getRepo, getTree, rateLimitStatus, type GithubFail } from "./api";
import { guardedLines, isMarkdownPath, normalizeRepoPath, parseRepoUrl, planUpdate, replaceText, stripMarkers, type TreeEntry } from "./core";
import { linkOfNote, linksOfProject, newLink, type GithubFile, type GithubLink } from "./link";
import { GithubSchedule } from "./schedule";
import { runUpdate, type UpdateDeps, type UpdateOutcome } from "./update";
import type { ConnectOptions, GithubConflict, GithubService, RepoPreview } from "./service";
import type { FileStore } from "../filestore";
import { ApiError, api, bufferSource, type Role } from "../vaults";

/** What the browser bridge gives the service: its calls (with their guards), the vault, the store, the saves, the token. */
export interface GithubHost {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  vaultId: string;
  userId: string;
  role(): Role | null;
  /** The vault's file store, or null: the archive then lives in this session only. */
  files: Pick<FileStore, "upload" | "info" | "read"> | null;
  /** The secret of the archive ids (the raw vault key), the same on every member's device. */
  archiveSecret(): Uint8Array | null;
  /** Resolves once this device holds the server's newest state. */
  catchUp(): Promise<void>;
  /** Saves the state to the server and resolves once the server took it. */
  persistNow(): Promise<void>;
  /** Settles once the account settings (and so the token) were read. */
  tokenReady(): Promise<void>;
  token(): string | null;
  setToken(token: string | null): Promise<void>;
}

export interface BrowserGithubService extends GithubService {
  /** Starts the checks while the app is open (editor and up); idempotent. */
  startSchedule(): void;
  stopSchedule(): void;
  scheduled(): boolean;
}

export const NO_STORE_STATUS = "Brak magazynu plików: archiwum wersji z GitHuba nie jest zapisywane.";
const BAD_ADDRESS = "To nie jest adres repozytorium na GitHubie.";
const NOT_FOUND = "Nie ma takiego repozytorium albo jest prywatne. Dla prywatnego dodaj token.";
const TOO_LARGE = "Repozytorium jest za duże, wybierz podfolder.";
const NO_CONNECTION = "Nie udało się połączyć z GitHubem. Spróbuj ponownie.";
const RATE_LIMITED = "Limit GitHuba, spróbuj później.";
const BUSY = "Inne urządzenie właśnie aktualizuje to połączenie.";
const NO_LINK = "Połączenie nie istnieje.";
const NOT_GITHUB_NOTE = "Ta notatka nie pochodzi z GitHuba.";
const EDITORS_ONLY = "Połączenie z GitHubem zmienia edytor, administrator albo właściciel.";
const RESOLVE_REASON = "Przed rozwiązaniem konfliktu z GitHubem";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The archive id of a blob (docs/GITHUB.md §6a): HMAC-SHA256(secret, "github\0" + link id + "\0" + blobSha), 32 hex. */
export async function archiveId(secret: Uint8Array, linkId: string, blobSha: string): Promise<string> {
  const mac = await crypto.subtle.importKey("raw", bufferSource(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`github\0${linkId}\0${blobSha}`));
  return hex(new Uint8Array(digest)).slice(0, 32);
}

function failText(r: { kind: GithubFail; resetAt?: number }): string {
  if (r.kind === "notFound") return NOT_FOUND;
  if (r.kind === "tooLarge") return TOO_LARGE;
  if (r.kind === "rateLimited") return r.resetAt === undefined ? RATE_LIMITED : rateLimitStatus(r.resetAt);
  return NO_CONNECTION;
}

function decode(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function plural(n: number): string {
  if (n === 1) return "plik";
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "pliki" : "plików";
}

// The status after a resolved conflict: its first part counts the conflicts left; the other parts stay.
function conflictStatus(status: string, left: number): string {
  const parts = status.split(" · ");
  if (parts[0] === "ok" || parts[0].startsWith("Konflikt:")) parts[0] = left > 0 ? `Konflikt: ${left} ${plural(left)}` : "ok";
  return parts.join(" · ");
}

export function createGithubService(host: GithubHost): BrowserGithubService {
  const base = `/api/vaults/${encodeURIComponent(host.vaultId)}`;
  const memory = new Map<string, Uint8Array>(); // the archive without a file store
  const auth = () => ({ token: host.token() });
  const canUpdate = (): boolean => host.role() === "owner" || host.role() === "admin" || host.role() === "editor";
  const allLinks = (): Promise<GithubLink[]> => host.call<GithubLink[]>("github_links");
  const find = async (id: string): Promise<GithubLink | null> => (await allLinks()).find((l) => l.id === id) ?? null;
  const save = (link: GithubLink): Promise<GithubLink> => host.call<GithubLink>("github_save_link", { link });

  async function secret(): Promise<Uint8Array> {
    const s = host.archiveSecret();
    if (!s) throw new Error("Brak klucza sejfu.");
    return s;
  }

  async function archive(link: GithubLink, blobSha: string, bytes: Uint8Array, path?: string): Promise<void> {
    if (!host.files) {
      memory.set(`${link.id}\0${blobSha}`, bytes);
      return;
    }
    const id = await archiveId(await secret(), link.id, blobSha);
    // The file store picks the project's key for a protected project; its name and content are sealed like any file.
    // A readable name in the project's files: the short blob sha and the file's name in the repository.
    const short = `GitHub ${blobSha.slice(0, 7)}`;
    const name = path === undefined ? `${short}.md` : `${short} ${path.slice(path.lastIndexOf("/") + 1)}`;
    const file = new File([bufferSource(bytes)], name, { type: "text/markdown" });
    try {
      await host.files.upload(file, { id, project: link.projectPath });
    } catch (e) {
      // Another member's device archived the same blob under the same id first.
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
  }

  async function readArchive(link: GithubLink, blobSha: string): Promise<Uint8Array | null> {
    if (!host.files) return memory.get(`${link.id}\0${blobSha}`) ?? null;
    const id = await archiveId(await secret(), link.id, blobSha);
    if (!(await host.files.info(id))) return null;
    return new Uint8Array(await (await host.files.read(id)).arrayBuffer());
  }

  // GitHub's text of a blob as the note took it (without permission markers): from the archive, else from GitHub.
  async function githubText(link: GithubLink, blobSha: string): Promise<string | null> {
    let bytes = await readArchive(link, blobSha).catch(() => null);
    if (!bytes) {
      const blob = await getBlob(link.repo, blobSha, auth());
      if (!blob.ok) return null;
      bytes = blob.value;
      await archive(link, blobSha, bytes).catch(() => undefined);
    }
    const text = decode(bytes);
    return text === null ? null : stripMarkers(text).text;
  }

  const deps = (): UpdateDeps => ({
    call: (cmd, args) => host.call(cmd, args),
    takeLease: async (name, ttlSeconds) => (await api<{ granted?: boolean }>(`${base}/leases`, "POST", { name, ttlSeconds })).granted === true,
    // A failed release only leaves the lease to expire; it must not hide the outcome of the run.
    releaseLease: async (name) => { await api(`${base}/leases/${encodeURIComponent(name)}`, "DELETE").catch(() => undefined); },
    catchUp: () => host.catchUp(),
    persistNow: () => host.persistNow(),
    archive,
    readArchive,
    auth: auth(),
    userId: host.userId,
    now: () => Date.now(),
  });

  // One run per link at a time (the schedule and "Sprawdź teraz" share it): the lease would let this device in twice.
  const inflight = new Map<string, Promise<UpdateOutcome>>();
  function run(linkId: string): Promise<UpdateOutcome> {
    const running = inflight.get(linkId);
    if (running) return running;
    const p = (async (): Promise<UpdateOutcome> => {
      await host.tokenReady();
      const outcome = await runUpdate(linkId, deps());
      if (!host.files && outcome.kind === "applied") {
        const link = await find(linkId);
        if (link && !link.status.includes(NO_STORE_STATUS)) {
          await save({ ...link, status: `${link.status} · ${NO_STORE_STATUS}` });
          await host.persistNow();
        }
      }
      return outcome;
    })().finally(() => inflight.delete(linkId));
    inflight.set(linkId, p);
    return p;
  }

  const schedule = new GithubSchedule({
    links: allLinks,
    run,
    hasToken: () => host.token() !== null,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    visible: () => document.visibilityState === "visible",
  });
  let active = false;
  const onVisibility = (): void => { if (document.visibilityState === "visible") schedule.onVisible(); };

  const noteInfo = async (noteId: string): Promise<{ link: GithubLink; file: GithubFile } | null> => linkOfNote(await allLinks(), noteId);

  return {
    async preview(address) {
      const parsed = parseRepoUrl(address.trim());
      if (!parsed) return { ok: false, message: BAD_ADDRESS };
      const repo = `${parsed.owner}/${parsed.repo}`;
      const info = await getRepo(repo, auth());
      if (!info.ok) return { ok: false, message: failText(info) };
      const head = await getCommitSha(repo, parsed.gitRef ?? info.value.defaultBranch, null, auth());
      if (!head.ok) return { ok: false, message: failText(head) };
      const tree = await getTree(repo, head.value, auth());
      if (!tree.ok) return { ok: false, message: failText(tree) };
      // The limits of an import are the plan's own (2000 files, 1 MiB each, 20 MiB in all): a first import plans them.
      const entries: TreeEntry[] = [];
      let skipped = 0;
      for (const e of tree.value) {
        if (!isMarkdownPath(e.path) || (parsed.path && !e.path.startsWith(`${parsed.path}/`))) continue;
        const path = normalizeRepoPath(e.path, parsed.path);
        if (path === null) skipped++;
        else entries.push({ path, blobSha: e.blobSha, size: e.size });
      }
      const plan = planUpdate([], entries, [], false);
      if (!plan.ok) return { ok: false, message: NO_CONNECTION };
      const sizes = new Map(entries.map((e) => [e.path, e.size]));
      let markdownFiles = 0;
      let totalBytes = 0;
      for (const a of plan.actions) {
        if (a.kind === "create") {
          markdownFiles++;
          totalBytes += sizes.get(a.path) ?? 0;
        } else if (a.kind === "skip") skipped++;
      }
      const value: RepoPreview = { repo, ref: parsed.gitRef, repoPath: parsed.path, defaultBranch: info.value.defaultBranch, private: info.value.private, markdownFiles, totalBytes, skipped };
      return { ok: true, value };
    },

    async connect(projectPath: string, o: ConnectOptions) {
      if (!canUpdate()) throw new Error(EDITORS_ONLY);
      const saved = await save(newLink(projectPath, o.repo, { ref: o.ref, repoPath: o.repoPath, target: o.target, onDelete: o.onDelete, allowEdits: o.allowEdits }));
      // The first import; one over GitHub's limit without a token goes on in the next runs of the schedule.
      await schedule.checkNow(saved.id);
      return (await find(saved.id)) ?? saved;
    },

    async links(projectPath) {
      return linksOfProject(await allLinks(), projectPath);
    },

    async checkNow(linkId) {
      // A viewer reads the status; the update is done by an editor's device.
      if (!canUpdate()) return (await find(linkId))?.status ?? NO_LINK;
      const [outcome] = await schedule.checkNow(linkId);
      if (outcome.kind === "busy") return BUSY;
      if (outcome.kind === "failed") return outcome.status;
      return (await find(linkId))?.status ?? NO_LINK;
    },

    async saveSettings(link) {
      await save(link);
    },

    async disconnect(linkId) {
      await host.call("github_remove_link", { id: linkId });
    },

    async restoreIgnored(linkId, path) {
      const link = await find(linkId);
      if (!link) throw new Error(NO_LINK);
      await save({ ...link, ignored: link.ignored.filter((p) => p !== path) });
    },

    async detachNote(noteId) {
      if (!canUpdate()) throw new Error(EDITORS_ONLY);
      const info = await noteInfo(noteId);
      if (!info) throw new Error(NOT_GITHUB_NOTE);
      const { [noteId]: _detached, ...files } = info.link.files;
      await save({ ...info.link, files, ignored: [...new Set([...info.link.ignored, info.file.path])] });
    },

    noteInfo,

    async baseText(noteId) {
      const info = await noteInfo(noteId);
      if (!info) return null;
      const bytes = await readArchive(info.link, info.file.blobSha).catch(() => null);
      const text = bytes ? decode(bytes) : null;
      return text === null ? null : stripMarkers(text).text;
    },

    async conflict(noteId): Promise<GithubConflict | null> {
      const info = await noteInfo(noteId);
      const c = info?.file.conflict;
      if (!info || !c) return null;
      const theirs = await githubText(info.link, c.blobSha);
      if (theirs === null) return null;
      return { ours: await host.call<string>("note_text", { id: noteId }), theirs, commit: c.commit };
    },

    async resolveConflict(noteId, text) {
      if (!canUpdate()) throw new Error(EDITORS_ONLY);
      const info = await noteInfo(noteId);
      const c = info?.file.conflict;
      if (!info || !c) throw new Error("Ta notatka nie ma konfliktu z GitHubem.");
      const theirs = await githubText(info.link, c.blobSha);
      if (theirs === null) throw new Error("Nie udało się pobrać wersji z GitHuba.");
      const doc = new Y.Doc();
      Y.applyUpdate(doc, await host.call<Uint8Array>("open_note", { id: noteId }));
      const before = doc.getText("content").toString();
      if (before !== text) {
        await host.call("github_save_version", { id: noteId, reason: RESOLVE_REASON, text: before });
        const vector = Y.encodeStateVector(doc);
        replaceText(doc, text);
        await host.call("apply_update", { id: noteId, update: Y.encodeStateAsUpdate(doc, vector), github: true });
      }
      // GitHub's version becomes the base: the next commit merges against it, and its task lines stay guarded.
      const { conflict: _resolved, ...rest } = info.file;
      const files: Record<string, GithubFile> = { ...info.link.files, [noteId]: { ...rest, blobSha: c.blobSha, guarded: guardedLines(theirs) } };
      const left = Object.values(files).filter((f) => f.conflict !== undefined && !f.deleted).length;
      await save({ ...info.link, files, status: conflictStatus(info.link.status, left) });
      await host.persistNow();
    },

    hasToken: () => host.token() !== null,
    setToken: (token) => host.setToken(token),

    startSchedule() {
      if (active) return;
      active = true;
      document.addEventListener("visibilitychange", onVisibility);
      schedule.start();
    },
    stopSchedule() {
      if (!active) return;
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      schedule.stop();
    },
    scheduled: () => active,
  };
}
