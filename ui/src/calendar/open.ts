// Finding, creating and opening the calendar note (ribbon, palette and explorer menu).
import * as Y from "yjs";
import type { Bridge, TreeItem } from "../bridge";

export const CALENDAR_NAME = "Kalendarz";
// The front matter that makes a note a calendar (ARCHITEKTURA §4.16b).
export const CALENDAR_TEXT = "---\ntyp: kalendarz\n---\n";

export interface CalendarDeps {
  bridge: Bridge;
  /** Every note of the tree. */
  items: () => TreeItem[];
  /** The note index's answer: the note's front matter says `typ: kalendarz`. */
  isCalendar: (id: string) => boolean;
  /** Creates an empty note at a path and returns it (the explorer reloads its tree). */
  create: (path: string) => Promise<TreeItem>;
  open: (item: TreeItem) => Promise<void>;
  /** The text of a note was written here, so the index can see it before the next sync. */
  written?: (id: string, text: string) => void;
  /** An organization has a single calendar: creating another opens the one it has. */
  single?: () => boolean;
  /** Tells the user why nothing new was created. */
  notice?: (message: string) => void;
}

/** `Kalendarz.md` in the folder, or the first free `Kalendarz 2.md`, `Kalendarz 3.md`, … */
export function freeCalendarPath(items: TreeItem[], folder = ""): string {
  const used = new Set(items.map((i) => i.path.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = `${CALENDAR_NAME}${i === 1 ? "" : ` ${i}`}.md`;
    const path = folder ? `${folder}/${name}` : name;
    if (!used.has(path.toLowerCase())) return path;
  }
}

/** The calendar note that comes first by path, or `undefined`. */
export function findCalendar(items: TreeItem[], isCalendar: (id: string) => boolean): TreeItem | undefined {
  let first: TreeItem | undefined;
  for (const i of items) if (isCalendar(i.id) && (!first || i.path < first.path)) first = i;
  return first;
}

/** Creates the calendar note in a folder. Its text is written through the core, like an edit. */
export async function createCalendar(deps: CalendarDeps, folder = ""): Promise<TreeItem> {
  const item = await deps.create(freeCalendarPath(deps.items(), folder));
  const doc = new Y.Doc();
  doc.getText("content").insert(0, CALENDAR_TEXT);
  await deps.bridge.call("apply_update", { id: item.id, update: Y.encodeStateAsUpdate(doc) });
  deps.written?.(item.id, CALENDAR_TEXT);
  return item;
}

export async function newCalendar(deps: CalendarDeps, folder = ""): Promise<void> {
  const existing = deps.single?.() ? findCalendar(deps.items(), deps.isCalendar) : undefined;
  if (existing) {
    deps.notice?.("Organizacja ma już kalendarz, otwieram go. W organizacji może być tylko jeden kalendarz.");
    await deps.open(existing);
    return;
  }
  await deps.open(await createCalendar(deps, folder));
}
