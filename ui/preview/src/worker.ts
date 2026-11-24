// Classic workers from blob: URLs, the only kind the frame may run (PODGLAD-PLAN §2). WebKit blocks them, and
// then spawnWorker gives null and the viewer does the same work on the frame's own thread.

const READY_TIMEOUT_MS = 2000;
// Posted by the first line of the worker, once its script has run.
const READY_PING = "self.postMessage({__ready:1});\n";

const blobUrls = new WeakMap<Worker, string>();

const isReady = (data: unknown): boolean =>
  typeof data === "object" && data !== null && (data as { __ready?: unknown }).__ready === 1;

export function spawnWorker(source: string): Promise<Worker | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  const url = URL.createObjectURL(new Blob([READY_PING + source], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch {
    URL.revokeObjectURL(url);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(), READY_TIMEOUT_MS);
    const detach = (): void => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", fail);
      worker.removeEventListener("messageerror", fail);
    };
    function fail(): void {
      detach();
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(null);
    }
    function onMessage(e: MessageEvent): void {
      if (!isReady(e.data)) return;
      detach();
      blobUrls.set(worker, url);
      resolve(worker);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
  });
}

/** Stops a worker from spawnWorker and frees its blob URL. */
export function releaseWorker(worker: Worker): void {
  worker.terminate();
  const url = blobUrls.get(worker);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(worker);
  }
}
