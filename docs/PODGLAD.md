# Podgląd plików

Okno podglądu otwierane dwukrotnym kliknięciem (oraz spacją i pozycją „Podgląd” w menu kontekstowym). Plik jest
odszyfrowywany w przeglądarce (PLIKI §2, §6), więc **cały podgląd działa po stronie klienta**. Żadna usługa nie
dostaje treści pliku. Ten dokument zbiera: biblioteki, których wolno użyć w płatnej aplikacji, oraz plan własnych
parserów tam, gdzie gotowej biblioteki z odpowiednią licencją nie ma. Od 2026-11-24 projekt jest open source na licencji
AGPL-3.0-or-later (LICENCJE.md); zasady dla zależności poniżej zostają, bo autor chce móc udzielać także osobnej
licencji komercyjnej.

Stan: zbudowane w przeglądarce (2026-11-18, gałąź `buduj/podglad`); plan wykonania i decyzje: [PODGLAD-PLAN.md](PODGLAD-PLAN.md),
odchylenia od tej specyfikacji: §6. Licencje sprawdzone w listopadzie 2026; przed wydaniem trzeba je sprawdzić ponownie
(lista kontrolna w §4). To nie jest porada prawna.

Decyzje:
- 2026-11-14: **wideo w oknie podglądu = tylko pierwsza klatka** (obraz), bez odtwarzania (§2.2).

---

## 1. Dozwolone biblioteki

Legenda warunków:
- **notka**: zachować informację o autorze i tekst licencji w `THIRD_PARTY_NOTICES.txt` (MIT, BSD, ISC, Apache-2.0;
  Apache dodatkowo: dołączyć plik `NOTICE`, jeśli jest, i oznaczyć zmienione pliki). Noty powstają automatycznie
  (`node scripts/licencje/generate.mjs`, LICENCJE.md).
- **MPL**: pliki biblioteki bez zmian albo zmiany w **tych plikach** publikujemy (np. publiczny fork). Biblioteka MPL
  jest dozwolona tylko imiennie (wyjątek w `deny.toml` albo w zadaniu `licencje` w CI). Do 2026-11-24 ta zasada
  chroniła zamknięty kod; po otwarciu kodu na AGPL chroni możliwość osobnej licencji komercyjnej (nasz kod łączony z
  biblioteką MPL może mieć dowolną licencję).
- **LGPL**: biblioteka jako **osobny, niezmieniony plik** `.js` + `.wasm` wczytywany w czasie działania (nie wklejony do
  naszego bundla), tekst licencji i link do źródeł danej wersji w „O programie”, użytkownik może podstawić własny build.

| Format | Biblioteka | Licencja | Warunek |
|---|---|---|---|
| 3D: obj, stl, ply, gltf/glb, fbx, 3ds, 3mf, amf, dae, wrl, off, 3dm, ifc, step, iges, brep, fcstd | Online3DViewer (engine) + three.js | MIT | notka |
| ↳ STEP / IGES / BREP | occt-import-js (OpenCascade); dziś nieużywane, karta „Pobierz” (§6) | LGPL-2.1 | LGPL |
| ↳ IFC | web-ifc | MPL-2.0 | MPL |
| ↳ 3DM, draco | rhino3dm, draco | MIT, Apache-2.0 | notka |
| Chmury punktów: LAS/LAZ (do v1.3), PCD, PLY | loaders.gl | MIT | notka |
| DXF | dxf-viewer | MPL-2.0 | MPL |
| DWG (R13–R2018) | acadrust (Rust, do WASM) albo acad-ts (TypeScript, port ACadSharp) | MPL-2.0 / MIT | MPL / notka |
| PDF | pdf.js | Apache-2.0 | notka |
| DOCX | docx-preview (docxjs) | Apache-2.0 | notka; JSZip w wariancie MIT |
| XLSX, XLS, XLSB, ODS, CSV | SheetJS CE (z cdn.sheetjs.com) albo calamine (Rust) | Apache-2.0 / MIT | notka (SheetJS: ich dokładna formułka) |
| PPTX | Pagus albo pptx-browser | MIT | notka; przetestować jakość |
| Kod, tekst, JSON, logi, Markdown | CodeMirror 6 (już w projekcie) | MIT | notka |
| Obrazy przeglądarkowe (jpg, png, gif, webp, avif, svg jako `<img>`) | natywnie | — | — |
| HEIC / HEIF | libheif-js (poza Safari) | LGPL-3.0 | LGPL |
| TIFF | UTIF.js | MIT | notka |
| PSD | ag-psd | MIT | notka |
| Fonty: ttf, otf, woff | opentype.js | MIT | notka |
| ZIP (lista plików, podgląd wnętrza) | fflate | MIT | notka |
| Audio: mp3, ogg, wav, flac, m4a | natywnie (`<audio>`) | — | — |
| Wideo — pierwsza klatka: mp4, webm, mov | natywnie (`<video>` + `<canvas>`) | — | — (§2.2) |
| Wideo — pierwsza klatka: mkv, avi | własny mini-demuxer (Rust/WASM) + WebCodecs | własny kod | — (§2.2) |

