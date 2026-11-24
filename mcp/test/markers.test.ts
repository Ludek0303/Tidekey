// Hidden links as opaque markers, the same answer for "missing" and "out of scope", strict set_task and stale keys
// (docs/MCP.md §3.5, §7.3).
import { describe, expect, it } from "vitest";
import { makeWorld, textOf } from "./fake";

const SCOPE = "Poza zakresem tego czatu.";
const hashOf = (read: string) => /expected dla edit_note\): ([0-9a-f]{64})/.exec(read)![1];
const bodyOf = (read: string) => read.split("\n\n").slice(1).join("\n\n").replace(/\n<<<koniec treści>>>$/, "");

describe("no answer tells a missing note from one out of scope", () => {
  it("reads and writes of a missing, an excluded or a locked path give the same text", async () => {
    const w = await makeWorld({
      notes: [{ path: "Jawne/A.md", text: "a\n" }, { path: "Ukryte/B.md", text: "b\n" }], scope: { exclude: ["Ukryte"], tools: ["read_note", "append", "edit_note", "move_note", "trash_note", "create_note"] },
      projects: [{ path: "Projekty/Zamknięty", forChat: false, notes: [{ path: "Projekty/Zamknięty/C.md", text: "c\n" }] }],
    });
    const { tools } = w.start(async () => true);
    for (const path of ["Jawne/Nie ma.md", "Ukryte/B.md", "Ukryte/Nie ma.md", "Projekty/Zamknięty/C.md", "Projekty/Zamknięty/Nie ma.md", "Inne/Nie ma.md"]) {
      expect(textOf(await tools.run("read_note", path, () => tools.readNote({ path })))).toBe(SCOPE);
      expect(textOf(await tools.run("append", path, () => tools.append({ path, text: "x" })))).toBe(SCOPE);
      expect(textOf(await tools.run("edit_note", path, () => tools.editNote({ path, expected: "", text: "x" })))).toBe(SCOPE);
      expect(textOf(await tools.run("trash_note", path, () => tools.trashNote({ path })))).toBe(SCOPE);
      expect(textOf(await tools.run("move_note", path, () => tools.moveNote({ from: path, to: "Jawne/X.md" })))).toBe(SCOPE);
    }
    for (const path of ["Projekty/Zamknięty/Nowa.md", "Ukryte/Nowa.md"]) expect(textOf(await tools.run("create_note", path, () => tools.createNote({ path, text: "x" })))).toBe(SCOPE);
    expect(w.server.revision).toBe(1);
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/A.md" })))).toContain("Znaki 0–2 z 2.");
  });
});

