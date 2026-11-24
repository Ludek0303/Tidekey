// Claude chats in the browser (docs/MCP.md §9, §3.9, §18): the screens over agentpairing.ts, which holds the logic.
// Settings → Urządzenia, "Połącz Claude", the acceptance of a pairing link, and the scope, proposal and undo dialogs.
// Texts are Polish; code and comments are English.
import type { BrowserBridge } from "./browserauth";
import type { WriteMode } from "./agentcrypto";
import type { ProposalChange } from "./proposals";
import {
  agentChanges, cancelPairing, checkPairingLink, confirmAgent, decideProposal, disconnectAgent, disconnectAll, finishPairing, listAgents,
  listProposals, openProposalCount, ownChoices, pendingPairing, renewAgent, spaceOptions, startPairing, summaryText, undoAgentChanges, updateScope,
  type AgentRow, type PairingCheck, type PairingLink, type PairingStart, type ProposalView, type SpaceChoice, type SpaceOption,
} from "./agentpairing";
import { el } from "./dom";
import { confirmDialog, errorText, openDialog, toast } from "./widgets";

const MODES: WriteMode[] = ["none", "proposals", "append", "direct"];
const MODE_LABEL: Record<WriteMode, string> = { none: "Tylko odczyt", proposals: "Propozycje do zatwierdzenia", append: "Dopisywanie", direct: "Bezpośrednio" };
const MODE_SHORT: Record<WriteMode, string> = { none: "tylko odczyt", proposals: "propozycje", append: "dopisywanie", direct: "bezpośrednio" };
const SESSION_CHOICES: [number, string][] = [[1, "1 godzina"], [4, "4 godziny"], [8, "8 godzin"], [24, "24 godziny"]];
const TOOL_CHOICES: [string, string][] = [["move_note", "Przenoszenie notatek (move_note)"], ["trash_note", "Usuwanie do kosza (trash_note)"]];
// The tools a chat has with an empty `tools` list (mcp/src/tools.ts READ_TOOLS + WRITE_TOOLS; scope_info is always on).
const DEFAULT_TOOLS = ["list_notes", "search", "read_note", "list_tasks", "create_note", "append", "edit_note", "add_tasks", "set_task"];
const OP_TEXT: Record<ProposalChange["op"], string> = { create: "Nowa notatka", append: "Dopisanie na końcu", edit: "Zmiana tekstu", tasks: "Zmiana zadań", move: "Przeniesienie", trash: "Do kosza" };
// docs/MCP.md §18.6: the six sentences shown on the connect screen.
const SAFETY_RULES = [
  "Claude widzi tylko to, co mu udostępnisz, i nigdy więcej niż Ty.",
  "To, co Claude przeczyta, trafia do rozmowy z Claude (Anthropic); nie udostępniaj więcej, niż potrzeba.",
  "Domyślnie Claude tylko czyta; zmiany może jedynie proponować, a zatwierdzasz je Ty.",
  "Notatka może zawierać polecenia dla Claude podrzucone przez kogoś innego; nie pozwalaj Claude na pobieranie stron ani inne konektory w rozmowach z notatkami.",
  "Kodu odzyskiwania i hasła nigdy nie podajesz Claude; czat ma własne klucze i możesz go w każdej chwili odłączyć.",
  "Parowanie zaczynasz zawsze sam, w aplikacji; link do parowania od kogokolwiek innego to oszustwo.",
];
const HOUR = 3_600_000;

const when = (ms: number): string => new Date(ms).toLocaleString("pl-PL");
const clock = (ms: number): string => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
const deviceName = (a: AgentRow): string => (a.device ? `${a.device.name}, ${a.device.os}` : "Czat bez nazwy");
const spaceName = (options: SpaceOption[], vaultId: string): string => options.find((o) => o.vaultId === vaultId)?.name ?? "przestrzeń";
const note = (text: string): HTMLElement => el("p", "muted", text);
const errorLine = (text: string): HTMLElement => el("p", "agents-error", text);
// A container with children (el() takes text only).
function wrap(tag: "div" | "ol", cls: string, ...children: Node[]): HTMLElement {
  const box = el(tag, cls);
  box.append(...children);
  return box;
}