DWG: acadrust pasuje do naszego rdzenia w Ruście. Wynik (linie, łuki, teksty, bloki, warstwy) zamieniamy na ten sam model
co DXF i rysujemy tą samą ścieżką. Biblioteka jest młoda (0.2.x): sprawdzić kompilację do `wasm32` i jakość na
prawdziwych rysunkach. Zapas: acad-ts.

## 2. Niedozwolone — i jak zrobić własne

| Co odpada | Dlaczego |
|---|---|
| ONLYOFFICE, Collabora (podgląd/edycja Office) | AGPL (obowiązek otwarcia kodu także przy SaaS) **i** konwersja na serwerze, co łamie E2E |
| react-doc-viewer i podobne | wysyłają plik do przeglądarki Microsoftu/Google (publiczny URL) — łamie E2E |
| LibreDWG | GPL-3.0 (zastąpione przez acadrust / acad-ts, §1) |
| ffmpeg.wasm | domyślny `@ffmpeg/core` jest na GPL; przy samej pierwszej klatce niepotrzebny (§2.2) |
| stare `.doc` i `.ppt` | brak gotowej biblioteki z licencją pozwalającą na sprzedaż → §2.1 |

### 2.1. Stare pliki Office: `.doc` i `.ppt` (Rust)

Oba formaty to kontener **OLE2 / Compound File Binary** — mały system plików w jednym pliku. Microsoft publikuje
specyfikacje: [MS-CFB] (kontener), [MS-DOC], [MS-PPT]. Kontener otwiera crate `cfb` (MIT).

**`.doc` — etap 1: sam tekst z akapitami (kilka dni)**
1. `cfb` → strumień `WordDocument`.
2. Na początku jest nagłówek **FIB**. Z niego: który strumień tabel (`0Table` albo `1Table`), przesunięcie i długość
   **CLX**.
3. W CLX jest **tabela kawałków** (piece table): lista fragmentów tekstu. Każdy kawałek mówi, gdzie leży w
   `WordDocument` i czy to tekst 8-bitowy (strona kodowa) czy UTF-16.
4. Sklejamy kawałki po kolei → cały tekst. `\r` = koniec akapitu, `\x07` = koniec komórki/wiersza tabeli,
   `\x0C` = podział strony; pomijamy znaki pól (`\x13`…`\x14`…`\x15` → bierzemy tylko wynik pola).
5. Wynik: lista akapitów → prosty HTML w ramce podglądu.

**`.doc` — etap 2 (opcjonalnie, tygodnie):** pogrubienie, rozmiar i nagłówki z bloków **CHPX/PAPX** (FKP), obrazy ze
strumienia `Data`.

**`.ppt` — tekst i obrazy na slajdach (ok. tydzień)**
1. `cfb` → strumień `PowerPoint Document` i `Current User`.
2. Strumień to drzewo **rekordów**: każdy ma 8 bajtów nagłówka (wersja/instancja, typ, długość). Kontener zawiera
   kolejne rekordy, atom zawiera dane.
3. Idziemy od `UserEditAtom` → tabela położeń → `SlideContainer` każdego slajdu. Tekst z `TextCharsAtom` (UTF-16) i
   `TextBytesAtom` (8-bit).
4. Obrazy: strumień `Pictures` — kolejne JPEG/PNG z krótkim nagłówkiem; wyciągamy je jako Blob.
5. Wynik: każdy slajd jako karta z tytułem, tekstem i obrazami (bez dokładnego układu).

**`.xls`** nie wymaga własnej pracy: SheetJS albo calamine (MIT, czysty Rust, czyta też `.xls`).

### 2.2. Wideo: tylko pierwsza klatka

