// Build-time changes to Online3DViewer 0.18.0 for the preview frame (PODGLAD-PLAN §5): its library loader and its STEP
// worker fetch from a CDN, which the frame may not do. The loader calls the frame's __podgladLib (model3dlibs.ts)
// instead, the STEP worker is refused, and the wasm files are copied into assets/ (their licences: THIRD_PARTY_NOTICES.txt).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { LIBRARY_WASM } from "./src/model3dlibs";

const MODULES = resolve(import.meta.dirname, "../node_modules");
const ENGINE = /[\\/]online-3d-viewer[\\/]build[\\/]engine[\\/]o3dv\.module\.js$/;

// The whole functions, from the header to the closing brace in column 0. The file has CRLF line endings.
const LOADER = /function LoadExternalLibrary \(libraryName\)\r?\n\{\r?\n[\s\S]*?\r?\n\}/;
const STEP = /function CreateOcctWorker \(worker\)\r?\n\{\r?\n[\s\S]*?\r?\n\}/;

const COPIES: [fileName: string, from: string][] = [
  [LIBRARY_WASM.webifc, "web-ifc/web-ifc.wasm"],
  [LIBRARY_WASM.draco3d, "draco3d/draco_decoder.wasm"],
];

export function o3dvOffline(): Plugin {
  return {
    name: "o3dv-offline",
    transform(code, id) {
      if (!ENGINE.test(id.split("?")[0])) return null;
      // another version of the library: failing the build is better than shipping the request
      if (!LOADER.test(code) || !STEP.test(code)) {
        this.error("Online3DViewer: LoadExternalLibrary or CreateOcctWorker not found, check vite-o3dv.ts");
      }
      const eol = code.includes("\r\n") ? "\r\n" : "\n";
      const loader = `function LoadExternalLibrary (libraryName)${eol}{${eol}\treturn globalThis.__podgladLib (libraryName);${eol}}`;
      const step = `function CreateOcctWorker (worker)${eol}{${eol}\treturn Promise.reject (new Error ('STEP, IGES and BREP are not available in the preview frame'));${eol}}`;
      return code.replace(LOADER, loader).replace(STEP, step);
    },
    generateBundle(_options, bundle) {
      // the wasm files are only shipped when the engine is in the frame (the viewer is registered in viewers/index.ts)
      const used = Object.values(bundle).some((chunk) => chunk.type === "chunk" && chunk.code.includes("__podgladLib"));
      if (!used) return;
      for (const [fileName, from] of COPIES) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(resolve(MODULES, from)) });
      }
    },
  };
}
