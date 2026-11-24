//! The GitHub windows of a project (GITHUB.md §2, §7): the connect window with its preview, the settings of a link and the
//! token window. The service does the work (service.ts); this file reads the fields and shows what comes back.
//! Styles: github.css.

import { el } from "../dom";
import { formatSize } from "../filestore";
import { errorText, openDialog, toast } from "../widgets";
import type { GithubLink } from "./link";
import type { ConnectOptions, GithubService, RepoPreview } from "./service";

export interface LinkSettings {
  ref: string | null;
  repoPath: string;
  target: string;
  onDelete: "keep" | "trash";
  allowEdits: boolean;
}

/** A typed folder without the slashes at its ends: "/docs/" is "docs". */
export const cleanPath = (path: string): string => path.trim().replace(/^\/+|\/+$/g, "");

/** Why a folder cannot be used (the rules of link.ts: no "..", "\", ":" or control characters), or null. An empty path is
 *  allowed only when `allowEmpty` (the whole repository). */
export function folderError(path: string, allowEmpty: boolean): string | null {
  const p = cleanPath(path);
  if (p === "") return allowEmpty ? null : "Podaj nazwę folderu.";
  if (/[\\:\u0000-\u001f\u007f]/.test(p)) return "Nazwa folderu nie może zawierać znaków \\ ani : (dwukropka).";
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return "Folder nie może zawierać „..” ani pustych części.";
  return null;
}

let formSeq = 0;

