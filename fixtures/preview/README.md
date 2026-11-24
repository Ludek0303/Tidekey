# Pliki testowe do podglądu

Odtworzenie (od zera, w katalogu repo):

```bash
bash scripts/fixtures/make-preview-fixtures.sh
bash scripts/fixtures/make-heic.sh   # zdjecie.heic, osobno (pillow-heif w tymczasowym venv)
```

Wszystkie pliki w tym katalogu są **wygenerowane w tym repo** przez skrypty z `scripts/fixtures/`.
Nic nie pochodzi z internetu. Fonty zbudowane od zera przez fontTools (nie kopie fontów systemowych).
Licencja: jak repo (AGPL-3.0-or-later, plik LICENSE); PDF-y z LibreOffice osadzają podzbiór Liberation Sans 2.1.5
(SIL OFL 1.1), REUSE.toml.

Powtarzalność: obrazy, audio, wideo, modele, fonty i archiwa są identyczne bajt w bajt między uruchomieniami. Pliki z LibreOffice (dokumenty, arkusze, prezentacje) mają czas zapisu w metadanych, więc różnią się bajtami, ale nie treścią.

Narzędzia używane tylko przy generowaniu (nie są wysyłane z aplikacją): Python 3 z Pillow 10, numpy i fontTools, pillow-heif 1.8.1 (tylko `make-heic.sh`),
ffmpeg (libx264, libvpx-vp9, libmp3lame, libvorbis, libopus, flac, aac, mjpeg, mpeg4), LibreOffice 24.2
(`soffice --headless --convert-to`).

Skrypty:

- `make-preview-fixtures.sh` uruchamia resztę, konwersje soffice i ffmpeg, na końcu wypisuje kolejność atomów MP4.
- `make-images.py`, `make-text.py`, `make-models.py`, `make-fonts.py`, `make-misc.py`, `make-office.py`: część Python.
- `mp4-atoms.py`: wypisuje kolejność atomów najwyższego poziomu w MP4.
- `make-zip-bomb.py <wyjście>`: nie jest uruchamiany przez skrypt główny. Tworzy `bomba.zip` (2 GB zer, ok. 2 MB)
  w podanym miejscu. Plik nie jest zapisany w repo; test generuje go w katalogu tymczasowym.

## Pliki

