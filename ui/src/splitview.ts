import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setPane, setShown, showSession, type NoteSession } from "./editor";
import type { Layout } from "./layout";

// The second editor of the split: one note beside the tab's note. Its state is the note's own, so edits go
// through the same Y.Doc and the Saver sees them like any other.
export class SplitView {
  readonly view: EditorView;
  private current: NoteSession | null = null;

  constructor(private readonly layout: Layout) {
    // After the tab's editor in the DOM, so the first `.editor .cm-editor` (and the focus lookups) is still the tab's.
    layout.editor.append(layout.split);
    this.view = new EditorView({ parent: layout.splitEditor });
    // Commands and the toolbar follow the pane the user works in.
    this.view.dom.addEventListener("focusin", () => {
      if (this.current) setShown(this.view, this.current);
    });
  }

  /** The note in the split, or null when the split is closed. */
  get session(): NoteSession | null {
    return this.current;
  }

  /**
   * Puts a note in the split. The note that was there keeps its state, so it comes back as it was.
   * Returns false, and does nothing, for the note the tab on the left shows: one note is never in both panes.
   */
  open(session: NoteSession, left: NoteSession | null): boolean {
    if (session === left) return false;
    if (this.current !== session) {
      if (this.current) this.current.state = this.view.state;
      showSession(this.view, session);
      this.current = session;
      setPane(this.view, session);
      this.paint();
    }
    return true;
  }

  /** Closes the split. The note's state is kept on the session, so nothing typed is lost. */
  close(): void {
    if (!this.current) return;
    this.current.state = this.view.state;
    setPane(this.view, null);
    // Detaches the note's collaboration binding from this view, so the note can be shown elsewhere.
    this.view.setState(EditorState.create());
    this.current = null;
    this.paint();
  }

  /** Closes the split when its note is gone (deleted). */
  forget(id: string): void {
    if (this.current?.id === id) this.close();
  }

  /** Keeps the split's note path and title in step with a rename. */
  renamed(id: string, path: string): void {
    if (this.current?.id !== id) return;
    this.current.path = path;
    this.paint();
  }

  focus(): void {
    if (this.current) this.view.focus();
  }

  // The split sits inside the editor area, so a hidden editor (reading view, calendar, board) hides it too.
  private paint(): void {
    const on = this.current !== null;
    this.layout.split.hidden = !on;
    this.layout.editor.classList.toggle("split-open", on);
    if (this.current) this.layout.splitTitle.textContent = this.current.path.split("/").pop()!.replace(/\.md$/, "");
  }
}
