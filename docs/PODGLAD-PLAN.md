# Podgląd plików — plan wykonania

Plan do [PODGLAD.md](PODGLAD.md) (specyfikacja: biblioteki, licencje, własne parsery). Ten dokument mówi, **gdzie** w kodzie
co powstaje, jakie są kontrakty między częściami i w jakiej kolejności to budujemy. Gałąź: `buduj/podglad`.

Stan: 2026-11-18, zbudowane (fazy 1–3); decyzje podczas pracy w §11, odchylenia od specyfikacji w PODGLAD.md §6.

---

## 1. Rozpoznanie (faza 0): co już jest

| Punkt specyfikacji | Gdzie jest dziś | Co zmieniamy |
|---|---|---|
| „Otwórz” / „Pobierz” osadzenia | `ui/src/attachments.ts`: `chip()`, `preview()` (PDF w nowej karcie, tekst w `<pre>`, audio/wideo w `<video>` w oknie), `openImage()`, `download()`, `openFile()` | zostają jako „Otwórz” i „Pobierz”; dochodzi „Podgląd” (dwuklik, menu) |
| Pamięć podręczna Blobów | `attachments.ts`: `BlobCache` (limit `CACHE_BYTES`), `readCached()`, `Owner` (zwalnianie URL) | okno podglądu nie korzysta z tej pamięci (bajty idą do ramki i znikają po zamknięciu) |
| Leniwe wczytywanie | `attachments.ts`: `whenVisible()` (IntersectionObserver), `lazyLoad()` | bez zmian |
| Zakładka „Pliki” | `ui/src/filesview.ts`: `renderFilesPage()`, `fileRow()` (tabela z przyciskami), `openImage()` (nowa karta) | wiersz z fokusem, dwuklik i spacja = podgląd, menu kontekstowe wiersza, przycisk „Podgląd” |
| Pliki w folderach drzewa | `ui/src/folderfiles.ts`: `openFolderFile()` (obraz w oknie, PDF w karcie, reszta „Pobierz”); `ui/src/explorer.ts`: `fileMenu()`, klik na wierszu pliku | klik/Enter/spacja = podgląd; „Podgląd” w `fileMenu()` |
| Okno pliku w folderze plików | `ui/src/filefolders-view.ts` → `openFile()` | dwuklik = podgląd |
| Widok czytania | `attachments.ts`: `embedReadingImages()` | dwuklik i menu kontekstowe na osadzeniu |
| Podgląd na żywo | `attachments.ts`: `FileWidget`, `ImageWidget` (`ignoreEvent() = true`) | dwuklik i menu kontekstowe na widżecie |
| Paleta poleceń | `ui/src/commands.ts`: `registerCommand()`; rejestracja w `main.ts` | „Podgląd pliku” |
| Menu kontekstowe | `ui/src/widgets.ts`: `openMenu(x, y, entries)` | używamy go |
| Okna | `widgets.ts`: `openDialog()` (pułapka fokusu, powrót fokusu, Esc) | okno podglądu ma własny układ (pełny ekran), ale tę samą logikę fokusu |
| Szyfrowanie | `ui/src/filecrypto.ts` (krytyczny): `openFile()` to generator porcji po 1 MiB, każda uwierzytelniona osobno | bez zmian; częściowe odszyfrowanie = przerwanie generatora po N porcjach |
| Pobieranie | `ui/src/remotefiles.ts`: `RemoteFileStore.read()` (fetch `…/content`, `openFile`, cały Blob) | `read(id, {signal, onProgress})` i nowe `readHead(id, maxBytes, opts)` |
| Miniatury | `ui/src/thumbnail.ts`: `makeThumbnail()` (tylko obrazy); `RemoteFileStore.upload()` z `thumbnail` → osobny plik z `thumbOf` i `parent` | `makeVideoThumbnail()` (w ramce) i `FileStore.setThumbnail()` dla starych filmów |
| Bundle | Vite 8, jeden wpis `index.html`, `worker.format: "es"`, wtyczka `thirdPartyNotices()` w `ui/vite.config.ts` pisze `THIRD-PARTY-NOTICES.txt` | osobna budowa ramki `ui/vite.preview.config.ts` → `dist/preview/` |
| CSP strony | `crates/node/src/http.rs` (krytyczny): `CSP`, `security_headers()`, COOP/COEP `require-corp`; Tauri: `app/src-tauri/tauri.conf.json` `security.csp` | trasa `/preview/*` z własnymi nagłówkami (§3.2) |
| Pulpit (Tauri) | `crates/bridge` trzyma załączniki w `assets/`; `filesOf(bridge)` = null; `tauribridge.ts` | poza zakresem tego etapu (§11, D4) |
| Zależności | brak three.js, JSZip, fflate, pakietów języków CodeMirror (jest `@codemirror/lang-markdown`, `language`, `view`, `state`) | dochodzą tylko pakiety z §5 |
| Testy przeglądarkowe | Playwright 1.56.1 (poza repo, `PLAYWRIGHT_PATH`), skrypty `scripts/test-*.cjs`; Chromium, Firefox 142, WebKit 26 | `scripts/test-preview.cjs` z zapisem ruchu sieciowego |
| CI | `.github/workflows/ci.yml`: `cargo test/clippy`, `cargo audit`, `cargo deny check` (lista licencji w `deny.toml`), UI: `npm run build`, `vitest` | dochodzi sprawdzanie licencji npm i budowa `crates/preview` |
| Narzędzia do plików testowych | `ffmpeg`, `soffice`, `python3` w systemie | skrypty w `scripts/fixtures/` |

Interfejs jest jeden: `ui/` (katalogu `variants/` nie ma).

## 2. Próba ramki (faza 0, pkt 7)

Próba: `$CLAUDE_JOB_DIR/tmp/probe` (serwer Node z nagłówkami jak `notes-node`: aplikacja z COOP/COEP `require-corp`,
ramka `<iframe sandbox="allow-scripts">` bez `allow-same-origin`, CSP ramki z §3.2). Playwright 1.56.1.

