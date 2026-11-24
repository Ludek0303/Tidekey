// usage: PLAYWRIGHT_PATH=... node scripts/test-obsidian-demo.cjs <built web dir> <shots dir>
// Demo-mode check of: Ctrl+P create, rename rewrites links, templates + daily note, split view.
const playwright = require(process.env.PLAYWRIGHT_PATH);
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const [web, shots] = process.argv.slice(2);
const PORT = 8101;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "OK  " : "FAIL"} ${n}${x ? " — " + x : ""}`); };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(web, p);
  if (!f.startsWith(web) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/?demo=1`);
    await page.locator("#tree").waitFor({ timeout: 20000 });
    await sleep(1500);
    const close = page.getByRole("button", { name: "Rozumiem" });
    if (await close.isVisible().catch(() => false)) await close.click();
    const palette = async (name) => {
      await page.keyboard.press("Control+Shift+P");
      await page.locator(".qo-input").last().fill(name);
      await sleep(200);
      await page.keyboard.press("Enter");
      await sleep(400);
    };
    const editorText = () => page.locator("#editor .cm-content").first().innerText();

    // 1. Ctrl+P creates a note
    await page.click("#editor .cm-content").catch(() => undefined);
    await page.keyboard.press("Control+P");
    await page.locator(".qo-input").fill("Cel testu");
    await sleep(200);
    check("Ctrl+P pokazuje, że Enter utworzy", (await page.locator(".qo-empty").textContent()).includes("Enter utworzy"));
    await page.keyboard.press("Enter");
    await sleep(800);
    check("nowa notatka w drzewie", await page.locator(".tree-row", { hasText: "Cel testu" }).count() > 0);

    // 2. a note linking to it, then rename the target
    await page.keyboard.press("Control+P");
    await page.locator(".qo-input").fill("Zrodlo linku");
    await page.keyboard.press("Enter");
    await sleep(800);
    await page.locator("#editor .cm-content").first().click();
    await page.keyboard.type("Zobacz [[Cel testu|cel]] i [[Cel testu#Sekcja]].");
    await sleep(1500);
    await page.locator(".tree-row", { hasText: "Cel testu" }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: /Zmień nazwę/ }).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Nowy cel");
    await page.keyboard.press("Enter");
    await sleep(2000);
    await page.locator(".tree-row", { hasText: "Zrodlo linku" }).first().click();
    await sleep(800);
    const src = await editorText();
    check("linki przepisane po zmianie nazwy", src.includes("[[Nowy cel|cel]]") && src.includes("[[Nowy cel#Sekcja]]"), src.slice(0, 120));

    // 3. split view
    await palette("Otwórz notatkę obok");
    await page.locator(".qo-input").last().fill("Nowy cel");
    await sleep(200);
    await page.keyboard.press("Enter");
    await sleep(1000);
    const splitShown = await page.locator("#split").isVisible();
    check("podział ekranu widoczny", splitShown);
    await page.locator("#split .cm-content").click();
    await page.keyboard.type("Tekst po prawej");
    await sleep(500);
    check("pisanie w prawym panelu", (await page.locator("#split .cm-content").innerText()).includes("Tekst po prawej"));
    check("lewy panel bez zmian", (await editorText()).includes("Zobacz"));
    await sleep(800); await page.screenshot({ path: path.join(shots, "split.png") });
    await page.click("#btn-split-close");
    await sleep(500);
    check("zamknięcie podziału", !(await page.locator("#split").isVisible()));
    await page.locator(".tree-row", { hasText: "Nowy cel" }).first().click();
    await sleep(800);
    check("tekst z prawego panelu zapisany", (await editorText()).includes("Tekst po prawej"));

    // 4. template + daily note
    await page.keyboard.press("Control+P");
    await page.locator(".qo-input").fill("Szablony/Dziennik");
    await page.keyboard.press("Enter");
    await sleep(800);
    await page.locator("#editor .cm-content").first().click();
    await page.keyboard.type("# {{date}} — {{title}}");
    await sleep(800);
    await page.locator(".tree-row", { hasText: "Zrodlo linku" }).first().click();
    await sleep(600);
    await page.locator("#editor .cm-content").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await palette("Wstaw szablon");
    await page.keyboard.press("Enter");
    await sleep(800);
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    check("szablon wstawiony ze zmiennymi", (await editorText()).includes(`# ${today} — Zrodlo linku`), (await editorText()).slice(-60));
    await palette("Dzisiejsza notatka");
    await sleep(800);
    check("dzisiejsza notatka otwarta", await page.locator(".tree-row", { hasText: today }).count() > 0);
    check("brak błędów strony", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("przebieg bez wyjątku", false, String(e).slice(0, 300));
    const p = browser.contexts()[0]?.pages()[0];
    if (p) await p.screenshot({ path: path.join(shots, "blad.png") });
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})();
