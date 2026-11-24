// OCR in the app, in Chromium, against the browser demo (?demo=1, memory store; no login, no account).
// Builds the app with its own vite (main bundle and the preview frame, which holds extract.html), serves it with the
// notes-node headers (COOP/COEP, crates/node/src/http.rs), and drives the Files tab:
//   1. uploads pdf-tekst.pdf, skan-czysty.png and zdjecie-bez-tekstu.png
//   2. waits for the badges "rozpoznany" and "brak tekstu"
//   3. opens the preview of pdf-tekst.pdf and reads its "Tekst" tab (normalized equal to the expected text)
//   4. the scan's text is close to its expected text (character error rate)
//   5. the "Bez tekstu" filter leaves only the photo without text
//   6. the "Szukaj" pane finds the files' text (no Polish letters typed, `w:pliki`, `typ:obraz`) and a hit opens the
//      preview's "Tekst" tab with the word marked
// Every request must go to this server (no CDN, no other host). Screenshots go to the directory in SHOTS.
// Run: PLAYWRIGHT_PATH=/path/to/playwright node scripts/test-ocr-demo.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const UI = path.join(ROOT, "ui");
const FIXTURES = path.join(ROOT, "fixtures", "ocr");
const SHOTS = process.env.SHOTS || path.join(require("node:os").tmpdir(), "ocr-shots");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

// Levenshtein over characters, whitespace collapsed on both sides (as in test-ocr-engine.cjs).
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
const normal = (s) => s.replace(/\s+/g, " ").trim();

function build(outDir) {
  const vite = path.join(UI, "node_modules", ".bin", "vite");
  execFileSync(vite, ["build", "--outDir", outDir, "--emptyOutDir"], { cwd: UI, stdio: "inherit" });
  execFileSync(vite, ["build", "-c", "vite.preview.config.ts", "--outDir", path.join(outDir, "preview"), "--emptyOutDir"], { cwd: UI, stdio: "inherit" });
}

