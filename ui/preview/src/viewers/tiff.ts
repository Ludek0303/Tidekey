// TIFF through UTIF. The headers of all pages are read first (size and count); a page is decoded when it is shown.
import UTIF, { type Ifd } from "utif";
import { checkDims, showStill, type StillView } from "../still";
import { checkTiffPage, readTiffIfds, TiffError } from "../tiffguard";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const MAX_PAGES = 500;

interface Page { ifd: Ifd; width: number; height: number }

/** The pages that carry an image (tags 256 and 257). UTIF reads only the headers here, no pixels. */
function readPages(bytes: ArrayBuffer): Page[] {
  let ifds: Ifd[];
  try {
    ifds = readTiffIfds(bytes, MAX_PAGES);
  } catch (err) {
    throw new PreviewError(err instanceof TiffError ? err.code : "corrupt");
  }
  const pages: Page[] = [];
  for (const ifd of ifds) {
    const width = ifd.t256?.[0];
    const height = ifd.t257?.[0];
    if (!width || !height) continue;
    // the viewer's own size limit (checkDims) applies to each page when it is shown, before its pixels are decoded
    checkTiffPage(ifd, Infinity);
    pages.push({ ifd, width, height });
  }
  if (pages.length === 0) throw new PreviewError("corrupt");
  return pages;
}

/** Size of every image page, from the headers only. */
export function tiffPages(bytes: ArrayBuffer): { width: number; height: number }[] {
  return readPages(bytes).map(({ width, height }) => ({ width, height }));
}

export function createTiffViewer(): Viewer {
  let book: { bytes: ArrayBuffer; pages: Page[]; ctx: ViewerContext } | null = null;
  let view: StillView | null = null;
  let canvas: HTMLCanvasElement | null = null;

  // Decodes one page into a new canvas. The size check comes first, so no pixels are allocated for a page past the limit.
  const render = (page: Page, bytes: ArrayBuffer): HTMLCanvasElement => {
    checkDims(page.width, page.height);
    let rgba: Uint8Array;
    try {
      UTIF.decodeImage(bytes, page.ifd);
      rgba = UTIF.toRGBA8(page.ifd);
    } catch {
      throw new PreviewError("corrupt");
    } finally {
      page.ifd.data = undefined;
    }
    const el = document.createElement("canvas");
    el.width = page.width;
    el.height = page.height;
    const g = el.getContext("2d");
    if (!g) throw new PreviewError("internal");
    // a view, not a copy: a page can be large; the buffer is never shared, so the cast is safe
    const pixels = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
    g.putImageData(new ImageData(pixels, page.width, page.height), 0, 0);
    return el;
  };

  const show = (index: number): void => {
    if (!book) return;
    const { bytes, pages, ctx } = book;
    const page = pages[index];
    const el = render(page, bytes);
    view?.dispose();
    // the previous page's canvas is released at once, not left to the garbage collector
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    canvas = el;
    const count = pages.length;
    view = showStill(ctx.host, el, page.width, page.height, count > 1 ? { pages: { index, count, go: turn } } : {});
    if (count > 1) ctx.status(`Strona ${index + 1} z ${count}`);
  };

  // A page that cannot be decoded keeps the current one on screen and says so.
  const turn = (index: number): void => {
    try {
      show(index);
    } catch {
      book?.ctx.status(`Nie udało się odczytać strony ${index + 1}`);
    }
  };

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const pages = readPages(bytes);
      if (ctx.signal.aborted) return;
      book = { bytes, pages, ctx };
      show(0);
    },

    resize(): void {
      view?.resize();
    },

    command: (name) => view?.command(name),

    key: (e) => view?.key(e) ?? false,

    swipe: () => view?.swipe() ?? false,

    dispose(): void {
      view?.dispose();
      view = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
      book = null;
    },
  };
}
