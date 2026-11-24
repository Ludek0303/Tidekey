//! "/" in a note: a menu of blocks to insert (a task, a table, headings, lists…), as in Notion or Obsidian's slash
//! commands. Each item is the toolbar's own command, so the menu and the toolbar write the same Markdown. A new task
//! opens the task panel at once (in an organization), so its person, group and date are filled in right there.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { pickFiles } from "./attachments";
import { addFolder } from "./filefolders-view";
import { SAMPLE_CHART } from "./charts";
import { insertChartBlock } from "./chartdialog";
import { SAMPLE_DIAGRAM } from "./diagram";
import { insertDiagramBlock } from "./diagramdialog";
import { openTaskPanel } from "./taskchips";
import { FORMAT_COMMANDS } from "./toolbar";
import { runCommand } from "./commands";

const TASK_PLACEHOLDER = "Nowe zadanie";
const PANEL_TRIES = 20; // the index sees the new line a moment after it is typed

const run = (id: string) => (view: EditorView) => FORMAT_COMMANDS.find((c) => c.id === id)!.run(view);
// A block that takes a whole line goes on the cursor's line when it is empty, else on a new line below it: text that
// is already there is never replaced.
const setLine = (view: EditorView, text: string, select?: [number, number]) => {
  let line = view.state.doc.lineAt(view.state.selection.main.head);
  if (line.text.trim()) {
    view.dispatch({ changes: { from: line.to, insert: "\n" }, selection: { anchor: line.to + 1 } });
    line = view.state.doc.lineAt(view.state.selection.main.head);
  }
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: text },
    selection: select ? { anchor: line.from + select[0], head: line.from + select[1] } : { anchor: line.from + text.length },
  });
};

interface SlashItem { label: string; detail: string; keywords: string; insert: (view: EditorView) => void }

export const SLASH_ITEMS: SlashItem[] = [
  { label: "Zadanie", detail: "- [ ] z panelem zadania", keywords: "task todo checkbox", insert: insertTask },
  { label: "Tabela", detail: "jak w arkuszu", keywords: "table excel arkusz", insert: run("fmt.table") },
  { label: "Wykres", detail: "słupkowy lub kołowy", keywords: "wykres chart diagram słupki kołowy excel", insert: (v) => insertChartBlock(v, v.state.selection.main.head, SAMPLE_CHART) },
  { label: "Schemat", detail: "prostokąty i strzałki", keywords: "schemat diagram blok strzałka graf visio proces", insert: (v) => insertDiagramBlock(v, v.state.selection.main.head, SAMPLE_DIAGRAM) },
  { label: "Nagłówek 1", detail: "#", keywords: "h1 heading tytul", insert: (v) => setLine(v, "# ") },
  { label: "Nagłówek 2", detail: "##", keywords: "h2 heading", insert: (v) => setLine(v, "## ") },
  { label: "Nagłówek 3", detail: "###", keywords: "h3 heading", insert: (v) => setLine(v, "### ") },
  { label: "Lista", detail: "- punkt", keywords: "list bullet punkty", insert: run("fmt.list") },
  { label: "Lista numerowana", detail: "1.", keywords: "ordered numbered", insert: run("fmt.ordered") },
  { label: "Cytat", detail: ">", keywords: "quote", insert: run("fmt.quote") },
  { label: "Wyróżnienie", detail: "> [!note]", keywords: "callout note uwaga", insert: (v) => setLine(v, "> [!note] ") },
  { label: "Blok kodu", detail: "```", keywords: "code kod", insert: (v) => setLine(v, "```\n\n```", [4, 4]) },
  { label: "Link do notatki", detail: "[[…]]", keywords: "link wikilink", insert: run("fmt.link") },
  { label: "Spotkanie", detail: "wydarzenie z tej notatki", keywords: "spotkanie wydarzenie kalendarz meeting", insert: () => runCommand("meeting.create") },
  { label: "Linia pozioma", detail: "---", keywords: "rule separator", insert: run("fmt.rule") },
  { label: "Dodaj plik", detail: "obraz, PDF lub inny plik", keywords: "plik załącznik zalacznik zdjęcie zdjecie obraz upload dodaj file image attach", insert: pickFiles },
  { label: "Folder z plikami", detail: "ikonka z plikami", keywords: "pliki folder załączniki files", insert: (v) => addFolder(v, v.state.selection.main.head) },
];

// A task line with its text selected (typing replaces it), then its panel as soon as the index knows the task.
function insertTask(view: EditorView): void {
  setLine(view, `- [ ] ${TASK_PLACEHOLDER}`, [6, 6 + TASK_PLACEHOLDER.length]);
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  let tries = 0;
  const attempt = () => { if (!openTaskPanel(line) && ++tries < PANEL_TRIES) setTimeout(attempt, 100); };
  setTimeout(attempt, 100);
}

/** The menu's items for the text before the cursor: "/" at a line start or after a space, then the typed filter. */
export function slashSource(context: CompletionContext): CompletionResult | null {
  const typed = context.matchBefore(/\/[\p{L}\p{N} ]{0,24}$/u);
  if (!typed) return null;
  const before = typed.from > 0 ? context.state.sliceDoc(typed.from - 1, typed.from) : "";
  if (before && !/\s/.test(before)) return null; // "a/b", a path or a date, is not a command
  const query = typed.text.slice(1).toLowerCase();
  const options: Completion[] = SLASH_ITEMS.filter((i) => !query || `${i.label} ${i.keywords}`.toLowerCase().includes(query)).map((item) => ({
    label: item.label,
    detail: item.detail,
    apply: (view, _c, from, to) => { view.dispatch({ changes: { from, to, insert: "" } }); item.insert(view); },
  }));
  return options.length ? { from: typed.from, to: context.pos, options, filter: false } : null;
}

export const slashCommands: Extension = autocompletion({ override: [slashSource], icons: false, activateOnTyping: true });
