// ZIP archives as a list of their entries: names and sizes from the central directory, nothing unpacked (PODGLAD-PLAN §5).
import { createElement, File, Folder, Lock } from "lucide";
import { filesWord, formatSize } from "../format";
import { readZipIndex, type ZipEntry } from "../zipindex";
import type { Viewer, ViewerContext } from "./index";

const MAX_ENTRIES = 10_000;
const INDENT_PX = 18;

function row(entry: ZipEntry): HTMLLIElement {
  const parts = entry.name.replace(/\/$/, "").split("/");
  const li = document.createElement("li");
  li.className = "r-zip-wiersz";
  li.style.paddingLeft = `${8 + (parts.length - 1) * INDENT_PX}px`;
  const icon = createElement(entry.dir ? Folder : File);
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "r-zip-nazwa";
  name.textContent = parts[parts.length - 1];
  name.title = entry.name;
  li.append(icon, name);
  if (entry.encrypted) {
    const lock = createElement(Lock);
    lock.setAttribute("aria-hidden", "true");
    const tag = document.createElement("span");
    tag.className = "r-zip-tag";
    tag.append(lock, "zaszyfrowany");
    li.append(tag);
  }
  if (!entry.dir) {
    const size = document.createElement("span");
    size.className = "r-zip-rozmiar";
    size.textContent = formatSize(entry.size);
    li.append(size);
  }
  return li;
}

export function createZipViewer(): Viewer {
  let root: HTMLElement | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const index = readZipIndex(new Uint8Array(bytes), MAX_ENTRIES);
      const files = index.entries.filter((e) => !e.dir);
      const count = `${files.length.toLocaleString("pl-PL")} ${filesWord(files.length)}`;
      const total = files.reduce((sum, e) => sum + e.size, 0);

      const view = document.createElement("div");
      view.className = "r-zip";
      const head = document.createElement("p");
      head.className = "r-zip-naglowek";
      head.textContent = `${count}, ${formatSize(total)} po rozpakowaniu`;
      const list = document.createElement("ul");
      list.className = "r-zip-lista";
      const sorted = [...index.entries].sort((a, b) => a.name.localeCompare(b.name, "pl"));
      for (const entry of sorted) list.append(row(entry));
      view.append(head, list);
      if (index.more) {
        const note = document.createElement("p");
        note.className = "r-zip-uwaga";
        note.textContent = `Pokazano ${MAX_ENTRIES.toLocaleString("pl-PL")} z ${index.total.toLocaleString("pl-PL")} wpisów.`;
        view.append(note);
      }

      ctx.host.append(view);
      root = view;
      ctx.status(count);
    },

    dispose(): void {
      root?.remove();
      root = null;
    },
  };
}
