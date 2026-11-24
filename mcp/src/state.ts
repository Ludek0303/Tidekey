// Local state that is not secret (docs/MCP.md §5.1, §8): the person's pinned keys (TOFU), the newest scope seen per
// vault, the server last paired, and the chat's log (time, tool, path; never content, keys, tokens or codes).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Pin { userId: string; signingKey: JsonWebKey; boxKey: JsonWebKey }
interface Data { server?: string; firstRunShown?: boolean; pins: Record<string, Pin>; scopes: Record<string, Record<string, number>> }

export const stateDir = (env: NodeJS.ProcessEnv = process.env): string => env.NOTES_MCP_STATE_DIR || join(homedir(), ".config", "notatki-mcp");

export class LocalState {
  data: Data = { pins: {}, scopes: {} };
  private readonly file: string;
  private readonly logFile: string;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.file = join(dir, "stan.json");
    this.logFile = join(dir, "dziennik.log");
    if (existsSync(this.file)) this.data = { pins: {}, scopes: {}, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<Data>) };
  }
  save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
  /** One log line: time, tool, path. Control characters in a path (tabs, line breaks, terminal escapes) become spaces, so a line stays one entry. */
  log(tool: string, path?: string): void {
    const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
    appendFileSync(this.logFile, `${new Date().toISOString()}\t${clean(tool)}\t${clean(path ?? "")}\n`, { mode: 0o600 });
    chmodSync(this.logFile, 0o600);
  }
  forget(origin: string): void {
    delete this.data.pins[origin];
    delete this.data.scopes[origin];
    if (this.data.server === origin) delete this.data.server;
    this.save();
  }
}
