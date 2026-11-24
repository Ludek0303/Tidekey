// Preview window against a real notes-node (encrypted files, the server's /preview/ headers): registers an account,
// uploads fixtures into a folder of "Moje notatki", opens each from the tree and checks what the window shows, what the
// frame fetched and that nothing ran or left the device (docs/PODGLAD-PLAN.md §9).
//
// usage: PLAYWRIGHT_PATH=... node scripts/test-preview.cjs <notes-node binary> <data dir> <built web dir> <shots dir> [fixture...]
// The web dir is `vite build` with the frame built into <web>/preview (vite build -c vite.preview.config.ts --outDir <web>/preview).
const playwright = require(process.env.PLAYWRIGHT_PATH);
// BROWSER=firefox: Firefox decodes H.264 (mp4, mov) where Chromium from Playwright cannot; EXTRA=1: the checks below the walk
const BROWSER = process.env.BROWSER || "chromium";
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const [node, data, web, shots, ...only] = process.argv.slice(2);
const PORT = 8097;
const TRAP_PORT = 8098; // an "outside" server: no request may ever reach it
const url = `http://127.0.0.1:${PORT}/`;
const FIX = path.join(__dirname, "..", "fixtures", "preview");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fixture → what the window must end with: "frame" (shown in the frame), "card" (a card in the app), "error"
// What Chromium from Playwright shows (no H.264/AAC there: those end on the video card or a codec error). "frame": shown
// in the frame; "card": a card in the app (unsupported, too large, video without a first frame); "error": the error card.
const ALL = {
  "obraz.png": "frame", "obraz.gif": "frame", "obraz.webp": "frame", "obraz.bmp": "frame", "zdjecie-8000x6000.jpg": "frame",
  "obraz.tiff": "frame", "obraz.psd": "frame", "zdjecie.heic": "frame", "skrypt.svg": "frame", "obraz-50000x50000.png": "card",
  "notatki.txt": "frame", "skrypt.py": "frame", "dane.json": "frame", "styl.css": "frame", "strona.html": "frame",
  "dziennik.log": "frame", "klienci.csv": "frame", "pusty.txt": "frame",
  "bardzo długa nazwa pliku z polskimi znakami zażółć gęślą jaźń — wersja ostateczna poprawiona po uwagach.txt": "frame",
  "dokument.pdf": "frame", "uszkodzony.pdf": "error", "pdf-a-w-srodku-zip.pdf": "frame",
  "dokument.docx": "frame", "docx-obraz-zewnetrzny.docx": "frame", "dokument.doc": "frame", "dokument.odt": "card",
  "arkusz.xlsx": "frame", "arkusz.xls": "frame", "arkusz.ods": "frame", "prezentacja.pptx": "frame", "prezentacja.ppt": "frame",
  "dzwiek.mp3": "frame", "dzwiek.ogg": "frame", "dzwiek.wav": "frame", "dzwiek.flac": "frame", "dzwiek.m4a": "error",
  "film.webm": "frame", "film-vp9.mkv": "frame", "film.avi": "frame", "film.mp4": "card", "film.mov": "card",
  "film-h264.mkv": "card", "film-h264.avi": "card", "film-moov-na-koncu.mp4": "card", "losowe.mkv": "card",
  "model.obj": "frame", "model.stl": "frame", "model-ascii.stl": "frame", "model.ply": "frame", "model.gltf": "frame",
  "model.glb": "frame", "model.off": "frame", "model.3mf": "frame", "model.amf": "frame", "model.dae": "frame", "model.wrl": "frame",
  "chmura.ply": "frame", "chmura.pcd": "frame", "chmura.las": "frame", "rysunek.dxf": "frame", "rysunek.dwg": "frame",
  "font.ttf": "frame", "font.otf": "frame", "font.woff": "frame", "archiwum.zip": "frame",
  "program.exe": "card", "losowe.dwg": "error", "losowe.doc": "card", "losowe.ppt": "card",
  "granica-1MiB.bin": "card", "granica-1MiB+1.bin": "card",
};
if (fs.existsSync(path.join(FIX, "model.step"))) ALL["model.step"] = "frame";
const CASES = only.length ? only.map((n) => [n, ALL[n] ?? null]) : Object.entries(ALL);

