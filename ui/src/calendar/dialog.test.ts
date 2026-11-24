// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { openEventForm } from "./dialog";
import type { EventInput } from "./edit";
import { dayOf } from "./dates";

const DAY = dayOf(2026, 10, 22);
const base: EventInput = { title: "", startDay: DAY, startMin: 600, endDay: DAY, endMin: 660, rule: null, color: null, description: "" };

// Opens the form and returns its reminder select and the input saved by "Zapisz".
function open(init: EventInput, editing = false) {
  document.body.replaceChildren();
  const onSave = vi.fn();
  openEventForm({ title: "Test", init, editing, onSave, onDelete: () => undefined });
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Przypomnienie"]')!;
  const save = (): EventInput => {
    document.querySelector<HTMLFormElement>("form.cal-form")!.requestSubmit();
    return onSave.mock.calls[0][0] as EventInput;
  };
  return { select, save };
}

describe("event form reminder", () => {
  it("defaults a new timed event to 15 minutes before and a new all-day event to none", () => {
    expect(open(base).select.value).toBe("15");
    expect(open({ ...base, startMin: null, endMin: null }).select.value).toBe("0");
  });

  it("shows and saves an existing reminder, including one that is not a choice", () => {
    expect(open({ ...base, reminder: 30 }, true).select.value).toBe("30");
    const { select, save } = open({ ...base, reminder: 1440 }, true);
    expect(select.value).toBe("1440");
    expect(save().reminder).toBe(1440);
  });

  it("saves no reminder as null", () => {
    const { select, save } = open({ ...base, reminder: 5 }, true);
    select.value = "0";
    select.dispatchEvent(new Event("change"));
    expect(save().reminder).toBeNull();
  });
});
