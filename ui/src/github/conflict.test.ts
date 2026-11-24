// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openGithubConflict } from "./conflict";
import type { GithubConflict, GithubService } from "./service";

const conflict: GithubConflict = {
  ours: "moja linia\nwspólna\n",
  theirs: "obca linia\nwspólna\n",
  commit: "abc1234def5678901234567890123456789abcdef",
};

function fake(c: GithubConflict | null, resolve = vi.fn(async () => {})) {
  return { conflict: vi.fn(async () => c), resolveConflict: resolve } as unknown as GithubService;
}

const modal = () => document.querySelector<HTMLElement>(".modal")!;
const button = (label: string) => [...modal().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.querySelectorAll(".modal-backdrop, .toasts").forEach((el) => el.remove());
});

describe("GitHub conflict screen", () => {
  it("names the sides with the short commit and the title", async () => {
    await openGithubConflict("n1", fake(conflict));
    const sides = [...modal().querySelectorAll<HTMLElement>(".conflict-side > span")].map((s) => s.textContent);
    expect(sides).toEqual(["Notatnik", "GitHub (abc1234)"]);
    expect(modal().querySelector(".sr-only")!.textContent).toBe("Konflikt z GitHubem");
  });

  it("takes GitHub's whole version as the new text", async () => {
    const resolve = vi.fn(async () => {});
    await openGithubConflict("n1", fake(conflict, resolve));
    button("Weź wersję z GitHuba").click();
    await flush();
    expect(resolve).toHaveBeenCalledWith("n1", conflict.theirs);
    expect(document.querySelector(".modal")).toBeNull();
    expect(document.querySelector(".toasts")!.textContent).toContain("Zapisano. Plik znowu aktualizuje się z GitHuba.");
  });

  it("merges the picked blocks into one text", async () => {
    const resolve = vi.fn(async () => {});
    await openGithubConflict("n1", fake(conflict, resolve));
    const theirs = modal().querySelector<HTMLInputElement>('input[type="radio"][value="theirs"]')!;
    theirs.checked = true;
    theirs.dispatchEvent(new Event("change"));
    button("Zastosuj wybór").click();
    await flush();
    expect(resolve).toHaveBeenCalledWith("n1", "obca linia\nwspólna\n");
  });

  it("says so when the conflict is already resolved", async () => {
    await openGithubConflict("n1", fake(null));
    expect(document.querySelector(".modal")).toBeNull();
    expect(document.querySelector(".toasts")!.textContent).toContain("Ten konflikt jest już rozwiązany.");
  });

  it("shows the error and keeps the screen open when saving fails", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("Nie udało się zapisać.");
    });
    await openGithubConflict("n1", fake(conflict, resolve));
    button("Weź wersję z GitHuba").click();
    await flush();
    expect(modal()).not.toBeNull();
    expect(document.querySelectorAll(".toast.is-error")).toHaveLength(1);
    expect(document.querySelector(".toast.is-error")!.textContent).toContain("Nie udało się zapisać.");
  });
});
