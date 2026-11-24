// @vitest-environment node
// Runs the real PP-OCRv5 models (vendor/ocr-models) through onnxruntime-web's wasm backend on one thread, and checks
// the CER against the reference pipeline's golden numbers (fixtures/ocr/golden/det-960.json, scripts/models/ocr_ref.py).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web";
import { decodePng } from "./testpng";
import { ocrPage, type InferenceSessionLike, type Models, type TensorLike } from "./run";
import { loadDict } from "./ctc";

const ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURES = resolve(ROOT, "fixtures/ocr");
const MODELS = resolve(ROOT, "vendor/ocr-models");
const DET_SIDE = 960;
const TIMEOUT = 600_000;

const CASES = ["skan-czysty", "skan-maly", "skan-obrot", "skan-szum", "dwie-kolumny", "zdjecie-bez-tekstu"];

// Same as ocr_ref.cer: whitespace collapsed on both sides, Levenshtein over characters.
function cer(ref: string, hyp: string): number {
  const a = [...ref.split(/\s+/).filter(Boolean).join(" ")];
  const b = [...hyp.split(/\s+/).filter(Boolean).join(" ")];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

interface Row {
  name: string;
  cer: number;
  golden: number;
  det: number;
  rec: number;
  lines: number;
}
const rows: Row[] = [];
let models: Models;
const golden = JSON.parse(readFileSync(resolve(FIXTURES, "golden/det-960.json"), "utf8")) as Record<
  string,
  { cer: number }
>;

beforeAll(async () => {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = resolve(ROOT, "ui/node_modules/onnxruntime-web/dist") + "/";
  const opts = { executionProviders: ["wasm"] };
  const det = await ort.InferenceSession.create(readFileSync(resolve(MODELS, "PP-OCRv5_mobile_det.fp16.onnx")), opts);
  const rec = await ort.InferenceSession.create(
    readFileSync(resolve(MODELS, "latin_PP-OCRv5_mobile_rec.fp16.onnx")),
    opts,
  );
  const wrap = (s: ort.InferenceSession): InferenceSessionLike => ({
    run: async (feeds) => (await s.run(feeds as unknown as Record<string, ort.Tensor>)) as unknown as Record<string, TensorLike>,
  });
  models = {
    det: wrap(det),
    rec: wrap(rec),
    chars: loadDict(readFileSync(resolve(MODELS, "ppocrv5_latin_dict.txt"), "utf8")),
  };
}, TIMEOUT);

afterAll(() => {
  if (rows.length === 0) return;
  const pad = (s: string, n: number) => s.padEnd(n);
  const lines = [
    `${pad("plik", 22)}${pad("CER", 9)}${pad("golden", 9)}${pad("linie", 7)}${pad("det ms", 9)}rec ms`,
    ...rows.map(
      (r) =>
        `${pad(r.name, 22)}${pad(r.cer.toFixed(4), 9)}${pad(r.golden.toFixed(4), 9)}${pad(String(r.lines), 7)}${pad(
          String(Math.round(r.det)),
          9,
        )}${Math.round(r.rec)}`,
    ),
  ];
  console.log(`\nOCR pipeline vs golden (det ${DET_SIDE}, 1 wątek)\n${lines.join("\n")}\n`);
});

describe("OCR pipeline on fixtures", () => {
  for (const name of CASES) {
    it(
      name,
      async () => {
        const img = decodePng(readFileSync(resolve(FIXTURES, `${name}.png`)));
        const ref = readFileSync(resolve(FIXTURES, `${name}.png.expected.txt`), "utf8");
        const out = await ocrPage(
          img,
          models,
          (data, dims) => new ort.Tensor("float32", data, dims) as unknown as TensorLike,
          { detSide: DET_SIDE, batch: 8 },
        );
        const hyp = out.lines.join("\n");
        const c = cer(ref, hyp);
        const g = golden[`${name}.png`]?.cer ?? 1;
        rows.push({ name, cer: c, golden: g, det: out.ms.det, rec: out.ms.rec, lines: out.lines.length });
        if (name === "zdjecie-bez-tekstu") {
          expect(out.lines).toEqual([]);
          return;
        }
        expect(c).toBeLessThanOrEqual(g + 0.01);
        if (name === "dwie-kolumny") expect(c).toBeLessThanOrEqual(0.05);
      },
      TIMEOUT,
    );
  }
});
