// Popovers of the calendar: one at a time, next to its anchor. A pointer outside it or Esc closes it.
import { el } from "./chips";

let closeCurrent: (() => void) | null = null;

export function openPopover(anchor: HTMLElement, label: string, build: (box: HTMLElement, close: () => void) => void): void {
  closeCurrent?.();
  const box = el("div", "cal-pop");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", label);
  const onPointer = (e: Event) => {
    if (!box.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close();
  };
  function close(): void {
    if (!box.isConnected) return;
    box.remove();
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
    closeCurrent = null;
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  build(box, close);
  document.body.append(box);
  closeCurrent = close;
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = box;
  const fitsBelow = r.bottom + 6 + h <= window.innerHeight - 8;
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  box.style.top = `${Math.max(8, fitsBelow ? r.bottom + 6 : r.top - h - 6)}px`;
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  box.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

export function closePopover(): void {
  closeCurrent?.();
}
