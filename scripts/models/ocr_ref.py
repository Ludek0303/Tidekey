"""Reference OCR pipeline on the ONNX models in vendor/ocr-models (det DB + latin rec CTC), the model the TypeScript
pipeline (ui/src/ocr/) is checked against (docs/OCR-PLAN.md §2 próba C). Dev tool: numpy, opencv-python, pyclipper,
onnxruntime. Usage: python ocr_ref.py <fixtures dir> [det.onnx rec.onnx det_side] [--json out.json]"""
import sys, time, math, pathlib, json
import numpy as np, cv2, pyclipper, onnxruntime as ort

ort.set_default_logger_severity(3)
HERE = pathlib.Path(__file__).parent
MODELS = HERE.parent.parent / "vendor/ocr-models"
DICT = (MODELS / "ppocrv5_latin_dict.txt").read_text(encoding="utf-8").split("\n")[:-1]
CHARS = ["<blank>"] + list(DICT) + [" "]


def det_input(img, limit):
    h, w = img.shape[:2]
    r = limit / max(h, w) if max(h, w) > limit else 1.0
    nh, nw = max(32, int(round(h * r / 32) * 32)), max(32, int(round(w * r / 32) * 32))
    x = cv2.resize(img, (nw, nh)).astype(np.float32) / 255.0
    x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    return x.transpose(2, 0, 1)[None], (h / nh, w / nw)


def boxes_from_map(prob, ratio, thresh=0.3, box_thresh=0.6, unclip=1.5, max_boxes=2000):
    bitmap = (prob > thresh).astype(np.uint8)
    contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in contours[:max_boxes]:
        rect = cv2.minAreaRect(c)
        if min(rect[1]) < 3:
            continue
        pts = cv2.boxPoints(rect)
        mask = np.zeros_like(bitmap)
        cv2.fillPoly(mask, [c.reshape(-1, 2)], 1)
        score = cv2.mean(prob, mask)[0]
        if score < box_thresh:
            continue
        poly = pyclipper.PyclipperOffset()
        poly.AddPath([tuple(p) for p in pts.astype(np.int64)], pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
        area = cv2.contourArea(pts)
        length = cv2.arcLength(pts, True)
        expanded = poly.Execute(area * unclip / max(length, 1e-6))
        if not expanded:
            continue
        rect = cv2.minAreaRect(np.array(expanded[0]))
        if min(rect[1]) < 5:
            continue
        box = cv2.boxPoints(rect) * np.array([ratio[1], ratio[0]], np.float32)
        out.append(order_points(box))
    return out


def order_points(p):
    p = p[np.argsort(p[:, 0])]
    left, right = p[:2][np.argsort(p[:2, 1])], p[2:][np.argsort(p[2:, 1])]
    return np.array([left[0], right[0], right[1], left[1]], np.float32)  # tl, tr, br, bl


def crop(img, box):
    w = int(max(np.linalg.norm(box[0] - box[1]), np.linalg.norm(box[2] - box[3])))
    h = int(max(np.linalg.norm(box[0] - box[3]), np.linalg.norm(box[1] - box[2])))
    m = cv2.getPerspectiveTransform(box, np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32))
    out = cv2.warpPerspective(img, m, (w, h), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    return np.rot90(out) if h / max(w, 1) >= 1.5 else out


def rec_batch(sess, crops):
    hs = 48
    widths = [max(1, int(math.ceil(hs * c.shape[1] / c.shape[0]))) for c in crops]
    maxw = max(320, max(widths))
    x = np.zeros((len(crops), 3, hs, maxw), np.float32)
    for i, (c, w) in enumerate(zip(crops, widths)):
        r = cv2.resize(c, (w, hs)).astype(np.float32) / 255.0
        x[i, :, :, :w] = ((r - 0.5) / 0.5).transpose(2, 0, 1)
    y = sess.run(None, {"x": x})[0]
    res = []
    for row in y:
        idx, p = row.argmax(1), row.max(1)
        text, probs, last = [], [], -1
        for i, pi in zip(idx, p):
            if i != last and i != 0:
                text.append(CHARS[i]); probs.append(pi)
            last = i
        res.append(("".join(text), float(np.mean(probs)) if probs else 0.0))
    return res


def ocr(det, rec, img, limit=960, batch=8):
    x, ratio = det_input(img, limit)
    t0 = time.perf_counter()
    prob = det.run(None, {"x": x})[0][0, 0]
    t1 = time.perf_counter()
    boxes = boxes_from_map(prob, ratio)
    crops = [crop(img, b) for b in boxes]
    order = sorted(range(len(crops)), key=lambda i: crops[i].shape[1] / crops[i].shape[0])
    texts = [None] * len(crops)
    for s in range(0, len(order), batch):
        part = order[s:s + batch]
        for i, r in zip(part, rec_batch(rec, [crops[i] for i in part])):
            texts[i] = r
    t2 = time.perf_counter()
    lines = reading_order(boxes, texts)
    return lines, (t1 - t0, t2 - t1)


def reading_order(boxes, texts):
    items = [(b[:, 1].min(), b[:, 1].max(), b[:, 0].min(), t) for b, t in zip(boxes, texts) if t and t[0].strip()]
    items.sort(key=lambda it: (it[0] + it[1]) / 2)
    lines, cur = [], []
    for it in items:
        if cur and it[0] > (cur[-1][0] + cur[-1][1]) / 2:
            lines.append(cur); cur = []
        cur.append(it)
    if cur:
        lines.append(cur)
    return [(" ".join(i[3][0] for i in sorted(l, key=lambda i: i[2])), min(i[3][1] for i in l)) for l in lines]


def cer(ref, hyp):
    ref, hyp = " ".join(ref.split()), " ".join(hyp.split())
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, a in enumerate(ref, 1):
        cur = [i]
        for j, b in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a != b)))
        prev = cur
    return prev[-1] / len(ref)


