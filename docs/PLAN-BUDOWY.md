# Plan budowy aplikacji

Kolejność prac od pustego repozytorium do wersji 1. Jak działa każdy element — [ARCHITEKTURA.md](ARCHITEKTURA.md). Wymagania — [PLAN.md](PLAN.md).

> **Stan na 2026-10-21.** Zrobione i scalone (gałęzie `buduj/*`): rdzeń z podpisanymi i zaszyfrowanymi wiadomościami w dzienniku, zapis `.md` przez `write_atomic`, zmiana nazwy, przenoszenie i kosz w rdzeniu, tabele z formułami, indeks linków, tagów i nagłówków oraz rendering w WASM (`crates/web`), widok czytania, podgląd na żywo, interfejs w stylu Obsidiana (pasek boczny, karty, paleta, ustawienia), graf globalny i lokalny. Kalendarz (notatka typu kalendarz, widoki, powtarzanie) jest na gałęzi `buduj/kalendarz-ui` i jeszcze nie w `main`.
>
> Interfejs to prototyp w przeglądarce na `MockBridge` (notatki w pamięci). Brakuje: Tauri, odczytu i zapisu prawdziwego folderu, obserwatora plików, historii wersji, wyszukiwania FTS5, zakładek, załączników i panelu odnośników zwrotnych. Etap 2 nie jest skończony. Odhaczono tylko punkty sprawdzone w kodzie i testach.

## Zasady prowadzenia prac

1. **Każdy etap kończy się czymś, czego da się używać.** Po etapie 2 aplikacja jest dobrym lokalnym edytorem notatek — nawet jeśli P2P nigdy nie powstanie.
2. **CRDT i dziennik wiadomości od etapu 2, nie od etapu 4.** Lokalna edycja od początku idzie przez Yrs i podpisane wiadomości. W etapie 4 sieć tylko przesyła istniejące wiadomości — nie przepisujemy zapisu.
3. **Testy ryzykownych miejsc przed funkcjami pobocznymi:** zapis po awarii, zmiany zewnętrzne, zbieżność synchronizacji, odrzucanie nieuprawnionych zmian.
4. **CI na Linuxie i Windowsie od pierwszego dnia** (GitHub Actions) — błędy specyficzne dla Windows (blokady plików, ścieżki) wychodzą od razu, nie na końcu.

## Struktura repozytorium

```text
notes/
├── crates/
│   ├── core/        # notatki, SQLite, zapis .md, obserwator, wersje, indeks — bez UI i sieci
│   ├── sync/        # tożsamość, klucze, dziennik uczestników, szyfrowanie, iroh
│   └── node/        # notes-node: węzeł przechowujący (program bez okna)
├── app/             # Tauri 2: komendy IPC, okno
├── ui/              # TypeScript + Vite + CodeMirror 6
└── docs/
```

`core` da się testować bez okna i bez sieci — tam jest większość logiki i większość testów.

---

## Etap 0 — Przygotowanie (kilka dni)

- [ ] Instalacja Rusta (`rustup`) ✅ i zależności Tauri ⏳ (wymagają sudo): Linux `webkit2gtk-4.1`, `libayatana-appindicator`; Windows WebView2 (jest w Windows 10/11).
- [ ] Szkielet repozytorium jak wyżej, `cargo` workspace, `ui` z Vite.
- [x] CI: build + testy na `ubuntu-latest` i `windows-latest`.
- [ ] Generator testowej przestrzeni: 10 000 notatek `.md` z linkami i tagami (do pomiarów).

**Gotowe, gdy:** puste okno Tauri buduje się i uruchamia na obu systemach w CI.

## Etap 1 — Prototyp interfejsu i pomiary (2–3 tygodnie)