function textField(text: string, value: string, placeholder: string, hint: string): { label: HTMLElement; input: HTMLInputElement } {
  const input = el("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  const label = el("label", "gh-field");
  label.append(el("span", "", text), input, el("small", "muted", hint));
  return { label, input };
}

// A radio group; `hint` is a one-line description under an option. A hidden legend still names the group for screen readers.
function choiceGroup(legend: string, name: string, options: [value: string, text: string, checked: boolean, hint?: string][], legendVisible = true): { node: HTMLElement; value: () => string } {
  const node = el("fieldset", "gh-choices");
  const title = el("legend", legendVisible ? "" : "sr-only", legend);
  node.append(title);
  const inputs = options.map(([value, text, checked, hint]) => {
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = checked;
    const label = el("label", "gh-choice");
    label.append(input, text);
    node.append(label);
    if (hint) node.append(el("small", "muted gh-choice-hint", hint));
    return input;
  });
  return { node, value: () => inputs.find((i) => i.checked)?.value ?? options[0][0] };
}

interface SettingsForm {
  node: HTMLElement;
  branch: HTMLInputElement;
  repoPath: HTMLInputElement;
  target: HTMLInputElement;
  /** The settings as typed, or the first problem with them (the section opens to show it). */
  read(): { ok: true; value: LinkSettings } | { ok: false; message: string };
}

/** The settings: the mode first (linked or read-only), then the "Ustawienia" section with branch, subfolder, folder and what
 *  happens to deleted files. `folder` = the connection from a folder's menu: its files may go straight into that folder. */
function settingsForm(v: LinkSettings, folder: boolean): SettingsForm {
  const seq = ++formSeq;
  const mode = choiceGroup("Tryb połączenia", `gh-mode-${seq}`, [
    ["yes", "Połączone z GitHubem", v.allowEdits, "Notatki aktualizują się z GitHuba, a Twoje dopiski w nich zostają."],
    ["no", "Tylko odczyt", !v.allowEdits, "Wierna kopia z GitHuba. Zmieniasz ją tylko na GitHubie."],
  ], false);
  const branch = textField("Gałąź", v.ref ?? "", "domyślna gałąź", "Puste = domyślna gałąź repozytorium; śledzi jej zmianę.");
  const repoPath = textField("Podfolder repozytorium", v.repoPath, "całe repozytorium", "Tylko ten folder z repozytorium.");
  const targetName = folder ? "Folder na pliki z GitHuba" : "Folder w projekcie";
  const target = folder
    ? textField(targetName, v.target, "ten folder", "Puste: pliki trafiają prosto do tego folderu, obok Twoich notatek.")
    : textField(targetName, v.target, "GitHub", "Folder w projekcie, w którym powstają notatki.");
  const onDelete = choiceGroup("Plik usunięty na GitHubie", `gh-delete-${seq}`, [
    ["keep", "Zostaje w notatniku z oznaczeniem", v.onDelete === "keep"],
    ["trash", "Do kosza", v.onDelete === "trash"],
  ]);
  const details = el("details", "gh-settings");
  details.append(el("summary", "", "Ustawienia"), branch.label, repoPath.label, target.label, onDelete.node);
  const node = el("div");
  node.append(mode.node, details);
  return {
    node,
    branch: branch.input,
    repoPath: repoPath.input,
    target: target.input,
    read() {
      const targetBad = folderError(target.input.value, folder);
      const repoBad = folderError(repoPath.input.value, true);
      if (targetBad || repoBad) {
        details.open = true;
        return { ok: false, message: targetBad ? `${targetName}: ${targetBad}` : `Podfolder repozytorium: ${repoBad}` };
      }
      return {
        ok: true,
        value: {
          ref: branch.input.value.trim() || null,
          repoPath: cleanPath(repoPath.input.value),
          target: cleanPath(target.input.value),
          onDelete: onDelete.value() === "trash" ? "trash" : "keep",
          allowEdits: mode.value() === "yes",
        },
      };
    },
  };
}

function previewCard(p: RepoPreview): HTMLElement {
  const box = el("dl", "gh-preview-card");
  const rows: [string, string][] = [
    ["Repozytorium", p.repo],
    ["Gałąź", p.ref ?? `${p.defaultBranch} (domyślna)`],
    ["Widoczność", p.private ? "prywatne" : "publiczne"],
    ["Pliki Markdown", String(p.markdownFiles)],
    ["Łączny rozmiar", formatSize(p.totalBytes)],
  ];
  if (p.skipped > 0) rows.push(["Pominięte", String(p.skipped)]);
  for (const [term, value] of rows) box.append(el("dt", "", term), el("dd", "", value));
  return box;
}

/** The connect window. A non-empty `address` (typed on "Nowy projekt") is checked at once. `folder` (the folder's menu) leaves
 *  the folder field empty: the files go straight into the folder. Resolves with the new link, or null. */
export async function openConnectDialog(projectPath: string, service: GithubService, address = "", opts: { folder?: boolean } = {}): Promise<GithubLink | null> {
  const folder = opts.folder === true;
  // A project that already has a link gets the folder "GitHub/<repo>", so a second repository does not mix with the first.
  const existing = await service.links(projectPath).then((links) => links.length, () => 0);
  return new Promise((resolve) => {
    let answered = false;
    const finish = (link: GithubLink | null, close: () => void) => {
      answered = true;
      resolve(link);
      close();
    };
    openDialog({
      label: "Połącz z GitHubem",
      className: "modal-confirm gh-dialog",
      render(box, close) {
        const heading = el("h2", "", "Połącz z GitHubem");
        const hintId = `gh-hint-${++formSeq}`;
        const addr = el("input");
        addr.type = "text";
        addr.value = address;
        addr.placeholder = "https://github.com/właściciel/repo";
        addr.autocomplete = "off";
        addr.spellcheck = false;
        addr.setAttribute("aria-describedby", hintId);
        const addrLabel = el("label", "gh-field");
        addrLabel.append(el("span", "", "Adres repozytorium"), addr);
        const hint = el("small", "muted", "Rozumiane formy: https://github.com/właściciel/repo, właściciel/repo, …/tree/gałąź/podfolder, …/blob/gałąź/plik.md (bierze się wtedy cały folder pliku).");
        hint.id = hintId;
        const check = el("button", "btn", "Sprawdź");
        check.type = "button";
        const row = el("div", "gh-address-row");
        row.append(addrLabel, check);
        const card = el("div", "gh-preview");
        card.setAttribute("aria-live", "polite");
        const error = el("p", "firstrun-error");
        error.setAttribute("role", "alert");

        const form = settingsForm({ ref: null, repoPath: "", target: folder ? "" : "GitHub", onDelete: "keep", allowEdits: true }, folder);
        let preview: RepoPreview | null = null;
        // The folder follows the repository until the user types their own.
        let targetTouched = false;
        form.target.addEventListener("input", () => { targetTouched = true; });

        const info = el("p", "muted", "Zmiany sprawdzane co 15 min (co 5 min z tokenem), gdy aplikacja jest otwarta. ");
        const tokenButton = el("button", "gh-link", "Dodaj token GitHuba");
        tokenButton.type = "button";
        tokenButton.addEventListener("click", () => openTokenDialog(service));
        info.append(tokenButton);

        const spinner = el("span", "gh-spinner");
        spinner.setAttribute("aria-hidden", "true");
        const busy = el("p", "gh-busy muted");
        busy.setAttribute("role", "status");
        busy.append(spinner, " Importuję notatki z GitHuba…");
        busy.hidden = true;

        const cancel = el("button", "btn", "Anuluj");
        cancel.type = "button";
        cancel.addEventListener("click", () => finish(null, close));
        const ok = el("button", "btn btn-primary", "Importuj");
        ok.type = "button";
        ok.disabled = true;
        const actions = el("div", "modal-actions");
        actions.append(cancel, ok);

        const setBusy = (on: boolean) => {
          busy.hidden = !on;
          ok.disabled = on;
          check.disabled = on;
          cancel.disabled = on;
        };

        const checkAddress = async () => {
          preview = null;
          ok.disabled = true;
          error.textContent = "";
          card.replaceChildren();
          check.disabled = true;
          check.textContent = "Sprawdzam…";
          try {
            const result = await service.preview(addr.value.trim());
            if (!result.ok) {
              error.textContent = result.message;
              return;
            }
            preview = result.value;
            card.replaceChildren(previewCard(preview));
            // The address's branch and folder fill the settings; without them the typed values stay.
            if (preview.ref !== null) form.branch.value = preview.ref;
            if (preview.repoPath) form.repoPath.value = preview.repoPath;
            if (!targetTouched && !folder) form.target.value = existing ? `GitHub/${preview.repo.split("/")[1]}` : "GitHub";
            ok.disabled = false;
          } catch (e) {
            error.textContent = errorText(e);
          } finally {
            check.disabled = false;
            check.textContent = "Sprawdź";
          }
        };

        check.addEventListener("click", () => void checkAddress());
        addr.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void checkAddress();
        });
        // A changed address needs a new check before the import.
        addr.addEventListener("input", () => {
          preview = null;
          ok.disabled = true;
        });
        ok.addEventListener("click", () => {
          const read = form.read();
          if (!preview) return;
          if (!read.ok) {
            error.textContent = read.message;
            return;
          }
          const s = read.value;
          const options: ConnectOptions = { repo: preview.repo, ref: s.ref, repoPath: s.repoPath, target: s.target, onDelete: s.onDelete, allowEdits: s.allowEdits };
          error.textContent = "";
          setBusy(true);
          service.connect(projectPath, options).then(
            (link) => {
              toast("Notatki z GitHuba zaimportowane.");
              finish(link, close);
            },
            (e: unknown) => {
              error.textContent = errorText(e);
              setBusy(false);
            },
          );
        });

        box.append(heading, row, hint, card, error, form.node, info, busy, actions);
        if (address) void checkAddress();
      },
      onClose: () => {
        if (!answered) resolve(null);
        answered = true;
      },
    });
  });
}

