// Build plugins for the notices (docs/LICENCJE.md "Jak powstają noty"). They work in Vite and rolldown alike.
// - licenceModules(label): records which npm packages really ended up in a bundle (modules with rendered code), as
//   package folders relative to the repository, in scripts/licencje/.cache/<label>.json. generate.mjs reads them.
//   A label collects across several bundles of one build (the workers of the app), so the first bundle of a build
//   starts the file anew.
// - licenceFiles(): puts LICENSE and THIRD_PARTY_NOTICES.txt from the repository root into the build's output.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = join(ROOT, "scripts/licencje/.cache");
const started = new Set(); // labels already started in this process

// The package folder of a module id inside node_modules (a nested copy has its own folder), or null.
export function packageDir(id) {
  const path = id.replace(/^\0/, "").split("?")[0];
  const i = path.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const rest = path.slice(i + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return path.slice(0, i + "node_modules/".length) + name;
}

export function licenceModules(label) {
  return {
    name: `licence-modules-${label}`,
    generateBundle(_options, bundle) {
      const file = join(CACHE, `${label}.json`);
      const dirs = new Set(started.has(label) && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
      started.add(label);
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, mod] of Object.entries(chunk.modules)) {
          const dir = mod.renderedLength > 0 ? packageDir(id) : null;
          if (dir && existsSync(join(dir, "package.json"))) dirs.add(relative(ROOT, dir));
        }
      }
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(file, JSON.stringify([...dirs].sort(), null, 1) + "\n");
    },
  };
}

export function licenceFiles() {
  return {
    name: "licence-files",
    generateBundle() {
      for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"])
        this.emitFile({ type: "asset", fileName: name, source: readFileSync(join(ROOT, name)) });
    },
  };
}
