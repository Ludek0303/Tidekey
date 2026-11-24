// The files the preview window can page through: FileStore entries turned into what the window needs, without the store.
import { download, openFile } from "../attachments";
import { textLayersOf, type FileHead, type FileInfo, type FileStore, type ReadOptions, type TextLayers, type VideoThumb } from "../filestore";
import type { TextLayerInfo } from "../remotefiles";
import { MAX_THUMB_SIDE } from "./protocol";

/** A file's text layer as the preview's "Tekst" tab shows it: its envelope fields and its Markdown. */
export interface LayerView { info: TextLayerInfo; markdown: string }
/** The "Tekst" tab's source for one file; null on a store without text layers. `load` resolves null when there is no layer. */
export interface TextAccess { load(options: ReadOptions): Promise<LayerView | null> }

export interface PreviewItem {
  key: string; // the file id; it stays in the app and never goes to the frame
  name: string;
  mime: string;
  size: number;
  durationMs: number | null;
  thumb: string | null;
  read(options: ReadOptions): Promise<Blob>;
  readHead(maxBytes: number, options: ReadOptions): Promise<FileHead>;
  /** null when the file has no thumbnail. */
  readThumb(options: ReadOptions): Promise<Blob> | null;
  saveThumb(thumb: VideoThumb): Promise<void>;
  /** The "Tekst" tab; null when the store keeps no text layers. */
  text: TextAccess | null;
  download(): void;
  open(): void;
}

export interface ItemActions {
  download(store: FileStore, info: FileInfo): void;
  open(store: FileStore, info: FileInfo): void;
}

const FILE_ACTIONS: ItemActions = {
  download: (store, info) => void download(store, info),
  open: (store, info) => openFile(store, info),
};

const SHOWN_STATES: readonly FileInfo["state"][] = ["ready", "trashed"];

export function itemsOf(store: FileStore, infos: FileInfo[], actions: ItemActions = FILE_ACTIONS): PreviewItem[] {
  const seen = new Set<string>();
  const items: PreviewItem[] = [];
  for (const info of infos) {
    if (seen.has(info.id) || info.thumbOf || !SHOWN_STATES.includes(info.state)) continue;
    seen.add(info.id);
    const id = info.id;
    items.push({
      key: id,
      name: info.name,
      mime: info.mime,
      size: info.size,
      durationMs: info.durationMs ?? null,
      thumb: info.thumb ?? null,
      read: (options) => store.read(id, options),
      readHead: (maxBytes, options) => store.readHead(id, maxBytes, options),
      readThumb: (options) => (info.thumb ? store.read(info.thumb, options) : null),
      saveThumb: (thumb) => store.setThumbnail(id, thumb),
      text: textLayersOf(store) ? textAccessOf(store, id) : null,
      download: () => actions.download(store, info),
      open: () => actions.open(store, info),
    });
  }
  return items;
}

function textAccessOf(store: FileStore & TextLayers, id: string): TextAccess {
  return {
    load: async (options) => {
      const info = (await store.textLayers()).get(id);
      if (!info) return null;
      return { info, markdown: await store.readTextLayer(info.id, id, options) };
    },
  };
}

const JPEG_QUALITY = 0.8;

/** Encodes raw RGBA pixels as WebP (JPEG where the browser cannot write WebP). null when the size or pixel count is wrong,
 * or when there is no 2D context. */
export async function encodeThumb(pixels: ArrayBuffer, width: number, height: number): Promise<Blob | null> {
  if (!validSide(width) || !validSide(height) || pixels.byteLength !== width * height * 4) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const webp = await toBlob(canvas, "image/webp");
  if (webp?.type === "image/webp") return webp;
  return toBlob(canvas, "image/jpeg");
}

const validSide = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_THUMB_SIDE;

const toBlob = (canvas: HTMLCanvasElement, type: string): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
