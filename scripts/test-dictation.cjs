// Dictation end to end (docs/DYKTOWANIE.md §8), with a WAV file as the microphone. Run against notes-node, whose
// headers (CSP, COOP/COEP) are the ones under test; the Vite dev server sends no CSP.
// notes-node serves the models from DATA/models: `ln -s "$PWD/models" DATA/models` before `serve --data DATA`.
//   PLAYWRIGHT_PATH=/path/to/playwright APP_URL=http://127.0.0.1:8090/?demo=1 node scripts/test-dictation.cjs
// Checks: consent, download, text at the caret, one undo removes one fragment, no request off the origin, a request
// to another host is blocked by CSP, and no audio is left in browser storage (only the model directory in OPFS).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const url = process.env.APP_URL || "http://127.0.0.1:8090/?demo=1";
const wav = process.env.WAV || path.resolve(__dirname, "../ui/src/voice/fixtures/jfk.wav");
const expected = new RegExp(process.env.EXPECT || "ask what you can do for your country", "i");

(async () => {
  const profile = process.env.PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "notes-dictation-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    permissions: ["microphone"],
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--enable-unsafe-webgpu", "--use-angle=vulkan", "--enable-features=Vulkan",
    ],
  });
  const page = await context.newPage();
  const origin = new URL(url).origin;
  const offOrigin = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !/^(data|blob):/.test(u)) offOrigin.push(u);
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(url);
  await page.locator(".tree-row").first().waitFor({ timeout: 30000 });
  const rows = page.locator(".tree-row");
  for (let i = 0; i < (await rows.count()); i++) {
    await rows.nth(i).click();
    if (await page.locator(".cm-content").isVisible().catch(() => false)) break;
  }
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  const before = await page.locator(".cm-content").innerText();
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, "the page must be cross-origin isolated");

  // CSP: a request to another host fails and is reported as a violation
  const blocked = await page.evaluate(async () => {
    const seen = new Promise((resolve) => document.addEventListener("securitypolicyviolation", (e) => resolve(e.violatedDirective), { once: true }));
    const result = await fetch("https://example.com/").then(() => "loaded", () => "failed");
    return { result, directive: await Promise.race([seen, new Promise((r) => setTimeout(() => r(null), 2000))]) };
  });
  assert.equal(blocked.result, "failed", "fetch to another host must fail");
  assert.equal(blocked.directive, "connect-src", "the failure must come from CSP connect-src");
  offOrigin.length = 0; // the probe above is the one deliberate attempt

  const t0 = Date.now();
  await page.locator(".voice-btn").click();
  const consent = page.getByRole("button", { name: "Pobierz i włącz" });
  if (await consent.waitFor({ timeout: 10000 }).then(() => true, () => false)) await consent.click();
  await page.waitForFunction((re) => new RegExp(re, "i").test(document.querySelector(".cm-content").innerText), expected.source, { timeout: 600000, polling: 250 });
  console.log(`text after ${((Date.now() - t0) / 1000).toFixed(1)} s (with any model download)`);
  await page.locator(".voice-btn").click();
  await page.waitForFunction(() => document.querySelector(".voice-btn").dataset.voice === "idle", null, { timeout: 15000 });

  const after = await page.locator(".cm-content").innerText();
  const added = after.slice(before.trimEnd().length).trim();
  console.log("dictated:", added);
  assert.ok(expected.test(added), "the dictated text is in the note");

  await page.keyboard.press("Control+z");
  const undone = await page.locator(".cm-content").innerText();
  assert.ok(undone.length < after.length && undone.length > before.trimEnd().length, "one undo removes the last fragment only");

  const storage = await page.evaluate(async () => {
    const opfs = [];
    for await (const [name] of (await navigator.storage.getDirectory()).entries()) opfs.push(name);
    return { caches: (await caches.keys()).length, idb: (await indexedDB.databases()).map((d) => d.name), opfs };
  });
  console.log("storage:", JSON.stringify(storage));
  assert.equal(storage.caches, 0, "no Cache Storage");
  assert.deepEqual(storage.opfs.filter((n) => n !== "voice-models"), [], "OPFS holds only the model directory");
  assert.ok(!storage.idb.some((n) => /voice|audio|dykt/i.test(n ?? "")), "no audio database in IndexedDB");
  assert.deepEqual(offOrigin, [], "no request leaves the origin");
  assert.deepEqual(errors, [], "no page errors");
  console.log("OK: dyktowanie działa, nic nie wychodzi poza origin, CSP blokuje inne hosty");
  await context.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
