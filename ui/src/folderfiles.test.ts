// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { freeName, placeOfFile, setFilePlaces } from "./folderfiles";

describe("freeName", () => {
  it("keeps a free path and adds ' (n)' before the extension when it is taken", () => {
    expect(freeName("P/umowa.pdf", new Set())).toBe("P/umowa.pdf");
    expect(freeName("P/umowa.pdf", new Set(["p/umowa.pdf"]))).toBe("P/umowa (2).pdf");
    expect(freeName("P/umowa.pdf", new Set(["p/umowa.pdf", "p/umowa (2).pdf"]))).toBe("P/umowa (3).pdf");
  });

  it("a name without an extension, or a dot-file, gets the number at the end", () => {
    expect(freeName("P/Notatki", new Set(["p/notatki"]))).toBe("P/Notatki (2)");
    expect(freeName("P/.env", new Set(["p/.env"]))).toBe("P/.env (2)");
  });
});

describe("placeOfFile", () => {
  it("names the folder of a listed file, and nothing for a file in no folder", () => {
    setFilePlaces([{ fileId: "a", path: "Projekty/Plan/umowa.pdf" }, { fileId: "b", path: "obraz.png" }]);
    expect(placeOfFile("a")).toBe("Projekty/Plan");
    expect(placeOfFile("b")).toBeNull();
    expect(placeOfFile("c")).toBeNull();
  });
});
