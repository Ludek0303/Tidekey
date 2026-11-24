// The libraries of the 3D viewer (PODGLAD-PLAN §5). The frame has no network, so Online3DViewer's CDN loads are
// replaced at build time (vite-o3dv.ts) by calls of globalThis.__podgladLib. Each library's code comes from this build,
// and its .wasm is the app's asset of the same name, read through ctx.asset.

/** The wasm file each library needs, as the app serves it (vite-o3dv.ts copies the files there). */
// No rhino3dm: its glue needs eval, which the frame's CSP never allows, so .3dm files get the download card (D11).
export const LIBRARY_WASM = {
  webifc: "assets/web-ifc.wasm",
  draco3d: "assets/draco_decoder.wasm",
} as const;

export type LibraryName = keyof typeof LIBRARY_WASM;

type Asset = (path: string) => Promise<ArrayBuffer>;
type Factory = (options: object) => Promise<unknown>;

interface Globals {
  DracoDecoderModule?: Factory;
  WebIFC?: unknown;
  __podgladLib?: (name: string) => Promise<void>;
}

// Loaded libraries, per frame. A failed load is forgotten, so the next file tries again.
const loaded = new Map<LibraryName, Promise<void>>();

function isLibrary(name: string): name is LibraryName {
  return Object.hasOwn(LIBRARY_WASM, name);
}

/** The library a file needs before the engine sees it, when the extension says so (draco is only known inside glTF). */
export function libraryFor(fileName: string): LibraryName | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "ifc") return "webifc";
  return null;
}

async function install(name: LibraryName, asset: Asset): Promise<void> {
  const wasm = await asset(LIBRARY_WASM[name]);
  const g = globalThis as unknown as Globals;
  if (name === "draco3d") {
    // draco3d ships no typings; its decoder glue is a plain factory function
    // @ts-expect-error draco3d has no declaration file
    const mod: { default: Factory } = await import("draco3d/draco_decoder_nodejs.js");
    g.DracoDecoderModule = (options) => mod.default({ ...options, wasmBinary: wasm });
  } else {
    const mod = await import("web-ifc");
    class SingleThreadIfcAPI extends mod.IfcAPI {
      // The multi-threaded build starts workers from this module's URL, which the frame may not do. The single-thread
      // build reads the wasm through a blob: URL, which is revoked once the module is instantiated.
      override async Init(): Promise<void> {
        const url = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
        try {
          await super.Init(() => url, true);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    }
    g.WebIFC = { ...mod, IfcAPI: SingleThreadIfcAPI };
  }
}

/** Loads one library into the frame's globals, once. Unknown names are rejected. */
export function loadLibrary(name: string, asset: Asset): Promise<void> {
  if (!isLibrary(name)) return Promise.reject(new Error(`Nieznana biblioteka: ${name}`));
  let done = loaded.get(name);
  if (!done) {
    done = install(name, asset);
    loaded.set(name, done);
    done.catch(() => loaded.delete(name));
  }
  return done;
}

/** Sets the function Online3DViewer calls for its libraries; `asset` is the current file session's. */
export function installPodgladLib(asset: Asset): void {
  (globalThis as unknown as Globals).__podgladLib = (name) => loadLibrary(name, asset);
}
