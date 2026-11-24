// OCR engine check in Chromium (OCR-PLAN §2, §4.2). Builds scripts/ocr-engine with the app's vite, serves it with the
// notes-node headers (COOP/COEP, crates/node/src/http.rs), and runs three configurations:
//   1. Chromium with WebGPU flags: text must be right; a WebGPU that fails its checks must be banned
//   2. Chromium without flags: expects wasm/wasm
//   3. the WebGPU flags with a test-only fault: the first WebGPU run of a page throws (if the GPU is used at all)
// Run: PLAYWRIGHT_PATH=/path/to/playwright node scripts/test-ocr-engine.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "ui");
const FIXTURES = path.join(ROOT, "fixtures", "ocr");
const PAGE = path.join(ROOT, "scripts", "ocr-engine");
const ENGINE = path.join(UI, "src", "ocr", "engine.ts");
const GPU_FLAGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=native",
  "--use-angle=vulkan",
  "--ignore-gpu-blocklist",
];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".mjs": "text/javascript" };

// Levenshtein over characters, whitespace collapsed on both sides (as in fixtures.test.ts).
function cer(ref, hyp) {
  const a = [...ref.split(/\s+/).filter(Boolean).join(" ")];
  const b = [...hyp.split(/\s+/).filter(Boolean).join(" ")];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

async function buildPage() {
  const vite = await import(pathToFileURL(require.resolve("vite", { paths: [UI] })).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-engine-"));
  await vite.build({
    root: PAGE,
    configFile: false,
    logLevel: "warn",
    resolve: { alias: [{ find: "@engine", replacement: ENGINE }] },
    worker: { format: "es" },
    build: { outDir, emptyOutDir: true, target: "es2022" },
  });
  return outDir;
}

// The app's server headers for its own files (notes-node http.rs): COOP and COEP make the page cross-origin isolated.
function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let file;
    if (url.startsWith("/fixtures/ocr/")) {
      const name = path.basename(url);
      file = path.join(FIXTURES, name);
      if (name !== url.slice("/fixtures/ocr/".length) || !fs.existsSync(file)) return res.writeHead(404).end();
    } else {
      file = path.join(dir, url === "/" ? "index.html" : url.slice(1));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function runConfig(label, args, fault, origin) {
  const browser = await chromium.launch({ headless: true, args, executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const urls = new Set();
    page.on("request", (r) => urls.add(r.url()));
    await page.goto(`${origin}/${fault ? "?fault=1" : ""}`);
    await page.waitForFunction(() => typeof window.ocrRun === "function");
    const names = ["skan-czysty.png", "zdjecie-bez-tekstu.png"];
    const result = await page.evaluate(
      (n) => window.ocrRun(n),
      names,
    );
    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    const [clean, photo] = result.pages;
    const expected = fs.readFileSync(path.join(FIXTURES, "skan-czysty.png.expected.txt"), "utf8");
    const text = clean.lines.join("\n");
    const c = cer(expected, text);
    const m = result.measured;
    const foreign = [...urls].filter((u) => !u.startsWith(origin));
    const fp32 = [...urls].filter((u) => /fp32/.test(u));
    console.log(`\n== ${label}`);
    console.log(`navigator.gpu: ${result.gpu}`);
    console.log(`provider (measured): det ${m?.det} / rec ${m?.rec}, msPerPage ${m?.msPerPage}, adapter "${m?.adapter}"`);
    console.log(`skan-czysty: provider ${JSON.stringify(clean.provider)}, ms ${Math.round(clean.ms)}, fellBack ${clean.fellBack}, lines ${clean.lines.length}, CER ${c.toFixed(4)}`);
    console.log(`zdjecie-bez-tekstu: noText ${photo.noText}, lines ${photo.lines.length}, provider ${JSON.stringify(photo.provider)}, fellBack ${photo.fellBack}`);
    console.log(`requested URLs (${urls.size}): ${[...urls].map((u) => u.replace(origin, "")).join(", ")}`);
    console.log(`fp32 model requests: ${fp32.length ? fp32.map((u) => u.replace(origin, "")).join(", ") : "none"}`);
    assert.deepEqual(foreign, [], `requests outside the test server: ${foreign.join(", ")}`);
    assert.ok(clean.lines.length > 0, "no text from skan-czysty");
    assert.ok(c < 0.1, `CER too high: ${c}`);
    assert.equal(photo.lines.length, 0, "text found in the photo without text");
    return { clean, photo, m, fp32 };
  } finally {
    await browser.close();
  }
}

(async () => {
  const dir = await buildPage();
  const server = await serve(dir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // WebGPU may or may not pass the reference check on a given GPU (fp16 models need shader-f16, OCR-PLAN §2 E); the
    // text must be right either way, and a rejected WebGPU must be stored as banned.
    const gpu = await runConfig("Chromium, WebGPU flags", GPU_FLAGS, false, origin);
    if (gpu.m.det === "webgpu" || gpu.m.rec === "webgpu") console.log("WebGPU passed the reference check on this GPU");
    else assert.equal(gpu.m.gpuBanned, true, "WebGPU failed its checks but the ban is not stored");
    const plain = await runConfig("Chromium, no flags", [], false, origin);
    assert.deepEqual([plain.m.det, plain.m.rec], ["wasm", "wasm"]);
    assert.deepEqual(plain.fp32, [], "a CPU-only device must not download the fp32 pair");
    // the injected loss fires on the first WebGPU run of a page; without one it is not consumed
    const lost = await runConfig("WebGPU flags, injected device loss", GPU_FLAGS, true, origin);
    console.log(lost.clean.fellBack ? "injected loss: fell back on a page" : "injected loss: no WebGPU run in the page, not consumed");
    console.log("\nall configurations passed");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
