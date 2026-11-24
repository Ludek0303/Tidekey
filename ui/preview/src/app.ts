// The frame's side of the protocol (PODGLAD-PLAN §4.1, §6): one file at a time, messages checked before use,
// keys and swipes. Pure logic apart from the host element; main.ts wires it to the window.
import { MAX_SIZE, type ViewerId } from "../../src/preview/formats";
import { PROTOCOL_VERSION, parseToFrame, type Command, type ErrorCode, type FromFrame, type Theme, type ToFrame } from "../../src/preview/protocol";
import { PreviewError, VIEWERS, type Viewer, type ViewerContext, type ViewerModule } from "./viewers/index";
import { firstFrame } from "./firstframe";
import { releaseWorker, spawnWorker } from "./worker";

const DEFAULT_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 30_000;
const SWIPE_MIN_PX = 60;
const CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
const ZOOM_KEYS = new Map<string, Command>([["+", "zoom-in"], ["=", "zoom-in"], ["-", "zoom-out"], ["0", "zoom-reset"]]);

// The dark theme of ui/src/tokens.css: used until the app sends init.
export const DEFAULT_THEME: Theme = {
  name: "dark",
  colors: { bg: "#161719", panel: "#1e1f22", text: "#ececf0", muted: "#a6a6b2", accent: "#b4a0ff", border: "#35363c" },
};

export interface FrameDeps {
  timeoutMs?: number;
  viewers?: Partial<Record<ViewerId, ViewerModule>>;
}

type OpenMsg = Extract<ToFrame, { type: "open" }>;
type FrameMsg = Extract<ToFrame, { type: "frame" }>;
interface Session { id: number; abort: AbortController; viewer: Viewer | null; workers: Set<Worker> }
interface Waiter { resolve(bytes: ArrayBuffer): void; reject(err: unknown): void }

/** Direction of a horizontal swipe (a finger moving left asks for the next file); 0 when the drag is no swipe. */
export function swipeDir(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (CONTROL_TAGS.has(target.tagName) || target.isContentEditable);
}

export class FrameApp {
  private theme: Theme = DEFAULT_THEME;
  private session: Session | null = null;
  private frameJob: AbortController | null = null;
  // Asset bytes cached for the life of the frame; requests waiting for one path share a single message.
  private readonly assets = new Map<string, ArrayBuffer>();
  private readonly waiting = new Map<string, Waiter[]>();
  private readonly timeoutMs: number;
  private readonly viewers: Partial<Record<ViewerId, ViewerModule>>;

