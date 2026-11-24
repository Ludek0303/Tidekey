// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachTooltips } from "./tooltip";
import { Toolbar } from "./toolbar";

let host: HTMLElement;
let detach: () => void;
let bold: HTMLButtonElement;
let italic: HTMLButtonElement;
let mic: HTMLButtonElement;

const tip = () => document.querySelector<HTMLElement>(".ui-tip")!;
const shown = () => tip().classList.contains("is-visible");
const hover = (el: Element, pointerType = "mouse") =>
  el.dispatchEvent(Object.assign(new Event("pointerover", { bubbles: true }), { pointerType }));
const leave = (el: Element) => el.dispatchEvent(new Event("pointerout", { bubbles: true }));
const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
const rect = (top: number, left: number, width = 30, height = 30) =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function button(attrs: Record<string, string>): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "fmt-btn";
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "data-tip") btn.dataset.tip = value;
    else btn.setAttribute(name, value);
  }
  host.append(btn);
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  bold = button({ "data-tip": "Pogrubienie (Ctrl+B)", "aria-label": "Pogrubienie (Ctrl+B)" });
  italic = button({ "aria-label": "Kursywa" });
  mic = button({ "aria-label": "Mikrofon" });
  detach = attachTooltips(host, ".fmt-btn");
});

afterEach(() => {
  detach();
  host.remove();
  document.querySelectorAll(".ui-tip").forEach((el) => el.remove());
  vi.useRealTimers();
});

describe("attachTooltips", () => {
  it("shows a mouse-hovered button after 350 ms", () => {
    hover(bold);
    vi.advanceTimersByTime(349);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(true);
    expect(tip().textContent).toBe("Pogrubienie" + "Ctrl+B");
  });

  it("puts the shortcut in a kbd and the name before it", () => {
    hover(bold);
    vi.advanceTimersByTime(350);
    expect(tip().firstChild!.textContent).toBe("Pogrubienie");
    expect(tip().querySelector("kbd")!.textContent).toBe("Ctrl+B");
  });

  it("uses aria-label when there is no data-tip and no kbd for plain text", () => {
    hover(italic);
    vi.advanceTimersByTime(350);
    expect(tip().textContent).toBe("Kursywa");
    expect(tip().querySelector("kbd")).toBeNull();
  });

  it("moves at once to the next button while a bubble was just shown", () => {
    hover(bold);
    vi.advanceTimersByTime(350);
    leave(bold);
    hover(italic);
    expect(shown()).toBe(true);
    expect(tip().textContent).toBe("Kursywa");
  });

  it("waits the normal delay again once the warm window has passed", () => {
    hover(bold);
    vi.advanceTimersByTime(350);
    leave(bold);
    vi.advanceTimersByTime(700);
    hover(italic);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(350);
    expect(shown()).toBe(true);
  });

  it("ignores touch pointers", () => {
    hover(bold, "touch");
    vi.advanceTimersByTime(1000);
    expect(shown()).toBe(false);
  });

  it("shows at once for keyboard focus", () => {
    key("Tab");
    italic.focus();
    expect(shown()).toBe(true);
    expect(tip().textContent).toBe("Kursywa");
  });

  it("does not show for focus that came from the mouse", () => {
    italic.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    italic.focus();
    expect(shown()).toBe(false);
  });

  it("hides on pointerout, pointerdown, focusout, Escape and scroll", () => {
    hover(bold);
    vi.advanceTimersByTime(350);
    leave(bold);
    expect(shown()).toBe(false);

    hover(bold);
    vi.advanceTimersByTime(350);
    bold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(shown()).toBe(false);

    hover(bold);
    vi.advanceTimersByTime(350);
    key("Escape");
    expect(shown()).toBe(false);

    hover(bold);
    vi.advanceTimersByTime(350);
    window.dispatchEvent(new Event("scroll"));
    expect(shown()).toBe(false);

    key("Tab");
    italic.focus();
    expect(shown()).toBe(true);
    italic.blur();
    expect(shown()).toBe(false);
  });

  it("hides when the button leaves the DOM", async () => {
    hover(bold);
    vi.advanceTimersByTime(350);
    bold.remove();
    await Promise.resolve();
    expect(shown()).toBe(false);
  });

  it("refreshes the open bubble when data-tip changes", async () => {
    hover(mic);
    vi.advanceTimersByTime(350);
    expect(tip().textContent).toBe("Mikrofon");
    mic.dataset.tip = "Pobieranie modelu mowy… 37%";
    await Promise.resolve();
    expect(tip().textContent).toBe("Pobieranie modelu mowy… 37%");
    expect(shown()).toBe(true);
  });

  it("sits above the button, and flips below when there is no room", () => {
    bold.getBoundingClientRect = () => rect(200, 100);
    hover(bold);
    vi.advanceTimersByTime(350);
    expect(tip().classList.contains("is-below")).toBe(false);
    expect(tip().style.top).toBe(`${200 - 8}px`);

    bold.getBoundingClientRect = () => rect(4, 100);
    leave(bold);
    hover(bold);
    vi.advanceTimersByTime(350);
    expect(tip().classList.contains("is-below")).toBe(true);
    expect(tip().style.top).toBe(`${34 + 8}px`);
  });

  it("clamps the bubble inside the window with an 8 px margin", () => {
    tip().getBoundingClientRect = () => rect(0, 0, 200, 20);
    bold.getBoundingClientRect = () => rect(200, 2);
    hover(bold);
    vi.advanceTimersByTime(350);
    expect(tip().style.left).toBe("8px");
    expect(tip().style.getPropertyValue("--tip-arrow")).toBe("9px");
    leave(bold);

    bold.getBoundingClientRect = () => rect(200, window.innerWidth - 20);
    hover(bold);
    vi.advanceTimersByTime(350);
    expect(tip().style.left).toBe(`${window.innerWidth - 8 - 200}px`);
  });

  it("stops listening after cleanup", () => {
    detach();
    hover(bold);
    vi.advanceTimersByTime(350);
    expect(document.querySelector(".ui-tip")).toBeNull();
    detach = () => {};
  });
});

describe("formatting toolbar tooltips", () => {
  it("removes the native title and keeps aria-label on the bar buttons", () => {
    // The bar's bubble is the one under test, so the bubble from beforeEach goes first.
    document.querySelectorAll(".ui-tip").forEach((el) => el.remove());
    const bar = document.createElement("div");
    document.body.append(bar);
    new Toolbar(bar, () => null);
    const btns = [...bar.querySelectorAll<HTMLButtonElement>(".fmt-btn")];
    expect(btns.length).toBeGreaterThan(10);
    for (const btn of btns) {
      expect(btn.hasAttribute("title")).toBe(false);
      expect(btn.getAttribute("aria-label")).toBeTruthy();
    }
    hover(btns[0]);
    vi.advanceTimersByTime(350);
    expect(tip().querySelector("kbd")!.textContent).toBe("Ctrl+B");
  });
});
