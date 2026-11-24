// Writes THIRD_PARTY_NOTICES.txt (repository root): the third-party components of every artifact we build, with
// their licences and copyrights, each licence text once. docs/LICENCJE.md describes the rules.
//   node scripts/licencje/generate.mjs           write the file
//   node scripts/licencje/generate.mjs --check   exit 1 when the file in the repository differs (CI)
// Inputs: Rust crates from `cargo tree -e normal` per artifact and target (Cargo.lock), npm packages from the builds
// (scripts/licencje/.cache/*.json, written by collect.mjs during `npm run build` in ui/ and mcp/), and the hand-kept
// part in manifest.json. The output is sorted and has no dates, so the same inputs give the same file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { choose, copyrights, detect, normalized } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = join(ROOT, "scripts/licencje");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.txt");
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const problems = [];

// ---- artifacts -------------------------------------------------------------------------------------------------
const ARTIFACTS = [
  { id: "web", title: "Strona webowa (ui/dist: aplikacja, ramka podglądu /preview/, workery; także interfejs aplikacji na komputer)",
    rust: [["-p", "notes-web", "wasm32-unknown-unknown"], ["-p", "notes-preview", "wasm32-unknown-unknown", "--no-default-features"], ["-p", "notes-preview", "wasm32-unknown-unknown"]],
    npm: ["ui-app", "ui-worker?", "ui-preview", "ui-preview-worker?"] },
  { id: "node", title: "Serwer notes-node (x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu)",
    rust: [["-p", "notes-node", "x86_64-unknown-linux-gnu"], ["-p", "notes-node", "aarch64-unknown-linux-gnu"]], npm: [] },
  { id: "docker", title: "Obraz Dockera (docker/Dockerfile): zawiera notes-node (sekcja 2) i stronę (sekcja 1), a do tego obraz bazowy", rust: [], npm: [] },
  { id: "desktop", title: "Aplikacja na komputer, Tauri (x86_64-unknown-linux-gnu, x86_64-pc-windows-msvc); interfejs to strona z sekcji 1",
    rust: [["--manifest-path", "app/src-tauri/Cargo.toml", "x86_64-unknown-linux-gnu"], ["--manifest-path", "app/src-tauri/Cargo.toml", "x86_64-pc-windows-msvc"]], npm: [] },
  { id: "mcp", title: "Serwer MCP (@notatki/mcp: dist/notatki-mcp.mjs, paczka .mcpb)",
    rust: [["-p", "notes-web", "wasm32-unknown-unknown"]], npm: ["mcp"] },
];

// ---- Rust ------------------------------------------------------------------------------------------------------
const cargo = (args) => execFileSync("cargo", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
const crateDirs = new Map(); // name@version -> folder of the crate's sources
for (const manifestPath of ["Cargo.toml", "app/src-tauri/Cargo.toml"]) {
  const meta = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1", "--manifest-path", manifestPath]));
  for (const p of meta.packages) if (p.source) crateDirs.set(`${p.name}@${p.version}`, { dir: dirname(p.manifest_path), pkg: p });
}

function rustCrates(spec) {
  const target = spec.find((a) => /-unknown-|-pc-/.test(a));
  const args = spec.filter((a) => a !== target);
  const out = cargo(["tree", "--locked", ...args, "--target", target, "-e", "normal", "--prefix", "none", "-f", "{p}"]);
  const found = [];
  for (const line of out.split("\n")) {
    // proc-macros run only while compiling: nothing of them is in the artifact
    const m = line.match(/^(\S+) v(\S+)( \((?!proc-macro)[^)]*\))?( \(proc-macro\))?/);
    if (!m || m[4]) continue;
    const key = `${m[1]}@${m[2]}`;
    if (crateDirs.has(key)) found.push(key); // our own crates (path) are not in crateDirs
  }
  return found;
}

// ---- reading licence files ---------------------------------------------------------------------------------------
const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|third[-_]party|patents)/i;
// LICENSE.spdx (an SPDX document some crates ship) is metadata, not a licence text
const listLicenceFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && LICENCE_FILE.test(e.name) && !e.name.endsWith(".spdx")).map((e) => e.name).sort() : []);

