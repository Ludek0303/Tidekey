// One file: dist/notatki-mcp.mjs. ui/src is bundled in; the core's WASM (task parser) is embedded as base64 (build it
// first: `npm run wasm` in ui/). @napi-rs/keyring stays external (native module).
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { licenceModules } from "../scripts/licencje/collect.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const wasm = {
  name: "notes-wasm",
  resolveId: (id) => (id === "virtual:notes-wasm" ? "\0notes-wasm" : null),
  load: (id) => (id === "\0notes-wasm" ? `export default ${JSON.stringify(readFileSync(here("../ui/src/wasm/notes_web_bg.wasm")).toString("base64"))};` : null),
};
// Vite's `?worker&url` imports (dictation, reached through ui/src/settings.ts) mean nothing here: the MCP never starts them.
const viteUrls = {
  name: "vite-worker-urls",
  resolveId: (id) => (id.endsWith("?worker&url") ? `\0vite-url:${id}` : null),
  load: (id) => (id.startsWith("\0vite-url:") ? 'export default "";' : null),
};
await build({
  input: here("./src/main.ts"),
  platform: "node",
  external: ["@napi-rs/keyring"],
  plugins: [wasm, viteUrls, licenceModules("mcp")],
  resolve: {
    alias: { yjs: here("./node_modules/yjs"), "libsodium-wrappers": here("./node_modules/libsodium-wrappers") }, // one copy for ui/src too
    modules: [here("./node_modules"), here("../ui/node_modules"), "node_modules"],
  },
  output: { file: here("./dist/notatki-mcp.mjs"), format: "esm", // libsodium's loader reads __dirname/__filename/require, which an ES module does not have
    banner: [
      "#!/usr/bin/env node",
      'import { createRequire as __mcpRequire } from "node:module"; import { fileURLToPath as __mcpPath } from "node:url";',
      "const require = __mcpRequire(import.meta.url); const __filename = __mcpPath(import.meta.url); const __dirname = __mcpPath(new URL('.', import.meta.url));",
    ].join("\n"), codeSplitting: false },
});
// The licence and the notices of the bundled components go with the package (docs/LICENCJE.md).
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) copyFileSync(here(`../${name}`), here(`./dist/${name}`));
