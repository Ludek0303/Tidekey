# Zestaw testowy OCR (`fixtures/ocr/`)

Generowany przez `bash scripts/fixtures/ocr/make-ocr-fixtures.sh` (od zera, za każdym razem nadpisuje wszystko oprócz
tego README). Obok każdego pliku leży `<nazwa pliku>.expected.txt`: tekst wzorcowy, jedna linia na linię tekstu,
strony oddzielone linią `\f`. Pusty `.expected.txt` oznacza, że wynikiem ma być flaga (opisana poniżej), a nie tekst.
Tekst pochodzi z generatora i jest po polsku z ą ć ę ł ń ó ś ź ż w każdym pliku z tekstem.

Czcionka: Liberation Sans. Obrazy (Pillow) i `pdf-zly-font.pdf` używają wersji 1.07.4 z
`ui/node_modules/pdfjs-dist/standard_fonts/` (GPL-2.0 z wyjątkiem dla czcionek, który pozwala osadzać ją w
dokumentach; `LICENSES/LicenseRef-Liberation-1.txt`); PDF-y z soffice osadzają systemową Liberation Sans 2.1.5
(SIL OFL 1.1). To tylko pliki testowe, nie trafiają do aplikacji (REUSE.toml, docs/LICENCJE.md). Nic nie jest pobierane z internetu poza pakietami PyPI do venv (wersje przypięte).

## Pliki

- `pdf-tekst.pdf` (30677 B): 2 strony z warstwą tekstu (FODT, soffice). Str. 1 to nagłówek i 12 linii faktury,
  str. 2 to nagłówek i dwie kolumny (kolejność czytania: najpierw lewa kolumna, potem prawa). OCR nie powinien być
  potrzebny; wynik z warstwy tekstu ma zgadzać się z `.expected.txt`.
- `pdf-skan.pdf` (227908 B): 2 strony tylko z obrazem (Pillow, 200 DPI, 1654 × 2339). Brak warstwy tekstu, więc
  wynik to OCR obrazu i musi zwrócić `.expected.txt` (str. 1: faktura, str. 2: list).
- `pdf-mieszany.pdf` (118895 B): str. 1 z warstwą tekstu (jak w `pdf-tekst.pdf`), str. 2 tylko obraz (jak str. 2
  z `pdf-skan.pdf`). Dobry test wyboru drogi osobno dla każdej strony: str. 1 z warstwy, str. 2 przez OCR.
- `pdf-haslo.pdf` (31780 B): kopia `pdf-tekst.pdf` z hasłem użytkownika (AES-256); hasło testowe jest w
  `make-ocr.py` (dane testowe). Oczekiwana flaga `zabezpieczony` (pdf.js: `PasswordException`), bez tekstu.
- `pdf-zly-font.pdf` (91377 B): PDF pisany ręcznie przez generator (obiekty, xref, trailer). Tekst
  idzie przez font Type0/Identity-H z osadzonym TrueType (Liberation Sans) bez tablicy cmap i bez ToUnicode. Na
  ekranie widać poprawny tekst, ale warstwa tekstu daje bezsensowne znaki (pdf.js: `6]DQRZQL3DĄ…`). Oczekiwane:
  uznać warstwę za zepsutą i zrobić OCR strony. `.expected.txt` to list (3 pierwsze linie: "Szanowni Państwo,", …).
- `skan-czysty.png` (89704 B): strona faktury, 2480 × 3508, skala szarości, bez szumu. OCR, wynik = `.expected.txt`.
- `skan-szum.png` (598462 B): jak `skan-czysty.png`, z szumem (2% pikseli) i rozmyciem. OCR, wynik = `.expected.txt`.
- `skan-obrot.png` (238373 B): jak `skan-czysty.png`, obrócony o 1,5° i lekko rozmyty. OCR, wynik = `.expected.txt`.
- `skan-maly.png` (46354 B): jak `skan-czysty.png`, mniejsza czcionka (28 px) i rozdzielczość 1654 × 2339. OCR.
- `dwie-kolumny.png` (30168 B): dwie kolumny tekstu na jednej stronie (2480 × 1600). Wynik OCR: najpierw lewa
  kolumna, potem prawa, czyli `.expected.txt`.
- `zdjecie-bez-tekstu.png` (889976 B): kolorowe kręgi na niebieskim tle, bez tekstu. Oczekiwany wynik: pusty tekst.
- `obrot-exif.jpg` (301125 B): zawartość jak `skan-czysty.png`, ale piksele leżą obrócone o 90°, a EXIF
  `Orientation=6` obraca je z powrotem. Bez uwzględnienia EXIF OCR nie znajdzie tekstu; wynik = `.expected.txt`.