| Sprawdzenie | Chromium 141 | Firefox 142 | WebKit 26 |
|---|---|---|---|
| `self.origin` w ramce | `null` | `null` | `null` |
| moduły JS i `import()` z `/preview/` (CORS `*`) | ✅ | ✅ | ✅ tylko gdy `script-src` wymienia adres serwera wprost (`'self'` w ramce bez pochodzenia nie pasuje) |
| `WebAssembly.instantiate(bajty)` (`'wasm-unsafe-eval'`) | ✅ | ✅ | ✅ |
| bajty `.wasm` od aplikacji przez `postMessage` (transfer) | ✅ | ✅ | ✅ |
| `fetch` (także do własnego serwera) | zablokowany | zablokowany | zablokowany |
| Worker klasyczny z `blob:` | ✅ | ✅ | ❌ (COEP blokuje worker `blob:null`) |
| Worker modułowy z `blob:` | ❌ | ✅ | ❌ |
| Worker z adresu `/preview/…` | ❌ (inne pochodzenie) | ❌ | ❌ |
| WASM w workerze klasycznym | ✅ | ✅ | — |
| WebGL / WebGL2 | ✅ | ❌ w trybie bez okna na tej maszynie (brak GL; to środowisko, nie ramka) | ✅ |
| `OffscreenCanvas` 2D | ✅ | ✅ | ✅ |
| `VideoDecoder` (WebCodecs) | jest | jest | jest |
| transfer `ArrayBuffer` 8 MiB | ✅ (nadawca dostaje bufor o długości 0) | ✅ | ✅ |
| `localStorage`, `indexedDB`, `document.cookie` | `SecurityError` | `SecurityError` | `SecurityError` |
| `parent.document` | `SecurityError` | `SecurityError` | `SecurityError` |
| `top.location = …`, `window.open`, wysłanie formularza | zablokowane | zablokowane | zablokowane |
| obraz z zewnętrznego adresu, `eval`, skrypt wstawiony w `<script>` | zablokowane | zablokowane | zablokowane |
| `<img>` z SVG ze skryptem | skrypt się nie wykonuje | nie wykonuje | nie wykonuje |
| `event.origin` komunikatu z ramki | `"null"` | `"null"` | `"null"` |
| ramka bez COEP albo z `credentialless` pod aplikacją `require-corp` | nie wyświetla się | nie wyświetla się | nie wyświetla się |

Wnioski (wybrany sposób izolacji, bez osobnej domeny):
1. Ramka `sandbox="allow-scripts"` bez `allow-same-origin` z `/preview/index.html`, z COEP `require-corp`.
2. `script-src` ramki wymienia **adres serwera wprost** (`'self' https://host/preview/`). Serwer bierze go z tego samego
   `Host`/`X-Forwarded-Host`/`X-Forwarded-Proto`, którym sprawdza `Origin` (`auth::same_origin`). Odpowiedź z
   `index.html` ramki ma `Cache-Control: no-store`, więc obca wartość `Host` nie trafi do cudzej pamięci podręcznej.
3. `connect-src blob:` (bez żadnego serwera). Pliki `.wasm` ramka dostaje od aplikacji: prosi komunikatem `asset` o ścieżkę z
   `/preview/assets/`, aplikacja sprawdza wzór ścieżki, pobiera ją ze swojego serwera i oddaje bajty (§4.1).
4. Workery tylko **klasyczne z `blob:`**, tworzone przez `spawnWorker()`. Gdy worker się nie uruchomi (WebKit), ta sama
   praca idzie w wątku ramki z limitem czasu. Nie ma bibliotek, które muszą mieć workera.
5. Brak osobnej domeny, brak zmian we wdrożeniu poza trasą `/preview/` w `notes-node`.

## 3. Architektura

```
 aplikacja (dokument główny, ma klucze)                ramka /preview/ (bez pochodzenia, bez sieci, bez kluczy)
 ┌─────────────────────────────────────────────┐       ┌──────────────────────────────────────────────┐
 │ wyzwalacze → openPreview(items, index)       │       │ main.ts: walidacja komunikatów, rejestr      │
 │ okno: pasek, stany, strzałki, fokus          │  pM   │ viewers/*: ładowane na żądanie (import())    │
 │ FileStore.read/readHead (odszyfrowanie)      │ ────▶ │ open {id, name, mime, size, viewer, bytes}   │
 │ detect(bajty, mime, nazwa) → viewer          │ ◀──── │ ready / progress / error {code} / nav /      │
 │ asset: pobiera /preview/assets/*.wasm        │       │ close / download / asset / frame (piksele)   │
 └─────────────────────────────────────────────┘       └──────────────────────────────────────────────┘
```

- Ramka dostaje **tylko** bajty, nazwę, MIME, rozmiar, nazwę motywu i kilka kolorów. Nigdy `fileId`, `vaultId`, klucza
  ani tokenu. `id` w komunikatach to licznik otwarć tego okna, nie id pliku.
- Pasek okna, stany ładowania i błędów rysuje aplikacja. W ramce jest tylko treść i jej własne sterowanie (przybliżanie,
  strony, zakładki arkuszy, warstwy).
- Ramka żyje tak długo jak okno. Przejście do następnego pliku: `dispose` + `open`. Zamknięcie okna usuwa ramkę (cała
  pamięć ramki, WASM i workery znikają z nią). Brak odpowiedzi ramki przez 20 s albo jej błąd → nowa ramka.

### 3.1. Budowanie

- Osobna budowa Vite: `ui/vite.preview.config.ts`, `root: ui/preview/`, `base: "/preview/"`, wynik `ui/dist/preview/`
  (`index.html` + `assets/`). Główny bundle się nie zmienia poza oknem podglądu (cel: ≤ ~15 KB gzip).
- `npm run build` = `wasm` + `tsc` + `vite build` + `vite build -c vite.preview.config.ts` + licencje.
- Dev: `npm run dev` serwuje `ui/dist/preview/` pod `/preview/` z nagłówkami ramki (wtyczka w `vite.config.ts`);
  `npm run preview:watch` przebudowuje ramkę.
- `crates/preview` (`notes-preview`) → `wasm-pack build --target web` → `ui/preview/wasm/` (poza repo, jak `ui/src/wasm`).

### 3.2. Nagłówki `/preview/*` (`crates/node/src/http.rs`, krytyczny — pisze Opus)

```
content-security-policy: sandbox allow-scripts; default-src 'none'; script-src <origin>/preview/ 'wasm-unsafe-eval';
  worker-src blob:; style-src <origin>/preview/ 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src blob: data:;
  connect-src blob:; frame-src 'none'; child-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
cross-origin-embedder-policy: require-corp
cross-origin-resource-policy: cross-origin      (moduły ładowane z pochodzenia null)
access-control-allow-origin: *                   (tylko pliki /preview/*: kod, bez danych)
x-frame-options: SAMEORIGIN, x-dns-prefetch-control: off, referrer-policy: no-referrer,
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()
cache-control: no-store (index.html; CSP zależy od hosta), public, max-age=31536000, immutable (assets/*)
```

Odstępstwa od punktu wyjścia z zadania i dlaczego:
- `script-src` i `style-src` mają adres serwera wprost: WebKit nie dopasowuje `'self'` w ramce bez pochodzenia (§2).
  Tylko ścieżka `/preview/`, nie cały serwer; `'self'` zostaje wyłącznie wtedy, gdy nagłówki nie podają hosta.
