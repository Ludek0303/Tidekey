// Text and source code: a read-only CodeMirror with line numbers, highlighting and switchable line wrap (PODGLAD-PLAN §5).
// HTML and SVG files come here as source, so their markup is never rendered.
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Theme } from "../../../src/preview/protocol";
import { decodeText, TEXT_SHOWN_BYTES } from "../textdecode";
import type { Viewer, ViewerContext } from "./index";

const MIB = 1024 * 1024;
const MONO = 'ui-monospace, "JetBrains Mono", monospace';
// A file name that stands for a MIME type, for files whose extension says nothing.
const MIME_NAMES: Record<string, string> = {
  "application/json": "x.json",
  "application/xml": "x.xml",
  "text/xml": "x.xml",
  "text/html": "x.html",
  "text/css": "x.css",
  "text/javascript": "x.js",
  "application/javascript": "x.js",
};

function editorTheme(theme: Theme): Extension {
  const c = theme.colors;
  return EditorView.theme(
    {
      "&": { height: "100%", fontSize: "12.5px", backgroundColor: c.bg, color: c.text },
      ".cm-scroller": { fontFamily: MONO, lineHeight: "1.5" },
      ".cm-gutters": { backgroundColor: c.bg, color: c.muted, border: "none", borderRight: `1px solid ${c.border}` },
    },
    { dark: theme.name === "dark" },
  );
}

function highlighting(theme: Theme): Extension {
  const dark = theme.name === "dark";
  const string = dark ? "#9bc8ae" : "#38734e";
  const number = dark ? "#e5c07b" : "#8a5d00";
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: theme.colors.accent },
      { tag: tags.string, color: string },
      { tag: tags.comment, color: theme.colors.muted, fontStyle: "italic" },
      { tag: [tags.number, tags.bool, tags.function(tags.variableName), tags.function(tags.propertyName)], color: number },
    ]),
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / MIB).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} MB`;
}

async function loadLanguage(ctx: ViewerContext, view: () => EditorView | null, language: Compartment): Promise<void> {
  const mimeName = MIME_NAMES[ctx.mime.toLowerCase()];
  const desc = LanguageDescription.matchFilename(languages, ctx.name) ?? (mimeName ? LanguageDescription.matchFilename(languages, mimeName) : null);
  if (!desc) return;
  let support: Extension;
  try {
    support = await desc.load();
  } catch {
    // the file stays plain text
    return;
  }
  const v = view();
  if (!ctx.signal.aborted && v) v.dispatch({ effects: language.reconfigure(support) });
}

export function createTextViewer(): Viewer {
  let root: HTMLElement | null = null;
  let view: EditorView | null = null;
  let wrapOn = false;
  let wrapButton: HTMLButtonElement | null = null;
  const wrap = new Compartment();
  const language = new Compartment();

  const toggleWrap = (): void => {
    if (!view || !wrapButton) return;
    wrapOn = !wrapOn;
    view.dispatch({ effects: wrap.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
    wrapButton.setAttribute("aria-pressed", String(wrapOn));
  };

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const { text, truncated } = decodeText(new Uint8Array(bytes), TEXT_SHOWN_BYTES);
      if (ctx.signal.aborted) return;

      const frame = document.createElement("div");
      frame.className = "r r-tekst";
      root = frame;
      ctx.host.append(frame);

      if (text === "") {
        const empty = document.createElement("div");
        empty.className = "tekst-pusty";
        empty.textContent = "Plik jest pusty.";
        frame.append(empty);
        ctx.status("Wierszy: 0");
        return;
      }

      if (truncated) {
        const note = document.createElement("div");
        note.className = "tekst-uwaga";
        note.textContent = `Pokazano pierwsze 2 MB z ${megabytes(ctx.size)}.`;
        frame.append(note);
      }

      const editor = document.createElement("div");
      editor.className = "tekst-edytor";
      frame.append(editor);

      const state = EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          editorTheme(ctx.theme),
          highlighting(ctx.theme),
          wrap.of([]),
          language.of([]),
        ],
      });
      view = new EditorView({ state, parent: editor });
      ctx.status(`Wierszy: ${view.state.doc.lines.toLocaleString("pl-PL")}`);

      const bar = document.createElement("div");
      bar.className = "r-narzedzia";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Tekst");
      wrapButton = document.createElement("button");
      wrapButton.type = "button";
      wrapButton.textContent = "Zawijaj wiersze";
      wrapButton.setAttribute("aria-pressed", "false");
      wrapButton.addEventListener("click", toggleWrap);
      bar.append(wrapButton);
      frame.append(bar);

      // the highlighting comes after the first paint: the file is readable at once
      void loadLanguage(ctx, () => view, language);
    },

    key(e: KeyboardEvent): boolean {
      if (e.key !== "w" || e.ctrlKey || e.metaKey || e.altKey || !view) return false;
      toggleWrap();
      return true;
    },

    dispose(): void {
      view?.destroy();
      view = null;
      wrapButton = null;
      root?.remove();
      root = null;
    },
  };
}
