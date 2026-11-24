// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserUser } from "./browserauth";
import { importVaultKey, randomVaultKey, wrapBytes, unwrapBytes } from "./vaults";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const aesKey = () => importVaultKey(randomVaultKey());
const patches = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH").map(([, init]) => JSON.parse((init as RequestInit).body as string));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });

describe("account preferences", () => {
  it("uploads this device's synced settings sealed when the account has none, and never in plaintext", async () => {
    vi.resetModules();
    localStorage.setItem("notes.settings.v1", JSON.stringify({ theme: "light", accent: "custom", customAccent: "#12a4b6", autoLoadImages: false }));
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { syncPreferences } = await import("./preferences");
    const personal = await aesKey();
    const user = { id: "u", email: "a@example.test", name: "A" } as BrowserUser;
    await syncPreferences(user, personal);
    const [body] = patches(fetchMock);
    expect(Object.keys(body)).toEqual(["preferences"]);
    expect(JSON.stringify(body)).not.toContain("12a4b6");
    expect(user.preferences).toEqual(body.preferences);
    const plain = JSON.parse(new TextDecoder().decode(await unwrapBytes(body.preferences, personal)));
    expect(plain).toMatchObject({ theme: "light", accent: "custom", customAccent: "#12a4b6" });
    expect(plain).not.toHaveProperty("autoLoadImages");
  });

  it("applies the account copy over the local settings, and a change is saved after a pause", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    localStorage.setItem("notes.settings.v1", JSON.stringify({ theme: "dark", fontSize: 13 }));
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { syncPreferences } = await import("./preferences");
    const settings = await import("./settings");
    const personal = await aesKey();
    const remote = await wrapBytes(new TextEncoder().encode(JSON.stringify({ theme: "light", fontSize: 16, accent: "custom", customAccent: "#12a4b6" })), personal);
    await syncPreferences({ id: "u", email: "a@example.test", name: "A", preferences: remote } as BrowserUser, personal);
    expect(settings.getSetting("theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--accent-solid")).toBe("#12a4b6");
    expect(patches(fetchMock)).toEqual([]); // applying the account copy is not a change to save

    settings.setSetting("fontSize", 18);
    expect(patches(fetchMock)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    // the save encrypts first (real WebCrypto), so the PATCH lands a little after the timer
    await vi.waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    const [body] = patches(fetchMock);
    expect(JSON.parse(new TextDecoder().decode(await unwrapBytes(body.preferences, personal)))).toMatchObject({ theme: "light", fontSize: 18 });
  });

  it("keeps the local settings when the account copy cannot be opened, and does not overwrite it", async () => {
    vi.resetModules();
    localStorage.setItem("notes.settings.v1", JSON.stringify({ fontSize: 15 }));
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { syncPreferences } = await import("./preferences");
    const settings = await import("./settings");
    const stranger = await wrapBytes(new TextEncoder().encode("{}"), await aesKey());
    await syncPreferences({ id: "u", email: "a@example.test", name: "A", preferences: stranger } as BrowserUser, await aesKey());
    expect(settings.getSetting("fontSize")).toBe(15);
    expect(patches(fetchMock)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("15");
  });

  it("keeps the GitHub token in the sealed account copy only, apart from the settings", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => json({ user: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const { syncPreferences, githubToken, setGithubToken } = await import("./preferences");
    const settings = await import("./settings");
    const personal = await aesKey();
    const token = "github_pat_SEKRET-42";
    const remote = await wrapBytes(new TextEncoder().encode(JSON.stringify({ theme: "light", githubToken: token })), personal);
    await syncPreferences({ id: "u", email: "a@example.test", name: "A", preferences: remote } as BrowserUser, personal);
    expect(githubToken()).toBe(token);
    expect(JSON.stringify(settings.syncedSettings())).not.toContain(token);
    expect(localStorage.getItem("notes.settings.v1") ?? "").not.toContain(token);

    await setGithubToken(null);
    const [body] = patches(fetchMock);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.parse(new TextDecoder().decode(await unwrapBytes(body.preferences, personal)))).not.toHaveProperty("githubToken");
    await setGithubToken("github_pat_NOWY");
    const sealed = patches(fetchMock)[1];
    expect(JSON.stringify(sealed)).not.toContain("NOWY");
    expect(JSON.parse(new TextDecoder().decode(await unwrapBytes(sealed.preferences, personal))).githubToken).toBe("github_pat_NOWY");
  });
});
