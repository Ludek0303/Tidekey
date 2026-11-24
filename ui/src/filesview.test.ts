// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeItem } from "./bridge";
import { FILE_EMBED, MemoryFileStore } from "./filestore";
import { ocrBoard } from "./ocr/status";
import { type FilesActions, type FilesData, type Usage, daysLeft, filterFiles, keepExtension, newFilesViewState, renderFilesPage, scanUsages } from "./filesview";
import { previewFiles } from "./preview/triggers";

vi.mock("./preview/triggers", () => ({ previewFiles: vi.fn() }));

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const notes: TreeItem[] = [
  { id: "n1", path: "Projekty/Alfa/Plan.md" },
  { id: "n2", path: "Notatka.md" },
];

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function seed(store: MemoryFileStore) {
  await store.upload(new File(["x".repeat(2000)], "Raport.pdf", { type: "application/pdf" }), { id: ID_A, project: "Projekty/Alfa" });
  await store.upload(new File(["abc"], "notatki.txt", { type: "text/plain" }), { id: ID_B });
  await store.upload(new File(["zz"], "logo.png", { type: "image/png" }), { id: ID_C });
  return store;
}

const usageOf = (note: TreeItem, line: number, embed: string | null = null): Usage => ({ note, line, embed });

async function setup(opts: { usages?: Map<string, Usage[]> | null; store?: MemoryFileStore; canInsert?: boolean } = {}) {
  const store = opts.store ?? (await seed(new MemoryFileStore("jan")));
  const actions: FilesActions = { open: vi.fn(), insert: vi.fn() };
  const host = document.createElement("div");
  document.body.append(host);
  const data: FilesData = {
    store,
    notes,
    usages: opts.usages === undefined ? new Map([[ID_A, [usageOf(notes[0], 7, "12345678")]]]) : opts.usages,
    canInsert: opts.canInsert ?? true,
    state: newFilesViewState(),
  };
  const setUsages = renderFilesPage(host, data, actions);
  await settle();
  return { store, actions, host, data, setUsages };
}

