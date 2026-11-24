// The MCP server over stdio: tool registration, version checks (docs/MCP.md §10) and the §8 advice.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Tools, type Ask } from "./tools";
import { compareVersions, VERSION } from "./version";
import type { Session } from "./session";
import type { LocalState } from "./state";
import { GUIDE, GUIDE_NAME, GUIDE_URI, PROMPTS, RULES } from "./guide";

export const FIRST_RUN = "Zalecenie: w rozmowach z notatkami wyłącz inne konektory, wyszukiwanie w sieci i pobieranie stron. Notatka może zawierać polecenia podrzucone przez kogoś innego, a te narzędzia mogłyby wysłać jej treść na zewnątrz. W Claude Code użyj gotowych ustawień claude-settings.json (blokada narzędzi sieciowych).";
export const INSTRUCTIONS = `${RULES} ${FIRST_RUN}`;
const HOUR = 3_600_000;
export const newerText = (command: string) => `Dostępna jest nowsza wersja Notatki MCP: ${command}.`;

/** GET /api/version (no session): says once per session that a newer version exists. */
export async function checkVersion(origin: string, tools: Tools, said: { done: boolean }, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const r = await fetchFn(new URL("/api/version", origin), { redirect: "error" });
    const v = (await r.json()) as { agentLatest?: string; update?: { npm?: string } };
    const command = typeof v.update?.npm === "string" ? v.update.npm : undefined;
    if (!said.done && v.agentLatest && compareVersions(VERSION, v.agentLatest) < 0) { said.done = true; tools.notices.push(newerText(command ?? "npx --yes @notatki/mcp@latest")); }
    return command;
  } catch { return undefined; }
}

const vault = z.string().max(200).optional().describe("Przestrzeń: nazwa albo id z scope_info. Potrzebna, gdy czat ma kilka przestrzeni.");
const path = (d: string) => z.string().min(1).max(1000).describe(d);
const text = z.string().max(500_000);
const cursor = z.string().max(20).optional().describe("Dalsza strona z poprzedniej odpowiedzi.");
const confirmToken = z.string().max(64).optional().describe("Jednorazowy kod potwierdzenia z podglądu (gdy klient nie pyta użytkownika sam).");

