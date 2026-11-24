# Uwagi do planu i otwarte decyzje

Przegląd [PLAN.md](PLAN.md) z 2026-10-19. Stan kodu: [PLAN-BUDOWY.md](PLAN-BUDOWY.md) (na górze).

## Luki do zamknięcia przed kodem

1. **Rola „czytelnik” nie jest egzekwowana w P2P.** Czytelnik ma klucz przestrzeni, więc może też szyfrować i wysyłać zmiany; aktualizacje Yrs nie są podpisane.
   Potrzebne: podpis każdej paczki zmian kluczem urządzenia, lista uczestników jako podpisany dziennik zmieniany tylko przez właściciela, odrzucanie zmian od nie-edytorów na każdym urządzeniu.
   Bez tego nie jest spełnione kryterium „osoba bez uprawnień nie może zmienić przestrzeni” (PLAN §11).
2. **Usunięty uczestnik wraca z offline.** Trzeba ustalić, czy jego zmiany sprzed usunięcia są przyjmowane. Zależy od kolejności w dzienniku uczestników (pkt 1).
3. **`id` w nagłówku YAML zmienia pliki użytkownika.** „Otwórz istniejący folder” dopisze nagłówek do każdego pliku (widać to w gicie i Obsidianie).
   Do wyboru: id w YAML **albo** mapa ścieżka → id w `.notes-sync` i wykrywanie przeniesień po treści.
4. **Zmiany z Obsidiana → operacje CRDT.** Różnica między ostatnim znanym tekstem a nowym zamieniana na wstawienia/usunięcia Yrs.
   Obserwator folderu musi ignorować własne zapisy (np. porównanie skrótu treści), inaczej powstanie pętla.
5. **Bezpieczny zapis na Windowsie.** Plik tymczasowy → fsync → rename. Rename nie udaje się, gdy inny program trzyma plik — ponawiać albo `ReplaceFileW`.
6. **Historia Yrs rośnie bez końca.** Okresowe migawki i przycinanie historii, inaczej cel startu < 2 s przy 10 000 notatek jest zagrożony.

## Proponowany stos (do potwierdzenia prototypem)

| Obszar | Propozycja | Dlaczego |
|---|---|---|
| Okno | Tauri 2 | Rust w backendzie, małe binarki na Linux/Windows |
| Edytor | CodeMirror 6 + `y-codemirror.next` | Kursory uczestników i łączenie zmian gotowe; Yjs jest zgodny binarnie z Yrs |
| CRDT | Yrs | Z planu |
| Wyszukiwanie | SQLite FTS5 | Z planu |
| Sieć P2P | iroh | Wykrywanie w LAN, przebijanie NAT, pośrednicy bez dostępu do treści |

Ryzyko: Tauri na Linuxie używa WebKitGTK, który bywa wolniejszy — to sprawdza etap 1.
Wersje iroh i Tauri nie zostały jeszcze sprawdzone.

## Propozycja zakresu

Sam etap 2 (notatki lokalne) to już używalny produkt. Wydać go przed pierwszą linijką P2P — kryptografia i synchronizacja to ponad połowa ryzyka projektu.

## Otwarte decyzje

Propozycje rozwiązań są w [ARCHITEKTURA.md](ARCHITEKTURA.md), kolejność prac w [PLAN-BUDOWY.md](PLAN-BUDOWY.md).

