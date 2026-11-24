import { emit, on } from "./bus";
import { listCommands, shortcut } from "./commands";
import type { SpaceKind } from "./spaces";
import { LASTNAME_VISIBILITY, forgetLocalUser, personNameError, type BrowserBridge } from "./browserauth";
import { fetchPersonalState, personalNotesControl } from "./vaults";
import { devicesPane } from "./agentsview";
import { confirmDialog, errorText, openDialog, toast } from "./widgets";
import { RETENTION_CHOICES } from "./taskretention";
import { backupNow, backupTarget, describeLastBackup } from "./backup";
import { inTauri } from "./tauribridge";
import { ocrBoard, requestMeasure, requestPause } from "./ocr/status";

export type Theme = "dark" | "light" | "system";
export type EditMode = "live" | "source";
export type ToolbarPosition = "top" | "bottom" | "left" | "right";
export type PresetAccent = "violet" | "blue" | "teal" | "green" | "orange" | "red" | "pink" | "graphite";
/** A preset, or "custom": the colour in `customAccent`. */
export type Accent = PresetAccent | "custom";
export type PluginId = "graph" | "backlinks" | "outline" | "tags" | "templates" | "palette" | "wordcount";
export type BackupReminder = "week" | "month" | "off";
export type WritingLanguage = "pl" | "en-US" | "en-GB" | "de" | "uk";
export type HeadingRailSide = "right" | "left" | "off";

export interface Settings {
  theme: Theme;
  fontSize: number;
  editMode: EditMode;
  lineNumbers: boolean;
  showToolbar: boolean;
  toolbarPosition: ToolbarPosition;
  newNoteFolder: string;
  autoLoadImages: boolean;
  plugins: Record<PluginId, boolean>;
  accent: Accent;
  /** The colour of the "custom" accent, as #rrggbb. */
  customAccent: string;
  /** Note text width in px; 0 means no limit (full width, side padding kept). */
  textWidth: number;
  /** How often to remind about a whole-space copy (backup.ts). */
  backupReminder: BackupReminder;
  /** Browser/OS spellcheck and autocorrect in the editor (editor.ts writingAttributes). */
  spellcheck: boolean;
  writingLanguage: WritingLanguage;
  /** The folder whose notes are templates (templates.ts). */
  templateFolder: string;
  /** The folder of the daily notes; "" is the root. */
  dailyFolder: string;
  /** The template of a new daily note, a note path; "" for an empty note. */
  dailyTemplate: string;
  /** The edge of the editor the heading rail is on, or off (headingrail.ts). */
  headingRail: HeadingRailSide;
  /** OCR of files (docs/OCR.md §3.6): on, on a slow device too, the hardware path, the old files, pages per file. */
  ocrEnabled: boolean;
  ocrOnThisDevice: boolean;
  ocrHardware: "auto" | "cpu";
  ocrLegacy: boolean;
  /** Adds each file's recognised text to the .zip export beside it (docs/OCR.md §3.6). */
  ocrZipText: boolean;
  ocrMaxPages: number;
}

export type SettingKey = keyof Settings;

/** The appearance and editor settings that follow the account (preferences.ts). Device and per-space ones stay local. */
export const SYNCED_SETTINGS: SettingKey[] = ["theme", "accent", "customAccent", "fontSize", "editMode", "lineNumbers", "showToolbar", "toolbarPosition", "textWidth", "spellcheck", "writingLanguage", "headingRail"];

const PLUGINS: { id: PluginId; name: string }[] = [
  { id: "graph", name: "Graf" },
  { id: "backlinks", name: "Odnośniki zwrotne" },
  { id: "outline", name: "Konspekt" },
  { id: "tags", name: "Tagi" },
  { id: "templates", name: "Szablony" },
  { id: "palette", name: "Paleta poleceń" },
  { id: "wordcount", name: "Liczba słów" },
];

// Swatch colours are the solid accent of each choice; tokens.css holds the per-theme values.
const ACCENTS: { id: PresetAccent; name: string; swatch: string }[] = [
  { id: "violet", name: "Fiolet", swatch: "#7052c7" },
  { id: "blue", name: "Niebieski", swatch: "#2563c9" },
  { id: "teal", name: "Turkus", swatch: "#0b6e6a" },
  { id: "green", name: "Zielony", swatch: "#2b7040" },
  { id: "orange", name: "Pomarańczowy", swatch: "#a35000" },
  { id: "red", name: "Czerwony", swatch: "#b1303a" },
  { id: "pink", name: "Różowy", swatch: "#a3286a" },
  { id: "graphite", name: "Grafitowy", swatch: "#4b505b" },
];
const WRITING_LANGUAGES: [WritingLanguage, string][] = [["pl", "Polski"], ["en-US", "Angielski (USA)"], ["en-GB", "Angielski (UK)"], ["de", "Niemiecki"], ["uk", "Ukraiński"]];
// Also the choices of the Settings selects: the stored value is checked against these lists.
const TOOLBAR_POSITIONS: [ToolbarPosition, string][] = [["top", "Góra"], ["bottom", "Dół"], ["left", "Lewo"], ["right", "Prawo"]];
const HEADING_RAIL_CHOICES: [HeadingRailSide, string][] = [["right", "Po prawej"], ["left", "Po lewej"], ["off", "Wyłączony"]];
const BACKUP_CHOICES: [BackupReminder, string][] = [["week", "Co tydzień"], ["month", "Co miesiąc"], ["off", "Nie przypominaj"]];
const WIDTH_PRESETS: [string, string][] = [["600", "Wąska (600 px)"], ["760", "Średnia (760 px)"], ["1000", "Szeroka (1000 px)"], ["0", "Pełna szerokość"]];
const clampWidth = (v: number): number => (v === 0 ? 0 : Math.min(2000, Math.max(400, Math.round(v))));

