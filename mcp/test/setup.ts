import { readFileSync } from "node:fs";
import { initSync } from "../../ui/src/wasm/notes_web.js";

// the core's task parser, as main.ts loads it from the bundle
initSync({ module: readFileSync(new URL("../../ui/src/wasm/notes_web_bg.wasm", import.meta.url)) });
