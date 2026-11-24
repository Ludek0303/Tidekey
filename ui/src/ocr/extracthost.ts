// The app's side of the extractor frame (docs/OCR-PLAN.md §4.1, OCR §3.5): one hidden sandboxed iframe per job. It sends
// the file's bytes, takes the pages back one at a time, and removes the frame when the job ends. The frame parses an
// untrusted file and may run hostile code, so everything it sends is held to the job's limits here: it gets no keys,
// ids, tokens or file name, and it cannot make the app hold more than one of its pages at a time.
import { EXTRACT_PROTOCOL, MAX_EXTRACT_BYTES, MAX_EXTRACT_TEXT_BYTES, isFromExtractor, type ExtractOptions, type FromExtractor, type ToExtractor } from "./protocol";

export const EXTRACT_SRC = "/preview/extract.html";
// No progress from the frame for this long (while it, not the app, has the turn) means a hung job; the frame is removed.
export const EXTRACT_SILENCE_MS = 90_000;
// All the frame's turns together in one job (a 300-page scan renders in a few minutes): a frame that sends a page just
// before each silence limit runs out still ends.
export const EXTRACT_FRAME_BUDGET_MS = 20 * 60_000;
// The frame asks for a handful of pdf.js and libheif files; more than this in one job is not our frame's code.
const MAX_ASSET_REQUESTS = 64;

export interface ExtractFile { mime: string; bytes: ArrayBuffer }
export interface ExtractResult { pages: number; truncated: boolean }
export type ExtractPage = Extract<FromExtractor, { type: "page" }>;

let nextJobId = 1;

const aborted = (): DOMException => new DOMException("Anulowano", "AbortError");

const defaultFetchAsset = async (path: string): Promise<ArrayBuffer> => {
  const response = await fetch(`/preview/${path}`, { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
};

function createFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  // Only "allow-scripts": no allow-same-origin, so the frame has an opaque origin and no access to the app.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = EXTRACT_SRC;
  frame.title = "Odczyt tekstu pliku";
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  // not display:none: a frame with no layout gets no animation frames, and pdf.js needs them to draw a page
  frame.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  return frame;
}

// A bitmap in a message that is dropped is closed: its pixels would otherwise stay until garbage collection.
function closeStray(data: unknown): void {
  const bitmap = typeof data === "object" && data !== null ? (data as { bitmap?: unknown }).bitmap : undefined;
  if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) bitmap.close();
}

/**
 * Reads the pages of one file in a sandboxed frame. `onPage` gets each page in order, as a fresh object with only the
 * known fields (its bitmap belongs to the caller, who closes it); the frame reads the next page only after the promise
 * `onPage` returns has settled. Resolves on `done`; rejects with an Error whose message is the frame's error code, or
 * "protocol" when the frame breaks the protocol, with an AbortError when the signal fires, or with "timeout" after 90 s
 * of silence.
 * The bytes are transferred: the caller's buffer is detached.
 */