const STORAGE_KEY = "notes.settings.v1";
const DEFAULTS: Settings = {
  theme: "dark",
  fontSize: 13,
  editMode: "live",
  lineNumbers: false,
  showToolbar: true,
  toolbarPosition: "top",
  newNoteFolder: "",
  autoLoadImages: true,
  plugins: Object.fromEntries(PLUGINS.map((p) => [p.id, true])) as Record<PluginId, boolean>,
  accent: "violet",
  customAccent: "#7052c7",
  textWidth: 760,
  backupReminder: "week",
  spellcheck: true,
  writingLanguage: "pl",
  templateFolder: "Szablony",
  dailyFolder: "",
  dailyTemplate: "",
  headingRail: "right",
  ocrEnabled: true,
  ocrOnThisDevice: false,
  ocrHardware: "auto",
  ocrLegacy: true,
  ocrZipText: true,
  ocrMaxPages: 300,
};

const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

// Reads the stored object key by key; a value of the wrong type falls back to its default. Also used for the account copy.
function normalize(stored: Partial<Settings>): Settings {
  const out: Settings = { ...DEFAULTS, plugins: { ...DEFAULTS.plugins } };
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    if (typeof stored[key] === typeof DEFAULTS[key]) Object.assign(out, { [key]: stored[key] });
  }
  out.plugins = { ...DEFAULTS.plugins, ...stored.plugins };
  if (out.accent !== "custom" && !ACCENTS.some((a) => a.id === out.accent)) out.accent = DEFAULTS.accent;
  if (!isHex(out.customAccent)) out.customAccent = DEFAULTS.customAccent;
  if (!TOOLBAR_POSITIONS.some(([id]) => id === out.toolbarPosition)) out.toolbarPosition = DEFAULTS.toolbarPosition;
  out.textWidth = clampWidth(out.textWidth);
  if (!BACKUP_CHOICES.some(([id]) => id === out.backupReminder)) out.backupReminder = DEFAULTS.backupReminder;
  if (!WRITING_LANGUAGES.some(([id]) => id === out.writingLanguage)) out.writingLanguage = DEFAULTS.writingLanguage;
  if (!HEADING_RAIL_CHOICES.some(([id]) => id === out.headingRail)) out.headingRail = DEFAULTS.headingRail;
  if (out.ocrHardware !== "auto" && out.ocrHardware !== "cpu") out.ocrHardware = DEFAULTS.ocrHardware;
  if (!Number.isInteger(out.ocrMaxPages) || out.ocrMaxPages < 1 || out.ocrMaxPages > 1000) out.ocrMaxPages = DEFAULTS.ocrMaxPages;
  return out;
}

function load(): Settings {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>);
  } catch {
    // Storage may be blocked or hold junk; the defaults are good enough.
    return normalize({});
  }
}

let current = load();

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return current[key];
}

/** The synced settings as they are now (for the account copy). */
export function syncedSettings(): Partial<Settings> {
  return Object.fromEntries(SYNCED_SETTINGS.map((key) => [key, current[key]]));
}

/** Applies the synced settings of the account copy; the others keep their local values. Silent apart from the page. */
export function applySyncedSettings(remote: Partial<Settings>): void {
  const picked = Object.fromEntries(SYNCED_SETTINGS.filter((key) => key in remote).map((key) => [key, remote[key]]));
  const next = normalize({ ...current, ...picked });
  for (const key of SYNCED_SETTINGS) if (next[key] !== current[key]) setSetting(key, next[key] as never);
}

/** Whether pictures in notes load by themselves (docs/PLIKI.md §6). */
export const autoLoadImages = (): boolean => getSetting("autoLoadImages");

// Stores the value, applies it to the page where that is needed, and tells other modules.
export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  if (key === "fontSize") value = Math.min(20, Math.max(12, Math.round(Number(value)))) as Settings[K];
  if (key === "textWidth") value = clampWidth(Number(value)) as Settings[K];
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Not persisted, but the change still applies for this session.
  }
  applyToPage(key);
  emit("settings:changed", { key, value });
}

export function onSettingChanged(cb: (key: SettingKey, value: unknown) => void): () => void {
  return on("settings:changed", (d) => {
    const { key, value } = d as { key: SettingKey; value: unknown };
    cb(key, value);
  });
}

function applyTheme(): void {
  const t = current.theme;
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  document.documentElement.dataset.theme = t === "system" ? (systemDark ? "dark" : "light") : t;
  applyAccent();
}

// The variables a custom accent sets on the page. Inline, so they win over the preset sets in tokens.css.
const CUSTOM_ACCENT_VARS = ["--accent", "--accent-solid", "--accent-solid-hover", "--sel", "--on-accent"];
// tokens.css keys the accent values on data-accent, one set per base theme; a custom colour is derived for the current one.
function applyAccent(): void {
  const root = document.documentElement;
  root.dataset.accent = current.accent;
  if (current.accent !== "custom") {
    for (const name of CUSTOM_ACCENT_VARS) root.style.removeProperty(name);
    return;
  }
  const vars = customAccentVars(current.customAccent, root.dataset.theme !== "light");
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexOf = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const mixWith = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as Rgb;
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The CSS values of a custom accent, derived like the presets': a lighter tint on dark, a darker one on light, and
 *  white or black text on the solid colour, whichever contrasts more. */
export function customAccentVars(hex: string, dark: boolean): Record<string, string> {
  const base = rgbOf(hex);
  const tint = dark ? mixWith(base, [255, 255, 255], 0.45) : mixWith(base, [0, 0, 0], 0.15);
  const light = luminance(base);
  return {
    "--accent": hexOf(tint),
    "--accent-solid": hex.toLowerCase(),
    "--accent-solid-hover": hexOf(mixWith(base, [0, 0, 0], 0.15)),
    "--sel": `rgba(${tint.join(", ")}, ${dark ? 0.14 : 0.1})`,
    "--on-accent": 1.05 / (light + 0.05) >= (light + 0.05) / 0.05 ? "#ffffff" : "#000000",
  };
}

function applyToPage(key: SettingKey): void {
  if (key === "theme") applyTheme();
  if (key === "fontSize") document.documentElement.style.setProperty("--ui-font-size", `${current.fontSize}px`);
  // tokens.css keys the accent values on data-accent, one set per base theme.
  if (key === "accent" || key === "customAccent") applyAccent();
  if (key === "textWidth") document.documentElement.style.setProperty("--measure", current.textWidth ? `${current.textWidth}px` : "100vw");
}

// Applies the stored look at startup and follows the system theme when it is set to "system".
export function applyStoredLook(): void {
  applyTheme();
  applyToPage("fontSize");
  applyToPage("accent");
  applyToPage("textWidth");
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (current.theme === "system") applyTheme();
  });
}
// only with a page: the MCP and its tests (Node) import modules that import this one
if (typeof document !== "undefined") applyStoredLook();

