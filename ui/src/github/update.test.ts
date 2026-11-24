import * as Y from "yjs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWasm } from "../testwasm";
import { MockBridge, type BrowserVaultSnapshot, type TreeListing } from "../bridge";
import { FakeGitHub } from "./testgithub";
import { gitBlobSha1, rateLimitStatus } from "./api";
import { replaceText } from "./core";
import { newLink, type GithubLink } from "./link";
import { runUpdate, type UpdateDeps } from "./update";

// Everything runs in memory: a fake GitHub (fetch), one MockBridge per device, a shared archive and lease.
// The server is a snapshot that devices persist to and catch up from, as the browser variant does.

const REPO = "acme/notatki";
const PROJECT = "Projekty/Alfa";
const TARGET = "Projekty/Alfa/GitHub";
const NOW = 1_700_000_000_000;
const enc = new TextEncoder();

beforeAll(async () => {
  await loadWasm();
});

interface Env {
  gh: FakeGitHub;
  archive: Map<string, Uint8Array>;
  held: Map<string, string>;
  server: BrowserVaultSnapshot | null;
}

const newEnv = (): Env => ({ gh: new FakeGitHub(), archive: new Map(), held: new Map(), server: null });
const archiveKey = (link: GithubLink, sha: string): string => `${link.id}:${sha}`;

class Device {
  readonly bridge = new MockBridge([], false);

  constructor(readonly name: string, readonly env: Env) {
    this.bridge.setBrowserAccount("u1", "a@example.test");
  }

  deps(): UpdateDeps {
    const { env, name, bridge } = this;
    return {
      call: <T>(cmd: string, args?: Record<string, unknown>) => bridge.call<T>(cmd, args),
      takeLease: async (lease) => {
        const holder = env.held.get(lease);
        if (holder !== undefined && holder !== name) return false;
        env.held.set(lease, name);
        return true;
      },
      releaseLease: async (lease) => {
        if (env.held.get(lease) === name) env.held.delete(lease);
      },
      catchUp: async () => {
        if (env.server) bridge.mergeBrowserSnapshot(env.server);
      },
      persistNow: async () => this.persist(),
      archive: async (link, sha, bytes) => {
        env.archive.set(archiveKey(link, sha), bytes);
      },
      readArchive: async (link, sha) => env.archive.get(archiveKey(link, sha)) ?? null,
      auth: { token: null },
      fetch: env.gh.fetch,
      userId: "u1",
      now: () => NOW,
    };
  }

  run(linkId: string) {
    return runUpdate(linkId, this.deps());
  }

  persist(): void {
    this.env.server = this.bridge.exportBrowserSnapshot("u1");
  }

  async connect(opts: { repoPath?: string; onDelete?: "keep" | "trash"; allowEdits?: boolean; target?: string } = {}): Promise<string> {
    const link = newLink(PROJECT, REPO, opts);
    await this.bridge.call("github_save_link", { link });
    this.persist();
    return link.id;
  }

  async link(id: string): Promise<GithubLink> {
    const links = await this.bridge.call<GithubLink[]>("github_links");
    const found = links.find((l) => l.id === id);
    if (!found) throw new Error(`no link ${id}`);
    return found;
  }

  async paths(): Promise<string[]> {
    const { notes } = await this.bridge.call<{ notes: { id: string; path: string }[] }>("list_tree");
    return notes.map((n) => n.path).sort();
  }

  async idOf(path: string): Promise<string> {
    const { notes } = await this.bridge.call<{ notes: { id: string; path: string }[] }>("list_tree");
    const note = notes.find((n) => n.path === path);
    if (!note) throw new Error(`no note ${path}`);
    return note.id;
  }

  async text(id: string): Promise<string> {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.bridge.call<Uint8Array>("open_note", { id }));
    return doc.getText("content").toString();
  }

  async versionReasons(id: string): Promise<string[]> {
    return (await this.bridge.call<{ reason: string }[]>("list_versions", { id })).map((v) => v.reason);
  }

  // The user's own edit: a change made in a separate Y.Doc and sent as an update, like the editor does.
  private async edit(id: string, change: (doc: Y.Doc) => void): Promise<void> {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.bridge.call<Uint8Array>("open_note", { id }));
    const before = Y.encodeStateVector(doc);
    change(doc);
    await this.bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
  }

  setText(id: string, text: string): Promise<void> {
    return this.edit(id, (doc) => replaceText(doc, text));
  }

  append(id: string, extra: string): Promise<void> {
    return this.edit(id, (doc) => {
      const t = doc.getText("content");
      t.insert(t.length, extra);
    });
  }
}

