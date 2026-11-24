// `notatki-mcp pair <https://host> [--okno]` (docs/MCP.md §3.2): the pairing code is typed by the person (terminal
// without echo, one stdin line when not a terminal, or a one-time local form), never passed as an argument and never
// written to the log. The chat's keys are made here; only their public halves leave the machine.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { checkCode, claimProof, generateAgentKeys, newNonce, normalizeCode, validCode, type AgentKeyPair } from "../../ui/src/agentcrypto";
import { AgentClient, AgentError, TEXT } from "./client";
import { encodeSecrets, type KeyStore } from "./keystore";
import { zero } from "./sodium";
import type { LocalState } from "./state";
import { VERSION } from "./version";

const TEN_MIN = 10 * 60_000;
export const PAIR_TEXT = {
  badUrl: "Podaj adres serwera Notatek, np. https://notatki.example.pl.",
  badCode: "To nie jest kod parowania (8 znaków, np. K7QM-3XRP).",
  claimFailed: "Serwer nie przyjął kodu: kod jest zły, wygasł albo został już użyty. Rozpocznij parowanie w aplikacji od nowa.",
  timeout: "Parowanie nie zostało dokończone w aplikacji w ciągu 10 minut. Rozpocznij je od nowa.",
  done: "Gotowe. Czat jest sparowany. Podłącz go do Claude (np. claude mcp add --scope user notatki -- npx --yes @notatki/mcp@1.0.0).",
};

/** The origin of the server address: https, or http only on this machine (tests, local servers). */
export function originOf(address: string | undefined): string {
  try {
    const url = new URL(address ?? "");
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  } catch { /* falls through */ }
  throw new Error(PAIR_TEXT.badUrl);
}

/** Reads the code from a terminal without echo (raw mode), or one line of a non-terminal stdin. */
export function readCode(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const at = buffer.indexOf("\n");
        if (at >= 0 || buffer.length > 200) { input.off("data", onData); input.pause(); resolve(buffer.slice(0, at >= 0 ? at : 200).trim()); }
      };
      input.on("data", onData);
      input.once("end", () => resolve(buffer.trim()));
      return;
    }
    output.write("Kod parowania z aplikacji (nie będzie widoczny): ");
    input.setRawMode(true);
    input.resume();
    let code = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\u0003") { done(); reject(new Error("Przerwano.")); return; }
        if (ch === "\r" || ch === "\n") { done(); resolve(code.trim()); return; }
        if (ch === "\u007f" || ch === "\b") code = code.slice(0, -1);
        else if (code.length < 64) code += ch;
      }
    };
    const done = () => { input.off("data", onData); input.setRawMode(false); input.pause(); output.write("\n"); };
    input.on("data", onData);
  });
}

const FORM = (action: string, error = "") => `<!doctype html><html lang="pl"><meta charset="utf-8"><title>Notatki: parowanie Claude</title>
<body style="font-family:sans-serif;max-width:28rem;margin:3rem auto"><h1>Parowanie Claude</h1>
<p>Wpisz kod parowania z aplikacji Notatki. Nikt z obsługi Notatek nigdy o niego nie poprosi.</p>${error ? `<p style="color:#b00">${error}</p>` : ""}
<form method="post" action="${action}"><input name="code" autocomplete="off" autofocus required maxlength="20" style="font-size:1.4rem;letter-spacing:.2em">
<button>Dalej</button></form></body></html>`;
const DONE_PAGE = `<!doctype html><html lang="pl"><meta charset="utf-8"><title>Notatki</title><body style="font-family:sans-serif;max-width:28rem;margin:3rem auto"><p>Kod przyjęty. Możesz zamknąć to okno i wrócić do terminala.</p></body></html>`;

/**
 * A one-time local form on 127.0.0.1 at a random port and a random 32-hex path. Closes after one valid code or 10
 * minutes. Only that path answers, only with the expected Host, and a POST must come from that same origin.
 */