type Category = { id: string; name: string; render: (pane: HTMLElement) => void };

// The open space as the general pane shows it. The legacy handle remains internal for old desktop spaces;
// the visible identity is the account/profile name.
export interface SpaceSettings {
  kind: SpaceKind;
  handle: string;
  accountName?: string;
  setKind: (kind: SpaceKind) => Promise<void>;
  setHandle: (handle: string) => Promise<void>;
  setAccountName?: (name: string) => Promise<void>;
  /** The optional last name, kept encrypted on the account (browser only). */
  lastName?: { load: () => Promise<string>; save: (last: string) => Promise<void> };
  /** The open space's notes as plain Markdown, path → text (only what this user can decrypt). */
  exportNotes?: () => Promise<Record<string, string>>;
  /** Organization only: after how many months done tasks are removed (0 = never), and may this user change it. */
  taskRetention?: () => Promise<{ months: number; canEdit: boolean }>;
  setTaskRetention?: (months: number) => Promise<void>;
}

let spaceName = "";
let space: SpaceSettings = { kind: "notatki", handle: "", setKind: () => Promise.resolve(), setHandle: () => Promise.resolve() };
let closeSettings: (() => void) | null = null;
// The browser bridge, for the Urządzenia pane (Claude chats); absent in the desktop app and the demo.
let devicesBridge: BrowserBridge | undefined;

// The server's Polish message, shown as it is.
async function responseError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
  return data.message ?? data.error ?? `Błąd serwera (${response.status}).`;
}

async function account<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json().catch(() => ({}))) as T;
}

function textInput(label: string, autocomplete: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 64;
  input.setAttribute("autocomplete", autocomplete);
  input.setAttribute("aria-label", label);
  input.placeholder = label;
  return input;
}

