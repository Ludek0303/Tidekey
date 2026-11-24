//! The first-run screen of the desktop app, also the space manager: the list of this device's spaces, the form
//! for a new space, the recovery phrase, and recovery. It is shown only when no space is open; `runFirstRun`
//! resolves once one is open.

import { errorText } from "./widgets";
import { KIND_LABEL, type SpaceItem, type SpaceKind } from "./spaces";

export type SpaceStatus = "none" | "open" | "needs_phrase";

// What the screen needs from the backend and the folder picker (see tauriFirstRun).
export interface FirstRunApi {
  status(): Promise<SpaceStatus>;
  // The device's spaces, newest first.
  spaces(): Promise<SpaceItem[]>;
  // Opens a listed space: "open", or "needs_phrase" when this device has no keys for it.
  openKnown(path: string): Promise<SpaceStatus>;
  // Removes a space from the list; its folder stays.
  forget(path: string): Promise<void>;
  // The folder the system dialog returned; null when it was cancelled.
  pickFolder(): Promise<string | null>;
  // The recovery words of the new space, which is named `name` inside the folder `path`.
  create(path: string, name: string): Promise<string[]>;
  // Sets the type of the space just created.
  setKind(kind: SpaceKind): Promise<void>;
  // The recovery words when the folder held no space and one was created; null when it was opened.
  open(path: string): Promise<string[] | null>;
  recover(path: string, words: string): Promise<void>;
  // The user confirmed that the phrase is saved: the backend remembers the new space's folder from now on.
  confirm(): Promise<void>;
}

