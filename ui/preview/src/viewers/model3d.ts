// 3D models through Online3DViewer's embedded viewer (PODGLAD-PLAN §5): WebGL drawn in the frame, with the engine's own
// mouse and touch navigation. The libraries for 3DM, IFC and draco come from model3dlibs.ts (vite-o3dv.ts changes the
// engine to use them).
import * as OV from "online-3d-viewer";
import { installPodgladLib, libraryFor, loadLibrary } from "../model3dlibs";
import { PreviewError, type Viewer, type ViewerContext } from "./index";
import "./model3d.css";

/** More triangles than this is not shown (PODGLAD-PLAN §5). */
export const MAX_TRIANGLES = 5_000_000;
const EDGE_ANGLE_DEG = 30;
const ZOOM_STEP = 1.25;

// Online3DViewer's own progress texts, in Polish (its Loc() looks them up by the English text).
const PROGRESS_PL = {
  "Loading model...": { pl: "Wczytuję model..." },
  "Importing model...": { pl: "Importuję model..." },
  "Visualizing model...": { pl: "Przygotowuję model..." },
};

/** The checks of a loaded model: no geometry means a corrupt file, too many triangles means the limit. */
export function checkTriangles(triangles: number): void {
  if (triangles === 0) throw new PreviewError("corrupt");
  if (triangles > MAX_TRIANGLES) throw new PreviewError("too-large");
}

// The context the engine draws with: the same one whichever of the two kinds is asked for first.
function webgl(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  return (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
}

function loseContext(gl: WebGLRenderingContext | null): void {
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}

// The theme colours are "#rrggbb"; Online3DViewer takes them without the "#".
function rgb(hex: string): OV.RGBColor {
  return OV.HexStringToRGBColor(hex.slice(1));
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

// Moves the eye toward the centre (factor < 1) or away from it; the direction and the up vector stay.
function zoomCamera(viewer: OV.Viewer, factor: number): void {
  const cam = viewer.GetCamera();
  const { eye, center } = cam;
  const at = (a: number, c: number): number => c + (a - c) * factor;
  const next = new OV.Camera(
    new OV.Coord3D(at(eye.x, center.x), at(eye.y, center.y), at(eye.z, center.z)),
    center.Clone(),
    cam.up.Clone(),
    cam.fov,
  );
  viewer.SetCamera(next);
}

export function createModel3dViewer(): Viewer {
  let root: HTMLElement | null = null;
  let embedded: OV.EmbeddedViewer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let edgeColor: OV.RGBColor | null = null;
  let edgeButton: HTMLButtonElement | null = null;
  let loading = false;
  let disposed = false;
  let released = false;
  // removes the window error listeners of a load in progress
  let stopWatching: () => void = () => undefined;

  const viewer = (): OV.Viewer | null => (embedded && !released ? embedded.GetViewer() : null);

  const fit = (): void => {
    const v = viewer();
    if (!v) return;
    const sphere = v.GetBoundingSphere(() => true);
    v.AdjustClippingPlanesToSphere(sphere);
    v.FitSphereToWindow(sphere, false);
  };

  const setEdges = (on: boolean): void => {
    const v = viewer();
    if (!v || !edgeColor) return;
    v.SetEdgeSettings(new OV.EdgeSettings(on, edgeColor, EDGE_ANGLE_DEG));
    edgeButton?.setAttribute("aria-pressed", String(on));
  };

  const zoom = (factor: number): void => {
    const v = viewer();
    if (v) zoomCamera(v, factor);
  };

  // Destroys the engine's viewer and loses the WebGL context. The engine keeps a window resize listener and a
  // document mouse listener that it never removes; they stay with the destroyed viewer and do nothing.
  const release = (): void => {
    if (!embedded || released) return;
    released = true;
    const gl = canvas ? webgl(canvas) : null;
    embedded.Destroy();
    loseContext(gl);
    embedded.Resize = () => undefined;
    embedded = null;
    canvas = null;
  };

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      const probe = webgl(document.createElement("canvas"));
      if (!probe) throw new PreviewError("unsupported");
      loseContext(probe);

      installPodgladLib(ctx.asset);
      // a library this frame cannot run is a format it cannot show, not a file that is corrupt
      const needed = libraryFor(ctx.name);
      if (needed) {
        try {
          await loadLibrary(needed, ctx.asset);
        } catch {
          throw new PreviewError("unsupported");
        }
      }
      OV.SetLocalizedStrings(PROGRESS_PL);
      OV.SetLanguageCode("pl");

      const stage = document.createElement("div");
      stage.className = "r-model-scena";
      root = document.createElement("div");
      root.className = "r-model";
      root.append(stage);
      ctx.host.append(root);

      // Settles when the engine has the model, or has failed to load it (its callbacks below).
      let settle: (error?: PreviewError) => void = () => undefined;
      const loaded = new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      });
      const finishLoad = (error?: PreviewError): void => {
        if (!loading) return;
        loading = false;
        stopWatching();
        if (disposed) release();
        settle(error);
      };
      // The engine's importers can throw on a file they do not expect (a glTF with no meshes) and then no callback
      // comes: an uncaught error while the file loads is the file's fault.
      const onEngineError = (): void => finishLoad(new PreviewError("corrupt"));
      window.addEventListener("error", onEngineError);
      window.addEventListener("unhandledrejection", onEngineError);
      stopWatching = () => {
        window.removeEventListener("error", onEngineError);
        window.removeEventListener("unhandledrejection", onEngineError);
      };

      const muted = rgb(ctx.theme.colors.muted);
      edgeColor = muted;
      embedded = new OV.EmbeddedViewer(stage, {
        backgroundColor: OV.HexStringToRGBAColor(ctx.theme.colors.bg.slice(1)),
        defaultColor: muted,
        edgeSettings: new OV.EdgeSettings(false, muted, EDGE_ANGLE_DEG),
        onModelLoaded: () => finishLoad(),
        onModelLoadFailed: () => finishLoad(new PreviewError("corrupt")),
      });
      canvas = embedded.GetViewer().GetCanvas();

      loading = true;
      embedded.LoadModelFromFileList([new File([bytes], ctx.name, { type: ctx.mime })]);
      await loaded;
      // closed while the engine worked: nothing more is drawn
      if (disposed || ctx.signal.aborted || !embedded) return;

      const triangles = embedded.GetModel().TriangleCount();
      checkTriangles(triangles);
      ctx.status(`Trójkątów: ${triangles}`);

      const bar = document.createElement("div");
      bar.className = "r-narzedzia";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Model 3D");
      edgeButton = button("Siatka", () => setEdges(edgeButton?.getAttribute("aria-pressed") !== "true"));
      edgeButton.setAttribute("aria-pressed", "false");
      bar.append(button("Wyśrodkuj", fit), edgeButton);
      root.append(bar);
    },

    resize(): void {
      if (embedded && !released) embedded.Resize();
    },

    // a horizontal drag turns the model, so it never turns the file
    swipe: () => false,

    command(name): void {
      switch (name) {
        case "fit":
        case "zoom-reset":
          fit();
          break;
        case "zoom-in":
          zoom(1 / ZOOM_STEP);
          break;
        case "zoom-out":
          zoom(ZOOM_STEP);
          break;
      }
    },

    dispose(): void {
      disposed = true;
      root?.remove();
      root = null;
      // the engine cannot be stopped while it loads: its callback, or the error listener, releases it
      if (!loading) release();
    },
  };
}