function button(label: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

// The display name (renames the member in the organizations too, through the bridge) and the optional last name
// (saved on the account). Only the members of a shared organization see the last name.
function profileForm(): HTMLElement {
  const name = textInput("Imię lub nazwa wyświetlana", "nickname");
  name.value = space.accountName ?? "";
  const lastName = textInput("Nazwisko (opcjonalne)", "family-name");
  let savedLast = "";
  const save = button("Zapisz zmiany", "btn btn-primary");
  const remove = button("Usuń nazwisko", "btn");
  const status = message();
  const change = async (last: string): Promise<void> => {
    const displayName = name.value.trim();
    const problem = personNameError(displayName, "Imię lub nazwa wyświetlana") ?? (last ? personNameError(last, "Nazwisko") : null);
    if (problem) { status.textContent = problem; return; }
    save.disabled = remove.disabled = true;
    try {
      if (displayName !== space.accountName && space.setAccountName) {
        await space.setAccountName(displayName);
        space = { ...space, accountName: displayName };
      }
      if (last !== savedLast) {
        await space.lastName?.save(last);
        savedLast = last;
      }
      lastName.value = last;
      status.textContent = last ? "Zapisano." : "Nazwisko usunięte.";
    } catch (e) { status.textContent = errorText(e); }
    finally { save.disabled = remove.disabled = false; }
  };
  save.addEventListener("click", () => void change(lastName.value.trim()));
  remove.addEventListener("click", () => { lastName.value = ""; void change(""); });
  // The last name is not in the space's settings: it is read from the account when the pane opens.
  void space.lastName?.load()
    .then((last) => { savedLast = last; lastName.value = last; })
    .catch(() => undefined);
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = LASTNAME_VISIBILITY;
  const box = document.createElement("div");
  box.className = "setting-stack";
  box.append(name, lastName, hint, remove, save, status);
  return row("Dane konta", "Imię lub nazwa wyświetlana jest widoczna dla członków organizacji zamiast adresu e-mail.", box);
}

// A JSON copy of the account data, saved on this device.
function exportRow(): HTMLElement {
  const download = button("Pobierz moje dane", "btn");
  const status = message();
  download.addEventListener("click", async () => {
    download.disabled = true;
    try {
      const response = await fetch("/api/auth/export", { credentials: "same-origin" });
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `notes-moje-dane-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "Plik z danymi został pobrany.";
    } catch (e) { status.textContent = errorText(e); }
    finally { download.disabled = false; }
  });
  const notes = button("Pobierz notatki tego sejfu", "btn");
  notes.hidden = !space.exportNotes;
  notes.addEventListener("click", async () => {
    notes.disabled = true;
    try {
      const files = await space.exportNotes!();
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), space: spaceName, notes: files }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `notes-notatki-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `Pobrano notatki: ${Object.keys(files).length}.`;
    } catch (e) { status.textContent = errorText(e); }
    finally { notes.disabled = false; }
  });
  const box = document.createElement("div");
  box.className = "setting-stack";
  box.append(download, notes, status);
  return row("Moje dane", "Kopia danych Twojego konta oraz treść notatek otwartego sejfu (Markdown w pliku JSON), zapisywane na tym urządzeniu.", box);
}

function passwordInput(label: string, autocomplete: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "password";
  input.setAttribute("autocomplete", autocomplete);
  input.setAttribute("aria-label", label);
  input.placeholder = label;
  return input;
}

function message(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "muted";
  p.setAttribute("role", "status");
  return p;
}

// The other devices are logged out; this one stays signed in.
function passwordForm(): HTMLElement {
  const current = passwordInput("Obecne hasło", "current-password");
  const next = passwordInput("Nowe hasło", "new-password");
  const again = passwordInput("Powtórz nowe hasło", "new-password");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary";
  save.textContent = "Zmień hasło";
  const status = message();
  save.addEventListener("click", async () => {
    if (next.value !== again.value) { status.textContent = "Nowe hasła się różnią."; return; }
    save.disabled = true;
    try {
      await account("/api/auth/password", "POST", { current: current.value, password: next.value });
      current.value = next.value = again.value = "";
      status.textContent = "Hasło zmienione. Inne urządzenia zostały wylogowane.";
    } catch (e) { status.textContent = e instanceof Error ? e.message : "Nie udało się zmienić hasła."; }
    finally { save.disabled = false; }
  });
  const box = document.createElement("div");
  box.className = "setting-stack";
  box.append(current, next, again, save, status);
  return row("Hasło", "Co najmniej 8 znaków, wielka litera i cyfra. Zmiana hasła nie dotyka notatek: ich klucz pochodzi z kodu odzyskiwania.", box);
}

function deleteAccountForm(): HTMLElement {
  const password = passwordInput("Hasło", "current-password");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-danger";
  remove.textContent = "Usuń konto";
  const status = message();
  remove.addEventListener("click", async () => {
    if (!confirm("Usunąć konto na zawsze? Znikną Twoje notatki osobiste i sejfy, w których jesteś sam. Tego nie da się cofnąć.")) return;
    remove.disabled = true;
    try {
      const me = await account<{ user?: { id: string } }>("/api/auth/me", "GET", undefined).catch(() => ({ user: undefined }));
      await account("/api/auth/me", "DELETE", { password: password.value });
      if (me.user) await forgetLocalUser(me.user.id).catch(() => undefined);
      location.assign("/");
    } catch (e) { status.textContent = errorText(e); remove.disabled = false; }
  });
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Jeśli jesteś właścicielem organizacji, serwer może nie pozwolić na usunięcie konta. Jego komunikat podpowie, jak przekazać własność albo wysłać prośbę do operatora.";
  const box = document.createElement("div");
  box.className = "setting-stack";
  box.append(password, remove, note, status);
  return row("Usuń konto", "Usuwa konto, notatki osobiste i sejfy, w których jesteś jedyną osobą. Ze wspólnych sejfów odchodzisz; zostaje w nich to, co dodałeś.", box);
}

// Moje notatki need the server admin's consent (docs/PANEL-ADMINA.md): the request, or the wait for it. Nothing once
// allowed. The state is read again here, so a consent given since shows up (Moje notatki join the vault list).
async function personalRow(pane: HTMLElement, bridge: BrowserBridge): Promise<void> {
  const state = await fetchPersonalState().catch(() => bridge.user.personal ?? "allowed");
  bridge.user.personal = state;
  const control = personalNotesControl(state, (next) => { bridge.user.personal = next; });
  if (control) pane.append(row("Własne notatki", "Moje notatki — prywatna przestrzeń tylko dla Ciebie. Na tym serwerze włącza je administrator serwera.", control));
}

// OCR settings (docs/OCR.md §3.6). Not on the desktop app, which keeps no text layers.
function ocrRows(): HTMLElement[] {
  if (inTauri()) return [];
  const measured = document.createElement("span");
  measured.className = "muted";
  const showLine = (): void => {
    measured.textContent = ocrBoard.hardware || "Jeszcze nie zmierzono";
  };
  showLine();
  const again = document.createElement("button");
  again.type = "button";
  again.className = "btn";
  again.textContent = "Zmierz ponownie";
  again.addEventListener("click", () => requestMeasure());
  const offLine = on("ocr:hardware", () => {
    if (!measured.isConnected) return offLine();
    showLine();
  });
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "btn";
  const paint = (): void => {
    pause.textContent = ocrBoard.paused ? "Wznów" : "Wstrzymaj";
  };
  paint();
  pause.addEventListener("click", () => requestPause(!ocrBoard.paused));
  const offPause = on("ocr:paused", () => {
    if (!pause.isConnected) return offPause();
    paint();
  });
  const pages = document.createElement("input");
  pages.type = "number";
  pages.min = "1";
  pages.max = "1000";
  pages.step = "1";
  pages.value = String(current.ocrMaxPages);
  pages.setAttribute("aria-label", "Najwięcej stron na plik");
  pages.addEventListener("change", () => {
    const n = Math.round(Number(pages.value));
    const value = Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 300;
    pages.value = String(value);
    setSetting("ocrMaxPages", value);
  });
  const wrapPause = document.createElement("div");
  wrapPause.append(pause);
  const measure = document.createElement("div");
  measure.append(measured, " ", again);
  return [
    row("Rozpoznawaj tekst w plikach (OCR)", "Tekst pliku dodanego albo własnego, który nie ma jeszcze warstwy tekstu", toggle("Rozpoznawaj tekst w plikach (OCR)", current.ocrEnabled, (v) => setSetting("ocrEnabled", v))),
    row("Rozpoznawaj tekst na tym urządzeniu", "Gdy ten komputer jest wolny, skany czekają na szybszy komputer, na którym jesteś zalogowany", toggle("Rozpoznawaj tekst na tym urządzeniu", current.ocrOnThisDevice, (v) => setSetting("ocrOnThisDevice", v))),
    row("Sprzęt", "Przy problemach ze sterownikiem karty graficznej wybierz tylko procesor", select<"auto" | "cpu">("Sprzęt", [["auto", "Automatycznie (zalecane)"], ["cpu", "Tylko procesor"]], current.ocrHardware, (v) => setSetting("ocrHardware", v))),
    row("Pomiar", "Wynik pomiaru tej drogi na tym urządzeniu", measure),
    row("Rozpoznawaj moje starsze pliki", "Pliki wysłane przed tą funkcją, do 50 MB każdy", toggle("Rozpoznawaj moje starsze pliki", current.ocrLegacy, (v) => setSetting("ocrLegacy", v))),
    row("Dołącz rozpoznany tekst do kopii .zip", "Obok pliku zapisuje <nazwa>.tekst.md", toggle("Dołącz rozpoznany tekst do kopii .zip", current.ocrZipText, (v) => setSetting("ocrZipText", v))),
    row("Wstrzymaj rozpoznawanie", "Zatrzymuje kolejkę do czasu wznowienia", wrapPause),
    row("Najwięcej stron na plik", "Od 1 do 1000", pages),
  ];
}

function row(name: string, desc: string, control: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "setting-row";
  const info = document.createElement("div");
  info.className = "setting-info";
  const h = document.createElement("h3");
  h.textContent = name;
  info.append(h);
  if (desc) {
    const p = document.createElement("p");
    p.textContent = desc;
    info.append(p);
  }
  control.classList.add("setting-control");
  el.append(info, control);
  return el;
}

function select<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", label);
  for (const [v, text] of options) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = text;
    opt.selected = v === value;
    sel.append(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value as T));
  return sel;
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.checked = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  // The track is drawn by CSS; the checkbox under it keeps the keyboard and screen reader role.
  const track = document.createElement("span");
  track.className = "switch-track";
  track.setAttribute("aria-hidden", "true");
  wrap.append(input, track);
  return wrap;
}