- [x] Główne okno: pasek narzędzi, drzewo plików (wirtualizowane), karty, edytor CodeMirror, prawy panel, pasek stanu.
- [x] Motyw ciemny i jasny na zmiennych CSS, zmiana rozmiaru paneli, tryb skupienia.
- [x] Skróty: Ctrl+P (szybkie otwieranie), Ctrl+Tab.
- [ ] Odczyt prawdziwego folderu `.md` (bez zapisu, bez bazy — to jeszcze prototyp).
- [ ] **Pomiary** na testowej przestrzeni, na Linuxie i Windowsie: czas startu, przełączenie kart, przewijanie dużej notatki, opóźnienie pisania.
- [ ] Decyzja: zostajemy przy Tauri + WebView, czy WebKitGTK na Linuxie jest za wolny (wtedy porównanie z alternatywą).
- [x] Decyzja: framework UI: czysty TypeScript, bez Solid (2026-10-21, UWAGI).

**Gotowe, gdy:** jest zapisany raport pomiarów (`docs/POMIARY.md`) i podjęte obie decyzje.

## Etap 2 — Notatki lokalne (6–8 tygodni)

Kolejność ma znaczenie — od fundamentu w górę:

1. [x] **Baza i dokumenty:** `space.db` (WAL, synchronous=FULL), dokument `meta` (id → ścieżka), dokument Yrs dla każdej notatki.
2. [x] **Klucz urządzenia + dziennik wiadomości:** każda paczka edycji to podpisana wiadomość z `seq` (jeszcze bez szyfrowania). Pasek „Zapisano lokalnie” dopiero po commicie.
3. [x] **Most edytor ↔ rdzeń:** Yjs w WebView, aktualizacje przez IPC, `open_note` zwraca pełny stan.
4. [x] **Bezpieczny zapis `.md`:** plik tymczasowy → fsync → podmiana; ponawianie na Windowsie; `file_state`.
5. [x] **Import istniejącego folderu** i skan przy starcie (`stat`, czytanie tylko zmienionych).
6. [x] **Obserwator folderu + zmiany zewnętrzne:** ignorowanie własnych zapisów, scalanie trójstronne, ekran konfliktu.
7. [x] **Zmiana nazwy, przenoszenie, usuwanie, kosz**, wykrywanie przeniesień zrobionych poza aplikacją.
8. [x] **Wersje:** tworzenie, lista w prawym panelu, porównanie, przywrócenie.
8a. [x] **Tabele z formułami** (ARCHITEKTURA §4.16a): parser i ewaluator w `core`, adresy na marginesie, edycja komórek, błędy.
9. [ ] **Wyszukiwanie FTS5**, linki, odnośniki zwrotne, tagi, ulubione, **graf** (globalny i lokalny, ARCHITEKTURA §4.15).
10. [x] **Załączniki:** wklejanie / przeciąganie obrazów do `assets/`, względne linki.
11. [x] Pierwsze uruchomienie: „Utwórz przestrzeń” i „Otwórz folder”.

Uwaga projektowa: zapis `.md`, obserwator folderu i zmiany zewnętrzne to w `core` osobny moduł „rzut na pliki”, który można wyłączyć. Przestrzeń zaszyfrowana (etap 3) po prostu go nie włącza — nie trzeba niczego przepisywać.

Testy, które muszą istnieć:
- [ ] proces zabity w trakcie zapisu → po restarcie plik jest albo stary, albo nowy, a tekst z bazy wraca;
- [x] zmiana pliku z zewnątrz w trakcie pisania w aplikacji → scalenie albo ekran konfliktu, nigdy cicha utrata;
- [ ] Windows: plik trzymany przez inny proces → zapis się powiedzie po zwolnieniu;
- [x] przeniesienie pliku poza aplikacją zachowuje id (także przeniesienie całego folderu);
- [ ] 10 000 notatek: start < 2 s, wyszukiwanie < 100 ms;
- [x] formuły: tabela przykładów (daty, zakresy, błędy, `#CYKL!`) + test właściwości: losowy tekst formuły nigdy nie powoduje paniki; 1000 komórek < 1 ms.

**Gotowe, gdy:** używasz aplikacji na co dzień zamiast Obsidiana na prawdziwym folderze i nic nie ginie. **To jest moment na pierwsze wydanie** (UWAGI: propozycja zakresu).

