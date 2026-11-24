import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { initFormula } from "./formula";

// Node has no fetch for file: URLs, so the real formula/calendar wasm is loaded through a stubbed fetch.
export async function loadWasm(): Promise<void> {
  const bytes = readFileSync(resolve(__dirname, "wasm/notes_web_bg.wasm"));
  vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }));
  await initFormula();
  vi.unstubAllGlobals();
}
