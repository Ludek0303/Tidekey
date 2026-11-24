// @vitest-environment jsdom
// Group colors: validation, the avatar color of a person, the group dialog and the merge rule.
import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "./bridge";
import { renderInsights, type InsightActions, type InsightState } from "./insights";
import { GROUP_COLORS, personColor, validGroupColor, type Group, type OrganizationSnapshot } from "./taskhistory";

const snapshotWith = (groups: Group[]): OrganizationSnapshot => ({
  me: "demo-jan", owner: "demo-jan", space_id: "t", verified: false, fields: {}, events: [], groups,
  members: [{ user_id: "demo-jan", name: "Jan", role: "Owner" }, { user_id: "demo-anna", name: "Anna", role: "Editor" }],
});

// WCAG relative luminance contrast of white text on a hex background.
function contrastWithWhite(hex: string): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

describe("group color", () => {
  it("accepts only palette names", () => {
    expect(validGroupColor("niebieski")).toBe("niebieski");
    expect(validGroupColor("żółty")).toBe("żółty");
    expect(validGroupColor("#ff0000")).toBeUndefined();
    expect(validGroupColor("constructor")).toBeUndefined();
    expect(validGroupColor(undefined)).toBeUndefined();
    expect(validGroupColor(3)).toBeUndefined();
  });

  it("keeps white initials readable on every palette color", () => {
    for (const { hex } of Object.values(GROUP_COLORS)) expect(contrastWithWhite(hex)).toBeGreaterThanOrEqual(4.5);
  });

  it("gives a person the color of their first active colored group", () => {
    const s = snapshotWith([
      { id: "a", name: "Bez", member_ids: ["demo-anna"] },
      { id: "b", name: "Stara", member_ids: ["demo-anna"], color: "czerwony", archived: true },
      { id: "c", name: "Zespół", member_ids: ["demo-anna"], color: "niebieski" },
      { id: "d", name: "Inny", member_ids: ["demo-anna"], color: "zielony" },
    ]);
    expect(personColor(s, "demo-anna")).toBe("niebieski");
    expect(personColor(s, "demo-jan")).toBeUndefined();
    expect(personColor(snapshotWith([{ id: "x", name: "X", member_ids: ["demo-anna"], color: "bogus" }]), "demo-anna")).toBeUndefined();
  });

  it("takes the color of the group with the lowest order, unordered groups last", () => {
    const s = snapshotWith([
      { id: "a", name: "Późna", member_ids: ["demo-anna"], color: "czerwony", order: 1 },
      { id: "b", name: "Bez", member_ids: ["demo-anna"], color: "zielony" },
      { id: "c", name: "Wczesna", member_ids: ["demo-anna"], color: "niebieski", order: 0 },
    ]);
    expect(personColor(s, "demo-anna")).toBe("niebieski");
  });

  it("moves a group later with the button and saves the new orders", async () => {
    const actions: InsightActions = { refresh: vi.fn(), open: vi.fn(), name: vi.fn(async () => {}), group: vi.fn(async () => {}) };
    const state = { year: 2026, person: "", group: "", project: "", points: false, graph: "", expanded: new Set<string>(), taskState: "", timelineStart: "", timelineRange: "week" } as InsightState;
    const s = snapshotWith([
      { id: "a", name: "Pierwsza", member_ids: [], order: 0 },
      { id: "b", name: "Druga", member_ids: [], order: 1 },
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    renderInsights(host, "people", s, [], [], state, actions);
    const card = [...host.querySelectorAll<HTMLElement>(".group-card")].find((c) => c.querySelector("h4")?.textContent === "Pierwsza")!;
    card.querySelector<HTMLButtonElement>('button[aria-label="Przenieś dalej"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(actions.group).toHaveBeenCalledWith(expect.objectContaining({ id: "b", order: 0 }));
    expect(actions.group).toHaveBeenCalledWith(expect.objectContaining({ id: "a", order: 1, order_at: expect.any(Number) }));
    expect(actions.refresh).toHaveBeenCalled();
  });

  it("renders the avatar in the person's color and the dialog saves the chosen color", () => {
    const actions: InsightActions = { refresh: vi.fn(), open: vi.fn(), name: vi.fn(async () => {}), group: vi.fn(async () => {}) };
    const state = { year: 2026, person: "", group: "", project: "", points: false, graph: "", expanded: new Set<string>(), taskState: "", timelineStart: "", timelineRange: "week" } as InsightState;
    const s = snapshotWith([{ id: "g", name: "Zespół", member_ids: ["demo-anna"], color: "zielony" }]);
    const host = document.createElement("div");
    document.body.append(host);
    renderInsights(host, "people", s, [], [], state, actions);
    const card = [...host.querySelectorAll<HTMLElement>(".person-card")].find((c) => c.querySelector("h4")?.textContent === "Anna")!;
    const avatar = card.querySelector<HTMLElement>(".person-avatar")!;
    expect(avatar.classList.contains("colored")).toBe(true);
    expect(avatar.style.getPropertyValue("--group-color")).toBe(GROUP_COLORS.zielony.hex);

    // Edit: the saved color is preselected; picking another one and saving sends it.
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Edytuj")!.click();
    const dialog = document.querySelector<HTMLElement>(".modal")!;
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Zielony"]')!.checked).toBe(true);
    dialog.querySelector<HTMLInputElement>('input[aria-label="Różowy"]')!.click();
    dialog.querySelector<HTMLFormElement>("form")!.requestSubmit();
    expect(actions.group).toHaveBeenCalledWith(expect.objectContaining({ id: "g", color: "róż" }));
  });

  it("the group dialog search filters members and Enter ticks the only match", () => {
    const actions: InsightActions = { refresh: vi.fn(), open: vi.fn(), name: vi.fn(async () => {}), group: vi.fn(async () => {}) };
    const state = { year: 2026, person: "", group: "", project: "", points: false, graph: "", expanded: new Set<string>(), taskState: "", timelineStart: "", timelineRange: "week" } as InsightState;
    const s = snapshotWith([]);
    s.members.push({ user_id: "demo-zofia", name: "Zofia Łódzka", role: "Editor" });
    const host = document.createElement("div");
    document.body.append(host);
    renderInsights(host, "people", s, [], [], state, actions);
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Nowa grupa"))!.click();
    const dialog = document.querySelector<HTMLElement>(".modal")!;
    const search = dialog.querySelector<HTMLInputElement>('input[aria-label="Szukaj osoby"]')!;
    const visible = () => [...dialog.querySelectorAll<HTMLLabelElement>(".module-participants label")].filter((l) => !l.hidden).map((l) => l.textContent);
    search.value = "anna";
    search.dispatchEvent(new Event("input"));
    expect(visible()).toEqual(["Anna"]);
    // Diacritics-insensitive: "lodz" finds "Łódzka"; Enter with one match ticks it and does not submit the form.
    search.value = "lodz";
    search.dispatchEvent(new Event("input"));
    const submit = vi.fn();
    dialog.querySelector("form")!.addEventListener("submit", submit);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(dialog.querySelectorAll<HTMLInputElement>(".module-participants input:checked")).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("merge keeps the local name and the later color choice", async () => {
    const base = new MockBridge([], false);
    base.setBrowserAccount("user-a", "a@example.test");
    await base.call("organization_group", { group: { id: "g1", name: "Zespół", member_ids: [] } });
    const initial = base.exportBrowserSnapshot("user-a");
    const left = new MockBridge([], false); left.setBrowserAccount("user-a", "a@example.test"); left.mergeBrowserSnapshot(initial);
    const right = new MockBridge([], false); right.setBrowserAccount("user-a", "a@example.test"); right.mergeBrowserSnapshot(initial);
    await right.call("organization_group", { group: { id: "g1", name: "Zdalna", member_ids: [], color: "turkus" } });
    const groupOf = async (b: MockBridge) => (await b.call<OrganizationSnapshot>("organization_snapshot")).groups!.find((g) => g.id === "g1")!;

    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect(await groupOf(left)).toMatchObject({ name: "Zespół", color: "turkus" });

    await left.call("organization_group", { group: { id: "g1", name: "Zespół", member_ids: [], color: "szary" } });
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect((await groupOf(left)).color).toBe("szary");

    // a later change on the other device wins, and so does a later removal
    await new Promise((r) => setTimeout(r, 2));
    right.mergeBrowserSnapshot(left.exportBrowserSnapshot("user-a"));
    await right.call("organization_group", { group: { id: "g1", name: "Zdalna", member_ids: [], color: "róż" } });
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect((await groupOf(left)).color).toBe("róż");
    await new Promise((r) => setTimeout(r, 2));
    await right.call("organization_group", { group: { id: "g1", name: "Zdalna", member_ids: [] } });
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect((await groupOf(left)).color).toBeUndefined();
  });

  it("merge keeps the newer order", async () => {
    const base = new MockBridge([], false);
    base.setBrowserAccount("user-a", "a@example.test");
    await base.call("organization_group", { group: { id: "g1", name: "Zespół", member_ids: [], order: 0, order_at: 1 } });
    const initial = base.exportBrowserSnapshot("user-a");
    const left = new MockBridge([], false); left.setBrowserAccount("user-a", "a@example.test"); left.mergeBrowserSnapshot(initial);
    const right = new MockBridge([], false); right.setBrowserAccount("user-a", "a@example.test"); right.mergeBrowserSnapshot(initial);
    await right.call("organization_group", { group: { id: "g1", name: "Zespół", member_ids: [], order: 2, order_at: 5 } });
    const groupOf = async (b: MockBridge) => (await b.call<OrganizationSnapshot>("organization_snapshot")).groups!.find((g) => g.id === "g1")!;

    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect(await groupOf(left)).toMatchObject({ order: 2, order_at: 5 });

    // a later order set on this device wins over the older one from the other device
    await left.call("organization_group", { group: { id: "g1", name: "Zespół", member_ids: [], order: 7, order_at: 9 } });
    left.mergeBrowserSnapshot(right.exportBrowserSnapshot("user-a"));
    expect(await groupOf(left)).toMatchObject({ order: 7, order_at: 9 });
  });
});