## Etap 3 — Tożsamość i zaproszenia (3–4 tygodnie)

- [ ] Klucz użytkownika z frazy odzyskiwania (BIP39), certyfikat urządzenia, przechowywanie w systemowym magazynie haseł.
- [ ] Ekran pierwszego uruchomienia: pokazanie frazy, potwierdzenie jej zapisania, ostrzeżenie o utracie dostępu.
- [ ] Dziennik uczestników (`acl_log`): łańcuch podpisanych wpisów, weryfikacja.
- [ ] Klucz przestrzeni i jego koperty dla uczestników; epoki klucza.
- [ ] Szyfrowanie wiadomości (XChaCha20-Poly1305) i reguły odrzucania (ARCHITEKTURA 4.10).
- [ ] Bilet zaproszenia, kod bezpieczeństwa, zatwierdzanie przez właściciela.
- [ ] Odzyskiwanie: nowe urządzenie z frazy; unieważnianie zgubionego urządzenia.
- [ ] **Przestrzeń zaszyfrowana** (ARCHITEKTURA §4.17): SQLCipher (`rusqlite` z `bundled-sqlcipher`), `keyfile` z Argon2id, zaszyfrowane `blobs/`, ekran hasła, blokada, eksport/import `.md`, wyłączone zrzuty pamięci.

Testy:
- [ ] przestrzeń zaszyfrowana: przeszukanie surowych bajtów `space.db`, WAL i `blobs/` nie znajduje ani fragmentu treści, ani nazwy notatki;
- [ ] złe hasło nie otwiera bazy; fraza odzyskiwania otwiera;
- [ ] po blokadzie klucz nie jest w pamięci procesu, a edytor jest pusty;
- [ ] wiadomość od czytelnika jest odrzucana;
- [ ] wiadomość od usuniętego uczestnika jest odrzucana;
- [ ] zmieniony bajt szyfrogramu lub nagłówka → odrzucenie;
- [ ] po usunięciu uczestnika jego klucz nie odszyfruje nowych wiadomości;
- [ ] odzyskanie dostępu z samej frazy.

**Gotowe, gdy:** testy przechodzą, a zaproszenie działa między dwiema instancjami na jednym komputerze (bez sieci — wymiana wiadomości w teście).

## Etap 4 — Współpraca P2P (8–13 tygodni, z węzłem przechowującym)

- [x] Punkt końcowy iroh na każdym urządzeniu; wykrywanie w LAN (mDNS) i przez internet (relay).
- [x] Protokół `notes-sync/1`: `Hello`, synchronizacja dziennika uczestników, wektory wersji, brakujące wiadomości, wysyłka na żywo.
- [ ] Paczka startowa dla nowego uczestnika.
- [ ] Kursory i zaznaczenia uczestników (awareness), lista „kto jest online”.
- [ ] Synchronizacja załączników (`iroh-blobs`, szyfrowane).
- [ ] Kompaktowanie dziennika.
- [ ] **Węzeł przechowujący `notes-node`** (ARCHITEKTURA §4.18): `init` z biletem węzła, wpis `Dodaj węzeł`, przyjmowanie i oddawanie wiadomości z kontrolą podpisu i roli, zaszyfrowane migawki i załączniki, prośby o dołączenie, limity, opcja `--relay`, usługa systemd i obraz Dockera ([DOCKER.md](DOCKER.md) §2–4, w tym `compose.test.yml` z klientami testowymi). *Zrobione (gałąź `buduj/siec`): `init`/`ticket`/`serve`/`health`, bilet z tokenem, przyjmowanie i oddawanie wiadomości z kontrolą podpisu i roli, limity, obraz Dockera i `compose.test.yml`. Brakuje: wpisu `Dodaj węzeł`, migawek, załączników, próśb o dołączenie, `--relay`, usługi systemd.*
- [ ] Wysyłka zaległych wiadomości do węzła: przy starcie, co 5 minut i przy zamykaniu aplikacji (z limitem czasu).
- [ ] Praca w tle: ikona w zasobniku, start z systemem (aplikacja częściej online).
- [ ] Pasek stanu: liczba połączonych osób, liczba oczekujących zmian.

