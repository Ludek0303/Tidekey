// What the chat holds while it runs (docs/MCP.md §3.5, §5.1): per vault in its cert, the vault keys and the keys of the
// protected projects sealed to it, as non-extractable CryptoKeys (the raw bytes are zeroed as soon as they are imported),
// the scope, and the decrypted notes. Memory only; `wipe` drops all of it.
import * as Y from "yjs";
import type { BrowserVaultSnapshot } from "../../ui/src/bridge";
import { decryptSnapshot, type Envelope } from "../../ui/src/browserauth";
import { inScope, openForAgent, openScope, projectSlot, verifyCert, type AgentCert, type AgentScope, type AgentSealed, type SealedScope, type WriteMode } from "../../ui/src/agentcrypto";
import { inside, openPayload, type ProtectedEntry } from "../../ui/src/protected";
import { base64ToBytes, importVaultKey } from "../../ui/src/vaults";
import { AgentClient, AgentError, TEXT } from "./client";
import { zero } from "./sodium";
import { embedsOf, loadFileTexts, type FileTexts } from "./filetext";
import type { LocalState, Pin } from "./state";

export interface ChatKeys { agentId: string; signKey: string; boxKey: string; signSecret: Uint8Array; boxSecret: Uint8Array }
export interface NoteView { id: string; path: string; text: string; project: string | null }
export interface ProjectView { path: string; key: CryptoKey; entry: ProtectedEntry }
export interface VaultView {
  id: string; name: string; kind: string; ownerUserId: string; keyEpoch: number; role: string; writeMode: WriteMode;
  scope: AgentScope; person: Pin; members: { userId: string; name: string }[];
  keys: Map<number, CryptoKey>; revision: number; snapshot: BrowserVaultSnapshot | null;
  projects: ProjectView[]; locked: string[]; notes: NoteView[]; fetchedAt: number;
  // the organization lets chats see protected projects; the hash of the sealed scope this view was opened from
  allowProtected: boolean; scopeHash: string;
  /** "Tekst z plików" (docs/OCR.md §5.2): in the signed cert and allowed by the server for this vault. */
  fileText: boolean;
  /** Decrypted text layers by layer id (each fetched once), the files the chat may see, and when they were read. */
  layers: Map<string, string>; files: FileTexts | null; filesAt: number;
  /** Files embedded by notes in the trash (their ids only): such a file is not "embedded nowhere" (docs/OCR.md §5.2). */
  trashedEmbeds: Set<string>;
  /** The pass reading the files now, shared by tools that ask at the same time. */
  filesLoading: Promise<FileTexts> | null;
}
interface AgentMe { agentId: string; userId: string; cert: AgentCert; signature: string; sessionExpiresAt: number; vaults: { vaultId: string; scopeHash?: string }[] }
interface AgentVault {
  vault: { id: string; name: string; kind: string; ownerUserId: string; keyEpoch: number }; role: string; writeMode: WriteMode;
  agentKeys: { keyEpoch: number; sealedKey: AgentSealed }[]; sealedScope: SealedScope; person: Pin; members: { userId: string; name: string }[];
  allowProtected?: boolean; fileText?: boolean;
}
interface SnapshotAnswer { revision: number; envelope: Envelope | null }

export const PIN_TEXT = "Klucze Twojego konta na serwerze różnią się od zapamiętanych. To może być podmiana na serwerze, więc czat przestaje działać. Sprawdź konto w aplikacji i sparuj czat od nowa (notatki-mcp forget, potem pair).";
export const CERT_TEXT = "Certyfikat czatu nie zgadza się z kluczami tego komputera albo wygasł. Sparuj czat od nowa.";
const MODES: WriteMode[] = ["none", "proposals", "append", "direct"];
// The server gives a whole vault at most once per 5 minutes (docs/MCP.md §3.3) and counts an earlier fetch as an
// overrun (three in an hour pause the chat): the copy here is refreshed no more often than that.
export const REFRESH_MS = 5 * 60_000 + 5_000;
// The chat may not read now: nothing decrypted stays in memory. A 429 is not one of them: what is held stays, as a
// fetch again would only meet more 429s (three in an hour pause the chat).
const WIPE = ["session", "disabled", "version", "paused", "proof"];
const sameJwk = (a: JsonWebKey, b: JsonWebKey): boolean => a?.kty === b?.kty && a?.crv === b?.crv && a?.x === b?.x && a?.y === b?.y;
const pubJwk = (k: JsonWebKey): JsonWebKey => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });

