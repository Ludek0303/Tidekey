//! Files that lie in a folder beside its notes (docs/PLIKI.md §7): a file is a server file (FileStore) placed by a
//! `folder_file_*` command; the tree shows it. These helpers name, upload, open and pick files; the tree and the
//! explorer call them. Desktop has no file store, so none of this runs there (tauribridge.ts).

import { download } from "./attachments";
import { errorText, openDialog, toast } from "./widgets";
import { isImageMime, KIND_LABEL, fileKind, formatSize, MAX_FILE_BYTES, newFileId, projectOfNote, type FileInfo, type FileStore } from "./filestore";
import { thumbnailFor } from "./thumbnail";

const TOAST_MS = 4000;
const URL_LIFETIME_MS = 60_000;

/** The path, or the first ` (n)` before the extension that no taken path (lower case) uses: `umowa.pdf` → `umowa (2).pdf`. */
export function freeName(path: string, taken: Set<string>): string {
  if (!taken.has(path.toLowerCase())) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const cut = dot > slash + 1 ? dot : path.length; // ".bashrc" has no extension
  for (let n = 2; ; n++) {
    const candidate = `${path.slice(0, cut)} (${n})${path.slice(cut)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Uploads a file for `path` (its folder and name) and returns the file; the store's name is set to the path's name. */
export async function uploadTo(store: FileStore, file: File, path: string, onProgress: (sent: number, total: number) => void): Promise<FileInfo> {
  const info = await store.upload(file, {
    id: newFileId(),
    project: projectOfNote(path),
    thumbnail: await thumbnailFor(file),
    onProgress,
  });
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === info.name) return info;
  await store.rename(info.id, name);
  return { ...info, name };
}

/** A progress line in the toast area while one file uploads; `done` removes it, `fail` leaves the error for a few seconds. */
export function progressToast(name: string): { update(sent: number, total: number): void; done(): void; fail(message: string): void } {
  const region = document.querySelector<HTMLElement>(".toasts") ?? Object.assign(document.createElement("div"), { className: "toasts" });
  if (!region.isConnected) document.body.append(region);
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = `Wgrywanie „${name}”: 0%`;
  region.append(el);
  return {
    update(sent, total) {
      el.textContent = `Wgrywanie „${name}”: ${total ? Math.min(100, Math.round((sent / total) * 100)) : 0}%`;
    },
    done() {
      el.remove();
    },
    fail(message) {
      el.className = "toast is-error";
      el.setAttribute("role", "alert");
      el.textContent = message;
      setTimeout(() => el.remove(), TOAST_MS);
    },
  };
}

let picker: HTMLInputElement | null = null;

/** The system picker for any files; `onPick` gets them when the user chooses some. */
export function pickFiles(onPick: (files: File[]) => void): void {
  if (!picker?.isConnected) {
    picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    document.body.append(picker);
  }
  const input = picker;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    onPick(files);
  };
  input.click();
}

/** Opens a file that lies in a folder: a picture in a window, a PDF in a new tab (as in Pliki), anything else with a download. */
export async function openFolderFile(store: FileStore, info: FileInfo): Promise<void> {
  try {
    if (info.mime === "application/pdf") {
      // The tab opens before the bytes arrive: a popup opened after the await would be blocked.
      const tab = window.open("", "_blank");
      if (!tab) return download(store, info);
      tab.opener = null;
      const url = URL.createObjectURL(new Blob([await store.read(info.id)], { type: "application/pdf" }));
      tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS);
      return;
    }
    if (isImageMime(info.mime)) {
      const url = URL.createObjectURL(await store.read(info.id));
      openDialog({
        label: `Podgląd: ${info.name}`,
        className: "file-preview",
        render(box) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = info.name;
          box.append(img);
        },
        onClose: () => URL.revokeObjectURL(url),
      });
      return;
    }
    openDialog({
      label: info.name,
      className: "modal-confirm",
      render(box, close) {
        const kind = KIND_LABEL[fileKind(info.name, info.mime)];
        const save = document.createElement("button");
        save.type = "button";
        save.className = "btn btn-primary";
        save.textContent = "Pobierz";
        save.addEventListener("click", () => {
          void download(store, info);
          close();
        });
        box.append(
          Object.assign(document.createElement("h2"), { textContent: info.name }),
          Object.assign(document.createElement("p"), { className: "muted", textContent: `${kind}, ${formatSize(info.size)}` }),
          save,
        );
      },
    });
  } catch (e) {
    toast(`Nie udało się otworzyć pliku: ${errorText(e)}`, true);
  }
}

/** The byte limit of one upload, as the message names it. */
export const TOO_BIG = `Plik jest większy niż ${formatSize(MAX_FILE_BYTES)}.`;

/** Where a protected project refuses files (the note's own insert is the way there). */
export const PROTECTED_FILE_TEXT = "W chronionym projekcie dodaj plik w notatce (Wstaw → Plik).";

// The folder of each file in the tree, for the Pliki page ("w: Projekty/Plan"). The explorer sets it on each listing.
const places = new Map<string, string>();

export function setFilePlaces(rows: { fileId: string; path: string }[]): void {
  places.clear();
  for (const r of rows) places.set(r.fileId, r.path.slice(0, Math.max(0, r.path.lastIndexOf("/"))));
}

/** The folder a file lies in, or null when it lies in no folder (the file is in Pliki only). */
export function placeOfFile(fileId: string): string | null {
  return places.get(fileId) || null;
}
