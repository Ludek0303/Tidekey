// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "./bridge";
import { leaveSpace, switcherEntries, switchSpace, type SpaceItem, type SwitchDeps } from "./spaces";
import type { MenuEntry } from "./widgets";

const flush = () => new Promise((r) => setTimeout(r, 0));

// A backend stand-in that records the commands it gets.
function backend(over: Record<string, () => Promise<unknown>> = {}): { bridge: Bridge; calls: string[] } {
  const calls: string[] = [];
  const bridge: Bridge = {
    call: (cmd: string) => {
      calls.push(cmd);
      return (over[cmd] ?? (() => Promise.resolve(undefined)))() as Promise<never>;
    },
    on: () => () => {},
  };
  return { bridge, calls };
}

function deps(bridge: Bridge, flush: () => Promise<boolean>) {
  const d: SwitchDeps = { bridge, flush, reload: vi.fn<() => void>() };
  return d as SwitchDeps & { reload: ReturnType<typeof vi.fn<() => void>> };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("switchSpace", () => {
  it("waits until every pending save reached the backend before it opens the other space", async () => {
    let finish!: (saved: boolean) => void;
    const pending = new Promise<boolean>((r) => (finish = r));
    const { bridge, calls } = backend();
    const d = deps(bridge, () => pending);

    const switched = switchSpace(d, "/home/uzytkownik/Triton");
    await flush();
    expect(calls).toEqual([]);
    finish(true);
    expect(await switched).toBe(true);
    expect(calls).toEqual(["open_known_space"]);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it("does not switch when a save failed, and says so", async () => {
    const { bridge, calls } = backend();
    const d = deps(bridge, () => Promise.resolve(false));

    expect(await switchSpace(d, "/home/uzytkownik/Triton")).toBe(false);
    expect(calls).toEqual([]);
    expect(d.reload).not.toHaveBeenCalled();
    const toast = document.querySelector(".toast.is-error");
    expect(toast?.textContent).toContain("Nie udało się zapisać");
  });

  it("keeps the current space when the backend refuses the other one", async () => {
    const { bridge } = backend({
      open_known_space: () => Promise.reject(Object.assign(new Error("Tej przestrzeni nie ma na liście przestrzeni."), { kind: "folder_refused" })),
    });
    const d = deps(bridge, () => Promise.resolve(true));
    expect(await switchSpace(d, "/x")).toBe(false);
    expect(d.reload).not.toHaveBeenCalled();
    expect(document.querySelector(".toast.is-error")?.textContent).toBe("Tej przestrzeni nie ma na liście przestrzeni.");
  });
});

describe("leaveSpace", () => {
  it("closes the open space after the saves and reloads into the space manager", async () => {
    const { bridge, calls } = backend();
    const d = deps(bridge, () => Promise.resolve(true));
    expect(await leaveSpace(d)).toBe(true);
    expect(calls).toEqual(["close_space"]);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});

describe("switcherEntries", () => {
  const spaces: SpaceItem[] = [
    { path: "/a", name: "Plan", kind: "notatki", current: true, exists: true },
    { path: "/b", name: "Triton", kind: "organizacja", current: false, exists: true },
    { path: "/c", name: "Stara", kind: "notatki", current: false, exists: false },
  ];

  it("lists the current space checked and marked, then the other existing spaces, then the manager entry", async () => {
    const { bridge } = backend({ list_spaces: () => Promise.resolve(spaces) });
    const entries = await switcherEntries(deps(bridge, () => Promise.resolve(true)));
    const labels = entries.map((e) => (e === "separator" ? "---" : e.label));
    expect(labels).toEqual(["Plan · Notatki (bieżąca)", "Triton · Organizacja", "---", "Zarządzaj przestrzeniami…"]);
    expect(entries[0]).toMatchObject({ checked: true });
    expect(entries[1]).toMatchObject({ checked: false });
  });

  it("opens the chosen space through the same switch", async () => {
    const { bridge, calls } = backend({ list_spaces: () => Promise.resolve(spaces) });
    const d = deps(bridge, () => Promise.resolve(true));
    const entries = await switcherEntries(d);
    const triton = entries[1] as Exclude<MenuEntry, "separator">;
    triton.run();
    await flush();
    await flush();
    expect(calls).toEqual(["list_spaces", "open_known_space"]);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});
