// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserBridge } from "./browserauth";
import * as pairing from "./agentpairing";
import type { AgentRow, PairingCheck, PairingLink, ProposalView, SpaceOption } from "./agentpairing";
import { agentsOffBanner, devicesPane, openPairingAccept } from "./agentsview";

// The logic is replaced; summaryText stays the real one, as the screens show its text.
vi.mock("./agentpairing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentpairing")>()),
  checkPairingLink: vi.fn(),
  spaceOptions: vi.fn(),
  finishPairing: vi.fn(),
  listAgents: vi.fn(),
  listProposals: vi.fn(),
  openProposalCount: vi.fn(async () => 0),
  ownChoices: vi.fn(async () => []),
  confirmAgent: vi.fn(),
  renewAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  disconnectAll: vi.fn(),
  updateScope: vi.fn(),
  decideProposal: vi.fn(),
  agentChanges: vi.fn(),
  undoAgentChanges: vi.fn(),
  startPairing: vi.fn(),
  cancelPairing: vi.fn(),
  pendingPairing: vi.fn(() => null),
}));

const mocked = vi.mocked(pairing);
const LINK: PairingLink = { pairToken: "a".repeat(64), signKey: "s", boxKey: "b", code: "K7QM3XRP" };
const bridge = { vault: { id: "v-1", name: "Klub" }, user: { id: "u1" }, projectsOfChat: () => [], call: vi.fn(async () => "") } as unknown as BrowserBridge;

const option = (over: Partial<SpaceOption> = {}): SpaceOption => ({
  vaultId: "browser-u1", name: "Moje notatki", kind: "notatki", disabledReason: null, maxWriteMode: "direct", maxHours: 24,
  allowProtected: true, projects: [], folders: [], hint: null, ...over,
});

const check = (over: Partial<PairingCheck> = {}): PairingCheck => ({
  ok: true, reason: null, device: { name: "Laptop", os: "Linux" }, mcpVersion: "1.0.0", claimIp: "192.0.2.1", myIp: "192.0.2.1",
  otherNetwork: false, checkCode: "123456", ...over,
});

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
  agentId: "a1", device: { name: "Laptop", os: "Linux" }, mcpVersion: "1.0.0",
  cert: { schema: "notes-agent-cert-v1", agentId: "a1", userId: "u1", signKey: "", boxKey: "", vaults: [{ vaultId: "browser-u1", whole: true, parts: [], writeMode: "none" }], createdAt: 0, expiresAt: Date.now() + 9e9 } as unknown as AgentRow["cert"],
  signature: "", createdAt: 0, sessionExpiresAt: Date.now() + 9e9, lastUsedAt: null, lastIp: null, revokedAt: null, paused: null,
  knownIps: [], fetches: 0, writes: 0, ...over,
});

const proposal = (over: Partial<ProposalView> = {}): ProposalView => ({ proposalId: "p1", agentId: "a1", createdAt: 1, state: "open", body: null, problem: null, stale: [], ...over });

const buttonNamed = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const switches = () => [...document.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
const ownCheck = () => document.querySelector<HTMLInputElement>('input[aria-label="To mój komputer i sam uruchomiłem parowanie"]');

beforeEach(() => {
  vi.clearAllMocks();
  mocked.checkPairingLink.mockResolvedValue(check());
  mocked.spaceOptions.mockResolvedValue([option()]);
  mocked.listAgents.mockResolvedValue([]);
  mocked.listProposals.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pairing acceptance", () => {
  it("keeps Połącz disabled until a space is switched on", async () => {
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(buttonNamed("Połącz")).toBeDefined());
    expect(buttonNamed("Połącz")!.disabled).toBe(true);
    switches()[0].click();
    expect(buttonNamed("Połącz")!.disabled).toBe(false);
  });

  it("does not let a space with a disabled reason be switched on", async () => {
    mocked.spaceOptions.mockResolvedValue([option({ disabledReason: "Właściciel wyłączył czaty." })]);
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(switches()).toHaveLength(1));
    expect(switches()[0].disabled).toBe(true);
    expect(document.body.textContent).toContain("Właściciel wyłączył czaty.");
  });

  it("shows only the reason and no form when the link is refused", async () => {
    mocked.checkPairingLink.mockResolvedValue(check({ ok: false, reason: "Nie rozpocząłeś parowania." }));
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(document.querySelector(".agents-error")?.textContent).toBe("Nie rozpocząłeś parowania."));
    expect(buttonNamed("Połącz")).toBeUndefined();
    expect(switches()).toHaveLength(0);
  });

  it("asks for the own-machine field when the chat comes from another network", async () => {
    mocked.checkPairingLink.mockResolvedValue(check({ otherNetwork: true, claimIp: "198.51.100.7" }));
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(ownCheck()).not.toBeNull());
    switches()[0].click();
    expect(buttonNamed("Połącz")!.disabled).toBe(true);
    ownCheck()!.click();
    expect(buttonNamed("Połącz")!.disabled).toBe(false);
  });

  it("changes the summary with the choices", async () => {
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(switches()).toHaveLength(1));
    const summary = () => document.querySelector(".agents-summary")?.textContent;
    expect(summary()).toBe("Ten czat nic nie widzi.");
    switches()[0].click();
    expect(summary()).toContain("Moje notatki (całe, tylko odczyt)");
  });
});

