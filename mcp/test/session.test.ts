// The session of a chat (docs/MCP.md §3.5, §3.9, §5.1, §5.3, §12): what crosses the wire, what stays in memory, and
// how rotation, scope changes, renewals and limits are taken.
import { describe, expect, it } from "vitest";
import { b64u, sealScope } from "../../ui/src/agentcrypto";
import { bytesToBase64 } from "../../ui/src/vaults";
import { pair } from "../src/pair";
import { openKeyStore } from "../src/keystore";
import { LocalState } from "../src/state";
import { identity, makeWorld, RAW_NULL, textOf } from "./fake";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const forms = (raw: Uint8Array) => [hex(raw), bytesToBase64(raw), b64u(raw)];
const SECRET_NOTES = [{ path: "Dziennik/A.md", text: "# A\ntekstPoufnyA\n- [ ] zadaniePoufne @Anna ^z-0a01\n" }];

/** Every Uint8Array and string reachable from `root` (cycles and CryptoKeys are skipped). */
function reachable(root: unknown): { bytes: Uint8Array[]; strings: string[] } {
  const seen = new Set<unknown>();
  const out = { bytes: [] as Uint8Array[], strings: [] as string[] };
  const walk = (v: unknown) => {
    if (typeof v === "string") { out.strings.push(v); return; }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Uint8Array) { out.bytes.push(v); return; }
    if (v instanceof Map) { for (const [k, x] of v) { walk(k); walk(x); } return; }
    for (const x of Object.values(v)) walk(x);
  };
  walk(root);
  return out;
}

describe("nothing secret on the wire or held in the clear (docs/MCP.md §5.1, §12)", () => {
  it("the traffic holds no vault or project key in the clear, no note text, and only chat routes", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES, projects: [{ path: "Projekty/P", forChat: true, notes: [{ path: "Projekty/P/X.md", text: "projektPoufny\n" }] }] });
    const { tools } = w.start();
    const runs = [
      () => tools.listNotes({}), () => tools.search({ q: "Poufn" }), () => tools.readNote({ path: "Dziennik/A.md" }), () => tools.readNote({ path: "Projekty/P/X.md" }),
      () => tools.listTasks({}), () => tools.append({ path: "Dziennik/A.md", text: "dopisekPoufny" }), () => tools.append({ path: "Projekty/P/X.md", text: "propozycjaPoufna" }),
      () => tools.createNote({ path: "Dziennik/Nowa.md", text: "nowaPoufna" }),
    ];
    for (const r of runs) expect(textOf(await tools.run("t", undefined, r))).not.toContain("nie odpowiada");
    expect(w.server.proposals).toHaveLength(1);
    const wire = w.server.log.map((l) => `${l.method} ${l.path}\n${JSON.stringify(l.headers)}\n${l.body}`).join("\n");
    for (const s of ["tekstPoufnyA", "zadaniePoufne", "projektPoufny", "dopisekPoufny", "propozycjaPoufna", "nowaPoufna", "Poufn"]) expect(wire).not.toContain(s);
    for (const raw of [w.raw, ...w.projectKeys.map((k) => k.raw), w.chat.signSecret, w.chat.boxSecret]) for (const f of forms(raw)) expect(wire).not.toContain(f);
    // the MCP has no recovery code, personal key or password to send: it calls only the chat routes
    for (const l of w.server.log) expect(l.path).toMatch(/^\/api\/(agent\/|version$)/);
  });

  it("held keys are non-extractable CryptoKeys; the session holds no raw key bytes", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES, projects: [{ path: "Projekty/P", forChat: true, notes: [{ path: "Projekty/P/X.md", text: "p\n" }] }] });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    const view = session.vaults.get(w.vaultId)!;
    expect(view.keys.size).toBe(1);
    for (const k of [...view.keys.values(), ...view.projects.map((p) => p.key)]) { expect(k).toBeInstanceOf(CryptoKey); expect(k.extractable).toBe(false); }
    const { bytes, strings } = reachable(session);
    const raws = [w.raw, ...w.projectKeys.map((k) => k.raw)];
    for (const b of bytes) for (const raw of raws) expect(hex(b).includes(hex(raw))).toBe(false);
    for (const s of strings) for (const raw of raws) for (const f of forms(raw)) expect(s.includes(f)).toBe(false);
  });
});

describe("sealed scope (docs/MCP.md §3.5)", () => {
  it("a scope signed by someone else, or a box that does not open, makes the vault unavailable", async () => {
    for (const bad of ["signer", "box"] as const) {
      const w = await makeWorld({ notes: SECRET_NOTES });
      w.meta.sealedScope = bad === "signer"
        ? await sealScope({ ...w.scope, include: [] }, await identity(w.userId), w.chat.boxKey)
        : { ...w.meta.sealedScope, box: w.meta.sealedScope.box.slice(0, -4) + "AAAA" };
      const { tools, session } = w.start();
      expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Notatek: 0.");
      expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Dziennik/A.md" })))).toBe("Poza zakresem tego czatu.");
      expect(textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()))).toContain("Niedostępne przestrzenie: 1");
      expect(session.vaults.size).toBe(0);
    }
  });
});