export function codeWindow(onUrl: (url: string) => void, timeoutMs = TEN_MIN): Promise<string> {
  const secretPath = `/${newNonce()}`;
  return new Promise((resolve, reject) => {
    let host = "";
    const server = createServer((req, res) => {
      const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
      if (req.headers.host !== host || req.url !== secretPath) { res.writeHead(404, headers).end(); return; }
      if (req.method === "GET") { res.writeHead(200, headers).end(FORM(secretPath)); return; }
      if (req.method !== "POST" || (req.headers.origin && req.headers.origin !== `http://${host}`)) { res.writeHead(403, headers).end(); return; }
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); if (body.length > 1024) req.destroy(); });
      req.on("end", () => {
        const code = new URLSearchParams(body).get("code")?.trim() ?? "";
        if (!validCode(code)) { res.writeHead(200, headers).end(FORM(secretPath, PAIR_TEXT.badCode)); return; }
        res.writeHead(200, headers).end(DONE_PAGE);
        finish();
        resolve(code);
      });
    });
    const timer = setTimeout(() => { finish(); reject(new Error(PAIR_TEXT.timeout)); }, timeoutMs);
    const finish = () => { clearTimeout(timer); server.close(); server.closeAllConnections(); };
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      host = `127.0.0.1:${port}`;
      onUrl(`http://${host}${secretPath}`);
    });
  });
}

/** Opens a URL in the default browser, without a shell (the URL carries `&`). */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref(); } catch { /* the address is printed anyway */ }
}

export interface PairDeps {
  store: KeyStore; state: LocalState; fetch?: typeof fetch; getCode: () => Promise<string>;
  print: (line: string) => void; open?: (url: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number;
}

export async function pair(address: string, deps: PairDeps): Promise<void> {
  const origin = originOf(address);
  const code = normalizeCode(await deps.getCode());
  if (!validCode(code)) throw new Error(PAIR_TEXT.badCode);
  const keys: AgentKeyPair = await generateAgentKeys();
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  try {
    const claim = { code, signKey: keys.signKey, boxKey: keys.boxKey, device: { name: hostname(), os: process.platform }, mcpVersion: VERSION, proof: await claimProof(code, keys) };
    const r = await fetchFn(new URL("/api/agent-pair/claim", origin), { method: "POST", headers: { "Content-Type": "application/json", "Notes-Agent-Version": VERSION }, body: JSON.stringify(claim), redirect: "error" });
    const answer = (await r.json().catch(() => ({}))) as { pairToken?: string; update?: { npm?: string } };
    if (r.status === 426) throw new Error(TEXT.old(answer.update?.npm ?? "npx --yes @notatki/mcp@latest"));
    if (r.status === 503) throw new Error(TEXT.disabled);
    if (r.status === 429) throw new Error(TEXT.limit);
    if (!r.ok || typeof answer.pairToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(answer.pairToken)) throw new Error(PAIR_TEXT.claimFailed);
    const pairToken = answer.pairToken;

    deps.print(`Kod kontrolny: ${await checkCode(keys.signKey, keys.boxKey, code)}. Sprawdź, czy przeglądarka pokazuje ten sam.`);
    const link = `${origin}/?pair-agent=${encodeURIComponent(pairToken)}#a=${keys.signKey}.${keys.boxKey}&c=${code}`;
    (deps.open ?? openBrowser)(link);
    deps.print(`Dokończ parowanie w przeglądarce. Jeśli się nie otworzyła, otwórz ten adres w przeglądarce, w której rozpocząłeś parowanie:\n${link}`);

    const client = new AgentClient({ origin, signSecret: keys.signSecret, fetch: fetchFn, now });
    const until = now() + TEN_MIN;
    let session: { sessionToken: string; agentId: string } | null = null;
    while (!session) {
      if (now() > until) throw new Error(PAIR_TEXT.timeout);
      try {
        session = await client.request("GET", `/api/agent-pair/${encodeURIComponent(pairToken)}`, undefined, false);
      } catch (e) {
        const again = e instanceof AgentError && (e.kind === "waiting" || e.kind === "limit" || e.status === 0);
        if (!again) throw e instanceof AgentError && e.kind === "gone" ? new Error(PAIR_TEXT.claimFailed) : e;
        await sleep(2000);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(session.sessionToken) || !/^[0-9a-f]{32}$/.test(session.agentId)) throw new Error(TEXT.failed);
    const token = Uint8Array.from(session.sessionToken.match(/../g)!, (h) => Number.parseInt(h, 16));
    const blob = encodeSecrets({ serverUrl: origin, agentId: session.agentId, signKey: keys.signKey, boxKey: keys.boxKey, signSecret: keys.signSecret, boxSecret: keys.boxSecret, token });
    await deps.store.save(origin, blob);
    zero(blob, token);
    // a new pairing trusts the person's keys anew (TOFU on first use)
    deps.state.forget(origin);
    deps.state.data.server = origin;
    deps.state.save();
    deps.print(PAIR_TEXT.done);
  } finally {
    zero(keys.signSecret, keys.boxSecret);
  }
}
