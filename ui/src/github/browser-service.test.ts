// @vitest-environment jsdom
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadWasm } from "../testwasm";
import { MockBridge, type TreeListing } from "../bridge";
import { ApiError, type Role } from "../vaults";
import type { FileInfo, FileStore } from "../filestore";
import { gitBlobSha1 } from "./api";
import { replaceText } from "./core";
import type { GithubLink } from "./link";
import { NO_STORE_STATUS, archiveId, createGithubService, type BrowserGithubService, type GithubHost } from "./browser-service";
import type { ConnectOptions } from "./service";
import { FakeGitHub } from "./testgithub";

// The service over a real MockBridge, a fake GitHub (fetch to api.github.com), a fake server (leases) and a fake store.

const REPO = "acme/notatki";
const PROJECT = "Projekty/Alfa";
const VAULT = `v-${"d".repeat(32)}`;
const SECRET = new Uint8Array(32).fill(7);
const TOKEN = "github_pat_SEKRET0123456789";
const enc = new TextEncoder();
const OPTIONS: ConnectOptions = { repo: REPO, ref: null, repoPath: "", target: "GitHub", onDelete: "keep", allowEdits: true };

beforeAll(async () => {
  await loadWasm();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface Sent { url: string; init?: RequestInit }

// Every fetch of the page: GitHub goes to the fake, the notes server answers leases.
function network(gh: FakeGitHub): Sent[] {
  const sent: Sent[] = [];
  const held = new Map<string, string>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    sent.push({ url, init });
    if (url.startsWith("https://api.github.com/")) return gh.fetch(input, init);
    const lease = /\/api\/vaults\/[^/]+\/leases(?:\/([0-9a-f]{32}))?$/.exec(url);
    if (lease && init?.method === "POST") {
      const { name } = JSON.parse(String(init.body)) as { name: string };
      const granted = !held.has(name);
      held.set(name, "me");
      return new Response(JSON.stringify({ granted, until: 1 }), { status: 200 });
    }
    if (lease && init?.method === "DELETE") {
      held.delete(lease[1]);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: "Nie ma." }), { status: 404 });
  });
  return sent;
}

// The vault's file store as far as the archive uses it: one record per id, written once by whoever came first.
class FakeStore {
  readonly records = new Map<string, { bytes: Uint8Array; by: string; project: string | null; name: string }>();
  forDevice(device: string): Pick<FileStore, "upload" | "info" | "read"> {
    return {
      upload: async (file, options) => {
        const known = this.records.get(options.id);
        if (known && known.by !== device) throw new ApiError("Identyfikator jest zajęty.", 409);
        this.records.set(options.id, { bytes: new Uint8Array(await file.arrayBuffer()), by: device, project: options.project ?? null, name: file.name });
        return { id: options.id } as FileInfo;
      },
      info: async (id) => (this.records.has(id) ? ({ id } as FileInfo) : null),
      read: async (id) => new Blob([this.records.get(id)!.bytes as BlobPart]),
    };
  }
}

interface Device { bridge: MockBridge; service: BrowserGithubService; host: GithubHost; token: { value: string | null } }

function device(store: FakeStore | null, name = "a", role: Role = "editor"): Device {
  const bridge = new MockBridge([], false);
  bridge.setBrowserAccount(name, `${name}@example.test`);
  const token = { value: null as string | null };
  const host: GithubHost = {
    call: (cmd, args) => bridge.call(cmd, args),
    vaultId: VAULT,
    userId: name,
    role: () => role,
    files: store ? store.forDevice(name) : null,
    archiveSecret: () => SECRET,
    catchUp: async () => undefined,
    persistNow: async () => undefined,
    tokenReady: async () => undefined,
    token: () => token.value,
    setToken: async (t) => { token.value = t; },
  };
  return { bridge, service: createGithubService(host), host, token };
}

