// Messages between the app and the preview frame (PODGLAD-PLAN §4.1). Both sides run every received message
// through parseToFrame / parseFromFrame: the result holds only known fields, or it is null.
import { VIEWER_IDS } from "./formats";
import type { ViewerId } from "./formats";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT = 512;
export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_THUMB_SIDE = 480;
export const ASSET_PATH = /^assets\/[A-Za-z0-9._-]{1,128}$/;

export type ErrorCode = "unsupported" | "corrupt" | "too-large" | "codec" | "timeout" | "internal";
export type Command = "zoom-in" | "zoom-out" | "zoom-reset" | "fit";
export interface ThemeColors { bg: string; panel: string; text: string; muted: string; accent: string; border: string }
export interface Theme { name: "dark" | "light"; colors: ThemeColors }

export type ToFrame =
  | { v: 1; type: "init"; theme: Theme }
  | { v: 1; type: "open"; id: number; name: string; mime: string; size: number; viewer: ViewerId; bytes: ArrayBuffer; label?: "first-frame"; durationMs?: number }
  | { v: 1; type: "command"; id: number; name: Command }
  | { v: 1; type: "frame"; id: number; name: string; mime: string; bytes: ArrayBuffer }
  | { v: 1; type: "asset"; path: string; bytes: ArrayBuffer | null }
  | { v: 1; type: "dispose" };

export type FromFrame =
  | { v: 1; type: "ready" }
  | { v: 1; type: "progress"; id: number; phase: "preparing" | "shown"; status?: string }
  | { v: 1; type: "error"; id: number; code: ErrorCode }
  | { v: 1; type: "nav"; dir: -1 | 1 }
  | { v: 1; type: "close"; key?: "space" }
  | { v: 1; type: "download" }
  | { v: 1; type: "asset"; path: string }
  | { v: 1; type: "frame"; id: number; width: number; height: number; pixels: ArrayBuffer; durationMs?: number }
  | { v: 1; type: "frame-error"; id: number; code: ErrorCode };

const ERROR_CODES: readonly ErrorCode[] = ["unsupported", "corrupt", "too-large", "codec", "timeout", "internal"];
const COMMANDS: readonly Command[] = ["zoom-in", "zoom-out", "zoom-reset", "fit"];
const PHASES = ["preparing", "shown"] as const;

type Fields = Record<string, unknown>;
const isObject = (x: unknown): x is Fields => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
const isText = (x: unknown): x is string => typeof x === "string" && x.length <= MAX_TEXT;
const isName = (x: unknown): x is string => isText(x) && x.length > 0;
const isOptionalText = (x: unknown): x is string | undefined => x === undefined || isText(x);
const isPath = (x: unknown): x is string => typeof x === "string" && ASSET_PATH.test(x);
const isColor = (x: unknown): x is string => typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x);
const isMode = (x: unknown): x is "dark" | "light" => x === "dark" || x === "light";
const isDir = (x: unknown): x is -1 | 1 => x === -1 || x === 1;
const isLabel = (x: unknown): x is "first-frame" | undefined => x === undefined || x === "first-frame";
const isDuration = (x: unknown): x is number | undefined =>
  x === undefined || (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e9);
const isOneOf = <T extends string>(list: readonly T[], x: unknown): x is T => typeof x === "string" && (list as readonly string[]).includes(x);
// Checked by tag, not instanceof, because the other window has its own ArrayBuffer constructor.
const isBuffer = (x: unknown): x is ArrayBuffer =>
  Object.prototype.toString.call(x) === "[object ArrayBuffer]" && (x as ArrayBuffer).byteLength <= MAX_BYTES;

function parseTheme(t: unknown): Theme | null {
  if (!isObject(t)) return null;
  const { name, colors } = t;
  if (!isMode(name) || !isObject(colors)) return null;
  const { bg, panel, text, muted, accent, border } = colors;
  if (!isColor(bg) || !isColor(panel) || !isColor(text) || !isColor(muted) || !isColor(accent) || !isColor(border)) return null;
  return { name, colors: { bg, panel, text, muted, accent, border } };
}

