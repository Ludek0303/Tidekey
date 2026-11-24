// The text of files for a chat (docs/OCR.md §5.2–§5.4): which files of a vault the chat may see, and their text
// layers, fetched, decrypted and checked in memory like a reader in the app does (remotefiles.ts layerOfRecord,
// layerText). Nothing goes to disk; the cache goes with the session's keys (`wipe`).
import { openFile, openMeta, scopeOf, type FileMeta, type MetaRef } from "../../ui/src/filecrypto";
import { FILE_EMBED } from "../../ui/src/filestore";
import { TEXT_LAYER_MAX_GZIP, layerOfRecord, layerText, type FileRecord } from "../../ui/src/remotefiles";
import { cipherSize } from "../../ui/src/filecrypto";
import type { AgentClient } from "./client";
import { pathKey, within, type NoteView, type VaultView } from "./session";

/** A file the chat may see, with its text when it has a valid layer. */
export interface VisibleFile {
  id: string;
  name: string;
  mime: string;
  /** The notes in the chat's scope that embed the file. */
  embeddedIn: string[];
  /** The layer's Markdown (notes-filetext-v1), or null: no layer yet, or one that did not read. */
  markdown: string | null;
}

export interface FileTexts {
  files: VisibleFile[];
  /** Layers the chat may read and how many of them are in `files` with text (for "Indeks plików: 140 z 380"). */
  layers: number;
  read: number;
}

const MAX_RECORDS = 200_000;
/** Decrypted text kept per vault at most (characters): many small gzip bombs must not exhaust the chat's memory. */
export const MAX_TEXT_CHARS = 64 * 1024 * 1024;
// Failures of one layer that leave the rest of the pass going; anything else (a lost session, a pause, the operator
// switch, a bad proof, an old version) stops it and goes up, so the session wipes what it holds.
const SKIP = new Set(["scope", "gone", "other"]);
const HEX32 = /^[0-9a-f]{32}$/;

/** The ids of the files a note embeds (`![[plik:<id>…]]`). */
export function embedsOf(text: string): string[] {
  return [...text.matchAll(new RegExp(FILE_EMBED.source, "g"))].map((m) => m[1]).filter((id): id is string => typeof id === "string");
}

/**
 * The rule of OCR §5.2: a file is visible when the chat has the key of its envelope (`opened`) and a note in its scope
 * embeds it, or no note of the vault embeds it and its project lies in the scope. `allNotes` holds every note the
 * chat can decrypt plus the ids embedded by notes in the trash; `projectInScope` must fail closed (see
 * `projectWholeInScope`), because a note the chat cannot decrypt (a locked protected project) may embed the file.
 */
export function fileVisible(
  id: string, meta: Pick<FileMeta, "project">, allNotes: Map<string, string[]>, visibleNotes: Map<string, string[]>, projectInScope: (project: string | null) => boolean,
): boolean {
  if ((visibleNotes.get(id)?.length ?? 0) > 0) return true;
  return (allNotes.get(id)?.length ?? 0) === 0 && projectInScope(meta.project ?? null);
}

/**
 * For a file embedded nowhere: its project (a folder, or null for the vault root) lies in the scope as a whole (no
 * exclusion inside it), and the vault has no locked protected project. A note the chat cannot decrypt may embed any
 * file of the vault, whatever its `project` (an embed can be copied into another project), so with a locked project
 * "embedded nowhere" cannot be known and the file stays hidden (fails closed).
 */
export function projectWholeInScope(view: Pick<VaultView, "scope" | "locked">, visible: (path: string) => boolean, project: string | null): boolean {
  if (view.locked.length > 0) return false;
  if (project === null) return view.scope.include.length === 0 && view.scope.exclude.length === 0;
  const inside = (path: string) => within(path, project) || pathKey(path) === pathKey(project);
  return visible(project) && !view.scope.exclude.some(inside);
}

/** Who embeds which file, among `notes`. */
export function embedMap(notes: NoteView[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of notes) {
    for (const id of new Set(embedsOf(n.text))) {
      const list = map.get(id);
      if (list) list.push(n.id);
      else map.set(id, [n.id]);
    }
  }
  return map;
}

async function resolver(view: VaultView): Promise<(ref: MetaRef) => Promise<CryptoKey | null>> {
  const scoped = new Map<string, CryptoKey>();
  for (const p of view.projects) scoped.set(`${await scopeOf(view.id, p.path)}\0${p.entry.keyEpoch}`, p.key);
  return async (ref) => ("keyEpoch" in ref ? view.keys.get(ref.keyEpoch) ?? null : scoped.get(`${ref.scope}\0${ref.projectEpoch}`) ?? null);
}

const isRecord = (r: unknown): r is FileRecord => {
  const x = r as Partial<FileRecord> | null;
  return !!x && typeof x.id === "string" && HEX32.test(x.id) && typeof x.meta === "string" && typeof x.size === "number" && typeof x.state === "string"
    && x.deletedAt == null;
};

