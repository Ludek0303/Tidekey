// Where a new event goes: the spaces the user can add to, the dialog that picks one, and the date kept across a
// switch of space (the space reloads, so the pending date waits in sessionStorage). Only the date travels, never a title.
import { el } from "../dom";
import { icon } from "../icons";
import { openDialog, toast } from "../widgets";
import { dayTitle, hhmm } from "./dates";

// personal: only the user sees it (Moje notatki); organization: an organization space (its own visibility rules).
export interface EventTarget { path: string; name: string; personal: boolean; organization: boolean; current: boolean }
export interface PendingEvent { path: string; day: number; startMin: number | null }

const KEY = "notes.pendingEvent";
const MAX_AGE_MS = 2 * 60_000;

export function savePending(p: PendingEvent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path: p.path, day: p.day, startMin: p.startMin, at: Date.now() }));
  } catch {
    // no storage: the event is not added after the switch, the user adds it by hand
  }
}

/** The pending event of this space, once. It is removed either way; a stale or foreign one is dropped. */
export function takePending(currentPath: string): PendingEvent | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as { path: unknown; day: unknown; startMin: unknown; at: unknown };
    const age = Date.now() - (p.at as number);
    if (p.path !== currentPath || typeof p.day !== "number" || !(p.startMin === null || typeof p.startMin === "number")) return null;
    if (!(age >= 0 && age < MAX_AGE_MS)) return null;
    return { path: p.path, day: p.day, startMin: p.startMin };
  } catch {
    return null;
  }
}

const whoSees = (t: EventTarget): string =>
  t.personal ? "Widzisz je tylko Ty." : t.organization ? "Widzą je zaproszone osoby oraz właściciele i administratorzy organizacji." : "Widzą je wszyscy członkowie tej przestrzeni.";

const whenOf = (day: number, startMin: number | null): string => (startMin === null ? dayTitle(day) : `${dayTitle(day)}, ${hhmm(startMin)}`);

/** Adds the event at once when there is one space, asks where otherwise. `onPick` gets the chosen space. */
export function chooseTarget(targets: EventTarget[], day: number, startMin: number | null, onPick: (t: EventTarget) => void): void {
  if (targets.length === 0) {
    toast("Nie masz przestrzeni, w której możesz dodać wydarzenie.", true);
    return;
  }
  if (targets.length === 1) {
    onPick(targets[0]);
    return;
  }
  // the personal space first; the sort is stable, so the rest keep their order
  const sorted = [...targets].sort((a, b) => Number(b.personal) - Number(a.personal));
  const preselected = sorted.find((t) => t.current) ?? sorted.find((t) => t.personal) ?? sorted[0];
  openDialog({
    label: "Dodaj wydarzenie",
    render(box, close) {
      const form = el("form");
      const radios: HTMLInputElement[] = [];
      const fieldset = el("fieldset", "cal-target");
      fieldset.append(el("legend", "", "Gdzie zapisać wydarzenie"));
      for (const t of sorted) {
        const label = el("label", "cal-target-option");
        const radio = el("input");
        radio.type = "radio";
        radio.name = "cal-target";
        radio.checked = t === preselected;
        radios.push(radio);
        const text = el("span", "cal-target-text");
        text.append(
          el("span", "cal-target-name", t.name),
          el("span", "cal-target-who", whoSees(t)),
        );
        label.append(radio, icon(t.personal ? "lock" : "users"), text);
        fieldset.append(label);
      }
      const picked = (): EventTarget => sorted[radios.findIndex((r) => r.checked)];
      const actions = el("div", "modal-actions");
      const cancel = el("button", "btn", "Anuluj");
      cancel.type = "button";
      cancel.addEventListener("click", () => close());
      const ok = el("button", "btn btn-primary");
      ok.type = "submit";
      const label = () => (picked().current ? "Dodaj wydarzenie" : "Przejdź do przestrzeni i dodaj");
      ok.textContent = label();
      form.addEventListener("change", () => { ok.textContent = label(); });
      // Enter in the form sends it, so the primary button needs no key handler
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const target = picked();
        close();
        onPick(target);
      });
      actions.append(cancel, ok);
      form.append(el("h2", "", "Dodaj wydarzenie"), el("p", "muted", whenOf(day, startMin)), fieldset, actions);
      box.append(form);
    },
  });
}
