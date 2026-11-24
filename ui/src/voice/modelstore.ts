// Speech model files in OPFS (docs/DYKTOWANIE.md §5). Each file lives under voice-models/<model id>/, so a new model
// version is a new directory and an old one is pruned, never overwritten in place.
import { modelUrl, DEFAULT_ASR, VAD_MODEL, type AsrModel, type ModelFile } from "./models";
import { Sha256 } from "./sha256";
import { VoiceError, type Variant } from "./types";

export interface Entry {
  id: string;
  file: ModelFile;
}

const TOP = "voice-models";
const HASH_CHUNK = 8 * 1024 * 1024;

export const vadEntry: Entry = { id: VAD_MODEL.id, file: VAD_MODEL.file };

// Encoder, decoder, vocab: the order the engine's URLs are read in.
export function filesFor(model: AsrModel, variant: Variant): ModelFile[] {
  return [variant === "gpu" ? model.files.encoderGpu : model.files.encoderCpu, model.files.decoder, model.files.vocab];
}

export const asrEntries = (variant: Variant): Entry[] => filesFor(DEFAULT_ASR, variant).map((file) => ({ id: DEFAULT_ASR.id, file }));

// fp16 needs shader-f16 on WebGPU (docs/DYKTOWANIE.md §3); without it the int8 encoder runs on WASM, slower.
export async function pickVariant(): Promise<{ variant: Variant; warn?: "no-webgpu" }> {
  const adapter = (await navigator.gpu?.requestAdapter().catch(() => null)) ?? null;
  if (adapter?.features.has("shader-f16")) return { variant: "gpu" };
  return { variant: "cpu", warn: "no-webgpu" };
}

// Null when the directory does not exist and create is false (or there is no OPFS at all).
async function topDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(TOP, { create });
  } catch (err) {
    if (create) throw err;
    return null;
  }
}

async function idDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const top = await topDir(create);
  if (!top) return null;
  try {
    return await top.getDirectoryHandle(id, { create });
  } catch (err) {
    if (create) throw err;
    return null;
  }
}

// Ready = the .sha256 mark holds the expected sum and the file has the expected size (the mark is written last).
async function isReady({ id, file }: Entry): Promise<boolean> {
  const dir = await idDir(id, false);
  if (!dir) return false;
  try {
    const mark = await (await dir.getFileHandle(`${file.name}.sha256`)).getFile();
    if ((await mark.text()) !== file.sha256) return false;
    return (await (await dir.getFileHandle(file.name)).getFile()).size === file.size;
  } catch {
    return false;
  }
}

export async function missing(entries: Entry[]): Promise<Entry[]> {
  const ready = await Promise.all(entries.map(isReady));
  return entries.filter((_, i) => !ready[i]);
}

export async function fileUrl(id: string, file: ModelFile): Promise<string> {
  const dir = await idDir(id, false);
  if (!dir) throw new VoiceError("model", `brak pliku ${file.name}`);
  return URL.createObjectURL(await (await dir.getFileHandle(file.name)).getFile());
}

export async function usage(): Promise<number> {
  const top = await topDir(false);
  if (!top) return 0;
  let total = 0;
  for await (const dir of top.values()) {
    if (dir.kind !== "directory") continue;
    for await (const f of (dir as FileSystemDirectoryHandle).values()) {
      if (f.kind === "file") total += (await (f as FileSystemFileHandle).getFile()).size;
    }
  }
  return total;
}

export async function removeAll(): Promise<void> {
  const top = await topDir(false);
  if (top) await (await navigator.storage.getDirectory()).removeEntry(TOP, { recursive: true });
}

export async function pruneOld(keep: string[]): Promise<void> {
  const top = await topDir(false);
  if (!top) return;
  const names: string[] = [];
  for await (const name of top.keys()) names.push(name);
  for (const name of names) if (!keep.includes(name)) await top.removeEntry(name, { recursive: true });
}

// What resumeDownload needs from storage: a sync access handle in the worker, a plain array in tests.
export interface ByteStore {
  size(): number;
  read(offset: number, length: number): Uint8Array;
  write(offset: number, chunk: Uint8Array): void;
  truncate(n: number): void;
  flush(): void;
}

const isAbort = (err: unknown): boolean => (err as Error)?.name === "AbortError";

// Appends the rest of the file to what the store already holds (a Range request), then checks size and SHA-256.
// The store keeps the bytes after an abort, so the next call resumes from them.
export async function resumeDownload(
  fetchFn: typeof fetch,
  store: ByteStore,
  file: ModelFile,
  url: string,
  onBytes: (n: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (store.size() > file.size) store.truncate(0);
  let hasher = new Sha256();
  let size = store.size();
  for (let off = 0; off < size; off += HASH_CHUNK) hasher.update(store.read(off, Math.min(HASH_CHUNK, size - off)));
  onBytes(size);
  try {
    if (size < file.size) {
      // OPFS is the cache; an HTTP-cached copy could hand back the same bad bytes after a checksum failure.
      const res = await fetchFn(url, { headers: size ? { Range: `bytes=${size}-` } : {}, signal, cache: "no-store" });
      if (res.status === 200) {
        store.truncate(0);
        hasher = new Sha256();
        size = 0;
      } else if (res.status !== 206) {
        throw new VoiceError("download", `HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new VoiceError("download", "brak treści odpowiedzi");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        store.write(size, value);
        hasher.update(value);
        size += value.length;
        onBytes(value.length);
      }
    }
    if (size !== file.size || hasher.digestHex() !== file.sha256) {
      store.truncate(0);
      throw new VoiceError("checksum");
    }
  } catch (err) {
    if (isAbort(err) || err instanceof VoiceError) throw err;
    if ((err as Error)?.name === "QuotaExceededError") throw new VoiceError("storage", String(err));
    throw new VoiceError("download", String(err));
  } finally {
    store.flush();
  }
}

// Worker only: the sync access handle is the one way to write OPFS from a worker without buffering 1 GB in memory.
export async function downloadToOpfs(id: string, file: ModelFile, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  const dir = (await idDir(id, true))!;
  await dir.removeEntry(`${file.name}.sha256`).catch(() => {});
  const access = await (await dir.getFileHandle(file.name, { create: true })).createSyncAccessHandle();
  try {
    const store: ByteStore = {
      size: () => access.getSize(),
      read: (offset, length) => {
        const buf = new Uint8Array(length);
        access.read(buf, { at: offset });
        return buf;
      },
      write: (offset, chunk) => void access.write(chunk, { at: offset }),
      truncate: (n) => access.truncate(n),
      flush: () => access.flush(),
    };
    await resumeDownload(fetch, store, file, modelUrl(id, file), onBytes, signal);
  } finally {
    access.close();
  }
  const mark = await (await dir.getFileHandle(`${file.name}.sha256`, { create: true })).createWritable();
  await mark.write(file.sha256);
  await mark.close();
}
