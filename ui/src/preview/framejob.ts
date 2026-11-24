// The first frame of a video, decoded in a hidden preview frame (PODGLAD.md §2.2). The app never decodes the file itself:
// one hidden frame per tab does it, jobs run one at a time, and the frame goes away when idle or when the page is left.
import { FrameHost, PreviewFailure } from "./frame";
import type { FrameImage } from "./frame";

/** The most of a file that goes into the frame: a video whose index is at the end is not read further. */
export const VIDEO_THUMB_HEAD = 16 * 1024 * 1024;

const JOB_MS = 20_000;
const IDLE_MS = 30_000;

let host: FrameHost | null = null;
let box: HTMLElement | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

export type FirstFrame = FrameImage;

/** The first frame as raw RGBA pixels, at most VIDEO_THUMB_HEAD bytes of the file are read. Rejects with PreviewFailure. */
export function firstFrameOf(file: Blob, name: string, mime: string): Promise<FirstFrame> {
  const job = queue.then(() => runJob(file, name, mime));
  queue = job.catch(() => undefined);
  return job;
}

async function runJob(file: Blob, name: string, mime: string): Promise<FirstFrame> {
  cancelIdle();
  const frame = host ?? (host = createHost());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreviewFailure("timeout")), JOB_MS);
  });
  try {
    const bytes = await file.slice(0, VIDEO_THUMB_HEAD).arrayBuffer();
    return await Promise.race([frame.frame({ name, mime, bytes }), expired]);
  } catch (error) {
    // A failed or hung frame is not trusted with the next file: the next job gets a new one.
    dropFrame();
    throw error;
  } finally {
    clearTimeout(timer);
    if (host) armIdle();
  }
}

function createHost(): FrameHost {
  // The container and the frame stay out of sight and out of reach: no clicks, no focus, no screen readers.
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.setAttribute("inert", "");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;";
  document.body.append(holder);
  box = holder;
  const none = () => undefined;
  const hidden = new FrameHost(holder, { onStatus: none, onNav: none, onClose: none, onDownload: none });
  hidden.element.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:320px;border:0;";
  hidden.element.setAttribute("aria-hidden", "true");
  hidden.element.tabIndex = -1;
  return hidden;
}

function armIdle(): void {
  cancelIdle();
  idleTimer = setTimeout(dropFrame, IDLE_MS);
}

function cancelIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
}

function dropFrame(): void {
  cancelIdle();
  const old = host;
  host = null;
  old?.destroy();
  box?.remove();
  box = null;
}

// only with a page (the MCP imports this module in Node)
if (typeof window !== "undefined") window.addEventListener("pagehide", dropFrame);
