//! The demo's test vault (`?demo=1&pliki=test`, development only): the files of fixtures/preview go into the in-memory
//! file store, and a note embeds each of them. The dev server serves the files (vite.config.ts, demoFixturesDev).
import * as Y from "yjs";
import type { Bridge } from "./bridge";
import { fileEmbed, filesOf, type FileStore, MAX_FILE_BYTES, newEmbedId, newFileId } from "./filestore";

const LIST_URL = "/__fixtures/list.json";
const FILE_URL = "/__fixtures/";
const NOTE_PATH = "Załączniki — test.md";
const OCTET = "application/octet-stream";

const MIME = new Map<string, string>(
  Object.entries({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    tif: "image/tiff", tiff: "image/tiff", psd: "image/vnd.adobe.photoshop", svg: "image/svg+xml",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ppt: "application/vnd.ms-powerpoint",
    odt: "application/vnd.oasis.opendocument.text",
    txt: "text/plain", md: "text/markdown", py: "text/x-python", json: "application/json", css: "text/css",
    html: "text/html", csv: "text/csv", log: "text/plain",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
    zip: "application/zip", ttf: "font/ttf", otf: "font/otf", woff: "font/woff",
    exe: "application/x-msdownload", dxf: "image/vnd.dxf", dwg: "image/vnd.dwg",
    stl: "model/stl", obj: "model/obj", glb: "model/gltf-binary", gltf: "model/gltf+json",
  }),
);

/** The MIME type of a test file by its extension; application/octet-stream for any other name. */
export function mimeByName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot < 0 ? undefined : MIME.get(name.slice(dot + 1).toLowerCase())) ?? OCTET;
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku testowego: ${url}`);
  return res;
}

async function load(bridge: Bridge, store: FileStore): Promise<void> {
  const raw: unknown = await (await get(LIST_URL)).json();
  const names = Array.isArray(raw) ? raw.filter((n: unknown): n is string => typeof n === "string") : [];
  if (!Array.isArray(raw) || names.length !== raw.length) throw new Error("Zła lista plików testowych.");
  const items: string[] = [];
  for (const name of names) {
    const blob = await (await get(FILE_URL + encodeURIComponent(name))).blob();
    if (blob.size > MAX_FILE_BYTES) continue;
    const info = await store.upload(new File([blob], name, { type: mimeByName(name) }), { id: newFileId() });
    items.push(`- ${name}\n  ${fileEmbed(info.id, null, newEmbedId())}`);
  }
  const id = await bridge.call<string>("create_note", { path: NOTE_PATH });
  const doc = new Y.Doc();
  doc.getText("content").insert(0, `# Załączniki — test\n\n${items.join("\n")}\n`);
  await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc) });
}

// One load per bridge: a second call gets the first call's promise and does nothing more.
const loads = new WeakMap<Bridge, Promise<void>>();

/** Puts the test files and the note that embeds them into the bridge's file store. Does nothing without a store. */
export function loadDemoFixtures(bridge: Bridge): Promise<void> {
  const store = filesOf(bridge);
  if (!store) return Promise.resolve();
  let done = loads.get(bridge);
  if (!done) {
    done = load(bridge, store);
    loads.set(bridge, done);
  }
  return done;
}