Okno podglądu pokazuje dla nagrania **jeden obraz: pierwszą klatkę**, plus nazwę, rozmiar, długość (jeśli znana) i
„Pobierz”. Nie ma odtwarzacza, przewijania ani dźwięku. Dzięki temu nie potrzebujemy ffmpeg ani własnych dekoderów.

**Główna droga: miniatura tworzona przy wysyłaniu** — tak jak miniatury zdjęć (PLIKI §2):
1. Przy dodaniu pliku wideo klient ma jawny plik (`File`, z dostępem losowym przez `slice`).
2. Wyciąga pierwszą klatkę (niżej jak), skaluje do ≤ 480 px dłuższego boku, koduje do JPEG/WebP.
3. Wysyła ją jako osobny plik z `thumbOf` w metadanych i `parent` w rekordzie; oryginał dostaje `thumb`. Kosz,
   przywracanie i usuwanie działają razem, jak przy zdjęciach.
4. Okno podglądu pobiera i odszyfrowuje **tylko miniaturę** (dziesiątki KB). Duży film nie jest pobierany.

**Jak wyciągnąć pierwszą klatkę:**
- **mp4, webm, mov** (formaty, które przeglądarka sama otwiera): `<video muted preload="auto">` z URL Bloba → po
  `loadeddata` ustawić `currentTime = 0` i poczekać na `seeked` (albo `requestVideoFrameCallback`) → `drawImage` na
  `<canvas>` → `toBlob`. Zero własnego kodu dekodującego.
- **mkv, avi** (przeglądarka ich nie otwiera): mały **demuxer w Ruście (WASM)**, który szuka tylko dwóch rzeczy —
  opisu ścieżki wideo i bajtów pierwszej klatki kluczowej:
  - **MKV/WebM** (EBML: każdy element = `ID (varint) + rozmiar (varint) + dane`): `Segment` → `Tracks` → ścieżka typu
    wideo (`CodecID`, `CodecPrivate`, wymiary) → pierwszy `Cluster` → pierwszy `SimpleBlock` tej ścieżki z flagą klatki
    kluczowej. Reszta pliku nie jest czytana.
  - **AVI** (RIFF: bloki `FourCC + długość`): `hdrl` → `strh`/`strf` (kodek FourCC, `BITMAPINFOHEADER`) → pierwszy blok
    `00dc` w `movi`.
  - Potem WebCodecs: `VideoDecoder.configure({codec, codedWidth, codedHeight, description: CodecPrivate})` →
    `decode(new EncodedVideoChunk({type: "key", timestamp: 0, data}))` → `flush()` → `VideoFrame` → `drawImage` na
    `OffscreenCanvas` → `frame.close()`, `decoder.close()`.
  - Rozmiar: ok. 200–400 linii Rusta, 2–3 dni z testami.
- Kodek, którego przeglądarka nie dekoduje (`VideoDecoder.isConfigSupported` = false) → ikona filmu zamiast klatki.

**Filmy wysłane wcześniej, bez miniatury:**
- Przy pierwszym podglądzie klient odszyfrowuje **tylko początek pliku**: secretstream można przerwać po N porcjach
  (limit np. 16 MiB). To wystarcza dla MKV, AVI, WebM i MP4 z `moov` na początku („faststart”).
- MP4/MOV z `moov` na końcu wymaga całego pliku (secretstream odszyfrowuje po kolei). Poniżej limitu odszyfrowujemy
  całość, powyżej — ikona i „Pobierz”.
- Udana klatka jest wysyłana jako miniatura (rola edytor+), więc następny podgląd jest natychmiastowy.

**Limity i sprzątanie:** czas na wyciągnięcie klatki 5 s, maksymalne wymiary dekodowania (np. 8192 × 8192), zawsze
`frame.close()` i `decoder.close()`, zwolnienie URL Bloba.

**Pulpit na Linuksie (WebKitGTK):** `<video>` działa przez GStreamer (potrzebne wtyczki kodeków); wsparcie WebCodecs
zależy od wersji WebKitGTK i GStreamera — sprawdzić, a bez niego mkv/avi pokazują ikonę.

**Rozstrzygnięte (2026-11-17):** obecne odtwarzanie wideo z PLIKI §6 („Otwórz” → `<video>`) zostaje obok podglądu.

### 2.3. Zasady wspólne dla własnych parserów

