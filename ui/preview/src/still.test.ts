// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PreviewError } from "./viewers/index";
import { checkDims, showStill } from "./still";

// The code of the PreviewError that fn throws, or null when it returns.
function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof PreviewError ? err.code : "other";
  }
}

const keyEvent = (key: string): KeyboardEvent => new KeyboardEvent("keydown", { key });

describe("checkDims", () => {
  it("granice: 30 000 na bok i 100 Mpx przechodzą", () => {
    expect(codeOf(() => checkDims(30000, 1))).toBeNull();
    expect(codeOf(() => checkDims(10000, 10000))).toBeNull();
  });

  it("ponad 30 000 na bok: too-large", () => {
    expect(codeOf(() => checkDims(30001, 1))).toBe("too-large");
    expect(codeOf(() => checkDims(1, 30001))).toBe("too-large");
  });

  it("ponad 100 Mpx: too-large", () => {
    expect(codeOf(() => checkDims(10001, 10000))).toBe("too-large");
  });
});

describe("showStill", () => {
  const img = () => document.createElement("img");

  it("bez stron strzałki nie są obsługiwane, a dispose czyści ramkę", () => {
    const host = document.createElement("div");
    const view = showStill(host, img(), 100, 50);
    expect(view.key(keyEvent("ArrowRight"))).toBe(false);
    expect(host.querySelector(".r .r-obraz img")).not.toBeNull();
    view.dispose();
    expect(host.children.length).toBe(0);
  });

  it("z kilkoma stronami ←/→ i PageUp/PageDown zmieniają stronę", () => {
    const host = document.createElement("div");
    const go = vi.fn();
    const view = showStill(host, img(), 100, 50, { pages: { index: 0, count: 3, go } });
    expect(view.key(keyEvent("ArrowLeft"))).toBe(false);
    expect(view.key(keyEvent("ArrowRight"))).toBe(true);
    expect(go).toHaveBeenLastCalledWith(1);
    expect(view.key(keyEvent("PageDown"))).toBe(true);
    expect(go).toHaveBeenLastCalledWith(1);
    view.dispose();
  });

  it("na ostatniej stronie strzałka w prawo zwraca false i nic nie zmienia", () => {
    const host = document.createElement("div");
    const go = vi.fn();
    const view = showStill(host, img(), 100, 50, { pages: { index: 2, count: 3, go } });
    expect(view.key(keyEvent("ArrowRight"))).toBe(false);
    expect(go).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Strona 3 z 3");
    view.dispose();
  });

  it("etykieta w lewym górnym rogu", () => {
    const host = document.createElement("div");
    const view = showStill(host, img(), 100, 50, { label: "Pierwsza klatka" });
    expect(host.querySelector(".etykieta")?.textContent).toBe("Pierwsza klatka");
    view.dispose();
  });
});
