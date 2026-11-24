//! The GitHub part of a project's screen (GITHUB.md §2, point 6): one row per link with its state and buttons.
//! The windows it opens are in connect-view.ts. Styles: github.css.

import { el } from "../dom";
import { confirmDialog, errorText, toast } from "../widgets";
import { openSettingsDialog } from "./connect-view";
import type { GithubLink } from "./link";
import { type GithubService, githubUrl } from "./service";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long ago, in Polish: "przed chwilą", "5 min temu", "2 h temu", "3 d temu". */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < MINUTE) return "przed chwilą";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min temu`;
  if (diff < 24 * HOUR) return `${Math.floor(diff / HOUR)} h temu`;
  return `${Math.floor(diff / (24 * HOUR))} d temu`;
}

/** The web address of a link's folder on GitHub, or of the whole repository. */
function linkUrl(link: GithubLink): string {
  if (!link.repoPath) return githubUrl(link.repo, link.ref);
  return `${githubUrl(link.repo, link.ref ?? link.defaultBranch ?? "HEAD")}/${link.repoPath.split("/").map(encodeURIComponent).join("/")}`;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const btn = el("button", "btn", label);
  btn.type = "button";
  btn.addEventListener("click", run);
  return btn;
}

/** Draws the links of a project into `host`; nothing at all when the project has none. */
export async function renderGithubStatus(host: HTMLElement, projectPath: string, service: GithubService): Promise<void> {
  const links = await service.links(projectPath).catch(() => null);
  host.replaceChildren();
  if (links === null) {
    host.append(el("p", "muted", "Nie udało się wczytać połączeń z GitHubem."));
    return;
  }
  const again = () => void renderGithubStatus(host, projectPath, service);
  for (const link of links) host.append(linkRow(link, service, again));
}

function linkRow(link: GithubLink, service: GithubService, again: () => void): HTMLElement {
  const row = el("article", "gh-link-row");
  const when = link.lastAppliedAt === null ? "jeszcze nie zaimportowano" : relativeTime(link.lastAppliedAt);
  const parts = [`GitHub: ${link.repo}${link.repoPath ? `/${link.repoPath}` : ""}`, link.ref ?? link.defaultBranch ?? "domyślna gałąź", link.lastCommit?.slice(0, 7), when];
  row.append(el("p", "gh-line", parts.filter(Boolean).join(" · ")), el("p", "muted", link.target ? `Folder w projekcie: ${link.target}` : "Pliki leżą prosto w folderze projektu."));
  if (link.status !== "ok") {
    const status = el("p", "gh-status is-warning", link.status);
    status.setAttribute("role", "status");
    row.append(status);
  }

  const check = button("Sprawdź teraz", async () => {
    check.disabled = true;
    check.textContent = "Sprawdzam…";
    try {
      await service.checkNow(link.id);
    } catch (e) {
      toast(errorText(e), true);
    }
    again();
  });
  const disconnect = button("Odłącz", async () => {
    if (!(await confirmDialog("Notatki zostaną jako zwykłe notatki projektu i przestaną się aktualizować.", "Odłącz"))) return;
    try {
      await service.disconnect(link.id);
      toast("Połączenie odłączone.");
      again();
    } catch (e) {
      toast(errorText(e), true);
    }
  });
  const actions = el("div", "org-actions gh-actions");
  actions.append(
    check,
    button("Otwórz na GitHubie", () => {
      window.open(linkUrl(link), "_blank", "noopener,noreferrer");
    }),
    button("Ustawienia", () => {
      void openSettingsDialog(link, service).then((saved) => {
        if (saved) again();
      });
    }),
    disconnect,
  );
  row.append(actions);
  return row;
}
