# OCR — plan implementacji

Specyfikacja: `docs/OCR.md`. Ten plik: wyniki rozpoznania i prób (faza 0), decyzje, kontrakty, zadania. Gałąź
`buduj/ocr` (od `main` 19e5365), osobny katalog roboczy `../kajecik-ocr`.

## 1. Co już jest (rozpoznanie)

| Potrzeba | Gdzie w kodzie | Uwagi |
|---|---|---|
| wysyłanie plików, miniatury jako dzieci | `ui/src/remotefiles.ts` `upload`, `sendFile` (pole `parent`, w kopercie `thumbOf`) | warstwa tekstu idzie tą samą drogą, z `kind: "text"` |
| koperta i kontener v2 | `ui/src/filecrypto.ts` (`sealFile`, `sealMeta`, `FileMeta.key` = klucz pliku base64) | klucz pliku = wejście HMAC dla `textId` (OCR §3.2) |
| `createdBy` po stronie klienta | `FileInfo.createdBy` (`remotefiles.ts` `toInfo`) | wznawianie „moich plików bez tekstu” |
| dzieci na serwerze | `crates/node/src/files.rs`: `parent`, kosz/przywracanie `(file_id=? OR parent=?)`, usuwanie, sieroty w uzgadnianiu | kolumna `kind` dochodzi tym samym wzorcem migracji co `parent` (`ALTER TABLE` gdy brak) |
| ramka piaskownicy | `ui/preview/` (osobny build `vite.preview.config.ts`, `/preview/` z CSP `sandbox allow-scripts`, `crates/node/src/http.rs` `preview_csp`) | `extract.html` jako drugi wpis tego samego buildu, ta sama CSP |
| pdf.js, UTIF, libheif-js | `ui/package.json`: `pdfjs-dist` 6.5.438, `utif` 3.1.0, `libheif-js` 1.23.5 (`vendor/lgpl/`) | te same wersje |
| ONNX Runtime Web | `onnxruntime-web` 1.24.1 (dyktowanie, `ui/src/voice/worker.ts`: `wasmPaths` z własnych plików) | ta sama wersja, ten sam wzorzec bez CDN |
| COOP/COEP | `crates/node/src/http.rs` `security_headers`: `same-origin` + `require-corp` (dla wątków dyktowania) | strona już jest `crossOriginIsolated` (próba D niżej) |
| indeks i graf | `crates/core/src/index/` (`SpaceIndex`), `crates/web/src/index.rs` (`WasmIndex`), `ui/src/noteindex.ts`, `ui/src/graphworker.ts` | mapa rozszerza ten indeks |
| wyszukiwanie | `ui/src/searchview.ts` → `bridge.call("search")` (pulpit: SQLite FTS5; przeglądarka: prosty filtr) | przeglądarka dostanie BM25 z mapy |
| MCP | `mcp/src/*` (narzędzia odczytu i zapisu, ładuje `notes_web` WASM: `mcp/src/main.ts`), sesja `agent` w `crates/node/src/agents.rs` | MCP ≥ krok 4 z MCP §12 → etap 4 w całości |
| dostęp czatu do plików | **brak**: trasy plików (`files.rs`) przyjmują tylko sesję z ciasteczka (`auth::authorize`) | etap 4 dodaje osobną trasę czatu tylko dla `kind: "text"` |

## 2. Próby (faza 0)

Maszyna: Linux, 16 rdzeni, NVIDIA RTX 3060 (Vulkan 1.4), Chromium 141 / Firefox 142 / WebKit 26 (Playwright).
Skrypty prób: `scripts/models/` i `scripts/fixtures/ocr/` (fala 1), wyniki surowe niżej.

### A. Izolacja a sprzęt

Ramka z nagłówkami jak `/preview/` (CSP `sandbox allow-scripts`, COEP z warstwy ogólnej, CORP `cross-origin`):

| Gdzie | Chromium 141 | Firefox 142 | WebKit 26 |
|---|---|---|---|
| aplikacja | COI ✓, SAB ✓, WebGPU ✓ (nvidia ampere) | COI ✓, SAB ✓, WebGPU ✗ | COI ✓, SAB ✓, WebGPU ✗ |
| Worker aplikacji (`blob:`) | COI ✓, SAB ✓, WebGPU ✓ | COI ✓, SAB ✓ | COI ✓, SAB ✓ |
| ramka (nieprzezroczyste pochodzenie) | **COI ✗, SAB ✗**, WebGPU ✓ tylko w wątku głównym | COI ✓, SAB ✓ | COI ✓, SAB ✓ |
| Worker ramki (`blob:`) | **WebGPU ✗, SAB ✗** | COI ✓, SAB ✓ | **nie startuje** |

