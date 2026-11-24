// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoLoadImages, customAccentVars, getSetting, openSettings, setSetting, sourceItem } from "./settings";
import { Toolbar } from "./toolbar";
import { EditorView } from "@codemirror/view";

// The dictation pane's storage and controller, replaced: no OPFS or worker in jsdom.
const store = vi.hoisted(() => ({ usage: vi.fn(async () => 0), removeAll: vi.fn(async () => {}) }));
const controller = vi.hoisted(() => ({ stopDictation: vi.fn() }));
vi.mock("./voice/modelstore", () => store);
vi.mock("./voice/controller", () => controller);

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const category = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".settings-cat")].find((b) => b.textContent === name)!;
const escape = () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

beforeEach(() => {
  localStorage.clear();
  setSetting("showToolbar", true);
  setSetting("theme", "dark");
  setSetting("accent", "violet");
  setSetting("textWidth", 760);
  setSetting("spellcheck", true);
  setSetting("writingLanguage", "pl");
});

afterEach(() => {
  // Closes a dialog left open by a test, so the next openSettings works.
  if (dialog()) escape();
  document.body.innerHTML = "";
});

describe("settings modal", () => {
  it("opening it focuses the dialog", () => {
    openSettings();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("Esc closes it and returns focus to the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    openSettings();
    escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("changing the theme updates data-theme and survives a reload of the module", async () => {
    openSettings();
    category("Wygląd").click();
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Motyw"]')!;
    select.value = "light";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("light");
    escape();

    vi.resetModules();
    const fresh = await import("./settings");
    expect(fresh.getSetting("theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("an organization's general pane has no activity visibility choice", async () => {
    openSettings("", { kind: "organizacja", handle: "", setKind: async () => {}, setHandle: async () => {}, taskRetention: async () => ({ months: 0, canEdit: true }), setTaskRetention: async () => {} });
    category("Ogólne").click();
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="Usuwanie ukończonych zadań"]')).not.toBeNull());
    expect(document.body.textContent).not.toContain("Kto widzi aktywność");
  });

  it("the toolbar toggle in Edytor hides the formatting toolbar", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const toolbar = new Toolbar(host, () => ({}) as EditorView);
    toolbar.setActive(true);
    expect(host.hidden).toBe(false);

    openSettings();
    category("Edytor").click();
    document.querySelector<HTMLInputElement>('input[aria-label="Pokaż pasek formatowania"]')!.click();
    expect(getSetting("showToolbar")).toBe(false);
    expect(host.hidden).toBe(true);
  });
});

describe("account pane", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const info = (accountName = "Ola", lastName = "Kowalska") => ({ kind: "notatki" as const, handle: "", accountName, setAccountName: vi.fn(async () => undefined), setKind: async () => undefined, setHandle: async () => undefined, lastName: { load: vi.fn(async () => lastName), save: vi.fn(async () => undefined) } });
  const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label)!;
  // The server's account: the last name is "Kowalska" until a PATCH changes it.
  function server(lastName = "Kowalska") {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/export") return new Response('{"user":{}}', { status: 200, headers: { "content-type": "application/json" } });
      if (init?.method === "PATCH") return json({ user: { id: "u1", name: "Ola", lastName: JSON.parse(init.body as string).lastName } });
      return json({ user: { id: "u1", email: "a@example.test", name: "Ola", lastName } });
    });
  }
  const patches = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("shows the display name and the last name, and saves a changed last name through the account bridge", async () => {
    const status = info();
    openSettings("", status);
    category("Konto").click();
    await vi.waitFor(() => expect(field("Nazwisko (opcjonalne)").value).toBe("Kowalska"));
    expect(field("Imię lub nazwa wyświetlana").value).toBe("Ola");
    field("Nazwisko (opcjonalne)").value = "Nowak";
    button("Zapisz zmiany").click();
    await vi.waitFor(() => expect(status.lastName.save).toHaveBeenCalledWith("Nowak"));
  });

  it("removes the last name by saving an empty one", async () => {
    const status = info();
    openSettings("", status);
    category("Konto").click();
    await vi.waitFor(() => expect(field("Nazwisko (opcjonalne)").value).toBe("Kowalska"));
    button("Usuń nazwisko").click();
    await vi.waitFor(() => expect(status.lastName.save).toHaveBeenCalledWith(""));
    expect(field("Nazwisko (opcjonalne)").value).toBe("");
  });

  it("does not send an invalid display name", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const status = info();
    openSettings("", status);
    category("Konto").click();
    field("Imię lub nazwa wyświetlana").value = "<b>";
    button("Zapisz zmiany").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Imię lub nazwa wyświetlana: do 64"));
    expect(status.setAccountName).not.toHaveBeenCalled();
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it("downloads the export as a dated JSON file", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:test");
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    let download = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { download = this.download; });
    openSettings("", info());
    category("Konto").click();
    button("Pobierz moje dane").click();
    await vi.waitFor(() => expect(download).not.toBe(""));
    expect(download).toMatch(/^notes-moje-dane-\d{4}-\d{2}-\d{2}\.json$/);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/export", expect.anything());
    expect(URL.createObjectURL).toHaveBeenCalled();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it("offers Moje notatki on request, shows the wait, and nothing once allowed", async () => {
    const devices = (personal: string) => ({ user: { id: "u1", personal } }) as unknown as Parameters<typeof openSettings>[2];
    const close = () => document.querySelector<HTMLButtonElement>(".settings-close")!.click();
    for (const [state, expected] of [["off", "Poproś o własne notatki"], ["requested", "Czeka na zgodę administratora serwera."]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => json({ authenticated: true, user: { id: "u1", email: "a@example.test", name: "Ola", personal: state } })));
      openSettings("", info(), devices("allowed"));
      category("Konto").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Własne notatki"));
      expect(document.body.textContent).toContain(expected);
      close();
    }
    const bridge = devices("off");
    vi.stubGlobal("fetch", vi.fn(async () => json({ authenticated: true, user: { id: "u1", email: "a@example.test", name: "Ola", personal: "allowed" } })));
    openSettings("", info(), bridge);
    category("Konto").click();
    await vi.waitFor(() => expect((bridge as unknown as { user: { personal: string } }).user.personal).toBe("allowed"));
    expect(document.body.textContent).not.toContain("Własne notatki");
  });

  it("shows the server's message when account deletion is blocked", async () => {
    const message = "Jesteś właścicielem organizacji Firma. Przekaż własność albo napisz do operatora.";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return json({ message }, 409);
      return json({ user: { id: "u1", name: "Ola", lastName: "" } });
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    openSettings("", info());
    category("Konto").click();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Usuń konto")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain(message));
  });
});