Testy:
- [ ] **test zbieżności:** 3 symulowane urządzenia, losowe edycje, losowa kolejność i opóźnienia dostarczania, rozłączenia → na końcu identyczny tekst u wszystkich (test właściwości, setki losowych przebiegów); *jest test właściwości z 16 przebiegami (`three_devices_converge`), do zwiększenia w CI nocnym*;
- [ ] tydzień offline (dużo wiadomości) → synchronizacja po połączeniu;
- [x] zmiany Ani docierają do Cezarego przez Bartka, z zachowaniem podpisu Ani;
- [ ] prawdziwe połączenie przez relay między Linuxem a Windowsem w różnych sieciach;
- [x] **A edytuje i wyłącza się, potem włącza się B** → B ma zmiany A z węzła;
- [ ] dwa urządzenia w tym samym LAN synchronizują się na żywo przy wyłączonym węźle i relayu; węzeł po włączeniu dostaje wszystko w najbliższej wysyłce;
- [ ] dwa urządzenia w różnych sieciach piszą jednocześnie przez węzeł; w bazie węzła są wszystkie wiadomości;
- [x] węzeł odrzuca wiadomości od obcego urządzenia i od czytelnika;
- [x] w bazie węzła nie ma jawnej treści ani nazw notatek;
- [ ] nowe urządzenie dołącza z samej migawki na węźle, gdy wszyscy uczestnicy są offline.

**Gotowe, gdy:** dwie osoby na dwóch komputerach w różnych sieciach piszą jednocześnie w jednej notatce przez godzinę i nic nie ginie.

## Etap 5 — Wersja webowa (4–6 tygodni)

Szczegóły: [WEB.md](WEB.md).

- [ ] `core` i `sync` kompilują się do `wasm32-unknown-unknown` (sprawdzane w CI od etapu 2 — patrz WEB §5).
- [ ] Rdzeń w Web Workerze, ten sam interfejs; warstwa „most” w UI: IPC Tauri albo `postMessage` do workera.
- [ ] SQLite w OPFS, zawsze zaszyfrowane jak przestrzeń zaszyfrowana; odblokowanie hasłem.
- [ ] Połączenie z węzłem przez WebSocket (TLS) tym samym protokołem `notes-sync/1`.
- [ ] Przeglądarka jako nowe urządzenie: fraza albo zaproszenie samego siebie.
- [ ] Eksport `.md` (zip) i import folderu (wybór plików).
- [ ] Hosting: statyczne pliki z węzła, podpisane wydania (WEB §4); obraz z WASM + UI i Caddy z `wss://` (DOCKER §2–3).

Testy:
- [ ] przeglądarka i aplikacja desktopowa piszą jednocześnie w jednej notatce przez węzeł;
- [ ] odświeżenie strony / zamknięcie karty nie traci zmian zapisanych lokalnie;
- [ ] w OPFS i w ruchu do węzła nie ma jawnej treści;
- [ ] pomiary w Chrome i Firefox: start, pisanie, wyszukiwanie przy 10 000 notatek.

**Gotowe, gdy:** wersja webowa robi wszystko to co desktopowa poza plikami `.md` na dysku i siecią LAN.

## Etap 6 — Dopracowanie (około 4 tygodni)

- [ ] Testy konfliktów i awarii na dłuższych scenariuszach (wiele godzin, wiele osób).
- [ ] Dostępność: pełna obsługa klawiaturą, czytnik ekranu (drzewo, karty, okna dialogowe), kontrast obu motywów.
- [ ] Końcowe pomiary wydajności na obu systemach → `docs/POMIARY.md`.
- [ ] Instalatory: `.deb`/AppImage na Linux, `.msi` na Windows; automatyczne aktualizacje (wtyczka Tauri updater).
- [ ] Wydanie z tagu `v*` buduje naraz Linux, Windows, web i obraz `notes-node` (amd64/arm64) — DOCKER §5–6.
- [ ] Przejście przez kryteria ukończenia z PLAN §11, punkt po punkcie.

