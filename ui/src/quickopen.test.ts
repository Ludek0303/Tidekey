// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickOpen, fuzzyScore, noteNameFromQuery } from "./quickopen";

const input = () => document.querySelector<HTMLInputElement>(".qo-input")!;
const key = (k: string, shiftKey = false) => input().dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event("input"));
};
afterEach(() => {
  document.body.innerHTML = "";
});

describe("fuzzyScore", () => {
  it("returns null when query chars are missing or out of order", () => {
    expect(fuzzyScore("xyz", "Projekty/Plan.md")).toBeNull();
    expect(fuzzyScore("nalp", "Plan.md")).toBeNull();
  });

  it("matches everything for an empty query", () => {
    expect(fuzzyScore("", "Plan.md")).not.toBeNull();
  });

  it("ranks a consecutive match above a scattered one", () => {
    const tight = fuzzyScore("plan", "Projekty/Plan.md")!;
    const scattered = fuzzyScore("plan", "Pomysły/Lekcja-Pracowita-Anna-N.md")!;
    expect(tight).toBeGreaterThan(scattered);
  });

  it("ranks a word-start match above a mid-word one", () => {
    const wordStart = fuzzyScore("sp", "Projekty/Spotkanie.md")!;
    const midWord = fuzzyScore("sp", "Dziennik/Aspekt.md")!;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("prefers a shorter path when everything else is equal", () => {
    expect(fuzzyScore("plan", "Plan.md")!).toBeGreaterThan(fuzzyScore("plan", "Projekty/Plan.md")!);
  });

  it("is case-insensitive and ignores spaces in the query", () => {
    expect(fuzzyScore("PLAN", "plan.md")).not.toBeNull();
    expect(fuzzyScore("pl an", "plan.md")).toBe(fuzzyScore("plan", "plan.md"));
  });

  it("never throws on empty and whitespace-only input", () => {
    expect(() => fuzzyScore("", "")).not.toThrow();
    expect(() => fuzzyScore("   ", "Plan.md")).not.toThrow();
    expect(() => fuzzyScore("plan", "")).not.toThrow();
    expect(fuzzyScore("plan", "")).toBeNull();
  });

  it("matches Polish letters, case-insensitively", () => {
    expect(fuzzyScore("zażółć", "Projekty/Zażółć gęślą jaźń.md")).not.toBeNull();
    expect(fuzzyScore("ŁÓDŹ", "Dziennik/łódź.md")).not.toBeNull();
    expect(fuzzyScore("ąę", "Ąę.md")).not.toBeNull();
  });

  it("never throws or returns a non-finite score for odd unicode input", () => {
    const alphabet = ["a", "Ż", "ł", "ś", "ź", "ń", "ó", " ", "/", "_", "-", ".", "́", "😀", "\uD800", "İ", "ß"];
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const randomStr = () => Array.from({ length: rnd(8) }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let i = 0; i < 500; i++) {
      const score = fuzzyScore(randomStr(), randomStr());
      expect(score === null || Number.isFinite(score)).toBe(true);
    }
  });
});

describe("creating a note from the query", () => {
  const items = [{ id: "1", path: "Projekty/Plan.md" }, { id: "2", path: "Notatka.md" }];

  it("trims the query and drops a trailing .md", () => {
    expect(noteNameFromQuery("  a/b/Nazwa.md ")).toBe("a/b/Nazwa");
    expect(noteNameFromQuery("Nazwa")).toBe("Nazwa");
    expect(noteNameFromQuery(".md")).toBe("");
  });

  it("Enter with nothing found creates <query>.md and says so with the name", () => {
    const onPick = vi.fn();
    const onCreate = vi.fn();
    new QuickOpen(onPick, () => {}, onCreate).open(items);
    type("Nowy pomysł");
    expect(document.querySelector(".qo-empty")!.textContent).toBe("Nie znaleziono notatki. Enter utworzy „Nowy pomysł”.");
    expect(document.querySelector<HTMLElement>(".qo-empty")!.hidden).toBe(false);
    key("Enter");
    expect(onCreate).toHaveBeenCalledWith("Nowy pomysł.md");
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector(".qo")).toBeNull();
  });

  it("Enter with matches still opens the match, Shift+Enter creates the typed note", () => {
    const onPick = vi.fn();
    const onCreate = vi.fn();
    new QuickOpen(onPick, () => {}, onCreate).open(items);
    type("plan");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith(items[0]);
    expect(onCreate).not.toHaveBeenCalled();

    new QuickOpen(onPick, () => {}, onCreate).open(items);
    type("plan");
    key("Enter", true);
    expect(onCreate).toHaveBeenCalledWith("plan.md");
  });

  it("Shift+Enter on a path that exists opens that note instead", () => {
    const onPick = vi.fn();
    const onCreate = vi.fn();
    new QuickOpen(onPick, () => {}, onCreate).open(items);
    type("notatka");
    key("Enter", true);
    expect(onPick).toHaveBeenCalledWith(items[1]);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("an empty query creates nothing, and the template picker (no creating) keeps the old text", () => {
    const onCreate = vi.fn();
    new QuickOpen(() => {}, () => {}, onCreate).open(items);
    key("Enter", true);
    expect(onCreate).not.toHaveBeenCalled();
    key("Escape");

    new QuickOpen(() => {}, () => {}).open(items, "Wstaw szablon");
    type("coś");
    expect(document.querySelector(".qo-empty")!.textContent).toBe("Nie znaleziono notatki. Spróbuj wpisać krótszą nazwę.");
    expect(document.querySelector(".qo-hint")!.textContent).not.toContain("utwórz");
    key("Enter");
    expect(document.querySelector(".qo")).not.toBeNull();
    expect(document.querySelector("#qo-title")!.textContent).toBe("Wstaw szablon");
    expect(input().placeholder).toBe("Wstaw szablon…");
  });

  it("the hint offers Shift+Enter to create", () => {
    new QuickOpen(() => {}, () => {}, () => {}).open(items);
    expect(document.querySelector(".qo-hint")!.textContent).toContain("Shift+Enter utwórz");
  });
});