  constructor(
    private readonly host: HTMLElement,
    private readonly post: (m: FromFrame, transfer?: Transferable[]) => void,
    deps: FrameDeps = {},
  ) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.viewers = deps.viewers ?? VIEWERS;
  }

  receive(data: unknown): void {
    const msg = parseToFrame(data);
    if (!msg) return;
    switch (msg.type) {
      case "init":
        this.init(msg.theme);
        break;
      case "open":
        this.open(msg);
        break;
      case "command": {
        const s = this.session;
        if (s && s.id === msg.id) s.viewer?.command?.(msg.name);
        break;
      }
      case "frame":
        this.frame(msg);
        break;
      case "asset":
        this.onAsset(msg.path, msg.bytes);
        break;
      case "dispose":
        this.teardown();
        break;
    }
  }

  keydown(e: KeyboardEvent): void {
    const viewer = this.session?.viewer;
    if (viewer?.key?.(e)) {
      e.preventDefault();
      return;
    }
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.post({ v: PROTOCOL_VERSION, type: "download" });
      return;
    }
    switch (e.key) {
      case "Escape":
        this.post({ v: PROTOCOL_VERSION, type: "close" });
        return;
      case " ":
        // the space bar closes only a window it opened, and never while a control has focus
        if (plain && !e.shiftKey && !isControl(e.target)) {
          e.preventDefault();
          this.post({ v: PROTOCOL_VERSION, type: "close", key: "space" });
        }
        return;
      case "ArrowLeft":
      case "ArrowRight":
        if (plain) this.post({ v: PROTOCOL_VERSION, type: "nav", dir: e.key === "ArrowLeft" ? -1 : 1 });
        return;
      default: {
        const name = plain ? ZOOM_KEYS.get(e.key) : undefined;
        if (name) {
          e.preventDefault();
          viewer?.command?.(name);
        }
      }
    }
  }

  swipe(dir: -1 | 1): void {
    if (this.session?.viewer?.swipe?.() !== false) this.post({ v: PROTOCOL_VERSION, type: "nav", dir });
  }

  resize(): void {
    this.session?.viewer?.resize?.();
  }

  private init(theme: Theme): void {
    this.theme = theme;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty(`--${name}`, value);
    root.style.setProperty("color-scheme", theme.name);
    root.dataset.theme = theme.name;
  }

  private open(msg: OpenMsg): void {
    this.teardown();
    const session: Session = { id: msg.id, abort: new AbortController(), viewer: null, workers: new Set() };
    this.session = session;
    this.post({ v: PROTOCOL_VERSION, type: "progress", id: msg.id, phase: "preparing" });
    const limit = MAX_SIZE[msg.viewer];
    if (msg.size > limit || msg.bytes.byteLength > limit) return this.fail(session, "too-large");
    const mod = this.viewers[msg.viewer];
    if (!mod) return this.fail(session, "unsupported");
    void this.run(session, mod, msg);
  }

  // The first frame of a video, for a thumbnail: nothing is drawn on screen, the pixels go back to the app.
  private frame(msg: FrameMsg): void {
    this.teardown();
    const job = new AbortController();
    this.frameJob = job;
    const { id } = msg;
    const fail = (code: ErrorCode): void => {
      this.frameJob = null;
      this.post({ v: PROTOCOL_VERSION, type: "frame-error", id, code });
    };
    if (msg.bytes.byteLength > MAX_SIZE.video) return fail("too-large");
    firstFrame(msg.bytes, msg.mime, job.signal, (path) => this.asset(path, job.signal)).then(
      (frame) => {
        // a newer request, an open or a dispose came first: that one answers, not this
        if (this.frameJob !== job) return;
        this.frameJob = null;
        this.post({ v: PROTOCOL_VERSION, type: "frame", id, ...frame }, [frame.pixels]);
      },
      (err: unknown) => {
        if (this.frameJob !== job) return;
        fail(err instanceof PreviewError ? err.code : "corrupt");
      },
    );
  }

  private async run(session: Session, mod: ViewerModule, msg: OpenMsg): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PreviewError("timeout")), this.timeoutMs);
    });
    const work = (async () => {
      const viewer = await mod.load();
      // the file was replaced or closed while the module loaded
      if (session.abort.signal.aborted) {
        viewer.dispose();
        return;
      }
      session.viewer = viewer;
      await viewer.open(msg.bytes, this.context(session, msg));
    })();
    try {
      await Promise.race([work, limit]);
      clearTimeout(timer);
      if (this.session === session) this.post({ v: PROTOCOL_VERSION, type: "progress", id: msg.id, phase: "shown" });
    } catch (err) {
      clearTimeout(timer);
      this.fail(session, err instanceof PreviewError ? err.code : "corrupt");
    }
  }

  private context(session: Session, msg: OpenMsg): ViewerContext {
    const current = (): boolean => this.session === session;
    return {
      host: this.host,
      name: msg.name,
      mime: msg.mime,
      size: msg.size,
      signal: session.abort.signal,
      theme: this.theme,
      label: msg.label,
      durationMs: msg.durationMs,
      asset: (path) => this.asset(path, session.abort.signal),
      spawnWorker: async (source) => {
        const worker = await spawnWorker(source);
        if (!worker) return null;
        if (session.abort.signal.aborted) {
          releaseWorker(worker);
          return null;
        }
        session.workers.add(worker);
        return worker;
      },
      status: (text) => {
        if (current()) this.post({ v: PROTOCOL_VERSION, type: "progress", id: msg.id, phase: "shown", status: text });
      },
      nav: (dir) => {
        if (current()) this.post({ v: PROTOCOL_VERSION, type: "nav", dir });
      },
    };
  }

  private asset(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const cached = this.assets.get(path);
    if (cached) return Promise.resolve(cached.slice(0));
    return new Promise<ArrayBuffer>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const rest = (this.waiting.get(path) ?? []).filter((w) => w !== waiter);
        if (rest.length) this.waiting.set(path, rest);
        else this.waiting.delete(path);
      };
      const waiter: Waiter = {
        resolve: (bytes) => {
          finish();
          resolve(bytes.slice(0));
        },
        reject: (err) => {
          finish();
          reject(err);
        },
      };
      const timer = setTimeout(() => waiter.reject(new PreviewError("timeout")), ASSET_TIMEOUT_MS);
      const onAbort = (): void => waiter.reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort);
      const queue = this.waiting.get(path);
      this.waiting.set(path, [...(queue ?? []), waiter]);
      if (!queue) this.post({ v: PROTOCOL_VERSION, type: "asset", path });
    });
  }

  private onAsset(path: string, bytes: ArrayBuffer | null): void {
    if (bytes) this.assets.set(path, bytes);
    const list = this.waiting.get(path) ?? [];
    this.waiting.delete(path);
    for (const w of list) {
      if (bytes) w.resolve(bytes);
      else w.reject(new PreviewError("internal"));
    }
  }

  private fail(session: Session, code: ErrorCode): void {
    if (this.session !== session) return;
    this.teardown();
    this.post({ v: PROTOCOL_VERSION, type: "error", id: session.id, code });
  }

  /** Closes the current file: aborts it, disposes its viewer, stops its workers, empties the host. */
  private teardown(): void {
    this.frameJob?.abort();
    this.frameJob = null;
    const s = this.session;
    this.session = null;
    if (s) {
      s.abort.abort();
      s.viewer?.dispose();
      for (const w of s.workers) releaseWorker(w);
    }
    this.host.replaceChildren();
  }
}
