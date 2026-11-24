// The server's file store for one vault (docs/PLIKI.md §3–§6): encrypts and decrypts in the browser (filecrypto.ts),
// keeps the server to ciphertext, and retries the chunks of an upload. Also the migration of snapshot attachments.
import { ApiError, bufferSource } from "./vaults";
import { inside } from "./protected";
import { EXTRACTOR_VERSION, parse as parseFileText } from "./ocr/filetext";
import { PLAIN_CHUNK, chunkCount, cipherSize, metaRefOf, migrationId, newFileKey, openFile, openMeta, scopeOf, sealFile, sealMeta, textLayerId, type FileMeta, type MetaRef } from "./filecrypto";
import { MAX_FILE_BYTES, formatSize, newFileId, type FileHead, type FileInfo, type FileList, type FileState, type FileStore, type ReadOptions, type TextLayers, type UploadOptions, type VideoThumb, projectOfNote } from "./filestore";

/** A protected project's key as this user has it. `current`: the project's current epoch (files are written with it). */
export interface ProjectRef { path: string; keyEpoch: number; current: boolean; members: string[]; key: CryptoKey | null }

/** The keys this store needs, from the bridge: the vault key of the current epoch, older epochs, and the protected projects. */
export interface FileKeys {
  vault(): { key: CryptoKey; keyEpoch: number };
  /** The vault key of an epoch this device still holds, or null. */
  vaultKey(keyEpoch: number): Promise<CryptoKey | null>;
  /** Every protected project known here. `key` is null when this user holds no key for it (its files are not theirs). */
  projects(): Promise<ProjectRef[]>;
}

export interface RemoteFileDeps {
  vaultId: string;
  /** This user's id: their own unfinished upload at a text layer's id may be started again (writeTextLayer). */
  who?: string;
  keys: FileKeys;
  fetch?: typeof fetch;
  /** Waits between retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

// The record as the server sends it (docs/PLIKI.md §3). `size` and `used` count encrypted bytes.
export interface FileRecord {
  id: string; state: FileState; size: number; chunks: number; received: number; scope: string | null; meta: string;
  createdBy: string | null; createdAt: number; completedAt: number | null; deletedAt: number | null;
  parent: string | null | undefined; kind?: "thumb" | "text" | null;
}
/** What a text layer's envelope says beside the usual fields (docs/OCR.md §3.2). */
export type TextLayerFields = Required<Pick<FileMeta, "extractor" | "method" | "pages" | "lang" | "quality" | "flags" | "engine">>;
/** A text layer as the app sees it: its own id, the original's id, its envelope fields and when it was written. */
export interface TextLayerInfo extends TextLayerFields { id: string; textOf: string; createdAt: number; createdBy: string | null }
interface FileListing { files: FileRecord[]; used: number; quota: number | null; trashDays: number }
/** What a new file's metadata says about it; the store adds the format, size, key and creation time. */
type NewFileFields = Pick<FileMeta, "name" | "mime" | "project"> & Partial<Pick<FileMeta, "width" | "height" | "thumb" | "thumbOf" | "duration" | "textOf" | "extractor" | "method" | "pages" | "lang" | "quality" | "flags" | "engine" | "encoding">>;

const RETRIES = 3;
/** A text layer holds at most 2 MB of text (docs/OCR.md §2.3); gzip never makes it bigger by more than a little. */
export const TEXT_LAYER_MAX_BYTES = 2 * 1024 * 1024;
export const TEXT_LAYER_MAX_GZIP = TEXT_LAYER_MAX_BYTES + 64 * 1024;
// at most ~1000× this much text comes out of one slice of gzip before the limit check runs
const INFLATE_SLICE = 16 * 1024;
const TOO_BIG = "Tekst pliku jest za duży.";
const CORRUPT_CONTAINER = "Plik jest uszkodzony albo został zmieniony.";
// the server's message for a row whose stored object is gone (crates/node/src/files.rs NO_CONTENT)
const NO_CONTENT = "Treść pliku nie istnieje na serwerze.";
/** The content of a text layer is wrong (not a failed read): too big, not gzip, not UTF-8 or not this file's layer. */
export class DamagedLayer extends Error {}
const METHODS = new Set<string>(["pdf-text", "ocr", "mixed", "none"]);
const FLAGS = new Set<string>(["ucięte", "zabezpieczony", "brak tekstu", "błąd"]);
const backoff = (attempt: number): number => 500 * 2 ** attempt;
const abortError = (): DOMException => new DOMException("Anulowano", "AbortError");
const toInfo = (rec: FileRecord, meta: FileMeta): FileInfo => ({
  id: rec.id, name: meta.name, mime: meta.mime, size: meta.size, project: meta.project ?? null, state: rec.state,
  createdAt: rec.createdAt, createdBy: rec.createdBy ?? null, deletedAt: rec.deletedAt ?? null,
  thumb: meta.thumb ?? null, width: meta.width ?? null, height: meta.height ?? null, thumbOf: meta.thumbOf ?? null,
  durationMs: meta.duration ?? null,
});

export class RemoteFileStore implements FileStore, TextLayers {
  private listeners = new Set<(id?: string) => void>();
  private uploadListeners = new Set<(info: FileInfo, file: File) => void>();
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;

