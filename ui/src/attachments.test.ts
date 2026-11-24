// @vitest-environment jsdom
import { projectOfNote } from "./filestore";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentHandlers, BlobCache, embedAt, embedImages, embedReadingImages, embedText, EMBED, insertFiles, isImage, pickFiles,
  releaseReadingImages, saveFiles,
} from "./attachments";
import type { Bridge } from "./bridge";
import {
  clampPosition, embedPattern, FILE_EMBED, fileEmbed, formatImageAlias, MemoryFileStore, newEmbedId, parseImageAlias, positionAt,
} from "./filestore";
import { previewEmbeds } from "./preview/triggers";
import { setSetting } from "./settings";

vi.mock("./preview/triggers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview/triggers")>()),
  previewEmbeds: vi.fn(async () => {}),
}));

function fakeBridge(calls: Array<[string, unknown]>, files?: MemoryFileStore): Bridge {
  return {
    call: vi.fn(async (cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "save_attachment") return `assets/${(args as { name: string }).name}`;
      if (cmd === "read_attachment") return new Uint8Array([1, 2, 3]);
      throw new Error(cmd);
    }),
    on: () => () => {},
    ...(files ? { files } : {}),
  } as unknown as Bridge;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";
const E1 = "aaaaaaaa";
const E2 = "bbbbbbbb";
const png = (name = "zdjecie.png") => new File(["img"], name, { type: "image/png" });
const txt = (name = "notatka.txt") => new File(["tekst"], name, { type: "text/plain" });

let views: EditorView[] = [];
function makeView(doc: string, bridge: Bridge, cursor = doc.length, onError = (_: string) => {}, project = () => "Projekty/Plan") {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [attachmentHandlers(bridge, onError, project), embedImages(bridge)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

// A note the way the editor has it: its Y.Text is the source, the view mirrors it through yCollab.
function makeNote(text: string, bridge: Bridge) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, text);
  const undo = new Y.UndoManager(ytext);
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: [attachmentHandlers(bridge, () => {}, () => "Projekty/Plan"), embedImages(bridge), yCollab(ytext, null, { undoManager: undo })],
    }),
    parent: document.body,
  });
  views.push(view);
  return { view, ytext, undo, doc };
}

