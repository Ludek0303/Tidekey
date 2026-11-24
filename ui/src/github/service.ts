// The contract between the GitHub screens and the code that talks to GitHub, the bridge and the server.
// The browser bridge provides the implementation; tests and the demo use a fake one.
import type { GithubFile, GithubLink } from "./link";

export interface RepoPreview {
  repo: string;             // "właściciel/repo"
  ref: string | null;       // from the address (…/tree/<ref>/…), null = default branch
  repoPath: string;         // from the address, "" = the whole repository
  defaultBranch: string;
  private: boolean;
  markdownFiles: number;    // after the limits of GITHUB.md §6
  totalBytes: number;
  skipped: number;          // files over the limits or with bad paths
}

export interface ConnectOptions {
  repo: string;
  ref: string | null;
  repoPath: string;
  target: string;           // "GitHub" or "GitHub/<repo>", relative to the project folder
  onDelete: "keep" | "trash";
  allowEdits: boolean;
}

export interface GithubConflict {
  ours: string;             // the note's text now
  theirs: string;           // GitHub's new version
  commit: string;           // sha of GitHub's version
}

export interface GithubService {
  /** Checks an address: the parsed repository and what an import would bring, or a message for the user. */
  preview(address: string): Promise<{ ok: true; value: RepoPreview } | { ok: false; message: string }>;
  /** Creates the link and runs the first import. */
  connect(projectPath: string, options: ConnectOptions): Promise<GithubLink>;
  /** The links of a project (not the removed ones). */
  links(projectPath: string): Promise<GithubLink[]>;
  /** "Sprawdź teraz": runs one update; resolves with the link's status text after it. */
  checkNow(linkId: string): Promise<string>;
  /** Saves changed settings of a link (target, onDelete, allowEdits, ref, repoPath). */
  saveSettings(link: GithubLink): Promise<void>;
  /** "Odłącz": the notes stay as plain notes of the project. */
  disconnect(linkId: string): Promise<void>;
  /** "Przywróć z GitHuba": takes a path out of `ignored`; the next update brings the file back. */
  restoreIgnored(linkId: string, path: string): Promise<void>;
  /** "Zostaw jako własną": the note stops following GitHub; its path goes to `ignored`, so the next update does not bring it back. */
  detachNote(noteId: string): Promise<void>;
  /** The link and file a note comes from, or null for a plain note. */
  noteInfo(noteId: string): Promise<{ link: GithubLink; file: GithubFile } | null>;
  /** GitHub's last applied text of the note ("Moje dopiski" compares the note with it), or null when not archived. */
  baseText(noteId: string): Promise<string | null>;
  /** The conflict waiting on a note, or null. */
  conflict(noteId: string): Promise<GithubConflict | null>;
  /** Saves the chosen text; GitHub's version becomes the new base and the file updates again. */
  resolveConflict(noteId: string, text: string): Promise<void>;
  /** Whether this user has a GitHub token saved (the token itself never leaves the service). */
  hasToken(): boolean;
  /** Saves (or with null removes) the user's personal token, in the encrypted account settings. */
  setToken(token: string | null): Promise<void>;
}

/** The web address of a repository, a branch or a file on GitHub, for "Otwórz na GitHubie". */
export function githubUrl(repo: string, ref?: string | null, path?: string): string {
  const base = `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}`;
  if (!ref) return base;
  const refPart = ref.split("/").map(encodeURIComponent).join("/");
  return path ? `${base}/blob/${refPart}/${path.split("/").map(encodeURIComponent).join("/")}` : `${base}/tree/${refPart}`;
}

// The service of the open vault: set by the browser bridge when it opens a shared vault, null elsewhere (desktop, demo).
let current: GithubService | null = null;
export function setGithubService(service: GithubService | null): void { current = service; }
export function githubService(): GithubService | null { return current; }