**Decyzja:** wariant zapasowy z OCR §3.5. Ramka parsuje plik (pdf.js, dekodery obrazów) i oddaje tekst stron PDF
albo **piksele** (`ImageBitmap`). Inferencja w **Workerze aplikacji** (jedyna droga z WebGPU i wątkami WASM w
Chromium). Worker dostaje tylko piksele i własne pliki modeli, nigdy bajtów pliku, klucza ani identyfikatorów. Ramka
nie potrzebuje modeli ani ONNX Runtime (prościej niż w specyfikacji: bez przekazywania modeli do ramki).

### B. ONNX Runtime Web bez CDN

Worker aplikacji, `ort.all.min.mjs` 1.24.1, `env.wasm.wasmPaths = "/…/"` (własne pliki), modele jako bajty.
Pobrane pliki: `ort.all.min.mjs`, `ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm`; **zero żądań
poza własnym serwerem**. Oba modele (fp32 i fp16) działają na `webgpu` bez błędów operatorów (profil braków: do
sprawdzenia w fali 4 przez `ort.env.webgpu.profiling`).

### C. Modele

`paddle2onnx` 2.0.2rc3, `paddlepaddle` 3.2.1, opset 17, oficjalne modele PaddleOCR 3.0 (`PP-OCRv5_mobile_det_infer`,
`latin_PP-OCRv5_mobile_rec_infer` z `paddle-model-ecology.bj.bcebos.com`), uproszczenie `onnxsim`. Słownik: 836 znaków
z `inference.yml` (+ pusty CTC na 0 + spacja na końcu = 838 wyjść); **wszystkie polskie litery są w słowniku.**

| Model | fp32 surowy / gzip | fp16 surowy / gzip | int8 (dynamiczny) |
|---|---|---|---|
| detektor | 4,75 / 4,53 MB | 2,42 / 1,79 MB | bez zmian (sploty nie są kwantyzowane dynamicznie) |
| rozpoznawanie | 8,01 / 7,31 MB | 4,20 / 3,73 MB | bez zmian (brak wag `MatMul`) |

CER (syntetyczne skany po polsku, Liberation Sans OFL, `scripts/fixtures/ocr/`), potok wzorcowy na ONNX (Python) vs
oficjalny PaddleOCR 3.3.2:

| Obraz | oficjalny PaddleOCR | ONNX fp32, det 960 | ONNX fp16, det 960 | ONNX fp16, det 1600 |
|---|---|---|---|---|
| skan czysty | 0,6% | 0,8% | 0,8% | 0,6% |
| mały druk | 0,4% | 0,4% | 0,4% | 0,4% |
| obrót 1,5° | 0,8% | 1,0% | 1,0% | 0,6% |
| szum + rozmycie | 1,2% | 2,2% | 2,2% | 2,0% |
| dwie kolumny | 61,5% (kolejność) | 61,5% | | |
| zdjęcie bez tekstu | 11 śmieciowych linii | 5 śmieciowych linii | | |

**Decyzje:** zostaje tylko **fp16** (ten sam CER, połowa pobierania, na WASM tak samo szybki jak fp32). int8 odrzucony
(brak zysku z dynamicznej kwantyzacji, statyczna wymagałaby kalibracji i ryzykowałaby CER). Kolejność kolumn i bramka
„brak tekstu” wymagają własnej logiki (oficjalny potok też ich nie ma).

### D. COOP/COEP

Już włączone w produkcji (`http.rs`, wprowadzone dla dyktowania, DYKTOWANIE §7, sprawdzone tam: logowanie, WebSocket,
podgląd, pobieranie). Strona aplikacji jest `crossOriginIsolated` (próba A). **Wątki WASM: tak.**

### E. Wydajność (Chromium, RTX 3060; mediana po rozgrzaniu, ms)

| Droga | det 960 / 1280 / 1600 | rec 1×320 | rec 8×480 | rec 32×480 | sesje (oba modele) |
|---|---|---|---|---|---|
| webgpu fp16 | 37 / 35 / 37 | 26 | 29 | 31 | 794 |
| webgpu fp32 | 51 / 96 / 143 | 8 | 24 | 91 | 737 |
| wasm 4 wątki fp16 | 113 / 207 / 319 | 15 | 227 | 1028 | 334 |
| wasm 1 wątek fp16 | 342 / 620 / 903 | 51 | 673 | 2495 | 345 |