- `wielostronicowy.tiff` (10896 B): TIFF 1-bitowy, Group 4, 2 strony (str. 1 list, str. 2 kilka linii). Wynik
  OCR = `.expected.txt` ze stronami oddzielonymi `\f`.
- `zdjecie.heic` (30660 B): strona tekstu zapisana jako HEIC (pillow-heif 1.8.1, ta sama wersja co
  `scripts/fixtures/make-heic.sh`). Wynik OCR = `.expected.txt`.
- `obraz-ogromny.png` (409616 B): 50000 × 50000 px, 1-bit, biały, z jednym krótkim wierszem tekstu
  ("Krótki wiersz na bardzo dużym obrazie."). Oczekiwana flaga `ucięte` albo `błąd` (ponad limit 50 Mpx),
  bez tekstu. Plik jest generowany strumieniowo, bo cały bufor zająłby ~2,5 GB RAM.
- `obciety.pdf` (18406 B): `pdf-tekst.pdf` obcięty do 60% bajtów (brak końca, brak xref). pdf.js odrzuca go jako
  `InvalidPDFException`. Oczekiwana flaga `ucięte` albo `błąd`, bez tekstu.
- `losowe.pdf` (24585 B): nagłówek `%PDF-1.4` i 24 KiB losowych bajtów (ziarno 11). Oczekiwana flaga `błąd`, bez
  tekstu; pdf.js: `InvalidPDFException`.
- `losowe.png` (24584 B): sygnatura PNG i 24 KiB losowych bajtów (ziarno 12). Oczekiwana flaga `błąd`, bez tekstu.

## Pliki wrogie (`make-hostile.py`)

Generowane przez `scripts/fixtures/ocr/make-hostile.py` (tylko biblioteka standardowa). Nie mają `.expected.txt`:
wynikiem jest błąd albo flaga, opisana tutaj. Każdy test ekstraktora (`scripts/test-ocr-extract.cjs`) mierzy czas.

- `petla.tiff` (186 B): TIFF, którego IFD wskazuje na siebie. Oczekiwane: `corrupt` od razu, bez wejścia w UTIF
  (przed zmianą UTIF kręcił się bez końca, a synchroniczna pętla nie dawała się przerwać limitem czasu).
- `heic-to-png.heic` (109 KB): PNG 30000 × 30000 (1 bit, IDAT z zer), podany jako `image/heic`. Oczekiwane:
  `too-large` z nagłówka, bez dekodowania (przeglądarka rozpoznałaby PNG i zdekodowałaby całość).
- `pdf-wielki-obraz.pdf` (195 KB): jedna strona z obrazem 40000 × 40000 (1 bit, Flate). Oczekiwane: błąd
  (`too-large` albo `timeout`) albo strona bez obrazu; nie zawieszenie ani awaria ramki.
- `pdf-wspolrzedne.pdf` (894 B): tekst w trzech liniach zwykłych i dwóch wierszach narysowanych przy x = +5e8 i
  x = −5e8. Oczekiwane: zakończenie, tekst strony (zwykłe linie), bez wierszy poza stroną.

## Co może się różnić między wersjami narzędzi

Wszystko jest powtarzalne na tym samym zestawie narzędzi (dwa kolejne przebiegi dają identyczne sumy SHA-256).
Po zmianie wersji mogą różnić się bajty, nie tekst:

- `pdf-tekst.pdf`, `pdf-mieszany.pdf`, `obciety.pdf` i kopie PDF: zależą od wersji LibreOffice (układ, podzbiór
  czcionki). Metadane i ID są ustawione na stałe przez `pypdf`, więc znacznik czasu nie wchodzi w grę.
- `pdf-skan.pdf`, `skan-*.png`, `dwie-kolumny.png`, `obrot-exif.jpg`, `wielostronicowy.tiff`, `zdjecie.heic`:
  zależą od Pillow, libjpeg, libheif. Zmiana kodeka to zmiana bajtów, tekst zostaje ten sam.
- `pdf-haslo.pdf`: sól i IV szyfrowania losuje pypdf; generator ustawia ziarno (`secrets.token_bytes`), więc
  przebiegi są identyczne przy tej samej wersji pypdf.
- `pdf-zly-font.pdf`: zależy od wersji Liberation Sans z `pdfjs-dist`.
