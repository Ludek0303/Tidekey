// Local release bundle (docs/MCP.md §10, §17). No network: run after `npm run build`.
// Output: mcp/release/ with notatki-mcp.mjs, notatki-mcp-<version>.mcpb, sbom.cdx.json, SHA256SUMS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dist = join(root, "dist", "notatki-mcp.mjs");
const manifestPath = join(root, "mcpb", "manifest.json");
const out = join(root, "release");

if (!existsSync(dist)) throw new Error("Brak dist/notatki-mcp.mjs: najpierw `npm run build`");
if (JSON.parse(readFileSync(manifestPath, "utf8")).version !== version) throw new Error(`mcpb/manifest.json: wersja inna niż package.json (${version})`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(dist, join(out, "notatki-mcp.mjs"));
const licences = ["LICENSE", "THIRD_PARTY_NOTICES.txt"].map((name) => [name, join(root, "dist", name)]);
for (const [name, path] of licences) copyFileSync(path, join(out, name));
writeFileSync(join(out, "sbom.cdx.json"), execFileSync("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit=dev"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }));

// .mcpb is a zip with manifest.json at the root and the server under server/.
const stage = mkdtempSync(join(tmpdir(), "notatki-mcpb-"));
try {
  mkdirSync(join(stage, "server"));
  copyFileSync(dist, join(stage, "server", "notatki-mcp.mjs"));
  copyFileSync(manifestPath, join(stage, "manifest.json"));
  for (const [name, path] of licences) copyFileSync(path, join(stage, "server", name));
  const mcpb = join(out, `notatki-mcp-${version}.mcpb`);
  try {
    execFileSync("zip", ["-X", "-q", "-r", mcpb, "manifest.json", "server"], { cwd: stage, stdio: "inherit" });
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`Nie udało się zbudować .mcpb (zip): ${err.message}`);
    // no zip on this machine: Python's zipfile makes the same archive
    execFileSync("python3", ["-m", "zipfile", "-c", mcpb, "manifest.json", "server"], { cwd: stage, stdio: "inherit" });
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const lines = readdirSync(out).sort().map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`);
writeFileSync(join(out, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(`Wydanie ${version} w ${out}:\n${lines.join("\n")}`);