/** The form paths are compared in: NFC (a path may come decomposed, e.g. from macOS) and case-folded, as the app does. */
export const pathKey = (p: string): string => p.normalize("NFC").toLowerCase();
/** `path` is `folder` or under it, compared as pathKey. */
export const within = (path: string, folder: string): boolean => inside(pathKey(path), pathKey(folder));
const nfcScope = (s: AgentScope): AgentScope => ({ ...s, include: s.include.map((p) => p.normalize("NFC")), exclude: s.exclude.map((p) => p.normalize("NFC")) });

export function noteText(yjsUpdateBase64: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base64ToBytes(yjsUpdateBase64));
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

export class Session {
  vaults = new Map<string, VaultView>();
  /** Vaults left out because their scope failed or was older than one seen before (names are not shown). */
  unavailable = new Set<string>();
  /** Pending proposals of this session: vault, path and summary only (the chat cannot open its own proposal, §7.1). */
  proposals: { vaultId: string; path: string; proposalId: string; summary: string }[] = [];
  sessionExpiresAt = 0;
  userId = "";
  /** Set after a pin mismatch: the chat refuses all work. */
  stopped: string | null = null;
  /** Called at the end of `wipe()`: holders of decrypted data outside the views (the chat's search index) drop it. */
  readonly onWipe: (() => void)[] = [];
  private loaded = false;
  private cert: AgentCert | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  // vaults of the scope not held now (a 429 or a failure): when to try them again (at most once per REFRESH_MS)
  private retryAt = new Map<string, number>();

  constructor(readonly client: AgentClient, readonly keys: ChatKeys, readonly state: LocalState, readonly origin: string, private readonly now: () => number = Date.now) {}