// "cargo:<crate>@<version>/<path>", "npm:<package>/<path>" or a path in the repository
function resolveFile(ref) {
  if (ref.startsWith("cargo:")) {
    const [key, ...rest] = ref.slice(6).split("/");
    const crate = crateDirs.get(key);
    if (!crate) throw new Error(`${ref}: crate ${key} nie występuje w Cargo.lock`);
    return join(crate.dir, ...rest);
  }
  if (ref.startsWith("npm:")) {
    const parts = ref.slice(4).split("/");
    const n = parts[0].startsWith("@") ? 2 : 1;
    return join(ROOT, "ui/node_modules", ...parts.slice(0, n), ...parts.slice(n));
  }
  return join(ROOT, ref);
}
const npmVersion = (ref) => JSON.parse(readFileSync(resolveFile(`${ref}/package.json`), "utf8")).version;

// ---- licence texts, each once ------------------------------------------------------------------------------------
const texts = new Map(); // normalized hash -> { id, licence, from, text }
function textRef(text, licence, from) {
  const key = createHash("sha256").update(normalized(text) || text).digest("hex");
  if (!texts.has(key)) texts.set(key, { id: 0, licence, from, text: text.trim() });
  return key;
}

// One component: its licence (the first alternative of "A OR B" whose texts we have), its texts and copyright lines.
const NO_NOTICE = ["CC0-1.0", "Unlicense", "0BSD", "blessing"]; // no text needs to go along; the official one is added
function component({ name, version, expr, dir, authors, repository, source, override, note, changes, files, inlineText, copyright }) {
  let candidates = files ?? [];
  if (!files) {
    const own = listLicenceFiles(dir).map((f) => join(dir, f));
    const extra = override?.texts ? listLicenceFiles(join(HERE, override.texts)).map((f) => join(HERE, override.texts, f)) : [];
    candidates = [...own, ...extra];
  }
  const read = candidates.map((file) => {
    if (!existsSync(file)) throw new Error(`${name} ${version}: brak pliku ${file}`);
    const text = readFileSync(file, "utf8");
    return { file, base: file.split("/").pop(), text, found: detect(text) };
  });
  const official = (l) => join(HERE, "spdx", `${l}.txt`);
  const hasText = (l) =>
    files || inlineText || l.startsWith("LicenseRef-") ||
    read.some((r) => r.found.includes(l) || (l.startsWith("LGPL") && r.found.includes("LGPL"))) ||
    ((override?.canonical?.includes(l) || NO_NOTICE.includes(l)) && (l === "blessing" || existsSync(official(l))));
  const chosen = choose(expr, (alt) => alt.every(hasText));
  if (!chosen.every(hasText)) problems.push(`${name} ${version}: brak tekstu licencji ${chosen.join(" AND ")} (paczka bez pliku licencji; dopisz teksty w manifest.json overrides)`);
  // the chosen licence's files, notices, and files whose wording is not recognised (they may carry conditions)
  const pick = read
    .filter((r) => files || !r.found.length || /^notice|third/i.test(r.base) || r.found.some((l) => chosen.includes(l) || (l === "LGPL" && chosen.some((c) => c.startsWith("LGPL")))))
    .map((r) => ({ text: r.text, licence: r.found.join(" + ") || r.base, from: `${name} ${version}: ${r.base}` }));
  if (inlineText) pick.push({ text: inlineText, licence: chosen.join(" AND "), from: name });
  const covered = new Set(pick.flatMap((p) => detect(p.text)));
  for (const l of chosen)
    if (!covered.has(l) && !inlineText && !files && existsSync(official(l))) pick.push({ text: readFileSync(official(l), "utf8"), licence: l, from: `oficjalny tekst SPDX ${l}` });
  const lines = copyright ?? [...copyrights(pick.map((p) => p.text)), ...(override?.addCopyright ?? [])];
  return {
    name, version, expr, chosen,
    copyright: lines.length ? lines : authors?.length ? [`Autorzy: ${authors.join(", ")}`] : [`Prawa autorskie: autorzy projektu (paczka nie podaje nazwisk)${repository ? `, ${repository}` : ""}`],
    refs: [...new Set(pick.map((p) => textRef(p.text, p.licence, p.from)))],
    source: chosen.some((l) => /^(MPL|LGPL|CC-BY)/.test(l)) || source ? source : undefined,
    note, changes, override,
  };
}

