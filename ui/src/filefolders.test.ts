// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentHandlers } from "./attachments";
import type { Bridge } from "./bridge";
import {
  addEmbedsChange, countText, deleteSubfolderChange, foldedFolders, folderCountText, folderName, folderSummary, insertFolderChange, type Change,
  parseFolders, removeFileChange, renameChange, subfolderChange,
} from "./filefolders";
import { folderCardsField, mountFolderPanel, openFolderDialog } from "./filefolders-view";
import { filesOf, MemoryFileStore } from "./filestore";
import { previewFiles } from "./preview/triggers";

vi.mock("./preview/triggers", () => ({ previewFiles: vi.fn() }));

const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";
const ID3 = "11111111222222223333333344444444";
const E1 = "aaaaaaaa";
const E2 = "bbbbbbbb";

const apply = (text: string, c: Change): string => text.slice(0, c.from) + c.insert + text.slice(c.to);

const NOTE = [
  "Wstęp",
  "",
  "> [!pliki] Faktury",
  `> ![[plik:${ID}#${E1}]]`,
  `> ![[plik:${ID2}#${E2}|320]]`,
  "",
  "> [!note] Uwaga",
  "> tekst",
  "",
  "> [!pliki]",
  "> ![[assets/zdjecie.png]]",
].join("\n");

afterEach(() => document.body.replaceChildren());

describe("parseFolders", () => {
  it("finds each folder with its name, its lines and its embeds, and leaves other callouts alone", () => {
    const folders = parseFolders(NOTE);
    expect(folders.map((f) => f.title)).toEqual(["Faktury", ""]);
    expect(folders[0].files.map((f) => f.id)).toEqual([ID, ID2]);
    expect(folders[1].files).toHaveLength(1);
    expect(folders[1].files[0].rel).toBe("assets/zdjecie.png");
  });

  it("gives offsets into the text: the folder's lines and each embed", () => {
    const [f] = parseFolders(NOTE);
    expect(NOTE.slice(f.from, f.from + 18)).toBe("> [!pliki] Faktury");
    expect(NOTE.slice(f.titleFrom, f.headEnd)).toBe("Faktury");
    expect(NOTE.slice(f.files[1].from, f.files[1].to)).toBe(`![[plik:${ID2}#${E2}|320]]`);
    expect(NOTE.slice(f.to, f.to + 1)).toBe("\n");
  });

  it("returns no folders for a note without them", () => {
    expect(parseFolders("> [!note] x\n> ![[plik:" + ID + "]]")).toEqual([]);
  });
});

describe("changes", () => {
  it("adds an embed line at the end of the folder", () => {
    const [f] = parseFolders(NOTE);
    const next = apply(NOTE, addEmbedsChange(f, [`![[plik:${ID3}#cccccccc]]`]));
    const [g] = parseFolders(next);
    expect(g.files).toHaveLength(3);
    expect(next).toContain(`> ![[plik:${ID2}#${E2}|320]]\n> ![[plik:${ID3}#cccccccc]]\n\n> [!note]`);
  });

  it("renames the folder on its head line, and an empty name becomes Pliki", () => {
    const [f] = parseFolders(NOTE);
    expect(parseFolders(apply(NOTE, renameChange(f, "  Rachunki   2026 ")))[0].title).toBe("Rachunki 2026");
    expect(folderName("   ")).toBe("Pliki");
  });

  it("removes a line that held only the embed, and only the embed when text shares the line", () => {
    const text = [`> [!pliki] A`, `> ![[plik:${ID}#${E1}]]`, `> ![[plik:${ID2}#${E2}]] opis`, `> ![[plik:${ID3}#cccccccc]]`].join("\n");
    const [f] = parseFolders(text);
    const once = apply(text, removeFileChange(text, f.files[0]));
    expect(once).toBe([`> [!pliki] A`, `> ![[plik:${ID2}#${E2}]] opis`, `> ![[plik:${ID3}#cccccccc]]`].join("\n"));
    const [g] = parseFolders(once);
    const twice = apply(once, removeFileChange(once, g.files[0]));
    expect(twice).toBe([`> [!pliki] A`, `>  opis`, `> ![[plik:${ID3}#cccccccc]]`].join("\n"));
    // the last line of the note goes with its line break
    const last = parseFolders(twice)[0].files[0];
    expect(apply(twice, removeFileChange(twice, last))).toBe([`> [!pliki] A`, `>  opis`].join("\n"));
  });

  it("appends a new folder after a blank line, or after the text that is there, with a blank line after it", () => {
    const at = (text: string) => insertFolderChange(text, text.length, "Nowy");
    expect(apply("", at("").change)).toBe("> [!pliki] Nowy\n\n");
    expect(apply("A", at("A").change)).toBe("A\n\n> [!pliki] Nowy\n\n");
    expect(apply("A\n", at("A\n").change)).toBe("A\n\n> [!pliki] Nowy\n\n");
    expect(apply("A\n\n", at("A\n\n").change)).toBe("A\n\n> [!pliki] Nowy\n\n");
  });

  it("inserts a folder at the caret on its own line, with the caret after it", () => {
    const below = insertFolderChange("A\nB", 2, "X");
    const next = apply("A\nB", below.change);
    expect(next).toBe("A\n\n> [!pliki] X\n\nB");
    expect(next.slice(below.caret)).toBe("B");
    const inside = insertFolderChange("Tekst", 2, "X");
    expect(apply("Tekst", inside.change)).toBe("Te\n\n> [!pliki] X\n\nkst");
    expect(apply("Tekst", inside.change).slice(inside.caret)).toBe("kst");
  });

  it("a folder inserted inside another folder's lines goes after that folder", () => {
    const text = "> [!pliki] A\n> ![[assets/a.png]]\nB";
    const { change } = insertFolderChange(text, 5, "X");
    const next = apply(text, change);
    expect(next).toBe("> [!pliki] A\n> ![[assets/a.png]]\n\n> [!pliki] X\n\n\nB");
    expect(parseFolders(next).map((f) => [f.title, f.files.length])).toEqual([["A", 1], ["X", 0]]);
  });

  it("puts the caret outside the new folder, so the card shows at once", () => {
    const { change, caret } = insertFolderChange("A", 1, "Nowy");
    const doc = apply("A", change);
    expect(foldedFolders(EditorState.create({ doc, selection: { anchor: caret } })).map((f) => f.title)).toEqual(["Nowy"]);
  });

  it("counts files in Polish", () => {
    expect([1, 2, 4, 5, 12, 22, 25].map(countText)).toEqual(["1 plik", "2 pliki", "4 pliki", "5 plików", "12 plików", "22 pliki", "25 plików"]);
  });

  it("counts subfolders in Polish", () => {
    expect([1, 2, 4, 5, 12, 14, 22, 25].map(folderCountText)).toEqual([
      "1 folder", "2 foldery", "4 foldery", "5 folderów", "12 folderów", "14 folderów", "22 foldery", "25 folderów",
    ]);
  });
});

