// @vitest-environment node
// Node on purpose: the MCP runs this module in Node 22 without a DOM.
import sodiumModule from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  b64u, blake2bHex, checkCode, claimProof, fromB64u, generateAgentKeys, inScope, newAgentId, newNonce, normalizeCode, openForAgent, openScope,
  projectSlot, requestProof, sealForAgent, sealScope, signAsAgent, signCert, validCode, verifyAgentSigned, verifyCert,
  type AgentCert, type AgentKeyPair, type AgentScope,
} from "./agentcrypto";
import type { SigningIdentity } from "./signing";

const sodium = sodiumModule;
beforeAll(async () => { await sodium.ready; });
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const DAY = 86_400_000;

async function identity(userId: string): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { userId, privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

const certFor = (keys: AgentKeyPair, over: Partial<AgentCert> = {}): AgentCert => ({
  schema: "notes-agent-cert-v1", agentId: "a".repeat(32), userId: "u1", signKey: keys.signKey, boxKey: keys.boxKey,
  vaults: [{ vaultId: "v1", whole: true, parts: [], writeMode: "proposals" }], createdAt: 1_000_000, expiresAt: 1_000_000 + 90 * DAY, ...over,
});
const scopeFor = (over: Partial<AgentScope> = {}): AgentScope => ({
  schema: "notes-agent-scope-v1", agentId: "a".repeat(32), vaultId: "v1", include: [], exclude: [], tools: [], tasks: "all", updatedAt: 5, ...over,
});

describe("encodings", () => {
  it("b64u is base64url without padding and round-trips", () => {
    const bytes = new Uint8Array([251, 255, 0, 1]);
    expect(b64u(bytes)).toBe("-_8AAQ");
    expect([...fromB64u("-_8AAQ")]).toEqual([...bytes]);
    expect(() => fromB64u("ab+c")).toThrow();
  });
  it("H is BLAKE2b-256 in hex", async () => {
    expect(await blake2bHex(new Uint8Array())).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
  });
  it("ids and nonces are 32 hex", () => {
    expect(newAgentId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(newNonce());
  });
});

describe("pairing", () => {
  it("normalizes and validates codes", () => {
    expect(normalizeCode(" k7qm-3xrp ")).toBe("K7QM3XRP");
    expect(validCode("k7qm-3xrp")).toBe(true);
    expect(validCode("K7QM-3XR")).toBe(false);
    expect(validCode("K7QM-3XR0")).toBe(false); // 0 is not in the alphabet
    expect(validCode("K7QM-3XRI")).toBe(false);
  });

  it("claim proof verifies with plain crypto_sign_verify_detached over the contract message", async () => {
    const keys = await generateAgentKeys();
    expect(fromB64u(keys.signKey)).toHaveLength(32);
    expect(fromB64u(keys.boxKey)).toHaveLength(32);
    const proof = fromB64u(await claimProof("k7qm-3xrp", keys));
    const message = `notes agent-claim v1\nK7QM3XRP\n${keys.signKey}\n${keys.boxKey}`;
    expect(sodium.crypto_sign_verify_detached(proof, utf8(message), fromB64u(keys.signKey))).toBe(true);
    expect(sodium.crypto_sign_verify_detached(proof, utf8(message.replace("K7QM3XRP", "K7QM3XRQ")), fromB64u(keys.signKey))).toBe(false);
  });

  it("check code is 6 deterministic digits from H of the contract message", async () => {
    const keys = await generateAgentKeys();
    const code = await checkCode(keys.signKey, keys.boxKey, "K7QM-3XRP");
    expect(code).toMatch(/^\d{6}$/);
    expect(await checkCode(keys.signKey, keys.boxKey, "k7qm3xrp")).toBe(code);
    const h = sodium.crypto_generichash(32, utf8(`notes agent-pair v1\n${keys.signKey}\n${keys.boxKey}\nK7QM3XRP`), null);
    const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0, false) % 1_000_000;
    expect(code).toBe(String(n).padStart(6, "0"));
    const other = await generateAgentKeys();
    expect(await checkCode(other.signKey, keys.boxKey, "K7QM3XRP")).not.toBe(code); // 1 in a million to collide
  });
});

describe("sealed to a chat", () => {
  it("opens only in the context it was sealed for and only with the chat's key", async () => {
    const keys = await generateAgentKeys();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealForAgent(key, keys.boxKey, "v1", "vault", 3);
    expect(sealed.schema).toBe("notes-agent-sealed-v1");
    expect([...await openForAgent(sealed, keys, "v1", "vault", 3)]).toEqual([...key]);
    // the box is exactly crypto_box_seal(context + key)
    const raw = sodium.crypto_box_seal_open(fromB64u(sealed.box), fromB64u(keys.boxKey), keys.boxSecret);
    expect(new TextDecoder().decode(raw.subarray(0, raw.length - 32))).toBe("notes-agent-sealed-v1\nv1\nvault\n3\n");
    await expect(openForAgent(sealed, keys, "v2", "vault", 3)).rejects.toThrow();
    await expect(openForAgent(sealed, keys, "v1", projectSlot("Projekty/A"), 3)).rejects.toThrow();
    await expect(openForAgent(sealed, keys, "v1", "vault", 4)).rejects.toThrow();
    const stranger = await generateAgentKeys();
    await expect(openForAgent(sealed, stranger, "v1", "vault", 3)).rejects.toThrow();
    const project = await sealForAgent(key, keys.boxKey, "v1", projectSlot("Projekty/A"), 1);
    expect([...await openForAgent(project, keys, "v1", "project:Projekty/A", 1)]).toEqual([...key]);
    await expect(openForAgent(project, keys, "v1", "project:Projekty/B", 1)).rejects.toThrow();
  });
});

describe("certificate", () => {
  it("verifies when signed by the person and refuses forgeries", async () => {
    const keys = await generateAgentKeys();
    const anna = await identity("u1");
    const signed = await signCert(certFor(keys), anna);
    expect(signed.signerUserId).toBe("u1");
    expect(await verifyCert(signed, anna.publicJwk)).toBe(true);
    expect(await verifyCert({ ...signed, boxKey: (await generateAgentKeys()).boxKey }, anna.publicJwk)).toBe(false);
    expect(await verifyCert(signed, (await identity("u1")).publicJwk)).toBe(false);
    expect(await verifyCert({ ...signed, signature: undefined }, anna.publicJwk)).toBe(false);
    // signed by someone else than the cert's person
    const mallory = await identity("u2");
    expect(await verifyCert(await signCert({ ...certFor(keys), userId: "u2" }, mallory).then((c) => ({ ...c, userId: "u1" })), mallory.publicJwk)).toBe(false);
    await expect(signCert(certFor(keys, { userId: "u2" }), anna)).rejects.toThrow();
    // "Tekst z plików" is signed with the rest: adding or flipping it afterwards breaks the signature; a non-boolean is refused
    const withText = { ...certFor(keys), vaults: certFor(keys).vaults.map((v) => ({ ...v, fileText: true })) };
    const signedText = await signCert(withText, anna);
    expect(await verifyCert(signedText, anna.publicJwk)).toBe(true);
    expect(await verifyCert({ ...signed, vaults: signed.vaults.map((v) => ({ ...v, fileText: true })) }, anna.publicJwk)).toBe(false);
    expect(await verifyCert({ ...signedText, vaults: signedText.vaults.map((v) => ({ ...v, fileText: false })) }, anna.publicJwk)).toBe(false);
    const odd = { ...certFor(keys), vaults: certFor(keys).vaults.map((v) => ({ ...v, fileText: "tak" as unknown as boolean })) };
    expect(await verifyCert(await signCert(odd, anna), anna.publicJwk)).toBe(false);
    // too long, empty vaults, wrong schema
    expect(await verifyCert(await signCert(certFor(keys, { expiresAt: 1_000_000 + 90 * DAY + 1 }), anna), anna.publicJwk)).toBe(false);
    expect(await verifyCert(await signCert(certFor(keys, { vaults: [] }), anna), anna.publicJwk)).toBe(false);
    expect(await verifyCert(await signCert({ ...certFor(keys), schema: "x" } as unknown as AgentCert, anna), anna.publicJwk)).toBe(false);
  });
});

describe("scope", () => {
  it("is signed, sealed, and opened only when signature and fields match", async () => {
    const keys = await generateAgentKeys();
    const anna = await identity("u1");
    const expect1 = { agentId: "a".repeat(32), vaultId: "v1", userId: "u1" };
    const sealed = await sealScope(scopeFor({ include: ["Spotkania"] }), anna, keys.boxKey);
    expect(sealed.schema).toBe("notes-agent-sealed-scope-v1");
    const opened = await openScope(sealed, keys, anna.publicJwk, expect1);
    expect(opened.include).toEqual(["Spotkania"]);
    await expect(openScope(sealed, keys, (await identity("u1")).publicJwk, expect1)).rejects.toThrow();
    await expect(openScope(sealed, keys, anna.publicJwk, { ...expect1, agentId: "b".repeat(32) })).rejects.toThrow();
    await expect(openScope(sealed, keys, anna.publicJwk, { ...expect1, vaultId: "v2" })).rejects.toThrow();
    await expect(openScope(sealed, keys, anna.publicJwk, { ...expect1, userId: "u2" })).rejects.toThrow();
    await expect(openScope(sealed, await generateAgentKeys(), anna.publicJwk, expect1)).rejects.toThrow();
    // a scope altered after signing: reseal the JSON with a changed field
    const raw = JSON.parse(new TextDecoder().decode(sodium.crypto_box_seal_open(fromB64u(sealed.box), fromB64u(keys.boxKey), keys.boxSecret)));
    raw.exclude = ["Tajne"];
    const forged = { schema: "notes-agent-sealed-scope-v1" as const, box: b64u(sodium.crypto_box_seal(utf8(JSON.stringify(raw)), fromB64u(keys.boxKey))) };
    await expect(openScope(forged, keys, anna.publicJwk, expect1)).rejects.toThrow();
  });

  it("include/exclude: exclude wins, a path covers itself and what is under it", () => {
    const s = scopeFor({ include: ["Spotkania/", "Plan.md"], exclude: ["Spotkania/Zarząd"] });
    expect(inScope(s, "Spotkania/a.md")).toBe(true);
    expect(inScope(s, "Spotkania")).toBe(true);
    expect(inScope(s, "Plan.md")).toBe(true);
    expect(inScope(s, "Spotkania/Zarząd")).toBe(false);
    expect(inScope(s, "Spotkania/Zarząd/x.md")).toBe(false);
    expect(inScope(s, "spotkania/zarząd/x.md")).toBe(false); // paths are case-insensitive in a vault
    expect(inScope(s, "Spotkania/Zarządy.md")).toBe(true);
    expect(inScope(s, "SpotkaniaX/a.md")).toBe(false);
    expect(inScope(s, "Inne.md")).toBe(false);
    expect(inScope(scopeFor(), "Cokolwiek/a.md")).toBe(true);
    expect(inScope(scopeFor({ exclude: ["Tajne"] }), "Tajne/a.md")).toBe(false);
    expect(inScope(null, "a.md")).toBe(false);
  });
});

describe("signed by a chat", () => {
  it("signs canonical JSON without signature with Ed25519 and refuses changes", async () => {
    const keys = await generateAgentKeys();
    const event = { event_id: "e1", time_ms: 5, note_id: "n", z: { b: 1, a: 2 } };
    const signed = await signAsAgent(event, "u1", "a".repeat(32), keys.signSecret);
    expect(signed).toMatchObject({ signerUserId: "u1", signerAgentId: "a".repeat(32), alg: "ed25519" });
    expect(await verifyAgentSigned(signed, keys.signKey)).toBe(true);
    const canon = '{"alg":"ed25519","event_id":"e1","note_id":"n","signerAgentId":"' + "a".repeat(32) + '","signerUserId":"u1","time_ms":5,"z":{"a":2,"b":1}}';
    expect(sodium.crypto_sign_verify_detached(fromB64u(signed.signature), utf8(canon), fromB64u(keys.signKey))).toBe(true);
    const later = { ...signed, time_ms: 6 };
    const relabelled = { ...signed, signerAgentId: "b".repeat(32) };
    expect(await verifyAgentSigned(later, keys.signKey)).toBe(false);
    expect(await verifyAgentSigned(relabelled, keys.signKey)).toBe(false);
    expect(await verifyAgentSigned(signed, (await generateAgentKeys()).signKey)).toBe(false);
    expect(await verifyAgentSigned({ ...signed, signature: "AAAA" }, keys.signKey)).toBe(false);
    expect(await verifyAgentSigned({ ...signed, signature: undefined }, keys.signKey)).toBe(false);
  });
});

describe("request proof", () => {
  it("verifies over the contract message and fails when any field changes", async () => {
    const keys = await generateAgentKeys();
    const input = { method: "POST", pathAndQuery: "/api/agent/vaults/v1/snapshot?since=3", body: utf8('{"a":1}'), time: 1_700_000_000_000, nonce: "0".repeat(32), version: "1.0.0" };
    const proof = fromB64u(await requestProof(input, keys.signSecret));
    const message = (i: typeof input): Uint8Array =>
      utf8(`notes-agent-req-v1\n${i.method}\n${i.pathAndQuery}\n${sodium.to_hex(sodium.crypto_generichash(32, i.body, null))}\n${i.time}\n${i.nonce}\n${i.version}`);
    const pk = fromB64u(keys.signKey);
    expect(sodium.crypto_sign_verify_detached(proof, message(input), pk)).toBe(true);
    for (const changed of [
      { ...input, method: "GET" }, { ...input, pathAndQuery: "/api/agent/vaults/v2/snapshot?since=3" }, { ...input, body: utf8('{"a":2}') },
      { ...input, time: input.time + 1 }, { ...input, nonce: "1".repeat(32) }, { ...input, version: "1.0.1" },
    ]) expect(sodium.crypto_sign_verify_detached(proof, message(changed), pk)).toBe(false);
    // empty body: H of zero bytes
    const empty = { ...input, method: "GET", body: new Uint8Array() };
    expect(sodium.crypto_sign_verify_detached(fromB64u(await requestProof(empty, keys.signSecret)), message(empty), pk)).toBe(true);
  });
});