/**
 * The files of `view` the chat may see, with the text of their layers. `cache` keeps decrypted layers by layer id
 * across refreshes (each is fetched once; the server allows one full pass per 5 minutes). `onProgress` gets
 * (read, layers) as layers come in.
 */
export async function loadFileTexts(
  view: VaultView & { fileText?: boolean },
  client: Pick<AgentClient, "request" | "requestBytes">,
  visible: (path: string) => boolean,
  cache: Map<string, string>,
  onProgress?: (read: number, layers: number) => void,
  /** False once the session dropped this vault (wipe, forget, narrower scope; drop() clears `cache`) or the pass went
   *  stale: it stops and keeps nothing. */
  alive: () => boolean = () => true,
): Promise<FileTexts> {
  if (!view.fileText) return { files: [], layers: 0, read: 0 };
  const base = `/api/agent/vaults/${encodeURIComponent(view.id)}/files`;
  const answer = await client.request<{ files?: unknown }>("GET", base);
  const records = Array.isArray(answer.files) ? answer.files.slice(0, MAX_RECORDS).filter(isRecord) : [];
  const resolve = await resolver(view);

  // originals the chat can open
  const originals = new Map<string, { rec: FileRecord; meta: FileMeta }>();
  for (const rec of records) {
    if (rec.parent || rec.kind || rec.state !== "ready") continue;
    const meta = await openMeta(view.id, rec.id, rec.meta, resolve).catch(() => null);
    if (meta && !meta.textOf && !meta.thumbOf) originals.set(rec.id, { rec, meta });
  }
  const all = embedMap(view.notes);
  for (const id of view.trashedEmbeds ?? []) if (!all.has(id)) all.set(id, ["(kosz)"]);
  const seen = embedMap(view.notes.filter((n) => visible(n.path)));
  const shown = [...originals.values()].filter(({ rec, meta }) => fileVisible(rec.id, meta, all, seen, (p) => projectWholeInScope(view, visible, p)));
  const shownIds = new Set(shown.map((o) => o.rec.id));

  // the newest valid layer of each shown file
  const layers = new Map<string, { rec: FileRecord; extractor: number; key: string; size: number }>();
  for (const rec of records) {
    if (rec.kind !== "text" || rec.state !== "ready" || !rec.parent || !shownIds.has(rec.parent)) continue;
    const original = originals.get(rec.parent);
    if (!original) continue;
    const layer = await layerOfRecord(view.id, rec, original.meta.key, resolve);
    if (!layer) continue;
    const meta = await openMeta(view.id, rec.id, rec.meta, resolve).catch(() => null);
    if (!meta || rec.size !== cipherSize(meta.size) || meta.size > TEXT_LAYER_MAX_GZIP) continue;
    const known = layers.get(rec.parent);
    if (!known || known.extractor < layer.extractor) layers.set(rec.parent, { rec, extractor: layer.extractor, key: meta.key, size: meta.size });
  }

  // only the layers chosen now stay cached: texts of files that are no longer visible go
  const chosen = new Set([...layers.values()].map((l) => l.rec.id));
  for (const id of [...cache.keys()]) if (!chosen.has(id)) cache.delete(id);

  let read = 0;
  let chars = 0;
  const texts = new Map<string, string>();
  for (const [originalId, layer] of layers) {
    if (!alive()) return { files: [], layers: 0, read: 0 };
    let markdown = cache.get(layer.rec.id) ?? null;
    if (markdown === null) {
      try {
        const cipher = await client.requestBytes(`${base}/${layer.rec.id}/content`, layer.rec.size);
        const plain = await collect(openFile(once(cipher), layer.key, view.id, layer.rec.id, layer.rec.scope, layer.size));
        markdown = await layerText(plain, originalId, layer.extractor);
      } catch (e) {
        const kind = (e as { kind?: unknown }).kind;
        // a limit stops the pass (the rest comes at the next refresh); a failure of the chat goes up; a layer that
        // does not read is left out
        if (kind === "limit") break;
        if (typeof kind === "string" && !SKIP.has(kind)) throw e;
        continue;
      }
      if (!alive()) return { files: [], layers: 0, read: 0 };
    }
    // the whole vault's text stays within a budget; past it the pass stops as at a limit
    if (chars + markdown.length > MAX_TEXT_CHARS) break;
    chars += markdown.length;
    cache.set(layer.rec.id, markdown);
    texts.set(originalId, markdown);
    read++;
    onProgress?.(read, layers.size);
  }
  return {
    files: shown.map(({ rec, meta }) => ({
      id: rec.id, name: meta.name, mime: meta.mime, embeddedIn: seen.get(rec.id) ?? [], markdown: texts.get(rec.id) ?? null,
    })),
    layers: layers.size,
    read,
  };
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

async function collect(parts: AsyncIterable<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const list: Uint8Array[] = [];
  let total = 0;
  for await (const p of parts) {
    total += p.length;
    if (total > TEXT_LAYER_MAX_GZIP) throw new Error("za duży");
    list.push(p);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of list) { out.set(p, at); at += p.length; }
  return out;
}
