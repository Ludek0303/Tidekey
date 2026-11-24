// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBridge, type TreeListing } from "./bridge";
import { Explorer } from "./explorer";
import { newLink, type GithubLink } from "./github/link";
import { setGithubService, type GithubService } from "./github/service";
import { filesOf } from "./filestore";
import { previewFiles } from "./preview/triggers";
import { NoteIndex } from "./noteindex";
import { FileTree } from "./tree";

vi.mock("./preview/triggers", () => ({ previewFiles: vi.fn() }));

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const key = (e: string, target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: e, bubbles: true }));

async function setup(extra: { newBoard?: (folder: string) => void } = {}) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const bridge = new MockBridge([
    { path: "Projekty/Plan.md", text: "# Plan" },
    { path: "Notatka.md", text: "x" },
  ]);
  const tree = new FileTree(host, () => undefined);
  const opened: string[] = [];
  const renamed: [string, string][] = [];
  const removed: string[] = [];
  const explorer = new Explorer({
    bridge,
    tree,
    open: async (item) => {
      opened.push(item.path);
    },
    renamed: (id, path) => renamed.push([id, path]),
    removed: (id) => removed.push(id),
    ...extra,
  });
  await explorer.reload();
  const row = (path: string) => host.querySelector<HTMLElement>(`[data-key="${path}"]`)!;
  const paths = async () => (await bridge.call<TreeListing>("list_tree")).notes.map((n) => n.path);
  return { bridge, tree, host, explorer, opened, renamed, removed, row, paths };
}

// Types a new name into the inline rename field and commits it with Enter.
function commitRename(host: HTMLElement, name: string): void {
  const input = host.querySelector<HTMLInputElement>(".tree-rename")!;
  input.value = name;
  key("Enter", input);
}

// The "Cofnij" button of the newest toast that has one.
const cofnij = (): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>(".toast-action")].find((b) => b.textContent === "Cofnij")!;