const sha7 = (sha: string): string => sha.slice(0, 7);

// A fresh link with the first import done on device A, which then persists it for device B.
async function imported(files: Record<string, string>, opts: { repoPath?: string; onDelete?: "keep" | "trash"; allowEdits?: boolean } = {}) {
  const env = newEnv();
  const a = new Device("A", env);
  const id = await a.connect(opts);
  await env.gh.commit("Pierwszy import", files);
  await a.run(id);
  return { env, a, id };
}

describe("runUpdate: import and no-change", () => {
  it("pierwszy import: pliki z podfolderu do GitHub/, README spoza folderu pominięty, archiwum ma bloby", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ repoPath: "docs" });
    await env.gh.commit("Pierwszy import", {
      "README.md": "# Główny\n",
      "docs/instalacja.md": "Krok 1\n",
      "docs/zakupy.md": "Mleko\n",
      "docs/faq/README.md": "FAQ\n",
    });

    const out = await a.run(id);

    expect(out).toEqual({ kind: "applied", commit: env.gh.head, changed: 3, conflicts: 0, skipped: 1 });
    expect(await a.paths()).toEqual([
      `${TARGET}/faq/README.md`,
      `${TARGET}/instalacja.md`,
      `${TARGET}/zakupy.md`,
    ]);
    expect(await a.text(await a.idOf(`${TARGET}/instalacja.md`))).toBe("Krok 1\n");
    const link = await a.link(id);
    expect(link.lastCommit).toBe(env.gh.head);
    expect(link.status).toBe("ok");
    expect(Object.values(link.files).map((f) => f.path).sort()).toEqual(["faq/README.md", "instalacja.md", "zakupy.md"]);
    expect(env.archive.size).toBe(3);
  });

  it("README bez rozszerzenia i plik .markdown stają się notatkami .md", async () => {
    const { a, id } = await imported({ "README": "Opis\n", "docs/plan.markdown": "Plan\n" });
    expect(await a.paths()).toEqual([`${TARGET}/README.md`, `${TARGET}/docs/plan.md`]);
    expect((await a.link(id)).status).toBe("ok");
    expect(Object.values((await a.link(id)).files).map((f) => f.path).sort()).toEqual(["README", "docs/plan.markdown"]);
  });

  it("commit bez zmian: unchanged, bez pobierania blobów, 304 z ETagiem", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "A\n" }, { repoPath: "docs" });
    env.gh.log.length = 0;

    expect(await a.run(id)).toEqual({ kind: "unchanged" });

    expect(env.gh.log.some((r) => r.path.includes("/git/blobs/"))).toBe(false);
    expect(env.gh.log.filter((r) => r.path.includes("/commits/main")).map((r) => r.status)).toEqual([304]);
  });
});