  /** Drops every vault key, project key and decrypted note (session expired, forget, exit). */
  wipe(): void {
    for (const id of [...this.vaults.keys()]) this.drop(id);
    this.loaded = false;
    this.retryAt.clear();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const f of this.onWipe) f();
  }
  /** Drops one vault: its keys, notes and snapshot are cleared, not only unlinked. */
  private drop(vaultId: string): void {
    const v = this.vaults.get(vaultId);
    if (v) { v.keys.clear(); v.projects = []; v.notes = []; v.snapshot = null; v.layers.clear(); v.files = null; v.trashedEmbeds.clear(); v.filesLoading = null; }
    this.vaults.delete(vaultId);
  }
  private setExpiry(at: unknown): void {
    this.sessionExpiresAt = Number(at) || 0;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const left = this.sessionExpiresAt - this.now();
    if (this.sessionExpiresAt && left > 0) { this.expiryTimer = setTimeout(() => this.wipe(), Math.min(left, 2 ** 31 - 1)); this.expiryTimer.unref?.(); }
  }
  private certOf(me: AgentMe): AgentCert | null {
    return me.cert && typeof me.cert === "object" ? { ...me.cert, signerUserId: me.cert.signerUserId ?? me.cert.userId, signature: me.signature ?? me.cert.signature } : null;
  }
  private async me(): Promise<AgentMe> {
    const me = await this.client.request<AgentMe>("GET", "/api/agent/me");
    if (typeof me.agentId !== "string" || (me.vaults !== undefined && !Array.isArray(me.vaults))) throw new AgentError(TEXT.failed, "other", 0);
    if (me.agentId !== this.keys.agentId) throw new AgentError(CERT_TEXT, "other", 0);
    this.scopeHashes = new Map((me.vaults ?? []).map((v) => [v.vaultId, v.scopeHash ?? ""]));
    this.setExpiry(me.sessionExpiresAt);
    return me;
  }

  /** Also zeroes the chat's own secret keys: the process is ending. */
  close(): void { this.wipe(); zero(this.keys.signSecret, this.keys.boxSecret); }

  /** Loads (or refreshes) the vaults; a lost session wipes everything held. */
  async ready(): Promise<void> {
    if (this.stopped) throw new AgentError(this.stopped, "other", 0);
    try {
      if (!this.loaded) await this.load();
      else {
        // Every tool asks the server first (cheap, no vault fetched): a disconnect, the operator switch, a pause or a
        // narrower scope then takes effect at once, not at the next refresh of the copy.
        const me = await this.me();
        const still = this.scopeHashes;
        for (const id of [...this.vaults.keys()]) if (!still.has(id)) this.drop(id);
        // a new cert (the scope screen changed vaults or write modes) is checked again for every vault held
        const cert = this.certOf(me);
        const newCert = cert?.signature !== this.cert?.signature;
        this.cert = cert;
        for (const v of [...this.vaults.values()]) {
          if (this.now() - v.fetchedAt > REFRESH_MS) await this.tryVault(v.id);
          // a new scope (narrower or wider) is opened at once, without fetching the vault again
          else if (newCert || still.get(v.id) !== v.scopeHash) await this.tryVault(v.id, false);
        }
        // a vault added to the scope, or one that could not be opened before, is tried (not more often than a refresh)
        for (const id of still.keys()) if (!this.vaults.has(id) && (this.retryAt.get(id) ?? 0) <= this.now()) await this.tryVault(id);
      }
    } catch (e) {
      // the chat may not read now: nothing decrypted stays in memory
      if (e instanceof AgentError && WIPE.includes(e.kind)) this.wipe();
      throw e;
    }
  }

  private async load(): Promise<void> {
    this.wipe();
    this.unavailable.clear();
    const me = await this.me();
    this.userId = me.userId;
    this.cert = this.certOf(me);
    for (const vaultId of this.scopeHashes.keys()) await this.tryVault(vaultId);
    this.loaded = true;
  }
  // One vault that fails (bad or older scope, a key that does not open) is left out; a failure of the chat is thrown.
  private scopeHashes = new Map<string, string>();
  async tryVault(vaultId: string, withSnapshot = true): Promise<void> {
    try {
      await this.refresh(vaultId, withSnapshot);
      this.unavailable.delete(vaultId);
      this.retryAt.delete(vaultId);
    } catch (e) {
      const limit = e instanceof AgentError && e.kind === "limit";
      if (this.stopped || (e instanceof AgentError && WIPE.includes(e.kind))) throw e;
      this.retryAt.set(vaultId, this.now() + REFRESH_MS);
      if (limit) return; // the copy held (if any) stays; tried again later
      this.drop(vaultId);
      if (!(e instanceof AgentError && e.kind === "scope")) this.unavailable.add(vaultId);
    }
  }

  /** When the next full fetch of a vault is allowed (the server gives a whole vault at most once per 5 minutes). */
  nextFullFetch(vaultId: string): number { return (this.vaults.get(vaultId)?.fetchedAt ?? 0) + REFRESH_MS; }
  /**
   * After a stale key (409): the vault's meta again for the new envelope, and its snapshot only when a full fetch is
   * allowed now, so no 429 is earned. Null, with the vault dropped, when the chat got no key for the new epoch.
   */
  async rekey(vaultId: string): Promise<VaultView | null> {
    await this.tryVault(vaultId, this.nextFullFetch(vaultId) <= this.now());
    const view = this.vaults.get(vaultId);
    if (view?.keys.has(view.keyEpoch)) return view;
    this.drop(vaultId);
    this.unavailable.add(vaultId);
    return null;
  }

  /** Checks the person's keys against the pinned ones (TOFU) and pins them on first use. */
  private pin(person: Pin): Pin {
    const pinned = this.state.data.pins[this.origin];
    const fresh = { userId: person.userId, signingKey: pubJwk(person.signingKey), boxKey: pubJwk(person.boxKey) };
    if (!pinned) { this.state.data.pins[this.origin] = fresh; this.state.save(); return fresh; }
    if (pinned.userId !== person.userId || !sameJwk(pinned.signingKey, person.signingKey) || !sameJwk(pinned.boxKey, person.boxKey)) {
      this.stopped = PIN_TEXT;
      this.wipe();
      throw new AgentError(PIN_TEXT, "other", 0);
    }
    return pinned;
  }

  async refresh(vaultId: string, withSnapshot = true): Promise<VaultView> {
    const path = `/api/agent/vaults/${encodeURIComponent(vaultId)}`;
    const meta = await this.client.request<AgentVault>("GET", path);
    if (meta?.vault?.id !== vaultId) throw new AgentError(TEXT.failed, "other", 0);
    // another person than the session's is never pinned
    if (meta.person?.userId !== this.userId) throw new AgentError(PIN_TEXT, "other", 0);
    const person = this.pin(meta.person);
    // the cert is signed by the person: it must name this chat's keys and this vault; its write mode bounds the server's
    const cert = this.cert;
    const inCert = cert?.vaults?.find((v) => v.vaultId === vaultId);
    if (!cert || cert.agentId !== this.keys.agentId || cert.userId !== person.userId || cert.signKey !== this.keys.signKey || cert.boxKey !== this.keys.boxKey
      || cert.expiresAt <= this.now() || !inCert || !(await verifyCert(cert, person.signingKey))) throw new AgentError(CERT_TEXT, "other", 0);
    const writeMode = MODES[Math.min(MODES.indexOf(meta.writeMode), MODES.indexOf(inCert.writeMode))] ?? "none";
    const scope = nfcScope(await openScope(meta.sealedScope, this.keys, person.signingKey, { agentId: this.keys.agentId, vaultId, userId: person.userId })
      .catch(() => { throw new AgentError("scope-bad", "other", 0); }));
    const seen = this.state.data.scopes[this.origin]?.[vaultId] ?? 0;
    if (scope.updatedAt < seen) throw new AgentError("scope-old", "other", 0);
    if (scope.updatedAt > seen) { (this.state.data.scopes[this.origin] ??= {})[vaultId] = scope.updatedAt; this.state.save(); }

    const old = this.vaults.get(vaultId);
    const keys = new Map<number, CryptoKey>();
    for (const k of meta.agentKeys ?? []) {
      const raw = await openForAgent(k.sealedKey, this.keys, vaultId, "vault", k.keyEpoch);
      try { keys.set(k.keyEpoch, await importVaultKey(raw)); } finally { zero(raw); }
    }
    const view: VaultView = {
      id: vaultId, name: meta.vault.name, kind: meta.vault.kind, ownerUserId: meta.vault.ownerUserId, keyEpoch: meta.vault.keyEpoch,
      role: meta.role, writeMode, scope, person, members: (meta.members ?? []).map((m) => ({ userId: m.userId, name: m.name })),
      keys, revision: old?.revision ?? 0, snapshot: old?.snapshot ?? null, projects: old?.projects ?? [], locked: old?.locked ?? [], notes: old?.notes ?? [],
      fetchedAt: withSnapshot || !old ? this.now() : old.fetchedAt, allowProtected: meta.allowProtected !== false, scopeHash: this.scopeHashes.get(vaultId) ?? "",
      // both must say yes: the server (cert and policy) and the cert the person signed
      fileText: meta.fileText === true && inCert.fileText === true,
      // decrypted layers stay only while the permission does; the file list is read again under the new scope
      layers: meta.fileText === true && inCert.fileText === true ? old?.layers ?? new Map() : new Map(), files: null, filesAt: 0,
      trashedEmbeds: old?.trashedEmbeds ?? new Set(), filesLoading: null,
    };
    if (old && !view.fileText) old.layers.clear();
    if (!withSnapshot && old?.snapshot) {
      // the copy held is read again under the new scope and policy (protected projects may no longer be allowed)
      await this.setSnapshot(view, old.revision, old.snapshot);
      this.vaults.set(vaultId, view);
      return view;
    }
    const since = old?.snapshot ? `?since=${old.revision}` : "";
    const answer = await this.client.request<SnapshotAnswer>("GET", `${path}/snapshot${since}`);
    if (answer.envelope) await this.take(view, answer.revision, answer.envelope);
    else if (!old?.snapshot) view.revision = answer.revision ?? 0;
    this.vaults.set(vaultId, view);
    return view;
  }

  /** Decrypts a snapshot the server sent and rebuilds the note views from it. */
  async take(view: VaultView, revision: number, envelope: Envelope): Promise<void> {
    const key = view.keys.get(envelope.keyEpoch ?? view.keyEpoch);
    if (!key) throw new AgentError(TEXT.failed, "other", 0);
    const snapshot = await decryptSnapshot(envelope, view.ownerUserId, view.id, key);
    await this.setSnapshot(view, revision, snapshot);
  }

  async setSnapshot(view: VaultView, revision: number, snapshot: BrowserVaultSnapshot): Promise<void> {
    const projects: ProjectView[] = [];
    const locked: string[] = [];
    const notes: NoteView[] = [];
    // files embedded by notes in a trash (the vault's and each opened project's) are not "embedded nowhere" (OCR §5.2):
    // only their ids are kept. The app moves a deleted note's text into `trash` (bridge.ts trashNote).
    const trashedEmbeds = new Set<string>();
    const trashed = (items: { state: string }[] | undefined) => {
      for (const t of items ?? []) for (const id of embedsOf(noteText(t.state))) trashedEmbeds.add(id);
    };
    trashed(snapshot.state.trash);
    for (const entry of snapshot.state.protected ?? []) {
      const mine = (entry as ProtectedEntry & { agentKeys?: { agentId: string; userId: string; sealedKey: AgentSealed }[] }).agentKeys
        ?.find((k) => k.agentId === this.keys.agentId && k.userId === view.person.userId);
      let key: CryptoKey | null = null;
      if (mine && view.allowProtected) {
        try {
          const raw = await openForAgent(mine.sealedKey, this.keys, view.id, projectSlot(entry.path), entry.keyEpoch);
          try { key = await importVaultKey(raw); } finally { zero(raw); }
          const payload = await openPayload(view.id, entry, key);
          for (const n of payload.notes) if (within(n.path, entry.path)) notes.push({ id: n.id, path: n.path, text: noteText(n.yjsUpdateBase64), project: entry.path });
          trashed(payload.trash);
        } catch { key = null; }
      }
      if (key) projects.push({ path: entry.path, key, entry });
      else locked.push(entry.path);
    }
    const hidden = (p: string) => [...locked, ...projects.map((x) => x.path)].some((f) => within(p, f));
    // a note with a delete tombstone is in the trash for the app (bridge.ts isDeleted), whatever copy is in `notes`
    const deleted = new Set((snapshot.state.deleted ?? []).filter((t) => Number(t.deletedAt) > (Number(t.restoredAt) || 0)).map((t) => String(t.id)));
    for (const n of snapshot.state.notes) {
      if (hidden(n.path)) continue;
      // a note in the trash is not shown, but the files it embeds are not "embedded nowhere": only their ids are kept
      if (deleted.has(n.id)) { for (const id of embedsOf(noteText(n.yjsUpdateBase64))) trashedEmbeds.add(id); continue; }
      notes.push({ id: n.id, path: n.path, text: noteText(n.yjsUpdateBase64), project: null });
    }
    notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // the file list depends on the notes and the locked projects: read again at the next fileTexts
    Object.assign(view, { revision, snapshot, projects, locked, notes, trashedEmbeds, files: null, filesAt: 0 });
  }

  /** Whether the chat may show `path` of this vault: in the soft scope and not in a protected project it has no key to. */
  visible(view: VaultView, path: string): boolean {
    return inScope(view.scope, path.normalize("NFC")) && !view.locked.some((f) => within(path, f));
  }
  visibleNotes(view: VaultView): NoteView[] { return view.notes.filter((n) => this.visible(view, n.path)); }

  /** The files of `view` the chat may see and their text (docs/OCR.md §5.4), read again after each refresh of the
   *  vault; empty without "Tekst z plików". `onProgress` gets (read, layers) while layers come in. */
  async fileTexts(view: VaultView, onProgress?: (read: number, layers: number) => void): Promise<FileTexts> {
    const none: FileTexts = { files: [], layers: 0, read: 0 };
    if (!view.fileText || this.vaults.get(view.id) !== view) return none;
    if (view.files && view.filesAt >= view.fetchedAt) return view.files;
    // one pass at a time per vault: a second tool waits for it (the server allows one full pass per 5 minutes)
    view.filesLoading ??= (async () => {
      // a new snapshot of this same view (a refresh, the chat's own write) makes this pass stale: its file list was
      // chosen from the old notes; the next tool starts a new pass
      const snap = view.snapshot;
      const alive = () => this.vaults.get(view.id) === view && view.snapshot === snap && !this.stopped;
      try {
        const files = await loadFileTexts(view, this.client, (p) => this.visible(view, p), view.layers, onProgress, alive);
        // dropped meanwhile (session end, narrower scope: drop() cleared the layers) or stale: nothing is kept. The
        // layer cache is not cleared here: a new view of the vault may share it (setVault keeps `old.layers`).
        if (!alive()) return none;
        view.files = files;
        view.filesAt = this.now();
        return files;
      } catch (e) {
        // the chat may not read now: nothing decrypted stays in memory (as in ready())
        if (e instanceof AgentError && WIPE.includes(e.kind)) this.wipe();
        throw e;
      } finally {
        view.filesLoading = null;
      }
    })();
    return view.filesLoading;
  }
}
