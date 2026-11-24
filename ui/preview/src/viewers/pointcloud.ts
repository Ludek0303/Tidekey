// Point clouds in three.js (PODGLAD-PLAN §5): LAS, PCD and PLY points on a canvas, orbit controls, a grid under the
// cloud, colour by height or by the file's own RGB. Parsing and sampling are in ../pointcloud-data.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { heightColors, kindOf, MAX_POINTS_OUT, readCloud, sampleStep, type Cloud } from "../pointcloud-data";
import { PreviewError, type Viewer, type ViewerContext } from "./index";
import "./pointcloud.css";

const POINT_SIZE = 2;
const FOV_DEG = 45;
// OrbitControls scales the camera distance by this factor (below 1 brings the camera closer), for dollyIn and dollyOut alike.
const ZOOM_SCALE = 0.8;
const GRID_DIVISIONS = 10;

type Colouring = "height" | "rgb";

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Points centred on the middle of the bounds. A LAS file is Z up, so it is turned to make its height the Y axis
 * three.js uses; PLY and PCD already have Y up.
 */
function placed(cloud: Cloud, zUp: boolean, centre: number[]): Float32Array {
  const out = new Float32Array(cloud.count * 3);
  const p = cloud.positions;
  for (let i = 0; i < cloud.count; i++) {
    const x = p[i * 3] - centre[0];
    const y = p[i * 3 + 1] - centre[1];
    const z = p[i * 3 + 2] - centre[2];
    out[i * 3] = x;
    out[i * 3 + 1] = zUp ? z : y;
    out[i * 3 + 2] = zUp ? -y : z;
  }
  return out;
}

export function createPointCloudViewer(): Viewer {
  let disposed = false;
  let renderer: THREE.WebGLRenderer | null = null;
  let root: HTMLElement | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  let grid: THREE.GridHelper | null = null;
  let radius = 1;

  const render = (): void => {
    if (renderer && scene && camera) renderer.render(scene, camera);
  };

  // Looks down at the cloud from a little above, far enough for the whole of it to fit the view.
  const fit = (): void => {
    if (!camera || !controls) return;
    const d = radius / Math.sin((FOV_DEG * Math.PI) / 360);
    camera.position.set(d * 0.6, d * 0.5, d * 0.8);
    controls.target.set(0, 0, 0);
    controls.update();
    render();
  };

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      // Without WebGL there is nothing to draw the cloud with: the app shows the "unsupported" message.
      // The colours are shown as the file gives them, not converted from sRGB, so this is off for the frame.
      THREE.ColorManagement.enabled = false;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false });
      } catch {
        throw new PreviewError("unsupported");
      }
      const { cloud, total } = await readCloud(bytes, ctx.name);
      if (disposed || ctx.signal.aborted) return;
      const zUp = kindOf(new Uint8Array(bytes), ctx.name) === "las";

      const { min, max } = cloud.bounds;
      const centre = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
      const extent = [0, 1, 2].map((a) => max[a] - min[a]);
      radius = Math.hypot(extent[0], extent[1], extent[2]) / 2 || 1;
      const axis = zUp ? 2 : 1;
      const height = heightColors(cloud.positions, axis, min[axis], max[axis], ctx.theme.colors.muted, ctx.theme.colors.accent);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(placed(cloud, zUp, centre), 3));
      const heightAttr = new THREE.BufferAttribute(height, 3, true);
      const rgbAttr = cloud.colors ? new THREE.BufferAttribute(cloud.colors, 3, true) : null;
      geometry.setAttribute("color", heightAttr);
      points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ size: POINT_SIZE, sizeAttenuation: false, vertexColors: true }),
      );

      // The grid lies on the lowest point, under the cloud, on the ground plane (the X and Y of a LAS file, the X and Z here).
      const ground = zUp ? min[2] - centre[2] : min[1] - centre[1];
      const horizontal = zUp ? extent[1] : extent[2];
      const gridObj = new THREE.GridHelper(Math.max(extent[0], horizontal) * 1.2 || 1, GRID_DIVISIONS, ctx.theme.colors.muted, ctx.theme.colors.border);
      gridObj.position.y = ground;
      grid = gridObj;

      scene = new THREE.Scene();
      scene.add(points, gridObj);
      camera = new THREE.PerspectiveCamera(FOV_DEG, 1, radius / 1000, radius * 1000);

      root = document.createElement("div");
      root.className = "r r-chmura";
      const bar = document.createElement("div");
      bar.className = "r-narzedzia";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Chmura punktów");

      const fitBtn = button("Wyśrodkuj", fit);
      const gridBtn = button("Siatka", () => {
        gridObj.visible = !gridObj.visible;
        gridBtn.setAttribute("aria-pressed", String(gridObj.visible));
        render();
      });
      gridBtn.setAttribute("aria-pressed", "true");
      const heightBtn = button("Kolor wg wysokości", () => setColouring("height"));
      const rgbBtn = button("Kolor RGB", () => setColouring("rgb"));
      bar.append(fitBtn, gridBtn, heightBtn);
      if (rgbAttr) bar.append(rgbBtn);

      const setColouring = (next: Colouring): void => {
        if (next === "rgb" && !rgbAttr) return;
        geometry.setAttribute("color", next === "rgb" && rgbAttr ? rgbAttr : heightAttr);
        heightBtn.setAttribute("aria-pressed", String(next === "height"));
        rgbBtn.setAttribute("aria-pressed", String(next === "rgb"));
        render();
      };
      // the file's own colours are the default when it has them
      setColouring(rgbAttr ? "rgb" : "height");

      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setClearColor(ctx.theme.colors.bg, 1);
      root.append(renderer.domElement, bar);
      ctx.host.append(root);
      renderer.setSize(root.clientWidth, root.clientHeight, false);
      camera.aspect = root.clientWidth / Math.max(1, root.clientHeight);
      camera.updateProjectionMatrix();

      controls = new OrbitControls(camera, renderer.domElement);
      controls.minDistance = radius * 0.01;
      controls.maxDistance = radius * 100;
      controls.addEventListener("change", render);
      fit();

      const step = sampleStep(total, MAX_POINTS_OUT);
      ctx.status(`Punktów: ${total.toLocaleString("pl-PL")}${step > 1 ? ` (pokazano co ${step}.)` : ""}`);
    },

    resize(): void {
      if (!renderer || !camera || !root) return;
      renderer.setSize(root.clientWidth, root.clientHeight, false);
      camera.aspect = root.clientWidth / Math.max(1, root.clientHeight);
      camera.updateProjectionMatrix();
      render();
    },

    command(name): void {
      if (!controls) return;
      if (name === "fit" || name === "zoom-reset") fit();
      else if (name === "zoom-in") controls.dollyIn(ZOOM_SCALE);
      else if (name === "zoom-out") controls.dollyOut(ZOOM_SCALE);
      else return;
      controls.update();
      render();
    },

    // A drag turns the cloud; it never turns the file.
    swipe: () => false,

    dispose(): void {
      disposed = true;
      controls?.removeEventListener("change", render);
      controls?.dispose();
      controls = null;
      if (points) {
        points.geometry.dispose();
        points.material.dispose();
      }
      if (grid) {
        grid.geometry.dispose();
        for (const m of [grid.material].flat()) m.dispose();
      }
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer = null;
      root?.remove();
      root = null;
      scene = null;
      camera = null;
      points = null;
      grid = null;
    },
  };
}