describe("key rotation (docs/MCP.md §3.5, §12)", () => {
  it("with a new envelope the chat reads the new epoch's snapshot", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    await w.rotate(true);
    await w.editOnServer(async (b) => { await b.call("create_note", { path: "Dziennik/Po rotacji.md" }); });
    session.vaults.get(w.vaultId)!.fetchedAt = 0;
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Po rotacji");
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Dziennik/A.md", text: "po rotacji" })))).toBe("Zapisano.");
    expect((await w.texts()).get("Dziennik/A.md")).toContain("po rotacji");
  });

  it("without a new envelope it refuses cleanly: the vault is gone from memory, nothing old is shown", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    const old = session.vaults.get(w.vaultId)!;
    await w.rotate(false);
    old.fetchedAt = 0;
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Notatek: 0.");
    expect(textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()))).toContain("Niedostępne przestrzenie: 1");
    expect(session.vaults.size).toBe(0);
    expect(old.keys.size).toBe(0);
    expect(old.notes).toEqual([]);
    expect(old.snapshot).toBeNull();
  });

  it("a write that meets the new epoch takes the new envelope and writes at once, without a full fetch", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES });
    const { tools } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    await w.rotate(true);
    const fetches = () => w.server.log.filter((l) => l.method === "GET" && l.path.includes("/snapshot")).length;
    const before = fetches();
    expect(textOf(await tools.run("append", "x", () => tools.append({ path: "Dziennik/A.md", text: "druga" })))).toBe("Zapisano.");
    expect(fetches()).toBe(before); // the last full fetch was under 5 minutes ago: the 409 brought the newest state
    expect(w.server.log.filter((l) => l.method === "GET" && l.path === `/api/agent/vaults/${w.vaultId}`).length).toBeGreaterThan(1);
    expect((await w.decrypted()).state.notes.length).toBe(1);
    expect((await w.texts()).get("Dziennik/A.md")).toMatch(/druga$/);
  });

  it("a protected project taken out of the scope (its envelope dropped): its notes are gone at the next refresh", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES, projects: [{ path: "Projekty/P", forChat: true, notes: [{ path: "Projekty/P/X.md", text: "projektowe\n" }] }] });
    const { tools, session } = w.start();
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Projekty/P/X.md" })))).toContain("projektowe");
    await w.mutate((s) => { for (const e of s.state.protected ?? []) (e as { agentKeys?: unknown[] }).agentKeys = []; });
    session.vaults.get(w.vaultId)!.fetchedAt = 0;
    expect(textOf(await tools.run("read_note", "x", () => tools.readNote({ path: "Projekty/P/X.md" })))).toBe("Poza zakresem tego czatu.");
    expect(textOf(await tools.run("search", undefined, () => tools.search({ q: "projektowe" })))).toContain("Wyników: 0");
    expect(textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()))).not.toContain("Projekty/P");
    expect(session.vaults.get(w.vaultId)!.projects).toEqual([]);
  });
});

describe("two vaults, one chat (docs/MCP.md §3.9)", () => {
  it("different write modes work independently", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "a\n" }], writeMode: "proposals", others: [{ notes: [{ path: "B.md", text: "b\n" }], writeMode: "direct" }] });
    const [klub, inny] = w.vaults;
    const { tools } = w.start();
    expect(textOf(await tools.run("append", "A.md", () => tools.append({ path: "A.md", text: "x" })))).toContain("kilka przestrzeni");
    expect(textOf(await tools.run("append", "A.md", () => tools.append({ path: "A.md", text: "x", vault: klub.name })))).toBe("Propozycja czeka na zatwierdzenie.");
    expect(textOf(await tools.run("append", "B.md", () => tools.append({ path: "B.md", text: "y", vault: inny.vaultId })))).toBe("Zapisano.");
    expect(textOf(await tools.run("append", "B.md", () => tools.append({ path: "B.md", text: "x", vault: klub.name })))).toBe("Poza zakresem tego czatu.");
    expect(klub.store.revision).toBe(1);
    expect(inny.store.revision).toBe(2);
    expect((await w.texts(inny)).get("B.md")).toBe("b\ny");
    const info = textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()));
    expect(info).toContain("propozycje do zatwierdzenia");
    expect(info).toContain("zmiany bezpośrednie");
  });

  it("a vault added to the cert and scope later is picked up at the next tool, without a restart", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "a\n" }], others: [{ notes: [{ path: "B.md", text: "b\n" }] }] });
    const second = w.vaults[1];
    second.inCert = false;
    second.listed = false;
    await w.resign();
    const { tools } = w.start();
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).not.toContain("B.md");
    second.inCert = true;
    second.listed = true;
    await w.resign();
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("B.md");
  });

  it("proposals of a vault taken out of the scope are not listed any more; another session's are not listed", async () => {
    const w = await makeWorld({ notes: [{ path: "A.md", text: "a\n" }], writeMode: "proposals", others: [{ notes: [{ path: "Tajne/B.md", text: "b\n" }], writeMode: "proposals" }] });
    const [klub, inny] = w.vaults;
    const { tools } = w.start();
    await tools.run("append", "x", () => tools.append({ path: "Tajne/B.md", text: "x", vault: inny.vaultId }));
    expect(textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()))).toContain("Tajne/B.md");
    const other = w.start();
    expect(textOf(await other.tools.run("scope_info", undefined, () => other.tools.scopeInfo()))).not.toContain("Tajne");
    inny.listed = false;
    expect(textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()))).not.toContain("Tajne");
    void klub;
  });
});

