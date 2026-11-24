// crates/preview in the frame (PODGLAD-PLAN §4.5): wasm-bindgen glue from the build, the .wasm bytes from the app (the
// frame has no fetch). Two modules: the small one (video keyframes, .doc, .ppt) and the DWG one (acadrust). A panic in
// WASM ends the call with a RuntimeError; the frame is thrown away after each file, so no instance is ever reused.
import coreWasmUrl from "../wasm/notes_preview_bg.wasm?url";
import dwgWasmUrl from "../wasm-dwg/notes_preview_dwg_bg.wasm?url";
import type * as Core from "../wasm/notes_preview";
import type * as Dwg from "../wasm-dwg/notes_preview_dwg";

export type PreviewWasm = typeof Core;
export type DwgWasm = typeof Dwg;
type Asset = (path: string) => Promise<ArrayBuffer>;

const ASSET_PREFIX = "/preview/";

let core: Promise<PreviewWasm> | null = null;
let dwg: Promise<DwgWasm> | null = null;

/** The module without DWG, loaded once per frame. */
export function previewWasm(asset: Asset): Promise<PreviewWasm> {
  core ??= load(import("../wasm/notes_preview"), coreWasmUrl, asset).catch((err: unknown) => {
    core = null;
    throw err;
  });
  return core;
}

/** The module with DWG → DXF, loaded once per frame. */
export function dwgWasm(asset: Asset): Promise<DwgWasm> {
  dwg ??= load(import("../wasm-dwg/notes_preview_dwg"), dwgWasmUrl, asset).catch((err: unknown) => {
    dwg = null;
    throw err;
  });
  return dwg;
}

/** "/preview/assets/x.wasm" becomes "assets/x.wasm", the path the app is asked for. */
export function assetPathOf(url: string): string {
  if (!url.startsWith(ASSET_PREFIX) || url.length === ASSET_PREFIX.length) throw new Error(`Not a preview asset URL: ${url}`);
  return url.slice(ASSET_PREFIX.length);
}

async function load<T extends { default(init: { module_or_path: ArrayBuffer }): Promise<unknown> }>(glue: Promise<T>, wasmUrl: string, asset: Asset): Promise<T> {
  const [module, bytes] = await Promise.all([glue, asset(assetPathOf(wasmUrl))]);
  await module.default({ module_or_path: bytes });
  return module;
}
