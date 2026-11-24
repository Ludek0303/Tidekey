// Audio through the browser's own <audio> element: a card with the name, the size and the length (PODGLAD-PLAN §5).
import { createElement, FileMusic } from "lucide";
import { formatDuration, formatSize } from "../format";
import { PreviewError, type Viewer, type ViewerContext } from "./index";

const METADATA_MS = 10_000;

// Resolves once the length is known. "codec": the browser cannot play the file. "corrupt": no metadata in time.
function metadata(el: HTMLAudioElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onLoaded = (): void => {
      done();
      resolve();
    };
    const onError = (): void => {
      done();
      reject(new PreviewError("codec"));
    };
    // the caller checks the signal after this, and draws nothing once it is aborted
    const onAbort = (): void => {
      done();
      resolve();
    };
    const timer = setTimeout(() => {
      done();
      reject(new PreviewError("corrupt"));
    }, METADATA_MS);
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

export function createAudioViewer(): Viewer {
  let url: string | null = null;
  let player: HTMLAudioElement | null = null;
  let root: HTMLElement | null = null;

  return {
    async open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void> {
      url = URL.createObjectURL(new Blob([bytes], { type: ctx.mime }));
      const el = document.createElement("audio");
      el.controls = true;
      el.preload = "metadata";
      el.src = url;
      player = el;

      const name = document.createElement("div");
      name.className = "r-audio-nazwa";
      name.textContent = ctx.name;
      const desc = document.createElement("div");
      desc.className = "r-audio-opis";
      const sizeText = `Dźwięk · ${formatSize(ctx.size)}`;
      desc.textContent = sizeText;
      const text = document.createElement("div");
      text.className = "r-audio-tekst";
      text.append(name, desc);
      const icon = createElement(FileMusic);
      icon.setAttribute("aria-hidden", "true");
      const head = document.createElement("div");
      head.className = "r-audio-glowa";
      head.append(icon, text);
      const card = document.createElement("div");
      card.className = "r-audio";
      card.append(head, el);
      const frame = document.createElement("div");
      frame.className = "r";
      frame.append(card);
      ctx.host.append(frame);
      root = frame;

      await metadata(el, ctx.signal);
      if (ctx.signal.aborted) return;
      // Infinity (a stream) and NaN have no length to show
      if (Number.isFinite(el.duration)) desc.textContent = `${sizeText} · ${formatDuration(Math.round(el.duration * 1000))}`;
    },

    // space toggles playback in the player; it must not close the window
    key(e: KeyboardEvent): boolean {
      if (e.key !== " " || !player || e.target !== player) return false;
      // the frame prevents the default of a handled key, so the space bar's play/pause is done here
      void (player.paused ? player.play().catch(() => undefined) : player.pause());
      return true;
    },

    dispose(): void {
      if (player) {
        player.pause();
        player.src = "";
        player.load();
      }
      player = null;
      root?.remove();
      root = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
}