Strona A4 (~40 linii): webgpu ≈ 0,1 s, wasm 4 wątki ≈ 1,5 s, wasm 1 wątek ≈ 4–5 s. **Rozmiar dla detektora: webgpu
1600 px, wasm 960 px** (różnica CER 0,2 pkt). Partia linii: webgpu 32, wasm 8. **Strona wzorcowa pomiaru:** wbudowany
syntetyczny skan (12 linii) w rozdzielczości 1240×1754. **Próg słabego urządzenia:** > 20 s na stronę wzorcową albo
`deviceMemory ≤ 4` (OCR §3.4), do potwierdzenia na laptopie (skrypt `scripts/models/measure.cjs` do uruchomienia
ręcznie; tu nie ma zintegrowanej karty).

## 3. Decyzje podczas implementacji

1. **Inferencja w Workerze aplikacji** (próba A), ramka tylko parsuje i rysuje.
2. **Modele fp16 w repozytorium** (`vendor/ocr-models/`, ok. 6,6 MB, Apache-2.0 z informacją o konwersji), z sumami
   SHA-256 i skryptem konwersji `scripts/models/convert.sh` (przypięte wersje). Budowa obrazu Dockera ich nie liczy
   ponownie (paddle jest ciężki); skrypt pozwala odtworzyć pliki i sprawdzić sumy.
3. **Serwer ukrywa `kind: "text"` na zwykłej liście plików** (`GET …/files` bez `?kinds=text`): stare klienty filtrują
   tylko `thumbOf` z koperty i pokazałyby warstwy tekstu jako pliki. Nowy klient prosi o `?kinds=text`.
4. Bramka „brak tekstu”: po rozpoznaniu odrzucamy linie bez co najmniej 2 liter/cyfr albo z pewnością < 0,5; strona
   bez linii = `brak tekstu`. Bramka detektora (OCR §2.4 pkt 2) na podstawie liczby i kształtu prostokątów — progi
   ustalone na zestawie testowym w fali 3.
5. Kolejność czytania z wykrywaniem dwóch kolumn (przerwa pionowa przez ≥ 60% wysokości strony).
6. **WebGPU bez `shader-f16`** (fala 4, RTX 3060 / Chromium 141 / Vulkan): modele fp16 na `webgpu` dają zera (jądra f16
   ORT 1.24.1 nie przechodzą walidacji WGSL, błąd niewidoczny dla kodu). Próba B mierzyła tylko czas na stałym wejściu
   i tego nie wykryła. Pomiar porównuje teraz wynik GPU z WASM (średnia i największa różnica); niesprawne GPU jest
   zapamiętane dla (ORT, sumy modeli, adapter) bez pętli pomiarów. **Dołączamy drugą parę modeli fp32** używaną tylko
   na `webgpu` bez `shader-f16` (pobierana tylko wtedy): na tej karcie najszybszy układ to detektor WASM fp16 +
   rozpoznawanie WebGPU fp32, 0,41 s na stronę wobec 0,83 s na samym WASM, CER bez zmian. WASM zawsze fp16
   (szybszy od fp32 na procesorze).
7. Wyszukiwanie: dopasowanie z odległością edycyjną (≤1 dla 5–8 znaków, ≤2 od 9) przy rzadkich słowach; obcinanie
   polskich końcówek wyłączone (zbiór 50 zapytań: recall@10 1,00 bez niego, MRR 0,99 → 0,97 z nim).

## 4. Kontrakty

### 4.1. Ramka `extract.html` (`/preview/extract.html`, CSP jak `/preview/`)

```
app → frame  { type: "extract", jobId, name, mime, bytes: ArrayBuffer, options: { maxPages, ocr: boolean } }
frame → app  { type: "page", jobId, page, pages, text?: string, bitmap?: ImageBitmap, reason?: "no-text" | "garbled" }
frame → app  { type: "done", jobId, pages, flags: Flag[] }       // po ostatniej stronie
frame → app  { type: "error", jobId, code: "encrypted" | "corrupt" | "unsupported" | "too-large" | "timeout" }
app → frame  { type: "cancel", jobId }
```
- `text` gdy strona PDF ma ≥ 20 znaków nieuszkodzonego tekstu (linie złożone po współrzędnych); inaczej `bitmap`
  (strona narysowana, dłuższy bok ≤ 2480 px). Obraz = jedna strona z `bitmap` (EXIF z `createImageBitmap`
  `imageOrientation: "from-image"`, TIFF/HEIC po dekodowaniu).
- Ramka nigdy nie dostaje klucza, `fileId`, `vaultId`, tokenów. Jedna ramka na zadanie, usuwana po `done`/`error`.

### 4.2. Worker OCR (aplikacja)

