// The app's side of the preview frame (PODGLAD-PLAN §3, §4.1): creates the sandboxed iframe, runs one request at a time
// through it, and turns frame messages into results or PreviewFailure. The frame never gets keys, ids or network access.
import { PROTOCOL_VERSION, parseFromFrame } from "./protocol";
import type { Command, ErrorCode, FromFrame, Theme, ThemeColors, ToFrame } from "./protocol";
import type { ViewerId } from "./formats";

export const FRAME_SRC = "/preview/index.html";

export class PreviewFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "PreviewFailure";
  }
}

export interface FrameEvents {
  onStatus(text: string): void; // progress.status from the frame („Strona 2 z 9”)
  onNav(dir: -1 | 1): void;
  onClose(bySpace: boolean): void;
  onDownload(): void;
}

export interface FrameOptions {
  src?: string;
  readyTimeoutMs?: number;
  hangTimeoutMs?: number;
  fetchAsset?: (path: string) => Promise<ArrayBuffer>;
  theme?: () => Theme;
}

export interface FrameFile {
  name: string;
  mime: string;
  size: number;
  viewer: ViewerId;
  bytes: ArrayBuffer;
  label?: "first-frame";
  durationMs?: number;
}

export interface FrameImage {
  width: number;
  height: number;
  pixels: ArrayBuffer;
  durationMs?: number;
}

// One request is in the frame at a time; a newer one replaces it.
interface Request {
  id: number;
  message: ToFrame;
  transfer: ArrayBuffer[];
  sent: boolean;
  // Gets the frame messages that carry this request's id; returns true when the request is over.
  handle(msg: FromFrame): boolean;
  reject(error: unknown): void;
}

const DEFAULT_READY_MS = 10000;
const DEFAULT_HANG_MS = 45000;

