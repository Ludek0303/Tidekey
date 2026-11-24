// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import * as Y from "yjs";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { MockBridge, type Bridge } from "./bridge";
import { EditorHost, Saver, countWriting, openSession, type NoteSession, type SaveStatus } from "./editor";
import { setSetting } from "./settings";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

function type(host: EditorHost, text: string): void {
  const at = host.view.state.doc.length;
  host.view.dispatch({ changes: { from: at, insert: text } });
}

function recording(bridge: Bridge) {
  const updates: Uint8Array[] = [];
  const wrapped: Bridge = {
    call: (cmd, args) => {
      if (cmd === "apply_update") updates.push((args as { update: Uint8Array }).update);
      return bridge.call(cmd, args);
    },
    on: (event, cb) => bridge.on(event, cb),
  };
  return { wrapped, updates };
}

async function readNote(bridge: Bridge, id: string): Promise<string> {
  const state = await bridge.call<Uint8Array>("open_note", { id });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText("content").toString();
}

describe("editor to core", () => {
  it("sends each typed change as apply_update and a fresh Y.Doc replays the text", async () => {
    const bridge = new MockBridge([]);
    const id = await bridge.call<string>("create_note", { path: "Nowa.md" });
    const { wrapped, updates } = recording(bridge);
    const host = new EditorHost(mount());
    const session = await openSession(wrapped, new Saver(wrapped, () => {}), id, "Nowa.md", () => {});
    host.show(session, null);

    type(host, "Zażółć ");
    type(host, "gęślą jaźń");
    await flush();

    expect(updates.length).toBeGreaterThanOrEqual(2);
    const replay = new Y.Doc();
    for (const u of updates) Y.applyUpdate(replay, u);
    expect(replay.getText("content").toString()).toBe("Zażółć gęślą jaźń");
    expect(await readNote(bridge, id)).toBe("Zażółć gęślą jaźń");
  });

  it("keeps keystrokes of each note across tab switches", async () => {
    const bridge = new MockBridge([]);
    const a = await bridge.call<string>("create_note", { path: "A.md" });
    const b = await bridge.call<string>("create_note", { path: "B.md" });
    const saver = new Saver(bridge, () => {});
    const host = new EditorHost(mount());
    const sa: NoteSession = await openSession(bridge, saver, a, "A.md", () => {});
    const sb: NoteSession = await openSession(bridge, saver, b, "B.md", () => {});

    host.show(sa, null);
    type(host, "alfa");
    host.show(sb, sa);
    type(host, "beta");
    host.show(sa, sb);
    type(host, " dalej");
    host.show(sb, sa);
    type(host, " znowu");
    await flush();

    expect(host.view.state.doc.toString()).toBe("beta znowu");
    expect(sa.doc.getText("content").toString()).toBe("alfa dalej");
    expect(sb.doc.getText("content").toString()).toBe("beta znowu");
    expect(await readNote(bridge, a)).toBe("alfa dalej");
    expect(await readNote(bridge, b)).toBe("beta znowu");
  });
});

describe("Saver", () => {
  const ok: Bridge = { call: () => Promise.resolve(undefined as never), on: () => () => {} };

  it("reports saving, then saved, when apply_update resolves", async () => {
    const seen: SaveStatus[] = [];
    new Saver(ok, (s) => seen.push(s)).send("note-1", new Uint8Array([0]));
    await flush();
    expect(seen).toEqual(["saving", "saved"]);
  });

  it("reports error when apply_update rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: Bridge = { call: () => Promise.reject(new Error("disk full")), on: () => () => {} };
    const seen: SaveStatus[] = [];
    new Saver(failing, (s) => seen.push(s)).send("note-1", new Uint8Array([0]));
    await flush();
    expect(seen).toEqual(["saving", "error"]);
  });

  it("does not report saved after a failed save, even if a later save succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const flaky: Bridge = {
      call: () => (calls++ === 0 ? Promise.reject(new Error("disk full")) : Promise.resolve(undefined as never)),
      on: () => () => {},
    };
    const seen: SaveStatus[] = [];
    const saver = new Saver(flaky, (s) => seen.push(s));
    saver.send("note-1", new Uint8Array([1]));
    saver.send("note-1", new Uint8Array([2]));
    await flush();
    expect(seen.at(-1)).toBe("error");
  });

  it("resends a failed update merged with the next one, so the core matches the editor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bridge = new MockBridge([]);
    const id = await bridge.call<string>("create_note", { path: "R.md" });
    let calls = 0;
    const flaky: Bridge = {
      call: (cmd, args) =>
        cmd === "apply_update" && calls++ === 0 ? Promise.reject(new Error("disk full")) : bridge.call(cmd, args),
      on: (event, cb) => bridge.on(event, cb),
    };
    const seen: SaveStatus[] = [];
    const saver = new Saver(flaky, (s) => seen.push(s));
    const host = new EditorHost(mount());
    const session = await openSession(flaky, saver, id, "R.md", () => {});
    host.show(session, null);

    type(host, "abc");
    await flush();
    expect(seen.at(-1)).toBe("error");
    expect(saver.hasUnsaved).toBe(true);

    type(host, "def");
    await flush();
    expect(saver.hasUnsaved).toBe(false);
    expect(seen.at(-1)).toBe("saved");
    expect(await readNote(bridge, id)).toBe("abcdef");
  });
});