- Jeden crate `preview` w workspace (obok `core`), kompilowany do WASM (`wasm-bindgen`). Zwraca **neutralny model**
  (akapity / prymitywy 2D / opis klatki wideo), a JavaScript tylko go rysuje.
- Dane wejściowe są **niezaufane**: bez `panic` (wszystko `Result`), limity jak w silniku kalendarza (maks. liczba
  obiektów, maks. rozmiar po rozpakowaniu, głębokość rekurencji, budżet pracy), przekroczenie = „Nie można wyświetlić”.
- `cargo-fuzz` dla każdego formatu + zbiór przykładowych plików w testach.
- **Czysta implementacja:** piszemy ze specyfikacji. Nie czytamy i nie kopiujemy kodu na GPL/AGPL (LibreDWG, ffmpeg w
  części GPL). Kod MIT/Apache (np. calamine) można czytać i przenosić z zachowaniem notki.

## 3. Okno podglądu — architektura

1. Podgląd działa w `<iframe sandbox="allow-scripts">` **bez** `allow-same-origin`, z CSP `default-src 'none';
   script-src 'self'; connect-src 'none'; img-src blob: data:`. Ramka nie ma dostępu do IndexedDB z kluczem osobistym
   i nie może nic wysłać w sieć.
2. Aplikacja odszyfrowuje plik i przekazuje bajty przez `postMessage` (transfer `ArrayBuffer`) razem z `mime` i nazwą
   z koperty metadanych.
3. Wybór przeglądarki: typ MIME + „magiczne bajty” (np. `PK\x03\x04` = ZIP/OOXML, `D0 CF 11 E0` = OLE2,
   `AC10xx` = DWG, `1A 45 DF A3` = EBML/MKV, `RIFF…AVI ` = AVI), nie tylko rozszerzenie.
4. Każdy moduł dołączony do aplikacji (bez CDN, jak libsodium) i wczytywany dopiero przy pierwszym pliku danego typu.
5. Zamknięcie okna zwalnia Bloby, `VideoFrame` i pamięć WASM (PLIKI §6: bez trwałych kopii lokalnych).
6. Formaty bez przeglądarki: karta z nazwą, rozmiarem, typem i przyciskiem „Pobierz”.

## 4. Lista kontrolna licencji przed wydaniem

1. `THIRD_PARTY_NOTICES.txt` (katalog główny) generowany z danych budowania przez `scripts/licencje/generate.mjs`,
   dołączany do każdego artefaktu i pokazywany w Ustawienia → O programie (pulpit i przeglądarka). CI sprawdza, że
   jest aktualny.
2. W CI: `cargo deny check` dla wszystkich celów i aplikacji Tauri, lista dozwolonych licencji npm
   (`license-checker-rseidelsohn --onlyAllow`, wyjątki imienne), `reuse lint`, gitleaks. Pełna lista kontrolna przed
   wydaniem: LICENCJE.md.
3. Pliki LGPL w `vendor/lgpl/` jako niezmienione kopie: wersja, SHA-256, link do źródeł. W Tauri w `resources/`.
4. Własne poprawki w bibliotekach MPL/LGPL — publiczny fork.

## 5. Kolejność prac

1. Ramka podglądu (§3) + kod/tekst (CodeMirror) + obrazy + audio natywne.
2. Wideo: miniatura pierwszej klatki przy wysyłaniu dla mp4/webm/mov (`<video>` + canvas) i podgląd z miniatury (§2.2).
3. PDF (pdf.js) — zastępuje obecne otwieranie w nowej karcie.
4. 3D (Online3DViewer, bez STEP), chmury punktów (loaders.gl).
5. DOCX, XLSX, PPTX.
6. DXF + DWG (acadrust → model DXF).
7. STEP/IGES (occt, LGPL), HEIC (libheif, LGPL).
8. Własne: pierwsza klatka mkv/avi (§2.2), `.doc`/`.ppt` (§2.1).

## 6. Odchylenia przy implementacji (2026-11-18)

Ostateczne wybory bibliotek:

