//! The spaces of this device: the switcher in the library, and the leave-and-switch steps. Both wait until the
//! open space's edits reached the backend, and a failed save keeps the space open.

import type { Bridge } from "./bridge";
import { errorText, openMenu, toast, type MenuEntry } from "./widgets";

export type SpaceKind = "notatki" | "organizacja";

export const KIND_LABEL: Record<SpaceKind, string> = { notatki: "Notatki", organizacja: "Organizacja" };

// One row of `list_spaces`: a folder of the device's list, with its type as cached in the app config.
export interface SpaceItem {
  path: string;
  name: string;
  kind: SpaceKind;
  current: boolean;
  exists: boolean;
}

export interface SwitchDeps {
  bridge: Bridge;
  // Resolves true once every pending editor update reached the backend (Saver.flushAll).
  flush: () => Promise<boolean>;
  // Reloads the window, so the next start-up opens the space the backend now has open.
  reload: () => void;
}

const SAVE_FAILED = "Nie udało się zapisać zmian w tej przestrzeni. Przełączanie anulowane.";

// Opens another listed space. The window reloads after the backend has opened it; on failure nothing changes.
export async function switchSpace(deps: SwitchDeps, path: string): Promise<boolean> {
  if (!(await deps.flush())) {
    toast(SAVE_FAILED, true);
    return false;
  }
  try {
    await deps.bridge.call("open_known_space", { path });
  } catch (e) {
    toast(errorText(e), true);
    return false;
  }
  deps.reload();
  return true;
}

// Closes the open space and shows the space manager after the reload.
export async function leaveSpace(deps: SwitchDeps): Promise<boolean> {
  if (!(await deps.flush())) {
    toast(SAVE_FAILED, true);
    return false;
  }
  try {
    await deps.bridge.call("close_space");
  } catch (e) {
    toast(errorText(e), true);
    return false;
  }
  deps.reload();
  return true;
}

// The switcher menu: the spaces that still exist, the current one checked and marked, then "Zarządzaj przestrzeniami…".
export async function switcherEntries(deps: SwitchDeps): Promise<MenuEntry[]> {
  let spaces: SpaceItem[] = [];
  try {
    spaces = await deps.bridge.call<SpaceItem[]>("list_spaces");
  } catch (e) {
    toast(errorText(e), true);
  }
  const listed: MenuEntry[] = spaces
    .filter((s) => s.current || s.exists)
    .map((s) => ({
      label: `${s.name} · ${KIND_LABEL[s.kind]}${s.current ? " (bieżąca)" : ""}`,
      icon: "folder",
      checked: s.current,
      run: () => { if (!s.current) void switchSpace(deps, s.path); },
    }));
  return [
    ...listed,
    ...(listed.length > 0 ? ["separator" as const] : []),
    { label: "Zarządzaj przestrzeniami…", icon: "settings", run: () => void leaveSpace(deps) },
  ];
}

// Opens the switcher menu above `anchor` (the space name in the library footer).
export async function openSwitcher(anchor: HTMLElement, deps: SwitchDeps): Promise<void> {
  const r = anchor.getBoundingClientRect();
  openMenu(r.left, r.top - 4, await switcherEntries(deps));
}