describe("Saver.flushAll", () => {
  it("resolves true once every pending update reached the backend", async () => {
    const saver = new Saver({ call: () => new Promise((r) => setTimeout(() => r(undefined as never), 5)), on: () => () => {} }, () => {});
    saver.send("note-1", new Uint8Array([1]));
    expect(await saver.flushAll()).toBe(true);
    expect(saver.hasUnsaved).toBe(false);
  });

  it("resolves false when a retry still fails, so the caller can keep the note open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: Bridge = { call: () => Promise.reject(new Error("disk full")), on: () => () => {} };
    const saver = new Saver(failing, () => {});
    saver.send("note-1", new Uint8Array([1]));
    expect(await saver.flushAll()).toBe(false);
    expect(saver.hasUnsaved).toBe(true);
  });
});

describe("undo", () => {
  it("undo removes only local edits, never a remote change", async () => {
    const bridge = new MockBridge([]);
    const id = await bridge.call<string>("create_note", { path: "U.md" });
    const saver = new Saver(bridge, () => {});
    const host = new EditorHost(mount());
    const session = await openSession(bridge, saver, id, "U.md", () => {});
    host.show(session, null);

    type(host, "local");
    const state = await bridge.call<Uint8Array>("open_note", { id });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, state);
    const before = Y.encodeStateVector(remote);
    remote.getText("content").insert(0, "R");
    Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(remote, before));
    expect(host.view.state.doc.toString()).toBe("Rlocal");

    yUndoManagerKeymap[0].run!(host.view);
    await flush();
    expect(host.view.state.doc.toString()).toBe("R");
    expect(session.doc.getText("content").toString()).toBe("R");
  });
});

describe("word counter and writing settings", () => {
  afterEach(() => {
    setSetting("spellcheck", true);
    setSetting("writingLanguage", "pl");
  });

  it("counts the whole note without a selection, and only the selected text with one", () => {
    const doc = "alfa beta\ngamma";
    expect(countWriting(EditorState.create({ doc }))).toEqual({ words: 3, chars: 15, selected: false });
    expect(countWriting(EditorState.create({ doc, selection: EditorSelection.cursor(3) }))).toEqual({ words: 3, chars: 15, selected: false });
    expect(countWriting(EditorState.create({ doc, selection: EditorSelection.single(0, 9) }))).toEqual({ words: 2, chars: 9, selected: true });
  });

  it("sums the counts over several selection ranges", () => {
    const doc = "alfa beta\ngamma";
    const selection = EditorSelection.create([EditorSelection.range(0, 4), EditorSelection.range(10, 15)]);
    const extensions = EditorState.allowMultipleSelections.of(true);
    expect(countWriting(EditorState.create({ doc, selection, extensions }))).toEqual({ words: 2, chars: 9, selected: true });
  });

  it("sets the spellcheck attributes on the editor and follows the settings live", async () => {
    const bridge = new MockBridge([]);
    const id = await bridge.call<string>("create_note", { path: "Pisownia.md" });
    const host = new EditorHost(mount());
    const session = await openSession(bridge, new Saver(bridge, () => {}), id, "Pisownia.md", () => {});
    host.show(session, null);

    const dom = host.view.contentDOM;
    expect(dom.getAttribute("spellcheck")).toBe("true");
    expect(dom.getAttribute("autocorrect")).toBe("on");
    expect(dom.getAttribute("autocapitalize")).toBe("sentences");
    expect(dom.getAttribute("lang")).toBe("pl");

    setSetting("writingLanguage", "de");
    setSetting("spellcheck", false);
    expect(dom.getAttribute("spellcheck")).toBe("false");
    expect(dom.getAttribute("autocorrect")).toBe("off");
    expect(dom.getAttribute("autocapitalize")).toBe("off");
    expect(dom.getAttribute("lang")).toBe("de");
  });
});
