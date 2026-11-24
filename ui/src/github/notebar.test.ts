// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubFile, GithubLink } from "./link";
import { mountGithubBar } from "./notebar";
import type { GithubService } from "./service";

const NOTE = "0123456789abcdef0123456789abcdef";
const NOTE2 = "fedcba9876543210fedcba9876543210";
const SHA = `abc1234${"0".repeat(33)}`;

type Info = { link: GithubLink; file: GithubFile };

const link = (over: Partial<GithubLink> = {}): GithubLink => ({
  id: "a".repeat(32),
  projectPath: "Projekty/Alfa",
  repo: "owner/repo",
  ref: null,
  repoPath: "",
  target: "GitHub",
  include: ["**/*.md"],
  onDelete: "keep",
  allowEdits: true,
  lastCommit: SHA,
  lastAppliedAt: 1,
  lastAppliedBy: null,
  files: {},
  ignored: [],
  status: "ok",
  rev: 1,
  ...over,
});

const file = (over: Partial<GithubFile> = {}): GithubFile => ({
  path: "docs/instalacja.md",
  blobSha: "b".repeat(40),
  guarded: [],
  ...over,
});

// Only the methods the bar calls matter; the cast keeps the rest out of the fake.
const fake = (over: Partial<GithubService>): GithubService => over as GithubService;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let editor: HTMLElement;
let reading: HTMLElement;

const bar = () => document.querySelector<HTMLElement>(".github-bar")!;
const text = () => bar().querySelector(".github-bar-text")?.textContent ?? "";
const button = (label: string) => [...bar().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

function mount(svc: GithubService | null, opts: { currentText?: () => string; onConflict?: (id: string) => void } = {}) {
  return mountGithubBar(editor, reading, () => svc, { currentText: opts.currentText ?? (() => ""), onConflict: opts.onConflict });
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  editor = document.createElement("div");
  reading = document.createElement("div");
  reading.hidden = true;
  document.body.append(editor, reading);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pasek notatki z GitHuba", () => {
  it("pokazuje skąd notatka pochodzi, sha i link do GitHuba", async () => {
    const svc = fake({ noteInfo: async () => ({ link: link(), file: file() }) });
    const { show } = mount(svc);
    await show(NOTE);
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("Z GitHuba: docs/instalacja.md · abc1234 — Twoje dopiski zostają przy aktualizacjach");
    const link$ = bar().querySelector<HTMLAnchorElement>("a")!;
    expect(link$.textContent).toBe("Otwórz na GitHubie");
    expect(link$.href).toBe(`https://github.com/owner/repo/blob/${SHA}/docs/instalacja.md`);
    expect(button("Moje dopiski")).toBeDefined();
  });

  it("dokleja folder repozytorium do adresu pliku", async () => {
    const svc = fake({ noteInfo: async () => ({ link: link({ ref: "main", repoPath: "docs" }), file: file() }) });
    await mount(svc).show(NOTE);
    expect(bar().querySelector<HTMLAnchorElement>("a")!.href).toBe("https://github.com/owner/repo/blob/main/docs/docs/instalacja.md");
  });

  it("jest ukryty dla zwykłej notatki i bez usługi", async () => {
    const plain = mount(fake({ noteInfo: async () => null }));
    await plain.show(NOTE);
    expect(bar().hidden).toBe(true);
    await mount(null).show(NOTE);
    expect(bar().hidden).toBe(true);
    await mount(fake({ noteInfo: async () => ({ link: link(), file: file() }) })).show(null);
    expect(bar().hidden).toBe(true);
  });

  it("oznacza plik usunięty na GitHubie", async () => {
    const svc = fake({ noteInfo: async () => ({ link: link(), file: file({ deleted: true }) }) });
    await mount(svc).show(NOTE);
    expect(bar().querySelector(".github-bar-deleted")?.textContent).toBe("Usunięty z GitHuba");
  });

  it("pokazuje konflikt i przycisk, który wywołuje onConflict", async () => {
    const svc = fake({ noteInfo: async () => ({ link: link(), file: file({ conflict: { blobSha: "c".repeat(40), commit: SHA } }) }) });
    const seen: string[] = [];
    const { show } = mount(svc, { onConflict: (id) => seen.push(id) });
    await show(NOTE);
    expect(bar().querySelector(".github-bar-conflict")?.textContent).toContain(
      "Konflikt z GitHubem (abc1234): ten plik nie aktualizuje się, dopóki nie wybierzesz wersji.",
    );
    button("Rozwiąż konflikt").click();
    expect(seen).toEqual([NOTE]);
  });

  it("czysta kopia jest tylko do odczytu", async () => {
    const svc = fake({ noteInfo: async () => ({ link: link({ allowEdits: false }), file: file() }) });
    await mount(svc).show(NOTE);
    expect(text()).toBe("Z GitHuba: docs/instalacja.md · abc1234 — czysta kopia tylko do odczytu");
  });

  it("wynik dla poprzedniej notatki nie nadpisuje nowszej", async () => {
    let resolveFirst!: (info: Info) => void;
    const svc = fake({
      noteInfo: (id: string) =>
        id === NOTE
          ? new Promise<Info>((resolve) => { resolveFirst = resolve; })
          : Promise.resolve({ link: link(), file: file({ path: "nowa.md" }) }),
    });
    const { show } = mount(svc);
    const first = show(NOTE);
    await show(NOTE2);
    resolveFirst({ link: link(), file: file({ path: "stara.md" }) });
    await first;
    expect(text()).toContain("nowa.md");
    expect(text()).not.toContain("stara.md");
  });

  it("wskazówka otwiera się raz na notatkę i zapamiętuje to", async () => {
    const svc = fake({ noteInfo: async () => ({ link: link(), file: file() }) });
    const { show } = mount(svc);
    await show(NOTE);
    const tip = bar().querySelector("details")!;
    expect(tip.open).toBe(true);
    expect(tip.textContent).toContain("prawie nigdy nie tworzą konfliktów");
    await show(NOTE);
    expect(bar().querySelector("details")!.open).toBe(false);
  });
});

