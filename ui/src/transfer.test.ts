// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { MockBridge, type TreeListing } from "./bridge";
import { setSetting } from "./settings";
import { buildExport, collectDropped, crc32, exportNotes, importMarkdown, zipParts, type ImportFile } from "./transfer";

afterEach(() => { document.body.innerHTML = ""; });

const ID = "a".repeat(32);
const MISSING = "b".repeat(32);

// Reads back a stored (method 0) ZIP: the central directory is found from the end record.
function unzip(parts: Uint8Array[]): Map<string, { data: Uint8Array; flags: number; crc: number }> {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const out = new Map<string, { data: Uint8Array; flags: number; crc: number }>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const local = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    expect(method).toBe(0);
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    const data = bytes.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, { data, flags, crc });
    pos += 46 + nameLength;
  }
  return out;
}

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("zip", () => {
  it("has the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips names (UTF-8, flag bit 11) and bytes", () => {
    const entries = [
      { name: "Notatka.md", data: new TextEncoder().encode("# Zażółć\n") },
      { name: "Folder/Źródło.md", data: new Uint8Array([0, 1, 2, 255]) },
      { name: "pliki/empty", data: new Uint8Array(0) },
    ];
    const zip = unzip(zipParts(entries));
    expect([...zip.keys()]).toEqual(["Notatka.md", "Folder/Źródło.md", "pliki/empty"]);
    expect(text(zip.get("Notatka.md")!.data)).toBe("# Zażółć\n");
    expect([...zip.get("Folder/Źródło.md")!.data]).toEqual([0, 1, 2, 255]);
    expect(zip.get("pliki/empty")!.data.length).toBe(0);
    for (const entry of zip.values()) expect(entry.flags & 0x0800).toBe(0x0800);
  });
});

describe("export", () => {
  it("rewrites server embeds to pliki/ and includes the file bytes once", async () => {
    const bridge = new MockBridge([
      { path: "Plan.md", text: `# Plan\n\n![[plik:${ID}#12345678|Wykres]]\n\n![[plik:${ID}]]\n` },
      { path: "Projekty/Brak.md", text: `![[plik:${MISSING}#1234abcd]]\n` },
    ]);
    await bridge.files.upload(new File(["PDF-BYTES"], "Raport.pdf", { type: "application/pdf" }), { id: ID });
    await bridge.call("save_attachment", { name: "szkic.txt", bytes: new TextEncoder().encode("desktop") });

    const { entries, notes, files, missing } = await buildExport(bridge);
    const zip = unzip(zipParts(entries));

    expect(notes).toBe(2);
    expect(files).toBe(1);
    expect(missing.length).toBe(1);
    expect(text(zip.get("Plan.md")!.data)).toBe("# Plan\n\n![[pliki/Raport.pdf|Wykres]]\n\n![[pliki/Raport.pdf]]\n");
    expect(text(zip.get("pliki/Raport.pdf")!.data)).toBe("PDF-BYTES");
    expect(zip.has("pliki/Raport.pdf (2)")).toBe(false);
    expect(text(zip.get("Projekty/Brak.md")!.data)).toBe(`![[plik:${MISSING}#1234abcd]]\n`);
    expect(text(zip.get("BRAKUJACE-PLIKI.txt")!.data)).toContain(MISSING);
  });

  it("keeps desktop attachments under assets/ and their embeds unchanged", async () => {
    const bridge = new MockBridge([{ path: "N.md", text: "![[assets/szkic.txt|opis]]\n" }]);
    await bridge.call("save_attachment", { name: "szkic.txt", bytes: new TextEncoder().encode("desktop") });
    const zip = unzip(zipParts((await buildExport(bridge)).entries));
    expect(text(zip.get("N.md")!.data)).toBe("![[assets/szkic.txt|opis]]\n");
    expect(text(zip.get("assets/szkic.txt")!.data)).toBe("desktop");
  });
});

