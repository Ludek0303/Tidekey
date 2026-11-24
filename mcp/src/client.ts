// HTTP to notes-node as a chat: every request carries the proof of docs/MCP.md §5.2 (contract: WEB-WSPOLDZIELENIE.md
// "Request proof"). Server answers become the fixed Polish messages of §5.3, §5.5, §10 and §18.4; the server's own
// message text is never passed on.
import { newNonce, requestProof } from "../../ui/src/agentcrypto";
import { VERSION } from "./version";

export const TEXT = {
  session: "Sesja czatu wygasła. Przedłuż ją w aplikacji Notatki.",
  disabled: "Czaty są chwilowo wyłączone przez operatora serwera.",
  paused: "Czat wstrzymany: nowy adres IP albo przekroczone limity. Jeśli to Ty, kliknij „Potwierdź” w Notatki → Ustawienia → Urządzenia → czat. Jeśli nie, kliknij „Odłącz”.",
  scope: "Poza zakresem tego czatu.",
  readOnly: "Ten czat ma tylko odczyt w tej przestrzeni.",
  limit: "Za dużo żądań czatu. Spróbuj za chwilę.",
  proof: "Serwer odrzucił podpis żądania czatu. Sparuj czat od nowa.",
  failed: "Serwer Notatek nie odpowiada poprawnie. Spróbuj później.",
  old: (command: string) => `Ta wersja Notatki MCP jest za stara i ma znane problemy bezpieczeństwa. Zaktualizuj: ${command}.`,
};
const DISABLED_PAUSE_MS = 5 * 60_000;

export type ErrorKind = "session" | "disabled" | "paused" | "scope" | "read-only" | "limit" | "version" | "proof" | "conflict" | "stale-key" | "waiting" | "gone" | "other";
export class AgentError extends Error {
  constructor(message: string, readonly kind: ErrorKind, readonly status: number, readonly body: Record<string, unknown> = {}) { super(message); }
}

export interface ClientOptions {
  origin: string;
  signSecret: Uint8Array;
  token?: Uint8Array | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** The update command for a 426 (from GET /api/version), when known. */
  updateCommand?: () => string | undefined;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export class AgentClient {
  /** Set after a 426: the chat stops and answers only this. */
  dead: string | null = null;
  private disabledUntil = 0;
  constructor(readonly opts: ClientOptions) {}
  private get fetch(): typeof fetch { return this.opts.fetch ?? fetch; }
  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** A signed request. `auth: false` leaves out the session token (the pairing poll). */
  async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    return this.answer<T>(await this.send(method, path, body, auth));
  }

  /** A signed GET whose answer is bytes (a text layer's ciphertext): at most `max` of them, else a failure. */
  async requestBytes(path: string, max: number): Promise<Uint8Array> {
    const response = await this.send("GET", path, undefined, true);
    if (!response.ok) return this.answer<never>(response);
    const reader = response.body?.getReader();
    if (!reader) throw new AgentError(TEXT.failed, "other", response.status);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { await reader.cancel(); throw new AgentError(TEXT.failed, "other", response.status); }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  private async send(method: string, path: string, body: unknown, auth: boolean): Promise<Response> {
    if (this.dead) throw new AgentError(this.dead, "version", 426);
    if (this.now() < this.disabledUntil) throw new AgentError(TEXT.disabled, "disabled", 503);
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const time = this.now();
    const nonce = newNonce();
    const proof = await requestProof({ method, pathAndQuery: path, body: bytes, time, nonce, version: VERSION }, this.opts.signSecret);
    const headers: Record<string, string> = { "Notes-Agent-Time": String(time), "Notes-Agent-Nonce": nonce, "Notes-Agent-Version": VERSION, "Notes-Agent-Proof": proof };
    if (auth && this.opts.token) headers.Authorization = `NotesAgent ${hex(this.opts.token)}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.opts.origin), { method, headers, body: body === undefined ? undefined : bytes, redirect: "error" });
    } catch {
      throw new AgentError(TEXT.failed, "other", 0);
    }
    return response;
  }

  private async answer<T>(response: Response): Promise<T> {
    const parsed: unknown = await response.json().catch(() => undefined);
    // every answer of the contract is a JSON object; anything else is a server fault, never passed on as data
    const json = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    if (response.ok) { if (json !== parsed) throw new AgentError(TEXT.failed, "other", response.status); return json as T; }
    const code = typeof json.code === "string" ? json.code : "";
    const status = response.status;
    const fail = (message: string, kind: ErrorKind) => new AgentError(message, kind, status, json);
    if (status === 426) {
      const update = (json.update as { npm?: unknown } | undefined)?.npm;
      this.dead = TEXT.old(typeof update === "string" ? update : this.opts.updateCommand?.() ?? "npx --yes @notatki/mcp@latest");
      throw fail(this.dead, "version");
    }
    if (status === 503) { this.disabledUntil = this.now() + DISABLED_PAUSE_MS; throw fail(TEXT.disabled, "disabled"); }
    if (status === 401) throw code === "proof" ? fail(TEXT.proof, "proof") : fail(TEXT.session, "session");
    if (status === 403 && code === "paused") throw fail(TEXT.paused, "paused");
    if (status === 403 && code === "read-only") throw fail(TEXT.readOnly, "read-only");
    if (status === 404 && code === "waiting") throw fail("waiting", "waiting");
    if (status === 404) throw fail(TEXT.scope, "scope");
    if (status === 409) throw fail(TEXT.failed, code === "stale-key" ? "stale-key" : "conflict");
    if (status === 410) throw fail(TEXT.failed, "gone");
    if (status === 429) throw fail(TEXT.limit, "limit");
    throw fail(TEXT.failed, "other");
  }
}
