// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderError, openConnectDialog, openSettingsDialog, openTokenDialog } from "./connect-view";
import type { GithubLink } from "./link";
import type { ConnectOptions, GithubService, RepoPreview } from "./service";

const PROJECT = "Projekty/Alfa";
const preview: RepoPreview = {
  repo: "owner/repo", ref: null, repoPath: "", defaultBranch: "main", private: false, markdownFiles: 12, totalBytes: 2048, skipped: 1,
};
const link = (over: Partial<GithubLink> = {}): GithubLink => ({
  id: "0".repeat(32), projectPath: PROJECT, repo: "owner/old", ref: null, repoPath: "", target: "GitHub", include: ["**/*.md"],
  onDelete: "keep", allowEdits: true, lastCommit: null, lastAppliedAt: null, lastAppliedBy: null, files: {}, ignored: [],
  status: "ok", rev: 1, ...over,
});

function fakeService(over: Partial<GithubService> = {}): GithubService {
  const service: GithubService = {
    preview: vi.fn(async () => ({ ok: true as const, value: preview })),
    connect: vi.fn(async (_path: string, o: ConnectOptions) => link({ id: "1".repeat(32), repo: o.repo, target: o.target })),
    links: vi.fn(async () => []),
    checkNow: vi.fn(async () => "ok"),
    saveSettings: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    restoreIgnored: vi.fn(async () => {}),
    noteInfo: vi.fn(async () => null),
    baseText: vi.fn(async () => null),
    conflict: vi.fn(async () => null),
    resolveConflict: vi.fn(async () => {}),
    hasToken: vi.fn(() => false),
    setToken: vi.fn(async () => {}),
    detachNote: vi.fn(async () => {}),
    ...over,
  };
  return service;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const modal = () => document.querySelector<HTMLElement>(".modal")!;
const button = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
// the input of a labelled field, e.g. field("Gałąź")
const field = (text: string) =>
  [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === text)!.querySelector("input")!;
const radio = (text: string) =>
  [...document.querySelectorAll("label")].find((l) => l.textContent === text)!.querySelector("input")!;
// the radio of a mode choice (the option's label is "gh-choice")
const modeRadio = (text: string) =>
  [...document.querySelectorAll<HTMLLabelElement>("label.gh-choice")].find((l) => l.textContent === text)!.querySelector("input")!;


afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("folderError", () => {
  it("refuses .., backslashes, colons and empty parts, and strips slashes at the ends", () => {
    expect(folderError("GitHub", false)).toBeNull();
    expect(folderError("/GitHub/", false)).toBeNull();
    expect(folderError("../x", false)).toMatch(/\.\./);
    expect(folderError("a\\b", false)).toMatch(/\\/);
    expect(folderError("C:x", false)).toMatch(/:/);
    expect(folderError("a//b", false)).not.toBeNull();
    expect(folderError("", false)).toBe("Podaj nazwę folderu.");
    expect(folderError("", true)).toBeNull();
  });
});

describe("connect window", () => {
  it("shows the preview card after a check", async () => {
    const service = fakeService();
    void openConnectDialog(PROJECT, service);
    await flush();
    field("Adres repozytorium").value = "owner/repo";
    button("Sprawdź").click();
    await flush();
    expect(service.preview).toHaveBeenCalledWith("owner/repo");
    const text = modal().textContent ?? "";
    expect(text).toContain("owner/repo");
    expect(text).toContain("main (domyślna)");
    expect(text).toContain("publiczne");
    expect(text).toContain("12");
    expect(text).toContain("2 KB");
    expect(text).toContain("1");
    expect(button("Importuj").disabled).toBe(false);
  });

  it("shows the service's message when the check fails and keeps Importuj off", async () => {
    const service = fakeService({
      preview: vi.fn(async () => ({ ok: false as const, message: "Nie ma takiego repozytorium albo jest prywatne. Dla prywatnego dodaj token." })),
    });
    void openConnectDialog(PROJECT, service);
    await flush();
    field("Adres repozytorium").value = "https://github.com/x/y";
    button("Sprawdź").click();
    await flush();
    expect(modal().querySelector('[role="alert"]')?.textContent).toBe("Nie ma takiego repozytorium albo jest prywatne. Dla prywatnego dodaj token.");
    expect(button("Importuj").disabled).toBe(true);
  });

  it("imports with the default settings and returns the link", async () => {
    const service = fakeService();
    const result = openConnectDialog(PROJECT, service);
    await flush();
    field("Adres repozytorium").value = "owner/repo";
    button("Sprawdź").click();
    await flush();
    button("Importuj").click();
    await flush();
    expect(service.connect).toHaveBeenCalledWith(PROJECT, {
      repo: "owner/repo", ref: null, repoPath: "", target: "GitHub", onDelete: "keep", allowEdits: true,
    });
    const made = await result;
    expect(made?.repo).toBe("owner/repo");
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("imports with the changed settings", async () => {
    const service = fakeService();
    const result = openConnectDialog(PROJECT, service);
    await flush();
    field("Adres repozytorium").value = "owner/repo";
    button("Sprawdź").click();
    await flush();
    field("Gałąź").value = "dev";
    field("Podfolder repozytorium").value = "docs";
    field("Folder w projekcie").value = "GitHub/inne";
    radio("Do kosza").checked = true;
    modeRadio("Tylko odczyt").checked = true;
    button("Importuj").click();
    await flush();
    expect(service.connect).toHaveBeenCalledWith(PROJECT, {
      repo: "owner/repo", ref: "dev", repoPath: "docs", target: "GitHub/inne", onDelete: "trash", allowEdits: false,
    });
    await result;
  });

  it("refuses a bad folder without calling the service", async () => {
    const service = fakeService();
    void openConnectDialog(PROJECT, service);
    await flush();
    field("Adres repozytorium").value = "owner/repo";
    button("Sprawdź").click();
    await flush();
    field("Folder w projekcie").value = "../poza";
    button("Importuj").click();
    await flush();
    expect(service.connect).not.toHaveBeenCalled();
    expect(modal().querySelector('[role="alert"]')?.textContent).toMatch(/\.\./);
  });

  it("suggests GitHub/<repo> when the project already has a connection", async () => {
    const service = fakeService({ links: vi.fn(async () => [link()]) });
    void openConnectDialog(PROJECT, service);
    await flush();
    field("Adres repozytorium").value = "owner/repo";
    button("Sprawdź").click();
    await flush();
    expect(field("Folder w projekcie").value).toBe("GitHub/repo");
  });

  it("runs the check at once when an address is given", async () => {
    const service = fakeService();
    void openConnectDialog(PROJECT, service, "owner/repo");
    await flush();
    expect(service.preview).toHaveBeenCalledWith("owner/repo");
    expect(button("Importuj").disabled).toBe(false);
  });

  it("returns null when cancelled", async () => {
    const service = fakeService();
    const result = openConnectDialog(PROJECT, service);
    await flush();
    button("Anuluj").click();
    expect(await result).toBeNull();
    expect(service.connect).not.toHaveBeenCalled();
  });
});

describe("token window", () => {
  it("saves a token without showing it and clears the field", async () => {
    const service = fakeService();
    openTokenDialog(service);
    const input = modal().querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.value).toBe("");
    input.value = "github_pat_SEKRET";
    button("Zapisz token").click();
    await flush();
    expect(service.setToken).toHaveBeenCalledWith("github_pat_SEKRET");
    expect(document.body.textContent).not.toContain("github_pat_SEKRET");
    expect(document.body.innerHTML).not.toContain("github_pat_SEKRET");
  });

  it("removes a saved token only when one exists", async () => {
    const none = fakeService({ hasToken: vi.fn(() => false) });
    openTokenDialog(none);
    expect(button("Usuń token")).toBeUndefined();
    button("Zamknij").click();

    const service = fakeService({ hasToken: vi.fn(() => true) });
    openTokenDialog(service);
    button("Usuń token").click();
    await flush();
    expect(service.setToken).toHaveBeenCalledWith(null);
  });

  it("opens the token page in a new window and explains the rules", () => {
    openTokenDialog(fakeService());
    const link = modal().querySelector<HTMLAnchorElement>('a[href="https://github.com/settings/personal-access-tokens/new"]')!;
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.rel).toContain("noreferrer");
    expect(modal().textContent).toContain("Only select repositories");
    expect(modal().textContent).toContain("Contents");
    expect(modal().textContent).toContain("Token jest osobisty");
  });
});

describe("link settings window", () => {
  it("saves the changed settings and restores an ignored file", async () => {
    const current = link({ ignored: ["stare/a.md"] });
    const service = fakeService();
    const saved = openSettingsDialog(current, service);
    await flush();
    expect(field("Folder w projekcie").value).toBe("GitHub");
    field("Gałąź").value = "dev";
    radio("Do kosza").checked = true;
    button("Przywróć z GitHuba").click();
    await flush();
    expect(service.restoreIgnored).toHaveBeenCalledWith(current.id, "stare/a.md");
    button("Zapisz").click();
    await flush();
    expect(service.saveSettings).toHaveBeenCalledWith({ ...current, ref: "dev", onDelete: "trash", ignored: [] });
    expect(await saved).toBe(true);
  });
});

describe("linked or read-only", () => {
  it("offers the two modes outside the collapsed Ustawienia section, with a one-line description", async () => {
    void openConnectDialog(PROJECT, fakeService());
    await flush();
    const linked = modeRadio("Połączone z GitHubem");
    expect(linked.closest("details")).toBeNull();
    expect(modeRadio("Tylko odczyt").closest("details")).toBeNull();
    expect(linked.checked).toBe(true);
    expect(modal().textContent).toContain("Notatki aktualizują się z GitHuba, a Twoje dopiski w nich zostają.");
    expect(modal().textContent).toContain("Wierna kopia z GitHuba. Zmieniasz ją tylko na GitHubie.");
  });

  it("the settings window shows the mode of the link and saves the one picked", async () => {
    const current = link({ allowEdits: true });
    const service = fakeService();
    const saved = openSettingsDialog(current, service);
    await flush();
    expect(modeRadio("Połączone z GitHubem").checked).toBe(true);
    modeRadio("Tylko odczyt").checked = true;
    button("Zapisz").click();
    await flush();
    expect(service.saveSettings).toHaveBeenCalledWith({ ...current, allowEdits: false });
    await saved;
  });
});

describe("connect from a folder", () => {
  it("leaves the folder field empty and imports the files straight into the folder", async () => {
    const service = fakeService();
    const result = openConnectDialog(PROJECT, service, "", { folder: true });
    await flush();
    field("Adres repozytorium").value = "owner/repo";
    button("Sprawdź").click();
    await flush();
    expect(field("Folder na pliki z GitHuba").value).toBe("");
    expect(modal().textContent).toContain("Puste: pliki trafiają prosto do tego folderu, obok Twoich notatek.");
    button("Importuj").click();
    await flush();
    expect(service.connect).toHaveBeenCalledWith(PROJECT, {
      repo: "owner/repo", ref: null, repoPath: "", target: "", onDelete: "keep", allowEdits: true,
    });
    await result;
  });

  it("a settings window of a link with an empty target saves it without asking for a folder", async () => {
    const current = link({ target: "" });
    const service = fakeService();
    const saved = openSettingsDialog(current, service);
    await flush();
    expect(field("Folder na pliki z GitHuba").value).toBe("");
    button("Zapisz").click();
    await flush();
    expect(service.saveSettings).toHaveBeenCalledWith(current);
    expect(await saved).toBe(true);
  });
});