function toFrame(data: unknown): ToFrame | null {
  if (!isObject(data) || data.v !== PROTOCOL_VERSION) return null;
  const v = PROTOCOL_VERSION;
  switch (data.type) {
    case "init": {
      const theme = parseTheme(data.theme);
      return theme ? { v, type: "init", theme } : null;
    }
    case "open": {
      const { id, name, mime, size, viewer, bytes, label, durationMs } = data;
      if (!isInt(id, 0) || !isName(name) || !isText(mime) || !isInt(size, 0) || !isOneOf(VIEWER_IDS, viewer) || !isBuffer(bytes) || !isLabel(label) || !isDuration(durationMs)) return null;
      return {
        v, type: "open", id, name, mime, size, viewer, bytes,
        ...(label === undefined ? {} : { label }),
        ...(durationMs === undefined ? {} : { durationMs }),
      };
    }
    case "command": {
      const { id, name } = data;
      if (!isInt(id, 0) || !isOneOf(COMMANDS, name)) return null;
      return { v, type: "command", id, name };
    }
    case "frame": {
      const { id, name, mime, bytes } = data;
      if (!isInt(id, 0) || !isName(name) || !isText(mime) || !isBuffer(bytes)) return null;
      return { v, type: "frame", id, name, mime, bytes };
    }
    case "asset": {
      const { path, bytes } = data;
      if (!isPath(path) || !(bytes === null || isBuffer(bytes))) return null;
      return { v, type: "asset", path, bytes };
    }
    case "dispose":
      return { v, type: "dispose" };
    default:
      return null;
  }
}

function fromFrame(data: unknown): FromFrame | null {
  if (!isObject(data) || data.v !== PROTOCOL_VERSION) return null;
  const v = PROTOCOL_VERSION;
  switch (data.type) {
    case "ready":
      return { v, type: "ready" };
    case "progress": {
      const { id, phase, status } = data;
      if (!isInt(id, 0) || !isOneOf(PHASES, phase) || !isOptionalText(status)) return null;
      return { v, type: "progress", id, phase, ...(status === undefined ? {} : { status }) };
    }
    case "error": {
      const { id, code } = data;
      if (!isInt(id, 0) || !isOneOf(ERROR_CODES, code)) return null;
      return { v, type: "error", id, code };
    }
    case "nav": {
      const { dir } = data;
      if (!isDir(dir)) return null;
      return { v, type: "nav", dir };
    }
    case "close": {
      // key "space": the frame closed on the space bar, which closes only a window opened with it
      const { key } = data;
      if (key !== undefined && key !== "space") return null;
      return { v, type: "close", ...(key === undefined ? {} : { key }) };
    }
    case "download":
      return { v, type: "download" };
    case "asset": {
      const { path } = data;
      if (!isPath(path)) return null;
      return { v, type: "asset", path };
    }
    case "frame": {
      const { id, width, height, pixels, durationMs } = data;
      if (!isInt(id, 0) || !isInt(width, 1, MAX_THUMB_SIDE) || !isInt(height, 1, MAX_THUMB_SIDE) || !isBuffer(pixels) || pixels.byteLength !== width * height * 4 || !isDuration(durationMs)) return null;
      return { v, type: "frame", id, width, height, pixels, ...(durationMs === undefined ? {} : { durationMs }) };
    }
    case "frame-error": {
      const { id, code } = data;
      if (!isInt(id, 0) || !isOneOf(ERROR_CODES, code)) return null;
      return { v, type: "frame-error", id, code };
    }
    default:
      return null;
  }
}

/** Returns a new object with only the known fields, or null when anything is wrong. Never throws. */
export function parseToFrame(data: unknown): ToFrame | null {
  try {
    return toFrame(data);
  } catch {
    return null;
  }
}

/** Returns a new object with only the known fields, or null when anything is wrong. Never throws. */
export function parseFromFrame(data: unknown): FromFrame | null {
  try {
    return fromFrame(data);
  } catch {
    return null;
  }
}