- `sandbox allow-scripts` w samej CSP: strona ramki otwarta bezpośrednio (nie w `<iframe sandbox>`) też ma pochodzenie
  `null` (sprawdzone w Chromium, Firefoksie i WebKicie).
- `font-src` bez `'self'`: fonty ramki są wbudowane w CSS jako `data:` albo pochodzą z pliku (FontFace z bajtów).
- `child-src blob:` dla starszych przeglądarek, które czytają workery z `child-src`.
- `frame-ancestors 'self'`: tylko aplikacja może osadzić ramkę.
- `connect-src blob:` zamiast `'none'` (D9): biblioteki emscripten (web-ifc, rhino3dm, draco, occt-import-js,
  libheif-js) i dxf-viewer ładują swoje dane przez `fetch`. Ramka robi `blob:` z bajtów, które dostała od aplikacji
  (`asset`), i podaje taki adres. `blob:` sięga tylko danych utworzonych w tej ramce; żaden serwer (także własny) nie
  jest osiągalny. Sprawdzone w Chromium, Firefoksie i WebKicie: `fetch(blob:)` i XHR działają, `fetch` do serwera i na
  zewnątrz zablokowany.
- `style-src 'unsafe-inline'`: biblioteki (docx-preview, pptx-browser, dxf-viewer) wstawiają style. Styl nie wykona
  kodu, a bez sieci nie może nic wysłać (obrazy tylko `blob:`/`data:`).

## 4. Kontrakty

### 4.1. Protokół ramki (`ui/src/preview/protocol.ts`, wspólny dla obu stron)

Każdy komunikat: `{ v: 1, type, ... }`. Odbiorca sprawdza: aplikacja — `event.source === frame.contentWindow`
(pochodzenie ramki to `"null"`, więc tylko źródło się liczy); ramka — `event.source === window.parent` i
`event.origin === location.origin` (adres serwera). Aplikacja wysyła z `targetOrigin: "*"` (ramka nie ma pochodzenia,
innej wartości nie da się podać; adresatem jest konkretne okno ramki). Ramka wysyła z `targetOrigin = location.origin`
(`ancestorOrigins`/adres serwera). Komunikat o złym kształcie jest odrzucany bez odpowiedzi. Limity: napisy ≤ 512 znaków,
`bytes` ≤ 128 MiB, `asset.path` wg wzoru `^assets/[A-Za-z0-9._-]{1,128}$`.

Aplikacja → ramka:

| type | pola | znaczenie |
|---|---|---|
| `init` | `theme: "dark"\|"light"`, `colors: {bg, panel, text, muted, accent, border}` (`#rrggbb`), `lang: "pl"` | po `ready`; i przy zmianie motywu |
| `open` | `id: number`, `name`, `mime`, `size`, `viewer: ViewerId`, `bytes: ArrayBuffer` (transfer), `opts?: {label?: "first-frame"}` | pokaż plik; poprzedni zostaje zamknięty |
| `command` | `id`, `name: "zoom-in"\|"zoom-out"\|"zoom-reset"\|"fit"` | przyciski i klawisze aplikacji |
| `frame` | `id`, `name`, `mime`, `bytes` | wyciągnij pierwszą klatkę wideo (miniatura), bez rysowania |
| `asset` | `path`, `bytes: ArrayBuffer \| null` | odpowiedź na prośbę o plik `.wasm`; `null` = nie ma |
| `dispose` | — | zamknij bieżący plik, zwolnij pamięć |

Ramka → aplikacja:

| type | pola | znaczenie |
|---|---|---|
| `ready` | — | ramka wczytana, czeka na `init` |
| `progress` | `id`, `phase: "preparing"\|"shown"`, `status?: string` (np. „Strona 2 z 9”, dla `aria-live`) | |
| `error` | `id`, `code: ErrorCode` | `"unsupported" \| "corrupt" \| "too-large" \| "codec" \| "timeout" \| "internal"` |
| `nav` | `dir: -1 \| 1` | strzałka po ostatniej stronie/slajdzie: następny plik |
| `close` | — | Esc (albo spacja, gdy okno otwarto spacją) wewnątrz ramki |
| `download` | — | Ctrl+S w ramce |
| `asset` | `path` | prośba o plik `.wasm` z `/preview/assets/` |
| `frame` | `id`, `width`, `height`, `pixels: ArrayBuffer` (RGBA, ≤ 480 px dłuższy bok), `durationMs?` albo `error` | wynik `frame` |

Aplikacja nie parsuje obrazów z ramki: miniaturę koduje do JPEG/WebP sama z surowych pikseli (`width*height*4 ===
pixels.byteLength`). Teksty błędów są po stronie aplikacji (§6); kody, nie komunikaty bibliotek.

### 4.2. Rejestr i wykrywanie (`ui/src/preview/formats.ts`, wspólny)

```ts
export type ViewerId = "image" | "tiff" | "psd" | "heic" | "text" | "csv" | "audio" | "font" | "zip" | "video" | "pdf"
  | "docx" | "doc" | "sheet" | "pptx" | "ppt" | "model3d" | "step" | "pointcloud" | "cad" | "none";
export interface FormatInfo { viewer: ViewerId; maxSize: number; label: string }        // label: „Obraz”, „PDF”…
/** Z nazwy i MIME, bez bajtów: czy w ogóle próbować i jaki limit. */
export function guess(mime: string, name: string): FormatInfo;
/** Z pierwszych bajtów (≥ 64 KiB albo cały plik), MIME i nazwy. Bajty wygrywają z rozszerzeniem. */
export function detect(head: Uint8Array, mime: string, name: string): ViewerId;
```

Magiczne bajty: `%PDF` → pdf; `PK\x03\x04` → po nazwie wpisów z katalogu centralnego: `word/` → docx, `xl/` → sheet,
`ppt/` → pptx, `mimetype` `…spreadsheet` → sheet, inaczej zip; `D0 CF 11 E0` (OLE2) → po strumieniach: `WordDocument`
→ doc, `PowerPoint Document` → ppt, `Workbook`/`Book` → sheet, inaczej none; `AC10..` → cad (dwg); `1A 45 DF A3` →
video (mkv/webm); `RIFF....AVI ` → video; `RIFF....WAVE` → audio; `....ftyp` → video lub audio (`M4A `) lub heic
(`heic`/`heix`/`mif1`); `II*\0`/`MM\0*` → tiff; `8BPS` → psd; `\x89PNG`, `\xFF\xD8\xFF`, `GIF8`, `RIFF....WEBP`, `BM`
→ image; `wOFF`/`wOF2`/`\0\1\0\0`/`OTTO`/`true` → font; `glTF` → model3d; `ply` + `vertex` bez `face` → pointcloud, z
`face` → model3d; `# .PCD`/`VERSION .7` → pointcloud; `LASF` → pointcloud; `ISO-10303-21` → step; `solid `/binarne STL
→ model3d; `0\nSECTION` → cad (dxf); `ID3`/`\xFF\xFB`/`OggS`/`fLaC` → audio. Tekst (UTF-8 bez bajtów 0 w pierwszych
8 KiB) → text (csv/tsv po rozszerzeniu → csv). HTML i SVG jako tekst/obraz, nigdy renderowane jako dokument.
Rozszerzenie decyduje tylko, gdy bajty nic nie mówią (OBJ, 3DS, FBX, 3MF, IGES, BREP, OFF itd.).