// The mock has no protected projects: its listing is given one, as the browser bridge gives it.
function lockProjekty(bridge: MockBridge): void {
  const list = bridge.call.bind(bridge) as <T>(cmd: string, args?: unknown) => Promise<T>;
  bridge.call = (async (cmd: string, args?: unknown) => {
    const result = await list(cmd, args);
    return cmd === "list_tree" ? { ...(result as TreeListing), locked: [{ path: "Projekty/Plan" }] } : result;
  }) as typeof bridge.call;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Explorer", () => {
  it("new note creates 'Bez nazwy.md', opens it and starts the inline rename", async () => {
    const { explorer, opened, paths, host } = await setup();
    await explorer.newNote();
    expect(await paths()).toContain("Bez nazwy.md");
    expect(opened).toContain("Bez nazwy.md");
    expect(host.querySelector(".tree-rename")).not.toBeNull();
  });

  it("a second new note gets 'Bez nazwy 2.md'", async () => {
    const { explorer, paths } = await setup();
    await explorer.newNote();
    await explorer.newNote();
    expect(await paths()).toEqual(expect.arrayContaining(["Bez nazwy.md", "Bez nazwy 2.md"]));
  });

  it("new folder shows an empty folder in the tree", async () => {
    const { explorer, host, bridge } = await setup();
    await explorer.newFolder();
    const folder = host.querySelector<HTMLElement>('[data-key="Bez nazwy"]');
    expect(folder?.classList.contains("is-folder")).toBe(true);
    expect((await bridge.call<TreeListing>("list_tree")).folders).toContain("Bez nazwy");
  });

  it("F2 renames the focused note in the mock and in the tree", async () => {
    const { host, row, paths, renamed } = await setup();
    row("Notatka.md").click();
    key("F2", host);
    commitRename(host, "Nowa");
    await flush();
    expect(await paths()).toContain("Nowa.md");
    expect(host.querySelector('[data-key="Nowa.md"]')).not.toBeNull();
    expect(renamed.map((r) => r[1])).toEqual(["Nowa.md"]);
  });

  it("a slash typed in a note's name stays in the name, it does not move the note", async () => {
    const { host, row, renamed } = await setup();
    row("Notatka.md").click();
    key("F2", host);
    commitRename(host, "Plan/2026");
    await flush();
    expect(renamed.map((r) => r[1])).toEqual(["Plan-2026.md"]);
  });

  it("the context menu rename does the same", async () => {
    const { host, row, paths, renamed } = await setup();
    row("Projekty/Plan.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Zmień nazwę")!;
    item.click();
    commitRename(host, "Pomysł");
    await flush();
    expect(await paths()).toContain("Projekty/Pomysł.md");
    expect(renamed).toEqual([[expect.any(String), "Projekty/Pomysł.md"]]);
  });

  it("Delete moves the note to the trash at once, and Cofnij brings it back", async () => {
    const { host, row, paths, removed, bridge } = await setup();
    row("Notatka.md").click();
    key("Delete", host);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await paths()).not.toContain("Notatka.md");
    expect(removed).toHaveLength(1);
    expect(document.querySelector(".toasts")?.textContent).toContain("Przeniesiono do kosza: „Notatka”.");
    cofnij().click();
    await flush();
    expect(await paths()).toContain("Notatka.md");
    expect(await bridge.call<unknown[]>("list_trash")).toHaveLength(0);
  });

  it("a folder with a protected project asks first, and cancelling keeps it", async () => {
    const { host, row, bridge, explorer } = await setup();
    lockProjekty(bridge);
    await explorer.reload();
    row("Projekty").click();
    key("Delete", host);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Chroniony projekt zostanie usunięty na zawsze.");
    expect(dialog.textContent).toContain("Pozostałe notatki można przywrócić przez 6 miesięcy.");
    key("Escape", dialog);
    await flush();
    expect((await bridge.call<TreeListing>("list_tree")).folders).toContain("Projekty");
  });

  it("deletes a folder with its nested notes at once and closes their tabs; Cofnij restores the notes", async () => {
    const { host, row, paths, removed, bridge } = await setup();
    await bridge.call("create_folder", { path: "Projekty/Pusty" });
    row("Projekty").click();
    key("Delete", host);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector(".toasts")?.textContent).toContain("Przeniesiono do kosza folder „Projekty” (1 notatka).");
    expect(await paths()).not.toContain("Projekty/Plan.md");
    expect(removed).toHaveLength(1);
    expect((await bridge.call<TreeListing>("list_tree")).folders).not.toContain("Projekty");
    cofnij().click();
    await flush();
    expect(await paths()).toContain("Projekty/Plan.md");
    expect(removed).toHaveLength(1);
  });

  it("Cofnij on a folder brings its files back from the file store's trash", async () => {
    const { host, row, bridge } = await setup();
    dropFiles(row("Projekty"), [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.length === 1);
    await flush();
    row("Projekty").click();
    key("Delete", host);
    await flush();
    expect((await bridge.call<TreeListing>("list_tree")).files ?? []).toEqual([]);
    expect((await filesOf(bridge)!.list()).files.find((f) => f.name === "umowa.pdf")?.state).toBe("trashed");
    cofnij().click();
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.[0]?.path === "Projekty/umowa.pdf");
    expect((await filesOf(bridge)!.list()).files.find((f) => f.name === "umowa.pdf")?.state).toBe("ready");
  });

  it("a file moved to the trash comes back with Cofnij", async () => {
    const { host, row, bridge } = await setup();
    dropFiles(row("Projekty"), [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.length === 1);
    await flush();
    row("Projekty/umowa.pdf").click();
    key("Delete", host);
    await flush();
    expect(document.querySelector(".toasts")?.textContent).toContain("Przeniesiono do kosza plik „umowa.pdf”.");
    expect((await bridge.call<TreeListing>("list_tree")).files ?? []).toEqual([]);
    cofnij().click();
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.[0]?.path === "Projekty/umowa.pdf");
  });

  it("dragging a folder that holds selected rows moves only the folder; the rows inside go with it", async () => {
    const { row, paths, explorer, bridge } = await setup();
    await bridge.call("create_folder", { path: "Archiwum" });
    await explorer.reload();
    row("Projekty").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    row("Projekty/Plan.md").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    row("Projekty").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("Archiwum").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(await paths()).toContain("Archiwum/Projekty/Plan.md");
    expect(document.querySelector(".toasts")?.textContent ?? "").not.toContain("Przeniesiono 2");
  });

  it("dragging a selected row moves every selected row, notes and files alike, and clears the selection", async () => {
    const { host, row, paths, bridge, explorer, tree } = await setup();
    await bridge.call("create_folder", { path: "Archiwum" });
    dropFiles(host, [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.length === 1);
    await explorer.reload();
    await flush();
    row("Notatka.md").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    row("umowa.pdf").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    row("Notatka.md").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("Archiwum").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.[0]?.path === "Archiwum/umowa.pdf");
    expect(await paths()).toContain("Archiwum/Notatka.md");
    expect(document.querySelector(".toasts")?.textContent).toContain("Przeniesiono 2 elementy do „Archiwum”.");
    expect(tree.selectedKeys()).toEqual([]);
  });

  it("dragging a note onto a folder moves it", async () => {
    const { row, paths, host } = await setup();
    const note = row("Notatka.md");
    note.dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("Projekty").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(await paths()).toContain("Projekty/Notatka.md");
    expect(host.querySelector('[data-key="Projekty/Notatka.md"]')).not.toBeNull();
  });

  it("dragging a folder onto another folder moves it with its notes and keeps its name", async () => {
    const { row, paths, renamed, bridge, explorer } = await setup();
    await bridge.call("create_folder", { path: "Archiwum" });
    await explorer.reload();
    row("Projekty").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("Archiwum").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(await paths()).toContain("Archiwum/Projekty/Plan.md");
    expect((await bridge.call<TreeListing>("list_tree")).folders).toContain("Archiwum/Projekty");
    expect(renamed).toEqual([[expect.any(String), "Archiwum/Projekty/Plan.md"]]);
  });

  it("dropping a folder into its own subfolder is refused and nothing moves", async () => {
    const { row, paths, bridge, explorer } = await setup();
    await bridge.call("create_folder", { path: "Projekty/Pod" });
    await explorer.reload();
    row("Projekty").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("Projekty/Pod").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector(".toasts")?.textContent).toContain("Folder nie może być przeniesiony do siebie samego");
    expect(await paths()).toContain("Projekty/Plan.md");
  });

  it("dropping a folder onto a folder with the same name there shows the clash and moves nothing", async () => {
    const { row, paths, bridge, explorer } = await setup();
    await bridge.call("create_folder", { path: "Archiwum" });
    await bridge.call("create_folder", { path: "Archiwum/Projekty" });
    await explorer.reload();
    row("Projekty").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("Archiwum").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector(".toasts")?.textContent).toContain("Ścieżka jest zajęta: Archiwum/Projekty");
    expect(await paths()).toContain("Projekty/Plan.md");
  });

  it("offers Uprawnienia on a note; without manage rights the flow only says so", async () => {
    const { row } = await setup();
    row("Notatka.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }));
    const item = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent === "Uprawnienia…");
    expect(item).toBeDefined();
    item!.click();
    await flush();
    expect(document.querySelector(".toasts")?.textContent).toContain("Uprawnienia zmienia właściciel lub administrator.");
  });
});

