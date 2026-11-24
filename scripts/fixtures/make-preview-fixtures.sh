#!/usr/bin/env bash
# Generuje fixtures/preview/ od zera: obrazy, tekst, dokumenty, audio, wideo, modele 3D, fonty, archiwa
# i pliki złych danych. Uruchomienie: bash scripts/fixtures/make-preview-fixtures.sh
# Narzędzia deweloperskie, nie są wysyłane z aplikacją: Python 3 (Pillow, numpy, fontTools), ffmpeg, soffice.
# Nic nie jest pobierane z internetu. Opis każdego pliku: fixtures/preview/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/fixtures"
OUT="$ROOT/fixtures/preview"
WORK="$(mktemp -d)"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$PROFILE"' EXIT

# czyści wygenerowane pliki, README.md (pisany ręcznie) zostaje
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +

# Obrazy, tekst i kod, modele 3D i chmury, fonty, pliki złych danych, źródła dokumentów (FODT/FODS/FODP)
python3 "$HERE/make-images.py" "$OUT"
python3 "$HERE/make-text.py" "$OUT"
python3 "$HERE/make-models.py" "$OUT"
python3 "$HERE/make-fonts.py" "$OUT"
python3 "$HERE/make-misc.py" "$OUT"
python3 "$HERE/make-office.py" "$WORK/src" "$OUT"

# Dokumenty: soffice zamienia źródła na formaty biurowe (wynik musi istnieć i być niepusty)
doc_convert() { # format src expected-output
  soffice -env:UserInstallation="file://$PROFILE" --headless --convert-to "$1" --outdir "$OUT" "$WORK/src/$2" >/dev/null 2>&1
  [ -s "$OUT/$3" ] || { echo "soffice nie zrobił $3" >&2; exit 1; }
}
doc_convert 'docx:MS Word 2007 XML' dokument.fodt dokument.docx
doc_convert 'doc:MS Word 97' dokument.fodt dokument.doc
doc_convert odt dokument.fodt dokument.odt
doc_convert pdf dokument.fodt dokument.pdf
doc_convert 'xlsx:Calc MS Excel 2007 XML' arkusz.fods arkusz.xlsx
doc_convert 'xls:MS Excel 97' arkusz.fods arkusz.xls
doc_convert ods arkusz.fods arkusz.ods
doc_convert 'pptx:Impress MS PowerPoint 2007 XML' prezentacja.fodp prezentacja.pptx
doc_convert 'ppt:MS PowerPoint 97' prezentacja.fodp prezentacja.ppt

# Uszkodzony PDF: pierwsza połowa prawdziwego pliku
SIZE="$(wc -c < "$OUT/dokument.pdf")"
head -c "$((SIZE / 2))" "$OUT/dokument.pdf" > "$OUT/uszkodzony.pdf"

# wyjście to ostatni argument; bitexact i brak metadanych daje powtarzalne pliki
ff() {
  local out="${*: -1}"
  local args=("${@:1:$#-1}")
  ffmpeg -hide_banner -loglevel error -y "${args[@]}" -map_metadata -1 -fflags +bitexact \
    -flags:v +bitexact -flags:a +bitexact "$out"
}

# Audio: sinus 440 Hz, 3 s
SINE="sine=frequency=440:duration=3"
ff -f lavfi -i "$SINE" -c:a libmp3lame -b:a 64k "$OUT/dzwiek.mp3"
ff -f lavfi -i "$SINE" -c:a libvorbis -q:a 2 "$OUT/dzwiek.ogg"
ff -f lavfi -i "$SINE" -c:a pcm_s16le "$OUT/dzwiek.wav"
ff -f lavfi -i "$SINE" -c:a flac "$OUT/dzwiek.flac"
ff -f lavfi -i "$SINE" -c:a aac -b:a 64k "$OUT/dzwiek.m4a"

# Wideo: testsrc2, 4 s, 640 x 360, mały bitrate
TESTSRC="testsrc2=size=640x360:rate=25:duration=4"
ff -f lavfi -i "$TESTSRC" -c:v libx264 -preset medium -b:v 250k -pix_fmt yuv420p -an -movflags +faststart "$OUT/film.mp4"
# ten sam strumień bez faststart: moov zostaje na końcu, za mdat
ff -f lavfi -i "$TESTSRC" -c:v libx264 -preset medium -b:v 250k -pix_fmt yuv420p -an "$OUT/film-moov-na-koncu.mp4"
ff -f lavfi -i "$TESTSRC" -c:v libvpx-vp9 -b:v 150k -deadline good -cpu-used 5 -an "$OUT/film.webm"
ff -f lavfi -i "$TESTSRC" -c:v libx264 -preset medium -b:v 250k -pix_fmt yuv420p -an "$OUT/film.mov"
ff -f lavfi -i "$TESTSRC" -c:v libx264 -preset medium -b:v 250k -pix_fmt yuv420p -an "$OUT/film-h264.mkv"
ff -f lavfi -i "$TESTSRC" -c:v libvpx-vp9 -b:v 150k -deadline good -cpu-used 5 -an "$OUT/film-vp9.mkv"
ff -f lavfi -i "$TESTSRC" -c:v mjpeg -q:v 12 -an "$OUT/film.avi"
ff -f lavfi -i "$TESTSRC" -c:v libx264 -preset medium -b:v 250k -pix_fmt yuv420p -an "$OUT/film-h264.avi"

# Kolejność atomów MP4: film.mp4 ma moov przed mdat, film-moov-na-koncu.mp4 odwrotnie
python3 "$HERE/mp4-atoms.py" "$OUT/film.mp4" "$OUT/film-moov-na-koncu.mp4"

echo "Gotowe: $(ls "$OUT" | wc -l) plików w fixtures/preview/ ($(du -sh "$OUT" | cut -f1))"
