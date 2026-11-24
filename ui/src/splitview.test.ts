// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MockBridge } from "./bridge";
import { EditorHost, Saver, focusedPane, openSession, setShown, type NoteSession } from "./editor";
import type { Layout } from "./layout";
import { SplitView } from "./splitview";
import { wrap } from "./toolbar";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The parts of the layout the split uses: the editor area, the split section inside it, its editor and title.
function splitLayout(): Layout {
  const editor = document.createElement("div");
  const split = document.createElement("section");
  split.hidden = true;
  const splitTitle = document.createElement("span");
  const splitEditor = document.createElement("div");
  split.append(splitTitle, splitEditor);
  editor.append(split);
  document.body.append(editor);
  return { editor, split, splitTitle, splitEditor } as unknown as Layout;
}

function type(view: { state: { doc: { length: number } }; dispatch: (tr: object) => void }, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

async function noteSession(bridge: MockBridge, saver: Saver, path: string, text: string): Promise<NoteSession> {
  const id = await bridge.call<string>("create_note", { path });
  const session = await openSession(bridge, saver, id, path, () => {});
  // The text goes in through a tab, as a user's typing does, so the Y.Doc and the backend both have it.
  const host = new EditorHost(document.body.appendChild(document.createElement("div")));
  host.show(session, null);
  type(host.view, text);
  await flush();
  return session;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("split view", () => {
  it("opens a note beside the tab and shows its text", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "Lewa treść");
    const right = await noteSession(bridge, saver, "Prawa.md", "Prawa treść");
    const leftHost = new EditorHost(document.body.appendChild(document.createElement("div")));
    leftHost.show(left, null);

    const layout = splitLayout();
    const split = new SplitView(layout);
    expect(split.open(right, left)).toBe(true);

    expect(split.session).toBe(right);
    expect(split.view.state.doc.toString()).toBe("Prawa treść");
    expect(layout.split.hidden).toBe(false);
    expect(layout.splitTitle.textContent).toBe("Prawa");
    expect(layout.editor.classList.contains("split-open")).toBe(true);
  });

  it("sends typing in the split to the note's Y.Doc and the backend", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "");
    const right = await noteSession(bridge, saver, "Prawa.md", "start");
    const split = new SplitView(splitLayout());
    split.open(right, left);

    type(split.view, " koniec");
    await flush();

    expect(right.doc.getText("content").toString()).toBe("start koniec");
    const stored = new Y.Doc();
    Y.applyUpdate(stored, await bridge.call<Uint8Array>("open_note", { id: right.id }));
    expect(stored.getText("content").toString()).toBe("start koniec");
  });

  it("close keeps the typed state on the session and hides the pane", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "");
    const right = await noteSession(bridge, saver, "Prawa.md", "bazowa");
    const layout = splitLayout();
    const split = new SplitView(layout);
    split.open(right, left);
    type(split.view, " dopisane");

    split.close();

    expect(split.session).toBeNull();
    expect(right.state.doc.toString()).toBe("bazowa dopisane");
    expect(layout.split.hidden).toBe(true);
    expect(layout.editor.classList.contains("split-open")).toBe(false);
    // Reopening the note shows what was typed.
    split.open(right, left);
    expect(split.view.state.doc.toString()).toBe("bazowa dopisane");
  });

  it("refuses the note the tab on the left shows, and changes nothing", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "lewa");
    const split = new SplitView(splitLayout());

    expect(split.open(left, left)).toBe(false);
    expect(split.session).toBeNull();
  });

  it("opening the note already in the split keeps its state", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "");
    const right = await noteSession(bridge, saver, "Prawa.md", "x");
    const split = new SplitView(splitLayout());
    split.open(right, left);
    type(split.view, "y");

    expect(split.open(right, left)).toBe(true);
    expect(split.view.state.doc.toString()).toBe("xy");
  });

  it("the focused pane decides what the commands act on", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "lewa tekst");
    const right = await noteSession(bridge, saver, "Prawa.md", "prawa tekst");
    const leftHost = new EditorHost(document.body.appendChild(document.createElement("div")));
    leftHost.show(left, null);
    const split = new SplitView(splitLayout());
    split.open(right, left);

    // The tab was shown last, so it is the focused pane until the split gets the focus.
    expect(focusedPane()?.view).toBe(leftHost.view);
    split.view.dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(focusedPane()?.view).toBe(split.view);
    expect(focusedPane()?.session).toBe(right);

    // A formatting action applies to the focused pane only.
    split.view.dispatch({ selection: { anchor: 0, head: 5 } });
    wrap(focusedPane()!.view, "**");
    expect(split.view.state.doc.toString()).toBe("**prawa** tekst");
    expect(leftHost.view.state.doc.toString()).toBe("lewa tekst");

    // Closing the split hands the focus back to the tab.
    split.close();
    expect(focusedPane()).toBeNull();
    setShown(leftHost.view, left);
    expect(focusedPane()?.session).toBe(left);
  });

  it("forget closes the split for a deleted note only", async () => {
    const bridge = new MockBridge([]);
    const saver = new Saver(bridge, () => {});
    const left = await noteSession(bridge, saver, "Lewa.md", "");
    const right = await noteSession(bridge, saver, "Prawa.md", "");
    const split = new SplitView(splitLayout());
    split.open(right, left);

    split.forget("nie-ta-notatka");
    expect(split.session).toBe(right);
    split.forget(right.id);
    expect(split.session).toBeNull();
  });
});
