// The speech models the app serves itself (docs/DYKTOWANIE.md §3, §5, §7). The browser loads them only from
// `/models/<id>/<file>` on its own origin; the upstream location here is read by scripts/fetch-voice-models.mjs at
// build time, never by the app. A new model version gets a new id, so a cached file is never replaced in place.

export interface ModelFile {
  /** File name under /models/<id>/. */
  name: string;
  size: number;
  sha256: string;
  /** Upstream file: Hugging Face `repo` at commit `rev`, or GitHub when `github` is set. Build time only. */
  source: { repo: string; rev: string; path: string; github?: boolean };
}

export interface AsrModel {
  id: string;
  name: string;
  /** Attribution and changes, for the "Licencje" screen (CC-BY-4.0 asks for both). */
  credit: string;
  files: {
    /** Encoder for WebGPU (fp16; int8 gives wrong results there). */
    encoderGpu: ModelFile;
    /** Encoder for the WASM path (int8, MatMulNBits). */
    encoderCpu: ModelFile;
    decoder: ModelFile;
    vocab: ModelFile;
    /** 4-bit encoder, smaller download; to be measured (§8). */
    encoderQ4?: ModelFile;
  };
}

const ULTRA_REPO = "Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx";
const ULTRA_REV = "b27f93c2238aa35e138996c005a62f1e8430f801";
const V3_REPO = "ysdede/parakeet-tdt-0.6b-v3-onnx";
const V3_REV = "e5356bf6e24bdb7a269536b0e9e7869bc034b893";

const ultra = (path: string, size: number, sha256: string): ModelFile => ({
  name: path.split("/").pop()!,
  size,
  sha256,
  source: { repo: ULTRA_REPO, rev: ULTRA_REV, path },
});
const v3 = (path: string, size: number, sha256: string): ModelFile => ({
  name: path,
  size,
  sha256,
  source: { repo: V3_REPO, rev: V3_REV, path },
});

export const VAD_MODEL: { id: string; file: ModelFile } = {
  id: "silero-vad-v6.2.3",
  file: {
    name: "silero_vad.onnx",
    size: 2327524,
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    source: { repo: "snakers4/silero-vad", rev: "v6.2.3", path: "src/silero_vad/data/silero_vad.onnx", github: true },
  },
};

export const ASR_MODELS: AsrModel[] = [
  {
    id: "parakeet-ultra-b27f93c",
    name: "Parakeet Ultra",
    credit:
      "moondream/parakeet-ultra (Moondream), dotrenowany nvidia/parakeet-tdt-0.6b-v3 (NVIDIA), CC-BY-4.0. " +
      "Eksport do ONNX: Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx (zmiany: przebudowa grafu, zaokrąglenie mantys do 12 bitów, " +
      "kwantyzacja fp16/int8/4-bit, zablokowany token <unk>). Notatki nie zmieniają plików modelu.",
    files: {
      encoderGpu: ultra("fp16/encoder-model.fp16.onnx", 1218170745, "f8353ed512daff07a3ca60e0845af2893c435325911fa8b4d21f9d63aa80250b"),
      encoderCpu: ultra("int8/encoder-model.int8.onnx", 649431593, "714047d70be4b612dce02e0ab2f9e0d6552f78adc421f408d154070796bc2dcf"),
      decoder: ultra("int8/decoder_joint-model.int8.onnx", 18203490, "667ffde2242a560923cba6bc7f69ef03d736f8a36ca9588f2e6f9fa818cf2fc1"),
      vocab: ultra("vocab.txt", 93939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
      encoderQ4: ultra("w4a8/encoder-model.w4a8.onnx", 383355483, "500fe613585f866a9c96bfcea11219d3694eaf1f619e99e92ade788005fb8f35"),
    },
  },
  {
    id: "parakeet-v3-e5356bf",
    name: "Parakeet TDT 0.6B v3",
    credit:
      "nvidia/parakeet-tdt-0.6b-v3 (NVIDIA), CC-BY-4.0. Eksport do ONNX: istupakov/parakeet-tdt-0.6b-v3-onnx, " +
      "wariant fp16: ysdede/parakeet-tdt-0.6b-v3-onnx (zmiany: konwersja fp16, kwantyzacja int8). Notatki nie zmieniają plików modelu.",
    files: {
      encoderGpu: v3("encoder-model.fp16.onnx", 1238960452, "a2bdeeb99cb7e5548818e823127b33854dd0c26f5d0c8da91effdd895ea0e717"),
      encoderCpu: v3("encoder-model.int8.onnx", 652183999, "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
      decoder: v3("decoder_joint-model.int8.onnx", 18202004, "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
      vocab: v3("vocab.txt", 102132, "ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742"),
    },
  },
];

/** The model the app uses; the other one stays for the quality comparison (§8). shortcut: fixed until measured. */
export const DEFAULT_ASR = ASR_MODELS[0];

export const modelUrl = (id: string, file: ModelFile): string => `/models/${id}/${file.name}`;