// A drag from the computer onto the target row; the files are read from dataTransfer.files (no entries in jsdom).
function dropFiles(target: HTMLElement, files: File[]): void {
  const data = { types: ["Files"], files, items: [] } as unknown as DataTransfer;
  for (const type of ["dragover", "drop"]) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: data });
    target.dispatchEvent(e);
  }
}

describe("Explorer file drops and downloads", () => {
  it("a .md file dropped on a folder row becomes a note in that folder", async () => {
    const { row, paths } = await setup();
    dropFiles(row("Projekty"), [new File(["# Nowa"], "Nowa.md")]);
    await flush();
    expect(await paths()).toContain("Projekty/Nowa.md");
  });

  it("dropped on a note, the file goes into the note's folder; on the empty tree, into the root", async () => {
    const { host, row, paths } = await setup();
    dropFiles(row("Projekty/Plan.md"), [new File(["a"], "A.md")]);
    dropFiles(host, [new File(["b"], "B.md")]);
    await flush();
    expect(await paths()).toEqual(expect.arrayContaining(["Projekty/A.md", "B.md"]));
  });

  it("without a file store (desktop) other files dropped on the tree are skipped with a message", async () => {
    const { host, bridge, paths } = await setup();
    Object.defineProperty(bridge, "files", { value: null });
    const before = await paths();
    dropFiles(host, [new File(["x"], "obraz.png")]);
    await flush();
    expect(await paths()).toEqual(before);
    expect(document.querySelector(".toasts")?.textContent).toContain("Pominięto");
  });

  it("other files dropped on a folder are stored as files in it, beside its notes", async () => {
    const { row, bridge } = await setup();
    dropFiles(row("Projekty"), [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.some((f) => f.path === "Projekty/umowa.pdf") ?? false);
    await flush();
    expect(row("Projekty/umowa.pdf").classList.contains("is-file")).toBe(true);
  });

  it("a drop of a .md and a .pdf makes the note and the file", async () => {
    const { row, bridge, paths } = await setup();
    dropFiles(row("Projekty"), [new File(["# A"], "A.md"), new File(["%PDF"], "B.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.length === 1);
    await flush();
    expect(await paths()).toContain("Projekty/A.md");
    expect((await bridge.call<TreeListing>("list_tree")).files?.[0].path).toBe("Projekty/B.pdf");
  });

  it("a file dropped on a protected folder is refused with the note-insert hint", async () => {
    const { row, bridge, explorer } = await setup();
    const real = bridge.call.bind(bridge);
    bridge.call = <T>(cmd: string, args?: unknown): Promise<T> =>
      cmd === "list_tree" ? real<TreeListing>(cmd, args).then((l) => ({ ...l, locked: [{ path: "Projekty" }] }) as T) : real<T>(cmd, args);
    await explorer.reload();
    dropFiles(row("Projekty"), [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await flush();
    expect(document.querySelector(".toasts")?.textContent).toContain("W chronionym projekcie dodaj plik w notatce (Wstaw → Plik).");
    expect((await real<TreeListing>("list_tree")).files ?? []).toEqual([]);
  });

  it("a file in a folder can be dragged out to the root", async () => {
    const { row, bridge, tree } = await setup();
    dropFiles(row("Projekty"), [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.length === 1);
    await flush();
    tree.hooks.onMove?.(["Projekty/umowa.pdf"], "");
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.[0]?.path === "umowa.pdf");
  });

  it("the context menu downloads the folder", async () => {
    const { row } = await setup();
    row("Projekty").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }));
    const item = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent === "Pobierz (.zip)");
    expect(item).toBeDefined();
  });
});

// The labels of the context menu that is open now.
const menuLabels = (): string[] => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((b) => b.textContent ?? "");
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }));

