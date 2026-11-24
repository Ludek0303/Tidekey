import { Compartment, EditorSelection, EditorState, RangeSetBuilder, Text, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import * as Y from "yjs";
import { liveTaskExtensions, taskExtensions } from "./taskchips";
import { tableCheckGuard } from "./tablechecks";
import { cursorAfterFrontMatter } from "./frontmatter";
import { yCollab, yUndoManagerKeymap, ySyncAnnotation, ySyncFacet } from "y-codemirror.next";
import type { Bridge } from "./bridge";
import { tableExtension } from "./table";
import { formattingKeymap } from "./toolbar";
import { slashCommands } from "./slash";
import { linkHandler, linkPaste, livePreview } from "./livepreview";
import { excelPaste } from "./excelpaste";
import { headingRail } from "./headingrail";
import { attachmentHandlers, embedImages } from "./attachments";
import { toast } from "./widgets";
import { emit } from "./bus";
import { getSetting, onSettingChanged } from "./settings";
import { dictationGhost } from "./voice/ghost";

export type SaveStatus = "saving" | "saved" | "error";
export const SAVE_TEXT: Record<SaveStatus, string> = {
  saving: "Zapisywanie…",
  saved: "Zapisano lokalnie",
  error: "Błąd zapisu",
};

const RETRY_MS = 5000;

// Sends every local Yjs update to the core. Updates that fail are kept per note and
// resent (merged) with the next update or by retry(), so no edit is dropped.
export class Saver {
  private inFlight = 0;
  private failed = new Map<string, Uint8Array[]>();
  // Deleted notes: nothing more is sent for them, and a late failure is not retried.
  private dropped = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // flushAll callers waiting for the queue to empty; each gets whether everything reached the backend.
  private idle: ((saved: boolean) => void)[] = [];

  constructor(
    private readonly bridge: Bridge,
    private readonly onStatus: (status: SaveStatus) => void,
  ) {}

  get hasUnsaved(): boolean {
    return this.inFlight > 0 || this.failed.size > 0;
  }

  // Drops the pending updates of a note that was deleted.
  forget(id: string): void {
    this.dropped.add(id);
    this.failed.delete(id);
    this.settle();
  }

  send(id: string, update: Uint8Array): void {
    this.post(id, update);
  }

  retry(): void {
    for (const id of [...this.failed.keys()]) this.post(id, null);
  }

  // Sends what is waiting again and resolves once the queue is empty: true when every update reached the backend,
  // false when one still fails.
  flushAll(): Promise<boolean> {
    this.retry();
    if (this.inFlight === 0) return Promise.resolve(this.failed.size === 0);
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private post(id: string, fresh: Uint8Array | null): void {
    if (this.dropped.has(id)) return;
    const prior = this.failed.get(id) ?? [];
    const batch = fresh ? [...prior, fresh] : prior;
    if (batch.length === 0) return;
    const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    this.inFlight++;
    this.report();
    this.bridge.call("apply_update", { id, update }).then(
      () => {
        this.inFlight--;
        const rest = (this.failed.get(id) ?? []).filter((u) => !batch.includes(u));
        if (rest.length > 0) this.failed.set(id, rest);
        else this.failed.delete(id);
        this.settle();
      },
      (err: unknown) => {
        this.inFlight--;
        console.error("apply_update failed", err);
        if (!this.dropped.has(id)) {
          const cur = this.failed.get(id) ?? [];
          this.failed.set(id, [...cur, ...batch.filter((u) => !cur.includes(u))]);
        }
        this.settle();
      },
    );
  }

  private settle(): void {
    if (this.inFlight === 0) {
      const waiting = this.idle.splice(0);
      waiting.forEach((resolve) => resolve(this.failed.size === 0));
    }
    if (this.failed.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.failed.size > 0 && this.timer === null) {
      this.timer = setInterval(() => this.retry(), RETRY_MS);
    }
    this.report();
  }

  private report(): void {
    if (this.failed.size > 0) this.onStatus("error");
    else if (this.inFlight > 0) this.onStatus("saving");
    else this.onStatus("saved");
  }
}

export interface NoteSession {
  id: string;
  path: string;
  doc: Y.Doc;
  // The note's own undo history (editor edits and calendar writes), shared by both views.
  undo: Y.UndoManager;
  // Kept in memory per tab; the EditorHost swaps it in and out.
  state: EditorState;
}

const LOAD_ORIGIN = "load";
// Origin of updates from other writers (the backend, after a change on disk or a remote edit): they reach the
// view but are not saved again.
const REMOTE_ORIGIN = "remote";
// The bridge the image embeds of the open notes load their files from.
let imageBridge: Bridge | null = null;
// Origin of the calendar's writes: undo tracks it, as it tracks the editor's own edits.
export const CALENDAR_ORIGIN = "calendar";

// Editing mode: Live Preview by default, or raw Markdown. Swapped by reconfiguring, so undo history survives.
const modeCompartment = new Compartment();
// Viewers of a shared vault edit nothing: every open note is read-only (setEditorReadOnly).
const readOnlyCompartment = new Compartment();
// Spellcheck, autocorrect and language of the editor (writingAttributes); reconfigured live.
const writingCompartment = new Compartment();
// The heading rail at the editor's edge (headingrail.ts); rebuilt when its setting changes.
const railCompartment = new Compartment();
let readOnly = false;
// Notes this user may read but not edit (a protected note or folder that names editors).
let readOnlyPath: (path: string) => boolean = () => false;
const lockedFor = (path: string): boolean => readOnly || readOnlyPath(path);
let sourceDefault = false;
// Every note opened in this session; setSourceMode switches all of them.
const sessions = new Set<NoteSession>();
// The editors on screen and the note each one shows: the tab (EditorHost) and the split pane (splitview.ts).
const panes = new Map<EditorView, NoteSession>();
// The editor the user worked in last (the split pane or the tab): the target of the toolbar and the commands.
let shown: EditorView | null = null;
let shownSession: NoteSession | null = null;

/** The focused editor and its note, or null before any note is shown. */
export function focusedPane(): { view: EditorView; session: NoteSession } | null {
  return shown && shownSession ? { view: shown, session: shownSession } : null;
}

/** Marks an editor as the focused one (its focusin). */
export function setShown(view: EditorView, session: NoteSession): void {
  shown = view;
  shownSession = session;
}

/** Registers the split pane's note while it is open, or removes the pane (null); a pane that had the focus falls back to the tab. */
export function setPane(view: EditorView, session: NoteSession | null): void {
  if (session) panes.set(view, session);
  else panes.delete(view);
  if (!session && shown === view) {
    shown = null;
    shownSession = null;
  }
}

/** Makes every open tab read-only (or editable again); `forPath` adds the notes read-only on their own. Remote changes still show. */
export function setEditorReadOnly(on: boolean, forPath?: (path: string) => boolean): void {
  readOnly = on;
  if (forPath) readOnlyPath = forPath;
  const effectsFor = (path: string) => readOnlyCompartment.reconfigure(EditorState.readOnly.of(lockedFor(path)));
  for (const s of sessions) s.state = s.state.update({ effects: effectsFor(s.path) }).state;
  for (const [view, s] of panes) view.dispatch({ effects: effectsFor(s.path) });
}

/** Switches every open tab between source and Live Preview, and makes that the default for tabs opened later. */
export function setSourceMode(on: boolean): void {
  sourceDefault = on;
  const effects = modeCompartment.reconfigure(on ? [] : modeExtensions());
  // A background tab keeps its state, undo history included, and is shown with it.
  // The shown tab's stored state is stale, but EditorHost.show overwrites it when the tab is left.
  for (const s of sessions) s.state = s.state.update({ effects }).state;
  for (const view of panes.keys()) view.dispatch({ effects });
}

// Live Preview: the note's own rendering, plus the images of its attachments.
function modeExtensions() {
  const live = [...livePreview(), ...liveTaskExtensions()];
  return imageBridge ? [...live, embedImages(imageBridge)] : live;
}

// The browser or OS does the spellchecking; the app ships no dictionary, it only sets these attributes.
function writingAttributes(): Extension {
  const on = getSetting("spellcheck");
  return EditorView.contentAttributes.of({
    spellcheck: on ? "true" : "false",
    autocorrect: on ? "on" : "off",
    autocapitalize: on ? "sentences" : "off",
    lang: getSetting("writingLanguage"),
  });
}

// Same shape as setSourceMode: every open tab, the shown one included, takes the new attributes.
function applyWriting(): void {
  const effects = writingCompartment.reconfigure(writingAttributes());
  for (const s of sessions) s.state = s.state.update({ effects }).state;
  for (const view of panes.keys()) view.dispatch({ effects });
}
// Same shape as applyWriting: the rail is rebuilt in every open view with the new side.
function applyRail(): void {
  const effects = railCompartment.reconfigure(headingRail(() => getSetting("headingRail")));
  for (const s of sessions) s.state = s.state.update({ effects }).state;
  for (const view of panes.keys()) view.dispatch({ effects });
}
onSettingChanged((key) => {
  if (key === "spellcheck" || key === "writingLanguage") applyWriting();
  if (key === "headingRail") applyRail();
});

const hasSelection = (state: EditorState): boolean => state.selection.ranges.some((r) => !r.empty);

// The whole note's count, per document value: a cursor move leaves the document as it is, so it is not recounted.
const wholeNoteCounts = new WeakMap<Text, { words: number; chars: number }>();

function countTexts(texts: string[]): { words: number; chars: number } {
  return {
    words: texts.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0),
    chars: texts.reduce((n, t) => n + t.length, 0),
  };
}

/** Words and characters of the selection (summed over its ranges), or of the whole note when nothing is selected. */
export function countWriting(state: EditorState): { words: number; chars: number; selected: boolean } {
  if (hasSelection(state)) {
    const ranges = state.selection.ranges.filter((r) => !r.empty);
    return { ...countTexts(ranges.map((r) => state.sliceDoc(r.from, r.to))), selected: true };
  }
  let whole = wholeNoteCounts.get(state.doc);
  if (!whole) {
    whole = countTexts([state.doc.toString()]);
    wholeNoteCounts.set(state.doc, whole);
  }
  return { ...whole, selected: false };
}

/** Applies an update from another writer to the note's document; the view follows and nothing is saved again. */
export function applyRemote(session: NoteSession, update: Uint8Array): void {
  Y.applyUpdate(session.doc, update, REMOTE_ORIGIN);
}

const headingLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }

    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const m = /^(#{1,6})\s/.exec(line.text);
          if (m) b.add(line.from, line.from, Decoration.line({ class: `cm-md-h${m[1].length}` }));
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// Replaces defaultHighlightStyle: headings and links must not be underlined in the source view.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold" },
  { tag: tags.link, color: "var(--accent)", textDecoration: "none" },
  { tag: tags.url, color: "var(--muted)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
]);