if __name__ == "__main__":
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    sys.argv = [a for i, a in enumerate(sys.argv) if a != "--json" and (i == 0 or sys.argv[i - 1] != "--json")]
    fx = pathlib.Path(sys.argv[1])
    det_p = sys.argv[2] if len(sys.argv) > 2 else str(MODELS / "PP-OCRv5_mobile_det.fp16.onnx")
    rec_p = sys.argv[3] if len(sys.argv) > 3 else str(MODELS / "latin_PP-OCRv5_mobile_rec.fp16.onnx")
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 960
    so = ort.SessionOptions(); so.intra_op_num_threads = 4
    det = ort.InferenceSession(det_p, so, providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(rec_p, so, providers=["CPUExecutionProvider"])
    total, golden = [], {}
    for png in sorted(p for p in fx.iterdir() if p.suffix in (".png", ".jpg") and p.with_name(p.name + ".expected.txt").exists()):
        try:
            img = cv2.imread(str(png))  # applies EXIF orientation
        except cv2.error:
            img = None  # over OpenCV's pixel limit (obraz-ogromny.png): the app flags it by its own 50 Mpx limit
        if img is None:
            continue
        ref = png.with_name(png.name + ".expected.txt").read_text(encoding="utf-8")
        lines, (td, tr) = ocr(det, rec, img, limit)
        hyp = "\n".join(l[0] for l in lines)
        c = cer(ref, hyp)
        total.append(c)
        golden[png.name] = {"cer": round(c, 4), "lines": [{"text": t, "conf": round(q, 3)} for t, q in lines]}
        print(f"{png.stem:22} CER {c:6.3f}  linie {len(lines):3}  det {td*1000:6.0f} ms  rec {tr*1000:6.0f} ms")
    print(f"średni CER {np.mean(total):.4f}")
    if out_json:
        pathlib.Path(out_json).write_text(json.dumps(golden, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
