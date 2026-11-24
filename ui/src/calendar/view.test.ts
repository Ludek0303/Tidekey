// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadWasm } from "../testwasm";
import type { NoteSession } from "../editor";
import { CalendarView } from "./view";

const CAL = "---\ntyp: kalendarz\n---\n\n";

function session(readOnly: boolean): NoteSession {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, CAL);
  return {
    id: "n1",
    path: "Moje notatki/Plan.md",
    doc,
    undo: new Y.UndoManager(doc.getText("content")),
    state: EditorState.create({ extensions: readOnly ? EditorState.readOnly.of(true) : [] }),
  } as unknown as NoteSession;
}

describe("calendar header: .ics buttons", () => {
  beforeAll(loadWasm);
  let view: CalendarView | null = null;
  afterEach(() => {
    view?.hide();
    view = null;
    document.body.replaceChildren();
  });

  const root = () => {
    const r = document.createElement("div");
    document.body.append(r);
    view = new CalendarView(r, () => undefined);
    return r;
  };
  const button = (r: HTMLElement, label: string) => [...r.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

  it("shows import and export for a note's calendar", () => {
    const r = root();
    view!.show(session(false));
    expect(button(r, "Importuj .ics").hidden).toBe(false);
    expect(button(r, "Eksportuj .ics").hidden).toBe(false);
  });

  it("hides import for a read-only note, but keeps export", () => {
    const r = root();
    view!.show(session(true));
    expect(button(r, "Importuj .ics").hidden).toBe(true);
    expect(button(r, "Eksportuj .ics").hidden).toBe(false);
  });

  it("hides both for a source calendar (not a note)", () => {
    const r = root();
    view!.showSource({ occurrences: () => [], details: () => undefined, create: () => undefined });
    expect(button(r, "Importuj .ics").hidden).toBe(true);
    expect(button(r, "Eksportuj .ics").hidden).toBe(true);
  });

  it("imports an .ics file as events of the note, in one write", async () => {
    const r = root();
    const note = session(false);
    view!.show(note);
    const ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261111", "SUMMARY:Pierwsze, dobre",
      "END:VEVENT", "BEGIN:VEVENT", "DTSTART:20261232T100000", "SUMMARY:Zły", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const input = r.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File([ics], "plan.ics", { type: "text/calendar" })] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(note.doc.getText("content").toString()).toContain("Pierwsze, dobre"));
    expect(note.doc.getText("content").toString()).not.toContain("Zły");
    expect(document.querySelector(".toasts")?.textContent).toContain("Zaimportowano 1 wydarzenie. Pominięto 1.");
  });
});
