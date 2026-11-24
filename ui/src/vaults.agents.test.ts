// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVault } from "./vaults";

afterEach(() => vi.unstubAllGlobals());

// An admin took a member's chat out of this vault: it counts as disconnected from then on here (older events still verify).
describe("fetchVault and chats detached from the vault", () => {
  it("detachedAt becomes the time the chat stops counting here; the earlier of the two wins", async () => {
    const agent = (over: object) => ({ agentId: "a".repeat(32), cert: {}, signature: "s", revokedAt: null, ...over });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ vault: { id: "v" }, role: "owner", members: [
      { userId: "u1", agents: [agent({ detachedAt: 500 }), agent({ revokedAt: 300, detachedAt: 900 }), agent({})] },
    ] })));
    const detail = await fetchVault("v");
    expect(detail.members[0].agents!.map((a) => a.revokedAt)).toEqual([500, 300, null]);
  });
});
