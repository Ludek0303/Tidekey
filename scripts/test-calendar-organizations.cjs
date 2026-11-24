// e2e: sign-up with a registration code, "Mój kalendarz" adding to Moje notatki and to an organization, deleting the organization.
// usage: PLAYWRIGHT_PATH=... node scripts/test-calendar-organizations.cjs <notes-node> <data> <web> <shots>
const playwright = require(process.env.PLAYWRIGHT_PATH);
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [node, data, web, shots] = process.argv.slice(2);
const PORT = 8099;
const url = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push([name, ok]); console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`); };

(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  execFileSync(node, ["init", "--data", data], { stdio: "ignore" });
  const codeOut = execFileSync(node, ["signup-code", "--data", data, "--label", "e2e"], { encoding: "utf8" });
  const code = codeOut.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
  check("CLI wydaje kod", !!code, codeOut.split("\n")[0]);
  const env = { ...process.env, AUTH_COOKIE_SECURE: "false" };
  delete env.NOTES_REGISTRATION;
  const server = spawn(node, ["serve", "--data", data, "--http", `127.0.0.1:${PORT}`, "--quic", "127.0.0.1:0", "--web", web, "--relay", "off"], { env, stdio: "ignore" });
  await sleep(1500);
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.dismiss());

    // --- registration needs the code
    await page.goto(url);
    await page.click(".web-auth-switch");
    await page.locator("#auth-code-row").waitFor();
    check("pole kodu widoczne przy rejestracji", await page.locator("#auth-code-row").isVisible());
    await page.screenshot({ path: path.join(shots, "1-rejestracja.png") });
    await page.fill('[name="code"]', "ZZZZ-ZZZZ-ZZZZ");
    await page.fill('[name="name"]', "Ola");
    await page.fill('[name="email"]', "ola@example.test");
    await page.fill('[name="password"]', "Bardzo dlugie haslo 1");
    await page.fill('[name="password2"]', "Bardzo dlugie haslo 1");
    await page.check('[name="terms"]');
    await page.click(".web-auth-submit");
    await page.locator(".web-auth-error:not([hidden])").waitFor();
    const err = await page.locator(".web-auth-error").textContent();
    check("zły kod odrzucony", /kod rejestracyjny jest nieprawidłowy/.test(err), err);
    await page.fill('[name="code"]', code.toLowerCase());
    await page.click(".web-auth-submit");
    await page.check("#recovery-ack", { timeout: 15000 });
    await page.click("#recovery-continue");
    await page.locator("#tree").waitFor({ timeout: 20000 });
    await sleep(1500);
    const close = page.getByRole("button", { name: "Rozumiem" });
    if (await close.isVisible().catch(() => false)) await close.click();
    check("konto z kodem ma Moje notatki", (await page.locator("#vault-name").textContent()).includes("Moje notatki"), await page.locator("#vault-name").textContent());
    const used = execFileSync(node, ["signup-codes", "--data", data], { encoding: "utf8" });
    check("kod oznaczony jako użyty", /użyty/.test(used), used.trim().split("\n").pop());

    // --- an organization
    await page.click("#vault-name");
    await page.getByRole("menuitem", { name: /Nowa organizacja/ }).click();
    await page.fill('input[aria-label="Nazwa organizacji"]', "Firma Testowa");
    await page.click('.vault-dialog button[type="submit"]');
    await page.waitForURL(/vault=/, { timeout: 20000 });
    await page.locator("#tree").waitFor({ timeout: 20000 });
    await sleep(2500);
    check("organizacja otwarta", (await page.locator("#vault-name").textContent()).includes("Firma Testowa"));

    // --- Mój kalendarz → Moje notatki (another space: reload, then the form)
    await page.click('[data-command="calendar.open"]');
    await page.locator(".cal-create").first().waitFor({ timeout: 15000 });
    await page.locator(".cal-create").first().click();
    await page.locator(".cal-target").waitFor();
    await sleep(700); await page.screenshot({ path: path.join(shots, "2-wybor-przestrzeni.png") });
    const options = await page.locator(".cal-target-option").allTextContents();
    check("wybór pokazuje obie przestrzenie", options.length === 2 && options.some((o) => o.includes("Moje notatki")) && options.some((o) => o.includes("Firma Testowa")), options.join(" | "));
    const primary = page.locator(".cal-target ~ .modal-actions .btn-primary");
    check("bieżąca organizacja zaznaczona", (await primary.textContent()) === "Dodaj wydarzenie", await primary.textContent());
    await page.locator(".cal-target-option", { hasText: "Moje notatki" }).click();
    check("przycisk mówi o przejściu", (await primary.textContent()) === "Przejdź do przestrzeni i dodaj");
    await primary.click();
    await page.waitForURL((u) => !u.search.includes("vault=") || u.search.includes("browser-"), { timeout: 20000 });
    const title = page.locator('input[aria-label="Tytuł"]');
    await title.waitFor({ timeout: 20000 });
    await page.screenshot({ path: path.join(shots, "3-formularz-moje.png") });
    await title.fill("Dentysta");
    await page.getByRole("button", { name: "Zapisz" }).click();
    await sleep(1500);
    check("w Moich notatkach powstał Kalendarz", await page.locator(".tree-row", { hasText: "Kalendarz" }).count() > 0);
    check("wydarzenie na kalendarzu", (await page.locator("#calendar").textContent()).includes("Dentysta"));

    // --- Mój kalendarz → Firma Testowa (reload into the org, the org's event form)
    await page.click('[data-command="calendar.open"]');
    await page.locator(".cal-create").first().waitFor({ timeout: 15000 });
    await sleep(500);
    const mine = (await page.locator("#calendar").textContent()).includes("Dentysta");
    check("Mój kalendarz pokazuje wydarzenie z Moich notatek", mine);
    await page.locator(".cal-create").first().click();
    await page.locator(".cal-target-option", { hasText: "Firma Testowa" }).click();
    await page.locator(".cal-target ~ .modal-actions .btn-primary").click();
    await page.waitForURL(/vault=/, { timeout: 20000 });
    await page.locator(".modal-module h2", { hasText: "Nowe wydarzenie" }).waitFor({ timeout: 25000 });
    await page.screenshot({ path: path.join(shots, "4-formularz-org.png") });
    await page.locator(".modal-module label", { hasText: "Nazwa" }).first().locator("input").fill("Spotkanie zespołu");
    await page.locator(".modal-module .btn-primary", { hasText: "Zapisz" }).click();
    await sleep(2000);
    check("wydarzenie w kalendarzu organizacji", (await page.locator("body").textContent()).includes("Spotkanie zespołu"));

    // --- delete the organization
    await page.click("#vault-name");
    await page.getByRole("menuitem", { name: /Członkowie i zaproszenia/ }).click();
    await page.locator(".vault-danger").waitFor({ timeout: 15000 });
    await page.locator(".vault-danger").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, "5-usun-organizacje.png") });
    await page.locator(".vault-danger button").click();
    const ok = page.locator(".modal-confirm .btn-danger");
    check("usuwanie zablokowane bez nazwy", await ok.isDisabled());
    await page.fill('.modal-confirm input[aria-label="Nazwa do potwierdzenia"]', "Firma Testowa");
    await sleep(700); await page.screenshot({ path: path.join(shots, "6-potwierdzenie.png") });
    await ok.click();
    await page.waitForURL((u) => !u.search.includes("vault=v") , { timeout: 20000 }).catch(() => undefined);
    await page.locator("#tree").waitFor({ timeout: 20000 });
    await sleep(2000);
    check("po usunięciu wraca do Moich notatek", (await page.locator("#vault-name").textContent()).includes("Moje notatki"), await page.locator("#vault-name").textContent());
    const list = await page.evaluate(async () => (await (await fetch("/api/vaults")).json()).vaults.length);
    check("serwer nie ma już organizacji", list === 0, String(list));
    await page.screenshot({ path: path.join(shots, "7-po-usunieciu.png") });

    // --- closed / open server text check for a signed-out visitor
    const page2 = await browser.newPage();
    await page2.goto(url);
    const me = await page2.evaluate(async () => (await fetch("/api/auth/me")).json());
    check("/api/auth/me podaje tryb rejestracji", me.registration === "invite", JSON.stringify(me));
    check("brak błędów strony", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("przebieg bez wyjątku", false, String(e).slice(0, 400));
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) await pages[0].screenshot({ path: path.join(shots, "blad.png") }).catch(() => undefined);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})();
