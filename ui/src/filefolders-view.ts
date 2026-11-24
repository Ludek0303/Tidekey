//! The folder UI (filefolders.ts holds the text rules): the card in Live Preview and the reading view, the bar above the
//! note, and the dialog that lists a folder's files and changes it. Every change is a normal transaction on the
//! editor's view, so Yjs and undo see it; nothing writes the document behind the editor's back.

import { EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { Bridge } from "./bridge";
import { bridgeOf, dropUpload, Owner, imageUrl, insertFiles, isImage, onUploadChange, thumbOf, uploadOf } from "./attachments";
import {
  addEmbedsChange, deleteSubfolderChange, foldedFolders, folderLabel, folderSummary, type Folder, type FolderFile, foldersOf, insertFolderChange,
  parseFolders, removeFileChange, renameChange, subfolderChange,
} from "./filefolders";
import { type FileInfo, fileKind, type FileStore, filesOf, formatSize, KIND_LABEL } from "./filestore";
import { icon } from "./icons";
import { previewFiles } from "./preview/triggers";
import { askName, confirmDialog, openDialog, toast } from "./widgets";

/** A folder button: the card in Live Preview and the reading view, or a chip in the bar above the note. */
export function folderButton(title: string, summary: string, onClick: () => void, cls = "file-folder-chip"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  const name = folderLabel(title);
  btn.title = `Otwórz folder: ${name}`;
  btn.setAttribute("aria-label", `Folder ${name}, ${summary}`);
  const label = document.createElement("span");
  label.className = "file-folder-name";
  label.textContent = name;
  const n = document.createElement("span");
  n.className = "file-folder-count";
  n.textContent = summary;
  btn.append(icon("folder"), label, n);
  btn.addEventListener("click", onClick);
  return btn;
}

// A folder with the caret outside it: one row card, in place of its quote lines (a block, so it comes from a StateField).
class FolderCard extends WidgetType {
  constructor(
    readonly index: number,
    readonly title: string,
    readonly summary: string,
  ) {
    super();
  }

  eq(o: FolderCard): boolean {
    return o.index === this.index && o.title === this.title && o.summary === this.summary;
  }

  toDOM(view: EditorView): HTMLElement {
    return folderButton(this.title, this.summary, () => openFolderDialog(view, this.index, bridgeOf(view.state)), "file-folder-card");
  }

  ignoreEvent(): boolean {
    return true; // the button is the card's own; a click must not move the caret
  }
}

function folderCards(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const all = foldersOf(state.doc);
  for (const f of foldedFolders(state)) {
    out.push(Decoration.replace({ widget: new FolderCard(f.index, f.title, folderSummary(all, f.index)), block: true }).range(f.from, f.to));
  }
  return Decoration.set(out, true);
}

/** Folder cards for Live Preview (added by livePreview() in livepreview.ts). */
export const folderCardsField = StateField.define<DecorationSet>({
  create: folderCards,
  update: (value, tr) => (tr.docChanged || tr.selection ? folderCards(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

const basename = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

/** A subfolder can be added to a folder up to this depth (the button is hidden at it). */
const MAX_DEPTH = 5;

/**
 * The folder's dialog: its name, its subfolders and files as tiles, and where to drop or pick more. `index` is the
 * folder's place in the note; the dialog keeps the folder it shows (a subfolder is opened in place).
 */
export function openFolderDialog(view: EditorView, index: number, bridge: Bridge | null): void {
  const parse = (): Folder[] => parseFolders(view.state.doc.toString());
  if (!parse()[index]) return;
  // The folder is found again on each use: the note may have changed under the dialog.
  let shown = index;
  const current = (): Folder | undefined => parse()[shown];
  const store: FileStore | null = bridge ? filesOf(bridge) : null;
  const infos = new Map<string, Promise<FileInfo>>();
  let owner = new Owner(); // object URLs of the last paint; released by the next one
  let boxEl: HTMLElement | null = null;
  const head = document.createElement("div");
  let count = document.createElement("span");
  let grid = document.createElement("div");
  let closeDialog: () => void = () => {};
  let stopUploads: () => void = () => {};

  const loadInfo = (s: FileStore, id: string): Promise<FileInfo> => {
    let p = infos.get(id);
    if (!p) {
      p = s.info(id).then((info) => {
        if (!info) throw new Error("no file");
        return info;
      });
      infos.set(id, p);
    }
    return p;
  };

  // The preview of a server file pages through the folder's server files, in the order the note shows them.
  const previewServer = async (s: FileStore, fileId: string): Promise<void> => {
    const ids = (current()?.files ?? []).flatMap((f) => (f.id ? [f.id] : []));
    const infos = (await Promise.all(ids.map((id) => loadInfo(s, id).catch(() => null)))).filter((i): i is FileInfo => i !== null);
    previewFiles(s, infos, infos.findIndex((i) => i.id === fileId));
  };

  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    void insertFiles(view, files, (text) => {
      const f = current();
      if (!f) return toast("Folder zniknął z notatki.", true);
      view.dispatch({ changes: addEmbedsChange(f, text.split("\n")) });
      paint();
    });
  };

  const navigate = (i: number): void => {
    shown = i;
    renderHead();
    paint();
  };

  const addSubfolder = async (): Promise<void> => {
    const name = await askName("Nowy folder", "Nazwa folderu", (n) => (n.trim() ? null : "Podaj nazwę folderu."));
    if (name === null) return;
    const f = current();
    if (!f) return closeDialog();
    view.dispatch({ changes: subfolderChange(f, name) });
    paint();
  };

  const removeSubfolder = async (): Promise<void> => {
    const f = current();
    if (!f || f.parent === null) return;
    const ok = await confirmDialog(`Usunąć folder „${folderLabel(f.title)}”? Pliki zostają w zakładce „Pliki”.`, "Usuń folder");
    if (!ok) return;
    const g = current();
    if (g?.from !== f.from) {
      toast("Folder zmienił się w notatce. Spróbuj ponownie.", true);
      return paint();
    }
    view.dispatch({ changes: deleteSubfolderChange(g) });
    navigate(f.parent);
  };

  // The header: the parents of the shown folder as links, its name (editable), its count and its actions.
  const renderHead = (): void => {
    const list = parse();
    const f = list[shown];
    if (!f) return closeDialog();
    const srTitle = boxEl?.querySelector(".sr-only");
    if (srTitle) srTitle.textContent = `Folder: ${folderLabel(f.title)}`;
    const trail: Folder[] = [];
    for (let p = f.parent; p !== null; p = list[p].parent) trail.unshift(list[p]);
    const crumbs = document.createElement("div");
    crumbs.className = "folder-trail";
    for (const p of trail) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "folder-crumb";
      link.textContent = folderLabel(p.title);
      link.setAttribute("aria-label", `Przejdź do folderu ${folderLabel(p.title)}`);
      link.addEventListener("click", () => navigate(p.index));
      const sep = document.createElement("span");
      sep.className = "folder-sep";
      sep.textContent = "›";
      sep.setAttribute("aria-hidden", "true");
      crumbs.append(link, sep);
    }
    const name = document.createElement("input");
    name.type = "text";
    name.id = "folder-name";
    name.className = "task-input folder-name";
    name.value = f.title;
    name.placeholder = "Pliki";
    name.setAttribute("aria-label", "Nazwa folderu");
    name.addEventListener("change", () => {
      const g = current();
      if (g) view.dispatch({ changes: renameChange(g, name.value) });
    });
    crumbs.append(name);
    count = document.createElement("span");
    count.className = "folder-count";
    const actions = document.createElement("div");
    actions.className = "folder-actions";
    if (f.depth < MAX_DEPTH) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn";
      add.setAttribute("aria-label", "Nowy folder w tym folderze");
      add.append(icon("folder-plus"), " Nowy folder");
      add.addEventListener("click", () => void addSubfolder());
      actions.append(add);
    }
    if (f.parent !== null) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-danger";
      del.setAttribute("aria-label", `Usuń folder ${folderLabel(f.title)}`);
      del.textContent = "Usuń folder";
      del.addEventListener("click", () => void removeSubfolder());
      actions.append(del);
    }
    head.replaceChildren(icon("folder"), crumbs, count, actions);
  };

  // A subfolder's tile: a click opens it in this dialog.
  const subTile = (g: Folder, list: Folder[]): HTMLElement => {
    const el = document.createElement("div");
    el.className = "folder-tile";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "folder-tile-open";
    const pic = document.createElement("span");
    pic.className = "folder-tile-pic is-folder";
    pic.append(icon("folder"));
    const name = document.createElement("span");
    name.className = "folder-tile-name";
    name.textContent = folderLabel(g.title);
    const meta = document.createElement("span");
    meta.className = "folder-tile-meta";
    meta.textContent = folderSummary(list, g.index);
    open.append(pic, name, meta);
    open.setAttribute("aria-label", `Otwórz folder ${folderLabel(g.title)}, ${meta.textContent}`);
    open.addEventListener("click", () => navigate(g.index));
    el.append(open);
    return el;
  };

  const removeTile = async (file: FolderFile, i: number, label: string): Promise<void> => {
    const same = (f: Folder | undefined): boolean => f?.files[i]?.id === file.id && f.files[i]?.rel === file.rel;
    if (!same(current())) {
      toast("Folder zmienił się w notatce. Spróbuj ponownie.", true);
      return paint();
    }
    const ok = await confirmDialog(`Usunąć „${label}” z folderu? Usuwa się tylko odnośnik w notatce, plik zostaje w zakładce „Pliki”.`, "Usuń z folderu", false);
    if (!ok) return;
    const f = current();
    if (!f || !same(f)) {
      toast("Folder zmienił się w notatce. Spróbuj ponownie.", true);
      return paint();
    }
    if (file.id && uploadOf(file.id)) dropUpload(view, file.id); // an upload in progress also goes, with its embed
    else view.dispatch({ changes: removeFileChange(view.state.doc.toString(), f.files[i]) });
    paint();
  };

  const tile = (file: FolderFile, i: number, run: Owner): HTMLElement => {
    const el = document.createElement("div");
    el.className = "folder-tile";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "folder-tile-open";
    const pic = document.createElement("span");
    pic.className = "folder-tile-pic";
    pic.append(icon("file-text"));
    const name = document.createElement("span");
    name.className = "folder-tile-name";
    const meta = document.createElement("span");
    meta.className = "folder-tile-meta";
    const bar = document.createElement("span");
    bar.className = "file-upload-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Postęp wysyłania");
    const fill = document.createElement("span");
    fill.className = "file-upload-fill";
    bar.append(fill);
    bar.hidden = true;
    open.append(pic, name, meta, bar);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "folder-tile-remove";
    remove.textContent = "×";
    el.append(open, remove);

    const up = file.id ? uploadOf(file.id) : null;
    let label = file.rel ? basename(file.rel) : "Plik";
    if (up) {
      label = up.name;
      meta.textContent = up.error ?? `Wysyłanie… ${up.pct}%`;
      bar.hidden = up.error !== null;
      bar.setAttribute("aria-valuenow", String(up.pct));
      fill.style.width = `${up.pct}%`;
      open.disabled = true;
    } else if (file.id && store) {
      const s = store;
      const fileId = file.id;
      name.textContent = "Wczytywanie…";
      loadInfo(s, fileId).then(
        (loaded) => {
          label = loaded.name;
          name.textContent = loaded.name;
          if (loaded.state !== "ready") {
            meta.textContent = loaded.state === "trashed" ? "Plik w koszu" : "Plik niedostępny";
            open.disabled = true;
            return;
          }
          meta.textContent = `${KIND_LABEL[fileKind(loaded.name, loaded.mime)]} · ${formatSize(loaded.size)}`;
          void thumbOf(s, loaded, run).then((url) => {
            if (!url) return;
            const img = document.createElement("img");
            img.alt = "";
            img.src = url;
            pic.replaceChildren(img);
          });
        },
        () => {
          name.textContent = label;
          meta.textContent = "Plik niedostępny";
          open.disabled = true;
        },
      );
      open.addEventListener("click", () => void previewServer(s, fileId));
      // A double click on the tile itself opens the preview too; its buttons keep their own clicks.
      el.addEventListener("dblclick", (e) => {
        if (!open.disabled && !(e.target instanceof Element && e.target.closest("button"))) void previewServer(s, fileId);
      });
    } else if (file.rel && bridge) {
      const rel = file.rel;
      const b = bridge;
      name.textContent = label;
      meta.textContent = "Plik z pulpitu";
      if (isImage(rel)) {
        void imageUrl(b, rel).then((url) => {
          if (!run.add(url)) return;
          const img = document.createElement("img");
          img.alt = "";
          img.src = url;
          pic.replaceChildren(img);
        });
        open.addEventListener("click", () => void showPicture(b, rel, label));
      } else open.disabled = true;
    }
    name.textContent ||= label;
    open.setAttribute("aria-label", `Otwórz ${label}`);
    remove.title = up?.error ? `Usuń plik ${label}` : `Usuń z folderu: ${label}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => void removeTile(file, i, label));
    return el;
  };

  // Repaints the subfolder and file tiles from the note. Upload progress comes through here too.
  const paint = (): void => {
    const list = parse();
    const f = list[shown];
    if (!f) {
      closeDialog();
      return;
    }
    owner.release();
    owner = new Owner();
    count.textContent = folderSummary(list, shown);
    const nodes = [...list.filter((g) => g.parent === shown).map((g) => subTile(g, list)), ...f.files.map((file, i) => tile(file, i, owner))];
    if (nodes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "folder-empty";
      empty.textContent = "Folder jest pusty. Dodaj pliki poniżej.";
      nodes.push(empty);
    }
    grid.replaceChildren(...nodes);
  };

  openDialog({
    label: `Folder: ${folderLabel(parse()[index].title)}`,
    className: "folder-dialog",
    onClose: () => {
      owner.release();
      stopUploads();
    },
    render(box, close) {
      boxEl = box;
      closeDialog = close;
      head.className = "folder-head";
      grid = document.createElement("div");
      grid.className = "folder-grid";

      const drop = document.createElement("div");
      drop.className = "folder-drop";
      const hint = document.createElement("span");
      hint.textContent = "Przeciągnij pliki tutaj albo";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn";
      add.textContent = "Dodaj pliki";
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.hidden = true;
      add.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        addFiles([...(input.files ?? [])]);
        input.value = "";
      });
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.classList.add("over");
      });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        addFiles([...(e.dataTransfer?.files ?? [])]);
      });
      drop.append(hint, add, input);

      box.append(head, grid, drop);
      stopUploads = onUploadChange(() => paint());
      renderHead();
      paint();
    },
  });
}

// A picture of a desktop attachment at full size.
function showPicture(bridge: Bridge, rel: string, title: string): Promise<void> {
  return imageUrl(bridge, rel).then((url) => {
    openDialog({
      label: `Podgląd: ${title}`,
      className: "file-preview",
      onClose: () => URL.revokeObjectURL(url),
      render(box) {
        const img = document.createElement("img");
        img.className = "file-full";
        img.alt = title;
        img.src = url;
        box.append(img);
      },
    });
  });
}

/** Asks for a name, adds a folder at `at` (the caret, or the end of the note), puts the caret after it and opens it. */
export async function addFolder(view: EditorView, at: number): Promise<void> {
  const name = await askName("Nowy folder z plikami", "Nazwa folderu", (n) => (n.trim() ? null : "Podaj nazwę folderu."));
  if (name === null) return;
  const { change, caret } = insertFolderChange(view.state.doc.toString(), at, name);
  view.dispatch({ changes: change, selection: { anchor: caret }, scrollIntoView: true });
  const index = parseFolders(view.state.doc.toString()).findIndex((f) => f.from >= change.from && f.from < caret);
  if (index >= 0) openFolderDialog(view, index, bridgeOf(view.state));
}

export interface FolderPanel {
  refresh(): void;
}

/**
 * The bar above the note (and above its reading view): the note's folders as chips and "+ Nowy folder". With no folder
 * and a file store it is only "+ Folder z plikami"; with neither, it is hidden. Recomputed from the text by refresh().
 */
export function mountFolderPanel(anchor: HTMLElement, reading: HTMLElement, bridge: Bridge, view: () => EditorView): FolderPanel {
  const el = document.createElement("div");
  el.className = "file-folders";
  el.hidden = true;
  anchor.before(el);

  const refresh = (): void => {
    const v = view();
    const all = parseFolders(v.state.doc.toString());
    const folders = all.filter((f) => f.depth === 1);
    const store = filesOf(bridge);
    const shown = !anchor.hidden || !reading.hidden;
    el.hidden = !shown || (folders.length === 0 && !store);
    if (el.hidden) {
      el.replaceChildren();
      return;
    }
    const add = (label: string, cls: string): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = cls;
      btn.textContent = label;
      btn.addEventListener("click", () => void addFolder(v, v.state.doc.length));
      return btn;
    };
    if (folders.length === 0) {
      el.replaceChildren(add("+ Folder z plikami", "file-folders-add"));
      return;
    }
    const label = document.createElement("span");
    label.className = "file-folders-label";
    label.textContent = "Pliki notatki";
    el.replaceChildren(
      label,
      ...folders.map((f) => folderButton(f.title, folderSummary(all, f.index), () => openFolderDialog(v, f.index, bridge))),
      add("+ Nowy folder", "file-folders-add"),
    );
  };

  new MutationObserver(refresh).observe(anchor, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(refresh).observe(reading, { attributes: true, attributeFilter: ["hidden"] });
  refresh();
  return { refresh };
}

/**
 * Reading view: each folder callout becomes one card, as in Live Preview. Call it before embedReadingImages, so the
 * folder's embeds are not drawn in a row. The reading view shows the note's text, so the i-th folder callout is folder i.
 */
export function foldReadingFolders(root: HTMLElement, text: string, view: EditorView, bridge: Bridge | null): void {
  const folders = parseFolders(text);
  const top = folders.filter((f) => f.depth === 1);
  // a subfolder's callout is inside its parent's blockquote, so only the outermost ones are cards
  const quotes = [...root.querySelectorAll<HTMLElement>("blockquote")].filter(
    (q) => !q.parentElement?.closest("blockquote") && /^\s*\[!pliki\]/i.test(q.textContent ?? ""),
  );
  quotes.forEach((q, i) => {
    const f = top[i];
    if (f) q.replaceWith(folderButton(f.title, folderSummary(folders, f.index), () => openFolderDialog(view, f.index, bridge), "file-folder-card"));
  });
}

