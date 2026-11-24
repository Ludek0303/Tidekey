// What every trigger of the preview window calls (PODGLAD-PLAN §7): a list of files and the one to show first.
import { FILE_EMBED, type FileInfo, type FileStore } from "../filestore";
import { toast } from "../widgets";
import { itemsOf } from "./items";
import { openPreview, type TextFocus } from "./window";

export interface PreviewOptions {
  /** Opened with the space bar: the space bar closes it again. */
  bySpace?: boolean;
  /** Opens the "Tekst" tab on a page (a search hit). */
  text?: TextFocus;
}

/** Opens the preview on `infos[index]`; the arrows page through `infos` (files that cannot be shown are left out). */
export function previewFiles(store: FileStore, infos: FileInfo[], index: number, options: PreviewOptions = {}): void {
  const items = itemsOf(store, infos);
  const at = items.findIndex((item) => item.key === infos[index]?.id);
  if (at < 0) return void toast("Tego pliku nie da się podejrzeć.", true);
  openPreview(items, at, options);
}

/** The server files embedded in a note's text, in the order they appear, each once. */
export function embeddedIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(new RegExp(FILE_EMBED.source, "g"))) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/** Opens `fileId`, paging through the files embedded in `text` (a note's text or the reading view's order). */
export async function previewEmbeds(store: FileStore, ids: string[], fileId: string, options: PreviewOptions = {}): Promise<void> {
  const list = ids.includes(fileId) ? ids : [fileId];
  const infos = (await Promise.all(list.map((id) => store.info(id).catch(() => null)))).filter((i): i is FileInfo => i !== null);
  const index = infos.findIndex((info) => info.id === fileId);
  if (index < 0) return void toast("Nie ma takiego pliku.", true);
  previewFiles(store, infos, index, options);
}
