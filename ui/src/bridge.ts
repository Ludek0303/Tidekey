import * as Y from "yjs";
import { DAY_MS } from "./calendar/dates";
import type { SpaceKind } from "./spaces";
import { MockRecords, type MockRecordsState } from "./mockrecords";
import { recordMockEdit } from "./mockhistory";
import { validGroupColor, type OrganizationSnapshot, type Group } from "./taskhistory";
import type { DataRecord } from "./records";
import type { EventCheck, EventSigner, SignableEvent } from "./signing";
import type { ProtectedEntry, ProtectedMark } from "./protected";
import { MemoryFileStore, type FileStore } from "./filestore";
import { mergeLinks, validLink, type GithubLink } from "./github/link";

// Idle time after the last keystroke before its task history is recorded (MockBridge.flushHistory).
const HISTORY_PAUSE_MS = 400;

// The only way the UI talks to the core. Desktop wraps Tauri IPC, web wraps postMessage.
// Note bytes cross the bridge as Yjs v1 updates in a Uint8Array. A TauriBridge must convert
// Uint8Array <-> number[] at the IPC edge, since Tauri serializes Vec<u8> as a number array.
export interface Bridge {
  call<T>(cmd: string, args?: unknown): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

export interface TreeItem {
  id: string;
  path: string;
}

// list_tree: notes plus every folder, empty ones included.
export interface TreeListing {
  notes: TreeItem[];
  folders: string[];
  // Protected project folders (browser variant). `member`: this user holds the project key; `check`: the signature.
  locked?: LockedFolder[];
  // Shared vaults: false when this user may not make top-level folders and notes (the root, Projekty/). Absent = true.
  rootFree?: boolean;
  // Files that lie in a folder beside its notes (folderfiles.ts). Absent where there is no file store (desktop).
  files?: TreeFile[];
}

// A file in a folder: its server file (FileStore) and its path (`Folder/name.pdf`).
export interface TreeFile {
  fileId: string;
  path: string;
}

// A protected folder this user holds the key of (listed with its verification, if any).
export interface LockedFolder {
  path: string;
  check?: EventCheck;
}

// What the project buttons need (`project_protection`): this user's rights in the project and the vault's members.
export interface ProjectProtection {
  protected: boolean;
  member: boolean;
  manage: boolean;
  admin: boolean;
  self: string;
  members: string[];
  // Who may write, among the members (empty = every member). Owners and admins are always among them.
  editors: string[];
  // The folder whose permissions these are: a note has its folder's (the innermost protected one above it), so this is the
  // path the changes are made on. A note protected on its own (an older version) answers for itself, with target "note".
  path: string;
  // What the protection covers: a project folder, any other folder, or a note protected on its own (older versions only).
  target: "project" | "folder" | "note";
  // The project lead's user id, from the signed entry (an owner's or admin's appointment); null when none is verified.
  lead: string | null;
  // User ids of the vault's owners and admins.
  admins: string[];
  candidates: { userId: string; name: string; ready: boolean }[];
}

interface Seed {
  path: string;
  text: string;
}

const SAMPLE: Seed[] = [
  {
    path: "Projekty/Plan.md",
    text: "# Plan aplikacji\n\nPierwszy szkic notatki.\n\n- [ ] Edytor\n- [ ] Synchronizacja\n\nZobacz [[Spotkanie]] i [[Pomysły]].\n",
  },
  {
    path: "Projekty/Spotkanie.md",
    text: "# Spotkanie\n\nOmówienie planu, **pogrubienie** i _kursywa_.\n\n| Kolumna | Wartość |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n\nPowiązane: [[Plan]].\n",
  },
  {
    path: "Projekty/Pomysły.md",
    text: "# Pomysły\n\n- Tryb skupienia\n- Graf powiązań\n",
  },
  {
    path: "Dziennik/2026-10-18.md",
    text: "# 18 października\n\nDziś dużo pisania. Wrócić do [[Plan]].\n",
  },
  {
    path: "Notatka bez folderu.md",
    text: "# Luźna notatka\n\nTo jest plik w korzeniu przestrzeni.\n",
  },
  // the demo project of an organization space: one task done, three open, with every kind of token
  {
    path: "Projekty/Sonda/Sonda.md",
    text: "---\ntyp: projekt\nstatus: aktywny\nprowadzacy: Stanisław\n---\n# Sonda\n\n## Cel projektu\n\nZbudować moduł sterowania dla sondy.\n\n## Zadania\n\n- [x] Ustalić zakres ✅ 2026-10-20 @Jan !trudnosc:4 ^z-aa11\n- [ ] Uzupełnić protokół ze spotkania @Stanisław 📅 2026-10-24 !nadzor:@Anna !trudnosc:2 ^z-0b77\n- [ ] Przygotować schemat elektroniki @Jan 📅 2026-11-05 !nadzor:@Stanisław !trudnosc:8 ^z-7f3a\n- [ ] Opisać interfejs czujnika @Piotr !nadzor:@Jan ^z-d4e5\n",
  },
];

interface Note {
  id: string;
  path: string;
  // ms of the last rename or move; 0 for a note never renamed. Merge picks the later path.
  pathChangedAt: number;
  doc: Y.Doc;
}

// A deleted note's id, kept so that no copy of the note on another device brings it back. Its clocks merge by the later
// value. A restore (`restoredAt`) brings the note back when it is later than the delete. `purgedAt`: the trash item was
// emptied for good; the record stays, without content, so an older copy of the item does not return.
export interface Tombstone {
  id: string;
  path: string;
  deletedAt: number;
  restoredAt?: number;
  purgedAt?: number;
}

// A deleted note in the trash: its content as a Yjs update (base64). Kept TRASH_DAYS days from the delete (purgeTrash).
export interface TrashItem { id: string; path: string; deletedAt: number; state: string }
// The trash as the UI lists it (`list_trash`), newest first.
export interface TrashEntry { id: string; path: string; deleted_at: number }
export const TRASH_DAYS = 183;

// The note is gone: its latest event is a delete. A restore later than the delete makes it alive again.
const isDeleted = (t: Tombstone | undefined): t is Tombstone => !!t && t.deletedAt > (t.restoredAt ?? 0);
// Deletes before this are expired: the note leaves the trash and its versions go (purgeTrash).
const trashCutoff = (now: number): number => now - TRASH_DAYS * DAY_MS;
// The versions of a note are gone for good: its delete expired or it was purged.
const goneForGood = (t: Tombstone | undefined, cutoff: number): boolean => isDeleted(t) && (t.purgedAt !== undefined || t.deletedAt < cutoff);
export const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
// Two copies of one tombstone: the clocks take the later value, and the path comes from the later delete.
function mergeTombstone(known: Tombstone | undefined, incoming: Tombstone): Tombstone {
  if (!known) return { ...incoming };
  const later = incoming.deletedAt > known.deletedAt ? incoming : known;
  const latest = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : Math.max(a ?? 0, b ?? 0));
  return { id: known.id, path: later.path, deletedAt: later.deletedAt, restoredAt: latest(known.restoredAt, incoming.restoredAt), purgedAt: latest(known.purgedAt, incoming.purgedAt) };
}

// Explicit folders need their own last-writer-wins clock. Notes already carry tombstones and
// pathChangedAt, but without this record an empty folder deleted on one device came back from
// another device's older snapshot.
export interface FolderChange {
  path: string;
  changedAt: number;
  deleted: boolean;
}

// What a merge changed: the UI reloads the tree and refreshes the open editors from it.
export interface MergeResult {
  removed: string[];
  updated: string[];
  treeChanged: boolean;
}

