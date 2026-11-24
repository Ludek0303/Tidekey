// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./bridge";
import { wrapBytes } from "./vaults";
import { loadSigningIdentity, signEvent, verificationBadge, verifyEvents, verifySigned, type SignableEvent, type SignerMember, type SigningIdentity } from "./signing";
import { generateAgentKeys, signAsAgent, signCert, type AgentCert } from "./agentcrypto";

const personal = (): Promise<CryptoKey> => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake server for /api/me/signing-key: one stored key (or none), PUT stores it unless `conflict` says a key exists.
function signingServer(options: { stored?: unknown; conflict?: unknown } = {}) {
  let stored = options.stored;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url !== "/api/me/signing-key") return json({ message: "nie ma" }, 404);
    if (method === "GET") return stored ? json(stored) : json({ message: "Brak klucza podpisu." }, 404);
    if (options.conflict) return json({ message: "Klucz podpisu już istnieje." }, 409);
    stored = body;
    return json({ publicJwk: body.publicJwk });
  });
  return { calls, store: (value: unknown) => { stored = value; } };
}

afterEach(() => { vi.restoreAllMocks(); });

const sampleEvent = (over: Partial<SignableEvent> = {}): SignableEvent => ({
  event_id: "e-1",
  actor_user_id: "user-a",
  kind: "TaskAssigned",
  time_ms: 1000,
  after: { task_id: "t-1", title: "Plan", assignees: ["Ania"], people: { Ania: "user-b" } },
  before: null,
  ...over,
} as SignableEvent);