```ts
// ramka: ui/preview/src/viewers/index.ts
export interface ViewerContext {
  host: HTMLElement; name: string; mime: string; size: number; signal: AbortSignal;
  theme: Theme; asset(path: string): Promise<ArrayBuffer>; spawnWorker(source: string): Worker | null;
  status(text: string): void;           // aria-live w aplikacji (progress.status)
  nav(dir: -1 | 1): void;               // koniec stron: następny plik
}
export interface Viewer { open(bytes: ArrayBuffer, ctx: ViewerContext): Promise<void>; resize?(): void;
  /** true, gdy klawisz obsłużony (strona/slajd/przybliżenie). */ key?(e: KeyboardEvent): boolean;
  command?(name: Command): void; dispose(): void }
export interface ViewerModule { id: ViewerId; load(): Promise<Viewer> }   // import() przy pierwszym pliku
```

### 4.3. Odczyt z postępem i częściowe odszyfrowanie (`ui/src/filestore.ts`, `ui/src/remotefiles.ts`)

```ts
export interface ReadOptions { signal?: AbortSignal; onProgress?(done: number, total: number): void }
interface FileStore {
  read(id: string, options?: ReadOptions): Promise<Blob>;                 // istniejąca, dochodzą opcje
  /** Najwyżej `maxBytes` tekstu jawnego od początku pliku (całe porcje po 1 MiB; ostatnia może być krótsza).
   * Pobieranie jest przerywane po ostatniej potrzebnej porcji (AbortController). Każda porcja jest uwierzytelniona
   * secretstreamem, więc początek jest prawdziwy, choć reszty nie sprawdzono. `complete: true`, gdy to cały plik. */
  readHead(id: string, maxBytes: number, options?: ReadOptions): Promise<{ blob: Blob; complete: boolean }>;
  /** Miniatura dla istniejącego pliku (stare filmy): osobny plik z `thumbOf` + `parent`, potem PATCH koperty oryginału
   * z `thumb`. Rola edytor+; widz dostaje błąd, który okno podglądu pomija po cichu. */
  setThumbnail(id: string, thumb: { blob: Blob; width: number; height: number; durationMs?: number }): Promise<void>;
}
```

`filecrypto.ts` się nie zmienia (poza polem `duration?: number` w `FileMeta`, ms, opcjonalnym; stare klienty je
zachowują, bo przy zmianie nazwy przepisują kopertę `{...meta, name}`). Implementacja `readHead`: `openFile` jest
generatorem; po zebraniu `ceil(maxBytes / PLAIN_CHUNK)` porcji pętla się kończy, a `AbortController` przerywa `fetch`.

### 4.4. Miniatura wideo przy wysyłaniu (`ui/src/thumbnail.ts`, `ui/src/preview/framejob.ts`)

```ts
/** Pierwsza klatka filmu jako miniatura (≤ 480 px, JPEG/WebP), wyciągnięta w ukrytej ramce podglądu. null, gdy się nie da. */
export function makeVideoThumbnail(file: File): Promise<Thumbnail & { durationMs?: number } | null>;
/** Obraz albo film: to, co wysyłanie przekazuje w `UploadOptions.thumbnail`. */
export function thumbnailFor(file: File): Promise<Thumbnail | null>;
```

Do ramki idzie najwyżej 16 MiB początku pliku (mp4/mov z `moov` na końcu: cały plik, gdy ≤ 16 MiB, inaczej brak
miniatury). Limit czasu 5 s, wymiary dekodowania ≤ 8192 × 8192.

### 4.5. `crates/preview` (`notes-preview`, Rust → WASM, `wasm-bindgen`)

```rust
pub const MAX_INPUT: usize = 64 << 20;
pub fn dwg_to_dxf(bytes: &[u8]) -> Result<Vec<u8>, PreviewError>;            // acadrust: DwgReader → DxfWriter
pub struct Keyframe { pub codec: String, pub description: Option<Vec<u8>>, pub width: u32, pub height: u32,
                      pub data: Vec<u8>, pub duration_ms: Option<u64> }
pub fn video_first_keyframe(bytes: &[u8]) -> Result<Keyframe, PreviewError>; // MKV/WebM (EBML) i AVI (RIFF)
pub struct DocModel { pub paragraphs: Vec<Paragraph> }                        // Paragraph { text, kind: Normal|Cell|PageBreak }
pub fn doc_text(bytes: &[u8]) -> Result<DocModel, PreviewError>;             // .doc etap 1 (MS-CFB, MS-DOC)
pub struct Slide { pub title: Option<String>, pub texts: Vec<String>, pub images: Vec<u32> }
pub struct Picture { pub mime: &'static str, pub data: Vec<u8> }
pub fn ppt_slides(bytes: &[u8]) -> Result<(Vec<Slide>, Vec<Picture>), PreviewError>; // .ppt (MS-PPT)
pub enum PreviewError { TooLarge, Corrupt, Unsupported }                       // → ErrorCode w ramce
```

Wspólne limity: wejście ≤ 64 MiB; ≤ 100 000 elementów/rekordów; głębokość ≤ 32; tekst ≤ 16 MiB; ≤ 500 slajdów;
obraz ≤ 32 MiB; budżet pracy (licznik kroków) zamiast zegara. Bez `unwrap`/`expect`/indeksowania bez sprawdzenia na
danych z pliku, `checked_*` na przesunięciach. `dwg_to_dxf` łapie panikę acadrust (`catch_unwind` natywnie; w WASM
panika kończy wywołanie błędem, który ramka zamienia na `corrupt`, a moduł jest wczytywany na nowo). Cele `cargo-fuzz`:
`fuzz_dwg`, `fuzz_mkv`, `fuzz_avi`, `fuzz_doc`, `fuzz_ppt`.

JS: wiązania zwracają `Uint8Array`/JSON (`doc_text_json`, `ppt_slides_json` + `ppt_picture(i)`), `video_first_keyframe`
zwraca obiekt z polami jak wyżej.

## 5. Formaty, biblioteki, licencje, limity

Rozmiar kawałka (gzip) uzupełniam po zbudowaniu każdej fali (§10).