// The organization role names the views show, by the server's role (insights.ts, taskhistory.ts).
export const ORG_ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Reader" };

// A file placed in a folder. One entry per file: the newest change wins, and a deletion wins a tie (as folderChanges).
export interface FolderFile extends TreeFile {
  changedAt: number;
  deleted: boolean;
}

export interface BrowserVaultSnapshot {
  schema: "browser-vault-snapshot";
  schemaVersion: 1;
  vault: { id: string; ownerUserId: string; name: string; kind: SpaceKind };
  state: {
    notes: { id: string; path: string; yjsUpdateBase64: string; pathChangedAt?: number }[];
    // Optional: snapshots written before tombstones existed have none.
    deleted?: Tombstone[];
    // The trash: deleted notes' content, for TRASH_DAYS days. Optional: older snapshots have none.
    trash?: TrashItem[];
    folders: string[];
    // Optional for snapshots from before synchronized folder deletion existed.
    folderChanges?: FolderChange[];
    // Optional for snapshots from before files in folders existed (docs/PLIKI.md §7, folderfiles.ts).
    folderFiles?: FolderFile[];
    // path: where the note was, kept only on the versions around a Claude chat's revision ("Cofnij zmiany czatu").
    versions: [string, { id: number; time_ms: number; reason: string; text: string; path?: string }[]][];
    // fileId: the attachment is on the server (docs/PLIKI.md §5); the bytes are then empty and the file is read by id.
    attachments: { key: string; bytesBase64: string; fileId?: string }[];
    nextVersion: number; nextId: number; me: string;
    organization: OrganizationSnapshot;
    records: MockRecordsState;
    taskCaches: [string, unknown][];
    // Stage E: protected projects. The notes under a protected folder are not in `notes`, only in its entry.
    protected?: ProtectedEntry[];
    unprotected?: ProtectedMark[];
    // GitHub links of the projects. Optional: older snapshots and old clients don't have it, and an empty list is not written.
    github?: GithubLink[];
  };
}
// Each note's encoded state, kept until its doc changes: an export then re-encodes only the notes that changed, and a
// merge skips a note whose incoming state is exactly the one held here.
const encoded = new WeakMap<Y.Doc, string>();
const watched = new WeakSet<Y.Doc>(); // one listener per doc, however often its cache is dropped
function encodedState(doc: Y.Doc): string {
  let value = encoded.get(doc);
  if (value === undefined) {
    if (!watched.has(doc)) { watched.add(doc); doc.on("update", () => encoded.delete(doc)); }
    value = toBase64(Y.encodeStateAsUpdate(doc));
    encoded.set(doc, value);
  }
  return value;
}

const toBase64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Path rules of the core (space_meta::is_valid_path): no empty, "." or ".." segments, no "\", ":" or NUL.
function plainPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || /[\\:\0]/.test(rel)) return false;
  const segs = rel.split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== "..") && segs[0].toLowerCase() !== ".notes-sync";
}
const validNote = (p: string): boolean => plainPath(p) && p.toLowerCase().endsWith(".md") && p.length > ".md".length;
const validFolder = (p: string): boolean => plainPath(p);
// A file in a folder is never a note: its name cannot end in .md (the import and the note list read those).
const validFile = (p: string): boolean => plainPath(p) && !/\.md$/i.test(p);
const keyOf = (p: string): string => p.toLowerCase();
const invalid = (p: string): Error => new Error(`Nieprawidłowa ścieżka: ${p}`);
const taken = (p: string): Error => new Error(`Ścieżka jest zajęta: ${p}`);

export interface SearchHit {
  id: string;
  path: string;
  snippet: string;
}

export interface VersionItem {
  id: number;
  time_ms: number;
  reason: string;
}

// Snippet hits are marked with these control characters, as the core marks them (see search.rs).
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

// Search folds case and diacritics, as the index does (ł is folded to l here, as the index's query does).
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase();
}

