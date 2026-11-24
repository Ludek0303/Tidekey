// @vitest-environment jsdom
import type { OrganizationSnapshot } from "./taskhistory";
import { loadWasm } from "./testwasm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BrowserBridge, decryptSnapshot, encryptSnapshot, newRecoveryKey } from "./browserauth";
import { newLink, type GithubLink } from "./github/link";
import { githubService } from "./github/service";
import { FakeGitHub } from "./github/testgithub";
import { syncPreferences } from "./preferences";
import { ancestorsOf, inside, landsTop, openPayload, payloadOf } from "./protected";
import { PROTECTED_FILE_TEXT } from "./folderfiles";
import type { BrowserVaultSnapshot, ProjectProtection, TrashEntry, TreeListing } from "./bridge";
import { signEvent, type SigningIdentity } from "./signing";
import type { BoxIdentity } from "./sealed";
import { icon } from "./icons";
import { historyCard } from "./taskpanel";
import { FileTree } from "./tree";
import { importVaultKey, randomVaultKey, type RemoteMember, type Role, type VaultAccess } from "./vaults";
import { generateAgentKeys, newAgentId, openForAgent, projectSlot, signAsAgent, signCert, type AgentCert, type WriteMode } from "./agentcrypto";

// A small IndexedDB stand-in that keeps its rows across opens, so a reopened bridge reads what the earlier one wrote.
function keepingIdb() {
  type Store = { keyPath: string | string[]; rows: Map<string, Record<string, unknown>> };
  const stores = new Map<string, Store>();
  const keyOf = (keyPath: string | string[], row: Record<string, unknown>) => JSON.stringify(Array.isArray(keyPath) ? keyPath.map((k) => row[k]) : row[keyPath]);
  const later = <T,>(run: () => T) => {
    const req: { result?: T; onsuccess?: () => void } = {};
    queueMicrotask(() => { req.result = run(); req.onsuccess?.(); });
    return req;
  };
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    close: () => undefined,
    createObjectStore: (name: string, options: { keyPath: string | string[] }) => { stores.set(name, { keyPath: options.keyPath, rows: new Map() }); },
    transaction: (name: string) => {
      const store = stores.get(name)!;
      const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          get: (key: unknown) => later(() => store.rows.get(JSON.stringify(key))),
          getAll: () => later(() => [...store.rows.values()]),
          put: (row: Record<string, unknown>) => later(() => {
            store.rows.set(keyOf(store.keyPath, row), structuredClone(row));
            queueMicrotask(() => tx.oncomplete?.());
            return undefined;
          }),
        }),
      };
      return tx;
    },
  };
  const indexedDB = {
    open: () => {
      const req: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = {};
      queueMicrotask(() => { req.result = database; if (!stores.size) req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
  return { indexedDB };
}

const OWNER = "owner-user";
const MEMBER = "member-user";
const OUTSIDER = "outsider-user";
const ADMIN = "admin-user";
const VAULT = `v-${"c".repeat(32)}`;
const RAW = randomVaultKey();
const PROJECT = "Projekty/Alfa";
const vaultInfo = { id: VAULT, name: "Zespół", kind: "organizacja" as const, ownerUserId: OWNER, keyEpoch: 1 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

// Each user's box key (sealing) and signing key (signatures): the public halves go to the members list.
interface Person { box: BoxIdentity; signing: SigningIdentity; member: RemoteMember }
async function person(userId: string, role: Role): Promise<Person> {
  const box = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const boxJwk = await crypto.subtle.exportKey("jwk", box.publicKey);
  const signJwk = await crypto.subtle.exportKey("jwk", sign.publicKey);
  const boxKey = { kty: boxJwk.kty, crv: boxJwk.crv, x: boxJwk.x, y: boxJwk.y } as JsonWebKey;
  const signingKey = { kty: signJwk.kty, crv: signJwk.crv, x: signJwk.x, y: signJwk.y } as JsonWebKey;
  return {
    box: { userId, privateKey: box.privateKey, publicJwk: boxKey },
    signing: { userId, privateKey: sign.privateKey, publicJwk: signingKey },
    member: { userId, email: `${userId}@example.test`, name: userId, role, boxKey, signingKey },
  };
}
const people = new Map<string, Person>();
async function setUp(): Promise<void> {
  people.clear();
  people.set(OWNER, await person(OWNER, "owner"));
  people.set(MEMBER, await person(MEMBER, "editor"));
  people.set(OUTSIDER, await person(OUTSIDER, "editor"));
  // the outsider stays in the vault, but not in the project
}
const members = (): RemoteMember[] => [...people.values()].map((p) => p.member);

// An in-memory stand-in for the local IndexedDB (only what the key stores use).
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const request = (run: (req: { result?: unknown; onsuccess?: () => void }) => void) => {
    const req: { result?: unknown; onsuccess?: () => void } = {};
    queueMicrotask(() => { run(req); req.onsuccess?.(); });
    return req;
  };
  return {
    rows,
    transaction: () => ({
      objectStore: () => ({
        get: () => request((req) => { req.result = undefined; }),
        put: (item: Record<string, unknown>) => request(() => rows.set(JSON.stringify([item.userId, item.vaultId]), item)),
        getAll: () => request((req) => { req.result = []; }),
      }),
    }),
  } as unknown as IDBDatabase;
}

// The bridge as these tests drive it: its calls, the save step and the server's update.
interface Driver {
  call<T>(cmd: string, args?: unknown): Promise<T>;
  exportBrowserSnapshot(ownerUserId: string, vaultId?: string): BrowserVaultSnapshot;
  sealProtected(): Promise<void>;
  persist(): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
}
// A bridge of one user over the shared vault key, with the save step stubbed (its storage is covered elsewhere).
async function bridgeFor(userId: string, role: Role): Promise<Driver> {
  const who = people.get(userId)!;
  const personal = (await newRecoveryKey()).key;
  const access: VaultAccess = { vault: vaultInfo, role, members: members(), rawKey: RAW, keyEpoch: 1 };
  const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => Record<string, unknown>;
  const bridge = new Ctor({ id: userId, email: `${userId}@example.test`, name: userId }, personal, fakeDb(), await importVaultKey(RAW), access);
  Object.assign(bridge, { persist: vi.fn(async () => undefined), box: who.box, signing: who.signing });
  return bridge as unknown as Driver;
}

let revision = 0;
// Delivers a snapshot to `to` as the server would: sealed under the shared key, received as an update.
async function deliver(to: Driver, snapshot: BrowserVaultSnapshot): Promise<void> {
  await to.handleMessage({ type: "update", revision: ++revision, envelope: await encryptSnapshot(snapshot, await importVaultKey(RAW), 1) });
}
// Sends `from`'s state to `to`, as a save of `from` followed by the server's update.
async function sync(from: Driver, to: Driver): Promise<void> {
  await from.sealProtected();
  await deliver(to, from.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot);
}

async function note(b: Driver, path: string, text: string): Promise<string> {
  const id = await b.call<string>("create_note", { path });
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
  return id;
}
async function textOf(b: Driver, id: string): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
  return doc.getText("content").toString();
}
const paths = async (b: Driver): Promise<string[]> => (await b.call<TreeListing>("list_tree")).notes.map((n) => n.path).sort();
const plainUnder = (snapshot: BrowserVaultSnapshot, folder: string): string[] => snapshot.state.notes.filter((n) => n.path.startsWith(`${folder}/`)).map((n) => n.path);

// The owner after a reload: the project's sealed entry comes back from the stored copy and the server's copy arrives.
async function reopenedOwner(): Promise<{ owner: Driver; reopened: Driver; first: Driver; reopen: () => Promise<Driver> }> {
  await setUp();
  vi.stubGlobal("indexedDB", keepingIdb().indexedDB);
  vi.stubGlobal("IDBKeyRange", { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) });
  vi.stubGlobal("WebSocket", class { addEventListener() {} send() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const who = people.get(OWNER)!;
  const user = { id: OWNER, email: `${OWNER}@example.test`, name: OWNER };
  const personal = (await newRecoveryKey()).key;
  const access: VaultAccess = { vault: vaultInfo, role: "owner", members: members(), rawKey: RAW, keyEpoch: 1 };
  const reopen = async () => (await BrowserBridge.open(user, personal, access, who.signing, who.box)) as unknown as Driver;
  const first = await reopen();
  return { owner: first, reopened: await reopen(), first, reopen };
}
// An entry for a note alone, as an older version protected it (the app no longer does): the steps of project_protect.
async function legacyNoteProtect(b: Driver, path: string, members: string[]): Promise<void> {
  await (b as unknown as { protectProject(p: string, m: string[], e: string[], t: string): Promise<void> }).protectProject(path, members, [], "note");
}
describe("protected projects", () => {
  it("a note has its folder's rights: the innermost protected folder above it, or else its own folder; protecting a note is refused", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await note(owner, `${PROJECT}/Umowy/Plan.md`, "# Plan\n");
    await note(owner, "Notatki/A.md", "# A\n");
    await note(owner, "Root.md", "# Root\n");
    const pathOf = async (p: string) => (await owner.call<ProjectProtection>("project_protection", { path: p })).path;
    expect(await pathOf(`${PROJECT}/Alfa.md`)).toBe(PROJECT);
    expect(await pathOf(`${PROJECT}/Umowy/Plan.md`)).toBe(`${PROJECT}/Umowy`);
    expect(await pathOf("Notatki/A.md")).toBe("Notatki");
    await expect(owner.call("project_protection", { path: "Root.md" })).rejects.toThrow("ograniczać można tylko foldery");
    await expect(owner.call("project_protect", { path: "Notatki/A.md", members: [MEMBER] })).rejects.toThrow("Notatki nie mają własnych uprawnień");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    expect(await pathOf(`${PROJECT}/Umowy/Plan.md`)).toBe(PROJECT);
  });

  it("inside: a note is inside its own path, and a folder holds what is under it", () => {
    expect(inside("Notatki/A.md", "Notatki/A.md")).toBe(true);
    expect(inside("Projekty/Alfa/x.md", "Projekty/Alfa")).toBe(true);
    expect(inside("Projekty/Alfa.md", "Projekty/Alfa")).toBe(false);
    expect(inside("Notatki/A.md.bak", "Notatki/A.md")).toBe(false);
  });

  it("a note is hidden from a non-member of its folder's protection and kept for a member", async () => {
    await setUp();
    const NOTE = "Notatki/Sekret.md";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    const id = await note(owner, NOTE, "# Sekret\n\nTajne.");
    await owner.call("project_protect", { path: "Notatki", members: [MEMBER] });
    const snapshot = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(snapshot.state.protected?.map((e) => e.path)).toEqual(["Notatki"]);
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");

    await sync(owner, outsider);
    expect(await paths(outsider)).toEqual([]);
    expect((await outsider.call<TreeListing>("list_tree")).locked).toEqual([]);
    await expect(outsider.call("create_note", { path: NOTE })).rejects.toThrow("Projekt jest chroniony");

    await sync(owner, member);
    expect(await paths(member)).toEqual([NOTE]);
    expect(await textOf(member, id)).toContain("Tajne.");
  });

  it("files in folders: no place inside a protected project, and a file a hidden note may embed is never trashed", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await note(owner, "Notatki/A.md", "# A\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    const fileId = "f".repeat(32);
    // the place would show the file's name to every member: refused for the key holders too
    for (const cmd of ["folder_file_add", "folder_file_rename"]) {
      await expect(owner.call(cmd, { fileId, path: `${PROJECT}/umowa.pdf` })).rejects.toThrow(PROTECTED_FILE_TEXT);
      await expect(owner.call(cmd, { fileId, path: `${PROJECT}/Umowy/umowa.pdf` })).rejects.toThrow(PROTECTED_FILE_TEXT);
    }
    await sync(owner, outsider);
    // the owner reads every note, so only real embeds count; the outsider cannot, so a file is always "maybe embedded"
    const embedded = (b: Driver) => (b as unknown as { embedded(id: string): boolean }).embedded(fileId);
    expect([embedded(owner), embedded(outsider)]).toEqual([false, true]);

    // a folder holding files neither moves into the project nor becomes protected; a stray entry never leaves
    const place = (path: string, id: string) => (owner as unknown as { folderFiles: Map<string, unknown> }).folderFiles.set(id, { fileId: id, path, changedAt: 1, deleted: false });
    place("Plain/umowa.pdf", "a".repeat(32));
    await expect(owner.call("rename_folder", { from: "Plain", to: `${PROJECT}/Plain` })).rejects.toThrow(PROTECTED_FILE_TEXT);
    await expect(owner.call("project_protect", { path: "Plain", members: [MEMBER] })).rejects.toThrow("leżą pliki");
    place(`${PROJECT}/tajne.pdf`, "b".repeat(32));
    const exported = JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT));
    expect(exported).toContain("Plain/umowa.pdf");
    expect(exported).not.toContain("tajne.pdf");
  });

  it("editors: a member who is not an editor reads the note but cannot write it", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "Start.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [OUTSIDER] });
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0].editors).toEqual([OUTSIDER, OWNER].sort());
    await sync(owner, member);

    expect(await textOf(member, id)).toContain("Start.");
    await expect(member.call("create_note", { path: `${PROJECT}/Nowa.md` })).rejects.toThrow("Masz tylko podgląd");
    const edit = new Y.Doc();
    edit.getText("content").insert(0, "Zmiana. ");
    await member.call("apply_update", { id, update: Y.encodeStateAsUpdate(edit) });
    expect(await textOf(member, id)).toBe("Start.");
    await expect(owner.call("create_note", { path: `${PROJECT}/Nowa.md` })).resolves.toBeDefined();
  });

  it("checkEntry flags a members change signed by a plain member", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, outsider);

    const snapshot = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    const forged = snapshot.state.protected![0];
    forged.members = [...forged.members, OUTSIDER].sort();
    await signEvent(forged, people.get(MEMBER)!.signing);
    await deliver(owner, snapshot);

    const check = (await owner.call<TreeListing>("list_tree")).locked![0].check;
    expect(check).toEqual({ status: "unverified", reason: "Zmiana członków lub edytorów przez osobę bez uprawnień." });
  });

  // docs/MCP.md §6: the lead is in the signed entry, set by an owner or admin; the note's `prowadzacy:` text gives no rights.
  it("a member who writes himself in as prowadzacy: neither manages the project nor gets a members change verified", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "---\ntyp: projekt\nprowadzacy:\n---\n# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    const id = (await member.call<TreeListing>("list_tree")).notes.find((n) => n.path === `${PROJECT}/Alfa.md`)!.id;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await member.call<Uint8Array>("open_note", { id }));
    const text = doc.getText("content");
    const at = text.toString().indexOf("prowadzacy:") + "prowadzacy:".length;
    const before = Y.encodeStateVector(doc);
    text.insert(at, ` ${MEMBER}`);
    await member.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
    expect(await textOf(member, id)).toContain(`prowadzacy: ${MEMBER}`);

    expect((await member.call<ProjectProtection>("project_protection", { path: PROJECT })).manage).toBe(false);
    await expect(member.call("project_set_members", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [MEMBER] })).rejects.toThrow();

    await sync(member, owner);
    const snapshot = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    const forged = snapshot.state.protected![0];
    forged.members = [...forged.members, OUTSIDER].sort();
    await signEvent(forged, people.get(MEMBER)!.signing);
    await deliver(owner, snapshot);
    const check = (await owner.call<TreeListing>("list_tree")).locked![0].check;
    expect(check).toEqual({ status: "unverified", reason: "Zmiana członków lub edytorów przez osobę bez uprawnień." });
  });

  it("the lead an owner sets in the entry manages the members, but cannot change the lead", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER], lead: MEMBER });
    expect((await owner.call<ProjectProtection>("project_protection", { path: PROJECT })).lead).toBe(MEMBER);
    await sync(owner, member);
    const info = await member.call<ProjectProtection>("project_protection", { path: PROJECT });
    expect(info.manage).toBe(true);
    expect(info.lead).toBe(MEMBER);
    await expect(member.call("project_set_members", { path: PROJECT, members: [MEMBER], editors: [MEMBER], lead: OUTSIDER })).rejects.toThrow("Prowadzącego zmienia właściciel lub administrator.");
    await member.call("project_set_members", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [MEMBER] });
    await sync(member, owner);
    await sync(member, outsider);
    expect((await owner.call<TreeListing>("list_tree")).locked![0].check?.status).not.toBe("unverified");
    expect((await outsider.call<ProjectProtection>("project_protection", { path: PROJECT })).lead).toBe(MEMBER);

    // the lead signs a new lead in: refused at every other member
    const snapshot = JSON.parse(JSON.stringify(member.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    snapshot.state.protected![0].lead = { ...snapshot.state.protected![0].lead!, userId: OUTSIDER };
    await signEvent(snapshot.state.protected![0].lead!, people.get(MEMBER)!.signing);
    await signEvent(snapshot.state.protected![0], people.get(MEMBER)!.signing);
    await deliver(owner, snapshot);
    expect((await owner.call<TreeListing>("list_tree")).locked![0].check).toEqual({ status: "unverified", reason: "Prowadzącego zmienia właściciel lub administrator." });
  });

  it("an appointment signed by a non-admin gives no lead; a tampered one flags the entry", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [MEMBER, OUTSIDER] });
    const snapshot = JSON.parse(JSON.stringify((await (async () => { await owner.sealProtected(); return owner.exportBrowserSnapshot(OWNER, VAULT); })()))) as BrowserVaultSnapshot;
    snapshot.state.protected![0].lead = { schema: "notes-project-lead-v1", vaultId: VAULT, path: PROJECT, userId: MEMBER };
    await signEvent(snapshot.state.protected![0].lead, people.get(MEMBER)!.signing);
    await signEvent(snapshot.state.protected![0], people.get(MEMBER)!.signing);
    await deliver(outsider, snapshot);
    expect((await outsider.call<ProjectProtection>("project_protection", { path: PROJECT })).lead).toBeNull();
    await deliver(member, snapshot);
    expect((await member.call<ProjectProtection>("project_protection", { path: PROJECT })).manage).toBe(false);

    // an owner's appointment of someone else, edited to name the member after it was signed
    const tampered = JSON.parse(JSON.stringify(snapshot)) as BrowserVaultSnapshot;
    tampered.state.protected![0].lead = { schema: "notes-project-lead-v1", vaultId: VAULT, path: PROJECT, userId: OUTSIDER };
    await signEvent(tampered.state.protected![0].lead, people.get(OWNER)!.signing);
    tampered.state.protected![0].lead.userId = MEMBER;
    await signEvent(tampered.state.protected![0], people.get(MEMBER)!.signing);
    const fresh = await bridgeFor(OUTSIDER, "editor");
    await deliver(fresh, tampered);
    expect((await fresh.call<TreeListing>("list_tree")).locked![0].check).toEqual({ status: "unverified", reason: "Prowadzącego zmienia właściciel lub administrator." });
  });

  // review of stage 1, finding 3: a change flagged once is checked against the last verified entry after a reload too
  it("a members change flagged once stays flagged after the owner reopens", async () => {
    const { first, reopen } = await reopenedOwner();
    await note(first, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await first.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER], lead: MEMBER });
    await first.persist();
    const snapshot = JSON.parse(JSON.stringify(first.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    const forged = snapshot.state.protected![0];
    forged.members = [...forged.members, OUTSIDER].sort();
    delete forged.lead; // and the lead dropped by someone who may not
    await signEvent(forged, people.get(MEMBER)!.signing); // an editor of the project
    await deliver(first, snapshot);
    expect((await first.call<TreeListing>("list_tree")).locked![0].check?.status).toBe("unverified");
    await first.persist();

    const again = await reopen();
    await deliver(again, snapshot);
    expect((await again.call<TreeListing>("list_tree")).locked![0].check?.status).toBe("unverified");
    expect((await again.call<ProjectProtection>("project_protection", { path: PROJECT })).lead).toBeNull();
  });

  // finding 8: an appointment whose signer is no longer an owner or admin lapses; the entry itself stays valid
  it("a lead appointed by an owner who is now an editor has lapsed: no lead, and the entry is still verified", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER], lead: MEMBER });
    const demoted = people.get(OWNER)!.member;
    people.set(OWNER, { ...people.get(OWNER)!, member: { ...demoted, role: "editor" } });
    people.set(ADMIN, await person(ADMIN, "owner"));
    const member = await bridgeFor(MEMBER, "editor");
    await sync(owner, member);
    expect((await member.call<TreeListing>("list_tree")).locked![0].check?.status).not.toBe("unverified");
    const info = await member.call<ProjectProtection>("project_protection", { path: PROJECT });
    expect(info.lead).toBeNull();
    expect(info.manage).toBe(false);
  });

  // second review, finding A: the baseline's lead is checked again: one whose appointment lapsed manages nothing
  it("a lead whose appointment lapsed cannot change the members, even against a baseline that named them", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [MEMBER, OUTSIDER], lead: MEMBER });
    await sync(owner, outsider); // the outsider (a member here) has a baseline naming MEMBER as lead
    people.set(OWNER, { ...people.get(OWNER)!, member: { ...people.get(OWNER)!.member, role: "editor" } });
    Object.assign(outsider, { serverMembers: members() }); // the owner is an editor now
    const snapshot = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    snapshot.state.protected![0].editors = [MEMBER]; // the lead takes the outsider's edit right away
    await signEvent(snapshot.state.protected![0], people.get(MEMBER)!.signing);
    await deliver(outsider, snapshot);
    expect((await outsider.call<TreeListing>("list_tree")).locked![0].check?.status).toBe("unverified");
  });

  // second review, finding C: an unprotect mark drops the entry on every device, so it must be an owner's or admin's
  it("an unsigned mark, or one an editor signed, does not lift a protection", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    const base = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    const keyEpoch = base.state.protected![0].keyEpoch;
    const unsigned = { ...base, state: { ...base.state, unprotected: [{ path: PROJECT, keyEpoch, unprotectedAt: Date.now() }] } } as BrowserVaultSnapshot;
    await deliver(member, unsigned);
    expect((await member.call<ProjectProtection>("project_protection", { path: PROJECT })).protected).toBe(true);
    const byEditor = JSON.parse(JSON.stringify(unsigned)) as BrowserVaultSnapshot;
    await signEvent(byEditor.state.unprotected![0], people.get(MEMBER)!.signing);
    await deliver(owner, byEditor);
    expect((await owner.call<ProjectProtection>("project_protection", { path: PROJECT })).protected).toBe(true);
    expect(plainUnder(owner.exportBrowserSnapshot(OWNER, VAULT), PROJECT)).toEqual([]);
  });

  it("a flagged entry takes no writes, and the owner's device never signs it again", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    const snapshot = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    snapshot.state.protected![0].members = [MEMBER, OUTSIDER].sort(); // the owner left out: healAdmins would add them back
    await signEvent(snapshot.state.protected![0], people.get(MEMBER)!.signing);
    await deliver(owner, snapshot);
    await new Promise((r) => setTimeout(r, 50));
    const held = owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0];
    expect(held.signerUserId).toBe(MEMBER);
    expect((await owner.call<TreeListing>("list_tree")).locked![0].check?.status).toBe("unverified");
    await expect(owner.call("create_note", { path: `${PROJECT}/Nowa.md` })).rejects.toThrow();
  });

  it("owners and admins are in a project even when not picked", async () => {
    await setUp();
    people.set(ADMIN, await person(ADMIN, "admin"));
    const owner = await bridgeFor(OWNER, "owner"), admin = await bridgeFor(ADMIN, "admin");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0].members).toEqual([ADMIN, MEMBER, OWNER].sort());
    await sync(owner, admin);
    expect(await textOf(admin, id)).toContain("# Alfa");
  });

  it("an owner adds an admin missing from a project, with the same key", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    people.set(ADMIN, await person(ADMIN, "admin"));

    const later = await bridgeFor(OWNER, "owner");
    await sync(owner, later);
    await vi.waitFor(() => expect(later.exportBrowserSnapshot(OWNER, VAULT).state.protected![0].members).toContain(ADMIN));
    expect(later.exportBrowserSnapshot(OWNER, VAULT).state.protected![0].keyEpoch).toBe(1);

    const admin = await bridgeFor(ADMIN, "admin");
    await sync(later, admin);
    expect(await textOf(admin, id)).toContain("# Alfa");
  });

  it("protect by the project note's path is refused: the project folder is protected, and it covers the note", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await expect(owner.call("project_protect", { path: `${PROJECT}/Alfa.md`, members: [MEMBER] })).rejects.toThrow("Notatki nie mają własnych uprawnień");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    const snapshot = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(snapshot.state.protected?.map((e) => e.path)).toEqual([PROJECT]);
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");
  });

  it("protect: the notes leave the plain state, and a member decrypts them", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });

    const snapshot = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(plainUnder(snapshot, PROJECT)).toEqual([]);
    expect(snapshot.state.versions.map(([noteId]) => noteId)).not.toContain(id);
    expect(snapshot.state.protected).toHaveLength(1);
    expect(snapshot.state.protected![0].keys.map((k) => k.userId).sort()).toEqual([MEMBER, OWNER].sort());
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");

    // a save leaves an unchanged project alone: the same entry object comes out again
    const entry = snapshot.state.protected![0];
    await owner.sealProtected();
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0]).toBe(entry);

    await sync(owner, member);
    expect(await paths(member)).toContain(`${PROJECT}/Alfa.md`);
    expect(await textOf(member, id)).toContain("Tajne.");
  });

  it("task history and task copies of a protected project travel only inside it", async () => {
    await loadWasm(); // the task lines are read by the core
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\n- [ ] Tajne zadanie @owner-user ^z-tajne1\n");
    const events = async (b: Driver) => (await b.call<OrganizationSnapshot>("organization_snapshot")).events.filter((e) => e.after.title.includes("Tajne zadanie"));
    expect((await events(owner)).length).toBeGreaterThan(0);
    await owner.call("save_task_cache", { saved: { userId: OWNER, rows: [{ path: `${PROJECT}/Alfa.md`, text: "Tajne zadanie" }, { path: "Inne.md", text: "jawne" }] } });
    await sync(owner, outsider); // the outsider got the plain history while the project was still open
    expect((await events(outsider)).length).toBeGreaterThan(0);

    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    const sent = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(JSON.stringify(sent)).not.toContain("Tajne zadanie");
    expect(JSON.stringify(sent)).toContain("jawne");
    expect(sent.state.protected![0].noteIds).toHaveLength(1);
    expect((await events(owner)).length).toBeGreaterThan(0); // the owner keeps it, sealed

    await sync(owner, member);
    expect((await events(member)).length).toBeGreaterThan(0);
    await sync(owner, outsider);
    expect(await events(outsider)).toEqual([]);
    expect(JSON.stringify(outsider.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Tajne zadanie");
  });

  it("non-member: re-emits the opaque entry unchanged, sees no notes and cannot create any", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, outsider);
    const sent = owner.exportBrowserSnapshot(OWNER, VAULT).state.protected!;

    await outsider.sealProtected();
    const out = outsider.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(out.state.protected).toEqual(sent);
    expect(plainUnder(out, PROJECT)).toEqual([]);
    expect(await paths(outsider)).toEqual([]);
    // a non-member is not told the project exists: no locked row either
    expect((await outsider.call<TreeListing>("list_tree")).locked).toEqual([]);
    await expect(outsider.call("create_note", { path: `${PROJECT}/Nowa.md` })).rejects.toThrow("Projekt jest chroniony");
  });

  it("a new protection: a picked member without 'może edytować' is read-only; a non-member cannot delete by id or see the folder", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, member);
    await sync(owner, outsider);
    const entry = owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0];
    expect(entry.editors).toEqual([OWNER]);

    await expect(member.call("create_note", { path: `${PROJECT}/Nowa.md` })).rejects.toThrow("Masz tylko podgląd");
    await expect(member.call("delete", { id })).rejects.toThrow("Masz tylko podgląd");
    await expect(outsider.call("delete", { id })).rejects.toThrow("Projekt jest chroniony");
    await expect(outsider.call("delete_folder", { path: PROJECT })).rejects.toThrow();
    expect((await outsider.call<TreeListing>("list_tree")).folders).not.toContain(PROJECT);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`]);
  });

  it("two members' concurrent edits in a protected project merge", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "Start.\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);

    const edit = async (b: Driver, text: string) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, await b.call<Uint8Array>("open_note", { id }));
      const before = Y.encodeStateVector(doc);
      doc.getText("content").insert(0, text);
      await b.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before) });
    };
    await edit(owner, "Właściciel. ");
    await edit(member, "Członek. ");
    await sync(owner, member);
    await sync(member, owner);
    expect(await textOf(owner, id)).toContain("Właściciel.");
    expect(await textOf(owner, id)).toContain("Członek.");
    expect(await textOf(member, id)).toContain("Właściciel.");
    expect(await textOf(member, id)).toContain("Członek.");
  });

  it("removing a project member rotates the key: epoch + 1, the removed member has no key", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, member);
    expect(await paths(member)).toEqual([`${PROJECT}/Alfa.md`]);

    await owner.call("project_set_members", { path: PROJECT, members: [] });
    const entry = owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0];
    expect(entry.keyEpoch).toBe(2);
    expect(entry.members).toEqual([OWNER]);
    expect(entry.keys.map((k) => k.userId)).toEqual([OWNER]);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`]);

    await sync(owner, member);
    expect(await paths(member)).toEqual([]);
    expect((await member.call<TreeListing>("list_tree")).locked).toEqual([]);
  });

  it("a tampered entry is kept but flagged, and its notes stay on the member's device", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, member);

    const snapshot = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;
    const envelope = snapshot.state.protected![0].envelope;
    envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
    await deliver(member, snapshot);

    const listing = await member.call<TreeListing>("list_tree");
    expect(listing.locked![0].check?.status).toBe("unverified");
    expect(await paths(member)).toEqual([`${PROJECT}/Alfa.md`]);
    const out = member.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(out.state.protected![0].envelope.ciphertext).toBe(envelope.ciphertext);
  });

  it("an unprotect marker beats an older protected copy", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, member);
    const older = JSON.parse(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))) as BrowserVaultSnapshot;

    await owner.call("project_unprotect", { path: PROJECT });
    await sync(owner, member);
    expect(await textOf(member, id)).toContain("# Alfa");

    await deliver(member, older);
    const out = member.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(out.state.protected).toBeUndefined();
    expect(out.state.unprotected?.map((m) => m.path)).toEqual([PROJECT]);
    expect(plainUnder(out, PROJECT)).toEqual([`${PROJECT}/Alfa.md`]);
  });

  it("the tree hides a protected folder from a non-member; a member sees it with no lock icon", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, outsider);
    await sync(owner, member);

    const render = async (b: Driver) => {
      const host = document.createElement("div");
      document.body.append(host);
      const tree = new FileTree(host, () => undefined);
      const listing = await b.call<TreeListing>("list_tree");
      tree.setItems(listing.notes, listing.folders, listing.locked ?? []);
      tree.expandAll();
      return host;
    };
    const asOutsider = await render(outsider);
    expect(asOutsider.innerHTML).not.toContain(icon("lock").innerHTML);
    expect(asOutsider.textContent).not.toContain("Alfa");

    const asMember = await render(member);
    expect(asMember.innerHTML).not.toContain(icon("lock").innerHTML);
    expect(asMember.textContent).toContain("Alfa");
  });

  it("a member creates folders and a note in a protected project: members get them, a non-member gets no trace", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    await sync(owner, outsider);

    await member.call("create_folder", { path: `${PROJECT}/Dokumenty` });
    await member.call("create_folder", { path: `${PROJECT}/Dokumenty/Podfolder` });
    await member.call("create_note", { path: `${PROJECT}/Dokumenty/Umowa.md` });
    await expect(outsider.call("create_folder", { path: `${PROJECT}/Obcy` })).rejects.toThrow("Projekt jest chroniony");
    await sync(member, owner);

    const ownerFolders = (await owner.call<TreeListing>("list_tree")).folders;
    expect(ownerFolders).toEqual(expect.arrayContaining([`${PROJECT}/Dokumenty`, `${PROJECT}/Dokumenty/Podfolder`]));
    expect(await paths(owner)).toContain(`${PROJECT}/Dokumenty/Umowa.md`);

    await sync(owner, outsider);
    expect((await outsider.call<TreeListing>("list_tree")).folders.join("\n")).not.toContain("Dokumenty");
    expect(JSON.stringify(outsider.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Dokumenty");

    // the member's own copy keeps the folders once the server's copy comes back
    await sync(owner, member);
    expect((await member.call<TreeListing>("list_tree")).folders).toContain(`${PROJECT}/Dokumenty/Podfolder`);
  });

  it("a member renames a folder inside a protected project; the project folder itself is not moved", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    await member.call("create_folder", { path: `${PROJECT}/Bez nazwy` });
    await member.call("rename_folder", { from: `${PROJECT}/Bez nazwy`, to: `${PROJECT}/Dokumenty` });
    expect((await member.call<TreeListing>("list_tree")).folders).toContain(`${PROJECT}/Dokumenty`);
    // an editor still does not make a top-level folder by a move
    await expect(member.call("rename_folder", { from: `${PROJECT}/Dokumenty`, to: "Projekty/Inne" })).rejects.toThrow("Główne foldery");
    await expect(member.call("rename_folder", { from: PROJECT, to: "Projekty/Beta" })).rejects.toThrow("Chronionego projektu");
  });

  it("drag and drop: a note or folder moved out of a project becomes a plain one, for everyone in the vault", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, "Notatki/Jawna.md", "# Jawna\n");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const id = await note(owner, `${PROJECT}/Plan.md`, "# Plan\n\nDo pokazania.");
    const inFolder = await note(owner, `${PROJECT}/Dokumenty/Umowa.md`, "# Umowa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    await sync(owner, outsider);
    expect(await paths(outsider)).toEqual(["Notatki/Jawna.md"]);

    await member.call("rename", { id, path: "Notatki/Plan.md" });
    await member.call("rename_folder", { from: `${PROJECT}/Dokumenty`, to: "Notatki/Dokumenty" });
    await member.sealProtected();
    const sent = member.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(sent.state.protected![0].noteIds).not.toContain(id);
    expect(sent.state.protected![0].noteIds).not.toContain(inFolder);
    expect(sent.state.notes.map((n) => n.path).sort()).toEqual(["Notatki/Dokumenty/Umowa.md", "Notatki/Jawna.md", "Notatki/Plan.md"]);

    await deliver(outsider, sent);
    await deliver(owner, sent);
    expect(await paths(outsider)).toEqual(["Notatki/Dokumenty/Umowa.md", "Notatki/Jawna.md", "Notatki/Plan.md"]);
    expect(await textOf(outsider, id)).toContain("Do pokazania.");
    expect(await paths(owner)).toEqual(["Notatki/Dokumenty/Umowa.md", "Notatki/Jawna.md", "Notatki/Plan.md", `${PROJECT}/Alfa.md`]);
    // the owner's next save keeps it out of the project
    await owner.sealProtected();
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0].noteIds).toEqual(sent.state.protected![0].noteIds);
  });

  it("drag and drop: a note or folder moved into a project is sealed with it, and a non-member forgets it", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    const id = await note(owner, "Notatki/Tajna.md", "# Tajna\n\nPrzenoszona.");
    const inFolder = await note(owner, "Notatki/Teczka/Umowa.md", "# Umowa\n");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    await sync(owner, outsider);
    expect(await paths(outsider)).toEqual(["Notatki/Tajna.md", "Notatki/Teczka/Umowa.md"]);
    // without the project's key nothing moves in
    await expect(outsider.call("rename", { id, path: `${PROJECT}/Tajna.md` })).rejects.toThrow("Projekt jest chroniony");
    await expect(outsider.call("rename_folder", { from: "Notatki/Teczka", to: `${PROJECT}/Teczka` })).rejects.toThrow("Projekt jest chroniony");

    await member.call("rename", { id, path: `${PROJECT}/Tajna.md` });
    await member.call("rename_folder", { from: "Notatki/Teczka", to: `${PROJECT}/Teczka` });
    await sync(member, outsider);
    expect(await paths(outsider)).toEqual([]);
    await outsider.sealProtected();
    expect(JSON.stringify(outsider.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Przenoszona");
    await sync(member, owner);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`, `${PROJECT}/Tajna.md`, `${PROJECT}/Teczka/Umowa.md`]);
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected![0].noteIds).toEqual(expect.arrayContaining([id, inFolder]));
  });

  it("a forged plain copy of a protected note (an id from the public noteIds) does not pull it out of its project", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    const id = await note(owner, `${PROJECT}/Tajna.md`, "# Tajna\n\nNie dla wszystkich.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, outsider);
    const forged = outsider.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(forged.state.protected![0].noteIds).toContain(id);
    forged.state.notes.push({ id, path: "Notatki/x.md", pathChangedAt: Date.now() + 1e9, yjsUpdateBase64: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(new Y.Doc()))) });
    await deliver(owner, forged);
    expect(await paths(owner)).toEqual([`${PROJECT}/Tajna.md`]);
    await owner.sealProtected();
    expect(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Nie dla wszystkich");
  });

  it("another project's payload listing a protected note does not take it away on a device holding both", async () => {
    await setUp();
    const BETA = "Projekty/Beta";
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    const id = await note(owner, `${PROJECT}/Tajna.md`, "# Tajna\n\nTylko Alfa.");
    await note(owner, `${BETA}/Beta.md`, "# Beta\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await owner.call("project_protect", { path: BETA, members: [OUTSIDER], editors: [OUTSIDER] });
    await sync(owner, outsider);
    // the outsider, an editor of Beta, seals a copy of the Alfa note's id into Beta with a later path change
    const fake = await note(outsider, `${BETA}/Kopia.md`, "# Kopia\n");
    const notesOf = (outsider as unknown as { notes: Map<string, { id: string; pathChangedAt: number }> }).notes;
    const copy = notesOf.get(fake)!;
    notesOf.delete(fake);
    notesOf.set(id, Object.assign(copy, { id, pathChangedAt: Date.now() + 1e9 }));
    await outsider.sealProtected();
    const sent = outsider.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(sent.state.protected!.find((e) => e.path === BETA)!.noteIds).toContain(id);
    await deliver(owner, sent);
    expect(await paths(owner)).toEqual([`${PROJECT}/Tajna.md`, `${BETA}/Beta.md`]);
    expect(await textOf(owner, id)).toContain("Tylko Alfa.");
    await owner.sealProtected();
    const after = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(after.state.protected!.find((e) => e.path === PROJECT)!.noteIds).toContain(id);
    expect(JSON.stringify(after.state.notes)).not.toContain(id);
  });

  it("a project that sorts first cannot take another project's note on a fresh device holding both", async () => {
    await setUp();
    const AAA = "Projekty/Aaa";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    const id = await note(owner, `${PROJECT}/Tajna.md`, "# Tajna\n\nTylko Alfa.");
    await note(owner, `${AAA}/Aaa.md`, "# Aaa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await owner.call("project_protect", { path: AAA, members: [OUTSIDER], editors: [OUTSIDER] });
    await sync(owner, member);
    await sync(owner, outsider);
    // the outsider, an editor of Aaa, seals the Alfa note's id into Aaa with a later path change
    const fake = await note(outsider, `${AAA}/Kopia.md`, "# Kopia\n");
    const notesOf = (outsider as unknown as { notes: Map<string, { id: string; pathChangedAt: number }> }).notes;
    const copy = notesOf.get(fake)!;
    notesOf.delete(fake);
    notesOf.set(id, Object.assign(copy, { id, pathChangedAt: Date.now() + 1e9 }));
    await outsider.sealProtected();
    const sent = outsider.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    // a fresh owner device (no copy of the note) gets it, and writes in Alfa: its reseal keeps the note it could not place
    const fresh = await bridgeFor(OWNER, "owner");
    await deliver(fresh, sent);
    await note(fresh, `${PROJECT}/Nowa.md`, "# Nowa\n");
    await fresh.sealProtected();
    const saved = fresh.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(saved.state.protected!.find((e) => e.path === PROJECT)!.noteIds).toContain(id);
    await deliver(member, saved);
    expect(await paths(member)).toContain(`${PROJECT}/Tajna.md`);
    expect(await textOf(member, id)).toContain("Tylko Alfa.");
    await deliver(outsider, saved);
    await outsider.sealProtected();
    expect(JSON.stringify(outsider.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Tylko Alfa");
    expect(await textOf(outsider, id)).not.toContain("Tylko Alfa");
  });

  it("a note moved out of a project and the project deleted before the next save: the note stays", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, "Notatki/Jawna.md", "# Jawna\n");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const id = await note(owner, `${PROJECT}/Plan.md`, "# Plan\n\nZostaje.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await owner.sealProtected();
    await owner.call("rename", { id, path: "Notatki/Plan.md" });
    await owner.call("delete_folder", { path: PROJECT });
    expect(await paths(owner)).toEqual(["Notatki/Jawna.md", "Notatki/Plan.md"]);
    const sent = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(sent.state.unprotected![0].noteIds).not.toContain(id);
    await deliver(outsider, sent);
    expect(await paths(outsider)).toEqual(["Notatki/Jawna.md", "Notatki/Plan.md"]);
    expect(await textOf(outsider, id)).toContain("Zostaje.");
  });

  it("a member of only a nested folder forgets a note moved from it into the parent project", async () => {
    await setUp();
    const POD = `${PROJECT}/Pod`;
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const id = await note(owner, `${POD}/Plan.md`, "# Plan\n\nDo rodzica.");
    await owner.call("project_protect", { path: PROJECT, members: [] });
    await owner.call("project_protect", { path: POD, members: [OUTSIDER], editors: [OUTSIDER] });
    await owner.sealProtected();
    await sync(owner, outsider);
    expect(await paths(outsider)).toEqual([`${POD}/Plan.md`]);
    await owner.call("rename", { id, path: `${PROJECT}/Plan.md` });
    await sync(owner, outsider);
    expect(await paths(outsider)).toEqual([]);
  });

  it("a project entry signed by a vault viewer does not take a plain note away from the others", async () => {
    await setUp();
    const VIEWER = "viewer-user", BETA = "Projekty/Beta";
    people.set(VIEWER, await person(VIEWER, "viewer"));
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor"), viewer = await bridgeFor(VIEWER, "viewer");
    const id = await note(owner, "Notatki/Jawna.md", "# Jawna\n\nDla wszystkich.");
    await note(owner, `${BETA}/Beta.md`, "# Beta\n");
    await owner.call("project_protect", { path: BETA, members: [VIEWER], editors: [VIEWER] });
    await sync(owner, viewer);
    await sync(owner, outsider);
    // the viewer (an editor of Beta) signs a Beta entry that lists the plain note
    const v = viewer as unknown as { protectedEntries: Map<string, { noteIds?: string[] }>; signEntry(e: unknown): Promise<unknown> };
    const entry = await v.signEntry({ ...v.protectedEntries.get(BETA)!, noteIds: [...(v.protectedEntries.get(BETA)!.noteIds ?? []), id] });
    const sent = viewer.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    sent.state.protected = [entry as never];
    await deliver(outsider, sent);
    expect(await paths(outsider)).toEqual(["Notatki/Jawna.md"]);
    expect(outsider.exportBrowserSnapshot(OWNER, VAULT).state.notes.map((n) => n.id)).toContain(id);
  });

  it("drag and drop between two projects: the note takes the target's protection; both keys and edit rights are needed", async () => {
    await setUp();
    const BETA = "Projekty/Beta";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await note(owner, `${BETA}/Beta.md`, "# Beta\n");
    const id = await note(owner, `${BETA}/Plan.md`, "# Plan\n\nZ Bety.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    // the outsider reads Beta only, without the right to edit it
    await owner.call("project_protect", { path: BETA, members: [MEMBER, OUTSIDER], editors: [MEMBER] });
    await sync(owner, member);
    await sync(owner, outsider);
    expect(await paths(outsider)).toEqual([`${BETA}/Beta.md`, `${BETA}/Plan.md`]);
    // no key of the target, and no edit right at the source
    await expect(outsider.call("rename", { id, path: `${PROJECT}/Plan.md` })).rejects.toThrow("Projekt jest chroniony");
    await expect(outsider.call("rename", { id, path: `${BETA}/Plan 2.md` })).rejects.toThrow("Masz tylko podgląd");

    await member.call("rename", { id, path: `${PROJECT}/Plan.md` });
    await member.sealProtected();
    const sent = member.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    const entry = (path: string) => sent.state.protected!.find((e) => e.path === path)!;
    expect(entry(PROJECT).noteIds).toContain(id);
    expect(entry(BETA).noteIds).not.toContain(id);
    expect(JSON.stringify(sent)).not.toContain("Z Bety");
    await deliver(outsider, sent);
    expect(await paths(outsider)).toEqual([`${BETA}/Beta.md`]);
    await deliver(owner, sent);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`, `${PROJECT}/Plan.md`, `${BETA}/Beta.md`]);
    expect(await textOf(owner, id)).toContain("Z Bety.");
  });

  it("a folder absorbs a note protected on its own by an older version: the note's entry goes", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    const NOTE = `${PROJECT}/Notatka.md`;
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await note(owner, NOTE, "# Notatka\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    // a note protected on its own (an older version's entry), then its folder: the folder takes the note in and its entry goes
    await owner.call("project_unprotect", { path: PROJECT });
    await legacyNoteProtect(owner, NOTE, [MEMBER]);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`, NOTE]);
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected!.map((e) => e.path)).toEqual([PROJECT]);
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.unprotected!.map((m) => m.path)).toContain(NOTE);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`, NOTE]);
    await sync(owner, member);
    const memberNote = (await member.call<TreeListing>("list_tree")).notes.find((n) => n.path === NOTE)!;
    expect(await textOf(member, memberNote.id)).toContain("Tajne.");
  });

  it("a note protected on its own by an older version still works: its member reads it, and the owner lifts it", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    const NOTE = "Notatki/Stara.md";
    const id = await note(owner, NOTE, "# Stara\n\nTajne.");
    await legacyNoteProtect(owner, NOTE, [MEMBER]);
    await sync(owner, member);
    await sync(owner, outsider);
    expect(await paths(member)).toEqual([NOTE]);
    expect(await textOf(member, id)).toContain("Tajne.");
    expect(await paths(outsider)).toEqual([]);
    expect((await owner.call<ProjectProtection>("project_protection", { path: NOTE })).target).toBe("note");
    await owner.call("project_unprotect", { path: NOTE });
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected ?? []).toEqual([]);
  });

  it("a folder made inside a protected folder, kept only in its sealed payload, is protected after a reopen", async () => {
    const { first, reopen } = await reopenedOwner();
    await note(first, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await first.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await first.call("create_folder", { path: `${PROJECT}/Umowy` });
    await note(first, `${PROJECT}/Umowy/Plan.md`, "# Plan\n\nTajne umowy.");
    await first.persist();
    const reopened = await reopen();
    expect(JSON.stringify(reopened.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Umowy");
    expect(await paths(reopened)).toEqual([`${PROJECT}/Alfa.md`, `${PROJECT}/Umowy/Plan.md`]);
    expect((await reopened.call<ProjectProtection>("project_protection", { path: `${PROJECT}/Umowy` })).manage).toBe(true);
    await reopened.call("project_protect", { path: `${PROJECT}/Umowy`, members: [OUTSIDER] });
    const state = reopened.exportBrowserSnapshot(OWNER, VAULT).state;
    expect(state.protected!.map((e) => e.path).sort()).toEqual([PROJECT, `${PROJECT}/Umowy`]);
    expect(JSON.stringify(state)).not.toContain("Tajne umowy");
    expect(await paths(reopened)).toEqual([`${PROJECT}/Alfa.md`, `${PROJECT}/Umowy/Plan.md`]);
  });

  it("an editor of a protected folder protects a folder made inside it; a member who only reads it cannot", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), reader = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [MEMBER] });
    await sync(owner, member);
    await member.call("create_folder", { path: `${PROJECT}/Umowy` });
    await sync(member, reader);
    expect((await reader.call<ProjectProtection>("project_protection", { path: `${PROJECT}/Umowy` })).manage).toBe(false);
    await expect(reader.call("project_protect", { path: `${PROJECT}/Umowy`, members: [] })).rejects.toThrow("Uprawnienia może zmienić");

    expect((await member.call<ProjectProtection>("project_protection", { path: `${PROJECT}/Umowy` })).manage).toBe(true);
    await member.call("project_protect", { path: `${PROJECT}/Umowy`, members: [OUTSIDER] });
    const entry = member.exportBrowserSnapshot(OWNER, VAULT).state.protected!.find((e) => e.path === `${PROJECT}/Umowy`)!;
    expect(entry.members).toEqual([MEMBER, OUTSIDER, OWNER].sort());
    await sync(member, owner);
    expect((await owner.call<ProjectProtection>("project_protection", { path: `${PROJECT}/Umowy` })).protected).toBe(true);
  });

  it("the task history shows the niezweryfikowane badge for an unverified event", () => {
    const card = historyCard({ status: "unverified", reason: "Podpis nie zgadza się z treścią zdarzenia." });
    expect(card.querySelector(".org-badge")?.textContent).toBe("niezweryfikowane");
    expect(historyCard({ status: "ok", reason: "Podpis zgodny z kluczem członka." }).querySelector(".org-badge")).toBeNull();
  });

  it("the owner's tree lists a project's note right after it is protected", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [] });
    const listing = await owner.call<TreeListing>("list_tree");
    expect(listing.notes.map((n) => n.path)).toEqual([`${PROJECT}/Alfa.md`]);
    expect(listing.folders).toContain(PROJECT);
  });

  it("two protects of one project at once: one is refused, and the owner reads the project the other sealed", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), creator = await bridgeFor(MEMBER, "admin");
    await note(creator, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const results = await Promise.allSettled([
      creator.call("project_protect", { path: PROJECT, members: [], editors: [] }),
      creator.call("project_protect", { path: PROJECT, members: [], editors: [] }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    await sync(creator, owner);
    expect(owner.exportBrowserSnapshot(OWNER, VAULT).state.protected).toHaveLength(1);
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`]);
  });

  it("rename_folder over a protected project is still refused", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [] });
    await expect(owner.call("rename_folder", { from: "Projekty", to: "Archiwum" })).rejects.toThrow("Chronionego projektu nie można przemianować ani przenieść.");
    expect(await paths(owner)).toEqual([`${PROJECT}/Alfa.md`]);
  });

  it("the owner deletes a folder with a protected project: the notes and their plain traces are gone", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
  await owner.call("restore_version", { id, vid: 1 }); // the text before the restore is kept as a version
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await owner.call("delete_folder", { path: "Projekty" });

    const snapshot = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(await paths(owner)).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");
    expect(JSON.stringify(snapshot)).not.toContain("Alfa.md");
    expect(snapshot.state.notes).toEqual([]);
    expect(snapshot.state.versions.map(([noteId]) => noteId)).not.toContain(id);
    expect(snapshot.state.protected ?? []).toEqual([]);
    expect(snapshot.state.unprotected!.map((m) => m.path)).toEqual([PROJECT]);
    expect(snapshot.state.deleted!.map((t) => t.id)).toContain(id);
  });

  it("a member who is neither owner nor admin cannot delete a folder with a protected project", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, member);
    await expect(member.call("delete_folder", { path: "Projekty" })).rejects.toThrow("Chroniony projekt usuwa właściciel lub administrator.");
    expect(await paths(member)).toEqual([`${PROJECT}/Alfa.md`]);
  });

  it("a second device holding the key ends with the notes deleted, and nothing of the project in its export", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    const id = await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
  await owner.call("restore_version", { id, vid: 1 }); // the text before the restore is kept as a version
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, member);
    expect(await textOf(member, id)).toContain("Tajne.");
    expect((await member.call<unknown[]>("list_versions", { id })).length).toBeGreaterThan(0);

    await owner.call("delete_folder", { path: "Projekty" });
    await sync(owner, member);
    expect(await paths(member)).toEqual([]);
    const out = member.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(JSON.stringify(out)).not.toContain("Tajne");
    expect(out.state.notes).toEqual([]);
    expect(out.state.protected ?? []).toEqual([]);
    expect(out.state.versions.map(([noteId]) => noteId)).not.toContain(id);
    expect(await member.call<unknown[]>("list_versions", { id })).toEqual([]);
  });

  it("after a reopen the owner deletes a folder whose project note is not in memory (entry and key held)", async () => {
    await setUp();
    const idb = keepingIdb();
    vi.stubGlobal("indexedDB", idb.indexedDB);
    vi.stubGlobal("IDBKeyRange", { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) });
    vi.stubGlobal("WebSocket", class { addEventListener() {} send() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const who = people.get(OWNER)!;
    const user = { id: OWNER, email: `${OWNER}@example.test`, name: OWNER };
    const personal = (await newRecoveryKey()).key;
    const access: VaultAccess = { vault: vaultInfo, role: "owner", members: members(), rawKey: RAW, keyEpoch: 1 };
    const first = await BrowserBridge.open(user, personal, access, who.signing, who.box);
    await note(first as unknown as Driver, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    await first.call("project_protect", { path: PROJECT, members: [] });
    await first.persist();

    const reopened = await BrowserBridge.open(user, personal, access, who.signing, who.box);
    await (reopened as unknown as Driver).handleMessage({ type: "snapshot", revision: ++revision, envelope: await encryptSnapshot(first.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot, await importVaultKey(RAW), 1) });
    // the state reported in the browser: the entry and its key are held, the project's note is not in memory
    (reopened as unknown as { forgetFolder(folder: string, ids: string[]): boolean }).forgetFolder(PROJECT, []);
    expect(await paths(reopened as unknown as Driver)).toEqual([]);
    await reopened.call("delete_folder", { path: "Projekty" });
    expect((reopened as unknown as { protectedEntries: Map<string, unknown> }).protectedEntries.size).toBe(0);
    const snapshot = reopened.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");
    expect(snapshot.state.unprotected!.map((m) => m.path)).toEqual([PROJECT]);
  });

  it("after a reopen: rename over the project is refused, the project folder and a single note inside it are deleted, nothing plain stays", async () => {
    const { first, reopened } = await reopenedOwner();
    const noteId = await note(first, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne.");
    const extra = await note(first, `${PROJECT}/Beta.md`, "# Beta\n\nTajne dwa.");
    await first.call("project_protect", { path: PROJECT, members: [] });
    await first.persist();
    await reopened.handleMessage({ type: "snapshot", revision: ++revision, envelope: await encryptSnapshot(first.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot, await importVaultKey(RAW), 1) });
    expect(await paths(reopened)).toEqual([`${PROJECT}/Alfa.md`, `${PROJECT}/Beta.md`]);

    await expect(reopened.call("rename_folder", { from: "Projekty", to: "Archiwum" })).rejects.toThrow("Chronionego projektu nie można przemianować ani przenieść.");
    await reopened.call("delete", { id: extra });
    expect(await paths(reopened)).toEqual([`${PROJECT}/Alfa.md`]);
    await reopened.call("delete_folder", { path: PROJECT });
    expect(await paths(reopened)).toEqual([]);
    expect((reopened as unknown as { protectedEntries: Map<string, unknown> }).protectedEntries.size).toBe(0);
    const snapshot = reopened.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");
    expect(snapshot.state.notes).toEqual([]);
    expect(snapshot.state.deleted!.map((t) => t.id)).toEqual(expect.arrayContaining([noteId, extra]));
  });

  it("a note deleted inside a protected project is trashed sealed: not in the plain snapshot, restored by the key holder after a reopen", async () => {
    const { first, reopened } = await reopenedOwner();
    const id = await note(first, `${PROJECT}/Alfa.md`, "# Alfa\n\nTajne do kosza.");
    await first.call("project_protect", { path: PROJECT, members: [] });
    await first.call("delete", { id });
    await first.persist();

    const plain = first.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(plain.state.trash ?? []).toEqual([]);
    expect(JSON.stringify(plain)).not.toContain("Tajne");
    expect(plain.state.protected![0].noteIds).toContain(id);
    await reopened.handleMessage({ type: "snapshot", revision: ++revision, envelope: await encryptSnapshot(plain, await importVaultKey(RAW), 1) });

    expect((await reopened.call<TrashEntry[]>("list_trash")).map((t) => t.id)).toEqual([id]);
    expect(await reopened.call<string>("restore_note", { id })).toBe(`${PROJECT}/Alfa.md`);
    expect(await paths(reopened)).toEqual([`${PROJECT}/Alfa.md`]);
    expect(await textOf(reopened, id)).toContain("Tajne do kosza.");
  });
});

describe("protected folders: top-level places and nested folders", () => {
  it("ancestorsOf lists the folders above a path, from the top", () => {
    expect(ancestorsOf("A/B/C")).toEqual(["A", "A/B"]);
    expect(ancestorsOf("A")).toEqual([]);
  });

  it("landsTop: the root, Projekty/ itself and a new folder there are top-level; a folder in a folder is not", () => {
    const folders = new Set(["Dział", "Dział/Kadry", "Projekty", "Projekty/Alfa"]);
    expect(landsTop("Notatka.md", folders)).toBe(true);
    expect(landsTop("Nowy", folders)).toBe(true);
    expect(landsTop("Projekty/Beta", folders)).toBe(true);
    expect(landsTop("Projekty/Beta/Beta.md", folders)).toBe(true);
    expect(landsTop("Projekty/x.md", folders)).toBe(true);
    expect(landsTop("Dział/Nowy.md", folders)).toBe(false);
    expect(landsTop("Dział/Kadry/Nowy", folders)).toBe(false);
    expect(landsTop("Projekty/Alfa/Dokumenty/Umowa.md", folders)).toBe(false);
    // a folder that does not exist yet, at a depth below the top, makes the item a non-top one
    expect(landsTop("Dział/Nowy/Notatka.md", folders)).toBe(false);
    expect(landsTop("Dział/Kadry/Nowy/Notatka.md", new Set(["Dział"]))).toBe(false);
    expect(landsTop("Nowy/Notatka.md", new Set())).toBe(true);
  });

  it("payloadOf leaves out the protected folders nested under the folder", () => {
    const note = (id: string, path: string) => ({ id, path, yjsUpdateBase64: "", pathChangedAt: 0 });
    const state = {
      notes: [note("a", "Dział/Ogólne.md"), note("b", "Dział/Kadry/Urlopy.md"), note("c", "Dział/Kadry/Sub/x.md"), note("d", "Dział2/y.md")],
      versions: [["a", []], ["b", []]],
      deleted: [],
      trash: [],
      folderChanges: [{ path: "Dział", changedAt: 1, deleted: false }, { path: "Dział/Kadry", changedAt: 1, deleted: false }],
      organization: { events: [] },
    } as unknown as Parameters<typeof payloadOf>[0];
    const parent = payloadOf(state, "Dział", ["Dział/Kadry"]);
    expect(parent.notes.map((n) => n.id)).toEqual(["a"]);
    expect(parent.versions.map(([id]) => id)).toEqual(["a"]);
    expect(parent.folderChanges!.map((f) => f.path)).toEqual(["Dział"]);
    const child = payloadOf(state, "Dział/Kadry");
    expect(child.notes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(child.folderChanges!.map((f) => f.path)).toEqual(["Dział/Kadry"]);
  });

  it("nested: a parent's members cannot see the folder protected inside it, and its members see the parent as a bare container", async () => {
    await setUp();
    const GEN = "Dział", KADRY = "Dział/Kadry";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${GEN}/Ogólne.md`, "# Ogólne\n");
    await note(owner, `${KADRY}/Urlopy.md`, "# Urlopy\n\nTajne kadrowe.");
    await owner.call("project_protect", { path: GEN, members: [MEMBER] });
    await owner.call("project_protect", { path: KADRY, members: [OUTSIDER] });
    await sync(owner, member);
    await sync(owner, outsider);
    expect(await paths(member)).toEqual([`${GEN}/Ogólne.md`]);
    expect(await paths(outsider)).toEqual([`${KADRY}/Urlopy.md`]);
    expect((await member.call<TreeListing>("list_tree")).folders.join("\n")).not.toContain("Kadry");
    expect((await outsider.call<TreeListing>("list_tree")).folders).toEqual(expect.arrayContaining([GEN, KADRY]));
    expect(await textOf(outsider, (await outsider.call<TreeListing>("list_tree")).notes[0].id)).toContain("Tajne kadrowe.");
  });

  it("nested: the parent's payload leaves the nested folder out; a member of only the nested folder works inside it", async () => {
    await setUp();
    const GEN = "Dział", KADRY = "Dział/Kadry";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${GEN}/Ogólne.md`, "# Ogólne\n\nWspólne.");
    await note(owner, `${GEN}/Finanse/Budżet.md`, "# Budżet\n\nTajne finansowe.");
    await note(owner, `${KADRY}/Urlopy.md`, "# Urlopy\n\nTajne kadrowe.");
    await owner.call("project_protect", { path: GEN, members: [] });
    await owner.call("project_protect", { path: KADRY, members: [MEMBER], editors: [MEMBER] });
    // the save that follows a protect (persist) seals the parent again, without the nested folder's notes
    await owner.sealProtected();
    const snapshot = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    expect(snapshot.state.protected!.map((e) => e.path).sort()).toEqual([GEN, KADRY]);
    expect(plainUnder(snapshot, GEN)).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("Tajne");

    const parentEntry = snapshot.state.protected!.find((e) => e.path === GEN)!;
    const ownerKeys = [...(owner as unknown as { projectKeys: Map<string, { path: string; key: CryptoKey }> }).projectKeys.values()];
    const parentPayload = await openPayload(VAULT, parentEntry, ownerKeys.find((k) => k.path === GEN)!.key);
    expect(parentPayload.notes.map((n) => n.path).sort()).toEqual([`${GEN}/Finanse/Budżet.md`, `${GEN}/Ogólne.md`]);
    expect(parentPayload.folderChanges!.filter((f) => f.path === KADRY || f.path.startsWith(`${KADRY}/`))).toEqual([]);

    await sync(owner, member);
    await sync(owner, outsider);
    expect(await paths(member)).toEqual([`${KADRY}/Urlopy.md`]);
    expect(await paths(outsider)).toEqual([]);
    expect((await outsider.call<TreeListing>("list_tree")).folders.join("\n")).not.toContain("Dział");

    // the nested folder's member writes inside it, and nowhere else in the parent
    await note(member, `${KADRY}/Nowa.md`, "# Nowa\n\nKadry piszą.");
    await member.call("create_folder", { path: `${KADRY}/Podfolder` });
    await expect(member.call("create_note", { path: `${GEN}/Ogólne2.md` })).rejects.toThrow("Projekt jest chroniony");
    await expect(member.call("create_note", { path: "Luźna.md" })).rejects.toThrow("Główne foldery");
    await expect(member.call("create_folder", { path: "Projekty" })).rejects.toThrow("Główne foldery");
    await expect(member.call("create_note", { path: "Projekty/Alfa/Alfa.md" })).rejects.toThrow("Główne foldery");
    await expect(member.call("rename_folder", { from: KADRY, to: `${GEN}/Kadra` })).rejects.toThrow("Chronionego projektu");
    await expect(member.call("delete_folder", { path: GEN })).rejects.toThrow("Chroniony projekt usuwa");

    await sync(member, owner);
    expect(await paths(owner)).toEqual(expect.arrayContaining([`${KADRY}/Nowa.md`, `${GEN}/Ogólne.md`]));
    await owner.sealProtected();
    const again = owner.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    const parentAgain = again.state.protected!.find((e) => e.path === GEN)!;
    const parentLater = await openPayload(VAULT, parentAgain, ownerKeys.find((k) => k.path === GEN)!.key);
    expect(parentLater.notes.map((n) => n.path)).not.toContain(`${KADRY}/Nowa.md`);
    expect(JSON.stringify(again)).not.toContain("Kadry piszą");
  });

  it("nested: unprotecting the nested folder gives its notes back to the parent's payload, where only the parent's members read them", async () => {
    await setUp();
    const GEN = "Dział", KADRY = "Dział/Kadry";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${GEN}/Ogólne.md`, "# Ogólne\n");
    await note(owner, `${KADRY}/Urlopy.md`, "# Urlopy\n\nTajne kadrowe.");
    await owner.call("project_protect", { path: GEN, members: [MEMBER] });
    await owner.call("project_protect", { path: KADRY, members: [OUTSIDER] });
    await owner.call("project_unprotect", { path: KADRY });
    await sync(owner, member);
    // the parent's members read the notes now: they are in the parent's payload
    expect(await paths(member)).toEqual([`${GEN}/Ogólne.md`, `${KADRY}/Urlopy.md`].sort());
    expect(JSON.stringify(owner.exportBrowserSnapshot(OWNER, VAULT))).not.toContain("Tajne");
  });

  it("nested: a protected parent cannot be renamed while it holds a protected folder; its members get no top-level rights", async () => {
    await setUp();
    const GEN = "Dział", KADRY = "Dział/Kadry";
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor");
    await note(owner, `${KADRY}/Urlopy.md`, "# Urlopy\n");
    await owner.call("project_protect", { path: GEN, members: [MEMBER], editors: [MEMBER] });
    await owner.call("project_protect", { path: KADRY, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    await expect(member.call("rename_folder", { from: GEN, to: "Dział2" })).rejects.toThrow("Chronionego projektu");
    await expect(member.call("create_note", { path: `${KADRY}/Nowa.md` })).resolves.toBeDefined();
    expect((await member.call<TreeListing>("list_tree")).rootFree).toBe(false);
    expect((await owner.call<TreeListing>("list_tree")).rootFree).toBe(true);
  });
});