function button(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

function facts(rows: [string, string][]): HTMLElement {
  const dl = el("dl", "agents-facts");
  for (const [term, value] of rows) dl.append(el("dt", "", term), el("dd", "", value));
  return dl;
}

function sessionSelect(value: number): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Długość sesji");
  for (const [hours, label] of SESSION_CHOICES) sel.append(new Option(label, String(hours), false, hours === value));
  return sel;
}

// Runs one action and says how it went; true when it worked. The caller redraws what it shows.
async function attempt(action: () => Promise<unknown>, done: string | null): Promise<boolean> {
  try {
    await action();
  } catch (e) {
    toast(errorText(e), true);
    return false;
  }
  if (done) toast(done);
  return true;
}

// A dialog whose body `draw` fills again after each step. Esc and the close button are the dialog's own.
function dialog(label: string, draw: (body: HTMLElement, close: () => void) => void, onClose?: () => void): () => void {
  const body = el("div", "agents-body");
  return openDialog({
    label,
    className: "agents-modal",
    render(box, close) {
      box.append(el("h2", "", label), body);
      draw(body, close);
    },
    onClose,
  });
}

// ---- the scope picker (§3.9) ----------------------------------------------------------------------------------------

// `tools` holds only the picked extra tools (TOOL_CHOICES). The MCP reads a non-empty `tools` list as the whole list of
// allowed tools, so a pick is saved as DEFAULT_TOOLS + the picks, and no pick as an empty list (the defaults).
// `exclude` is kept as read: this screen does not edit it, and dropping it would widen the scope.
interface ScopeState { on: boolean; include: Set<string>; exclude: string[]; projects: Set<string>; writeMode: WriteMode; tools: Set<string>; tasks: "mine" | "all" }
let groupSeq = 0;

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void, shown = label): HTMLLabelElement {
  const wrap = el("label", "agents-check");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, el("span", "", shown));
  return wrap;
}

function radio(name: string, value: string, label: string, checked: boolean, onPick: () => void): HTMLLabelElement {
  const wrap = el("label", "agents-check");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", onPick);
  wrap.append(input, el("span", "", label));
  return wrap;
}

// What one open space offers. A folder, project or tool that is not picked is left out; "mine" is the default for tasks.
function spaceDetails(o: SpaceOption, s: ScopeState, group: number, changed: () => void): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(el("p", "agents-label", "Co widzi czat"));
  if (o.folders.length) {
    out.push(note("Nic nie zaznaczone: cała przestrzeń. Zaznaczone foldery: tylko one."));
    for (const folder of [...o.folders].sort()) {
      const depth = folder.split("/").length - 1;
      const row = checkbox(folder, s.include.has(folder), (on) => { if (on) s.include.add(folder); else s.include.delete(folder); changed(); }, folder.split("/").pop() ?? folder);
      row.style.paddingLeft = `${depth * 16}px`;
      row.append(el("span", "muted", "miękkie"));
      out.push(row);
    }
  } else {
    out.push(note("Foldery tej przestrzeni zobaczysz po jej otwarciu."));
  }
  if (o.allowProtected && o.projects.length) {
    out.push(el("p", "agents-label", "Chronione projekty"));
    for (const project of o.projects) out.push(checkbox(project, s.projects.has(project), (on) => { if (on) s.projects.add(project); else s.projects.delete(project); changed(); }));
  }
  if (o.hint) out.push(note(o.hint));
  out.push(el("p", "agents-label", "Tryb zapisu"));
  const direct = errorLine("Czat zmienia notatki od razu, bez zatwierdzenia. Używaj tylko przy zaufanym czacie.");
  direct.hidden = s.writeMode !== "direct";
  for (const mode of MODES.slice(0, MODES.indexOf(o.maxWriteMode) + 1)) {
    out.push(radio(`agents-${group}-mode`, mode, MODE_LABEL[mode], s.writeMode === mode, () => {
      s.writeMode = mode;
      direct.hidden = mode !== "direct";
      changed();
    }));
  }
  out.push(direct);
  out.push(el("p", "agents-label", "Narzędzia"));
  for (const [name, label] of TOOL_CHOICES) out.push(checkbox(label, s.tools.has(name), (on) => { if (on) s.tools.add(name); else s.tools.delete(name); changed(); }));
  out.push(el("p", "agents-label", "Zadania"));
  out.push(radio(`agents-${group}-tasks`, "mine", "Tylko moje", s.tasks === "mine", () => { s.tasks = "mine"; changed(); }));
  out.push(radio(`agents-${group}-tasks`, "all", "Wszystkie", s.tasks === "all", () => { s.tasks = "all"; changed(); }));
  return out;
}

