// notatki-mcp: `pair <https://host> [--okno]`, `forget [https://host]`, or (no arguments) the MCP server on stdio.
import wasmBase64 from "virtual:notes-wasm";
import { initSync } from "../../ui/src/wasm/notes_web.js";
import { AgentClient } from "./client";
import { decodeSecrets, openKeyStore } from "./keystore";
import { codeWindow, openBrowser, originOf, pair, readCode } from "./pair";
import { serveStdio } from "./server";
import { Session } from "./session";
import { zero } from "./sodium";
import { LocalState, stateDir } from "./state";

const HELP = `Notatki MCP
  notatki-mcp pair https://adres-notatek [--okno]   sparowanie czatu (kod z aplikacji Notatki)
  notatki-mcp forget [https://adres-notatek]         usunięcie kluczy czatu z tego komputera
  notatki-mcp                                        serwer MCP dla Claude (stdio)`;
const say = (line: string) => process.stderr.write(`${line}\n`);

async function main(args: string[]): Promise<void> {
  // the task parser of the core (orgtasks.ts), embedded in this file
  initSync({ module: Buffer.from(wasmBase64, "base64") });
  const state = new LocalState(stateDir());
  const [command, address] = args;
  if (command === "--help" || command === "-h") { say(HELP); return; }
  if (command === "pair") {
    const okno = args.includes("--okno");
    const getCode = okno
      ? () => codeWindow((url) => { say(`Wpisz kod parowania w oknie przeglądarki: ${url}`); openBrowser(url); })
      : () => readCode();
    await pair(address, { store: openKeyStore(), state, getCode, print: say });
    return;
  }
  if (command === "forget") {
    const origin = address ? originOf(address) : state.data.server;
    if (!origin) { say("Nie ma sparowanego czatu na tym komputerze."); return; }
    await openKeyStore().remove(origin);
    state.forget(origin);
    say("Klucze czatu usunięte z tego komputera. Odłącz czat także w aplikacji: Ustawienia → Urządzenia → Odłącz.");
    return;
  }
  if (command !== undefined) { say(HELP); process.exitCode = 2; return; }

  const origin = process.env.NOTES_MCP_SERVER ? originOf(process.env.NOTES_MCP_SERVER) : state.data.server;
  const blob = origin ? await openKeyStore().load(origin) : null;
  if (!origin || !blob) { say("Najpierw sparuj czat: notatki-mcp pair https://adres-notatek"); process.exitCode = 1; return; }
  const secrets = decodeSecrets(blob);
  zero(blob);
  const client = new AgentClient({ origin, signSecret: secrets.signSecret, token: secrets.token });
  const session = new Session(client, { agentId: secrets.agentId, signKey: secrets.signKey, boxKey: secrets.boxKey, signSecret: secrets.signSecret, boxSecret: secrets.boxSecret }, state, origin);
  const close = () => { session.close(); zero(secrets.token); };
  process.on("exit", close);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => { close(); process.exit(0); });
  await serveStdio(session, state, origin);
}

main(process.argv.slice(2)).catch((e: unknown) => { say(e instanceof Error ? e.message : "Błąd."); process.exitCode = 1; });