```
init { provider: "webgpu" | "wasm", threads, models: { det: URL, rec: URL, dict: URL } }
page { id, bitmap: ImageBitmap, detSide: number, batch: number } → result { id, lines: { text, conf, box }[], ms }
measure {} → { det: Provider, rec: Provider, msPerPage }
release {}
```
`detect(bitmap) → Box[]`, `recognize(crops) → {text, conf}[]`, `layout(lines) → string` (czysty TS, testy na wynikach
wzorcowych z próby C: `scripts/fixtures/ocr/golden/*.json`).

### 4.3. Warstwa tekstu (`ui/src/ocr/filetext.ts`)

`serialize(doc: FileTextDoc): string`, `parse(md: string): FileTextDoc | null`, `sanitizeLine(s)` (NFC, bez
sterujących poza `\t`, `#` → `\#` na początku), dokładnie OCR §3.1. Walidacja wyniku przed zapisem (`validate.ts`,
kod krytyczny): ≤ 2 MB, UTF-8, nagłówek zgodny ze schematem, strony rosnące od 1, brak sterujących.

### 4.4. Serwer (`files.rs`, kod krytyczny)

- Kolumna `kind TEXT` (NULL = jak dotąd), `POST …/files` przyjmuje `kind ∈ {"thumb","text"}` tylko z `parent`, rodzic
  musi istnieć w tym samym sejfie i mieć ten sam `scope`.
- `GET …/files` bez `?kinds=text` pomija `kind = 'text'`; z nim — dołącza. Rekord dostaje pole `kind`.
- Kosz, przywracanie, usuwanie, sieroty: bez zmian (już po `parent`).

### 4.5. Identyfikator i koperta (kod krytyczny, `ui/src/ocr/textlayer.ts`)

`textId = hex(HMAC-SHA256(keyBytes(original.key), "notes-file-text-v1\0" + fileId + "\0" + extractor))[0..32]`.
Koperta: `FileMeta` z `textOf`, `extractor`, `method`, `pages`, `lang`, `quality`, `flags`, `engine`, `encoding:
"gzip"`, `name: "<nazwa>.tekst.md"`, `mime: "text/markdown"`; ten sam `MetaRef` (klucz sejfu albo projektu) i `scope`
co oryginał. **Odstępstwo od OCR §3.2 („200/409 = zrobione”):** rekord pod `textId` liczy się jako zrobiony tylko,
gdy jest prawdziwą warstwą tego pliku (koperta pod jego kluczem, id wyprowadzone z klucza, tekst czyta się i parsuje
z `source` = oryginał). Warstwa w koszu jest przywracana, własne przerwane wysyłanie zaczyna się od nowa, cokolwiek
innego jest błędem. Inaczej członek mógłby zająć miejsce warstwy śmieciem, który wszyscy uznaliby za gotowy tekst.
Warstwa kończy wysyłanie i wraca z kosza tylko, gdy oryginał jest gotowy; tekst pliku w koszu nie jest pokazywany ani
wyszukiwany.

**Trwałe i przejściowe wyniki.** Id warstwy jest stałe, więc zapisana warstwa zostaje do usunięcia przez administratora
albo do nowej wersji ekstraktora. Zapisujemy więc tylko to, co jest cechą pliku: tekst, `brak tekstu`, `zabezpieczony`
(hasło) i `błąd` dla pliku uszkodzonego, nieobsługiwanego albo za dużego. Błąd Workera OCR, brak sieci, brak plików
pdf.js/libheif (`unavailable`), złamanie protokołu ramki (`protocol`) i `timeout` niczego nie zapisują; następne
uruchomienie próbuje znowu. **Świadomie przyjęte:** gdy łączny czas ramki (20 min) skończy się w trakcie bardzo dużego
skanu na wolnym urządzeniu, zapisujemy strony już odczytane ze znacznikiem `ucięte` i ta warstwa zostaje (reguła
słabych urządzeń z OCR §3.4 i tak kieruje OCR na szybszy komputer autora).

**Zakres w mapie (OCR §5.2).** Test różnicowy (proptest) pilnuje, że wywołanie z zakresem na całym indeksie daje
dokładnie to samo co wywołanie bez zakresu na indeksie zbudowanym tylko z widocznych notatek (wyszukiwanie z prefiksem,
frazą, wykluczeniem i tagiem, przegląd, sąsiedzi, wzmianki). Na granicy WASM tylko jawne `"*"` znaczy „wszystko”; `""`
i zły JSON to pusty zakres.

### 4.6. Mapa (Rust, `crates/core/src/index/map/`, eksporty w `crates/web/src/index.rs`)

