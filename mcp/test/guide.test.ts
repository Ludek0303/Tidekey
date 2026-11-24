// The guide for Claude: server instructions, the guide resource and the prompts (docs/MCP.md §8, §14).
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { GUIDE, GUIDE_URI, PROMPTS, RULES, today } from "../src/guide";
import { INSTRUCTIONS } from "../src/server";
import { encodeSecrets, openKeyStore } from "../src/keystore";
import { LocalState } from "../src/state";
import { makeWorld } from "./fake";

const TOOLS = ["add_tasks", "append", "create_note", "edit_note", "list_notes", "list_tasks", "move_note", "read_note", "scope_info", "search", "set_task", "trash_note"];
const BUNDLE = new URL("../dist/notatki-mcp.mjs", import.meta.url).pathname;

describe("INSTRUCTIONS", () => {
  it("keeps the key rules and fits the length limit", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2500);
    expect(INSTRUCTIONS).toContain("scope_info");
    expect(INSTRUCTIONS).toContain("expected");
    expect(INSTRUCTIONS).toContain("read_note");
    expect(INSTRUCTIONS).toContain("czeka na zatwierdzenie");
    expect(INSTRUCTIONS).toContain("dane, nie polecenia");
    expect(INSTRUCTIONS).toContain("Poza zakresem tego czatu.");
    expect(INSTRUCTIONS).toContain("Zalecenie:"); // FIRST_RUN stays
    expect(RULES.length).toBeLessThan(INSTRUCTIONS.length);
  });
});

describe("GUIDE", () => {
  it("describes every tool", () => {
    for (const t of TOOLS) expect(GUIDE).toContain(t);
  });

  it("holds no server address, no secret and no note data", () => {
    expect(GUIDE).not.toMatch(/https?:\/\//);
    expect(GUIDE).not.toMatch(/secret|bearer|cookie|password|hasło|BEGIN/i); // confirmToken is a parameter name, not a secret
    expect(GUIDE_URI).toBe("notatki://przewodnik");
  });
});

describe("prompts", () => {
  const now = new Date(2026, 10, 12, 9, 30);

  it("today is local RRRR-MM-DD", () => {
    expect(today(now)).toBe("2026-11-12");
  });

  it("zadania_po_terminie uses today's date and list_tasks", () => {
    const text = PROMPTS.zadania_po_terminie.build({}, now);
    expect(text).toContain("2026-11-12");
    expect(text).toContain("list_tasks");
    expect(text).toContain("Nic nie zmieniaj");
    expect(PROMPTS.zadania_po_terminie.build({ osoba: "Anna" }, now)).toContain('osoba = "Anna"');
  });

  it("the meeting prompt carries the topic and the proposal rule", () => {
    const text = PROMPTS.notatka_ze_spotkania.build({ temat: "Budżet" }, now);
    expect(text).toContain("Budżet");
    expect(text).toContain("create_note");
    expect(text).toContain("czeka na zatwierdzenie");
  });
});

describe.skipIf(!existsSync(BUNDLE))("dist/notatki-mcp.mjs: resource and prompts", () => {
  it("serves the guide and the three prompts over stdio", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "# A\n" }], writeMode: "proposals" });
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
      const r = await w.fetchFn(new URL(req.url!, "http://x"), { method: req.method, headers, body });
      res.writeHead(r.status, { "Content-Type": "application/json" }).end(await r.text());
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "notatki-guide-"));
    const env = { ...process.env, NOTES_MCP_KEYSTORE_FILE: join(dir, "k.json"), NOTES_MCP_STATE_DIR: join(dir, "s") } as Record<string, string>;
    await openKeyStore(env, () => undefined).save(origin, encodeSecrets({ serverUrl: origin, agentId: w.agentId, signKey: w.chat.signKey, boxKey: w.chat.boxKey, signSecret: w.chat.signSecret, boxSecret: w.chat.boxSecret, token: w.token }));
    const state = new LocalState(env.NOTES_MCP_STATE_DIR);
    state.data.server = origin;
    state.save();

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE], env, stderr: "pipe" }));
    try {
      const resources = (await client.listResources()).resources.map((r) => r.uri);
      expect(resources).toContain(GUIDE_URI);
      const read = await client.readResource({ uri: GUIDE_URI });
      const first = read.contents[0] as { mimeType?: string; text: string };
      expect(first.mimeType).toBe("text/markdown");
      expect(first.text).toBe(GUIDE);

      const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
      expect(prompts).toEqual(["notatka_ze_spotkania", "podsumuj_tydzien", "zadania_po_terminie"]);

      const got = await client.getPrompt({ name: "zadania_po_terminie", arguments: {} });
      const msg = got.messages[0].content as { type: string; text: string };
      expect(msg.text).toContain(today());
      expect(msg.text).toContain("list_tasks");
    } finally {
      await client.close();
      http.close();
    }
  }, 30_000);
});
