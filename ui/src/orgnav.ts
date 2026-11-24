//! The library's sections in an organization space: Przegląd, Projekty, Zadania, Pliki and the rest. The file tree stays
//! under the nav; each section opens its own view (Projekty lists the projects on its page, projectsview.ts).

import { el } from "./dom";
import { type IconName, icon } from "./icons";

export type Section = "overview" | "projects" | "tasks" | "files" | "people" | "notifications" | "activity" | "graphs" | "calendars" | "inventory" | "availability";

const LABELS: Record<Section, [string, IconName]> = {
  overview: ["Przegląd", "layout-dashboard"],
  projects: ["Projekty", "folder-kanban"],
  tasks: ["Zadania", "list-checks"],
  files: ["Pliki", "files"],
  notifications: ["Powiadomienia", "bell"],
  graphs: ["Grafy", "network"],
  activity: ["Aktywność", "activity"],
  people: ["Osoby i grupy", "users"],
  calendars: ["Kalendarze", "calendar"],
  inventory: ["Inwentarze", "package"],
  availability: ["Dostępność", "calendar-clock"],
};

// The sidebar's groups, in order; each group is a collapsible list.
const GROUPS: [string, Section[]][] = [
  ["Praca", ["overview", "projects", "tasks", "files"]],
  ["Zespół", ["notifications", "activity", "people", "graphs"]],
  ["Moduły", ["calendars", "inventory", "availability"]],
];

export interface OrgNavActions {
  section(section: Section): void;
}

const GROUPS_KEY = "notes.orgnav.open";
function openGroups(): string[] {
  try { const v: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "null"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : ["Praca"]; }
  catch { return ["Praca"]; }
}
function saveGroup(title: string, open: boolean): void {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...new Set([...openGroups().filter((t) => t !== title), ...(open ? [title] : [])])])); }
  catch { /* the choice lasts until reload */ }
}

/** "organization": every group; "personal": one person's notatki, only Zadania; "off": hidden (no space open). */
export type NavMode = "organization" | "personal" | "off";

export class OrgNav {
  readonly nav = el("nav", "org-nav");
  private readonly buttons = new Map<Section, HTMLButtonElement>();
  private readonly counts = new Map<Section, HTMLElement>();
  private readonly groups = new Map<string, HTMLElement>();
  private mode: NavMode = "off";
  // The choice of setSectionVisible: false hides the section in every mode.
  private readonly allowed = new Map<Section, boolean>();

  constructor(
    pane: HTMLElement,
    private readonly actions: OrgNavActions,
  ) {
    for (const [title, sections] of GROUPS) {
      // Only "Praca" starts open, so the library under the nav keeps its room; the choice is remembered on this device.
      const group = el("details", "org-nav-group");
      this.groups.set(title, group);
      group.open = openGroups().includes(title);
      group.addEventListener("toggle", () => saveGroup(title, group.open));
      const items = el("div", "org-nav-items");
      for (const section of sections) {
        const [label, name] = LABELS[section];
        const b = el("button", "org-nav-btn");
        b.type = "button";
        b.append(icon(name), el("span", "org-nav-label", label));
        b.addEventListener("click", () => this.actions.section(section));
        this.buttons.set(section, b);
        items.append(b);
      }
      group.append(el("summary", "org-nav-group-title", title), items);
      this.nav.append(group);
    }
    pane.prepend(this.nav);
    this.apply();
  }

  /** Shown in an organization or a personal space; a personal space has only the Zadania button, in the Praca group. */
  setMode(mode: NavMode): void {
    this.mode = mode;
    this.apply();
  }

  /** Shows or hides a section's button (activity is for administrators only). */
  setSectionVisible(section: Section, on: boolean): void {
    this.allowed.set(section, on);
    this.apply();
  }

  private apply(): void {
    const personal = this.mode === "personal";
    this.nav.hidden = this.mode === "off";
    this.nav.setAttribute("aria-label", personal ? "Sekcje notatek" : "Sekcje organizacji");
    for (const [title, group] of this.groups) group.hidden = personal && title !== "Praca";
    for (const [section, b] of this.buttons) {
      const inMode = this.mode === "organization" || (personal && section === "tasks");
      b.hidden = !inMode || this.allowed.get(section) === false;
    }
  }

  /** A count on a section's button (unread notifications). Zero hides it. */
  setCount(section: Section, count: number): void {
    const button = this.buttons.get(section);
    if (!button) return;
    let badge = this.counts.get(section);
    if (!badge) { badge = el("span", "org-nav-count"); button.append(badge); this.counts.set(section, badge); }
    badge.textContent = count > 0 ? String(count) : "";
    badge.hidden = count <= 0;
    badge.setAttribute("aria-label", `${count} nieprzeczytanych`);
  }

  /** Marks the section that is on screen. */
  select(section: Section): void {
    for (const [s, b] of this.buttons) b.setAttribute("aria-pressed", String(s === section));
    // a collapsed group must not hide the section on screen
    const group = this.buttons.get(section)?.closest("details");
    if (group) group.open = true;
  }

  /** No section is marked: a note is on screen. */
  clear(): void {
    for (const b of this.buttons.values()) b.setAttribute("aria-pressed", "false");
  }
}