describe("canonical JSON", () => {
  it("is the same for any key order, at every depth, and keeps array order", () => {
    const a = { b: 1, a: { d: [3, 1], c: "x" } };
    const b = { a: { c: "x", d: [3, 1] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
    expect(canonicalJson({ l: [2, 1] })).not.toBe(canonicalJson({ l: [1, 2] }));
  });
});

describe("signing key", () => {
  it("generates a key, stores its public half and the wrapped private half when the server has none (404)", async () => {
    const server = signingServer();
    const identity = await loadSigningIdentity("user-a", await personal());
    expect(server.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    const put = server.calls[1].body as { publicJwk: JsonWebKey; wrappedPrivate: { schema: string } };
    expect(Object.keys(put.publicJwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(put.wrappedPrivate.schema).toBe("notes-key-v1");
    expect(identity.publicJwk).toEqual(put.publicJwk);
  });

  it("on 409 (another key was stored first) reads the stored key again", async () => {
    const key = await personal();
    const elsewhere = await generatedEnvelope(key);
    let gets = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if ((init?.method ?? "GET") !== "GET") return json({ message: "Klucz podpisu już istnieje." }, 409);
      gets++;
      return gets === 1 ? json({ message: "Brak klucza podpisu." }, 404) : json(elsewhere);
    });
    const identity = await loadSigningIdentity("user-a", key);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(gets).toBe(2);
    expect(identity.publicJwk).toEqual(elsewhere.publicJwk);
  });

  it("reuses the stored key without a PUT (200)", async () => {
    const key = await personal();
    const made = await generatedEnvelope(key);
    const server = signingServer({ stored: made });
    const identity = await loadSigningIdentity("user-a", key);
    expect(server.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(identity.publicJwk).toEqual(made.publicJwk);
  });
});

// A stored signing key as the server keeps it: a fresh pair, its private half wrapped with `key`.
async function generatedEnvelope(key: CryptoKey) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey, wrappedPrivate: await wrapBytes(pkcs8, key) };
}

async function identityFor(userId: string): Promise<{ identity: SigningIdentity; member: SignerMember }> {
  const key = await personal();
  const made = await generatedEnvelope(key);
  signingServer({ stored: made });
  const identity = await loadSigningIdentity(userId, key);
  return { identity, member: { userId, signingKey: identity.publicJwk } };
}

describe("signed events", () => {
  it("a signed event verifies against its signer's key", async () => {
    const { identity, member } = await identityFor("user-a");
    const event = sampleEvent();
    await signEvent(event, identity);
    expect(event.signerUserId).toBe("user-a");
    expect(event.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    const checks = await verifyEvents([event], [member], true);
    expect(checks.get("e-1")?.status).toBe("ok");
  });

  it("a tampered event is unverified, and the cached ok is not reused for the changed copy", async () => {
    const { identity, member } = await identityFor("user-a");
    const event = sampleEvent();
    await signEvent(event, identity);
    expect((await verifyEvents([event], [member], true)).get("e-1")?.status).toBe("ok");
    const tampered = { ...event, kind: "TaskCompleted" } as SignableEvent;
    const check = (await verifyEvents([tampered], [member], true)).get("e-1");
    expect(check?.status).toBe("unverified");
    expect(check?.reason).toMatch(/nie zgadza się/);
  });

  it("an event signed by someone who is not a member is unverified", async () => {
    const outsider = await identityFor("user-x");
    const { member } = await identityFor("user-a");
    const event = sampleEvent();
    await signEvent(event, outsider.identity);
    const check = (await verifyEvents([event], [member], true)).get("e-1");
    expect(check?.status).toBe("unverified");
    expect(check?.reason).toMatch(/nie jest członkiem/);
  });

  it("an unsigned event in a shared vault is unverified but still returned; in the personal vault it is fine", async () => {
    const { member } = await identityFor("user-a");
    const events = [sampleEvent({ event_id: "legacy" })];
    const shared = await verifyEvents(events, [member], true);
    expect(shared.has("legacy")).toBe(true);
    expect(shared.get("legacy")?.status).toBe("unverified");
    expect(verificationBadge(shared.get("legacy"))?.textContent).toBe("niezweryfikowane");
    expect((await verifyEvents(events, [member], false)).get("legacy")?.status).toBe("ok");
  });

  it("a verified event gets no badge", () => {
    expect(verificationBadge({ status: "ok", reason: "" })).toBeNull();
    expect(verificationBadge(undefined)).toBeNull();
  });
});

describe("events signed by a Claude chat", () => {
  const AGENT = "a".repeat(32);
  async function chat(revokedAt: number | null = null, over: Partial<AgentCert> = {}) {
    const { identity, member } = await identityFor("user-a");
    const keys = await generateAgentKeys();
    const cert = await signCert({
      schema: "notes-agent-cert-v1", agentId: AGENT, userId: "user-a", signKey: keys.signKey, boxKey: keys.boxKey,
      vaults: [{ vaultId: "v1", whole: true, parts: [], writeMode: "direct" }], createdAt: 500, expiresAt: 500 + 86_400_000, ...over,
    }, identity);
    // as GET /api/vaults/:id sends it: the signature beside the cert
    const { signature, ...unsigned } = cert;
    const withChat: SignerMember = { ...member, agents: [{ agentId: AGENT, cert: unsigned as AgentCert, signature, revokedAt }] };
    const event = await signAsAgent(sampleEvent({ event_id: `chat-${Math.random()}` }), "user-a", AGENT, keys.signSecret);
    return { identity, keys, member: withChat, event };
  }
  const check = async (event: SignableEvent, member: SignerMember) => (await verifyEvents([event], [member], true)).get(event.event_id)!;

  it("verifies against the chat's certificate", async () => {
    const { event, member } = await chat();
    expect(await check(event, member)).toEqual({ status: "ok", reason: "Podpis czatu Claude zgodny z certyfikatem." });
    expect((await verifySigned(event, [member])).status).toBe("ok");
  });

  it("is unverified when the chat was revoked before the event, but fine when revoked after", async () => {
    const before = await chat(999);
    expect(await check(before.event, before.member)).toMatchObject({ status: "unverified", reason: "Czat Claude został odłączony przed tym zdarzeniem." });
    const after = await chat(1001);
    expect((await check(after.event, after.member)).status).toBe("ok");
  });

  it("is unverified with a bad certificate, a changed event, another agentId, or after the cert expired", async () => {
    const { event, member, keys } = await chat();
    const agent = member.agents![0];
    const forgedCert: SignerMember = { ...member, agents: [{ ...agent, cert: { ...agent.cert, signKey: (await generateAgentKeys()).signKey } }] };
    expect((await check(event, forgedCert)).status).toBe("unverified");
    expect((await check({ ...event, kind: "TaskCompleted" } as SignableEvent, member)).status).toBe("unverified");
    const other = await signAsAgent(sampleEvent({ event_id: "other-agent" }), "user-a", "b".repeat(32), keys.signSecret);
    expect((await check(other, member)).status).toBe("unverified");
    const expired = await chat(null, { expiresAt: 900 });
    expect((await check(expired.event, expired.member)).status).toBe("unverified");
    // a chat of another member can't sign as this member
    const stranger = await chat();
    expect((await check({ ...stranger.event, signerUserId: "user-b" } as SignableEvent, member)).status).toBe("unverified");
    // without the member's agents list (old server), a chat signature is never trusted
    expect((await check(event, { userId: member.userId, signingKey: member.signingKey })).status).toBe("unverified");
    expect((await verifySigned(event, [{ userId: member.userId, signingKey: member.signingKey }])).status).toBe("unverified");
  });

  it("an ECDSA event claiming a chat is unverified", async () => {
    const { identity, member } = await identityFor("user-a");
    const event = { ...sampleEvent({ event_id: "mixed" }), signerAgentId: AGENT } as SignableEvent;
    await signEvent(event, identity);
    expect((await check(event, member)).status).toBe("unverified");
  });
});
