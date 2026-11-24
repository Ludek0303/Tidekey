// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FirstRunApi, runFirstRun, splitWords } from "./firstrun";
import type { SpaceItem } from "./spaces";

const WORDS = Array.from({ length: 24 }, (_, i) => `slowo${i + 1}`);

function api(over: Partial<FirstRunApi> = {}): FirstRunApi {
  return {
    status: vi.fn(async () => "none" as const),
    spaces: vi.fn(async (): Promise<SpaceItem[]> => []),
    openKnown: vi.fn(async () => "open" as const),
    forget: vi.fn(async () => undefined),
    pickFolder: vi.fn(async () => "/home/uzytkownik/Notatki"),
    create: vi.fn(async () => WORDS),
    setKind: vi.fn(async () => undefined),
    open: vi.fn(async () => null),
    recover: vi.fn(async () => undefined),
    confirm: vi.fn(async () => undefined),
    ...over,
  };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("splitWords", () => {
  it("accepts any case and spacing", () => {
    expect(splitWords("  Ala\tMa\n kota ")).toEqual(["ala", "ma", "kota"]);
    expect(splitWords("   ")).toEqual([]);
  });
});

describe("runFirstRun", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.replaceChildren(root);
  });

  it("resolves at once and shows nothing when a space is open", async () => {
    await runFirstRun(root, api({ status: async () => "open" }));
    expect(root.childElementCount).toBe(0);
  });

  it("creates a space, and continues only after the phrase is confirmed", async () => {
    const a = api();
    let resolved = false;
    const run = runFirstRun(root, a).then(() => (resolved = true));
    await flush();
    button(root, "Utwórz przestrzeń").click();
    await newSpaceForm(root, "Projekt Triton", "/home/uzytkownik/Notatki");

    expect(a.create).toHaveBeenCalledWith("/home/uzytkownik/Notatki", "Projekt Triton");
    expect(root.querySelectorAll(".firstrun-words li")).toHaveLength(24);
    const next = button(root, "Dalej");
    expect(next.disabled).toBe(true);
    const check = root.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    expect(next.disabled).toBe(false);
    next.click();
    await run;
    expect(a.confirm).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(true);
    expect(root.childElementCount).toBe(0);
  });

  it("passes the chosen type to the backend right after the space is created", async () => {
    const a = api();
    void runFirstRun(root, a);
    await flush();
    button(root, "Utwórz przestrzeń").click();
    await newSpaceForm(root, "Triton", "/home/uzytkownik/Notatki", "organizacja");
    await flush();
    expect(a.create).toHaveBeenCalledWith("/home/uzytkownik/Notatki", "Triton");
    expect(a.setKind).toHaveBeenCalledWith("organizacja");
    expect(root.querySelectorAll(".firstrun-words li")).toHaveLength(24);
  });

  it("keeps a notes space as notes and shows a failed type change next to the phrase", async () => {
    const plain = api();
    void runFirstRun(root, plain);
    await flush();
    button(root, "Utwórz przestrzeń").click();
    await newSpaceForm(root, "Plan", "/home/uzytkownik/Notatki");
    expect(plain.setKind).not.toHaveBeenCalled();

    document.body.replaceChildren((root = document.createElement("div")));
    const failing = api({ setKind: vi.fn(async () => Promise.reject(new Error("Nie udało się zmienić typu."))) });
    void runFirstRun(root, failing);
    await flush();
    button(root, "Utwórz przestrzeń").click();
    await newSpaceForm(root, "Plan", "/home/uzytkownik/Notatki", "organizacja");
    expect(root.querySelector("[role=alert]")!.textContent).toBe("Nie udało się zmienić typu.");
    expect(root.querySelectorAll(".firstrun-words li")).toHaveLength(24);
  });

  it("offers the phrase at once when opening a folder says the device needs it", async () => {
    const a = api({
      open: vi.fn(async () => Promise.reject(Object.assign(new Error("Ta przestrzeń wymaga frazy odzyskiwania na tym komputerze."), { kind: "needs_phrase" }))),
    });
    void runFirstRun(root, a);
    await flush();
    button(root, "Otwórz folder").click();
    await flush();
    await flush();
    expect(root.querySelector("textarea")).not.toBeNull();
    expect(root.querySelector("[role=alert]")!.textContent).toContain("frazy odzyskiwania");
    expect(root.querySelectorAll("p.muted")[1].textContent).toBe("/home/uzytkownik/Notatki");
    expect(a.confirm).not.toHaveBeenCalled();
  });

  it("shows the backend's error in the alert region and stays on the form", async () => {
    const a = api({ recover: vi.fn(async () => Promise.reject(new Error("Fraza odzyskiwania jest nieprawidłowa."))) });
    void runFirstRun(root, a, );
    await flush();
    button(root, "Odzyskaj frazą").click();
    root.querySelector("textarea")!.value = WORDS.join(" ");
    button(root, "Wybierz folder").click();
    await flush();
    button(root, "Odzyskaj").click();
    await flush();
    expect(root.querySelector("[role=alert]")!.textContent).toBe("Fraza odzyskiwania jest nieprawidłowa.");
    expect(a.recover).toHaveBeenCalledWith("/home/uzytkownik/Notatki", WORDS.join(" "));
  });

  it("asks for the phrase at once when the remembered space needs it", async () => {
    void runFirstRun(root, api({ status: async () => "needs_phrase" }));
    await flush();
    expect(root.querySelector("textarea")).not.toBeNull();
    expect([...root.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Wstecz");
  });
});

