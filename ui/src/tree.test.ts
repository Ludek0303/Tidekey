// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { makeBigMock, type TreeListing } from "./bridge";
import { icon } from "./icons";
import { FileTree, ROW_H, buildTree } from "./tree";

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

async function setup(n: number) {
  const { notes: items } = await makeBigMock(n).call<TreeListing>("list_tree");
  const host = document.createElement("div");
  document.body.append(host);
  const opened: Array<[string, string]> = [];
  const tree = new FileTree(host, (id, path) => opened.push([id, path]));
  tree.setItems(items);
  return { host, tree, items, opened };
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];

// Building the 10 000-note mock alone takes several seconds in jsdom, so these get more than the default 5 s.
describe("FileTree virtualization", { timeout: 30_000 }, () => {
  it("renders far fewer rows than the 10 000 notes", async () => {
    const { host } = await setup(10000);
    expect(rows(host).length).toBeGreaterThan(0);
    expect(rows(host).length).toBeLessThan(200);
    expect(host.querySelector<HTMLElement>(".tree-spacer")!.style.height).toBe(`${10100 * ROW_H}px`);
  });

  it("renders a different window after scrolling", async () => {
    const { host } = await setup(10000);
    const topBefore = rows(host).map((r) => r.style.top);

    host.scrollTop = 200 * ROW_H;
    host.dispatchEvent(new Event("scroll"));
    await nextFrame();

    const topAfter = rows(host).map((r) => r.style.top);
    expect(topAfter).not.toEqual(topBefore);
    expect(topAfter).toContain(`${200 * ROW_H}px`);
    expect(topAfter.length).toBeLessThan(200);
  });

  it("opens the focused note with ArrowDown, ArrowDown, Enter", async () => {
    const { host, items, opened } = await setup(10000);
    const press = (key: string) => host.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    press("ArrowDown"); // first row: folder "Folder 0"
    press("ArrowDown"); // first note in that folder
    press("Enter");

    const first = items.find((i) => i.path === "Folder 0/Notatka 0.md")!;
    expect(opened).toEqual([[first.id, first.path]]);
  });

  it("exposes tree roles and ARIA state on rows", async () => {
    const { host, tree, items } = await setup(10000);
    expect(host.getAttribute("role")).toBe("tree");

    const folder = rows(host).find((r) => r.classList.contains("is-folder"))!;
    expect(folder.getAttribute("role")).toBe("treeitem");
    expect(folder.getAttribute("aria-level")).toBe("1");
    expect(folder.getAttribute("aria-expanded")).toBe("true");

    const first = items.find((i) => i.path === "Folder 0/Notatka 0.md")!;
    tree.setActive(first.id);
    const note = rows(host).find((r) => r.dataset.key === first.path)!;
    expect(note.getAttribute("role")).toBe("treeitem");
    expect(note.getAttribute("aria-level")).toBe("2");
    expect(note.getAttribute("aria-selected")).toBe("true");
  });
});