describe("automatic image loading", () => {
  it("is on by default and the getter follows the setting", () => {
    expect(autoLoadImages()).toBe(true);
    setSetting("autoLoadImages", false);
    expect(autoLoadImages()).toBe(false);
    expect(getSetting("autoLoadImages")).toBe(false);
    setSetting("autoLoadImages", true);
  });

  it("is a switch in the Edytor pane", () => {
    openSettings();
    category("Edytor").click();
    const toggle = document.querySelector<HTMLInputElement>('input[aria-label="Automatycznie wczytuj obrazy"]')!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(autoLoadImages()).toBe(false);
    escape();
  });
});

describe("appearance pane: accent and note width", () => {
  const radio = (name: string) => document.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${name}"]`)!;
  const widthSelect = () => document.querySelector<HTMLSelectElement>('select[aria-label="Szerokość tekstu"]')!;
  const widthInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Własna szerokość w pikselach"]')!;
  const choose = (el: HTMLInputElement | HTMLSelectElement, value?: string) => {
    if (value !== undefined) el.value = value;
    el.dispatchEvent(new Event("change"));
  };
  const open = () => {
    openSettings();
    category("Wygląd").click();
  };

  it("offers at least eight accents in a labelled radiogroup", () => {
    open();
    const group = document.querySelector('[role="radiogroup"][aria-label="Kolor akcentu"]')!;
    expect(group.querySelectorAll('input[type="radio"]').length).toBeGreaterThanOrEqual(8);
    expect(radio("Fiolet").checked).toBe(true);
  });

  it("choosing an accent sets data-accent, saves it and applies it after a reload", async () => {
    open();
    radio("Niebieski").click();
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(JSON.parse(localStorage.getItem("notes.settings.v1")!).accent).toBe("blue");
    escape();

    vi.resetModules();
    await import("./settings");
    expect(document.documentElement.dataset.accent).toBe("blue");
  });

  it("a stored unknown accent falls back to violet", async () => {
    localStorage.setItem("notes.settings.v1", JSON.stringify({ accent: "neon" }));
    vi.resetModules();
    const fresh = await import("./settings");
    expect(fresh.getSetting("accent")).toBe("violet");
  });

  it("the width presets set --measure and save; full width is 100vw", () => {
    open();
    choose(widthSelect(), "600");
    expect(document.documentElement.style.getPropertyValue("--measure")).toBe("600px");
    expect(getSetting("textWidth")).toBe(600);
    choose(widthSelect(), "0");
    expect(document.documentElement.style.getPropertyValue("--measure")).toBe("100vw");
    expect(getSetting("textWidth")).toBe(0);
  });

  it("a custom width is clamped to 400–2000 px and shown as its own choice", () => {
    open();
    choose(widthInput(), "1500");
    expect(getSetting("textWidth")).toBe(1500);
    expect(document.documentElement.style.getPropertyValue("--measure")).toBe("1500px");
    expect(widthSelect().value).toBe("custom");

    choose(widthInput(), "5000");
    expect(getSetting("textWidth")).toBe(2000);
    expect(widthInput().value).toBe("2000");
  });
});

