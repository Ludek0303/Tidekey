//! The conflict screen (ARCHITEKTURA §4.4): a note was changed both in the app and in its file, and the file's
//! text is kept apart until the user decides. The texts are shown block by block; the user takes one side as a
//! whole, or picks a side for each differing block.

import type { Bridge } from "./bridge";
import { blocks, compose } from "./linediff";
import { errorText, openDialog, toast } from "./widgets";

export interface ConflictTexts {
  ours: string;
  theirs: string;
  // the hash of the file's text: a resolution quotes it, and the backend refuses when the file changed since
  theirs_hash: string;
}

/** The banner above a note in conflict; its button opens the screen. */
export function conflictBanner(onOpen: () => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "conflict-banner";
  bar.setAttribute("role", "alert");
  const text = document.createElement("span");
  text.textContent = "Ta notatka ma konflikt: zmieniono ją w aplikacji i w pliku.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = "Rozwiąż konflikt";
  button.addEventListener("click", onOpen);
  bar.append(text, button);
  return bar;
}

/** The screen's source: where the two texts come from and where the chosen text goes. */
export interface ConflictSource {
  texts(): Promise<{ ours: string; theirs: string }>;
  resolve(text: string): Promise<void>;
  labels: { ours: string; theirs: string };
  buttons: { ours: string; theirs: string };
  title?: string;
  intro?: string;
}

// Keeps radio group names unique when more than one screen is open over time.
let screenSeq = 0;

/** Opens the screen for note `id`. `done` runs once the conflict is resolved. */
export async function openConflict(bridge: Bridge, id: string, done: () => void): Promise<void> {
  let seen = "";
  await openConflictScreen(
    {
      texts: async () => {
        const texts = await bridge.call<ConflictTexts>("conflict_texts", { id });
        seen = texts.theirs_hash;
        return texts;
      },
      resolve: (text) => bridge.call("resolve_conflict", { id, text, seen }).then(() => {}),
      labels: { ours: "W aplikacji", theirs: "Na dysku" },
      buttons: { ours: "Zostaw wersję z aplikacji", theirs: "Weź wersję z dysku" },
    },
    done,
  );
}

/** Opens the comparison screen for any source. `done` runs once the text is saved. */
export async function openConflictScreen(source: ConflictSource, done: () => void): Promise<void> {
  const texts = await source.texts();
  const all = blocks(texts.ours, texts.theirs);
  const picks: Array<"ours" | "theirs"> = all.filter((b) => !("same" in b)).map(() => "ours");
  const radioName = `conflict-${++screenSeq}`;
  openDialog({
    label: source.title ?? "Konflikt zapisu",
    className: "conflict",
    render: (box, close) => {
      const resolve = async (text: string) => {
        try {
          await source.resolve(text);
          close();
          done();
        } catch (e) {
          // the file changed since this view was made: the view is made again, with the texts as they are now
          if ((e as { kind?: unknown } | null)?.kind === "conflict_changed") {
            close();
            void openConflictScreen(source, done);
            return;
          }
          toast(errorText(e), true);
        }
      };
      const intro = document.createElement("p");
      intro.textContent = source.intro ?? "W aplikacji i w pliku zmieniono ten sam fragment. Wybierz, która wersja zostaje.";
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const keepApp = button(source.buttons.ours, () => void resolve(texts.ours));
      const takeDisk = button(source.buttons.theirs, () => void resolve(texts.theirs));
      const chosen = button("Zastosuj wybór", () => void resolve(compose(all, picks)));
      actions.append(keepApp, takeDisk, chosen);

      const rows = document.createElement("div");
      rows.className = "conflict-rows";
      let differing = 0;
      all.forEach((block) => {
        if ("same" in block) {
          rows.append(lines(block.same, "conflict-same"));
          return;
        }
        const n = differing++;
        const group = document.createElement("fieldset");
        group.className = "conflict-block";
        const legend = document.createElement("legend");
        legend.textContent = `Fragment ${n + 1}`;
        group.append(legend, radio(`${radioName}-${n}`, "ours", source.labels.ours, block.ours, () => (picks[n] = "ours"), true));
        group.append(radio(`${radioName}-${n}`, "theirs", source.labels.theirs, block.theirs, () => (picks[n] = "theirs"), false));
        rows.append(group);
      });
      box.append(intro, actions, rows);
      keepApp.focus();
    },
  });
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function lines(text: string[], cls: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = cls;
  pre.textContent = text.join("\n");
  return pre;
}

// One side of a differing block: a radio with its label, and the lines of that side.
function radio(name: string, value: string, label: string, text: string[], onPick: () => void, checked: boolean): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "conflict-side";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.addEventListener("change", onPick);
  const title = document.createElement("span");
  title.textContent = label;
  wrap.append(input, title, lines(text.length ? text : ["(brak wierszy)"], "conflict-lines"));
  return wrap;
}