  constructor(private readonly deps: RemoteFileDeps) {
    this.base = `/api/vaults/${encodeURIComponent(deps.vaultId)}`;
    this.http = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Uploads a file under `options.id`. A thumbnail goes first, as its own file, and the image records its id. An upload
   * that found an unfinished record of the same id starts again: a stream cannot resume, so the old record is dropped
   * and the file is sent with a new key.
   */
  async upload(file: File, options: UploadOptions): Promise<FileInfo> {
    const info = await this.sendUpload(file, options);
    for (const cb of this.uploadListeners) cb(info, file);
    return info;
  }

  onUploaded(cb: (info: FileInfo, file: File) => void): () => void {
    this.uploadListeners.add(cb);
    return () => this.uploadListeners.delete(cb);
  }

  private async sendUpload(file: File, options: UploadOptions): Promise<FileInfo> {
    if (file.size > MAX_FILE_BYTES) throw new Error(`Plik jest większy niż ${formatSize(MAX_FILE_BYTES)}.`);
    if (options.signal?.aborted) throw abortError();
    const project = await this.scopeFor(options.project ?? null);
    const name = file.name || "plik";
    const mime = file.type || "application/octet-stream";
    const signal = options.signal;
    if (!options.thumbnail) return this.sendFile(file, options.id, { name, mime, project }, options);
    await this.cancel(options.id); // a restart drops the old thumbnail with the old record, before the new one goes up
    const thumbId = newFileId();
    const { blob, width, height, durationMs } = options.thumbnail;
    await this.sendFile(blob, thumbId, { name, mime: blob.type || "image/jpeg", project, thumbOf: options.id }, { signal });
    const duration = durationMs === undefined ? {} : { duration: Math.round(durationMs) };
    return this.sendFile(file, options.id, { name, mime, project, thumb: thumbId, width, height, ...duration }, options);
  }

  private async sendFile(blob: Blob, id: string, fields: NewFileFields, options: Pick<UploadOptions, "signal" | "onProgress">): Promise<FileInfo> {
    const { signal } = options;
    const target = await this.target(fields.project);
    const key = await newFileKey();
    const meta: FileMeta = { format: 2, version: 1, ...fields, size: blob.size, key, createdAt: Date.now() };
    const sealed = await sealMeta(this.deps.vaultId, id, target.ref, target.key, meta);
    // A protected project: its scope list is set before the first file goes in (the server checks it).
    if (target.scope && !fields.textOf) await this.request("PUT", `${this.base}/file-scopes/${target.scope}`, { json: { members: target.members } });
    const child = fields.textOf ? { parent: fields.textOf, kind: "text" } : fields.thumbOf ? { parent: fields.thumbOf, kind: "thumb" } : {};
    const post = () => this.send("POST", `${this.base}/files`, { json: { id, size: cipherSize(blob.size), meta: sealed, ...(target.scope ? { scope: target.scope } : {}), ...child } });
    let created = await post();
    if (created.status === 200) {
      // The same id again: a finished file is the answer; an unfinished one is dropped and started with a new key.
      const old = (await created.json()) as FileRecord;
      const existing = old.state === "ready" ? await this.openRecord(old) : null;
      if (existing) return toInfo(old, existing);
      // only an unfinished upload is dropped; a finished file this device cannot open is never touched
      if (old.state !== "uploading") throw new Error("Plik o tym identyfikatorze już istnieje.");
      await this.request("DELETE", this.path(id));
      created = await post();
    }
    if (!created.ok) throw await this.failure(created);
    if (created.status === 200) throw new Error("Plik o tym identyfikatorze jest już przesyłany. Spróbuj ponownie.");
    try {
      let n = 0;
      for await (const wire of sealFile(blob, key, this.deps.vaultId, id, target.scope ?? null)) {
        if (signal?.aborted) throw abortError();
        // The server answers with what it holds now; anything but "this chunk is held" means the upload went out of step.
        const received = await this.putChunk(id, n, wire, signal);
        if (received !== n + 1) throw new Error("Serwer odrzucił część pliku. Spróbuj ponownie.");
        n++;
        options.onProgress?.(Math.min(blob.size, n * PLAIN_CHUNK), blob.size);
      }
      const rec = await this.request<FileRecord>("POST", `${this.path(id)}/complete`);
      this.changed(id);
      return toInfo(rec, meta);
    } catch (error) {
      // A cancelled upload is dropped from the server; a failed one stays until it is cancelled or started again.
      if (signal?.aborted) await this.cancel(id).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<FileList> {
    const listing = await this.listing();
    const resolve = await this.resolver();
    const files: FileInfo[] = [];
    for (const rec of listing.files) {
      // A file this user cannot open is not shown; a copy that fails the check is skipped, not reported. Thumbnails are not files of their own.
      const info = await this.infoOf(rec, resolve).catch(() => null);
      if (info && !info.thumbOf) files.push(info);
    }
    return { files, used: listing.used, quota: listing.quota, trashDays: listing.trashDays };
  }

  /**
   * Writes the text layer of `originalId` (docs/OCR.md §3.2): `markdown` gzip-compressed in the usual container, under
   * the id derived from the original's file key, as a hidden child (`kind: "text"`) with the original's project, so it
   * gets the original's scope and key. A record already at that id counts as done only when it is a real layer of this
   * original (checked like a reader does): a trashed one is restored, this user's unfinished upload is started again, and
   * anything else is reported, never taken for done (docs/OCR-PLAN.md §4.5).
   */
  async writeTextLayer(originalId: string, markdown: string, fields: TextLayerFields, signal?: AbortSignal): Promise<string> {
    const meta = await this.originalMeta(originalId, signal);
    // only a layer a reader would take: within the limit, of this file and of the extractor it claims
    const doc = new TextEncoder().encode(markdown).length <= TEXT_LAYER_MAX_BYTES ? parseFileText(markdown) : null;
    // and envelope fields every reader accepts: a layer they would refuse would block its id for good
    if (doc?.source !== originalId || doc.extractor !== fields.extractor || !validLayerFields(fields)) throw new Error("Tekst pliku jest uszkodzony.");
    const id = await textLayerId(meta.key, originalId, fields.extractor);
    if (await this.settleExistingLayer(id, originalId, meta.key, signal)) return id;
    const gz = new Blob([await new Response(new Response(markdown).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()]);
    // the seven layer fields are copied one by one: nothing in `fields` can replace `textOf` or `project`
    const layer: NewFileFields = {
      extractor: fields.extractor, method: fields.method, pages: fields.pages, lang: fields.lang, quality: fields.quality,
      flags: [...fields.flags], engine: fields.engine,
      name: `${meta.name}.tekst.md`, mime: "text/markdown", project: meta.project, textOf: originalId, encoding: "gzip",
    };
    try {
      await this.sendFile(gz, id, layer, { signal });
    } catch (error) {
      // another device of a member wrote it meanwhile: done only when that record is a real layer
      if (!(error instanceof ApiError && error.status === 409) || !(await this.settleExistingLayer(id, originalId, meta.key, signal))) throw error;
    }
    return id;
  }

  /** The envelope of a ready original (not a thumbnail or a layer) this user can open; throws otherwise. */
  private async originalMeta(originalId: string, signal?: AbortSignal): Promise<FileMeta> {
    const rec = await this.record(originalId, signal);
    const meta = rec && rec.state === "ready" && !rec.parent && !rec.kind ? await this.openRecord(rec).catch(() => null) : null;
    if (!meta) throw new Error("Nie ma tego pliku albo nie można go odczytać.");
    return meta;
  }

  /** True when a valid layer whose text reads back is at `id` (restored first when trashed); false when nothing is there
   *  or this user's own unfinished upload was cleared; throws when something else holds the id. */
  private async settleExistingLayer(id: string, originalId: string, fileKey: string, signal?: AbortSignal): Promise<boolean> {
    const rec = await this.record(id, signal);
    if (!rec) return false;
    const valid = rec.kind === "text" && rec.parent === originalId && await this.layerOf(rec, fileKey, await this.resolver()) !== null;
    if (valid && (rec.state === "ready" || rec.state === "trashed")) {
      // a valid envelope over text that never reads would hold the id for good: checked before it counts as done;
      // only a text that does not read is "damaged" (offline, aborted or a server error stays what it is)
      await this.inflateLayer(rec, originalId, fileKey, { signal }).catch((error: unknown) => {
        // a stored object that is missing or fails its integrity check is as damaged as text that does not parse
        // only "no content" among the 404s: a purged row or lost access is not damage
        const stored = error instanceof Error && (error.message === NO_CONTENT || error.message === CORRUPT_CONTAINER);
        if (!(error instanceof DamagedLayer) && !stored) throw error;
        throw new Error(rec.state === "trashed"
          ? "Tekst tego pliku zapisany wcześniej jest uszkodzony. Administrator sejfu może usunąć go z kosza na stałe, potem rozpoznaj tekst ponownie."
          : "Tekst tego pliku zapisany wcześniej jest uszkodzony. Administrator sejfu może go usunąć, potem rozpoznaj tekst ponownie.");
      });
      if (rec.state === "trashed") await this.request("POST", `${this.path(id)}/restore`);
      return true;
    }
    if (rec.state === "uploading" && rec.createdBy === this.deps.who) {
      await this.cancel(id);
      return false;
    }
    throw new Error("Tekstu tego pliku nie da się zapisać: jego miejsce zajmuje inny zapis. Rozpoznaj tekst ponownie później.");
  }

  private layerOf(rec: FileRecord, fileKey: string, resolve: (ref: MetaRef) => Promise<CryptoKey | null>): Promise<TextLayerInfo | null> {
    return layerOfRecord(this.deps.vaultId, rec, fileKey, resolve);
  }

  /** The text layers this user can open, by the id of their original; the newest extractor wins (docs/OCR.md §3.2). */
  async textLayers(): Promise<Map<string, TextLayerInfo>> {
    const listing = await this.request<FileListing>("GET", `${this.base}/files?kinds=text`);
    const resolve = await this.resolver();
    const keys = new Map<string, string>();
    for (const rec of listing.files) {
      // only ready originals: the text of a file in the trash is neither shown nor searched
      if (rec.parent || rec.kind || rec.state !== "ready") continue;
      const meta = await openMeta(this.deps.vaultId, rec.id, rec.meta, resolve).catch(() => null);
      if (meta) keys.set(rec.id, meta.key);
    }
    const out = new Map<string, TextLayerInfo>();
    for (const rec of listing.files) {
      if (rec.kind !== "text" || rec.state !== "ready" || !rec.parent) continue;
      const key = keys.get(rec.parent);
      const layer = key ? await this.layerOf(rec, key, resolve) : null;
      if (!layer) continue;
      const known = out.get(layer.textOf);
      if (!known || known.extractor < layer.extractor) out.set(layer.textOf, layer);
    }
    return out;
  }

  /** The Markdown of the ready text layer `id` of `originalId` (checked like `textLayers` does), decrypted and
   *  decompressed; it must parse as a layer of that file (at most `TEXT_LAYER_MAX_BYTES`). */
  async readTextLayer(id: string, originalId: string, options?: ReadOptions): Promise<string> {
    const rec = await this.record(id, options?.signal);
    const meta = rec?.state === "ready" ? await this.originalMeta(originalId, options?.signal) : null;
    if (!rec || !meta || await this.layerOf(rec, meta.key, await this.resolver()) === null || rec.parent !== originalId) throw new Error("Nie ma tekstu tego pliku.");
    return this.inflateLayer(rec, originalId, meta.key, options);
  }

  /** The layer's text, read and checked. Fails with `DamagedLayer` when the content itself is wrong (not on a read
   *  error): too big, not gzip, not UTF-8, or not a layer of `originalId` by the extractor its envelope names. */
  private async inflateLayer(rec: FileRecord, originalId: string, fileKey: string, options?: ReadOptions): Promise<string> {
    const layer = await this.layerOf(rec, fileKey, await this.resolver());
    if (!layer || rec.parent !== originalId) throw new Error("Nie ma tekstu tego pliku.");
    const zipped = new Uint8Array(await (await this.read(rec.id, options)).arrayBuffer());
    return layerText(zipped, originalId, layer.extractor);
  }

  async info(id: string): Promise<FileInfo | null> {
    const rec = await this.record(id);
    return rec ? this.infoOf(rec, await this.resolver()) : null;
  }

  async read(id: string, options?: ReadOptions): Promise<Blob> {
    return (await this.plain(id, Infinity, options)).blob;
  }

  async readHead(id: string, maxBytes: number, options?: ReadOptions): Promise<FileHead> {
    if (!(maxBytes > 0)) throw new RangeError("maxBytes must be positive");
    return this.plain(id, Math.max(1, Math.ceil(maxBytes / PLAIN_CHUNK)), options);
  }

  /**
   * Decrypts the first `chunks` chunks of a file (all of them for Infinity). The download is stopped once they are
   * decrypted, and an abort of the caller stops it at once.
   */
  private async plain(id: string, chunks: number, options: ReadOptions = {}): Promise<FileHead> {
    const { signal, onProgress } = options;
    if (signal?.aborted) throw abortError();
    try {
      const rec = await this.record(id, signal);
      const meta = rec && await this.openRecord(rec);
      if (!rec || !meta) throw new Error("Nie ma takiego pliku.");
      if (rec.size !== cipherSize(meta.size)) throw new Error("Plik jest uszkodzony albo został zmieniony.");
      const total = chunkCount(meta.size);
      const want = Math.min(chunks, total);
      const end = Math.min(meta.size, want * PLAIN_CHUNK);
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const res = await this.send("GET", `${this.path(id)}/content`, { signal: controller.signal });
        if (!res.ok) throw await this.failure(res);
        const parts: Uint8Array[] = [];
        let done = 0;
        for await (const part of openFile(bodyPieces(res), meta.key, this.deps.vaultId, id, rec.scope, meta.size)) {
          parts.push(part);
          done += part.length;
          onProgress?.(done, end);
          if (signal?.aborted) throw abortError();
          // a whole read runs the stream to its end, so openFile still rejects bytes after the final chunk
          if (want < total && parts.length === want) break;
        }
        return { blob: new Blob(parts as BlobPart[], { type: meta.mime }), complete: want === total };
      } finally {
        signal?.removeEventListener("abort", stop);
        controller.abort();
      }
    } catch (error) {
      // A network failure while fetching (fetch rejects with a TypeError) is not a damaged file.
      if (error instanceof TypeError) throw new Error("Plik jest niedostępny bez połączenia.");
      throw error;
    }
  }

  /** Adds the thumbnail of a video that has none: its own file (`parent`, `thumbOf`), then the original's envelope gets `thumb`. */
  async setThumbnail(id: string, thumb: VideoThumb): Promise<void> {
    const rec = await this.record(id);
    const meta = rec && await this.openRecord(rec);
    if (!rec || !meta) throw new Error("Nie ma takiego pliku.");
    if (meta.thumb) return;
    const thumbId = newFileId();
    await this.sendFile(thumb.blob, thumbId, { name: meta.name, mime: thumb.blob.type || "image/jpeg", project: meta.project, thumbOf: id }, {});
    const target = await this.target(meta.project);
    const duration = thumb.durationMs !== undefined ? { duration: Math.round(thumb.durationMs) } : {};
    const sealed = await sealMeta(this.deps.vaultId, id, target.ref, target.key, { ...meta, thumb: thumbId, ...duration });
    await this.request("PATCH", this.path(id), { json: { meta: sealed } });
    this.changed(id);
  }

  async rename(id: string, name: string): Promise<void> {
    const clean = name.trim();
    if (!clean) throw new Error("Nazwa pliku nie może być pusta.");
    const rec = await this.record(id);
    const meta = rec && await this.openRecord(rec);
    if (!meta) throw new Error("Nie ma takiego pliku.");
    const target = await this.target(meta.project);
    const sealed = await sealMeta(this.deps.vaultId, id, target.ref, target.key, { ...meta, name: clean });
    await this.request("PATCH", this.path(id), { json: { meta: sealed } });
    this.changed(id);
  }

  trash(id: string): Promise<void> { return this.act(id, "DELETE", ""); }
  restore(id: string): Promise<void> { return this.act(id, "POST", "/restore"); }

  /** Stops an upload and drops its thumbnail. A finished file is left alone (use trash for it). */
  async cancel(id: string): Promise<void> {
    if ((await this.record(id))?.state === "uploading") await this.act(id, "DELETE", "");
  }

  /** Removes a file from the trash for good (admins; the server checks the role). */
  purge(id: string): Promise<void> { return this.act(id, "POST", "/purge"); }

  /** Sets the members of a protected project's scope (the bridge calls it when the members change). */
  async syncProject(path: string, members: string[]): Promise<void> {
    await this.request("PUT", `${this.base}/file-scopes/${await scopeOf(this.deps.vaultId, path)}`, { json: { members } });
  }

  /**
   * Re-seals the envelopes of older key epochs (after a vault key rotation or a project rekey) with the current key.
   * Only files this user can open and whose key is current here are touched. Returns how many were re-sealed.
   */
  async rewrapAll(): Promise<number> {
    const resolve = await this.resolver();
    let count = 0;
    // text layers too: left on an old epoch, a member without that key could neither read nor rewrite them
    for (const rec of (await this.request<FileListing>("GET", `${this.base}/files?kinds=text`)).files) {
      if (rec.state === "uploading") continue;
      try {
        const meta = await openMeta(this.deps.vaultId, rec.id, rec.meta, resolve);
        if (!meta) continue;
        const ref = metaRefOf(rec.meta);
        const target = await this.target(meta.project);
        const stale = "scope" in ref ? target.scope === ref.scope && ref.projectEpoch < target.epoch : !target.scope && ref.keyEpoch < target.epoch;
        if (!stale) continue;
        await this.request("PATCH", this.path(rec.id), { json: { meta: await sealMeta(this.deps.vaultId, rec.id, target.ref, target.key, meta) } });
        count++;
      } catch {
        // Not this user's to re-seal, or changed meanwhile: it stays as it is and the next run tries again.
      }
    }
    if (count) this.changed();
    return count;
  }

  onChange(cb: (id?: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---- requests -----------------------------------------------------------------------------------------------------

  private path(id: string): string { return `${this.base}/files/${encodeURIComponent(id)}`; }

  private send(method: string, path: string, init: { body?: Uint8Array; json?: unknown; type?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.type) headers["content-type"] = init.type;
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.body ? bufferSource(init.body) : undefined;
    return this.http(path, { method, credentials: "same-origin", headers, body, signal: init.signal });
  }

  private async request<T = unknown>(method: string, path: string, init?: { json?: unknown }): Promise<T> {
    const res = await this.send(method, path, init);
    if (!res.ok) throw await this.failure(res);
    return (await res.json().catch(() => ({}))) as T;
  }

  private async failure(res: Response): Promise<ApiError> {
    const data = await res.json().catch(() => ({})) as { message?: string; error?: string };
    return new ApiError(data.message ?? data.error ?? `Błąd serwera (${res.status}).`, res.status);
  }

  private async listing(): Promise<FileListing> { return this.request<FileListing>("GET", `${this.base}/files`); }

  private async record(id: string, signal?: AbortSignal): Promise<FileRecord | null> {
    const res = await this.send("GET", this.path(id), { signal });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure(res);
    return (await res.json()) as FileRecord;
  }

  // The server takes the file's thumbnail along (its `parent` is this file).
  private async act(id: string, method: string, suffix: string): Promise<void> {
    await this.request(method, `${this.path(id)}${suffix}`);
    this.changed(id);
  }

  // Sends one chunk, retrying network errors and 5xx with backoff, and returns how many chunks the server now holds.
  // The same bytes are sent again on a retry (the cipher state is ahead, so the chunk cannot be sealed anew).
  private async putChunk(id: string, n: number, body: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.send("PUT", `${this.path(id)}/chunks/${n}`, { body, type: "application/octet-stream", signal });
      } catch (error) {
        if (signal?.aborted || attempt >= RETRIES) throw error;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (res.ok || res.status === 409) return ((await res.json()) as { received: number }).received;
      if (res.status < 500 || attempt >= RETRIES) throw await this.failure(res);
      await this.sleep(backoff(attempt));
    }
  }

  // ---- keys ---------------------------------------------------------------------------------------------------------

  // Which key opens an envelope: the vault key of its epoch, or the held key of a project scope and epoch.
  private async resolver(): Promise<(ref: MetaRef) => Promise<CryptoKey | null>> {
    const scoped = new Map<string, CryptoKey>();
    for (const project of await this.deps.keys.projects()) {
      if (project.key) scoped.set(`${await scopeOf(this.deps.vaultId, project.path)}\0${project.keyEpoch}`, project.key);
    }
    return async (ref) => ("keyEpoch" in ref ? this.deps.keys.vaultKey(ref.keyEpoch) : scoped.get(`${ref.scope}\0${ref.projectEpoch}`) ?? null);
  }

  // The protection a note's files go under: the innermost protected folder or note holding `path` (a note path, or an
  // older caller's project folder); otherwise the `Projekty/<Name>` project the note sits in, kept for the Pliki filter.
  private async scopeFor(path: string | null): Promise<string | null> {
    if (path === null) return null;
    const holding = (await this.deps.keys.projects()).filter((p) => p.current && inside(path, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return holding?.path ?? projectOfNote(path) ?? (path.endsWith(".md") ? null : path);
  }

  // What a new or re-sealed envelope is written with: the current project key (its scope) for a protected folder, else the vault key.
  private async target(project: string | null): Promise<{ ref: MetaRef; key: CryptoKey; epoch: number; scope?: string; members: string[] }> {
    const current = project ? (await this.deps.keys.projects()).find((p) => p.current && p.path === project) : undefined;
    if (current) {
      if (!current.key) throw new Error("Nie masz klucza tego projektu na tym urządzeniu.");
      const scope = await scopeOf(this.deps.vaultId, current.path);
      return { ref: { scope, projectEpoch: current.keyEpoch }, key: current.key, epoch: current.keyEpoch, scope, members: current.members };
    }
    const vault = this.deps.keys.vault();
    return { ref: { keyEpoch: vault.keyEpoch }, key: vault.key, epoch: vault.keyEpoch, members: [] };
  }

  private async openRecord(rec: FileRecord): Promise<FileMeta | null> {
    return openMeta(this.deps.vaultId, rec.id, rec.meta, await this.resolver());
  }

  private async infoOf(rec: FileRecord, resolve: (ref: MetaRef) => Promise<CryptoKey | null>): Promise<FileInfo | null> {
    const meta = await openMeta(this.deps.vaultId, rec.id, rec.meta, resolve);
    return meta ? toInfo(rec, meta) : null;
  }

  private changed(id?: string): void {
    for (const cb of this.listeners) cb(id);
  }
}

// The body as pieces: one piece when the response has no stream.
async function* bodyPieces(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) { yield new Uint8Array(await res.arrayBuffer()); return; }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

// ---- migration (docs/PLIKI.md §5) ---------------------------------------------------------------------------------

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip",
  mp3: "audio/mpeg", mp4: "video/mp4",
};
export const mimeByName = (name: string): string => MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

export interface PendingAttachment { key: string; bytes: Uint8Array }

/**
 * Moves snapshot attachments to the server. Each goes up under its deterministic id (a 409 means another client has
 * that id already), is read back and compared, and only then `moved` is called: the caller drops the local bytes there.
 * Stops at the first failure; what is left waits for the next run. Returns how many were moved.
 */
export async function migrateAttachments(files: FileStore, secret: Uint8Array, items: PendingAttachment[], moved: (key: string, bytes: Uint8Array, fileId: string) => boolean): Promise<number> {
  let count = 0;
  for (const { key, bytes } of items) {
    const fileId = await migrationId(secret, key, bytes);
    const name = key.slice(key.lastIndexOf("/") + 1) || "plik";
    try {
      await files.upload(new File([bytes as BlobPart], name, { type: mimeByName(name) }), { id: fileId });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
    const back = new Uint8Array(await (await files.read(fileId)).arrayBuffer());
    if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) throw new Error("Kontrola migracji załącznika nie przeszła.");
    if (moved(key, bytes, fileId)) count++;
  }
  return count;
}

/**
 * The layer a record holds, or null when it is not a valid layer of its parent: wrong kind, size over the limit, an
 * envelope that does not open, fields of the wrong type, or an id not derived from the original's key (a member could
 * otherwise place a layer of their own at any id and let it win by a higher extractor number). Shared with the MCP,
 * so every reader takes the same layers.
 */
export async function layerOfRecord(
  vaultId: string, rec: FileRecord, fileKey: string, resolve: (ref: MetaRef) => Promise<CryptoKey | null>,
): Promise<TextLayerInfo | null> {
  if (rec.kind !== "text" || !rec.parent || rec.size > cipherSize(TEXT_LAYER_MAX_GZIP)) return null;
  const meta = await openMeta(vaultId, rec.id, rec.meta, resolve).catch(() => null);
  if (!meta || meta.textOf !== rec.parent || meta.encoding !== "gzip") return null;
  if (!validLayerFields(meta) || rec.id !== await textLayerId(fileKey, rec.parent, meta.extractor)) return null;
  const { extractor, method, pages, quality, flags, engine } = meta;
  return { id: rec.id, textOf: rec.parent, createdAt: rec.createdAt, createdBy: rec.createdBy ?? null, extractor, method, pages, lang: "latin", quality, flags: [...flags], engine };
}

/** A layer's Markdown from its decrypted gzip: within 2 MB, UTF-8, and a layer of `originalId` by `extractor`; else
 *  `DamagedLayer`. Shared with the MCP. */
export async function layerText(zipped: Uint8Array<ArrayBuffer>, originalId: string, extractor: number): Promise<string> {
  try {
    const markdown = await inflateText(zipped);
    const doc = parseFileText(markdown);
    if (doc?.source !== originalId || doc.extractor !== extractor) throw new DamagedLayer("Tekst pliku jest uszkodzony.");
    return markdown;
  } catch (error) {
    throw error instanceof DamagedLayer ? error : new DamagedLayer(error instanceof Error && error.message === TOO_BIG ? TOO_BIG : "Tekst pliku jest uszkodzony.");
  }
}

/** The envelope fields of a text layer, as every reader checks them (docs/OCR.md §3.2). */
function validLayerFields<T extends Partial<TextLayerFields>>(f: T): f is T & TextLayerFields {
  const { extractor, method, pages, lang, quality, flags, engine } = f;
  return Number.isSafeInteger(extractor) && extractor! >= 1 && extractor! <= EXTRACTOR_VERSION
    && typeof method === "string" && METHODS.has(method) && Number.isSafeInteger(pages) && pages! >= 0 && pages! <= 100_000
    && lang === "latin" && typeof quality === "number" && quality >= 0 && quality <= 1
    && Array.isArray(flags) && flags.length <= 8 && flags.every((x) => typeof x === "string" && FLAGS.has(x))
    && typeof engine === "string" && engine.length <= 200;
}

/** The text of a layer's gzip, fed in small slices and read as it inflates, stopping at the 2 MB limit. */
async function inflateText(zipped: Uint8Array<ArrayBuffer>): Promise<string> {
  // fed in small slices and read as it inflates, stopping at the limit: a layer is written by any editor, so a small
  // gzip may hide a huge text, and a decoder given one big chunk inflates all of it before the first read
  let at = 0;
  const slices = new ReadableStream<BufferSource>({
    pull(controller) {
      if (at >= zipped.length) return controller.close();
      controller.enqueue(zipped.subarray(at, at += INFLATE_SLICE));
    },
  }, { highWaterMark: 0 });
  const reader = slices.pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > TEXT_LAYER_MAX_BYTES) {
      await reader.cancel();
      throw new Error(TOO_BIG);
    }
    parts.push(value);
  }
  const plain = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { plain.set(p, off); off += p.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}