describe("custom accent colour", () => {
  it("derives the variants from one colour and picks black or white text by contrast", () => {
    expect(customAccentVars("#12a4b6", true)).toMatchObject({ "--accent-solid": "#12a4b6", "--on-accent": "#000000" });
    expect(customAccentVars("#7052c7", true)["--on-accent"]).toBe("#ffffff");
    expect(customAccentVars("#12a4b6", false)["--accent"]).not.toBe(customAccentVars("#12a4b6", true)["--accent"]);
  });

  it("the native colour field selects it, applies it inline and saves it", () => {
    openSettings();
    [...document.querySelectorAll<HTMLButtonElement>(".settings-cat")].find((b) => b.textContent === "Wygląd")!.click();
    const picker = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    picker.value = "#12a4b6";
    picker.dispatchEvent(new Event("input"));
    expect(document.documentElement.dataset.accent).toBe("custom");
    expect(document.documentElement.style.getPropertyValue("--accent-solid")).toBe("#12a4b6");
    expect(JSON.parse(localStorage.getItem("notes.settings.v1")!)).toMatchObject({ accent: "custom", customAccent: "#12a4b6" });
    expect(document.querySelector<HTMLInputElement>('input[type="radio"][aria-label="Własny kolor"]')!.checked).toBe(true);
    escape();
    setSetting("accent", "blue");
    expect(document.documentElement.style.getPropertyValue("--accent-solid")).toBe("");
  });
});

describe("backup section", () => {
  it("renders the copy button and the plain-text warning", () => {
    openSettings();
    category("Kopia zapasowa").click();
    const pane = document.querySelector<HTMLElement>(".settings-pane")!;
    expect([...pane.querySelectorAll("button")].map((b) => b.textContent)).toContain("Pobierz kopię zapasową");
    expect(pane.textContent).toContain("Kopia zawiera notatki w postaci jawnej (niezaszyfrowanej). Przechowuj ją bezpiecznie.");
  });
});

