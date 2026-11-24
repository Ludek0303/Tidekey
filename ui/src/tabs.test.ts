// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installHotkeys } from "./commands";
import { TabBar, type TabInfo } from "./tabs";

const tabs: TabInfo[] = [
  { id: "a", title: "A" },
  { id: "b", title: "B" },
  { id: "c", title: "C" },
];

function setup(active: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const onSelect = vi.fn();
  const bar = new TabBar(host, onSelect);
  bar.render(tabs, active);
  const tab = (id: string) => host.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const press = (id: string, key: string) =>
    tab(id).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  return { host, onSelect, tab, press };
}

describe("TabBar keyboard and ARIA", () => {
  it("marks only the active tab as aria-selected and gives it roving focus", () => {
    const { host, tab } = setup("b");
    expect(host.getAttribute("role")).toBe("tablist");
    expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    expect(tab("b").getAttribute("aria-selected")).toBe("true");
    expect(tab("b").getAttribute("role")).toBe("tab");
    expect(tab("b").tabIndex).toBe(0);
    expect(tab("a").tabIndex).toBe(-1);
  });

  it("ArrowRight and ArrowLeft move to the neighbouring tab", () => {
    const { onSelect, press } = setup("b");
    press("b", "ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("c");
    press("b", "ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("a");
  });

  it("wraps around at both ends", () => {
    const last = setup("c");
    last.press("c", "ArrowRight");
    expect(last.onSelect).toHaveBeenLastCalledWith("a");

    const first = setup("a");
    first.press("a", "ArrowLeft");
    expect(first.onSelect).toHaveBeenLastCalledWith("c");
  });

  it("moves DOM focus to the tab it selects", () => {
    const { tab, press } = setup("a");
    press("a", "ArrowRight");
    expect(document.activeElement).toBe(tab("b"));
  });

  it("ignores other keys", () => {
    const { onSelect, press } = setup("b");
    press("b", "ArrowDown");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("TabBar closing", () => {
  it("the close button and a middle click close that tab, not select it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    new TabBar(host, onSelect, onClose).render(tabs, "a");
    const tab = (id: string) => host.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

    tab("b").querySelector<HTMLButtonElement>(".tab-close")!.click();
    expect(onClose).toHaveBeenLastCalledWith("b");
    expect(onSelect).not.toHaveBeenCalled();

    tab("c").dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(onClose).toHaveBeenLastCalledWith("c");
  });

  it("Ctrl+Alt+W closes the active tab", () => {
    installHotkeys();
    const host = document.createElement("div");
    document.body.append(host);
    const onClose = vi.fn();
    new TabBar(host, vi.fn(), onClose).render(tabs, "b");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, bubbles: true }));
    expect(onClose).toHaveBeenCalledWith("b");
  });

  it("Delete and Ctrl+F4 close the focused tab, not the active one", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    new TabBar(host, onSelect, onClose).render(tabs, "a");
    const tab = host.querySelector<HTMLElement>('[data-id="c"]')!;
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(onClose).toHaveBeenLastCalledWith("c");
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", ctrlKey: true, bubbles: true }));
    expect(onClose).toHaveBeenLastCalledWith("c");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("the close button has the icon-btn and tab-close classes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    new TabBar(host, vi.fn(), vi.fn()).render(tabs, "a");
    expect(host.querySelector(".tab-close")!.classList.contains("icon-btn")).toBe(true);
  });

  it("after ArrowLeft the new tab keeps focus, so Delete closes it and the editor is not touched", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onClose = vi.fn();
    const bar: TabBar = new TabBar(host, (id) => bar.render(tabs, id), onClose);
    bar.render(tabs, "b");
    host.querySelector<HTMLElement>('[data-id="b"]')!.focus();
    host.querySelector<HTMLElement>('[data-id="b"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(host.querySelector('[data-id="a"]'));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(onClose).toHaveBeenCalledWith("a");
  });
});