describe("runUpdate: merging GitHub changes with the user's notes", () => {
  it("zmiana na GitHubie bez dopisków: notatka = nowy tekst, wersja z powodem GitHub <sha>: <opis>", async () => {
    const { env, a, id } = await imported({ "docs/instalacja.md": "Krok 1\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/instalacja.md`);
    await env.gh.commit("Rozszerz instalację", { "docs/instalacja.md": "Krok 1\nKrok 2\n" });

    expect((await a.run(id)).kind).toBe("applied");

    expect(await a.text(note)).toBe("Krok 1\nKrok 2\n");
    expect(await a.versionReasons(note)).toEqual([`GitHub ${sha7(env.gh.head)}: Rozszerz instalację`]);
  });

  it("dopisek na końcu i zmiana na początku na GitHubie: oba zostają", async () => {
    const { env, a, id } = await imported({ "docs/instalacja.md": "Krok 1\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/instalacja.md`);
    await a.append(note, "\n## Moje\n- uwaga\n");
    await env.gh.commit("Nagłówek", { "docs/instalacja.md": "# Instalacja\nKrok 1\n" });

    await a.run(id);

    expect(await a.text(note)).toBe("# Instalacja\nKrok 1\n\n## Moje\n- uwaga\n");
  });

  it("dopisek przetrwa 20 kolejnych commitów zmieniających inne części pliku", async () => {
    // Ten sam plik w każdym commicie, z jedną zmienioną linią (w wierszach 1–9, nigdy w ostatniej).
    const lines = (v: number): string =>
      Array.from({ length: 10 }, (_, i) => (i === v % 9 ? `L${i + 1} v${v}` : `L${i + 1}`)).join("\n") + "\n";
    const { env, a, id } = await imported({ "docs/plik.md": lines(0) }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/plik.md`);
    await a.append(note, "- moja uwaga\n");

    for (let v = 1; v <= 20; v++) {
      await env.gh.commit(`Zmiana ${v}`, { "docs/plik.md": lines(v) });
      expect((await a.run(id)).kind).toBe("applied");
    }

    expect(await a.text(note)).toBe(lines(20) + "- moja uwaga\n");
  });

  it("ten sam fragment zmieniony w obu miejscach: konflikt, notatka nietknięta", async () => {
    const { env, a, id } = await imported({ "docs/instalacja.md": "Krok 1\nKrok 2\nKrok 3\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/instalacja.md`);
    const mine = "Krok 1\nKrok 2 — moja wersja\nKrok 3\n";
    await a.setText(note, mine);
    const theirs = "Krok 1\nKrok 2 — GitHub\nKrok 3\n";
    await env.gh.commit("Zmiana kroku 2", { "docs/instalacja.md": theirs });
    const theirsSha = await gitBlobSha1(enc.encode(theirs));

    const out = await a.run(id);

    expect(out).toEqual({ kind: "applied", commit: env.gh.head, changed: 0, conflicts: 1, skipped: 0 });
    expect(await a.text(note)).toBe(mine);
    const link = await a.link(id);
    expect(link.status).toBe("Konflikt: 1 plik");
    const file = Object.values(link.files)[0];
    expect(file.conflict).toEqual({ blobSha: theirsSha, commit: env.gh.head });
    expect(file.blobSha).not.toBe(theirsSha);
  });

  it("usunięty plik z dopiskami zostaje, oznaczony, a archiwum nadal ma blob", async () => {
    const { env, a, id } = await imported({ "docs/zakupy.md": "Mleko\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/zakupy.md`);
    await a.append(note, "- jajka\n");
    const oldSha = await gitBlobSha1(enc.encode("Mleko\n"));
    await env.gh.commit("Usunięcie zakupów", { "docs/zakupy.md": null });

    expect((await a.run(id)).kind).toBe("applied");

    expect(await a.text(note)).toBe("Mleko\n- jajka\n");
    const file = (await a.link(id)).files[note];
    expect(file.deleted).toBe(true);
    expect(env.archive.has(archiveKey(await a.link(id), oldSha))).toBe(true);
  });

  it("usunięty plik bez dopisków przy onDelete trash: w koszu", async () => {
    const { env, a, id } = await imported({ "docs/zakupy.md": "Mleko\n" }, { repoPath: "docs", onDelete: "trash" });
    await env.gh.commit("Usunięcie zakupów", { "docs/zakupy.md": null });

    await a.run(id);

    expect(await a.paths()).toEqual([]);
    const trash = await a.bridge.call<{ path: string }[]>("list_trash");
    expect(trash.map((t) => t.path)).toEqual([`${TARGET}/zakupy.md`]);
  });

  it("przeniesienie: ta sama notatka (id), nowa ścieżka, dopisek zostaje", async () => {
    const { env, a, id } = await imported({ "docs/zakupy.md": "Mleko\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/zakupy.md`);
    await a.append(note, "- jajka\n");
    await env.gh.commit("Przeniesienie", { "docs/zakupy.md": null, "docs/sklep/zakupy.md": "Mleko\n" });

    await a.run(id);

    expect(await a.paths()).toEqual([`${TARGET}/sklep/zakupy.md`]);
    expect(await a.idOf(`${TARGET}/sklep/zakupy.md`)).toBe(note);
    expect(await a.text(note)).toBe("Mleko\n- jajka\n");
  });

  it("plik usunięty przez użytkownika nie wraca, jego ścieżka trafia do ignored", async () => {
    const { env, a, id } = await imported({ "docs/zakupy.md": "Mleko\n" }, { repoPath: "docs" });
    await a.bridge.call("delete", { id: await a.idOf(`${TARGET}/zakupy.md`) });
    await env.gh.commit("Zmiana innego pliku", { "docs/inny.md": "Inny\n" });

    await a.run(id);

    expect(await a.paths()).toEqual([`${TARGET}/inny.md`]);
    expect((await a.link(id)).ignored).toEqual(["zakupy.md"]);
  });
});

describe("runUpdate: content from GitHub", () => {
  it("zły blobSha: treść nie trafia do notatki, status podaje ścieżkę", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "A\n" }, { repoPath: "docs" });
    await env.gh.commit("Nowy plik", { "docs/nowy.md": "Nowy\n" });
    env.gh.corrupt.add(await gitBlobSha1(enc.encode("Nowy\n")));

    const out = await a.run(id);

    expect(out).toEqual({ kind: "applied", commit: env.gh.head, changed: 0, conflicts: 0, skipped: 1 });
    expect(await a.paths()).toEqual([`${TARGET}/a.md`]);
    expect((await a.link(id)).status).toBe("ok · Niezgodna suma pliku: nowy.md");
  });

  it("znaczniki uprawnień w README z GitHuba nie trafiają do notatki", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect();
    await env.gh.commit("README", { "README.md": "---\nosoby:\n  - Ania\n---\n# Opis\n!zaznacza:x\n" });

    await a.run(id);

    const text = await a.text(await a.idOf(`${TARGET}/README.md`));
    expect(text).not.toContain("osoby:");
    expect(text).not.toContain("!zaznacza");
    expect(text).toContain("# Opis");
    expect((await a.link(id)).status).toBe("ok · Pominięto znaczniki uprawnień: 3");
  });

  it("zajęta ścieżka: nowa notatka dostaje nazwę (GitHub), potem (GitHub 2); notatka użytkownika nietknięta", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect();
    const mine = await a.bridge.call<string>("create_note", { path: `${TARGET}/instalacja.md` });
    await a.setText(mine, "moje\n");
    await env.gh.commit("Import", { "instalacja.md": "Z GitHuba\n" });

    await a.run(id);

    expect(await a.paths()).toEqual([`${TARGET}/instalacja (GitHub).md`, `${TARGET}/instalacja.md`]);
    expect(await a.text(await a.idOf(`${TARGET}/instalacja (GitHub).md`))).toBe("Z GitHuba\n");
    expect(await a.text(await a.idOf(`${TARGET}/instalacja.md`))).toBe("moje\n");

    // the name "(GitHub)" is taken too: the next copy gets "(GitHub 2)"
    const second = await a.bridge.call<string>("create_note", { path: `${TARGET}/zakupy.md` });
    await a.setText(second, "moje zakupy\n");
    await env.gh.commit("Zakupy", { "instalacja.md": "Z GitHuba\n", "zakupy.md": "Z GitHuba\n" });
    await a.run(id);
    expect(await a.paths()).toEqual([
      `${TARGET}/instalacja (GitHub).md`, `${TARGET}/instalacja.md`, `${TARGET}/zakupy (GitHub).md`, `${TARGET}/zakupy.md`,
    ]);
  });

  it("pliki w folderze projektu (target \"\"): folder o tej samej nazwie co folder z GitHuba łączy się z nim, bez zmiany nazwy", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ target: "" });
    await a.bridge.call("create_folder", { path: `${PROJECT}/docs` });
    await env.gh.commit("Import", { "docs/a.md": "A\n" });

    await a.run(id);

    expect(await a.paths()).toEqual([`${PROJECT}/docs/a.md`]);
    expect((await a.bridge.call<TreeListing>("list_tree")).folders).toContain(`${PROJECT}/docs`);
    expect(await a.text(await a.idOf(`${PROJECT}/docs/a.md`))).toBe("A\n");
  });

  it("pliki w folderze projektu (target \"\"): zajęta nazwa dostaje (GitHub), a kolejne aktualizacje wracają do tej notatki", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ target: "" });
    const mine = await a.bridge.call<string>("create_note", { path: `${PROJECT}/instalacja.md` });
    await a.setText(mine, "moje\n");
    await env.gh.commit("Import", { "instalacja.md": "Z GitHuba\n" });

    await a.run(id);

    expect(await a.paths()).toEqual([`${PROJECT}/instalacja (GitHub).md`, `${PROJECT}/instalacja.md`]);
    expect(await a.text(mine)).toBe("moje\n");
    const copy = await a.idOf(`${PROJECT}/instalacja (GitHub).md`);
    expect((await a.link(id)).files[copy]).toMatchObject({ path: "instalacja.md" });

    await env.gh.commit("Zmiana", { "instalacja.md": "Z GitHuba 2\n" });
    await a.run(id);

    expect(await a.paths()).toEqual([`${PROJECT}/instalacja (GitHub).md`, `${PROJECT}/instalacja.md`]);
    expect(await a.text(copy)).toBe("Z GitHuba 2\n");
    expect(await a.text(mine)).toBe("moje\n");
  });
});

