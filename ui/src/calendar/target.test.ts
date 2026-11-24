// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseTarget, savePending, takePending, type EventTarget } from "./target";

const KEY = "notes.pendingEvent";
const personal: EventTarget = { path: "browser-anna", name: "Moje notatki", personal: true, organization: false, current: false };
const firma: EventTarget = { path: "v-1", name: "Firma", personal: false, organization: true, current: true };

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pending event across a switch of space", () => {
  it("returns the saved date for the same space, once", () => {
    savePending({ path: "browser-anna", day: 20000, startMin: 600 });
    expect(takePending("browser-anna")).toEqual({ path: "browser-anna", day: 20000, startMin: 600 });
    expect(takePending("browser-anna")).toBeNull();
  });

  it("drops the pending event for another space and removes it", () => {
    savePending({ path: "v-1", day: 20000, startMin: null });
    expect(takePending("browser-anna")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("drops an event older than two minutes", () => {
    vi.useFakeTimers();
    savePending({ path: "browser-anna", day: 20000, startMin: null });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(takePending("browser-anna")).toBeNull();
  });

  it("keeps only the date, with no title or note text", () => {
    savePending({ path: "browser-anna", day: 20000, startMin: 600 });
    expect(Object.keys(JSON.parse(sessionStorage.getItem(KEY)!)).sort()).toEqual(["at", "day", "path", "startMin"]);
  });

  it("does nothing when the storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => savePending({ path: "browser-anna", day: 1, startMin: null })).not.toThrow();
    expect(takePending("browser-anna")).toBeNull();
  });

  it("ignores a value that is not a pending event", () => {
    sessionStorage.setItem(KEY, "{\"path\":\"browser-anna\",\"day\":\"x\",\"startMin\":null,\"at\":1}");
    expect(takePending("browser-anna")).toBeNull();
    sessionStorage.setItem(KEY, "null");
    expect(takePending("browser-anna")).toBeNull();
  });
});

describe("chooseTarget", () => {
  it("adds at once when there is one space, with no dialog", () => {
    const onPick = vi.fn();
    chooseTarget([firma], 20000, null, onPick);
    expect(onPick).toHaveBeenCalledWith(firma);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("shows a toast and no dialog when there is no space", () => {
    const onPick = vi.fn();
    chooseTarget([], 20000, null, onPick);
    expect(onPick).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Nie masz przestrzeni, w której możesz dodać wydarzenie.");
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("lists the personal space first and preselects the current one", () => {
    chooseTarget([firma, personal], 20000, 600, vi.fn());
    const names = [...document.querySelectorAll(".cal-target-name")].map((n) => n.textContent);
    expect(names).toEqual(["Moje notatki", "Firma"]);
    const checked = document.querySelector<HTMLInputElement>("input[name=cal-target]:checked");
    expect(checked?.closest("label")?.textContent).toContain("Firma");
    expect(document.querySelector(".btn-primary")?.textContent).toBe("Dodaj wydarzenie");
  });

  it("preselects the personal space when no space is current", () => {
    chooseTarget([{ ...firma, current: false }, personal], 20000, null, vi.fn());
    const checked = document.querySelector<HTMLInputElement>("input[name=cal-target]:checked");
    expect(checked?.closest("label")?.textContent).toContain("Moje notatki");
    expect(document.querySelector(".btn-primary")?.textContent).toBe("Przejdź do przestrzeni i dodaj");
  });

  it("changes the primary label with the selection and calls onPick on submit", () => {
    const onPick = vi.fn();
    chooseTarget([firma, personal], 20000, null, onPick);
    const radios = [...document.querySelectorAll<HTMLInputElement>("input[name=cal-target]")];
    const ok = document.querySelector<HTMLButtonElement>(".btn-primary")!;
    radios[1].checked = true; // the Firma row
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    expect(ok.textContent).toBe("Dodaj wydarzenie");
    radios[0].checked = true; // the personal row
    radios[0].dispatchEvent(new Event("change", { bubbles: true }));
    expect(ok.textContent).toBe("Przejdź do przestrzeni i dodaj");
    document.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onPick).toHaveBeenCalledWith(personal);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("does not call onPick on Anuluj", () => {
    const onPick = vi.fn();
    chooseTarget([firma, personal], 20000, null, onPick);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Anuluj")!;
    cancel.click();
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector(".modal")).toBeNull();
  });
});