// Wikilink brackets are not Markdown links, so they are marked by pattern.
const wikilinkMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private readonly matcher = new MatchDecorator({
      regexp: /\[\[[^\]\n]+\]\]/g,
      decoration: Decoration.mark({ class: "cm-wikilink" }),
    });

    constructor(view: EditorView) {
      this.decorations = this.matcher.createDeco(view);
    }

    update(u: ViewUpdate): void {
      this.decorations = this.matcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const editorTheme = EditorView.theme({
  ".cm-wikilink": { color: "var(--accent)" },
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--editor-bg)" },
  ".cm-scroller": { fontFamily: "var(--font-text)", lineHeight: "1.7" },
  ".cm-content": { caretColor: "var(--accent)", padding: "24px 0", maxWidth: "var(--measure)", margin: "0 auto" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--sel)" },
  ".cm-md-h1": { fontSize: "1.8em", fontWeight: "700" },
  ".cm-md-h2": { fontSize: "1.45em", fontWeight: "700" },
  ".cm-md-h3": { fontSize: "1.2em", fontWeight: "600" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontWeight: "600" },
});

// Each note's Y.Doc is the source of truth; the EditorState is a view of its "content" text.
export async function openSession(
  bridge: Bridge,
  saver: Saver,
  id: string,
  path: string,
  onEdit: () => void,
  onLink: (target: string) => void = () => {},
): Promise<NoteSession> {
  const state = await bridge.call<Uint8Array>("open_note", { id });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, LOAD_ORIGIN);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== LOAD_ORIGIN && origin !== REMOTE_ORIGIN) saver.send(id, update);
  });

  const ytext = doc.getText("content");
  imageBridge = bridge;
  // Undo is Yjs-based and tracks only local edits (origin set by yCollab), never remote ones.
  const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set<unknown>([CALENDAR_ORIGIN]) });
  const editorState = EditorState.create({
    doc: ytext.toString(),
    // the cursor starts below the front matter, so the properties show
    selection: EditorSelection.cursor(cursorAfterFrontMatter(ytext.toString())),
    extensions: [
      ...taskExtensions(),
      tableCheckGuard,
      formattingKeymap,
      slashCommands,
      keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
      syntaxHighlighting(markdownHighlight),
      wikilinkMarks,
      markdown({ base: markdownLanguage }), // GFM, so tables get a "Table" node
      headingLines,
      tableExtension(),
      linkHandler.of(onLink),
      modeCompartment.of(sourceDefault ? [] : modeExtensions()),
      readOnlyCompartment.of(EditorState.readOnly.of(lockedFor(path))),
      writingCompartment.of(writingAttributes()),
      railCompartment.of(headingRail(() => getSetting("headingRail"))),
      attachmentHandlers(bridge, (message) => toast(message, true), () => path),
      excelPaste,
      linkPaste,
      dictationGhost,
      editorTheme,
      EditorView.lineWrapping,
      yCollab(ytext, null, { undoManager }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onEdit();
        // A move between two empty selections changes neither count.
        else if (u.selectionSet && (hasSelection(u.state) || hasSelection(u.startState))) emit("editor:selection");
      }),
    ],
  });
  const session: NoteSession = { id, path, doc, state: editorState, undo: undoManager };
  sessions.add(session);
  return session;
}

/** Puts a note's state into a view. A change made to the Y.Doc while the note was inactive is caught up first. */
export function showSession(view: EditorView, next: NoteSession): void {
  view.setState(next.state);
  const ytext = next.doc.getText("content").toString();
  if (view.state.doc.toString() !== ytext) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: ytext },
      annotations: [ySyncAnnotation.of(view.state.facet(ySyncFacet)), Transaction.addToHistory.of(false)],
    });
  }
}

export class EditorHost {
  readonly view: EditorView;
  private current: NoteSession | null = null;

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent });
  }

  show(next: NoteSession, prev: NoteSession | null): void {
    shown = this.view;
    shownSession = next;
    if (prev) prev.state = this.view.state;
    showSession(this.view, next);
    this.current = next;
    panes.set(this.view, next);
  }

  /** The note the tab shows. It can differ from the active note while a board or calendar is on screen. */
  get session(): NoteSession | null {
    return this.current;
  }

  // Takes the note out of the view, so nothing (toolbar, hotkeys, typing) can reach a closed note.
  clear(): void {
    this.view.setState(EditorState.create());
  }

  focus(): void {
    this.view.focus();
  }
}