| Format | Przeglądarka (ViewerId) | Biblioteka, wersja | Licencja | Limit pliku |
|---|---|---|---|---|
| jpg, png, gif, webp, avif, bmp, svg (jako `<img>`) | image | natywnie | — | 50 MiB, ≤ 100 Mpx (wymiary z nagłówka przed dekodowaniem) |
| TIFF | tiff | utif 3.1.0 | MIT | 50 MiB, ≤ 100 Mpx |
| PSD | psd | ag-psd 34.2.1 | MIT | 100 MiB, ≤ 100 Mpx (tylko obraz złożony) |
| HEIC/HEIF | heic | natywnie w Safari; libheif-js 1.23.5 w `vendor/lgpl/` | LGPL-3.0 | 30 MiB |
| tekst, kod, JSON, logi, Markdown, HTML (jako tekst) | text | CodeMirror 6 (`@codemirror/*` w projekcie) + `@codemirror/language-data` z kawałkami języków | MIT | 10 MiB (pokazane pierwsze 2 MiB) |
| CSV, TSV | csv | własny parser (RFC 4180) | — | 20 MiB, ≤ 100 000 wierszy |
| mp3, ogg, wav, flac, m4a | audio | natywnie `<audio>` | — | 100 MiB |
| ttf, otf, woff, woff2 | font | opentype.js 2.0.0 (nazwa kroju); próbka przez `FontFace` z bajtów | MIT | 20 MiB |
| zip | zip | własny odczyt katalogu centralnego (bez rozpakowywania); fflate 0.8.3 tylko dla OOXML | MIT | 100 MiB, ≤ 10 000 wpisów |
| wideo mp4/webm/mov | video | natywnie `<video>` + canvas; miniatura z serwera | — | 16 MiB odszyfrowane |
| wideo mkv/avi | video | `crates/preview` + WebCodecs | własny | 16 MiB odszyfrowane |
| PDF | pdf | pdfjs-dist 6.5.438 | Apache-2.0 | 100 MiB, ≤ 2000 stron |
| DOCX | docx | docx-preview 0.4.1 (+ jszip 3.10.2, wariant MIT) | Apache-2.0 | 30 MiB, ≤ 300 MiB po rozpakowaniu |
| .doc | doc | `crates/preview` (cfb 0.16) | własny + MIT | 30 MiB |
| XLSX, XLS, XLSB, ODS | sheet | SheetJS CE 0.20.3 (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) | Apache-2.0 | 30 MiB, pokazane ≤ 2000 wierszy × 200 kolumn na arkusz |
| PPTX | pptx | pptx-browser 4.1.5 | MIT | 50 MiB, ≤ 300 slajdów |
| .ppt | ppt | `crates/preview` | własny | 50 MiB |
| obj, stl, ply, gltf/glb, fbx, 3ds, 3mf, amf, dae, wrl, off, 3dm | model3d | online-3d-viewer 0.18.0 + three 0.187.0 (+ rhino3dm 8.35.0, draco3d 1.5.9) | MIT, Apache-2.0 | 100 MiB |
| IFC | model3d | web-ifc 0.0.79 | MPL-2.0 (pliki bez zmian) | 100 MiB |
| STEP, IGES, BREP | step | occt-import-js 0.0.23 w `vendor/lgpl/` | LGPL-2.1 | 50 MiB |
| LAS/LAZ (≤ 1.3), PCD, PLY (punkty) | pointcloud | @loaders.gl/las, pcd, ply 4.5.4 + three | MIT | 100 MiB, ≤ 5 mln punktów (próbkowanie) |
| DXF | cad | dxf-viewer 1.0.51 (+ three) | MPL-2.0 (pliki bez zmian) | 50 MiB |
| DWG (R13–R2018) | cad | acadrust 0.6.8 w `crates/preview` → DXF → dxf-viewer | MPL-2.0 (crate bez zmian) | 30 MiB |
| exe, rar, 7z, iso, pozostałe | none | karta „Pobierz” | — | — |

Wybory z zadania §2:
- **PPTX: pptx-browser.** Pagus nie istnieje w npm ani pod znanym repozytorium (sprawdzone 2026-11-17), więc jedyną
  biblioteką z listy jest pptx-browser (MIT, bez zależności, rysuje na canvasie). Jakość sprawdzam na plikach z
  `fixtures/` w fali 4; jeśli zawiedzie, PPTX dostaje kartę „Pobierz” (zapis w §11).
- **Arkusze: SheetJS CE.** Daje wartości tak, jak je widać w Excelu (formaty liczb i dat, `w`), scalenia komórek i
  nazwy arkuszy; czyta XLSX, XLS, XLSB, ODS i CSV. calamine zwraca same wartości bez formatów, więc trzeba by napisać
  formatowanie od nowa. Wersja z cdn.sheetjs.com (npm ma starą, z błędami bezpieczeństwa), wpisana w `package.json`
  jako adres tarballa z sumą w `package-lock.json`.
- **DWG: acadrust.** Próba 2026-11-17: `acadrust 0.6.8` z `default-features = false` kompiluje się do
  `wasm32-unknown-unknown`, `DwgWriter` → `DwgReader` → `DxfWriter` daje poprawny DXF (AC1032), obcięte i zmienione
  pliki dają `Err`, bez paniki. WASM bez optymalizacji: 7,7 MB (2,0 MB gzip); kawałek ładowany tylko dla DWG.

## 6. Okno podglądu (aplikacja)

Pliki: `ui/src/preview/window.ts` (okno), `ui/src/preview/items.ts` (lista plików do przeglądania z `FileInfo`),
`ui/src/preview/frame.ts` (ramka i protokół po stronie aplikacji), `ui/src/preview/triggers.ts` (podpięcia),
`ui/src/preview/preview.css`.

```ts
export interface PreviewItem { key: string; name: string; mime: string; size: number; thumb: string | null;
  read(o: ReadOptions): Promise<Blob>; readHead(max: number, o: ReadOptions): Promise<{ blob: Blob; complete: boolean }>;
  readThumb(): Promise<Blob> | null; saveThumb(t: VideoThumb): Promise<void>; download(): void; open(): void }
export function openPreview(items: PreviewItem[], index: number, opts?: { bySpace?: boolean }): () => void;
export function itemsOf(store: FileStore, infos: FileInfo[]): PreviewItem[];
```

Elementy i stany:
- **Pasek** (`.podglad-pasek`): ikona typu (lucide), nazwa (ucięta w środku: `początek…koniec.ext`, pełna w `title`),
  „PDF · 2,4 MB”, przyciski Pobierz, Otwórz, Zamknij; ‹ › z licznikiem „3 z 12” (ukryte przy jednym pliku).
