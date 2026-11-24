// The extractor frame (docs/OCR-PLAN.md §4.1, OCR §3.5) in a real browser: extract.html in a sandboxed iframe of a test
// page, fed with the fixtures of fixtures/ocr/. The app's side is the test page itself: it answers the frame's asset
// requests and records what comes back. Also checks that the frame made no request but blob:, data: and its own scripts.
//
// usage: PLAYWRIGHT_PATH=... node scripts/test-ocr-extract.cjs <built preview dir> [fixtures dir]
// The preview dir is `vite build -c vite.preview.config.ts --outDir <tmp>/preview`; it is served at /preview/ with the
// headers of crates/node/src/http.rs (preview_csp, security_headers), so nothing here builds anything.
const playwright = require(process.env.PLAYWRIGHT_PATH);
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const [previewDir, fixturesArg] = process.argv.slice(2);
if (!previewDir) {
  console.error("usage: node scripts/test-ocr-extract.cjs <built preview dir> [fixtures dir]");
  process.exit(2);
}
const PREVIEW = path.resolve(previewDir);
const FIX = path.resolve(fixturesArg ?? path.join(__dirname, "..", "fixtures", "ocr"));
const BROWSER = process.env.BROWSER || "chromium";

// crates/node/src/http.rs preview_csp(origin); the origin is the request's host, as request_origin reads it
const previewCsp = (origin) =>
  `sandbox allow-scripts; default-src 'none'; script-src ${origin}/preview/ 'wasm-unsafe-eval'; worker-src blob:; child-src blob:; ` +
  `style-src ${origin}/preview/ 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src blob: data:; connect-src blob:; ` +
  `frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json" };

// the app page stand-in: same-origin with the frame, cross-origin isolated like the app (security_headers)
const TEST_PAGE = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Test wyodrębniania</title></head>
<body><script>
window.runExtract = (name, mime, data, options) => new Promise((resolve) => {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.src = "/preview/extract.html";
  // as the app's frame (extracthost.ts): 1 px and transparent, not display:none (no animation frames there)
  iframe.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0";
  document.body.append(iframe);
  const pages = [];
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    iframe.remove();
    resolve({ ...result, pages });
  };
  const timer = setTimeout(() => finish({ ok: false, code: "test-timeout" }), 150000);
  const onMessage = async (e) => {
    // the frame's origin is opaque ("null"): the window it came from is the check, as in frame.ts
    if (e.source !== iframe.contentWindow) return;
    const m = e.data;
    if (m.type === "ready") {
      const bytes = new Uint8Array(data).buffer;
      iframe.contentWindow.postMessage({ type: "extract", v: 1, jobId: 1, mime, bytes, options }, "*", [bytes]);
    } else if (m.type === "asset") {
      // the app's side: the preview's own asset list, as the app serves it
      let bytes = null;
      try {
        const r = await fetch("/preview/" + m.path);
        if (r.ok) bytes = await r.arrayBuffer();
      } catch (err) {
        bytes = null;
      }
      iframe.contentWindow.postMessage({ type: "asset", v: 1, path: m.path, bytes }, "*", bytes ? [bytes] : []);
    } else if (m.type === "page") {
      pages.push({ page: m.page, pages: m.pages, text: m.text, reason: m.reason, width: m.bitmap?.width, height: m.bitmap?.height });
      m.bitmap?.close();
      iframe.contentWindow.postMessage({ type: "next", v: 1, jobId: 1 }, "*");
    } else if (m.type === "done") {
      finish({ ok: true, done: { pages: m.pages, truncated: m.truncated } });
    } else if (m.type === "error") {
      finish({ ok: false, code: m.code });
    }
  };
  window.addEventListener("message", onMessage);
});
// the frame of the app's sandbox, kept alive for the probe: resolves once the frame says it is ready
window.probeFrame = () => new Promise((resolve) => {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.src = "/preview/extract.html";
  iframe.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0";
  document.body.append(iframe);
  window.dropFrame = () => iframe.remove();
  const onReady = (e) => {
    if (e.source !== iframe.contentWindow || e.data?.type !== "ready") return;
    window.removeEventListener("message", onReady);
    resolve(true);
  };
  window.addEventListener("message", onReady);
});
</script></body></html>`;