const embedIds = (doc: string) => [...doc.matchAll(/!\[\[plik:([0-9a-f]{32})(?:#[0-9a-f]{8})?(?:\|[^\]\n]+)?\]\]/g)].map((m) => m[1]);
const embedsOf = (doc: string) => [...doc.matchAll(/!\[\[plik:[0-9a-f]{32}(?:#[0-9a-f]{8})?(?:\|[^\]\n]+)?\]\]/g)].map((m) => m[0]);
const pickerInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

/** Picks files in the system dialog (the picker's change event, with its file list). */
function choose(files: File[]): void {
  const input = pickerInput();
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.onchange?.(new Event("change"));
}

beforeAll(() => {
  // jsdom has no object URLs; the widgets only need some URL to hand to <img>
  Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
  // jsdom has no text layout: CodeMirror's measure asks text ranges for their rects
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;
});

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  document.body.innerHTML = "";
  setSetting("autoLoadImages", true);
  vi.unstubAllGlobals();
});

describe("attachments", () => {
  it("saves each file and returns its embed in order", async () => {
    const calls: Array<[string, unknown]> = [];
    const files = [new File(["x"], "zdjęcie.png"), new File(["y"], "")];
    const embeds = await saveFiles(fakeBridge(calls), files);
    expect(embeds).toEqual(["![[assets/zdjęcie.png]]", "![[assets/plik]]"]);
    expect(calls.map(([cmd]) => cmd)).toEqual(["save_attachment", "save_attachment"]);
    expect((calls[0][1] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([120]));
  });

  it("finds embeds of attachments only, with an optional width", () => {
    const text = `a ${embedText("assets/x.png")} b ![[zwykła]] c ![[assets/y.png|320]] ![[plik:${ID}]]`;
    expect([...text.matchAll(EMBED)].map((m) => [m[1], m[2]])).toEqual([["assets/x.png", undefined], ["assets/y.png", "320"]]);
    expect(isImage("assets/x.PNG")).toBe(true);
    expect(isImage("assets/x.pdf")).toBe(false);
  });

  it("turns the wikilink of an image into an image in the reading view", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>!<a class="wikilink" data-target="assets/a.png">assets/a.png</a> i <a class="wikilink" data-target="Inna">Inna</a></p>';
    embedReadingImages(root, fakeBridge([]));
    expect(root.querySelector("img.embed-image")).not.toBeNull();
    expect(root.querySelectorAll(".wikilink")).toHaveLength(1);
    expect(root.textContent).toContain("i ");
  });

  it("turns an embed-marked image wikilink into an image in the reading view", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p><a class="wikilink embed" data-target="assets/a.png">320</a></p>';
    embedReadingImages(root, fakeBridge([]));
    expect(root.querySelector<HTMLImageElement>("img.embed-image")!.style.width).toBe("320px");
    releaseReadingImages(root);
  });

  it("takes the project of a note under Projekty/<Name>", () => {
    expect(projectOfNote("Projekty/Plan/notatka.md")).toBe("Projekty/Plan");
    expect(projectOfNote("Projekty/Plan/pod/x.md")).toBe("Projekty/Plan");
    expect(projectOfNote("Dziennik.md")).toBeNull();
  });

  it("keeps the desktop path: without a file store the picture is saved under assets/", async () => {
    const calls: Array<[string, unknown]> = [];
    const view = makeView("", fakeBridge(calls), 0);
    await insertFiles(view, [new File(["x"], "a.png", { type: "image/png" })]);
    expect(calls.map(([cmd]) => cmd)).toEqual(["save_attachment"]);
    expect(view.state.doc.toString()).toBe("![[assets/a.png]]");
  });
});

describe("uploads on the server", () => {
  it("puts one embed per file where the command was, each with a new embed id, and uploads into the note's project", async () => {
    const store = new MemoryFileStore("u1");
    const upload = vi.spyOn(store, "upload");
    const view = makeView("ab", fakeBridge([], store), 1);
    await insertFiles(view, [png(), txt()], (text) => view.dispatch({ changes: { from: 1, insert: text } }));
    const [a, b] = embedIds(view.state.doc.toString());
    const [ea, eb] = embedsOf(view.state.doc.toString()).map((e) => /#([0-9a-f]{8})/.exec(e)![1]);
    expect(ea).not.toBe(eb);
    expect(view.state.doc.toString()).toBe(`a${fileEmbed(a, undefined, ea)}\n${fileEmbed(b, undefined, eb)}b`);
    expect(upload.mock.calls.map(([, opts]) => opts.project)).toEqual(["Projekty/Plan", "Projekty/Plan"]);
    await tick(20);
    expect((await store.list()).files.map((f) => f.state)).toEqual(["ready", "ready"]);
  });

  it("keeps the embed where it was put when text is typed before it during the upload", async () => {
    const store = new MemoryFileStore("u1");
    store.stepDelay = 20;
    const view = makeView("", fakeBridge([], store));
    await insertFiles(view, [txt()]);
    const [id] = embedIds(view.state.doc.toString());
    const embed = embedsOf(view.state.doc.toString())[0];
    view.dispatch({ changes: { from: 0, insert: "xyz " } });
    await tick(200);
    expect(view.state.doc.toString()).toBe(`xyz ${embed}`);
    expect((await store.info(id))?.state).toBe("ready");
  });

  it("shows the upload with a progressbar, and cancel removes the embed and drops the file", async () => {
    const store = new MemoryFileStore("u1");
    store.stepDelay = 30;
    const view = makeView("", fakeBridge([], store));
    await insertFiles(view, [txt()]);
    const bar = view.dom.querySelector<HTMLElement>(".file-upload [role=progressbar]");
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("aria-valuenow")).toBe("0");
    const cancel = view.dom.querySelector<HTMLButtonElement>(".file-upload-cancel")!;
    expect(cancel.getAttribute("aria-label")).toBeTruthy();
    expect(cancel.title).toBeTruthy();
    cancel.click();
    expect(view.state.doc.toString()).toBe("");
    await tick(100);
    expect((await store.list()).files).toHaveLength(0);
  });

  it("does not restore an embed the user deleted during the upload", async () => {
    const store = new MemoryFileStore("u1");
    store.stepDelay = 20;
    const view = makeView("", fakeBridge([], store));
    await insertFiles(view, [txt()]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
    await tick(200);
    expect(view.state.doc.toString()).toBe("");
    expect((await store.list()).files.map((f) => f.state)).toEqual(["ready"]);
  });

  it("shows an error with Ponów and Usuń, and retry uploads the same id again: one embed, one file", async () => {
    const store = new MemoryFileStore("u1");
    const onError = vi.fn();
    const view = makeView("", fakeBridge([], store), 0, onError);
    store.failNext = new Error("brak sieci");
    await insertFiles(view, [txt()]);
    await tick(5);
    const error = view.dom.querySelector<HTMLElement>(".file-upload-error")!;
    expect(error.textContent).toContain("brak sieci");
    expect(view.dom.querySelector<HTMLButtonElement>(".file-upload-cancel")!.textContent).toBe("Usuń");
    const retry = view.dom.querySelector<HTMLButtonElement>(".file-upload-retry")!;
    expect(retry.getAttribute("aria-label")).toBeTruthy();
    const [id] = embedIds(view.state.doc.toString());
    retry.click();
    await tick(20);
    expect(embedIds(view.state.doc.toString())).toEqual([id]);
    expect((await store.list()).files.map((f) => f.id)).toEqual([id]);
    expect(view.dom.querySelector(".file-upload")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps one embed and one upload through undo and redo while the file uploads", async () => {
    const store = new MemoryFileStore("u1");
    store.stepDelay = 20;
    const { view, undo } = makeNote("", fakeBridge([], store));
    await insertFiles(view, [txt()]);
    const embed = embedsOf(view.state.doc.toString())[0];
    undo.undo();
    expect(view.state.doc.toString()).toBe("");
    undo.redo();
    expect(view.state.doc.toString()).toBe(embed);
    expect(view.dom.querySelector(".file-upload")).not.toBeNull();
    await tick(200);
    expect(view.state.doc.toString()).toBe(embed);
    expect(view.dom.querySelector(".file-upload")).toBeNull();
    expect((await store.list()).files.map((f) => f.state)).toEqual(["ready"]);
  });

  it("writes a width into the right one of two embeds of the same file, keeping each embed id", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, null, E1)}\n${fileEmbed(ID, null, E2)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const embeds = view.dom.querySelectorAll<HTMLElement>(".file-embed");
    expect(embeds).toHaveLength(2);
    const handle = embeds[1].querySelector<HTMLElement>(".file-resize")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 160 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(view.state.doc.toString()).toBe(`${fileEmbed(ID, null, E1)}\n${fileEmbed(ID, { width: 60 }, E2)}\nkoniec`);
  });

  it("gives a resized copy a new embed id when the note still has the old one", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, null, E1)}\n${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const input = view.dom.querySelectorAll<HTMLInputElement>(".file-width")[1];
    input.value = "200";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const [first, second] = embedsOf(view.state.doc.toString());
    expect(first).toBe(fileEmbed(ID, null, E1));
    expect(second).toMatch(new RegExp(`^!\\[\\[plik:${ID}#[0-9a-f]{8}\\|200\\]\\]$`));
    expect(second).not.toContain(E1);
  });

  it("applies a typed width on Enter", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const input = view.dom.querySelector<HTMLInputElement>(".file-width")!;
    expect(input.getAttribute("aria-label")).toBeTruthy();
    input.value = "200";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.state.doc.toString()).toBe(`${fileEmbed(ID, { width: 200 }, E1)}\nkoniec`);
  });

  it("shows a file as a chip with its name, size and buttons, and a muted note for a missing one", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(txt("raport.txt"), { id: ID });
    const doc = `${fileEmbed(ID, null, E1)}\n${fileEmbed(ID2, null, E2)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    expect(view.dom.querySelector(".file-chip .file-name")?.textContent).toBe("raport.txt");
    expect(view.dom.querySelector(".file-chip .file-size")?.textContent).toBeTruthy();
    expect(view.dom.querySelector(".file-chip .file-open")?.textContent).toBe("Otwórz");
    expect(view.dom.querySelector(".file-chip .file-download")?.textContent).toBe("Pobierz");
    expect(view.dom.querySelector(".file-note")?.textContent).toBe("Plik niedostępny");
  });

  it("says the file is unavailable without a connection", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    vi.spyOn(store, "read").mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    expect(view.dom.querySelector(".file-image-box .file-note")?.textContent).toBe("Plik jest niedostępny bez połączenia");
  });
});

describe("pictures from the slash menu and the picker", () => {
  it("opens the system picker, and the files go in where the command was (typing before it moves nothing)", async () => {
    const store = new MemoryFileStore("u1");
    const view = makeView("ab", fakeBridge([], store), 1);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    pickFiles(view);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    view.dispatch({ changes: { from: 0, insert: "XY" } });
    choose([txt(), png()]);
    await tick(10);
    const embeds = embedsOf(view.state.doc.toString());
    expect(view.state.doc.toString()).toBe(`XYa${embeds[0]}\n${embeds[1]}b`);
    expect(embeds).toHaveLength(2);
  });

  it("follows the Y.Text when the note has one: remote edits before the place move it", async () => {
    const store = new MemoryFileStore("u1");
    const note = makeNote("ab", fakeBridge([], store));
    const { view, ytext, doc } = note;
    view.dispatch({ selection: { anchor: 1 } });
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    pickFiles(view);
    click.mockRestore();
    doc.transact(() => ytext.insert(0, "XY"), "remote");
    expect(view.state.doc.toString()).toBe("XYab");
    choose([txt()]);
    await tick(10);
    expect(ytext.toString()).toBe(`XYa${embedsOf(view.state.doc.toString())[0]}b`);
    expect(view.state.doc.toString()).toBe(ytext.toString());
  });

  it("writes the files into the note's Y.Text when another tab is shown meanwhile", async () => {
    const store = new MemoryFileStore("u1");
    const { view, ytext } = makeNote("ab", fakeBridge([], store));
    const other = makeNote("inna notatka", fakeBridge([], store));
    view.dispatch({ selection: { anchor: 1 } });
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    pickFiles(view);
    click.mockRestore();
    view.setState(other.view.state); // the user opened another note; this note's state is no longer shown
    choose([txt()]);
    await tick(10);
    expect(ytext.toString()).toBe(`a${embedsOf(ytext.toString())[0]}b`);
  });

  it("the file command's slash item inserts where the command was", async () => {
    const store = new MemoryFileStore("u1");
    const { view } = makeNote("A /dodaj plik", fakeBridge([], store));
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    view.dispatch({ changes: { from: 2, to: view.state.doc.length } });
    pickFiles(view);
    click.mockRestore();
    view.dispatch({ changes: { from: 0, insert: "X" } });
    choose([png()]);
    await tick(10);
    expect(embedsOf(view.state.doc.toString())).toHaveLength(1);
    expect(view.state.doc.toString().startsWith("XA ![[plik:")).toBe(true);
  });
});

describe("copy and move of embeds", () => {
  const paste = (view: EditorView, text: string, from = view.state.doc.length) =>
    view.dispatch({ changes: { from, insert: text }, userEvent: "input.paste" });

  it("a pasted copy of an embed in the note gets a new embed id, the same file", async () => {
    const store = new MemoryFileStore("u1");
    const embed = fileEmbed(ID, { width: 320 }, E1);
    const view = makeView(`${embed}\n`, fakeBridge([], store));
    paste(view, embed);
    const [original, copy] = embedsOf(view.state.doc.toString());
    expect(original).toBe(embed);
    expect(copy).toMatch(new RegExp(`^!\\[\\[plik:${ID}#[0-9a-f]{8}\\|320\\]\\]$`));
    expect(copy).not.toBe(original);
  });

  it("a cut and pasted embed (a move) keeps its embed id", () => {
    const store = new MemoryFileStore("u1");
    const embed = fileEmbed(ID, null, E1);
    const view = makeView(`x${embed}\ny`, fakeBridge([], store));
    view.dispatch({ changes: { from: 1, to: 1 + embed.length } }); // cut
    paste(view, embed, view.state.doc.length);
    expect(embedsOf(view.state.doc.toString())).toEqual([embed]);
  });

  it("leaves remote text alone: only pastes are rewritten", () => {
    const store = new MemoryFileStore("u1");
    const embed = fileEmbed(ID, null, E1);
    const view = makeView(embed, fakeBridge([], store));
    view.dispatch({ changes: { from: view.state.doc.length, insert: embed } });
    expect(embedsOf(view.state.doc.toString())).toEqual([embed, embed]);
  });
});

describe("the display of embeds", () => {
  it("shows a legacy image at its width, on every line but the cursor's", async () => {
    const doc = "![[assets/x.png|320]]\nkoniec";
    const view = makeView(doc, fakeBridge([]), doc.length);
    await tick(5);
    expect(view.dom.querySelector<HTMLImageElement>("img.embed-image")!.style.width).toBe("320px");
  });

  it("shows a server image at its width, and no image on the cursor's line", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, { width: 320 }, E1)}\n${fileEmbed(ID, null, E2)}`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const imgs = view.dom.querySelectorAll<HTMLElement>(".file-embed img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].style.width).toBe("320px");
  });

  it("shows two embeds of one file at their own widths", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, { width: 320 }, E1)}\n${fileEmbed(ID, { width: 60 }, E2)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    expect([...view.dom.querySelectorAll<HTMLImageElement>(".file-embed img")].map((i) => i.style.width)).toEqual(["320px", "60px"]);
  });

  it("shows a server image in the reading view at its width, with or without an embed id", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const root = document.createElement("div");
    root.innerHTML = `<p><a class="wikilink" data-target="plik:${ID}#${E1}">320</a> <a class="wikilink" data-target="plik:${ID2}">plik:${ID2}</a></p>`;
    embedReadingImages(root, fakeBridge([], store));
    await tick(10);
    expect(root.querySelector(".wikilink")).toBeNull();
    const img = root.querySelector<HTMLImageElement>(".file-embed img")!;
    expect(img.style.width).toBe("320px");
    expect(root.querySelectorAll(".file-note")).toHaveLength(1);
    releaseReadingImages(root);
  });

  it("shows the thumbnail first and reads the original only when it is opened", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    await store.upload(png("mini.webp"), { id: ID2 });
    const real = store.info.bind(store);
    vi.spyOn(store, "info").mockImplementation(async (id) => (id === ID ? { ...(await real(id))!, thumb: ID2 } : real(id)));
    const read = vi.spyOn(store, "read");
    const root = document.createElement("div");
    root.innerHTML = `<p><a class="wikilink" data-target="plik:${ID}#${E1}">320</a></p>`;
    embedReadingImages(root, fakeBridge([], store));
    await tick(10);
    expect(read.mock.calls.map(([id]) => id)).toEqual([ID2]);
    releaseReadingImages(root);
  });

  it("loads a picture only when it is on screen", async () => {
    const seen: Array<{ cb: IntersectionObserverCallback; el: Element[] }> = [];
    class FakeObserver {
      private readonly targets: Element[] = [];
      constructor(cb: IntersectionObserverCallback) {
        seen.push({ cb, el: this.targets });
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      disconnect() {
        this.targets.length = 0;
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const read = vi.spyOn(store, "read");
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    expect(read).not.toHaveBeenCalled();
    const observer = seen[seen.length - 1];
    expect(observer.el).toHaveLength(1);
    observer.cb([{ isIntersecting: true, target: observer.el[0] } as IntersectionObserverEntry], {} as IntersectionObserver);
    await tick(10);
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector<HTMLImageElement>(".file-embed img")!.src).toContain("blob:");
  });

  it("with the setting off, shows a button and loads the picture on its click", async () => {
    setSetting("autoLoadImages", false);
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const read = vi.spyOn(store, "read");
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    expect(read).not.toHaveBeenCalled();
    const show = view.dom.querySelector<HTMLButtonElement>(".file-show")!;
    expect(show.textContent).toBe("Wyświetl obraz");
    show.click();
    await tick(10);
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector(".file-show")).toBeNull();
  });

  it("an SVG is shown only as an <img> with a blob URL, never inline", async () => {
    const store = new MemoryFileStore("u1");
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'], "rys.svg", { type: "image/svg+xml" });
    await store.upload(svg, { id: ID });
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const embed = view.dom.querySelector(".file-embed")!;
    expect(embed.querySelector("svg, script")).toBeNull();
    expect(embed.querySelector<HTMLImageElement>("img")!.src).toContain("blob:");
  });
});

describe("object URLs and the cache", () => {
  it("revokes the URLs of a reading view's last paint when the next paint comes", async () => {
    const revoked: string[] = [];
    let n = 0;
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:${++n}`),
      revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
    }));
    const root = document.createElement("div");
    const html = '<p>!<a class="wikilink" data-target="assets/a.png">assets/a.png</a></p>';
    root.innerHTML = html;
    embedReadingImages(root, fakeBridge([]));
    await new Promise((r) => setTimeout(r, 0));
    expect([...root.querySelectorAll("img")].map((img) => img.src)).toEqual(["blob:1"]);

    // the next paint replaces the content and calls the hook again
    root.innerHTML = html;
    embedReadingImages(root, fakeBridge([]));
    expect(revoked).toEqual(["blob:1"]);
    await new Promise((r) => setTimeout(r, 0));
    releaseReadingImages(root);
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });

  it("revokes a picture's URL when its embed leaves the note", async () => {
    const revoked: string[] = [];
    let n = 0;
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:${++n}`),
      revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
    }));
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    expect(view.dom.querySelector<HTMLImageElement>(".file-embed img")!.src).toContain("blob:");
    view.dispatch({ changes: { from: 0, to: fileEmbed(ID, null, E1).length } });
    expect(revoked).toEqual(["blob:1"]);
  });

  it("keeps the least recently used bytes within the limit", () => {
    const cache = new BlobCache(10);
    cache.set("a", new Blob(["123456"]));
    cache.set("b", new Blob(["123456"]));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    cache.set("c", new Blob(["1234"]));
    cache.get("b");
    cache.set("d", new Blob(["1234"]));
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.bytes).toBe(10);
    cache.set("big", new Blob(["12345678901"]));
    expect(cache.get("big")).toBeUndefined();
  });
});

describe("new embed ids", () => {
  it("newEmbedId is 8 hex digits", () => {
    expect(newEmbedId()).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("the image alias (docs/PLIKI.md §1)", () => {
  it("parses the forms (the old width too) and rejects what the grammar does not allow", () => {
    expect(parseImageAlias("320")).toEqual({ width: 320, height: null, align: null, position: null });
    expect(parseImageAlias("320x200 center")).toEqual({ width: 320, height: 200, align: "center", position: null });
    expect(parseImageAlias("wrap-right")).toEqual({ width: null, height: null, align: "wrap-right", position: null });
    expect(parseImageAlias("320 wrap-left")).toEqual({ width: 320, height: null, align: "wrap-left", position: null });
    expect(parseImageAlias("5x9000")).toEqual({ width: 40, height: 4000, align: null, position: null });
    for (const bad of ["", "320x", "x200", "320center", "320 middle", "320x200x100", "123456", "320  left", "Center", "poz", "320 poz", "320pos25", "left poz5 center"]) {
      expect(parseImageAlias(bad)).toBeNull();
    }
  });

  it("reads and writes the position: pozN with N 0..50, clamped", () => {
    expect(parseImageAlias("poz25")).toEqual({ width: null, height: null, align: null, position: 25 });
    expect(parseImageAlias("320 poz0")).toEqual({ width: 320, height: null, align: null, position: 0 });
    expect(parseImageAlias("320x200 left poz50")).toEqual({ width: 320, height: 200, align: "left", position: 50 });
    expect(parseImageAlias("poz999")).toEqual({ width: null, height: null, align: null, position: 50 });
    expect(formatImageAlias({ width: 300, height: 200, align: null, position: 25 })).toBe("300x200 poz25");
    expect(formatImageAlias({ width: null, position: 0 })).toBe("poz0");
    expect(formatImageAlias({ width: 300, position: 80 })).toBe("300 poz50");
    expect(formatImageAlias({ width: 300, position: null })).toBe("300");
    expect(clampPosition(-3)).toBe(0);
    expect(clampPosition(24.6)).toBe(25);
    expect(clampPosition(51)).toBe(50);
  });

  it("maps the left edge to the position: 0 at the left, 50 at the right, 25 centred", () => {
    expect(positionAt(250, 800, 300)).toBe(25); // centred: (800 - 300) / 2
    expect(positionAt(-40, 800, 300)).toBe(0); // dragged past the left edge
    expect(positionAt(900, 800, 300)).toBe(50); // past the right edge
    expect(positionAt(10, 200, 300)).toBe(0); // no room beside a picture wider than the line
  });

  it("formats an alias back to the text it was read from", () => {
    for (const text of ["320", "320x200", "center", "320x200 center", "320 wrap-left", "40x4000 right", "poz7", "320 poz7", "320x200 right poz50"]) {
      expect(formatImageAlias(parseImageAlias(text))).toBe(text);
    }
    expect(formatImageAlias(null)).toBe("");
    expect(formatImageAlias({ width: 5, height: 9000, align: null })).toBe("40x4000");
    expect(formatImageAlias({ height: 200, align: "left" })).toBe("left"); // a height needs a width
  });

  it("matches the embed with its alias, and nothing else", () => {
    const whole = (alias: string) => new RegExp(`^${embedPattern(ID)}$`).exec(`![[plik:${ID}#${E1}|${alias}]]`);
    for (const alias of ["320", "320x200 center", "wrap-right", "center"]) expect(whole(alias)?.[2]).toBe(alias);
    for (const alias of ["320 middle", "320x", "320center", "abc"]) expect(whole(alias)).toBeNull();
    expect(new RegExp(`^${embedPattern(ID)}$`).exec(`![[plik:${ID}|]]`)).toBeNull();
    expect([...`![[plik:${ID}#${E1}|320x200 center]]`.matchAll(FILE_EMBED)][0][3]).toBe("320x200 center");
  });

  it("commits the whole alias: a height, then a placement, with the ratio off", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, { width: 320 }, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const ratio = view.dom.querySelector<HTMLInputElement>(".file-controls input[type=checkbox]")!;
    ratio.checked = false;
    ratio.dispatchEvent(new Event("change"));
    const height = view.dom.querySelector<HTMLInputElement>(".file-height")!;
    height.value = "200";
    height.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.state.doc.toString()).toBe(`${fileEmbed(ID, { width: 320, height: 200 }, E1)}\nkoniec`);
    await tick(10);
    const select = view.dom.querySelector<HTMLSelectElement>(".file-controls select")!;
    expect(select.getAttribute("aria-label")).toBeTruthy();
    select.value = "center";
    select.dispatchEvent(new Event("change"));
    expect(view.state.doc.toString()).toBe(`![[plik:${ID}#${E1}|320x200 center]]\nkoniec`);
    await tick(10);
    expect(view.dom.querySelector(".file-align-center img")).not.toBeNull();
    ratio.checked = true; // back to the default for the tests that follow
    ratio.dispatchEvent(new Event("change"));
  });

  it("with the ratio on, a typed width gets the picture's height", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const real = store.info.bind(store);
    vi.spyOn(store, "info").mockImplementation(async (id) => ({ ...(await real(id))!, width: 400, height: 200 }));
    const doc = `${fileEmbed(ID, null, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const width = view.dom.querySelector<HTMLInputElement>(".file-width")!;
    width.value = "320";
    width.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.state.doc.toString()).toBe(`![[plik:${ID}#${E1}|320x160]]\nkoniec`);
  });

  it("a typed position is written with the alias, drops the align, and places the picture by its share", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const doc = `${fileEmbed(ID, { width: 320, align: "left" }, E1)}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    const position = view.dom.querySelector<HTMLInputElement>(".file-position")!;
    position.value = "25";
    position.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.state.doc.toString()).toBe(`![[plik:${ID}#${E1}|320 poz25]]\nkoniec`);
    await tick(10);
    const embed = view.dom.querySelector<HTMLElement>(".file-embed")!;
    expect([embed.classList.contains("file-pos"), embed.style.getPropertyValue("--pos"), embed.className.includes("file-align")]).toEqual([true, "25", false]);
    expect(embed.querySelector(".file-position")).not.toBeNull();
  });

  it("places a server image in the reading view by its alias", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const root = document.createElement("div");
    root.innerHTML = `<p><a class="wikilink" data-target="plik:${ID}#${E1}">320x200 wrap-right</a> <a class="wikilink" data-target="plik:${ID}#${E2}">center</a></p>`;
    embedReadingImages(root, fakeBridge([], store));
    await tick(10);
    const img = root.querySelector<HTMLImageElement>(".file-align-wrap-right img")!;
    expect([img.style.width, img.style.height, img.classList.contains("embed-exact")]).toEqual(["320px", "200px", true]);
    expect(root.querySelector(".file-align-center")).not.toBeNull();
    releaseReadingImages(root);
  });

  it("places a picture by its position in the reading view too, and the align is dropped", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const root = document.createElement("div");
    root.innerHTML = `<p><a class="wikilink" data-target="plik:${ID}#${E1}">320 poz25</a></p>`;
    embedReadingImages(root, fakeBridge([], store));
    await tick(10);
    const wrap = root.querySelector<HTMLElement>(".file-embed")!;
    expect([wrap.classList.contains("file-pos"), wrap.style.getPropertyValue("--pos"), wrap.className.includes("file-align")]).toEqual([true, "25", false]);
    expect(wrap.querySelector<HTMLImageElement>("img")!.style.width).toBe("320px");
    releaseReadingImages(root);
  });

  it("places a desktop image by its alias, in the editor and in the reading view", async () => {
    const doc = "![[assets/x.png|320x200 center]]\nkoniec";
    const view = makeView(doc, fakeBridge([]));
    await tick(5);
    const box = view.dom.querySelector<HTMLElement>(".file-image-box")!;
    expect(box.classList.contains("file-align-center")).toBe(true);
    expect([box.querySelector("img")!.style.width, box.querySelector("img")!.style.height]).toEqual(["320px", "200px"]);
    const root = document.createElement("div");
    root.innerHTML = '<p>!<a class="wikilink" data-target="assets/a.png">320 wrap-left</a></p>';
    embedReadingImages(root, fakeBridge([]));
    expect(root.querySelector<HTMLImageElement>(".file-image-box.file-align-wrap-left img")!.style.width).toBe("320px");
    releaseReadingImages(root);
  });
});

