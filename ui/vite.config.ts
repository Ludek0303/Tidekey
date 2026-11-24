import { execFileSync } from "node:child_process";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { searchForWorkspaceRoot, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { licenceFiles, licenceModules } from "../scripts/licencje/collect.mjs";

// Serves the speech models from ../models in dev, as notes-node does in production (docs/DYKTOWANIE.md §5).
function voiceModelsDev(): Plugin {
  const dir = resolve(import.meta.dirname, "../models");
  const types: Record<string, string> = { ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8" };
  return {
    name: "voice-models-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/models/")) return next();
        let rel: string;
        try {
          rel = decodeURIComponent(url.slice("/models/".length).split("?")[0]);
        } catch {
          res.statusCode = 400;
          return res.end();
        }
        if (rel.split("/").includes("..")) {
          res.statusCode = 400;
          return res.end();
        }
        const file = join(dir, rel);
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
      });
    },
  };
}

// Serves the built preview frame (ui/dist/preview) under /preview/ with the frame's headers, as notes-node does
// (PODGLAD-PLAN §3.2). The CSP names this server's address, so it is built from the Host header of each request.
function previewFrameDev(): Plugin {
  const dir = resolve(import.meta.dirname, "dist/preview");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  return {
    name: "preview-frame-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/preview/")) return next();
        let rel: string;
        try {
          rel = decodeURIComponent(url.slice("/preview/".length).split("?")[0]) || "index.html";
        } catch {
          res.statusCode = 400;
          return res.end();
        }
        if (rel.split("/").includes("..")) {
          res.statusCode = 400;
          return res.end();
        }
        const file = join(dir, rel);
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        const host = req.headers.host;
        const origin = host && /^[A-Za-z0-9.:\[\]-]+$/.test(host) ? `http://${host}` : null;
        const scripts = origin ? `${origin}/preview/` : "'self'";
        res.setHeader(
          "Content-Security-Policy",
          `sandbox allow-scripts; default-src 'none'; script-src ${scripts} 'wasm-unsafe-eval'; worker-src blob:; ` +
            `style-src ${scripts} 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src blob: data:; ` +
            `connect-src blob:; frame-src 'none'; child-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
        );
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
      });
    },
  };
}

// Serves the preview's test files (fixtures/preview) at /__fixtures/ for the demo vault (demofixtures.ts, development only).
function demoFixturesDev(): Plugin {
  const dir = resolve(import.meta.dirname, "../fixtures/preview");
  return {
    name: "demo-fixtures-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__fixtures/")) return next();
        if (url.split("?")[0] === "/__fixtures/list.json") {
          // the README documents the files; it is not one of them
          const names = readdirSync(dir).filter((f) => f !== "README.md" && statSync(join(dir, f)).isFile());
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(JSON.stringify(names));
        }
        let rel: string;
        try {
          rel = decodeURIComponent(url.slice("/__fixtures/".length).split("?")[0]);
        } catch {
          res.statusCode = 400;
          return res.end();
        }
        if (rel.includes("/") || rel.includes("\\") || rel === ".." || rel === ".") {
          res.statusCode = 400;
          return res.end();
        }
        const file = join(dir, rel);
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
      });
    },
  };
}

// Where the source of this build is ("O programie", AGPL-3.0 §13): NOTES_COMMIT and NOTES_SOURCE_URL from the
// environment (the Docker build passes them), else the commit of the working copy; empty when neither is known.
function buildCommit(): string {
  if (process.env.NOTES_COMMIT) return process.env.NOTES_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  define: { __NOTES_COMMIT__: JSON.stringify(buildCommit()), __NOTES_SOURCE__: JSON.stringify(process.env.NOTES_SOURCE_URL ?? "") },
  plugins: [licenceModules("ui-app"), licenceFiles(), voiceModelsDev(), previewFrameDev(), demoFixturesDev()],
  // The worker imports onnxruntime-web, which is split into chunks; the iife format cannot load those.
  // the workers are built apart: their packages are recorded for the notices too (scripts/licencje/collect.mjs)
  worker: { format: "es", plugins: () => [licenceModules("ui-worker")] },
  // Pre-bundled on first use, these would reload the dev page mid-dictation; they are plain ESM already.
  optimizeDeps: { exclude: ["onnxruntime-web", "parakeet.js"] },
  server: {
    // Same headers notes-node sends: multi-threaded WASM needs cross-origin isolation.
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
    // the OCR models and their sums live in vendor/ (docs/OCR-PLAN.md): only that folder besides the workspace
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), resolve(import.meta.dirname, "../vendor/ocr-models")] },
  },
  build: { outDir: "dist", target: "es2022" },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "preview/src/**/*.test.ts"] },
});