// What each fixture must produce. "text" pages compare with the expected file (whitespace-normalized, pages split by \\f).
const norm = (s) => s.replace(/\s+/g, " ").trim();
const expectedPages = (name) => fs.readFileSync(path.join(FIX, `${name}.expected.txt`), "utf8").split("\f").map(norm);
const CASES = [
  { file: "pdf-tekst.pdf", mime: "application/pdf", want: "text 2 pages", check: (r) => {
    const want = expectedPages("pdf-tekst.pdf");
    const got = r.pages.map((p) => norm(p.text ?? ""));
    const same = r.ok && r.pages.length === 2 && r.pages.every((p) => p.text !== undefined) && got.every((t, i) => t === want[i]);
    return [same, same ? "2 text pages, equal to expected" : `pages ${r.pages.length}, text match ${got.map((t, i) => t === want[i])}`];
  } },
  { file: "pdf-skan.pdf", mime: "application/pdf", want: "2 bitmaps", check: (r) => bitmapsOnly(r, 2) },
  { file: "pdf-mieszany.pdf", mime: "application/pdf", want: "text, then bitmap", check: (r) => {
    const ok = r.ok && r.pages.length === 2 && r.pages[0].text !== undefined && r.pages[1].width > 0 && r.pages[1].text === undefined;
    return [ok, ok ? "p1 text, p2 bitmap" : r.pages.map((p) => (p.text !== undefined ? "text" : `bitmap ${p.width}x${p.height}`)).join(", ")];
  } },
  { file: "pdf-haslo.pdf", mime: "application/pdf", want: "error encrypted", check: (r) => [!r.ok && r.code === "encrypted", r.ok ? "ok" : r.code] },
  { file: "pdf-zly-font.pdf", mime: "application/pdf", want: "bitmap, reason garbled", check: (r) => {
    const first = r.pages[0];
    const ok = r.ok && first?.width > 0 && first.text === undefined && first.reason === "garbled";
    return [ok, r.ok ? `page 1 reason ${first?.reason ?? "none"}` : r.code];
  } },
  { file: "obciety.pdf", mime: "application/pdf", want: "error corrupt", check: (r) => [!r.ok && r.code === "corrupt", r.ok ? "ok" : r.code] },
  { file: "losowe.pdf", mime: "application/pdf", want: "error corrupt", check: (r) => [!r.ok && r.code === "corrupt", r.ok ? "ok" : r.code] },
  { file: "obrot-exif.jpg", mime: "image/jpeg", want: "upright bitmap (w < h)", check: (r) => {
    const p = r.pages[0];
    const ok = r.ok && r.pages.length === 1 && p.width > 0 && p.width < p.height;
    return [ok, p ? `${p.width}x${p.height}` : r.code];
  } },
  { file: "wielostronicowy.tiff", mime: "image/tiff", want: "2 bitmaps", check: (r) => bitmapsOnly(r, 2) },
  { file: "zdjecie.heic", mime: "image/heic", want: "1 bitmap", check: (r) => bitmapsOnly(r, 1) },
  { file: "obraz-ogromny.png", mime: "image/png", want: "error too-large", check: (r) => [!r.ok && r.code === "too-large", r.ok ? "ok" : r.code] },
  { file: "losowe.png", mime: "image/png", want: "error corrupt or unsupported", check: (r) => [!r.ok && ["corrupt", "unsupported"].includes(r.code), r.ok ? "ok" : r.code] },
  // hostile files (make-hostile.py): each one ends with a result, never a hang or a crash
  { file: "petla.tiff", mime: "image/tiff", want: "error corrupt, at once", check: (r, ms) => [!r.ok && r.code === "corrupt" && ms < 5000, r.ok ? "ok" : `${r.code}` ] },
  { file: "heic-to-png.heic", mime: "image/heic", want: "error too-large, no decode", check: (r) => [!r.ok && r.code === "too-large", r.ok ? "ok" : r.code] },
  { file: "pdf-wielki-obraz.pdf", mime: "application/pdf", want: "too-large or page error, under 60 s", check: (r, ms) => [r.code !== "test-timeout" && ms < 60000, r.ok ? `ok, ${r.pages.length} page(s)` : r.code] },
  { file: "pdf-wspolrzedne.pdf", mime: "application/pdf", want: "text, far runs dropped", check: (r) => {
    const first = r.pages[0];
    const ok = r.ok && first?.text !== undefined && first.text.includes("Zwykly") && !first.text.includes("Daleko");
    return [ok, r.ok ? (first?.text !== undefined ? "text, no far runs" : `bitmap ${first?.width}x${first?.height}`) : r.code];
  } },
];

function bitmapsOnly(r, count) {
  const ok = r.ok && r.pages.length === count && r.pages.every((p) => p.text === undefined && p.width > 0 && p.height > 0);
  return [ok, r.ok ? r.pages.map((p) => (p.text !== undefined ? "text" : `${p.width}x${p.height}`)).join(", ") : r.code];
}

// the frame's own requests: blob:, data:, and its own scripts from /preview/ (the only ones it may make)
const frameAllowed = (url, base) => url.startsWith("blob:") || url.startsWith("data:") || (url.startsWith(`${base}/preview/`) && /\.(js|mjs)$|extract\.html$/.test(url));

