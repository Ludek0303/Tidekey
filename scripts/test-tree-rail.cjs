// usage: PLAYWRIGHT_PATH=... node scripts/test-tree-rail.cjs <notes-node> <data dir> <built web dir> <shots dir>
// heading rail, delete without dialog + Cofnij, file rows: click selects, double click opens, drag moves the selection
const playwright = require(process.env.PLAYWRIGHT_PATH);
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [node, data, web, shots] = process.argv.slice(2);
const PORT = 8102;
const url = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "OK  " : "FAIL"} ${n}${x ? " — " + x : ""}`); };

(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  execFileSync(node, ["init", "--data", data], { stdio: "ignore" });
  const server = spawn(node, ["serve", "--data", data, "--http", `127.0.0.1:${PORT}`, "--quic", "127.0.0.1:0", "--web", web, "--relay", "off"],
    { env: { ...process.env, AUTH_COOKIE_SECURE: "false", NOTES_REGISTRATION: "open" }, stdio: "ignore" });
  await sleep(1500);
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.dismiss());
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
    const newNote = async (name) => {
      await page.keyboard.press("Control+P");
      await page.locator(".qo-input").fill(name);
      await page.keyboard.press("Enter");
      await sleep(900);
    };

    // 1. heading rail
    await newNote("Plan projektu");
    await page.locator("#editor .cm-content").first().click();
    const body = "# Cel\n\nOpis celu.\n\n## Zakres\n\n" + "Tekst.\n\n".repeat(25) + "## Harmonogram\n\nTydzień 1.\n\n### Ryzyka\n\n" + "Więcej.\n\n".repeat(30) + "# Podsumowanie\n\nKoniec.";
    await page.keyboard.insertText(body);
    await sleep(800);
    const ticks = await page.locator(".cm-heading-tick").count();
    check("kreski dla 5 nagłówków", ticks === 5, String(ticks));
    await page.locator(".cm-heading-tick").nth(3).hover();
    await sleep(300);
    await page.screenshot({ path: path.join(shots, "1-kreski.png") });
    await page.locator(".cm-heading-tick").nth(3).click();
    await sleep(500);
    const top = await page.evaluate(() => [...document.querySelectorAll("#editor .cm-line")].find((l) => l.textContent.includes("Ryzyka"))?.getBoundingClientRect().top ?? -1);
    check("kliknięcie przenosi do nagłówka", top > 0 && top < 400, String(Math.round(top)));
    const dashW = await page.evaluate(() => document.querySelector(".cm-heading-tick .dash")?.getBoundingClientRect().width ?? 0);
    check("kreski są widoczne", dashW > 0, `${dashW}px`);

    // 2. delete without a dialog, then Cofnij
    await newNote("Do usunięcia");
    await page.locator(".tree-row", { hasText: "Do usunięcia" }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Usuń$/ }).click();
    await sleep(800);
    check("bez okna potwierdzenia", (await page.locator(".modal-confirm").count()) === 0);
    check("notatka zniknęła z drzewa", (await page.locator(".tree-row", { hasText: "Do usunięcia" }).count()) === 0);
    const toast = page.locator(".toast", { hasText: "Przeniesiono do kosza" });
    check("toast z Cofnij", await toast.locator("button", { hasText: "Cofnij" }).isVisible());
    await page.screenshot({ path: path.join(shots, "2-cofnij.png") });
    await toast.locator("button", { hasText: "Cofnij" }).click();
    await sleep(1200);
    check("Cofnij przywraca notatkę", (await page.locator(".tree-row", { hasText: "Do usunięcia" }).count()) === 1);

    // 3. files: click selects, double click opens, drag moves the selection
    // the second folder is made inside the first (it is the selected one): files go Dokumenty → Dokumenty/Archiwum
    for (const folder of ["Dokumenty", "Archiwum"]) {
      await page.getByRole("button", { name: "Nowy folder" }).first().click();
      await page.keyboard.type(folder);
      await page.keyboard.press("Enter");
      await sleep(600);
    }
    const tmp = path.join(shots, "pliki");
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "a.txt"), "plik A");
    fs.writeFileSync(path.join(tmp, "b.txt"), "plik B");
    await page.locator(".tree-row", { hasText: "Dokumenty" }).first().click({ button: "right" });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Wgraj pliki/ }).click();
    await (await chooser).setFiles([path.join(tmp, "a.txt"), path.join(tmp, "b.txt")]);
    await page.waitForFunction(() => document.querySelectorAll(".toast").length === 0, null, { timeout: 30000, polling: 500 }).catch(() => undefined);
    await sleep(800);
    const rowA = page.locator(".tree-row", { hasText: "a.txt" }).first();
    const rowB = page.locator(".tree-row", { hasText: "b.txt" }).first();
    if (!(await rowA.isVisible())) await page.locator(".tree-row", { hasText: "Dokumenty" }).first().click();
    await sleep(500);
    await rowA.click();
    await sleep(500);
    check("klik zaznacza plik", (await rowA.getAttribute("class")).includes("is-selected"));
    check("klik nie otwiera podglądu", (await page.locator(".podglad [role=dialog]").count()) === 0);
    check("pasek zaznaczenia ukryty dla jednego kliknięcia", await page.locator(".tree-footer, .tree-selection").first().isHidden().catch(() => true));
    await rowB.click({ modifiers: ["Control"] });
    await sleep(300);
    await page.screenshot({ path: path.join(shots, "3-zaznaczone.png") });
    await rowA.dragTo(page.locator(".tree-row", { hasText: "Archiwum" }).first());
    await sleep(2000);
    const moved = await page.evaluate(() => [...document.querySelectorAll(".tree-row")].map((r) => r.getAttribute("data-key")).filter((k) => k && k.endsWith(".txt")));
    check("przeciągnięcie przenosi oba pliki", moved.length > 0 && moved.length === 2 && moved.every((k) => k.startsWith("Dokumenty/Archiwum/")), moved.join(", "));
    if (await page.locator(".tree-row", { hasText: "a.txt" }).count() === 0) await page.locator(".tree-row", { hasText: "Archiwum" }).first().click();
    await sleep(500);
    await page.locator(".tree-row", { hasText: "a.txt" }).first().dblclick();
    await page.locator(".podglad [role=dialog]").waitFor({ timeout: 10000 }).catch(() => undefined);
    check("dwuklik otwiera plik", (await page.locator(".podglad [role=dialog]").count()) > 0);
    await sleep(800);
    await page.screenshot({ path: path.join(shots, "4-podglad.png") });
    check("brak błędów strony", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("przebieg bez wyjątku", false, String(e).slice(0, 300));
    const p = browser.contexts()[0]?.pages()[0];
    if (p) await p.screenshot({ path: path.join(shots, "blad.png") });
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})();