const idOf = async (b: MockBridge, path: string): Promise<string> => (await b.call<TreeListing>("list_tree")).notes.find((n) => n.path === path)!.id;
const paths = async (b: MockBridge): Promise<string[]> => (await b.call<TreeListing>("list_tree")).notes.map((n) => n.path).sort();
async function textOf(b: MockBridge, id: string): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
  return doc.getText("content").toString();
}
async function setText(b: MockBridge, id: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
  const before = Y.encodeStateVector(doc);
  replaceText(doc, text);
  await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
}
const linkOf = async (b: MockBridge, id: string): Promise<GithubLink> => (await b.call<GithubLink[]>("github_links")).find((l) => l.id === id)!;

describe("preview", () => {
  it("counts the Markdown files of the folder within the limits and skips the rest", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n", "docs/a.md": "A\n", "docs/duzy.md": "x".repeat(1024 * 1024 + 1), "docs/kod.ts": "1;\n" });
    network(gh);
    const { service } = device(new FakeStore());
    const all = await service.preview(`https://github.com/${REPO}`);
    expect(all).toEqual({ ok: true, value: { repo: REPO, ref: null, repoPath: "", defaultBranch: "main", private: false, markdownFiles: 2, totalBytes: 8, skipped: 1 } });
    const docs = await service.preview(`https://github.com/${REPO}/tree/main/docs`);
    expect(docs.ok && docs.value).toMatchObject({ ref: "main", repoPath: "docs", markdownFiles: 1, totalBytes: 2, skipped: 1 });
  });

  it("answers in the user's words: a bad address, a missing repository", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n" });
    network(gh);
    const { service } = device(new FakeStore());
    expect(await service.preview("to nie adres")).toEqual({ ok: false, message: "To nie jest adres repozytorium na GitHubie." });
    expect(await service.preview("https://github.com/acme/nie-ma")).toEqual({ ok: false, message: "Nie ma takiego repozytorium albo jest prywatne. Dla prywatnego dodaj token." });
  });
});

