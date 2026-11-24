// The bar above a note that comes from GitHub (GITHUB.md §2 point 7, §8): where the note comes from, its state, the
// conflict, and "Moje dopiski", which shows only what the user added. Text from GitHub goes in as textContent only.
import { el } from "../dom";
import { blocks } from "../linediff";
import { confirmDialog, errorText, openDialog, toast } from "../widgets";
import { githubUrl, type GithubService } from "./service";
import type { GithubFile, GithubLink } from "./link";

export interface GithubBarOptions {
  /** The open note's text now, as the editor has it. */
  currentText(): string;
  /** "Rozwiąż konflikt" was pressed for this note. */
  onConflict?(noteId: string): void;
}

const TIP_KEY = (noteId: string) => `notes.githubTip.${noteId}`;

// The tip opens by itself once per note; localStorage can be blocked, and then the tip just opens every time.
function tipSeen(noteId: string): boolean {
  try {
    return localStorage.getItem(TIP_KEY(noteId)) !== null;
  } catch {
    return false;
  }
}

function markTipSeen(noteId: string): void {
  try {
    localStorage.setItem(TIP_KEY(noteId), "1");
  } catch {
    // no storage: nothing to remember
  }
}

/** The bar goes above the editor and the reading view (like the folder bar); it is hidden when neither is shown. */
export function mountGithubBar(
  editorHost: HTMLElement,
  readingHost: HTMLElement,
  service: () => GithubService | null,
  opts: GithubBarOptions,
): { show(noteId: string | null): Promise<void> } {
  const bar = el("div", "github-bar");
  bar.hidden = true;
  editorHost.before(bar);

  const place = (): void => {
    bar.hidden = bar.childElementCount === 0 || (editorHost.hidden && readingHost.hidden);
  };
  new MutationObserver(place).observe(editorHost, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(place).observe(readingHost, { attributes: true, attributeFilter: ["hidden"] });

  // Each show gets a number; an answer that comes back after a newer show is dropped.
  let latest = 0;

  async function show(noteId: string | null): Promise<void> {
    const call = ++latest;
    const svc = service();
    let info: Awaited<ReturnType<GithubService["noteInfo"]>> = null;
    if (noteId && svc) {
      try {
        info = await svc.noteInfo(noteId);
      } catch {
        info = null;
      }
    }
    if (call !== latest) return;
    if (!noteId || !svc || !info) {
      bar.replaceChildren();
    } else {
      bar.replaceChildren(...barContent(noteId, info.link, info.file, svc));
    }
    place();
  }

  function barContent(noteId: string, link: GithubLink, file: GithubFile, svc: GithubService): HTMLElement[] {
    const sha = link.lastCommit?.slice(0, 7);
    const tail = link.allowEdits ? "Twoje dopiski zostają przy aktualizacjach" : "czysta kopia tylko do odczytu";
    const row = el("div", "github-bar-row");
    row.append(el("span", "github-bar-text", `Z GitHuba: ${file.path}${sha ? ` · ${sha}` : ""} — ${tail}`));
    if (file.deleted) row.append(el("span", "github-bar-deleted", "Usunięty z GitHuba"));

    const mine = el("button", "github-bar-btn", "Moje dopiski");
    mine.type = "button";
    mine.addEventListener("click", () => openMine(noteId, svc));
    const path = link.repoPath ? `${link.repoPath}/${file.path}` : file.path;
    const open = el("a", "github-bar-btn", "Otwórz na GitHubie");
    open.href = githubUrl(link.repo, link.ref ?? link.lastCommit, path);
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    const leave = el("button", "github-bar-btn", "Zostaw jako własną");
    leave.type = "button";
    leave.addEventListener("click", () => void detach(noteId, svc));
    row.append(mine, open, leave);

    const out: HTMLElement[] = [row];
    if (file.conflict) {
      const warn = el("div", "github-bar-conflict");
      warn.append(
        el("span", "", `Konflikt z GitHubem (${file.conflict.commit.slice(0, 7)}): ten plik nie aktualizuje się, dopóki nie wybierzesz wersji.`),
      );
      const resolve = el("button", "github-bar-btn", "Rozwiąż konflikt");
      resolve.type = "button";
      resolve.addEventListener("click", () => opts.onConflict?.(noteId));
      warn.append(resolve);
      out.push(warn);
    }
    out.push(tip(noteId));
    return out;
  }

  function tip(noteId: string): HTMLElement {
    const box = el("details", "github-bar-tip");
    box.append(
      el("summary", "", "Wskazówka: dopiski i konflikty"),
      el("p", "", "Dopiski na końcu pliku, w osobnym akapicie albo w callout > [!note] Moje prawie nigdy nie tworzą konfliktów. Obszerne notatki najlepiej trzymać obok, w zwykłych notatkach projektu, z linkiem do tego pliku."),
    );
    if (!tipSeen(noteId)) {
      box.open = true;
      markTipSeen(noteId);
    }
    return box;
  }

  // "Zostaw jako własną": the note stops following GitHub; the file on GitHub stays as it is.
  async function detach(noteId: string, svc: GithubService): Promise<void> {
    if (!(await confirmDialog("Ta notatka przestanie się aktualizować z GitHuba i zostanie Twoją zwykłą notatką. Plik na GitHubie się nie zmieni.", "Zostaw jako własną", false))) return;
    try {
      await svc.detachNote(noteId);
      toast("Notatka jest teraz Twoja.");
      await show(noteId);
    } catch (e) {
      toast(errorText(e), true);
    }
  }

  // "Moje dopiski": the diff of the note against GitHub's archived text, so only what the user added (or changed) shows.
  function openMine(noteId: string, svc: GithubService): void {
    const current = opts.currentText();
    openDialog({
      label: "Moje dopiski",
      className: "github-mine",
      render(box, close) {
        const body = el("div", "github-mine-body", "Wczytywanie…");
        const done = el("button", "btn", "Zamknij");
        done.type = "button";
        done.addEventListener("click", close);
        box.append(el("h2", "github-mine-title", "Moje dopiski"), body, done);
        svc.baseText(noteId).then(
          (base) => body.replaceChildren(base === null ? el("p", "", "Brak wersji z GitHuba w archiwum.") : diffView(base, current)),
          () => body.replaceChildren(el("p", "", "Nie udało się wczytać wersji z GitHuba.")),
        );
      },
    });
  }

  return { show };
}

// Only the user's lines: added ones, and ones changed against GitHub (named so, not as plain additions).
function diffView(base: string, current: string): HTMLElement {
  const out = el("div", "github-mine-diff");
  let any = false;
  for (const block of blocks(current, base)) {
    if ("same" in block) continue;
    any = true;
    if (block.theirs.length === 0) {
      out.append(el("div", "github-diff-label", "dopisane"));
      for (const line of block.ours) out.append(el("div", "github-diff-line github-diff-add", line || " "));
    } else {
      out.append(el("div", "github-diff-label", "zmienione względem GitHuba"));
      if (block.ours.length === 0) out.append(el("div", "github-diff-note", "usunięto fragment z wersji GitHuba"));
      for (const line of block.ours) out.append(el("div", "github-diff-line github-diff-change", line || " "));
    }
  }
  if (!any) return el("p", "", "Nie ma dopisków: notatka jest taka sama jak na GitHubie.");
  return out;
}
