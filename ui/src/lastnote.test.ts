// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { rememberNote, rememberedNote } from "./lastnote";

const notes = [
  { id: "n1", path: "Alfa.md" },
  { id: "n2", path: "Beta/Gamma.md" },
];

afterEach(() => localStorage.clear());

describe("remembered note", () => {
  it("returns the note remembered for the space", () => {
    rememberNote("u1:browser-u1", notes[1]);
    expect(rememberedNote("u1:browser-u1", notes)).toEqual(notes[1]);
  });

  it("keeps spaces apart", () => {
    rememberNote("space-a", notes[0]);
    expect(rememberedNote("space-b", notes)).toBeNull();
  });

  it("falls back to the path when the id is gone", () => {
    rememberNote("space-a", { id: "old", path: "Beta/Gamma.md" });
    expect(rememberedNote("space-a", notes)).toEqual(notes[1]);
  });

  it("returns null when the note is gone or the stored value is broken", () => {
    rememberNote("space-a", { id: "old", path: "Gone.md" });
    expect(rememberedNote("space-a", notes)).toBeNull();
    localStorage.setItem("notes.lastNote.v1.space-a", "{not json");
    expect(rememberedNote("space-a", notes)).toBeNull();
  });
});