describe("FileTree selection and file drops", () => {
  // A folder F and three notes; the rows read F, a, b, c.
  function mini() {
    const host = document.createElement("div");
    document.body.append(host);
    const opened: string[] = [];
    const tree = new FileTree(host, (_id, path) => opened.push(path));
    tree.setItems([{ id: "1", path: "a.md" }, { id: "2", path: "b.md" }, { id: "3", path: "c.md" }], ["F"]);
    const row = (path: string) => host.querySelector<HTMLElement>(`[data-key="${path}"]`)!;
    const click = (path: string, init: MouseEventInit = {}) => row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
    const footer = host.nextElementSibling as HTMLElement;
    return { host, tree, opened, row, click, footer };
  }

  // A drag from the computer: only "Files" in the types, and the files in dataTransfer.
  function osDrag(type: string, target: HTMLElement, files: File[], onDrop: (data: DataTransfer) => void = () => undefined) {
    const data = { types: ["Files"], files, items: [] } as unknown as DataTransfer;
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: data });
    target.dispatchEvent(over);
    if (type === "drop") {
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: data });
      target.dispatchEvent(drop);
      onDrop(data);
    }
    return over;
  }

  it("Ctrl toggles a row, Shift selects the range in shown order, a plain click clears and opens", () => {
    const { host, tree, opened, row, click } = mini();
    click("a.md", { ctrlKey: true });
    click("c.md", { ctrlKey: true });
    expect(tree.selectedKeys().sort()).toEqual(["a.md", "c.md"]);
    expect(row("a.md").getAttribute("aria-selected")).toBe("true");
    expect(row("a.md").classList.contains("is-selected")).toBe(true);
    expect(row("b.md").getAttribute("aria-selected")).toBe("false");
    expect(host.getAttribute("aria-multiselectable")).toBe("true");
    expect(opened).toEqual([]);

    click("b.md", { shiftKey: true }); // anchor is c.md
    expect(tree.selectedKeys().sort()).toEqual(["b.md", "c.md"]);

    click("a.md");
    expect(tree.selectedKeys()).toEqual([]);
    expect(opened).toEqual(["a.md"]);
  });

  it("Escape clears the selection and Ctrl+A selects every visible row", () => {
    const { host, tree, click } = mini();
    click("a.md", { ctrlKey: true });
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tree.selectedKeys()).toEqual([]);

    host.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    expect(tree.selectedKeys().sort()).toEqual(["F", "a.md", "b.md", "c.md"]);
  });

  it("select mode makes plain taps toggle rows and shows checkboxes", () => {
    const { tree, opened, row, click } = mini();
    expect(tree.toggleSelectMode()).toBe(true);
    click("b.md");
    expect(tree.selectedKeys()).toEqual(["b.md"]);
    expect(row("b.md").querySelector(".tree-check.is-on")).not.toBeNull();
    expect(opened).toEqual([]);
  });

  it("the bar under the tree counts the selection and downloads it", () => {
    const { tree, click, footer } = mini();
    const downloads: string[][] = [];
    tree.hooks.onDownload = (keys) => downloads.push(keys);
    expect(footer.hidden).toBe(true);
    click("a.md", { ctrlKey: true });
    expect(footer.hidden).toBe(false);
    expect(footer.textContent).toContain("Zaznaczono: 1");
    [...footer.querySelectorAll("button")].find((b) => b.textContent === "Pobierz (.zip)")!.click();
    expect(downloads).toEqual([["a.md"]]);
    [...footer.querySelectorAll("button")].find((b) => b.textContent === "Wyczyść")!.click();
    expect(tree.selectedKeys()).toEqual([]);
    expect(footer.hidden).toBe(true);
  });

  it("files dragged from the computer highlight the folder under the cursor and reach onDropFiles", () => {
    const { host, tree, row, footer } = mini();
    const dropped: string[] = [];
    tree.hooks.onDropFiles = (_data, folder) => dropped.push(folder);
    const file = new File(["# x"], "x.md");

    const over = osDrag("dragover", row("F"), [file]);
    expect(over.defaultPrevented).toBe(true);
    expect(row("F").classList.contains("is-drop")).toBe(true);
    expect(footer.querySelector<HTMLElement>(".tree-footer-hint")!.hidden).toBe(false);
    expect(footer.textContent).toContain("Upuść pliki .md, aby je dodać");

    osDrag("drop", row("F"), [file], () => undefined);
    expect(dropped).toEqual(["F"]);
    expect(row("F").classList.contains("is-drop")).toBe(false);
    expect(footer.querySelector<HTMLElement>(".tree-footer-hint")!.hidden).toBe(true);

    osDrag("dragover", host, [file]);
    expect(host.classList.contains("is-drop-root")).toBe(true);
    osDrag("drop", host, [file]);
    expect(dropped).toEqual(["F", ""]);
  });

  it("a drag of a note from the tree is not taken for a file drop", () => {
    const { row, tree } = mini();
    const dropped: string[] = [];
    tree.hooks.onDropFiles = (_data, folder) => dropped.push(folder);
    const moved: string[] = [];
    tree.hooks.onMove = (keys, folder) => moved.push(`${keys.join("+")}->${folder}`);
    row("a.md").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("F").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(moved).toEqual(["a.md->F"]);
    expect(dropped).toEqual([]);
  });

  it("a folder row is draggable, and dragging it onto a note's row drops it in that note's folder", () => {
    const { row, tree } = mini();
    expect(row("F").getAttribute("draggable")).toBe("true");
    const moved: string[] = [];
    tree.hooks.onMove = (keys, folder) => moved.push(`${keys.join("+")}->${folder}`);
    row("F").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("b.md").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(moved).toEqual(["F->"]);
  });

  it("dragging a row of the selection carries the whole selection, dragged row first; any other row carries only itself", () => {
    const { host, row, tree, click } = mini();
    const moved: string[][] = [];
    tree.hooks.onMove = (keys) => moved.push(keys);
    click("a.md", { ctrlKey: true });
    click("c.md", { ctrlKey: true });
    const data = new Map<string, string>();
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value) } });
    row("c.md").dispatchEvent(start);
    expect(data.get("text/plain")).toBe("c.md\na.md");
    row("F").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    row("b.md").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("F").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(moved).toEqual([["c.md", "a.md"], ["b.md"]]);
    expect(host.querySelector('[data-key="b.md"]')).not.toBeNull();
  });
});