export function buildServer(session: Session, state: LocalState): { server: McpServer; tools: Tools } {
  const server = new McpServer({ name: "notatki", version: VERSION }, { instructions: INSTRUCTIONS });
  const ask: Ask = async (message) => {
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    const answer = await server.server.elicitInput({ message, requestedSchema: { type: "object", properties: { potwierdzam: { type: "boolean", title: "Tak, zrób to" } }, required: ["potwierdzam"] } });
    return answer.action === "accept" && answer.content?.potwierdzam === true;
  };
  const tools = new Tools(session, state, ask);
  if (!state.data.firstRunShown) { tools.notices.push(FIRST_RUN); state.data.firstRunShown = true; state.save(); }
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool("scope_info", { description: "Przestrzenie i foldery w zakresie tego czatu, tryb zapisu każdej, narzędzia i wygaśnięcie sesji.", inputSchema: {}, annotations: read },
    () => tools.run("scope_info", undefined, () => tools.scopeInfo()));
  server.registerTool("list_notes", { description: "Ścieżki i tytuły notatek (najwyżej 50 na stronę).", inputSchema: { folder: z.string().max(1000).optional(), cursor, vault }, annotations: read },
    (a) => tools.run("list_notes", a.folder, () => tools.listNotes(a)));
  server.registerTool("search", { description: "Szukanie w notatkach i w tekście plików: fragmenty z id, miejscem, wycinkiem i liczbą tokenów (fragment/całość). Operatory: \"fraza\", -słowo, tag:, path:, typ:pdf, typ:obraz, w:pliki, w:notatki.", inputSchema: { q: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional(), cursor, vault }, annotations: read },
    (a) => tools.run("search", undefined, () => tools.search(a)));
  server.registerTool("map", { description: "Przegląd zakresu: foldery, najczęstsze tagi, osoby, najbardziej połączone notatki, liczba plików z tekstem.", inputSchema: { vault }, annotations: read },
    (a) => tools.run("map", undefined, () => tools.map(a)));
  const nodeId = z.string().min(1).max(200).describe("Id z search, outline albo neighbors (n:…, f:…, n:…#3, f:…#s2).");
  server.registerTool("outline", { description: "Spis notatki (sekcje) albo pliku (strony) z liczbą tokenów każdej części.", inputSchema: { id: nodeId, vault }, annotations: read },
    (a) => tools.run("outline", undefined, () => tools.outline(a)));
  server.registerTool("read", { description: "Fragment, sekcja albo strony pliku (pages: \"2\" albo \"2-3\"), najwyżej 20 000 znaków naraz (offset, limit).", inputSchema: { id: nodeId, pages: z.string().max(20).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20_000).optional(), vault }, annotations: read },
    (a) => tools.run("read", undefined, () => tools.read(a)));
  server.registerTool("neighbors", { description: "Sąsiedzi węzła w mapie: linki, osadzone pliki, tagi, osoby, foldery, wzmianki.", inputSchema: { id: z.string().min(1).max(300).describe("n:…, f:…, t:tag, p:osoba albo d:folder"), depth: z.number().int().min(1).max(2).optional(), types: z.array(z.enum(["link", "embed", "tag", "assigned", "in", "mention"])).max(6).optional(), limit: z.number().int().min(1).max(100).optional(), vault }, annotations: read },
    (a) => tools.run("neighbors", undefined, () => tools.neighbors(a)));
  server.registerTool("find_files", { description: "Pliki: nazwa, typ, stan tekstu, strony, notatki osadzające (najwyżej 50 na stronę).", inputSchema: { q: z.string().max(200).optional(), typ: z.string().max(20).optional().describe("pdf albo obraz"), folder: z.string().max(1000).optional(), cursor, vault }, annotations: read },
    (a) => tools.run("find_files", undefined, () => tools.findFiles(a)));
  server.registerTool("read_note", { description: "Treść notatki, najwyżej 20 000 znaków naraz (offset, limit). Zwraca też skrót treści do edit_note.", inputSchema: { path: path("Ścieżka notatki, np. Spotkania/2026-11-10.md"), section: z.string().min(1).max(500).optional().describe("Tylko ta sekcja: nagłówek albo ścieżka nagłówków z outline"), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20_000).optional(), vault }, annotations: read },
    (a) => tools.run("read_note", a.path, () => tools.readNote(a)));
  server.registerTool("list_tasks", { description: "Zadania: osoba, termin, notatka, stan (najwyżej 50 na stronę).", inputSchema: { osoba: z.string().max(64).optional(), stan: z.enum(["otwarte", "zrobione", "wszystkie"]).optional(), termin_do: z.string().max(10).optional().describe("RRRR-MM-DD"), folder: z.string().max(1000).optional(), cursor, vault }, annotations: read },
    (a) => tools.run("list_tasks", a.folder, () => tools.listTasks(a)));
  server.registerTool("create_note", { description: "Nowa notatka. W trybie propozycji tworzy propozycję do zatwierdzenia.", inputSchema: { path: path("Ścieżka nowej notatki"), text, vault }, annotations: write },
    (a) => tools.run("create_note", a.path, () => tools.createNote(a)));
  server.registerTool("append", { description: "Dopisanie tekstu na końcu notatki.", inputSchema: { path: path("Ścieżka notatki"), text, vault }, annotations: write },
    (a) => tools.run("append", a.path, () => tools.append(a)));
  server.registerTool("edit_note", { description: "Zmiana całej treści notatki. Najpierw read_note; expected: skrót (albo treść) z read_note. Gdy notatka zmieniła się od odczytu, zmiana jest odrzucana. Znaczniki ⟦ukryty link N⟧ zostaw bez zmian: wracają jako oryginalne linki.", inputSchema: { path: path("Ścieżka notatki"), expected: text, text, vault }, annotations: write },
    (a) => tools.run("edit_note", a.path, () => tools.editNote(a)));
  server.registerTool("add_tasks", { description: "Kilka zadań naraz na końcu notatki, w formacie - [ ] zadanie @osoba 📅 RRRR-MM-DD ^z-id.", inputSchema: { note: path("Ścieżka notatki"), titles: z.array(z.string().min(1).max(500)).min(1).max(50), osoba: z.string().max(64).optional(), termin: z.string().max(10).optional().describe("RRRR-MM-DD"), vault }, annotations: write },
    (a) => tools.run("add_tasks", a.note, () => tools.addTasks(a)));
  server.registerTool("set_task", { description: "Zmiana pola zadania o danym id (z list_tasks): wykonawca, termin, nadzor, trudnosc (0–10), ukonczenie (tak/nie). Pusta wartość usuwa pole.", inputSchema: { id: z.string().min(1).max(40), pole: z.enum(["wykonawca", "termin", "nadzor", "trudnosc", "ukonczenie"]), wartosc: z.string().max(64), vault }, annotations: write },
    (a) => tools.run("set_task", undefined, () => tools.setTask(a)));
  server.registerTool("move_note", { description: "Przeniesienie notatki (oba miejsca w zakresie, w obrębie jednej części). Wymaga potwierdzenia użytkownika.", inputSchema: { from: path("Obecna ścieżka"), to: path("Nowa ścieżka"), confirmToken, vault }, annotations: destructive },
    (a) => tools.run("move_note", a.from, () => tools.moveNote(a)));
  server.registerTool("trash_note", { description: "Przeniesienie notatki do kosza (nigdy trwałe usunięcie). Wymaga potwierdzenia użytkownika.", inputSchema: { path: path("Ścieżka notatki"), confirmToken, vault }, annotations: destructive },
    (a) => tools.run("trash_note", a.path, () => tools.trashNote(a)));
  server.registerResource(GUIDE_NAME, GUIDE_URI, { title: GUIDE_NAME, description: "Narzędzia, tryby zapisu, zasady bezpieczeństwa i typowe przepływy.", mimeType: "text/markdown" },
    () => ({ contents: [{ uri: GUIDE_URI, mimeType: "text/markdown", text: GUIDE }] }));
  const prompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  server.registerPrompt("podsumuj_tydzien", { title: PROMPTS.podsumuj_tydzien.title, description: PROMPTS.podsumuj_tydzien.description, argsSchema: { vault } },
    (a) => prompt(PROMPTS.podsumuj_tydzien.build(a, new Date())));
  server.registerPrompt("zadania_po_terminie", { title: PROMPTS.zadania_po_terminie.title, description: PROMPTS.zadania_po_terminie.description, argsSchema: { osoba: z.string().max(64).optional(), vault } },
    (a) => prompt(PROMPTS.zadania_po_terminie.build(a, new Date())));
  server.registerPrompt("notatka_ze_spotkania", { title: PROMPTS.notatka_ze_spotkania.title, description: PROMPTS.notatka_ze_spotkania.description, argsSchema: { temat: z.string().min(1).max(200), vault } },
    (a) => prompt(PROMPTS.notatka_ze_spotkania.build(a, new Date())));
  return { server, tools };
}

/** Serves MCP on stdio until the client goes; checks the version at start and every hour. */
export async function serveStdio(session: Session, state: LocalState, origin: string): Promise<void> {
  const { server, tools } = buildServer(session, state);
  const said = { done: false };
  let command: string | undefined;
  const check = async () => { command = (await checkVersion(origin, tools, said)) ?? command; };
  session.client.opts.updateCommand = () => command;
  await check();
  setInterval(() => void check(), HOUR).unref();
  await server.connect(new StdioServerTransport());
}
