// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { OrgNav } from "./orgnav";

function setup() {
  const pane = document.createElement("section");
  pane.innerHTML = '<div id="tree"></div>';
  document.body.append(pane);
  const actions = { section: vi.fn() };
  const nav = new OrgNav(pane, actions);
  return { nav, actions, buttons: () => [...nav.nav.querySelectorAll<HTMLButtonElement>(".org-nav-btn")] };
}

describe("OrgNav", () => {
  it("shows every section as a button named by its label, in three groups", () => {
    const { nav, buttons } = setup();
    expect(buttons().map((b) => b.textContent)).toEqual([
      "Przegląd", "Projekty", "Zadania", "Pliki", "Powiadomienia", "Aktywność", "Osoby i grupy", "Grafy", "Kalendarze", "Inwentarze", "Dostępność",
    ]);
    expect(nav.nav.querySelectorAll("details.org-nav-group")).toHaveLength(3);
  });

  it("shows the unread count inside the notifications button and hides it at zero", () => {
    const { nav, buttons } = setup();
    const bell = buttons().find((b) => b.textContent?.startsWith("Powiadomienia"))!;
    nav.setCount("notifications", 3);
    expect(bell.textContent).toBe("Powiadomienia3");
    expect(bell.querySelector<HTMLElement>(".org-nav-count")!.hidden).toBe(false);
    nav.setCount("notifications", 0);
    expect(bell.querySelector<HTMLElement>(".org-nav-count")!.hidden).toBe(true);
  });

  it("marks the section on screen and opens its group when it was collapsed", () => {
    const { nav, buttons } = setup();
    const files = buttons().find((b) => b.textContent === "Pliki")!;
    const group = files.closest("details")!;
    group.open = false;
    nav.select("files");
    expect(files.getAttribute("aria-pressed")).toBe("true");
    expect(group.open).toBe(true);
  });

  it("starts with the file tree on screen and no section marked", () => {
    const { buttons } = setup();
    expect(document.querySelector<HTMLElement>("#tree")!.hidden).toBe(false);
    expect(buttons().filter((b) => b.getAttribute("aria-pressed") === "true")).toEqual([]);
  });

  it("selecting Projekty keeps the file tree on screen; clear() unmarks every section", () => {
    const { nav, buttons } = setup();
    nav.select("projects");
    expect(buttons().find((b) => b.textContent === "Projekty")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLElement>("#tree")!.hidden).toBe(false);
    nav.clear();
    expect(buttons().map((b) => b.getAttribute("aria-pressed"))).toEqual(buttons().map(() => "false"));
  });
});

describe("OrgNav in a personal space", () => {
  it("shows only Zadania, in the Praca group, under the notatki label", () => {
    const { nav, buttons } = setup();
    nav.setMode("personal");
    nav.setSectionVisible("files", true);
    expect(nav.nav.hidden).toBe(false);
    expect(nav.nav.getAttribute("aria-label")).toBe("Sekcje notatek");
    expect(buttons().filter((b) => !b.hidden).map((b) => b.textContent)).toEqual(["Zadania"]);
    const groups = [...nav.nav.querySelectorAll<HTMLElement>("details.org-nav-group")];
    expect(groups.filter((g) => !g.hidden).map((g) => g.querySelector("summary")!.textContent)).toEqual(["Praca"]);
  });

  it("is hidden until a space is known, and every section comes back in an organization", () => {
    const { nav, buttons } = setup();
    expect(nav.nav.hidden).toBe(true);
    nav.setMode("organization");
    expect(nav.nav.hidden).toBe(false);
    expect(nav.nav.getAttribute("aria-label")).toBe("Sekcje organizacji");
    expect(buttons().filter((b) => !b.hidden)).toHaveLength(11);
  });
});
