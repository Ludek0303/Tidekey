#!/usr/bin/env bash
# Generuje fixtures/preview/zdjecie.heic: 640 × 480, gradient i kształty, jak inne obrazy testowe (PODGLAD-PLAN §5).
# Uruchomienie: bash scripts/fixtures/make-heic.sh
# pillow-heif (libheif) działa tylko w tymczasowym venv; nie jest wysyłany z aplikacją. Nic nie jest pobierane poza pip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/fixtures/preview/zdjecie.heic"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q pillow-heif==1.8.1

"$WORK/venv/bin/python" - "$OUT" <<'EOF'
import sys
from PIL import Image, ImageDraw
import pillow_heif

W, H = 640, 480
img = Image.new("RGB", (W, H))
draw = ImageDraw.Draw(img)
# gradient: diagonal from blue-violet to warm orange
for y in range(H):
    for x in range(0, W, 1):
        t = (x / (W - 1) + y / (H - 1)) / 2
        draw.point((x, y), fill=(int(60 + 180 * t), int(90 + 60 * (1 - t)), int(200 - 150 * t)))
# shapes: a disc, a rectangle with a border, a triangle
draw.ellipse((40, 40, 240, 240), fill=(250, 240, 220), outline=(40, 30, 60), width=6)
draw.rectangle((300, 200, 560, 420), fill=(30, 110, 90), outline=(245, 245, 245), width=8)
draw.polygon([(420, 30), (600, 30), (510, 170)], fill=(230, 70, 70))

pillow_heif.register_heif_opener()
img.save(sys.argv[1], format="HEIF", quality=90)
print(f"zapisano {sys.argv[1]}")
EOF
