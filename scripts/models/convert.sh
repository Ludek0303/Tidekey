#!/usr/bin/env bash
# Builds the OCR models in vendor/ocr-models/ from the official PaddleOCR 3.0 inference models (docs/OCR.md §2.1,
# docs/OCR-PLAN.md §2 próba C): paddle2onnx (opset 17) → onnxsim → float16 weights with float32 inputs and outputs
# (the fp16 pair, used by wasm and by WebGPU with shader-f16), plus the fp32 simplified pair (used by WebGPU without
# shader-f16, where fp16 kernels fail: OCR-PLAN §2 E).
# Dev tool, not shipped. Needs `uv` and network for the pinned packages and the two model archives. The result must
# match vendor/ocr-models/SHA256SUMS; a different toolchain version can change the bytes, so the sums are checked.
#   bash scripts/models/convert.sh [--check]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/vendor/ocr-models"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BASE=https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0
MODELS=(PP-OCRv5_mobile_det latin_PP-OCRv5_mobile_rec)

uv venv -q -p 3.12 "$WORK/venv"
# shellcheck disable=SC1091
. "$WORK/venv/bin/activate"
uv pip install -q "paddlepaddle==3.2.1" "paddle2onnx==2.0.2rc3" "onnx==1.17.0" "onnxsim==0.8.1" "onnxconverter-common==1.16.0" "ml-dtypes==0.7.0" "numpy==2.5.5" "protobuf==7.36.2" "pyyaml==6.0.2" "setuptools==84.2.1"

for m in "${MODELS[@]}"; do
  curl -sSfL "$BASE/${m}_infer.tar" -o "$WORK/$m.tar"
  tar -xf "$WORK/$m.tar" -C "$WORK"
  paddle2onnx --model_dir "$WORK/${m}_infer" --model_filename inference.json --params_filename inference.pdiparams \
    --save_file "$WORK/$m.onnx" --opset_version 17 >/dev/null 2>&1
  python -W ignore - "$WORK/$m.onnx" "$WORK/$m.fp16.onnx" "$WORK/$m.fp32.onnx" <<'PY'
import sys, onnx, onnxsim
from onnxconverter_common import float16
simp, ok = onnxsim.simplify(onnx.load(sys.argv[1]))
assert ok, "onnxsim failed"
onnx.save(simp, sys.argv[3])  # fp32 first: the fp16 conversion below works on the same graph
onnx.save(float16.convert_float_to_float16(simp, keep_io_types=True), sys.argv[2])
PY
done
# the recognizer's character list, one per line (index 1..N; 0 is the CTC blank, N+1 the space)
python - "$WORK/latin_PP-OCRv5_mobile_rec_infer/inference.yml" "$WORK/ppocrv5_latin_dict.txt" <<'PY'
import sys, yaml
chars = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["PostProcess"]["character_dict"]
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(chars) + "\n")
PY

if [ "${1:-}" = "--check" ]; then
  (cd "$WORK" && sha256sum -c "$OUT/SHA256SUMS")
else
  mkdir -p "$OUT"
  cp "$WORK/PP-OCRv5_mobile_det.fp16.onnx" "$WORK/latin_PP-OCRv5_mobile_rec.fp16.onnx" \
    "$WORK/PP-OCRv5_mobile_det.fp32.onnx" "$WORK/latin_PP-OCRv5_mobile_rec.fp32.onnx" "$WORK/ppocrv5_latin_dict.txt" "$OUT/"
  (cd "$OUT" && sha256sum PP-OCRv5_mobile_det.fp16.onnx latin_PP-OCRv5_mobile_rec.fp16.onnx \
    PP-OCRv5_mobile_det.fp32.onnx latin_PP-OCRv5_mobile_rec.fp32.onnx ppocrv5_latin_dict.txt > SHA256SUMS)
  cat "$OUT/SHA256SUMS"
fi
