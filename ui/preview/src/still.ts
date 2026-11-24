// The view of one still image in the frame: zoom, pan and "Dopasuj" (PanZoom), the zoom bar, an optional label and,
// for multi-page files, a page bar. Image, TIFF and PSD viewers all draw through it (PODGLAD-PLAN §5).
import type { Command } from "../../src/preview/protocol";
import { PanZoom, bindPanZoom } from "./panzoom";
import { zoomBar } from "./ui";
import { PreviewError } from "./viewers/index";

const MAX_SIDE = 30000;
const MAX_PIXELS = 100_000_000;
// Zoom buttons and keys; the wheel uses a finer step in panzoom.ts.
const KEY_STEP = 1.25;
// The fitted image keeps this space from the frame edges. The view is inset by it, so zoomed pictures stay inside too.
const MARGIN_PX = 24;

export interface StillOptions {
  /** Text in the top left corner (".etykieta"). */
  label?: string;
  pages?: { index: number; count: number; go(index: number): void };
}

export interface StillView {
  command(name: Command): void;
  resize(): void;
  /** false when a horizontal drag belongs to the image (zoomed or moved). */
  swipe(): boolean;
  /** true when the key turned a page; the arrow keys then do not turn the file. */
  key(e: KeyboardEvent): boolean;
  dispose(): void;
}

/** The header or decoder size limits: a picture past them is refused before any pixel is allocated. */
export function checkDims(width: number, height: number): void {
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new PreviewError("too-large");
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The label of the first frame of a video, with its length when it is known. */
export function firstFrameLabel(durationMs?: number): string {
  return durationMs === undefined ? "Pierwsza klatka" : `Pierwsza klatka · ${clock(durationMs)}`;
}

function button(text: string, aria: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.setAttribute("aria-label", aria);
  b.addEventListener("click", onClick);
  return b;
}

/** Draws `element` (already sized width × height) in the frame `host`. */
export function showStill(
  host: HTMLElement,
  element: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
  options: StillOptions = {},
): StillView {
  const area = document.createElement("div");
  area.className = "r-obraz";
  area.style.inset = `${MARGIN_PX}px`;
  area.append(element);

  const command = (name: Command): void => {
    switch (name) {
      case "zoom-in":
        pz.zoomBy(KEY_STEP);
        break;
      case "zoom-out":
        pz.zoomBy(1 / KEY_STEP);
        break;
      case "zoom-reset":
        pz.reset();
        break;
      case "fit":
        pz.fitView();
        break;
    }
  };

  const bar = zoomBar(command);
  const frame = document.createElement("div");
  frame.className = "r";
  frame.append(area, bar.el);
  if (options.label) {
    const label = document.createElement("div");
    label.className = "etykieta";
    label.textContent = options.label;
    frame.append(label);
  }

  const pages = options.pages;
  if (pages) {
    const prev = button("‹", "Poprzednia strona", () => pages.go(pages.index - 1));
    const next = button("›", "Następna strona", () => pages.go(pages.index + 1));
    prev.disabled = pages.index === 0;
    next.disabled = pages.index >= pages.count - 1;
    const where = document.createElement("span");
    where.className = "wart";
    where.textContent = `Strona ${pages.index + 1} z ${pages.count}`;
    bar.el.prepend(prev, where, next);
  }
  host.append(frame);

  const pz = new PanZoom((t) => {
    element.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    element.style.imageRendering = t.scale > 4 ? "pixelated" : "auto";
    bar.setValue(`${Math.round(t.scale * 100)}%`);
  });
  const detach = bindPanZoom(area, pz);
  pz.fit(area.clientWidth, area.clientHeight, width, height);

  return {
    command,

    resize: () => pz.resize(area.clientWidth, area.clientHeight),

    swipe: () => pz.fitMode,

    key(e: KeyboardEvent): boolean {
      if (!pages || e.ctrlKey || e.metaKey || e.altKey) return false;
      const step = e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : e.key === "ArrowRight" || e.key === "PageDown" ? 1 : 0;
      const index = pages.index + step;
      if (step === 0 || index < 0 || index >= pages.count) return false;
      pages.go(index);
      return true;
    },

    dispose(): void {
      detach();
      frame.remove();
    },
  };
}
