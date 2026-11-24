# Licencje

Licencja projektu, składniki innych autorów w każdym artefakcie, jak spełniamy ich warunki, jak odświeżać noty i jak
dodać nową zależność. Sprawdzone 2026-11-24 (gałąź `buduj/licencje`: `main` ze scaloną `buduj/ocr`). **To nie jest
porada prawna.** Projekt jest wciąż rozwijany: ten dokument i noty zmieniają się razem z zależnościami.

## 1. Licencja projektu

- **AGPL-3.0-or-later**, Copyright (c) 2026 Stanisław Ludwicki (decyzja: [UWAGI.md](UWAGI.md), 2026-11-24). Pełny,
  oficjalny tekst: [LICENSE](../LICENSE) (ten sam w `LICENSES/AGPL-3.0-or-later.txt`).
- Obejmuje cały kod i dokumentację repozytorium, poza plikami innych autorów opisanymi w [REUSE.toml](../REUSE.toml):
  `vendor/lgpl/` (libheif-js, LGPL-3.0), `vendor/ocr-models/` (PaddleOCR, Apache-2.0), `ui/public/favicon.svg`
  (ikona Lucide, ISC), `ui/src/voice/fixtures/jfk.wav` (domena publiczna) i teksty licencji w `scripts/licencje/`.
  `reuse lint` przechodzi.
