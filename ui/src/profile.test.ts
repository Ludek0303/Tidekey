// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserUser } from "./browserauth";
import { keepLastName, openLastName, openProfile, profileChange, sealLastName, sealProfile } from "./profile";
import { importVaultKey, randomVaultKey } from "./vaults";

const VAULT = `v-${"a".repeat(32)}`;
const aesKey = () => importVaultKey(randomVaultKey());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("name cards", () => {
  it("open with the vault key, owner, vault and epoch they were sealed for", async () => {
    const key = await aesKey();
    const card = await sealProfile("Kowalska", VAULT, "anna", 2, key);
    expect(card).toMatchObject({ schema: "notes-profile-v1", keyEpoch: 2 });
    expect(await openProfile(card, VAULT, "anna", key)).toBe("Kowalska");
  });

  it("do not open for another user, another vault, another epoch, or with another key", async () => {
    const key = await aesKey();
    const card = await sealProfile("Kowalska", VAULT, "anna", 2, key);
    await expect(openProfile(card, VAULT, "bartek", key)).rejects.toThrow();
    await expect(openProfile(card, `v-${"b".repeat(32)}`, "anna", key)).rejects.toThrow();
    await expect(openProfile({ ...card, keyEpoch: 3 }, VAULT, "anna", key)).rejects.toThrow();
    await expect(openProfile(card, VAULT, "anna", await aesKey())).rejects.toThrow();
  });

  it("the account copy opens only with the personal key", async () => {
    const personal = await aesKey();
    const secret = await sealLastName("Kowalska", personal);
    expect(await openLastName(secret, personal)).toBe("Kowalska");
    await expect(openLastName(secret, await aesKey())).rejects.toThrow();
  });

  it("is written when the server has no card", async () => {
    expect(await profileChange(null, "Kowalska", VAULT, "anna", 1, await aesKey())).toMatchObject({ keyEpoch: 1 });
  });

  it("is not written when the card has the same name under the same epoch", async () => {
    const key = await aesKey();
    const card = await sealProfile("Kowalska", VAULT, "anna", 1, key);
    expect(await profileChange(card, "Kowalska", VAULT, "anna", 1, key)).toBeUndefined();
  });

  it("is written under a newer epoch or with another name, and removed when the name is cleared", async () => {
    const key = await aesKey();
    const card = await sealProfile("Kowalska", VAULT, "anna", 1, key);
    expect(await profileChange(card, "Kowalska", VAULT, "anna", 2, key)).toMatchObject({ keyEpoch: 2 });
    expect(await profileChange(card, "Nowak", VAULT, "anna", 1, key)).toMatchObject({ keyEpoch: 1 });
    expect(await profileChange(card, "", VAULT, "anna", 1, key)).toBeNull();
  });

  it("is not written when there is neither a name nor a card", async () => {
    expect(await profileChange(null, "", VAULT, "anna", 1, await aesKey())).toBeUndefined();
  });
});

describe("the account copy of the last name", () => {
  const user = (over: Partial<BrowserUser> = {}): BrowserUser => ({ id: "u1", email: "a@example.test", name: "Ola", ...over });
  // The PATCH bodies sent to the account, in order.
  const patches = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/auth/me" && (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

  it("a typed name is stored encrypted, and no plaintext is sent", async () => {
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const personal = await aesKey();
    const u = user();
    await keepLastName(u, personal, "Kowalska");
    const [body] = patches(fetchMock);
    expect(Object.keys(body)).toEqual(["profileSecret"]);
    expect(await openLastName(body.profileSecret as never, personal)).toBe("Kowalska");
    expect(u.profileSecret).toEqual(body.profileSecret);
  });

  it("a legacy plaintext name is moved in one request that clears it, then nothing is sent again", async () => {
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const personal = await aesKey();
    const u = user({ lastName: "Kowalska" });
    await keepLastName(u, personal, "");
    const [body] = patches(fetchMock);
    expect(body).toMatchObject({ lastName: "" });
    expect(await openLastName(body.profileSecret as never, personal)).toBe("Kowalska");
    expect(u.lastName).toBe("");
    await keepLastName(u, personal, "");
    expect(patches(fetchMock)).toHaveLength(1);
  });

  it("with a stored copy already, a legacy name only clears the plaintext", async () => {
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const personal = await aesKey();
    await keepLastName(user({ lastName: "Kowalska", profileSecret: await sealLastName("Nowak", personal) }), personal, "");
    expect(patches(fetchMock)).toEqual([{ lastName: "" }]);
  });

  it("a failed save does not throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Błąd" }, 500)));
    await expect(keepLastName(user(), await aesKey(), "Kowalska")).resolves.toBeUndefined();
  });
});
