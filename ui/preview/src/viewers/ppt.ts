// Old PowerPoint files (.ppt) as cards: title, texts and pictures of each slide, without the layout (PODGLAD-PLAN §2.1).
// The parser is in Rust (crates/preview/src/ppt.rs); this file checks its JSON and draws it.
import type { PptJs } from "../../wasm/notes_preview";
import { el, isList, isObject, wasmCall } from "./doc";
import { PreviewError, type Viewer, type ViewerContext } from "./index";
import "./legacyoffice.css";

export const MAX_SLIDES = 300;
// Only these pictures are drawn: the frame does not decode other formats.
const SHOWN_MIME = new Set(["image/png", "image/jpeg"]);

export interface Slide {
  title: string | null;
  texts: string[];
  /** Indices into the picture list of the file; an index out of range is left out. */
  pictures: number[];
}

const isStrings = (x: unknown): x is string[] => isList(x) && x.every((t) => typeof t === "string");
const isIndexes = (x: unknown): x is number[] => isList(x) && x.every((i) => typeof i === "number" && Number.isInteger(i) && i >= 0);

export function parseSlides(json: string, pictureCount: number): Slide[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new PreviewError("corrupt");
  }
  if (!isObject(data) || !isList(data.slides)) throw new PreviewError("corrupt");
  return data.slides.map((s) => {
    if (!isObject(s)) throw new PreviewError("corrupt");
    const { title, texts, pictures } = s;
    if ((title !== null && typeof title !== "string") || !isStrings(texts) || !isIndexes(pictures)) {
      throw new PreviewError("corrupt");
    }
    return { title, texts, pictures: pictures.filter((i) => i < pictureCount) };
  });
}

function card(slide: Slide, number: number, urls: Map<number, string>): HTMLElement {
  const c = el("section", "ppt-karta");
  const label = el("div", "ppt-numer");
  label.textContent = `Slajd ${number}`;
  c.append(label);
  if (slide.title !== null) {
    const h = el("h2");
    h.textContent = slide.title;
    c.append(h);
  }
  for (const text of slide.texts) {
    const p = el("p");
    p.textContent = text;
    c.append(p);
  }
  for (const i of slide.pictures) {
    const url = urls.get(i);
    if (!url) continue;
    const img = el("img");
    img.src = url;
    img.alt = `Obraz na slajdzie ${number}`;
    c.append(img);
  }
  return c;
}

export function createPptViewer(): Viewer {
  let ctx: ViewerContext | null = null;
  let root: HTMLElement | null = null;
  let cards: HTMLElement[] = [];
  let urls: string[] = [];
  let current = 0;

  const show = (i: number): void => {
    current = i;
    ctx?.status(`Slajd ${i + 1} z ${cards.length}`);
  };

  // Returns false at the first or last slide: the caller then asks the app for the neighbouring file.
  const go = (i: number): boolean => {
    const target = cards[i];
    if (!root || !target) return false;
    root.scrollTop = target.offsetTop;
    show(i);
    return true;
  };

  // The card at the top third of the view is the current one, so the status follows a scroll with the mouse as well.
  const onScroll = (): void => {
    if (!root) return;
    const line = root.scrollTop + root.clientHeight / 3;
    let at = 0;
    cards.forEach((c, i) => {
      if (c.offsetTop <= line) at = i;
    });
    if (at !== current) show(at);
  };

  return {
    async open(bytes: ArrayBuffer, c: ViewerContext): Promise<void> {
      ctx = c;
      const deck: PptJs = await wasmCall(c, (wasm) => wasm.pptSlides(new Uint8Array(bytes)));
      try {
        const slides = parseSlides(deck.slides_json(), deck.picture_count());
        if (slides.length > MAX_SLIDES) throw new PreviewError("too-large");
        if (c.signal.aborted) return;

        // the pictures are copied out before the module is freed; blob: URLs are released in dispose()
        const picture = new Map<number, string>();
        for (const slide of slides) {
          for (const i of slide.pictures) {
            const mime = deck.picture_mime(i);
            if (picture.has(i) || !SHOWN_MIME.has(mime)) continue;
            // wasm-bindgen copies the bytes into a fresh buffer, so the cast to a plain ArrayBuffer view holds
            const data = deck.picture(i) as Uint8Array<ArrayBuffer>;
            const url = URL.createObjectURL(new Blob([data], { type: mime }));
            urls.push(url);
            picture.set(i, url);
          }
        }

        const frame = el("div", "r-ppt");
        // focused, so that the arrow keys reach the viewer
        frame.tabIndex = 0;
        const note = el("p", "lo-uwaga");
        note.textContent = "Podgląd bez układu slajdów (stary format .ppt).";
        frame.append(note);
        if (slides.length === 0) {
          const empty = el("div", "lo-pusty");
          empty.textContent = "Prezentacja nie ma slajdów.";
          frame.append(empty);
          c.host.append(frame);
          root = frame;
          c.status("Slajdów: 0");
          return;
        }
        const list = el("div", "ppt-karty");
        cards = slides.map((slide, i) => card(slide, i + 1, picture));
        list.append(...cards);
        frame.append(list);
        c.host.append(frame);
        root = frame;
        frame.addEventListener("scroll", onScroll);
        show(0);
        frame.focus({ preventScroll: true });
      } finally {
        deck.free();
      }
    },

    key(e: KeyboardEvent): boolean {
      if (!root || e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "ArrowLeft") return go(current - 1);
      if (e.key === "ArrowRight") return go(current + 1);
      return false;
    },

    dispose(): void {
      root?.removeEventListener("scroll", onScroll);
      root?.remove();
      root = null;
      cards = [];
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [];
      current = 0;
      ctx = null;
    },
  };
}
