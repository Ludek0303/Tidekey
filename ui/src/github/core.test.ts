import * as Y from "yjs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWasm } from "../testwasm";
import {
  applyTextEdits,
  blobSha1,
  guardedLines,
  isMarkdownPath,
  merge3,
  normalizeRepoPath,
  parseRepoUrl,
  planUpdate,
  replaceText,
  stripMarkers,
  textEdits,
} from "./core";

beforeAll(async () => {
  await loadWasm();
});

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

describe("GitHub core wrappers", () => {
  it("reads repository addresses", () => {
    expect(parseRepoUrl("https://github.com/acme/notes/tree/main/docs")).toEqual({
      owner: "acme",
      repo: "notes",
      gitRef: "main",
      path: "docs",
    });
    expect(parseRepoUrl("acme/notes")?.gitRef).toBeNull();
    expect(parseRepoUrl("https://gitlab.com/acme/notes")).toBeNull();
    expect(parseRepoUrl("../../etc")).toBeNull();
  });

  it("hashes blobs the way git does", () => {
    expect(blobSha1(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("keeps paths inside the target folder", () => {
    expect(normalizeRepoPath("docs/Zażółć.md", "docs")).toBe("Zażółć.md");
    expect(normalizeRepoPath("docs/../x.md", "docs")).toBeNull();
    expect(normalizeRepoPath("other/a.md", "docs")).toBeNull();
    expect(isMarkdownPath("README")).toBe(true);
    expect(isMarkdownPath("notatki/Ż.MD")).toBe(true);
    expect(isMarkdownPath("obraz.png")).toBe(false);
  });

  it("merges clean texts and reports conflicts", () => {
    expect(merge3("x\n", "y\n", "x\n")).toEqual({ clean: "y\n" });
    expect(merge3("x\n", "a\n", "b\n")).toEqual({ conflict: true });
  });

  it("strips permission markers and counts them", () => {
    expect(stripMarkers("---\ntytul: X\nosoby:\n  - Anna\n---\n!zaznacza:x\ntekst\n")).toEqual({
      text: "---\ntytul: X\n---\ntekst\n",
      removed: 3,
    });
  });

  it("hashes task and mention lines only", () => {
    const lines = guardedLines("- [ ] zadanie @Anna\nzwykły\n- [x] ok");
    expect(lines).toHaveLength(2);
    expect(lines.every((h) => h.length === 8)).toBe(true);
  });

  it("plans moves, trashes and skips", () => {
    const plan = planUpdate(
      [
        { noteId: "n1", path: "a.md", blobSha: "X", hasEdits: false },
        { noteId: "n2", path: "gone.md", blobSha: "Y", hasEdits: false },
      ],
      [
        { path: "b.md", blobSha: "X", size: 5 },
        { path: "big.md", blobSha: "Z", size: 2_000_000 },
        { path: "i.md", blobSha: "Q", size: 1 },
      ],
      ["i.md"],
      true,
    );
    expect(plan).toEqual({
      ok: true,
      actions: [
        { kind: "move", noteId: "n1", from: "a.md", to: "b.md", blobSha: "X" },
        { kind: "trash", noteId: "n2" },
        { kind: "skip", path: "big.md", reason: "tooLarge" },
        { kind: "skip", path: "i.md", reason: "ignored" },
      ],
    });
  });

  it("computes edits in UTF-16 units", () => {
    expect(textEdits("Żółw 🐢 x", "Żółw 🐢 y")).toEqual([{ at: 8, delete: 1, insert: "y" }]);
    expect(textEdits("same", "same")).toEqual([]);
  });

  it("applies edits in one transaction", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "abcdef");
    let transactions = 0;
    doc.on("afterTransaction", () => {
      transactions++;
    });
    doc.transact(() => applyTextEdits(text, [
      { at: 1, delete: 2, insert: "XY" },
      { at: 4, delete: 0, insert: "!" },
    ]));
    expect(text.toString()).toBe("aXYd!ef");
    expect(transactions).toBe(1);
  });

  it("replaces the text with one transaction and origin github", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "Zażółć gęślą\nlinia\n");
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    replaceText(doc, "Zażółć GĘŚLĄ\nlinia\n");
    expect(doc.getText("content").toString()).toBe("Zażółć GĘŚLĄ\nlinia\n");
    expect(origins).toEqual(["github"]);
  });

  it("keeps another client's cursor where its text is after a change elsewhere", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("content").insert(0, "Zażółć\nDrugi wiersz ąę\n");
    sync(a, b);
    // the other writer's cursor is at the start of "Drugi"
    const cursor = Y.createRelativePositionFromTypeIndex(b.getText("content"), 7);

    replaceText(a, "Zażółć!!\nDrugi wiersz ąę\n");
    sync(a, b);

    expect(b.getText("content").toString()).toBe("Zażółć!!\nDrugi wiersz ąę\n");
    const abs = Y.createAbsolutePositionFromRelativePosition(cursor, b);
    expect(abs).not.toBeNull();
    expect(b.getText("content").toString().slice(abs?.index)).toMatch(/^Drugi wiersz/);
  });
});