describe("runUpdate: errors and limits", () => {
  it("404: Repozytorium niedostępne, notatki i archiwum nietknięte", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "A\n" }, { repoPath: "docs" });
    const before = await a.paths();
    const archived = env.archive.size;
    env.gh.override = { status: 404 };

    expect(await a.run(id)).toEqual({ kind: "failed", status: "Repozytorium niedostępne" });

    expect(await a.paths()).toEqual(before);
    expect(env.archive.size).toBe(archived);
    expect((await a.link(id)).status).toBe("Repozytorium niedostępne");
  });

  it("403 z x-ratelimit-reset: failed z resetAt, status z godziną, jedno zapytanie", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect();
    const reset = Math.floor(NOW / 1000) + 3600;
    env.gh.override = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } };
    env.gh.log.length = 0;

    const out = await a.run(id);

    expect(out).toEqual({ kind: "failed", status: rateLimitStatus(reset * 1000), resetAt: reset * 1000 });
    expect(out).toMatchObject({ status: expect.stringMatching(/^Limit GitHuba do \d\d:\d\d$/) });
    expect(env.gh.log).toHaveLength(1);
  });

  it("blokada zajęta: busy, nic nie zmienione", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "A\n" }, { repoPath: "docs" });
    await env.gh.commit("Zmiana", { "docs/a.md": "B\n" });
    const before = await a.paths();
    env.held.set(id, "ktoś-inny");

    expect(await a.run(id)).toEqual({ kind: "busy" });

    expect(await a.paths()).toEqual(before);
    expect((await a.link(id)).lastCommit).not.toBe(env.gh.head);
    expect(env.held.get(id)).toBe("ktoś-inny");
  });

  it("dwa urządzenia zaczynają ten sam commit naraz: tekst bez duplikatów, commit zastosowany raz", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "Krok 1\n" }, { repoPath: "docs" });
    const b = new Device("B", env);
    await b.bridge.mergeBrowserSnapshot(env.server!);
    const note = await a.idOf(`${TARGET}/a.md`);
    await env.gh.commit("Krok 2", { "docs/a.md": "Krok 1\nKrok 2\n" });

    const [outA, outB] = await Promise.all([a.run(id), b.run(id)]);

    expect([outA.kind, outB.kind].sort()).toEqual(["applied", "busy"].sort());
    // The second device catches up and finds the commit already applied.
    expect(await b.run(id)).toEqual({ kind: "unchanged" });
    expect(await a.text(note)).toBe("Krok 1\nKrok 2\n");
    expect(await a.versionReasons(note)).toEqual([`GitHub ${sha7(env.gh.head)}: Krok 2`]);
    expect((await a.link(id)).lastCommit).toBe(env.gh.head);
  });
});