(async () => {
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const origin = `http://${host}`;
    const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
    const common = {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (pathname === "/") {
      res.writeHead(200, { ...common, "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(TEST_PAGE);
      return;
    }
    if (!pathname.startsWith("/preview/")) {
      res.writeHead(404, common).end();
      return;
    }
    const file = path.resolve(PREVIEW, pathname.slice("/preview/".length));
    if (!file.startsWith(PREVIEW + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, common).end();
      return;
    }
    // the preview's headers (http.rs preview_headers): the frame's CSP, CORS and CORP for its own origin
    res.writeHead(200, {
      ...common,
      "content-security-policy": previewCsp(origin),
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "x-frame-options": "SAMEORIGIN",
      "x-dns-prefetch-control": "off",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(), display-capture=()",
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await playwright[BROWSER].launch({ headless: true });
  let failures = 0;
  let frameRequests = 0;
  const rows = [];
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (process.env.DEBUG_OCR) page.on("console", (m) => console.log(`  [page ${m.type()}] ${m.text().slice(0, 300)}`));
    const requests = [];
    page.on("request", (r) => requests.push({ url: r.url(), frame: r.frame().url() }));
    await page.goto(`${base}/`);

    // ONLY=<fixture name>[,<name>...] runs a part of the cases (a quick look while a case is being fixed)
    const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
    for (const c of CASES.filter((x) => !only || only.includes(x.file))) {
      const bytes = [...fs.readFileSync(path.join(FIX, c.file))];
      const before = requests.length;
      const started = Date.now();
      const r = await page.evaluate(([name, mime, data]) => window.runExtract(name, mime, data, {
        maxPages: 300, maxPixels: 50000000, renderLongSide: 2480,
      }).then((res) => ({ ...res, pages: res.pages })), [c.file, c.mime, bytes]);
      const ms = Date.now() - started;
      const [ok, got] = c.check(r, ms);
      const frameReqs = requests.slice(before).filter((q) => q.frame.startsWith(`${base}/preview/`));
      frameRequests += frameReqs.length;
      const foreign = frameReqs.filter((q) => !frameAllowed(q.url, base)).map((q) => q.url);
      const passed = ok && foreign.length === 0;
      if (!passed) failures++;
      rows.push({ file: c.file, want: c.want, got: got + (foreign.length ? `; foreign requests: ${foreign.join(", ")}` : ""), ms, passed });
    }

    // hostile frame: a live frame of the sandbox, probed from inside (the probe's own requests must stay blocked or local)
    const topBefore = page.url();
    const before = requests.length;
    await page.evaluate(() => window.probeFrame());
    const probe = page.frames().find((f) => f.url() === `${base}/preview/extract.html`);
    const checks = probe ? await probe.evaluate(async () => {
      const refused = async (p) => {
        try {
          await p;
          return false;
        } catch {
          return true;
        }
      };
      const out = {};
      out.fetchExternal = await refused(fetch("https://example.com/"));
      out.fetchApi = await refused(fetch("/api/health"));
      out.noRtc = typeof RTCPeerConnection === "undefined" && typeof webkitRTCPeerConnection === "undefined" && typeof RTCDataChannel === "undefined";
      out.windowOpenNull = window.open("https://example.com/") === null;
      try {
        top.location = "/x";
        out.topNav = "no throw";
      } catch {
        out.topNav = "throws";
      }
      return out;
    }) : null;
    await page.evaluate(() => window.dropFrame?.());
    await new Promise((resolve) => setTimeout(resolve, 200));
    const probeReqs = requests.slice(before).filter((q) => q.frame.startsWith(`${base}/preview/`));
    const probeForeign = probeReqs.filter((q) => !frameAllowed(q.url, base)).map((q) => q.url);
    const topSame = page.url() === topBefore;
    const hostileOk = !!checks && checks.fetchExternal && checks.fetchApi && checks.noRtc && checks.windowOpenNull && topSame && probeForeign.length === 0;
    if (!hostileOk) failures++;
    const detail = checks ? `fetch external refused ${checks.fetchExternal}, /api/health refused ${checks.fetchApi}, no RTC ${checks.noRtc}, window.open null ${checks.windowOpenNull}, top navigation ${checks.topNav}, page URL kept ${topSame}, foreign requests ${probeForeign.length}` : "no frame";
    rows.push({ file: "hostile frame", want: "no network, no RTC, no popups, no top navigation", got: detail, ms: 0, passed: hostileOk });
    const otherRequests = requests.filter((q) => !q.frame.startsWith(`${base}/preview/`) && q.url.startsWith("http") && !q.url.startsWith(base));
    if (otherRequests.length) console.log(`(app page requests outside the server: ${otherRequests.length}, not the frame's)`);
    if (errors.length) console.log(`page errors: ${errors.slice(0, 5).join(" | ")}`);
  } finally {
    await browser.close();
    server.close();
  }

  console.log("\n| fixture | want | got | ms | result |\n|---|---|---|---|---|");
  for (const row of rows) console.log(`| ${row.file} | ${row.want} | ${row.got} | ${row.ms} | ${row.passed ? "PASS" : "FAIL"} |`);
  console.log(`\nframe requests seen: ${frameRequests} (blob:, data: and its own scripts only)`);
  console.log(`${rows.length - failures}/${rows.length} passed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
