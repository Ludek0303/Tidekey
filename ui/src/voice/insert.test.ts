import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { insertDictation, joinFragment } from "./insert";

beforeAll(() => {
  // jsdom has no layout; CodeMirror measures the scrolled-to selection through these.
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

describe("joinFragment", () => {
  it("starts a sentence with a capital at the start of a line", () => {
    expect(joinFragment("", "", "ala ma kota.")).toBe("Ala ma kota.");
  });

  it("starts a sentence after a list, task, quote or heading marker", () => {
    expect(joinFragment("- ", "", "kupić mleko")).toBe("Kupić mleko");
    expect(joinFragment("- [ ] ", "", "kupić mleko")).toBe("Kupić mleko");
    expect(joinFragment("> ", "", "cytat")).toBe("Cytat");
    expect(joinFragment("## ", "", "plan")).toBe("Plan");
    expect(joinFragment("3. ", "", "punkt")).toBe("Punkt");
  });

  it("adds a space and a capital after the end of a sentence", () => {
    expect(joinFragment("Koniec.", "", "nowe zdanie.")).toBe(" Nowe zdanie.");
    expect(joinFragment("Czy tak?", "", "tak.")).toBe(" Tak.");
    expect(joinFragment("Koniec. ", "", "nowe zdanie.")).toBe("Nowe zdanie.");
  });

  it("continues a sentence in lower case after a word or a comma", () => {
    expect(joinFragment("Spotkanie jest", "", "W poniedziałek.")).toBe(" w poniedziałek.");
    expect(joinFragment("Kupić mleko,", "", "Chleb i masło.")).toBe(" chleb i masło.");
  });

  it("keeps an acronym in capitals mid-sentence", () => {
    expect(joinFragment("Raport dla", "", "NATO.")).toBe(" NATO.");
  });

  it("adds no space before punctuation and none after an opening bracket or quote", () => {
    expect(joinFragment("Tak", "", ", oczywiście.")).toBe(", oczywiście.");
    expect(joinFragment("Uwaga (", "", "ważne")).toBe("ważne");
    expect(joinFragment("Napisał „", "", "Dzień dobry")).toBe("Dzień dobry");
  });

  it("adds a space after the fragment when a word follows the caret", () => {
    expect(joinFragment("", "reszta", "Początek")).toBe("Początek ");
    expect(joinFragment("", " reszta", "Początek")).toBe("Początek");
    expect(joinFragment("", ".", "Początek")).toBe("Początek");
  });

  it("trims what the engine returns and gives nothing for silence", () => {
    expect(joinFragment("", "", "  ala  ")).toBe("Ala");
    expect(joinFragment("Tekst", "", "   ")).toBe("");
  });
});

function editor(doc: string, cursor = doc.length, head = cursor): EditorView {
  return new EditorView({ state: EditorState.create({ doc, selection: { anchor: cursor, head } }) });
}

describe("insertDictation", () => {
  it("inserts at the caret and leaves the caret after the fragment", () => {
    const view = editor("Pierwsze zdanie.");
    expect(insertDictation(view, "drugie zdanie.")).toBe(true);
    expect(view.state.doc.toString()).toBe("Pierwsze zdanie. Drugie zdanie.");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("replaces a selection", () => {
    const view = editor("Ala ma psa.", 7, 10);
    insertDictation(view, "kota");
    expect(view.state.doc.toString()).toBe("Ala ma kota.");
  });

  it("leaves the caret before the added trailing space, so the next fragment joins cleanly", () => {
    const view = editor("reszta", 0);
    insertDictation(view, "Raz");
    insertDictation(view, "dwa.");
    expect(view.state.doc.toString()).toBe("Raz dwa. reszta");
  });

  it("closes the undo step before and after, so one undo removes one fragment", () => {
    const view = editor("");
    const calls: string[] = [];
    insertDictation(view, "tekst", { stopCapturing: () => calls.push("stop") });
    expect(calls).toEqual(["stop", "stop"]);
  });

  it("does nothing for an empty fragment", () => {
    const view = editor("Tekst");
    expect(insertDictation(view, "  ")).toBe(false);
    expect(view.state.doc.toString()).toBe("Tekst");
  });

  it("tags the transaction with the input.dictation user event", () => {
    const seen: boolean[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "" }),
      dispatchTransactions: (trs, v) => {
        for (const tr of trs) seen.push(tr.isUserEvent("input.dictation"));
        v.update(trs);
      },
    });
    insertDictation(view, "tekst");
    expect(seen).toEqual([true]);
  });
});
