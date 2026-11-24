// Copies the pdf.js data the frame may ask for (CMaps, standard fonts, wasm, ICC profiles) into the frame's assets.
// The names are the ones assetPathFor maps to, so the frame finds each file by its URL (PODGLAD-PLAN §2).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { assetPathFor, PDFJS_DATA_URLS } from "./src/pdfdata";

const PDFJS = resolve(import.meta.dirname, "../node_modules/pdfjs-dist");

// folder in pdfjs-dist, and the data URL it is served under
const FOLDERS: [string, keyof typeof PDFJS_DATA_URLS][] = [
  ["cmaps", "cMapUrl"],
  ["standard_fonts", "standardFontDataUrl"],
  ["wasm", "wasmUrl"],
  ["iccs", "iccUrl"],
];

// wasm/ also holds JavaScript fallbacks, which the frame never loads, and QuickJS, which only runs scripts inside PDFs
// (off in the preview): neither is copied. The Liberation fonts are GPL-2.0 (with a font exception), which the project
// does not ship (docs/LICENCJE.md); the frame renders with useSystemFonts, so pdf.js uses the system's fonts instead.
const wanted = (folder: string, file: string): boolean =>
  folder === "standard_fonts"
    ? !/liberation/i.test(file)
    : folder !== "wasm" || (file.endsWith(".wasm") && !file.startsWith("quickjs")) || (file.startsWith("LICENSE_") && !file.includes("QUICKJS"));

export function pdfjsData(): Plugin {
  return {
    name: "pdfjs-data",
    generateBundle() {
      for (const [folder, key] of FOLDERS) {
        const dir = join(PDFJS, folder);
        for (const file of readdirSync(dir)) {
          if (!wanted(folder, file)) continue;
          const fileName = assetPathFor(`${PDFJS_DATA_URLS[key]}${file}`);
          if (!fileName) this.error(`pdf.js: nazwa ${file} nie pasuje do zasobów podglądu`);
          this.emitFile({ type: "asset", fileName, source: readFileSync(join(dir, file)) });
        }
      }
    },
  };
}