describe("dictation settings", () => {
  const tauri = window as unknown as Record<string, unknown>;
  const categoryNames = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-cat")].map((b) => b.textContent);
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

  beforeEach(() => {
    store.usage.mockResolvedValue(0);
    store.removeAll.mockClear();
    controller.stopDictation.mockClear();
  });
  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
  });

  it("is a category in the browser and not in the desktop app", () => {
    openSettings();
    expect(categoryNames()).toContain("Dyktowanie");
    escape();
    tauri.__TAURI_INTERNALS__ = {};
    openSettings();
    expect(categoryNames()).not.toContain("Dyktowanie");
  });

  it("says when no model is stored, and the removal is off", async () => {
    openSettings();
    category("Dyktowanie").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Nie pobrano"));
    expect(button("Usuń pobrany model").disabled).toBe(true);
  });

  it("shows the stored size and removes the model after confirmation", async () => {
    store.usage.mockResolvedValue(312_400_000);
    openSettings();
    category("Dyktowanie").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Parakeet Ultra: 312 MB na tym urządzeniu"));

    store.usage.mockResolvedValue(0);
    button("Usuń pobrany model").click();
    await vi.waitFor(() => expect(document.querySelector(".modal-confirm")).not.toBeNull());
    [...document.querySelector(".modal-confirm")!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Usuń")!.click();

    await vi.waitFor(() => expect(store.removeAll).toHaveBeenCalledTimes(1));
    expect(controller.stopDictation).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Nie pobrano"));
  });
});

describe("licences in the about pane", () => {
  it("lists the dictation model and libraries next to the interface licences", async () => {
    openSettings();
    category("O programie").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("parakeet.js"));
    for (const text of ["Licencje", "CC BY 4.0", "Silero VAD", "ONNX Runtime Web"]) expect(document.body.textContent).toContain(text);
  });
});

describe("licence notices in the about pane", () => {
  const pressed = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  const link = (text: string) => [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === text)!;
  // The notices dialog opens on top of Settings, so the top dialog is the one under test.
  const topDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].pop();
  const openAbout = () => {
    openSettings();
    category("O programie").click();
  };
  // Closes both dialogs, so a failed assertion cannot leave Settings open for the next test (openSettings is a no-op then).
  afterEach(() => {
    for (let i = 0; i < 3 && document.querySelector('[role="dialog"]'); i++) escape();
    vi.unstubAllGlobals();
  });

  it("opens the notices file as text in a dialog", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "NOTICE TEXT" }));
    vi.stubGlobal("fetch", fetchMock);
    openAbout();
    pressed("Pokaż licencje").click();
    await vi.waitFor(() => expect(topDialog()?.querySelector("pre")?.textContent).toBe("NOTICE TEXT"));
    expect(fetchMock).toHaveBeenCalledWith("/THIRD_PARTY_NOTICES.txt");
  });

  it("says so when the notices file cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => "" })));
    openAbout();
    pressed("Pokaż licencje").click();
    await vi.waitFor(() => expect(topDialog()?.textContent).toContain("Nie udało się wczytać pliku licencji."));
  });

  it("links the LGPL libraries to their sources in a new tab, without opener access", async () => {
    openAbout();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Biblioteki LGPL są osobnymi, niezmienionymi plikami"));
    for (const text of ["libheif-js 1.23.5 (LGPL-3.0) — źródła"]) {
      const a = link(text);
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
      expect(a.href).toMatch(/^https:\/\//);
    }
  });

  it("names the AGPL, links its text, says the project is still developed, and links the source of this version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ commit: "abc123def4567890", source: "https://example.test/notatki" }) })));
    openAbout();
    const text = () => document.body.textContent ?? "";
    expect(text()).toContain("GNU Affero General Public License w wersji 3 lub nowszej");
    expect(text()).toContain("Projekt jest wciąż rozwijany");
    expect(link("Treść licencji (po angielsku)").getAttribute("href")).toBe("/LICENSE");
    await vi.waitFor(() => expect(text()).toContain("Serwer: wersja abc123def456"));
    const server = [...document.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.textContent === "kod źródłowy tej wersji").pop()!;
    expect(server.href).toBe("https://example.test/notatki/tree/abc123def4567890");
  });

  it("a part without a known repository says so instead of a dead link", () => {
    expect(sourceItem("Ta aplikacja", "", "").textContent).toBe("Ta aplikacja: ta kompilacja nie ma zapisanego adresu kodu źródłowego.");
    expect(sourceItem("Serwer", "0123456789abcdef", "").textContent).toContain("wersja 0123456789ab");
  });

  it("the LGPL links match vendor/lgpl/MANIFEST.json when that file exists", async () => {
    const manifestPath = new URL("../../vendor/lgpl/MANIFEST.json", import.meta.url);
    if (!existsSync(manifestPath)) return;
    const packages = JSON.parse(readFileSync(manifestPath, "utf8")) as { package: string; version: string; license: string; source: string }[];
    openAbout();
    for (const pkg of packages) expect(link(`${pkg.package} ${pkg.version} (${pkg.license}) — źródła`).href).toBe(pkg.source);
  });
});

