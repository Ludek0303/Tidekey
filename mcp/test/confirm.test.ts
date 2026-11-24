import { describe, expect, it } from "vitest";
import { Tools } from "../src/tools";
import { makeWorld, textOf } from "./fake";

const NOTES = [{ path: "F/A.md", text: "# A\n" }, { path: "F/B.md", text: "# B\n" }];
const ALL = { tools: ["list_notes", "read_note", "move_note", "trash_note"] };
const tokenOf = (text: string) => /confirmToken="([0-9a-f]{32})"/.exec(text)?.[1];

describe("confirmation of move_note and trash_note (docs/MCP.md §7.3)", () => {
  it("off by default", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    expect(textOf(await tools.run("trash_note", "F/A.md", () => tools.trashNote({ path: "F/A.md" })))).toContain("wyłączone");
    expect(textOf(await tools.run("move_note", "F/A.md", () => tools.moveNote({ from: "F/A.md", to: "F/C.md" })))).toContain("wyłączone");
  });

  it("without, with another, used, expired or mismatched token nothing changes; the right one applies once", async () => {
    const w = await makeWorld({ notes: NOTES, scope: ALL });
    let now = Date.now();
    const { session, state } = w.start();
    const tools = new Tools(session, state, async () => null, () => now);
    const trash = (a: { path: string; confirmToken?: string }) => tools.run("trash_note", a.path, () => tools.trashNote(a));

    const preview = textOf(await trash({ path: "F/A.md" }));
    expect(preview).toContain("Przenieść notatkę F/A.md do kosza?");
    const token = tokenOf(preview)!;
    expect(token).toBeTruthy();
    expect(w.server.revision).toBe(1);

    expect(textOf(await trash({ path: "F/A.md", confirmToken: "0".repeat(32) }))).toContain("nieważne");
    // a token for A.md does not confirm B.md (and is spent by the try)
    const forA = tokenOf(textOf(await trash({ path: "F/A.md" })))!;
    expect(textOf(await trash({ path: "F/B.md", confirmToken: forA }))).toContain("nieważne");
    expect(textOf(await trash({ path: "F/A.md", confirmToken: forA }))).toContain("nieważne");
    // a token of the other tool does not confirm this one
    const moveToken = tokenOf(textOf(await tools.run("move_note", "F/A.md", () => tools.moveNote({ from: "F/A.md", to: "F/C.md" }))))!;
    expect(textOf(await trash({ path: "F/A.md", confirmToken: moveToken }))).toContain("nieważne");
    // a token from another chat process is unknown here
    const other = w.start();
    const otherToken = tokenOf(textOf(await other.tools.run("trash_note", "F/A.md", () => other.tools.trashNote({ path: "F/A.md" }))))!;
    expect(textOf(await trash({ path: "F/A.md", confirmToken: otherToken }))).toContain("nieważne");
    // expired after 2 minutes
    const late = tokenOf(textOf(await trash({ path: "F/A.md" })))!;
    now += 2 * 60_000 + 1;
    expect(textOf(await trash({ path: "F/A.md", confirmToken: late }))).toContain("nieważne");
    expect(w.server.revision).toBe(1);
    expect((await w.texts()).has("F/A.md")).toBe(true);

    // a fresh token, used at once, applies; it is spent after that
    const good = tokenOf(textOf(await trash({ path: "F/A.md" })))!;
    expect(textOf(await trash({ path: "F/A.md", confirmToken: good }))).toBe("Zapisano.");
    expect((await w.texts()).has("F/A.md")).toBe(false);
    expect(textOf(await trash({ path: "F/B.md", confirmToken: good }))).toContain("nieważne");
    expect(token).not.toBe(good);
  });

  it("uses elicitation when the client has it: no means nothing, yes applies", async () => {
    const w = await makeWorld({ notes: NOTES, scope: ALL });
    const asked: string[] = [];
    let answer = false;
    const { tools } = w.start(async (m) => { asked.push(m); return answer; });
    // a top-level note is the owner's or an admin's to make: refused before anyone is asked
    expect(textOf(await tools.run("move_note", "F/A.md", () => tools.moveNote({ from: "F/A.md", to: "C.md" })))).toContain("tworzy właściciel lub administrator");
    expect(textOf(await tools.run("move_note", "F/A.md", () => tools.moveNote({ from: "F/A.md", to: "F/C.md" })))).toBe("Anulowano. Nic nie zmieniono.");
    expect(w.server.revision).toBe(1);
    answer = true;
    expect(textOf(await tools.run("move_note", "F/A.md", () => tools.moveNote({ from: "F/A.md", to: "F/C.md" })))).toBe("Zapisano.");
    expect([...(await w.texts()).keys()].sort()).toEqual(["F/B.md", "F/C.md"]);
    expect(asked).toEqual(["Przenieść notatkę F/A.md do F/C.md?", "Przenieść notatkę F/A.md do F/C.md?"]);
  });
});
