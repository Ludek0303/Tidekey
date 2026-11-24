// The MCP tools of docs/MCP.md §7 and §3.9. Every tool runs inside the chat's effective scope: the soft filter
// (include/exclude, tasks, tools) is applied before anything is read, and a path outside it gets the same answer
// whether or not it exists.
import { canonicalJson } from "../../ui/src/bridge";
import { blake2bHex, newNonce } from "../../ui/src/agentcrypto";
import { textHash } from "../../ui/src/proposals";
import { TOP_TEXT, ancestorsOf, landsTop } from "../../ui/src/protected";
import { isSharedVaultId } from "../../ui/src/vaults";
import { dayOf, isoOf, parseDay, parseLine, sameHandle, setTaskDone, setTaskField, type LineTask, type TaskField } from "../../ui/src/orgtasks";
import { newTaskId } from "./taskid";
import { AgentError, TEXT } from "./client";
import { cut, failure, hasMarker, hideLinks, page, READ_MAX, resolves, restoreLinks, result, rowsResult, SNIPPET, titleOf, wrap, wrapFile, type Row, type ToolResult } from "./present";
import { MapIndex, type VaultIndex } from "./mapindex";
import { pathKey, within, type NoteView, type Session, type VaultView } from "./session";
import type { LocalState } from "./state";
import { applyChange, checkMarks, route, type Change } from "./write";

export const READ_TOOLS = ["scope_info", "list_notes", "search", "read_note", "list_tasks"] as const;
export const WRITE_TOOLS = ["create_note", "append", "edit_note", "add_tasks", "set_task"] as const;
export const CONFIRM_TOOLS = ["move_note", "trash_note"] as const;
// The map tools (docs/OCR.md §5.1) read only what search reads, so they follow the search permission: a chat saved with
// an explicit tools list before they existed gets them with search.
export const MAP_TOOLS = ["map", "outline", "read", "neighbors", "find_files"] as const;
const HIDDEN_MARKER = /\u27e6ukryty link (\d+)\u27e7/g;
const FILE_EMBED_LINK = /^!\[\[plik:([0-9a-f]{32})/;
const EDGE_TYPES = ["link", "embed", "tag", "assigned", "in", "mention"];
const DEFAULT_TOOLS = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS]);
const CONFIRM_MS = 2 * 60_000;
const PAGE_MAX = 50;
// search pages at most this deep (cursor), so one call never ranks the whole index
const SEARCH_DEPTH = 500;
const MAP_ITEMS = 15;
const MODE_LABEL = { none: "tylko odczyt", proposals: "propozycje do zatwierdzenia", append: "tworzenie i dopisywanie", direct: "zmiany bezpośrednie" };
const T = {
  pickVault: "Ten czat ma kilka przestrzeni. Podaj pole vault (nazwa albo id z scope_info).",
  noTask: "Nie ma takiego zadania (albo jego id występuje kilka razy).",
  toolOff: "To narzędzie jest wyłączone w zakresie tego czatu.",
  stale: "Treść notatki zmieniła się od odczytu. Przeczytaj ją jeszcze raz (read_note) i podaj nowe expected.",
  dropsLink: "Ta zmiana usuwa albo zmienia ukryty link (znacznik ⟦ukryty link N⟧ z read_note). Zostaw każdy znacznik bez zmian.",
  foreignMarker: "Znacznik ⟦ukryty link N⟧ działa tylko w notatce, z której pochodzi, i tylko taki, jaki pokazał read_note.",
  cancelled: "Anulowano. Nic nie zmieniono.",
  badToken: "Potwierdzenie jest nieważne (inne argumenty, wygasło, zostało użyte albo pochodzi z innego wywołania). Nic nie zmieniono.",
  samePart: "Czat przenosi notatkę tylko w obrębie jednej części przestrzeni (bez wchodzenia do chronionego projektu i wychodzenia z niego).",
  taken: "Ścieżka jest zajęta.",
  badPath: "Nieprawidłowa ścieżka notatki.",
  badTask: "Nazwa zadania nie może być pusta ani zawierać znaków, które zadanie czyta jako swoje pola (np. @, # albo 📅).",
  badPerson: "Nieprawidłowa nazwa osoby (np. Jan): użyj liter, cyfr, kropki, _ lub -.",
  badDate: "Termin musi być datą RRRR-MM-DD.",
  badPages: "Strony podaj jako numer albo zakres, np. 2 albo 2-3.",
  noSection: "Nie ma takiej sekcji w tej notatce. Nagłówki pokazuje outline.",
  badValue: "Nieprawidłowa wartość pola zadania (wykonawca: nazwa osoby, termin: RRRR-MM-DD, trudność: liczba 0–10).",
};