- **Treść** (`.podglad-tresc`): ramka albo stan.
- **Stany** (`.podglad-stan`, `role="status"`, `aria-live="polite"`):
  - ładowanie: „Pobieranie i odszyfrowywanie… 3,1 z 12 MB” + pasek postępu; potem „Przygotowuję podgląd…”;
  - błąd: „Nie można wyświetlić tego pliku” + powód z kodu (`corrupt` → „Plik jest uszkodzony albo ma nieznany
    format.”, `codec` → „Ta przeglądarka nie odtwarza tego kodeka.”, `timeout` → „Przygotowanie podglądu trwało za
    długo.”, `internal` → „Coś poszło nie tak w podglądzie.”) + „Pobierz”;
  - nieobsługiwany (karta): duża ikona, nazwa, typ, rozmiar, „Tego rodzaju pliku nie da się podejrzeć.”, Pobierz/Otwórz;
  - brak sieci: „Plik jest niedostępny bez połączenia” (jak PLIKI §6) + „Spróbuj ponownie”;
  - za duży: karta z „Ten plik jest za duży na podgląd (limit 30 MB).”;
  - wideo bez klatki: karta z ikoną filmu, „Pierwszej klatki nie da się pokazać.” + Otwórz/Pobierz.
- **Wideo**: obraz pierwszej klatki w ramce, etykieta „Pierwsza klatka · 1:24” w rogu (rysuje ramka), „Otwórz” w pasku.
- **Wąskie okno (< 700 px)**: cały ekran, w pasku tylko nazwa, Zamknij i „⋯” (menu: Pobierz, Otwórz, Poprzedni, Następny);
  przesunięcie palcem w poziomie (≥ 60 px, przewaga poziomu) = poprzedni/następny plik (gest łapie pasek i stan, a w
  ramce ramka zgłasza `nav` z własnego gestu, gdy treść nie jest przybliżona).
- **Klawiatura**: Esc zamyka; ←/→ poprzedni/następny (gdy ramka ma fokus, najpierw strona/slajd, potem `nav`); spacja
  zamyka okno otwarte spacją; `+`/`−`/`0` przybliżanie (`command`); Ctrl+S pobiera; Tab krąży w oknie (pasek ↔ ramka).