function spaceBlock(o: SpaceOption, s: ScopeState, changed: () => void): HTMLElement {
  const block = el("fieldset", "agents-space");
  const legend = el("legend", "", o.name);
  const toggle = el("label", "switch");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("aria-label", o.name);
  input.checked = s.on;
  input.disabled = !!o.disabledReason;
  const track = el("span", "switch-track");
  track.setAttribute("aria-hidden", "true");
  toggle.append(input, track);
  const detail = el("div", "agents-space-detail");
  const group = ++groupSeq;
  const paint = (): void => {
    detail.replaceChildren(...spaceDetails(o, s, group, changed));
    detail.hidden = !s.on;
  };
  input.addEventListener("change", () => {
    s.on = input.checked;
    paint();
    changed();
  });
  paint();
  block.append(legend, toggle);
  if (o.disabledReason) block.append(note(o.disabledReason));
  block.append(detail);
  return block;
}

/** The scope picker: a switch per space, and the details of each open one. `initial` starts the switches. */
function scopeForm(options: SpaceOption[], initial: SpaceChoice[], changed: () => void): { root: HTMLElement; choices: () => SpaceChoice[] } {
  const states = new Map<string, ScopeState>();
  for (const o of options) {
    const from = initial.find((c) => c.vaultId === o.vaultId);
    states.set(o.vaultId, {
      on: !!from, include: new Set(from?.include), exclude: [...(from?.exclude ?? [])], projects: new Set(from?.projects), writeMode: from?.writeMode ?? "none",
      tools: new Set(from?.tools.filter((t) => TOOL_CHOICES.some(([name]) => name === t))), tasks: from?.tasks ?? "mine",
    });
  }
  const choices = (): SpaceChoice[] => options.flatMap((o) => {
    const s = states.get(o.vaultId)!;
    if (!s.on || o.disabledReason) return [];
    const extra = TOOL_CHOICES.map(([name]) => name).filter((name) => s.tools.has(name));
    return [{ vaultId: o.vaultId, include: [...s.include], exclude: [...s.exclude], projects: [...s.projects], writeMode: s.writeMode, tools: extra.length ? [...DEFAULT_TOOLS, ...extra] : [], tasks: s.tasks }];
  });
  const root = el("div", "agents-scope");
  for (const o of options) root.append(spaceBlock(o, states.get(o.vaultId)!, changed));
  return { root, choices };
}

// ---- "Przyjmij parowanie" (§3.2 pkt 4–7, §3.9) -------------------------------------------------------------------

/** Opens the link of a pairing started in this browser: who connects, the check code, and the scope to give it. */
export function openPairingAccept(bridge: BrowserBridge, link: PairingLink): void {
  dialog("Połącz Claude", (body, close) => void acceptView(bridge, link, body, close));
}

