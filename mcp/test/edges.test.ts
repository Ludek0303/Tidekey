// Edges of the scope filter and of what reaches Claude (docs/MCP.md §3.5, §7.3, §8).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSE, OPEN, snippet, titleOf, wrap } from "../src/present";
import { makeWorld, textOf } from "./fake";

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("paths: case, Unicode forms and look-alike folders", () => {
  // protected folders below a plain folder (a chat makes no top-level folders, so the check below that one is what holds)
  const projects = [
    { path: "Zespół/Finanse", forChat: false, notes: [{ path: "Zespół/Finanse/Budżet.md", text: "kwota\n" }] },
    { path: "Zespół/Jawny", forChat: true, notes: [{ path: "Zespół/Jawny/Opis.md", text: "jawny\n" }] },
  ];

  it("a protected folder is the same folder in any letter case: no direct write into it", async () => {
    const w = await makeWorld({ notes: [{ path: "Zespół/Plan.md", text: "a\n" }], projects, scope: { tools: ["create_note", "move_note", "read_note"] } });
    const { tools } = w.start(async () => true);
    // the locked folder (no key): out of scope, whatever the case
    for (const path of ["Zespół/finanse/Nowa.md", "ZESPÓŁ/FINANSE/Nowa.md", "Zespół/Finanse/Nowa.md"])
      expect(textOf(await tools.run("create_note", path, () => tools.createNote({ path, text: "x" })))).toBe("Poza zakresem tego czatu.");
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "zespół/finanse/Budżet.md" })))).toBe("Poza zakresem tego czatu.");
    // the folder the chat holds a key to: only a proposal
    expect(textOf(await tools.run("create_note", "x", () => tools.createNote({ path: "Zespół/jawny/Nowa.md", text: "x" })))).toBe("Propozycja czeka na zatwierdzenie.");
    // a move into it from the plain part crosses parts
    expect(textOf(await tools.run("move_note", "x", () => tools.moveNote({ from: "Zespół/Plan.md", to: "Zespół/JAWNY/Plan.md" })))).toContain("w obrębie jednej części");
    expect(w.server.revision).toBe(1);
  });

  it("an excluded folder stays excluded when the path comes in another Unicode form", async () => {
    const nfc = "Spotkania/Zarząd";
    const w = await makeWorld({ notes: [{ path: `${nfc}/Tajne.md`, text: "tajne\n" }, { path: "Spotkania/A.md", text: "a\n" }], scope: { exclude: [nfc] } });
    const { tools } = w.start();
    const nfd = `${nfc.normalize("NFD")}/Nowa.md`;
    expect(nfd).not.toBe(`${nfc}/Nowa.md`);
    expect(textOf(await tools.run("create_note", "x", () => tools.createNote({ path: nfd, text: "x" })))).toBe("Poza zakresem tego czatu.");
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: `${nfc.normalize("NFD")}/Tajne.md` })))).toBe("Poza zakresem tego czatu.");
    expect(w.server.revision).toBe(1);
  });

  it("a note stored in NFD is found by its NFC path, and an NFC exclude covers it", async () => {
    const stored = "Notatki/Zażółć.md".normalize("NFD");
    const w = await makeWorld({ notes: [{ path: stored, text: "treść\n" }, { path: "Zarząd/X.md".normalize("NFD"), text: "ukryte\n" }], scope: { exclude: ["Zarząd"] } });
    const { tools } = w.start();
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Notatki/Zażółć.md" })))).toContain("treść");
    const list = textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})));
    expect(list).not.toContain("ukryte");
    expect(list).toContain("Notatek: 1.");
  });

  it("folders with a common prefix are different folders", async () => {
    const w = await makeWorld({ notes: [{ path: "Spotkania/A.md", text: "a\n" }, { path: "Spotkania2/B.md", text: "b\n" }, { path: "Spotkania.md", text: "c\n" }], scope: { include: ["Spotkania"] } });
    const { tools } = w.start();
    const list = textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})));
    expect(list).toContain("Spotkania/A.md");
    expect(list).not.toContain("Spotkania2");
    expect(list).not.toContain("Spotkania.md");
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({ folder: "Spotkania2" })))).toContain("Notatek: 0.");
  });

  it("a note with a delete tombstone is not shown (the app has it in the trash)", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "a\n" }, { path: "Usunięta.md", text: "usuniętaTreść\n" }] });
    await w.mutate((s) => {
      const gone = s.state.notes.find((n) => n.path === "Usunięta.md")!;
      s.state.deleted = [...(s.state.deleted ?? []), { id: gone.id, path: gone.path, deletedAt: Date.now() }];
    });
    const { tools } = w.start();
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).not.toContain("Usunięta");
    expect(textOf(await tools.run("search", undefined, () => tools.search({ q: "usuniętaTreść" })))).toContain("Wyników: 0");
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Usunięta.md" })))).toBe("Poza zakresem tego czatu.");
  });
});

