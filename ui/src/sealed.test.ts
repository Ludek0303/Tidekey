// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBoxIdentity, openSealed, sealTo } from "./sealed";
import { newRecoveryKey } from "./browserauth";
import { randomVaultKey } from "./vaults";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pair = async () => {
  const p = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", p.publicKey);
  return { privateKey: p.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey };
};

afterEach(() => { vi.restoreAllMocks(); });

describe("sealed box", () => {
  it("opens with the recipient's private key and returns the same bytes", async () => {
    const recipient = await pair();
    const raw = randomVaultKey();
    const sealed = await sealTo(recipient.publicJwk, raw);
    expect(sealed.schema).toBe("notes-sealed-v1");
    expect(Object.keys(sealed.epk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(atob(sealed.nonce).length).toBe(12);
    expect(await openSealed(sealed, recipient.privateKey)).toEqual(raw);
  });

  it("each seal uses a fresh ephemeral key and nonce", async () => {
    const recipient = await pair();
    const raw = randomVaultKey();
    const a = await sealTo(recipient.publicJwk, raw);
    const b = await sealTo(recipient.publicJwk, raw);
    expect(a.epk).not.toEqual(b.epk);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("another member's private key cannot open it", async () => {
    const recipient = await pair();
    const stranger = await pair();
    const sealed = await sealTo(recipient.publicJwk, randomVaultKey());
    await expect(openSealed(sealed, stranger.privateKey)).rejects.toThrow("Nie udało się otworzyć klucza sejfu.");
  });

  it("an altered ciphertext does not open", async () => {
    const recipient = await pair();
    const sealed = await sealTo(recipient.publicJwk, randomVaultKey());
    const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    const tampered = { ...sealed, ciphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(openSealed(tampered, recipient.privateKey)).rejects.toThrow();
  });
});

// A fake server for /api/me/box-key: one stored key (or none). PUT stores it unless `conflict` says another key exists.
function boxServer(options: { stored?: unknown; conflict?: boolean } = {}) {
  let stored = options.stored;
  const calls: { method: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== "/api/me/box-key") return json({ message: "nie ma" }, 404);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    if (method === "GET") return stored ? json(stored) : json({ message: "Brak klucza szyfrowania." }, 404);
    if (options.conflict) return json({ message: "Klucz już istnieje." }, 409);
    stored = body;
    return json({ publicJwk: body.publicJwk });
  });
  return { calls };
}

describe("box key", () => {
  it("404: generates a pair, PUTs the public half and the wrapped private half", async () => {
    const personal = (await newRecoveryKey()).key;
    const server = boxServer();
    const identity = await loadBoxIdentity("user-a", personal);
    expect(server.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    const put = server.calls[1].body as { publicJwk: JsonWebKey; wrappedPrivate: { schema: string } };
    expect(Object.keys(put.publicJwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(put.wrappedPrivate.schema).toBe("notes-key-v1");
    expect(identity.publicJwk).toEqual(put.publicJwk);
    // the generated key works for sealing and opening
    const sealed = await sealTo(identity.publicJwk, randomVaultKey());
    expect(await openSealed(sealed, identity.privateKey)).toHaveLength(32);
  });

  it("409 on PUT (another device stored one first): reads the stored key again", async () => {
    const personal = (await newRecoveryKey()).key;
    const elsewhere = boxServer();
    await loadBoxIdentity("user-a", personal);
    const stored = elsewhere.calls[1].body;
    vi.restoreAllMocks();
    let gets = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if ((init?.method ?? "GET") !== "GET") return json({ message: "Klucz już istnieje." }, 409);
      gets++;
      return gets === 1 ? json({ message: "Brak klucza szyfrowania." }, 404) : json(stored);
    });
    const identity = await loadBoxIdentity("user-a", personal);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(gets).toBe(2);
    expect(identity.publicJwk).toEqual((stored as { publicJwk: JsonWebKey }).publicJwk);
  });

  it("the stored private half is wrapped: another personal key cannot read it", async () => {
    const personal = (await newRecoveryKey()).key;
    const other = (await newRecoveryKey()).key;
    const server = boxServer();
    await loadBoxIdentity("user-a", personal);
    const wrapped = (server.calls[1].body as { wrappedPrivate: unknown }).wrappedPrivate;
    const stored = { publicJwk: (server.calls[1].body as { publicJwk: JsonWebKey }).publicJwk, wrappedPrivate: wrapped };
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(stored));
    await expect(loadBoxIdentity("user-a", other)).rejects.toThrow();
  });
});