describe("writing settings in the Edytor pane", () => {
  it("spellcheck is a switch and the language a select, and both are saved", () => {
    openSettings();
    category("Edytor").click();
    const sw = document.querySelector<HTMLInputElement>('input[aria-label="Sprawdzanie pisowni i autokorekta"]')!;
    expect(sw.checked).toBe(true);
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    expect(getSetting("spellcheck")).toBe(false);

    const lang = document.querySelector<HTMLSelectElement>('select[aria-label="Język pisania"]')!;
    expect([...lang.options].map((o) => o.textContent)).toEqual(["Polski", "Angielski (USA)", "Angielski (UK)", "Niemiecki", "Ukraiński"]);
    lang.value = "uk";
    lang.dispatchEvent(new Event("change"));
    expect(getSetting("writingLanguage")).toBe("uk");
    escape();
  });

  it("a stored unknown language falls back to Polish, and a stored spellcheck value is kept", async () => {
    localStorage.setItem("notes.settings.v1", JSON.stringify({ writingLanguage: "xx", spellcheck: false }));
    vi.resetModules();
    const fresh = await import("./settings");
    expect(fresh.getSetting("writingLanguage")).toBe("pl");
    expect(fresh.getSetting("spellcheck")).toBe(false);
  });
});

describe("template and daily note settings in the Pliki i linki pane", () => {
  it("shows the template folder (Szablony), the daily folder (root) and the daily template (empty)", () => {
    openSettings();
    category("Pliki i linki").click();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder szablonów"]')!.value).toBe("Szablony");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder notatek dziennych"]')!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Szablon notatki dziennej"]')!.value).toBe("");
  });

  it("a change is saved and read back after a reload of the module", async () => {
    openSettings();
    category("Pliki i linki").click();
    const folder = document.querySelector<HTMLInputElement>('input[aria-label="Folder szablonów"]')!;
    folder.value = " Wzory ";
    folder.dispatchEvent(new Event("change"));
    escape();

    vi.resetModules();
    const fresh = await import("./settings");
    expect(fresh.getSetting("templateFolder")).toBe("Wzory");
  });

  it("a stored value of the wrong type falls back to the default", async () => {
    localStorage.setItem("notes.settings.v1", JSON.stringify({ templateFolder: 3, dailyTemplate: null }));
    vi.resetModules();
    const fresh = await import("./settings");
    expect(fresh.getSetting("templateFolder")).toBe("Szablony");
    expect(fresh.getSetting("dailyTemplate")).toBe("");
  });
});

describe("heading rail setting", () => {
  it("the editor pane offers right, left and off, and a choice is stored", () => {
    openSettings();
    category("Edytor").click();
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Konspekt przy krawędzi edytora"]')!;
    expect([...select.options].map((o) => o.value)).toEqual(["right", "left", "off"]);
    expect(select.value).toBe("right");
    select.value = "off";
    select.dispatchEvent(new Event("change"));
    expect(getSetting("headingRail")).toBe("off");
    escape();
    setSetting("headingRail", "right");
  });
});