const rowNames = (host: HTMLElement) => [...host.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
const rowFor = (host: HTMLElement, name: string) => [...host.querySelectorAll("tbody tr")].find((r) => r.querySelector("td")?.textContent?.includes(name)) as HTMLElement | undefined;
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label")?.startsWith(`${label}:`)) as HTMLButtonElement;
const dialog = () => document.querySelector<HTMLElement>(".modal")!;

const menuLabels = () => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((b) => b.textContent);
const key = (k: string, target: EventTarget) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
// The arguments of the last call to previewFiles: the store, the files to page through, the index, the options.
const lastPreview = () => vi.mocked(previewFiles).mock.lastCall!;

afterEach(() => {
  document.body.replaceChildren();
  document.querySelectorAll(".modal, .modal-backdrop, .menu").forEach((n) => n.remove());
  vi.mocked(previewFiles).mockClear();
});

describe("Pliki page", () => {
  it("lists the files with their type, size, project and usage count", async () => {
    const { host } = await setup();
    expect(rowNames(host)).toEqual(["logo.png", "notatki.txt", "Raport.pdf"]);
    const raport = rowFor(host, "Raport.pdf")!;
    expect(raport.textContent).toContain("PDF");
    expect(raport.textContent).toContain("2 KB");
    expect(raport.textContent).toContain("Projekty/Alfa");
    expect(raport.querySelector("td[data-label='Użycia']")?.textContent).toBe("1");
    expect(rowFor(host, "notatki.txt")!.textContent).toContain("nieużywany");
  });

  it("shows the storage used against the quota", async () => {
    const { host, store } = await setup();
    const text = host.querySelector(".files-storage-text")!.textContent!;
    expect(text).toMatch(/^Zajęte: .+ z 200 MB$/);
    expect(host.querySelector(".org-progress")?.getAttribute("aria-valuenow")).toBe("0");
    store.quota = null;
    await store.rename(ID_A, "Raport.pdf");
    await settle();
    expect(host.querySelector(".files-storage-text")!.textContent).toContain("bez limitu");
  });

  it("never lists thumbnails", async () => {
    const store = await seed(new MemoryFileStore("jan"));
    await store.upload(new File(["p"], "foto.png", { type: "image/png" }), { id: "d".repeat(32), thumbnail: { blob: new Blob(["t"], { type: "image/jpeg" }), width: 1, height: 1 } });
    const { host } = await setup({ store });
    expect(rowNames(host)).toHaveLength(4);
  });

  it("filters by name, type and project", async () => {
    const { host } = await setup();
    const search = host.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "RAP";
    search.dispatchEvent(new Event("input"));
    expect(rowNames(host)).toEqual(["Raport.pdf"]);

    search.value = "";
    search.dispatchEvent(new Event("input"));
    const kind = host.querySelector<HTMLSelectElement>("select")!;
    kind.value = "image";
    kind.dispatchEvent(new Event("change"));
    expect(rowNames(host)).toEqual(["logo.png"]);

    kind.value = "";
    kind.dispatchEvent(new Event("change"));
    const project = host.querySelectorAll<HTMLSelectElement>("select")[1];
    project.value = JSON.stringify("Projekty/Alfa");
    project.dispatchEvent(new Event("change"));
    expect(rowNames(host)).toEqual(["Raport.pdf"]);

    project.value = "null";
    project.dispatchEvent(new Event("change"));
    expect(rowNames(host)).toEqual(["logo.png", "notatki.txt"]);
  });

  it("opens the chosen usage at its line; notes it was not given are never named", async () => {
    const { host, actions } = await setup({ usages: new Map([[ID_A, [usageOf(notes[0], 7, "12345678")]]]) });
    button(rowFor(host, "Raport.pdf")!, "Użycia").click();
    expect(dialog().textContent).toContain("Plan");
    expect(dialog().textContent).toContain("wiersz 7");
    expect(dialog().textContent).not.toContain("n9");
    [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Plan")!.click();
    expect(actions.open).toHaveBeenCalledWith("Projekty/Alfa/Plan.md", 7);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("says the usages are still being counted until they arrive", async () => {
    const { host, setUsages, actions } = await setup({ usages: null });
    expect(rowFor(host, "Raport.pdf")!.querySelector("td[data-label='Użycia']")?.textContent).toBe("…");
    setUsages(new Map([[ID_A, [usageOf(notes[1], 3)]]]));
    expect(rowFor(host, "Raport.pdf")!.querySelector("td[data-label='Użycia']")?.textContent).toBe("1");
    button(rowFor(host, "Raport.pdf")!, "Użycia").click();
    expect(dialog().textContent).toContain("Notatka.md");
    [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Notatka")!.click();
    expect(actions.open).toHaveBeenCalledWith("Notatka.md", 3);
  });

  it("renames, keeping the extension when the new name has none", async () => {
    const { store, host } = await setup();
    button(rowFor(host, "Raport.pdf")!, "Zmień nazwę").click();
    const field = dialog().querySelector<HTMLInputElement>("input")!;
    field.value = "Budżet";
    [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Zapisz")!.click();
    await settle();
    expect((await store.info(ID_A))!.name).toBe("Budżet.pdf");
    expect(rowFor(host, "Budżet.pdf")).toBeDefined();
    expect(rowFor(host, "Raport.pdf")).toBeUndefined();
  });

  it("moves a file to the trash at once, and back", async () => {
    const { store, host } = await setup();
    button(rowFor(host, "notatki.txt")!, "Do kosza").click();
    await settle();
    // no question first: the trash keeps it, and the toast offers Cofnij
    expect(document.querySelector(".toast")?.textContent).toContain("Przeniesiono do kosza plik „notatki.txt”");
    expect((await store.info(ID_B))!.state).toBe("trashed");
    expect(rowFor(host, "notatki.txt")).toBeUndefined();
    expect(host.querySelector(".files-trash summary")?.textContent).toBe("Kosz (1)");
    expect(host.querySelector(".files-trash-item")?.textContent).toContain("za 30 dni");

    const restore = [...host.querySelectorAll<HTMLButtonElement>(".files-trash button")].find((b) => b.textContent === "Przywróć")!;
    restore.click();
    await settle();
    expect((await store.info(ID_B))!.state).toBe("ready");
    expect(rowFor(host, "notatki.txt")).toBeDefined();
    expect(host.querySelector(".files-trash summary")?.textContent).toBe("Kosz (0)");
  });

  it("inserts the existing file as a new embed each time, without uploading it again", async () => {
    const { store, actions, host } = await setup();
    const upload = vi.spyOn(store, "upload");
    button(rowFor(host, "Raport.pdf")!, "Wstaw do notatki").click();
    button(rowFor(host, "Raport.pdf")!, "Wstaw do notatki").click();
    expect(upload).not.toHaveBeenCalled();
    const [first, second] = (actions.insert as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    for (const text of [first, second]) {
      const m = [...text.matchAll(FILE_EMBED)];
      expect(m).toHaveLength(1);
      expect(m[0][1]).toBe(ID_A);
      expect(m[0][2]).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(first).not.toBe(second);
  });

  it("disables insertion with a hint when no note is open", async () => {
    const { host, actions } = await setup({ canInsert: false });
    expect(host.textContent).toContain("Otwórz notatkę, aby wstawić do niej plik.");
    const insert = button(rowFor(host, "Raport.pdf")!, "Wstaw do notatki");
    expect(insert.disabled).toBe(true);
    insert.click();
    expect(actions.insert).not.toHaveBeenCalled();
  });

  it("explains an empty space", async () => {
    const { host } = await setup({ store: new MemoryFileStore(), usages: new Map() });
    expect(host.textContent).toContain("Nie ma jeszcze plików");
  });
});

describe("usages", () => {
  it("finds every embed in the readable notes, with its line and embed id, legacy ones included", async () => {
    const texts: Record<string, string> = {
      n1: `# Plan\n![[plik:${ID_A}#12345678]]\n\n![[plik:${ID_A}|320]]\n![[plik:${ID_B}#aaaaaaaa]]`,
      n2: `Tekst\n![[plik:${ID_A}]]`,
    };
    const read = vi.fn(async (id: string) => texts[id]);
    const uses = await scanUsages(notes, read);
    expect(uses.get(ID_A)).toEqual([
      usageOf(notes[0], 2, "12345678"),
      usageOf(notes[0], 4, null),
      usageOf(notes[1], 2, null),
    ]);
    expect(uses.get(ID_B)).toEqual([usageOf(notes[0], 5, "aaaaaaaa")]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("skips a note whose text cannot be read", async () => {
    const uses = await scanUsages(notes, async (id) => {
      if (id === "n1") throw new Error("nie można odczytać");
      return `![[plik:${ID_A}#12345678]]`;
    });
    expect(uses.get(ID_A)).toEqual([usageOf(notes[1], 1, "12345678")]);
  });
});

describe("pure helpers", () => {
  it("keeps the old extension unless a new one is typed", () => {
    expect(keepExtension("raport.pdf", "budżet")).toBe("budżet.pdf");
    expect(keepExtension("raport.pdf", "budżet.docx")).toBe("budżet.docx");
    expect(keepExtension("README", "notatki")).toBe("notatki");
    expect(keepExtension("raport.pdf", "  ")).toBe("");
  });

  it("filters by the given query, kind and project", () => {
    const files = [
      { id: ID_A, name: "Raport.pdf", mime: "application/pdf", size: 1, project: "P", state: "ready", createdAt: 0, createdBy: null, deletedAt: null },
      { id: ID_B, name: "a.txt", mime: "text/plain", size: 1, project: null, state: "ready", createdAt: 0, createdBy: null, deletedAt: null },
    ] as const;
    expect(filterFiles([...files], { query: "rap", kind: "pdf", project: JSON.stringify("P") }).map((f) => f.id)).toEqual([ID_A]);
    expect(filterFiles([...files], { query: "", kind: "", project: "null" }).map((f) => f.id)).toEqual([ID_B]);
  });

  it("counts the whole days left in the trash, rounded up", () => {
    const day = 86_400_000;
    expect(daysLeft(0, 30, 0)).toBe(30);
    expect(daysLeft(0, 30, 1)).toBe(30);
    expect(daysLeft(0, 30, 29 * day + 1)).toBe(1);
    expect(daysLeft(0, 30, 31 * day)).toBe(0);
  });
});

describe("Pliki: opening the preview", () => {
  it("a double click on a row opens the preview on that file, among the files after the filters", async () => {
    const { host, store } = await setup();
    rowFor(host, "notatki.txt")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [s, infos, index] = lastPreview();
    expect(s).toBe(store);
    expect(infos.map((f) => f.name)).toEqual(["logo.png", "notatki.txt", "Raport.pdf"]);
    expect(index).toBe(1);
  });

  it("the list leaves out the files that are filtered away and those in the trash", async () => {
    const { host, store } = await setup();
    const search = host.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "p"; // notatki.txt is left out
    search.dispatchEvent(new Event("input"));
    rowFor(host, "Raport.pdf")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(lastPreview()[1].map((f) => f.name)).toEqual(["logo.png", "Raport.pdf"]);
    expect(lastPreview()[2]).toBe(1);

    search.value = "";
    search.dispatchEvent(new Event("input"));
    await store.trash(ID_B);
    await settle();
    rowFor(host, "Raport.pdf")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(lastPreview()[1].map((f) => f.name)).toEqual(["logo.png", "Raport.pdf"]);
  });

  it("a double click on a button of the row does not open the preview", async () => {
    const { host } = await setup();
    button(rowFor(host, "Raport.pdf")!, "Pobierz").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(previewFiles).not.toHaveBeenCalled();
  });

  it("the space bar on a focused row opens the preview as a space preview, and is not typed", async () => {
    const { host } = await setup();
    const row = rowFor(host, "Raport.pdf")!;
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(lastPreview()[2]).toBe(2);
    expect(lastPreview()[3]).toEqual({ bySpace: true });
  });

  it("the space bar on a button in the row does not open the preview", async () => {
    const { host } = await setup();
    key(" ", button(rowFor(host, "Raport.pdf")!, "Pobierz"));
    expect(previewFiles).not.toHaveBeenCalled();
  });

  it("Enter on a focused row opens the preview without the space option", async () => {
    const { host } = await setup();
    key("Enter", rowFor(host, "logo.png")!);
    expect(lastPreview()[2]).toBe(0);
    expect(lastPreview()).toHaveLength(3);
  });

  it("the arrows move the focus to the row above or below", async () => {
    const { host } = await setup();
    const rows = [...host.querySelectorAll<HTMLElement>("tbody tr")];
    expect(rows.every((r) => r.tabIndex === 0 && r.classList.contains("files-row"))).toBe(true);
    rows[0].focus();
    key("ArrowDown", rows[0]);
    expect(document.activeElement).toBe(rows[1]);
    key("ArrowUp", rows[1]);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("the context menu starts with Podgląd, and offers Wstaw do notatki only when a note is open", async () => {
    const { host, data } = await setup();
    const row = rowFor(host, "Raport.pdf")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(["Podgląd", "Pobierz", "Wstaw do notatki", "Zmień nazwę", "Użycia", "Do kosza"]);
    document.querySelectorAll(".menu").forEach((n) => n.remove());

    data.canInsert = false;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(menuLabels()).toEqual(["Podgląd", "Pobierz", "Zmień nazwę", "Użycia", "Do kosza"]);
    [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")][0].click();
    expect(lastPreview()[2]).toBe(2);
  });

  it("the first button of the Akcje column is Podgląd, and no picture has an Otwórz button", async () => {
    const { host } = await setup();
    const actions = rowFor(host, "Raport.pdf")!.querySelector(".files-actions")!;
    expect(actions.querySelector("button")!.textContent).toBe("Podgląd");
    expect(rowFor(host, "logo.png")!.textContent).not.toContain("Otwórz");
    button(rowFor(host, "Raport.pdf")!, "Podgląd").click();
    expect(lastPreview()[2]).toBe(2);
  });
});

describe("Pliki: OCR badges and the text filter", () => {
  it("shows each file's status and filters the files without text", async () => {
    ocrBoard.reset();
    ocrBoard.set(ID_A, "tekst");
    ocrBoard.set(ID_B, "brak tekstu");
    ocrBoard.set(ID_C, "rozpoznawanie");
    ocrBoard.setProgress(ID_C, 3, 12);
    const { host } = await setup();
    expect(rowFor(host, "Raport.pdf")?.textContent).toContain("rozpoznany");
    expect(rowFor(host, "logo.png")?.textContent).toContain("rozpoznawanie s. 3 z 12");
    const box = host.querySelector<HTMLInputElement>(".files-check input")!;
    expect(box).not.toBeNull();
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(rowNames(host)).toHaveLength(1);
    expect(rowNames(host)[0]).toContain("notatki.txt");
    ocrBoard.reset();
  });

  it("offers Rozpoznaj tekst in the menu to editors only", async () => {
    ocrBoard.reset();
    const { host } = await setup();
    rowFor(host, "Raport.pdf")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
    expect(menuLabels()).not.toContain("Rozpoznaj tekst");
    document.querySelectorAll(".menu").forEach((n) => n.remove());
    ocrBoard.writable = true;
    rowFor(host, "Raport.pdf")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
    expect(menuLabels()).toContain("Rozpoznaj tekst");
    ocrBoard.reset();
  });
});