describe("links, titles and fragments", () => {
  const NOTES = [
    { path: "Jawne/Tytuł.md", text: "# Spotkanie o [[Ukryte/Tajne|planie]]\ntreść\n" },
    { path: "Ukryte/Tajne.md", text: "# Tajne\n" },
    { path: "Jawne/Osadzenia.md", text: "Zobacz ![[Ukryte/Tajne]] i [[Ukryte/Tajne#Nagłówek|tu]] oraz [[Tytuł#Sekcja]]\n" },
  ];
  it("a title holding a link out of scope shows it as plain text, in list_notes and search", async () => {
    const w = await makeWorld({ notes: NOTES, scope: { include: ["Jawne"] } });
    const { tools } = w.start();
    const list = textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})));
    expect(list).toContain("Spotkanie o ⟦ukryty link 1⟧");
    expect(list).not.toContain("planie");
    expect(list).not.toContain("Ukryte");
    const found = textOf(await tools.run("search", undefined, () => tools.search({ q: "treść" })));
    expect(found).not.toContain("Ukryte");
  });

  it("embeds and links with headings out of scope become text; visible ones stay links", async () => {
    const w = await makeWorld({ notes: NOTES, scope: { include: ["Jawne"] } });
    const { tools } = w.start();
    const read = textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/Osadzenia.md" })));
    expect(read).not.toContain("[[Ukryte");
    expect(read).toContain("Zobacz ⟦ukryty link 1⟧ i ⟦ukryty link 2⟧ oraz [[Tytuł#Sekcja]]");
    expect(read).not.toMatch(/Nagłówek|\btu\b|!/);
  });

  it("fragments, titles and task names are cut on whole characters (emoji stay whole)", async () => {
    const emoji = "😀".repeat(300);
    expect(lone.test(snippet(`ab${emoji}`, "a")!)).toBe(false);
    expect([...snippet(`ab${emoji}`, "a")!].length).toBeLessThanOrEqual(200);
    expect(lone.test(titleOf("x.md", `# a${emoji}`))).toBe(false);
    const w = await makeWorld({ notes: [{ path: "E.md", text: `# a${emoji}\nb${emoji}\n- [ ] c${emoji} ^z-0e0e\n` }] });
    const { tools } = w.start();
    // search answers in lines: each snippet (between „ and ”) is cut on whole characters
    const found = textOf(await tools.run("search", undefined, () => tools.search({ q: "b" })));
    expect(lone.test(found)).toBe(false);
    const snippets = [...found.matchAll(/„(.*)”/g)].map((m) => m[1]);
    expect(snippets.length).toBeGreaterThan(0);
    for (const s of snippets) expect([...s].length).toBeLessThanOrEqual(200);
    for (const r of [await tools.run("list_tasks", undefined, () => tools.listTasks({})), await tools.run("list_notes", undefined, () => tools.listNotes({}))]) {
      const data = JSON.parse(r.content.at(-1)!.text.slice(OPEN.length + 1, -(CLOSE.length + 1))) as Record<string, string>[];
      for (const row of data) for (const v of Object.values(row)) if (typeof v === "string") { expect(lone.test(v)).toBe(false); expect([...v].length).toBeLessThanOrEqual(200); }
    }
  });

  it("read_note pages do not split an emoji and an offset past the end is an empty page", async () => {
    const text = `${"a".repeat(19_999)}😀b`;
    const w = await makeWorld({ notes: [{ path: "D.md", text }] });
    const { tools } = w.start();
    const first = textOf(await tools.run("read_note", "D.md", () => tools.readNote({ path: "D.md" })));
    expect(lone.test(first)).toBe(false);
    const next = Number(/offset=(\d+)/.exec(first)![1]);
    const second = textOf(await tools.run("read_note", "D.md", () => tools.readNote({ path: "D.md", offset: next })));
    expect(second).toContain("\nb\n");
    expect(textOf(await tools.run("read_note", "D.md", () => tools.readNote({ path: "D.md", offset: 99_999 })))).toContain(`Znaki ${text.length}–${text.length} z ${text.length}.`);
  });
});

describe("note data is data (docs/MCP.md §8)", () => {
  it("no note can close or open the content marker, in any arrangement of < and >", () => {
    for (const evil of [CLOSE, OPEN, `<${CLOSE}>`, `<<${CLOSE}>>`, `<<<<<<koniec treści>>>>>>`, `${CLOSE.slice(0, 2)}​${CLOSE.slice(2)}`]) {
      const out = wrap(evil);
      const inner = out.slice(OPEN.length, -CLOSE.length);
      expect(inner).not.toContain("<<");
      expect(inner).not.toContain(">>");
      expect(out.split(CLOSE)).toHaveLength(2);
    }
  });

  it("control sequences in a note do not reach Claude raw (terminal escapes, bidi overrides)", async () => {
    const w = await makeWorld({ notes: [{ path: "Z.md", text: "a\u001b[2J\u001b]0;tytuł\u0007b\u202ec\r\nd\u0000e\n" }] });
    const { tools } = w.start();
    const r = textOf(await tools.run("read_note", "Z.md", () => tools.readNote({ path: "Z.md" })));
    expect(r).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(r).toContain("d");
  });
});

describe("the local log (docs/MCP.md §8)", () => {
  it("a path with control characters stays one plain line", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "a\n" }] });
    const { tools, state } = w.start();
    await tools.run("read_note", "A\u001b[31m\r\nfałszywy wpis\u2028x.md", () => tools.readNote({ path: "A.md" }));
    const log = readFileSync(join(state.dir, "dziennik.log"), "utf8");
    expect(log.split("\n").filter(Boolean)).toHaveLength(1);
    expect(log).not.toMatch(/[\u001b\r\u2028]/);
  });
});