// Waits until the check holds (the uploads of the files run in the background).
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("nie doczekano się warunku");
}

describe("Explorer menus: permissions, boards, files", () => {
  it("Uprawnienia is offered in an organization, not in one's own notes", async () => {
    const { row, bridge, explorer } = await setup();
    rightClick(row("Projekty"));
    expect(menuLabels()).toContain("Uprawnienia…");
    bridge.setBrowserAccount("user-a", "a@example.test");
    await explorer.reload();
    rightClick(row("Projekty"));
    expect(menuLabels()).not.toContain("Uprawnienia…");
    rightClick(row("Notatka.md"));
    expect(menuLabels()).not.toContain("Uprawnienia…");
  });

  it("Nowa tablica kanban is offered on a folder and at the root, and asks for the folder", async () => {
    const asked: string[] = [];
    const { row, host } = await setup({ newBoard: (folder) => asked.push(folder) });
    rightClick(row("Projekty"));
    const item = () => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent === "Nowa tablica kanban");
    item()!.click();
    rightClick(host);
    item()!.click();
    expect(asked).toEqual(["Projekty", ""]);
  });

  it("Nowa tablica kanban is not offered on a note's row", async () => {
    const { row } = await setup({ newBoard: () => undefined });
    rightClick(row("Notatka.md"));
    expect(menuLabels()).not.toContain("Nowa tablica kanban");
  });

  it("Wgraj pliki… is offered on a folder where there is a file store, not on the desktop", async () => {
    const { row, bridge, explorer } = await setup();
    rightClick(row("Projekty"));
    expect(menuLabels()).toContain("Wgraj pliki…");
    Object.defineProperty(bridge, "files", { value: null });
    await explorer.reload();
    rightClick(row("Projekty"));
    expect(menuLabels()).not.toContain("Wgraj pliki…");
  });

  it("a file's menu: Pobierz, Zmień nazwę, Kopiuj odnośnik do notatki, Usuń", async () => {
    const { row, bridge } = await setup();
    dropFiles(row("Projekty"), [new File(["%PDF"], "umowa.pdf", { type: "application/pdf" })]);
    await until(async () => (await bridge.call<TreeListing>("list_tree")).files?.length === 1);
    await flush();
    rightClick(row("Projekty/umowa.pdf"));
    expect(menuLabels()).toEqual(["Podgląd", "Pobierz", "Zmień nazwę", "Kopiuj odnośnik do notatki", "Usuń"]);
  });
});

