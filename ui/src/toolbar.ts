import { Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { registerCommand } from "./commands";
import { iconButton, type IconName } from "./icons";
import { getSetting, onSettingChanged } from "./settings";
import { emit, on } from "./bus";
import { inTauri } from "./tauribridge";
import { STATUS_TEXT } from "./voice/types";
import { attachTooltips } from "./tooltip";
import type { DictationTarget } from "./voice/controller";

// Loaded on the first dictation click or shortcut; kept so setActive can stop it.
let voice: typeof import("./voice/controller") | null = null;

// Counts the run of ch touching the selection on each side, so "**a**" is not read as an italic pair.
function sideRuns(view: EditorView, from: number, to: number, ch: string): [number, number] {
  const { doc } = view.state;
  let left = 0;
  while (from - left > 0 && doc.sliceString(from - left - 1, from - left) === ch) left++;
  let right = 0;
  while (to + right < doc.length && doc.sliceString(to + right, to + right + 1) === ch) right++;
  return [left, right];
}

// Wraps the main selection in open/close markers, or removes them when they already surround it.
export function wrap(view: EditorView, open: string, close = open): void {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  const before = view.state.sliceDoc(Math.max(0, from - open.length), from);
  const after = view.state.sliceDoc(to, to + close.length);
  // A single `*` inside a bold `**` run is not a pair of its own, so "**a**" gets italic as "***a***".
  const [left, right] = open.length === 1 ? sideRuns(view, from, to, open) : [1, 1];
  if (before === open && after === close && (open.length > 1 || (left % 2 === 1 && right % 2 === 1))) {
    view.dispatch({
      changes: [
        { from: from - open.length, to: from },
        { from: to, to: to + close.length },
      ],
      selection: { anchor: from - open.length, head: to - open.length },
    });
  } else if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
    const inner = text.slice(open.length, text.length - close.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
  } else {
    // Markdown does not recognise `**tekst **` (and the same applies to the other inline
    // markers). Keep whitespace outside the markers when a user selected it with the word.
    const leading = text.match(/^\s*/u)?.[0] ?? "";
    const trailing = text.match(/\s*$/u)?.[0] ?? "";
    const bodyEnd = text.length - trailing.length;
    const body = text.slice(leading.length, bodyEnd);
    if (body.length > 0 && (leading.length > 0 || trailing.length > 0)) {
      const insert = leading + open + body + close + trailing;
      const bodyFrom = from + leading.length + open.length;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: bodyFrom, head: bodyFrom + body.length },
      });
      return;
    }
    view.dispatch({
      changes: { from, to, insert: open + text + close },
      selection: { anchor: from + open.length, head: to + open.length },
    });
  }
}

// Matches the markers a line may already start with: headings, quotes, lists, tasks.
const LINE_HEAD = /^(?:#{1,6} |> |- \[[ xX]\] |[-*+] |\d+\. )/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces the start of every selected line. `strip` matches what is removed, `prefix` is inserted.
function editLines(view: EditorView, strip: RegExp, prefix: string): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const changes = [];
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
    const line = state.doc.line(n);
    const m = strip.exec(line.text);
    changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
  }
  const changeSet = state.changes(changes);
  // At the start of an empty line CodeMirror normally keeps the caret before inserted text.
  // A list command should leave it where typing starts: after `- `, `1. ` or `- [ ] `.
  view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1) });
}

// Toggles a line prefix on the selected lines. `on` matches a line that already has it; such a line loses it.
// Other lines get `prefix` in place of their own marker, so a list item "- [ ] x" becomes "- x".
export function togglePrefix(view: EditorView, prefix: string, on = new RegExp(`^${escapeRe(prefix)}`)): void {
  const first = view.state.doc.lineAt(view.state.selection.main.from).text;
  if (on.test(first)) editLines(view, on, "");
  else editLines(view, LINE_HEAD, prefix);
}

