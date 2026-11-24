// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Bridge, TreeItem } from "../bridge";
import { loadWasm } from "../testwasm";
import { createMeeting, saveMeeting, setMeetingSource } from "./meeting";
import { CALENDAR_TEXT, type CalendarDeps } from "./open";
import { parseCalendar } from "./model";
import { dayOf } from "./dates";
import type { EventInput } from "./edit";

beforeAll(loadWasm);
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

// A bridge over one calendar note: `open_note` gives its state, `apply_update` merges a change into it.
function setup() {
  const calendar = new Y.Doc();
  calendar.getText("content").insert(0, CALENDAR_TEXT);
  const bridge = {
    call: vi.fn(async (cmd: string, args?: { update?: Uint8Array }) => {
      if (cmd === "open_note") return Y.encodeStateAsUpdate(calendar);
      if (cmd === "apply_update") return Y.applyUpdate(calendar, args!.update!);
      throw new Error(`unexpected ${cmd}`);
    }),
  };
  const items: TreeItem[] = [
    { id: "cal", path: "Kalendarz.md" },
    { id: "plan", path: "Plan.md" },
  ];
  const deps: CalendarDeps = {
    bridge: bridge as unknown as Bridge,
    items: () => items,
    isCalendar: (id) => id === "cal",
    create: async (path) => ({ id: "new", path }),
    open: async () => undefined,
  };
  setMeetingSource({ deps, path: () => "Plan.md", openDoc: () => null });
  const view = new EditorView({
    state: EditorState.create({ doc: "Treść\n", selection: { anchor: 6 } }),
    parent: document.body,
  });
  return { view, calendarText: () => calendar.getText("content").toString() };
}

const meeting: EventInput = {
  title: "Plan",
  startDay: dayOf(2026, 11, 5),
  startMin: 14 * 60,
  endDay: dayOf(2026, 11, 5),
  endMin: 15 * 60,
  rule: null,
  color: null,
  description: "[[Plan]]",
};

describe("a meeting from a note", () => {
  it("adds one event that links back to the note, and a line that links to the calendar", async () => {
    const { view, calendarText } = setup();
    await saveMeeting(view, meeting);

    const lines = calendarText().split("\n");
    expect(lines[3]).toMatch(/^- 2026-11-05 14:00 Plan \^e[0-9a-z]{5}$/);
    expect(lines[4]).toBe("    [[Plan]]");
    expect(parseCalendar(calendarText()).events).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("Treść\n- 📅 [[Kalendarz]] Spotkanie: Plan, 2026-11-05 14:00");
  });

  it("opens the form prefilled with the note, and saves it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 5, 10, 20));
    const { view, calendarText } = setup();
    createMeeting(view);

    const form = document.querySelector<HTMLFormElement>("form.cal-form")!;
    const field = (label: string) => form.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    expect(field("Tytuł").value).toBe("Plan");
    expect(field("Powiązana notatka").value).toBe("Plan");
    expect(field("Data początku").value).toBe("2026-11-05");
    expect(field("Godzina początku").value).toBe("11:00");

    form.requestSubmit();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("[[Kalendarz]]"));
    expect(calendarText().split("\n")[3]).toMatch(/^- 2026-11-05 11:00 Plan 🔔 15 \^e[0-9a-z]{5}$/);
  });
});