describe("FileTree: file rows select on a click, open on a double click or Enter", () => {
  function withFile() {
    const host = document.createElement("div");
    document.body.append(host);
    const opened: string[] = [];
    const tree = new FileTree(host, () => undefined);
    tree.hooks = { onOpenFile: (fileId) => opened.push(fileId) };
    tree.setItems([{ id: "n1", path: "F/Plan.md" }], ["F"], [], [{ fileId: "a".repeat(32), path: "F/umowa.pdf" }]);
    const row = (path: string) => host.querySelector<HTMLElement>(`[data-key="${path}"]`)!;
    const click = (path: string, init: MouseEventInit = {}) => row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
    return { host, tree, opened, row, click };
  }

  it("a plain click selects only the file row and does not open it", () => {
    const { row, tree, opened, click } = withFile();
    click("F/Plan.md", { ctrlKey: true });
    click("F/umowa.pdf");
    expect(tree.selectedKeys()).toEqual(["F/umowa.pdf"]);
    expect(row("F/umowa.pdf").getAttribute("aria-selected")).toBe("true");
    expect(row("F/umowa.pdf").classList.contains("is-selected")).toBe(true);
    expect(opened).toEqual([]);
  });

  it("a Ctrl click adds the file to the selection without opening it", () => {
    const { tree, opened, click } = withFile();
    click("F/umowa.pdf", { ctrlKey: true });
    expect(tree.selectedKeys()).toEqual(["F/umowa.pdf"]);
    expect(opened).toEqual([]);
  });

  it("a double click opens the file; Enter on the focused file row opens it too", () => {
    const { host, row, opened, click } = withFile();
    click("F/umowa.pdf");
    row("F/umowa.pdf").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(opened).toEqual(["a".repeat(32)]);
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual(["a".repeat(32), "a".repeat(32)]);
  });

  it("a click on a note still opens it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const opened: string[] = [];
    const tree = new FileTree(host, (_id, path) => opened.push(path));
    tree.setItems([{ id: "n1", path: "Plan.md" }]);
    host.querySelector<HTMLElement>('[data-key="Plan.md"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual(["Plan.md"]);
  });
});

describe("FileTree move target while dragging inside the tree", () => {
  const dragStart = (el: HTMLElement) => el.dispatchEvent(new Event("dragstart", { bubbles: true }));
  const dragOver = (el: HTMLElement) => el.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
  const line = (host: HTMLElement) => host.querySelector<HTMLElement>(".tree-drop-line");

  it("an empty folder gets the line just under its row and is highlighted; dragend clears both", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const tree = new FileTree(host, () => undefined);
    tree.setItems([{ id: "1", path: "a.md" }, { id: "2", path: "b.md" }], ["F"]);
    const row = (path: string) => host.querySelector<HTMLElement>(`[data-key="${path}"]`)!;

    dragStart(row("a.md"));
    dragOver(row("F"));
    expect(row("F").classList.contains("is-drop")).toBe(true);
    expect(line(host)!.style.top).toBe(`${ROW_H - 1}px`);
    expect(line(host)!.style.left).toBe(`${14 + 4}px`);

    row("a.md").dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(row("F").classList.contains("is-drop")).toBe(false);
    expect(line(host)).toBeNull();
    expect(tree.selectedKeys()).toEqual([]);
  });

  it("an open folder puts the line where the name sorts among its children", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const tree = new FileTree(host, () => undefined);
    tree.setItems([{ id: "1", path: "F/x.md" }, { id: "2", path: "F/z.md" }, { id: "3", path: "y.md" }], ["F"]);
    const row = (path: string) => host.querySelector<HTMLElement>(`[data-key="${path}"]`)!;

    dragStart(row("y.md"));
    dragOver(row("F"));
    // Rows: F, x.md, z.md, y.md. y.md sorts between x.md and z.md, so the line sits at the top of z.md.
    expect(line(host)!.style.top).toBe(`${2 * ROW_H - 1}px`);
    expect(line(host)!.style.left).toBe(`${14 + 4}px`);
    row("y.md").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(line(host)).toBeNull();
  });
});

