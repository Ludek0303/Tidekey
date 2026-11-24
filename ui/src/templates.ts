// Note templates and the daily note (Obsidian's Templates and Daily notes): the variables, the picker's list and the first write of a daily note.
import * as Y from "yjs";
import type { Bridge, TreeItem } from "./bridge";

export interface TemplateVars {
  title: string;
  now: Date;
}

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

// YYYY, MM, DD, HH and mm are replaced (local time); anything else in the format is copied.
function formatDate(format: string, d: Date): string {
  const parts: Record<string, string> = {
    YYYY: pad(d.getFullYear(), 4),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
  };
  return format.replace(/YYYY|MM|DD|HH|mm/g, (t) => parts[t]);
}

// One pass over the text, so a title that itself contains "{{date}}" stays as it is.
export function applyTemplate(text: string, { title, now }: TemplateVars): string {
  return text.replace(/\{\{(title|time|date(?::[^}]*)?)\}\}/g, (_, token: string) => {
    if (token === "title") return title;
    if (token === "time") return formatDate("HH:mm", now);
    return formatDate(token === "date" ? "YYYY-MM-DD" : token.slice(5), now);
  });
}

// Folder names as the tree keys them: no leading or trailing "/".
const cleanFolder = (p: string): string => p.trim().replace(/^\/+|\/+$/g, "");

/** The notes inside the template folder, sub-folders too. An empty folder setting has none. */
export function templateNotes(items: TreeItem[], folder: string): TreeItem[] {
  const dir = cleanFolder(folder);
  return dir ? items.filter((i) => i.path.startsWith(`${dir}/`)) : [];
}

/** A note's name without `.md`: its `{{title}}`. */
export const titleOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** `<folder>/YYYY-MM-DD.md` for the day; the root for an empty folder. */
export function dailyPath(now: Date, folder: string): string {
  const name = `${formatDate("YYYY-MM-DD", now)}.md`;
  const dir = cleanFolder(folder);
  return dir ? `${dir}/${name}` : name;
}

export interface DailyDeps {
  bridge: Bridge;
  /** Every note of the tree. */
  items: () => TreeItem[];
  /** Creates an empty note at a path and returns it (the explorer reloads its tree). */
  create: (path: string) => Promise<TreeItem>;
  open: (item: TreeItem) => Promise<void>;
  /** The text of a note was written here, so the index can see it before the next sync. */
  written?: (id: string, text: string) => void;
}

/** Opens the day's note; the first time it is made from the daily template (a missing template: an empty note). */
export async function openDailyNote(deps: DailyDeps, folder: string, template: string, now = new Date()): Promise<void> {
  const path = dailyPath(now, folder);
  const existing = deps.items().find((i) => i.path === path);
  if (existing) return deps.open(existing);
  const source = template.trim() ? deps.items().find((i) => i.path === template.trim()) : undefined;
  // Read before the note exists, so a failed read leaves nothing behind.
  const text = source
    ? applyTemplate(await deps.bridge.call<string>("note_text", { id: source.id }), { title: formatDate("YYYY-MM-DD", now), now })
    : "";
  const item = await deps.create(path);
  if (text) {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    await deps.bridge.call("apply_update", { id: item.id, update: Y.encodeStateAsUpdate(doc) });
    deps.written?.(item.id, text);
  }
  await deps.open(item);
}