/** The settings window of a link: the same fields as the connect window, without the address, and the ignored files with a
 *  button that brings each back. Resolves true when the settings were saved. */
export function openSettingsDialog(link: GithubLink, service: GithubService): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (saved: boolean, close: () => void) => {
      answered = true;
      resolve(saved);
      close();
    };
    openDialog({
      label: `Ustawienia: ${link.repo}`,
      className: "modal-confirm gh-dialog",
      render(box, close) {
        const form = settingsForm({ ref: link.ref, repoPath: link.repoPath, target: link.target, onDelete: link.onDelete, allowEdits: link.allowEdits }, link.target === "");
        const error = el("p", "firstrun-error");
        error.setAttribute("role", "alert");
        // Files brought back here leave the saved list too, so the save cannot ignore them again.
        const restored = new Set<string>();
        const ignored = el("section", "gh-ignored");
        ignored.append(el("h3", "", "Pominięte pliki"));
        if (link.ignored.length === 0) ignored.append(el("p", "muted", "Nic nie jest pominięte."));
        for (const path of link.ignored) {
          const item = el("div", "gh-ignored-row");
          const restore = el("button", "btn", "Przywróć z GitHuba");
          restore.type = "button";
          restore.addEventListener("click", () => {
            restore.disabled = true;
            service.restoreIgnored(link.id, path).then(
              () => {
                restored.add(path);
                item.remove();
                toast("Plik wraca przy następnej aktualizacji.");
              },
              (e: unknown) => {
                restore.disabled = false;
                toast(errorText(e), true);
              },
            );
          });
          item.append(el("span", "", path), restore);
          ignored.append(item);
        }
        const cancel = el("button", "btn", "Anuluj");
        cancel.type = "button";
        cancel.addEventListener("click", () => finish(false, close));
        const save = el("button", "btn btn-primary", "Zapisz");
        save.type = "button";
        save.addEventListener("click", () => {
          const read = form.read();
          if (!read.ok) {
            error.textContent = read.message;
            return;
          }
          save.disabled = true;
          service.saveSettings({ ...link, ...read.value, ignored: link.ignored.filter((p) => !restored.has(p)) }).then(
            () => {
              toast("Ustawienia zapisane.");
              finish(true, close);
            },
            (e: unknown) => {
              error.textContent = errorText(e);
              save.disabled = false;
            },
          );
        });
        const actions = el("div", "modal-actions");
        actions.append(cancel, save);
        box.append(el("h2", "", `Ustawienia: ${link.repo}`), form.node, ignored, error, actions);
      },
      onClose: () => {
        if (!answered) resolve(false);
        answered = true;
      },
    });
  });
}

