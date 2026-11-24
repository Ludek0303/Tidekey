import type { EditorView } from "@codemirror/view";
import { openDialog, toast } from "../widgets";
import { clearGhost, showGhost } from "./ghost";
import { insertDictation } from "./insert";
import { asrEntries, missing, pickVariant, vadEntry, type Entry } from "./modelstore";
import { DEFAULT_ASR } from "./models";
import { ERROR_TEXT, STATUS_TEXT, type VoiceStatus } from "./types";
import { WorkerVoice } from "./voice";

// The note a fragment goes into. `undo` identifies the note: a switch to another note changes it.
export interface DictationTarget {
  view: EditorView;
  undo: { stopCapturing(): void } | null;
}

// Only these states show the microphone as on.
const ON = new Set<VoiceStatus>(["listening", "processing", "downloading", "loading"]);

// Loaded by dynamic import from toolbar.ts, so the engine code stays out of the main bundle.
let voice: WorkerVoice | null = null;
let status: VoiceStatus = "idle";
let button: HTMLElement | null = null;
let started: { target: () => DictationTarget | null; undo: DictationTarget["undo"] } | null = null;
let percent = 0;
// The open consent window's download view, if any: the window closes itself when the download ends.
let closeProgress: (() => void) | null = null;
let progressEl: HTMLProgressElement | null = null;
let progressText: HTMLElement | null = null;
let opening = false;
let warnedNoWebgpu = false;
// The view that shows the ghost, if any: the ghost is cleared there even if the note changed meanwhile.
let ghostView: EditorView | null = null;

function dropGhost(): void {
  if (ghostView) clearGhost(ghostView);
  ghostView = null;
}

const mb = (bytes: number): number => Math.round(bytes / 1e6);
const progressLine = (loaded: number, total: number): string =>
  `Pobieranie modelu mowy: ${total ? Math.floor((loaded * 100) / total) : 0}% (${mb(loaded)} z ${mb(total)} MB)`;

function show(next: VoiceStatus): void {
  status = next;
  if (next === "idle" || next === "error") dropGhost();
  if (next !== "downloading") {
    percent = 0;
    closeProgress?.();
  }
  if (!button) return;
  button.dataset.voice = next;
  button.setAttribute("aria-pressed", String(ON.has(next)));
  button.dataset.tip = next === "downloading" ? `${STATUS_TEXT.downloading} ${percent}%` : STATUS_TEXT[next];
  button.setAttribute("aria-label", STATUS_TEXT[next]);
}

function engine(): WorkerVoice {
  if (!voice) {
    voice = new WorkerVoice();
    voice.on("status", show);
    voice.on("progress", ({ loaded, total }) => {
      percent = total ? Math.floor((loaded * 100) / total) : 0;
      if (progressEl) progressEl.value = percent;
      if (progressText) progressText.textContent = progressLine(loaded, total);
      if (status === "downloading") show(status);
    });
    voice.on("partial", (text) => {
      const now = started?.target();
      if (!started || !now || now.undo !== started.undo) return;
      ghostView = now.view;
      showGhost(now.view, text);
    });
    voice.on("final", (text) => {
      dropGhost();
      const now = started?.target();
      // The note changed while speaking: stop rather than write into a different note.
      if (!started || !now || now.undo !== started.undo) {
        stopDictation();
        return;
      }
      insertDictation(now.view, text, now.undo);
    });
    voice.on("error", ({ code }) => toast(ERROR_TEXT[code], code !== "no-webgpu"));
  }
  return voice;
}

const para = (text: string): HTMLParagraphElement => {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
};

const makeButton = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
};

// Asks before the first download (docs/DYKTOWANIE.md §5). Resolves true when the user agrees; the window then shows
// the download's progress until the status leaves "downloading".
function askConsent(need: Entry[], warn: "no-webgpu" | undefined): Promise<boolean> {
  const total = need.reduce((n, e) => n + e.file.size, 0);
  return new Promise((resolve) => {
    openDialog({
      label: "Włączyć dyktowanie?",
      className: "modal-confirm",
      render(box, close) {
        closeProgress = close;
        const content = document.createElement("div");
        box.append(content);
        const actions = (...buttons: HTMLElement[]) => {
          const row = document.createElement("div");
          row.className = "modal-actions";
          row.append(...buttons);
          return row;
        };
        const notes = [
          para("Mowa jest rozpoznawana w całości na tym urządzeniu. Nagrania nie są nigdzie wysyłane ani zapisywane — do notatki trafia tylko gotowy tekst."),
          para(`Przeglądarka pobierze jednorazowo model mowy z serwera Notatek: ${mb(total)} MB.`),
        ];
        if (warn) notes.push(para(ERROR_TEXT[warn]));
        notes.push(para(`Model: ${DEFAULT_ASR.name} (licencja CC-BY-4.0, szczegóły w Ustawienia → O programie).`));
        content.append(
          ...notes,
          actions(
            makeButton("Anuluj", "btn", () => close()),
            makeButton("Pobierz i włącz", "btn btn-primary", () => {
              resolve(true);
              const bar = document.createElement("progress");
              bar.max = 100;
              bar.value = 0;
              const text = para(progressLine(0, total));
              progressEl = bar;
              progressText = text;
              content.replaceChildren(text, bar, actions(makeButton("Anuluj", "btn", () => {
                stopDictation();
                close();
              })));
            }),
          ),
        );
      },
      onClose() {
        closeProgress = null;
        progressEl = null;
        progressText = null;
        resolve(false);
      },
    });
  });
}

export async function toggleDictation(target: () => DictationTarget | null, btn: HTMLElement | null): Promise<void> {
  button = btn;
  const v = engine();
  if (status !== "idle" && status !== "error") {
    dropGhost();
    v.stop();
    return;
  }
  // Ignores a second press while the variant, the file check or the consent window is still pending.
  if (opening) return;
  const now = target();
  if (!now) return;
  opening = true;
  try {
    const { variant, warn } = await pickVariant();
    const need = await missing([vadEntry, ...asrEntries(variant)]);
    if (need.length) {
      if (!(await askConsent(need, warn))) return;
    } else if (warn && !warnedNoWebgpu) {
      warnedNoWebgpu = true;
      toast(ERROR_TEXT[warn]);
    }
    started = { target, undo: now.undo };
    void v.start({ engine: "parakeet", variant, download: need.length > 0 });
  } finally {
    opening = false;
  }
}

export function stopDictation(): void {
  dropGhost();
  voice?.stop();
}
