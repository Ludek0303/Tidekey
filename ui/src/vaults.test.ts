// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge, decryptSnapshot, encryptSnapshot, newRecoveryKey, pickStored } from "./browserauth";
import { MockBridge } from "./bridge";
import {
  membersSection,
  assignableRoles, canManage, clearInviteUrl, importVaultKey, inviteLink, invitableRoles, memberRoleOptions,
  memberLabel, parseInviteHref, randomVaultKey, runInvite, toBase64Url, unwrapVaultKey, wrapVaultKey, type Role, type VaultAccess,
  openVaultMenu, openMembersDialog,
} from "./vaults";

const OWNER = "owner-user";
const MEMBER = "member-user";
const VAULT = `v-${"a".repeat(32)}`;
const vaultInfo = { id: VAULT, name: "Zespół", kind: "organizacja" as const, ownerUserId: OWNER };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

// A bridge without IndexedDB or a socket: the constructor is private, and these tests drive it directly.
// Private members are reached through `any`: the tests drive the sync internals directly.
type Internals = any;
function bridgeFor(role: Role, socket?: { readyState: number; send: () => void; close: () => void }): Internals {
  const access: VaultAccess = { vault: vaultInfo, role, members: [], rawKey: null, keyEpoch: 1 };
  const Ctor = BrowserBridge as unknown as new (...args: unknown[]) => Internals;
  const bridge = new Ctor({ id: MEMBER, email: "m@example.test", name: "Maria" }, {} as CryptoKey, {} as IDBDatabase, {} as CryptoKey, access);
  if (socket) { bridge.socket = socket; bridge.connected = true; }
  return bridge;
}

describe("vault key", () => {
  it("wraps with the personal key and unwraps to the same bytes", async () => {
    const personal = (await newRecoveryKey()).key;
    const raw = randomVaultKey();
    const envelope = await wrapVaultKey(raw, personal);
    expect(envelope.schema).toBe("notes-key-v1");
    expect(atob(envelope.nonce).length).toBe(12);
    expect(await unwrapVaultKey(envelope, personal)).toEqual(raw);
  });

  it("another member's personal key cannot unwrap the key", async () => {
    const owner = (await newRecoveryKey()).key;
    const stranger = (await newRecoveryKey()).key;
    const envelope = await wrapVaultKey(randomVaultKey(), owner);
    await expect(unwrapVaultKey(envelope, stranger)).rejects.toThrow("Nie udało się odblokować klucza tego sejfu.");
  });

  it("the unwrapped key opens snapshots of the shared vault", async () => {
    const personal = (await newRecoveryKey()).key;
    const raw = randomVaultKey();
    const vaultKey = await importVaultKey(await unwrapVaultKey(await wrapVaultKey(raw, personal), personal));
    const owner = new MockBridge([], false);
    owner.setBrowserAccount(OWNER, "o@example.test", vaultInfo);
    expect(await decryptSnapshot(await encryptSnapshot(owner.exportBrowserSnapshot(OWNER, VAULT), vaultKey), OWNER, VAULT, vaultKey)).toBeTruthy();
  });
});