describe("hidden links are opaque markers (docs/MCP.md §3.5)", () => {
  const LINKS = "Zobacz [[Ukryte/Tajne|alias tajny]], ![[Ukryte/obraz.png]] i [[Tajne#Sekcja]] oraz [[Jawne/B]].\n";
  const NOTES = [
    { path: "Jawne/A.md", text: `# A [[Ukryte/Tajne]]\n${LINKS}- [ ] Zadanie z [[Ukryte/Tajne|aliasem]] ^z-0a01\n` },
    { path: "Jawne/B.md", text: "b\n" },
    { path: "Ukryte/Tajne.md", text: "tajne\n" },
  ];
  const world = () => makeWorld({ notes: NOTES, scope: { include: ["Jawne"] } });

  it("no tool shows a hidden link's target, heading or alias", async () => {
    const w = await world();
    const { tools } = w.start();
    const out = [
      await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/A.md" })), await tools.run("list_notes", undefined, () => tools.listNotes({})),
      await tools.run("search", undefined, () => tools.search({ q: "Zobacz" })), await tools.run("list_tasks", undefined, () => tools.listTasks({})),
    ].map(textOf).join("\n");
    for (const s of ["Ukryte", "Tajne", "tajny", "aliasem", "obraz", "Sekcja"]) expect(out).not.toContain(s);
    expect(out).toContain("# A ⟦ukryty link 1⟧");
    expect(out).toContain("Zobacz ⟦ukryty link 2⟧, ⟦ukryty link 3⟧ i ⟦ukryty link 4⟧ oraz [[Jawne/B]].");
    expect(out).toContain("Zadanie z ⟦ukryty link 5⟧");
  });

  it("an edit that keeps every marker writes the original links back byte for byte", async () => {
    const w = await world();
    const { tools } = w.start();
    const read = textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/A.md" })));
    const shown = bodyOf(read);
    const next = `${shown.replace("Zobacz", "Patrz").replace("⟦ukryty link 4⟧", "⟦ukryty link 4⟧ (dwa razy: ⟦ukryty link 4⟧)")}dopisek\n`;
    expect(textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Jawne/A.md", expected: hashOf(read), text: next })))).toBe("Zapisano.");
    expect((await w.texts()).get("Jawne/A.md")).toBe(`${NOTES[0].text.replace("Zobacz", "Patrz").replace("[[Tajne#Sekcja]]", "[[Tajne#Sekcja]] (dwa razy: [[Tajne#Sekcja]])")}dopisek\n`);
    // the shown text is a valid expected too
    const again = textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/A.md" })));
    expect(textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Jawne/A.md", expected: bodyOf(again), text: bodyOf(again).replace("Patrz", "Zobacz") })))).toBe("Zapisano.");
    expect((await w.texts()).get("Jawne/A.md")).toContain("Zobacz [[Ukryte/Tajne|alias tajny]], ![[Ukryte/obraz.png]]");
  });

  it("a removed, changed or forged marker is refused, and nothing is written", async () => {
    const w = await world();
    const { tools } = w.start();
    const read = textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/A.md" })));
    const shown = bodyOf(read);
    const edit = (text: string) => tools.run("edit_note", "x", () => tools.editNote({ path: "Jawne/A.md", expected: hashOf(read), text }));
    expect(textOf(await edit(shown.replace("⟦ukryty link 3⟧", "")))).toContain("usuwa albo zmienia ukryty link");
    expect(textOf(await edit(shown.replace("⟦ukryty link 3⟧", "[[Ukryte/obraz.png]]")))).toContain("usuwa albo zmienia ukryty link");
    for (const forged of ["⟦ukryty link 6⟧", "⟦ukryty link 0⟧", "⟦ukryty link 03⟧", "⟦ukryty link x⟧"])
      expect(textOf(await edit(`${shown}${forged}`))).toContain("działa tylko w notatce");
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Jawne/A.md", text: "⟦ukryty link 9⟧" })))).toContain("działa tylko w notatce");
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Jawne/B.md", text: "⟦ukryty link 1⟧" })))).toContain("działa tylko w notatce");
    expect(textOf(await tools.run("create_note", "x", () => tools.createNote({ path: "Jawne/C.md", text: "⟦ukryty link 1⟧" })))).toContain("działa tylko w notatce");
    expect(w.server.revision).toBe(1);
    // append with a marker of its own note writes the link
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Jawne/A.md", text: "też ⟦ukryty link 2⟧" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Jawne/A.md")).toMatch(/też \[\[Ukryte\/Tajne\|alias tajny\]\]$/);
  });

  it("a note holding marker-shaped text of its own cannot take markers (ambiguous)", async () => {
    const w = await makeWorld({ notes: [{ path: "Jawne/A.md", text: "⟦ukryty link 1⟧ [[Ukryte/X]]\n" }], scope: { include: ["Jawne"] } });
    const { tools } = w.start();
    const read = textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Jawne/A.md" })));
    expect(textOf(await tools.run("edit_note", "x", () => tools.editNote({ path: "Jawne/A.md", expected: hashOf(read), text: bodyOf(read) })))).toContain("działa tylko w notatce");
    expect(w.server.revision).toBe(1);
  });
});