function text(label: string, value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.value.trim()));
  return input;
}

function slider(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "slider";
  const input = document.createElement("input");
  input.type = "range";
  input.min = "12";
  input.max = "20";
  input.step = "1";
  input.value = String(value);
  input.setAttribute("aria-label", label);
  const out = document.createElement("output");
  out.textContent = `${value} px`;
  input.addEventListener("input", () => {
    out.textContent = `${input.value} px`;
    onChange(Number(input.value));
  });
  wrap.append(input, out);
  return wrap;
}

// Native radios give the arrow-key radiogroup behaviour; the swatch is only drawn over them. The last choice is the custom colour.
function accentPicker(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "setting-stack";
  const group = document.createElement("div");
  group.className = "accent-picker";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Kolor akcentu");
  const choice = (id: Accent, name: string, swatch: string, onPick: () => void): HTMLInputElement => {
    const label = document.createElement("label");
    label.className = "accent-choice";
    label.title = name;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "accent";
    input.value = id;
    input.checked = current.accent === id;
    input.setAttribute("aria-label", name);
    input.addEventListener("change", onPick);
    const dot = document.createElement("span");
    dot.className = "accent-swatch";
    dot.style.background = swatch;
    label.append(input, dot);
    group.append(label);
    return input;
  };
  for (const a of ACCENTS) choice(a.id, a.name, a.swatch, () => setSetting("accent", a.id));

  // Any colour: the native picker and a hex field stay in step; either one selects the custom accent.
  const customRadio = choice("custom", "Własny kolor", current.customAccent, () => setSetting("accent", "custom"));
  const customSwatch = customRadio.nextElementSibling as HTMLElement;
  const picker = document.createElement("input");
  picker.type = "color";
  picker.value = current.customAccent;
  picker.setAttribute("aria-label", "Własny kolor");
  const hex = document.createElement("input");
  hex.type = "text";
  hex.maxLength = 7;
  hex.placeholder = "#rrggbb";
  hex.value = current.customAccent;
  hex.setAttribute("aria-label", "Kod koloru akcentu");
  const useCustom = (color: string): void => {
    setSetting("customAccent", color.toLowerCase());
    setSetting("accent", "custom");
    customRadio.checked = true;
    customSwatch.style.background = current.customAccent;
    picker.value = hex.value = current.customAccent;
  };
  picker.addEventListener("input", () => useCustom(picker.value));
  hex.addEventListener("change", () => {
    const value = hex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(value)) useCustom(value.startsWith("#") ? value : `#${value}`);
    else hex.value = current.customAccent;
  });
  const custom = document.createElement("div");
  custom.className = "accent-custom";
  custom.append(picker, hex);
  wrap.append(group, custom);
  return wrap;
}

// Presets plus a number field for any width from 400 to 2000 px; "Własna" appears when the width is not a preset.
function widthControl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "setting-stack";
  const choice = document.createElement("select");
  choice.setAttribute("aria-label", "Szerokość tekstu");
  const num = document.createElement("input");
  num.type = "number";
  num.min = "400";
  num.max = "2000";
  num.step = "10";
  num.placeholder = "400–2000";
  num.setAttribute("aria-label", "Własna szerokość w pikselach");
  const sync = () => {
    const w = current.textWidth;
    const preset = WIDTH_PRESETS.some(([v]) => Number(v) === w);
    choice.replaceChildren(...WIDTH_PRESETS.map(([v, label]) => new Option(label, v)));
    if (!preset) choice.append(new Option(`Własna (${w} px)`, "custom"));
    choice.value = preset ? String(w) : "custom";
    num.value = w ? String(w) : "";
  };
  choice.addEventListener("change", () => {
    if (choice.value !== "custom") setSetting("textWidth", Number(choice.value));
    sync();
  });
  num.addEventListener("change", () => {
    if (num.value !== "" && Number.isFinite(Number(num.value))) setSetting("textWidth", Number(num.value));
    sync();
  });
  sync();
  wrap.append(choice, num);
  return wrap;
}

function hotkeysPane(pane: HTMLElement): void {
  const search = document.createElement("input");
  search.type = "search";
  search.className = "hotkey-search";
  search.placeholder = "Szukaj skrótów…";
  search.setAttribute("aria-label", "Szukaj skrótów");
  const list = document.createElement("ul");
  list.className = "hotkey-list";
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const items = listCommands().filter((c) => c.name.toLowerCase().includes(q));
    list.replaceChildren(
      ...items.map((c) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = c.name;
        const keys = document.createElement("kbd");
        keys.textContent = shortcut(c) ?? "—";
        li.append(name, keys);
        return li;
      }),
    );
  };
  search.addEventListener("input", fill);
  pane.append(search, list);
  fill();
}

// The whole space as a ZIP of plain Markdown; the reminder that offers it at start lives in backup.ts.
function backupPane(pane: HTMLElement): void {
  const status = message();
  status.textContent = describeLastBackup(backupTarget()?.spaceKey ?? null);
  const download = button("Pobierz kopię zapasową", "btn btn-primary");
  download.addEventListener("click", async () => {
    const target = backupTarget();
    if (!target) return;
    download.disabled = true;
    try {
      if (await backupNow(target.bridge, target.spaceKey)) status.textContent = describeLastBackup(target.spaceKey);
    } finally {
      download.disabled = false;
    }
  });
  const warning = message();
  warning.textContent = "Kopia zawiera notatki w postaci jawnej (niezaszyfrowanej). Przechowuj ją bezpiecznie.";
  const restore = message();
  restore.textContent = "Aby przywrócić, rozpakuj kopię i przeciągnij folder do drzewa notatek.";
  const box = document.createElement("div");
  box.className = "setting-stack";
  box.append(status, download, warning, restore);
  pane.append(
    row("Kopia zapasowa", "Wszystkie notatki tej przestrzeni jako pliki .md w jednym archiwum .zip, wraz z załącznikami.", box),
    row(
      "Przypominaj o kopii",
      "Po uruchomieniu aplikacji, gdy od ostatniej kopii minął wybrany czas.",
      select<BackupReminder>("Przypominaj o kopii", BACKUP_CHOICES, current.backupReminder, (v) => setSetting("backupReminder", v)),
    ),
  );
}