describe("the space manager", () => {
  let root: HTMLElement;
  const spaces: SpaceItem[] = [
    { path: "/home/uzytkownik/Triton", name: "Triton", kind: "organizacja", current: false, exists: true },
    { path: "/home/uzytkownik/Plan", name: "Plan", kind: "notatki", current: false, exists: true },
    { path: "/home/uzytkownik/Stara", name: "Stara", kind: "notatki", current: false, exists: false },
  ];
  beforeEach(() => {
    root = document.createElement("div");
    document.body.replaceChildren(root);
  });

  const rows = () => [...root.querySelectorAll<HTMLElement>(".space-row")];

  it("shows no list and no heading before the first space exists", async () => {
    void runFirstRun(root, api());
    await flush();
    expect(root.querySelector<HTMLElement>(".firstrun-spaces")!.hidden).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it("lists the spaces with their type, the last opened first, and a missing folder marked", async () => {
    void runFirstRun(root, api({ spaces: async () => spaces }));
    await flush();
    expect(root.querySelector("h2")!.textContent).toBe("Twoje przestrzenie");
    expect(rows()).toHaveLength(3);
    expect(rows()[0].querySelector(".space-badge")!.textContent).toBe("Organizacja");
    expect(rows()[1].querySelector(".space-badge")!.textContent).toBe("Notatki");
    expect(rows()[0].textContent).toContain("ostatnio otwarta");
    expect(rows()[1].textContent).not.toContain("ostatnio otwarta");
    expect(rows()[2].textContent).toContain("folder nie istnieje");
    expect((rows()[2].querySelector(".space-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a space on click, and the screen ends once it is open", async () => {
    const a = api({ spaces: async () => spaces });
    let resolved = false;
    const run = runFirstRun(root, a).then(() => (resolved = true));
    await flush();
    rows()[1].querySelector<HTMLButtonElement>(".space-open")!.click();
    await run;
    expect(a.openKnown).toHaveBeenCalledWith("/home/uzytkownik/Plan");
    expect(resolved).toBe(true);
  });

  it("asks for the phrase with the path filled in when this device has no keys", async () => {
    const a = api({ spaces: async () => spaces, openKnown: vi.fn(async () => "needs_phrase" as const) });
    void runFirstRun(root, a);
    await flush();
    rows()[0].querySelector<HTMLButtonElement>(".space-open")!.click();
    await flush();
    expect(root.querySelector("textarea")).not.toBeNull();
    expect(root.querySelectorAll("p.muted")[1].textContent).toBe("/home/uzytkownik/Triton");
  });

  it("removes a row from the list and shows the list again without it", async () => {
    let listed = [...spaces];
    const a = api({
      spaces: async () => listed,
      forget: vi.fn(async (path: string) => {
        listed = listed.filter((s) => s.path !== path);
      }),
    });
    void runFirstRun(root, a);
    await flush();
    const forget = rows()[1].querySelector<HTMLButtonElement>(".space-forget")!;
    forget.click();
    await flush();
    await flush();
    expect(a.forget).toHaveBeenCalledWith("/home/uzytkownik/Plan");
    expect(rows().map((r) => r.querySelector("strong")!.textContent)).toEqual(["Triton", "Stara"]);
  });

  it("shows the backend's refusal in the alert and keeps the list", async () => {
    const a = api({
      spaces: async () => spaces,
      openKnown: vi.fn(async () => Promise.reject(new Error("Tej przestrzeni nie ma na liście przestrzeni."))),
    });
    void runFirstRun(root, a);
    await flush();
    rows()[1].querySelector<HTMLButtonElement>(".space-open")!.click();
    await flush();
    expect(root.querySelector("[role=alert]")!.textContent).toBe("Tej przestrzeni nie ma na liście przestrzeni.");
    expect(rows()).toHaveLength(3);
  });
});

// Fills the form of a new space and presses Utwórz. The folder is chosen with the form's button.
async function newSpaceForm(root: HTMLElement, name: string, folder: string, kind: "notatki" | "organizacja" = "notatki") {
  root.querySelector<HTMLInputElement>("input[type=text]")!.value = name;
  root.querySelector<HTMLInputElement>(`input[type=radio][value=${kind}]`)!.checked = true;
  button(root, "Wybierz folder").click();
  await flush();
  expect(root.textContent).toContain(folder);
  button(root, "Utwórz").click();
  await flush();
  await flush();
}

describe("runFirstRun when the remembered folder cannot be checked", () => {
  it("shows the choices with the backend's message, not a blank window", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const a = api({ status: vi.fn(() => Promise.reject(new Error("Kopia przestrzeni jest starsza niż znany dziennik uczestników."))) });
    void runFirstRun(root, a);
    await flush();
    expect(root.querySelector("[role=alert]")!.textContent).toBe("Kopia przestrzeni jest starsza niż znany dziennik uczestników.");
    const labels = [...root.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Otwórz folder");
    expect(labels).toContain("Odzyskaj frazą");
  });
});

describe("the space list's remove buttons", () => {
  it("name their row, since the rows share the button text", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    void runFirstRun(root, api({ spaces: async () => [
      { path: "/a", name: "Triton", kind: "organizacja", current: false, exists: true },
      { path: "/b", name: "Plan", kind: "notatki", current: false, exists: true },
    ] }));
    await flush();
    const labels = [...root.querySelectorAll<HTMLButtonElement>(".space-forget")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Usuń z listy: Triton", "Usuń z listy: Plan"]);
  });
});