- **Dostępność**: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` = nazwa pliku, fokus na „Zamknij” po
  otwarciu, powrót fokusu na element, z którego otwarto; kontrast AA; widoczny `:focus-visible`.
- **Animacje**: pojawienie się 120 ms (przezroczystość), wyłączone przy `prefers-reduced-motion`.

Tokeny (`ui/src/preview/preview.css`, zdefiniowane przez zmienne motywu z `tokens.css`):

```css
--podglad-tlo: var(--overlay);            /* przyciemnienie pod oknem */
--podglad-okno: var(--bg);                /* tło okna i ramki */
--podglad-pasek: var(--panel);            /* pasek u góry */
--podglad-krawedz: var(--border);
--podglad-tekst: var(--text);
--podglad-opis: var(--muted);
--podglad-akcent: var(--accent);
--podglad-karta: var(--editor-bg);        /* karta „Pobierz”, stany */
--podglad-postep: var(--accent);
--podglad-blad: var(--danger);
--podglad-promien: var(--radius-panel);
--podglad-czas: 120ms;
```

Ramka dostaje w `init` kolory: `bg = --bg`, `panel = --panel`, `text`, `muted`, `accent`, `border` (odczytane przez
`getComputedStyle` w chwili otwarcia; motyw systemowy rozstrzygnięty do `dark`/`light`).

Nowe napisy (wszystkie): Podgląd, Pobierz, Otwórz, Zamknij, Poprzedni plik, Następny plik, „{n} z {m}”, Więcej,
Pobieranie i odszyfrowywanie…, „{a} z {b} MB”, Przygotowuję podgląd…, Nie można wyświetlić tego pliku, Plik jest
uszkodzony albo ma nieznany format., Ta przeglądarka nie odtwarza tego kodeka., Przygotowanie podglądu trwało za długo.,
Coś poszło nie tak w podglądzie., Tego rodzaju pliku nie da się podejrzeć., Ten plik jest za duży na podgląd (limit {x}).,
Plik jest niedostępny bez połączenia, Spróbuj ponownie, Pierwsza klatka, Pierwszej klatki nie da się pokazać.,
Podgląd pliku (paleta), W tej notatce nie ma plików., Przybliż, Oddal, 100%, Dopasuj, Strona {n} z {m},
Slajd {n} z {m}, Arkusz, Zawijaj wiersze, Wyśrodkuj, Siatka, Kolor wg wysokości, Kolor RGB, Warstwy,
„{n} plików, {rozmiar} po rozpakowaniu”, Zażółć gęślą jaźń (próbka fontu), Wczytuję moduł podglądu….

## 7. Wyzwalacze

| Miejsce | Dwuklik | Spacja | Menu kontekstowe | Inne |
|---|---|---|---|---|
| „Pliki” (`filesview.ts`) | wiersz → podgląd | wiersz z fokusem → podgląd | nowe menu wiersza: Podgląd, Pobierz, Wstaw do notatki, Zmień nazwę, Użycia, Do kosza | przycisk „Podgląd”; kolejność = lista po filtrach |
| Drzewo, plik w folderze (`explorer.ts`) | klik/Enter → podgląd (zamiast `openFolderFile`) | wiersz z fokusem | „Podgląd” na początku `fileMenu()` | kolejność = pliki tego folderu |
| Okno folderu plików (`filefolders-view.ts`) | → podgląd | — | — | |
| Osadzenie w podglądzie na żywo (`FileWidget`) | → podgląd | — | Podgląd, Otwórz, Pobierz | kolejność = osadzenia notatki |
| Osadzenie w widoku czytania | → podgląd | — | Podgląd, Otwórz, Pobierz | jw. |
| Paleta poleceń | — | — | — | „Podgląd pliku”: osadzenie pod kursorem albo pierwsze w notatce |

Podwójny prawy przycisk: **pomijam**. Pierwsze `contextmenu` musi od razu otworzyć menu (inaczej menu spóźnia się o
400 ms za każdym razem), więc drugie zawsze zamknęłoby widoczne już menu — to jest miganie, którego zadanie zabrania.

## 8. Zadania dla agentów (fale)

Każde zadanie: worktree od `buduj/podglad`, ≤ ~300 linii bez testów, testy najpierw. `node_modules` i `ui/src/wasm`
podlinkowane z głównej kopii; nowe pakiety instaluje Opus przed falą (agent nie uruchamia `npm install`).

| Fala | Zadanie | Pliki | Zależy od |
|---|---|---|---|
| 1 | F1 protokół + walidatory | `ui/src/preview/protocol.ts` (+test) | — |
| 1 | F2 wykrywanie formatów | `ui/src/preview/formats.ts` (+test) | — |
| 1 | F3 szkielet ramki: `preview/index.html`, `vite.preview.config.ts`, `main.ts` ramki, rejestr, `spawnWorker`, motyw, przeglądarka obrazów | `ui/preview/**`, `ui/vite.preview.config.ts`, `ui/package.json` (skrypty) | F1, F2 |
| 1 | F4 okno w aplikacji (pasek, stany, klawiatura, fokus, strzałki, wąskie okno) | `ui/src/preview/window.ts`, `frame.ts`, `items.ts`, `preview.css` (+testy) | F1, F2 |
| 1 | F5 wyzwalacze + paleta | `filesview.ts`, `explorer.ts`, `filefolders-view.ts`, `attachments.ts`, `main.ts`, `preview/triggers.ts` | F4 |
| 1 | F6 pliki testowe i sejf przykładowy | `scripts/fixtures/*`, `fixtures/**`, `ui/src/demofiles.ts` (MemoryFileStore w `?demo=1`) | — |
| 1 | O1 (Opus) trasa `/preview/` w `notes-node` + test nagłówków; `read` z postępem, `readHead`, `setThumbnail` | `http.rs`, `run.rs`, `filestore.ts`, `remotefiles.ts` | — |
| 2 | proste formaty: tekst/kod, CSV, audio, fonty, ZIP, TIFF, PSD | `ui/preview/src/viewers/*` | F3 |
| 3 | wideo: klatka mp4/webm/mov w ramce (`frame`), miniatura przy wysyłaniu, stare filmy | `viewers/video.ts`, `thumbnail.ts`, `framejob.ts`, wysyłanie w `filesview.ts`/`folderfiles.ts`/`attachments.ts` | F3, O1 |
| 4 | PDF, DOCX, arkusze, PPTX | `viewers/pdf.ts`, `docx.ts`, `sheet.ts`, `pptx.ts` | F3 |
| 5 | 3D (O3DV), chmury punktów, DXF | `viewers/model3d.ts`, `pointcloud.ts`, `cad.ts` | F3 |
| 6 | LGPL: occt-import-js, libheif-js | `vendor/lgpl/**`, `viewers/step.ts`, `heic.ts` | F3 |
| 7 | `crates/preview`: DWG→DXF, MKV/AVI, `.doc`, `.ppt`, fuzz | `crates/preview/**`, `viewers/doc.ts`, `ppt.ts`, ścieżka mkv/avi w `video.ts`, `cad.ts` | F3, fala 3, 5 |
| 8 | licencje: `THIRD-PARTY-NOTICES.txt` dla ramki i crate'ów, „O programie → Licencje”, CI | `vite.config.ts`, `vite.preview.config.ts`, `settings.ts`, `ci.yml`, `scripts/licenses.mjs` | wszystko |

## 9. Testy akceptacyjne

1. Każdy plik sejfu przykładowego (§3.1 zadania, `fixtures/README.md`) otwiera się we właściwej przeglądarce albo
   kończy kartą/stanem błędu; żadnego pustego okna; zero błędów w konsoli aplikacji (`scripts/test-preview.cjs`).
2. Izolacja: SVG ze skryptem nie wykonuje skryptu; DOCX z obrazem z zewnętrznego adresu nie wysyła żądania (ruch ramki
   w Playwright: tylko `/preview/*` z własnego serwera, a serwer „zewnętrzny” na innym porcie nie dostaje nic); kod w
   ramce dostaje `SecurityError` dla `indexedDB`, `localStorage`, `parent.document`; nawigacja `top` i `window.open`
   zablokowane; HTML pokazany jako tekst.
3. Złe dane: obcięte i uszkodzone pliki każdego formatu, bomba zip (OOXML z 10 GB po rozpakowaniu), PNG 50 000 × 50 000,
   losowe bajty jako DWG/MKV/`.doc`/`.ppt` → stan błędu, aplikacja działa dalej; `cargo fuzz` ≥ 10 min na cel.
4. Wideo: po wysłaniu MP4 jest miniatura, a podgląd pobiera tylko ją (brak żądania `…/content` oryginału); stary film
   bez miniatury: najwyżej 16 MiB (licznik bajtów odpowiedzi); MP4 z `moov` na końcu > 16 MiB → karta; MKV H.264 i
   VP9 → klatka; kodek nieobsługiwany → karta wideo.
5. Pamięć: 50 × otwórz/zamknij różne pliki → 0 żywych URL Blobów w aplikacji, 0 ramek, `performance.memory`/
   `measureUserAgentSpecificMemory` wraca do poziomu wyjściowego (± 20 %).
6. Rozmiar: główny bundle + ≤ 15 KB gzip; tabela kawałków ramki w raporcie.
7. Obsługa: wszystkie skróty z §6 samą klawiaturą; nazwa okna i stany w drzewie dostępności; oba motywy; 375 px.
8. Licencje: `THIRD-PARTY-NOTICES.txt` ma każdy pakiet ramki i crate; sprawdzanie licencji odrzuca pakiet GPL (próba na
   gałęzi próbnej).
9. Granice: plik 0 B, 1 MiB, 1 MiB + 1 B (granica porcji, `readHead`), `.pdf` z ZIP-em w środku, polska i bardzo długa
   nazwa, plik w chronionym projekcie, plik w koszu, brak sieci w trakcie pobierania, zamknięcie w trakcie odszyfrowania
   (fetch przerwany), szybkie strzałki (poprzedni odczyt przerwany, ramka pokazuje tylko ostatni), dwa okna aplikacji.
10. Pełne CI: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo check -p notes-core --target
    wasm32-unknown-unknown`, `cargo deny check`, `cd ui && npm run build && npx vitest run`.

## 9a. Wyniki testów końcowych (2026-11-18)

- `scripts/test-preview.cjs` na `notes-node` (Chromium z Playwright): 71 z 71 plików sejfu przykładowego kończy się
  zgodnie z oczekiwaniem (ramka, karta albo błąd), 0 żądań ramki poza `/preview/` i `blob:`, 0 trafień w serwer-pułapkę
  (także DOCX z obrazem z zewnętrznego adresu), 0 alertów (SVG ze skryptem), 0 ramek po zamknięciu.
- Izolacja w prawdziwej ramce: pochodzenie `null`; IndexedDB, `localStorage`, ciasteczka, `parent.document` i nawigacja
  `top` → `SecurityError`; `window.open` → `null`; `fetch` do serwera i na zewnątrz → zablokowany.
- Pamięć: 50 otwarć i zamknięć różnych plików → 0 żywych URL-i Blobów, 0 ramek, sterta 26 MB → 26 MB.
- Wideo: film z miniaturą z wysyłania pobiera tylko miniaturę (1 żądanie treści); stary film 29 MB bez miniatury →
  karta, pobrane 20–24 MiB (D12).
- Firefox (WebCodecs): H.264 w MKV i AVI → pierwsza klatka; Chromium z Playwright nie ma H.264/AAC → karta wideo / błąd
  kodeka (zgodnie z §6).
- Fuzzing (`cargo +nightly fuzz`, po 10 min, ziarna z `fixtures/preview`): `fuzz_mkv` 62,3 mln przebiegów, `fuzz_avi`
  3,5 mln, `fuzz_doc` 3,4 mln, `fuzz_ppt` 1,0 mln — bez awarii. `fuzz_dwg` znalazł panikę w acadrust (przepełnienie
  przesunięcia w `handle_reader.rs:101`); `dwg_to_dxf` łapie ją (`catch_unwind`, test regresji z tym plikiem), cel fuzz
  sprawdza teraz, że żadna panika nie wychodzi poza `dwg_to_dxf`: 174 tys. przebiegów w 10 min bez awarii.
- CI lokalnie: `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo check -p notes-core --target
  wasm32-unknown-unknown`, `npm run build`, `npx vitest run` (2127 testów), sprawdzanie licencji npm — przechodzą.
  `cargo deny check`: licencje i źródła przechodzą; `advisories` i `bans` zgłaszają stare sprawy innych crate'ów
  (zależności po ścieżce bez wersji, nieutrzymywane `paste`/`smallstr`/`zvariant`, SQLite w `libsqlite3-sys` < 0.39).

## 10. Rozmiary (2026-11-18)

Główna aplikacja (`vite build`, wszystkie pliki JS gzip -9): przed podglądem 747 354 B, po 758 831 B — **+11,2 KB**
JS i +0,9 KB CSS (cel ~15 KB). Reszta jest w budowie ramki `dist/preview/`, ładowanej dopiero przy pierwszym pliku danego
typu. Największe kawałki ramki (gzip -9):

| Kawałek | gzip | Kiedy |
|---|---|---|
| `notes_preview_dwg_bg.wasm` (acadrust) | 1720 KB | DWG |
| `web-ifc.wasm` + `web-ifc-api.js` | 592 + 376 KB | IFC |
| `pdf.js` + worker | 535 + 372 KB | PDF |
| `libheif.wasm` + `libheif.js` (LGPL) | 471 + 28 KB | HEIC poza Safari |
| `model3d` (Online3DViewer + three 0.176) | 236 KB | modele 3D |
| `cad` (dxf-viewer + three) + font Roboto | 189 + 84 KB | DXF, DWG |
| `three.module` (0.186, wspólny) | 128 KB | chmury punktów, STEP |
| `sheet` (SheetJS) | 118 KB | arkusze |
| `psd` (ag-psd) | 102 KB | PSD |
| `text` (CodeMirror + language-data; języki osobno po 1–6 KB) | 89 KB | tekst, kod |
| `notes_preview_bg.wasm` (bez DWG) | 86 KB | MKV/AVI, `.doc`, `.ppt` |
| `pointcloud` (loaders.gl) + laz-rs | 80 + 47 KB | LAS, PCD, PLY |
| `font` (opentype.js) | 66 KB | fonty |
| `docx` (docx-preview + jszip) | 48 KB | DOCX |
| `pptx` (pptx-browser) | 46 KB | PPTX |
| `tiff` (UTIF + pako) | 29 KB | TIFF |
| szkielet ramki (`index` + `image`/`still`) | ~8 KB | zawsze |
| dane pdf.js (cmapy, fonty standardowe, ICC) | 169 plików, 1,1 MB | tylko gdy PDF ich potrzebuje |

## 11. Decyzje podczas implementacji

- D1 (2026-11-17) Gałąź `buduj/podglad` wychodzi z `funkcje/dyktowanie` (`a5abc13`), nie z `main`: tam są pliki w
  folderach (`folderfiles.ts`), pod które podpinamy podgląd, i zmiany `http.rs`. Gdy `funkcje/dyktowanie` trafi do
  `main`, różnica gałęzi to sam podgląd; inaczej `git rebase --onto main funkcje/dyktowanie buduj/podglad`.
- D2 Workery tylko klasyczne z `blob:`; bez workera ta sama praca w wątku ramki (WebKit, §2).
- D3 `.wasm` i inne pliki binarne ramki idą przez aplikację (`asset`), żeby `connect-src` ramki zostało `'none'`.
- D4 Pulpit (Tauri) bez okna podglądu w tym etapie: pulpit nie ma `FileStore` (pliki tylko w `assets/`), CSP Tauri
  jest jedna dla wszystkich stron, a na tej maszynie nie ma WebKitGTK, żeby sprawdzić ramkę. Pulpit działa jak dziś.
- D5 Nazwa pliku licencji zostaje `THIRD-PARTY-NOTICES.txt` (już pokazywana w Ustawienia → O programie).
- D6 Podwójny prawy przycisk pominięty (§7).
- D7 `id` w protokole to numer otwarcia w oknie, nie `fileId`.
- D8 ZIP: własny odczyt katalogu centralnego (`zipindex.ts`) zamiast fflate — lista bez rozpakowywania, pełna kontrola
  limitów; `guardZip` sprawdza deklarowane rozmiary przed każdą biblioteką Office (bomba zip → „za duży”).
- D9 `connect-src blob:` w ramce (§3.2).
- D10 Linki w dokumentach nie nawigują ramki: `main.ts` ramki blokuje kliknięcia w `a[href]` (sygnał „ktoś otworzył
  plik” dla autora pliku).
- D11 3DM, STEP, IGES, BREP: karta „Pobierz” (rhino3dm i occt-import-js potrzebują `eval`); praca STEP na gałęzi
  `buduj/podglad-step-eval`, decyzja o osobnym dokumencie ramki z `'unsafe-eval'` należy do właściciela (PODGLAD.md §6).
- D12 Stary film: odszyfrowane najwyżej 16 MiB, pobieranie przerywane; bez `Range` na serwerze przeglądarka czyta z
  wyprzedzeniem kilka MiB (pomiar: 20–24 MiB dla filmu 29 MB). Pełne „≤ 16 MiB” wymaga `Range` w `…/content`.
- D13 Każdy plik w nowej ramce (przegląd bezpieczeństwa `connect-src blob:`): kod, który uruchomiłby plik A, nie widzi
  bajtów pliku B.
- D14 pdf.js w wersji legacy (polyfille `Math.sumPrecise`, `Map.getOrInsertComputed`).
- D15 Dwa moduły WASM `crates/preview`: bez DWG (86 KB gzip) i z DWG (1,7 MB gzip, feature `dwg`).
- D16 `.odt`, `.odp`, `.key`, `.rtf` nie są na liście PODGLAD §1: karta „Pobierz”.