`upsert_file_text(fileId, name, mime, markdown, embeddedIn_json)`, `remove_file(fileId)`, `search_json(q, limit,
cursor)`, `outline_json(id)`, `read_json(id, range)`, `neighbors_json(id, depth, types, limit)`, `map_json()`,
`chunk_json(id)`. Fragmenty, BM25 + trygramy, operatory i wzmianki jak OCR §4. Zakres (MCP) jako lista dozwolonych
węzłów przekazywana do każdego zapytania (kod krytyczny filtru po stronie MCP).

### 4.7. MCP (etap 4)

Trasa czatu `GET /api/agent/vaults/:id/files?kinds=text` i `…/files/:fid/content` (tylko `kind = 'text'`, rodzic w
sejfie z certyfikatu, uprawnienie „Tekst z plików” w certyfikacie), limity sesji `agent` (MCP §3.3). Narzędzia z OCR
§5.1, instrukcja w `initialize`.

## 5. Pliki i rozmiary (ładowane dopiero przy pierwszym rozpoznawaniu)

| Plik | Wariant | gzip | Kiedy |
|---|---|---|---|
| `PP-OCRv5_mobile_det` | fp16 | 1,79 MB | pierwszy OCR |
| `latin_PP-OCRv5_mobile_rec` | fp16 | 3,73 MB | pierwszy OCR (po bramce detektora) |
| `ort.all.min.mjs` + `ort-wasm-simd-threaded.jsep.{mjs,wasm}` | 1.24.1 | wspólne z dyktowaniem | pierwszy OCR |
| pdf.js | 6.5.438 | wspólne z podglądem | każdy PDF (w ramce) |

## 6. Zadania (fale)

Stan 2026-11-24: fale 1–8 zrobione w wersji webowej (wersja na pulpit, OCR §3.3, to etap 5). Narzędzia mapy w MCP
(`map`, `outline`, `read`, `neighbors`, `find_files`) idą za uprawnieniem `search`: nie zmieniają formatu zakresu ani
certyfikatu, a czat bez `search` nie dostaje ich wcale. Indeks czatu (`mcp/src/mapindex.ts`) zostawia w tekście
notatek osadzenia `![[plik:…]]` tylko plików widocznych dla czatu (krawędzie `embed`); resztę linków spoza zakresu
zamienia na znaczniki z tą samą numeracją co `read_note`. Po recenzji (2026-11-24): plik „nigdzie nieosadzony” jest
dla czatu niewidoczny, gdy sejf ma choć jeden zablokowany dla czatu chroniony projekt (jego notatki mogą osadzać plik
z dowolnym `project`), a osadzenia z kosza sejfu i otwartych projektów się liczą; indeks czatu jest zwalniany razem z
kluczami (`Session.onWipe`), ale `WasmSearch.free()` nie nadpisuje pamięci WASM (`shortcut:` w `mapindex.ts`).

| Fala | Zadanie | Kto | Zależy od |
|---|---|---|---|
| 1 | `kind` na serwerze + testy | Opus | — |
| 1 | `filetext.ts` (format, parser, sprzątanie) + testy | Haiku | — |
| 1 | `scripts/fixtures/ocr/` (obrazy, PDF przez pdf-lib, wzorce), `scripts/models/` (konwersja, sumy) | Opus (próby) + Haiku (PDF) | — |
| 1 | `vendor/ocr-models/` fp16 + NOTICE | Opus | konwersja |
| 2 | `extract.html` + protokół + tekst PDF (pdf.js, składanie linii, wykrywanie uszkodzonego tekstu) | Haiku | 1 |
| 2 | `textlayer.ts` (`textId`, koperta, wysyłka 200/409), `validate.ts` | Opus | 1 |
| 2 | kolejka po wysłaniu pliku, zakładka „Tekst” w podglądzie | Haiku | 2 |
| 3 | potok OCR w TS (przygotowanie, DB, wycinanie, CTC, kolejność, bramki) na wzorcach | Haiku ×2 | 1 |
| 4 | Worker OCR, wybór sprzętu, `device.lost`, zwalnianie | Haiku | 3 |
| 5 | obrazy/TIFF/HEIC/skany, kolejka autora, wznawianie, ustawienia, znaczki, filtr | Haiku | 2, 4 |
| 6 | mapa w Ruście (fragmenty, BM25, trygramy, operatory, węzły, wzmianki), test w Node | Haiku ×2 + Opus (filtr zakresu) | — |
| 7 | „Szukaj” z plikami, graf, eksport ZIP | Haiku | 6 |
| 8 | MCP: trasa czatu (Opus), uprawnienie (Opus), narzędzia (Haiku) | | 6 |