describe("Urządzenia", () => {
  it("lists a paused chat with its confirm button and the chat's actions", async () => {
    mocked.listAgents.mockResolvedValue([agent({ paused: "ip" })]);
    const pane = document.createElement("div");
    document.body.append(pane);
    await devicesPane(pane, bridge);
    for (const text of ["Potwierdź", "Odłącz", "Zakres", "Przedłuż", "Propozycje Claude", "Cofnij zmiany czatu", "Połącz Claude"]) {
      expect(buttonNamed(text), text).toBeDefined();
    }
    expect(pane.textContent).toContain("Czat wstrzymany: nowy adres IP.");
  });

  it("offers no approve button for a proposal that is broken or forged", async () => {
    mocked.listAgents.mockResolvedValue([agent()]);
    mocked.listProposals.mockResolvedValue([proposal({ problem: "Propozycja jest uszkodzona lub podrobiona." })]);
    const pane = document.createElement("div");
    document.body.append(pane);
    await devicesPane(pane, bridge);
    buttonNamed("Propozycje Claude")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Propozycja jest uszkodzona lub podrobiona."));
    expect(buttonNamed("Zatwierdź")).toBeUndefined();
  });

  it("shows the banner text of the operator's switch", () => {
    expect(agentsOffBanner().textContent).toBe("Czaty Claude są wyłączone przez operatora serwera.");
  });
});

describe("review of the screens", () => {
  const DEFAULTS = ["list_notes", "search", "read_note", "list_tasks", "create_note", "append", "edit_note", "add_tasks", "set_task"];
  const checkNamed = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

  it("tools: no pick saves an empty list (the defaults); a pick saves the defaults plus the pick (the MCP reads a list as all it may use)", async () => {
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(switches()).toHaveLength(1));
    switches()[0].click();
    buttonNamed("Połącz")!.click();
    await vi.waitFor(() => expect(mocked.finishPairing).toHaveBeenCalledTimes(1));
    expect(mocked.finishPairing.mock.calls[0][2][0].tools).toEqual([]);
    document.body.innerHTML = "";
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(switches()).toHaveLength(1));
    switches()[0].click();
    checkNamed("Przenoszenie notatek (move_note)").click();
    buttonNamed("Połącz")!.click();
    await vi.waitFor(() => expect(mocked.finishPairing).toHaveBeenCalledTimes(2));
    expect(mocked.finishPairing.mock.calls[1][2][0].tools).toEqual([...DEFAULTS, "move_note"]);
  });

  it("the scope screen reads such a list back as the pick only, and keeps exclude", async () => {
    mocked.listAgents.mockResolvedValue([agent()]);
    mocked.ownChoices.mockResolvedValue([{ vaultId: "browser-u1", include: [], exclude: ["Tajne"], projects: [], writeMode: "none", tools: [...DEFAULTS, "trash_note"], tasks: "mine" }]);
    const pane = document.createElement("div");
    document.body.append(pane);
    await devicesPane(pane, bridge);
    buttonNamed("Zakres")!.click();
    await vi.waitFor(() => expect(buttonNamed("Zapisz zakres")).toBeDefined());
    expect(checkNamed("Usuwanie do kosza (trash_note)").checked).toBe(true);
    expect(checkNamed("Przenoszenie notatek (move_note)").checked).toBe(false);
    buttonNamed("Zapisz zakres")!.click();
    await vi.waitFor(() => expect(mocked.updateScope).toHaveBeenCalled());
    expect(mocked.updateScope.mock.calls[0][2][0]).toMatchObject({ tools: [...DEFAULTS, "trash_note"], exclude: ["Tajne"] });
  });

  it("the device name and system from the chat go to the page as text, never as HTML", async () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    mocked.checkPairingLink.mockResolvedValue(check({ device: { name: evil, os: `<b>${evil}</b>` } }));
    openPairingAccept(bridge, LINK);
    await vi.waitFor(() => expect(switches()).toHaveLength(1));
    expect(document.querySelector("img, b")).toBeNull();
    expect(document.body.textContent).toContain(evil);
    document.body.innerHTML = "";
    mocked.listAgents.mockResolvedValue([agent({ device: { name: evil, os: evil } })]);
    mocked.listProposals.mockResolvedValue([proposal({ problem: "x" })]);
    const pane = document.createElement("div");
    document.body.append(pane);
    await devicesPane(pane, bridge);
    buttonNamed("Propozycje Claude")!.click();
    await vi.waitFor(() => expect(document.querySelector(".agents-proposal")).not.toBeNull());
    expect(document.querySelector("img, b")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("the device list counts the open proposals without opening any", async () => {
    mocked.openProposalCount.mockResolvedValue(3);
    const pane = document.createElement("div");
    document.body.append(pane);
    await devicesPane(pane, bridge);
    expect(pane.textContent).toContain("Otwarte propozycje: 3");
    expect(mocked.listProposals).not.toHaveBeenCalled();
  });
});

describe("an admin's list of the members' chats", () => {
  it("disconnects a chat from this organization only, and says so", async () => {
    const { chatsSection } = await import("./vaults");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${url}`); return new Response(null, { status: 204 }); }));
    const onChange = vi.fn(async () => undefined);
    const detail = { vault: { id: "v-1" }, role: "owner", wrappedKey: {}, members: [{ userId: "u2", name: "Ewa", role: "editor", agents: [{ agentId: "a".repeat(32), cert: {}, signature: "", revokedAt: null }] }] } as never;
    document.body.append(chatsSection("v-1", detail, onChange));
    buttonNamed("Odłącz od tej organizacji")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Odłączyć czat Claude osoby Ewa od tej organizacji? Czat straci dostęp do jej notatek; inne przestrzenie tej osoby zostają."));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Odłącz od tej organizacji").at(-1)!;
    confirm.click();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(calls).toEqual([`DELETE /api/vaults/v-1/agents/${"a".repeat(32)}`]);
    vi.unstubAllGlobals();
  });
});
