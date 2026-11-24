//! Window-level keys of the shell: Ctrl+E (or Cmd+E on macOS) switches the reading and editing mode, and
//! PageUp/PageDown cycle the tabs as the web fallback of Ctrl+Tab. The editor's own keys are not touched.

import type { Layout } from "./layout";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function installShellKeys(layout: Layout, actions: { toggleMode: () => void; cycle: (delta: number) => void }): void {
  // Capture phase on window: runs before the editor and before the browser's own Ctrl+E (search bar).
  // macOS uses Cmd+E alone, so Ctrl+E stays "end of line" there.
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "e") return;
      // Dialogs (quick open) keep their keys, and keys pressed outside the layout are not ours.
      if (document.querySelector('[role="dialog"]')) return;
      if (!(e.target instanceof Node && layout.app.contains(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      actions.toggleMode();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    // Browsers keep Ctrl+Tab for themselves, so PageUp/PageDown is the web fallback.
    if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      actions.cycle(e.key === "PageDown" ? 1 : -1);
    }
  });
}
