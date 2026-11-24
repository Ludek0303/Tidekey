//! Pliki: the space's server files (docs/PLIKI.md §7). The list with search and filters, the storage meter, the notes
//! that embed each file, and the trash. The page reaches the notes only through `FilesActions` and the note texts it
//! is given.

import type { TreeItem } from "./bridge";
import { download } from "./attachments";
import { placeOfFile } from "./folderfiles";
import { DAY_MS } from "./calendar/dates";
import { el } from "./dom";
import { FILE_EMBED, type FileInfo, type FileList, type FileStore, KIND_LABEL, fileEmbed, fileKind, formatSize, newEmbedId, newFileId, textLayersOf } from "./filestore";
import { icon } from "./icons";
import { on } from "./bus";
import { badgeText, isRecognizable, ocrBoard, requestRecognize, type OcrStatus, type OcrStatusEvent } from "./ocr/status";
import { previewFiles } from "./preview/triggers";
import { thumbnailFor } from "./thumbnail";
import { errorText, type MenuEntry, openDialog, openMenu, toast } from "./widgets";

let stopWatching: (() => void) | null = null;

export interface UploadLine {
  name: string;
  sent: number;
  total: number;
  error?: string;
}

/** What the page keeps between renders: the filters and the uploads in progress. */
export interface FilesViewState {
  query: string;
  /** A `FileKind`, or "" for every type. */
  kind: string;
  /** `JSON.stringify` of the project path or of null (the whole space), or "" for every project. */
  project: string;
  /** Only the files whose text is missing ("brak tekstu"). */
  noText: boolean;
  uploads: UploadLine[];
}

export function newFilesViewState(): FilesViewState {
  return { query: "", kind: "", project: "", noText: false, uploads: [] };
}

/** One place a note embeds a file: the note, the 1-based line of the embed, and its embed id (null: a legacy embed). */
export interface Usage {
  note: TreeItem;
  line: number;
  embed: string | null;
}

export interface FilesData {
  store: FileStore;
  /** The notes this user can read (the tree). Usages are looked up among them only. */
  notes: TreeItem[];
  /** File id -> its usages; null while the notes are still being read. */
  usages: Map<string, Usage[]> | null;
  /** False with no note open: there is nowhere to insert a file. */
  canInsert: boolean;
  state: FilesViewState;
}

export interface FilesActions {
  /** Opens a note, at a line when given. */
  open(path: string, line?: number): void;
  /** Writes text at the cursor of the open note. */
  insert(text: string): void;
}

/**
 * Where each file is embedded, read from the text of `notes` (docs/PLIKI.md §7). Nothing is stored: the notes are the
 * only source, so this can be run again at any time. Only the given notes are read; a note whose text cannot be read is
 * skipped.
 */
export async function scanUsages(notes: TreeItem[], readText: (id: string) => Promise<string>): Promise<Map<string, Usage[]>> {
  const uses = new Map<string, Usage[]>();
  for (const note of notes) {
    const text = await readText(note.id).catch(() => null);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(FILE_EMBED)) {
        const list = uses.get(m[1]) ?? [];
        list.push({ note, line: i + 1, embed: m[2] ?? null });
        uses.set(m[1], list);
      }
    });
  }
  return uses;
}

/** A new name without an extension keeps the file's old one (`raport` for `raport.pdf` stays `raport.pdf`). */
export function keepExtension(oldName: string, next: string): string {
  const name = next.trim();
  const dot = oldName.lastIndexOf(".");
  if (!name || name.lastIndexOf(".") > 0 || dot <= 0) return name;
  return name + oldName.slice(dot);
}

/** The files matching the search, the type and the project filter (see `FilesViewState`), by name. */
export function filterFiles(files: FileInfo[], s: Pick<FilesViewState, "query" | "kind" | "project"> & Partial<Pick<FilesViewState, "noText">>): FileInfo[] {
  const query = s.query.trim().toLocaleLowerCase("pl");
  return files
    .filter((f) => !query || f.name.toLocaleLowerCase("pl").includes(query))
    .filter((f) => !s.kind || fileKind(f.name, f.mime) === s.kind)
    .filter((f) => !s.project || JSON.stringify(f.project) === s.project)
    .filter((f) => !s.noText || ocrBoard.statusOf(f.id) === "brak tekstu")
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

/** Whole days left in the trash (rounded up; 0 when the file is due). */
export function daysLeft(deletedAt: number, trashDays: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deletedAt + trashDays * DAY_MS - now) / DAY_MS));
}

export const when = (ms: number): string => new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" });
export const noteName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

