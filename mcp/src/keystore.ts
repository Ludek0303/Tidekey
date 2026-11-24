// The chat's secrets on disk (docs/MCP.md §5.1): the system keyring, service "notatki-mcp", account = the server's
// origin (one chat per origin). Only the chat's own keys and its session token; never vault keys or notes.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToBase64, base64ToBytes } from "../../ui/src/vaults";

export interface ChatSecrets {
  serverUrl: string; agentId: string; signKey: string; boxKey: string;
  signSecret: Uint8Array; boxSecret: Uint8Array; token: Uint8Array;
}
export interface KeyStore { load(origin: string): Promise<Uint8Array | null>; save(origin: string, blob: Uint8Array): Promise<void>; remove(origin: string): Promise<boolean> }

export const SERVICE = "notatki-mcp";
export const FILE_WARNING = "Klucze czatu w pliku zamiast w pęku kluczy systemu.";
const SIZES = [64, 32, 32] as const; // signSecret, boxSecret, token

/** Binary form: u16 header length, header JSON (public fields), then the secret bytes. Secrets never become strings. */
export function encodeSecrets(s: ChatSecrets): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, serverUrl: s.serverUrl, agentId: s.agentId, signKey: s.signKey, boxKey: s.boxKey }));
  const parts = [s.signSecret, s.boxSecret, s.token];
  parts.forEach((p, i) => { if (p.length !== SIZES[i]) throw new Error("Nieprawidłowe klucze czatu."); });
  const out = new Uint8Array(2 + header.length + 128);
  out[0] = header.length >> 8; out[1] = header.length & 0xff;
  out.set(header, 2);
  let at = 2 + header.length;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function decodeSecrets(blob: Uint8Array): ChatSecrets {
  const len = (blob[0] << 8) | blob[1];
  if (blob.length !== 2 + len + 128) throw new Error("Zapis kluczy czatu jest uszkodzony.");
  const h = JSON.parse(new TextDecoder().decode(blob.subarray(2, 2 + len))) as Omit<ChatSecrets, "signSecret" | "boxSecret" | "token"> & { v: number };
  if (h.v !== 1) throw new Error("Zapis kluczy czatu jest uszkodzony.");
  let at = 2 + len;
  const take = (n: number) => blob.slice(at, (at += n));
  return { serverUrl: h.serverUrl, agentId: h.agentId, signKey: h.signKey, boxKey: h.boxKey, signSecret: take(64), boxSecret: take(32), token: take(32) };
}

// For tests and machines without a keyring: one JSON file, 0600, origin → base64 of the binary form.
function fileStore(path: string): KeyStore {
  const read = (): Record<string, string> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, string> : {});
  const write = (all: Record<string, string>) => { writeFileSync(path, JSON.stringify(all), { mode: 0o600 }); chmodSync(path, 0o600); };
  return {
    load: async (origin) => { const v = read()[origin]; return v ? base64ToBytes(v) : null; },
    save: async (origin, blob) => { const all = read(); all[origin] = bytesToBase64(blob); write(all); },
    remove: async (origin) => { const all = read(); const had = origin in all; delete all[origin]; write(all); return had; },
  };
}

function keyringStore(): KeyStore {
  // native module, loaded only when used (kept out of the bundle: rolldown external)
  const entry = async (origin: string) => new (await import("@napi-rs/keyring")).Entry(SERVICE, origin);
  return {
    load: async (origin) => { const v = (await entry(origin)).getSecret(); return v ? Uint8Array.from(v) : null; },
    save: async (origin, blob) => (await entry(origin)).setSecret(blob),
    remove: async (origin) => { try { return (await entry(origin)).deletePassword(); } catch { return false; } },
  };
}

export function openKeyStore(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = (m) => process.stderr.write(`${m}\n`)): KeyStore {
  const file = env.NOTES_MCP_KEYSTORE_FILE;
  if (file) { warn(FILE_WARNING); return fileStore(file); }
  return keyringStore();
}
