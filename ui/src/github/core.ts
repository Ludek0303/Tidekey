// Typed wrappers over the GitHub logic of crates/core (through crates/web/src/github.rs). Pure: no network, no
// tokens. The wasm module must be loaded first (`initGithubCore()`, or the formula engine's init, which shares it).
import * as Y from "yjs";
import init, {
  github_blob_sha1,
  github_guarded_lines,
  github_is_markdown,
  github_merge3,
  github_normalize_path,
  github_parse_repo_url,
  github_plan,
  github_strip_markers,
  text_edits,
} from "../wasm/notes_web.js";

export interface RepoAddress {
  owner: string;
  repo: string;
  gitRef: string | null;
  path: string;
}

/** One range change: at `at` (UTF-16 units) delete `delete` units, then insert `insert`. */
export interface TextEdit {
  at: number;
  delete: number;
  insert: string;
}

export type Merge = { clean: string } | { conflict: true };

export interface TrackedFile {
  noteId: string;
  path: string;
  blobSha: string;
  hasEdits: boolean;
}

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

export type SkipReason = "ignored" | "tooLarge" | "limitFiles" | "limitTotal";

export type PlanAction =
  | { kind: "create"; path: string; blobSha: string }
  | { kind: "update"; noteId: string; path: string; blobSha: string }
  | { kind: "move"; noteId: string; from: string; to: string; blobSha: string }
  | { kind: "markDeleted"; noteId: string }
  | { kind: "trash"; noteId: string }
  | { kind: "skip"; path: string; reason: SkipReason };

export type PlanResult = { ok: true; actions: PlanAction[] } | { ok: false; error: string };

let loaded: Promise<unknown> | null = null;

/** Loads the wasm module. Shares the load with the formula engine: wasm-bindgen returns the loaded module again. */
export async function initGithubCore(): Promise<void> {
  loaded ??= init().catch((e: unknown) => {
    loaded = null;
    throw e;
  });
  await loaded;
}

// The wasm side returns JSON built in Rust, so the shape is trusted here.
function parse<T>(json: string): T {
  return JSON.parse(json) as T;
}

/** `null` for anything that is not a github.com address. */
export function parseRepoUrl(input: string): RepoAddress | null {
  const json = github_parse_repo_url(input);
  return json === undefined ? null : parse<RepoAddress>(json);
}

/** The git blob id of the bytes, as the GitHub tree lists it. */
export function blobSha1(bytes: Uint8Array): string {
  return github_blob_sha1(bytes);
}

/** The path inside the folder `root`, or `null` when the file lies outside it. */
export function normalizeRepoPath(path: string, root: string): string | null {
  return github_normalize_path(path, root) ?? null;
}

export function isMarkdownPath(path: string): boolean {
  return github_is_markdown(path);
}

/** Three-way merge of the base, the note and the GitHub text, line by line. */
export function merge3(base: string, ours: string, theirs: string): Merge {
  return parse<Merge>(github_merge3(base, ours, theirs));
}

/** The text without the permission markers that GitHub text must not set, and how many lines were removed. */
export function stripMarkers(text: string): { text: string; removed: number } {
  return parse<{ text: string; removed: number }>(github_strip_markers(text));
}

/** Short hashes of the task and `@mention` lines, to check that GitHub did not change what the user added. */
export function guardedLines(text: string): string[] {
  return parse<string[]>(github_guarded_lines(text));
}

/** The actions of an update, from the tracked notes, the new tree and the ignored paths. */
export function planUpdate(
  tracked: TrackedFile[],
  tree: TreeEntry[],
  ignored: string[],
  trashOnDelete: boolean,
): PlanResult {
  const out = parse<PlanAction[] | { error: string }>(
    github_plan(JSON.stringify(tracked), JSON.stringify(tree), JSON.stringify(ignored), trashOnDelete),
  );
  return Array.isArray(out) ? { ok: true, actions: out } : { ok: false, error: out.error };
}

/** The smallest edits that turn `old` into `new`, to apply in order (each `at` counts after the edits before it). */
export function textEdits(old: string, next: string): TextEdit[] {
  return parse<TextEdit[]>(text_edits(old, next));
}

/** Applies the edits to a Y.Text in one transaction, so other writers' cursors stay where they are. */
export function applyTextEdits(text: Y.Text, edits: TextEdit[]): void {
  const run = (): void => {
    for (const e of edits) {
      if (e.delete > 0) text.delete(e.at, e.delete);
      if (e.insert) text.insert(e.at, e.insert);
    }
  };
  if (text.doc) text.doc.transact(run);
  else run();
}

/** Makes the note's text `next`, touching only what changed. One transaction with origin "github". */
export function replaceText(doc: Y.Doc, next: string): void {
  const text = doc.getText("content");
  const edits = textEdits(text.toString(), next);
  if (edits.length === 0) return;
  doc.transact(() => applyTextEdits(text, edits), "github");
}
