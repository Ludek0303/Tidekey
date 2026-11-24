// The conflict screen for a note that GitHub and the user both changed (GITHUB.md §8): the same screen as for Obsidian.
import { openConflictScreen, type ConflictSource } from "../conflictview";
import { toast } from "../widgets";
import { githubService, type GithubService } from "./service";

/** Opens the comparison for note `noteId`; a resolved conflict only shows a message. */
export async function openGithubConflict(noteId: string, service: GithubService | null = githubService()): Promise<void> {
  // without a service (desktop, demo) the GitHub functions are not shown, so there is nothing to open
  if (!service) return;
  const conflict = await service.conflict(noteId);
  if (!conflict) {
    toast("Ten konflikt jest już rozwiązany.");
    return;
  }
  const source: ConflictSource = {
    title: "Konflikt z GitHubem",
      intro: "Na GitHubie i w notatniku zmieniono ten sam fragment. Wybierz, która wersja zostaje. Dopiski na końcu pliku zachowasz, wybierając fragmenty i „Zastosuj wybór”.",
    labels: { ours: "Notatnik", theirs: `GitHub (${conflict.commit.slice(0, 7)})` },
    buttons: { ours: "Zostaw wersję z notatnika", theirs: "Weź wersję z GitHuba" },
    texts: async () => ({ ours: conflict.ours, theirs: conflict.theirs }),
    // a failure is shown by the screen, which stays open
    resolve: async (text) => {
      await service.resolveConflict(noteId, text);
      toast("Zapisano. Plik znowu aktualizuje się z GitHuba.");
    },
  };
  await openConflictScreen(source, () => {});
}
