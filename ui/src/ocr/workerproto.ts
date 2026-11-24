// Messages between the OCR engine (main thread) and its module worker (ui/src/ocr/worker.ts). Only pixels, numbers and
// text cross this boundary: never file bytes, names or keys. `id` is the only identifier.
import type { Provider } from "./hw";

export type OcrRequest =
  | { type: "measure"; webgpu: boolean }
  | { type: "page"; bitmap: ImageBitmap; det: Provider; rec: Provider; fault: boolean }
  | { type: "cancel" }
  | { type: "release" };
export type ToOcrWorker = OcrRequest & { id: number };

export interface MeasureReply {
  det: Provider;
  rec: Provider;
  msPerPage: number;
  adapter: string;
  // WebGPU was tried and at least one stage failed its checks (run error or output disagreeing with wasm)
  gpuRejected: boolean;
}
export interface PageReply {
  lines: string[];
  quality: number;
  noText: boolean;
  provider: { det: Provider; rec: Provider };
  ms: number;
  fellBack: boolean;
}

export type FromOcrWorker =
  | { type: "measured"; id: number; value: MeasureReply }
  | { type: "page"; id: number; value: PageReply }
  | { type: "released"; id: number }
  | { type: "error"; id: number; name: string; message: string };