// The badge's look: a finished text is accented, a failure is red, the rest is the grey default.
const badgeClass = (status: OcrStatus): string => (status === "tekst" ? "files-badge is-ok" : status === "błąd" ? "files-badge is-danger" : "files-badge");

// Opens the preview on `files[index]`; a preview opened with the space bar also closes with it (preview/triggers.ts).
function previewAt(store: FileStore, files: FileInfo[], index: number, bySpace: boolean): void {
  if (bySpace) previewFiles(store, files, index, { bySpace });
  else previewFiles(store, files, index);
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = el("label", "files-field");
  label.append(el("span", "", text), control);
  return label;
}

function actionButton(label: string, name: string, run: () => void): HTMLButtonElement {
  const button = el("button", "btn files-act", label);
  button.type = "button";
  button.setAttribute("aria-label", `${label}: ${name}`);
  button.title = `${label}: ${name}`;
  button.addEventListener("click", run);
  return button;
}

function cell(label: string, ...content: (Node | string)[]): HTMLTableCellElement {
  const td = el("td");
  td.dataset.label = label;
  td.append(...content);
  return td;
}

/** Draws the page into `host`. Returns the setter that gives it the usages once they are read. */
export function renderFilesPage(host: HTMLElement, data: FilesData, actions: FilesActions): (usages: Map<string, Usage[]>) => void {
  const { store, state } = data;
  const root = el("div", "files-page");
  let snapshot: FileList | null = null;
  let usages = data.usages;
  let failure = "";
  let projectSig = "";

  // --- Header with the upload button (the file input stays out of sight; the button opens it).
  const input = el("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  const add = el("button", "btn firstrun-primary", "Dodaj pliki");
  add.type = "button";
  add.setAttribute("aria-label", "Dodaj pliki do przestrzeni");
  add.title = "Dodaj pliki do przestrzeni";
  add.addEventListener("click", () => input.click());
  const actionRow = el("div", "org-actions");
  actionRow.append(add, input);
  const head = el("header", "org-view-head");
  head.append(el("p", "eyebrow", "PLIKI PRZESTRZENI"), el("h2", "", "Pliki"), actionRow);

  // --- Storage meter, filters, uploads, list and trash. Only the list and the meter are redrawn on a change, so the
  // filter controls keep their focus.
  const storage = el("section", "files-storage");
  storage.setAttribute("aria-label", "Miejsce na pliki");

  const search = el("input");
  search.type = "search";
  search.value = state.query;
  search.addEventListener("input", () => { state.query = search.value; draw(); });
  const kinds = el("select");
  kinds.append(new Option("Wszystkie typy", ""));
  for (const [kind, label] of Object.entries(KIND_LABEL)) kinds.append(new Option(label, kind));
  kinds.value = state.kind;
  kinds.addEventListener("change", () => { state.kind = kinds.value; draw(); });
  const projects = el("select");
  projects.addEventListener("change", () => { state.project = projects.value; draw(); });
  const filters = el("div", "files-filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "Filtry plików");
  filters.append(labelled("Szukaj po nazwie", search), labelled("Typ", kinds), labelled("Projekt", projects));
  // the text filter exists where the store keeps text layers (OCR); its state survives the redraws
  if (textLayersOf(store)) {
    const noText = el("input");
    noText.type = "checkbox";
    noText.checked = state.noText;
    noText.addEventListener("change", () => { state.noText = noText.checked; draw(); });
    const check = el("label", "files-check");
    check.append(noText, " Bez tekstu");
    filters.append(check);
  }
  // Announces an OCR status change (not each page) to the screen reader; the badges follow in the list.
  const live = el("p", "files-live");
  live.setAttribute("aria-live", "polite");

  const uploads = el("ul", "files-uploads");
  uploads.setAttribute("aria-live", "polite");
  const list = el("div", "files-list");
  const trashBody = el("div", "files-trash-body");
  const trashSummary = el("summary", "", "Kosz");
  const trash = el("details", "files-trash");
  trash.append(trashSummary, trashBody);

  const drawStorage = (): void => {
    if (!snapshot) { storage.replaceChildren(); return; }
    const { used, quota } = snapshot;
    const text = el("p", "files-storage-text", quota === null ? `Zajęte: ${formatSize(used)} (bez limitu)` : `Zajęte: ${formatSize(used)} z ${formatSize(quota)}`);
    if (quota === null) { storage.replaceChildren(text); return; }
    const percent = Math.min(100, Math.round((used / quota) * 100));
    const bar = el("div", "org-progress");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Zajęte miejsce");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(percent));
    const fill = el("div", "org-progress-bar");
    fill.style.width = `${percent}%`;
    bar.append(fill);
    storage.replaceChildren(text, bar);
  };

  const drawProjects = (files: FileInfo[]): void => {
    const names = [...new Set(files.map((f) => f.project).filter((p): p is string => p !== null))].sort((a, b) => a.localeCompare(b, "pl"));
    const sig = JSON.stringify(names);
    if (sig !== projectSig) {
      projectSig = sig;
      projects.replaceChildren(new Option("Wszystkie projekty", ""), new Option("Cała przestrzeń", "null"), ...names.map((p) => new Option(p, JSON.stringify(p))));
      if (![...projects.options].some((o) => o.value === state.project)) state.project = "";
    }
    projects.value = state.project;
  };

  const drawUploads = (): void => {
    uploads.hidden = state.uploads.length === 0;
    uploads.replaceChildren(
      ...state.uploads.map((u) => {
        const li = el("li", "files-upload");
        li.append(el("span", "", u.name), " ", el("span", u.error ? "firstrun-error" : "muted", u.error ?? `${formatSize(u.sent)} z ${formatSize(u.total)}`));
        return li;
      }),
    );
  };

  const drawList = (): void => {
    if (failure) { const p = el("p", "firstrun-error", failure); p.setAttribute("role", "alert"); list.replaceChildren(p); return; }
    if (!snapshot) { list.replaceChildren(el("p", "muted", "Wczytywanie…")); return; }
    const active = snapshot.files.filter((f) => f.state !== "trashed");
    if (!active.length) { list.replaceChildren(el("p", "org-hint", "Nie ma jeszcze plików. Dodaj pliki przyciskiem „Dodaj pliki”.")); return; }
    const shown = filterFiles(active, state);
    if (!shown.length) { list.replaceChildren(el("p", "org-hint", "Żaden plik nie pasuje do wyszukiwania i filtrów.")); return; }
    const table = el("table", "files-table");
    table.setAttribute("aria-label", "Pliki przestrzeni");
    const headRow = table.createTHead().insertRow();
    for (const h of ["Nazwa", "Typ", "Rozmiar", "Dodano", "Projekt", "Użycia", "Akcje"]) headRow.append(el("th", "", h));
    const days = snapshot.trashDays;
    const body = table.createTBody();
    shown.forEach((f, i) => body.append(fileRow(f, days, (bySpace) => previewAt(store, shown, i, bySpace))));
    list.replaceChildren(table);
  };

  const drawTrash = (): void => {
    const gone = snapshot?.files.filter((f) => f.state === "trashed") ?? [];
    trashSummary.textContent = `Kosz (${gone.length})`;
    if (!snapshot) { trashBody.replaceChildren(); return; }
    if (!gone.length) { trashBody.replaceChildren(el("p", "muted", "Kosz jest pusty.")); return; }
    const days = snapshot.trashDays;
    const ul = el("ul", "files-trash-list");
    for (const f of gone) {
      const li = el("li", "files-trash-item");
      const left = f.deletedAt === null ? "" : ` · ${trashLeft(daysLeft(f.deletedAt, days))}`;
      li.append(el("span", "files-name", f.name), " ", el("span", "muted", `${formatSize(f.size)}${left}`));
      li.append(actionButton("Przywróć", f.name, () => void attempt(store.restore(f.id), "Plik przywrócony.")));
      ul.append(li);
    }
    trashBody.replaceChildren(ul, el("p", "muted", `Plik w koszu można przywrócić; po ${days} dniach zostanie usunięty na stałe.`));
  };

  const draw = (): void => {
    drawStorage();
    if (snapshot) drawProjects(snapshot.files);
    drawUploads();
    drawList();
    drawTrash();
  };

  // Changes during a listing ask for one more, not one each: K uploads do not cost K listings.
  let loading = false;
  let again = false;
  const load = async (): Promise<void> => {
    again = loading;
    if (loading) return;
    loading = true;
    do {
      again = false;
      try {
        snapshot = await store.list();
        failure = "";
      } catch (e) {
        failure = errorText(e);
      }
    } while (again);
    loading = false;
    draw();
  };

  // One listener per page: a redraw of the page, or another view replacing it, drops the last one.
  stopWatching?.();
  const unwatch = store.onChange(() => {
    if (!host.contains(root)) stopWatching?.();
    else void load();
  });
  // OCR: a status change redraws the list and is announced; a page only redraws the badge
  const offStatus = on("ocr:status", (detail) => {
    if (!host.contains(root)) return stopWatching?.();
    const e = detail as OcrStatusEvent;
    const name = snapshot?.files.find((f) => f.id === e.fileId)?.name;
    if (name && e.status) live.textContent = `${name}: ${badgeText(e.status)}`;
    drawList();
  });
  const offProgress = on("ocr:progress", () => { if (host.contains(root)) drawList(); });
  stopWatching = () => { unwatch(); offStatus(); offProgress(); stopWatching = null; };

  async function attempt(work: Promise<unknown>, done?: string): Promise<void> {
    try {
      await work;
      if (done) toast(done);
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  async function addFiles(picked: File[]): Promise<void> {
    state.uploads = state.uploads.filter((u) => !u.error);
    for (const file of picked) {
      const line: UploadLine = { name: file.name, sent: 0, total: file.size };
      state.uploads.push(line);
      draw();
      try {
        await store.upload(file, {
          id: newFileId(),
          project: null,
          thumbnail: await thumbnailFor(file),
          onProgress: (sent, total) => { line.sent = sent; line.total = total; drawUploads(); },
        });
        state.uploads = state.uploads.filter((u) => u !== line);
      } catch (e) {
        line.error = `${file.name}: ${errorText(e)}`;
      }
      draw();
    }
    await load();
  }

  // `preview` opens the preview at this file among the shown ones (drawList gives it that list).
  function fileRow(f: FileInfo, trashDays: number, preview: (bySpace: boolean) => void): HTMLTableRowElement {
    const row = el("tr");
    row.tabIndex = 0;
    row.className = "files-row";
    const ready = f.state === "ready";
    const count = usages ? usages.get(f.id)?.length ?? 0 : null;
    const kind = fileKind(f.name, f.mime);
    const nameCell = cell("Nazwa", el("span", "", f.name));
    // A file that lies in a folder of the tree says which (folderfiles.ts).
    const place = placeOfFile(f.id);
    if (place) nameCell.append(" ", el("span", "muted", `w: ${place}`));
    const ocr = ocrBoard.statusOf(f.id);
    if (ocr) nameCell.append(" ", el("span", badgeClass(ocr), badgeText(ocr, ocrBoard.progressOf(f.id))));
    if (f.state === "missing") nameCell.append(" ", el("span", "files-badge is-danger", "brak treści"));
    if (f.state === "uploading") nameCell.append(" ", el("span", "files-badge", "w przesyłaniu"));
    const kindLabel = el("span", `files-kind files-kind-${kind}`);
    kindLabel.append(icon("file-text"), ` ${KIND_LABEL[kind]}`);
    const usage = cell("Użycia");
    if (count === null) usage.append(el("span", "muted", "…"));
    else if (count > 0) usage.append(String(count));
    else usage.append(el("span", "files-badge", "nieużywany"));
    const pobierz = () => void download(store, f);
    const wstaw = () => actions.insert(fileEmbed(f.id, null, newEmbedId()));
    const zmien = () => rename(f);
    const uzycia = () => showUses(f);
    const kosz = () => void trashFile(f, trashDays);
    const buttons = cell("Akcje");
    buttons.className = "files-actions";
    if (ready) {
      buttons.append(actionButton("Podgląd", f.name, () => preview(false)));
      buttons.append(actionButton("Pobierz", f.name, pobierz));
      const insert = actionButton("Wstaw do notatki", f.name, wstaw);
      insert.disabled = !data.canInsert;
      if (!data.canInsert) insert.title = "Najpierw otwórz notatkę, w której ma być plik";
      buttons.append(insert);
    }
    buttons.append(actionButton("Zmień nazwę", f.name, zmien), actionButton("Użycia", f.name, uzycia), actionButton("Do kosza", f.name, kosz));
    row.append(
      nameCell,
      cell("Typ", kindLabel),
      cell("Rozmiar", formatSize(f.size)),
      cell("Dodano", when(f.createdAt)),
      cell("Projekt", f.project ?? "Cała przestrzeń"),
      usage,
      buttons,
    );

    // The row opens the preview on a double click (not on its buttons), and on Enter or the space bar when the row itself has focus.
    const showPreview = (bySpace: boolean): void => {
      if (ready) preview(bySpace);
    };
    row.addEventListener("dblclick", (e) => {
      if (!(e.target instanceof Element && e.target.closest("button"))) showPreview(false);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return; // a key on one of the row's buttons belongs to the button
      if (e.key === " ") {
        e.preventDefault();
        showPreview(true);
      } else if (e.key === "Enter") {
        showPreview(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const next = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        if (next instanceof HTMLElement) {
          e.preventDefault();
          next.focus();
        }
      }
    });
    // The same actions as the buttons; the menu is built when it opens, so it sees the current note.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const entries: MenuEntry[] = [];
      if (ready) entries.push({ label: "Podgląd", icon: "eye", run: () => preview(false) }, { label: "Pobierz", icon: "download", run: pobierz });
      if (ready && data.canInsert) entries.push({ label: "Wstaw do notatki", icon: "link", run: wstaw });
      if (ready && ocrBoard.writable && isRecognizable(f.mime)) entries.push({ label: "Rozpoznaj tekst", icon: "file-text", run: () => requestRecognize(f.id) });
      entries.push({ label: "Zmień nazwę", icon: "pencil", run: zmien }, { label: "Użycia", icon: "file-search", run: uzycia }, { label: "Do kosza", icon: "trash-2", run: kosz });
      openMenu(e.clientX, e.clientY, entries);
    });
    return row;
  }

  function rename(f: FileInfo): void {
    openDialog({
      label: `Zmień nazwę pliku ${f.name}`,
      className: "modal-confirm",
      render(box, close) {
        const field = el("input");
        field.type = "text";
        field.value = f.name;
        field.setAttribute("aria-label", "Nowa nazwa pliku");
        const error = el("p", "firstrun-error");
        error.setAttribute("role", "alert");
        const row = el("div", "modal-actions");
        const cancel = el("button", "btn", "Anuluj");
        cancel.type = "button";
        cancel.addEventListener("click", () => close());
        const save = el("button", "btn btn-primary", "Zapisz");
        save.type = "button";
        const submit = () => {
          const name = keepExtension(f.name, field.value);
          if (!name) { error.textContent = "Nazwa nie może być pusta."; return; }
          save.disabled = true;
          store.rename(f.id, name).then(
            () => { close(); toast("Zmieniono nazwę pliku."); },
            (e: unknown) => { error.textContent = errorText(e); save.disabled = false; },
          );
        };
        save.addEventListener("click", submit);
        field.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        row.append(cancel, save);
        box.append(el("h2", "", "Zmień nazwę pliku"), field, error, row);
      },
    });
  }

  function showUses(f: FileInfo): void {
    openDialog({
      label: `Użycia pliku ${f.name}`,
      className: "modal-confirm",
      render(box, close) {
        box.append(el("h2", "", `Użycia: ${f.name}`));
        if (!usages) { box.append(el("p", "muted", "Użycia są jeszcze liczone…")); return; }
        const uses = usages.get(f.id) ?? [];
        if (!uses.length) { box.append(el("p", "muted", "Żadna notatka, którą możesz otworzyć, nie wstawia tego pliku.")); return; }
        const list = el("ul", "files-uses");
        for (const use of uses) {
          const { note } = use;
          const button = el("button", "btn", noteName(note.path));
          button.type = "button";
          button.title = `Otwórz notatkę ${note.path}, wiersz ${use.line}`;
          button.setAttribute("aria-label", `Otwórz notatkę ${note.path}, wiersz ${use.line}`);
          button.addEventListener("click", () => { close(); actions.open(note.path, use.line); });
          const item = el("li");
          item.append(button, " ", el("span", "muted", `${note.path} · wiersz ${use.line}`));
          list.append(item);
        }
        box.append(list);
      },
    });
  }

  // The trash keeps it `days` days, so no question first; Cofnij brings it back at once.
  async function trashFile(f: FileInfo, days: number): Promise<void> {
    try {
      await store.trash(f.id);
    } catch (e) {
      toast(errorText(e), true);
      return;
    }
    toast(`Przeniesiono do kosza plik „${f.name}” (usunięcie na stałe po ${days} dniach).`, false, {
      label: "Cofnij",
      run: () => void attempt(store.restore(f.id), "Plik przywrócony."),
    });
  }

  // --- Uploads: the file input's files, each stored under a fresh id in the space (no project).
  input.addEventListener("change", () => {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (picked.length) void addFiles(picked);
  });

  host.replaceChildren(root);
  root.append(head, storage, filters, uploads, live, list, trash);
  if (!data.canInsert) root.insertBefore(el("p", "org-hint", "Otwórz notatkę, aby wstawić do niej plik."), list);
  draw();
  void load();
  return (next) => {
    usages = next;
    draw();
  };
}

function trashLeft(days: number): string {
  if (days === 0) return "zostanie usunięty wkrótce";
  return `zostanie usunięty na stałe za ${days} ${days === 1 ? "dzień" : "dni"}`;
}