describe("FileTree active note and collapsed folders", () => {
  // F/G/x.md is the open note; a.md sits at the top.
  function nested() {
    const host = document.createElement("div");
    document.body.append(host);
    const tree = new FileTree(host, () => undefined);
    tree.setItems([{ id: "x", path: "F/G/x.md" }, { id: "a", path: "a.md" }], ["F", "F/G"]);
    const row = (path: string) => host.querySelector<HTMLElement>(`[data-key="${path}"]`);
    const click = (path: string) => row(path)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { host, tree, row, click };
  }

  it("a note inside a collapsed folder marks that folder only", () => {
    const { host, tree, row } = nested();
    tree.collapseAll();
    tree.setActive("x");
    expect(row("F")!.classList.contains("has-active")).toBe(true);
    expect(row("F")!.getAttribute("aria-description")).toBe("Zawiera otwartą notatkę");
    expect(host.querySelectorAll(".is-active")).toHaveLength(0);
    expect(row("F/G/x.md")).toBeNull();
  });

  it("nested collapsed folders: only the outermost visible one is marked", () => {
    const { host, tree, row, click } = nested();
    tree.setActive("x");
    // F is open and G is closed, so G is the visible folder holding the note.
    expect(host.querySelectorAll(".has-active")).toHaveLength(1);
    expect(row("F/G")!.classList.contains("has-active")).toBe(true);

    click("F"); // collapse F: it is now the outermost visible folder
    expect(host.querySelectorAll(".has-active")).toHaveLength(1);
    expect(row("F")!.classList.contains("has-active")).toBe(true);
    expect(row("F/G")).toBeNull();
  });

  it("expanding the folders shows the note as active and drops the mark", () => {
    const { host, tree, row } = nested();
    tree.collapseAll();
    tree.setActive("x");
    tree.expandAll();
    expect(row("F/G/x.md")!.classList.contains("is-active")).toBe(true);
    expect(host.querySelectorAll(".has-active")).toHaveLength(0);
    expect(row("F")!.hasAttribute("aria-description")).toBe(false);
  });

  it("clearing the active note removes the mark", () => {
    const { host, tree } = nested();
    tree.collapseAll();
    tree.setActive("x");
    tree.setActive(null);
    expect(host.querySelectorAll(".has-active")).toHaveLength(0);
  });
});