/** Asks the user (MCP elicitation). Returns null when the client cannot ask. */
export type Ask = (message: string) => Promise<boolean | null>;

interface Task { view: VaultView; note: NoteView; line: number; raw: string; parsed: LineTask }

export class Tools {
  /** Notices said once (newer version, §8 advice), put before the next answer. */
  notices: string[] = [];
  private tokens = new Map<string, { digest: string; expires: number }>();
  /** The chat's search indexes, one per vault (docs/OCR.md §5.4). */
  readonly maps: MapIndex;

  constructor(readonly session: Session, readonly state: LocalState, readonly ask: Ask = async () => null, private readonly now: () => number = Date.now) {
    this.maps = new MapIndex(session);
  }

  /** Runs one tool: log line (tool and path only), scope load, errors as fixed messages. */
  async run(tool: string, path: string | undefined, body: () => Promise<ToolResult>): Promise<ToolResult> {
    this.state.log(tool, path);
    let out: ToolResult;
    try {
      if (this.session.client.dead) return failure(this.session.client.dead);
      await this.session.ready();
      out = await body();
    } catch (e) {
      if (this.session.client.dead) return failure(this.session.client.dead);
      // only the MCP's own messages reach Claude: another error's text may quote data (a JSON parse error quotes its input)
      out = failure(e instanceof AgentError ? e.message : TEXT.failed);
    }
    if (this.notices.length) out.content.unshift({ type: "text", text: this.notices.splice(0).join("\n") });
    return out;
  }

  // ---- scope ----------------------------------------------------------------------------------------------------

