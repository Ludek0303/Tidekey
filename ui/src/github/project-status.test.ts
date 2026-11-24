// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubLink } from "./link";
import { renderGithubStatus, relativeTime } from "./project-status";
import type { GithubService } from "./service";

const PROJECT = "Projekty/Alfa";
const SHA = "abc1234def5678901234567890123456789012ab";
const HOUR = 3_600_000;
const link = (over: Partial<GithubLink> = {}): GithubLink => ({
  id: "a".repeat(32), projectPath: PROJECT, repo: "owner/repo", ref: "main", repoPath: "", target: "GitHub", include: ["**/*.md"],
  onDelete: "keep", allowEdits: true, lastCommit: SHA, lastAppliedAt: Date.now() - 2 * HOUR, lastAppliedBy: null, files: {},
  ignored: [], status: "ok", rev: 3, ...over,
});

// The fake keeps its links in `list`, so a redraw after an action sees what the action changed.
function fakeService(list: GithubLink[], over: Partial<GithubService> = {}): GithubService {
  return {
    preview: vi.fn(),
    connect: vi.fn(),
    links: vi.fn(async () => list.map((l) => ({ ...l }))),
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
    ...over,
  } as GithubService;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("relativeTime", () => {
  it("speaks in Polish units", () => {
    const now = Date.now();
    expect(relativeTime(now - 10_000, now)).toBe("przed chwilą");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min temu");
    expect(relativeTime(now - 2 * HOUR - 1000, now)).toBe("2 h temu");
    expect(relativeTime(now - 3 * 24 * HOUR, now)).toBe("3 d temu");
  });
});

describe("project status", () => {
  it("shows one row per link: repository, branch, commit and time", async () => {
    const host = document.createElement("div");
    await renderGithubStatus(host, PROJECT, fakeService([link()]));
    const line = host.querySelector(".gh-line")!.textContent;
    expect(line).toBe("GitHub: owner/repo · main · abc1234 · 2 h temu");
    expect(host.querySelector(".gh-status")).toBeNull();
  });

  it("says that nothing was imported yet and highlights a status that is not ok", async () => {
    const host = document.createElement("div");
    await renderGithubStatus(host, PROJECT, fakeService([link({ lastAppliedAt: null, lastCommit: null, status: "limit do 15:00" })]));
    expect(host.querySelector(".gh-line")!.textContent).toContain("jeszcze nie zaimportowano");
    const status = host.querySelector(".gh-status")!;
    expect(status.textContent).toBe("limit do 15:00");
    expect(status.classList.contains("is-warning")).toBe(true);
  });

  it("draws nothing when the project has no link", async () => {
    const host = document.createElement("div");
    host.append("stare");
    await renderGithubStatus(host, PROJECT, fakeService([]));
    expect(host.children.length).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("checks now with the service and draws the new status", async () => {
    const list = [link()];
    const service = fakeService(list, {
      checkNow: vi.fn(async () => {
        list[0].status = "konflikt: 1 plik";
        return "konflikt: 1 plik";
      }),
    });
    const host = document.createElement("div");
    await renderGithubStatus(host, PROJECT, service);
    button(host, "Sprawdź teraz").click();
    await flush();
    await flush();
    expect(service.checkNow).toHaveBeenCalledWith(list[0].id);
    expect(host.querySelector(".gh-status")!.textContent).toBe("konflikt: 1 plik");
  });

  it("opens the repository on GitHub in a new window", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const host = document.createElement("div");
    await renderGithubStatus(host, PROJECT, fakeService([link({ repoPath: "docs" })]));
    button(host, "Otwórz na GitHubie").click();
    expect(open).toHaveBeenCalledWith("https://github.com/owner/repo/tree/main/docs", "_blank", "noopener,noreferrer");
  });

  it("disconnects only after the confirmation", async () => {
    const list = [link()];
    const id = list[0].id;
    const service = fakeService(list, { disconnect: vi.fn(async () => { list.length = 0; }) });
    const host = document.createElement("div");
    await renderGithubStatus(host, PROJECT, service);
    button(host, "Odłącz").click();
    await flush();
    const dialog = document.querySelector(".modal")!;
    expect(dialog.textContent).toContain("Notatki zostaną jako zwykłe notatki projektu i przestaną się aktualizować.");
    expect(service.disconnect).not.toHaveBeenCalled();
    button(dialog as HTMLElement, "Odłącz").click();
    await flush();
    await flush();
    expect(service.disconnect).toHaveBeenCalledWith(id);
    expect(host.children.length).toBe(0);
  });

  it("restores an ignored file from the settings window", async () => {
    const list = [link({ ignored: ["stare/a.md"] })];
    const service = fakeService(list);
    const host = document.createElement("div");
    await renderGithubStatus(host, PROJECT, service);
    button(host, "Ustawienia").click();
    await flush();
    button(document.querySelector<HTMLElement>(".modal")!, "Przywróć z GitHuba").click();
    await flush();
    expect(service.restoreIgnored).toHaveBeenCalledWith(list[0].id, "stare/a.md");
  });
});
