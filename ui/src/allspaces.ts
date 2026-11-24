// "Mój kalendarz": one calendar of what the user has in every space they can open. It holds the organization events
// they see, their own calendar notes (the personal space) and their tasks due in the range. The merge is pure
// (myItems); browserSpaces reads every vault of the browser, main.ts supplies the desktop's bridge calls.
import * as Y from "yjs";
import type { Bridge, BrowserVaultSnapshot } from "./bridge";
import type { BrowserBridge } from "./browserauth";
import { decryptSnapshot, openDb, readEpochKeys, readStored } from "./browserauth";
import type { DataRecord, ModuleData } from "./records";
import { visibleTo } from "./records";
import type { OrganizationSnapshot } from "./taskhistory";
import type { TaskRow } from "./orgtasks";
import { occurrences as eventOccurrences } from "./availability";
import { dayAndMinute, localMidnight } from "./calendar/dates";
import { dateLabel } from "./calendar/details";
import { isCalendarText, load, unsavedEvent, type Occurrence } from "./calendar/model";
import type { CalendarSource, CalendarView } from "./calendar/view";
import { el } from "./dom";
import { chooseTarget, savePending, type EventTarget } from "./calendar/target";
import { errorText, openDialog, toast } from "./widgets";
import { base64ToBytes, importVaultKey, listSharedVaults, openAccess, ownVaults, personalVaultId, type VaultInfo, type VaultRow } from "./vaults";

/** A space as the calendar reads it. The browser also fills `calendars` (the personal space's calendar note texts) and `tasks` (this user's task rows). */
export interface SpaceSource {
  path: string;
  name: string;
  data: ModuleData;
  identity: OrganizationSnapshot;
  calendars?: string[];
  tasks?: TaskRow[];
}

export interface MyCalendarInput {
  me: string;
  /** Organization spaces: their events, filtered by visibleTo. */
  spaces: SpaceSource[];
  /** Calendar notes of the personal space: the text of each one, with the space's name. */
  notes: { space: string; path: string | null; text: string }[];
  /** Task rows per space; only those assigned to `me` with a due date are shown. */
  tasks: { space: string; path: string | null; rows: TaskRow[] }[];
}

export interface MyItem {
  occ: Occurrence;
  space: string;
  /** The space to switch to on click; null when it is the open one. */
  path: string | null;
}

function occurrence(title: string, startDay: number, startMin: number | null, endDay: number, endMin: number | null, description = ""): Occurrence {
  return { event: unsavedEvent(title, { startDay, startMin, endDay, endMin }, { description }), startDay, startMin, endDay, endMin };
}

/** Everything of `input` in `fromDay..=toDay`: the visible organization events, the calendar notes, the tasks due. */
export function myItems(input: MyCalendarInput, fromDay: number, toDay: number): MyItem[] {
  const items: MyItem[] = [];
  const from = localMidnight(fromDay), until = localMidnight(toDay + 1);
  for (const space of input.spaces) {
    const identity = { ...space.identity, me: input.me };
    for (const record of Object.values(space.data.records) as DataRecord[]) {
      if (record.kind !== "event" || record.deleted || !visibleTo(record, identity)) continue;
      for (const { start, end } of eventOccurrences(record, from, until)) {
        const [startDay, startMin] = dayAndMinute(start), [endDay, endMin] = dayAndMinute(end);
        items.push({ occ: occurrence(String(record.name ?? ""), startDay, startMin, endDay, endMin, String(record.description ?? "")), space: space.name, path: space.path });
      }
    }
  }
  for (const note of input.notes)
    for (const occ of load(note.text, fromDay, toDay).occurrences) items.push({ occ, space: note.space, path: note.path });
  for (const part of input.tasks)
    for (const row of part.rows)
      if (row.due !== null && !row.done && row.assignee_user_ids?.includes(input.me) && row.due >= fromDay && row.due <= toDay)
        items.push({ occ: occurrence(row.text, row.due, null, row.due, null, row.note ?? ""), space: part.space, path: part.path });
  return items;
}

