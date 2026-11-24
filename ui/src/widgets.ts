import { icon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  // Set on radio-style items (sort order): shows a check mark on the active one.
  checked?: boolean;
  run: () => void;
}
export type MenuEntry = MenuItem | "separator";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])';
let closeMenu: (() => void) | null = null;

// Context and "more" menus: arrows move, Home/End jump, Enter/Space run, Esc or Tab closes.
export function openMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeMenu?.();
  const returnTo = document.activeElement as HTMLElement | null;
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Menu");
  for (const entry of entries) {
    if (entry === "separator") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      sep.setAttribute("role", "separator");
      menu.append(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemradio");
    if (entry.checked !== undefined) btn.setAttribute("aria-checked", String(entry.checked));
    if (entry.checked) btn.append(icon("check"));
    else if (entry.icon) btn.append(icon(entry.icon));
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = entry.label;
    btn.append(label);
    if (entry.hint) {
      const hint = document.createElement("kbd");
      hint.textContent = entry.hint;
      btn.append(hint);
    }
    btn.addEventListener("click", () => {
      close();
      entry.run();
    });
    menu.append(btn);
  }

  const onPointer = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  function close(): void {
    if (!menu.isConnected) return;
    menu.remove();
    document.removeEventListener("pointerdown", onPointer, true);
    closeMenu = null;
    if (returnTo?.isConnected) returnTo.focus();
  }
  closeMenu = close;

  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") move(cur + 1);
    else if (e.key === "ArrowUp") move(cur < 0 ? -1 : cur - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  });
  document.body.append(menu);
  // Keep the menu on screen: flip it back inside the viewport when it would overflow.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  document.addEventListener("pointerdown", onPointer, true);
  menu.querySelector<HTMLButtonElement>(".menu-item")?.focus();
}

let dialogSeq = 0;

// Modal dialog: focus starts inside, Tab cycles within it, Esc closes, focus returns on close.
export function openDialog(opts: {
  label: string;
  className?: string;
  render: (box: HTMLElement, close: () => void) => void;
  onClose?: () => void;
}): () => void {
  const returnTo = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const box = document.createElement("div");
  box.className = `modal ${opts.className ?? ""}`.trim();
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  // The label is a visually hidden title, so the dialog is named by its own text (aria-labelledby).
  const title = document.createElement("span");
  title.id = `dialog-title-${++dialogSeq}`;
  title.className = "sr-only";
  title.textContent = opts.label;
  box.setAttribute("aria-labelledby", title.id);
  box.tabIndex = -1;
  box.append(title);
  backdrop.append(box);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    if (returnTo?.isConnected) returnTo.focus();
    // the opener went away (a list redrew under a nested confirm): the dialog below takes focus, so Escape still closes it
    else [...document.querySelectorAll<HTMLElement>(".modal-backdrop > [role=dialog]")].pop()?.focus();
    opts.onClose?.();
  };
  // Focus that drops out of the box (its button was removed by a redraw) goes back to the box, so Escape and Tab keep working.
  box.addEventListener("focusout", (e) => {
    if (e.relatedTarget !== null) return;
    queueMicrotask(() => {
      if (closed) return;
      const active = document.activeElement;
      const inDialog = active !== null && active !== document.body && [...document.querySelectorAll<HTMLElement>(".modal-backdrop > [role=dialog]")].some((d) => d.contains(active));
      if (!inDialog) box.focus();
    });
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });

  opts.render(box, close);
  document.body.append(backdrop);
  (box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
  return close;
}

// `typed`: for destructive actions the user must type it exactly; the OK button stays disabled until then.
export function confirmDialog(message: string, okLabel: string, danger = true, typed?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (ok: boolean, close: () => void) => {
      if (!answered) resolve(ok);
      answered = true;
      close();
    };
    openDialog({
      label: message,
      className: "modal-confirm",
      render(box, close) {
        const p = document.createElement("p");
        p.textContent = message;
        const row = document.createElement("div");
        row.className = "modal-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = "Anuluj";
        cancel.addEventListener("click", () => finish(false, close));
        const ok = document.createElement("button");
        ok.type = "button";
        ok.className = danger ? "btn btn-danger" : "btn btn-primary";
        ok.textContent = okLabel;
        ok.addEventListener("click", () => finish(true, close));
        const parts: HTMLElement[] = [p];
        if (typed !== undefined) {
          const hint = document.createElement("p");
          const strong = document.createElement("strong");
          strong.textContent = typed;
          hint.append("Aby potwierdzić, wpisz nazwę: ", strong);
          const input = document.createElement("input");
          input.type = "text";
          input.autocomplete = "off";
          input.setAttribute("aria-label", "Nazwa do potwierdzenia");
          const matches = () => input.value.trim() === typed;
          ok.disabled = true;
          input.addEventListener("input", () => {
            ok.disabled = !matches();
          });
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && matches()) {
              e.preventDefault();
              finish(true, close);
            }
          });
          parts.push(hint, input);
        }
        row.append(cancel, ok);
        box.append(...parts, row);
      },
      onClose: () => {
        if (!answered) resolve(false);
        answered = true;
      },
    });
  });
}

export function confirmByName(question: string, name: string, okLabel = "Usuń"): Promise<boolean> {
  return confirmDialog(question, okLabel, true, name);
}

// Small status message; errors are announced as alerts. An action adds a button that runs once.
export function toast(message: string, error = false, action?: { label: string; run: () => void }): void {
  let region = document.querySelector<HTMLElement>(".toasts");
  if (!region) {
    region = document.createElement("div");
    region.className = "toasts";
    document.body.append(region);
  }
  const el = document.createElement("div");
  el.className = `toast${error ? " is-error" : ""}`;
  el.setAttribute("role", error ? "alert" : "status");
  el.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.remove();
      action.run();
    });
    el.append(" ", btn);
  }
  region.append(el);
  setTimeout(() => el.remove(), 4000);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A dialog with one name field: `problem` says why a name is refused (shown under the field), or null to accept it.
 * Resolves with the trimmed name, or null when cancelled. */
export function askName(title: string, label: string, problem: (name: string) => string | null, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value: string | null, close: () => void) => {
      answered = true;
      resolve(value);
      close();
    };
    openDialog({
      label: title,
      className: "modal-confirm",
      render(box, close) {
        const heading = document.createElement("h2");
        heading.textContent = title;
        const input = document.createElement("input");
        input.className = "task-input";
        input.type = "text";
        input.value = initial;
        input.setAttribute("aria-label", label);
        const error = document.createElement("p");
        error.className = "firstrun-error";
        error.setAttribute("role", "alert");
        const actions = document.createElement("div");
        actions.className = "modal-actions";
        const cancel = document.createElement("button");
        cancel.className = "btn";
        cancel.type = "button";
        cancel.textContent = "Anuluj";
        cancel.addEventListener("click", () => finish(null, close));
        const ok = document.createElement("button");
        ok.className = "btn btn-primary";
        ok.type = "button";
        ok.textContent = "Utwórz";
        ok.addEventListener("click", () => {
          const why = problem(input.value);
          if (why) error.textContent = why;
          else finish(input.value.trim(), close);
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            ok.click();
          }
        });
        actions.append(cancel, ok);
        box.append(heading, input, error, actions);
        input.focus();
      },
      onClose: () => {
        if (!answered) resolve(null);
        answered = true;
      },
    });
  });
}