describe("shared snapshots", () => {
  it("a non-owner member decrypts the snapshot: the AAD names the owner, not the reader", async () => {
    const key = await importVaultKey(randomVaultKey());
    const owner = new MockBridge([], false);
    owner.setBrowserAccount(OWNER, "o@example.test", vaultInfo);
    await owner.call("create_note", { path: "wspolna.md" });
    const envelope = await encryptSnapshot(owner.exportBrowserSnapshot(OWNER, VAULT), key);

    const snapshot = await decryptSnapshot(envelope, OWNER, VAULT, key);
    expect(snapshot.vault.name).toBe("Zespół");
    expect(snapshot.state.notes.map((n) => n.path)).toEqual(["wspolna.md"]);
    // The member's own id is not the AAD owner, so the snapshot does not open under it.
    await expect(decryptSnapshot(envelope, MEMBER, VAULT, key)).rejects.toThrow();
  });

  it("a member's bridge takes the vault's organization from the server: owner, space, kind, members", () => {
    const bridge = new MockBridge([], false);
    bridge.setBrowserAccount(MEMBER, "ania.kowalska@example.test", vaultInfo);
    bridge.setMembers([
      { userId: OWNER, email: "jan@example.test", name: "Jan Nowak", role: "owner" },
      { userId: MEMBER, email: "ania.kowalska@example.test", name: "Anna Kowalska", role: "viewer" },
    ]);
    const snapshot = bridge.exportBrowserSnapshot(OWNER, VAULT);
    expect(snapshot.vault).toEqual({ id: VAULT, ownerUserId: OWNER, name: "Zespół", kind: "organizacja" });
    expect(snapshot.state.organization).toMatchObject({ me: MEMBER, owner: OWNER, space_id: VAULT });
    expect(snapshot.state.organization.members).toEqual([
      { user_id: OWNER, name: "Jan Nowak", role: "Owner" },
      { user_id: MEMBER, name: "Anna Kowalska", role: "Reader" },
    ]);
  });

  it("setMembers uses the account name, and keeps a name an administrator set in the organization", async () => {
    const bridge = new MockBridge([], false);
    bridge.setBrowserAccount(MEMBER, "ania@example.test", vaultInfo);
    bridge.setMembers([{ userId: MEMBER, email: "ania@example.test", name: "Ania", role: "editor" }, { userId: OWNER, email: "o@example.test", name: "Ola Nowak", role: "owner" }]);
    expect(bridge.exportBrowserSnapshot(OWNER, VAULT).state.organization.members.map((m) => m.name)).toEqual(["Ania", "Ola Nowak"]);
    await bridge.call("organization_person", { userId: MEMBER, name: "Anna Kowalska" });
    // the next refresh from the server brings the account name again; the organization's name stays
    bridge.setMembers([{ userId: MEMBER, email: "ania@example.test", name: "Ania", role: "editor" }, { userId: OWNER, email: "o@example.test", name: "Ola Nowak", role: "owner" }]);
    const [renamed, untouched] = bridge.exportBrowserSnapshot(OWNER, VAULT).state.organization.members;
    expect([renamed.name, untouched.name]).toEqual(["Anna Kowalska", "Ola Nowak"]);
    expect(renamed.name_changed_at).toBeGreaterThan(0);
  });
});

