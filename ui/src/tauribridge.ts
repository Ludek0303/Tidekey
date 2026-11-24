import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Bridge, MockBridge, makeBigMock } from "./bridge";
import { type FirstRunApi, type SpaceStatus, runFirstRun } from "./firstrun";
import type { SpaceItem } from "./spaces";
import { authenticateBrowser } from "./browserauth";
import { syncPreferences } from "./preferences";

// Commands whose result is bytes. Tauri sends Vec<u8> as a JSON array of numbers.
const BYTE_RESULTS = new Set(["open_note"]);

// Uint8Array arguments go out as number arrays, deep inside the argument object too.
export function toWire(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  }
  return value;
}

export function fromWire(cmd: string, value: unknown): unknown {
  // raw results come as an ArrayBuffer (see read_attachment in the app)
  if (cmd === "read_attachment") return new Uint8Array(value as ArrayBuffer);
  return BYTE_RESULTS.has(cmd) ? new Uint8Array(value as number[]) : value;
}

// The backend rejects with {kind, message}; the UI gets an Error with the same message and kind.
function toError(e: unknown): Error {
  if (e && typeof e === "object" && "message" in e) {
    return Object.assign(new Error(String((e as { message: unknown }).message)), {
      kind: (e as { kind?: unknown }).kind,
    });
  }
  return new Error(String(e));
}

// GitHub links exist only in the browser variant (the desktop has no commands for them yet).
const GITHUB_WEB_ONLY = new Set(["github_links", "github_save_link", "github_remove_link"]);

// shortcut: files in folders need a file store, which only the browser variant has; the desktop tree lists none.
const FOLDER_FILE_WEB_ONLY = /^folder_files?(_|$)/;

// Desktop app: commands go to the Rust backend over Tauri IPC.
export class TauriBridge implements Bridge {
  // The desktop app keeps its attachments in assets/ (attachments.ts), not in a file store.
  readonly files = null;

  async call<T>(cmd: string, args?: unknown): Promise<T> {
    if (GITHUB_WEB_ONLY.has(cmd)) throw new Error("Połączenie z GitHubem działa w wersji webowej.");
    if (FOLDER_FILE_WEB_ONLY.test(cmd)) throw new Error("Pliki w folderach są na razie w wersji przeglądarkowej.");
    try {
      if (cmd === "save_attachment") return await saveAttachment<T>(args as { name: string; bytes: Uint8Array });
      const result = await invoke<unknown>(cmd, toWire(args ?? {}) as Record<string, unknown>);
      return fromWire(cmd, result) as T;
    } catch (e) {
      throw toError(e);
    }
  }

  on(event: string, cb: (payload: unknown) => void): () => void {
    let stop: (() => void) | undefined;
    let closed = false;
    void listen<unknown>(event, (e) => cb(reviveEvent(e.payload))).then((unlisten) => {
      if (closed) unlisten();
      else stop = unlisten;
    });
    return () => {
      if (closed) return;
      closed = true;
      stop?.();
    };
  }
}

// The file's bytes go as the raw request body; its name travels percent-encoded in a header, since a raw body
// cannot carry JSON arguments.
function saveAttachment<T>(args: { name: string; bytes: Uint8Array }): Promise<T> {
  return invoke<T>("save_attachment", args.bytes, {
    headers: { "x-file-name": encodeURIComponent(args.name) },
  });
}

// Event payloads with bytes arrive as number arrays, like command results.
function reviveEvent(payload: unknown): unknown {
  if (payload && typeof payload === "object" && Array.isArray((payload as { update?: unknown }).update)) {
    return { ...payload, update: new Uint8Array((payload as { update: number[] }).update) };
  }
  return payload;
}

/** The window smoke check (`scripts/smoke-app.sh`): reports whether the WASM module loaded; the app then exits.
 * Outside that check `smoke_mode` is false and nothing happens. */
export async function reportSmoke(wasmLoaded: boolean): Promise<void> {
  if (!(await invoke<boolean>("smoke_mode"))) return;
  await invoke("smoke_report", { ok: wasmLoaded, detail: wasmLoaded ? "wasm loaded" : "wasm did not load" });
}

export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** The bridge of this run: the Rust backend in the desktop app (after the first-run screen), the mock otherwise. */
export async function chooseBridge(big: number): Promise<Bridge> {
  if (big > 0) return makeBigMock(big);
  // App integration tests run in jsdom without account forms or IndexedDB. The
  // production browser build remains authenticated; tests use the in-memory bridge.
  if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test") return new MockBridge();
  if (!inTauri()) {
    if (new URLSearchParams(location.search).get("demo") === "1") return new MockBridge();
    const bridge = await authenticateBrowser(document.getElementById("app")!);
    await syncPreferences(bridge.user, bridge.personalKey);
    return bridge;
  }
  const bridge = new TauriBridge();
  await runFirstRun(document.getElementById("app")!, tauriFirstRun(bridge));
  return bridge;
}

// The first-run screen's calls: the space commands of the Rust backend. The folder dialog runs in the backend,
// which then accepts only the folder it returned.
export function tauriFirstRun(bridge: Bridge): FirstRunApi {
  return {
    status: () => bridge.call<SpaceStatus>("space_status"),
    spaces: () => bridge.call<SpaceItem[]>("list_spaces"),
    openKnown: (path) => bridge.call<SpaceStatus>("open_known_space", { path }),
    forget: (path) => bridge.call<void>("forget_space", { path }),
    pickFolder: () => bridge.call<string | null>("pick_folder"),
    create: (path, name) => bridge.call<string[]>("create_space", { path, name }),
    setKind: (kind) => bridge.call<string>("set_space_kind", { kind }).then(() => undefined),
    open: (path) => bridge.call<string[] | null>("open_space", { path }),
    recover: (path, words) => bridge.call<void>("recover_space", { path, words }),
    confirm: () => bridge.call<void>("confirm_phrase"),
  };
}