/** The calendar of `input`. Clicking an item opens its space through `switchTo`; no edits here. */
export function myCalendarSource(
  input: MyCalendarInput,
  current: string | null,
  switchTo: (path: string) => Promise<unknown>,
  create: (day: number, startMin: number | null) => void,
): CalendarSource {
  const origin = new WeakMap<object, MyItem>();
  return {
    occurrences(fromDay, toDay) {
      return myItems(input, fromDay, toDay).map((item) => {
        // the space's name in the title: the calendar is one list of every space
        const occ = { ...item.occ, event: { ...item.occ.event, title: `${item.occ.event.title} · ${item.space}` } };
        origin.set(occ.event, { ...item, occ });
        return occ;
      });
    },
    details(occ) {
      const item = origin.get(occ.event);
      if (!item) return;
      openDialog({
        label: item.occ.event.title,
        render(box, close) {
          box.append(el("h2", "", item.occ.event.title), el("p", "muted", `${item.space} · ${dateLabel(item.occ)}`));
          const actions = el("div", "modal-actions");
          if (item.path && item.path !== current) {
            const go = el("button", "btn", "Przejdź do przestrzeni");
            go.type = "button";
            go.addEventListener("click", () => { close(); void switchTo(item.path!); });
            actions.append(go);
          }
          const back = el("button", "btn", "Zamknij");
          back.type = "button";
          back.addEventListener("click", close);
          actions.append(back);
          box.append(actions);
        },
      });
    },
    create,
  };
}

// ---- the browser: every vault's decrypted state ---------------------------------------------------------------------

const textOf = (update: string): string => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base64ToBytes(update));
  return doc.getText("content").toString();
};

/** A vault's state from this device: the open one live, the others from their stored encrypted copy (no write). */
async function storedSnapshot(db: IDBDatabase, userId: string, vault: VaultInfo, personal: CryptoKey): Promise<BrowserVaultSnapshot | null> {
  const stored = await readStored(db, userId, vault.id);
  if (!stored?.envelope) return null;
  // shortcut: the vault key comes from the server's current member record; a vault whose access was removed is skipped.
  const access = await openAccess(vault.id, userId, personal);
  const epoch = stored.envelope.keyEpoch;
  const key = epoch === undefined || epoch === access.keyEpoch
    ? access.rawKey ? await importVaultKey(access.rawKey) : personal
    : (await readEpochKeys(db, userId, vault.id, personal)).get(epoch)?.key;
  if (!key) return null;
  return decryptSnapshot(stored.envelope, access.vault.ownerUserId, vault.id, key);
}

/**
 * Every vault of the browser this user can open, read without writing anything. A vault with no copy on this device,
 * or without access now, is listed in `skipped`. Protected projects' notes are not in a vault's notes, so they are left out.
 * shortcut: a protected project's sealed notes are not shown here, only the vault's plain notes.
 */
export async function browserSpaces(bridge: BrowserBridge): Promise<{ spaces: SpaceSource[]; skipped: string[] }> {
  const me = bridge.user.id;
  const shared = await listSharedVaults().catch(() => [] as VaultInfo[]);
  const vaults: VaultInfo[] = [...ownVaults(bridge.user), ...shared];
  if (!vaults.some((v) => v.id === bridge.vault.id)) vaults.push(bridge.vault);
  const spaces: SpaceSource[] = [], skipped: string[] = [];
  const db = await openDb();
  try {
    // the vaults are read at once; the results keep the vaults' order
    const read = await Promise.all(vaults.map(async (vault): Promise<SpaceSource | null> => {
      const snapshot = vault.id === bridge.vault.id
        ? bridge.exportBrowserSnapshot(bridge.vault.ownerUserId, bridge.vault.id)
        : await storedSnapshot(db, me, vault, bridge.personalKey).catch(() => null);
      if (!snapshot) return null;
      const { state } = snapshot;
      const deleted = new Set((state.deleted ?? []).map((t) => t.id));
      const personal = vault.id === personalVaultId(me);
      return {
        path: vault.id,
        name: vault.name,
        data: state.records.data,
        identity: { ...state.organization, me },
        tasks: state.taskCaches.flatMap(([, saved]) => { const c = saved as { userId?: string; rows?: TaskRow[] }; return c.userId === me ? (c.rows ?? []) : []; }),
        calendars: personal ? state.notes.filter((n) => !deleted.has(n.id)).map((n) => textOf(n.yjsUpdateBase64)).filter(isCalendarText) : undefined,
      };
    }));
    vaults.forEach((vault, i) => {
      const space = read[i];
      if (space) spaces.push(space);
      else skipped.push(vault.name);
    });
  } finally {
    db.close();
  }
  return { spaces, skipped };
}