describe("set_task is strict on its line (docs/MCP.md §7.3)", () => {
  const NOTES = [{ path: "Z.md", text: "# Z\n- [ ] Pierwsze @Anna ^z-0001\n- [ ] Drugie @Anna ^z-0002\n" }];
  it("a task line changed by a person since the chat's copy is refused; the person's line stays", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    await tools.run("list_tasks", undefined, () => tools.listTasks({}));
    await w.editNoteOnServer("Z.md", (t) => { const at = t.toString().indexOf(" ^z-0001"); t.insert(at, " 📅 2026-12-01"); });
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-0001", pole: "termin", wartosc: "2026-12-24" })))).toBe("Zadanie zmieniło się od odczytu. Odczytaj je ponownie.");
    expect((await w.texts()).get("Z.md")).toBe("# Z\n- [ ] Pierwsze @Anna 📅 2026-12-01 ^z-0001\n- [ ] Drugie @Anna ^z-0002\n");
  });

  it("a change of another line of the note merges", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    await tools.run("list_tasks", undefined, () => tools.listTasks({}));
    await w.editNoteOnServer("Z.md", (t) => t.insert(t.length, "notatka człowieka\n"));
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-0002", pole: "termin", wartosc: "2026-12-24" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Z.md")).toBe("# Z\n- [ ] Pierwsze @Anna ^z-0001\n- [ ] Drugie @Anna 📅 2026-12-24 ^z-0002\nnotatka człowieka\n");
  });
});

describe("stale key (409 stale-key)", () => {
  const NOTES = [{ path: "A.md", text: "a\n" }];
  const snapshotGets = (w: Awaited<ReturnType<typeof makeWorld>>) => w.server.log.filter((l) => l.method === "GET" && l.path.includes("/snapshot")).length;

  it("when a full fetch is allowed, the new snapshot is fetched with the new envelope and the write goes on", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    await w.rotate(true);
    await w.editNoteOnServer("A.md", (t) => t.insert(0, "od człowieka\n"));
    const real = w.fetchFn;
    let first = true;
    (session.client.opts as { fetch?: typeof fetch }).fetch = (async (u: URL | string, init?: RequestInit) => {
      if (init?.method === "POST" && first) {
        first = false;
        session.vaults.get(w.vaultId)!.fetchedAt = 0; // the last full fetch is long enough ago now
        return new Response(JSON.stringify({ code: "stale-key", message: "x" }), { status: 409 });
      }
      return real(u, init);
    }) as typeof fetch;
    const before = snapshotGets(w);
    expect(textOf(await tools.run("append", "A.md", () => tools.append({ path: "A.md", text: "b" })))).toBe("Zapisano.");
    expect(snapshotGets(w)).toBe(before + 1);
    expect((await w.texts()).get("A.md")).toBe("od człowieka\na\nb");
  });

  it("no full fetch within 5 minutes of the last: a stale key again gives the time to try, and earns no 429", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    const real = w.fetchFn;
    (session.client.opts as { fetch?: typeof fetch }).fetch = (async (u: URL | string, init?: RequestInit) =>
      init?.method === "POST" ? new Response(JSON.stringify({ code: "stale-key", message: "x" }), { status: 409 }) : real(u, init)) as typeof fetch;
    const before = snapshotGets(w);
    const r = textOf(await tools.run("append", "A.md", () => tools.append({ path: "A.md", text: "b" })));
    expect(r).toMatch(/^Klucz przestrzeni właśnie się zmienił\. Nowe notatki można pobrać najwcześniej o \d\d:\d\d; spróbuj wtedy jeszcze raz\.$/);
    expect(snapshotGets(w)).toBe(before);
    expect(w.server.log.filter((l) => l.method === "GET" && l.path === `/api/agent/vaults/${w.vaultId}`).length).toBeGreaterThanOrEqual(2);
  });

  it("no envelope for the new epoch: the vault is dropped with a clear message", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    await w.rotate(false);
    expect(textOf(await tools.run("append", "A.md", () => tools.append({ path: "A.md", text: "b" })))).toBe("Ten czat nie dostał nowego klucza tej przestrzeni, więc nie ma już do niej dostępu.");
    expect(session.vaults.size).toBe(0);
    expect(w.server.revision).toBe(2);
  });
});

describe("the guide says it (docs/MCP.md §3.5)", () => {
  it("tells that missing and out of scope look the same, and how markers work", async () => {
    const { GUIDE, INSTRUCTIONS } = await Promise.all([import("../src/guide"), import("../src/server")]).then(([g, s]) => ({ GUIDE: g.GUIDE, INSTRUCTIONS: s.INSTRUCTIONS }));
    for (const text of [GUIDE, INSTRUCTIONS]) { expect(text).toContain("nie odróżnia"); expect(text).toContain("⟦ukryty link N⟧"); }
    expect(GUIDE).not.toContain("Nie ma takiej notatki");
    expect(GUIDE).toContain("Zadanie zmieniło się od odczytu");
  });
});
