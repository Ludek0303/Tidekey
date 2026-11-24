// Still images through the browser's own decoder: an <img> over a blob: URL, shown by still.ts (PODGLAD-PLAN §5).
import { imageSize } from "../imagesize";
import { checkDims, firstFrameLabel, showStill, type StillView } from "../still";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const MIB = 1024 * 1024;
const MAX_SVG_BYTES = 10 * MIB;

export function createImageViewer(): Viewer {
  let url: string | null = null;
  let view: StillView | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      // SVG is always drawn as SVG: inside <img> its scripts do not run.
      const svg = ctx.mime === "image/svg+xml" || /\.svg$/i.test(ctx.name);
      if (svg) {
        if (bytes.byteLength > MAX_SVG_BYTES) throw new PreviewError("too-large");
      } else {
        // the header tells the size before the decoder allocates anything
        const size = imageSize(new Uint8Array(bytes));
        if (size) checkDims(size.width, size.height);
      }
      url = URL.createObjectURL(new Blob([bytes], { type: svg ? "image/svg+xml" : ctx.mime || "application/octet-stream" }));
      const img = new Image();
      img.alt = ctx.name;
      img.src = url;
      try {
        await img.decode();
      } catch {
        throw new PreviewError("corrupt");
      }
      // An SVG without a size, or an ICO, has no size in its header: the decoded size is checked here.
      const width = img.naturalWidth || 300;
      const height = img.naturalHeight || 150;
      checkDims(width, height);
      if (ctx.signal.aborted) return;

      view = showStill(ctx.host, img, width, height, {
        label: ctx.label === "first-frame" ? firstFrameLabel(ctx.durationMs) : undefined,
      });
    },

    resize(): void {
      view?.resize();
    },

    command: (name) => view?.command(name),

    // A horizontal drag turns the page only when the image fits the view (the drag would pan it otherwise).
    swipe: () => view?.swipe() ?? false,

    dispose(): void {
      view?.dispose();
      view = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
}