async function acceptView(bridge: BrowserBridge, link: PairingLink, body: HTMLElement, close: () => void): Promise<void> {
  body.replaceChildren(note("Sprawdzam link parowania…"));
  let check: PairingCheck;
  try {
    check = await checkPairingLink(link);
  } catch (e) {
    body.replaceChildren(errorLine(errorText(e)));
    return;
  }
  if (!check.ok) {
    body.replaceChildren(errorLine(check.reason ?? "Nie udało się sprawdzić linku parowania."));
    return;
  }
  let options: SpaceOption[];
  try {
    options = await spaceOptions(bridge);
  } catch (e) {
    body.replaceChildren(errorLine(errorText(e)));
    return;
  }
  const ownBox = document.createElement("input");
  ownBox.type = "checkbox";
  ownBox.setAttribute("aria-label", "To mój komputer i sam uruchomiłem parowanie");
  const ownOk = (): boolean => !check.otherNetwork || ownBox.checked;
  const scope = scopeForm(options, [], () => refresh());
  const hours = sessionSelect(4);
  const summary = el("p", "agents-summary");
  summary.setAttribute("aria-live", "polite");
  const connect = button("Połącz", () => void connectNow(), "btn btn-primary");
  const refresh = (): void => {
    const picked = scope.choices();
    summary.textContent = summaryText(picked, options);
    connect.disabled = picked.length === 0 || !ownOk();
  };
  const connectNow = async (): Promise<void> => {
    const picked = scope.choices();
    const said = summaryText(picked, options);
    connect.disabled = true;
    try {
      await finishPairing(bridge, link, picked, Number(hours.value));
    } catch (e) {
      toast(errorText(e), true);
      connect.disabled = false;
      return;
    }
    body.replaceChildren(el("h3", "", "Claude jest połączony"), el("p", "", said), note("Zakres i odłączenie zmienisz w Ustawienia → Urządzenia."), button("Zamknij", close, "btn btn-primary"));
  };
  const stop = async (): Promise<void> => {
    try {
      await cancelPairing();
    } catch (e) {
      toast(errorText(e), true);
    }
    close();
  };
  const sessionLabel = el("label", "agents-field", "Długość sesji ");
  sessionLabel.append(hours);
  const parts: HTMLElement[] = [
    el("h3", "", "Kto się łączy"),
    facts([
      ["Komputer", check.device?.name ?? "nieznany"],
      ["System", check.device?.os ?? "nieznany"],
      ["Wersja MCP", check.mcpVersion],
      ["Adres IP zgłoszenia", check.claimIp],
      ["Adres IP tej przeglądarki", check.myIp],
    ]),
    note("Kod kontrolny. Czy jest taki sam jak w Claude?"),
    el("p", "agents-code", check.checkCode),
  ];
  if (check.otherNetwork) {
    const own = el("label", "agents-check");
    ownBox.addEventListener("change", refresh);
    own.append(ownBox, el("span", "", "To mój komputer i sam uruchomiłem parowanie"));
    parts.push(errorLine("Ten czat zgłasza się z innej sieci niż ta przeglądarka. Jeśli to nie Ty, kliknij Przerwij."), own);
  }
  parts.push(el("h3", "", "Co Claude może widzieć"), scope.root, sessionLabel, summary, wrap("div", "agents-actions", connect, button("Przerwij", () => void stop())));
  body.replaceChildren(...parts);
  refresh();
}

// ---- "Połącz Claude" (§18.2, §18.3, §18.6) --------------------------------------------------------------------------

/** Settings → Urządzenia → Połącz Claude: the safety rules, the way to connect, and the pairing code. */
export function openConnect(onClose: () => void): void {
  let platform: "desktop" | "code" = "desktop";
  let pairing: PairingStart | null = null;
  dialog("Połącz Claude", (body, close) => {
    const begin = async (): Promise<void> => {
      try {
        pairing = await startPairing();
      } catch (e) {
        toast(errorText(e), true);
        return;
      }
      show();
    };
    const stop = async (): Promise<void> => {
      try {
        await cancelPairing();
      } catch (e) {
        toast(errorText(e), true);
      }
      pairing = null;
      show();
    };
    const tab = (label: string, id: "desktop" | "code"): HTMLButtonElement => {
      const b = button(label, () => { platform = id; show(); });
      b.setAttribute("aria-pressed", String(platform === id));
      return b;
    };
    const pairingPart = (): HTMLElement => {
      const box = el("div", "agents-pairing");
      if (!pairing) {
        box.append(button("Rozpocznij parowanie", () => void begin(), "btn btn-primary"));
        return box;
      }
      box.append(
        el("p", "agents-code", pairing.code),
        note(`Ważny do ${clock(pairing.expiresAt)}. Wpisz ten kod tylko w Claude na swoim komputerze. Nikt z obsługi Notatek nigdy o niego nie poprosi.`),
        button("Przerwij", () => void stop()),
      );
      return box;
    };
    const show = (): void => {
      const rules = el("ol", "agents-rules");
      rules.append(...SAFETY_RULES.map((rule) => el("li", "", rule)));
      const steps = platform === "desktop" ? desktopSteps() : codeSteps();
      body.replaceChildren(
        el("h3", "", "Zanim połączysz"),
        rules,
        el("h3", "", "Jak połączyć"),
        wrap("div", "agents-tabs", tab("Claude Desktop", "desktop"), tab("Claude Code", "code")),
        ...steps,
        el("h3", "", "Kod parowania"),
        pairingPart(),
        wrap("div", "agents-actions", button("Zamknij", close, "btn btn-primary")),
      );
    };
    pairing = pendingPairing();
    show();
  }, onClose);
}

