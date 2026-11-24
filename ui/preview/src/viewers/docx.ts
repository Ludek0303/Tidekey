// A .docx as pages: docx-preview lays the document out in white sheets, the frame scrolls them (PODGLAD-PLAN §5).
// Nothing here may reach the network: images and fonts are blob: URLs, links and outside references are stripped.
import { renderAsync } from "docx-preview";
import { guardZip } from "../zipindex";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const PAGE_GAP_PX = 16;
const MIN_SCALE = 0.1;
const ALLOWED_SRC = ["blob:", "data:"];
const BLOB_URL = /blob:[^"'()\s]+/g;

/** Removes what could point outside the document or run code: src, srcset and href that are not blob: or data: (a link
 * may also be a fragment, #…, on <a> and <use>), and on* handlers. Returns how many attributes were removed. */
export function sanitizeRendered(root: Element): number {
  let removed = 0;
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    const fragmentOk = el.localName === "a" || el.localName === "use";
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      const allowed = ALLOWED_SRC.some((s) => value.startsWith(s)) || (fragmentOk && value.startsWith("#"));
      const drop =
        name.startsWith("on") ||
        ((name === "src" || name === "srcset" || name === "href" || name === "xlink:href") && !allowed);
      if (drop) {
        el.removeAttribute(attr.name);
        removed++;
      }
    }
  }
  return removed;
}

/** The zoom that fits the widest page into the view with a gap on both sides; a page that fits is shown at 100%. */
export function fitScale(pageWidth: number, viewWidth: number): number {
  if (pageWidth <= 0) return 1;
  return Math.min(1, Math.max(MIN_SCALE, (viewWidth - 2 * PAGE_GAP_PX) / pageWidth));
}

// docx-preview keeps its images and embedded fonts as blob: URLs, in <img> elements and in the style sheet.
function blobUrls(pages: Element, styles: Element): string[] {
  const fromCss = styles.textContent?.match(BLOB_URL) ?? [];
  const fromImg = Array.from(pages.querySelectorAll("img[src^='blob:']"), (img) => img.getAttribute("src") ?? "");
  return [...new Set([...fromCss, ...fromImg])];
}

export function createDocxViewer(): Viewer {
  let view: HTMLElement | null = null;
  let pages: HTMLElement | null = null;
  let pageWidth = 0;
  let urls: string[] = [];

  const fit = (): void => {
    if (view && pages) pages.style.zoom = String(fitScale(pageWidth, view.clientWidth));
  };

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      guardZip(new Uint8Array(bytes));
      const root = document.createElement("div");
      root.className = "r-docx";
      // focused, so that the arrow keys scroll the pages natively
      root.tabIndex = 0;
      const styles = document.createElement("div");
      const body = document.createElement("div");
      body.className = "r-docx-kartki";
      root.append(styles, body);
      ctx.host.append(root);
      view = root;
      pages = body;

      try {
        // renderAltChunks off: an embedded chunk becomes an <iframe srcdoc> that would run its scripts.
        await renderAsync(new Blob([bytes]), body, styles, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderAltChunks: false,
          useBase64URL: false,
          experimental: false,
          trimXmlDeclaration: true,
          debug: false,
        });
      } catch {
        throw new PreviewError("corrupt");
      }

      // the URLs are taken before the abort check, so a file closed meanwhile does not leave them behind
      const found = blobUrls(body, styles);
      sanitizeRendered(body);
      if (ctx.signal.aborted) {
        for (const u of found) URL.revokeObjectURL(u);
        return;
      }
      urls = found;

      const sections = body.querySelectorAll<HTMLElement>("section.docx");
      pageWidth = Array.from(sections).reduce((w, s) => Math.max(w, s.offsetWidth), 0);
      fit();
      ctx.status(`Stron: ${sections.length}`);
      root.focus({ preventScroll: true });
    },

    resize(): void {
      fit();
    },

    key(e: KeyboardEvent): boolean {
      // the space bar closes the window only when the document fits in the view
      if (!view || view.scrollHeight <= view.clientHeight) return false;
      const step = view.clientHeight;
      if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) view.scrollBy({ top: step });
      else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) view.scrollBy({ top: -step });
      else return false;
      return true;
    },

    dispose(): void {
      view?.remove();
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [];
      view = null;
      pages = null;
      pageWidth = 0;
    },
  };
}