describe("FileTree: files in folders", () => {
  it("lists a folder's files after its notes, with the size, and a double click opens the file", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const opened: string[] = [];
    const tree = new FileTree(host, () => undefined);
    tree.hooks = { onOpenFile: (fileId) => opened.push(fileId) };
    tree.setItems([{ id: "n1", path: "F/Plan.md" }], ["F"], [], [{ fileId: "a".repeat(32), path: "F/umowa.pdf", size: 2048, mime: "application/pdf" }]);
    const keys = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((r) => r.dataset.key);
    expect(keys).toEqual(["F", "F/Plan.md", "F/umowa.pdf"]);
    const file = host.querySelector<HTMLElement>('[data-key="F/umowa.pdf"]')!;
    expect(file.classList.contains("is-file")).toBe(true);
    expect(file.querySelector(".tree-size")?.textContent).toBe("2 KB");
    file.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual([]);
    // the click re-rendered the rows: the second click lands on the new row and opens the file
    host.querySelector<HTMLElement>('[data-key="F/umowa.pdf"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(opened).toEqual(["a".repeat(32)]);
  });

  it("the space bar on a focused file row asks for its preview as a space preview; on a folder it does nothing", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: [string, string, boolean | undefined][] = [];
    const tree = new FileTree(host, () => undefined);
    tree.hooks = { onOpenFile: (fileId, name, bySpace) => calls.push([fileId, name, bySpace]) };
    tree.setItems([], ["F"], [], [{ fileId: "a".repeat(32), path: "F/umowa.pdf" }]);
    host.querySelector<HTMLElement>('[data-key="F/umowa.pdf"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    host.querySelector<HTMLElement>('[data-key="F/umowa.pdf"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    host.dispatchEvent(space);
    expect(calls).toEqual([["a".repeat(32), "umowa.pdf", undefined], ["a".repeat(32), "umowa.pdf", true]]);
    expect(space.defaultPrevented).toBe(true);
    host.querySelector<HTMLElement>('[data-key="F"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const onFolder = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    host.dispatchEvent(onFolder);
    expect(calls).toHaveLength(2);
    expect(onFolder.defaultPrevented).toBe(false);
  });
});

describe("FileTree: two slow clicks on a file are two selections, not an open", () => {
  it("opens only when the second click comes soon", () => {
    vi.useFakeTimers();
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const opened: string[] = [];
      const tree = new FileTree(host, () => undefined);
      tree.hooks = { onOpenFile: (fileId) => opened.push(fileId) };
      tree.setItems([], ["F"], [], [{ fileId: "a".repeat(32), path: "F/umowa.pdf" }]);
      const click = () => host.querySelector<HTMLElement>('[data-key="F/umowa.pdf"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      click();
      vi.advanceTimersByTime(1000);
      click();
      expect(opened).toEqual([]);
      vi.advanceTimersByTime(200);
      click();
      expect(opened).toEqual(["a".repeat(32)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("kanban boards in the tree", () => {
  // Folder F with a board "Tablica" and notes "a", "b"; the root has a note "Plan" and a board "Zadania".
  const items = [
    { id: "f1", path: "F/a.md" },
    { id: "b1", path: "F/Tablica.md" },
    { id: "f2", path: "F/b.md" },
    { id: "r1", path: "Plan.md" },
    { id: "b2", path: "Zadania.md" },
  ];
  const isBoard = (id: string) => id === "b1" || id === "b2";
  const inF = (root: ReturnType<typeof buildTree>) => (root.children.find((n) => n.kind === "folder") as { children: { name: string }[] }).children.map((n) => n.name);

  it("sorts boards above folders and notes in both directions, keeping name order among boards", () => {
    const root = buildTree(items, ["F"], false, [], [], isBoard);
    expect(root.children.map((n) => n.name)).toEqual(["Zadania.md", "F", "Plan.md"]);
    const desc = buildTree(items, ["F"], true, [], [], isBoard);
    expect(desc.children.map((n) => n.name)).toEqual(["Zadania.md", "F", "Plan.md"]);
    expect(inF(root)).toEqual(["Tablica.md", "a.md", "b.md"]);
    expect(inF(desc)).toEqual(["Tablica.md", "b.md", "a.md"]);
  });

  it("shows the board icon on a board row and the note icon on the others", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const tree = new FileTree(host, () => undefined);
    tree.isBoard = isBoard;
    tree.setItems(items, ["F"]);
    tree.setSort(false);
    const label = (key: string) => host.querySelector<HTMLElement>(`[data-key="${key}"] .tree-label`)!;
    expect(label("Zadania.md").querySelector("svg")!.outerHTML).toBe(icon("columns-3").outerHTML);
    expect(label("Plan.md").querySelector("svg")!.outerHTML).toBe(icon("file-text").outerHTML);
  });

  it("re-sorts when a note becomes a board, and when it stops", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const tree = new FileTree(host, () => undefined);
    let boards = new Set<string>();
    tree.isBoard = (id) => boards.has(id);
    tree.setItems([{ id: "1", path: "a.md" }, { id: "2", path: "b.md" }]);
    const order = () => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((r) => r.dataset.key);
    expect(order()).toEqual(["a.md", "b.md"]);

    boards = new Set(["2"]);
    tree.refreshBoards();
    expect(order()).toEqual(["b.md", "a.md"]);

    boards = new Set();
    tree.refreshBoards();
    expect(order()).toEqual(["a.md", "b.md"]);
  });
});
