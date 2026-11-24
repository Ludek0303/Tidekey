// PDF through pdf.js (PODGLAD-PLAN §5): the pages one under another, each drawn to a canvas once it is near the view.
// Only the pages near the view keep their canvas, at most MAX_LIVE at a time.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfBinaryFactory, PDFJS_DATA_URLS } from "../pdfdata";
import { startPdfWorker, type PdfWorkerHandle } from "../pdfworker";
import { releaseWorker } from "../worker";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const MAX_PAGES = 2000;
const MAX_LIVE = 12;
const RENDER_TIMEOUT_MS = 30_000;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_DPR = 2;
const SIZE_BATCH = 50;
const VIEW_MARGIN_PX = 48;
const PAD_TOP_PX = 18;
const GAP_PX = 14;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const FIT_MAX = 2;
const MIN_FIT_SCALE = 0.05;

interface Size { width: number; height: number }

/** The page nearest the middle of the view; `tops` are the page offsets, sorted. */
export function pageNear(tops: number[], sizes: Size[], scale: number, centre: number): number {
  let i = 0;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= centre) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const dist = (p: number): number => Math.abs(tops[p] + (sizes[p].height * scale) / 2 - centre);
  let best = i;
  if (i > 0 && dist(i - 1) < dist(best)) best = i - 1;
  if (i + 1 < tops.length && dist(i + 1) < dist(best)) best = i + 1;
  return best;
}

/** Errors of pdf.js mapped to the codes of the protocol. A password is not asked for: the file is not shown. */
function classify(err: unknown): PreviewError {
  if (err instanceof PreviewError) return err;
  if (err instanceof pdfjs.PasswordException) return new PreviewError("unsupported");
  return new PreviewError("corrupt");
}

