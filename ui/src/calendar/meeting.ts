// "Utwórz spotkanie z tej notatki": an event in the calendar note that links back to this note, and a
// line in this note that links to the calendar. Opened from the palette and the "/" menu.
import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import { CALENDAR_ORIGIN } from "../editor";
import { editNote } from "../orgedit";
import { errorText, toast } from "../widgets";
import { hhmm, isoDay, MINUTES, nextFullHour } from "./dates";
import { addEvent, applyChanges, type EventInput } from "./edit";
import { openEventForm } from "./dialog";
import { cleanNoteName } from "./model";
import { createCalendar, findCalendar, type CalendarDeps } from "./open";

interface MeetingSource {
  deps: CalendarDeps;
  /** The path of the open note, or `null` without one. */
  path: () => string | null;
  /** The document of a note open in a tab (its edits go through it), or `null`. */
  openDoc: (id: string) => Y.Doc | null;
}
let source: MeetingSource | null = null;

/** main.ts calls it once: the calendar's dependencies and the open note. */
export function setMeetingSource(src: MeetingSource): void {
  source = src;
}

const noteName = (path: string): string => path.split("/").pop()!.replace(/\.md$/, "");

/** Opens the event form for a meeting from the open note: the next full hour today, one hour long. */
export function createMeeting(view: EditorView): void {
  const path = source?.path();
  if (!source || !path) return toast("Otwórz notatkę.", true);
  const name = cleanNoteName(noteName(path));
  const { day: startDay, startMin } = nextFullHour(new Date());
  const endAbs = startDay * MINUTES + startMin + 60;
  const init: EventInput = {
    title: name,
    startDay,
    startMin,
    endDay: Math.floor(endAbs / MINUTES),
    endMin: endAbs % MINUTES,
    rule: null,
    color: null,
    description: `[[${name}]]`,
  };
  openEventForm({
    title: "Nowe spotkanie",
    init,
    editing: false,
    onSave: (input) => void saveMeeting(view, input).catch((err: unknown) => toast(errorText(err), true)),
    onDelete: () => undefined,
  });
}

/** Writes the event to the calendar note (the first one, or a new one), then the link line at the cursor. */
export async function saveMeeting(view: EditorView, input: EventInput): Promise<void> {
  const src = source!;
  const found = findCalendar(src.deps.items(), src.deps.isCalendar);
  // An organization's calendar is its module page: no calendar note is made for a meeting there.
  if (!found && src.deps.single?.()) throw new Error("W organizacji wydarzenia są w module Kalendarze.");
  const cal = found ?? (await createCalendar(src.deps));
  await addToCalendar(src, cal.id, input);
  const when = input.startMin === null ? isoDay(input.startDay) : `${isoDay(input.startDay)} ${hhmm(input.startMin)}`;
  insertLine(view, `- 📅 [[${noteName(cal.path)}]] Spotkanie: ${input.title}, ${when}`);
}

/** Adds the event in the note's open document, or loaded and saved through the bridge (as orgedit does). */
async function addToCalendar(src: MeetingSource, id: string, input: EventInput): Promise<void> {
  let text = "";
  await editNote({ bridge: src.deps.bridge, openDoc: src.openDoc }, id, (old) => (text = applyChanges(old, addEvent(old, input))), CALENDAR_ORIGIN);
  src.deps.written?.(id, text);
}

/** The text as a line of its own at the cursor: on the cursor's line when that is empty, else below it. */
function insertLine(view: EditorView, text: string): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (line.text.trim() === "") {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + text.length } });
  } else {
    view.dispatch({ changes: { from: line.to, insert: `\n${text}` }, selection: { anchor: line.to + 1 + text.length } });
  }
}