/** The spaces of the browser the user can add an event to: their own notes and the shared vaults they may edit. */
export async function browserTargets(bridge: BrowserBridge): Promise<EventTarget[]> {
  const me = bridge.user.id;
  const shared = await listSharedVaults().catch(() => [] as VaultRow[]);
  const rows: VaultInfo[] = [...ownVaults(bridge.user), ...shared.filter((v) => v.role !== "viewer")];
  const seen = new Set<string>();
  return rows.filter((v) => !seen.has(v.id) && seen.add(v.id)).map((v) => ({
    path: v.id,
    name: v.name,
    personal: v.id === personalVaultId(me),
    organization: v.kind === "organizacja",
    current: v.id === bridge.vault.id,
  }));
}

// ---- the screen -----------------------------------------------------------------------------------------------------

export interface MyCalendarHost {
  bridge: Bridge;
  browser: BrowserBridge | null;
  view: CalendarView;
  /** The open space's path (browser: the vault id), null on the desktop. */
  current: string | null;
  /** The open space's name, for its calendar notes on the desktop. */
  currentName: string;
  /** Desktop: the texts of the open personal space's calendar notes (none in an organization). */
  openNotes: () => Promise<string[]>;
  switchTo: (path: string) => Promise<unknown>;
  /** The spaces the user can add an event to. */
  targets: () => Promise<EventTarget[]>;
  /** Adds an event in the given space, which is the open one (the caller switches first otherwise). */
  addHere: (t: EventTarget, day: number, startMin: number | null) => void;
  /** Hides the editor, the graph and the organization pages before the calendar is drawn. */
  hideOthers: () => void;
}

type DesktopCopy = { name: string; path: string; saved: { userId?: string; rows: TaskRow[] } };

async function gather(host: MyCalendarHost): Promise<{ input: MyCalendarInput; skipped: string[] }> {
  if (host.browser) {
    const me = host.browser.user.id;
    const { spaces, skipped } = await browserSpaces(host.browser);
    const notes = spaces.flatMap((s) => (s.calendars ?? []).map((text) => ({ space: s.name, path: s.path, text })));
    return { input: { me, spaces, notes, tasks: spaces.map((s) => ({ space: s.name, path: s.path, rows: s.tasks ?? [] })) }, skipped };
  }
  // shortcut: on the desktop the personal calendar is the open space's notes plus the task copies (task_caches); a space never opened here has no copy.
  const [{ me }, spaces, copies, own] = await Promise.all([
    host.bridge.call<OrganizationSnapshot>("organization_snapshot"),
    host.bridge.call<SpaceSource[]>("organization_global_records").catch(() => [] as SpaceSource[]),
    host.bridge.call<DesktopCopy[]>("task_caches").catch(() => [] as DesktopCopy[]),
    host.openNotes(),
  ]);
  return {
    input: {
      me,
      spaces,
      notes: own.map((text) => ({ space: host.currentName, path: null, text })),
      tasks: copies.filter((c) => c.saved.userId === me).map((c) => ({ space: c.name, path: c.path, rows: c.saved.rows ?? [] })),
    },
    skipped: [],
  };
}

/** Opens "Mój kalendarz" in the calendar area. Throws when the spaces cannot be read; the caller shows the error. */
export async function showMyCalendar(host: MyCalendarHost): Promise<void> {
  const { input, skipped } = await gather(host);
  host.hideOthers();
  const create = (day: number, startMin: number | null): void => {
    host.targets()
      .then((targets) => chooseTarget(targets, day, startMin, (t) => {
        if (t.current) return host.addHere(t, day, startMin);
        // another space reloads the window: the date waits for it (takePending in main.ts)
        savePending({ path: t.path, day, startMin });
        void host.switchTo(t.path);
      }))
      .catch((e: unknown) => toast(errorText(e), true));
  };
  host.view.showSource(myCalendarSource(input, host.current, host.switchTo, create));
  if (skipped.length) toast(`Pominięto (nie otwarto na tym urządzeniu lub brak dostępu): ${skipped.join(", ")}.`);
}
