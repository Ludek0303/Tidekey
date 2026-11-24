// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "./settings";
import { Toolbar } from "./toolbar";

beforeEach(() => {
  localStorage.clear();
  setSetting("showToolbar", true);
  setSetting("toolbarPosition", "top");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("toolbar position", () => {
  it("defaults to top", async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import("./settings");
    expect(fresh.getSetting("toolbarPosition")).toBe("top");
  });

  it("changing the setting moves the bar and sets its orientation", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const toolbar = new Toolbar(host, () => null);
    toolbar.setActive(true);
    expect(host.dataset.toolbar).toBe("top");
    expect(host.getAttribute("aria-orientation")).toBe("horizontal");

    setSetting("toolbarPosition", "bottom");
    expect(host.dataset.toolbar).toBe("bottom");
    expect(host.getAttribute("aria-orientation")).toBe("horizontal");

    setSetting("toolbarPosition", "left");
    expect(getSetting("toolbarPosition")).toBe("left");
    expect(host.dataset.toolbar).toBe("left");
    expect(host.getAttribute("aria-orientation")).toBe("vertical");

    setSetting("toolbarPosition", "right");
    expect(host.dataset.toolbar).toBe("right");
    expect(host.getAttribute("aria-orientation")).toBe("vertical");
  });
});