| Format | Wybrane | Uwagi |
|---|---|---|
| PPTX | pptx-browser 4.1.5 (MIT) | Pagus nie istnieje w npm ani pod znanym repozytorium. Przy budowie dwie poprawki biblioteki (`ui/preview/vite-offline.ts`): bez pobierania fontów Google, deklaracja `defRPr` przed użyciem (bez niej tekst kształtów z punktorami znikał). |
| XLSX, XLS, XLSB, ODS | SheetJS CE 0.20.3 z cdn.sheetjs.com | wartości sformatowane jak w Excelu (`w`), scalenia, nazwy arkuszy; calamine dałby same wartości. |
| DWG | acadrust 0.6.8 w `crates/preview` | DWG → DXF w WASM, rysowane przez dxf-viewer. Osobny moduł WASM (1,7 MB gzip), ładowany tylko dla DWG; reszta parserów to 86 KB gzip. |
| PDF | pdfjs-dist 6.5.438, wersja **legacy** | wersja zwykła woła `Math.sumPrecise` i `Map.getOrInsertComputed`, których obecne przeglądarki nie mają; bez nich tekst rysował się złymi znakami. |
| ZIP | własny odczyt katalogu centralnego | zamiast fflate: sama lista, bez rozpakowywania, pełna kontrola limitów; ta sama funkcja pilnuje „bomby zip” przed bibliotekami Office. |

Inne odchylenia:
- **3DM** (Rhino) oraz **STEP, IGES, BREP** nie są pokazywane: rhino3dm i occt-import-js potrzebują `eval` (kod
  embind generuje funkcje przez `new Function`), a ramka go nie dopuszcza. Te pliki dostają kartę „Pobierz” od razu.
  Gotowa praca dla STEP/IGES/BREP (pliki LGPL w `vendor/lgpl/occt-import-js-0.0.23/` z SHA-256, przeglądarka three.js,
  plik testowy `model.step`) jest na gałęzi `buduj/podglad-step-eval`. **Do decyzji właściciela:** osobny dokument ramki
  (np. `/preview/eval.html`) z `'unsafe-eval'` tylko dla tych dwóch bibliotek — ta sama piaskownica bez sieci i kluczy,
  więc `eval` daje złośliwemu plikowi tyle, co błąd w parserze, ale to rozluźnienie polityki z §3.
- **CSP ramki** (§3): `script-src` wymienia adres serwera wprost (WebKit nie dopasowuje `'self'` w ramce bez pochodzenia),
  `connect-src blob:` zamiast `'none'` (biblioteki WASM ładują dane z adresów `blob:` zrobionych przez samą ramkę; żaden
  serwer nie jest osiągalny), `sandbox allow-scripts` także w samej CSP. Pliki `.wasm` ramka dostaje od aplikacji.
- **Każdy plik w nowej ramce**: kod, który uruchomiłby jeden plik, nie widzi bajtów następnego.
- **Workery** tylko klasyczne z `blob:` (moduły z `blob:` nie działają w Chromium, a WebKit pod COEP nie uruchamia
  żadnego); bez workera praca idzie w wątku ramki.
- **Filmy wysłane wcześniej**: odszyfrowane jest najwyżej 16 MiB, potem pobieranie jest przerywane. Serwer nie obsługuje
  `Range`, więc stos sieciowy przeglądarki zdąża przeczytać z wyprzedzeniem jeszcze kilka MiB (pomiar na pętli lokalnej:
  20–24 MiB dla filmu 29 MB). Dokładne 16 MiB wymaga obsługi `Range` w `…/content` (zmiana API serwera, nie w tym etapie).
- **.doc** (etap 1): tabulator zostaje w tekście (inaczej słowa się sklejają); podziały stron tylko ze znaku `\x0C`
  (LibreOffice zapisuje je jako właściwość akapitu, więc w jego plikach ich nie widać).
- **.ppt**: tytuł to typ tekstu 0 i 6 (MS-PPT), nie 5; obraz bez ustalonego slajdu trafia na ostatni slajd.
- **MKV/AVI**: gdy pierwszy Cluster nie ma klatki kluczowej ścieżki, czytane są następne (w granicach budżetu).
- **Pulpit (Tauri)**: bez okna podglądu w tym etapie (brak magazynu plików na pulpicie, jedna CSP dla wszystkich stron
  Tauri, brak WebKitGTK na maszynie budowy do sprawdzenia ramki).
- **Podwójny prawy przycisk** nie otwiera podglądu: pierwsze menu musi się pokazać od razu, więc drugie kliknięcie
  zawsze zamykałoby widoczne menu.
- **Nie sprawdzone na prawdziwych plikach**: LAZ (brak próbki i narzędzia do zapisu), FBX, 3DS, draco w glTF, zaszyfrowane
  .xls/.ppt, natywne HEIC w Safari, WebCodecs w WebKitGTK.
