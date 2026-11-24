// Run against the browser demo: PLAYWRIGHT_PATH=/path/to/playwright node scripts/test-organizations.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const out = path.resolve("docs/organization-checks");
  fs.mkdirSync(out, { recursive: true });
  // Collapsed nav groups ("Zespół", "Moduły") are opened first, as a user would.
  const nav = async (name) => {
    await page.locator(".org-nav details:not([open]) > summary").evaluateAll((s) => s.forEach((x) => x.click()));
    await page.locator(".org-nav").getByRole("button", { name, exact: true }).click();
  };
  const dialog = () => page.getByRole("dialog");
  const save = async () => {
    await dialog().getByRole("button", { name: "Zapisz", exact: true }).click();
    await dialog().waitFor({ state: "hidden" });
  };
  try {
    await page.goto(process.env.APP_URL || "http://127.0.0.1:5174");
    await page.locator(".org-nav").waitFor();
    // the cookie notice sits over the dialogs' buttons until it is acknowledged
    const cookies = page.getByRole("button", { name: "Rozumiem", exact: true });
    if (await cookies.isVisible().catch(() => false)) await cookies.click();
    await nav("Osoby i grupy");
    await page.getByRole("button", { name: /Nowa grupa/ }).click();
    await dialog().getByLabel("Nazwa grupy").fill("Zespół E2E");
    await dialog().getByLabel("Jan", { exact: true }).check();
    await save();
    await page
      .getByRole("heading", { name: "Zespół E2E", exact: true })
      .waitFor();
    await nav("Kalendarze");
    await page.getByRole("button", { name: "Utwórz", exact: true }).click();
    await dialog()
      .getByLabel("Nazwa", { exact: true })
      .fill("Przegląd projektu");
    await dialog()
      .getByLabel("Początek", { exact: true })
      .fill("2026-10-27T10:00");
    await dialog()
      .getByLabel("Koniec", { exact: true })
      .fill("2026-10-27T11:00");
    await dialog()
      .getByLabel("Strefa czasowa", { exact: true })
      .fill("Europe/Warsaw");
    await save();
    await page.getByLabel("Data kalendarza").fill("2026-10-01");
    await page.getByRole("button", { name: /Przegląd projektu/ }).waitFor();
    await page.screenshot({ path: path.join(out, "calendar.png") });
    await nav("Inwentarze");
    await page.getByRole("button", { name: "Nowy moduł", exact: true }).click();
    await dialog().getByLabel("Nazwa", { exact: true }).fill("Laboratorium");
    await save();
    await page
      .getByRole("button", { name: "Dodaj pozycję", exact: true })
      .click();
    await dialog().getByLabel("Nazwa", { exact: true }).fill("Kontroler lotu");
    await dialog().getByLabel("Lokalizacja", { exact: true }).fill("Sala 40");
    await save();
    await page.getByRole("button", { name: "Wydaj", exact: true }).click();
    await save();
    await page.getByRole("cell", { name: "0 / 1 szt.", exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Wydaj", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Zwróć", exact: true }).click();
    await save();
    await page.getByRole("cell", { name: "1 / 1 szt.", exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, "inventory.png") });
    await nav("Dostępność");
    await page
      .getByRole("button", {
        name: "Poniedziałek 10:00: niedostępny",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Zapisz mój plan", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Poniedziałek 10:00: dostępny",
        exact: true,
      })
      .waitFor();
    await nav("Przegląd");
    await page
      .getByRole("button", { name: "Nowy projekt", exact: true })
      .click();
    await dialog().getByLabel("Nazwa projektu").fill("Audit E2E");
    await dialog().getByRole("button", { name: "Utwórz", exact: true }).click();
    const editor = page.locator(".cm-content");
    await editor.waitFor();
    await editor.click();
    const text =
      "---\ntyp: projekt\n---\n# Audit E2E\n\n- [ ] Próba historii @Jan !nadzor:@Jan !trudnosc:8 ^z-e2e";
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(text);
    await page.waitForTimeout(2000);
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(
      text.replace("[ ]", "[x]") + " ✅ 2026-10-25",
    );
    await page.waitForTimeout(2000);
    await nav("Aktywność");
    await page.locator(".activity-heatmap").waitFor();
    assert.equal(await page.locator(".heatmap-day").count(), 365);
    assert.match(
      await page.locator(".insight-summary").innerText(),
      /1 ukończonych · 8 pkt/,
    );
    await page.screenshot({ path: path.join(out, "activity.png") });
    await nav("Powiadomienia");
    await page
      .getByRole("heading", { name: "Wykonano zadanie", exact: true })
      .waitFor();
    await nav("Grafy");
    await page
      .locator(".graph-task")
      .filter({ hasText: "Próba historii" })
      .waitFor();
    await page.screenshot({ path: path.join(out, "graphs.png") });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "browser-result.json"),
      JSON.stringify(
        {
          passed: true,
          errors,
          checks: [
            "groups",
            "calendar create",
            "inventory issue/return",
            "availability save",
            "task assignment/completion",
            "activity",
            "notifications",
            "graph task nodes",
          ],
        },
        null,
        2,
      ),
    );
    console.log("Organization browser checks passed");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