// docs/MCP.md §3.4, §6: Claude chats and protected projects. A chat of `userId` (its cert signed by that person) is put on
// the members list the bridges are made with.
async function chatOf(userId: string, writeMode: WriteMode = "direct") {
  const keys = await generateAgentKeys();
  const agentId = newAgentId();
  const { signature, ...cert } = await signCert({
    schema: "notes-agent-cert-v1", agentId, userId, signKey: keys.signKey, boxKey: keys.boxKey,
    vaults: [{ vaultId: VAULT, whole: true, parts: [], writeMode }], createdAt: Date.now() - 1000, expiresAt: Date.now() + 86_400_000,
  }, people.get(userId)!.signing);
  const agent = { agentId, cert: cert as AgentCert, signature: signature!, revokedAt: null as number | null };
  const member = people.get(userId)!.member;
  member.agents = [...(member.agents ?? []), agent];
  return { keys, agentId, agent };
}
const checkOf = (b: Driver, path = PROJECT) => (b as any).protectedChecks.get(path)?.status;
const entryOf = (b: Driver, path = PROJECT) => (b as any).protectedEntries.get(path);
const withEntry = (b: Driver, entry: unknown): BrowserVaultSnapshot => {
  const snapshot = b.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
  return { ...snapshot, state: { ...snapshot.state, protected: [entry as never] } };
};

