import { fuzzyScore } from "./quickopen";
import { openDialog } from "./widgets";

// hotkey: "Ctrl+Shift+P" style, or a list of them. Ctrl also matches Cmd on macOS. hint: shown only (handled elsewhere).
export interface Command {
  id: string;
  name: string;
  run: () => void;
  hotkey?: string | string[];
  hint?: string;
}

// The key combo shown next to a command: its first hotkey, else its hint.
export function shortcut(cmd: Command): string | undefined {
  return ([cmd.hotkey].flat()[0] as string | undefined) ?? cmd.hint;
}

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
}

export function listCommands(): Command[] {
  return [...commands.values()];
}

export function runCommand(id: string): void {
  commands.get(id)?.run();
}

function matches(hotkey: string, e: KeyboardEvent): boolean {
  const parts = hotkey.split("+");
  const key = parts.pop()!.toLowerCase();
  return (
    (e.ctrlKey || e.metaKey) === parts.includes("Ctrl") &&
    e.shiftKey === parts.includes("Shift") &&
    e.altKey === parts.includes("Alt") &&
    e.key.toLowerCase() === key
  );
}

// Typing in a text field keeps its keys, and an open dialog (palette, settings, quick open) keeps them all.
export function installHotkeys(): void {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (document.querySelector('[role="dialog"]')) return;
    for (const cmd of commands.values()) {
      if ([cmd.hotkey].flat().some((k) => k !== undefined && matches(k, e))) {
        e.preventDefault();
        cmd.run();
        return;
      }
    }
  });
}

// Command palette (Ctrl+Shift+P or F1). Same shared dialog frame as settings; Esc closes.
export class CommandPalette {
  private input: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private results: Command[] = [];
  private sel = 0;
  private closeDialog: (() => void) | null = null;

  open(): void {
    if (this.closeDialog) return;
    this.closeDialog = openDialog({
      label: "Paleta poleceń",
      className: "qo",
      render: (box) => {
        box.insertAdjacentHTML(
          "beforeend",
          `<input class="qo-input" type="text" role="combobox" aria-autocomplete="list"
            aria-expanded="true" aria-controls="cmd-list" placeholder="Wpisz polecenie…" />
          <ul class="qo-list" id="cmd-list" role="listbox" aria-label="Polecenia"></ul>`,
        );
        this.input = box.querySelector<HTMLInputElement>(".qo-input");
        this.list = box.querySelector<HTMLElement>(".qo-list");
        this.input!.addEventListener("input", () => this.filter());
        this.input!.addEventListener("keydown", (e) => this.onKey(e));
        this.filter();
      },
      onClose: () => {
        this.closeDialog = null;
        this.input = this.list = null;
      },
    });
  }

  private filter(): void {
    const query = this.input?.value ?? "";
    this.results = listCommands()
      .filter((cmd) => fuzzyScore(query, cmd.name) !== null)
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));
    this.sel = 0;
    this.renderList();
  }

  private renderList(): void {
    if (!this.list || !this.input) return;
    const opts = this.results.map((cmd, i) => {
      const li = document.createElement("li");
      li.id = `cmd-opt-${i}`;
      li.className = `qo-option${i === this.sel ? " is-sel" : ""}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === this.sel));
      const name = document.createElement("span");
      name.textContent = cmd.name;
      li.append(name);
      const keys = shortcut(cmd);
      if (keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = keys;
        li.append(kbd);
      }
      li.addEventListener("click", () => this.pick(i));
      return li;
    });
    this.list.replaceChildren(...opts);
    if (this.results.length > 0) this.input.setAttribute("aria-activedescendant", `cmd-opt-${this.sel}`);
    else this.input.removeAttribute("aria-activedescendant");
  }

  private pick(i: number): void {
    const cmd = this.results[i];
    if (!cmd) return;
    this.closeDialog?.();
    cmd.run();
  }

  // Escape is handled by the dialog frame, which closes the palette.
  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const n = this.results.length;
        if (n === 0) break;
        this.sel = (this.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        this.renderList();
        this.list?.children[this.sel]?.scrollIntoView({ block: "nearest" });
        break;
      }
      case "Enter":
        this.pick(this.sel);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
