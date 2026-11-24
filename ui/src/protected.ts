// Protected projects (Stage E, contract: docs/WEB-WSPOLDZIELENIE.md). The notes under a protected project folder live in one
// AES-GCM envelope under a random project key; each member gets that key sealed to their box key. The entries travel in
// the vault snapshot (`state.protected`), signed by whoever wrote them.
import * as Y from "yjs";
import type { BrowserVaultSnapshot, FolderChange, Tombstone, TrashItem } from "./bridge";
import { canonicalJson } from "./bridge";
import type { SealedBox } from "./sealed";
import type { AgentSealed } from "./agentcrypto";
import type { TaskEvent } from "./taskhistory";
import { base64ToBytes, bufferSource, bytesToBase64 } from "./vaults";
import type { GithubLink } from "./github/link";

export const PROTECTED_SCHEMA = "notes-protected-v1";
type SnapshotNote = BrowserVaultSnapshot["state"]["notes"][number];

export interface ProtectedEnvelope { schema: typeof PROTECTED_SCHEMA; nonce: string; ciphertext: string }
export interface ProtectedEntry {
  path: string;
  keyEpoch: number;
  members: string[];
  // Who may write. Empty = every member. Owners and admins are always among them.
  editors?: string[];
  keys: { userId: string; sealedKey: SealedBox }[];
  envelope: ProtectedEnvelope;
  // The ids of the notes inside (random, nothing else): every device, member or not, can drop their task events from
  // the plain state, so the history of a protected task never travels in the clear.
  noteIds?: string[];
  // The project lead, who manages its members: appointed by an owner or admin, who signs the appointment itself (so any
  // device checks it, whoever signed the entry last). The note's `prowadzacy:` text is shown, never trusted (docs/MCP.md §6).
  lead?: LeadAppointment;
  // The project key sealed for members' Claude chats (slot `project:<path>`, docs/MCP.md §3.4). Each userId is a member;
  // a person's chats are changed by that person (or removed by a manager): see checkEntry in browserauth.ts.
  agentKeys?: { agentId: string; userId: string; sealedKey: AgentSealed }[];
  signerUserId?: string;
  signerAgentId?: string;
  alg?: string;
  signature?: string;
}
export const LEAD_SCHEMA = "notes-project-lead-v1";
/** A project lead's appointment, signed by an owner or admin, for one vault and one project path. */
export interface LeadAppointment { schema: typeof LEAD_SCHEMA; vaultId: string; path: string; userId: string; signerUserId?: string; signature?: string }
// Left in the snapshot when a project is unprotected: an older protected copy (same or lower epoch) is not brought back.
// `deleted`: the project's folder was deleted with it; `noteIds` are its notes, which every device forgets.
// Signed like an entry (docs/MCP.md §6): a mark drops an entry on every device, so only an owner or admin may make one (or,
// for a note protected on its own by older versions, a member of the verified folder entry that takes it in).
export interface ProtectedMark { path: string; keyEpoch: number; unprotectedAt: number; deleted?: boolean; noteIds?: string[]; signerUserId?: string; signature?: string }
// What the envelope holds: the notes under the folder, their versions, tombstones and trash (a trashed note of a protected
// project is sealed too: a plain trash item would show its title and content to every member's device), and the folders
// under it (created, renamed or deleted: `folderChanges`, as the plain state keeps them, so no folder name leaks out).
// `github`: the GitHub links of the projects in it (by `projectPath`), so the repository name never travels in the clear.
export interface ProtectedPayload { notes: SnapshotNote[]; versions: BrowserVaultSnapshot["state"]["versions"]; deleted: Tombstone[]; trash?: TrashItem[]; events?: TaskEvent[]; folderChanges?: FolderChange[]; github?: GithubLink[] }

const aad = (vaultId: string, path: string, keyEpoch: number): Uint8Array => new TextEncoder().encode(`${PROTECTED_SCHEMA}\0${vaultId}\0${path}\0${keyEpoch}`);

/** Shape check of an entry from the server or a snapshot. Signature and decryption are checked elsewhere. */
export function validEntry(entry: ProtectedEntry): boolean {
  return typeof entry?.path === "string" && Number.isInteger(entry.keyEpoch) && Array.isArray(entry.members) && Array.isArray(entry.keys) && entry.envelope?.schema === PROTECTED_SCHEMA;
}

export const under = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);
/** A note or folder is inside an entry's path: the path itself (a protected note) or anything under it (a folder). */
export const inside = (path: string, target: string): boolean => path === target || under(path, target);

