// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBridge } from "./bridge";
import { backupReminder, describeLastBackup, lastBackup, reminderDue } from "./backup";

const DAY = 86_400_000;
const NOW = new Date("2026-11-04T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const toasts = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "");

beforeEach(() => localStorage.clear());
afterEach(() => { document.body.innerHTML = ""; });

describe("reminderDue", () => {
  it("is due after 7 days for the weekly choice, not before", () => {
    expect(reminderDue(new Date(ago(6)), "week", NOW)).toBe(false);
    expect(reminderDue(new Date(ago(7)), "week", NOW)).toBe(true);
  });

  it("is due after 30 days for the monthly choice, not before", () => {
    expect(reminderDue(new Date(ago(29)), "month", NOW)).toBe(false);
    expect(reminderDue(new Date(ago(30)), "month", NOW)).toBe(true);
  });

  it("is never due when the reminder is off", () => {
    expect(reminderDue(new Date(ago(400)), "off", NOW)).toBe(false);
    expect(reminderDue(null, "off", NOW)).toBe(false);
  });

  it("is due for a space that was never copied", () => {
    expect(reminderDue(null, "week", NOW)).toBe(true);
  });
});

describe("last backup per space", () => {
  it("keeps the day of each space apart and ignores a broken entry", () => {
    localStorage.setItem("notes.lastBackup.v1.A", ago(3));
    localStorage.setItem("notes.lastBackup.v1.B", "to nie jest data");
    expect(lastBackup("A")?.toISOString()).toBe(ago(3));
    expect(lastBackup("B")).toBeNull();
    expect(lastBackup("C")).toBeNull();
  });

  it("describes the last copy in Polish", () => {
    expect(describeLastBackup("A", NOW)).toBe("Nie zrobiono jeszcze kopii.");
    localStorage.setItem("notes.lastBackup.v1.A", ago(3));
    expect(describeLastBackup("A", NOW)).toMatch(/^Ostatnia kopia: .+ \(3 dni temu\)\.$/);
  });
});

describe("backupReminder", () => {
  const bridge = new MockBridge([]);

  it("shows the toast with the Pobierz action when a copy is due", () => {
    backupReminder(bridge, "A", "week", NOW);
    expect(toasts()).toEqual(["Nie masz jeszcze kopii zapasowej notatek. Pobierz"]);
    expect(document.querySelector(".toast-action")?.textContent).toBe("Pobierz");
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    localStorage.setItem("notes.lastBackup.v1.A", ago(8));
    backupReminder(bridge, "A", "week", NOW);
    expect(toasts()).toEqual(["Minął tydzień od ostatniej kopii notatek. Pobierz"]);
  });

  it("stays quiet when the last copy is recent or the reminder is off", () => {
    localStorage.setItem("notes.lastBackup.v1.A", ago(2));
    backupReminder(bridge, "A", "week", NOW);
    backupReminder(bridge, "A", "off", NOW);
    expect(toasts()).toEqual([]);
  });

  it("does nothing without an open space", () => {
    backupReminder(bridge, null, "week", NOW);
    expect(toasts()).toEqual([]);
  });
});