describe("runUpdate: the rules added in review", () => {
  it("§8: plik w konflikcie jest pomijany w przebiegu (bez pobierania bloba, bez odświeżania conflict.commit), konflikt liczony dalej", async () => {
    const { env, a, id } = await imported({ "docs/i.md": "Krok 1\nKrok 2\nKrok 3\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/i.md`);
    await a.setText(note, "Krok 1\nKrok 2 — moja\nKrok 3\n");
    await env.gh.commit("Krok 2 z GitHuba", { "docs/i.md": "Krok 1\nKrok 2 — GitHub\nKrok 3\n" });
    await a.run(id);
    const firstConflictCommit = env.gh.head;
    // A later commit changes the same file again: the conflicted file is not touched at all.
    const secondText = "Krok 1\nKrok 2 — GitHub v2\nKrok 3\n";
    await env.gh.commit("Kolejna zmiana", { "docs/i.md": secondText });
    env.gh.log.length = 0;

    const out = await a.run(id);

    expect(out).toEqual({ kind: "applied", commit: env.gh.head, changed: 0, conflicts: 1, skipped: 0 });
    expect(env.gh.log.some((r) => r.path.includes("/git/blobs/"))).toBe(false);
    expect(await a.text(note)).toBe("Krok 1\nKrok 2 — moja\nKrok 3\n");
    const file = (await a.link(id)).files[note];
    expect(file.conflict?.commit).toBe(firstConflictCommit);
    expect(file.conflict?.blobSha).toBe(await gitBlobSha1(enc.encode("Krok 1\nKrok 2 — GitHub\nKrok 3\n")));
    expect((await a.link(id)).status).toBe("Konflikt: 1 plik");
  });

  it("walidacja rekordu: niepoprawny rekord -> failed, notatki nietknięte", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "Krok 1\n", "docs/b.md": "B\n" }, { repoPath: "docs" });
    const note = await a.idOf(`${TARGET}/a.md`);
    await a.append(note, "- moja\n");
    await env.gh.commit("Zmiany", { "docs/a.md": "Krok 1\nKrok 2\n", "docs/nowy.md": "Nowy\n" });
    const deps = a.deps();
    const inner = deps.call;
    // A stored record with an ignored path that is not a valid relative path.
    deps.call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      const r = await inner<T>(cmd, args);
      if (cmd !== "github_links") return r;
      return (r as unknown as GithubLink[]).map((l) => ({ ...l, ignored: ["../x"] })) as unknown as T;
    };
    const before = await a.paths();

    const out = await runUpdate(id, deps);

    expect(out).toEqual({ kind: "failed", status: "Zapis połączenia byłby nieprawidłowy, nic nie zmieniono." });
    expect(await a.paths()).toEqual(before);
    expect(await a.text(note)).toBe("Krok 1\n- moja\n");
    expect((await a.link(id)).lastCommit).not.toBe(env.gh.head);
  });

  it("czysta kopia (allowEdits=false): tekst z GitHuba bez konfliktu, wersja z tekstem użytkownika nadal powstaje", async () => {
    const { env, a, id } = await imported({ "docs/i.md": "Krok 1\nKrok 2\n" }, { repoPath: "docs", allowEdits: false });
    const note = await a.idOf(`${TARGET}/i.md`);
    await a.setText(note, "Krok 1 — moja\nKrok 2\n");
    await env.gh.commit("Krok 1 z GitHuba", { "docs/i.md": "Krok 1 — GitHub\nKrok 2\n" });

    const out = await a.run(id);

    expect(out).toMatchObject({ kind: "applied", conflicts: 0 });
    expect(await a.text(note)).toBe("Krok 1 — GitHub\nKrok 2\n");
    const versions = await a.bridge.call<{ id: number; reason: string }[]>("list_versions", { id: note });
    expect(versions.map((v) => v.reason)).toEqual([`GitHub ${sha7(env.gh.head)}: Krok 1 z GitHuba`]);
    expect(await a.bridge.call<string>("version_text", { vid: versions[0].id })).toBe("Krok 1 — moja\nKrok 2\n");
  });

  it("domyślna gałąź: zmiana zapisana, komunikat w statusie raz, potem zwykły status", async () => {
    const { env, a, id } = await imported({ "docs/a.md": "A\n" }, { repoPath: "docs" });
    expect((await a.link(id)).defaultBranch).toBe("main");
    env.gh.branch = "master";

    // Same commit on the new default branch: the run ends without an update, but the branch change is kept.
    expect(await a.run(id)).toEqual({ kind: "unchanged" });
    expect(await a.link(id)).toMatchObject({ defaultBranch: "master", status: "ok · Domyślna gałąź: master" });

    await env.gh.commit("Na master", { "docs/a.md": "A2\n" });
    expect(await a.run(id)).toMatchObject({ kind: "applied" });
    expect(await a.link(id)).toMatchObject({ defaultBranch: "master", status: "ok" });
    expect(await a.text(await a.idOf(`${TARGET}/a.md`))).toBe("A2\n");
  });
});