const CATEGORIES: Category[] = [
  {
    id: "general",
    name: "Ogólne",
    render: (pane) => {
      const name = document.createElement("span");
      name.className = "muted";
      name.textContent = spaceName;
      pane.append(row("Nazwa przestrzeni", "Nazwa z ustawień przestrzeni (tylko do odczytu)", name));
      if (space.kind === "organizacja") {
        const kind = document.createElement("span");
        kind.className = "muted";
        kind.textContent = "Organizacja";
        pane.append(row("Typ przestrzeni", "Przestrzeń organizacji: zadania, terminy i nadzór.", kind));
        if (space.taskRetention) void retentionRow(pane);
        return;
      }
      const change = document.createElement("button");
      change.type = "button";
      change.className = "btn";
      change.textContent = "Zmień na organizację";
      change.addEventListener("click", () => void changeKind(pane, change));
      pane.append(row("Typ przestrzeni", "Notatki można zamienić na organizację. Tej zmiany nie cofniesz.", change));
    },
  },
  {
    id: "account",
    name: "Konto",
    render: (pane) => {
      if (space.accountName === undefined) { pane.append(row("Konto", "Konto i hasło są w wersji przeglądarkowej.", document.createElement("span"))); return; }
      pane.append(profileForm(), exportRow(), passwordForm(), deleteAccountForm());
      if (devicesBridge) void personalRow(pane, devicesBridge);
    },
  },
  { id: "devices", name: "Urządzenia", render: (pane) => { if (devicesBridge) void devicesPane(pane, devicesBridge); } },
  {
    id: "editor",
    name: "Edytor",
    render: (pane) =>
      pane.append(
        row(
          "Domyślny tryb edycji",
          "Tryb, w jakim otwierają się notatki",
          select<EditMode>("Domyślny tryb edycji", [["live", "Podgląd na żywo"], ["source", "Źródło"]], current.editMode, (v) => setSetting("editMode", v)),
        ),
        row("Pokaż numery linii", "Numery linii w edytorze źródłowym", toggle("Pokaż numery linii", current.lineNumbers, (v) => setSetting("lineNumbers", v))),
        row("Pokaż pasek formatowania", "Pasek przycisków nad edytorem", toggle("Pokaż pasek formatowania", current.showToolbar, (v) => setSetting("showToolbar", v))),
        row(
          "Położenie paska formatowania",
          "Nad edytorem, pod nim albo z boku",
          select<ToolbarPosition>("Położenie paska formatowania", TOOLBAR_POSITIONS, current.toolbarPosition, (v) => setSetting("toolbarPosition", v)),
        ),
        row("Automatycznie wczytuj obrazy", "Obrazy w notatkach ładują się, gdy są widoczne; wyłączone: przycisk „Wyświetl obraz”", toggle("Automatycznie wczytuj obrazy", current.autoLoadImages, (v) => setSetting("autoLoadImages", v))),
        row(
          "Sprawdzanie pisowni i autokorekta",
          "Podkreśla błędy w wybranym języku. Podkreślenia pojawiają się tylko, gdy przeglądarka ma ten słownik: w Chrome Ustawienia → Języki → Sprawdzanie pisowni → dodaj polski; w Firefoksie zainstaluj słownik polski.",
          toggle("Sprawdzanie pisowni i autokorekta", current.spellcheck, (v) => setSetting("spellcheck", v)),
        ),
        row(
          "Język pisania",
          "Język, w którym sprawdzana jest pisownia",
          select<WritingLanguage>("Język pisania", WRITING_LANGUAGES, current.writingLanguage, (v) => setSetting("writingLanguage", v)),
        ),
        row(
          "Konspekt przy krawędzi edytora",
          "Kreski dla nagłówków notatki przy krawędzi edytora; kliknięcie przechodzi do nagłówka",
          select<HeadingRailSide>("Konspekt przy krawędzi edytora", HEADING_RAIL_CHOICES, current.headingRail, (v) => setSetting("headingRail", v)),
        ),
      ),
  },
  // Not in the desktop app: dictation is a browser feature (see openSettings).
  { id: "dictation", name: "Dyktowanie", render: (pane) => void dictationPane(pane) },
  {
    id: "files",
    name: "Pliki i linki",
    render: (pane) =>
      pane.append(
        row("Folder nowych notatek", "Pusty oznacza główny folder przestrzeni", text("Folder nowych notatek", current.newNoteFolder, (v) => setSetting("newNoteFolder", v))),
        row("Folder szablonów", "Notatki w tym folderze są szablonami do polecenia „Wstaw szablon”", text("Folder szablonów", current.templateFolder, (v) => setSetting("templateFolder", v))),
        row("Folder notatek dziennych", "Pusty oznacza główny folder przestrzeni", text("Folder notatek dziennych", current.dailyFolder, (v) => setSetting("dailyFolder", v))),
        row("Szablon notatki dziennej", "Ścieżka notatki z folderu szablonów; pusty oznacza pustą notatkę", text("Szablon notatki dziennej", current.dailyTemplate, (v) => setSetting("dailyTemplate", v))),
        ...ocrRows(),
      ),
  },
  { id: "backup", name: "Kopia zapasowa", render: backupPane },
  {
    id: "appearance",
    name: "Wygląd",
    render: (pane) =>
      pane.append(
        row(
          "Motyw",
          "Ciemny, jasny albo jak system",
          select<Theme>("Motyw", [["dark", "Ciemny"], ["light", "Jasny"], ["system", "Systemowy"]], current.theme, (v) => setSetting("theme", v)),
        ),
        row("Rozmiar czcionki", "Dotyczy interfejsu i edytora", slider("Rozmiar czcionki", current.fontSize, (v) => setSetting("fontSize", v))),
        row("Kolor akcentu", "Zaznaczenia, przyciski i linki", accentPicker()),
        row("Szerokość tekstu", "Szerokość tekstu w edytorze i w widoku czytania", widthControl()),
      ),
  },
  { id: "hotkeys", name: "Skróty klawiszowe", render: hotkeysPane },
  {
    id: "plugins",
    name: "Wbudowane wtyczki",
    render: (pane) =>
      pane.append(
        ...PLUGINS.map((p) =>
          row(p.name, "", toggle(p.name, current.plugins[p.id], (v) => setSetting("plugins", { ...current.plugins, [p.id]: v }))),
        ),
      ),
  },
  {
    id: "about",
    name: "O programie",
    render: (pane) => {
      const name = document.createElement("h3");
      name.textContent = "Notatki";
      const status = document.createElement("p");
      status.className = "muted";
      status.textContent = "Projekt jest wciąż rozwijany: funkcje i wygląd mogą się jeszcze zmieniać.";
      const own = document.createElement("h4");
      own.textContent = "Licencja";
      const agpl = document.createElement("p");
      agpl.textContent =
        "Notatki to wolne oprogramowanie na licencji GNU Affero General Public License w wersji 3 lub nowszej (AGPL). " +
        "Możesz z niego korzystać, poznawać jego kod, zmieniać go i udostępniać dalej. Kto udostępnia zmienioną wersję, " +
        "także jako usługę w sieci, musi udostępnić jej kod źródłowy na tej samej licencji. Program jest dostarczany bez gwarancji.";
      const licenceText = link("Treść licencji (po angielsku)", "/LICENSE");
      const sources = document.createElement("ul");
      sources.append(sourceItem("Ta aplikacja", __NOTES_COMMIT__, __NOTES_SOURCE__));
      const heading = document.createElement("h4");
      heading.textContent = "Licencje bibliotek";
      const licenses = document.createElement("p");
      licenses.className = "muted";
      licenses.textContent = "Aplikacja korzysta z bibliotek i modeli innych autorów (licencje MIT, Apache-2.0, BSD, ISC, MPL-2.0, LGPL, CC BY 4.0 i inne). Pełna lista z tekstami licencji:";
      const show = button("Pokaż licencje", "btn");
      show.addEventListener("click", showLicences);
      const lgplHeading = document.createElement("p");
      lgplHeading.className = "muted";
      lgplHeading.textContent =
        "Biblioteki LGPL są osobnymi, niezmienionymi plikami: możesz je zastąpić własnym buildem tej samej wersji (szczegóły w licencjach). Źródła:";
      const lgpl = document.createElement("ul");
      for (const lib of LGPL_LIBRARIES) {
        const item = document.createElement("li");
        item.append(link(`${lib.name} ${lib.version} (${lib.license}) — źródła`, lib.source));
        lgpl.append(item);
      }
      const voice = document.createElement("ul");
      const privacy = document.createElement("a");
      privacy.href = "/prywatnosc";
      privacy.target = "_blank";
      privacy.textContent = "Polityka prywatności";
      pane.append(name, status, own, agpl, licenceText, sources, heading, licenses, show, lgplHeading, lgpl, voice, privacy);
      if (!inTauri()) void serverSource(sources);
      if (!inTauri()) void voiceLicenses(voice);
    },
  },
];

