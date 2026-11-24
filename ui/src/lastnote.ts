//! The note that was open last in a space, so a switch of space (a full reload) comes back to it. A per-viewer
//! convenience in localStorage: a missing or broken entry just opens the first note.

import type { TreeItem } from "./bridge";

const KEY = (spaceKey: string) => `notes.lastNote.v1.${spaceKey}`;

/** The note remembered for `spaceKey` among `notes`: by id, else by path (the note may have been recreated). */
export function rememberedNote(spaceKey: string, notes: TreeItem[]): TreeItem | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY(spaceKey)) ?? "null") as TreeItem | null;
    if (!saved) return null;
    return notes.find((n) => n.id === saved.id) ?? notes.find((n) => n.path === saved.path) ?? null;
  } catch {
    return null;
  }
}

export function rememberNote(spaceKey: string, item: TreeItem): void {
  try { localStorage.setItem(KEY(spaceKey), JSON.stringify({ id: item.id, path: item.path })); } catch { /* not remembered */ }
}
