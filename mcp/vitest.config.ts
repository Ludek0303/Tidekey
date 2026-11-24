import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
// ui/src imports these too: one copy for both sides (a second Yjs breaks documents, a second libsodium is waste).
export default defineConfig({
  resolve: { alias: { yjs: here("./node_modules/yjs"), "libsodium-wrappers": here("./node_modules/libsodium-wrappers") } },
  test: { environment: "node", testTimeout: 30_000, setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
});