describe("Moje dopiski", () => {
  async function openMine(base: string | null, current: string): Promise<void> {
    const svc = fake({
      noteInfo: async () => ({ link: link(), file: file() }),
      baseText: async () => base,
    });
    const { show } = mount(svc, { currentText: () => current });
    await show(NOTE);
    button("Moje dopiski").click();
    await tick();
  }

  const dialog = () => document.querySelector<HTMLElement>(".github-mine")!;

  it("pokazuje tylko dopisane i zmienione linie", async () => {
    await openMine("a\nb\nc", "a\nY\nc\nd");
    const lines = [...dialog().querySelectorAll(".github-diff-line")].map((n) => n.textContent);
    const labels = [...dialog().querySelectorAll(".github-diff-label")].map((n) => n.textContent);
    expect(lines).toEqual(["Y", "d"]);
    expect(labels).toEqual(["zmienione względem GitHuba", "dopisane"]);
  });

  it("bez dopisków mówi, że notatka jest taka sama", async () => {
    await openMine("a\nb", "a\nb");
    expect(dialog().textContent).toContain("Nie ma dopisków: notatka jest taka sama jak na GitHubie.");
  });

  it("bez archiwum mówi, że nie ma wersji z GitHuba", async () => {
    await openMine(null, "a");
    expect(dialog().textContent).toContain("Brak wersji z GitHuba w archiwum.");
  });

  it("Zostaw jako własną: pyta, potem odłącza notatkę i pasek znika", async () => {
    let info: Info | null = { link: link(), file: file() };
    const detachNote = vi.fn(async () => {
      info = null;
    });
    const { show } = mount(fake({ noteInfo: async () => info, detachNote }));
    await show(NOTE);
    button("Zostaw jako własną").click();
    await tick();
    const ask = document.querySelector<HTMLElement>(".modal")!;
    expect(ask.textContent).toContain("Ta notatka przestanie się aktualizować z GitHuba i zostanie Twoją zwykłą notatką. Plik na GitHubie się nie zmieni.");
    expect(detachNote).not.toHaveBeenCalled();
    [...ask.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Zostaw jako własną")!.click();
    await tick();
    await tick();
    expect(detachNote).toHaveBeenCalledWith(NOTE);
    expect(bar().hidden).toBe(true);
    expect(document.body.textContent).toContain("Notatka jest teraz Twoja.");
  });

  it("Zostaw jako własną: anulowanie nie odłącza", async () => {
    const detachNote = vi.fn(async () => undefined);
    const { show } = mount(fake({ noteInfo: async () => ({ link: link(), file: file() }), detachNote }));
    await show(NOTE);
    button("Zostaw jako własną").click();
    await tick();
    [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Anuluj")!.click();
    await tick();
    expect(detachNote).not.toHaveBeenCalled();
  });
});