// Words as the user typed them: any case and spacing.
export function splitWords(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Shows the screen in `root` until a space is open, then empties `root`. Returns at once when one already is.
export async function runFirstRun(root: HTMLElement, api: FirstRunApi): Promise<void> {
  // a remembered folder that cannot be opened is not a reason for a blank window: the choices come with the error
  let status: SpaceStatus = "none";
  let notice = "";
  try {
    status = await api.status();
  } catch (e) {
    notice = errorText(e);
  }
  if (status === "open") return;
  await new Promise<void>((done) => {
    const finish = () => {
      root.replaceChildren();
      done();
    };
    if (status === "needs_phrase") recoverView(root, api, false, finish);
    else void welcomeView(root, api, finish, notice);
  });
}

function view(root: HTMLElement, heading: string, lead: string): HTMLElement {
  const card = document.createElement("main");
  card.className = "firstrun";
  const h = document.createElement("h1");
  h.textContent = heading;
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = lead;
  card.append(h, p);
  root.replaceChildren(card);
  return card;
}

function button(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// The view's alert region: errors of the last action appear here, read out by screen readers.
function errorRegion(card: HTMLElement): HTMLElement {
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.className = "firstrun-error";
  card.append(alert);
  return alert;
}

// Runs `action`; a failure is shown in `alert`. Returns whether the action succeeded.
async function attempt(alert: HTMLElement, action: () => Promise<void>): Promise<boolean> {
  alert.textContent = "";
  try {
    await action();
    return true;
  } catch (e) {
    alert.textContent = errorText(e);
    return false;
  }
}

// The space manager: the list of this device's spaces, then the three actions.
async function welcomeView(root: HTMLElement, api: FirstRunApi, done: () => void, notice = ""): Promise<void> {
  const card = view(
    root,
    "Witaj w Notatkach",
    "Notatki są zapisywane w wybranym folderze jako zwykłe pliki .md. Wybierz przestrzeń albo utwórz nową.",
  );
  const alert = errorRegion(card);
  alert.textContent = notice;
  let listed: SpaceItem[] = [];
  try {
    listed = await api.spaces();
  } catch (e) {
    alert.textContent = errorText(e);
  }

  const list = document.createElement("section");
  list.className = "firstrun-spaces";
  const listHeading = document.createElement("h2");
  listHeading.textContent = "Twoje przestrzenie";
  // with no space yet there is no list, so no heading either
  list.hidden = listed.length === 0;
  list.append(listHeading);
  if (listed.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "space-list";
    listed.forEach((item, i) => ul.append(spaceRow(root, api, done, item, i === 0, alert)));
    list.append(ul);
  }
  const actions = document.createElement("div");
  actions.className = "firstrun-actions";

  const pick = (then: (path: string) => Promise<void>) => async () => {
    const path = await api.pickFolder();
    if (path) await attempt(alert, () => then(path));
  };
  const create = button("Utwórz przestrzeń", () => newSpaceView(root, api, done), "btn firstrun-primary");
  const openFolder = button(
    "Otwórz folder",
    pick(async (path) => {
      let words: string[] | null;
      try {
        words = await api.open(path);
      } catch (e) {
        // the folder's space is on another device's keys only: the phrase is the way in
        if (!needsPhrase(e)) throw e;
        recoverView(root, api, true, done, path, "Ta przestrzeń wymaga frazy odzyskiwania na tym komputerze.");
        return;
      }
      if (words) await phraseView(root, api, words, done);
      else done();
    }),
  );
  const recover = button("Odzyskaj frazą", () => recoverView(root, api, true, done));
  actions.append(create, openFolder, recover);
  card.append(list, actions);
  const firstOpen = list.querySelector<HTMLButtonElement>(".space-open:not(:disabled)");
  (firstOpen ?? create).focus();
}

// One row of the list: the name and folder open the space; a missing folder can only be removed from the list.
function spaceRow(root: HTMLElement, api: FirstRunApi, done: () => void, item: SpaceItem, last: boolean, alert: HTMLElement): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "space-row";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "space-open";
  open.disabled = !item.exists;
  const name = document.createElement("strong");
  name.textContent = item.name;
  const path = document.createElement("span");
  path.className = "muted";
  path.textContent = item.exists ? item.path : `${item.path} (folder nie istnieje)`;
  const badge = document.createElement("span");
  badge.className = `space-badge kind-${item.kind}`;
  badge.textContent = KIND_LABEL[item.kind];
  open.append(name, path);
  open.addEventListener("click", () =>
    void attempt(alert, async () => {
      const status = await api.openKnown(item.path);
      if (status === "needs_phrase") {
        recoverView(root, api, true, done, item.path, "Ta przestrzeń wymaga frazy odzyskiwania na tym komputerze.");
      } else {
        done();
      }
    }),
  );
  const meta = document.createElement("span");
  meta.className = "space-meta";
  meta.append(badge);
  if (last) {
    const recent = document.createElement("span");
    recent.className = "muted";
    recent.textContent = "ostatnio otwarta";
    meta.append(recent);
  }
  const remove = button("Usuń z listy", () =>
    void attempt(alert, async () => {
      await api.forget(item.path);
      await welcomeView(root, api, done);
    }),
    "btn space-forget",
  );
  // three rows have the same button text: the name tells them apart for a screen reader
  remove.setAttribute("aria-label", `Usuń z listy: ${item.name}`);
  li.append(open, meta, remove);
  return li;
}

// The form for a new space: its name, its type and the folder that holds it. The type is set right after creation.
function newSpaceView(root: HTMLElement, api: FirstRunApi, done: () => void): void {
  const card = view(root, "Nowa przestrzeń", "Przestrzeń to folder z notatkami. Nazwa stanie się nazwą folderu.");
  const alert = errorRegion(card);
  let chosen: string | null = null;

  const nameLabel = document.createElement("label");
  nameLabel.className = "firstrun-field";
  nameLabel.append("Nazwa");
  const name = document.createElement("input");
  name.type = "text";
  name.className = "firstrun-input";
  name.autocomplete = "off";
  nameLabel.append(name);

  const kind = document.createElement("fieldset");
  kind.className = "firstrun-field";
  const legend = document.createElement("legend");
  legend.textContent = "Typ przestrzeni";
  kind.append(legend);
  const radios: Record<SpaceKind, HTMLInputElement> = { notatki: radio("kind", "notatki", true), organizacja: radio("kind", "organizacja", false) };
  const hints: Record<SpaceKind, string> = {
    notatki: "Zwykłe notatki, jak w Obsidianie.",
    organizacja: "Notatki projektów z zadaniami, terminami i nadzorem zespołu.",
  };
  for (const k of ["notatki", "organizacja"] as const) {
    const label = document.createElement("label");
    label.className = "firstrun-radio";
    const title = document.createElement("span");
    title.textContent = KIND_LABEL[k];
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = hints[k];
    label.append(radios[k], title, hint);
    kind.append(label);
  }

  const folderLabel = document.createElement("p");
  folderLabel.className = "muted";
  folderLabel.textContent = "Nie wybrano folderu";
  const choose = button("Wybierz folder", async () => {
    const picked = await api.pickFolder();
    if (picked) {
      chosen = picked;
      folderLabel.textContent = picked;
    }
  });

  const create = button(
    "Utwórz",
    async () => {
      const title = name.value.trim();
      if (!title) alert.textContent = "Podaj nazwę przestrzeni.";
      else if (!chosen) alert.textContent = "Wybierz folder, w którym powstanie przestrzeń.";
      else {
        const folder = chosen;
        const selected = (Object.keys(radios) as SpaceKind[]).find((k) => radios[k].checked) ?? "notatki";
        let words: string[];
        try {
          words = await api.create(folder, title);
        } catch (e) {
          alert.textContent = errorText(e);
          return;
        }
        let typeError = "";
        if (selected !== "notatki") {
          try {
            await api.setKind(selected);
          } catch (e) {
            typeError = errorText(e);
          }
        }
        await phraseView(root, api, words, done, typeError);
      }
    },
    "btn firstrun-primary",
  );
  const actions = document.createElement("div");
  actions.className = "firstrun-actions";
  actions.append(choose, button("Anuluj", () => void welcomeView(root, api, done)), create);
  card.append(nameLabel, kind, folderLabel, actions);
  name.focus();
}

function radio(group: string, value: string, checked: boolean): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "radio";
  input.name = group;
  input.value = value;
  input.checked = checked;
  return input;
}

