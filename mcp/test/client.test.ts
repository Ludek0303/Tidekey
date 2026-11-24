import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { blake2bHex, fromB64u } from "../../ui/src/agentcrypto";
import { AgentClient } from "../src/client";
import { VERSION } from "../src/version";
import { makeWorld, textOf } from "./fake";

const NOTES = [{ path: "A.md", text: "# A\ntajna treść\n" }];

describe("request proof and server answers (docs/MCP.md §5.2, §5.3, §5.5, §10)", () => {
  it("every request carries a proof that verifies under the chat key, over method, path, body, time, nonce, version", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    await tools.run("append", "A.md", () => tools.append({ path: "A.md", text: "x" }));
    const agent = w.server.log.filter((l) => l.path.startsWith("/api/agent/"));
    expect(agent.length).toBeGreaterThanOrEqual(4);
    const nonces = new Set<string>();
    await sodium.ready;
    for (const l of agent) {
      const h = l.headers;
      expect(h.authorization).toBe(`NotesAgent ${w.tokenHex}`);
      expect(h["notes-agent-version"]).toBe(VERSION);
      expect(h["notes-agent-nonce"]).toMatch(/^[0-9a-f]{32}$/);
      expect(Math.abs(Number(h["notes-agent-time"]) - Date.now())).toBeLessThan(60_000);
      nonces.add(h["notes-agent-nonce"]);
      const message = `notes-agent-req-v1\n${l.method}\n${l.path}\n${await blake2bHex(new TextEncoder().encode(l.body))}\n${h["notes-agent-time"]}\n${h["notes-agent-nonce"]}\n${h["notes-agent-version"]}`;
      expect(sodium.crypto_sign_verify_detached(fromB64u(h["notes-agent-proof"]), new TextEncoder().encode(message), fromB64u(w.chat.signKey))).toBe(true);
      // another version under the same proof does not verify
      expect(sodium.crypto_sign_verify_detached(fromB64u(h["notes-agent-proof"]), new TextEncoder().encode(message.replace(/\n[^\n]*$/, "\n9.9.9")), fromB64u(w.chat.signKey))).toBe(false);
    }
    expect(nonces.size).toBe(agent.length);
    expect(agent.find((l) => l.method === "POST")!.path).toBe(`/api/agent/vaults/${w.vaultId}/snapshot`);
  });

  it("426 stops the chat: only the update message from then on, no more requests", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools } = w.start();
    w.server.next.push({ status: 426, body: { code: "version", message: "x", update: { npm: "npx --yes @notatki/mcp@1.0.5" } } });
    const r = textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})));
    expect(r).toBe("Ta wersja Notatki MCP jest za stara i ma znane problemy bezpieczeństwa. Zaktualizuj: npx --yes @notatki/mcp@1.0.5.");
    const count = w.server.log.length;
    expect(textOf(await tools.run("read_note", "A.md", () => tools.readNote({ path: "A.md" })))).toBe(r);
    expect(w.server.log.length).toBe(count);
  });

  it("503: the operator message, and no request again within 5 minutes", async () => {
    let now = Date.now();
    const w = await makeWorld({ notes: NOTES });
    const client = new AgentClient({ origin: "https://notatki.test", signSecret: w.chat.signSecret, token: w.token, fetch: w.fetchFn, now: () => now });
    w.server.next.push({ status: 503, body: { code: "disabled", message: "x" } });
    await expect(client.request("GET", "/api/agent/me")).rejects.toThrow("Czaty są chwilowo wyłączone przez operatora serwera.");
    const count = w.server.log.length;
    now += 4 * 60_000;
    await expect(client.request("GET", "/api/agent/me")).rejects.toThrow("Czaty są chwilowo wyłączone");
    expect(w.server.log.length).toBe(count);
    now += 60_001;
    await expect(client.request("GET", "/api/agent/me")).resolves.toMatchObject({ agentId: w.agentId });
  });

  it("paused, out of scope and a lost session give the fixed messages; a lost session empties memory", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    expect(session.vaults.size).toBe(1);
    const view = [...session.vaults.values()][0];
    expect(view.notes.length).toBe(1);

    w.server.next.push({ status: 403, body: { code: "paused", message: "x" } });
    session.vaults.get(w.vaultId)!.fetchedAt = 0;
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Czat wstrzymany");

    expect(session.vaults.size).toBe(0); // paused: nothing decrypted stays in memory
    w.server.next.push({ status: 401, body: { code: "session", message: "x" } });
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toBe("Sesja czatu wygasła. Przedłuż ją w aplikacji Notatki.");
    expect(session.vaults.size).toBe(0);
    expect(view.keys.size).toBe(0);
    expect(view.notes).toEqual([]);
    expect(view.snapshot).toBeNull();
    // the session is renewed in the app: the next call loads again
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("A.md");
  });

  it("the local expiry of the session empties memory too", async () => {
    const w = await makeWorld({ notes: NOTES });
    w.server.sessionExpiresAt = Date.now() + 1500;
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    expect(session.vaults.size).toBe(1);
    await new Promise((r) => setTimeout(r, 1700));
    expect(session.vaults.size).toBe(0);
  });

  it("close zeroes the chat's own secret keys", async () => {
    const w = await makeWorld({ notes: NOTES });
    const { session, tools } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    session.close();
    expect(session.vaults.size).toBe(0);
    expect(session.keys.signSecret.every((b) => b === 0)).toBe(true);
    expect(session.keys.boxSecret.every((b) => b === 0)).toBe(true);
  });
});

describe("version check (docs/MCP.md §10)", () => {
  it("says once per session that a newer version exists", async () => {
    const { checkVersion, newerText } = await import("../src/server");
    const w = await makeWorld({ notes: NOTES, latest: "1.0.1" });
    const { tools } = w.start();
    const said = { done: false };
    expect(await checkVersion("https://notatki.test", tools, said, w.fetchFn)).toBe("npx --yes @notatki/mcp@9.9.9");
    await checkVersion("https://notatki.test", tools, said, w.fetchFn);
    expect(tools.notices).toEqual([newerText("npx --yes @notatki/mcp@9.9.9")]);
    const r = textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})));
    expect(r.startsWith("Dostępna jest nowsza wersja Notatki MCP: npx --yes @notatki/mcp@9.9.9.")).toBe(true);
    expect(tools.notices).toEqual([]);
  });
});