describe("invite links", () => {
  it("builds ?invite=<token>#k=<key> and parses it back", async () => {
    const token = "c".repeat(64);
    const raw = randomVaultKey();
    const link = inviteLink("https://notes.example.test", token, raw, 3);
    expect(link).toBe(`https://notes.example.test/?invite=${token}#k=${toBase64Url(raw)}&e=3`);
    expect(parseInviteHref(link)).toEqual({ token, key: raw, keyEpoch: 3 });
  });

  it("a link without e= (made before key epochs) means epoch 1; a malformed e= is rejected", () => {
    const token = "9".repeat(64);
    const raw = randomVaultKey();
    expect(parseInviteHref(`https://x.test/?invite=${token}#k=${toBase64Url(raw)}`)).toEqual({ token, key: raw, keyEpoch: 1 });
    expect(parseInviteHref(`https://x.test/?invite=${token}#k=${toBase64Url(raw)}&e=0`)).toBeNull();
    expect(parseInviteHref(`https://x.test/?invite=${token}#k=${toBase64Url(raw)}&e=abc`)).toBeNull();
    expect(parseInviteHref(`https://x.test/?invite=${token}#k=${toBase64Url(raw)}&e=2`)).toEqual({ token, key: raw, keyEpoch: 2 });
  });

  it("rejects a link without a fragment key, with a wrong key length, or with a bad token", () => {
    const token = "d".repeat(64);
    expect(parseInviteHref(`https://x.test/?invite=${token}`)).toBeNull();
    expect(parseInviteHref(`https://x.test/?invite=${token}#k=AAAA`)).toBeNull();
    expect(parseInviteHref(`https://x.test/?invite=abc#k=${toBase64Url(randomVaultKey())}`)).toBeNull();
  });

  it("accepting an invite clears the token and the key from the address", async () => {
    const personal = (await newRecoveryKey()).key;
    const raw = randomVaultKey();
    history.replaceState(null, "", `/?invite=${"e".repeat(64)}#k=${toBase64Url(raw)}&e=2`);
    const requests: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string | undefined });
      if (url.startsWith("/api/invites/") && init?.method === "GET") return Response.json({ vault: vaultInfo, role: "editor", expiresAt: 1 });
      return Response.json({ vault: { ...vaultInfo, role: "editor" } }, { status: 200 });
    }));
    const opened = await runInvite(parseInviteHref(location.href), personal, async () => true);
    expect(opened).toBe(VAULT);
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
    const accept = requests.find((r) => r.url === "/api/invites/accept")!;
    const sent = JSON.parse(accept.body!) as { token: string; wrappedKey: unknown; keyEpoch: number };
    expect(sent.token).toBe("e".repeat(64));
    expect(sent.keyEpoch).toBe(2);
    expect(await unwrapVaultKey(sent.wrappedKey as Parameters<typeof unwrapVaultKey>[0], personal)).toEqual(raw);
  });

  it("409 (already a member) opens the vault without an error", async () => {
    const personal = (await newRecoveryKey()).key;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json({ vault: vaultInfo, role: "viewer", expiresAt: 1 });
      return Response.json({ message: "Już jesteś członkiem." }, { status: 409 });
    }));
    clearInviteUrl();
    expect(await runInvite({ token: "f".repeat(64), key: randomVaultKey(), keyEpoch: 1 }, personal, async () => true)).toBe(VAULT);
  });

  it("410 (used or expired) shows the Polish message and falls back to the personal vault", async () => {
    const personal = (await newRecoveryKey()).key;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Zaproszenie wygasło po zmianie klucza." }, { status: 410 })));
    const result = runInvite({ token: "0".repeat(64), key: randomVaultKey(), keyEpoch: 1 }, personal, async () => true);
    await vi.waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Zaproszenie wygasło po zmianie klucza."));
    document.querySelector<HTMLButtonElement>(".modal .btn-primary")!.click();
    expect(await result).toBeNull();
  });

  it("404 (unknown token) shows its message", async () => {
    const personal = (await newRecoveryKey()).key;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "x" }, { status: 404 })));
    const result = runInvite({ token: "1".repeat(64), key: randomVaultKey(), keyEpoch: 1 }, personal, async () => true);
    await vi.waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Ten link zaproszenia nie istnieje."));
    document.querySelector<HTMLButtonElement>(".modal .btn-primary")!.click();
    expect(await result).toBeNull();
  });
});