describe("import", () => {
  const md = (name: string, body: string, dir = ""): ImportFile => ({ file: new File([body], name, { type: "text/markdown" }), dir });
  const noteText = async (bridge: MockBridge, path: string) => {
    const { notes } = await bridge.call<TreeListing>("list_tree");
    const note = notes.find((n) => n.path === path)!;
    return bridge.call<string>("note_text", { id: note.id });
  };

  it("creates notes, strips the BOM, normalises CRLF and de-duplicates names", async () => {
    const bridge = new MockBridge([{ path: "A.md", text: "stara\n" }]);
    const count = await importMarkdown(bridge, [md("A.md", "﻿# Nowa\r\nlinia\r\n"), md("B.md", "")]);
    expect(count).toBe(2);
    expect(await noteText(bridge, "A (2).md")).toBe("# Nowa\nlinia\n");
    expect(await noteText(bridge, "B.md")).toBe("");
    expect(await noteText(bridge, "A.md")).toBe("stara\n");
  });

  it("puts notes into the folder and keeps the folders of a picked directory", async () => {
    const bridge = new MockBridge([{ path: "Dziennik/A.md", text: "x" }]);
    await importMarkdown(bridge, [
      md("A.md", "y", "Wybrany/Sub"),
      md("C.md", "z", "Wybrany"),
      md("A.md", "w", "Wybrany/Sub"),
    ], "Dziennik");
    const { notes, folders } = await bridge.call<TreeListing>("list_tree");
    expect(folders).toEqual(expect.arrayContaining(["Dziennik/Wybrany", "Dziennik/Wybrany/Sub"]));
    expect(notes.map((n) => n.path).sort()).toEqual([
      "Dziennik/A.md",
      "Dziennik/Wybrany/C.md",
      "Dziennik/Wybrany/Sub/A (2).md",
      "Dziennik/Wybrany/Sub/A.md",
    ]);
  });

  it("skips files that are not .md", async () => {
    const bridge = new MockBridge([]);
    expect(await importMarkdown(bridge, [{ file: new File(["x"], "obraz.png"), dir: "" }])).toBe(0);
    expect((await bridge.call<TreeListing>("list_tree")).notes).toEqual([]);
  });
});

// Runs a download and returns the file name it was saved under and the ZIP inside it.
async function downloaded(run: () => Promise<void>) {
  let blob: Blob | undefined;
  let name = "";
  const click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (b: Blob | MediaSource) => { blob = b as Blob; return "blob:test"; };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { name = this.download; };
  try {
    const done = run();
    // The confirmation is shown before anything is read.
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Pobierz")!.click();
    await done;
  } finally {
    HTMLAnchorElement.prototype.click = click;
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  }
  const bytes = await new Promise<Uint8Array>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob!);
  });
  return { name, zip: unzip([bytes]) };
}

describe("exportNotes", () => {
  it("takes the selected notes and the notes inside a selected folder, not a sibling with the same prefix", async () => {
    const bridge = new MockBridge([
      { path: "Projekty/A/x.md", text: "X" },
      { path: "Projekty/AB/x.md", text: "AB" },
      { path: "Projekty/A.md", text: "plik obok" },
      { path: "Inne.md", text: "Y" },
    ]);
    const { name, zip } = await downloaded(() => exportNotes(bridge, ["Projekty/A"]));
    expect(name).toBe("A.zip");
    expect([...zip.keys()]).toEqual(["Projekty/A/x.md"]);
  });

  it("takes exactly the selected notes under a generic name when several keys are selected", async () => {
    const bridge = new MockBridge([
      { path: "Projekty/A/x.md", text: "X" },
      { path: "Inne.md", text: "Y" },
      { path: "Trzecia.md", text: "Z" },
    ]);
    const { name, zip } = await downloaded(() => exportNotes(bridge, ["Inne.md", "Projekty/A/x.md"]));
    expect(name).toMatch(/^notatki-\d{4}-\d{2}-\d{2}\.zip$/);
    expect([...zip.keys()].sort()).toEqual(["Inne.md", "Projekty/A/x.md"]);
  });
});

describe("collectDropped", () => {
  it("falls back to dataTransfer.files when there are no entries (no webkitGetAsEntry)", async () => {
    const file = new File(["# A"], "A.md");
    const data = { items: [], files: [file] } as unknown as DataTransfer;
    expect(await collectDropped(data)).toEqual([{ file, dir: "" }]);
  });
});