function rustComponent(key) {
  const { dir, pkg } = crateDirs.get(key);
  return component({
    name: pkg.name, version: pkg.version, expr: pkg.license ?? "NOASSERTION", dir, authors: pkg.authors, repository: pkg.repository,
    source: chooseSource(pkg.license, pkg.repository && `${pkg.repository} (wersja ${pkg.version}, crates.io)`),
    override: manifest.overrides[key], note: manifest.notes[pkg.name],
  });
}
const chooseSource = (expr, src) => (/MPL|LGPL/.test(expr ?? "") ? src ?? "(brak adresu w metadanych)" : undefined);

function npmComponent(rel) {
  const dir = join(ROOT, rel);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const expr = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "NOASSERTION");
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  return component({
    name: pkg.name, version: pkg.version, expr: expr.replace(/^\((.*)\)$/, "$1"), dir, authors: author ? [author] : [], repository: repo?.replace(/^git\+/, "").replace(/\.git$/, ""),
    source: chooseSource(expr, repo && `${repo.replace(/^git\+/, "").replace(/\.git$/, "")} (wersja ${pkg.version}, npm)`),
    override: manifest.overrides[`${pkg.name}@${pkg.version}`], note: manifest.notes[pkg.name],
  });
}

function extraComponent(e) {
  const version = e.version.startsWith("npm:") ? npmVersion(e.version) : e.version;
  return component({
    name: e.name, version, expr: e.license, files: (e.files ?? []).map(resolveFile), inlineText: e.text,
    source: e.source, note: e.note, changes: e.changes, copyright: e.copyright,
  });
}

// LGPL libraries shipped as separate, unchanged files (vendor/lgpl/MANIFEST.json): the SHA-256 of each file is
// checked, so a different file than the one described fails the generation.
function lgplComponents() {
  const base = join(ROOT, "vendor/lgpl");
  const list = JSON.parse(readFileSync(join(base, "MANIFEST.json"), "utf8"));
  return list.map((pkg) => {
    const dir = join(base, `${pkg.package}-${pkg.version}`);
    for (const [file, sha] of Object.entries(pkg.files)) {
      const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
      if (actual !== sha) problems.push(`${pkg.package}: SHA-256 pliku ${file} nie zgadza się z vendor/lgpl/MANIFEST.json`);
    }
    const c = component({ name: pkg.package, version: pkg.version, expr: pkg.license, files: [join(dir, "LICENSE")], source: pkg.source, copyright: pkg.copyright });
    c.note = [
      `Biblioteka upstream: ${pkg.upstream}.`,
      "Osobny, niezmieniony plik w ramce podglądu (/preview/assets/lgpl-*), wczytywany w czasie działania, nie wklejony do naszego kodu.",
      "Możesz go zastąpić własnym buildem tej samej wersji API: podmień pliki .js i .wasm w katalogu /preview/assets/ serwera.",
      "SHA-256 dołączonych plików: " + Object.entries(pkg.files).map(([f, s]) => `${f} ${s}`).join("; "),
    ].join(" ");
    return c;
  });
}

