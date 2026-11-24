// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, listCommands, registerCommand } from "./commands";

describe("command registry and palette", () => {
  it("registerCommand adds a command to the list", () => {
    registerCommand({ id: "test.one", name: "Pierwsze", run: () => undefined });
    expect(listCommands().map((c) => c.id)).toContain("test.one");
  });

  it("the palette lists the commands and runs the selected one", () => {
    const alpha = vi.fn();
    registerCommand({ id: "test.alpha", name: "Alfa polecenie", run: alpha });
    registerCommand({ id: "test.beta", name: "Beta polecenie", run: vi.fn() });

    const palette = new CommandPalette();
    palette.open();
    const names = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(["Alfa polecenie", "Beta polecenie"]));

    const input = document.querySelector<HTMLInputElement>(".qo-input")!;
    input.value = "alfa";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(alpha).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("the palette sorts commands alphabetically and Esc closes it", () => {
    registerCommand({ id: "test.zeta", name: "Zeta polecenie", run: vi.fn() });
    registerCommand({ id: "test.gamma", name: "Gamma polecenie", run: vi.fn() });

    const palette = new CommandPalette();
    palette.open();
    const names = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "pl")));

    document.querySelector<HTMLInputElement>(".qo-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