describe("tasks: mine (docs/MCP.md §3.5)", () => {
  it("counts the person's aliases from the vault, and nobody else's", async () => {
    const w = await makeWorld({ notes: [{ path: "Z.md", text: "- [ ] Moje stare @Ania ^z-0001\n- [ ] Moje @anna ^z-0002\n- [ ] Cudze @Bob ^z-0003\n- [ ] Bez osoby ^z-0004\n" }], scope: { tasks: "mine" } });
    await w.mutate((s) => { s.state.organization.aliases = { ...s.state.organization.aliases, [w.userId]: ["Ania", "Anna"], "u-bob": ["Bob"] }; });
    const { tools } = w.start();
    const r = textOf(await tools.run("list_tasks", undefined, () => tools.listTasks({ stan: "wszystkie" })));
    expect(r).toContain("z-0001");
    expect(r).toContain("z-0002");
    expect(r).not.toContain("z-0003");
    expect(r).not.toContain("z-0004");
    expect(textOf(await tools.run("set_task", undefined, () => tools.setTask({ id: "z-0003", pole: "termin", wartosc: "2026-12-01" })))).toContain("Nie ma takiego zadania");
  });
});

describe("renewal, limits and odd answers (docs/MCP.md §3.3, §5.3)", () => {
  it("a renewed session is not wiped at the old expiry", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES });
    w.server.sessionExpiresAt = Date.now() + 1500;
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    w.server.sessionExpiresAt = Date.now() + 3_600_000;
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    await new Promise((r) => setTimeout(r, 1700));
    expect(session.vaults.size).toBe(1);
    expect(session.sessionExpiresAt).toBe(w.server.sessionExpiresAt);
  });

  it("a 429 keeps what is held: no full fetch again (which would be one more 429 towards a pause)", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES });
    const { tools, session } = w.start();
    await tools.run("list_notes", undefined, () => tools.listNotes({}));
    const fetches = () => w.server.log.filter((l) => l.path.includes("/snapshot")).length;
    const before = fetches();
    w.server.next.push({ status: 429, body: { code: "limit", message: "x" } });
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toBe("Za dużo żądań czatu. Spróbuj za chwilę.");
    expect(session.vaults.size).toBe(1);
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Dziennik/A.md");
    expect(fetches()).toBe(before);
  });

  it("a vault whose fetch meets a 429 at load is tried again later, not counted as broken and not fatal", async () => {
    let now = Date.now();
    const w = await makeWorld({ notes: SECRET_NOTES });
    const { tools, session } = w.start(undefined, undefined, () => now);
    // /me answers, the vault's meta meets the limit
    const real = w.fetchFn;
    let limited = 1;
    (session.client.opts as { fetch?: typeof fetch }).fetch = (async (u: URL | string, init?: RequestInit) => {
      if (String(u).includes("/api/agent/vaults/") && limited-- > 0) return new Response(JSON.stringify({ code: "limit", message: "x" }), { status: 429 });
      return real(u, init);
    }) as typeof fetch;
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Notatek: 0.");
    expect(textOf(await tools.run("scope_info", undefined, () => tools.scopeInfo()))).not.toContain("Niedostępne");
    now += 5 * 60_000 + 10_000;
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Dziennik/A.md");
  });

  it("answers that are not JSON objects give the fixed message, never a crash or a hang", async () => {
    const w = await makeWorld({ notes: SECRET_NOTES });
    const { tools } = w.start();
    for (const body of [RAW_NULL, [1, 2], "tekst", 5]) {
      w.server.next.push({ status: 200, body });
      expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toBe("Serwer Notatek nie odpowiada poprawnie. Spróbuj później.");
    }
    expect(textOf(await tools.run("list_notes", undefined, () => tools.listNotes({})))).toContain("Dziennik/A.md");

    const dir = mkdtempSync(join(tmpdir(), "notatki-pair-"));
    let t = 0;
    const fetchFn = (async (u: URL | string) => String(u).endsWith("/claim")
      ? new Response(JSON.stringify({ pairingId: "p", pairToken: "TOKEN_abcdefghijklmnop" }))
      : new Response("null")) as typeof fetch;
    await expect(pair("https://notatki.test", { store: openKeyStore({ NOTES_MCP_KEYSTORE_FILE: join(dir, "k.json") }, () => undefined), state: new LocalState(join(dir, "s")), fetch: fetchFn, getCode: async () => "K7QM3XRP", print: () => undefined, open: () => undefined, sleep: async () => undefined, now: () => (t += 1000) }))
      .rejects.toThrow("Serwer Notatek nie odpowiada poprawnie");
  });
});
