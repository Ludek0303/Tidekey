// Writes keep what people did (docs/MCP.md §7.3): their edits, the state the engine does not model, task lines.
import { describe, expect, it, vi } from "vitest";
import { makeWorld, textOf } from "./fake";

const NOTES = [
  { path: "Spotkania/A.md", text: "# A\npierwsza linia\n" },
  { path: "Zadania.md", text: "# Zadania\n- [ ] Stare @Anna ^z-00aa\n" },
];
const hashOf = (read: string) => /expected dla edit_note\): ([0-9a-f]{64})/.exec(read)![1];

describe("writes keep what people did (docs/MCP.md §7.3)", () => {
  it("edit_note from a copy older than a person's edit of that note is refused; the person's text stays", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    const hash = hashOf(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Spotkania/A.md" }))));
    // a person edits the same note; the chat's copy is not refreshed yet (at most every 5 minutes)
    await w.editNoteOnServer("Spotkania/A.md", (t) => t.insert(t.length, "od człowieka\n"));
    expect(textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Spotkania/A.md", expected: hash, text: "# A\nprzepisane przez czat\n" })))).toContain("zmieniła się od odczytu");
    expect((await w.texts()).get("Spotkania/A.md")).toBe("# A\npierwsza linia\nod człowieka\n");
    expect(w.server.revision).toBe(2);
    // an edit of another note in the meantime does not block it
    const fresh = w.start().tools;
    const h2 = hashOf(textOf(await fresh.run("read_note", "x", () => fresh.readNote({ path: "Spotkania/A.md" }))));
    await w.editNoteOnServer("Zadania.md", (t) => t.insert(t.length, "jeszcze\n"));
    expect(textOf(await fresh.run("edit_note", "x", () => fresh.editNote({ path: "Spotkania/A.md", expected: h2, text: "# A\nnowe\n" })))).toBe("Zapisano.");
    const texts = await w.texts();
    expect(texts.get("Spotkania/A.md")).toBe("# A\nnowe\n");
    expect(texts.get("Zadania.md")).toContain("jeszcze");
  });

  it("attachments, trash, versions, protected marks and fields the engine does not know survive a chat write", async () => {
    const w = await makeWorld({ notes: [...NOTES, { path: "Kosz.md", text: "do kosza\n" }] });
    await w.editOnServer(async (b) => {
      const tree = await b.call<{ notes: { id: string; path: string }[] }>("list_tree");
      await b.call("delete", { id: tree.notes.find((n) => n.path === "Kosz.md")!.id });
    });
    await w.mutate((s) => {
      s.state.attachments = [{ key: "obraz.png", bytesBase64: "iVBORw0KGgo=" }, { key: "plik.pdf", bytesBase64: "", fileId: "f-1" }];
      s.state.versions = [[s.state.notes[0].id, [{ id: 7, time_ms: 1, reason: "edit", text: "stara wersja" }]]];
      (s.state as unknown as Record<string, unknown>).nowePole = { z: 1 };
      s.state.unprotected = [{ path: "Stary", unprotectedAt: 1 } as never];
    });
    const before = await w.decrypted();
    expect(before.state.trash).toHaveLength(1);
    const { tools } = w.start();
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Spotkania/A.md", text: "x" })))).toBe("Zapisano.");
    const after = await w.decrypted();
    expect(after.state.attachments).toEqual(before.state.attachments);
    expect(after.state.trash).toEqual(before.state.trash);
    expect(after.state.deleted).toEqual(before.state.deleted);
    expect(after.state.versions).toEqual(before.state.versions);
    expect(after.state.unprotected).toEqual(before.state.unprotected);
    expect((after.state as unknown as Record<string, unknown>).nowePole).toEqual({ z: 1 });
    expect(after.state.organization.members).toEqual(before.state.organization.members);
  });

  it("in Moje notatki the person's member name is not replaced by the engine's placeholder", async () => {
    const w = await makeWorld({ notes: NOTES, personal: true });
    const before = (await w.decrypted()).state.organization.members;
    expect(before[0].name).toBe("Anna");
    const { tools } = w.start();
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Spotkania/A.md", text: "x" })))).toBe("Zapisano.");
    expect((await w.decrypted()).state.organization.members).toEqual(before);
  });

  it("set_task changes the line of its id when titles repeat; a wrong value gets a clear message", async () => {
    const w = await makeWorld({ notes: [{ path: "Z.md", text: "- [ ] Zrób to @Anna ^z-00a1\n- [ ] Zrób to @Anna ^z-00a2\n- [ ] Zrób to @Anna ^z-00a3\n" }] });
    const { tools } = w.start();
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-00a2", pole: "termin", wartosc: "2026-12-24" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Z.md")).toBe("- [ ] Zrób to @Anna ^z-00a1\n- [ ] Zrób to @Anna 📅 2026-12-24 ^z-00a2\n- [ ] Zrób to @Anna ^z-00a3\n");
    for (const [pole, wartosc] of [["trudnosc", "bardzo"], ["termin", "jutro"], ["wykonawca", "Jan @Eve"]] as const)
      expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-00a1", pole, wartosc })))).toContain("Nieprawidłowa wartość pola zadania");
    expect(w.server.revision).toBe(2);
  });

  it("add_tasks makes ids unique in the whole vault, not only in its note", async () => {
    const w = await makeWorld({ notes: [{ path: "Inna.md", text: "- [ ] Stare ^z-0001\n" }, { path: "Z.md", text: "# Z\n" }] });
    const { tools } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    // the first random id is the one already used in another note
    const real = crypto.getRandomValues.bind(crypto);
    let first = true;
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array<ArrayBuffer>) => {
      if (first && a.length === 2) { first = false; a.set([0, 1]); return a; }
      return real(a);
    }) as typeof crypto.getRandomValues);
    try { expect(textOf(await tools.run("add_tasks", "x", () => tools.addTasks({ note: "Z.md", titles: ["Nowe"] })))).toBe("Zapisano."); }
    finally { spy.mockRestore(); }
    expect(first).toBe(false);
    expect((await w.texts()).get("Z.md")).not.toContain("^z-0001");
  });

  it("a proposal over the size limit says so, and nothing is sent", async () => {
    const w = await makeWorld({ notes: NOTES, writeMode: "proposals" });
    const { tools } = w.start();
    const text = Array.from({ length: 500_000 }, () => String.fromCharCode(0x4e00 + Math.floor(Math.random() * 20_000))).join("");
    expect(textOf(await tools.run("create_note", "x", () => tools.createNote({ path: "Duża.md", text })))).toContain("Propozycja jest za duża");
    expect(w.server.proposals).toEqual([]);
  });
});