describe("protected projects and Claude chats", () => {
  // version 1: a chat writes into a protected project only through a proposal, so no entry it signs is trusted
  it("an entry signed by a chat is never trusted, whatever it changes", async () => {
    await setUp();
    const chat = await chatOf(MEMBER);
    const owner = await bridgeFor(OWNER, "owner"), other = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "Start.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, other);
    const entry = entryOf(owner);
    const bySigned = (over: object) => signAsAgent({ ...entry, ...over }, MEMBER, chat.agentId, chat.keys.signSecret);

    await deliver(other, withEntry(owner, await bySigned({})));
    expect(checkOf(other)).toBe("unverified");
    await deliver(other, withEntry(owner, await bySigned({ members: [...entry.members, OUTSIDER].sort() })));
    expect(checkOf(other)).toBe("unverified");
    await deliver(other, withEntry(owner, await bySigned({ editors: [MEMBER] })));
    expect(checkOf(other)).toBe("unverified");
    const sealedKey = (await import("./agentcrypto")).sealForAgent(randomVaultKey(), chat.keys.boxKey, VAULT, projectSlot(PROJECT), 1);
    await deliver(other, withEntry(owner, await bySigned({ agentKeys: [{ agentId: chat.agentId, userId: MEMBER, sealedKey: await sealedKey }] })));
    expect(checkOf(other)).toBe("unverified");
    await deliver(other, withEntry(owner, await bySigned({})));
    expect(checkOf(other)).toBe("unverified");
    chat.agent.revokedAt = Date.now() - 1;
    await deliver(other, withEntry(owner, await bySigned({})));
    expect(checkOf(other)).toBe("unverified");
  });

  it("a person seals the project key for their own chat; a manager may not add one for someone else, nor for a non-member", async () => {
    await setUp();
    const chat = await chatOf(MEMBER);
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), other = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "Start.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    await sync(owner, member);
    await sync(owner, other);
    expect((member as any).agentProjects()).toEqual([PROJECT]);
    await (member as any).grantProjectToChat(PROJECT, chat.agentId, chat.keys.boxKey);
    await sync(member, other);
    expect(checkOf(other)).toBe("ok");
    const sealed = entryOf(other).agentKeys;
    expect(sealed.map((k: any) => [k.agentId, k.userId])).toEqual([[chat.agentId, MEMBER]]);
    const held = [...(owner as any).projectKeys.values()][0].raw;
    expect([...await openForAgent(sealed[0].sealedKey, chat.keys, VAULT, projectSlot(PROJECT), 1)]).toEqual([...held]);

    // the owner adding a chat key for the member's chat: flagged
    const third = await bridgeFor(OUTSIDER, "editor");
    await sync(owner, third);
    const forged = { ...entryOf(owner), agentKeys: [{ agentId: newAgentId(), userId: MEMBER, sealedKey: sealed[0].sealedKey }] };
    await signEvent(forged, people.get(OWNER)!.signing);
    await deliver(third, withEntry(owner, forged));
    expect(checkOf(third)).toBe("unverified");
    // a chat key for someone outside the project: flagged anywhere
    const outside = { ...entryOf(owner), agentKeys: [{ agentId: newAgentId(), userId: OUTSIDER, sealedKey: sealed[0].sealedKey }] };
    await signEvent(outside, people.get(OUTSIDER)!.signing);
    await deliver(other, withEntry(owner, outside));
    expect(checkOf(other)).toBe("unverified");
  });

  it("a new project key is sealed for the remaining members' chats; a removed member's chats and a revoked chat lose it", async () => {
    await setUp();
    const mine = await chatOf(MEMBER), theirs = await chatOf(OUTSIDER);
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "Start.");
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER, OUTSIDER], editors: [MEMBER, OUTSIDER] });
    await sync(owner, member);
    await (member as any).grantProjectToChat(PROJECT, mine.agentId, mine.keys.boxKey);
    // each version is seen as it is made (a device that missed one flags a later signer's copy, as for members)
    await sync(member, owner);
    await sync(member, outsider);
    await (outsider as any).grantProjectToChat(PROJECT, theirs.agentId, theirs.keys.boxKey);
    await sync(outsider, owner);
    expect(checkOf(owner)).toBe("ok");
    expect(entryOf(owner).agentKeys.map((k: any) => k.userId).sort()).toEqual([MEMBER, OUTSIDER].sort());

    await owner.call("project_set_members", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    const rotated = entryOf(owner);
    expect(rotated.keyEpoch).toBe(2);
    expect(rotated.agentKeys.map((k: any) => k.agentId)).toEqual([mine.agentId]);
    const raw = [...(owner as any).projectKeys.values()].find((k: any) => k.keyEpoch === 2).raw;
    expect([...await openForAgent(rotated.agentKeys[0].sealedKey, mine.keys, VAULT, projectSlot(PROJECT), 2)]).toEqual([...raw]);
    await sync(owner, member);
    expect(checkOf(member)).toBe("ok");

    // the person takes the project away from the chat: a new key, without it
    await (member as any).revokeProjectsFromChats([PROJECT], [mine.agentId]);
    expect(entryOf(member).keyEpoch).toBe(3);
    expect(entryOf(member).agentKeys).toBeUndefined();
    await sync(member, owner);
    expect(checkOf(owner)).toBe("ok");
  });
});