(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  execFileSync(node, ["init", "--data", data], { stdio: "ignore" });
  const server = spawn(node, ["serve", "--data", data, "--http", `127.0.0.1:${PORT}`, "--quic", "127.0.0.1:0", "--web", web, "--relay", "off"],
    { env: { ...process.env, AUTH_COOKIE_SECURE: "false", NOTES_REGISTRATION: "open" }, stdio: "ignore" });
  const trapHits = [];
  const trap = http.createServer((req, res) => { trapHits.push(req.url); res.end(); }).listen(TRAP_PORT, "127.0.0.1");
  await sleep(1500);
  const browser = await playwright[BROWSER].launch({ headless: true, ...(BROWSER === "chromium" ? { args: ["--js-flags=--expose-gc"] } : {}) });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    // counts the object URLs the app's own document holds: every one must be released when the window closes
    await page.addInitScript(() => {
      const live = new Set();
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (o) => { const u = create(o); live.add(u); return u; };
      URL.revokeObjectURL = (u) => { live.delete(u); revoke(u); };
      Object.defineProperty(window, "__liveBlobUrls", { get: () => live.size });
    });
    const appErrors = [];
    page.on("pageerror", (e) => appErrors.push(e.message));
    if (process.env.DEBUG_FRAME) page.on("console", (m) => { if (m.location().url.includes("/preview/")) console.log(`  [frame ${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on("console", (m) => { if (m.type() === "error" && !m.location().url.includes("/preview/") && !m.text().startsWith("Failed to load resource")) appErrors.push(m.text()); });
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
    const requests = [];
    page.on("request", (r) => requests.push({ url: r.url(), frame: r.frame()?.url() ?? "" }));
    // a new account's own 404s (keys not made yet, a file looked up before its first upload) are not the preview's
    page.on("response", (r) => { if (r.status() >= 400 && /\/preview\/|\/content$/.test(r.url())) appErrors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

    await page.goto(url);
    await page.click(".web-auth-switch");
    await page.fill('[name="name"]', "Ola");
    await page.fill('[name="email"]', "ola@example.test");
    await page.fill('[name="password"]', "Bardzo dlugie haslo 1");
    await page.fill('[name="password2"]', "Bardzo dlugie haslo 1");
    await page.check('[name="terms"]');
    await page.click(".web-auth-submit");
    await page.check("#recovery-ack", { timeout: 15000 });
    await page.click("#recovery-continue");
    await page.locator("#tree").waitFor({ timeout: 20000 });
    await sleep(1500);
    const close = page.getByRole("button", { name: "Rozumiem" });
    if (await close.isVisible().catch(() => false)) await close.click();

    // upload every fixture into the root folder through the tree's menu
    // an empty library has no menu: a folder first, then its menu uploads the files
    await page.getByRole("button", { name: "Nowy folder" }).first().click();
    await page.keyboard.type("Pliki testowe");
    await page.keyboard.press("Enter");
    await page.locator(".tree-row", { hasText: "Pliki testowe" }).first().click({ button: "right" });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Wgraj pliki/ }).click({ timeout: 5000 });
    await (await chooser).setFiles(CASES.map(([n]) => path.join(FIX, n)));
    // uploads go one by one; the tree reloads after the last one, and the upload toasts go away
    await page.waitForFunction(() => document.querySelectorAll(".toast").length === 0, null, { timeout: 900000, polling: 1000 });
    await page.locator(".tree-row", { hasText: "Pliki testowe" }).first().click(); // open the folder
    await sleep(800);
    const want = new Map(CASES);

    // open the first file of the folder from the tree, then walk the whole folder with the window's → arrow
    const firstFile = page.locator('.tree-row[data-key^="Pliki testowe/"]').first();
    await firstFile.click();
    const seen = new Set();
    for (let step = 0; step < CASES.length + 2; step++) {
      await page.locator(".podglad [role=dialog]").waitFor({ timeout: 10000 });
      const before = requests.length;
      // the window settles on the frame (shown) or a card
      await page.waitForFunction(() => {
        const stan = document.querySelector(".podglad-stan");
        const karta = stan && !stan.hidden && stan.querySelector(".podglad-karta");
        const ramka = document.querySelector(".podglad-ramka");
        return Boolean(karta) || (ramka && getComputedStyle(ramka).visibility !== "hidden" && (!stan || stan.hidden));
      }, null, { timeout: 60000 }).catch(() => undefined);
      await sleep(700);
      const state = await page.evaluate(() => {
        const stan = document.querySelector(".podglad-stan");
        const karta = stan && !stan.hidden ? stan.querySelector(".podglad-karta") : null;
        const name = document.querySelector(".podglad-pasek [title]")?.getAttribute("title") ?? "?";
        const counter = document.querySelector(".podglad-licznik")?.textContent ?? "";
        return { name, counter, got: karta ? (karta.classList.contains("is-blad") ? "error" : "card") + ": " + karta.textContent.replace(/\s+/g, " ").trim() : "frame" };
      });
      const { name, got, counter } = state;
      if (seen.has(name)) break;
      seen.add(name);
      const mine = requests.slice(before);
      const frameReqs = mine.filter((r) => r.frame.includes("/preview/")).map((r) => r.url);
      const foreign = frameReqs.filter((u) => !u.startsWith(`${url}preview/`) && !u.startsWith("blob:"));
      const shot = path.join(shots, `${name.replace(/[^a-z0-9.-]/gi, "_").slice(0, 80)}.png`);
      await page.screenshot({ path: shot });
      const expected = want.get(name);
      const ok = (!expected || got.startsWith(expected)) && foreign.length === 0;
      console.log(`${ok ? "OK  " : "FAIL"} [${counter}] ${name.slice(0, 60)}: ${got.slice(0, 100)}${expected ? "" : " (no expectation)"}${foreign.length ? " FOREIGN: " + foreign.join(", ") : ""}`);
      if (!ok) failures.push(name);
      // the arrow goes to the window, not into the frame: focus the window's own close button first
      await page.locator(".podglad [aria-label='Zamknij']").first().focus();
      const [here, total] = counter.split(" z ").map(Number);
      if (here >= total) break;
      await page.keyboard.press("ArrowRight");
      await sleep(300);
    }
    const missing = CASES.map(([n]) => n).filter((n) => !seen.has(n));
    if (missing.length) { console.log("NOT VISITED:", missing.join(", ")); failures.push("not visited"); }
    // content requests: a video with a thumbnail made on upload fetches only the thumbnail (checked by the count)
    console.log(`content requests in all: ${requests.filter((r) => r.url.endsWith("/content")).length} for ${seen.size} files`);
    await page.keyboard.press("Escape");
    await page.locator(".podglad").waitFor({ state: "detached", timeout: 5000 }).catch(() => failures.push("window did not close"));

    if (process.env.EXTRA) {
      // 1. isolation inside the real frame build: no storage, no app document, no navigation, no windows
      await firstFile.click();
      await page.waitForFunction(() => { const r = document.querySelector(".podglad-ramka"); return r && getComputedStyle(r).visibility !== "hidden"; }, null, { timeout: 60000 });
      const frame = page.frames().find((f) => f.url().includes("/preview/"));
      const probe = await frame.evaluate(async () => {
        const tryIt = async (fn) => { try { return `ALLOWED: ${String(await fn()).slice(0, 40)}`; } catch (e) { return e.name; } };
        return {
          origin: self.origin,
          indexedDB: await tryIt(() => new Promise((res, rej) => { const q = indexedDB.open("x"); q.onsuccess = () => res("open"); q.onerror = () => rej(q.error); })),
          localStorage: await tryIt(() => localStorage.length),
          cookie: await tryIt(() => document.cookie),
          parentDocument: await tryIt(() => parent.document.title),
          topNavigation: await tryIt(() => { top.location.href = "http://127.0.0.1:8098/nav"; return "no error"; }),
          windowOpen: await tryIt(() => window.open("http://127.0.0.1:8098/popup")),
          fetchServer: await tryIt(() => fetch("/api/vaults").then((r) => r.status)),
          fetchOutside: await tryIt(() => fetch("http://127.0.0.1:8098/x").then((r) => r.status)),
        };
      });
      console.log("frame isolation:", JSON.stringify(probe));
      // the probe's own refusals are logged by the browser as errors: they are the expected result, not app errors
      appErrors.length = 0;
      const leaks = Object.entries(probe).filter(([k, v]) => k !== "origin" && String(v).startsWith("ALLOWED") && !(k === "windowOpen" && v === "ALLOWED: null"));
      if (probe.origin !== "null" || leaks.length) failures.push(`isolation: ${JSON.stringify(leaks)}`);
      await page.keyboard.press("Escape");
      await sleep(500);

      // 2. memory: 50 opens and closes of different files leave no object URL, no frame, and the heap where it was
      const heap = () => page.evaluate(() => { if (typeof gc === "function") gc(); return performance.memory ? performance.memory.usedJSHeapSize : 0; });
      const heapBefore = await heap();
      const rows = await page.locator('.tree-row[data-key^="Pliki testowe/"]').count();
      for (let i = 0; i < 50; i++) {
        await page.locator('.tree-row[data-key^="Pliki testowe/"]').nth(i % Math.max(1, rows)).click();
        await page.locator(".podglad [role=dialog]").waitFor({ timeout: 10000 });
        await sleep(i % 5 === 0 ? 1500 : 250); // some of them load fully, the others are closed while they load
        await page.keyboard.press("Escape");
        await page.locator(".podglad").waitFor({ state: "detached", timeout: 5000 });
      }
      await sleep(1500);
      const after = await page.evaluate(() => ({ urls: window.__liveBlobUrls, frames: [...document.querySelectorAll("iframe")].filter((f) => !f.closest('[aria-hidden="true"]')).length }));
      const heapAfter = await heap();
      console.log(`memory: live object URLs ${after.urls}, window frames ${after.frames}, heap ${Math.round(heapBefore / 1e6)} MB → ${Math.round(heapAfter / 1e6)} MB`);
      if (after.urls || after.frames || (heapBefore && heapAfter > heapBefore * 1.2 + 5e6)) failures.push("memory");

      // 3. an old video without a thumbnail (BIG_VIDEO: an H.264 mp4 over 16 MiB with moov at the end, which Chromium
      //    cannot decode, so no thumbnail is made on upload): the preview downloads at most 16 MiB and ends on the card
      if (process.env.BIG_VIDEO && BROWSER === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Network.enable");
        const contentIds = new Set();
        let bytes = 0;
        cdp.on("Network.requestWillBeSent", (e) => { if (e.request.url.endsWith("/content")) contentIds.add(e.requestId); });
        cdp.on("Network.dataReceived", (e) => { if (contentIds.has(e.requestId)) bytes += e.encodedDataLength || e.dataLength; });
        const big = path.basename(process.env.BIG_VIDEO);
        await page.locator(".tree-row", { hasText: "Pliki testowe" }).first().click({ button: "right" });
        const chooser2 = page.waitForEvent("filechooser");
        await page.getByRole("menuitem", { name: /Wgraj pliki/ }).click({ timeout: 5000 });
        await (await chooser2).setFiles([process.env.BIG_VIDEO]);
        await page.waitForFunction(() => document.querySelectorAll(".toast").length === 0, null, { timeout: 300000, polling: 1000 });
        await sleep(1000);
        bytes = 0; contentIds.clear();
        await page.locator(`.tree-row[data-key="Pliki testowe/${big}"]`).first().click();
        await page.waitForFunction(() => document.querySelector(".podglad-stan:not([hidden]) .podglad-karta"), null, { timeout: 120000 });
        await sleep(1500);
        const card = await page.locator(".podglad-stan .podglad-karta").textContent();
        console.log(`old video ${big}: downloaded ${(bytes / 1048576).toFixed(2)} MiB, window: ${card.replace(/\s+/g, " ").trim().slice(0, 90)}`);
        // 16 MiB are decrypted, then the fetch is aborted; the browser's network stack reads ahead a few MiB before the
        // abort lands (no Range support on the server, PODGLAD-PLAN D12): measured 20–24 MiB here; the check allows 8 MiB of
        // read-ahead, which still proves the download stops long before the end of a large file
        if (bytes > 24 * 1048576) failures.push(`old video downloaded ${bytes} bytes`);
        await page.keyboard.press("Escape");
      }
    }
    // the hidden frame that makes video thumbnails on upload lives on for 30 s by design; only the window's frames count
    const frames = await page.evaluate(() => [...document.querySelectorAll("iframe")].filter((f) => !f.closest('[aria-hidden="true"]')).length);
    console.log(`alerts: ${dialogs}, iframes left: ${frames}, trap hits: ${trapHits.length}, app errors: ${JSON.stringify(appErrors)}`);
    if (dialogs || frames || trapHits.length || appErrors.length) failures.push("isolation/cleanup");
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    trap.close();
  }
  if (failures.length) { console.error("FAILED:", failures.join(", ")); process.exit(1); }
  console.log("ALL OK");
})().catch((e) => { console.error(e); process.exit(1); });