// The LGPL libraries shipped as separate files, with the sources of their versions. The settings test checks these
// links against vendor/lgpl/MANIFEST.json when that file exists.
const LGPL_LIBRARIES = [
  { name: "libheif-js", version: "1.23.5", license: "LGPL-3.0", source: "https://github.com/catdad-experiments/libheif-js/tree/v1.23.5" },
];

// A link that opens in a new tab without access back to this page.
function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

// Where the source of one part is (AGPL-3.0 §13): the repository at the exact commit when both are known.
export function sourceItem(label: string, commit: string, source: string): HTMLLIElement {
  const item = document.createElement("li");
  const short = commit.slice(0, 12);
  if (source && commit) item.append(`${label}: wersja ${short}, `, link("kod źródłowy tej wersji", `${source.replace(/\/$/, "")}/tree/${commit}`));
  else if (source) item.append(`${label}: `, link("kod źródłowy", source));
  else item.append(`${label}: ${commit ? `wersja ${short}; ` : ""}ta kompilacja nie ma zapisanego adresu kodu źródłowego.`);
  return item;
}

// The server's own version and source (GET /api/source on notes-node); nothing is shown when the server has none.
async function serverSource(list: HTMLElement): Promise<void> {
  try {
    const res = await fetch("/api/source");
    if (!res.ok) return;
    const info = (await res.json()) as { commit?: unknown; source?: unknown };
    list.append(sourceItem("Serwer", typeof info.commit === "string" ? info.commit : "", typeof info.source === "string" ? info.source : ""));
  } catch {
    // demo or an older server: the app's own line stays
  }
}

// The notices file (THIRD_PARTY_NOTICES.txt from the repository, put into the build by scripts/licencje/collect.mjs).
function showLicences(): void {
  openDialog({
    label: "Licencje bibliotek",
    render: (box) => {
      const text = document.createElement("pre");
      text.textContent = "Ładowanie…";
      text.style.cssText = "max-height: 70vh; overflow: auto; white-space: pre-wrap; font-size: 12px";
      box.append(text);
      fetch("/THIRD_PARTY_NOTICES.txt")
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text.textContent = await res.text();
        })
        .catch(() => {
          text.textContent = "Nie udało się wczytać pliku licencji.";
        });
    },
  });
}

