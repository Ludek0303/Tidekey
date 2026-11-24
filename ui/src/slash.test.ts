// @vitest-environment jsdom
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { attachmentHandlers } from "./attachments";
import type { Bridge } from "./bridge";
import { MemoryFileStore } from "./filestore";
import { SLASH_ITEMS, slashSource } from "./slash";

const at = (doc: string) => slashSource(new CompletionContext(EditorState.create({ doc }), doc.length, false));
const view = (doc: string) => new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.length } }), parent: document.body });
const pick = (v: EditorView, label: string) => {
  const result = at(v.state.doc.toString())!;
  const option = result.options.find((o) => o.label === label)!;
  (option.apply as (view: EditorView, c: unknown, from: number, to: number) => void)(v, option, result.from, result.to ?? v.state.doc.length);
  return v.state.doc.toString();
};

describe("the / menu", () => {
  it("opens at a line start or after a space, filters by what follows, and not inside a word or a path", () => {
    expect(at("/")!.options.length).toBe(SLASH_ITEMS.length);
    expect(at("tekst /tab")!.options.map((o) => o.label)).toEqual(["Tabela"]);
    expect(at("/zad")!.options.map((o) => o.label)).toEqual(["Zadanie"]);
    expect(at("a/b")).toBeNull();
    expect(at("/xyz")).toBeNull();
  });

  it("writes the same Markdown as the toolbar, and never replaces text already on the line", () => {
    expect(pick(view("/"), "Nagłówek 2")).toBe("## ");
    expect(pick(view("Notatka /"), "Nagłówek 1")).toBe("Notatka \n# ");
    expect(pick(view("/"), "Zadanie")).toBe("- [ ] Nowe zadanie");
    expect(pick(view("/"), "Tabela")).toContain("| --- |");
  });
});

describe("the diagram item", () => {
  it("is found by its name and by its keywords", () => {
    expect(at("/schemat")!.options.map((o) => o.label)).toEqual(["Schemat"]);
    expect(at("/strzałka")!.options.map((o) => o.label)).toEqual(["Schemat"]);
  });
});

describe("the file command", () => {
  it("is found by typing its name, with the space", () => {
    expect(at("/dodaj plik")!.options.map((o) => o.label)).toEqual(["Dodaj plik"]);
    expect(at("/plik")!.options.map((o) => o.label)).toEqual(["Dodaj plik", "Folder z plikami"]);
    expect(at("/zdjecie")!.options.map((o) => o.label)).toEqual(["Dodaj plik"]);
  });

  it("removes its typed text and opens the picker where that text was", async () => {
    const store = new MemoryFileStore("u1");
    const bridge = { call: vi.fn(), on: () => () => {}, files: store } as unknown as Bridge;
    const v = new EditorView({
      state: EditorState.create({ doc: "A /dodaj plik", selection: { anchor: 13 }, extensions: [attachmentHandlers(bridge, () => {})] }),
      parent: document.body,
    });
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    expect(pick(v, "Dodaj plik")).toBe("A ");
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    v.dispatch({ changes: { from: 0, insert: "XY" } }); // typed before the place while the picker is open
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "a.txt", { type: "text/plain" })], configurable: true });
    input.onchange?.(new Event("change"));
    await new Promise((r) => setTimeout(r, 10));
    expect(v.state.doc.toString()).toMatch(/^XYA !\[\[plik:[0-9a-f]{32}#[0-9a-f]{8}\]\]$/);
    v.destroy();
  });
});
