// The built file (npm run build) as Claude runs it: MCP over stdio against a local fake server.
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { encodeSecrets, openKeyStore } from "../src/keystore";
import { LocalState } from "../src/state";
import { makeWorld } from "./fake";

const BUNDLE = new URL("../dist/notatki-mcp.mjs", import.meta.url).pathname;

describe.skipIf(!existsSync(BUNDLE))("dist/notatki-mcp.mjs", () => {
  it("serves the tools over stdio", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "# A\n- [ ] Zadanie @Anna ^z-0a0a\n" }], writeMode: "proposals" });
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
    const dir = mkdtempSync(join(tmpdir(), "notatki-bundle-"));
    const env = { ...process.env, NOTES_MCP_KEYSTORE_FILE: join(dir, "k.json"), NOTES_MCP_STATE_DIR: join(dir, "s") } as Record<string, string>;
    await openKeyStore(env, () => undefined).save(origin, encodeSecrets({ serverUrl: origin, agentId: w.agentId, signKey: w.chat.signKey, boxKey: w.chat.boxKey, signSecret: w.chat.signSecret, boxSecret: w.chat.boxSecret, token: w.token }));
    const state = new LocalState(env.NOTES_MCP_STATE_DIR);
    state.data.server = origin;
    state.save();

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE], env, stderr: "pipe" }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(["add_tasks", "append", "create_note", "edit_note", "find_files", "list_notes", "list_tasks", "map", "move_note", "neighbors", "outline", "read", "read_note", "scope_info", "search", "set_task", "trash_note"]);
      const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
      const tasks = text(await client.callTool({ name: "list_tasks", arguments: {} }));
      expect(tasks).toContain("z-0a0a");
      expect(tasks).toContain("Zalecenie:"); // §8, on the first run
      expect(text(await client.callTool({ name: "append", arguments: { path: "A.md", text: "x" } }))).toContain("Propozycja czeka na zatwierdzenie.");
      expect(w.server.proposals).toHaveLength(1);
    } finally {
      await client.close();
      http.close();
    }
  }, 30_000);
});
