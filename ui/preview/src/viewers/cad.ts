/// <reference types="vite/client" />
// DXF drawings through dxf-viewer (PODGLAD-PLAN §5): a 2D drawing on WebGL with pan, zoom and a list of layers.
// The frame's CSP lets it fetch only blob: URLs, so the file and the font go in as blobs. openDxf is the one place
// where DXF bytes are drawn: a DWG file, converted to DXF by its own module, is handed to it as well.
import { DxfViewer, type LayerInfo } from "dxf-viewer";
import fontUrl from "roboto-fontface/fonts/roboto/Roboto-Regular.woff?url";
import { Color, Vector3 } from "three";
import type { Command } from "../../../src/preview/protocol";
import { dwgWasm } from "../previewwasm";
import { zoomBar } from "../ui";
import { PreviewError, type Viewer, type ViewerContext } from "./index";
import "./cad.css";

const MIB = 1024 * 1024;
const MAX_BYTES = 50 * MIB;
const ZOOM_STEP = 1.25;

export interface Drawing {
  command(name: Command): void;
  dispose(): void;
}

export interface LayerRow {
  name: string;
  label: string;
  color: string;
  visible: boolean;
}

/** The path ctx.asset takes for a file Vite emitted: "/preview/assets/x" becomes "assets/x". */
export function assetPathOf(url: string): string {
  return url.replace(/^\/?preview\//, "");
}

/** The rows of the layer list. The library gives colors as 0xRRGGBB numbers. */
export function layerRows(layers: LayerInfo[]): LayerRow[] {
  return layers.map((layer) => ({
    name: layer.name,
    label: layer.displayName,
    color: `#${layer.color.toString(16).padStart(6, "0")}`,
    visible: layer.visible,
  }));
}

/** Scene units covered by one device pixel: the zoom is the ratio of these at the fit and now. */
function unitsPerPixel(viewer: DxfViewer): number {
  const cam = viewer.GetCamera();
  return (cam.right - cam.left) / viewer.GetCanvas().width;
}

/** The text encoding of a DXF: R2007 and later ($ACADVER AC1021+) are UTF-8; older files name an ANSI code page in
 * $DWGCODEPAGE (Polish drawings: ANSI_1250). Unknown or unsupported → UTF-8, as dxf-viewer assumes. */
export function dxfEncoding(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
  const version = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/.exec(head);
  if (version && Number(version[1]) >= 1021) return "utf-8";
  const page = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d{3,4})/i.exec(head);
  if (!page) return "utf-8";
  const label = `windows-${page[1]}`;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return "utf-8";
  }
}

/** A DWG drawing as DXF text, through the DWG module of crates/preview (acadrust). */
async function dwgToDxf(bytes: ArrayBuffer, ctx: ViewerContext): Promise<ArrayBuffer> {
  const dwg = await dwgWasm(ctx.asset);
  try {
    const dxf = dwg.dwgToDxf(new Uint8Array(bytes));
    return dxf.buffer.slice(dxf.byteOffset, dxf.byteOffset + dxf.byteLength) as ArrayBuffer;
  } catch (err) {
    // the module throws its error code; a panic in WASM is a RuntimeError
    const code = err instanceof Error ? err.message : "";
    throw new PreviewError(code === "too-large" || code === "unsupported" ? code : "corrupt");
  }
}

