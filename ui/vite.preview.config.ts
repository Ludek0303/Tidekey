import { resolve } from "node:path";
import { defineConfig } from "vite";
import { pptxOffline } from "./preview/vite-offline";
import { pdfjsData } from "./preview/vite-pdfjs";
import { o3dvOffline } from "./preview/vite-o3dv";
import { lgplLibraries } from "./preview/vite-lgpl";
import { licenceModules } from "../scripts/licencje/collect.mjs";

// The preview frame is built apart from the app: its own root, base and output (PODGLAD-PLAN §3.1).
export default defineConfig({
  root: resolve(import.meta.dirname, "preview"),
  base: "/preview/",
  plugins: [pptxOffline(), pdfjsData(), o3dvOffline(), lgplLibraries(), licenceModules("ui-preview")],
  worker: { plugins: () => [licenceModules("ui-preview-worker")] },
  build: {
    outDir: resolve(import.meta.dirname, "dist/preview"),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    // The polyfill uses fetch, which the frame is not allowed to call.
    modulePreload: { polyfill: false },
    // the second document: the extractor frame (ui/src/ocr/extracthost.ts), same server headers as the preview
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "preview/index.html"),
        extract: resolve(import.meta.dirname, "preview/extract.html"),
      },
    },
  },
});
