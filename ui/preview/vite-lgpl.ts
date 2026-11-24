// Copies the LGPL libraries from vendor/lgpl into the frame's assets, byte for byte (PODGLAD-PLAN §4, §5). Each file's
// SHA-256 must match MANIFEST.json, so an edited file fails the build instead of shipping under the LGPL name.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { LIBRARIES, lgplPublishedName } from "./src/lgpl";

interface ManifestEntry {
  package: string;
  version: string;
  files: Record<string, string>;
}

export interface LgplEmitter {
  emitFile(file: { type: "asset"; fileName: string; source: Uint8Array }): unknown;
  error(message: string): never;
}

export function emitLgpl(ctx: LgplEmitter, root: string): void {
  const manifest = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8")) as ManifestEntry[];
  // the frame names its scripts from LIBRARIES: a version bumped in one place only would load nothing
  for (const [lib, { pkg, version }] of Object.entries(LIBRARIES)) {
    if (!manifest.some((e) => e.package === pkg && e.version === version)) {
      ctx.error(`lgpl: ${lib} (${pkg} ${version}) nie ma wpisu w MANIFEST.json`);
    }
  }
  for (const entry of manifest) {
    for (const [file, sha] of Object.entries(entry.files)) {
      const source = readFileSync(join(root, `${entry.package}-${entry.version}`, file));
      if (createHash("sha256").update(source).digest("hex") !== sha) {
        ctx.error(`lgpl: ${entry.package}-${entry.version}/${file} nie zgadza się z MANIFEST.json (SHA-256)`);
      }
      ctx.emitFile({ type: "asset", fileName: `assets/${lgplPublishedName(entry.package, entry.version, file)}`, source });
    }
  }
}

export function lgplLibraries(root = resolve(import.meta.dirname, "../../vendor/lgpl")): Plugin {
  return {
    name: "lgpl-libraries",
    generateBundle() {
      emitLgpl(this, root);
    },
  };
}