describe("viewer bridge", () => {
  it("refuses local mutations with the read-only message and sends no put", async () => {
    const send = vi.fn();
    const bridge = bridgeFor("viewer", { readyState: WebSocket.OPEN, send, close: vi.fn() });
    await expect(bridge.call("create_note", { path: "x.md" })).rejects.toThrow("Masz dostęp tylko do odczytu.");
    expect(document.querySelector(".toast")?.textContent).toBe("Masz dostęp tylko do odczytu.");
    bridge.sendPut({ schema: "notes-encrypted-v1", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" }, "{}");
    expect(send).not.toHaveBeenCalled();
  });

  it("a read-only error from the server drops the role to viewer, stops puts and reports the change", async () => {
    const send = vi.fn();
    const bridge = bridgeFor("editor", { readyState: WebSocket.OPEN, send, close: vi.fn() });
    const seen: unknown[] = [];
    bridge.onVaultAccess((payload: unknown) => seen.push(payload));
    await bridge.handleMessage({ type: "error", code: "read-only", message: "Sejf jest tylko do odczytu." });
    expect(bridge.role).toBe("viewer");
    expect(seen).toEqual([{ role: "viewer" }]);
    bridge.sendPut({ schema: "notes-encrypted-v1", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" }, "{}");
    expect(send).not.toHaveBeenCalled();
  });

  it("a live role change is reported, and an editor may put again", async () => {
    const send = vi.fn();
    const bridge = bridgeFor("viewer", { readyState: WebSocket.OPEN, send, close: vi.fn() });
    const seen: unknown[] = [];
    bridge.onVaultAccess((payload: unknown) => seen.push(payload));
    await bridge.handleMessage({ type: "access", role: "editor" });
    expect(bridge.role).toBe("editor");
    expect(seen).toEqual([{ role: "editor" }]);
    bridge.sendPut({ schema: "notes-encrypted-v1", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" }, "{}");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("removal", () => {
  it("access with role null revokes: the socket closes, no reconnect, and the listener is told", async () => {
    const close = vi.fn();
    const bridge = bridgeFor("editor", { readyState: WebSocket.OPEN, send: vi.fn(), close });
    const seen: unknown[] = [];
    bridge.onVaultAccess((payload: unknown) => seen.push(payload));
    await bridge.handleMessage({ type: "access", role: null });
    expect(close).toHaveBeenCalledTimes(1);
    expect(bridge.stopped).toBe(true);
    expect(bridge.role).toBeNull();
    expect(seen).toEqual([{ role: null, voluntary: false }]);
  });

  it("a forbidden hello error is the same removal path", async () => {
    const close = vi.fn();
    const bridge = bridgeFor("editor", { readyState: WebSocket.OPEN, send: vi.fn(), close });
    const seen: unknown[] = [];
    bridge.onVaultAccess((payload: unknown) => seen.push(payload));
    await bridge.handleMessage({ type: "error", code: "forbidden", message: "Brak dostępu do tego sejfu." });
    expect(seen).toEqual([{ role: null, voluntary: false }]);
    expect(close).toHaveBeenCalled();
  });

  it("leaving yourself is reported as voluntary", async () => {
    const bridge = bridgeFor("editor", { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() });
    const seen: unknown[] = [];
    bridge.onVaultAccess((payload: unknown) => seen.push(payload));
    bridge.markLeaving();
    await bridge.handleMessage({ type: "access", role: null });
    expect(seen).toEqual([{ role: null, voluntary: true }]);
  });
});

describe("local storage per vault", () => {
  const record = (vaultId: string, revision: number) => ({ userId: OWNER, vaultId, envelope: { schema: "notes-encrypted-v1" as const, nonce: "", ciphertext: "" }, revision, updatedAt: 0 });

  it("the personal vault reads the legacy per-user record until its own record exists", () => {
    const legacy = record("", 4);
    expect(pickStored(undefined, legacy, OWNER, `browser-${OWNER}`)).toMatchObject({ revision: 4, vaultId: `browser-${OWNER}` });
    expect(pickStored(record(`browser-${OWNER}`, 9), legacy, OWNER, `browser-${OWNER}`)).toMatchObject({ revision: 9 });
  });

  it("a shared vault never reads the legacy record", () => {
    expect(pickStored(undefined, record(`browser-${OWNER}`, 4), OWNER, VAULT)).toBeUndefined();
  });

  it("nothing stored means nothing to open", () => {
    expect(pickStored(undefined, undefined, OWNER, `browser-${OWNER}`)).toBeUndefined();
  });
});

describe("members panel rules", () => {
  it("an owner may give any role; an admin only editor or viewer", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "editor", "viewer"]);
    expect(assignableRoles("admin")).toEqual(["editor", "viewer"]);
    expect(assignableRoles("editor")).toEqual([]);
  });

  it("an admin can manage only editors and viewers; the owner anyone", () => {
    expect(canManage("admin", "editor")).toBe(true);
    expect(canManage("admin", "viewer")).toBe(true);
    expect(canManage("admin", "admin")).toBe(false);
    expect(canManage("admin", "owner")).toBe(false);
    expect(canManage("owner", "owner")).toBe(true);
    expect(canManage("owner", "admin")).toBe(true);
    expect(canManage("editor", "viewer")).toBe(false);
  });

  it("an admin's role select on an editor enables only editor and viewer", () => {
    expect(memberRoleOptions("admin", "editor").filter((o) => o.enabled).map((o) => o.role)).toEqual(["editor", "viewer"]);
  });

  it("an admin's role select on an owner or admin enables nothing but the current role", () => {
    expect(memberRoleOptions("admin", "owner").filter((o) => o.enabled).map((o) => o.role)).toEqual(["owner"]);
    expect(memberRoleOptions("admin", "admin").filter((o) => o.enabled).map((o) => o.role)).toEqual(["admin"]);
  });

  it("an owner's role select enables every role for any member", () => {
    expect(memberRoleOptions("owner", "viewer").every((o) => o.enabled)).toBe(true);
  });

  it("invites: the owner may invite admins, an admin may not", () => {
    expect(invitableRoles("owner")).toEqual(["admin", "editor", "viewer"]);
    expect(invitableRoles("admin")).toEqual(["editor", "viewer"]);
    expect(invitableRoles("viewer")).toEqual([]);
  });
});

describe("members section", () => {
  const member = (userId: string, name: string, role: Role) => ({ userId, email: `${userId}@example.test`, name, role, addedAt: 0 });
  const detail = (role: Role) => ({ vault: { id: "v-1", name: "Firma", kind: "organizacja", ownerUserId: "anna", role }, role, wrappedKey: {} as never,
    members: [member("anna", "Anna", "owner"), member("bartek", "Bartek", "editor")] }) as never;
  const render = (me: string, role: Role) => membersSection("v-1", detail(role), me, async () => {}, async () => {});
  const rowOf = (s: HTMLElement, name: string) => [...s.querySelectorAll("li")].find((li) => li.textContent!.includes(name))!;

  it("lets the owner remove others but not themselves, and marks their own row", () => {
    const s = render("anna", "owner");
    expect(rowOf(s, "Anna").querySelector(".person-you")?.textContent).toBe("Ty");
    expect(rowOf(s, "Bartek").querySelector(".person-you")).toBeNull();
    expect(rowOf(s, "Anna").textContent).not.toContain("Usuń");
    expect(rowOf(s, "Bartek").textContent).toContain("Usuń");
  });

  it("gives an editor no remove buttons", () => {
    expect(render("bartek", "editor").textContent).not.toContain("Usuń");
  });
});

describe("member names and emails", () => {
  const detail = (members: unknown[]) => ({ vault: { id: "v-1", name: "Firma", kind: "organizacja", ownerUserId: "anna" }, role: "owner", wrappedKey: {}, members }) as never;

  it("shows the display name with the last name read from the card, and the email only when the server sent it", () => {
    const s = membersSection("v-1", detail([
      { userId: "anna", name: "Anna", email: "anna@example.test", role: "owner" },
      { userId: "bartek", name: "Bartek", role: "editor" },
    ]), "bartek", async () => {}, async () => {}, new Map([["anna", "Kowalska"]]));
    expect(s.textContent).toContain("Anna Kowalska (anna@example.test)");
    expect(s.textContent).toContain("Bartek");
    expect(s.textContent).not.toContain("undefined");
    expect(s.textContent).not.toContain("null");
    expect(s.querySelector('[aria-label="Rola: Bartek"]')).not.toBeNull();
  });

  it("joins the names without a last name", () => {
    expect(memberLabel({ name: "Ola", lastName: null })).toBe("Ola");
    expect(memberLabel({ name: "Anna", lastName: "Kowalska" })).toBe("Anna Kowalska");
  });
});

describe("vault menu", () => {
  it("no longer offers the download and upload entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ vaults: [] })));
    const bridge = { vault: { id: "browser-u1" }, user: { id: "u1" } } as unknown as BrowserBridge;
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await openVaultMenu(anchor, bridge);
    const labels = [...document.querySelectorAll("[role=menuitem]")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => /zip|Wgraj/.test(l))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("vault menu: the vault on screen", () => {
  it("does not offer the vault on screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ vaults: [{ id: "org-1", name: "Triton", kind: "organizacja", ownerUserId: "u2" }, { id: "org-2", name: "Alfa", kind: "organizacja", ownerUserId: "u2" }] })));
    const bridge = { vault: { id: "org-1", name: "Triton", kind: "organizacja", ownerUserId: "u2" }, user: { id: "u1", personal: "off" } } as unknown as BrowserBridge;
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await openVaultMenu(anchor, bridge);
    const text = [...document.querySelectorAll("[role^=menuitem]")].map((e) => e.textContent).join("|");
    expect(text).toContain("Alfa");
    expect(text).not.toContain("Triton");
    // an account from an invite link alone founds no organization (the server refuses it too)
    expect(text).not.toContain("Nowa organizacja");
    vi.unstubAllGlobals();
  });

  it("offers a new organization to an account with its own notes", async () => {
    document.body.replaceChildren();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ vaults: [] })));
    const bridge = { vault: { id: "org-1", name: "Triton", kind: "organizacja", ownerUserId: "u2" }, user: { id: "u1", personal: "allowed" } } as unknown as BrowserBridge;
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await openVaultMenu(anchor, bridge);
    expect([...document.querySelectorAll("[role^=menuitem]")].map((e) => e.textContent).join("|")).toContain("Nowa organizacja");
    vi.unstubAllGlobals();
  });
});

describe("members dialog invites", () => {
  it("a new link sends maxUses, says how many people it works for, and the list shows uses", async () => {
    const raw = randomVaultKey();
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(init.body as string));
        return Response.json({ invite: { id: "i2", token: "b".repeat(64), role: "editor", expiresAt: Date.now() + 1e6 } });
      }
      if (url.endsWith("/invites")) {
        return Response.json({ invites: [{ id: "i1", role: "viewer", createdBy: OWNER, createdAt: 1, expiresAt: Date.now() + 1e6, maxUses: 5, uses: 2 }] });
      }
      return Response.json({ vault: vaultInfo, role: "owner", wrappedKey: {}, members: [], needsRotation: false });
    }));
    const bridge = {
      vault: vaultInfo, user: { id: OWNER }, vaultKey: raw, vaultEpoch: 1,
      memberLastNames: async () => new Map(), refreshMembers: async () => undefined, markLeaving: () => undefined, catchUp: async () => undefined,
    } as unknown as BrowserBridge;
    openMembersDialog(bridge);
    await vi.waitFor(() => expect(document.body.textContent).toContain("wykorzystano 2 z 5"));

    (document.querySelector('input[aria-label="Na ile osób"]') as HTMLInputElement).value = "5";
    document.querySelector("form.vault-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Link działa dla 5 osób"));
    expect(posted).toEqual([{ role: "editor", maxUses: 5 }]);
  });
});