describe("runUpdate: import in parts (GitHub's limit without a token)", () => {
  // 120 notes in one commit: without a token GitHub allows about 50 blobs an hour, so the import takes several runs.
  const FILES = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`docs/n${String(i).padStart(3, "0")}.md`, `Notatka ${i}\n`]));
  const PART = /^Import w częściach: \d+ z 120 plików · Limit GitHuba do \d\d:\d\d$/;

  it("limit w połowie: zapisane 50 notatek, status z liczbą, lastCommit stary, pendingCommit ustawiony", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ repoPath: "docs" });
    await env.gh.commit("Import", FILES);
    const reset = Math.floor(NOW / 1000) + 3600;
    env.gh.blobLimit = { left: 50, reset };

    const out = await a.run(id);

    expect(out).toMatchObject({ kind: "failed", resetAt: reset * 1000, status: expect.stringMatching(PART) });
    expect((out as { status: string }).status).toMatch(/^Import w częściach: 50 z 120 plików/);
    expect(await a.paths()).toHaveLength(50);
    expect(env.archive.size).toBe(50);
    const link = await a.link(id);
    expect(link.lastCommit).toBeNull();
    expect(link.pendingCommit).toBe(env.gh.head);
    expect(link.status).toBe((out as { status: string }).status);
  });

  it("po resecie drugi przebieg dokańcza bez duplikatów; 304 nie przeszkadza", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ repoPath: "docs" });
    await env.gh.commit("Import", FILES);
    env.gh.blobLimit = { left: 50, reset: Math.floor(NOW / 1000) + 3600 };
    await a.run(id);
    env.gh.blobLimit = null;
    env.gh.log.length = 0;

    expect(await a.run(id)).toEqual({ kind: "applied", commit: env.gh.head, changed: 70, conflicts: 0, skipped: 0 });

    expect(env.gh.log.filter((r) => r.path.includes("/commits/main")).map((r) => r.status)).toEqual([304]);
    expect(await a.paths()).toHaveLength(120);
    expect(new Set(await a.paths()).size).toBe(120);
    const link = await a.link(id);
    expect(link.lastCommit).toBe(env.gh.head);
    expect(link.pendingCommit).toBeNull();
    expect(link.status).toBe("ok");
  });

  it("po resecie bez ETagu (200 zamiast 304) też dokańcza", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ repoPath: "docs" });
    await env.gh.commit("Import", FILES);
    env.gh.blobLimit = { left: 50, reset: Math.floor(NOW / 1000) + 3600 };
    await a.run(id);
    await a.bridge.call("github_save_link", { link: { ...(await a.link(id)), etag: null } });
    env.gh.blobLimit = null;

    expect((await a.run(id)).kind).toBe("applied");

    expect(await a.paths()).toHaveLength(120);
    expect((await a.link(id)).pendingCommit).toBeNull();
  });

  it("dopisek w już zaimportowanej notatce przetrwa kolejne części", async () => {
    const env = newEnv();
    const a = new Device("A", env);
    const id = await a.connect({ repoPath: "docs" });
    await env.gh.commit("Import", FILES);
    env.gh.blobLimit = { left: 50, reset: Math.floor(NOW / 1000) + 3600 };
    await a.run(id);
    const note = await a.idOf(`${TARGET}/n000.md`);
    await a.append(note, "- moja uwaga\n");

    env.gh.blobLimit = { left: 50, reset: Math.floor(NOW / 1000) + 3600 };
    expect((await a.run(id)).kind).toBe("failed");
    expect(await a.paths()).toHaveLength(100);
    env.gh.blobLimit = null;
    expect((await a.run(id)).kind).toBe("applied");

    expect(await a.text(note)).toBe("Notatka 0\n- moja uwaga\n");
    expect(await a.paths()).toHaveLength(120);
  });
});
