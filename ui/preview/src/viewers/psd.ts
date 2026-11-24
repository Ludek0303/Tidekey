// PSD through ag-psd: the header gives the size before the decoder runs; the composite image (the picture as the file
// shows it) is drawn with still.ts. Layers are skipped: only the flattened image is shown.
import { readPsd, type PixelData } from "ag-psd";
import { checkDims, showStill, type StillView } from "../still";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const HEADER_BYTES = 26;
// Colour modes that ag-psd cannot draw as a picture here: CMYK and Lab.
const MODE_CMYK = 4;
const MODE_LAB = 9;

/** Width and height from the header (version 1 = PSD, version 2 = PSB); null when the bytes are not a PSD. */
export function psdSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "8BPS") return null;
  const version = (bytes[4] << 8) | bytes[5];
  if (version !== 1 && version !== 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(18), height: view.getUint32(14) };
}

/** The picture as a canvas: the composite image of ag-psd, with 8 bits per channel. */
function toCanvas(px: PixelData): HTMLCanvasElement {
  const { data, width, height } = px;
  // 8 bits per channel is what ag-psd gives for the composite image; deeper data is not shown
  const eight = data instanceof Uint8ClampedArray || data instanceof Uint8Array;
  if (!eight || data.length !== width * height * 4) throw new PreviewError("unsupported");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new PreviewError("internal");
  // a view, not a copy: the buffer is never shared, so the cast is safe
  const pixels = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  g.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}

export function createPsdViewer(): Viewer {
  let view: StillView | null = null;
  let canvas: HTMLCanvasElement | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const data = new Uint8Array(bytes);
      const size = psdSize(data);
      if (!size || size.width === 0 || size.height === 0) throw new PreviewError("corrupt");
      checkDims(size.width, size.height);

      let psd: ReturnType<typeof readPsd>;
      try {
        psd = readPsd(bytes, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
      } catch {
        const mode = (data[24] << 8) | data[25];
        throw new PreviewError(mode === MODE_CMYK || mode === MODE_LAB ? "unsupported" : "corrupt");
      }
      const pixels = psd.imageData;
      const el = psd.canvas ?? (pixels ? toCanvas(pixels) : null);
      if (!el) throw new PreviewError("unsupported");
      if (ctx.signal.aborted) return;

      canvas = el;
      view = showStill(ctx.host, el, el.width, el.height);
    },

    resize(): void {
      view?.resize();
    },

    command: (name) => view?.command(name),

    swipe: () => view?.swipe() ?? false,

    dispose(): void {
      view?.dispose();
      view = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    },
  };
}