  private allowed(view: VaultView, tool: string): boolean {
    if ((MAP_TOOLS as readonly string[]).includes(tool)) return this.allowed(view, "search");
    return tool === "scope_info" || (view.scope.tools.length ? view.scope.tools.includes(tool) : DEFAULT_TOOLS.has(tool));
  }
  private vaultsFor(tool: string, vault?: string): VaultView[] {
    const views = vault ? [this.pick(vault)] : [...this.session.vaults.values()];
    const usable = views.filter((v) => this.allowed(v, tool));
    if (vault && !usable.length) throw new AgentError(T.toolOff, "other", 0);
    return usable;
  }
  private pick(vault?: string): VaultView {
    const views = [...this.session.vaults.values()];
    if (!vault) {
      if (views.length === 1) return views[0];
      throw new AgentError(views.length ? T.pickVault : TEXT.scope, "other", 0);
    }
    const byId = views.find((v) => v.id === vault);
    const byName = views.filter((v) => v.name.toLowerCase() === vault.toLowerCase());
    const view = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!view) throw new AgentError(byName.length > 1 ? T.pickVault : TEXT.scope, "scope", 0);
    return view;
  }
  private one(tool: string, vault?: string): VaultView {
    const view = this.pick(vault);
    if (!this.allowed(view, tool)) throw new AgentError(T.toolOff, "other", 0);
    return view;
  }
  private notePath(path: string): string {
    const p = path.normalize("NFC").trim().replace(/^\/+/, "");
    // the core's path rules (bridge.ts plainPath); inScope refuses empty, "." and ".." segments
    if (/[\\:\0]/.test(p) || /^\.notes-sync(\/|$)/i.test(p)) throw new AgentError(T.badPath, "other", 0);
    return /\.md$/i.test(p) ? p : `${p}.md`;
  }
  /** A chat is at most an editor: in a shared vault it does not make top-level notes or folders directly (TOP_TEXT). */
  private checkTop(view: VaultView, change: Change, path: string): void {
    if (!isSharedVaultId(view.id) || route(view, change) !== "direct") return;
    const folders = new Set([...(view.snapshot?.state.folders ?? []), ...view.notes.flatMap((n) => ancestorsOf(n.path))]);
    if (landsTop(path, folders)) throw new AgentError(TOP_TEXT, "other", 0);
  }
  /** The visible note at `path`. A missing note answers like one out of scope, so no answer tells what exists beyond. */
  private note(view: VaultView, path: string): NoteView {
    const p = this.notePath(path);
    const note = this.session.visible(view, p) ? view.notes.find((n) => pathKey(n.path) === pathKey(p)) : undefined;
    if (!note) throw new AgentError(TEXT.scope, "scope", 0);
    return note;
  }
  /** The text as the chat sees it: links to notes it cannot see are numbered markers (`links`: the originals). */
  private hidden(view: VaultView, text: string, paths = this.session.visibleNotes(view).map((n) => n.path)): { text: string; links: string[] } {
    return hideLinks(text, (t) => resolves(t, paths));
  }
  private shown(view: VaultView, text: string, paths?: string[]): string { return this.hidden(view, text, paths).text; }
  /**
   * The chat's new text for `note` with every marker back as its original link. `whole`: the text replaces the note, so
   * every marker of the note must be in it. A note holding marker-shaped text of its own is not changed (ambiguous).
   */
  private restore(view: VaultView, note: NoteView | null, text: string, whole: boolean): string {
    const { links } = note ? this.hidden(view, note.text) : { links: [] };
    if (!hasMarker(text)) { if (whole && links.length) throw new AgentError(T.dropsLink, "other", 0); return text; }
    if (!note || hasMarker(note.text)) throw new AgentError(T.foreignMarker, "other", 0);
    const back = restoreLinks(text, links);
    if (!back) throw new AgentError(T.foreignMarker, "other", 0);
    if (whole && back.used.size !== links.length) throw new AgentError(T.dropsLink, "other", 0);
    return back.text;
  }
  private personNames(view: VaultView): string[] {
    const id = view.person.userId;
    const aliases = view.snapshot?.state.organization?.aliases?.[id] ?? [];
    return [...view.members.filter((m) => m.userId === id).map((m) => m.name), ...aliases];
  }
  private mine(view: VaultView, parsed: LineTask): boolean {
    // in Moje notatki every task is the person's own
    if (!isSharedVaultId(view.id)) return true;
    const names = this.personNames(view);
    return parsed.tokens.some((t) => t.kind === "assignee" && names.some((n) => sameHandle(String(t.value), n)));
  }
  private tasks(view: VaultView): Task[] {
    const out: Task[] = [];
    for (const note of this.session.visibleNotes(view))
      note.text.split("\n").forEach((raw, i) => {
        const parsed = parseLine(raw);
        if (parsed && (view.scope.tasks === "all" || this.mine(view, parsed))) out.push({ view, note, line: i + 1, raw, parsed });
      });
    return out;
  }

  // ---- read -----------------------------------------------------------------------------------------------------

  async scopeInfo(): Promise<ToolResult> {
    const vaults = [...this.session.vaults.values()].map((v) => ({
      przestrzeń: v.name, id: v.id, rodzaj: v.kind, tryb_zapisu: MODE_LABEL[v.writeMode], rola_czatu: v.role,
      foldery: v.scope.include.length ? v.scope.include : "cała przestrzeń", zadania: v.scope.tasks === "mine" ? "tylko moje" : "wszystkie",
      narzędzia: [...READ_TOOLS, ...MAP_TOOLS, ...WRITE_TOOLS, ...CONFIRM_TOOLS].filter((t) => this.allowed(v, t)),
      chronione_projekty: v.projects.map((p) => p.path).filter((p) => this.session.visible(v, p)),
    }));
    // only proposals of vaults and paths still in scope (their summaries name paths)
    const pending = this.session.proposals.filter((p) => { const v = this.session.vaults.get(p.vaultId); return v && this.session.visible(v, p.path); });
    const expires = this.session.sessionExpiresAt ? new Date(this.session.sessionExpiresAt).toISOString() : "nieznane";
    const lines = [`Sesja czatu wygasa: ${expires}.`, "Notatki są odświeżane najwyżej co 5 minut: zmiany zrobione w aplikacji mogą pojawić się tu z takim opóźnieniem."];
    if (this.session.unavailable.size) lines.push(`Niedostępne przestrzenie: ${this.session.unavailable.size} (zakres uszkodzony, starszy niż ostatnio widziany albo klucz się nie otwiera).`);
    if (pending.length) lines.push(`Propozycje z tej sesji czekające na zatwierdzenie: ${pending.length}.`);
    return result(lines.join("\n"), { przestrzenie: vaults, propozycje: pending.map((p) => p.summary) });
  }

  async listNotes(a: { vault?: string; folder?: string; cursor?: string }): Promise<ToolResult> {
    const folder = a.folder?.trim().replace(/^\/+|\/+$/g, "");
    const rows = this.vaultsFor("list_notes", a.vault).flatMap((v) => {
      const visible = this.session.visibleNotes(v);
      const paths = visible.map((n) => n.path);
      return visible.filter((n) => !folder || within(n.path, folder)).map((n) => ({ vault: v.name, path: n.path, title: titleOf(n.path, this.shown(v, n.text, paths)) }));
    });
    const { items, next } = page(rows, a.cursor);
    return result(`Notatek: ${rows.length}.${next ? ` Dalsza strona: cursor="${next}".` : ""}`, items);
  }

  async readNote(a: { path: string; vault?: string; offset?: number; limit?: number; section?: string }): Promise<ToolResult> {
    const view = this.one("read_note", a.vault);
    const note = this.note(view, a.path);
    if (a.section !== undefined) return this.readSection(view, note, a.section, a.offset, a.limit);
    const text = this.shown(view, note.text);
    const offset = Math.min(text.length, Math.max(0, Math.floor(a.offset ?? 0)));
    let end = Math.min(text.length, offset + Math.min(READ_MAX, Math.max(1, Math.floor(a.limit ?? READ_MAX))));
    // a page never ends inside a surrogate pair (an emoji): the pair goes whole into this page
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1] ?? "")) end++;
    const more = end < text.length ? ` Dalsza część: offset=${end}.` : "";
    const hash = await textHash(note.text);
    return result(`Znaki ${offset}–${end} z ${text.length}.${more} Skrót treści (expected dla edit_note): ${hash}.`, `ścieżka: ${note.path}\n\n${text.slice(offset, end)}`);
  }

  // ---- map (docs/OCR.md §5.1) ------------------------------------------------------------------------------------

  /**
   * The index of `view`. Its text is read_note's (same marker numbers, so a marker copied from `read` restores the
   * same link), except that embeds of files the chat may see are back as themselves (embed edges, `![[plik:…]]`).
   */
  private indexOf(view: VaultView, pass = true): VaultIndex {
    const paths = this.session.visibleNotes(view).map((n) => n.path);
    return this.maps.of(view, (text, file) => {
      const { text: out, links } = this.hidden(view, text, paths);
      return out.replace(HIDDEN_MARKER, (m, n: string) => {
        const link = links[Number(n) - 1] ?? "";
        const id = FILE_EMBED_LINK.exec(link)?.[1];
        return id && file(id) ? link : m;
      });
    }, pass);
  }
  /** "Indeks plików: 140 z 380." while the file pass of `view` runs, else "". */
  private filesNote(view: VaultView): string {
    const p = this.maps.pending(view);
    if (!p) return "";
    return p.failed ? " Indeks plików: nie udało się wczytać tekstu plików, spróbuj później." : ` Indeks plików: ${p.read} z ${p.layers || "?"} (wyniki z plików mogą być niepełne).`;
  }
  private where(index: VaultIndex, fileId: string): string {
    const in_ = index.embeds.get(fileId) ?? [];
    return in_.length ? `  (w: ${in_.slice(0, 3).join(", ")}${in_.length > 3 ? ` +${in_.length - 3}` : ""})` : "";
  }

  async search(a: { q: string; vault?: string; cursor?: string; limit?: number }): Promise<ToolResult> {
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(a.limit ?? 10)));
    const offset = Math.min(SEARCH_DEPTH, Math.max(0, Number.parseInt(a.cursor ?? "0", 10) || 0));
    const views = this.vaultsFor("search", a.vault);
    let total = 0;
    let notes = "";
    type Hit = { chunkId: string; kind: "note" | "file"; docId: string; title: string; place: string; snippet: string; score: number; tokensApprox: number; docTokensApprox: number };
    const hits: { view: VaultView; index: VaultIndex; hit: Hit }[] = [];
    for (const view of views) {
      const index = this.indexOf(view);
      const out = JSON.parse(index.search.search_json(a.q, offset + limit, 0, index.scope)) as { hits: Hit[]; total: number };
      total += out.total;
      hits.push(...out.hits.map((hit) => ({ view, index, hit })));
      notes += this.filesNote(view);
    }
    hits.sort((x, y) => y.hit.score - x.hit.score);
    const rows: Row[] = hits.slice(offset, offset + limit).map(({ view, index, hit: h }) => {
      const vault = views.length > 1 ? `[${view.name}] ` : "";
      const place = h.kind === "file" ? `  ${h.place}${this.where(index, h.docId)}` : h.place ? `  §${h.place}` : "";
      return { file: h.kind === "file", text: `${vault}${h.chunkId}  ${h.title}${place}  ~${h.tokensApprox}/${h.docTokensApprox} tok  „${h.snippet}”` };
    });
    const next = offset + limit < Math.min(total, SEARCH_DEPTH) ? ` Dalsza strona: cursor="${offset + limit}".` : "";
    return rowsResult(`Wyników: ${total}.${next}${notes} Czytaj fragment przez read(id); id n:… to notatka, f:… to plik.`, rows);
  }

  async map(a: { vault?: string }): Promise<ToolResult> {
    const rows: string[] = [];
    let notes = "";
    for (const view of this.vaultsFor("map", a.vault)) {
      const index = this.indexOf(view);
      const m = JSON.parse(index.search.map_json(index.scope)) as {
        folders: { path: string; notes: number }[]; topTags: { tag: string; n: number }[]; people: { name: string; n: number }[];
        hubs: { id: string; title: string; degree: number }[]; filesWithText: number; filesTotal: number;
      };
      rows.push(`# ${view.name}`,
        `foldery: ${m.folders.slice(0, MAP_ITEMS).map((f) => `${f.path || "/"} (${f.notes})`).join(", ") || "—"}`,
        `tagi: ${m.topTags.slice(0, MAP_ITEMS).map((t) => `#${t.tag} (${t.n})`).join(", ") || "—"}`,
        `osoby: ${m.people.slice(0, MAP_ITEMS).map((p) => `@${p.name} (${p.n})`).join(", ") || "—"}`,
        `najwięcej połączeń: ${m.hubs.slice(0, MAP_ITEMS).map((h) => `${h.id} ${h.title} (${h.degree})`).join(", ") || "—"}`,
        `pliki z tekstem: ${m.filesWithText} z ${m.filesTotal}`);
      notes += this.filesNote(view);
    }
    return result(`Przegląd zakresu.${notes}`, rows.length ? rows.join("\n") : undefined);
  }

  async outline(a: { id: string; vault?: string }): Promise<ToolResult> {
    const view = this.one("outline", a.vault);
    const index = this.indexOf(view);
    const items = JSON.parse(index.search.outline_json(a.id, index.scope)) as { chunkId: string; place: string; tokensApprox: number; firstLine: string | null; lowQuality: boolean }[] | null;
    if (!items) throw new AgentError(TEXT.scope, "scope", 0);
    const file = a.id.startsWith("f:") || index.files.has(a.id);
    const rows = items.map((i) => ({ file, text: `${i.chunkId}  ${i.place || "(początek)"}  ~${i.tokensApprox} tok${i.lowQuality ? "  niska jakość" : ""}${i.firstLine ? `  „${cut(i.firstLine, 120)}”` : ""}` }));
    return rowsResult(`${file ? "Strony pliku" : "Sekcje notatki"}: ${items.length}. Czytaj przez read(id) albo read(id pliku, pages).`, rows);
  }

  async read(a: { id: string; pages?: string; offset?: number; limit?: number; vault?: string }): Promise<ToolResult> {
    const view = this.one("read", a.vault);
    const index = this.indexOf(view);
    let from: number | undefined;
    let to: number | undefined;
    if (a.pages) {
      const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(a.pages);
      if (!m) throw new AgentError(T.badPages, "other", 0);
      from = Number(m[1]);
      to = Number(m[2] ?? m[1]);
      if (to < from) throw new AgentError(T.badPages, "other", 0);
    }
    const offset = Math.max(0, Math.floor(a.offset ?? 0));
    const limit = Math.min(READ_MAX, Math.max(1, Math.floor(a.limit ?? READ_MAX)));
    const r = JSON.parse(index.search.read_json(a.id, from, to, offset, limit, index.scope)) as { id: string; title: string; place: string; text: string; totalChars: number; more: boolean } | null;
    if (!r) throw new AgentError(TEXT.scope, "scope", 0);
    const file = r.id.startsWith("f:") || index.files.has(a.id);
    const end = offset + r.text.length;
    const more = r.more ? ` Dalsza część: offset=${end}.` : "";
    const head = `${r.title}${r.place ? ` · ${r.place}` : ""}`;
    const message = `Znaki ${offset}–${end} z ${r.totalChars}.${more}${file ? " Tekst rozpoznany z pliku (OCR): może mieć błędy." : ""}`;
    return { content: [{ type: "text", text: message }, { type: "text", text: (file ? wrapFile : wrap)(`${head}\n\n${r.text}`) }] };
  }

  async neighbors(a: { id: string; depth?: number; types?: string[]; limit?: number; vault?: string }): Promise<ToolResult> {
    const view = this.one("neighbors", a.vault);
    const index = this.indexOf(view);
    const types = (a.types ?? []).filter((t) => EDGE_TYPES.includes(t)).join(",");
    const depth = Math.min(2, Math.max(1, Math.floor(a.depth ?? 1)));
    const limit = Math.min(100, Math.max(1, Math.floor(a.limit ?? 30)));
    const n = JSON.parse(index.search.neighbors_json(a.id, depth, types, limit, index.scope)) as {
      nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string; kind: string }[]; truncated: boolean;
    } | null;
    if (!n) throw new AgentError(TEXT.scope, "scope", 0);
    // a file's name is file data (it may come from outside): its row goes in the file marker
    const rows: Row[] = [...n.nodes.map((x) => ({ file: x.kind === "file", text: `${x.id}  ${x.kind}  ${x.label}` })),
      ...n.edges.map((e) => ({ file: false, text: `${e.from} -${e.kind}-> ${e.to}` }))];
    return rowsResult(`Węzłów: ${n.nodes.length}, krawędzi: ${n.edges.length}.${n.truncated ? " Lista ucięta (limit)." : ""}`, rows);
  }

  async findFiles(a: { q?: string; typ?: string; folder?: string; cursor?: string; vault?: string }): Promise<ToolResult> {
    const offset = Math.max(0, Number.parseInt(a.cursor ?? "0", 10) || 0);
    const STATE: Record<string, string> = { text: "tekst", none: "brak tekstu", pending: "bez tekstu (jeszcze)", error: "błąd" };
    const rows: Row[] = [];
    let total = 0;
    let notes = "";
    const views = this.vaultsFor("find_files", a.vault);
    for (const view of views) {
      const index = this.indexOf(view);
      const out = JSON.parse(index.search.find_files_json(a.q ?? "", a.typ ?? "", a.folder ?? "", offset + PAGE_MAX, 0, index.scope)) as {
        files: { id: string; name: string; mime: string; textState: string; pages: number | null }[]; total: number;
      };
      total += out.total;
      const vault = views.length > 1 ? `[${view.name}] ` : "";
      for (const f of out.files) rows.push({ file: true, text: `${vault}f:${f.id}  ${f.name}  ${f.mime}  ${STATE[f.textState] ?? f.textState}${f.pages ? `  stron: ${f.pages}` : ""}${this.where(index, f.id)}` });
      notes += this.filesNote(view);
    }
    const shown = rows.slice(offset, offset + PAGE_MAX);
    const next = offset + PAGE_MAX < total ? ` Dalsza strona: cursor="${offset + PAGE_MAX}".` : "";
    return rowsResult(`Plików: ${total}.${next}${notes}`, shown);
  }

  /** One section of a note (a heading path from outline, or its last heading), all its chunks. */
  private async readSection(view: VaultView, note: NoteView, section: string, offset = 0, limit = READ_MAX): Promise<ToolResult> {
    const index = this.indexOf(view, false);
    const items = JSON.parse(index.search.outline_json(note.id, index.scope)) as { chunkId: string; place: string }[] | null;
    const want = section.normalize("NFC").trim().toLowerCase();
    const same = (place: string) => { const p = place.toLowerCase(); return p === want || p.split(" > ").at(-1) === want; };
    const place = items?.find((i) => same(i.place))?.place;
    if (!items || place === undefined) throw new AgentError(T.noSection, "other", 0);
    const text = items.filter((i) => i.place === place)
      .map((i) => (JSON.parse(index.search.read_json(i.chunkId, undefined, undefined, 0, READ_MAX, index.scope)) as { text: string } | null)?.text ?? "").join("\n\n");
    const from = Math.min(text.length, Math.max(0, Math.floor(offset)));
    let end = Math.min(text.length, from + Math.min(READ_MAX, Math.max(1, Math.floor(limit))));
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1] ?? "")) end++;
    const more = end < text.length ? ` Dalsza część: offset=${end}.` : "";
    // the heading is note data: it goes in the data, never in the MCP's own message
    return result(`Sekcja: znaki ${from}–${end} z ${text.length}.${more} Do edit_note przeczytaj całą notatkę (bez section).`, `ścieżka: ${note.path}\nsekcja: ${place}\n\n${text.slice(from, end)}`);
  }

  async listTasks(a: { vault?: string; osoba?: string; stan?: "otwarte" | "zrobione" | "wszystkie"; termin_do?: string; folder?: string; cursor?: string }): Promise<ToolResult> {
    const until = a.termin_do ? parseDay(a.termin_do) : null;
    if (a.termin_do && until === null) throw new AgentError(T.badDate, "other", 0);
    const stan = a.stan ?? "otwarte";
    // the lines as the chat sees them (markers numbered per note), once per note
    const shownLines = new Map<NoteView, string[]>();
    const lineOf = (view: VaultView, note: NoteView, line: number) => {
      if (!shownLines.has(note)) shownLines.set(note, this.shown(view, note.text).split("\n"));
      return shownLines.get(note)![line - 1];
    };
    const rows = this.vaultsFor("list_tasks", a.vault).flatMap((v) => this.tasks(v)).flatMap(({ view, note, line, raw, parsed }) => {
      const value = (kind: string) => parsed.tokens.filter((t) => t.kind === kind).map((t) => t.value);
      const done = /\[[xX]\]/.test(raw);
      const due = value("due").at(-1) as number | undefined;
      const people = value("assignee").map(String);
      if ((stan === "otwarte" && done) || (stan === "zrobione" && !done)) return [];
      if (a.osoba && !people.some((p) => sameHandle(p, a.osoba!))) return [];
      if (until !== null && (due === undefined || due > until)) return [];
      if (a.folder && !within(note.path, a.folder.trim().replace(/^\/+|\/+$/g, ""))) return [];
      return [{ vault: view.name, id: parsed.id, zadanie: cut(parseLine(lineOf(view, note, line))?.text ?? "", SNIPPET), zrobione: done, osoby: people,
        nadzór: value("supervisor").at(-1) ?? null, termin: due === undefined ? null : isoOf(due), trudność: value("difficulty").at(-1) ?? null, notatka: note.path }];
    });
    const { items, next } = page(rows, a.cursor);
    return result(`Zadań: ${rows.length}.${next ? ` Dalsza strona: cursor="${next}".` : ""}`, items);
  }

  // ---- write ----------------------------------------------------------------------------------------------------

  private async done(view: VaultView, change: Change): Promise<ToolResult> {
    const outcome = await applyChange(this.session, view, change);
    return result(outcome.message);
  }

  async createNote(a: { path: string; text: string; vault?: string }): Promise<ToolResult> {
    const view = this.one("create_note", a.vault);
    const path = this.notePath(a.path);
    if (!this.session.visible(view, path)) throw new AgentError(TEXT.scope, "scope", 0);
    if (view.notes.some((n) => pathKey(n.path) === pathKey(path))) throw new AgentError(T.taken, "other", 0);
    const change: Change = { op: "create", path, noteId: "", before: "", after: this.restore(view, null, a.text, false) };
    checkMarks(change);
    this.checkTop(view, change, path);
    return this.done(view, change);
  }

  private async appendText(op: "append" | "tasks", view: VaultView, note: NoteView, added: string): Promise<ToolResult> {
    const sep = note.text === "" || note.text.endsWith("\n") ? "" : "\n";
    const text = sep + this.restore(view, note, added, false);
    return this.done(view, { op, path: note.path, noteId: note.id, before: note.text, after: note.text + text, added: text });
  }

  async append(a: { path: string; text: string; vault?: string }): Promise<ToolResult> {
    const view = this.one("append", a.vault);
    return this.appendText("append", view, this.note(view, a.path), a.text);
  }

  async editNote(a: { path: string; expected: string; text: string; vault?: string }): Promise<ToolResult> {
    const view = this.one("edit_note", a.vault);
    const note = this.note(view, a.path);
    if (a.expected !== note.text && a.expected !== this.shown(view, note.text) && a.expected !== (await textHash(note.text))) throw new AgentError(T.stale, "other", 0);
    // a link the chat cannot see is a marker: every marker must stay, and goes back as the link it stands for
    const text = this.restore(view, note, a.text, true);
    // strict: when the note changed on the server since this copy (a 409), the edit is refused, not merged
    return this.done(view, { op: "edit", path: note.path, noteId: note.id, before: note.text, after: text, strict: true });
  }

  async addTasks(a: { note: string; titles: string[]; osoba?: string; termin?: string; vault?: string }): Promise<ToolResult> {
    const view = this.one("add_tasks", a.vault);
    const note = this.note(view, a.note);
    if (a.osoba && !/^[\p{L}\p{N}._-]+$/u.test(a.osoba)) throw new AgentError(T.badPerson, "other", 0);
    if (a.termin && parseDay(a.termin) === null) throw new AgentError(T.badDate, "other", 0);
    // ids unique in the whole vault, so set_task (which finds a task by id alone) finds each of them
    let all = view.notes.map((n) => n.text).join("\n");
    const lines: string[] = [];
    for (const raw of a.titles) {
      const title = raw.trim().replace(/\s+/g, " ");
      const id = newTaskId(all);
      const line = ["- [ ]", title, a.osoba ? `@${a.osoba}` : "", a.termin ? `📅 ${a.termin}` : "", `^${id}`].filter(Boolean).join(" ");
      const parsed = parseLine(line);
      // the title must read back as the title: no token hidden in it
      if (!title || !parsed || parsed.text !== title || parsed.id !== id) throw new AgentError(T.badTask, "other", 0);
      lines.push(line);
      all += `\n${line}`;
    }
    return this.appendText("tasks", view, note, `${lines.join("\n")}\n`);
  }

  async setTask(a: { id: string; pole: "wykonawca" | "termin" | "nadzor" | "trudnosc" | "ukonczenie"; wartosc: string; vault?: string }): Promise<ToolResult> {
    const id = a.id.replace(/^\^/, "");
    const views = a.vault ? [this.one("set_task", a.vault)] : this.vaultsFor("set_task");
    const hits = views.flatMap((v) => this.tasks(v)).filter((t) => t.parsed.id === id);
    if (hits.length !== 1) throw new AgentError(T.noTask, "other", 0);
    const { view, note, line, raw } = hits[0];
    const value = a.wartosc.trim();
    const FIELD: Record<string, TaskField> = { wykonawca: "assignee", termin: "due", nadzor: "supervisor", trudnosc: "difficulty" };
    let next: string;
    try { next = a.pole === "ukonczenie" ? setTaskDone(raw, /^(tak|true|1|x)$/i.test(value), dayOf(new Date(this.now()))) : setTaskField(raw, FIELD[a.pole], value || null); }
    catch { throw new AgentError(T.badValue, "other", 0); }
    const lines = note.text.split("\n");
    lines[line - 1] = next;
    // strict on the task line: when it changed on the server since this copy (a 409), the change is refused, not merged
    return this.done(view, { op: "edit", path: note.path, noteId: note.id, before: note.text, after: lines.join("\n"), line: raw });
  }

  // ---- with confirmation ----------------------------------------------------------------------------------------

  /**
   * The confirmation of §7.3: the client's elicitation when it has one; otherwise a preview and a one-time token
   * bound to the tool, its arguments and the preview, valid 2 minutes, issued only with a preview. Null = go ahead.
   */
  private async confirm(tool: string, args: Record<string, unknown>, preview: string): Promise<ToolResult | null> {
    const asked = await this.ask(preview);
    if (asked === true) return null;
    if (asked === false) return result(T.cancelled);
    const { confirmToken, ...rest } = args;
    const digest = await blake2bHex(new TextEncoder().encode(canonicalJson({ tool, args: rest, preview })));
    if (typeof confirmToken === "string" && confirmToken) {
      const held = this.tokens.get(confirmToken);
      this.tokens.delete(confirmToken);
      return held && held.expires > this.now() && held.digest === digest ? null : failure(T.badToken);
    }
    const token = newNonce();
    this.tokens.set(token, { digest, expires: this.now() + CONFIRM_MS });
    return result(`Ta zmiana wymaga potwierdzenia użytkownika. Pokaż mu podgląd. Jeśli się zgodzi, wywołaj ${tool} jeszcze raz z tymi samymi argumentami i confirmToken="${token}" (ważny 2 minuty, jednorazowy).`, preview);
  }

  async moveNote(a: { from: string; to: string; vault?: string; confirmToken?: string }): Promise<ToolResult> {
    const view = this.one("move_note", a.vault);
    const note = this.note(view, a.from);
    const to = this.notePath(a.to);
    if (!this.session.visible(view, to)) throw new AgentError(TEXT.scope, "scope", 0);
    if (view.notes.some((n) => pathKey(n.path) === pathKey(to))) throw new AgentError(T.taken, "other", 0);
    const part = (p: string) => view.projects.find((x) => within(p, x.path))?.path ?? null;
    if (part(note.path) !== part(to)) throw new AgentError(T.samePart, "other", 0);
    const change: Change = { op: "move", path: note.path, noteId: note.id, before: note.text, after: null, to };
    checkMarks(change);
    this.checkTop(view, change, to);
    if (route(view, change) === "direct") {
      const stop = await this.confirm("move_note", a, `Przenieść notatkę ${note.path} do ${to}?`);
      if (stop) return stop;
    }
    return this.done(view, change);
  }

  async trashNote(a: { path: string; vault?: string; confirmToken?: string }): Promise<ToolResult> {
    const view = this.one("trash_note", a.vault);
    const note = this.note(view, a.path);
    const change: Change = { op: "trash", path: note.path, noteId: note.id, before: note.text, after: null };
    checkMarks(change);
    if (route(view, change) === "direct") {
      const stop = await this.confirm("trash_note", a, `Przenieść notatkę ${note.path} do kosza?`);
      if (stop) return stop;
    }
    return this.done(view, change);
  }
}