function desktopSteps(): HTMLElement[] {
  return [
    note("Rozszerzenie do Claude Desktop nie jest jeszcze opublikowane. Do czasu wydania połącz przez Claude Code albo zobacz docs/MCP-UZYTKOWNIK.md."),
    wrap("ol", "agents-rules", ...[
      "Otwórz pobrane rozszerzenie „Notatki” w Claude Desktop, sprawdź wydawcę i kliknij Zainstaluj. W polu „Adres serwera” wpisz adres swoich Notatek.",
      "Kliknij Rozpocznij parowanie poniżej i zostaw tę kartę otwartą.",
      "Rozszerzenie poprosi o kod parowania w osobnym okienku. Wpisz go tam, nigdy w rozmowie z Claude.",
      "Sprawdź, kto się łączy (komputer, system, sieć, kod kontrolny). Jeśli się zgadza, wybierz przestrzenie i kliknij Połącz.",
      "W rozmowach z notatkami wyłącz inne konektory i wyszukiwanie w sieci.",
      "Sprawdź: zapytaj Claude „Do czego masz dostęp?”.",
    ].map((s) => el("li", "", s))),
  ];
}

function codeSteps(): HTMLElement[] {
  const cmd = (text: string): HTMLElement => el("pre", "agents-cmd", text);
  return [
    note("Wymaga Node 22 LTS i Claude Code. Najpierw kliknij Rozpocznij parowanie poniżej."),
    cmd("cd ~/notes/mcp && npm ci --ignore-scripts && npm run build"),
    cmd(`node ~/notes/mcp/dist/notatki-mcp.mjs pair ${location.origin}`),
    note("Polecenie zapyta o kod parowania w terminalu (nie widać go i nie trafia do historii), potem pokaże kod kontrolny do porównania z tym na ekranie."),
    cmd("claude mcp add --scope user notatki -- node ~/notes/mcp/dist/notatki-mcp.mjs"),
    note("W folderze, z którego uruchamiasz claude, zapisz .claude/settings.json z pliku mcp/claude-settings.json (blokada narzędzi sieciowych i pytanie przy każdej zmianie)."),
    note("Sprawdź: w claude wpisz /mcp. Ma pokazać „notatki: połączony”."),
  ];
}

// ---- Settings → Urządzenia (§9) -------------------------------------------------------------------------------------

/** The operator's switch of chats (§18.4): a banner above the app. */
export function agentsOffBanner(): HTMLElement {
  return el("div", "agents-banner", "Czaty Claude są wyłączone przez operatora serwera.");
}

/** The chats of this person, their state and the actions on each (§9). Redrawn after every change. */
export async function devicesPane(pane: HTMLElement, bridge: BrowserBridge): Promise<void> {
  const draw = async (): Promise<void> => {
    pane.replaceChildren(note("Ładowanie czatów…"));
    let agents: AgentRow[];
    let options: SpaceOption[];
    try {
      [agents, options] = await Promise.all([listAgents(), spaceOptions(bridge)]);
    } catch (e) {
      pane.replaceChildren(errorLine(errorText(e)));
      return;
    }
    // a count only: opening and checking every proposal waits for the proposals dialog
    const open = await openProposalCount(bridge).catch(() => 0);
    const live = agents.filter((a) => a.revokedAt == null);
    const list = el("div", "agents-list");
    list.append(...live.map((a) => chatItem(bridge, a, options, draw)));
    if (!live.length) list.append(note("Nie masz połączonego czatu Claude."));
    const actions = el("div", "agents-actions");
    if (live.length) actions.append(button("Odłącz wszystkie czaty", () => void disconnectEverything(), "btn btn-danger"));
    actions.append(button("Połącz Claude", () => openConnect(() => void draw()), "btn btn-primary"));
    pane.replaceChildren(
      note("Każdy czat to osobne urządzenie z własnym zakresem."),
      wrap("div", "agents-actions", el("p", "", `Otwarte propozycje: ${open}`), button("Propozycje Claude", () => openProposals(bridge, undefined, () => void draw()))),
      list,
      actions,
    );
  };
  const disconnectEverything = async (): Promise<void> => {
    if (!(await confirmDialog("Odłączyć wszystkie czaty Claude? Żaden z nich nie zobaczy już notatek.", "Odłącz wszystkie"))) return;
    await attempt(() => disconnectAll(bridge), "Wszystkie czaty odłączone.");
    await draw();
  };
  await draw();
}

