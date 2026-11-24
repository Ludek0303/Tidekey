// The OCR queue wired into the app (docs/OCR.md §3.4, §3.6). main.ts loads this module only when the file store keeps
// text layers. It builds the engine on first use (the engine module is a lazy chunk), the pacing between pages (an idle
// callback and a quiet time after typing or scrolling), the settings, and answers the bus requests of the views.
import { on } from "../bus";
import { getSetting } from "../settings";
import type { FileStore, TextLayers } from "../filestore";
import { extract } from "./extracthost";
import { OcrQueue, type OcrPrefs, type PageEngine } from "./queue";
import { hardwareLine, ocrBoard } from "./status";
import { toast } from "../widgets";

// After this much typing or scrolling the queue waits (OCR §2.4 pkt 10).
const QUIET_MS = 1500;
const IDLE_TIMEOUT_MS = 200;
let lastActivity = 0;

const markActivity = (): void => {
  lastActivity = Date.now();
};
document.addEventListener("keydown", markActivity, { capture: true, passive: true });
document.addEventListener("input", markActivity, { capture: true, passive: true });
document.addEventListener("wheel", markActivity, { capture: true, passive: true });
document.addEventListener("scroll", markActivity, { capture: true, passive: true });

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(resolve, 50);
  });

const quiet = async (): Promise<void> => {
  while (Date.now() - lastActivity < QUIET_MS) await new Promise((resolve) => setTimeout(resolve, 250));
};

const pace = async (): Promise<void> => {
  await idle();
  await quiet();
};

const prefs = (): OcrPrefs => ({
  enabled: getSetting("ocrEnabled"),
  onThisDevice: getSetting("ocrOnThisDevice"),
  legacy: getSetting("ocrLegacy"),
  maxPages: getSetting("ocrMaxPages"),
});

export interface OcrServiceOptions {
  /** This user's id (the owner of the files the scan takes). */
  me: string | null;
  /** Editor or higher. Viewers get the statuses of the layers only: no queue, no writes. */
  writable: boolean;
}

/** Starts OCR for one vault: loads the layers' statuses, then the queue (with the scan of this user's old files). */
export async function startOcr(store: FileStore & TextLayers, options: OcrServiceOptions): Promise<void> {
  ocrBoard.writable = options.writable;
  // one engine per vault; its module and worker load on first use, and the engine releases itself after a minute idle
  let engineP: Promise<PageEngine> | null = null;
  const engine = (): Promise<PageEngine> => {
    engineP ??= import("./engine").then(({ OcrEngine }) => new OcrEngine({ cpuOnly: () => getSetting("ocrHardware") === "cpu" }));
    return engineP;
  };
  const measureNow = async (): Promise<void> => {
    try {
      ocrBoard.setHardware(hardwareLine(await (await engine()).measure()));
    } catch {
      ocrBoard.setHardware("Nie udało się zmierzyć tego urządzenia.");
    }
  };

  if (!options.writable) {
    for (const layer of (await store.textLayers()).values()) ocrBoard.setLayer(layer);
    return;
  }
  const queue = new OcrQueue({
    store,
    me: options.me,
    writable: true,
    prefs,
    extract,
    engine,
    pace,
    memory: () => (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
  store.onUploaded((info, file) => queue.uploaded(info, file));
  on("ocr:recognize", (detail) => {
    const fileId = (detail as { fileId: string }).fileId;
    void store.info(fileId).then((info) => {
      if (!info) return;
      if (!prefs().enabled) toast("Rozpoznawanie tekstu jest wyłączone w ustawieniach.", true);
      else queue.request(info);
    });
  });
  on("ocr:pause", (detail) => queue.pause((detail as { paused: boolean }).paused));
  on("ocr:measure", () => void measureNow());
  // the stored measurement, if any, is shown before anything runs
  void engine().then((e) => ocrBoard.setHardware(hardwareLine(e.current())));
  await queue.start();
}