| plik | jak powstał (polecenie/skrypt) | co sprawdza |
|---|---|---|
| `zdjecie.heic` | `make-heic.sh`: Pillow, rysunek 640×480 (gradient, koło, prostokąt z obwódką, trójkąt), zapis HEIF q=90 przez pillow-heif 1.8.1 (libheif, HEVC) w tymczasowym venv | HEIC (`ftyp heic`): ścieżka libheif poza Safari, jeden obraz główny |
| `zdjecie-8000x6000.jpg` | `make-images.py`: gradient 400×300 powiększony do 8000×6000 (Pillow), kształty, JPEG q=92 (najwyższa jakość mieszcząca się w 3 MB) | duży obraz (48 Mpx), limit rozmiaru i wymiarów |
| `obraz.png` | `make-images.py`: RGBA, przezroczysty okrąg (alfa z odległości od środka) | przezroczystość |
| `obraz.gif` | `make-images.py`: 3 klatki 240×160, 300 ms, pętla nieskończona | GIF animowany, liczba klatek |
| `obraz.webp` | `make-images.py`: Pillow, WebP stratny q=80 | WebP |
| `obraz.bmp` | `make-images.py`: Pillow, 24 bity | BMP |
| `obraz.tiff` | `make-images.py`: Pillow, TIFF z kompresją LZW | TIFF (LZW) |
| `obraz.psd` | `make-images.py`: własny zapis PSD wg specyfikacji Adobe: nagłówek, sekcje o długości 0, obraz złożony RLE (PackBits), RGB 8 bitów, 640×480 | parser PSD, obraz złożony; piksele to gradient i dwa kształty |
| `skrypt.svg` | ręcznie: `<script>alert(1)</script>`, `onload="alert(2)"` na `<svg>`, widoczny prostokąt z napisem | SVG jako obraz nie wykonuje skryptu; widoczny kształt |
| `obraz-50000x50000.png` | ręcznie: prawdziwy nagłówek PNG, IHDR 50000×50000, poprawne CRC, mały IDAT, tEXt ok. 3 KB | dekoder nie może zaalokować 2,5 mld pikseli: odrzucenie po nagłówku, stan błędu |
| `notatki.txt` | ręcznie: polskie znaki, zawijanie, długi wiersz bez spacji, ścieżka z `\` | UTF-8, zawijanie, polskie znaki |
| `skrypt.py` | ręcznie: mały skrypt Python z komentarzem i f-stringiem | podświetlanie składni |
| `dane.json` | `json.dumps(ensure_ascii=False, indent=2)` | JSON, polskie znaki, `null`, wartości logiczne |
| `styl.css` | ręcznie: zmienne `:root`, `h1::before` z symbolem Unicode | CSS jako tekst |
| `strona.html` | ręcznie: `<script>`, `onload`, zdalny `<img src="http://127.0.0.1:9/…">` | HTML pokazany jako źródło; skrypt się nie wykonuje; brak żądania sieciowego |
| `klienci.csv` | `csv.writer(delimiter=';')`, 200 wierszy (ziarno 7), kwoty z przecinkiem, pole z `;` w cudzysłowie | CSV ze średnikiem, RFC 4180, polskie znaki |
| `dziennik.log` | 200 wpisów, poziomy INFO/WARN/DEBUG/ERROR, ziarno 7 | długi tekst z wieloma wierszami, polskie znaki |
| `dokument.docx` | `make-office.py` → `dokument.fodt` (nagłówki H1/H2, akapity, tabela, obraz, podział strony, lista) → `soffice --convert-to docx` | DOCX: style Heading1/Heading2, tabela, obraz osadzony |
| `dokument.doc` | ten sam `dokument.fodt` → `soffice --convert-to "doc:MS Word 97"` | Word 97 (OLE2) |
| `dokument.odt` | ten sam `dokument.fodt` → `soffice --convert-to odt` | ODT |
| `dokument.pdf` | ten sam `dokument.fodt` → `soffice --convert-to pdf` | PDF, 3 strony A4, obraz w PDF, tekst z polskimi znakami |
| `arkusz.xlsx` | `make-office.py` → `arkusz.fods` (arkusze „Plan” i „Wykonanie”, scalone A1:D1, waluta zł, daty, `SUM`, odwołania `[$Plan.C3]`) → `soffice` | XLSX: 2 arkusze, format zł, daty, scalenia, formuły z wartościami |
| `arkusz.xls` | ten sam `arkusz.fods` → `soffice --convert-to "xls:MS Excel 97"` | XLS (BIFF), formaty i formuły |
| `arkusz.ods` | ten sam `arkusz.fods` → `soffice --convert-to ods` | ODS, dwa arkusze |
| `prezentacja.pptx` | `make-office.py` → `prezentacja.fodp` (4 slajdy: tytuł, punkty, obraz, podsumowanie) → `soffice` | PPTX: tytuły, punkty, jeden obraz |
| `prezentacja.ppt` | ten sam `prezentacja.fodp` → `soffice --convert-to "ppt:MS PowerPoint 97"` | PPT (OLE2) |
| `docx-obraz-zewnetrzny.docx` | `make-office.py`: `zipfile`, obraz podpięty relacją `TargetMode="External"` na `http://127.0.0.1:9/zewnetrzny.png`, bez części obrazu | podgląd nie pobiera niczego; port 9 nie odpowiada; brak żądania poza serwerem |
| `uszkodzony.pdf` | `head -c` połowy `dokument.pdf` | PDF bez trailera: stan błędu, aplikacja działa dalej |
| `dzwiek.mp3` | `ffmpeg -f lavfi -i sine=frequency=440:duration=3`, libmp3lame 64k | MP3 |
| `dzwiek.ogg` | jw., libvorbis | Ogg Vorbis |
| `dzwiek.wav` | jw., pcm_s16le | WAV (PCM) |
| `dzwiek.flac` | jw., flac | FLAC |
| `dzwiek.m4a` | jw., aac 64k | M4A (AAC) |
| `film.mp4` | `ffmpeg -f lavfi -i testsrc2=size=640x360:rate=25:duration=4`, libx264 250k, `-movflags +faststart`, bez dźwięku | MP4 H.264: `moov` przed `mdat` (`ftyp, moov, free, mdat`) |
| `film-moov-na-koncu.mp4` | ten sam strumień, bez `faststart` | MP4 z `moov` za `mdat` (`ftyp, free, mdat, moov`): metadane na końcu pliku (plan §9.4) |
| `film.webm` | libvpx-vp9 150k | WebM VP9 |
| `film.mov` | libx264 250k w kontenerze QuickTime | MOV H.264 |
| `film-h264.mkv` | libx264 250k w Matroska | MKV H.264: ścieżka klatek dla MKV (plan §9.4) |
| `film-vp9.mkv` | libvpx-vp9 150k w Matroska | MKV VP9 |
| `film.avi` | `-c:v mjpeg -q:v 12` | AVI z MJPEG: kodek nie gra natywnie w `<video>`, oczekiwana karta lub ścieżka dekodera |
| `film-h264.avi` | libx264 250k w AVI | AVI z H.264 |
| `model.obj` | ręcznie: sześcian, 8 wierzchołków, 6 ścian-czworokątów | OBJ (czworokąty) |
| `model.stl` | ręcznie, binarny: nagłówek 80 B, 12 trójkątów z normalnymi | STL binarny |
| `model-ascii.stl` | ręcznie: ten sam sześcian w ASCII | STL ASCII (rozpoznanie ASCII) |
| `model.ply` | ręcznie, ASCII: wierzchołki i ściany `list uchar int` | PLY z siatką |
| `chmura.ply` | ręcznie, `binary_little_endian`: 20 000 punktów, x y z float, RGB uchar, bez ścian | PLY jako chmura punktów |
| `chmura.pcd` | ręcznie, ASCII: 10 000 punktów `x y z rgb`; rgb spakowane w float jak w PCL | PCD ASCII, kolor w polu float |
| `chmura.las` | ręcznie: LAS 1.2, format punktu 2 (26 B, RGB), skala 0,01, nagłówek 227 B, 20 000 punktów | LAS: nagłówek, skala, rekordy |
| `model.gltf` | ręcznie: JSON, bufor w `data:` base64, materiał PBR, normalne, indeksy uint16 | glTF z osadzonym buforem |
| `model.glb` | ta sama geometria w kontenerze GLB (chunki JSON i BIN) | GLB |
| `model.off` | ręcznie: OFF z czworokątami | OFF |
| `model.3mf` | ręcznie: ZIP z `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model` | 3MF (ZIP + XML) |
| `model.amf` | ręcznie: XML, obiekt, `volume` z trójkątami | AMF |
| `model.dae` | ręcznie: COLLADA 1.4.1, geometria, materiał, scena | COLLADA |
| `model.wrl` | ręcznie: VRML 2.0 (`#VRML V2.0 utf8`), `IndexedFaceSet` | VRML 2.0 |
| `rysunek.dxf` | ręcznie: DXF R12 (AC1009), `$DWGCODEPAGE ANSI_1250`, kodowanie cp1250; warstwy SCIANY, WYMIARY, TEKST z kolorami; LINE, CIRCLE, ARC, POLYLINE z VERTEX, TEXT „Rzut parteru” | DXF R12, polskie znaki w kodowaniu z nagłówka, warstwy i kolory |
| `font.ttf` | `make-fonts.py`: fontTools `FontBuilder`, glify-prostokąty dla „Zażółć gęślą jaźń” i cyfr, nazwa „Podgląd Test” | TTF: cmap z polskimi literami, nazwa kroju po polsku |
| `font.otf` | jw., CFF (nazwa w tablicy CFF ASCII „Podglad Test”, bo CFF to Latin-1; pełna nazwa w `name`) | OTF / CFF |
| `font.woff` | fontTools: ten sam TTF z `flavor = woff` | WOFF |
| `archiwum.zip` | `make-text.py`: zipfile, stała data wpisów, katalogi, nazwy UTF-8, pusty katalog | listowanie katalogów, polskie nazwy |
| `program.exe` | ręcznie: `MZ` + 64 KB losowych bajtów (ziarno 7) | nagłówek MZ: plik wykonywalny, karta „Pobierz” |
| `losowe.dwg` | ręcznie: `AC1032` + 32 KB losowych bajtów | sygnatura DWG przy zepsutej zawartości: stan błędu |
| `rysunek.dwg` | `cargo run -p notes-preview --example make_dwg_fixture` (acadrust `DwgWriter`): 3 warstwy w kolorach, pokój 6×4 m (linie), łuk, okrąg, zamknięta polilinia, teksty „Rzut parteru” i tekst z polskimi znakami | DWG R2018 (`AC1032`) → DXF: encje, warstwy, polskie znaki |
| `losowe.mkv` | ręcznie: EBML `1A 45 DF A3` + 32 KB losowych bajtów | błędny MKV: stan błędu |
| `losowe.doc` | ręcznie: sygnatura OLE2 `D0 CF 11 E0 A1 B1 1A E1` + 32 KB losowych | błędny .doc: stan błędu |
| `losowe.ppt` | ręcznie: sygnatura OLE2 + 32 KB losowych | błędny .ppt: stan błędu |
| `pusty.txt` | 0 B | plik 0 B |
| `granica-1MiB.bin` | losowe bajty, dokładnie 1 048 576 B | granica 1 MiB (`readHead`) |
| `granica-1MiB+1.bin` | losowe bajty, 1 048 577 B | granica 1 MiB + 1 B |
| `pdf-a-w-srodku-zip.pdf` | `zipfile`: ZIP z `notatka.txt`, zapisany jako `.pdf` | wykrywanie po sygnaturze, nie po rozszerzeniu |
| `bardzo długa nazwa pliku z polskimi znakami zażółć gęślą jaźń — wersja ostateczna poprawiona po uwagach.txt` | ręcznie: nazwa 119 B w UTF-8, ze znakiem `—` | długa polska nazwa, obcinanie w interfejsie |

Nie generowane tutaj, dojdą w późniejszych zadaniach: DWG z prawdziwym rysunkiem, STEP/IGES/BREP, IFC, FBX,
3DS, 3DM, LAZ, PPTX z animacjami.

`bomba.zip` nie leży w repo: `python3 scripts/fixtures/make-zip-bomb.py <katalog-tymczasowy>/bomba.zip`.