function chatItem(bridge: BrowserBridge, a: AgentRow, options: SpaceOption[], draw: () => Promise<void>): HTMLElement {
  const name = deviceName(a);
  const item = el("section", "agents-item");
  const spaces = a.cert.vaults.map((v) => `${spaceName(options, v.vaultId)} (${MODE_SHORT[v.writeMode]})`).join("; ");
  const sessionOpen = a.sessionExpiresAt > Date.now();
  item.append(
    el("h3", "", name),
    facts([
      ["Wersja MCP", a.mcpVersion],
      ["Przestrzenie", spaces || "brak"],
      ["Sesja", sessionOpen ? `do ${when(a.sessionExpiresAt)}` : "wygasła"],
      ["Certyfikat", `do ${when(a.cert.expiresAt)}`],
      ["Ostatnie użycie", a.lastUsedAt == null ? "jeszcze nie używany" : `${when(a.lastUsedAt)}, adres ${a.lastIp ?? "nieznany"}`],
    ]),
  );
  const actions = el("div", "agents-actions");
  if (a.paused === "ip") {
    item.append(errorLine("Czat wstrzymany: nowy adres IP. Jeśli to Ty (inna sieć, VPN), potwierdź. Jeśli nie, odłącz czat."));
    actions.append(button("Potwierdź", () => void attempt(() => confirmAgent(a.agentId), "Czat potwierdzony.").then(draw), "btn btn-primary"));
  } else if (a.paused === "limit") {
    item.append(errorLine("Czat wstrzymany: przekroczono limit użycia."));
  }
  const renewSelect = sessionSelect(4);
  renewSelect.setAttribute("aria-label", "Przedłuż na");
  actions.append(
    button("Zakres", () => openScope(bridge, a, name, draw)),
    renewSelect,
    button("Przedłuż", () => void renew(a.agentId, Number(renewSelect.value)).then(draw)),
    button("Propozycje Claude", () => openProposals(bridge, a.agentId, () => void draw())),
    button("Cofnij zmiany czatu", () => openUndo(bridge, a.agentId, name)),
    button("Odłącz", () => void disconnectOne(bridge, a, name).then(draw)),
  );
  item.append(actions);
  return item;
}

async function renew(agentId: string, hours: number): Promise<void> {
  try {
    const until = await renewAgent(agentId, hours);
    toast(`Sesja przedłużona do ${when(until)}.`);
  } catch (e) {
    toast(errorText(e), true);
  }
}

// Asks twice: first about the disconnect, then whether to put back the chat's changes of the last 24 hours.
async function disconnectOne(bridge: BrowserBridge, a: AgentRow, name: string): Promise<void> {
  if (!(await confirmDialog(`Odłączyć czat „${name}”? Claude straci do niego dostęp.`, "Odłącz"))) return;
  if (!(await attempt(() => disconnectAgent(bridge, a.agentId), "Czat odłączony."))) return;
  if (await confirmDialog("Cofnąć zmiany tego czatu z ostatnich 24 h?", "Cofnij zmiany")) await undoSince(bridge, a.agentId, Date.now() - 24 * HOUR);
}

