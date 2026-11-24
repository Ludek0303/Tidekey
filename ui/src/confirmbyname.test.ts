// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmByName } from "./widgets";

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const input = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Nazwa do potwierdzenia"]')!;
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("confirmByName", () => {
  it("keeps the danger button disabled until the exact name is typed", async () => {
    const answer = confirmByName("Usunąć?", "Plan");
    expect(button("Usuń").disabled).toBe(true);
    type("Pla");
    expect(button("Usuń").disabled).toBe(true);
    type("Plan");
    expect(button("Usuń").disabled).toBe(false);
    button("Usuń").click();
    expect(await answer).toBe(true);
  });

  it("ignores surrounding spaces, but not a different name", async () => {
    const answer = confirmByName("Usunąć?", "Plan");
    type("  Plan ");
    expect(button("Usuń").disabled).toBe(false);
    type("Plany");
    expect(button("Usuń").disabled).toBe(true);
    button("Anuluj").click();
    expect(await answer).toBe(false);
  });

  it("Enter confirms only when the name matches", async () => {
    const answer = confirmByName("Usunąć?", "Plan");
    type("Pla");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(dialog().isConnected).toBe(true);
    type("Plan");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(await answer).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Escape resolves false and closes", async () => {
    const answer = confirmByName("Usunąć?", "Plan");
    type("Plan");
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await answer).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Anuluj resolves false even when the name matches", async () => {
    const answer = confirmByName("Usunąć?", "Plan");
    type("Plan");
    button("Anuluj").click();
    expect(await answer).toBe(false);
  });

  it("uses the given label for the confirm button", () => {
    void confirmByName("Usunąć?", "Plan", "Zdejmij");
    expect(button("Zdejmij").classList.contains("btn-danger")).toBe(true);
    button("Anuluj").click();
  });
});
