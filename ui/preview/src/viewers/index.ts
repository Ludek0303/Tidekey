// The viewer contract and the registry. A viewer module is loaded on the first file of its kind (import()).
import type { Command, ErrorCode, Theme } from "../../../src/preview/protocol";
import type { ViewerId } from "../../../src/preview/formats";

export interface ViewerContext {
  host: HTMLElement;
  name: string;
  mime: string;
  size: number;
  signal: AbortSignal;
  theme: Theme;
  /** The first frame of a video, as the app shows it: the viewer draws the "Pierwsza klatka" label. */
  label?: "first-frame";
  durationMs?: number;
  asset(path: string): Promise<ArrayBuffer>;
  spawnWorker(source: string): Promise<Worker | null>;
  status(text: string): void;
  nav(dir: -1 | 1): void;
}

export interface Viewer {
  open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void>;
  resize?(): void;
  /** true when the key was handled (zoom, page, slide). */
  key?(e: KeyboardEvent): boolean;
  command?(name: Command): void;
  /** false when a horizontal drag belongs to the content (a zoomed image). */
  swipe?(): boolean;
  dispose(): void;
}

export interface ViewerModule {
  id: ViewerId;
  /** A new viewer object on every call; the module itself is loaded by import(). */
  load(): Promise<Viewer>;
}

export class PreviewError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "PreviewError";
  }
}

export const VIEWERS: Partial<Record<ViewerId, ViewerModule>> = {
  image: { id: "image", load: async () => (await import("./image")).createImageViewer() },
  heic: { id: "heic", load: async () => (await import("./heic")).createHeicViewer() },
  tiff: { id: "tiff", load: async () => (await import("./tiff")).createTiffViewer() },
  psd: { id: "psd", load: async () => (await import("./psd")).createPsdViewer() },
  text: { id: "text", load: async () => (await import("./text")).createTextViewer() },
  csv: { id: "csv", load: async () => (await import("./csv")).createCsvViewer() },
  audio: { id: "audio", load: async () => (await import("./audio")).createAudioViewer() },
  font: { id: "font", load: async () => (await import("./font")).createFontViewer() },
  zip: { id: "zip", load: async () => (await import("./zip")).createZipViewer() },
  sheet: { id: "sheet", load: async () => (await import("./sheet")).createSheetViewer() },
  docx: { id: "docx", load: async () => (await import("./docx")).createDocxViewer() },
  pptx: { id: "pptx", load: async () => (await import("./pptx")).createPptxViewer() },
  pdf: { id: "pdf", load: async () => (await import("./pdf")).createPdfViewer() },
  pointcloud: { id: "pointcloud", load: async () => (await import("./pointcloud")).createPointCloudViewer() },
  cad: { id: "cad", load: async () => (await import("./cad")).createCadViewer() },
  doc: { id: "doc", load: async () => (await import("./doc")).createDocViewer() },
  ppt: { id: "ppt", load: async () => (await import("./ppt")).createPptViewer() },
  model3d: { id: "model3d", load: async () => (await import("./model3d")).createModel3dViewer() },
};