describe("Explorer: preview of a file in a folder", () => {
  // Three files in Projekty, uploaded in another order than the tree shows them.
  async function withFolderFiles() {
    const env = await setup();
    dropFiles(env.row("Projekty"), [
      new File(["%PDF"], "c.pdf", { type: "application/pdf" }),
      new File(["%PDF"], "a.pdf", { type: "application/pdf" }),
      new File(["%PDF"], "b.pdf", { type: "application/pdf" }),
    ]);
    await until(async () => (await env.bridge.call<TreeListing>("list_tree")).files?.length === 3);
    await flush();
    return env;
  }
  const lastPreview = () => vi.mocked(previewFiles).mock.lastCall!;

  afterEach(() => vi.mocked(previewFiles).mockClear());

  it("a click on a file only selects it; a double click pages the preview through the files of its folder, in the tree's order", async () => {
    const { row, bridge } = await withFolderFiles();
    row("Projekty/b.pdf").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(previewFiles).not.toHaveBeenCalled();
    row("Projekty/b.pdf").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    await flush();
    const [store, infos, index] = lastPreview();
    expect(store).toBe(bridge.files);
    expect(infos.map((f) => f.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(index).toBe(1);
    expect(lastPreview()).toHaveLength(3);
  });

  it("the space bar on a focused file row opens the preview as a space preview", async () => {
    const { row, host } = await withFolderFiles();
    row("Projekty/a.pdf").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    key(" ", host);
    await flush();
    expect(lastPreview()[2]).toBe(0);
    expect(lastPreview()[3]).toEqual({ bySpace: true });
  });

  it("the file's menu starts with Podgląd, which previews it", async () => {
    const { row } = await withFolderFiles();
    rightClick(row("Projekty/c.pdf"));
    const item = [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent === "Podgląd")!;
    item.click();
    await flush();
    expect(lastPreview()[2]).toBe(2);
  });
});

describe("Explorer trash count", () => {
  it("the Kosz badge shows the trashed notes after a delete, and stays put on reloads", async () => {
    const { bridge, host, explorer, row } = await setup();
    const root = document.createElement("div");
    root.innerHTML = '<div class="explorer-head"></div>';
    document.body.append(root);
    explorer.bindHeader(root);
    await flush();
    const badge = () => root.querySelector<HTMLElement>(".trash-count")!.textContent;
    expect(badge()).toBe("");
    row("Notatka.md").click();
    key("Delete", host);
    await flush();
    expect(badge()).toBe("1");
    await explorer.reload();
    await flush();
    expect(badge()).toBe("1");
    expect((await bridge.call<unknown[]>("list_trash")).length).toBe(1);
  });
});

// A GitHub service with the links of a folder; the explorer's menu and the status window read only `links`.
function fakeGithub(links: GithubLink[]): GithubService {
  return {
    links: async (projectPath: string) => links.filter((l) => l.projectPath === projectPath),
    saveSettings: async () => undefined,
    checkNow: async () => "ok",
    disconnect: async () => undefined,
    restoreIgnored: async () => undefined,
  } as unknown as GithubService;
}

const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent === label);

describe("Explorer: GitHub on folders", () => {
  afterEach(() => {
    setGithubService(null);
    document.body.innerHTML = "";
  });

  it("the folder menu offers the connect window for an unlinked folder, only where GitHub is open", async () => {
    const { row } = await setup();
    rightClick(row("Projekty"));
    expect(menuItem("Połącz z GitHubem…")).toBeUndefined();
    expect(menuItem("Pobierz (.zip)")).toBeDefined();

    setGithubService(fakeGithub([]));
    rightClick(row("Projekty"));
    expect(menuItem("Połącz z GitHubem…")).toBeDefined();
    expect(menuItem("GitHub…")).toBeUndefined();
  });

  it("the connect window of a folder leaves the folder field empty", async () => {
    const { row } = await setup();
    setGithubService(fakeGithub([]));
    rightClick(row("Projekty"));
    menuItem("Połącz z GitHubem…")!.click();
    await flush();
    const label = [...document.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === "Folder na pliki z GitHuba");
    expect(label?.querySelector("input")?.value).toBe("");
  });

  it("a folder with a link gets GitHub…, which shows its status in a window named for the folder", async () => {
    const { bridge, row, explorer } = await setup();
    const link = newLink("Projekty", "owner/repo", {});
    await bridge.call("github_save_link", { link });
    setGithubService(fakeGithub([link]));
    await explorer.reload();
    rightClick(row("Projekty"));
    expect(menuItem("Połącz z GitHubem…")).toBeUndefined();
    menuItem("GitHub…")!.click();
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("GitHub: Projekty");
    expect(dialog.textContent).toContain("GitHub: owner/repo");
  });

  it("the right-click menu has no Nowy kalendarz, on a folder or at the root", async () => {
    const { row, host } = await setup();
    rightClick(row("Projekty"));
    expect(menuItem("Nowy kalendarz")).toBeUndefined();
    expect(menuItem("Nowa notatka")).toBeDefined();
    document.body.innerHTML = "";
    rightClick(host);
    expect(menuItem("Nowy kalendarz")).toBeUndefined();
  });

  it("a linked folder shows a GitHub mark whose title names the repository, and a read-only one says so", async () => {
    const { bridge, row, explorer } = await setup();
    const linked = newLink("Projekty", "owner/repo", {});
    const copy = newLink("Notatka", "owner/kopia", {});
    await bridge.call("github_save_link", { link: linked });
    await bridge.call("github_save_link", { link: { ...copy, projectPath: "Projekty", allowEdits: false, target: "GitHub/kopia" } });
    setGithubService(fakeGithub([]));
    await explorer.reload();
    const mark = row("Projekty").querySelector<HTMLElement>(".tree-github")!;
    expect(mark.getAttribute("aria-label")).toBe("Połączony z GitHubem: owner/repo, owner/kopia (tylko odczyt)");
    expect(mark.title).toBe(mark.getAttribute("aria-label"));
    expect(row("Notatka.md").querySelector(".tree-github")).toBeNull();
  });

  it("no GitHub service means no mark, even with links in the vault", async () => {
    const { bridge, row, explorer } = await setup();
    await bridge.call("github_save_link", { link: newLink("Projekty", "owner/repo", {}) });
    await explorer.reload();
    expect(row("Projekty").querySelector(".tree-github")).toBeNull();
  });
});

// The link index is the real wasm one; the bridge is the mock. Node has no fetch for file: URLs, so the wasm is read here.
describe("Explorer: links follow a rename", () => {
  beforeAll(async () => {
    const bytes = readFileSync(resolve(__dirname, "wasm/notes_web_bg.wasm"));
    vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }));
    await new NoteIndex(new MockBridge([])).start();
    vi.unstubAllGlobals();
  });

  async function setupLinks(withIndex = true) {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    const bridge = new MockBridge([
      { path: "Projekty/Plan.md", text: "# Plan" },
      { path: "Notatka.md", text: "Patrz [[Plan]] i [[Plan|x]], [[Projekty/Plan#Cele]]\n`[[Plan]]`" },
    ]);
    const index = new NoteIndex(bridge);
    await index.start();
    const tree = new FileTree(host, () => undefined);
    const explorer = new Explorer({
      bridge,
      tree,
      open: async () => undefined,
      renamed: () => undefined,
      removed: () => undefined,
      links: withIndex ? { index, openDoc: () => null } : undefined,
    });
    await explorer.reload();
    await index.sync();
    const idOf = async (path: string) => (await bridge.call<TreeListing>("list_tree")).notes.find((n) => n.path === path)!.id;
    return { bridge, explorer, idOf, notatka: await idOf("Notatka.md") };
  }

  it("renaming a note rewrites its links in other notes and says how many", async () => {
    const { bridge, explorer, notatka } = await setupLinks();
    await explorer.rename("Projekty/Plan.md", "Nowy plan");
    await flush();
    expect(await bridge.call<string>("note_text", { id: notatka })).toBe(
      "Patrz [[Nowy plan]] i [[Nowy plan|x]], [[Projekty/Nowy plan#Cele]]\n`[[Plan]]`",
    );
    expect(document.querySelector(".toasts")?.textContent).toContain("Zaktualizowano linki w 1 notatce.");
  });

  it("a folder rename rewrites path links to the notes inside it", async () => {
    const { bridge, explorer, notatka } = await setupLinks();
    await explorer.rename("Projekty", "Archiwum");
    await flush();
    expect(await bridge.call<string>("note_text", { id: notatka })).toBe(
      "Patrz [[Plan]] i [[Plan|x]], [[Archiwum/Plan#Cele]]\n`[[Plan]]`",
    );
  });

  it("without the link index the rename still happens and no link is touched", async () => {
    const { bridge, explorer, notatka, idOf } = await setupLinks(false);
    await explorer.rename("Projekty/Plan.md", "Nowy plan");
    await flush();
    expect(await idOf("Projekty/Nowy plan.md")).toBeTruthy();
    expect(await bridge.call<string>("note_text", { id: notatka })).toContain("[[Plan]] i [[Plan|x]]");
    expect(document.querySelector(".toasts")?.textContent ?? "").not.toContain("Zaktualizowano");
  });
});