- Pola licencji: `[workspace.package] license` w `Cargo.toml` (crate'y biorą ją przez `license.workspace = true`),
  `app/src-tauri/Cargo.toml`, `"license"` w `ui/package.json` i `mcp/package.json`, `bundle.copyright` i
  `bundle.license` w `app/src-tauri/tauri.conf.json`, etykieta OCI `org.opencontainers.image.licenses` w
  `docker/Dockerfile`.
- Co to znaczy w praktyce: każdy może używać programu, czytać i zmieniać kod oraz udostępniać go dalej (także
  odpłatnie). Kto udostępnia zmienioną wersję, również jako usługę w sieci, musi udostępnić jej pełny kod źródłowy na
  AGPL (§13). Właściciel praw może dodatkowo udzielać osobnej licencji komercyjnej, dopóki ma prawa do całego kodu,
  dlatego na razie nie przyjmujemy zmian od innych ([CONTRIBUTING.md](../CONTRIBUTING.md); CLA, gdy to się zmieni).
- **Kod źródłowy działającej wersji (AGPL §13):** Ustawienia → O programie pokazują commit strony (z budowania:
  `NOTES_COMMIT` albo `git rev-parse HEAD`) i serwera (`GET /api/source`, [API-WEB.md](API-WEB.md)) z linkiem
  `<NOTES_SOURCE_URL>/tree/<commit>`. `NOTES_SOURCE_URL` (adres publicznego repozytorium) podaje się przy budowaniu
  (`docker build --build-arg NOTES_SOURCE_URL=… --build-arg NOTES_COMMIT=…`); bez niego ekran mówi, że adresu nie ma.

## 2. Artefakty i gdzie są noty

Jeden plik [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) w katalogu głównym, z osobną sekcją dla każdego
artefaktu, trafia do każdego artefaktu. Każda pozycja ma nazwę, wersję, licencję (przy „A OR B”: z której korzystamy),
prawa autorskie i odwołanie do pełnego tekstu licencji na końcu pliku (każdy tekst raz). Pliki `NOTICE` z Apache są
w całości; przy MPL, LGPL i CC BY jest adres źródeł, przy LGPL także jak podmienić plik.

| Artefakt | Jak powstaje | Składników | Gdzie są noty |
|---|---|---|---|
| Strona (`ui/dist`: aplikacja, ramka `/preview/`, workery) | `npm run build` w `ui/` | 216 | `/THIRD_PARTY_NOTICES.txt` i `/LICENSE` (wtyczka `licenceFiles` w `scripts/licencje/collect.mjs`), przycisk „Pokaż licencje” w O programie |
| `notes-node` (x86_64, aarch64) | `cargo build --release -p notes-node` | 293 | w obrazie Dockera (niżej); osobno rozpowszechniana binarka musi mieć obok `LICENSE` i `THIRD_PARTY_NOTICES.txt` |
| Obraz Dockera | `docker/Dockerfile` (distroless Debian 12) | sekcje strony i serwera + obraz bazowy | `/usr/share/doc/notes/` i `/web/`; pliki `copyright` pakietów Debiana w `/usr/share/doc/<pakiet>/` |
| Aplikacja Tauri (Linux, Windows) | `cargo build --manifest-path app/src-tauri/Cargo.toml` | 370 + strona | zasoby aplikacji (`bundle.resources`), `bundle.licenseFile`; interfejs ma te same noty co strona |
| MCP (`@notatki/mcp`, `.mcpb`) | `npm run build`, `npm run release` w `mcp/` | 111 | `dist/LICENSE`, `dist/THIRD_PARTY_NOTICES.txt` w paczce npm, w `.mcpb` i w `release/` |

Tylko do budowania i testów (nie trafiają do artefaktów, nie ma ich w notach): devDependencies `ui/` (vite, vitest,
typescript, jsdom, @types/*, license-checker-rseidelsohn) i `mcp/` (rolldown, vite, vitest, typescript), crate'y
proc-macro (48, np. `serde_derive`, `tokio-macros`) i zależności `build` (`cc`, `bindgen`, `pkg-config`), wasm-pack,
cargo-deny, cargo-audit, reuse 5.0.2, gitleaks, Playwright w skryptach e2e, obrazy `rust:latest` i
`node:22-bookworm-slim` (etapy budowania), skrypty `scripts/fixtures/` i `scripts/models/` (paddle2onnx, onnxsim).
Wszystkie działają tylko przy budowaniu albo w CI.

## 3. Składniki, warunki i jak je spełniamy

Pełna, sprawdzana w CI lista to `THIRD_PARTY_NOTICES.txt`. Licencje (wybrane przy „A OR B”) 633 różnych składników:
MIT 539, BSD-3-Clause 16, Apache-2.0 15, Unicode-3.0 15, ISC 14, MPL-2.0 8, CC0-1.0 6, Zlib 2, CC-BY-4.0 2, LGPL-3.0 1,
CDLA-Permissive-2.0 1, SQLite `blessing` 1, połączenia `AND` 11 (np. ring: Apache-2.0 AND ISC; pako: MIT AND Zlib),
obraz bazowy Debiana 1.

| Licencja | Warunek | Jak spełniamy |
|---|---|---|
| MIT, BSD-2/3-Clause, ISC, Zlib, Unicode-3.0, CDLA-Permissive-2.0 | zachować prawa autorskie i tekst licencji (Zlib: oznaczyć zmienione wersje) | pozycja z prawami autorskimi i tekstem w `THIRD_PARTY_NOTICES.txt` w każdym artefakcie |
| Apache-2.0 | tekst licencji, plik `NOTICE` autora, oznaczenie zmienionych plików | tekst i `NOTICE` w całości; zmiany opisane (modele OCR: `vendor/ocr-models/NOTICE`; pptx-browser i online-3d-viewer: pole „Uwaga”) |
| MPL-2.0 (imiennie: acadrust, attohttpc, cssparser, cssparser-macros, selectors, dtoa-short, option-ext, dxf-viewer, web-ifc) | pliki biblioteki bez zmian albo ich zmiany publicznie; tekst licencji | używamy bez zmian; tekst i adres źródeł w notach; wyjątki imienne w `deny.toml` i w CI |
| LGPL-3.0 (libheif-js 1.23.5) | osobny plik, tekst licencji, źródła tej wersji, możliwość podmiany | `vendor/lgpl/` bajt w bajt (SHA-256 sprawdzane przy generowaniu not), ramka wczytuje plik w czasie działania; noty i O programie: źródła i jak podmienić |
| CC-BY-4.0 (modele mowy Parakeet) | uznanie autorstwa, link do licencji, opis zmian | autorzy, adres, zmiany eksportu i tekst CC BY 4.0 w notach; O programie |
| CC0-1.0, Unlicense, `blessing` | brak | podane dla porządku |
| Obraz bazowy (glibc LGPL-2.1, libgcc/libstdc++ GPL-3.0 z wyjątkiem GCC, OpenSSL, ca-certificates, tzdata, base-files, netbase) | przy publikacji obrazu: noty i dostęp do źródeł tych pakietów | pliki `copyright` w obrazie, pozycja w notach ze wskazaniem źródeł Debiana; to system obok programu, nie zależność naszego kodu |

Sprawdzone ręcznie (narzędzia ich nie widzą; `scripts/licencje/manifest.json`):

| Składnik | Wersja | Licencja | Gdzie sprawdzono |
|---|---|---|---|
| Modele PaddleOCR PP-OCRv5 (wykrywanie, rozpoznawanie łacińskie, słownik) | PaddleOCR 3.0 | Apache-2.0 | `LICENSE` z tagu v3.0.0 (teraz bez zmian w `vendor/ocr-models/LICENSE`), README v3.0.0 |
| Parakeet Ultra ONNX (Olicorne) | commit b27f93c2 | CC-BY-4.0 | karta modelu w tym commicie; model bazowy `moondream/parakeet-ultra` @73175eb7: CC-BY-4.0 |
| Parakeet TDT 0.6B v3 ONNX (ysdede) | commit e5356bf6 | CC-BY-4.0 | karta modelu w tym commicie; `nvidia/parakeet-tdt-0.6b-v3` @541d1f99: CC-BY-4.0 |
| Silero VAD | v6.2.3 | MIT | `LICENSE` z tagu v6.2.3 |
| ONNX Runtime Web | 1.24.1 | MIT (+ ThirdPartyNotices) | pakiet npm bez pliku licencji; `LICENSE` i `ThirdPartyNotices.txt` z oficjalnego pakietu onnxruntime 1.24.1 (PyPI) |
| libsodium (C w pakiecie npm) | commit 33cc75ab | ISC | `LICENSE` z podmodułu libsodium.js @2830fcf2 |
| pdf.js: CMapy, czcionki Foxit, profil ICC, OpenJPEG, JBIG2, qcms | 6.5.438 | BSD-3, BSD-3, CC0, BSD-2 + Apache, BSD-3 + Apache, MIT + Apache | pliki `LICENSE*` w paczce `pdfjs-dist` |
| SQLite (w libsqlite3-sys, sqlite-wasm-rs) | 3.53.2, 3.53.0 | `blessing` | nagłówek `sqlite3.c` |
| zstd (w zstd-sys) | 1.5.7 | BSD-3-Clause (wybór z „BSD-3-Clause OR GPL-2.0”) | `zstd/LICENSE`, `zstd/COPYING` w paczce |
| Microsoft WebView2 SDK (Windows) | 1.0.3800.47 | BSD-3-Clause (Microsoft) | `LICENSE.txt`, `NOTICE.txt` z pakietu NuGet tej wersji (wersja z `update-bindings` webview2-rs @edc2caf8) |
| Crate'y bez pliku licencji: alloc-stdlib, dlopen2, iroh, iroh-base, iroh-dns, iroh-relay, iroh-mdns-address-lookup, netwatch, portmapper, rsqlite-vfs, webview2-com, webview2-com-sys, yrs; npm draco3d | jak w notach | jak w notach | pliki z repozytorium autora w commicie z `.cargo_vcs_info.json` (draco: tag 1.5.9), `scripts/licencje/texts/` |
| acto, selectors, bitcoin_hashes | jak w notach | MIT (z „Apache-2.0 OR MIT”), MPL-2.0, CC0-1.0 | repozytoria bez pliku licencji; oficjalny tekst SPDX (`scripts/licencje/spdx/`) |

Kod skopiowany: przeszukanie repozytorium (`Copyright`, `based on`, `adapted from`, `port of`, `na podstawie`, adresy
GitHub, Stack Overflow, gist, osadzone SVG i dane) nie znalazło kodu przeniesionego bez podpisu ani fragmentów ze
Stack Overflow. Ikony z pakietu `lucide` (ISC, w notach). Tablice z norm (Huffman JPEG ITU-T T.81, Windows-1252,
stałe SHA-256 FIPS 180-4, wektor BIP-39) to dane z norm.

## 4. Jak powstają i jak odświeżyć noty

```bash
cd ui && npm run build          # zapisuje pakiety z bundla strony, ramki i workerów do scripts/licencje/.cache/
cd ../mcp && npm run build      # to samo dla MCP
cd .. && node scripts/licencje/generate.mjs           # zapisuje THIRD_PARTY_NOTICES.txt
node scripts/licencje/generate.mjs --check            # tak sprawdza CI (zadanie „licencje”)
node --test scripts/licencje/*.test.mjs               # testy generatora
```

- Rust: `cargo tree --locked -e normal --target <cel>` dla każdego artefaktu i celu (bez proc-macr), licencje i pliki
  z paczek w wersjach z `Cargo.lock` i `app/src-tauri/Cargo.lock`.
- npm: tylko pakiety z kodem w zbudowanych plikach (`scripts/licencje/collect.mjs`: moduły z `renderedLength > 0`).
- Ręcznie: `scripts/licencje/manifest.json` (`overrides`, `notes`, `extra`) i teksty w `scripts/licencje/texts/`.
- Wynik jest posortowany i bez dat. Generator przerywa, gdy składnikowi brakuje tekstu licencji albo gdy plik LGPL ma
  inną sumę SHA-256 niż w `vendor/lgpl/MANIFEST.json`.

## 5. Nowa zależność krok po kroku

1. Sprawdź licencję **w tej wersji, której użyjesz** (plik licencji w paczce, nie strona projektu). Dozwolone: lista
   `allow` w `deny.toml` i `ALLOW` w zadaniu `licencje` w CI. Nie wolno: GPL, AGPL, „non-commercial”, BUSL, SSPL,
   Elastic, Commons Clause, kod bez licencji. MPL i LGPL tylko po decyzji w UWAGI.md i jako wyjątek imienny, w trybie z
   [PODGLAD.md](PODGLAD.md) §1.
2. Dodaj zależność (`Cargo.toml` / `package.json`) i przebuduj (`npm run build` w `ui/` i `mcp/`).
3. `cargo deny check` (i `cargo deny --manifest-path app/src-tauri/Cargo.toml check` dla aplikacji Tauri) oraz
   sprawdzenie npm jak w CI.
4. `node scripts/licencje/generate.mjs`. Jeśli przerwie z „brak tekstu licencji”, weź plik licencji z repozytorium
   autora w commicie tej wersji (`.cargo_vcs_info.json` albo tag), zapisz w `scripts/licencje/texts/<nazwa>-<wersja>/`,
   dopisz `overrides` w `manifest.json` i adnotację w `REUSE.toml`.
5. Plik, którego narzędzia nie widzą (model, słownik, czcionka, ikona, `.wasm` kopiowany wtyczką, plik w `vendor/`):
   pozycja `extra` w `manifest.json` (nazwa, wersja, licencja, źródło, pliki licencji i `NOTICE`, opis zmian) i
   adnotacja w `REUSE.toml`.
6. Zmieniony `THIRD_PARTY_NOTICES.txt` w tym samym commicie; `reuse lint` przechodzi.

## 6. Lista kontrolna przed wydaniem (uzupełnia PODGLAD §4)

1. CI zielone: `cargo deny` (obie przestrzenie robocze), licencje npm, `reuse lint`, `generate.mjs --check`, gitleaks.
2. Budowanie z `NOTES_SOURCE_URL` (adres publicznego repozytorium) i `NOTES_COMMIT`; O programie pokazuje działające
   linki do kodu strony i serwera.
3. `LICENSE` i `THIRD_PARTY_NOTICES.txt` są w: `ui/dist/`, obrazie (`/usr/share/doc/notes/`, `/web/`), paczce npm i
   `.mcpb` MCP, zasobach aplikacji Tauri.
4. Kod publikowanej wersji jest w publicznym repozytorium pod tym commitem (albo tagiem).
5. Licencje modeli i plików z `manifest.json` sprawdzone ponownie, gdy zmieniła się ich wersja.
6. Przy publikacji obrazu Dockera: wersje pakietów Debiana z obrazu do wskazania na prośbę o źródła.

Pierwsze upublicznienie: `bash scripts/nowe-repozytorium.sh <pusty katalog> "<Imię Nazwisko>" <id+login@users.noreply.github.com> main`
tworzy nowe repozytorium z jednym commitem (bez historii, bez osobistych ustawień Claude Code z `.claude/`), po
sprawdzeniu, że nie ma w nim plików `.env`, nazwy użytkownika i katalogu domowego tej maszyny, adresu e-mail z
konfiguracji gita, nazw hostów Tailscale ani słów z `PRIVATE_WORDS`, a gitleaks i `reuse lint` przechodzą. Wypycha się
je ręcznie.

## 7. Problemy z inwentarza i co z nimi zrobiono

| Problem | Stan |
|---|---|
| Prywatne dane w historii gita (adresy autorów, domena, nazwa użytkownika, ścieżki) | pliki oczyszczone (domena z adresu strony w `legal.ts`, neutralne nazwy w dokumentacji i testach, testowe adresy `example.test`, adresy IP z RFC 5737); historia: publiczne repozytorium powstanie od nowa z jednego commita (decyzja właściciela) |
| Sekrety | brak w historii i plikach (gitleaks 8.28.0); `.gitleaks.toml` pomija sumy z `Cargo.lock`; `.gitignore` obejmuje `.env` w każdym katalogu. `.env.example` do przejrzenia przez właściciela |
| Czcionki Liberation (GPL-2.0) w ramce podglądu | nie są już kopiowane (`ui/preview/vite-pdfjs.ts`); ramka renderuje z `useSystemFonts` |
| Artefakty bez not | noty w każdym artefakcie (§2) |
| Składniki bez pliku licencji | teksty z repozytoriów autorów w używanych wersjach (§3) |
| Budowa MCP na `main` | naprawiona (wtyczka `viteUrls` z gałęzi OCR) |
| Nieaktualny `app/src-tauri/Cargo.lock`, Tauri poza `cargo deny` | lockfile zgodny, `cargo deny` dla aplikacji w CI |
| MPL dozwolone dla wszystkich | wyjątki imienne |
| `occt-import-js` w O programie | usunięty z listy i z zależności (nie trafiał do żadnego pliku; STEP/IGES/BREP mają kartę „Pobierz”, PODGLAD §6) |
| Zmiany w online-3d-viewer nieopisane w notach | opisane |
| Nazwy demo koła naukowego | zastąpione („Przykładowa organizacja”, projekt „Sonda”) |
| Tekst licencji modeli OCR nie był plikiem autora | `LICENSE` z PaddleOCR v3.0.0 bez zmian |

## 8. Sprawdzenie (2026-11-24)

- Zbudowane od zera: strona (`npm run build`), MCP (`npm run build`), `notes-node` dla x86_64 i aarch64 (aarch64
  krzyżowo przez `zig cc`). W `ui/dist` i `mcp/dist` są `LICENSE` i `THIRD_PARTY_NOTICES.txt` identyczny z plikiem w
  repozytorium; w ramce podglądu nie ma czcionek Liberation.
- Noty a zawartość: każdy crate z `cargo tree -e normal` dla każdego celu i każdy pakiet z danych budowania strony,
  workerów, ramki i MCP ma pozycję (0 brakujących); pliki z `manifest.json` (modele OCR, dane pdf.js, draco, web-ifc,
  libheif) są w zbudowanej stronie.
- Przechodzą: `cargo deny check` (obie przestrzenie robocze), sprawdzenie npm (UI i MCP), `reuse lint`,
  `generate.mjs --check`, testy generatora, gitleaks (cała historia i pliki), `cargo test --workspace`,
  `cargo clippy --workspace -- -D warnings`, `cargo check -p notes-core --target wasm32-unknown-unknown`, testy UI
  (2465) i MCP (93).
- Testy negatywne (osobne commity, cofnięte): zależność npm na GPL-3.0 zatrzymuje sprawdzenie npm; crate na GPL-3.0
  zatrzymuje `cargo deny`; nowa zależność bez odświeżenia not zatrzymuje `generate.mjs --check`.
- Nie sprawdzone tutaj (brak narzędzi na maszynie): budowa obrazu Dockera (brak Dockera) i aplikacji Tauri (brak
  WebKitGTK); ich konfiguracja not jest w `docker/Dockerfile` i `tauri.conf.json`, a zawartość ich części not
  (crate'y aplikacji i obraz bazowy) jest w `THIRD_PARTY_NOTICES.txt`. Do sprawdzenia przy pierwszej budowie obrazu i
  instalatora (§6).
- Świeży przegląd (agent bez kontekstu tej pracy, „znajdź coś, czego nie wolno upublicznić albo bez licencji”):
  znalazł historię gita z prywatnymi adresami (rozwiązanie: nowe repozytorium), zrzuty z nazwą koła naukowego
  (nowe zrzuty), ścieżkę domową w `scripts/test-ocr-demo.cjs` (usunięta), plik Anthropic
  `.claude/commands/security-review.md` bez opisu licencji (opisany: MIT, Anthropic), osadzone czcionki w PDF-ach
  testowych (opisane w REUSE) i nieaktualne zdania w roboczej wersji tego dokumentu (poprawione).
