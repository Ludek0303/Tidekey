import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// Matches a line that holds only its marker, so the text typed after it starts a sentence.
const LINE_MARKER = /^\s*(?:#{1,6} |> |[-*+] (?:\[[ xX]\] )?|\d+\. )$/;

// Joins a spoken fragment to the text around the caret: capital letter, spaces and punctuation.
// `before` is the line up to the caret, `after` the rest of the line from the selection's end.
export function joinFragment(before: string, after: string, text: string): string {
  let t = text.trim();
  if (!t) return "";
  const prev = before.trimEnd();
  const last = prev.slice(-1);
  if (prev === "" || LINE_MARKER.test(before) || /[.!?…]/.test(last)) {
    t = t[0].toUpperCase() + t.slice(1);
  } else if (/[\p{L}\p{N},;:\-–—]/u.test(last)) {
    // shortcut: a proper noun after a pause loses its capital, until the engine marks proper nouns
    const word = /^\p{L}+/u.exec(t)?.[0] ?? "";
    if (!(word.length >= 2 && word === word.toUpperCase())) t = t[0].toLowerCase() + t.slice(1);
  }
  if (prev !== "" && /\S/.test(before.slice(-1)) && !/[([{„"'«]/.test(before.slice(-1)) && !/^[.,;:!?…)\]}»”]/.test(t)) {
    t = " " + t;
  }
  if (/^[\p{L}\p{N}]/u.test(after)) t += " ";
  return t;
}

// The text a fragment becomes at the main selection, joined to the text around it as insertDictation writes it.
export function fragmentAt(state: EditorState, text: string): string {
  const { from, to } = state.selection.main;
  const before = state.sliceDoc(state.doc.lineAt(from).from, from);
  const after = state.sliceDoc(to, state.doc.lineAt(to).to);
  return joinFragment(before, after, text);
}

// Inserts a fragment in place of the main selection, as one transaction, so one undo removes one fragment.
export function insertDictation(view: EditorView, text: string, undo: { stopCapturing(): void } | null = null): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const insert = fragmentAt(state, text);
  if (!insert) return false;
  // The caret goes after the text but before the trailing space, which only joins the next fragment.
  const head = from + insert.trimEnd().length;
  undo?.stopCapturing();
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: head },
    scrollIntoView: true,
    userEvent: "input.dictation",
  });
  undo?.stopCapturing();
  return true;
}
