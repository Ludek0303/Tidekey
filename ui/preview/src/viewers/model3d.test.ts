// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { libraryFor, loadLibrary } from "../model3dlibs";
import { checkTriangles, MAX_TRIANGLES } from "./model3d";
import { PreviewError } from "./index";
import { o3dvOffline } from "../../vite-o3dv";

const ENGINE_PATH = new URL("../../../node_modules/online-3d-viewer/build/engine/o3dv.module.js", import.meta.url);
const ENGINE_ID = "/project/node_modules/online-3d-viewer/build/engine/o3dv.module.js";

type Transform = (this: { error(message: string): never }, code: string, id: string) => string | null;

// The plugin's transform hook, called the way Vite calls it: this.error throws the build error.
function transform(code: string, id: string): string | null {
  const hook = o3dvOffline().transform as unknown as Transform;
  return hook.call({ error: (message) => { throw new Error(message); } }, code, id);
}

// Stands in for ctx.asset with the real wasm files of the packages.
const WASM_FILES: Record<string, string> = {
  "assets/web-ifc.wasm": "web-ifc/web-ifc.wasm",
  "assets/draco_decoder.wasm": "draco3d/draco_decoder.wasm",
};
const asset = async (path: string): Promise<ArrayBuffer> => {
  const bytes = readFileSync(new URL(`../../../node_modules/${WASM_FILES[path]}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

describe("o3dvOffline: Online3DViewer without the network", () => {
  it("replaces the CDN loaders and the STEP worker in the real o3dv build", () => {
    const code = readFileSync(ENGINE_PATH, "utf8");
    const out = transform(code, ENGINE_ID);
    expect(out).not.toBeNull();
    expect(out).toContain("globalThis.__podgladLib");
    expect(out).not.toContain("cdn.jsdelivr.net");
    expect(out).not.toContain("fetch (");
    expect(out).not.toContain("fetch(");
    // the original file has CRLF line endings; the replaced bodies keep them
    expect(out).toContain("\r\n");
  });

  it("ignores other files", () => {
    expect(transform("function LoadExternalLibrary (libraryName)\n{\n}", "/project/src/other.js")).toBeNull();
  });

  it("fails the build when the loader is not where the plugin expects it (another o3dv version)", () => {
    expect(() => transform("const nothing = 1;\n", ENGINE_ID)).toThrow(/LoadExternalLibrary/);
  });
});

describe("loadLibrary: the libraries the viewer asks for", () => {
  it("returns a promise and sets the globals o3dv calls (DracoDecoderModule, WebIFC)", async () => {
    const done = loadLibrary("webifc", asset);
    expect(done).toBeInstanceOf(Promise);
    await done;
    const g = globalThis as unknown as Record<string, unknown>;
    const ifc = g.WebIFC as { IfcAPI?: unknown };
    expect(typeof ifc.IfcAPI).toBe("function");

    await loadLibrary("draco3d", asset);
    expect(typeof g.DracoDecoderModule).toBe("function");
  });

  it("rejects a library it does not know, rhino3dm included (it would need eval)", async () => {
    await expect(loadLibrary("occt", asset)).rejects.toThrow(/occt/);
    await expect(loadLibrary("rhino3dm", asset)).rejects.toThrow(/rhino3dm/);
  });

  it("names the library a file needs before it is handed to the engine", () => {
    expect(libraryFor("bryla.3DM")).toBeNull();
    expect(libraryFor("dom.ifc")).toBe("webifc");
    expect(libraryFor("model.glb")).toBeNull();
  });
});

describe("checkTriangles: the limits of a loaded model", () => {
  it("accepts a model with geometry up to the limit", () => {
    expect(() => checkTriangles(1)).not.toThrow();
    expect(() => checkTriangles(MAX_TRIANGLES)).not.toThrow();
  });

  it("a model without geometry is corrupt", () => {
    expect(() => checkTriangles(0)).toThrow(PreviewError);
    expect(() => checkTriangles(0)).toThrow(/corrupt/);
  });

  it("more triangles than the limit is too large", () => {
    expect(() => checkTriangles(MAX_TRIANGLES + 1)).toThrow(/too-large/);
  });
});