// The app's own files, and the fixtures under /fixtures/ocr/ (only by their plain name).
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
    // the preview frame (and its extractor) is an opaque-origin document: its files are CORS and CORP "cross-origin"
    // (crates/node/src/http.rs preview_headers); everything else is the app's own
    const frame = url.startsWith("/preview/");
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": frame ? "cross-origin" : "same-origin",
      ...(frame ? { "access-control-allow-origin": "*" } : {}),
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-demo-"));
  build(dir);
  const server = await serve(dir);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const requested = new Set();
  page.on("pageerror", (e) => errors.push(e.message));
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  page.on("request", (r) => requested.add(r.url()));
  const files = (name) => path.join(FIXTURES, name);
  const row = (name) => page.locator("tr.files-row", { hasText: name });
  const badge = (name) => row(name).locator(".files-badge").filter({ hasNotText: "nieużywany" });
  const report = {};
  try {
    await page.goto(`${base}/?demo=1`);
    await page.locator(".org-nav details:not([open]) > summary").evaluateAll((s) => s.forEach((x) => x.click()));
    await page.locator(".org-nav").getByRole("button", { name: "Pliki", exact: true }).click();
    await page.locator(".files-page input[type=file]").setInputFiles([files("pdf-tekst.pdf"), files("skan-czysty.png"), files("zdjecie-bez-tekstu.png")]);
    await row("pdf-tekst.pdf").waitFor({ timeout: 60_000 });
    await badge("pdf-tekst.pdf").filter({ hasText: "rozpoznany" }).waitFor({ timeout: 120_000 });
    await badge("zdjecie-bez-tekstu.png").filter({ hasText: "brak tekstu" }).waitFor({ timeout: 180_000 });
    await badge("skan-czysty.png").filter({ hasText: "rozpoznany" }).waitFor({ timeout: 240_000 });
    await page.screenshot({ path: path.join(SHOTS, "pliki.png"), fullPage: true });
    report.badges = {
      "pdf-tekst.pdf": await badge("pdf-tekst.pdf").textContent(),
      "skan-czysty.png": await badge("skan-czysty.png").textContent(),
      "zdjecie-bez-tekstu.png": await badge("zdjecie-bez-tekstu.png").textContent(),
    };

    // the preview's text tab of the PDF
    await row("pdf-tekst.pdf").dblclick();
    const tab = page.locator(".podglad-tekst-przycisk");
    await tab.waitFor();
    await tab.click();
    const pane = page.locator(".podglad-tekst");
    await pane.locator("pre").first().waitFor();
    const pdfText = await pane.locator("pre").allTextContents();
    const expectedPdf = fs.readFileSync(files("pdf-tekst.pdf.expected.txt"), "utf8");
    assert.equal(normal(pdfText.join(" ")), normal(expectedPdf), "the PDF's text tab matches the expected text");
    await page.screenshot({ path: path.join(SHOTS, "tekst.png") });
    report.pdfTextMatches = true;
    await page.keyboard.press("Escape");

    // the scan: its text close to the expected one
    await row("skan-czysty.png").dblclick();
    await tab.click();
    await pane.locator("pre").first().waitFor();
    const scanText = (await pane.locator("pre").allTextContents()).join("\n");
    const expectedScan = fs.readFileSync(files("skan-czysty.png.expected.txt"), "utf8");
    report.scanCer = Number(cer(expectedScan, scanText).toFixed(4));
    assert.ok(report.scanCer <= 0.05, `scan CER ${report.scanCer} above 0.05`);
    await page.keyboard.press("Escape");

    // the "Bez tekstu" filter leaves the photo without text
    await page.locator(".files-check input").check();
    const shown = await page.locator("tbody tr.files-row").allTextContents();
    assert.equal(shown.length, 1, `filter shows ${shown.length} rows`);
    assert.ok(shown[0].includes("zdjecie-bez-tekstu.png"));
    await page.screenshot({ path: path.join(SHOTS, "pliki-bez-tekstu.png"), fullPage: true });
    report.filterRows = shown.length;

    // the search pane over the files' text (docs/OCR.md §3.6)
    await page.locator('.side-tab[data-pane="search"]').click();
    const query = page.locator(".search-input");
    const hits = page.locator("button.search-hit");
    await query.fill("zrodlana w:pliki");
    await hits.filter({ hasText: "skan-czysty.png" }).waitFor({ timeout: 60_000 });
    await hits.filter({ hasText: "pdf-tekst.pdf" }).waitFor({ timeout: 60_000 });
    report.searchHits = await hits.allTextContents();
    await query.fill("zrodlana typ:obraz");
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("button.search-hit")].map((b) => b.textContent);
      return rows.length > 0 && rows.every((t) => t.includes("skan-czysty.png"));
    }, null, { timeout: 30_000 });
    await query.fill("zrodlana w:pliki");
    await hits.filter({ hasText: "pdf-tekst.pdf" }).click();
    const mark = page.locator(".podglad-tekst mark").first();
    await mark.waitFor({ timeout: 30_000 });
    report.searchMark = await mark.textContent();
    assert.equal(report.searchMark, "Źródlana", "the hit's word is marked in the Tekst tab");
    await page.screenshot({ path: path.join(SHOTS, "szukaj-tekst.png") });
    await page.keyboard.press("Escape");

    const foreign = [...requested].filter((u) => !u.startsWith(base) && !u.startsWith("data:") && !u.startsWith("blob:"));
    assert.deepEqual(foreign, [], "requests to other hosts");
    report.requests = [...requested].map((u) => u.replace(base, "<own>")).sort();
    assert.deepEqual(errors, [], "page errors");
    console.log(JSON.stringify(report, null, 2));
    console.log("OK");
  } catch (e) {
    console.error("FAIL", e.message);
    console.error(JSON.stringify(report, null, 2));
    console.error("rows:", JSON.stringify(await page.locator("tr.files-row").allTextContents().catch(() => [])));
    console.error("console:", JSON.stringify(logs.slice(0, 20)), "page errors:", JSON.stringify(errors));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
