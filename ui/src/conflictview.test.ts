// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Bridge } from "./bridge";
import { conflictBanner, openConflict, openConflictScreen } from "./conflictview";

const texts = { ours: "moja linia\nwspólna\n", theirs: "obca linia\nwspólna\n", theirs_hash: "h1" };

describe("conflict screen", () => {
  it("shows a banner that opens the screen", () => {
    const onOpen = vi.fn();
    const bar = conflictBanner(onOpen);
    expect(bar.getAttribute("role")).toBe("alert");
    bar.querySelector<HTMLButtonElement>("button")!.click();
    expect(onOpen).toHaveBeenCalled();
  });

  it("takes the disk's text as a whole when asked", async () => {
    const call = vi.fn(async (cmd: string) => (cmd === "conflict_texts" ? texts : undefined));
    const done = vi.fn();
    await openConflict({ call } as unknown as Bridge, "a", done);
    const button = [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Weź wersję z dysku")!;
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(call).toHaveBeenCalledWith("resolve_conflict", { id: "a", text: texts.theirs, seen: "h1" });
    expect(done).toHaveBeenCalled();
  });

  it("applies the choice made for each differing block", async () => {
    const call = vi.fn(async (cmd: string) => (cmd === "conflict_texts" ? texts : undefined));
    await openConflict({ call } as unknown as Bridge, "a", () => {});
    const dialog = document.querySelector(".modal")!;
    const radios = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"][value="theirs"]');
    radios[0].checked = true;
    radios[0].dispatchEvent(new Event("change"));
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Zastosuj wybór")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(call).toHaveBeenLastCalledWith("resolve_conflict", { id: "a", text: "obca linia\nwspólna\n", seen: "h1" });
  });
});

describe("conflict view after a change in the file", () => {
  it("is made again with the texts as they are now", async () => {
    const stale = Object.assign(new Error("Plik zmienił się od otwarcia porównania — wybierz jeszcze raz."), {
      kind: "conflict_changed",
    });
    const call = vi.fn(async (cmd: string) => {
      if (cmd === "conflict_texts") return texts;
      if (cmd === "resolve_conflict") throw stale;
      return undefined;
    });
    await openConflict({ call } as unknown as Bridge, "a", () => {});
    const button = [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Weź wersję z dysku")!;
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(call.mock.calls.filter(([cmd]) => cmd === "conflict_texts")).toHaveLength(2);
  });
});

describe("conflict screen for any source", () => {
  it("shows the labels the source passes", async () => {
    document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    const source = {
      texts: async () => ({ ours: "moja\n", theirs: "obca\n" }),
      resolve: vi.fn(async () => {}),
      labels: { ours: "Notatnik", theirs: "GitHub (abc1234)" },
      buttons: { ours: "Zostaw", theirs: "Weź" },
      title: "Konflikt z GitHubem",
    };
    await openConflictScreen(source, () => {});
    const sides = [...document.querySelectorAll<HTMLElement>(".modal .conflict-side > span")].map((s) => s.textContent);
    expect(sides).toEqual(["Notatnik", "GitHub (abc1234)"]);
    expect(document.querySelector(".modal .sr-only")!.textContent).toBe("Konflikt z GitHubem");
  });
});
