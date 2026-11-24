// Zoom and pan of one image in its viewport. The logic is pure: it keeps {scale, x, y} and hands each new
// state to `apply`, which draws it. bindPanZoom wires the mouse and touch input to it.

export interface Transform { scale: number; x: number; y: number }

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 32;
const WHEEL_STEP = 1.15;

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// An image smaller than the view sits in the middle; a larger one can move only between its edges.
function axis(pos: number, size: number, view: number): number {
  return size <= view ? (view - size) / 2 : Math.min(0, Math.max(view - size, pos));
}

export class PanZoom {
  private scale = 1;
  private x = 0;
  private y = 0;
  private viewW = 0;
  private viewH = 0;
  private imgW = 0;
  private imgH = 0;
  private fitting = true;

  constructor(private readonly apply: (t: Transform) => void) {}

  /** True while the image is fitted to the view ("Dopasuj"); the user has not zoomed or moved it since. */
  get fitMode(): boolean {
    return this.fitting;
  }

  /** Fits the image to the view; images smaller than the view are not enlarged. */
  fit(viewW: number, viewH: number, imgW: number, imgH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    this.imgW = imgW;
    this.imgH = imgH;
    this.fitting = true;
    const s = imgW > 0 && imgH > 0 ? Math.min(1, viewW / imgW, viewH / imgH) : 1;
    this.place(clampScale(s), 0, 0);
  }

  fitView(): void {
    this.fit(this.viewW, this.viewH, this.imgW, this.imgH);
  }

  /** Keeps the zoom and re-clamps the position to the new view size. */
  setView(viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    this.place(this.scale, this.x, this.y);
  }

  /** A resized window fits again while the user has not zoomed. */
  resize(viewW: number, viewH: number): void {
    if (this.fitting) this.fit(viewW, viewH, this.imgW, this.imgH);
    else this.setView(viewW, viewH);
  }

  /** Zooms by `factor` around the point (px, py) of the view: that point of the image stays under it. */
  zoomAt(factor: number, px: number, py: number): void {
    this.zoomTo(clampScale(this.scale * factor), px, py);
  }

  zoomBy(factor: number): void {
    this.zoomAt(factor, this.viewW / 2, this.viewH / 2);
  }

  /** 100 %, around the middle of the view. */
  reset(): void {
    this.zoomTo(1, this.viewW / 2, this.viewH / 2);
  }

  /** Double click: 100 % from the fitted state, and back to fitted from any other. */
  toggle(): void {
    if (this.fitting) this.reset();
    else this.fitView();
  }

  panBy(dx: number, dy: number): void {
    const { x, y } = this;
    this.place(this.scale, this.x + dx, this.y + dy);
    // a drag that the edges stopped changes nothing, so the fitted state survives it
    if (this.x !== x || this.y !== y) this.fitting = false;
  }

  private zoomTo(next: number, px: number, py: number): void {
    const ix = (px - this.x) / this.scale;
    const iy = (py - this.y) / this.scale;
    this.fitting = false;
    this.place(next, px - ix * next, py - iy * next);
  }

  private place(scale: number, x: number, y: number): void {
    this.scale = scale;
    this.x = axis(x, this.imgW * scale, this.viewW);
    this.y = axis(y, this.imgH * scale, this.viewH);
    this.apply({ scale: this.scale, x: this.x, y: this.y });
  }
}

/** Wheel zooms, a mouse or finger drag pans, a double click toggles. Returns the function that removes them. */
export function bindPanZoom(viewport: HTMLElement, pz: PanZoom): () => void {
  let last: { x: number; y: number } | null = null;
  const local = (e: MouseEvent): { x: number; y: number } => {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = local(e);
    pz.zoomAt(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, p.x, p.y);
  };
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    last = { x: e.clientX, y: e.clientY };
    viewport.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!last) return;
    pz.panBy(e.clientX - last.x, e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
  };
  const onUp = (): void => {
    last = null;
  };
  const onDouble = (): void => pz.toggle();
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", onDown);
  viewport.addEventListener("pointermove", onMove);
  viewport.addEventListener("pointerup", onUp);
  viewport.addEventListener("pointercancel", onUp);
  viewport.addEventListener("dblclick", onDouble);
  return () => {
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("pointerdown", onDown);
    viewport.removeEventListener("pointermove", onMove);
    viewport.removeEventListener("pointerup", onUp);
    viewport.removeEventListener("pointercancel", onUp);
    viewport.removeEventListener("dblclick", onDouble);
  };
}
