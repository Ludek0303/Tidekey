#!/usr/bin/env node
// Pobiera modele mowy do katalogu models/ (serwowanego przez notes-node jako /models/<id>/<plik>).
// Źródła i sumy są w ui/src/voice/models.ts; ta lista jest jedynym miejscem, z którego czytamy URL-e.
//
// Użycie: node scripts/fetch-voice-models.mjs [--out DIR] [--model ID|all ...] [--variant gpu|cpu|q4 ...] [--only-vad] [--from URL|DIR]
//         node scripts/fetch-voice-models.mjs --self-test
// --from: URL serwera Notatki (np. https://notatki.example.pl/models) albo lokalny katalog <dir>/<id>/<plik>.
//         Bez --from pliki idą z Hugging Face/GitHub. Można też ustawić zmienną VOICE_MODELS_FROM.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VARIANT_FIELD = { gpu: "encoderGpu", cpu: "encoderCpu", q4: "encoderQ4" };

function upstreamUrl(src) {
  return src.github
    ? `https://raw.githubusercontent.com/${src.repo}/${src.rev}/${src.path}`
    : `https://huggingface.co/${src.repo}/resolve/${src.rev}/${src.path}`;
}

async function sha256File(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// Downloads to `${dest}.part` (resumable), verifies size and SHA-256, then renames into place.
// On a bad checksum the partial file is removed, so nothing unverified stays under the final name.
export async function fetchFile(url, dest, { size, sha256 }, onProgress = () => {}) {
  const part = `${dest}.part`;
  let offset = existsSync(part) ? statSync(part).size : 0;
  if (offset > size) {
    rmSync(part); // larger than the real file: it cannot be a prefix of it
    offset = 0;
  }

  if (offset < size) {
    const res = await fetch(url, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {});
    if (!res.ok) throw new Error(`HTTP ${res.status} przy pobieraniu ${url}`);
    // A server that ignores Range answers 200 with the whole file: start over instead of appending it to the prefix.
    if (res.status !== 206) offset = 0;
    if (!res.body) throw new Error(`Pusta odpowiedź z ${url}`);

    let received = offset;
    let mark = Math.floor((offset * 100) / size / 5) * 5 + 5;
    const progress = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        const pct = Math.floor((received * 100) / size);
        if (pct >= mark) {
          onProgress(pct, received);
          mark = Math.floor(pct / 5) * 5 + 5;
        }
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body),
      progress,
      createWriteStream(part, { flags: offset > 0 ? "a" : "w" }),
    );
  }

  await verifyAndInstall(dest, { size, sha256 });
}

// Shared tail of every source: `${dest}.part` must match size and SHA-256, then it is renamed to dest.
async function verifyAndInstall(dest, { size, sha256 }) {
  const part = `${dest}.part`;
  const got = statSync(part).size;
  if (got !== size) {
    rmSync(part);
    throw new Error(`Zły rozmiar ${dest}: oczekiwano ${size} B, otrzymano ${got} B`);
  }
  const hash = await sha256File(part);
  if (hash !== sha256) {
    rmSync(part);
    throw new Error(`Zła suma SHA-256 dla ${dest}: oczekiwana ${sha256}, otrzymana ${hash}`);
  }
  renameSync(part, dest);
}

// Local source (--from DIR): copies the file to `${dest}.part` (always from scratch), then verifies it like a download.
export async function copyLocal(src, dest, { size, sha256 }) {
  if (!existsSync(src)) throw new Error(`Brak pliku źródłowego: ${src}`);
  copyFileSync(src, `${dest}.part`);
  await verifyAndInstall(dest, { size, sha256 });
}

