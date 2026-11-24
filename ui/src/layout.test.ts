// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildLayout } from "./layout";

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, layout: buildLayout(host) };
}

describe("buildLayout", () => {
  it("gives every button an aria-label and a title", () => {
    const { host } = mount();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThan(20);
    for (const b of buttons) {
      expect(b.getAttribute("aria-label"), b.outerHTML).toBeTruthy();
      expect(b.title, b.outerHTML).toBeTruthy();
    }
  });

  it("has the left sidebar toggle and the six ribbon buttons with their Polish labels", () => {
    const { host } = mount();
    const labels = [...host.querySelectorAll<HTMLButtonElement>(".ribbon button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Pokaż lub ukryj lewy panel",
      "Otwórz szybki przełącznik",
      "Szukaj w notatkach",
      "Otwórz widok grafu",
      "Moje zadania",
      "Kalendarz",
      "Paleta poleceń",
    ]);
  });

  it("has the five explorer header buttons", () => {
    const { host } = mount();
    const actions = [...host.querySelectorAll<HTMLElement>("[data-action]")].map((b) => b.dataset.action);
    expect(actions).toEqual(["new-note", "new-folder", "sort", "collapse-all", "expand-all"]);
  });

  it("collapses the left sidebar from the tab bar", () => {
    const { host, layout } = mount();
    host.querySelector<HTMLButtonElement>("#btn-toggle-left")!.click();
    expect(layout.app.classList.contains("left-collapsed")).toBe(true);
  });

  it("switches sidebar panes with the side tabs", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.side-tab[data-pane="search"]')!.click();
    expect(host.querySelector<HTMLElement>("#pane-files")!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>("#pane-search")!.hidden).toBe(false);
  });

  it("moves between sidebar tabs with the keyboard and keeps one tab stop", () => {
    const { host } = mount();
    const files = host.querySelector<HTMLButtonElement>('[data-pane="files"]')!;
    files.focus();
    files.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const search = host.querySelector<HTMLButtonElement>('[data-pane="search"]')!;
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("aria-selected")).toBe("true");
    expect(files.tabIndex).toBe(-1);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(host.querySelector('[data-pane="bookmarks"]'));
  });
});

describe("the library header", () => {
  it("shows the open space's name at the top of the library and in the footer", async () => {
    const { buildLayout, showSpaceName } = await import("./layout");
    const layout = buildLayout(document.createElement("div"));
    showSpaceName(layout, "Przykładowa organizacja");
    expect(layout.workspaceName.textContent).toBe("Przykładowa organizacja");
    expect(layout.vaultName.textContent).toBe("Przykładowa organizacja");
    // the header clamps a long name; the full name stays readable in the tooltip
    expect(layout.workspaceName.title).toBe("Przykładowa organizacja");
  });
});

describe("the note's name in the breadcrumb", () => {
  it("renames on Enter, keeps the name on Escape", async () => {
    const { setCrumbs } = await import("./layout");
    const { layout } = mount();
    const names: string[] = [];
    setCrumbs(layout, "Projekty/Plan.md", () => undefined, (n) => names.push(n));
    const title = () => layout.crumbs.querySelector<HTMLElement>(".crumb.is-last")!;
    expect(title().textContent).toBe("Plan");
    const type = (value: string, key: string) => {
      title().click();
      const input = layout.crumbs.querySelector<HTMLInputElement>(".crumb-rename")!;
      input.value = value;
      input.dispatchEvent(new KeyboardEvent("keydown", { key }));
    };
    type("Plan 2026", "Escape");
    type("Plan 2026", "Enter");
    expect(names).toEqual(["Plan 2026"]);
    expect(layout.crumbs.querySelector(".crumb-rename")).toBeNull();
  });

  it("closes the library drawer on a small screen after a pick, on Escape and on the backdrop", () => {
    const width = window.innerWidth;
    window.innerWidth = 480;
    try {
      const { layout, host } = mount();
      const isOpen = () => !layout.app.classList.contains("left-collapsed");
      const open = () => { if (!isOpen()) layout.app.querySelector<HTMLButtonElement>("#btn-toggle-left")!.click(); };
      const backdrop = host.querySelector<HTMLElement>(".drawer-backdrop")!;

      open();
      layout.tree.insertAdjacentHTML("beforeend", '<div role="treeitem" aria-level="1"></div><div role="treeitem" aria-expanded="true"></div>');
      // a folder (aria-expanded) keeps the drawer open; a note closes it
      layout.tree.querySelector<HTMLElement>('[role="treeitem"][aria-expanded]')!.click();
      expect(isOpen()).toBe(true);
      layout.tree.querySelector<HTMLElement>('[role="treeitem"]:not([aria-expanded])')!.click();
      expect(isOpen()).toBe(false);

      open();
      backdrop.click();
      expect(isOpen()).toBe(false);

      open();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(isOpen()).toBe(false);
    } finally {
      window.innerWidth = width;
    }
  });
});