export function createPdfViewer(): Viewer {
  let disposed = false;
  let task: pdfjs.PDFDocumentLoadingTask | null = null;
  let doc: pdfjs.PDFDocumentProxy | null = null;
  let handle: PdfWorkerHandle | null = null;
  let frame: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  let counter: HTMLElement | null = null;
  let io: IntersectionObserver | null = null;
  let raf = 0;
  let sizes: Size[] = [];
  let tops: number[] = [];
  let pageEls: HTMLElement[] = [];
  let canvases = new Map<number, HTMLCanvasElement>();
  let failed = new Set<number>();
  let inView = new Set<number>();
  let wanted: number[] = [];
  let indexOf = new Map<Element, number>();
  let current = 0;
  let scale = 1;
  let fitMode = true;
  let generation = 0;
  let busy = false;
  let width = -1;
  let ctx: ViewerContext | null = null;

  const fitScale = (): number => {
    const widest = Math.max(...sizes.map((s) => s.width));
    const view = (scroller?.clientWidth ?? 0) - VIEW_MARGIN_PX;
    return Math.max(MIN_FIT_SCALE, Math.min(view / widest, FIT_MAX));
  };

  const clampScale = (s: number, fit: number): number => Math.min(fit * ZOOM_MAX, Math.max(fit * ZOOM_MIN, s));

  const showStatus = (): void => {
    const text = `Strona ${current + 1} z ${sizes.length}`;
    if (counter) counter.textContent = text;
    ctx?.status(text);
  };

  const release = (i: number): void => {
    const c = canvases.get(i);
    if (!c) return;
    canvases.delete(i);
    c.width = 0;
    c.height = 0;
    c.remove();
  };

  const releaseAll = (): void => {
    for (const i of [...canvases.keys()]) release(i);
    failed.clear();
  };

  const fail = (i: number): void => {
    failed.add(i);
    const el = pageEls[i];
    el.classList.add("blad");
    el.textContent = "Nie udało się narysować strony.";
  };

  // Lays the pages out at `next` scale and keeps the current page at the same place in the view.
  const layout = (next: number): void => {
    if (!scroller) return;
    const fit = fitScale();
    const old = scale;
    const hadPages = tops.length > 0;
    const offset = scroller.scrollTop - (tops[current] ?? 0);
    scale = clampScale(next, fit);
    let y = PAD_TOP_PX;
    tops = sizes.map((s, i) => {
      const top = y;
      const el = pageEls[i];
      el.style.width = `${s.width * scale}px`;
      el.style.height = `${s.height * scale}px`;
      y += s.height * scale + GAP_PX;
      return top;
    });
    generation++;
    releaseAll();
    if (hadPages) scroller.scrollTop = tops[current] + offset * (scale / old);
    schedule();
  };

  const goTo = (i: number): void => {
    if (!scroller) return;
    current = i;
    scroller.scrollTop = tops[i] - PAD_TOP_PX;
    showStatus();
    schedule();
  };

  // Decides which pages keep a canvas: the ones near the view, nearest the middle first, at most MAX_LIVE.
  const schedule = (): void => {
    const near = [...inView].sort((a, b) => Math.abs(a - current) - Math.abs(b - current)).slice(0, MAX_LIVE);
    const keep = new Set(near);
    for (const i of [...canvases.keys()]) if (!keep.has(i)) release(i);
    wanted = near;
    void pump();
  };

  const draw = async (i: number, gen: number): Promise<void> => {
    if (!doc) return;
    let page: pdfjs.PDFPageProxy;
    try {
      page = await doc.getPage(i + 1);
    } catch {
      if (!disposed && gen === generation) fail(i);
      return;
    }
    try {
      if (disposed || gen !== generation) return;
      const cssW = sizes[i].width * scale;
      const cssH = sizes[i].height * scale;
      // device pixels up to 2 per CSS pixel, and at most MAX_CANVAS_PIXELS on the canvas
      const k = Math.min(Math.min(window.devicePixelRatio || 1, MAX_DPR), Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
      const viewport = page.getViewport({ scale: scale * k });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const g = canvas.getContext("2d");
      if (!g) throw new PreviewError("internal");
      const task = page.render({ canvas, canvasContext: g, viewport });
      const timer = setTimeout(() => task.cancel(), RENDER_TIMEOUT_MS);
      try {
        await task.promise;
      } finally {
        clearTimeout(timer);
      }
      if (disposed || gen !== generation) return;
      canvases.set(i, canvas);
      pageEls[i].replaceChildren(canvas);
    } catch {
      if (!disposed && gen === generation) fail(i);
    } finally {
      page.cleanup();
    }
  };

  // Draws the wanted pages one after another; a page that fails shows its message and the others go on.
  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        if (disposed) break;
        const i = wanted.find((p) => !canvases.has(p) && !failed.has(p));
        if (i === undefined) break;
        await draw(i, generation);
      }
    } finally {
      busy = false;
    }
  };

  const updateCurrent = (): void => {
    if (!scroller || sizes.length === 0) return;
    const next = pageNear(tops, sizes, scale, scroller.scrollTop + scroller.clientHeight / 2);
    if (next !== current) {
      current = next;
      showStatus();
    }
  };

  const zoom = (next: number, fit: boolean): void => {
    fitMode = fit;
    layout(next);
    showStatus();
  };

  const bar = (onCommand: (name: "zoom-in" | "zoom-out" | "fit") => void): { el: HTMLElement; set(text: string): void } => {
    const el = document.createElement("div");
    el.className = "r-narzedzia";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "Strony");
    const text = document.createElement("span");
    text.className = "wart";
    const button = (label: string, aria: string | null, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", onClick);
      return b;
    };
    el.append(
      button("−", "Oddal", () => onCommand("zoom-out")),
      text,
      button("+", "Przybliż", () => onCommand("zoom-in")),
      button("Dopasuj", null, () => onCommand("fit")),
    );
    return { el, set: (t) => { text.textContent = t; } };
  };

  let toolbar: { el: HTMLElement; set(text: string): void } | null = null;

  const command = (name: "zoom-in" | "zoom-out" | "zoom-reset" | "fit"): void => {
    if (!doc) return;
    switch (name) {
      case "zoom-in":
        zoom(scale * ZOOM_STEP, false);
        break;
      case "zoom-out":
        zoom(scale / ZOOM_STEP, false);
        break;
      case "zoom-reset":
        zoom(1, false);
        break;
      case "fit":
        zoom(fitScale(), true);
        break;
    }
  };

  return {
    async open(bytes: ArrayBuffer, c: ViewerContext): Promise<void> {
      ctx = c;
      const started = await startPdfWorker(pdfjs, c.spawnWorker);
      handle = started;
      if (c.signal.aborted) return;
      const loading = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        worker: started?.pdf,
        BinaryDataFactory: pdfBinaryFactory(c.asset),
        ...PDFJS_DATA_URLS,
        useWorkerFetch: false,
        enableXfa: false,
        disableAutoFetch: true,
        disableStream: true,
        useSystemFonts: true,
      });
      task = loading;
      try {
        doc = await loading.promise;
        if (c.signal.aborted) return;
        if (doc.numPages > MAX_PAGES) throw new PreviewError("too-large");
        if (doc.numPages === 0) throw new PreviewError("corrupt");
        const d = doc;
        const all: Size[] = [];
        for (let first = 1; first <= d.numPages; first += SIZE_BATCH) {
          const last = Math.min(d.numPages, first + SIZE_BATCH - 1);
          const batch: Promise<Size>[] = [];
          for (let p = first; p <= last; p++) {
            batch.push(
              d.getPage(p).then((page) => {
                const v = page.getViewport({ scale: 1 });
                page.cleanup();
                return { width: v.width, height: v.height };
              }),
            );
          }
          all.push(...(await Promise.all(batch)));
          if (c.signal.aborted) return;
        }
        sizes = all;
      } catch (err) {
        if (c.signal.aborted) return;
        throw classify(err);
      }
      if (c.signal.aborted) return;

      frame = document.createElement("div");
      frame.className = "r";
      scroller = document.createElement("div");
      scroller.className = "r-pdf";
      frame.append(scroller);
      toolbar = bar(command);
      frame.append(toolbar.el);
      c.host.append(frame);
      counter = toolbar.el.querySelector(".wart");
      pageEls = sizes.map((_, i) => {
        const el = document.createElement("div");
        el.className = "r-pdf-strona";
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", `Strona ${i + 1} z ${sizes.length}`);
        scroller!.append(el);
        return el;
      });
      width = scroller.clientWidth;
      scale = fitScale();
      layout(scale);
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const i = indexOf.get(e.target);
            if (i === undefined) continue;
            if (e.isIntersecting) inView.add(i);
            else inView.delete(i);
          }
          schedule();
        },
        { root: scroller, rootMargin: "100% 0px" },
      );
      pageEls.forEach((el, i) => {
        indexOf.set(el, i);
        io!.observe(el);
      });
      scroller.addEventListener("scroll", () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          updateCurrent();
          schedule();
        });
      }, { passive: true });
      showStatus();
    },

    resize(): void {
      if (!scroller || disposed) return;
      if (scroller.clientWidth === width) return;
      width = scroller.clientWidth;
      if (fitMode) zoom(fitScale(), true);
      else layout(scale);
    },

    command,

    // a horizontal drag turns the file only when the page does not scroll sideways (a zoomed page does)
    swipe: () => (scroller ? scroller.scrollWidth <= scroller.clientWidth : true),

    key(e: KeyboardEvent): boolean {
      if (!doc || e.ctrlKey || e.metaKey || e.altKey || sizes.length === 0) return false;
      const last = sizes.length - 1;
      const step = (to: number): boolean => {
        if (to < 0 || to > last) return false;
        goTo(to);
        return true;
      };
      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          return step(current - 1);
        case "ArrowRight":
        case "PageDown":
          return step(current + 1);
        case "Home":
          return step(0);
        case "End":
          return step(last);
        default:
          // the space bar and the other keys belong to the app
          return false;
      }
    },

    dispose(): void {
      disposed = true;
      generation++;
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      releaseAll();
      // the loading task destroys the document too
      void task?.destroy().catch(() => undefined);
      if (handle) releaseWorker(handle.worker);
      handle = null;
      doc = null;
      task = null;
      frame?.remove();
      frame = null;
      scroller = null;
      toolbar = null;
      io = null;
      pageEls = [];
      sizes = [];
      tops = [];
      canvases = new Map();
      failed = new Set();
      inView = new Set();
      wanted = [];
      indexOf = new Map();
    },
  };
}