// A note a person changed after the chat, where the chat's part cannot be found, is not overwritten: it is named here,
// to be put right by hand from its history of versions (docs/MCP.md §7.2: conflicts are shown).
async function undoSince(bridge: BrowserBridge, agentId: string, since: number): Promise<string[]> {
  try {
    const { notes, conflicts } = await undoAgentChanges(bridge, agentId, since);
    if (conflicts.length) toast(`Nie cofnięto zmian czatu w notatkach zmienionych później przez osoby: ${conflicts.join(", ")}. Sprawdź je w historii wersji.`, true);
    else toast(notes ? `Cofnięto zmiany w notatkach: ${notes}.` : "Ten czat nic nie zmienił w tym czasie.");
    return conflicts;
  } catch (e) {
    toast(errorText(e), true);
    return [];
  }
}

// The chat's scope with its current spaces, writing mode and projects. Its folders and tools are not readable here.
function openScope(bridge: BrowserBridge, a: AgentRow, name: string, after: () => unknown): void {
  dialog(`Zakres: ${name}`, (body, close) => {
    const show = async (): Promise<void> => {
      body.replaceChildren(note("Ładowanie przestrzeni…"));
      let options: SpaceOption[];
      try {
        options = await spaceOptions(bridge);
      } catch (e) {
        body.replaceChildren(errorLine(errorText(e)));
        return;
      }
      // the scope in force, from the person's own copies; a space without a readable copy starts off (never wider)
      const initial: SpaceChoice[] = await ownChoices(bridge, a);
      const summary = el("p", "agents-summary");
      summary.setAttribute("aria-live", "polite");
      const refresh = (): void => {
        summary.textContent = summaryText(form.choices(), options);
        save.disabled = form.choices().length === 0;
      };
      const form = scopeForm(options, initial, refresh);
      const save = button("Zapisz zakres", () => {
        void (async () => {
          if (await attempt(() => updateScope(bridge, a.agentId, form.choices()), "Zapisano zakres czatu.")) {
            close();
            await after();
          }
        })();
      }, "btn btn-primary");
      body.replaceChildren(
        form.root,
        summary,
        wrap("div", "agents-actions", save, button("Anuluj", close)),
      );
      refresh();
    };
    void show();
  });
}

// ---- proposals (§7.1) -----------------------------------------------------------------------------------------------

/** The open proposals of the open space, one chat's when `agentId` is given. Nothing is approved on its own. */
export function openProposals(bridge: BrowserBridge, agentId: string | undefined, onClose?: () => void): void {
  dialog("Propozycje Claude", (body) => {
    const show = async (): Promise<void> => {
      body.replaceChildren(note("Ładowanie propozycji…"));
      let views: ProposalView[];
      let agents: AgentRow[];
      try {
        [views, agents] = await Promise.all([listProposals(bridge), listAgents()]);
      } catch (e) {
        body.replaceChildren(errorLine(errorText(e)));
        return;
      }
      const open = views.filter((v) => v.state === "open" && (!agentId || v.agentId === agentId));
      const cards = open.map((v) => proposalCard(bridge, v, agents.find((a) => a.agentId === v.agentId), show));
      body.replaceChildren(
        note(`Propozycje przestrzeni „${bridge.vault.name}”. Nic nie zatwierdza się samo.`),
        ...(cards.length ? cards : [note("Brak propozycji czekających na zatwierdzenie.")]),
      );
    };
    void show();
  }, onClose);
}

function proposalCard(bridge: BrowserBridge, v: ProposalView, a: AgentRow | undefined, again: () => unknown): HTMLElement {
  const card = el("section", "agents-proposal");
  card.append(el("h3", "", `${a?.device?.name ?? "Czat Claude"} · ${when(v.createdAt)}`));
  if (!v.body || v.problem) {
    card.append(errorLine(v.problem ?? "Propozycja jest uszkodzona lub podrobiona."));
    return card;
  }
  card.append(el("p", "", v.body.summary));
  v.body.changes.forEach((c, i) => card.append(changeView(bridge, c, v.stale[i] === true)));
  const decide = (approve: boolean) => () => void attempt(() => decideProposal(bridge, v, approve), approve ? "Zatwierdzono propozycję." : "Odrzucono propozycję.").then(again);
  card.append(wrap("div", "agents-actions", button("Zatwierdź", decide(true), "btn btn-primary"), button("Odrzuć", decide(false))));
  return card;
}