// Key-order independent JSON: two snapshots with the same content compare equal.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}
// Conflict rename of a path that another note holds: "Plan.md" becomes "Plan (konflikt 1).md", the next free N.
function conflictPath(path: string, taken: Set<string>): string {
  const stem = path.slice(0, -".md".length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (konflikt ${n}).md`;
    if (!taken.has(keyOf(candidate))) { taken.add(keyOf(candidate)); return candidate; }
  }
}
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// Names a user went by, kept per user_id: a union of both copies, newest last, capped. Old snapshots have none.
const NAME_ALIAS_LIMIT = 10;
function unionAliases(...sources: (Record<string, string[]> | undefined)[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const source of sources)
    for (const [userId, names] of Object.entries(source ?? {})) {
      if (!Array.isArray(names)) continue;
      let list = out[userId] ?? [];
      for (const name of names) {
        if (typeof name !== "string" || !name.trim()) continue;
        list = [...list.filter((n) => n.toLowerCase() !== name.toLowerCase()), name];
      }
      out[userId] = list.slice(-NAME_ALIAS_LIMIT);
    }
  return out;
}

export function mergeOrganizationSnapshots(local: OrganizationSnapshot, remote: OrganizationSnapshot): OrganizationSnapshot {
  const members = new Map(local.members.map((m) => [m.user_id, m]));
  for (const m of remote.members) {
    const known = members.get(m.user_id);
    if (!known || (m.name_changed_at ?? 0) > (known.name_changed_at ?? 0)) members.set(m.user_id, structuredClone(m));
  }
  const events = new Map(local.events.map((e) => [e.event_id, e]));
  for (const e of remote.events) if (!events.has(e.event_id)) events.set(e.event_id, structuredClone(e));
  const groups = new Map((local.groups ?? []).map((g) => [g.id, g]));
  for (const g of remote.groups ?? []) {
    const old = groups.get(g.id);
    // Name: the local one wins, as before. Color (or its removal) and order: the later choice wins (color_at, order_at).
    const newer = (g.color_at ?? 0) > (old?.color_at ?? 0) ? g : old;
    const newerOrder = (g.order_at ?? 0) > (old?.order_at ?? 0) ? g : old;
    groups.set(g.id, old ? { ...old, member_ids: [...new Set([...old.member_ids, ...g.member_ids])].sort(), archived: !!old.archived || !!g.archived, color: validGroupColor(newer?.color), color_at: newer?.color_at, order: newerOrder?.order, order_at: newerOrder?.order_at } : structuredClone(g));
  }
  const fields = { ...remote.fields, ...local.fields };
  for (const [key, value] of Object.entries(remote.fields)) if (local.fields[key] !== undefined && local.fields[key] !== value && !fields[`sync-conflict:${key}`]) fields[`sync-conflict:${key}`] = value;
  return { ...remote, ...local, members: [...members.values()], events: [...events.values()].sort((a,b) => a.time_ms-b.time_ms || a.event_id.localeCompare(b.event_id)), groups: [...groups.values()], fields, aliases: unionAliases(local.aliases, remote.aliases), ...(remote.handles || local.handles ? { handles: { ...(remote.handles ?? {}), ...(local.handles ?? {}) } } : {}) };
}
function mergeRecordStates(local: MockRecordsState, remote: MockRecordsState): MockRecordsState {
  const byId = new Map<string, any>();
  for (const op of [...local.data.operations, ...remote.data.operations]) if (op?.event_id) byId.set(op.event_id, structuredClone(op));
  const operations = [...byId.values()].sort((a,b) => a.time_ms-b.time_ms || String(a.event_id).localeCompare(String(b.event_id)));
  const records = { ...structuredClone(remote.data.records), ...structuredClone(local.data.records) };
  const revisions = { ...remote.data.revisions, ...local.data.revisions };
  const markdown = { ...remote.data.markdown, ...local.data.markdown };
  const latest = new Map<string, any>();
  for (const op of operations) { const r = op.record?.after; if (r?.id) latest.set(r.id, op); }
  for (const [id, op] of latest) { records[id] = structuredClone(op.record.after); revisions[id] = op.event_id; }
  return { data: { ...remote.data, ...local.data, records, revisions, markdown, operations, empty_revision: local.data.empty_revision || remote.data.empty_revision }, seq: Math.max(local.seq, remote.seq) };
}

// Yjs v1 update encoding, same text name ("content") as the Rust core.
export class MockBridge implements Bridge {
  private recordStore = new MockRecords();
  private taskCaches = new Map<string, unknown>();
  private name = "Przykładowa organizacja";
  private organization: OrganizationSnapshot = {
    me: "demo-0", owner: "demo-0", space_id: "browser-demo", verified: false, events: [], fields: {},
    members: ["Jan", "Anna", "Piotr", "Stanisław", "Weronika", "Michał", "Zofia", "Kuba", "Julia"].map((name, i) => ({ user_id: `demo-${i}`, name, role: i === 0 ? "Owner" : "Editor" })),
    groups: [],
  };
  protected notes = new Map<string, Note>();
  protected tombstones = new Map<string, Tombstone>();
  protected trash = new Map<string, TrashItem>();
  private folders = new Set<string>();
  private folderChanges = new Map<string, FolderChange>();
  // Files in folders, by file id.
  private folderFiles = new Map<string, FolderFile>();
  // In-memory stand-ins for the desktop features: versions, conflicts and attachments.
  private versions = new Map<string, { id: number; time_ms: number; reason: string; text: string; path?: string }[]>();
  private attachments = new Map<string, Uint8Array>();
  // Attachments already on the file store (browser variant), by key. Their bytes are dropped from `attachments`.
  private attachmentFiles = new Map<string, string>();
  /** Files of the backend: the browser variant's server store; the demo and tests use memory. */
  readonly files: FileStore = new MemoryFileStore();
  private nextVersion = 1;
  // The mock is one space; it starts as an organization, so the demo shows the project and task views.
  private kind: SpaceKind = "organizacja";
  // Legacy per-device handle; the visible profile uses the account name.
  private me = "Jan";
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private nextId = 1;
  // Set by BrowserBridge once the user's signing key is loaded. Without it (demo, desktop) events stay unsigned.
  eventSigner?: EventSigner;
  private pendingSignatures: Promise<void>[] = [];
  // Task history is recorded once typing pauses, not per keystroke: note id -> its text when last recorded.
  private history = new Map<string, string>();
  private historyTimer: ReturnType<typeof setTimeout> | undefined;
  protected githubLinks: GithubLink[] = [];

  constructor(seed: Seed[] = SAMPLE, _organizationDemo = true) {
    for (const s of seed) {
      const id = this.createNote(s.path);
      this.notes.get(id)!.doc.getText("content").insert(0, s.text);
    }
    this.organization.groups = [
      { id: "demo-group-board", name: "Zarząd", member_ids: ["demo-0", "demo-3"], color: "pomarańcz" },
      { id: "demo-group-software", name: "Software", member_ids: ["demo-0", "demo-1", "demo-5", "demo-8"], color: "niebieski" },
      { id: "demo-group-electronics", name: "Elektronika", member_ids: ["demo-2", "demo-3", "demo-6", "demo-7"] },
    ];
    for (const n of this.notes.values()) if (n.path.startsWith("Projekty/")) recordMockEdit(this.organization, n.id, "", n.doc.getText("content").toString());
  }

  // The personal vault, or a shared one (`shared`): its name and kind come from the server, its members from setMembers.
  setBrowserAccount(userId: string, _email: string, shared?: { id: string; name: string; kind: SpaceKind; ownerUserId: string }, displayName = "Użytkownik"): void {
    this.flushHistory();
    this.me = displayName.trim() || "Użytkownik";
    // The aliases belong to one space: they carry over only when the space stays the same.
    const spaceId = shared ? shared.id : `browser-${userId}`;
    const aliases = this.organization.space_id === spaceId ? (this.organization.aliases ?? {}) : {};
    if (shared) {
      this.name = shared.name;
      this.kind = shared.kind;
      this.organization = { me: userId, owner: shared.ownerUserId, space_id: shared.id, verified: false, events: [], fields: {}, members: [], groups: [], aliases };
    } else {
      this.name = "Moje notatki";
      this.kind = "notatki";
      this.organization = { me: userId, owner: userId, space_id: spaceId, verified: false, events: [], fields: {}, members: [{ user_id: userId, name: this.me, role: "Owner" }], groups: [], aliases };
    }
    this.learnName(userId, this.me);
  }

  // Remembers a display name a user went by, so tasks written with it still match them after a rename. Only display
  // names are kept: never last names or emails. The default placeholder is not a name.
  private learnName(userId: string, name: string | null | undefined): void {
    const clean = name?.normalize("NFC").trim();
    if (!userId || !clean || clean === "Użytkownik") return;
    const aliases = this.organization.aliases ?? (this.organization.aliases = {});
    const key = clean.toLowerCase();
    aliases[userId] = [...(aliases[userId] ?? []).filter((n) => n.toLowerCase() !== key), clean].slice(-NAME_ALIAS_LIMIT);
  }

  // Replaces the member list with the server's. A real account name is canonical across organizations;
  // the local name is kept only for migrated accounts that still have the generic default.
  setMembers(members: { userId: string; email: string; name?: string; role: string }[]): void {
    const known = new Map(this.organization.members.map((m) => [m.user_id, m]));
    this.organization.members = members.map((m) => {
      const profile = known.get(m.userId);
      // a name set in the organization (by an administrator, or the person) wins over the account name
      if (profile?.name && profile.name_changed_at !== undefined) return { user_id: m.userId, name: profile.name, role: ORG_ROLE[m.role] ?? m.role, name_changed_at: profile.name_changed_at };
      const accountName = m.name?.trim();
      const useAccountName = !!accountName && accountName !== "Użytkownik";
      return { user_id: m.userId, name: useAccountName ? accountName : profile?.name || "Użytkownik", role: ORG_ROLE[m.role] ?? m.role };
    });
    for (const m of this.organization.members) this.learnName(m.user_id, m.name);
  }

  exportBrowserSnapshot(ownerUserId: string, vaultId = `browser-${ownerUserId}`): BrowserVaultSnapshot {
    this.flushHistory();
    const now = Date.now(), cutoff = trashCutoff(now);
    return { schema: "browser-vault-snapshot", schemaVersion: 1,
      vault: { id: vaultId, ownerUserId, name: this.name, kind: this.kind },
      state: {
        notes: [...this.notes.values()].map(({ id, path, pathChangedAt, doc }) => ({ id, path, pathChangedAt, yjsUpdateBase64: encodedState(doc) })),
        deleted: [...this.tombstones.values()].map((t) => ({ ...t })),
        trash: [...this.trash.values()].filter((t) => this.keptTrash(t, now)).map((t) => ({ ...t })),
        folders: [...this.folders], versions: structuredClone([...this.versions].filter(([id]) => !goneForGood(this.tombstones.get(id), cutoff))),
        folderChanges: [...this.folderChanges.values()].map((f) => ({ ...f })),
        folderFiles: [...this.folderFiles.values()].map((f) => ({ ...f })),
        attachments: [
          ...[...this.attachments].map(([key, bytes]) => ({ key, bytesBase64: toBase64(bytes) })),
          ...[...this.attachmentFiles].map(([key, fileId]) => ({ key, bytesBase64: "", fileId })),
        ],
        nextVersion: this.nextVersion, nextId: this.nextId, me: this.me,
        organization: structuredClone(this.organization), records: this.recordStore.snapshot(), taskCaches: structuredClone([...this.taskCaches]),
        ...(this.githubLinks.length ? { github: structuredClone(this.githubLinks) } : {}),
      },
    };
  }

  mergeBrowserSnapshot(snapshot: BrowserVaultSnapshot): void {
    this.flushHistory();
    if (snapshot.schema !== "browser-vault-snapshot" || snapshot.schemaVersion !== 1) throw new Error("Nieobsługiwany zapis przestrzeni.");
    // Tombstones first: a deleted id stays deleted, whatever copy of the note arrives, unless a later restore says otherwise.
    for (const t of snapshot.state.deleted ?? []) {
      const incoming = { ...t, id: String(t.id), path: String(t.path), deletedAt: Number(t.deletedAt) || 0 };
      this.tombstones.set(incoming.id, mergeTombstone(this.tombstones.get(incoming.id), incoming));
    }
    for (const [id, t] of this.tombstones) if (isDeleted(t)) this.notes.delete(id);
    for (const saved of snapshot.state.notes) {
      if (!validNote(saved.path)) throw new Error("Zapis zawiera nieprawidłową notatkę.");
      if (isDeleted(this.tombstones.get(saved.id))) continue;
      const incomingAt = Number(saved.pathChangedAt) || 0;
      const existing = this.notes.get(saved.id);
      if (existing) {
        if (encodedState(existing.doc) !== saved.yjsUpdateBase64) Y.applyUpdate(existing.doc, fromBase64(saved.yjsUpdateBase64));
        // Last writer wins on the path; a tie goes to the lexicographically smaller path.
        if (incomingAt > existing.pathChangedAt || (incomingAt === existing.pathChangedAt && keyOf(saved.path) < keyOf(existing.path))) { existing.path = saved.path; existing.pathChangedAt = incomingAt; }
      } else {
        const doc = new Y.Doc(); Y.applyUpdate(doc, fromBase64(saved.yjsUpdateBase64));
        this.notes.set(saved.id, { id: saved.id, path: saved.path, pathChangedAt: incomingAt, doc });
      }
    }
    this.resolvePaths();
    // Old snapshots list only live folders and therefore get clock 0. New snapshots carry both
    // creations and deletions. A deletion wins a tie, so two devices converge deterministically.
    for (const path of snapshot.state.folders) {
      if (!validFolder(path) || this.folderChanges.has(keyOf(path))) continue;
      this.folderChanges.set(keyOf(path), { path, changedAt: 0, deleted: false });
    }
    for (const incoming of snapshot.state.folderChanges ?? []) {
      if (!validFolder(incoming.path)) continue;
      const key = keyOf(incoming.path);
      const known = this.folderChanges.get(key);
      const next = { path: incoming.path, changedAt: Number(incoming.changedAt) || 0, deleted: !!incoming.deleted };
      if (!known || next.changedAt > known.changedAt || (next.changedAt === known.changedAt && next.deleted && !known.deleted)) this.folderChanges.set(key, next);
    }
    this.folders = new Set([...this.folderChanges.values()].filter((f) => !f.deleted).map((f) => f.path));
    for (const incoming of snapshot.state.folderFiles ?? []) {
      if (!validFile(incoming.path) || !incoming.fileId) continue;
      const known = this.folderFiles.get(incoming.fileId);
      const next = { fileId: incoming.fileId, path: incoming.path, changedAt: Number(incoming.changedAt) || 0, deleted: !!incoming.deleted };
      if (!known || next.changedAt > known.changedAt || (next.changedAt === known.changedAt && next.deleted && !known.deleted)) this.folderFiles.set(next.fileId, next);
    }
    const versions = new Map(this.versions);
    for (const [noteId, incoming] of snapshot.state.versions) {
      const merged = new Map((versions.get(noteId) ?? []).map((v) => [`${v.id}:${v.time_ms}:${v.text}`, v]));
      const used = new Set([...merged.values()].map((v) => v.id));
      let nextId = Math.max(0, ...used);
      for (const v of incoming) {
        const contentKey = `${v.id}:${v.time_ms}:${v.text}`;
        if (merged.has(contentKey)) continue;
        const candidate = used.has(v.id) ? { ...v, id: ++nextId } : v;
        merged.set(`${candidate.id}:${candidate.time_ms}:${candidate.text}`, candidate); used.add(candidate.id);
      }
      versions.set(noteId, [...merged.values()].sort((a,b) => a.time_ms-b.time_ms || a.id-b.id));
    }
    this.versions = versions;
    // Trash: a copy is kept only while it matches the latest delete of its note. Two copies of one item merge their Yjs states.
    for (const item of snapshot.state.trash ?? []) {
      const t = this.tombstones.get(String(item.id));
      if (!isDeleted(t) || t.purgedAt !== undefined || Number(item.deletedAt) !== t.deletedAt) continue;
      // A copy of an older delete is replaced, not merged: only the same delete's copies have the same content.
      const known = this.trash.get(t.id);
      this.trash.set(t.id, known && known.deletedAt === t.deletedAt
        ? { ...known, state: toBase64(Y.mergeUpdates([fromBase64(known.state), fromBase64(item.state)])) }
        : { id: t.id, path: t.path, deletedAt: t.deletedAt, state: item.state });
    }
    this.purgeTrash();
    const attachments = new Map(this.attachments);
    const attachmentFiles = new Map(this.attachmentFiles);
    for (const item of snapshot.state.attachments) {
      // An entry with a file on the server wins over bytes for the same key. Bytes not yet moved here are kept as a copy.
      if (item.fileId) {
        const local = attachments.get(item.key);
        if (local) { attachments.delete(item.key); attachments.set(conflictName(item.key, local), local); }
        if (!attachmentFiles.has(item.key)) attachmentFiles.set(item.key, item.fileId);
        continue;
      }
      if (attachmentFiles.has(item.key)) continue;
      const existing = attachments.get(item.key);
      const incoming = fromBase64(item.bytesBase64);
      if (!existing) attachments.set(item.key, incoming);
      else if (existing.length !== incoming.length || existing.some((b,i) => b !== incoming[i])) attachments.set(conflictName(item.key, incoming), incoming);
    }
    this.attachments = attachments;
    this.attachmentFiles = attachmentFiles;
    this.nextVersion = Math.max(this.nextVersion, snapshot.state.nextVersion); this.nextId = Math.max(this.nextId, snapshot.state.nextId);
    this.name = this.name || snapshot.vault.name; this.kind = this.kind === "notatki" ? snapshot.vault.kind : this.kind;
    this.me = this.me || snapshot.state.me;
    this.organization = mergeOrganizationSnapshots(this.organization, snapshot.state.organization);
    this.recordStore.restore(mergeRecordStates(this.recordStore.snapshot(), snapshot.state.records));
    const taskCaches = new Map(this.taskCaches);
    for (const [key, value] of snapshot.state.taskCaches) {
      if (!taskCaches.has(key)) taskCaches.set(key, structuredClone(value));
      else if (JSON.stringify(taskCaches.get(key)) !== JSON.stringify(value)) {
        const conflictKey = `${key}::sync-conflict-${snapshot.vault.ownerUserId.slice(0,8)}`;
        if (!taskCaches.has(conflictKey)) taskCaches.set(conflictKey, structuredClone(value));
      }
    }
    this.taskCaches = taskCaches;
    this.githubLinks = mergeLinks(this.githubLinks, structuredClone(Array.isArray(snapshot.state.github) ? snapshot.state.github : []));
  }

  /**
   * Drops this device's plain copy of the notes under `folder` (a protected project it can no longer read), and of `noteIds`
   * wherever they are. `folder` null: the notes of `noteIds` only (no folder goes).
   */
  forgetFolder(folder: string | null, noteIds: string[] = []): boolean {
    this.flushHistory();
    const inFolder = (path: string | undefined) => folder !== null && path !== undefined && within(path, folder);
    const gone = [...this.notes.values()].filter((n) => inFolder(n.path) || noteIds.includes(n.id));
    for (const n of gone) { this.notes.delete(n.id); this.versions.delete(n.id); }
    // the folders go too (their names are not kept in the clear either)
    for (const [key, f] of this.folderChanges) if (inFolder(f.path)) this.folderChanges.delete(key);
    this.folders = new Set([...this.folders].filter((f) => !inFolder(f)));
    for (const [id, f] of this.folderFiles) if (inFolder(f.path)) this.folderFiles.delete(id);
    // their trash goes too, by id or by path (a permanently deleted project)
    const ids = new Set([...noteIds, ...gone.map((n) => n.id)]);
    for (const [id, item] of this.trash) if (ids.has(id) || inFolder(item.path)) { this.trash.delete(id); this.versions.delete(id); }
    // their task history and this device's task copy go too: what the device cannot open, it does not keep in the clear
    this.organization = { ...this.organization, events: this.organization.events.filter((e) => !ids.has(e.note_id)) };
    for (const [key, saved] of this.taskCaches) {
      const rows = (saved as { rows?: { path?: string }[] } | null)?.rows;
      if (Array.isArray(rows)) this.taskCaches.set(key, { ...(saved as object), rows: rows.filter((r) => !inFolder(r?.path)) });
    }
    this.githubLinks = this.githubLinks.filter((l) => !inFolder(l.projectPath));
    for (const n of gone) this.emit("note_removed", { id: n.id });
    if (gone.length) this.emit("tree_changed", null);
    return gone.length > 0;
  }

  // A delete: the note's content goes to the trash and the note leaves the tree. Its versions stay with the trash item.
  private trashNote(note: Note, at: number): void {
    this.tombstones.set(note.id, { ...this.tombstones.get(note.id), id: note.id, path: note.path, deletedAt: at });
    this.trash.set(note.id, { id: note.id, path: note.path, deletedAt: at, state: encodedState(note.doc) });
    this.notes.delete(note.id);
  }

  // A trash item is kept at `now` only while it matches the latest delete of its note, the note is not purged
  // and the delete is within TRASH_DAYS. Reads filter with this; purgeTrash removes what is not kept.
  protected keptTrash(item: TrashItem, now: number): boolean {
    const t = this.tombstones.get(item.id);
    return isDeleted(t) && t.purgedAt === undefined && item.deletedAt === t.deletedAt && item.deletedAt >= trashCutoff(now);
  }

  // Trash that is no longer kept, and the versions gone for good, are removed for good. Tombstones stay.
  // Runs on load, merge and the commands that change the trash; reads never mutate.
  private purgeTrash(now = Date.now()): void {
    const cutoff = trashCutoff(now);
    for (const id of this.versions.keys()) if (goneForGood(this.tombstones.get(id), cutoff)) this.versions.delete(id);
    for (const [id, item] of this.trash) if (!this.keptTrash(item, now)) this.trash.delete(id);
  }

  // Brings a trashed note back, with its content and versions. Its path is taken or its folder is gone: see restoredPath.
  private restoreNote(id: string): string {
    const item = this.trash.get(id);
    if (!item) throw new Error("Nie ma takiej notatki w koszu.");
    const now = Date.now();
    const path = this.restoredPath(item.path);
    // A folder that is gone comes back explicitly, so it stays when the note is moved out later.
    const segs = path.split("/");
    const existing = this.allFolders();
    for (let i = 1; i < segs.length; i++) {
      const folder = segs.slice(0, i).join("/");
      if (existing.includes(folder)) continue;
      this.folders.add(folder);
      this.folderChanges.set(keyOf(folder), { path: folder, changedAt: now, deleted: false });
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(item.state));
    this.notes.set(id, { id, path, pathChangedAt: now, doc });
    this.trash.delete(id);
    this.tombstones.set(id, { ...this.tombstones.get(id)!, restoredAt: now });
    return path;
  }
  // The path a restored note takes: its own when free, else beside it as "Nazwa (przywrócona).md" (the next free number).
  private restoredPath(path: string): string {
    if (!this.isTaken(path)) return path;
    const ext = path.endsWith(".md") ? ".md" : "";
    const stem = path.slice(0, path.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = `${stem} (przywrócona${n === 1 ? "" : ` ${n}`})${ext}`;
      if (!this.isTaken(candidate)) return candidate;
    }
  }
  // Empties one trashed note for good: its content and versions go, and a purge marker stays in its tombstone.
  private purgeNote(id: string): void {
    this.purgeTrash();
    if (!this.trash.has(id)) throw new Error("Nie ma takiej notatki w koszu.");
    this.trash.delete(id);
    this.versions.delete(id);
    this.tombstones.set(id, { ...this.tombstones.get(id)!, purgedAt: Date.now() });
  }
  private trashKey(): string { return [...this.trash.keys()].sort().join("\0"); }

  private createNote(path: string): string {
    const id = `note-${crypto.randomUUID()}`;
    this.nextId++;
    this.notes.set(id, { id, path, pathChangedAt: 0, doc: new Y.Doc() });
    return id;
  }

  // Two different notes on one path (two devices created or moved them there): the most recent path claim keeps
  // it, the other is renamed to a conflict name. Both notes stay; neither content is merged into the other.
  private resolvePaths(): void {
    const groups = new Map<string, Note[]>();
    for (const n of this.notes.values()) groups.set(keyOf(n.path), [...(groups.get(keyOf(n.path)) ?? []), n]);
    const taken = new Set(groups.keys());
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.pathChangedAt - a.pathChangedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const loser of group.slice(1)) { loser.path = conflictPath(loser.path, taken); loser.pathChangedAt = Date.now(); }
    }
  }

  // The tree as the UI lists it: note ids and paths, and the folders.
  private treeKey(): string {
    return [...this.notes.values()].map((n) => `${n.id}\t${n.path}`).sort().join("\n") + "\0" + this.allFolders().join("\n");
  }

  /** A merge of another device's state while the UI is open. Emits what the UI must follow: removed notes,
   *  the tree, and for each note whose Yjs state changed, its full update (applied idempotently by the editor). */
  mergeRemoteSnapshot(snapshot: BrowserVaultSnapshot): MergeResult {
    const before = new Map([...this.notes].map(([id, n]) => [id, Y.encodeStateVector(n.doc)]));
    const treeBefore = this.treeKey();
    const orgBefore = this.organizationKey();
    const trashBefore = this.trashKey();
    this.mergeBrowserSnapshot(snapshot);
    const removed = [...before.keys()].filter((id) => !this.notes.has(id));
    const updated = [...this.notes.values()].filter((n) => !before.has(n.id) || !sameBytes(before.get(n.id)!, Y.encodeStateVector(n.doc))).map((n) => n.id);
    const result: MergeResult = { removed, updated, treeChanged: this.treeKey() !== treeBefore };
    for (const id of removed) this.emit("note_removed", { id });
    if (result.treeChanged) this.emit("tree_changed", null);
    for (const id of updated) this.emit("note_update", { id, update: Y.encodeStateAsUpdate(this.notes.get(id)!.doc) });
    // New organization events or record operations count as a remote change too (the notifications follow it).
    if (removed.length || updated.length || result.treeChanged || this.organizationKey() !== orgBefore || this.trashKey() !== trashBefore) this.emit("remote_changed", result);
    return result;
  }

  private organizationKey(): string {
    return `${this.organization.events.length}\0${this.recordStore.data.operations.length}`;
  }

  private liveFiles(): TreeFile[] {
    return [...this.folderFiles.values()].filter((f) => !f.deleted).map(({ fileId, path }) => ({ fileId, path })).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }

  // Whether a note's text embeds the file (any embed id, any alias). Only the notes this device holds are read.
  /** Whether a note of this space embeds the file. A subclass that cannot read every note answers true when unsure. */
  protected embedded(fileId: string): boolean {
    return [...this.notes.values()].some((n) => n.doc.getText("content").toString().includes(`plik:${fileId}`));
  }

  // A file goes to a folder, or moves within the tree (`moving`): its name must be free there and the folder must exist.
  private async placeFile(fileId: string, path: string, moving: boolean): Promise<void> {
    if (!validFile(path)) throw invalid(path);
    const known = this.folderFiles.get(fileId);
    const live = !!known && !known.deleted;
    if (moving && !live) throw new Error("Nie ma takiego pliku w folderze.");
    if (!moving && live) throw new Error("Plik jest już w folderze.");
    const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (parent && !this.allFolders().includes(parent)) throw new Error(`Nie ma folderu: ${parent}`);
    if (this.isTaken(path) || this.fileTaken(path, fileId)) throw taken(path);
    if (!moving) {
      const info = await this.files.info(fileId);
      if (!info || info.state !== "ready" || info.thumbOf) throw new Error("Nie ma takiego pliku.");
    }
    this.folderFiles.set(fileId, { fileId, path, changedAt: Date.now(), deleted: false });
  }

  // Another live file already has this name in the tree (names are case-insensitive, as on the core's disks).
  private fileTaken(path: string, exceptId?: string): boolean {
    const k = keyOf(path);
    return [...this.folderFiles.values()].some((f) => !f.deleted && f.fileId !== exceptId && keyOf(f.path) === k);
  }

  // Folders that hold notes, plus the explicitly created ones.
  protected allFolders(): string[] {
    const set = new Set(this.folders);
    for (const folder of this.folders) {
      const segs = folder.split("/");
      for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join("/"));
    }
    // a folder holding notes or placed files is listed, so a file never outlives the folder shown around it
    for (const path of [...[...this.notes.values()].map((n) => n.path), ...[...this.folderFiles.values()].filter((f) => !f.deleted).map((f) => f.path)]) {
      const segs = path.split("/");
      for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join("/"));
    }
    return [...set].sort();
  }

  /** Whether files placed in the tree (not notes) live at `folder` or under it. */
  protected holdsFolderFiles(folder: string): boolean {
    return [...this.folderFiles.values()].some((f) => !f.deleted && (f.path === folder || f.path.startsWith(`${folder}/`)));
  }

  // A note or folder already has this path (case-insensitive, as on the core's disks), except the note itself.
  private isTaken(path: string, exceptId?: string): boolean {
    const k = keyOf(path);
    for (const n of this.notes.values()) if (n.id !== exceptId && keyOf(n.path) === k) return true;
    return this.allFolders().some((f) => keyOf(f) === k);
  }

  protected emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  on(event: string, cb: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  // Organization events a call appends (task events, record operations) are signed as they are made. The signing is
  // async, so persist waits for settleSignatures before it snapshots. The lengths are read synchronously with the call.
  call<T>(cmd: string, args?: unknown): Promise<T> {
    // A keystroke only queues its note's history (apply_update); the calls that read a note's text alone do not need it.
    // Every other call reads or changes the history first.
    if (cmd !== "apply_update" && cmd !== "open_note" && cmd !== "note_text") this.flushHistory();
    const events = this.organization.events.length;
    const operations = this.recordStore.data.operations.length;
    const result = this.dispatch<T>(cmd, args);
    this.signEvents(events);
    if (this.eventSigner) for (const op of this.recordStore.data.operations.slice(operations)) this.pendingSignatures.push(this.signOne(op));
    return result;
  }
  private async signOne(event: { event_id: string }): Promise<void> {
    try { await this.eventSigner!(event); }
    catch (e) { console.error("Nie udało się podpisać zdarzenia", e); }
  }
  // Signs the organization events appended since index `from` (when a signer is set).
  private signEvents(from: number): void {
    if (this.eventSigner) for (const e of this.organization.events.slice(from)) this.pendingSignatures.push(this.signOne(e));
  }
  // Records the task changes of every note edited since its last record, one comparison per note: edits within the
  // pause collapse into one (a task done and undone in between leaves no event). Signs what it adds.
  private flushHistory(): void {
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    const events = this.organization.events.length;
    for (const [id, before] of this.history) {
      const note = this.notes.get(id);
      if (note) recordMockEdit(this.organization, id, before, note.doc.getText("content").toString());
    }
    this.history.clear();
    this.signEvents(events);
  }
  /** Waits until every event made so far is signed. */
  async settleSignatures(): Promise<void> {
    this.flushHistory();
    while (this.pendingSignatures.length) await Promise.all(this.pendingSignatures.splice(0));
  }

  // Every organization event and record operation, for verification (BrowserBridge).
  protected signableEvents(): SignableEvent[] {
    this.flushHistory();
    return [...this.organization.events, ...this.recordStore.data.operations] as SignableEvent[];
  }

  private async dispatch<T>(cmd: string, args?: unknown): Promise<T> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "organization_snapshot":
        return structuredClone(this.organization) as T;
      case "organization_group": {
        const group = structuredClone(a.group as Group);
        if (!group?.id || !group.name.trim()) throw new Error("Nieprawidłowa grupa.");
        if (!validGroupColor(group.color)) delete group.color;
        const before = this.organization.groups?.find((g) => g.id === group.id);
        group.color_at = (before?.color ?? null) === (group.color ?? null) ? before?.color_at : Date.now();
        this.organization.groups = [...(this.organization.groups ?? []).filter((g) => g.id !== group.id), group];
        return undefined as T;
      }
      case "organization_person": {
        const member = this.organization.members.find((m) => m.user_id === String(a.userId));
        const name = String(a.name ?? "").trim();
        if (!member || !/^[\p{L}\p{N}._ -]{1,64}$/u.test(name)) throw new Error("Nieprawidłowa osoba lub nazwa.");
        member.name = name;
        member.name_changed_at = Date.now();
        this.learnName(member.user_id, name);
        return undefined as T;
      }
      case "organization_records":
        return structuredClone(this.recordStore.data) as T;
      case "github_links":
        return structuredClone(this.githubLinks.filter((l) => !l.removed)) as T;
      case "github_save_link": {
        const link = a.link;
        if (!validLink(link)) throw new Error("Nieprawidłowe połączenie z GitHubem.");
        const before = this.githubLinks.find((l) => l.id === link.id);
        if (before?.removed || link.removed) throw new Error("To połączenie z GitHubem zostało odłączone.");
        const saved = { ...structuredClone(link), rev: Math.max(before?.rev ?? 0, link.rev) + 1 };
        this.githubLinks = [...this.githubLinks.filter((l) => l.id !== saved.id), saved];
        return structuredClone(saved) as T;
      }
      case "github_remove_link":
        this.githubLinks = this.githubLinks.map((l) => (l.id === String(a.id) ? { ...l, removed: true, files: {}, rev: l.rev + 1 } : l));
        return undefined as T;
      // The text of a note before a GitHub update changes it, kept under the update's reason (like createVersionSnapshot).
      case "github_save_version": {
        const id = String(a.id), text = String(a.text);
        this.getNote(id);
        const list = this.versions.get(id) ?? [];
        if (list[0]?.text !== text) list.unshift({ id: this.nextVersion++, time_ms: Date.now(), reason: String(a.reason), text });
        this.versions.set(id, list);
        return undefined as T;
      }
      case "organization_global_records":
        return [{ path: "mock", name: this.name, data: structuredClone(this.recordStore.data), identity: structuredClone(this.organization) }] as T;
      case "organization_save_record":
        return this.recordStore.save(a.record as DataRecord, String(a.expected), this.organization.me, a.base as string[] | undefined) as T;
      case "organization_import_module":
        return this.recordStore.importModule(String(a.text), a.expected as string | null, Boolean(a.commit), this.organization.me) as T;
      case "organization_movement":
        return this.recordStore.movement(String(a.id), String(a.itemId), Number(a.quantity), Boolean(a.issue), String(a.borrower), this.organization.me) as T;
      case "organization_cancel_movement": {
        const target = this.recordStore.data.records[String(a.targetId)];
        if (!target) throw new Error("Nie ma takiej operacji.");
        return this.recordStore.save({ id: `cancel-${target.id}`, kind: "movement_cancel", module_id: target.module_id, item_id: target.item_id, target_id: target.id, reason: String(a.reason) }, this.recordStore.data.empty_revision, this.organization.me) as T;
      }
      case "list_tree": {
        const notes: TreeItem[] = [...this.notes.values()].map((n) => ({ id: n.id, path: n.path }));
        notes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
        return { notes, folders: this.allFolders(), files: this.liveFiles() } as T;
      }
      // Protected projects are the browser's (BrowserBridge); the demo has none.
      case "project_protection":
        return { protected: false, member: true, manage: false, admin: false, self: "", path: "", members: [], editors: [], target: "folder", lead: null, admins: [], candidates: [] } as T;
      case "space_name":
        return this.name as T;
      // The mock holds one space, which is the open one; the list, switching and forgetting are its only entry.
      case "list_spaces":
        return [{ path: "mock", name: this.name, kind: this.kind, current: true, exists: true }] as T;
      case "open_known_space":
        return "open" as T;
      case "close_space":
      case "forget_space":
        return undefined as T;
      case "space_kind":
        return this.kind as T;
      case "my_handle":
        return this.me as T;
      case "set_my_handle":
        this.me = String(a.handle);
        this.learnName(this.organization.me, this.me);
        return undefined as T;
      // The copies of other spaces live in the app's config folder; the mock has no other space.
      case "save_task_cache":
        this.taskCaches.set(String((a.saved as { userId?: string } | undefined)?.userId ?? this.organization.me), structuredClone(a.saved));
        return undefined as T;
      case "task_caches":
        // the open space's own copy is its live tasks already: listing it again would show every task twice
        return [...this.taskCaches.entries()].filter(([userId]) => userId !== this.organization.me).map(([userId, saved]) => ({ name: "Lokalne zadania", path: "mock", saved: structuredClone(saved), userId })) as T;
      case "set_space_kind": {
        const kind = String(a.kind);
        if (kind !== "notatki" && kind !== "organizacja") throw new Error(`Nieznany typ przestrzeni: ${kind}`);
        if (this.kind === "organizacja" && kind === "notatki") throw new Error("Przestrzeni organizacji nie można zmienić z powrotem na notatki.");
        this.kind = kind;
        return this.kind as T;
      }
      case "create_note": {
        const path = String(a.path);
        if (!validNote(path)) throw invalid(path);
        if (this.isTaken(path)) throw taken(path);
        const id = this.createNote(path);
        this.emit("tree_changed", null);
        return id as T;
      }
      case "create_folder": {
        const path = String(a.path);
        if (!validFolder(path)) throw invalid(path);
        if (this.isTaken(path)) throw taken(path);
        this.folders.add(path);
        this.folderChanges.set(keyOf(path), { path, changedAt: Date.now(), deleted: false });
        this.emit("tree_changed", null);
        return undefined as T;
      }
      case "rename": {
        const note = this.getNote(a.id);
        const path = String(a.path);
        if (!validNote(path)) throw invalid(path);
        if (path === note.path) return undefined as T;
        if (this.isTaken(path, note.id)) throw taken(path);
        note.path = path;
        note.pathChangedAt = Date.now();
        this.emit("tree_changed", null);
        return undefined as T;
      }
      case "rename_folder": {
        const from = String(a.from);
        const to = String(a.to);
        if (!this.allFolders().includes(from)) throw new Error(`Nie ma folderu: ${from}`);
        if (!validFolder(to)) throw invalid(to);
        if (to === from) return undefined as T;
        if (to.startsWith(`${from}/`)) throw new Error("Folder nie może być przeniesiony do siebie samego");
        if (this.isTaken(to)) throw taken(to);
        for (const n of this.notes.values()) {
          if (n.path.startsWith(`${from}/`)) { n.path = to + n.path.slice(from.length); n.pathChangedAt = Date.now(); }
        }
        const changedAt = Date.now();
        for (const f of this.folderFiles.values()) if (!f.deleted && within(f.path, from)) { f.path = to + f.path.slice(from.length); f.changedAt = changedAt; }
        const explicit = [...this.folders].filter((f) => f === from || f.startsWith(`${from}/`));
        for (const old of explicit) {
          this.folderChanges.set(keyOf(old), { path: old, changedAt, deleted: true });
          const path = to + old.slice(from.length);
          this.folderChanges.set(keyOf(path), { path, changedAt, deleted: false });
        }
        this.folders = new Set([...this.folders].map((f) => (f === from || f.startsWith(`${from}/`) ? to + f.slice(from.length) : f)));
        this.folders.add(to);
        this.folderChanges.set(keyOf(to), { path: to, changedAt, deleted: false });
        this.emit("tree_changed", null);
        return undefined as T;
      }
      case "delete_folder": {
        const path = String(a.path);
        if (!validFolder(path)) throw invalid(path);
        if (!this.allFolders().includes(path)) throw new Error(`Nie ma folderu: ${path}`);
        const changedAt = Date.now();
        const affectedFolders = this.allFolders().filter((f) => f === path || f.startsWith(`${path}/`));
        const affectedNotes = [...this.notes.values()].filter((n) => n.path.startsWith(`${path}/`));
        for (const folder of affectedFolders) this.folderChanges.set(keyOf(folder), { path: folder, changedAt, deleted: true });
        for (const note of affectedNotes) this.trashNote(note, changedAt);
        this.folders = new Set([...this.folders].filter((f) => f !== path && !f.startsWith(`${path}/`)));
        // The files of the folder leave it; the ones no note embeds go to the file store's trash (after the notes, so
        // the notes just deleted do not count as embedding them).
        const files = [...this.folderFiles.values()].filter((f) => !f.deleted && within(f.path, path));
        for (const f of files) {
          if (!this.embedded(f.fileId)) await this.files.trash(f.fileId).catch(() => undefined);
          f.deleted = true;
          f.changedAt = changedAt;
        }
        this.emit("tree_changed", null);
        return undefined as T;
      }
      // Files in folders (docs/PLIKI.md §7): the entries are per file, the bytes stay in the file store.
      case "folder_files":
        return this.liveFiles() as T;
      case "folder_file_add":
        await this.placeFile(String(a.fileId), String(a.path), false);
        this.emit("tree_changed", null);
        return undefined as T;
      case "folder_file_rename":
        await this.placeFile(String(a.fileId), String(a.path), true);
        this.emit("tree_changed", null);
        return undefined as T;
      case "folder_file_remove": {
        const fileId = String(a.fileId);
        const entry = this.folderFiles.get(fileId);
        if (!entry || entry.deleted) throw new Error("Nie ma takiego pliku w folderze.");
        // The trash first: if the store refuses, the file stays in the folder.
        const trashed = !this.embedded(fileId);
        if (trashed) await this.files.trash(fileId);
        entry.deleted = true;
        entry.changedAt = Date.now();
        this.emit("tree_changed", null);
        return trashed as T;
      }
      case "delete": {
        const note = this.getNote(a.id);
        this.trashNote(note, Date.now());
        this.emit("tree_changed", null);
        return undefined as T;
      }
      case "list_trash": {
        const now = Date.now();
        return [...this.trash.values()].filter((t) => this.keptTrash(t, now)).sort((x, y) => y.deletedAt - x.deletedAt).map(({ id, path, deletedAt }): TrashEntry => ({ id, path, deleted_at: deletedAt })) as T;
      }
      case "restore_note": {
        this.purgeTrash();
        const path = this.restoreNote(String(a.id));
        this.emit("tree_changed", null);
        return path as T;
      }
      case "purge_note":
        this.purgeNote(String(a.id));
        return undefined as T;
      case "open_note": {
        const note = this.getNote(a.id);
        // the bytes of the note's state, as the Rust backend sends them (see tauribridge.ts)
        return Y.encodeStateAsUpdate(note.doc) as T;
      }
      // Plain text of a note, for the link index (not the editor state).
      case "note_text":
        return this.getNote(a.id).doc.getText("content").toString() as T;
      case "apply_update": {
        const note = this.getNote(a.id);
        if (!this.history.has(note.id)) this.history.set(note.id, note.doc.getText("content").toString());
        Y.applyUpdate(note.doc, a.update as Uint8Array);
        // a GitHub update is written here, not typed in the editor: the open editor learns it like a remote change
        if (a.github === true) this.emit("note_update", { id: note.id, update: a.update as Uint8Array });
        clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => this.flushHistory(), HISTORY_PAUSE_MS);
        return undefined as T;
      }
      case "search":
        return this.search(String(a.query), Number(a.limit ?? 50)) as T;
      case "list_versions":
        return this.keptVersions(String(a.id)).map(({ id, time_ms, reason }) => ({ id, time_ms, reason })) as T;
      case "version_text":
        return this.findVersion(Number(a.vid)).text as T;
      case "restore_version": {
        const note = this.getNote(a.id);
        this.createVersionSnapshot(note.id, "przed przywróceniem");
        this.replaceText(note, this.findVersion(Number(a.vid)).text);
        this.createVersionSnapshot(note.id, "przywrócono");
        this.emit("note_update", { id: note.id, update: Y.encodeStateAsUpdate(note.doc) });
        return undefined as T;
      }
      case "list_conflicts":
        return [] as T;
      case "conflict_texts":
        throw new Error(`no conflict in note: ${String(a.id)}`);
      case "resolve_conflict":
        this.replaceText(this.getNote(a.id), String(a.text));
        this.emit("note_update", { id: String(a.id), update: Y.encodeStateAsUpdate(this.getNote(a.id).doc) });
        return undefined as T;
      case "save_attachment": {
        const rel = this.uniqueAttachment(String(a.name));
        this.attachments.set(rel, a.bytes as Uint8Array);
        return rel as T;
      }
      case "read_attachment": {
        const bytes = this.attachments.get(String(a.rel));
        if (!bytes) throw new Error(`no attachment: ${String(a.rel)}`);
        return bytes as T;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }

  private search(query: string, limit: number): SearchHit[] {
    const terms = query.split(/\s+/).map(foldText).filter((t) => /[\p{L}\p{N}]/u.test(t));
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const n of [...this.notes.values()].sort((x, y) => (x.path < y.path ? -1 : 1))) {
      const text = n.doc.getText("content").toString();
      const folded = foldText(text);
      if (!terms.every((t) => folded.includes(t))) continue;
      const at = Math.max(0, folded.indexOf(terms[0]));
      const from = Math.max(0, at - 30);
      const shown = text.slice(from, at + 90).replace(/\n/g, " ");
      const snippet = shown.replace(new RegExp(`(${terms[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"), `${MARK_START}$1${MARK_END}`);
      hits.push({ id: n.id, path: n.path, snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private createVersionSnapshot(id: string, reason: string): void {
    const text = this.getNote(id).doc.getText("content").toString();
    const list = this.versions.get(id) ?? [];
    if (list[0]?.text === text) return;
    list.unshift({ id: this.nextVersion++, time_ms: Date.now(), reason, text });
    this.versions.set(id, list);
  }

  // A note's versions, unless they are gone for good (expired or purged) but not yet removed.
  private keptVersions(id: string): { id: number; time_ms: number; reason: string; text: string }[] {
    return goneForGood(this.tombstones.get(id), trashCutoff(Date.now())) ? [] : this.versions.get(id) ?? [];
  }

  private findVersion(vid: number): { id: number; time_ms: number; reason: string; text: string } {
    for (const id of this.versions.keys()) {
      const found = this.keptVersions(id).find((v) => v.id === vid);
      if (found) return found;
    }
    throw new Error(`no version: ${vid}`);
  }

  private replaceText(note: Note, text: string): void {
    const ytext = note.doc.getText("content");
    note.doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, text);
    });
  }

  private uniqueAttachment(name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const taken = (rel: string) => this.attachments.has(rel) || this.attachmentFiles.has(rel);
    let rel = `assets/${name}`;
    for (let n = 2; taken(rel); n++) rel = `assets/${stem} (${n})${ext}`;
    return rel;
  }

  /** Attachments still held as bytes here: the browser variant moves them to the file store (docs/PLIKI.md §5). */
  pendingAttachments(): { key: string; bytes: Uint8Array }[] {
    return [...this.attachments].map(([key, bytes]) => ({ key, bytes }));
  }
  /** Drops the bytes of `key` once they are on the file store under `fileId`. False when they changed meanwhile. */
  attachmentMigrated(key: string, bytes: Uint8Array, fileId: string): boolean {
    if (this.attachments.get(key) !== bytes) return false;
    this.attachments.delete(key);
    this.attachmentFiles.set(key, fileId);
    return true;
  }
  /** The file id of an attachment kept on the file store, if it is one. */
  attachmentFileId(rel: string): string | undefined { return this.attachmentFiles.get(rel); }

  private getNote(id: unknown): Note {
    const note = this.notes.get(String(id));
    if (!note) throw new Error(`no such note: ${String(id)}`);
    return note;
  }
}

// The key of a copy kept beside `key` when two versions of one attachment meet (the first 4 bytes name it).
function conflictName(key: string, bytes: Uint8Array): string {
  return `${key}.conflict-${[...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Seeds n notes spread over folders, for the 10 000-note tree check.
export function makeBigMock(n: number): MockBridge {
  const seed: Seed[] = [];
  for (let i = 0; i < n; i++) {
    const folder = `Folder ${Math.floor(i / 100)}`;
    seed.push({ path: `${folder}/Notatka ${i}.md`, text: `# Notatka ${i}\n` });
  }
  return new MockBridge(seed);
}