describe("connect, update, disconnect", () => {
  it("imports, takes and releases the lease, archives each blob in the project, and updates on checkNow", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n", "docs/a.md": "A\n" });
    const sent = network(gh);
    const store = new FakeStore();
    const { bridge, service } = device(store);
    const link = await service.connect(PROJECT, OPTIONS);
    expect(await paths(bridge)).toEqual(["Projekty/Alfa/GitHub/README.md", "Projekty/Alfa/GitHub/docs/a.md"]);
    expect(link.lastCommit).toBe(gh.head);
    expect(link.status).toBe("ok");
    const leases = sent.filter((s) => s.url.includes("/leases"));
    expect(leases.map((s) => s.init?.method)).toEqual(["POST", "DELETE"]);
    expect(leases[1].url).toBe(`/api/vaults/${VAULT}/leases/${link.id}`);
    const readme = await gitBlobSha1(enc.encode("# Hej\n"));
    const record = store.records.get(await archiveId(SECRET, link.id, readme));
    expect(record?.project).toBe(PROJECT);
    expect(new TextDecoder().decode(record?.bytes)).toBe("# Hej\n");
    expect(await service.links(PROJECT)).toHaveLength(1);
    expect(await service.links("Projekty/Beta")).toEqual([]);

    await gh.commit("zmiana", { "README.md": "# Hej\nNowa linia\n" });
    expect(await service.checkNow(link.id)).toBe("ok");
    const id = await idOf(bridge, "Projekty/Alfa/GitHub/README.md");
    expect(await textOf(bridge, id)).toBe("# Hej\nNowa linia\n");
    expect(await service.baseText(id)).toBe("# Hej\nNowa linia\n");
    expect((await service.noteInfo(id))?.file.path).toBe("README.md");

    await service.disconnect(link.id);
    expect(await service.links(PROJECT)).toEqual([]);
    expect(await service.noteInfo(id)).toBeNull();
    expect(await paths(bridge)).toContain("Projekty/Alfa/GitHub/README.md");
  });

  it("a deleted note stays away until restoreIgnored, then the next commit brings it back", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n", "b.md": "B\n" });
    network(gh);
    const { bridge, service } = device(new FakeStore());
    const link = await service.connect(PROJECT, OPTIONS);
    await bridge.call("delete", { id: await idOf(bridge, "Projekty/Alfa/GitHub/b.md") });
    await gh.commit("dwa", { "README.md": "# Hej 2\n" });
    await service.checkNow(link.id);
    expect((await linkOf(bridge, link.id)).ignored).toEqual(["b.md"]);
    expect(await paths(bridge)).toEqual(["Projekty/Alfa/GitHub/README.md"]);

    await service.restoreIgnored(link.id, "b.md");
    expect((await linkOf(bridge, link.id)).ignored).toEqual([]);
    await gh.commit("trzy", { "README.md": "# Hej 3\n" });
    await service.checkNow(link.id);
    expect(await paths(bridge)).toEqual(["Projekty/Alfa/GitHub/README.md", "Projekty/Alfa/GitHub/b.md"]);
  });

  it("Zostaw jako własną: the note stops following GitHub, its text stays, and the next commit does not bring the file back", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n", "b.md": "B\n" });
    network(gh);
    const { bridge, service } = device(new FakeStore());
    const link = await service.connect(PROJECT, OPTIONS);
    const b = await idOf(bridge, "Projekty/Alfa/GitHub/b.md");
    await setText(bridge, b, "B po swojemu\n");

    await service.detachNote(b);

    expect(await service.noteInfo(b)).toBeNull();
    expect(Object.keys((await linkOf(bridge, link.id)).files)).not.toContain(b);
    expect((await linkOf(bridge, link.id)).ignored).toEqual(["b.md"]);
    await gh.commit("dwa", { "README.md": "# Hej 2\n", "b.md": "B z GitHuba\n" });
    await service.checkNow(link.id);
    expect(await paths(bridge)).toEqual(["Projekty/Alfa/GitHub/README.md", "Projekty/Alfa/GitHub/b.md"]);
    expect(await textOf(bridge, b)).toBe("B po swojemu\n");
  });

  it("a conflict shows both texts; the chosen text is kept, GitHub's version is the new base, the next commit merges", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "plan.md": "Krok 1\nKrok 2\nKrok 3\n" });
    network(gh);
    const { bridge, service } = device(new FakeStore());
    const link = await service.connect(PROJECT, OPTIONS);
    const id = await idOf(bridge, "Projekty/Alfa/GitHub/plan.md");
    await setText(bridge, id, "Krok 1\nKrok 2 — moje\nKrok 3\n");
    await gh.commit("zmiana", { "plan.md": "Krok 1\nKrok 2 — GitHub\nKrok 3\n" });
    expect(await service.checkNow(link.id)).toBe("Konflikt: 1 plik");

    const conflict = await service.conflict(id);
    expect(conflict).toEqual({ ours: "Krok 1\nKrok 2 — moje\nKrok 3\n", theirs: "Krok 1\nKrok 2 — GitHub\nKrok 3\n", commit: gh.head });
    await service.resolveConflict(id, "Krok 1\nKrok 2 — GitHub\nKrok 3\nMój dopisek\n");
    expect(await textOf(bridge, id)).toBe("Krok 1\nKrok 2 — GitHub\nKrok 3\nMój dopisek\n");
    expect(await service.baseText(id)).toBe("Krok 1\nKrok 2 — GitHub\nKrok 3\n");
    expect(await service.conflict(id)).toBeNull();
    expect((await linkOf(bridge, link.id)).status).toBe("ok");
    expect((await bridge.call<{ reason: string }[]>("list_versions", { id })).map((v) => v.reason)).toContain("Przed rozwiązaniem konfliktu z GitHubem");

    await gh.commit("dalej", { "plan.md": "Krok 0\nKrok 1\nKrok 2 — GitHub\nKrok 3\n" });
    expect(await service.checkNow(link.id)).toBe("ok");
    expect(await textOf(bridge, id)).toBe("Krok 0\nKrok 1\nKrok 2 — GitHub\nKrok 3\nMój dopisek\n");
  });

  it("a viewer reads the status without running an update", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n" });
    const sent = network(gh);
    const editor = device(new FakeStore());
    const link = await editor.service.connect(PROJECT, OPTIONS);
    const viewer = device(new FakeStore(), "v", "viewer");
    viewer.bridge.mergeBrowserSnapshot(editor.bridge.exportBrowserSnapshot("a"));
    await gh.commit("zmiana", { "README.md": "# Hej 2\n" });
    const before = sent.length;
    expect(await viewer.service.checkNow(link.id)).toBe("ok");
    expect(sent.length).toBe(before);
    await expect(viewer.service.connect(PROJECT, OPTIONS)).rejects.toThrow("edytor");
  });

  it("without a file store the archive lives in the session and the status says so", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n" });
    network(gh);
    const { bridge, service } = device(null);
    const link = await service.connect(PROJECT, OPTIONS);
    expect(link.status).toBe(`ok · ${NO_STORE_STATUS}`);
    const id = await idOf(bridge, "Projekty/Alfa/GitHub/README.md");
    await setText(bridge, id, "# Hej\nMoje\n");
    await gh.commit("zmiana", { "README.md": "Wstęp\n# Hej\n" });
    await service.checkNow(link.id);
    expect(await textOf(bridge, id)).toBe("Wstęp\n# Hej\nMoje\n");
  });
});