// One change: its kind and path, and the text before and after (a simple side-by-side view).
function changeView(bridge: BrowserBridge, c: ProposalChange, stale: boolean): HTMLElement {
  const box = el("div", "agents-change");
  box.append(el("p", "", `${OP_TEXT[c.op]}: ${c.path}`));
  if (stale) box.append(errorLine("Nieaktualna: notatka zmieniła się od utworzenia propozycji. Odśwież ją przed zatwierdzeniem."));
  if (c.op === "move") box.append(note(`Nowa ścieżka: ${c.to ?? "?"}`));
  else if (c.op === "trash") box.append(note("Notatka trafi do kosza."));
  else if (c.op === "append" || c.op === "tasks") box.append(note(c.op === "tasks" ? "Zadania dopisane na końcu:" : "Dopisane na końcu:"), el("pre", "agents-text", c.text ?? ""));
  else {
    const before = el("pre", "agents-text", c.op === "create" ? "(nowa notatka)" : "Wczytywanie…");
    const diff = el("div", "agents-diff");
    diff.append(column("Przed", before), column("Po", el("pre", "agents-text", c.text ?? "")));
    box.append(diff);
    if (c.op !== "create") {
      void bridge.call<string>("note_text", { id: c.noteId }).then(
        (text) => { before.textContent = text; },
        () => { before.textContent = "(tej notatki już nie ma)"; },
      );
    }
  }
  return box;
}

function column(title: string, content: HTMLElement): HTMLElement {
  const col = el("div", "agents-col");
  col.append(el("p", "muted", title), content);
  return col;
}

// ---- "Cofnij zmiany czatu" (§7.2) -----------------------------------------------------------------------------------

const localInput = (ms: number): string => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function openUndo(bridge: BrowserBridge, agentId: string, name: string): void {
  dialog(`Cofnij zmiany: ${name}`, (body) => {
    const range = document.createElement("select");
    range.setAttribute("aria-label", "Okres");
    range.append(new Option("Ostatnia godzina", "1"), new Option("Ostatnie 24 godziny", "24"), new Option("Od godziny", "from"));
    const from = document.createElement("input");
    from.type = "datetime-local";
    from.value = localInput(Date.now() - HOUR);
    from.setAttribute("aria-label", "Od kiedy");
    const since = (): number => (range.value === "from" ? Date.parse(from.value) : Date.now() - Number(range.value) * HOUR);
    const list = el("div", "agents-list");
    const undoAll = button("Cofnij wszystkie", () => {
      void (async () => {
        if (!(await confirmDialog("Cofnąć zmiany tego czatu w notatkach z wybranego okresu?", "Cofnij wszystkie"))) return;
        const conflicts = await undoSince(bridge, agentId, since());
        await show();
        if (conflicts.length) list.prepend(errorLine(`Do rozstrzygnięcia (zmienione później przez osoby): ${conflicts.join(", ")}`));
      })();
    }, "btn btn-danger");
    const show = async (): Promise<void> => {
      const start = since();
      undoAll.disabled = true;
      if (!Number.isFinite(start)) {
        list.replaceChildren(note("Wybierz datę i godzinę."));
        return;
      }
      let changes: { noteId: string; path: string; at: number }[];
      try {
        changes = await agentChanges(bridge, agentId, start);
      } catch (e) {
        list.replaceChildren(errorLine(errorText(e)));
        return;
      }
      // the newest change of each note
      const last = new Map<string, { path: string; at: number }>();
      for (const c of changes) if ((last.get(c.noteId)?.at ?? 0) < c.at) last.set(c.noteId, c);
      const items = [...last.values()];
      list.replaceChildren(...(items.length ? items.map((c) => el("p", "", `${c.path} · ${when(c.at)}`)) : [note("Ten czat nic nie zmienił w tym okresie.")]));
      undoAll.disabled = items.length === 0;
    };
    range.addEventListener("change", () => void show());
    from.addEventListener("change", () => void show());
    body.replaceChildren(
      note(`Dotyczy notatek w przestrzeni „${bridge.vault.name}”.`),
      wrap("div", "agents-actions", range, from),
      list,
      wrap("div", "agents-actions", undoAll),
    );
    void show();
  });
}