describe("deleting an organization", () => {
  const detailAs = (role: string) => Response.json({ vault: vaultInfo, role, wrappedKey: {}, members: [], needsRotation: false });
  const bridgeFor = (marked: string[]) => ({
    vault: vaultInfo, user: { id: OWNER, personal: "allowed" }, vaultKey: randomVaultKey(), vaultEpoch: 1, flush: async () => true,
    memberLastNames: async () => new Map(), refreshMembers: async () => undefined, markLeaving: () => marked.push("leaving"), catchUp: async () => undefined,
  }) as unknown as BrowserBridge;

  it("is offered to an owner only, after the name is typed, and sends the name", async () => {
    document.body.replaceChildren();
    const deletes: [string, unknown][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deletes.push([url, JSON.parse(init.body as string)]); return new Response(null, { status: 204 }); }
      if (url.endsWith("/invites")) return Response.json({ invites: [] });
      return detailAs("owner");
    }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...location, assign, pathname: "/" });
    const marked: string[] = [];
    openMembersDialog(bridgeFor(marked));
    const name = vaultInfo.name;
    await vi.waitFor(() => expect(document.querySelector(".vault-danger")).not.toBeNull());
    [...document.querySelectorAll<HTMLButtonElement>(".vault-danger button")].find((b) => b.textContent?.startsWith("Usuń"))!.click();
    const ok = await vi.waitFor(() => { const b = document.querySelector<HTMLButtonElement>(".modal-confirm .btn-danger"); expect(b).not.toBeNull(); return b!; });
    expect(ok.disabled).toBe(true);
    const typed = document.querySelector<HTMLInputElement>('.modal-confirm input[aria-label="Nazwa do potwierdzenia"]')!;
    typed.value = name;
    typed.dispatchEvent(new Event("input"));
    expect(ok.disabled).toBe(false);
    ok.click();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(deletes).toEqual([[`/api/vaults/${encodeURIComponent(vaultInfo.id)}`, { name }]]);
    expect(marked).toEqual(["leaving"]);
    vi.unstubAllGlobals();
  });

  it("is not offered to an admin", async () => {
    document.body.replaceChildren();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/invites") ? Response.json({ invites: [] }) : detailAs("admin"))));
    openMembersDialog(bridgeFor([]));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Klucz sejfu"));
    expect(document.querySelector(".vault-danger")).toBeNull();
    vi.unstubAllGlobals();
  });
});
