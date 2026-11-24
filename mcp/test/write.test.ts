import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { openProposal } from "../../ui/src/proposals";
import { verifyAgentSigned } from "../../ui/src/agentcrypto";
import { decryptSnapshot } from "../../ui/src/browserauth";
import { MARKS_TEXT } from "../../ui/src/permissionmarks";
import { makeWorld, textOf } from "./fake";

const NOTES = [
  { path: "Spotkania/A.md", text: "# A\npierwsza linia\n" },
  { path: "Projekt.md", text: "---\ntyp: projekt\nosoby: Anna\n---\n# Projekt\n\n| Składka | Jan !zaznacza:@Anna |\n| --- | --- |\n" },
  { path: "Zadania.md", text: "# Zadania\n- [ ] Stare @Anna ^z-00aa\n" },
];

describe("writes (docs/MCP.md §6, §7.1, §7.3)", () => {
  it("refuses every change of the permission marks and leaves the server as it was", async () => {
    const w = await makeWorld({ notes: NOTES, scope: { tools: ["read_note", "create_note", "append", "edit_note", "move_note", "trash_note"] } });
    const { tools } = w.start();
    const read = textOf(await tools.run("read_note", "Projekt.md", () => tools.readNote({ path: "Projekt.md" })));
    const hash = /Skrót treści \(expected dla edit_note\): ([0-9a-f]{64})/.exec(read)![1];
    const attempts = [
      () => tools.createNote({ path: "Nowy.md", text: "---\nosoby: Jan\n---\n# Nowy\n" }),
      () => tools.createNote({ path: "Nowa tabela.md", text: "| A !zaznacza:@Jan |\n| --- |\n" }),
      () => tools.editNote({ path: "Projekt.md", expected: hash, text: NOTES[1].text.replace("osoby: Anna", "osoby: Anna, Eve") }),
      () => tools.editNote({ path: "Projekt.md", expected: hash, text: NOTES[1].text.replace("prowadzacy", "").replace("---\n#", "prowadzacy: Eve\n---\n#") }),
      () => tools.editNote({ path: "Projekt.md", expected: hash, text: NOTES[1].text.replace("!zaznacza:@Anna", "!zaznacza:@Eve") }),
      () => tools.editNote({ path: "Projekt.md", expected: hash, text: NOTES[1].text.replace("typ: projekt\n", "") }),
      () => tools.append({ path: "Spotkania/A.md", text: "| X !zaznacza:@Eve |" }),
      () => tools.trashNote({ path: "Projekt.md" }),
      () => tools.moveNote({ from: "Projekt.md", to: "Inny.md" }),
    ];
    for (const run of attempts) expect(textOf(await tools.run("t", undefined, run))).toBe(MARKS_TEXT);
    expect(w.server.revision).toBe(1);
    expect(w.server.proposals).toEqual([]);
  });

  it("edit_note with an outdated expected is refused; the current one (text or hash) applies", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    const stale = textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Spotkania/A.md", expected: "# A\nstara treść\n", text: "# A\nnowa\n" })));
    expect(stale).toContain("zmieniła się od odczytu");
    expect(w.server.revision).toBe(1);
    expect(textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Spotkania/A.md", expected: NOTES[0].text, text: "# A\nnowa\n" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Spotkania/A.md")).toBe("# A\nnowa\n");
    // the old text is outdated now, also as a hash
    const again = textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Spotkania/A.md", expected: NOTES[0].text, text: "# A\ninna\n" })));
    expect(again).toContain("zmieniła się od odczytu");
  });

  it("a conflict is merged with the newer revision and put again", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    // someone edits another note in the meantime: the chat's put meets a newer revision
    await w.editOnServer(async (b) => {
      const tree = await b.call<{ notes: { id: string; path: string }[] }>("list_tree");
      const id = tree.notes.find((n) => n.path === "Zadania.md")!.id;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
      const sv = Y.encodeStateVector(doc);
      doc.getText("content").insert(doc.getText("content").length, "od człowieka\n");
      await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, sv) });
    });
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Spotkania/A.md", text: "od czatu" })))).toBe("Zapisano.");
    const texts = await w.texts();
    expect(texts.get("Spotkania/A.md")).toBe("# A\npierwsza linia\nod czatu");
    expect(texts.get("Zadania.md")).toContain("od człowieka");
    expect(w.server.revision).toBe(3);
  });

  it("tasks: add_tasks writes the token format, set_task changes a field, events are signed as the chat", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    expect(textOf(await tools.run("add_tasks", "x", () => tools.addTasks({ note: "Zadania.md", titles: ["Zrobić X", "Zrobić Y"], osoba: "Anna", termin: "2026-12-01" })))).toBe("Zapisano.");
    const text = (await w.texts()).get("Zadania.md")!;
    expect(text).toMatch(/\n- \[ \] Zrobić X @Anna 📅 2026-12-01 \^z-[0-9a-f]{4}\n- \[ \] Zrobić Y @Anna 📅 2026-12-01 \^z-[0-9a-f]{4}\n$/);
    expect(textOf(await tools.run("add_tasks", "x", () => tools.addTasks({ note: "Zadania.md", titles: ["Ukryte @Eve"] })))).toContain("Nazwa zadania");
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-00aa", pole: "ukonczenie", wartosc: "tak" })))).toBe("Zapisano.");
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "^z-00aa", pole: "wykonawca", wartosc: "Jan" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Zadania.md")).toMatch(/- \[x\] Stare @Jan ✅ \d{4}-\d\d-\d\d \^z-00aa/);
    const state = (await decryptSnapshot(w.server.envelope, w.userId, w.vaultId, w.key)).state;
    const events = state.organization.events as unknown as { signerAgentId?: string; alg?: string; signature?: string }[];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.signerAgentId).toBe(w.agentId);
      expect(await verifyAgentSigned(e, w.chat.signKey)).toBe(true);
    }
  });

  it("none: read only; proposals: sealed to the person, nothing written", async () => {
    const none = await makeWorld({ notes: NOTES, writeMode: "none" });
    const a = none.start();
    expect(textOf(await a.tools.run("create_note", "x", () => a.tools.createNote({ path: "N.md", text: "x" })))).toBe("Ten czat ma tylko odczyt w tej przestrzeni.");
    expect(none.server.log.some((l) => l.method === "POST")).toBe(false);

    const w = await makeWorld({ notes: NOTES, writeMode: "proposals" });
    const { tools } = w.start();
    expect(textOf(await tools.run("create_note", "x", () => tools.createNote({ path: "Nowa.md", text: "# Nowa\n" })))).toBe("Propozycja czeka na zatwierdzenie.");
    expect(textOf(await tools.run("trash_note", "x", () => tools.trashNote({ path: "Spotkania/A.md" })))).toContain("wyłączone");
    expect(w.server.revision).toBe(1);
    expect(w.server.proposals).toHaveLength(1);
    const body = await openProposal(w.server.proposals[0] as never, { vaultId: w.vaultId, boxPrivateKey: w.box.privateKey, agentSignKey: w.chat.signKey, agentId: w.agentId, userId: w.userId });
    expect(body.changes).toEqual([{ op: "create", path: "Nowa.md", noteId: "", baseHash: "", text: "# Nowa\n" }]);
    // the proposal does not open with the vault key's world: the ciphertext never holds the plain text
    expect(JSON.stringify(w.server.proposals[0])).not.toContain("Nowa");
  });

  it("append: only new notes and text at the end", async () => {
    const w = await makeWorld({ notes: NOTES, writeMode: "append" });
    const { tools } = w.start();
    expect(textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Spotkania/A.md", expected: NOTES[0].text, text: "nic" })))).toContain("tylko tworzyć notatki i dopisywać");
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-00aa", pole: "termin", wartosc: "2026-12-01" })))).toContain("tylko tworzyć notatki i dopisywać");
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Spotkania/A.md", text: "dopisek\n" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Spotkania/A.md")).toBe("# A\npierwsza linia\ndopisek\n");
  });

  it("a protected project the chat holds a key to is read, and written only as a proposal", async () => {
    const w = await makeWorld({ notes: NOTES, projects: [{ path: "Projekty/Jawny", forChat: true, notes: [{ path: "Projekty/Jawny/Opis.md", text: "# Opis\njawny\n" }] }] });
    const { tools } = w.start();
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Projekty/Jawny/Opis.md" })))).toContain("jawny");
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Projekty/Jawny/Opis.md", text: "dopisek" })))).toBe("Propozycja czeka na zatwierdzenie.");
    expect(textOf(await tools.run("create_note", "x", () => tools.createNote({ path: "Projekty/Jawny/Nowa.md", text: "x" })))).toBe("Propozycja czeka na zatwierdzenie.");
    expect(w.server.revision).toBe(1);
    expect(w.server.proposals).toHaveLength(2);
    // a direct write elsewhere keeps the protected entries exactly as they were
    const before = (await decryptSnapshot(w.server.envelope, w.userId, w.vaultId, w.key)).state.protected;
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Spotkania/A.md", text: "dopisek" })))).toBe("Zapisano.");
    const after = await decryptSnapshot(w.server.envelope, w.userId, w.vaultId, w.key);
    expect(after.state.protected).toEqual(before);
    expect(after.state.notes.some((n) => n.path.startsWith("Projekty/Jawny"))).toBe(false);
  });
});
