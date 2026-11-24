// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDialog } from "./widgets";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("openDialog", () => {
  it("keeps Escape working when the focused button is removed by a redraw", async () => {
    let closed = false;
    openDialog({
      label: "Test",
      render(box) {
        const first = document.createElement("button");
        first.textContent = "Pierwszy";
        first.addEventListener("click", () => first.remove());
        box.append(first);
      },
      onClose: () => {
        closed = true;
      },
    });
    const button = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
    // jsdom does not fire focusout when a focused element is removed (browsers may), so blur first
    button.blur();
    button.remove();
    await flush();
    const box = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(box);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
