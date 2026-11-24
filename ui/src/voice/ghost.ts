// The ghost: words of a partial result, shown at the caret while they are still being spoken (docs/DYKTOWANIE.md §4).
// A widget decoration, so the text never reaches the document: not Yjs, not undo, not the saved file. The final
// replaces it, and stopping dictation clears it.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { fragmentAt } from "./insert";

const setGhost = StateEffect.define<{ pos: number; text: string } | null>();

class Ghost extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof Ghost && other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-dictation-ghost";
    // The final text lands in the document anyway, so a screen reader does not need the ghost.
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
}

export const dictationGhost = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setGhost)) continue;
      next = e.value ? Decoration.set(Decoration.widget({ widget: new Ghost(e.value.text), side: 1 }).range(e.value.pos)) : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Shows `text` at the main caret, joined as the final will be (capital, space). Empty text clears the ghost.
export function showGhost(view: EditorView, text: string): void {
  const insert = fragmentAt(view.state, text);
  const pos = view.state.selection.main.from;
  view.dispatch({ effects: setGhost.of(insert ? { pos, text: insert } : null) });
}

export function clearGhost(view: EditorView): void {
  if (view.state.field(dictationGhost).size) view.dispatch({ effects: setGhost.of(null) });
}
