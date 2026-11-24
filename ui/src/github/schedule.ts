// Checks GitHub links for changes while the app is open: every 5 min with a token, 15 min without one.
// Links are checked one at a time. A rate limit pauses every link, because without a token the limit is per IP.

import { rateLimitStatus } from "./api";
import type { UpdateOutcome } from "./update";

export type { UpdateOutcome } from "./update";

export interface ScheduleDeps {
  links(): Promise<{ id: string }[]>; // active links of the vault (without removed ones)
  run(linkId: string): Promise<UpdateOutcome>; // one update pass
  hasToken(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  visible(): boolean; // document.visibilityState === "visible"
  onChange?(linkId: string, outcome: UpdateOutcome): void;
}

export const EVERY_WITH_TOKEN_MS = 5 * 60_000;
export const EVERY_WITHOUT_TOKEN_MS = 15 * 60_000;
// Waiting a little past the reset, so GitHub has surely opened the window again.
const RESET_MARGIN_MS = 5_000;
const NETWORK_FAILURE = "Nie udało się sprawdzić zmian";

const noop = () => undefined;

export class GithubSchedule {
  private readonly deps: ScheduleDeps;
  private active = false;
  private ticking = false;
  private wake: number | null = null;
  private chain: Promise<void> = Promise.resolve(); // runs checks one after another
  private readonly inflight = new Map<string, Promise<UpdateOutcome>>();
  private readonly nextAt = new Map<string, number>();
  private limitReset: number | null = null; // resetAt of the last rate limit

  constructor(deps: ScheduleDeps) {
    this.deps = deps;
  }

  start(): void {
    this.active = true;
    this.arm(0);
  }

  stop(): void {
    this.active = false;
    this.disarm();
  }

  // Back in the tab: checks the links whose interval has passed.
  onVisible(): void {
    if (this.active) void this.tick();
  }

  // "Sprawdź teraz": skips the interval, but not the rate-limit pause.
  async checkNow(linkId?: string): Promise<UpdateOutcome[]> {
    const ids = linkId !== undefined ? [linkId] : (await this.deps.links()).map((l) => l.id);
    const outcomes: UpdateOutcome[] = [];
    for (const id of ids) outcomes.push(await this.check(id));
    return outcomes;
  }

  private arm(ms: number): void {
    this.disarm();
    this.wake = this.deps.setTimer(() => {
      this.wake = null;
      void this.tick();
    }, ms);
  }

  private disarm(): void {
    if (this.wake !== null) this.deps.clearTimer(this.wake);
    this.wake = null;
  }

  private interval(): number {
    return this.deps.hasToken() ? EVERY_WITH_TOKEN_MS : EVERY_WITHOUT_TOKEN_MS;
  }

  private pausedReset(): number | null {
    if (this.limitReset === null || this.deps.now() >= this.limitReset + RESET_MARGIN_MS) return null;
    return this.limitReset;
  }

  // The earliest moment a link may be checked: its own schedule, never inside a rate-limit pause.
  private dueAt(id: string): number {
    const reset = this.limitReset === null ? 0 : this.limitReset + RESET_MARGIN_MS;
    return Math.max(this.nextAt.get(id) ?? 0, reset);
  }

  private async tick(): Promise<void> {
    if (!this.active || this.ticking) return;
    this.disarm();
    if (!this.deps.visible()) return; // onVisible starts the checks again
    this.ticking = true;
    try {
      const links = await this.deps.links();
      for (const { id } of links) {
        if (!this.active || !this.deps.visible()) return;
        if (this.deps.now() >= this.dueAt(id)) await this.check(id);
      }
      if (!this.active || !this.deps.visible()) return;
      const now = this.deps.now();
      const next = links.length === 0 ? now + this.interval() : Math.min(...links.map(({ id }) => this.dueAt(id)));
      this.arm(Math.max(0, next - now));
    } catch {
      // links() failed: try again at the normal interval
      if (this.active) this.arm(this.interval());
    } finally {
      this.ticking = false;
    }
  }

  // One check per link at a time: a second call while one is running gets the same promise.
  private check(id: string): Promise<UpdateOutcome> {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.serial(() => this.run(id)).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.then(noop, noop);
    return p;
  }

  private async run(id: string): Promise<UpdateOutcome> {
    const paused = this.pausedReset();
    if (paused !== null) return this.notify(id, { kind: "failed", status: rateLimitStatus(paused), resetAt: paused });

    let outcome: UpdateOutcome;
    try {
      outcome = await this.deps.run(id);
    } catch {
      outcome = { kind: "failed", status: NETWORK_FAILURE };
    }
    const now = this.deps.now();
    if (outcome.kind === "failed" && outcome.resetAt !== undefined) {
      this.limitReset = outcome.resetAt;
      this.nextAt.set(id, outcome.resetAt + RESET_MARGIN_MS);
    } else {
      this.nextAt.set(id, now + this.interval());
    }
    return this.notify(id, outcome);
  }

  private notify(id: string, outcome: UpdateOutcome): UpdateOutcome {
    this.deps.onChange?.(id, outcome);
    return outcome;
  }
}
