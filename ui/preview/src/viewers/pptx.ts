// PowerPoint through pptx-browser (PODGLAD-PLAN §5): the current slide is drawn large on a canvas, the others as
// thumbnails drawn when they scroll into view. The library's Google Fonts step is removed at build time (vite-offline.ts).
import { PptxRenderer } from "pptx-browser";
import { guardZip } from "../zipindex";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

export const MAX_SLIDES = 300;
const MAX_WIDTH = 1920;
const THUMB_WIDTH = 240;
const RESIZE_DELAY_MS = 150;

/** Canvas width in pixels for an area of `areaWidth` CSS pixels: device pixels, at most 1920, at least 1. */
export function slideWidth(areaWidth: number, dpr: number): number {
  return Math.max(1, Math.min(MAX_WIDTH, Math.round(areaWidth * dpr)));
}

function el<K extends "div" | "button" | "canvas" | "p" | "span">(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(text: string, aria: string): HTMLButtonElement {
  const b = el("button");
  b.type = "button";
  b.textContent = text;
  b.setAttribute("aria-label", aria);
  return b;
}

// Width of the content box, without the padding of the element.
function innerWidth(node: HTMLElement): number {
  const style = getComputedStyle(node);
  return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

// A canvas gives its pixels back at once; other nodes need nothing.
function release(node: HTMLElement): void {
  if (node instanceof HTMLCanvasElement) node.width = 0;
}

export function createPptxViewer(): Viewer {
  let ctx: ViewerContext | null = null;
  let renderer: PptxRenderer | null = null;
  let root: HTMLElement | null = null;
  let area: HTMLElement | null = null;
  let big: HTMLElement | null = null;
  let wart: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;
  let thumbs: HTMLButtonElement[] = [];
  let count = 0;
  let current = 0;
  let ready = false;
  let disposed = false;
  // Each request for the large slide gets a number; a drawing that finishes after a newer request is dropped.
  let version = 0;
  let bigChain: Promise<void> = Promise.resolve();
  let thumbChain: Promise<void> = Promise.resolve();
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  const setBig = (node: HTMLElement): void => {
    if (big) {
      big.replaceWith(node);
      release(big);
    } else {
      area?.prepend(node);
    }
    big = node;
  };

  // The old slide stays on screen until the new one is drawn.
  const drawBig = (i: number): void => {
    const r = renderer;
    const a = area;
    if (!r || !a) return;
    const v = ++version;
    bigChain = bigChain.then(async () => {
      if (v !== version || disposed) return;
      const canvas = el("canvas");
      try {
        await r.renderSlide(i, canvas, slideWidth(innerWidth(a), devicePixelRatio));
      } catch {
        if (v === version && !disposed) setBig(broken());
        return;
      }
      if (v === version && !disposed) setBig(canvas);
      else release(canvas);
    });
  };

  const broken = (): HTMLElement => {
    const p = el("p", "slajd-blad");
    p.textContent = "Tego slajdu nie da się pokazać.";
    return p;
  };

  const show = (i: number): void => {
    current = i;
    const label = `Slajd ${i + 1} z ${count}`;
    if (wart) wart.textContent = label;
    ctx?.status(label);
    thumbs.forEach((t, k) => {
      if (k === i) t.setAttribute("aria-current", "true");
      else t.removeAttribute("aria-current");
    });
    thumbs[i]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    drawBig(i);
  };

  // Returns false at the first or last slide: the caller then asks the app for the neighbouring file.
  const go = (i: number): boolean => {
    if (i < 0 || i >= count) return false;
    show(i);
    return true;
  };

  const drawThumb = (i: number, b: HTMLButtonElement): void => {
    const r = renderer;
    if (!r || i < 0) return;
    thumbChain = thumbChain.then(async () => {
      if (disposed) return;
      const canvas = el("canvas");
      try {
        await r.renderSlide(i, canvas, THUMB_WIDTH);
      } catch {
        // the thumbnail stays blank; the large slide shows the message
        return;
      }
      if (disposed) release(canvas);
      else b.append(canvas);
    });
  };

  const build = (c: ViewerContext, n: number): void => {
    root = el("div", "r r-slajdy");
    const list = el("div", "miniatury");
    list.setAttribute("aria-label", "Slajdy");
    area = el("div", "slajd-duzy");
    const bar = el("div", "r-narzedzia");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Nawigacja po slajdach");
    const prev = button("‹", "Poprzedni slajd");
    const next = button("›", "Następny slajd");
    wart = el("span", "wart");
    // at the ends of the deck the buttons pass the move on to the app, as the arrow keys do
    prev.addEventListener("click", () => {
      if (!go(current - 1)) c.nav(-1);
    });
    next.addEventListener("click", () => {
      if (!go(current + 1)) c.nav(1);
    });
    bar.append(prev, wart, next);
    area.append(bar);
    root.append(list, area);
    c.host.append(root);

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const b = entry.target as HTMLButtonElement;
          observer?.unobserve(b);
          drawThumb(thumbs.indexOf(b), b);
        }
      },
      { root: list, rootMargin: "200px" },
    );
    for (let i = 0; i < n; i++) {
      const b = el("button", "miniatura");
      b.type = "button";
      b.setAttribute("aria-label", `Slajd ${i + 1}`);
      b.addEventListener("click", () => go(i));
      thumbs.push(b);
      list.append(b);
      observer.observe(b);
    }
  };

  return {
    async open(bytes: ArrayBuffer, c: ViewerContext): Promise<void> {
      // the library unpacks the file: a zip bomb is refused before that
      guardZip(new Uint8Array(bytes));
      ctx = c;
      const r = new PptxRenderer();
      renderer = r;
      // shortcut: the library keeps every blob: URL of the deck until destroy(), so images stay in memory while the user browses, upgrade if a long deck shows it in measurements
      try {
        await r.load(bytes);
      } catch {
        throw new PreviewError("corrupt");
      }
      if (c.signal.aborted) return;
      count = r.slideCount;
      if (count === 0) throw new PreviewError("corrupt");
      if (count > MAX_SLIDES) throw new PreviewError("too-large");
      build(c, count);
      ready = true;
      show(0);
    },

    resize(): void {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (ready) drawBig(current);
      }, RESIZE_DELAY_MS);
    },

    key(e: KeyboardEvent): boolean {
      if (!ready || e.ctrlKey || e.metaKey || e.altKey) return false;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          return go(current - 1);
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          return go(current + 1);
        case "Home":
          if (current !== 0) show(0);
          return true;
        case "End":
          if (current !== count - 1) show(count - 1);
          return true;
        default:
          return false;
      }
    },

    dispose(): void {
      disposed = true;
      ready = false;
      version++;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      observer = null;
      // releases the blob: URLs of the images the library made
      renderer?.destroy();
      renderer = null;
      root?.querySelectorAll("canvas").forEach(release);
      if (big) release(big);
      root?.remove();
      root = null;
      area = null;
      big = null;
      wart = null;
      thumbs = [];
      ctx = null;
    },
  };
}