describe("GitHub links of protected projects", () => {
  const SECRET = "acme/tajne-repo";
  const links = (b: Driver) => b.call<GithubLink[]>("github_links");
  const save = (b: Driver, link: GithubLink) => b.call<GithubLink>("github_save_link", { link });
  // What goes to the server: the export before encryption, and the plain state the vault key opens again.
  async function sent(b: Driver): Promise<{ json: string; plain: BrowserVaultSnapshot }> {
    await b.sealProtected();
    const snapshot = b.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    const plain = await decryptSnapshot(await encryptSnapshot(snapshot, await importVaultKey(RAW), 1), OWNER, VAULT, await importVaultKey(RAW));
    return { json: JSON.stringify(snapshot), plain };
  }

  it("a protected project's link travels only in its payload: members read it, the server and outsiders do not", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const secret = await save(owner, newLink(PROJECT, SECRET, {}));
    await save(owner, newLink("Projekty/Beta", "acme/jawne-repo", {}));
    await sync(owner, outsider); // the outsider got the link while the project was still open
    expect((await links(outsider)).map((l) => l.repo)).toContain(SECRET);

    await owner.call("project_protect", { path: PROJECT, members: [MEMBER], editors: [MEMBER] });
    const { json, plain } = await sent(owner);
    expect(json).not.toContain("tajne-repo");
    expect(json).toContain("jawne-repo");
    expect(plain.state.github?.map((l) => l.repo)).toEqual(["acme/jawne-repo"]);
    expect(JSON.stringify(plain)).not.toContain("tajne-repo");
    expect((await links(owner)).map((l) => l.id)).toContain(secret.id);

    await sync(owner, member);
    expect((await links(member)).find((l) => l.id === secret.id)?.repo).toBe(SECRET);
    expect((await sent(member)).json).not.toContain("tajne-repo");
    await sync(owner, outsider);
    expect((await links(outsider)).map((l) => l.repo)).toEqual(["acme/jawne-repo"]);
    expect((await sent(outsider)).json).not.toContain("tajne-repo");

    // a member's change is sealed again and reaches the owner
    await save(member, { ...secret, status: "zmieniony" });
    await sync(member, owner);
    expect((await links(owner)).find((l) => l.id === secret.id)?.status).toBe("zmieniony");
  });

  it("a forged plain copy of a protected link (in the project's path, or its id elsewhere) is dropped by a member", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const secret = await save(owner, newLink(PROJECT, SECRET, {}));
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, outsider);
    const forged = outsider.exportBrowserSnapshot(OWNER, VAULT) as BrowserVaultSnapshot;
    forged.state.github = [{ ...newLink(PROJECT, "evil/repo", {}), rev: 50 }, { ...secret, projectPath: "Notatki", repo: "evil/moved", rev: 99 }];
    await deliver(owner, forged);
    const now = await links(owner);
    expect(now.map((l) => l.repo)).toEqual([SECRET]);
    expect(now[0].rev).toBe(secret.rev);
  });

  it("unprotect brings the link back to the plain state; protect takes it out again", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner"), outsider = await bridgeFor(OUTSIDER, "editor");
    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const secret = await save(owner, newLink(PROJECT, SECRET, {}));
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    await sync(owner, outsider);
    expect(await links(outsider)).toEqual([]);

    await owner.call("project_unprotect", { path: PROJECT });
    expect((await sent(owner)).plain.state.github?.map((l) => l.id)).toEqual([secret.id]);
    await sync(owner, outsider);
    expect((await links(outsider)).map((l) => l.repo)).toEqual([SECRET]);

    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] });
    expect((await sent(owner)).json).not.toContain("tajne-repo");
    await sync(owner, outsider);
    expect(await links(outsider)).toEqual([]);
    expect((await sent(outsider)).json).not.toContain("tajne-repo");
  });

  it("writes: a viewer saves no link; without the project key or the edit right the save is refused", async () => {
    await setUp();
    const VIEWER = "viewer-user";
    people.set(VIEWER, await person(VIEWER, "viewer"));
    const owner = await bridgeFor(OWNER, "owner"), member = await bridgeFor(MEMBER, "editor"), outsider = await bridgeFor(OUTSIDER, "editor"), viewer = await bridgeFor(VIEWER, "viewer");
    await expect(save(viewer, newLink("Projekty/Beta", "acme/jawne-repo", {}))).rejects.toThrow();
    expect(await links(viewer)).toEqual([]);

    await note(owner, `${PROJECT}/Alfa.md`, "# Alfa\n");
    const secret = await save(owner, newLink(PROJECT, SECRET, {}));
    await owner.call("project_protect", { path: PROJECT, members: [MEMBER] }); // the member only reads it
    await sync(owner, member);
    await sync(owner, outsider);
    await expect(save(outsider, newLink(PROJECT, "evil/repo", {}))).rejects.toThrow("Projekt jest chroniony");
    await expect(save(outsider, newLink(`${PROJECT}/Pod`, "evil/repo", {}))).rejects.toThrow("Projekt jest chroniony");
    await expect(save(member, { ...secret, status: "zmieniony" })).rejects.toThrow("Masz tylko podgląd");
    await expect(member.call("github_remove_link", { id: secret.id })).rejects.toThrow("Masz tylko podgląd");
    // a link stays in its protected project: moving it out would leave a plain copy under a sealed id
    await expect(save(owner, { ...secret, projectPath: "Notatki" })).rejects.toThrow("nie można przenieść");
    expect(await links(outsider)).toEqual([]);
    expect((await links(member)).find((l) => l.id === secret.id)?.status).toBe("ok");
  });
});

