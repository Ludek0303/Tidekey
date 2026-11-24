// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorHost, Saver, openSession, setSourceMode } from "./editor";
import { MockBridge } from "./bridge";
import { setTaskSpace } from "./taskchips";
import { loadWasm } from "./testwasm";

beforeAll(async () => {
  await loadWasm();
});

afterEach(() => {
  setSourceMode(false);
  setTaskSpace("off");
  document.body.replaceChildren();
});

describe("Source mode shows the raw text", () => {
  it("has no chips and no properties block, and Live Preview brings them back", async () => {
    setTaskSpace("organization");
    const bridge = new MockBridge();
    const { notes } = await bridge.call<{ notes: { id: string; path: string }[] }>("list_tree");
    const triton = notes.find((n) => n.path === "Projekty/Sonda/Sonda.md")!;
    const parent = document.createElement("div");
    document.body.append(parent);
    const host = new EditorHost(parent);
    const session = await openSession(bridge, new Saver(bridge, () => {}), triton.id, triton.path, () => {});
    // the note opens with its cursor below the front matter and its title
    const text = session.state.doc.toString();
    expect(session.state.selection.main.head).toBe(text.indexOf("\n", text.indexOf("# Sonda")) + 1);
    // the cursor goes to the end, away from the front matter and the tasks' cursor line
    session.state = session.state.update({ selection: { anchor: session.state.doc.length } }).state;

    setSourceMode(true);
    host.show(session, null);
    expect(parent.querySelectorAll(".task-chip")).toHaveLength(0);
    expect(parent.querySelectorAll(".cm-props")).toHaveLength(0);
    expect(parent.textContent).toContain("---");

    setSourceMode(false);
    host.show(session, null);
    expect(parent.querySelectorAll(".task-chip").length).toBeGreaterThan(0);
    expect(parent.querySelectorAll(".cm-props")).toHaveLength(1);
  });
});
