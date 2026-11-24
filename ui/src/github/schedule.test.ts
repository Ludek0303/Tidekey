import { describe, expect, it } from "vitest";
import { EVERY_WITHOUT_TOKEN_MS, EVERY_WITH_TOKEN_MS, GithubSchedule, type ScheduleDeps, type UpdateOutcome } from "./schedule";

const MIN = 60_000;
const UNCHANGED: UpdateOutcome = { kind: "unchanged" };

// Fake clock: advance() fires due timers in order and lets pending promises settle between them.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id: number): void {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      await flush();
      for (;;) {
        let next: number | null = null;
        for (const [id, t] of timers) if (t.at <= target && (next === null || t.at < timers.get(next)!.at)) next = id;
        if (next === null) break;
        const t = timers.get(next)!;
        timers.delete(next);
        now = t.at;
        t.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function setup(over: { ids?: string[]; token?: boolean; run?: ScheduleDeps["run"] } = {}) {
  const c = fakeClock();
  const ids = over.ids ?? ["a"];
  const runs: { id: string; at: number }[] = [];
  const changes: [string, UpdateOutcome][] = [];
  const view = { visible: true };
  const s = new GithubSchedule({
    links: async () => ids.map((id) => ({ id })),
    run: (id) => {
      runs.push({ id, at: c.now() });
      return (over.run ?? (async () => UNCHANGED))(id);
    },
    hasToken: () => over.token ?? true,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    visible: () => view.visible,
    onChange: (id, outcome) => changes.push([id, outcome]),
  });
  return { s, c, runs, changes, view };
}

describe("GithubSchedule", () => {
  it("odstęp: 5 min z tokenem", async () => {
    expect(EVERY_WITH_TOKEN_MS).toBe(5 * MIN);
    const t = setup({ token: true });
    t.s.start();
    await t.c.advance(0);
    await t.c.advance(5 * MIN - 1);
    expect(t.runs.map((r) => r.at)).toEqual([0]);
    await t.c.advance(1);
    expect(t.runs.map((r) => r.at)).toEqual([0, 5 * MIN]);
    t.s.stop();
  });

  it("odstęp: 15 min bez tokenu", async () => {
    expect(EVERY_WITHOUT_TOKEN_MS).toBe(15 * MIN);
    const t = setup({ token: false });
    t.s.start();
    await t.c.advance(0);
    await t.c.advance(15 * MIN - 1);
    expect(t.runs).toHaveLength(1);
    await t.c.advance(1);
    expect(t.runs.map((r) => r.at)).toEqual([0, 15 * MIN]);
    t.s.stop();
  });

  it("start sprawdza od razu, po 0 ms", async () => {
    const t = setup();
    t.s.start();
    expect(t.runs).toHaveLength(0);
    await t.c.advance(0);
    expect(t.runs).toHaveLength(1);
    t.s.stop();
  });

  it("niewidoczna karta nie sprawdza; onVisible sprawdza po minięciu odstępu", async () => {
    const t = setup();
    t.view.visible = false;
    t.s.start();
    await t.c.advance(0);
    await t.c.advance(20 * MIN);
    expect(t.runs).toHaveLength(0);
    t.view.visible = true;
    t.s.onVisible();
    await t.c.advance(0);
    expect(t.runs).toHaveLength(1);
    t.s.stop();
  });

  it("onVisible nie sprawdza, gdy odstęp jeszcze nie minął", async () => {
    const t = setup();
    t.s.start();
    await t.c.advance(0);
    t.view.visible = false;
    await t.c.advance(MIN);
    t.view.visible = true;
    t.s.onVisible();
    await t.c.advance(0);
    expect(t.runs).toHaveLength(1);
    t.s.stop();
  });

  it("rateLimited wstrzymuje wszystkie połączenia do resetAt + 5 s, checkNow nie pyta GitHuba", async () => {
    let limited = true;
    const t = setup({
      ids: ["a", "b"],
      run: async (id) => {
        if (limited && id === "a") {
          limited = false;
          return { kind: "failed", status: "limit", resetAt: t.c.now() + MIN };
        }
        return UNCHANGED;
      },
    });
    t.s.start();
    await t.c.advance(0);
    expect(t.runs.map((r) => r.id)).toEqual(["a"]);

    await t.c.advance(30_000);
    const manual = await t.s.checkNow();
    expect(t.runs).toHaveLength(1);
    expect(manual).toEqual([
      { kind: "failed", status: expect.stringContaining("Limit GitHuba"), resetAt: MIN },
      { kind: "failed", status: expect.stringContaining("Limit GitHuba"), resetAt: MIN },
    ]);

    await t.c.advance(MIN + 5_000 - 1 - 30_000);
    expect(t.runs).toHaveLength(1);
    await t.c.advance(1);
    expect(t.runs.slice(1)).toEqual([
      { id: "a", at: MIN + 5_000 },
      { id: "b", at: MIN + 5_000 },
    ]);
    t.s.stop();
  });

  it("brak pętli: najwyżej jedno sprawdzenie na odstęp", async () => {
    const t = setup();
    t.s.start();
    await t.c.advance(60 * MIN);
    expect(t.runs.map((r) => r.at)).toEqual(Array.from({ length: 13 }, (_, i) => i * 5 * MIN));
    t.s.stop();
  });

  it("failed bez resetAt wraca po zwykłym odstępie", async () => {
    let first = true;
    const t = setup({
      run: async () => {
        if (first) {
          first = false;
          return { kind: "failed", status: "sieć" };
        }
        return UNCHANGED;
      },
    });
    t.s.start();
    await t.c.advance(5 * MIN - 1);
    expect(t.runs.map((r) => r.at)).toEqual([0]);
    await t.c.advance(1);
    expect(t.runs.map((r) => r.at)).toEqual([0, 5 * MIN]);
    t.s.stop();
  });

  it("połączenia sprawdzane po kolei, nie równolegle", async () => {
    let release!: (o: UpdateOutcome) => void;
    const gate = new Promise<UpdateOutcome>((r) => (release = r));
    const t = setup({ ids: ["a", "b"], run: (id) => (id === "a" ? gate : Promise.resolve(UNCHANGED)) });
    t.s.start();
    await t.c.advance(0);
    expect(t.runs.map((r) => r.id)).toEqual(["a"]);
    release(UNCHANGED);
    await t.c.advance(0);
    expect(t.runs.map((r) => r.id)).toEqual(["a", "b"]);
    t.s.stop();
  });

  it("równoległe checkNow dla jednego połączenia to jedno run", async () => {
    let release!: (o: UpdateOutcome) => void;
    const gate = new Promise<UpdateOutcome>((r) => (release = r));
    const t = setup({ run: () => gate });
    const p1 = t.s.checkNow("a");
    const p2 = t.s.checkNow("a");
    await t.c.advance(0);
    release(UNCHANGED);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(t.runs).toHaveLength(1);
    expect(r1).toEqual([UNCHANGED]);
    expect(r2).toEqual([UNCHANGED]);
  });

  it("wyjątek w run nie zatrzymuje kolejnych połączeń ani kolejnych sprawdzeń", async () => {
    const t = setup({
      ids: ["a", "b"],
      run: async (id) => {
        if (id === "a") throw new Error("boom");
        return UNCHANGED;
      },
    });
    t.s.start();
    await t.c.advance(0);
    await t.c.advance(5 * MIN);
    expect(t.runs.map((r) => r.id)).toEqual(["a", "b", "a", "b"]);
    expect(t.changes[0]).toEqual(["a", { kind: "failed", status: expect.any(String) }]);
    t.s.stop();
  });

  it("stop czyści timery: po nim nie ma żadnych run", async () => {
    const t = setup();
    t.s.start();
    await t.c.advance(0);
    t.s.stop();
    await t.c.advance(60 * MIN);
    expect(t.runs).toHaveLength(1);
    expect(t.c.pending()).toBe(0);
  });

  it("onChange dostaje wynik sprawdzenia", async () => {
    const applied: UpdateOutcome = { kind: "applied", commit: "abc1234", changed: 2, conflicts: 0, skipped: 1 };
    const t = setup({ run: async () => applied });
    const out = await t.s.checkNow("a");
    expect(out).toEqual([applied]);
    expect(t.changes).toEqual([["a", applied]]);
  });
});