/** The token window: why a token, how to make a fine-grained one, and saving or removing it. A saved token is never shown. */
export function openTokenDialog(service: GithubService): void {
  openDialog({
    label: "Token GitHuba",
    className: "modal-confirm gh-dialog",
    render(box, close) {
      const input = el("input");
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Token GitHuba");
      const label = el("label", "gh-field");
      label.append(el("span", "", "Token"), input);
      const error = el("p", "firstrun-error");
      error.setAttribute("role", "alert");

      const steps = el("ol", "gh-steps");
      steps.append(
        el("li", "", "GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token."),
        el("li", "", "Repository access: Only select repositories. Wybierz tylko repozytoria, które chcesz połączyć."),
        el("li", "", "Permissions: Contents: Read-only. Nic więcej."),
        el("li", "", "Skopiuj token i wklej go poniżej."),
      );
      const page = el("a", "", "Otwórz stronę tworzenia tokenu");
      page.href = "https://github.com/settings/personal-access-tokens/new";
      page.target = "_blank";
      page.rel = "noopener noreferrer";

      const actions = el("div", "modal-actions");
      if (service.hasToken()) {
        const remove = el("button", "btn btn-danger", "Usuń token");
        remove.type = "button";
        remove.addEventListener("click", () => {
          service.setToken(null).then(
            () => {
              toast("Token usunięty.");
              close();
            },
            (e: unknown) => {
              error.textContent = errorText(e);
            },
          );
        });
        actions.append(remove);
      }
      const shut = el("button", "btn", "Zamknij");
      shut.type = "button";
      shut.addEventListener("click", () => close());
      const save = el("button", "btn btn-primary", "Zapisz token");
      save.type = "button";
      save.addEventListener("click", () => {
        const token = input.value.trim();
        if (!token) {
          error.textContent = "Wklej token.";
          return;
        }
        service.setToken(token).then(
          () => {
            input.value = "";
            toast("Token zapisany.");
            close();
          },
          (e: unknown) => {
            error.textContent = errorText(e);
          },
        );
      });
      actions.append(shut, save);

      box.append(
        el("h2", "", "Token GitHuba"),
        el("p", "muted", "Publiczne repozytoria działają bez tokenu. Token podnosi limity zapytań do GitHuba i jest potrzebny do prywatnych repozytoriów."),
        el("p", "muted", "Token jest osobisty: zapisany zaszyfrowany w Twoim koncie, nie trafia do projektu ani na serwer w jawnej postaci."),
        steps,
        page,
        label,
        error,
        actions,
      );
    },
  });
}