- [ ] Id notatki: YAML czy mapa w `.notes-sync` (pkt 3) — propozycja: mapa (ARCHITEKTURA §3)
- [ ] Polityka zmian od usuniętych uczestników (pkt 2) — propozycja: odrzucać wszystkie (ARCHITEKTURA §4.10)
- [ ] Potwierdzenie stosu po prototypie etapu 1
- [x] Framework UI: czysty TypeScript, bez Solid (2026-10-21): interfejs w `ui/` bez frameworka
- [ ] Relay: przy węźle na VPS niepotrzebny na co dzień (ruch między sieciami idzie przez węzeł); dla drogi zapasowej i węzła w domu — publiczne n0, później opcjonalnie `notes-node --relay` (SIEC §3, §5)
- [ ] Historia wersji lokalna czy synchronizowana — propozycja: lokalna (ARCHITEKTURA §4.13)
- [x] Podgląd Markdown „na żywo” w wersji 1: tak (2026-10-21), zrobiony w `ui/src/livepreview.ts`
- [x] Instalacja Rusta (`rustup`) — zainstalowany 2026-10-19 (1.99, profil minimal)
- [x] Szyfrowanie na dysku (2026-10-19): **wybór przy tworzeniu przestrzeni** — otwarta (czytelne `.md`) albo zaszyfrowana (nic jawnego na dysku, hasło). ARCHITEKTURA §4.17
- [ ] Czas automatycznej blokady przestrzeni zaszyfrowanej — propozycja: 15 min
- [ ] Czy zablokowana przestrzeń ma się synchronizować — propozycja: nie (brak klucza bazy)
- [x] Dostarczanie zmian, gdy nikt nie jest online (2026-10-19): **własny węzeł przechowujący** w wersji 1 (ARCHITEKTURA §4.18)
- [x] Rola węzła (2026-10-19): ta sama sieć → bezpośrednio po LAN, węzeł dostaje kopię co 5 min; różne sieci → **na żywo przez węzeł**, który zapisuje zaszyfrowaną kopię (SIEC §3, ARCHITEKTURA §4.18)
- [ ] Zapas, gdy węzeł nieosiągalny: połączenie bezpośrednie/relay iroh — propozycja: tak
- [x] Biblioteka grafu: `d3-force` + `<canvas>`, układ w Web Workerze (2026-10-21): `ui/src/graph.ts`, `ui/src/graphworker.ts` (ARCHITEKTURA §4.15)
- [ ] Odstęp wysyłki do węzła — propozycja: 5 min (plus start i zamknięcie)
- [x] Szyfrowany format wiadomości już w etapie 2 (2026-10-19): **tak**, z tymczasowym kluczem epoki 0 w `space.db` — zrobione (`crates/core/src/message.rs`, SZYFROWANIE §8 krok A)
- [ ] Certyfikaty urządzeń w `Hello` i przechowywane osobno, nie w każdej wiadomości (SZYFROWANIE §3)
- [ ] Dopełnienie wiadomości — propozycja: do 256 B; migawka na węźle — raz na dobę albo po 10 000 wiadomości (SZYFROWANIE §3–4)
- [x] Tabele z adresami jak w Excelu i podstawowymi formułami (2026-10-19): w wersji 1, formuły zapisane w `.md`, wyniki liczone przy wyświetlaniu (ARCHITEKTURA §4.16a)
- [ ] Lista funkcji, polskie nazwy + angielskie synonimy, separator `;` — propozycja jak w §4.16a
- [x] Licencja projektu (2026-11-24, decyzja Stanisława Ludwickiego): **AGPL-3.0-or-later**, Copyright (c) 2026 Stanisław Ludwicki; zasady dla zależności zostają ostre (tylko licencje z listy w `deny.toml` i w zadaniu CI `licencje`, MPL i LGPL imiennie), żeby zachować możliwość osobnej licencji komercyjnej i sprzedaży subskrypcji; na razie bez przyjmowania zmian w kodzie od innych (CLA, gdy to się zmieni); zgłoszenia luk przez prywatne zgłoszenia GitHuba; publiczne repozytorium powstanie od nowa z jednego commita (historia prywatna ma prywatne adresy) ([LICENCJE.md](LICENCJE.md))
- [x] Wersja webowa (2026-10-19): **w wersji 1, w pełni funkcjonalna**, rdzeń Rust jako WASM ([WEB.md](WEB.md))
- [ ] Kolejność: wersja webowa po etapie 4 (potrzebuje węzła) — propozycja: tak, ale kompilacja `core` do WASM sprawdzana w CI już od etapu 2
- [ ] Skąd ładowana wersja webowa — propozycja: z własnego węzła, podpisane wydania (WEB §4)
- [x] Rodzaje przestrzeni (2026-10-19): **Notatki** i **Organizacja** (zadania, osoby, projekty, terminy, powiadomienia) — ORGANIZACJA.md
- [ ] Zadania jako linie w notatkach `.md` (format zgodny z Obsidian Tasks + `@osoba` + `^z-id`) — propozycja: tak (ORGANIZACJA §2)
- [ ] Zespoły `@marketing` w wersji 1 czy później — propozycja: później
- [ ] Powiadomienia push przez węzeł bez treści — propozycja: po wersji 1 (węzeł nie widzi treści, ORGANIZACJA §6)
- [x] Dyktowanie: biblioteka `parakeet.js` 1.4.4 (MIT; `onnx-asr-web` 0.1.3 zbyt młoda), skrót Ctrl+Shift+D, na start tylko gotowe fragmenty bez szarego podglądu (2026-11-16, DYKTOWANIE §10)
- [x] Źródło modeli dyktowania (2026-11-16): NVIDIA i Moondream nie publikują ONNX, więc konwersje społeczności na CC-BY-4.0 przypięte do commitu i SHA-256 (`ui/src/voice/models.ts`): Olicorne (Ultra), ysdede/istupakov (v3)
- [ ] Wariant kodera dyktowania (fp16 1,2 GB / int8 650 MB / 4-bit 383 MB) — po pomiarze na nagraniach właściciela (POMIARY.md)
- [ ] `/models/*` jest publiczne i bez limitu (jedno pobranie to do 1,3 GB) — limit w Caddy/Cloudflare albo wymóg sesji? (przegląd http.rs 2026-11-16)
- [x] Modele dyktowania na dysku serwera (wolumen `voice-models`, poza kopiami `notes-data`), nie w obrazie; `wdrozenie.sh` je wgrywa; nowe serwery biorą je z serwera projektu (`--from`), przeglądarka tylko z własnego serwera (2026-11-16, decyzja właściciela)
- [ ] Miejsce na Radxie: modele w wolumenie zajmują ok. 1,9 GB — może wystarczy wariant 4-bitowy albo sam CPU int8
- [ ] Pauza kończąca fragment dyktowania (teraz 600 ms): dłuższa = mniej zdań przeciętych kropką, ale większe opóźnienie
- [ ] Usunięcie modelu w trakcie jego pobierania może skończyć się błędem (otwarty uchwyt OPFS) — wystarczy ponowić
- [x] Projekt połączony z GitHubem (2026-11-14): repozytoria publiczne bez tokenu, token osobisty tylko dla prywatnych i wyższych limitów; aktualizuje jedno urządzenie pod blokadą serwera; folder `GitHub/` (`GitHub/<repo>/` przy kilku); plik usunięty na GitHubie zostaje oznaczony; limity 2000 plików / 1 MB / 20 MB; sprawdzanie co 5/15 min; bez udostępniania tokenu członkom ([GITHUB.md](GITHUB.md) §13)
