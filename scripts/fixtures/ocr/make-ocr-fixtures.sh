#!/usr/bin/env bash
# Generuje fixtures/ocr/ od zera: PDF z tekstem, skany, mieszany, hasło, zły font, obrazy po polsku z EXIF,
# TIFF, HEIC, obraz ogromny, plik obcięty i losowe bajty. Obok każdego pliku <nazwa>.expected.txt.
# Uruchomienie: bash scripts/fixtures/ocr/make-ocr-fixtures.sh
# Narzędzia deweloperskie, nie są wysyłane z aplikacją. Nic nie jest pobierane poza pakietami PyPI (venv z
# przypiętymi wersjami przez uv) i czcionką z ui/node_modules/pdfjs-dist (OFL). Opis plików: fixtures/ocr/README.md.
# Czcionka: domyślnie ui/node_modules/pdfjs-dist/standard_fonts w tym katalogu lub w głównym checkoutcie;
# inną można wskazać przez OCR_FONT_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/scripts/fixtures/ocr"
OUT="$ROOT/fixtures/ocr"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v uv >/dev/null || { echo "Brak uv (https://docs.astral.sh/uv/)" >&2; exit 1; }
command -v soffice >/dev/null || { echo "Brak soffice w PATH" >&2; exit 1; }

# czyści wygenerowane pliki, README.md (pisany ręcznie) zostaje
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +

# czcionka Liberation Sans: najpierw OCR_FONT_DIR, potem ten checkout, potem główny checkout (worktree)
FONTS="${OCR_FONT_DIR:-}"
if [ -z "$FONTS" ]; then
  MAIN="$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{ if (!m) m = $2 } END { print m }')"
  for root in "$ROOT" "$MAIN"; do
    if [ -f "$root/ui/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf" ]; then
      FONTS="$root/ui/node_modules/pdfjs-dist/standard_fonts"
      break
    fi
  done
fi
[ -n "$FONTS" ] && [ -f "$FONTS/LiberationSans-Regular.ttf" ] || {
  echo "Brak LiberationSans-Regular.ttf: zainstaluj ui/ (npm ci) albo ustaw OCR_FONT_DIR" >&2
  exit 1
}

# Python z przypiętymi wersjami (Pillow, fontTools, pypdf, cryptography, pillow-heif); bez numpy
VENV="$WORK/venv"
uv venv -q "$VENV" --python "$(command -v python3)"
uv pip install -q --python "$VENV/bin/python" \
  "pillow==11.1.0" "fonttools==4.54.1" "pypdf==5.1.0" "cryptography==43.0.3" "pillow-heif==1.8.1"

"$VENV/bin/python" "$HERE/make-ocr.py" "$WORK" "$OUT" "$FONTS"
# wrogie pliki (pętla TIFF, PNG podany jako HEIC, ogromny obraz w PDF, współrzędne ±5e8); stdlib, ten sam python
"$VENV/bin/python" "$HERE/make-hostile.py" "$OUT"

echo "Gotowe: $(ls "$OUT" | grep -vc '\.expected\.txt$') plików testowych w fixtures/ocr/"