// Heading level cycles none, H1, H2, H3, none.
export function cycleHeading(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.from).text;
  const level = /^(#{1,6}) /.exec(line)?.[1].length ?? 0;
  const next = level >= 3 ? 0 : level + 1;
  editLines(view, /^#{1,6} /, next ? `${"#".repeat(next)} ` : "");
}

// Inserts a block at the end of the current line. A blank line goes before it, so a line of text above
// does not turn it into a setext heading ("text" over "---").
function insertBlock(view: EditorView, block: string): void {
  const { doc, selection } = view.state;
  const line = doc.lineAt(selection.main.from);
  const above = line.number > 1 ? doc.line(line.number - 1).text : "";
  const lead = line.length > 0 ? "\n\n" : above.length > 0 ? "\n" : "";
  const text = lead + block;
  view.dispatch({
    changes: { from: line.to, insert: text },
    selection: { anchor: line.to + text.length },
  });
}

const TABLE = "| Kolumna 1 | Kolumna 2 | Kolumna 3 |\n| --- | --- | --- |\n|  |  |  |\n";

export function insertTable(view: EditorView): void {
  insertBlock(view, TABLE);
}

export function insertRule(view: EditorView): void {
  insertBlock(view, "---\n");
}

export interface FormatCommand {
  id: string;
  name: string;
  icon: IconName;
  run: (view: EditorView) => void;
  hotkey?: string;
}

export const FORMAT_COMMANDS: FormatCommand[] = [
  { id: "fmt.bold", name: "Pogrubienie", icon: "bold", hotkey: "Ctrl+B", run: (v) => wrap(v, "**") },
  { id: "fmt.italic", name: "Kursywa", icon: "italic", hotkey: "Ctrl+I", run: (v) => wrap(v, "*") },
  { id: "fmt.strike", name: "Przekreślenie", icon: "strikethrough", hotkey: "Ctrl+Shift+X", run: (v) => wrap(v, "~~") },
  { id: "fmt.mark", name: "Zakreślenie", icon: "highlighter", run: (v) => wrap(v, "==") },
  { id: "fmt.heading", name: "Nagłówek", icon: "heading", run: cycleHeading },
  { id: "fmt.list", name: "Lista", icon: "list", run: (v) => togglePrefix(v, "- ", /^- (?!\[[ xX]\] )/) },
  { id: "fmt.ordered", name: "Lista numerowana", icon: "list-ordered", run: (v) => togglePrefix(v, "1. ") },
  { id: "fmt.task", name: "Zadanie", icon: "list-todo", run: (v) => togglePrefix(v, "- [ ] ", /^- \[[ xX]\] /) },
  { id: "fmt.quote", name: "Cytat", icon: "quote", run: (v) => togglePrefix(v, "> ") },
  { id: "fmt.code", name: "Kod", icon: "code", run: (v) => wrap(v, "`") },
  { id: "fmt.link", name: "Link", icon: "link", hotkey: "Ctrl+K", run: (v) => wrap(v, "[[", "]]") },
  { id: "fmt.table", name: "Wstaw tabelę", icon: "table", run: insertTable },
  { id: "fmt.rule", name: "Linia pozioma", icon: "minus", run: insertRule },
];

// "Ctrl+Shift+X" becomes "Mod-Shift-x", the CodeMirror spelling.
function toCmKey(hotkey: string): string {
  const parts = hotkey.split("+");
  const key = parts.pop()!.toLowerCase();
  return [...parts.map((p) => (p === "Ctrl" ? "Mod" : p)), key].join("-");
}

// Formatting hotkeys live in the editor's own keymap, so they fire only with the editor focused.
// Prec.high puts them ahead of defaultKeymap, where Ctrl+I is selectParentSyntax.
export const formattingKeymap: Extension = Prec.high(
  keymap.of(
    [
      // In Markdown, Tab/Shift+Tab make and remove a nested list level. Table navigation has
      // its own higher-priority handler and still wins while the caret is in a table.
      indentWithTab,
      ...FORMAT_COMMANDS.filter((c) => c.hotkey).map((c) => ({
        key: toCmKey(c.hotkey!),
        run: (view: EditorView) => {
          c.run(view);
          return true;
        },
      })),
      // Dictation is browser-only for now (docs/DYKTOWANIE.md §9), so the desktop app gets no shortcut.
      ...(inTauri() ? [] : [{ key: "Mod-Shift-d", run: () => (emit("voice:toggle"), true) }]),
    ],
  ),
);

// Registers the formatting commands so the palette can run them too. The hotkeys stay in the editor keymap.
export function registerFormatCommands(getView: () => EditorView | null): void {
  for (const cmd of FORMAT_COMMANDS) {
    registerCommand({
      id: cmd.id,
      name: cmd.name,
      hint: cmd.hotkey,
      run: () => {
        const view = getView();
        if (view) cmd.run(view);
      },
    });
  }
}

// The slim bar beside the editor (top by default). Shown only while a note is open and the "showToolbar" setting is on.
export class Toolbar {
  private active = false;

  private voiceBtn: HTMLElement | null = null;
  private readonly target: () => DictationTarget | null;

  constructor(
    private readonly host: HTMLElement,
    getView: () => EditorView | null,
    getUndo: () => { stopCapturing(): void } | null = () => null,
  ) {
    host.setAttribute("role", "toolbar");
    host.setAttribute("aria-label", "Formatowanie");
    registerFormatCommands(getView);
    this.target = () => {
      const view = getView();
      return view ? { view, undo: getUndo() } : null;
    };
    for (const cmd of FORMAT_COMMANDS) {
      const label = cmd.hotkey ? `${cmd.name} (${cmd.hotkey})` : cmd.name;
      const btn = iconButton(cmd.icon, label, "fmt-btn");
      // The tooltip replaces the native title, which shows late and never on keyboard focus.
      btn.removeAttribute("title");
      // Keep the selection and scroll position when the mouse reaches for formatting.
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => {
        const view = getView();
        if (view) {
          cmd.run(view);
          view.focus();
        }
      });
      host.append(btn);
    }
    if (!inTauri()) {
      const btn = iconButton("mic", STATUS_TEXT.idle, "fmt-btn voice-btn");
      btn.removeAttribute("title");
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => this.dictate());
      host.append(btn);
      this.voiceBtn = btn;
      on("voice:toggle", () => this.dictate());
      registerCommand({ id: "voice.toggle", name: "Dyktowanie", hint: "Ctrl+Shift+D", run: () => emit("voice:toggle") });
    }
    attachTooltips(host, ".fmt-btn");
    this.apply();
    onSettingChanged((key) => {
      if (key === "showToolbar" || key === "toolbarPosition") this.apply();
    });
  }

  setActive(on: boolean): void {
    this.active = on;
    if (!on) voice?.stopDictation();
    this.apply();
  }

  private dictate(): void {
    this.target()?.view.focus();
    void import("./voice/controller").then((m) => {
      voice = m;
      m.toggleDictation(this.target, this.voiceBtn);
    });
  }

  private apply(): void {
    // CSS places the bar by this attribute (workspace.css); a side bar is a vertical column.
    const position = getSetting("toolbarPosition");
    this.host.dataset.toolbar = position;
    this.host.setAttribute("aria-orientation", position === "left" || position === "right" ? "vertical" : "horizontal");
    this.host.hidden = !this.active || !getSetting("showToolbar");
  }
}