// A folder with a subfolder (Rysunki) and a sibling after it (Dokumenty), and a note callout inside Dokumenty.
const TREE = [
  "> [!pliki] Projekt",
  `> ![[plik:${ID}#${E1}]]`,
  "> > [!pliki] Rysunki",
  `> > ![[plik:${ID2}#${E2}]]`,
  `> ![[plik:${ID3}#cccccccc]]`,
  "> [!pliki] Dokumenty",
  `> ![[plik:${ID}#${E1}]]`,
  "> > [!note] Uwaga",
  `> > ![[plik:${ID2}#${E2}]]`,
].join("\n");

describe("nested folders", () => {
  it("gives each folder its depth, its parent and its own files, in document order", () => {
    const folders = parseFolders(TREE);
    expect(folders.map((f) => [f.title, f.depth, f.parent])).toEqual([
      ["Projekt", 1, null],
      ["Rysunki", 2, 0],
      ["Dokumenty", 1, null],
    ]);
    expect(folders.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(folders[0].files.map((f) => f.id)).toEqual([ID, ID3]); // the file after the subfolder is still Projekt's
    expect(folders[1].files.map((f) => f.id)).toEqual([ID2]);
    expect(folders[2].files.map((f) => f.id)).toEqual([ID]); // the embed in the note callout is no one's
  });

  it("ends a folder's own files before its first subfolder, and spans to its last line", () => {
    const [projekt, rysunki, dokumenty] = parseFolders(TREE);
    expect(TREE.slice(0, projekt.filesEnd).endsWith(`> ![[plik:${ID}#${E1}]]`)).toBe(true);
    expect(TREE.slice(projekt.to).startsWith("\n> [!pliki] Dokumenty")).toBe(true); // a sibling head ends it
    expect(TREE.slice(rysunki.to).startsWith(`\n> ![[plik:${ID3}`)).toBe(true); // a line one level up ends a subfolder
    expect(dokumenty.to).toBe(TREE.length);
    expect(dokumenty.filesEnd).toBe(dokumenty.headEnd + 1 + `> ![[plik:${ID}#${E1}]]`.length);
  });

  it("gives a folder with only a subfolder its head as the place for files", () => {
    const [p] = parseFolders(`> [!pliki] P\n> > [!pliki] C\n> > ![[plik:${ID}]]`);
    expect(p.filesEnd).toBe(p.headEnd);
  });

  it("adds a file to a parent before its subfolder, not inside it", () => {
    const [projekt] = parseFolders(TREE);
    const next = apply(TREE, addEmbedsChange(projekt, [`![[plik:${ID2}#${E2}]]`]));
    expect(next).toContain(`> ![[plik:${ID}#${E1}]]\n> ![[plik:${ID2}#${E2}]]\n> > [!pliki] Rysunki`);
    const [p, r] = parseFolders(next);
    expect(p.files.map((f) => f.id)).toEqual([ID, ID2, ID3]);
    expect(r.files.map((f) => f.id)).toEqual([ID2]);
  });

  it("adds a subfolder at the end of its folder, one level deeper", () => {
    const next = apply(TREE, subfolderChange(parseFolders(TREE)[0], "Skany"));
    expect(parseFolders(next).map((f) => [f.title, f.depth, f.parent])).toEqual([
      ["Projekt", 1, null],
      ["Rysunki", 2, 0],
      ["Skany", 2, 0],
      ["Dokumenty", 1, null],
    ]);
  });

  it("deletes a subfolder with its lines, and its files stay where they are", () => {
    const [, rysunki] = parseFolders(TREE);
    const next = apply(TREE, deleteSubfolderChange(rysunki));
    expect(next).toBe(TREE.replace(`\n> > [!pliki] Rysunki\n> > ![[plik:${ID2}#${E2}]]`, ""));
    const folders = parseFolders(next);
    expect(folders.map((f) => f.title)).toEqual(["Projekt", "Dokumenty"]);
    expect(folders[0].files.map((f) => f.id)).toEqual([ID, ID3]);
  });

  it("counts a folder's files with its subfolders' files, and its subfolders", () => {
    expect(folderSummary(parseFolders(TREE), 0)).toBe("3 pliki · 1 folder");
    expect(folderSummary(parseFolders(TREE), 2)).toBe("1 plik");
  });

  it("gives a card only to top-level folders", () => {
    const doc = `Wstęp\n\n${TREE}`;
    expect(foldedFolders(EditorState.create({ doc, selection: { anchor: 0 } })).map((f) => f.title)).toEqual(["Projekt", "Dokumenty"]);
  });
});

describe("foldedFolders", () => {
  it("leaves out only the folder the caret is in", () => {
    const inside = NOTE.indexOf(ID) + 2;
    const outside = NOTE.indexOf("Wstęp") + 1;
    const at = (pos: number) => foldedFolders(EditorState.create({ doc: NOTE, selection: { anchor: pos } })).map((f) => f.title);
    expect(at(inside)).toEqual([""]);
    expect(at(outside)).toEqual(["Faktury", ""]);
  });

  it("sees an edit of the note: a folder that was removed is gone, a new one is found", () => {
    const before = EditorState.create({ doc: NOTE, selection: { anchor: 0 } });
    expect(foldedFolders(before).map((f) => f.title)).toEqual(["Faktury", ""]);
    const after = before.update({ changes: { from: 0, to: before.doc.length, insert: "Bez folderów" } }).state;
    expect(foldedFolders(after)).toEqual([]);
    const folder = `> [!pliki] Nowy\n> ![[plik:${ID}]]\n`;
    const again = after.update({ changes: { from: 0, insert: folder }, selection: { anchor: folder.length + after.doc.length } }).state;
    expect(foldedFolders(again).map((f) => f.title)).toEqual(["Nowy"]);
  });
});

describe("folder panel and dialog", () => {
  const setup = (doc: string, withStore = true) => {
    const store = new MemoryFileStore();
    const bridge = { call: vi.fn(), on: () => () => {}, ...(withStore ? { files: store } : {}) } as unknown as Bridge;
    const anchor = document.createElement("div");
    const reading = document.createElement("div");
    reading.hidden = true;
    document.body.append(anchor, reading);
    const view = new EditorView({ parent: anchor, state: EditorState.create({ doc, extensions: [attachmentHandlers(bridge, () => {}, () => "Projekty/Plan")] }) });
    return { bridge, view, anchor, reading };
  };

  it("opens a subfolder in the same dialog, with its parents as links", () => {
    const { view } = setup(TREE);
    openFolderDialog(view, 0, null);
    const dialog = document.querySelector<HTMLElement>(".folder-dialog")!;
    const sub = dialog.querySelector<HTMLButtonElement>('.folder-tile-open[aria-label^="Otwórz folder Rysunki"]')!;
    expect(sub).not.toBeNull();
    sub.click();
    expect(dialog.querySelector<HTMLInputElement>(".folder-name")!.value).toBe("Rysunki");
    expect(dialog.querySelector(".folder-crumb")!.textContent).toBe("Projekt");
    expect(dialog.querySelectorAll(".folder-tile")).toHaveLength(1); // its one file
    dialog.querySelector<HTMLButtonElement>(".folder-crumb")!.click();
    expect(dialog.querySelector<HTMLInputElement>(".folder-name")!.value).toBe("Projekt");
  });

  it("lists the note's folders above it, with their file counts", () => {
    const { bridge, view, anchor, reading } = setup(NOTE);
    mountFolderPanel(anchor, reading, bridge, () => view).refresh();
    const bar = document.querySelector<HTMLElement>(".file-folders")!;
    expect(bar.hidden).toBe(false);
    const chips = [...bar.querySelectorAll(".file-folder-chip")].map((c) => c.textContent);
    expect(chips[0]).toContain("Faktury");
    expect(chips[0]).toContain("2 pliki");
    expect(chips[1]).toContain("Pliki");
    expect(bar.textContent).toContain("+ Nowy folder");
  });

  it("is hidden without folders and without a file store, and shows only the add button with a store", () => {
    const plain = setup("Tekst", false);
    mountFolderPanel(plain.anchor, plain.reading, plain.bridge, () => plain.view).refresh();
    expect(document.querySelector<HTMLElement>(".file-folders")!.hidden).toBe(true);
    document.body.replaceChildren();
    const withStore = setup("Tekst");
    mountFolderPanel(withStore.anchor, withStore.reading, withStore.bridge, () => withStore.view).refresh();
    const bar = document.querySelector<HTMLElement>(".file-folders")!;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelectorAll(".file-folder-chip")).toHaveLength(0);
    expect(bar.textContent).toBe("+ Folder z plikami");
  });

  it("adds a dropped or picked file as an embed line in the folder, through a transaction", async () => {
    const { bridge, view, anchor, reading } = setup(NOTE);
    mountFolderPanel(anchor, reading, bridge, () => view).refresh();
    document.querySelector<HTMLElement>(".file-folder-chip")!.click();
    const input = document.querySelector<HTMLInputElement>(".folder-dialog input[type=file]")!;
    expect(input).not.toBeNull();
    const dispatch = vi.spyOn(view, "dispatch");
    Object.defineProperty(input, "files", { value: [new File(["raport"], "raport.txt", { type: "text/plain" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch.mock.calls.some(([spec]) => (spec as { changes?: unknown }).changes !== undefined)).toBe(true);
    const [first, second] = parseFolders(view.state.doc.toString());
    expect(first.files).toHaveLength(3);
    expect(second.files).toHaveLength(1); // the other folder is untouched
    expect(view.state.doc.toString()).toContain("\n> ![[plik:");
    openFolderDialog(view, 0, bridge); // the dialog opens again on the same folder
    const again = [...document.querySelectorAll<HTMLElement>(".folder-dialog")].pop()!;
    expect(again.querySelectorAll(".folder-tile")).toHaveLength(3);
  });

  it("Otwórz on a server file and a double click on its tile preview it among the folder's files, in the note's order", async () => {
    const { bridge, view, anchor, reading } = setup(NOTE);
    const store = filesOf(bridge)!;
    await store.upload(new File(["b"], "drugi.txt", { type: "text/plain" }), { id: ID2 });
    await store.upload(new File(["a"], "pierwszy.txt", { type: "text/plain" }), { id: ID });
    mountFolderPanel(anchor, reading, bridge, () => view).refresh();
    document.querySelector<HTMLElement>(".file-folder-chip")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const tiles = () => [...document.querySelectorAll<HTMLElement>(".folder-dialog .folder-tile")];
    tiles()[1].querySelector<HTMLButtonElement>(".folder-tile-open")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const [s, infos, index] = vi.mocked(previewFiles).mock.lastCall!;
    expect(s).toBe(store);
    expect(infos.map((i) => i.id)).toEqual([ID, ID2]);
    expect(index).toBe(1);

    tiles()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(previewFiles).mock.lastCall![2]).toBe(0);
    expect(vi.mocked(previewFiles).mock.calls).toHaveLength(2);

    tiles()[0].querySelector<HTMLButtonElement>(".folder-tile-remove")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(previewFiles).mock.calls).toHaveLength(2);
  });
});

describe("folder card in Live Preview", () => {
  it("shows a folder as one card while the caret is outside it, and as raw text inside it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const inside = NOTE.indexOf(ID) + 2;
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: NOTE, selection: { anchor: 0 }, extensions: [folderCardsField] }) });
    const cards = () => [...host.querySelectorAll<HTMLElement>(".file-folder-card")].map((c) => c.textContent);
    expect(cards()).toEqual([expect.stringContaining("Faktury"), expect.stringContaining("Pliki")]);
    expect(cards()[0]).toContain("2 pliki");
    view.dispatch({ selection: { anchor: inside } });
    expect(cards()).toEqual([expect.stringContaining("Pliki")]);
    host.querySelector<HTMLElement>(".file-folder-card")!.click();
    expect(document.querySelector(".folder-dialog")).not.toBeNull();
    view.destroy();
  });
});
