// @vitest-environment node
// Node on purpose: the MCP seals proposals in Node 22 without a DOM.
import { describe, expect, it } from "vitest";
import { blake2bHex, generateAgentKeys, signAsAgent, type AgentKeyPair } from "./agentcrypto";
import { openProposal, sealProposal, textHash, type Proposal, type ProposalBody } from "./proposals";
import { bufferSource, randomVaultKey } from "./vaults";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const AGENT = "a".repeat(32);
const body: ProposalBody = { createdAt: 1_700_000_000_000, summary: "Dopisz notatkę", changes: [{ op: "append", path: "Plan.md", noteId: "n1", baseHash: "00", text: "\n- nowy punkt" }] };

async function person() {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { boxPrivateKey: pair.privateKey, personBoxKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey };
}
const seal = (keys: AgentKeyPair, personBoxKey: JsonWebKey, over: Partial<ProposalBody> = {}) =>
  sealProposal({ ...body, ...over }, { vaultId: "v1", agentId: AGENT, userId: "u1", personBoxKey, signSecret: keys.signSecret });
const opts = (keys: AgentKeyPair, boxPrivateKey: CryptoKey) => ({ vaultId: "v1", boxPrivateKey, agentSignKey: keys.signKey, agentId: AGENT, userId: "u1" });
const BAD = "Propozycja jest uszkodzona lub podrobiona.";

describe("proposals", () => {
  it("textHash is hex H of the UTF-8 text", async () => {
    expect(await textHash("zażółć")).toBe(await blake2bHex(new TextEncoder().encode("zażółć")));
    expect(await textHash("")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips for the person and the signed chat", async () => {
    const keys = await generateAgentKeys();
    const anna = await person();
    const p = await seal(keys, anna.personBoxKey);
    expect(p).toMatchObject({ schema: "notes-proposal-v1", agentId: AGENT, signerUserId: "u1", signerAgentId: AGENT, alg: "ed25519" });
    expect(p.proposalId).toMatch(/^[0-9a-f]{32}$/);
    expect(p.epk).not.toHaveProperty("d");
    expect(await openProposal(p, opts(keys, anna.boxPrivateKey))).toEqual(body);
  });

  it("does not open for another person, with another vault or with a forged signature", async () => {
    const keys = await generateAgentKeys();
    const anna = await person();
    const p = await seal(keys, anna.personBoxKey);
    await expect(openProposal(p, opts(keys, (await person()).boxPrivateKey))).rejects.toThrow(BAD);
    await expect(openProposal(p, { ...opts(keys, anna.boxPrivateKey), vaultId: "v2" })).rejects.toThrow(BAD);
    await expect(openProposal(p, { ...opts(keys, anna.boxPrivateKey), agentSignKey: (await generateAgentKeys()).signKey })).rejects.toThrow(BAD);
    await expect(openProposal(p, { ...opts(keys, anna.boxPrivateKey), userId: "u2" })).rejects.toThrow(BAD);
    await expect(openProposal(p, { ...opts(keys, anna.boxPrivateKey), agentId: "b".repeat(32) })).rejects.toThrow(BAD);
    await expect(openProposal({ ...p, signature: p.signature.slice(0, -2) + "AA" }, opts(keys, anna.boxPrivateKey))).rejects.toThrow(BAD);
    await expect(openProposal({ ...p, schema: "x" } as unknown as Proposal, opts(keys, anna.boxPrivateKey))).rejects.toThrow(BAD);
  });

  it("refuses changed AAD fields even when the chat re-signs them", async () => {
    const keys = await generateAgentKeys();
    const anna = await person();
    const p = await seal(keys, anna.personBoxKey);
    const { signature: _s, signerUserId: _u, signerAgentId: _a, alg: _g, ...unsigned } = p;
    // another proposalId (key and AAD differ)
    const moved = await signAsAgent({ ...unsigned, proposalId: "c".repeat(32) }, "u1", AGENT, keys.signSecret);
    await expect(openProposal(moved, opts(keys, anna.boxPrivateKey))).rejects.toThrow(BAD);
    // another agentId inside the proposal, signed by that same key: AAD differs (agentId must match too)
    const other = "b".repeat(32);
    const relabelled = await signAsAgent({ ...unsigned, agentId: other }, "u1", other, keys.signSecret);
    await expect(openProposal(relabelled, { ...opts(keys, anna.boxPrivateKey), agentId: other })).rejects.toThrow(BAD);
    // a proposal sealed for vault v2 opened as v1
    const v2 = await sealProposal(body, { vaultId: "v2", agentId: AGENT, userId: "u1", personBoxKey: anna.personBoxKey, signSecret: keys.signSecret });
    await expect(openProposal(v2, opts(keys, anna.boxPrivateKey))).rejects.toThrow(BAD);
  });

  it("is not encrypted with the vault key", async () => {
    const keys = await generateAgentKeys();
    const anna = await person();
    const p = await seal(keys, anna.personBoxKey);
    const vaultKey = await crypto.subtle.importKey("raw", bufferSource(randomVaultKey()), "AES-GCM", false, ["decrypt"]);
    const aad = new TextEncoder().encode(`notes-proposal-v1\0v1\0${p.proposalId}\0${AGENT}`);
    const iv = Uint8Array.from(atob(p.nonce), (c) => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(p.ciphertext), (c) => c.charCodeAt(0));
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, vaultKey, ct)).rejects.toThrow();
  });

  it("refuses a ciphertext above 1 MiB", async () => {
    const keys = await generateAgentKeys();
    const anna = await person();
    const noise = Array.from({ length: 14 }, () => Array.from(crypto.getRandomValues(new Uint8Array(65_536)), (b) => b.toString(16).padStart(2, "0")).join("")).join("");
    await expect(seal(keys, anna.personBoxKey, { changes: [{ op: "create", path: "Duży.md", noteId: "n2", baseHash: "", text: noise }] })).rejects.toThrow(/1 MiB/);
  });
});
