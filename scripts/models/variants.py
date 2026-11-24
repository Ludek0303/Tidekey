# Dev tool (not shipped): model variants for the WebGPU investigation (OCR-PLAN §2 E). From the fp32 simplified models
# (convert.sh stage onnxsim, before float16) it writes float16 weights WITHOUT keep_io_types (fp16 inputs and outputs)
# next to them. Usage: venv/bin/python scripts/models/variants.py <sim-dir> <out-dir>
import os, sys, onnx
from onnxconverter_common import float16

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for name in ["PP-OCRv5_mobile_det", "latin_PP-OCRv5_mobile_rec"]:
    m = onnx.load(os.path.join(src, f"{name}.sim.onnx"))
    onnx.save(float16.convert_float_to_float16(m, keep_io_types=False), os.path.join(out, f"{name}.fp16nio.onnx"))
    print("wrote", name, "fp16nio")