export function extract(
  file: ExtractFile,
  options: ExtractOptions,
  onPage: (page: ExtractPage) => void | Promise<void>,
  signal?: AbortSignal,
  fetchAsset: (path: string) => Promise<ArrayBuffer> = defaultFetchAsset,
): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    if (file.bytes.byteLength > MAX_EXTRACT_BYTES) return reject(new Error("too-large"));
    const jobId = nextJobId++;
    const iframe = createFrame();
    let sent = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // time the frame has had the turn: from each arm() to its next page or done
    let frameMs = 0;
    let turnStart = 0;
    // the frame may send one page, then waits for `next`; `total` is the page count it said with its first page
    let mayPage = false;
    let delivered = 0;
    let total = 0;
    let textBytes = 0;
    let assets = 0;
    let assetChain: Promise<void> = Promise.resolve();

    const finish = (): void => {
      finished = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      iframe.remove();
    };
    const fail = (err: unknown): void => {
      if (finished) return;
      finish();
      reject(err);
    };
    // Over the frame's budget with pages already read, the job ends with those pages (a long scan on a slow device);
    // silent for 90 s, or over the budget before any page, it fails.
    const outOfTime = (): void => {
      if (delivered === 0) return fail(new Error("timeout"));
      post({ type: "cancel", v: EXTRACT_PROTOCOL, jobId });
      finish();
      resolve({ pages: delivered, truncated: true });
    };
    const arm = (): void => {
      clearTimeout(timer);
      turnStart = performance.now();
      const budgetLeft = EXTRACT_FRAME_BUDGET_MS - frameMs;
      timer = budgetLeft < EXTRACT_SILENCE_MS
        ? setTimeout(outOfTime, Math.max(0, budgetLeft))
        : setTimeout(() => fail(new Error("timeout")), EXTRACT_SILENCE_MS);
    };
    const endTurn = (): boolean => {
      frameMs += performance.now() - turnStart;
      if (frameMs <= EXTRACT_FRAME_BUDGET_MS) return true;
      outOfTime();
      return false;
    };
    // The frame has an opaque origin, so "*" is the only target origin; the window itself is still this one frame.
    const post = (message: ToExtractor, transfer: ArrayBuffer[] = []): void => {
      try {
        iframe.contentWindow?.postMessage(message, "*", transfer);
      } catch {
        fail(new Error("protocol"));
      }
    };
    // "protocol", not a frame code: the frame broke the protocol (or the app's own message failed), which says
    // nothing lasting about the file
    const violation = (): void => {
      post({ type: "cancel", v: EXTRACT_PROTOCOL, jobId });
      fail(new Error("protocol"));
    };
    const onAbort = (): void => {
      if (sent) post({ type: "cancel", v: EXTRACT_PROTOCOL, jobId });
      fail(aborted());
    };
    const onPageMessage = (msg: ExtractPage): void => {
      const { bitmap } = msg;
      if (!mayPage) {
        bitmap?.close();
        return violation();
      }
      if (!endTurn()) return bitmap?.close();
      const pixelsOk = bitmap === undefined || (bitmap.width >= 1 && bitmap.height >= 1 && bitmap.width * bitmap.height <= options.maxPixels);
      const countOk = msg.page === delivered + 1 && msg.pages <= options.maxPages && (delivered === 0 || msg.pages === total);
      if (!pixelsOk || !countOk) {
        bitmap?.close();
        return violation();
      }
      mayPage = false;
      total = msg.pages;
      if (msg.text !== undefined) textBytes += new TextEncoder().encode(msg.text).byteLength;
      if (textBytes > MAX_EXTRACT_TEXT_BYTES) {
        // the file's text is over the layer limit: the pages so far are kept and the result says it was cut
        post({ type: "cancel", v: EXTRACT_PROTOCOL, jobId });
        finish();
        return resolve({ pages: delivered, truncated: true });
      }
      delivered++;
      const page: ExtractPage = {
        type: "page", v: EXTRACT_PROTOCOL, jobId, page: msg.page, pages: msg.pages,
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        ...(bitmap !== undefined ? { bitmap } : {}),
        ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
      };
      // the app has the turn while it works on the page: the frame's silence is not counted
      clearTimeout(timer);
      Promise.resolve()
        .then(() => onPage(page))
        .then(() => {
          if (finished) return;
          mayPage = true;
          arm();
          post({ type: "next", v: EXTRACT_PROTOCOL, jobId });
        }, fail);
    };
    // shortcut: messages a hostile frame queued before the job ended are not seen (the listener is gone), so their
    // bitmaps wait for garbage collection; a short-lived listener closing them would tighten this if it ever matters.
    const onMessage = (event: MessageEvent): void => {
      const win = iframe.contentWindow;
      // a null window matches a null source, so both must be present
      if (!win || event.source !== win || finished) return;
      const msg: unknown = event.data;
      if (!isFromExtractor(msg)) return closeStray(msg);
      if (msg.type === "ready") {
        // a second ready would keep a job alive forever
        if (sent) return violation();
        sent = true;
        mayPage = true;
        arm();
        post({ type: "extract", v: EXTRACT_PROTOCOL, jobId, mime: file.mime, bytes: file.bytes, options }, [file.bytes]);
        return;
      }
      if (msg.type === "asset") {
        // not progress: asset requests do not re-arm the timer; fetched one at a time
        if (++assets > MAX_ASSET_REQUESTS) return violation();
        const { path } = msg;
        assetChain = assetChain.then(() => (finished ? new ArrayBuffer(0) : fetchAsset(path))).then(
          (bytes) => { if (!finished) post({ type: "asset", v: EXTRACT_PROTOCOL, path, bytes }, [bytes]); },
          () => { if (!finished) post({ type: "asset", v: EXTRACT_PROTOCOL, path, bytes: null }); },
        );
        return;
      }
      if (msg.jobId !== jobId || !sent) {
        if (msg.type === "page") msg.bitmap?.close();
        return violation();
      }
      if (msg.type === "page") return onPageMessage(msg);
      if (msg.type === "done") {
        if (msg.pages !== delivered || !mayPage) return violation();
        finish();
        // fewer pages than the frame announced: the result says it was cut
        return resolve({ pages: delivered, truncated: msg.truncated || delivered < total });
      }
      fail(new Error(msg.code));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("message", onMessage);
    document.body.append(iframe);
    arm();
  });
}