describe("archive names", () => {
  it("the archived file is named after the blob's short sha and the file's name in the repository", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "docs/README.md": "# Hej\n" });
    network(gh);
    const store = new FakeStore();
    const { service } = device(store);
    const link = await service.connect(PROJECT, { ...OPTIONS, repoPath: "docs" });
    expect(link.status).toBe("ok");
    const sha = await gitBlobSha1(enc.encode("# Hej\n"));
    expect(store.records.get(await archiveId(SECRET, link.id, sha))?.name).toBe(`GitHub ${sha.slice(0, 7)} README.md`);
  });
});

describe("archive ids and the token", () => {
  it("two devices give a blob the same id; the second upload's 409 counts as archived", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n" });
    network(gh);
    const store = new FakeStore();
    const a = device(store, "a");
    const link = await a.service.connect(PROJECT, OPTIONS);
    const b = device(store, "b");
    b.bridge.mergeBrowserSnapshot(a.bridge.exportBrowserSnapshot("a"));
    // the same bytes under another path: the same blob, so the same archive id, already written by device a
    await gh.commit("kopia", { "kopia/README.md": "# Hej\n" });
    expect(await b.service.checkNow(link.id)).toBe("ok");
    const sha = await gitBlobSha1(enc.encode("# Hej\n"));
    const id = await archiveId(SECRET, link.id, sha);
    expect(store.records.get(id)?.by).toBe("a");
    expect([...store.records.keys()]).toEqual([id]);
    expect(await archiveId(SECRET, link.id, sha)).toBe(id);
    expect(await archiveId(SECRET, "f".repeat(32), sha)).not.toBe(id);
  });

  it("the token goes only to api.github.com, never to the notes server or into the vault state", async () => {
    const gh = new FakeGitHub(REPO);
    await gh.commit("start", { "README.md": "# Hej\n" });
    const sent = network(gh);
    const { bridge, service } = device(new FakeStore());
    expect(service.hasToken()).toBe(false);
    await service.setToken(TOKEN);
    expect(service.hasToken()).toBe(true);
    await service.connect(PROJECT, OPTIONS);
    const github = sent.filter((s) => s.url.startsWith("https://api.github.com/"));
    expect(github.length).toBeGreaterThan(0);
    for (const s of github) expect((s.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    for (const s of sent.filter((x) => !x.url.startsWith("https://api.github.com/"))) {
      expect(s.url).not.toContain(TOKEN);
      expect(JSON.stringify(s.init ?? {})).not.toContain(TOKEN);
    }
    expect(JSON.stringify(bridge.exportBrowserSnapshot("a"))).not.toContain(TOKEN);
  });
});