describe("previews from the embeds (PODGLAD-PLAN §7)", () => {
  const preview = vi.mocked(previewEmbeds);
  const labels = () => [...document.querySelectorAll(".menu-label")].map((el) => el.textContent);
  const dblclick = (el: Element) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

  beforeEach(() => preview.mockClear());

  it("a double click on an embed previews it, paging through the note's files in the order of the text", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    await store.upload(txt(), { id: ID2 });
    const doc = `${fileEmbed(ID2, null, E1)}\n${fileEmbed(ID, null, E2)}\n${fileEmbed(ID2, null, "cccccccc")}\nkoniec`;
    const view = makeView(doc, fakeBridge([], store), doc.length);
    await tick(10);
    dblclick(view.dom.querySelector(`.file-embed[data-id="${ID}"]`)!);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(store, [ID2, ID], ID);
  });

  it("a double click on the download button does not preview", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(txt(), { id: ID });
    const view = makeView(`${fileEmbed(ID, null, E1)}\nkoniec`, fakeBridge([], store));
    await tick(10);
    dblclick(view.dom.querySelector(".file-chip .file-download")!);
    expect(preview).not.toHaveBeenCalled();
  });

  it("a double click on a picture previews it and does not open it full size", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const view = makeView(`${fileEmbed(ID, null, E1)}\nkoniec`, fakeBridge([], store));
    await tick(10);
    const picture = view.dom.querySelector<HTMLElement>(".file-image")!;
    picture.click();
    picture.click();
    dblclick(picture);
    await tick(500);
    expect(preview).toHaveBeenCalledWith(store, [ID], ID);
    expect(document.querySelector(".file-full")).toBeNull();
  });

  it("a single click on a picture opens it full size once the double-click time has passed", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const view = makeView(`${fileEmbed(ID, null, E1)}\nkoniec`, fakeBridge([], store));
    await tick(10);
    view.dom.querySelector<HTMLElement>(".file-image")!.click();
    expect(document.querySelector(".file-full")).toBeNull();
    await tick(500);
    expect(document.querySelector(".file-full")).not.toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it("the menu of an embed has Podgląd, Otwórz and Pobierz, and the preview item previews it", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const view = makeView(`${fileEmbed(ID, null, E1)}\nkoniec`, fakeBridge([], store));
    await tick(10);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 });
    view.dom.querySelector(".file-embed")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(labels()).toEqual(["Podgląd", "Otwórz", "Pobierz"]);
    (document.querySelector(".menu-item") as HTMLElement).click();
    expect(preview).toHaveBeenCalledWith(store, [ID], ID);
  });

  it("the menu has only Podgląd when the file's info is not known (a missing file)", async () => {
    const store = new MemoryFileStore("u1");
    const view = makeView(`${fileEmbed(ID2, null, E1)}\nkoniec`, fakeBridge([], store));
    await tick(10);
    view.dom.querySelector(".file-embed")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(labels()).toEqual(["Podgląd"]);
  });

  it("the reading view: a double click previews the file, with the files of the page in document order, each once", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    await store.upload(txt(), { id: ID2 });
    const root = document.createElement("div");
    root.innerHTML = `<p><a class="wikilink" data-target="plik:${ID2}#${E1}"></a> <a class="wikilink" data-target="plik:${ID}#${E2}"></a> <a class="wikilink" data-target="plik:${ID2}#cccccccc"></a></p>`;
    embedReadingImages(root, fakeBridge([], store));
    await tick(10);
    dblclick(root.querySelector(`.file-embed[data-id="${ID}"]`)!);
    expect(preview).toHaveBeenCalledWith(store, [ID2, ID], ID);
    releaseReadingImages(root);
  });

  it("the reading view's menu of an embed has the same three items once the file is known", async () => {
    const store = new MemoryFileStore("u1");
    await store.upload(png(), { id: ID });
    const root = document.createElement("div");
    root.innerHTML = `<p><a class="wikilink" data-target="plik:${ID}#${E1}"></a></p>`;
    embedReadingImages(root, fakeBridge([], store));
    await tick(10);
    root.querySelector(".file-embed")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(labels()).toEqual(["Podgląd", "Otwórz", "Pobierz"]);
    releaseReadingImages(root);
  });
});

describe("embedAt: the embed under the cursor", () => {
  const one = fileEmbed(ID, null, E1);
  const two = fileEmbed(ID2, { width: 320 }, E2);
  const text = `ab ${one} cd ${two} ef`;
  const s1 = 3;
  const s2 = s1 + one.length + 4; // " cd " between the two

  it("is the file of the embed the position is in, the alias included", () => {
    expect(embedAt(text, s1 + 5)).toBe(ID);
    expect(embedAt(text, s2 + 3)).toBe(ID2);
  });

  it("counts the two borders of an embed as on it", () => {
    expect(embedAt(text, s1)).toBe(ID);
    expect(embedAt(text, s1 + one.length)).toBe(ID);
  });

  it("is null outside every embed, and in a text without embeds", () => {
    expect(embedAt(text, 0)).toBeNull();
    expect(embedAt(text, s1 + one.length + 1)).toBeNull();
    expect(embedAt(text, text.length)).toBeNull();
    expect(embedAt("", 0)).toBeNull();
    expect(embedAt("zwykły tekst", 3)).toBeNull();
  });
});
