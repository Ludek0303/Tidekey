// Kosz: the deleted notes, kept TRASH_DAYS days. A note can be restored; "Usuń na zawsze" empties one for good.
import type { Bridge, TrashEntry } from "./bridge";
import { TRASH_DAYS } from "./bridge";
import { emit } from "./bus";
import { daysLeft, noteName, when } from "./filesview";
import { el } from "./dom";
import { count } from "./transfer";
import { confirmDialog, errorText, openDialog, toast } from "./widgets";

const TRASH_EMPTY_TEXT = "Kosz jest pusty. Usunięte notatki są tu przez 6 miesięcy.";

/** The trash dialog. `changed` runs after a restore or a purge (the explorer refreshes its count). */
export function openTrash(bridge: Bridge, changed: () => void = () => undefined): void {
  openDialog({
    label: "Kosz",
    className: "trash-dialog",
    render(box, close) {
      const body = el("div", "trash-body");
      const footer = el("div", "modal-actions");
      const done = el("button", "btn", "Zamknij");
      done.type = "button";
      done.addEventListener("click", () => close());
      footer.append(done);
      box.append(el("h2", "trash-title", "Kosz"), body, footer);

      const draw = async (): Promise<void> => {
        const items = await bridge.call<TrashEntry[]>("list_trash");
        if (!items.length) { body.replaceChildren(el("p", "muted", TRASH_EMPTY_TEXT)); return; }
        const list = el("ul", "trash-list");
        for (const item of items) list.append(row(item));
        body.replaceChildren(list);
      };
      const run = async (task: () => Promise<void>): Promise<void> => {
        try {
          await task();
          changed();
          await draw();
        } catch (err) {
          toast(errorText(err), true);
        }
      };
      const restore = (item: TrashEntry) => run(async () => {
        const path = await bridge.call<string>("restore_note", { id: item.id });
        emit("ui:tree-reload");
        toast(`Przywrócono: ${noteName(path)}`);
      });
      const purge = async (item: TrashEntry): Promise<void> => {
        const name = noteName(item.path);
        if (!(await confirmDialog(`Usunąć na zawsze notatkę „${name}”? Nie będzie można jej przywrócić.`, "Usuń na zawsze"))) return;
        await run(async () => {
          await bridge.call("purge_note", { id: item.id });
        });
      };

      const row = (item: TrashEntry): HTMLLIElement => {
        const left = daysLeft(item.deleted_at, TRASH_DAYS);
        const info = el("div", "trash-info");
        info.append(el("strong", "trash-name", noteName(item.path)), el("span", "trash-path muted", item.path));
        const due = left === 0 ? "zostanie usunięte w najbliższym czasie" : `zostanie usunięte za ${count(left, "dzień", "dni", "dni")}`;
        info.append(el("span", "muted", `usunięto ${when(item.deleted_at)} · ${due}`));
        const restoreButton = el("button", "btn", "Przywróć");
        restoreButton.type = "button";
        restoreButton.addEventListener("click", () => void restore(item));
        const purgeButton = el("button", "btn btn-danger", "Usuń na zawsze");
        purgeButton.type = "button";
        purgeButton.addEventListener("click", () => void purge(item));
        const actions = el("div", "trash-actions");
        actions.append(restoreButton, purgeButton);
        const li = el("li", "trash-item");
        li.append(info, actions);
        return li;
      };

      void draw().catch((err: unknown) => toast(errorText(err), true));
    },
  });
}