// Dictation's model and libraries (docs/DYKTOWANIE.md §2, §3). Loaded on demand; the desktop app has no dictation.
async function voiceLicenses(list: HTMLElement): Promise<void> {
  const { DEFAULT_ASR } = await import("./voice/models");
  const cc = document.createElement("a");
  cc.href = "https://creativecommons.org/licenses/by/4.0/deed.pl";
  cc.target = "_blank";
  cc.rel = "noopener";
  cc.textContent = "CC BY 4.0";
  const model = document.createElement("li");
  model.append(`${DEFAULT_ASR.name} — ${DEFAULT_ASR.credit} Licencja: `, cc);
  const libraries = ["Silero VAD v6.2.3 (Silero Team) — licencja MIT", "ONNX Runtime Web 1.24.1 (Microsoft) — licencja MIT", "parakeet.js 1.4.4 (Yunus Seyhan Dede) — licencja MIT"];
  list.append(model, ...libraries.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
}

// The speech model stored in this browser (docs/DYKTOWANIE.md §5). Its code loads on demand, out of the main bundle.
async function dictationPane(pane: HTMLElement): Promise<void> {
  const store = await import("./voice/modelstore");
  const { DEFAULT_ASR } = await import("./voice/models");
  const describe = (bytes: number): string =>
    bytes ? `${DEFAULT_ASR.name}: ${Math.round(bytes / 1e6)} MB na tym urządzeniu` : "Nie pobrano — model pobierze się po pierwszym włączeniu dyktowania.";
  const remove = button("Usuń pobrany model", "btn btn-danger");
  let bytes = await store.usage();
  const model = row("Pobrany model mowy", describe(bytes), remove);
  remove.disabled = bytes === 0;
  const refresh = async (): Promise<void> => {
    bytes = await store.usage();
    model.querySelector("p")!.textContent = describe(bytes);
    remove.disabled = bytes === 0;
  };
  remove.addEventListener("click", async () => {
    if (!(await confirmDialog("Usunąć pobrany model mowy z tej przeglądarki? Przy następnym dyktowaniu pobierze się ponownie.", "Usuń"))) return;
    remove.disabled = true;
    try {
      // The worker reads the model files while dictation runs; stop it first. A no-op when dictation never started.
      (await import("./voice/controller")).stopDictation();
      await store.removeAll();
      toast("Usunięto model mowy.");
    } catch (e) {
      toast(errorText(e), true);
    } finally {
      await refresh();
    }
  });
  const intro = document.createElement("p");
  intro.className = "muted";
  intro.textContent = "Mowa jest rozpoznawana w całości na tym urządzeniu. Dźwięk nie jest nigdzie wysyłany ani zapisywany; do notatki trafia tylko gotowy tekst, zaszyfrowany jak przy pisaniu z klawiatury. Skrót: Ctrl+Shift+D. Język jest wykrywany automatycznie (polski i 24 inne języki europejskie).";
  pane.append(intro, model);
}

// Done tasks older than the chosen time leave their notes; only administrators change it.
async function retentionRow(pane: HTMLElement): Promise<void> {
  const loaded = await space.taskRetention!().catch(() => ({ months: 0, canEdit: false }));
  const canEdit = loaded.canEdit;
  let months = loaded.months;
  const choice = select("Usuwanie ukończonych zadań", RETENTION_CHOICES.map(([m, label]) => [String(m), label] as [string, string]), String(months), (v) => {
    const next = Number(v);
    const ask = next ? confirmDialog(`Ukończone zadania starsze niż wybrany czas zostaną usunięte z notatek. Niedokończone zadania zostają.`, "Ustaw") : Promise.resolve(true);
    void ask.then(async (ok) => {
      if (!ok) { choice.value = String(months); return; }
      try { await space.setTaskRetention!(next); months = next; toast("Zapisano ustawienie usuwania zadań."); }
      catch (e) { choice.value = String(months); toast(errorText(e), true); }
    });
  });
  choice.disabled = !canEdit || !space.setTaskRetention;
  pane.append(row("Usuwanie ukończonych zadań", canEdit ? "Po tym czasie od ukończenia zadanie znika z notatki (zostaje w historii wersji). Niedokończone zadania nie są usuwane." : "Zmienić to może administrator organizacji.", choice));
}

// Asks first: a notes space becomes an organization for every member, and it cannot go back.
async function changeKind(pane: HTMLElement, button: HTMLButtonElement): Promise<void> {
  const ok = await confirmDialog("Przestrzeń stanie się organizacją. Tej zmiany nie cofniesz.", "Zmień na organizację");
  if (!ok) return;
  button.disabled = true;
  try {
    await space.setKind("organizacja");
    space = { ...space, kind: "organizacja" };
    pane.replaceChildren();
    CATEGORIES[0].render(pane);
  } catch (e) {
    button.disabled = false;
    toast(errorText(e), true);
  }
}

// Settings modal. Esc closes, focus stays inside (openDialog), and focus returns to the opener.
export function openSettings(vaultName = "", info: SpaceSettings = space, devices?: BrowserBridge): void {
  if (closeSettings) return;
  spaceName = vaultName;
  space = info;
  devicesBridge = devices;
  // the Urządzenia category exists only with the browser bridge (Claude chats are a browser feature); dictation not in the desktop app
  const cats = CATEGORIES.filter((c) => (c.id !== "devices" || devicesBridge) && (c.id !== "dictation" || !inTauri()));
  closeSettings = openDialog({
    label: "Ustawienia",
    className: "settings",
    render(box, close) {
      const title = document.createElement("h2");
      title.textContent = "Ustawienia";
      const nav = document.createElement("nav");
      nav.className = "settings-nav";
      nav.setAttribute("aria-label", "Opcje");
      const pane = document.createElement("div");
      pane.className = "settings-pane";
      const exit = document.createElement("button");
      exit.type = "button";
      exit.className = "icon-btn settings-close";
      exit.title = "Zamknij";
      exit.setAttribute("aria-label", "Zamknij ustawienia");
      exit.textContent = "×";
      exit.addEventListener("click", () => close());
      const buttons = cats.map((cat) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "settings-cat";
        b.textContent = cat.name;
        b.addEventListener("click", () => show(cat, buttons));
        nav.append(b);
        return b;
      });
      const show = (cat: Category, all: HTMLButtonElement[]) => {
        all.forEach((b, i) => b.setAttribute("aria-current", String(cats[i] === cat)));
        pane.replaceChildren();
        cat.render(pane);
      };
      box.append(title, exit, nav, pane);
      show(cats[0], buttons);
    },
    onClose: () => {
      closeSettings = null;
    },
  });
}
