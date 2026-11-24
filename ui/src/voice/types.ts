// The one interface the editor uses for dictation (docs/DYKTOWANIE.md §4). Any engine (the browser worker today,
// a native sherpa-rs one in Tauri later) sits behind it, so the editor does not change when the engine does.

export type VoiceStatus = "idle" | "downloading" | "loading" | "listening" | "processing" | "error";

export type VoiceErrorCode =
  | "mic-denied"
  | "no-mic"
  | "no-webgpu"
  | "memory"
  | "unsupported"
  | "model"
  | "download"
  | "checksum"
  | "storage"
  | "internal";

export interface VoiceEventMap {
  status: VoiceStatus;
  /** Text of the fragment still being spoken; replaced by the next partial or by its final. */
  partial: string;
  /** A finished fragment: inserted into the note as one transaction. */
  final: string;
  error: { code: VoiceErrorCode; detail?: string };
  /** Model download, in bytes. */
  progress: { loaded: number; total: number };
}

export type VoiceEventName = keyof VoiceEventMap;

/** gpu: fp16 encoder on WebGPU (needs shader-f16); cpu: int8 encoder on WASM. */
export type Variant = "gpu" | "cpu";

export interface StartOptions {
  /** mock: fixed text per fragment, for tests; parakeet: the real model. */
  engine: "mock" | "parakeet";
  variant: Variant;
  /** The user agreed to download what is missing (docs/DYKTOWANIE.md §5); without it a missing file is an error. */
  download: boolean;
}

export interface VoiceEngine {
  start(opts: StartOptions): Promise<void>;
  stop(): void;
  on<K extends VoiceEventName>(name: K, cb: (value: VoiceEventMap[K]) => void): () => void;
  /** Ends the engine for good (terminates the worker, frees the model). */
  dispose(): void;
}

/** Messages from the UI thread to the voice worker. Audio is 16 kHz mono Float32, transferred, never stored. */
export type ToWorker = ({ type: "start" } & StartOptions) | { type: "audio"; pcm: Float32Array } | { type: "stop" };

/** Messages from the voice worker: one per engine event. */
export type FromWorker = { [K in VoiceEventName]: { type: K; value: VoiceEventMap[K] } }[VoiceEventName];

/** A failure the user can act on; `code` picks the message from ERROR_TEXT. */
export class VoiceError extends Error {
  constructor(readonly code: VoiceErrorCode, detail?: string) {
    super(detail ?? code);
  }
}

export const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: "Dyktowanie (Ctrl+Shift+D)",
  downloading: "Pobieranie modelu mowy…",
  loading: "Ładowanie modelu mowy…",
  listening: "Słucham… (kliknij, aby zakończyć)",
  processing: "Przetwarzanie mowy…",
  error: "Błąd dyktowania",
};

export const ERROR_TEXT: Record<VoiceErrorCode, string> = {
  "mic-denied": "Brak zgody na mikrofon. Zezwól na mikrofon dla tej strony w ustawieniach przeglądarki.",
  "no-mic": "Nie znaleziono mikrofonu.",
  "no-webgpu": "Ta przeglądarka nie ma WebGPU: dyktowanie działa, ale wolniej.",
  memory: "Za mało pamięci, żeby załadować model mowy. Zamknij inne karty i spróbuj ponownie.",
  unsupported: "Ta przeglądarka nie obsługuje dyktowania. Użyj aktualnego Chrome, Edge albo Firefoksa.",
  model: "Nie udało się załadować modelu mowy.",
  download: "Pobieranie modelu mowy zostało przerwane. Kliknij mikrofon ponownie, żeby je wznowić.",
  checksum: "Pobrany model mowy jest uszkodzony (suma kontrolna się nie zgadza). Kliknij mikrofon, żeby pobrać go ponownie.",
  storage: "Brak miejsca w przeglądarce na model mowy. Zwolnij miejsce na dysku i spróbuj ponownie.",
  internal: "Dyktowanie przerwał nieoczekiwany błąd.",
};