const DEFAULT_COLORS: Record<Theme["name"], ThemeColors> = {
  dark: { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" },
  light: { bg: "#f0efed", panel: "#f7f6f4", text: "#2c2b33", muted: "#6c6978", accent: "#7052b8", border: "#dedde2" },
};
const COLOR_KEYS = ["bg", "panel", "text", "muted", "accent", "border"] as const;

const aborted = (): DOMException => new DOMException("Anulowano", "AbortError");

const defaultFetchAsset = async (path: string): Promise<ArrayBuffer> => {
  const response = await fetch(`/preview/${path}`, { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
};

export class FrameHost {
  private iframe: HTMLIFrameElement;
  private readonly src: string;
  private readonly readyTimeoutMs: number;
  private readonly hangTimeoutMs: number;
  private readonly fetchAsset: (path: string) => Promise<ArrayBuffer>;
  private readonly theme: () => Theme;
  private ready = false;
  private destroyed = false;
  // A frame that has seen one file never sees another: code a file ran in it must not read the next file's bytes.
  private used = false;
  private nextId = 0;
  private openId = 0;
  private active: Request | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly container: HTMLElement, private readonly events: FrameEvents, options: FrameOptions = {}) {
    this.src = options.src ?? FRAME_SRC;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_MS;
    this.hangTimeoutMs = options.hangTimeoutMs ?? DEFAULT_HANG_MS;
    this.fetchAsset = options.fetchAsset ?? defaultFetchAsset;
    this.theme = options.theme ?? currentTheme;
    this.iframe = this.createFrame();
    container.append(this.iframe);
    window.addEventListener("message", this.onMessage);
  }

  get element(): HTMLIFrameElement {
    return this.iframe;
  }

  /** Shows the file. Resolves when the frame reports it shown. */
  open(file: FrameFile): Promise<void> {
    if (this.destroyed) return Promise.reject(aborted());
    const id = ++this.nextId;
    this.openId = id;
    const message: ToFrame = {
      v: PROTOCOL_VERSION, type: "open", id, name: file.name, mime: file.mime, size: file.size, viewer: file.viewer, bytes: file.bytes,
      ...(file.label === undefined ? {} : { label: file.label }),
      ...(file.durationMs === undefined ? {} : { durationMs: file.durationMs }),
    };
    return new Promise<void>((resolve, reject) => {
      this.begin({
        id, message, transfer: [file.bytes], sent: false, reject,
        handle: (msg) => {
          if (msg.type === "progress" && msg.phase === "shown") resolve();
          else if (msg.type === "error") reject(new PreviewFailure(msg.code));
          else return false;
          return true;
        },
      });
    });
  }

  /** The first frame of a video as raw RGBA pixels. The frame draws nothing. */
  frame(file: { name: string; mime: string; bytes: ArrayBuffer }): Promise<FrameImage> {
    if (this.destroyed) return Promise.reject(aborted());
    const id = ++this.nextId;
    const message: ToFrame = { v: PROTOCOL_VERSION, type: "frame", id, name: file.name, mime: file.mime, bytes: file.bytes };
    return new Promise<FrameImage>((resolve, reject) => {
      this.begin({
        id, message, transfer: [file.bytes], sent: false, reject,
        handle: (msg) => {
          if (msg.type === "frame") resolve({ width: msg.width, height: msg.height, pixels: msg.pixels, durationMs: msg.durationMs });
          else if (msg.type === "frame-error") reject(new PreviewFailure(msg.code));
          else return false;
          return true;
        },
      });
    });
  }

  command(name: Command): void {
    if (this.ready) this.post({ v: PROTOCOL_VERSION, type: "command", id: this.openId, name }, []);
  }

  setTheme(theme: Theme): void {
    if (this.ready) this.post({ v: PROTOCOL_VERSION, type: "init", theme }, []);
  }

  /** The frame drops the current file. */
  dispose(): void {
    if (this.destroyed) return;
    this.cancelActive(aborted());
    if (this.ready) this.post({ v: PROTOCOL_VERSION, type: "dispose" }, []);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelActive(aborted());
    this.clearReadyTimer();
    window.removeEventListener("message", this.onMessage);
    this.iframe.remove();
    this.destroyed = true;
  }

  private createFrame(): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    // Only "allow-scripts": no allow-same-origin, so the frame has a null origin and no access to the app.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = this.src;
    frame.title = "Podgląd pliku";
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.className = "podglad-ramka";
    return frame;
  }

  private begin(request: Request): void {
    this.cancelActive(aborted());
    if (this.used) this.restart(aborted());
    this.active = request;
    if (this.ready) this.send(request);
    else this.awaitReady();
  }

  private send(request: Request): void {
    request.sent = true;
    this.used = true;
    this.post(request.message, request.transfer);
    this.armHang();
  }

  private awaitReady(): void {
    if (this.readyTimer !== null) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.restart(new PreviewFailure("internal"));
    }, this.readyTimeoutMs);
  }

  // Every message from the frame with the active id renews the watchdog; silence for hangTimeoutMs means a hung frame.
  private armHang(): void {
    if (this.hangTimer !== null) clearTimeout(this.hangTimer);
    this.hangTimer = setTimeout(() => this.restart(new PreviewFailure("timeout")), this.hangTimeoutMs);
  }

  // Rejects the active request, then replaces the frame; the next request waits for the new frame's ready.
  private restart(error: unknown): void {
    this.cancelActive(error);
    this.clearReadyTimer();
    this.ready = false;
    this.used = false;
    this.iframe.remove();
    this.iframe = this.createFrame();
    this.container.append(this.iframe);
  }

  private cancelActive(error: unknown): void {
    const request = this.active;
    this.endActive();
    request?.reject(error);
  }

  private endActive(): void {
    this.active = null;
    if (this.hangTimer !== null) clearTimeout(this.hangTimer);
    this.hangTimer = null;
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  // The frame has a null origin, so "*" is the only value allowed; the target is still this one window.
  private post(message: ToFrame, transfer: ArrayBuffer[]): void {
    if (this.destroyed) return;
    this.iframe.contentWindow?.postMessage(message, "*", transfer);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const win = this.iframe.contentWindow;
    // A null window matches a null source, so both must be present.
    if (!win || event.source !== win) return;
    const msg = parseFromFrame(event.data);
    if (!msg) return;
    switch (msg.type) {
      case "ready":
        this.onReady();
        return;
      case "nav":
        this.events.onNav(msg.dir);
        return;
      case "close":
        this.events.onClose(msg.key === "space");
        return;
      case "download":
        this.events.onDownload();
        return;
      case "asset":
        this.onAsset(msg.path);
        return;
    }
    const request = this.active;
    if (!request || !("id" in msg) || msg.id !== request.id) return;
    this.armHang();
    if (msg.type === "progress" && msg.status !== undefined) this.events.onStatus(msg.status);
    if (request.handle(msg)) this.endActive();
  };

  private onReady(): void {
    this.ready = true;
    this.clearReadyTimer();
    this.post({ v: PROTOCOL_VERSION, type: "init", theme: this.theme() }, []);
    const request = this.active;
    if (request && !request.sent) this.send(request);
  }

  private onAsset(path: string): void {
    this.fetchAsset(path).then(
      (bytes) => this.post({ v: PROTOCOL_VERSION, type: "asset", path, bytes }, [bytes]),
      () => this.post({ v: PROTOCOL_VERSION, type: "asset", path, bytes: null }, []),
    );
  }
}

/** The app's theme for the frame: data-theme decides dark or light; each color comes from its CSS variable. */
export function currentTheme(): Theme {
  const root = document.documentElement;
  const name: Theme["name"] = root.dataset.theme === "light" ? "light" : "dark";
  const style = getComputedStyle(root);
  const colors = {} as ThemeColors;
  for (const key of COLOR_KEYS) colors[key] = hexOf(style.getPropertyValue(`--${key}`)) ?? DEFAULT_COLORS[name][key];
  return { name, colors };
}

// #rgb and rgb()/rgba() to #rrggbb; anything else is null.
function hexOf(value: string): string | null {
  const v = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/i.exec(v);
  if (!rgb) return null;
  const parts = rgb.slice(1, 4).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