// Where one file is read from: upstream when `from` is empty, an http(s) base URL serving /<id>/<name>,
// or a local directory laid out as <dir>/<id>/<name>.
export function sourceFor(from, id, file) {
  if (!from) return { url: upstreamUrl(file.source) };
  if (/^https?:\/\//i.test(from)) return { url: `${from.replace(/\/+$/, "")}/${id}/${file.name}` };
  return { path: join(resolve(from), id, file.name) };
}

function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

function parseArgs(argv) {
  const opts = {
    out: join(ROOT, "models"),
    from: (process.env.VOICE_MODELS_FROM ?? "").trim() || null,
    models: [],
    variants: [],
    onlyVad: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Brak wartości po ${a}`);
      return argv[++i];
    };
    if (a === "--out") opts.out = resolve(next());
    else if (a === "--from") {
      opts.from = next().trim();
      if (!opts.from) throw new Error("Pusta wartość po --from");
    }
    else if (a === "--model") opts.models.push(next());
    else if (a === "--variant") opts.variants.push(next());
    else if (a === "--only-vad") opts.onlyVad = true;
    else if (a === "--self-test") opts.selfTest = true;
    else throw new Error(`Nieznana opcja: ${a}`);
  }
  return opts;
}

// The file list for the run: VAD always, then per ASR model the decoder, the vocab and the chosen encoders.
function planFiles(opts, { VAD_MODEL, ASR_MODELS, DEFAULT_ASR }) {
  const plan = [{ id: VAD_MODEL.id, file: VAD_MODEL.file }];
  if (opts.onlyVad) return plan;

  const variants = opts.variants.length ? opts.variants : ["gpu", "cpu"];
  for (const v of variants) {
    if (!(v in VARIANT_FIELD)) throw new Error(`Nieznany wariant: ${v} (dozwolone: gpu, cpu, q4)`);
  }
  let models;
  if (opts.models.includes("all")) models = ASR_MODELS;
  else if (opts.models.length) {
    models = opts.models.map((id) => {
      const m = ASR_MODELS.find((x) => x.id === id);
      if (!m) throw new Error(`Nieznany model: ${id}`);
      return m;
    });
  } else models = [DEFAULT_ASR];

  for (const m of models) {
    const picked = [m.files.decoder, m.files.vocab];
    for (const v of variants) {
      const f = m.files[VARIANT_FIELD[v]];
      if (!f) throw new Error(`Model ${m.id} nie ma pliku dla wariantu ${v}`);
      picked.push(f);
    }
    for (const file of picked) plan.push({ id: m.id, file });
  }
  // Same file requested twice (e.g. --model X --model X): fetch once.
  return [...new Map(plan.map((p) => [`${p.id}/${p.file.name}`, p])).values()];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) return selfTest();

  const models = await import(pathToFileURL(join(ROOT, "ui/src/voice/models.ts")).href);
  const plan = planFiles(opts, models);
  console.log(`Źródło: ${opts.from ?? "Hugging Face / GitHub (models.ts)"}`);

  for (const { id, file } of plan) {
    const dir = join(opts.out, id);
    const dest = join(dir, file.name);
    const label = `${id}/${file.name}`;
    mkdirSync(dir, { recursive: true });

    // Size first: a wrong size rules the file out without hashing 1 GB.
    if (existsSync(dest) && statSync(dest).size === file.size && (await sha256File(dest)) === file.sha256) {
      console.log(`${label}: ok (już jest)`);
      continue;
    }
    const src = sourceFor(opts.from, id, file);
    console.log(`${label}: ${src.path ? "kopiuję" : "pobieram"} (${mb(file.size)} MB)`);
    if (src.path) {
      await copyLocal(src.path, dest, file);
    } else {
      await fetchFile(src.url, dest, file, (pct, received) => {
        console.error(`  ${pct}% (${mb(received)} z ${mb(file.size)} MB)`);
      });
    }
    console.log(`${label}: gotowe`);
  }

  console.log(`Łącznie w ${opts.out}: ${mb(dirBytes(opts.out))} MB`);
}

async function selfTest() {
  const size = 3 << 20;
  const body = randomBytes(size);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const seenRanges = [];
  const server = createServer((req, res) => {
    const range = req.headers.range;
    seenRanges.push(range ?? null);
    const ignoreRange = req.url.includes("norange");
    const m = !ignoreRange && range && /^bytes=(\d+)-$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, { "Content-Length": size - start, "Content-Range": `bytes ${start}-${size - 1}/${size}` });
      res.end(body.subarray(start));
    } else {
      res.writeHead(200, { "Content-Length": size });
      res.end(body);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "fetch-voice-"));
  const exp = { size, sha256 };

  try {
    // 0. sourceFor: an HTTP base (trailing slashes trimmed) gives a URL, a directory gives <dir>/<id>/<name>.
    assert.equal(sourceFor("http://h/models//", "ID", { name: "name.onnx" }).url, "http://h/models/ID/name.onnx");
    assert.equal(sourceFor(dir, "ID", { name: "name.onnx" }).path, join(resolve(dir), "ID", "name.onnx"));

    // 1. Fresh download from zero.
    const a = join(dir, "a.onnx");
    await fetchFile(`${base}/f`, a, exp);
    assert.deepEqual(readFileSync(a), body);
    assert.equal(existsSync(`${a}.part`), false);
    assert.equal(seenRanges.at(-1), null);

    // 2. Resume from an existing .part.
    const b = join(dir, "b.onnx");
    const half = body.subarray(0, 1 << 20);
    writeFileSync(`${b}.part`, half);
    await fetchFile(`${base}/f`, b, exp);
    assert.deepEqual(readFileSync(b), body);
    assert.equal(seenRanges.at(-1), `bytes=${1 << 20}-`);

    // 2b. Server ignores Range (200): the prefix must be discarded, not appended to.
    const c = join(dir, "c.onnx");
    writeFileSync(`${c}.part`, half);
    await fetchFile(`${base}/f?norange`, c, exp);
    assert.deepEqual(readFileSync(c), body);

    // 3. Wrong checksum: error, and neither the final file nor the .part stays on disk.
    const d = join(dir, "d.onnx");
    await assert.rejects(fetchFile(`${base}/f`, d, { size, sha256: "0".repeat(64) }), /Zła suma SHA-256/);
    assert.equal(existsSync(d), false);
    assert.equal(existsSync(`${d}.part`), false);

    // 4. Local directory source: a correct copy is byte-identical and leaves no .part behind.
    const id = "model-x";
    const file = { name: "m.onnx", size, sha256 };
    const srcDir = join(dir, "models");
    mkdirSync(join(srcDir, id), { recursive: true });
    writeFileSync(join(srcDir, id, file.name), body);
    const outDir = join(dir, "out", id);
    mkdirSync(outDir, { recursive: true });
    const e = join(outDir, file.name);
    await copyLocal(sourceFor(srcDir, id, file).path, e, file);
    assert.deepEqual(readFileSync(e), body);
    assert.equal(existsSync(`${e}.part`), false);

    // 4b. Missing local source: error naming the path.
    await assert.rejects(copyLocal(join(srcDir, id, "nope.onnx"), join(outDir, "nope.onnx"), file), /Brak pliku źródłowego/);

    // 5. Local copy with a wrong checksum: error, and neither the final file nor the .part stays on disk.
    const f = join(outDir, "bad.onnx");
    await assert.rejects(copyLocal(join(srcDir, id, file.name), f, { size, sha256: "0".repeat(64) }), /Zła suma SHA-256/);
    assert.equal(existsSync(f), false);
    assert.equal(existsSync(`${f}.part`), false);

    console.log("self-test: OK (pobranie, wznowienie, odrzucenie złej sumy, źródło lokalne)");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`Błąd: ${e.message}`);
  process.exit(1);
});