// ---- collecting ------------------------------------------------------------------------------------------------
const sections = [];
for (const art of ARTIFACTS) {
  const comps = new Map();
  const add = (c) => comps.set(`${c.name}@${c.version}`, c);
  for (const spec of art.rust) for (const key of rustCrates(spec)) if (!comps.has(key)) add(rustComponent(key));
  for (const entry of art.npm) {
    // "?": a build that has no workers writes no file for them
    const label = entry.replace(/\?$/, "");
    const file = join(HERE, ".cache", `${label}.json`);
    if (!existsSync(file) && entry.endsWith("?")) continue;
    if (!existsSync(file)) {
      problems.push(`brak danych budowania ${label} (scripts/licencje/.cache/${label}.json): najpierw \`npm run build\` w ${label.startsWith("mcp") ? "mcp/" : "ui/"}`);
      continue;
    }
    for (const rel of JSON.parse(readFileSync(file, "utf8"))) add(npmComponent(rel));
  }
  if (art.id === "web") for (const c of lgplComponents()) add(c);
  for (const e of manifest.extra) if (e.artifacts.includes(art.id)) add(extraComponent(e));
  sections.push({ ...art, comps: [...comps.values()].sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en")) });
}
if (problems.length) {
  console.error("Noty nie powstały:\n- " + problems.join("\n- "));
  process.exit(1);
}

// texts are numbered in the order they are first used
let n = 0;
for (const s of sections) for (const c of s.comps) for (const r of c.refs) if (!texts.get(r).id) texts.get(r).id = ++n;
const T = (r) => `[T${texts.get(r).id}]`;

// ---- writing ---------------------------------------------------------------------------------------------------
const RULE = "=".repeat(100);
const out = [];
out.push(
  "NOTATKI: LICENCJE SKŁADNIKÓW ZEWNĘTRZNYCH (THIRD_PARTY_NOTICES.txt)",
  "",
  "Notatki są na licencji GNU Affero General Public License w wersji 3 lub nowszej (plik LICENSE).",
  "Ten plik wymienia składniki innych autorów w każdym artefakcie, który budujemy: wersję, licencję, prawa autorskie",
  "i odwołanie do pełnego tekstu licencji (na końcu pliku, każdy tekst raz). Teksty licencji są przepisane bez zmian",
  "z paczek w używanych wersjach. Przy licencji „A OR B” podajemy, z której korzystamy. Przy składnikach zmienionych",
  "przy budowaniu jest opis zmian. Plik powstaje automatycznie: node scripts/licencje/generate.mjs (docs/LICENCJE.md).",
  "To nie jest porada prawna.",
  "",
);
sections.forEach((s, i) => out.push(`${i + 1}. ${s.title}: ${s.comps.length} składników`));
sections.forEach((s, i) => {
  out.push("", RULE, `${i + 1}. ${s.title}`, RULE, "");
  for (const c of s.comps) {
    const lic = c.chosen.join(" AND ");
    out.push(`* ${c.name} ${c.version}`);
    out.push(`  Licencja: ${c.expr === lic ? lic : `${c.expr} (korzystamy z: ${lic})`}`);
    for (const line of c.copyright) out.push(`  ${line}`);
    if (c.source) out.push(`  Źródła: ${c.source}`);
    if (c.override?.from) out.push(`  Tekst licencji z: ${c.override.from}`);
    if (c.changes) out.push(`  Zmiany: ${c.changes}`);
    if (c.note) out.push(`  Uwaga: ${c.note}`);
    out.push(`  Tekst: ${c.refs.map(T).join(", ")}`);
  }
});
out.push("", RULE, "TEKSTY LICENCJI I PLIKI NOTICE", RULE);
for (const t of [...texts.values()].sort((a, b) => a.id - b.id)) out.push("", `[T${t.id}] ${t.licence} (tekst z: ${t.from})`, "-".repeat(60), t.text);
const result = out.join("\n").replace(/[ \t]+$/gm, "") + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== result) {
    console.error("THIRD_PARTY_NOTICES.txt jest nieaktualny: uruchom node scripts/licencje/generate.mjs i dodaj plik do commita.");
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.txt aktualny.");
} else {
  writeFileSync(OUT, result);
  console.log(`THIRD_PARTY_NOTICES.txt: ${sections.map((s) => `${s.id} ${s.comps.length}`).join(", ")}; tekstów licencji: ${texts.size}`);
}
