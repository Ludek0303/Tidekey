// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures the scrolled-to selection through these.
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

// The fake engine records the listeners the controller installs, so a test fires events by hand.
const fake = vi.hoisted(() => ({
  listeners: {} as Record<string, (value: unknown) => void>,
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}));

// What the model store reports: `need` is the files still to download, `warn` the WebGPU warning.
const store = vi.hoisted(() => ({
  need: [] as { id: string; file: { name: string; size: number } }[],
  warn: undefined as "no-webgpu" | undefined,
}));

vi.mock("./modelstore", () => ({
  vadEntry: { id: "silero", file: { name: "silero.onnx", size: 2_000_000 } },
  asrEntries: () => [],
  pickVariant: async () => ({ variant: "cpu", warn: store.warn }),
  missing: async () => store.need,
}));

vi.mock("./voice", () => ({
  WorkerVoice: class {
    on(name: string, cb: (value: unknown) => void) {
      fake.listeners[name] = cb;
      return () => {};
    }
    start = fake.start;
    stop = fake.stop;
    dispose() {}
  },
}));

type Controller = typeof import("./controller");
let controller: Controller;

// The consent window opens after the file check, which is async: wait for it.
async function openedDialog(): Promise<HTMLElement> {
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

function editor(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

beforeEach(async () => {
  // Each test starts with a fresh controller, so the idle state and the listeners are reset.
  vi.resetModules();
  fake.start.mockClear();
  fake.stop.mockClear();
  fake.listeners = {};
  document.body.innerHTML = "";
  store.need = [];
  store.warn = undefined;
  controller = await import("./controller");
});

describe("toggleDictation", () => {
  it("inserts a final fragment into the view and shows the listening state on the button", async () => {
    const view = editor("");
    const undo = { stopCapturing: () => {} };
    const button = document.createElement("button");
    await controller.toggleDictation(() => ({ view, undo }), button);
    expect(fake.start).toHaveBeenCalledWith({ engine: "parakeet", variant: "cpu", download: false });

    fake.listeners.status("listening");
    expect(button.dataset.voice).toBe("listening");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fake.listeners.final("ala ma kota.");
    expect(view.state.doc.toString()).toBe("Ala ma kota.");
  });

  it("stops and inserts nothing when the note changed while speaking", async () => {
    const first = editor("");
    const second = editor("");
    const undoA = { stopCapturing: () => {} };
    let current: { view: EditorView; undo: { stopCapturing(): void } } = { view: first, undo: undoA };
    await controller.toggleDictation(() => current, null);

    fake.listeners.status("listening");
    current = { view: second, undo: { stopCapturing: () => {} } };
    fake.listeners.final("tekst.");

    expect(second.state.doc.toString()).toBe("");
    expect(first.state.doc.toString()).toBe("");
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the engine when pressed while it listens", async () => {
    const view = editor("");
    const target = () => ({ view, undo: null });
    await controller.toggleDictation(target, null);
    fake.listeners.status("listening");
    await controller.toggleDictation(target, null);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("starts without a window when the model is already stored", async () => {
    store.warn = "no-webgpu";
    await controller.toggleDictation(() => ({ view: editor(""), undo: null }), null);
    expect(fake.start).toHaveBeenCalledWith({ engine: "parakeet", variant: "cpu", download: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("asks for consent with the download size, and starts nothing on cancel", async () => {
    store.need = [{ id: "m", file: { name: "a.onnx", size: 1_219_000_000 } }];
    store.warn = "no-webgpu";
    void controller.toggleDictation(() => ({ view: editor(""), undo: null }), null);
    const dialog = await openedDialog();
    expect(dialog.textContent).toContain("Włączyć dyktowanie?");
    expect(dialog.textContent).toContain("1219 MB");
    expect(dialog.textContent).toContain("Ta przeglądarka nie ma WebGPU");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Anuluj")!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("starts the download after consent and shows its progress until loading", async () => {
    store.need = [{ id: "m", file: { name: "a.onnx", size: 1_000_000 } }];
    const button = document.createElement("button");
    void controller.toggleDictation(() => ({ view: editor(""), undo: null }), button);
    await openedDialog();
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Pobierz i włącz")!.click();
    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledWith({ engine: "parakeet", variant: "cpu", download: true }));

    fake.listeners.status("downloading");
    fake.listeners.progress({ loaded: 370_000, total: 1_000_000 });
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Pobieranie modelu mowy: 37% (0 z 1 MB)");
    expect(button.dataset.tip).toBe("Pobieranie modelu mowy… 37%");

    fake.listeners.status("loading");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("partial results", () => {
  // An editor that counts the transactions changing its document. The ghost comes from the same module instance
  // as the controller's (loaded after vi.resetModules), so its effects are recognised.
  async function counted(doc: string) {
    const { dictationGhost } = await import("./ghost");
    let changes = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [dictationGhost, EditorView.updateListener.of((u) => { if (u.docChanged) changes++; })],
      }),
    });
    return { view, changes: () => changes };
  }
  const ghostOf = (view: EditorView) => view.contentDOM.querySelector(".cm-dictation-ghost");

  it("shows a partial as a ghost, and the final removes it and inserts once", async () => {
    const { view, changes } = await counted("");
    await controller.toggleDictation(() => ({ view, undo: null }), null);
    fake.listeners.status("listening");

    fake.listeners.partial("ala ma");
    expect(ghostOf(view)?.textContent).toBe("Ala ma");
    expect(view.state.doc.toString()).toBe("");

    const before = changes();
    fake.listeners.final("ala ma kota.");
    expect(ghostOf(view)).toBeNull();
    expect(view.state.doc.toString()).toBe("Ala ma kota.");
    expect(changes() - before).toBe(1);
  });

  it("clears the ghost when dictation goes idle", async () => {
    const { view } = await counted("");
    await controller.toggleDictation(() => ({ view, undo: null }), null);
    fake.listeners.status("listening");
    fake.listeners.partial("ala");
    expect(ghostOf(view)).not.toBeNull();

    fake.listeners.status("idle");
    expect(ghostOf(view)).toBeNull();
    expect(view.state.doc.toString()).toBe("");
  });

  it("ignores a partial from a note changed while speaking", async () => {
    const first = await counted("");
    const second = await counted("");
    // The undo token identifies the note; a new token means another note.
    const tokenA = { stopCapturing() {} };
    let current = { view: first.view, undo: tokenA };
    await controller.toggleDictation(() => current, null);
    fake.listeners.status("listening");

    current = { view: second.view, undo: { stopCapturing() {} } };
    fake.listeners.partial("tekst");
    expect(ghostOf(second.view)).toBeNull();
    expect(ghostOf(first.view)).toBeNull();
  });
});