**Gotowe, gdy:** wszystkie kryteria z PLAN §11 są odhaczone z dowodem (test albo pomiar).

## Etap 7 — Dyktowanie w przeglądarce (spec: [DYKTOWANIE.md](DYKTOWANIE.md))

- [x] Moduł `ui/src/voice/` ładowany leniwie, Web Worker, jedno API `start/stop` + zdarzenia; przycisk mikrofonu i Ctrl+Shift+D (bez Tauri). Testy: `insert.test.ts` (styk z tekstem, jedno cofnięcie = jeden fragment), `voice.test.ts`, `controller.test.ts`.
- [x] AudioWorklet z resamplingiem do 16 kHz, Silero VAD v6.2.3 w workerze. Testy: `resample.test.ts`, `vad.test.ts`, `vad.silero.test.ts` (prawdziwy model na `fixtures/jfk.wav`).
- [x] Parakeet przez `parakeet.js` (WebGPU fp16 przy `shader-f16`, inaczej WASM int8), ekran zgody, postęp, anulowanie, wznawianie (Range), OPFS, SHA-256. Testy: `modelstore.test.ts`, `sha256.test.ts`.
- [x] `notes-node`: `/models/*` bez fallbacku, `immutable`, COOP+COEP, `microphone=(self)`, `connect-src` z `blob:`; modele na dysku serwera (`<data>/models`), wgrywane zadaniem `voice-models` z innego serwera Notatek albo katalogu (`--from`, SHA-256). Test: `http::tests::speech_models_…`; przegląd diffu przez osobną sesję Opusa (critical-files).
- [x] Błędy po polsku, Ustawienia → Dyktowanie (rozmiar, usuwanie), „O programie” → Licencje, `THIRD-PARTY-NOTICES.txt` z modelami.
- [x] E2E: `scripts/test-dictation.cjs` (zgoda, tekst, Ctrl+Z, brak żądań poza originem, CSP blokuje inne hosty, brak audio w pamięci przeglądarki).
- [ ] Pomiar na nagraniach właściciela (10–15 min) → `docs/POMIARY.md` (`scripts/measure-dictation.cjs`); wstępny pomiar na FLEURS jest w POMIARY.md.
- [ ] Ścieżka WebGPU fp16 sprawdzona na sprzęcie z `shader-f16` (tu Chromium/Linux/NVIDIA go nie zgłasza).
- [ ] Ręcznie: Firefox i Safari, podgląd PDF pod COEP, skrót Ctrl+Shift+D w Chrome/Edge.

**Gotowe, gdy:** wszystkie kryteria z DYKTOWANIE §8 są odhaczone z dowodem.

---

## Szacunek czasu

Dla jednej osoby pracującej na pełny etat: około **7–10 miesięcy** do wersji 1 (z wersją webową), w tym **3 miesiące do pierwszego wydania lokalnego** (etapy 0–2). To zgrubny szacunek, nie zobowiązanie — największa niepewność jest w etapie 4 (sieć w realnych warunkach).

## Największe ryzyka

| Ryzyko | Kiedy wyjdzie | Co wtedy |
|---|---|---|
| WebKitGTK za wolny na Linuxie | etap 1 | wcześnie, więc tanio: zmiana warstwy UI |
| Scalanie zmian z Obsidiana daje dziwne wyniki | etap 2 | więcej przypadków na ekran konfliktu zamiast auto-scalania |
| Przebijanie NAT nie działa w części sieci | etap 4 | relay zawsze działa — wolniej, ale działa |
| SQLite/iroh w WASM nie działa tak, jak obiecują | etap 2 (CI z celem WASM) | zamiennik magazynu w przeglądarce za tym samym interfejsem w `core` |
| Błąd w kryptografii | etap 3–4 | tylko sprawdzone biblioteki, żadnych własnych algorytmów; przegląd bezpieczeństwa przed wydaniem z P2P |
