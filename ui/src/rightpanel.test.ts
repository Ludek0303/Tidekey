// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Bridge } from "./bridge";
import { RightPanel, trailing } from "./rightpanel";

vi.mock("./widgets", async (orig) => ({
  ...(await orig<typeof import("./widgets")>()),
  confirmDialog: vi.fn(async () => true),
}));

const graph = {
  nodes: [
    { id: "a", path: "Plan.md", tags: ["praca", "plan"] },
    { id: "b", path: "Spotkanie.md", tags: ["praca"] },
    { id: "c", path: "Pomysły.md", tags: [] },
  ],
  edges: [
    ["b", "a"],
    ["c", "b"],
  ] as [string, string][],
  ghosts: [],
};

function setup(answers: Record<string, unknown>) {
  const root = document.createElement("div");
  document.body.append(root);
  const call = vi.fn(async (cmd: string) => answers[cmd] ?? []);
  const deps = {
    bridge: { call } as unknown as Bridge,
    graph: () => graph,
    open: vi.fn(),
    jump: vi.fn(),
    search: vi.fn(),
    restored: vi.fn(),
  };
  const panel = new RightPanel(root, deps);
  // the panel's content, as the tests read it
  const tab = (name: string) => root.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)!;
  const body = () => root.querySelector(".rp-body")!;
  return { root, deps, call, panel, tab, body };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RightPanel", () => {
  it("lists the notes that link to the open note", async () => {
    const { panel, body, deps, call } = setup({ search: [] });
    panel.setNote({ id: "a", path: "Plan.md", text: "" });
    await flush();
    expect(body().textContent).toContain("Spotkanie.md");
    expect(body().textContent).not.toContain("Pomysły.md");
    expect(call).toHaveBeenCalledWith("search", { query: "Plan", limit: 30 });
    (body().querySelector("button.rp-item") as HTMLButtonElement).click();
    expect(deps.open).toHaveBeenCalledWith("b", "Spotkanie.md");
  });

  it("shows unlinked mentions from the search", async () => {
    const hits = [{ id: "c", path: "Pomysły.md", snippet: "patrz Plan" }];
    const { panel, body } = setup({ search: hits });
    panel.setNote({ id: "a", path: "Plan.md", text: "" });
    await flush();
    expect(body().textContent).toContain("Wzmianki bez linku");
    expect(body().textContent).toContain("Pomysły.md");
  });

  it("jumps to the line of a heading in the outline", async () => {
    const { panel, tab, body, deps } = setup({});
    panel.setNote({ id: "a", path: "Plan.md", text: "wstęp\n# Cele\ntekst\n## Zakres" });
    tab("outline").click();
    await flush();
    const heads = [...body().querySelectorAll("button")];
    expect(heads.map((b) => b.textContent)).toEqual(["Cele", "Zakres"]);
    heads[1].click();
    expect(deps.jump).toHaveBeenCalledWith(3);
  });

  it("counts the tags of all notes and searches for one", async () => {
    const { panel, tab, body, deps } = setup({});
    panel.setNote({ id: "a", path: "Plan.md", text: "" });
    tab("tags").click();
    await flush();
    expect(body().textContent).toContain("#praca (2)");
    expect(body().textContent).toContain("#plan (1)");
    [...body().querySelectorAll("button")].find((b) => b.textContent === "#praca (2)")!.click();
    expect(deps.search).toHaveBeenCalledWith("praca");
  });

  it("previews a version as a diff and restores it after confirmation", async () => {
    const versions = [{ id: 7, time_ms: 1_700_000_000_000, reason: "automatycznie" }];
    const { panel, tab, body, call, deps } = setup({
      list_versions: versions,
      version_text: "stara\nwspólna",
      restore_version: undefined,
    });
    panel.setNote({ id: "a", path: "Plan.md", text: "nowa\nwspólna" });
    tab("versions").click();
    await flush();
    body().querySelector<HTMLButtonElement>("button.rp-item")!.click();
    await flush();
    expect(body().querySelector(".rp-del")?.textContent).toBe("− stara");
    expect(body().querySelector(".rp-add")?.textContent).toBe("+ nowa");
    [...body().querySelectorAll("button")].find((b) => b.textContent === "Przywróć")!.click();
    await flush();
    await flush();
    expect(call).toHaveBeenCalledWith("restore_version", { id: "a", vid: 7 });
    expect(deps.restored).toHaveBeenCalled();
  });
});

// The tab on screen; `tab` is private to the panel.
const tabOf = (panel: RightPanel): string => (panel as unknown as { tab: string }).tab;

describe("a task in the right panel follows its note", () => {
  it("is dropped when the active note is another note, and kept for the same note", () => {
    const { panel } = setup({});
    const body = () => [document.createElement("p")];
    panel.showTask(async () => body(), "n1");
    expect(tabOf(panel)).toBe("task");
    panel.setNote({ id: "n1", path: "A.md", text: "" });
    expect(tabOf(panel)).toBe("task");
    panel.setNote({ id: "n2", path: "B.md", text: "" });
    expect(tabOf(panel)).toBe("backlinks");
  });

  it("is dropped when the organization views take the screen, and its content leaves the panel", async () => {
    const { panel, body } = setup({});
    panel.showTask(async () => [Object.assign(document.createElement("p"), { textContent: "FORMULARZ-ZADANIA" })], "n1");
    await flush();
    expect(body().textContent).toContain("FORMULARZ-ZADANIA");
    panel.clearTask();
    await flush();
    expect(tabOf(panel)).toBe("backlinks");
    expect(body().textContent).not.toContain("FORMULARZ-ZADANIA");
  });
});

describe("remote updates refresh the panel after the typing pauses", () => {
  it("20 quick updates refresh once, after the pause, and the task is read once", async () => {
    vi.useFakeTimers();
    try {
      const { panel } = setup({});
      const readIndex = vi.fn();
      panel.showTask(async () => {
        readIndex();
        return [document.createElement("p")];
      }, "n1");
      const settle = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      };
      await settle();
      readIndex.mockClear();
      const refresh = trailing(() => panel.setNote({ id: "n1", path: "A.md", text: "" }), 300);
      for (let i = 0; i < 20; i++) refresh();
      vi.advanceTimersByTime(299);
      await settle();
      expect(readIndex).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await settle();
      expect(readIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