/** Draws one DXF file in `ctx.host`. Resolves to null when the frame closed the file meanwhile. */
export async function openDxf(bytes: ArrayBuffer, ctx: ViewerContext): Promise<Drawing | null> {
  if (bytes.byteLength > MAX_BYTES) throw new PreviewError("too-large");
  const urls: string[] = [];
  const root = document.createElement("div");
  root.className = "r-cad";
  ctx.host.append(root);
  let viewer: DxfViewer | null = null;

  const dispose = (): void => {
    const v = viewer;
    viewer = null;
    if (v) {
      const renderer = v.GetRenderer();
      v.Destroy();
      // browsers allow only a few WebGL contexts at once: this one is released now, not at garbage collection
      renderer?.forceContextLoss();
    }
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    root.remove();
  };
  const blob = (data: ArrayBuffer, type: string): string => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    urls.push(url);
    return url;
  };

  try {
    const font = await ctx.asset(assetPathOf(fontUrl));
    if (ctx.signal.aborted) {
      dispose();
      return null;
    }
    const fontSrc = blob(font, "font/woff");
    const fileSrc = blob(bytes, "application/octet-stream");
    const created = new DxfViewer(root, {
      clearColor: new Color(ctx.theme.colors.bg),
      autoResize: true,
      colorCorrection: true,
      // on a dark theme black lines become light
      blackWhiteInversion: true,
      fileEncoding: dxfEncoding(new Uint8Array(bytes)),
    });
    viewer = created;
    if (!created.HasRenderer()) throw new PreviewError("unsupported");
    // A press makes the canvas take focus (OrbitControls). An unfocusable canvas would leave the frame without the
    // keys (+, -), so it takes focus but stays out of the tab order.
    created.GetCanvas().tabIndex = -1;
    // no worker: the parsing runs in this frame
    await created.Load({ url: fileSrc, fonts: [fontSrc], workerFactory: null });
  } catch (err) {
    dispose();
    if (ctx.signal.aborted) return null;
    throw err instanceof PreviewError ? err : new PreviewError("corrupt");
  }
  if (ctx.signal.aborted || !viewer) {
    dispose();
    return null;
  }
  const v = viewer;

  // The zoom shown is relative to the fit ("100%" = the whole drawing).
  let fitUnits = 1;
  const fit = (): void => {
    const b = v.GetBounds();
    if (b) {
      const o = v.GetOrigin();
      v.FitView(b.minX - o.x, b.maxX - o.x, b.minY - o.y, b.maxY - o.y);
    }
    fitUnits = unitsPerPixel(v);
    showZoom();
  };
  const zoomBy = (factor: number): void => {
    const cam = v.GetCamera();
    v.SetView(new Vector3(cam.position.x, cam.position.y, 0), (cam.right - cam.left) / factor);
  };
  const command = (name: Command): void => {
    switch (name) {
      case "zoom-in":
        zoomBy(ZOOM_STEP);
        break;
      case "zoom-out":
        zoomBy(1 / ZOOM_STEP);
        break;
      case "zoom-reset":
      case "fit":
        fit();
        break;
    }
    // SetView and FitView move the camera without drawing it; the frame is drawn again here.
    v.Render();
  };

  const bar = zoomBar(command);
  const showZoom = (): void => bar.setValue(`${Math.round((fitUnits / unitsPerPixel(v)) * 100)}%`);
  v.Subscribe("viewChanged", showZoom);

  const layers = layerRows(Array.from(v.GetLayers()));
  ctx.status(`Warstw: ${layers.length}`);

  const panel = document.createElement("aside");
  panel.className = "r-boczne";
  const head = document.createElement("div");
  head.className = "r-boczne-naglowek";
  const title = document.createElement("span");
  title.textContent = "Warstwy";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "r-boczne-przelacz";
  // the list folds on a narrow window only (CSS); the state is kept in data-zwiniety
  const setFolded = (folded: boolean): void => {
    panel.dataset.zwiniety = String(folded);
    toggle.textContent = folded ? "Pokaż" : "Ukryj";
    toggle.setAttribute("aria-expanded", String(!folded));
  };
  toggle.addEventListener("click", () => setFolded(panel.dataset.zwiniety !== "true"));
  setFolded(true);
  head.append(title, toggle);

  const list = document.createElement("ul");
  list.className = "r-warstwy";
  for (const row of layers) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = row.visible;
    box.addEventListener("change", () => v.ShowLayer(row.name, box.checked));
    const swatch = document.createElement("span");
    swatch.className = "r-warstwa-barwa";
    swatch.style.background = row.color;
    const name = document.createElement("span");
    name.className = "r-warstwa-nazwa";
    name.textContent = row.label;
    const label = document.createElement("label");
    label.append(box, swatch, name);
    const item = document.createElement("li");
    item.append(label);
    list.append(item);
  }
  panel.append(head, list);
  root.append(panel, bar.el);

  fit();
  return { command, dispose };
}

export function createCadViewer(): Viewer {
  let drawing: Drawing | null = null;
  let closed = false;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      // a DWG ("AC10xx") goes in as the DXF it converts to, so both draw the same way
      const dwg = new TextDecoder("latin1").decode(new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))) === "AC10";
      const opened = await openDxf(dwg ? await dwgToDxf(bytes, ctx) : bytes, ctx);
      if (!opened) return;
      // the frame may have closed the file while the drawing was being read
      if (closed) opened.dispose();
      else drawing = opened;
    },

    command: (name) => drawing?.command(name),

    // A horizontal drag pans the drawing, so it never turns the page.
    swipe: () => false,

    dispose(): void {
      closed = true;
      drawing?.dispose();
      drawing = null;
    },
  };
}