/** The folders above `path`, from the top: "A/B/C" gives ["A", "A/B"]. */
export const ancestorsOf = (path: string): string[] => path.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/"));

/**
 * Whether a new note or folder at `path` is a top-level one: a folder of the root or of `Projekty/` (a general folder or a
 * project), or an item directly in the root or in `Projekty/`. `folders`: the folders that exist.
 */
/** Why an editor may not create a top-level item (landsTop): shown by the bridge, the explorer and the Projekty page. */
export const TOP_TEXT = "Główne foldery, notatki w głównym folderze i nowe projekty tworzy właściciel lub administrator.";

export function landsTop(path: string, folders: ReadonlySet<string>): boolean {
  const segs = path.split("/");
  // a folder of depth `depth` sits in the root or directly in Projekty/
  const topDepth = (depth: number) => depth === 1 || (depth === 2 && segs[0] === "Projekty");
  // the first folder that does not exist yet is made here, with the item in it
  for (let i = 1; i < segs.length; i++) if (!folders.has(segs.slice(0, i).join("/"))) return topDepth(i);
  return topDepth(segs.length);
}

/**
 * The part of a plain state that belongs to the project at `folder`: its notes, their tombstones, versions and task events.
 * `nested`: the folders under it that are protected on their own (their notes and folders sit in their own payloads).
 */
export function payloadOf(state: BrowserVaultSnapshot["state"], folder: string, nested: string[] = []): ProtectedPayload {
  const mine = (path: string) => inside(path, folder) && !nested.some((n) => inside(path, n));
  const notes = state.notes.filter((n) => mine(n.path));
  const deleted = (state.deleted ?? []).filter((t) => mine(t.path));
  const trash = (state.trash ?? []).filter((t) => mine(t.path));
  const ids = new Set([...notes.map((n) => n.id), ...deleted.map((t) => t.id), ...trash.map((t) => t.id)]);
  const events = (state.organization?.events ?? []).filter((e) => ids.has(e.note_id));
  const folderChanges = (state.folderChanges ?? []).filter((f) => mine(f.path));
  const github = (state.github ?? []).filter((l) => mine(l.projectPath));
  return { notes, versions: state.versions.filter(([id]) => ids.has(id)), deleted, trash, events, folderChanges, github };
}

/** The note ids a payload holds (what an entry lists in `noteIds`). */
export const noteIdsOf = (payload: ProtectedPayload): string[] => [...new Set([...payload.notes.map((n) => n.id), ...payload.deleted.map((t) => t.id), ...(payload.trash ?? []).map((t) => t.id)])].sort();

/** The folder (of `folders`) that holds `path`, if any: the shared predicate of the plain-state scrubs. */
const folderOfPath = (path: unknown, folders: string[]): string | undefined => (typeof path === "string" ? folders.find((f) => inside(path, f)) : undefined);

/** Drops the GitHub links whose project `drop` accepts; an empty list is not written (as the bridge's export). */
function dropLinks(state: BrowserVaultSnapshot["state"], drop: (path: unknown) => boolean): void {
  if (!state.github) return;
  const kept = state.github.filter((l) => !drop(l?.projectPath));
  if (kept.length) state.github = kept; else delete state.github;
}

/** Takes the notes with `ids` out of a plain state: their notes, trash, versions and task events. Tombstones are the caller's. */
function dropNoteIds(state: BrowserVaultSnapshot["state"], ids: Set<string>): void {
  if (!ids.size) return;
  state.notes = state.notes.filter((n) => !ids.has(n.id));
  state.trash = state.trash?.filter((t) => !ids.has(t.id));
  state.versions = state.versions.filter(([id]) => !ids.has(id));
  if (state.organization) state.organization = { ...state.organization, events: state.organization.events.filter((e) => !ids.has(e.note_id)) };
}

/** Takes the notes with `ids` out of a plain state, tombstones included (dropFolders without folders). */
export function dropIds(state: BrowserVaultSnapshot["state"], ids: Set<string>): void {
  dropNoteIds(state, ids);
  if (ids.size) state.deleted = state.deleted?.filter((t) => !ids.has(t.id));
}

/** Drops the rows whose path `drop` accepts from the task copies. */
function dropTaskRows(state: BrowserVaultSnapshot["state"], drop: (path: unknown) => boolean): void {
  state.taskCaches = (state.taskCaches ?? []).map(([key, saved]) => {
    const rows = (saved as { rows?: { path?: unknown }[] } | null)?.rows;
    return Array.isArray(rows) ? [key, { ...(saved as object), rows: rows.filter((r) => !drop(r?.path)) }] : [key, saved];
  });
}