describe("Polish counts", () => {
  it("picks one, few or many", async () => {
    const { count } = await import("./transfer");
    expect([1, 2, 4, 5, 12, 22, 25, 112].map((n) => count(n, "notatka", "notatki", "notatek"))).toEqual(
      ["1 notatka", "2 notatki", "4 notatki", "5 notatek", "12 notatek", "22 notatki", "25 notatek", "112 notatek"]);
  });
});

describe("export of recognised text", () => {
  // Gives the in-memory store text layers: `layers` maps an original's id to its Markdown, or to an error to throw.
  const withLayers = (bridge: MockBridge, layers: Map<string, string | Error>) => {
    const store = bridge.files as unknown as Record<string, unknown>;
    const info = (id: string) => ({ id: `text-${id}`, textOf: id, extractor: "t", method: "text", pages: 1, lang: "pl", quality: 1, flags: [], engine: "x", createdAt: 0, createdBy: null });
    store.textLayers = async () => new Map([...layers.keys()].map((id) => [id, info(id)]));
    store.readTextLayer = async (_layerId: string, originalId: string) => {
      const value = layers.get(originalId);
      if (value instanceof Error) throw value;
      return value ?? "";
    };
  };

  it("writes <file>.tekst.md beside a file that has a text layer, with the layer's text", async () => {
    const bridge = new MockBridge([{ path: "Plan.md", text: `![[plik:${ID}]]\n` }]);
    await bridge.files.upload(new File(["PDF"], "Faktura.pdf", { type: "application/pdf" }), { id: ID });
    withLayers(bridge, new Map([[ID, "# Faktura\n"]]));
    const zip = unzip(zipParts((await buildExport(bridge)).entries));
    expect(text(zip.get("pliki/Faktura.pdf.tekst.md")!.data)).toBe("# Faktura\n");
    expect(text(zip.get("pliki/Faktura.pdf")!.data)).toBe("PDF");
  });

  it("writes nothing for a file without a text layer", async () => {
    const bridge = new MockBridge([{ path: "Plan.md", text: `![[plik:${ID}]]\n` }]);
    await bridge.files.upload(new File(["PDF"], "Faktura.pdf", { type: "application/pdf" }), { id: ID });
    withLayers(bridge, new Map());
    const zip = unzip(zipParts((await buildExport(bridge)).entries));
    expect([...zip.keys()].some((name) => name.endsWith(".tekst.md") && name !== "Plan.md")).toBe(false);
  });

  it("writes nothing when the setting is off", async () => {
    const bridge = new MockBridge([{ path: "Plan.md", text: `![[plik:${ID}]]\n` }]);
    await bridge.files.upload(new File(["PDF"], "Faktura.pdf", { type: "application/pdf" }), { id: ID });
    withLayers(bridge, new Map([[ID, "# Faktura\n"]]));
    setSetting("ocrZipText", false);
    try {
      const zip = unzip(zipParts((await buildExport(bridge)).entries));
      expect(zip.has("pliki/Faktura.pdf.tekst.md")).toBe(false);
      expect(zip.has("pliki/Faktura.pdf")).toBe(true);
    } finally {
      setSetting("ocrZipText", true);
    }
  });

  it("keeps the export going when reading a layer fails", async () => {
    const OTHER = "c".repeat(32);
    const bridge = new MockBridge([{ path: "Plan.md", text: `![[plik:${ID}]]\n![[plik:${OTHER}]]\n` }]);
    await bridge.files.upload(new File(["A"], "Zly.pdf", { type: "application/pdf" }), { id: ID });
    await bridge.files.upload(new File(["B"], "Dobry.pdf", { type: "application/pdf" }), { id: OTHER });
    withLayers(bridge, new Map<string, string | Error>([[ID, new Error("boom")], [OTHER, "# Dobry\n"]]));
    const result = await buildExport(bridge);
    const zip = unzip(zipParts(result.entries));
    expect(result.missing).toEqual([]);
    expect(zip.has("pliki/Zly.pdf")).toBe(true);
    expect(zip.has("pliki/Zly.pdf.tekst.md")).toBe(false);
    expect(text(zip.get("pliki/Dobry.pdf.tekst.md")!.data)).toBe("# Dobry\n");
  });
});
