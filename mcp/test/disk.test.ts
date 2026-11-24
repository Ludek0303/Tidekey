import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { blake2bHex, b64u, checkCode, fromB64u } from "../../ui/src/agentcrypto";
import { bytesToBase64 } from "../../ui/src/vaults";
import { decodeSecrets, FILE_WARNING, openKeyStore } from "../src/keystore";
import { pair } from "../src/pair";
import { LocalState } from "../src/state";
import { makeWorld, textOf } from "./fake";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const filesOf = (dir: string): string => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

describe("nothing secret on disk (docs/MCP.md §5.1, §8)", () => {
  it("state and log hold no note text, content key, token or chat secret after the tools ran", async () => {
    const w = await makeWorld({ notes: [{ path: "Dziennik/Dzień.md", text: "# Dzień\nzawartośćPoufna\n- [ ] ZadaniePoufne @Anna ^z-0101\n" }], projects: [{ path: "Projekty/P", forChat: true, notes: [{ path: "Projekty/P/X.md", text: "projektPoufny\n" }] }] });
    const { tools } = w.start();
    const runs = [
      () => tools.listNotes({}), () => tools.search({ q: "Poufn" }), () => tools.readNote({ path: "Dziennik/Dzień.md" }),
      () => tools.readNote({ path: "Projekty/P/X.md" }), () => tools.listTasks({}), () => tools.scopeInfo(),
      () => tools.createNote({ path: "Dziennik/Nowa.md", text: "nowaPoufna\n" }), () => tools.append({ path: "Dziennik/Dzień.md", text: "dopisekPoufny" }),
    ];
    for (const run of runs) expect(textOf(await tools.run("narzędzie", "Dziennik/Dzień.md", run))).not.toContain("Błąd");
    const disk = filesOf(w.stateDir);
    for (const secret of ["zawartośćPoufna", "ZadaniePoufne", "projektPoufny", "nowaPoufna", "dopisekPoufny", "Poufn"]) expect(disk).not.toContain(secret);
    for (const raw of [w.raw, ...w.projectKeys.map((k) => k.raw), w.token, w.chat.signSecret, w.chat.boxSecret])
      for (const form of [hex(raw), bytesToBase64(raw), b64u(raw)]) expect(disk).not.toContain(form);
    const log = readFileSync(join(w.stateDir, "dziennik.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(runs.length);
    for (const line of log) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[^\t]+\tnarzędzie\tDziennik\/Dzień\.md$/);
    for (const f of readdirSync(w.stateDir)) expect(statSync(join(w.stateDir, f)).mode & 0o777).toBe(0o600);
    expect(statSync(w.stateDir).mode & 0o777).toBe(0o700);
  });
});

describe("pairing (docs/MCP.md §3.2)", () => {
  it("claims with proof, shows the check code, polls with proof, stores the keys; the code reaches no log or file", async () => {
    await sodium.ready;
    const dir = mkdtempSync(join(tmpdir(), "notatki-pair-"));
    const keystoreFile = join(dir, "klucze.json");
    const state = new LocalState(join(dir, "stan"));
    const warnings: string[] = [];
    const store = openKeyStore({ NOTES_MCP_KEYSTORE_FILE: keystoreFile }, (m) => warnings.push(m));
    expect(warnings).toEqual([FILE_WARNING]);
    const sessionToken = "ab".repeat(32);
    const agentId = "cd".repeat(16);
    let claim: { code: string; signKey: string; boxKey: string; proof: string; device: { name: string; os: string }; mcpVersion: string } | null = null;
    let polls = 0;
    const fetchFn = (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = init.headers as Record<string, string>;
      if (url.pathname === "/api/agent-pair/claim") {
        claim = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ pairingId: "p1", pairToken: "TOKEN_abcdefghijklmnop" }), { status: 200 });
      }
      if (url.pathname === "/api/agent-pair/TOKEN_abcdefghijklmnop") {
        const message = `notes-agent-req-v1\nGET\n${url.pathname}\n${await blake2bHex(new Uint8Array())}\n${headers["Notes-Agent-Time"]}\n${headers["Notes-Agent-Nonce"]}\n${headers["Notes-Agent-Version"]}`;
        expect(sodium.crypto_sign_verify_detached(fromB64u(headers["Notes-Agent-Proof"]), new TextEncoder().encode(message), fromB64u(claim!.signKey))).toBe(true);
        expect(headers.Authorization).toBeUndefined();
        if (++polls < 3) return new Response(JSON.stringify({ code: "waiting", message: "x" }), { status: 404 });
        return new Response(JSON.stringify({ sessionToken, agentId, expiresAt: Date.now() + 3_600_000 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const printed: string[] = [];
    const opened: string[] = [];
    await pair("https://notatki.test/", { store, state, fetch: fetchFn, getCode: async () => "k7qm-3xrp", print: (l) => printed.push(l), open: (u) => opened.push(u), sleep: async () => undefined });

    const c = claim!;
    expect(c.code).toBe("K7QM3XRP");
    const proofMessage = `notes agent-claim v1\nK7QM3XRP\n${c.signKey}\n${c.boxKey}`;
    expect(sodium.crypto_sign_verify_detached(fromB64u(c.proof), new TextEncoder().encode(proofMessage), fromB64u(c.signKey))).toBe(true);
    expect(c.mcpVersion).toBe("1.0.0");
    expect(polls).toBe(3);
    expect(printed.join("\n")).toContain(`Kod kontrolny: ${await checkCode(c.signKey, c.boxKey, "K7QM3XRP")}`);
    expect(opened).toEqual([`https://notatki.test/?pair-agent=TOKEN_abcdefghijklmnop#a=${c.signKey}.${c.boxKey}&c=K7QM3XRP`]);
    // apart from the browser address (its fragment never reaches a server), nothing printed holds the code
    expect(printed.filter((l) => !l.includes("?pair-agent=")).join("\n")).not.toMatch(/K7QM-?3XRP/i);

    const stored = decodeSecrets((await store.load("https://notatki.test"))!);
    expect(stored).toMatchObject({ serverUrl: "https://notatki.test", agentId, signKey: c.signKey, boxKey: c.boxKey });
    expect(hex(stored.token)).toBe(sessionToken);
    expect(b64u(stored.signSecret.slice(32))).toBe(c.signKey); // an Ed25519 secret key ends with its public key
    expect(statSync(keystoreFile).mode & 0o777).toBe(0o600);
    expect(state.data.server).toBe("https://notatki.test");
    for (const text of [readFileSync(keystoreFile, "utf8"), filesOf(state.dir)]) expect(text).not.toMatch(/K7QM-?3XRP/i);

    expect(await store.remove("https://notatki.test")).toBe(true);
    expect(await store.load("https://notatki.test")).toBeNull();
  });

  it("a code that is not a pairing code goes nowhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notatki-pair-"));
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(pair("https://notatki.test", { store: openKeyStore({ NOTES_MCP_KEYSTORE_FILE: join(dir, "k.json") }, () => undefined), state: new LocalState(join(dir, "s")), fetch: fetchFn, getCode: async () => "hasło123", print: () => undefined, open: () => undefined })).rejects.toThrow("To nie jest kod parowania");
    expect(calls).toBe(0);
    await expect(pair("http://notatki.test", { store: openKeyStore({ NOTES_MCP_KEYSTORE_FILE: join(dir, "k.json") }, () => undefined), state: new LocalState(join(dir, "s")), fetch: fetchFn, getCode: async () => "K7QM3XRP", print: () => undefined })).rejects.toThrow("Podaj adres");
  });
});

describe("local code window (--okno)", () => {
  it("answers only its random path, takes one valid code, then closes", async () => {
    const { codeWindow } = await import("../src/pair");
    let url = "";
    const code = codeWindow((u) => { url = u; });
    while (!url) await new Promise((r) => setTimeout(r, 5));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    const base = new URL(url);
    expect((await fetch(new URL("/", base))).status).toBe(404);
    expect((await fetch(url)).status).toBe(200);
    const post = (body: string, origin = base.origin) => fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin } });
    expect((await post("code=K7QM3XRP", "https://evil.example")).status).toBe(403);
    expect(await (await post("code=zly")).text()).toContain("To nie jest kod parowania");
    expect((await post("code=K7QM-3XRP")).status).toBe(200);
    expect(await code).toBe("K7QM-3XRP");
    await expect(fetch(url)).rejects.toThrow();
  });
});