describe("GitHub in an open shared vault", () => {
  const REPO_NAME = "acme/tajne-repo-9q";
  const CONTENT = "TRESC-Z-GITHUBA-7f3a";
  const TOKEN = "github_pat_SEKRET-7f3a";
  const user = { id: OWNER, email: `${OWNER}@example.test`, name: OWNER };

  // A socket that answers hello with the server's (empty) snapshot and every put with an ack; it keeps every frame.
  function fakeSocket(frames: string[]) {
    let rev = 0;
    return class {
      static OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      onmessage?: (e: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      send(data: string) {
        frames.push(data);
        const m = JSON.parse(data) as { type: string };
        const reply = m.type === "hello" ? { type: "snapshot", revision: 0 } : m.type === "put" ? { type: "ack", revision: ++rev } : null;
        if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
      }
      close() {}
      addEventListener() {}
    };
  }
  async function openAs(role: Role, frames: string[] = []): Promise<BrowserBridge> {
    await setUp();
    vi.stubGlobal("indexedDB", keepingIdb().indexedDB);
    vi.stubGlobal("IDBKeyRange", { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) });
    vi.stubGlobal("WebSocket", fakeSocket(frames));
    const who = people.get(OWNER)!;
    const access: VaultAccess = { vault: vaultInfo, role, members: members(), rawKey: RAW, keyEpoch: 1 };
    return BrowserBridge.open(user, (await newRecoveryKey()).key, access, who.signing, who.box);
  }

  it("a shared vault gets the service; the schedule runs for editors, not for a viewer; closing drops it", async () => {
    await loadWasm();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const editor = await openAs("editor");
    expect(githubService()).toBe(editor.githubService);
    expect(editor.githubService?.scheduled()).toBe(true);
    editor.close();
    expect(githubService()).toBeNull();
    expect(editor.githubService?.scheduled()).toBe(false);

    const viewer = await openAs("viewer");
    expect(githubService()).not.toBeNull();
    expect(viewer.githubService?.scheduled()).toBe(false);
    viewer.close();

    // a role change to viewer stops the checks, back to editor starts them again
    const demoted = await openAs("editor");
    const frame = (role: Role) => (demoted as unknown as Driver).handleMessage({ type: "access", role });
    await frame("viewer");
    expect(demoted.githubService?.scheduled()).toBe(false);
    await frame("editor");
    expect(demoted.githubService?.scheduled()).toBe(true);
    demoted.close();
  }, 30_000);

  it("a clean copy refuses the user's edit with a message and takes the GitHub run's writes", async () => {
    await setUp();
    const owner = await bridgeFor(OWNER, "owner");
    const id = await note(owner, `${PROJECT}/GitHub/README.md`, "# Z GitHuba\n");
    const link = newLink(PROJECT, "acme/repo", { allowEdits: false });
    link.files[id] = { path: "README.md", blobSha: "a".repeat(40), guarded: [] };
    await owner.call("github_save_link", { link });
    const edit = async (github: boolean) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, await owner.call<Uint8Array>("open_note", { id }));
      const before = Y.encodeStateVector(doc);
      doc.getText("content").insert(0, "x");
      await owner.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, before), ...(github ? { github: true } : {}) });
    };
    await edit(false);
    expect(await textOf(owner, id)).toBe("# Z GitHuba\n");
    expect(document.body.textContent).toContain("To czysta kopia z GitHuba (tylko do odczytu).");
    await edit(true);
    expect(await textOf(owner, id)).toBe("x# Z GitHuba\n");
  });

  it("an import sends the server neither the repository, the file content nor the token", async () => {
    await loadWasm();
    const gh = new FakeGitHub(REPO_NAME);
    await gh.commit("start", { "README.md": `# ${CONTENT}\n- [ ] Zrób X @Ania\n` });
    const traffic: string[] = [];
    const frames: string[] = [];
    const latin1 = new TextDecoder("latin1");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) return gh.fetch(input, init);
      const body = init?.body;
      traffic.push(`${init?.method ?? "GET"} ${url} ${typeof body === "string" ? body : body ? latin1.decode(body as ArrayBuffer) : ""}`);
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/leases") && init?.method === "POST") return ok({ granted: true, until: 1 });
      if (url.includes("/leases/")) return new Response(null, { status: 204 });
      if (url === "/api/auth/me") return ok({ user: {} });
      const rec = (id: string, state: string) => ({ id, state, size: 1, chunks: 1, received: 0, scope: null, meta: "", createdBy: OWNER, createdAt: 1, completedAt: null, deletedAt: null });
      if (url.endsWith("/files") && init?.method === "POST") return ok(rec((JSON.parse(String(body)) as { id: string }).id, "uploading"), 201);
      const chunk = /\/files\/([0-9a-f]{32})\/chunks\/(\d+)$/.exec(url);
      if (chunk) return ok({ received: Number(chunk[2]) + 1 });
      const done = /\/files\/([0-9a-f]{32})\/complete$/.exec(url);
      if (done) return ok(rec(done[1], "ready"));
      return ok({ error: "Nie ma." }, 404);
    }));
    const bridge = await openAs("owner", frames);
    await syncPreferences(user, bridge.personalKey);
    const service = bridge.githubService!;
    await service.setToken(TOKEN);
    const link = await service.connect(PROJECT, { repo: REPO_NAME, ref: null, repoPath: "", target: "GitHub", onDelete: "keep", allowEdits: true });
    expect(link.lastCommit).toBe(gh.head);
    expect(link.status).toBe("ok");
    const id = (await bridge.call<TreeListing>("list_tree")).notes.find((n) => n.path === `${PROJECT}/GitHub/README.md`)!.id;
    expect(await bridge.call<string>("note_text", { id })).toContain(CONTENT);
    expect(frames.some((f) => f.includes('"put"'))).toBe(true);
    expect(traffic.some((t) => t.includes("/chunks/"))).toBe(true);
    for (const sent of [...traffic, ...frames]) {
      expect(sent).not.toContain("tajne-repo");
      expect(sent).not.toContain(CONTENT);
      expect(sent).not.toContain(TOKEN);
    }
    expect(JSON.stringify(bridge.exportBrowserSnapshot(OWNER, VAULT))).not.toContain(TOKEN);
    bridge.close();
  }, 30_000);
});