/**
 * Takes the projects at `folders` out of a plain state, in one pass: their notes, tombstones, versions, the task events
 * of those notes (and of `noteIds`, the notes of entries this device cannot open), and their rows in the task copies.
 */
export function dropFolders(state: BrowserVaultSnapshot["state"], folders: string[], noteIds: Iterable<string> = []): void {
  if (!folders.length) return;
  const within = (path: unknown) => folderOfPath(path, folders) !== undefined;
  dropIds(state, new Set([...noteIds, ...[...state.notes, ...(state.deleted ?? []), ...(state.trash ?? [])].filter((x) => within(x.path)).map((x) => x.id)]));
  dropTaskRows(state, within);
  dropLinks(state, within);
  // the folders themselves are names too: a plain state does not list a protected folder
  state.folders = state.folders.filter((f) => !within(f));
  if (state.folderChanges) state.folderChanges = state.folderChanges.filter((f) => !within(f.path));
  // a file placed in a folder carries its name: never under a protected path (docs/PLIKI.md §7)
  if (state.folderFiles) state.folderFiles = state.folderFiles.filter((f) => !within(f.path));
}

/**
 * A deleted project leaves no plain trace in a state: its notes' versions and task events go, its tombstones keep only the
 * folder's path (not the note's), and its task-copy rows go.
 */
export function scrubDeleted(state: BrowserVaultSnapshot["state"], marks: ProtectedMark[]): void {
  const folders = marks.map((m) => m.path);
  dropNoteIds(state, new Set(marks.flatMap((m) => m.noteIds ?? [])));
  state.deleted = state.deleted?.map((t) => { const folder = folderOfPath(t.path, folders); return folder ? { ...t, path: folder } : t; });
  // a permanently deleted project's trash goes with it: by note id (above), or by a path inside the folder
  state.trash = state.trash?.filter((t) => !folderOfPath(t.path, folders));
  dropTaskRows(state, (path) => folderOfPath(path, folders) !== undefined);
  dropLinks(state, (path) => folderOfPath(path, folders) !== undefined);
  // the folder goes; its deletion stays (at the time of the mark), so an older live copy of the folder does not bring it back
  state.folders = state.folders.filter((f) => !folderOfPath(f, folders));
  state.folderChanges = [...(state.folderChanges ?? []).filter((f) => !folderOfPath(f.path, folders)), ...marks.map((m) => ({ path: m.path, changedAt: m.unprotectedAt, deleted: true }))];
  // a file placed there (only from older data: placing one inside a project is refused) leaves with its name
  state.folderFiles = state.folderFiles?.filter((f) => !folderOfPath(f.path, folders));
}

export async function sealPayload(vaultId: string, path: string, keyEpoch: number, key: CryptoKey, payload: ProtectedPayload): Promise<ProtectedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), additionalData: bufferSource(aad(vaultId, path, keyEpoch)), tagLength: 128 }, key, bufferSource(plain));
  return { schema: PROTECTED_SCHEMA, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

/** Decrypts an entry's payload. Throws when the key is wrong or the envelope (or its path, epoch) was altered. */
export async function openPayload(vaultId: string, entry: ProtectedEntry, key: CryptoKey): Promise<ProtectedPayload> {
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(base64ToBytes(entry.envelope.nonce)), additionalData: bufferSource(aad(vaultId, entry.path, entry.keyEpoch)), tagLength: 128 }, key, bufferSource(base64ToBytes(entry.envelope.ciphertext)));
  return JSON.parse(new TextDecoder().decode(raw)) as ProtectedPayload;
}

/**
 * The text of a payload, for telling whether it changed. Notes are compared by their text, not their Yjs bytes: two
 * equal documents can encode differently, and that must not make every device reseal the project.
 */
export function payloadKey(payload: ProtectedPayload): string {
  const notes = payload.notes.map((n) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToBytes(n.yjsUpdateBase64));
    return [n.id, n.path, n.pathChangedAt ?? 0, doc.getText("content").toString()];
  }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const versions = [...payload.versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const deleted = [...payload.deleted].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const trash = (payload.trash ?? []).map((t) => [t.id, t.path, t.deletedAt]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const events = (payload.events ?? []).map((e) => e.event_id).sort();
  const folders = (payload.folderChanges ?? []).map((f) => [f.path, f.changedAt, f.deleted]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const github = [...(payload.github ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonicalJson({ notes, versions, deleted, trash, events, folders, github });
}