function needsPhrase(e: unknown): boolean {
  return (e as { kind?: unknown } | null)?.kind === "needs_phrase";
}

// The 24 words, shown once. Continuing needs the confirmation checkbox; the backend remembers the folder then.
function phraseView(root: HTMLElement, api: FirstRunApi, words: string[], done: () => void, notice = ""): Promise<void> {
  return new Promise((resolve) => {
    const card = view(
      root,
      "Fraza odzyskiwania",
      "To jedyny sposób odzyskania przestrzeni na innym komputerze. Zapisz 24 słowa w bezpiecznym miejscu.",
    );
    if (notice) errorRegion(card).textContent = notice;
    const warning = document.createElement("p");
    warning.className = "firstrun-warning";
    warning.textContent =
      "Aplikacja nie przechowuje tej frazy i nie pokaże jej ponownie. Bez niej utracisz dostęp do przestrzeni, jeśli stracisz wszystkie urządzenia.";
    const list = document.createElement("ol");
    list.className = "firstrun-words";
    for (const word of words) {
      const li = document.createElement("li");
      li.textContent = word;
      list.append(li);
    }
    const label = document.createElement("label");
    label.className = "firstrun-confirm";
    const check = document.createElement("input");
    check.type = "checkbox";
    label.append(check, " Zapisałem frazę");
    const next = button("Dalej", async () => {
      await api.confirm();
      done();
      resolve();
    }, "btn firstrun-primary");
    next.disabled = true;
    check.addEventListener("change", () => (next.disabled = !check.checked));
    card.append(warning, list, label, next);
    check.focus();
  });
}

// Recovery form: the phrase and the folder. `allowBack` is false when the phrase is the only way in. `folder`
// is the folder already chosen, and `notice` a line that explains why the form is shown.
function recoverView(
  root: HTMLElement,
  api: FirstRunApi,
  allowBack: boolean,
  done: () => void,
  folder: string | null = null,
  notice = "",
): void {
  const card = view(
    root,
    "Odzyskaj przestrzeń",
    "Podaj 24 słowa frazy odzyskiwania i folder, w którym leży przestrzeń.",
  );
  const alert = errorRegion(card);
  alert.textContent = notice;
  let chosen = folder;

  const folderLabel = document.createElement("p");
  folderLabel.className = "muted";
  folderLabel.textContent = chosen ?? "Nie wybrano folderu";
  const choose = button("Wybierz folder", async () => {
    const picked = await api.pickFolder();
    if (picked) {
      chosen = picked;
      folderLabel.textContent = picked;
    }
  });

  const area = document.createElement("textarea");
  area.rows = 4;
  area.setAttribute("aria-label", "Fraza odzyskiwania, 24 słowa");
  area.autocomplete = "off";
  area.spellcheck = false;

  const submit = button(
    "Odzyskaj",
    async () => {
      const words = splitWords(area.value);
      if (!chosen) {
        alert.textContent = "Wybierz folder przestrzeni.";
      } else if (words.length !== 24) {
        alert.textContent = `Fraza ma 24 słowa, a podano ${words.length}.`;
      } else if (await attempt(alert, () => api.recover(chosen!, words.join(" ")))) {
        done();
      }
    },
    "btn firstrun-primary",
  );

  const actions = document.createElement("div");
  actions.className = "firstrun-actions";
  actions.append(choose, submit);
  if (allowBack) actions.append(button("Wstecz", () => void welcomeView(root, api, done)));
  card.append(folderLabel, area, actions);
  area.focus();
}
