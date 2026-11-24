# Architektura — jak aplikacja działa

Ten dokument opisuje dokładnie, co dzieje się w aplikacji: z jakich części się składa, gdzie leżą dane i co się dzieje krok po kroku w każdej ważnej sytuacji. Wymagania są w [PLAN.md](PLAN.md), luki i decyzje w [UWAGI.md](UWAGI.md), kolejność prac w [PLAN-BUDOWY.md](PLAN-BUDOWY.md).

Miejsca oznaczone **[decyzja]** to propozycje, które trzeba potwierdzić (lista w UWAGI.md).

---

## 1. Najważniejsza idea w jednym akapicie

Prawdziwa treść notatki żyje w dokumencie CRDT (Yrs), zapisanym w bazie SQLite w `.notes-sync/`. W przestrzeni otwartej plik `.md` na dysku jest **rzutem** tego dokumentu (w przestrzeni zaszyfrowanej plików `.md` nie ma — §4.17): aplikacja go generuje i pilnuje, żeby był aktualny, a gdy ktoś zmieni go z zewnątrz (Obsidian), zamienia tę zmianę z powrotem na operacje CRDT. Każda edycja to mała, podpisana wiadomość w dzienniku przestrzeni. Synchronizacja polega wyłącznie na wymianie brakujących wiadomości między urządzeniami — lokalnie, przez sieć LAN albo przez internet.

Dzięki temu ten sam mechanizm obsługuje: zapis lokalny, historię, pracę offline, wspólną edycję i uprawnienia.

---

## 2. Części aplikacji

```text
┌──────────────────────────── Okno aplikacji (Tauri 2) ────────────────────────────┐
│  Interfejs (TypeScript, WebView)                                                  │
│   ├─ drzewo plików, karty, panele, pasek stanu, paleta poleceń                    │
│   └─ edytor CodeMirror 6 + Yjs (kopia dokumentu otwartej notatki)                 │
│                    ▲  aktualizacje Yjs (bajty) + zdarzenia  │                      │
│                    │            IPC Tauri                   ▼                      │
│  Rdzeń (Rust)                                                                     │
│   ├─ core:  przestrzeń, notatki (Yrs), dziennik zmian, SQLite, zapis .md,         │
│   │         obserwator folderu, wersje, wyszukiwanie, linki                       │
│   └─ sync:  tożsamość i klucze, lista uczestników, szyfrowanie, protokół P2P      │
└───────────────────────────────────────────────┬──────────────────────────────────┘
                                                │ iroh (QUIC): LAN / bezpośrednio / pośrednik
                                       inne urządzenia uczestników
```

| Część | Odpowiada za | Główne biblioteki |
|---|---|---|
| Interfejs | wygląd, klawiatura, edytor | CodeMirror 6, `yjs`, `y-codemirror.next`, czysty TypeScript, bez frameworka (decyzja 2026-10-21) |
| `core` | wszystko, co lokalne; nie wie nic o sieci | `yrs`, `rusqlite` (z FTS5), `notify`, `similar`/`diffy`, `pulldown-cmark`, `zstd` |
| `sync` | kto jest kim, szyfrowanie, wymiana wiadomości | `iroh`, `iroh-blobs`, `ed25519-dalek`, `chacha20poly1305`, `crypto_box`, `bip39`, `blake3`, `keyring` |
| szyfrowanie na dysku (`core`) | przestrzeń zaszyfrowana (§4.17) | `rusqlite` z `bundled-sqlcipher`, `argon2`, `zeroize` |
| wersja webowa | ten sam `core` + `sync` jako WASM w Web Workerze, ten sam interfejs; dane w OPFS, sync zawsze przez węzeł ([WEB.md](WEB.md)) | `wasm-bindgen`, SQLite WASM (OPFS) |
| `node` (osobny program) | węzeł przechowujący: trzyma zaszyfrowane wiadomości, gdy nikt nie jest online (§4.18) | `iroh`, `iroh-relay`, `rusqlite` + kod protokołu z `sync` |

Zasada: **rdzeń w Ruście jest źródłem prawdy**. Interfejs trzyma tylko kopię otwartych notatek, żeby pisanie nigdy nie czekało na IPC. Yjs (JavaScript) i Yrs (Rust) mają ten sam format binarny, więc przesyłają między sobą zwykłe bajty aktualizacji.

---

## 3. Dane na dysku

```text
Moje notatki/
├── Projekty/Plan.md              ← czysty Markdown, czytelny bez aplikacji
├── assets/szkic.png
└── .notes-sync/
    ├── space.db                  ← jedna baza SQLite (tryb WAL, synchronous=FULL)
    └── trash/                    ← treść notatek w koszu (do przywrócenia)
```

Tabele w `space.db`:

| Tabela | Zawartość |
|---|---|
| `meta` | dokument Yrs „metadane przestrzeni”: mapa `id notatki → {ścieżka, usunięta?}`, lista załączników |
| `messages` | dziennik wiadomości: `(autor_urządzenie, seq) → podpisana, zaszyfrowana paczka` |
| `note_state` | ostatni stan Yrs każdej notatki (po kompaktowaniu dziennika) |
| `file_state` | dla każdej notatki: tekst i skrót (hash) ostatnio zapisanego `.md`, `mtime`, rozmiar |
| `versions` | wersje: pełny tekst (zstd), autor, czas, powód |
| `fts` | indeks FTS5 (tytuł, treść), tokenizer `unicode61 remove_diacritics 2` (polskie znaki) |
| `links`, `tags` | linki między notatkami i tagi — do odnośników zwrotnych i filtrów |
| `acl_log` | podpisany dziennik uczestników i kluczy (przestrzenie współdzielone) |

**Tożsamość notatki** [decyzja, UWAGI pkt 3]: proponuję **nie** dopisywać `id` do plików. Identyfikator żyje w `meta` (mapa id → ścieżka) i synchronizuje się jak wszystko inne. Pliki użytkownika pozostają nietknięte; nagłówek YAML służy tylko na właściwości, które użytkownik sam chce mieć (`tags`, `title` — Obsidian je rozumie).

Bez folderu `.notes-sync` pliki `.md` są kompletne — tracisz tylko historię i synchronizację.

Powyższe dotyczy **przestrzeni otwartej**. Przestrzeń zaszyfrowana wygląda na dysku inaczej:

```text
Sejf/
└── .notes-sync/
    ├── space.db                  ← cała baza zaszyfrowana (SQLCipher): treść, nazwy, indeks, historia, kosz
    ├── blobs/                    ← załączniki, każdy zaszyfrowany, nazwa = skrót szyfrogramu
    └── keyfile                   ← klucz bazy zaszyfrowany hasłem (i osobno frazą odzyskiwania)
```

Szczegóły w §4.17.

---

## 4. Co się dzieje krok po kroku

### 4.1. Uruchomienie aplikacji (cel: < 2 s przy 10 000 notatek)

1. Otwórz `space.db`, wczytaj `meta` → drzewo plików (same ścieżki, ~10 000 krótkich napisów — milisekundy).
2. Narysuj okno, otwórz ostatnią notatkę z `note_state` (nie z pliku).
3. **W tle**: `stat` każdego pliku `.md` (bez czytania treści) i porównanie `mtime` + rozmiaru z `file_state`. Tylko pliki, które się różnią, są czytane i traktowane jak zmiana zewnętrzna (4.4). Nowe pliki → nowe notatki. Brakujące → usunięte albo przeniesione (4.6).
4. W tle: połączenie z uczestnikami (4.7), dokończenie indeksowania.

Nic z kroków 3–4 nie blokuje edytora.

### 4.2. Wpisuję literę

```text
klawisz → CodeMirror → Yjs (w WebView) ──aktualizacja──▶ IPC ──▶ rdzeń: Yrs notatki
                                                                    │
                     pasek: „Zapisano lokalnie” ◀── commit SQLite ◀─┤ zbieranie ~300 ms
                                                                    ├─▶ zapis .md (po 500 ms ciszy)
                                                                    ├─▶ indeks FTS, linki (w tle)
                                                                    └─▶ wysyłka do uczestników
```

1. CodeMirror zmienia tekst natychmiast — ekran nie czeka na nic.
2. Yjs tworzy małą aktualizację binarną i wysyła ją przez IPC do rdzenia.
3. Rdzeń stosuje ją w dokumencie Yrs i zbiera aktualizacje przez ~300 ms (łączy je w jedną — `merge_updates`).
4. Paczka staje się **wiadomością**: dostaje kolejny numer `seq` tego urządzenia, jest szyfrowana (w przestrzeni współdzielonej) i podpisywana kluczem urządzenia.
5. Wiadomość trafia do tabeli `messages` w jednej transakcji SQLite z `fsync`. **Dopiero teraz** pasek stanu pokazuje „Zapisano lokalnie” (PLAN §8).
6. Po 500 ms bez pisania rdzeń zapisuje plik `.md` (4.3), aktualizuje indeks i linki.
7. Jeśli są połączeni uczestnicy, wiadomość od razu do nich leci (4.8).

Awaria w dowolnym momencie po kroku 5 nie traci tekstu: przy starcie rdzeń widzi, że `.md` jest starszy od stanu w bazie, i zapisuje go ponownie.

### 4.3. Bezpieczny zapis pliku `.md`

1. Zapisz treść do `Plan.md.tmp-<losowe>` w **tym samym** folderze.
2. `fsync` pliku.
3. Podmień: Linux `rename`, Windows `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`. Na Linuxie dodatkowo `fsync` folderu.
4. Windows: jeśli inny program trzyma plik (błąd współdzielenia), ponawiaj z rosnącym odstępem; po kilku próbach pokaż „Plik .md niezapisany — ponawiam”. Treść jest już bezpieczna w bazie.
5. Zapisz w `file_state` tekst, skrót, `mtime` i rozmiar tego zapisu — to „ostatni znany stan” do wykrywania zmian zewnętrznych i ignorowania własnych zapisów.

Plik nigdy nie jest w połowie zapisany: albo stara wersja, albo nowa.

Notatka, której treść nie jest jeszcze w pamięci, dostaje `.md` dopiero po załadowaniu: aplikacja w tle opróżnia kolejkę `load_pending`, a notatka znana tylko z meta dostaje pusty plik tak samo. Do tego czasu treść jest bezpieczna w `space.db`, a istniejące pliki zostają nietknięte. Wiadomość, którą Yrs nie może zastosować, jest odrzucana i pomijana, nie psuje notatki ani otwarcia przestrzeni.

### 4.4. Ktoś zmienił plik w Obsidianie

Obserwator folderu (`notify`) zgłasza zmianę. Po krótkim odczekaniu (200 ms, edytory zapisują w kilku krokach) rdzeń czyta plik.

Trzy teksty:
- **baza** — to, co aplikacja ostatnio zapisała (`file_state`),
- **zewnętrzny** — obecna treść pliku,
- **nasz** — obecna treść CRDT (mogła się zmienić, np. przez współpracownika).

| Sytuacja | Działanie |
|---|---|
| skrót pliku = skrót ostatniego zapisu | to nasz własny zapis — ignoruj |
| zewnętrzny = nasz | nic do zrobienia, uaktualnij `file_state` |
| nasz = baza (u nas nic się nie zmieniło) | zapisz wersję „przed zmianą zewnętrzną”, zastosuj różnicę nasz → zewnętrzny jako operacje CRDT |
| obie strony zmienione, różne fragmenty | scal trójstronnie (jak `git merge`, po liniach); zapisz wersję; zastosuj różnicę nasz → wynik |
| obie strony zmieniły ten sam fragment | **konflikt**: zapisz tekst zewnętrzny jako wersję, wstrzymaj zapisywanie tego pliku, pokaż ekran porównania |

W konflikcie nic nie jest nadpisywane: na dysku zostaje wersja z Obsidiana, w aplikacji wersja CRDT (ze zmianami współpracowników). Użytkownik wybiera na ekranie porównania całość albo poszczególne fragmenty; wynik staje się nową edycją i wznawia zapisywanie.

Różnicę do CRDT stosuje się znak po znaku (biblioteka `similar`), żeby zmienić tylko to, co faktycznie się zmieniło — kursory współpracowników zostają na miejscu.

**Uwaga:** nie należy jednocześnie synchronizować tego samego folderu innym narzędziem (Dropbox, Obsidian Sync, Syncthing). Każde z nich widziałoby zmiany drugiego jako zewnętrzne — powstaną duplikaty.

### 4.5. Dwie osoby piszą w tej samej notatce

1. Ania pisze → jej rdzeń tworzy wiadomość (4.2) i wysyła ją do Bartka.
2. Rdzeń Bartka sprawdza podpis i uprawnienia (4.10), odszyfrowuje, stosuje w Yrs.
3. Jeśli Bartek ma tę notatkę otwartą, rdzeń przekazuje aktualizację do jego Yjs w WebView; CodeMirror przerysowuje tekst, kursor Bartka zostaje na miejscu.
4. Kursory i zaznaczenia (awareness) to osobne, ulotne wiadomości: szyfrowane, ale **nie zapisywane** w dzienniku; znikają po 30 s bez odświeżenia.

CRDT nie zna konfliktów: dwa wpisy w tym samym miejscu oba zostają (jeden za drugim, w ustalonej kolejności). Ekran porównania dotyczy tylko zmian z zewnętrznych edytorów (4.4).

### 4.6. Zmiana nazwy, przeniesienie, usunięcie

Wszystko to zmiany w dokumencie `meta` — synchronizują się jak edycje:

- **Zmiana nazwy / przeniesienie w aplikacji:** `meta[id].path = nowa ścieżka`, potem rename pliku na dysku. Dwie osoby jednocześnie zmieniają nazwę → wygrywa jedna (ostatni zapis w mapie Yrs), u obu ten sam wynik.
- **Ta sama ścieżka u dwóch osób naraz** (obie utworzyły `Pomysły.md`): druga notatka dostaje `Pomysły (2).md`. Nic nie ginie.
- **Przeniesienie w Obsidianie / menedżerze plików:** obserwator widzi zniknięcie pliku A i pojawienie się pliku B; jeśli w ciągu ~2 s i skróty treści się zgadzają, to przeniesienie (to samo id). Inaczej: usunięcie + nowa notatka.
- **Usunięcie:** `meta[id].deleted = czas`, plik znika z dysku (Obsidian go nie widzi), treść ląduje w koszu. Znacznik usunięcia zostaje na zawsze — stara kopia offline nie przywróci notatki (PLAN §6). Przywrócenie z kosza = skasowanie znacznika i ponowny zapis pliku.
- **Trwałe usunięcie** (`purge_note`, „Usuń na zawsze”; `purge_trash` po otwarciu przestrzeni dla notatek usuniętych wcześniej niż `TRASH_DAYS` = 183 dni): znacznik usunięcia (`deleted`) zostaje, a `purged` dostaje czas. Notatka z `purged` nie jest żywa, nie wchodzi do kosza i nie da się jej przywrócić ani przenieść, także gdy starsze urządzenie zmieni jej nazwę lub treść (ukrywa ją każde urządzenie, które zna `purged`). Usuwane lokalnie: ścieżka w `meta`, tekst w pamięci, wersje historii (`versions`), `file_state`, `file_base`, konflikty, zużycie i plik `.md`. **Zostaje:** zaszyfrowane wiadomości notatki w dzienniku (`messages`, `doc_index`). Dziennik jest podpisaną historią, którą mają też inne urządzenia, a luka w numerach `seq` sprawiłaby, że wiadomości wróciłyby przy synchronizacji. Kto ma klucz przestrzeni, może je odczytać. Zostają też znaczniki `deleted` i `purged` w `meta`.

### 4.7. Uruchamiam aplikację po tygodniu offline

1. Mój dziennik ma wiadomości `(mój_laptop, seq 1..812)`; przez tydzień offline doszły `813..950`.
2. Łączę się z Bartkiem. Wymieniamy **wektory wersji** — dla każdego urządzenia: najwyższy `seq`, jaki mamy. To kilka liczb niezależnie od liczby notatek.
3. Każdy wysyła drugiemu tylko brakujące wiadomości; Yrs scala je bez konfliktów.
4. Zmienione notatki są zapisywane do `.md` w tle.

Wiadomości są przekazywane dalej z zachowaniem oryginalnego podpisu: jeśli Ania jest offline, ale Bartek ma jej zmiany, dostaję je od Bartka — i nadal wiem, że napisała je Ania.

**Nikt inny nie jest online?** Ania przy wyjściu z aplikacji (i co 5 minut w trakcie pracy) wysyła swoje wiadomości do **węzła przechowującego** (§4.18). Bartek po uruchomieniu pobiera je stamtąd — Ania nie musi być włączona.

### 4.8. Jak urządzenia się znajdują i łączą (iroh)

- Każde urządzenie to punkt końcowy iroh; jego adres to klucz publiczny urządzenia.
- Lista „z kim się łączyć” pochodzi z dziennika uczestników (4.10) — znamy klucze wszystkich urządzeń przestrzeni.
- **Ta sama sieć:** wykrywanie przez mDNS, połączenie bezpośrednie.
- **Różne sieci:** urządzenia nie łączą się ze sobą wprost — każde łączy się wychodząco z **węzłem przechowującym** (§4.18), który zapisuje każdą wiadomość i od razu przekazuje ją pozostałym. Węzeł widzi tylko szyfrogram (SZYFROWANIE §3). Gdy węzeł jest nieosiągalny, iroh próbuje połączenia bezpośredniego albo przez relay — jako zapas [decyzja].
- Na połączeniu działa własny protokół `notes-sync/1`:
  1. `Hello`: id przestrzeni, certyfikat urządzenia, skrót głowy dziennika uczestników. Obcy (spoza listy) — rozłącz.
  2. Synchronizacja dziennika uczestników (najpierw — bo od niego zależą uprawnienia).
  3. Wymiana wektorów wersji i brakujących wiadomości (4.7).
  4. Na żywo: każda nowa wiadomość od razu do wszystkich połączonych; wiadomości kursorów.

Przy kilku osobach każdy łączy się z każdym — nie trzeba plotkowania (gossip). Węzeł przechowujący (§4.18) mówi tym samym protokołem: dla urządzeń w różnych sieciach jest drogą na żywo, dla urządzeń w jednym LAN — tylko okresową kopią zapasową. Pełny opis sieci (drogi połączeń, adresy, domena, porty): [SIEC.md](SIEC.md).

### 4.9. Tożsamość, klucz odzyskiwania i własne urządzenia

- **Klucz użytkownika** (Ed25519) powstaje z **frazy odzyskiwania** (24 słowa, BIP39) pokazanej przy pierwszym uruchomieniu.
- **Klucz urządzenia** — losowy, osobny na każdej instalacji. Klucz użytkownika podpisuje go („certyfikat urządzenia”). Oba trzymane w systemowym magazynie haseł (Secret Service na Linuxie, Menedżer poświadczeń w Windows).
- **Drugi własny komputer:** zaproszenie samego siebie (4.11) albo wpisanie frazy odzyskiwania.
- **Zgubiony laptop:** z innego urządzenia podpisuję unieważnienie jego certyfikatu; uczestnicy przestają przyjmować jego wiadomości.
- **Wszystkie urządzenia zgubione:** fraza odtwarza klucz użytkownika; klucze przestrzeni są zaszyfrowane dla klucza użytkownika w dzienniku uczestników, więc dowolny inny uczestnik (albo przyszły węzeł przechowujący) odda je po połączeniu. Bez frazy i bez urządzeń — dane współdzielone są nie do odszyfrowania (to ostrzeżenie z PLAN §4). W przestrzeni otwartej lokalne pliki `.md`, jeśli dysk przetrwał, są zawsze czytelne. W zaszyfrowanej — tylko z hasłem albo frazą (§4.17).

### 4.10. Uprawnienia i szyfrowanie (zamyka UWAGI pkt 1)

Szczegółowy format kluczy i wiadomości, zawartość węzła i plan wdrożenia: [SZYFROWANIE.md](SZYFROWANIE.md).

**Dziennik uczestników** (`acl_log`): łańcuch wpisów, każdy podpisany kluczem właściciela i zawierający skrót poprzedniego. Tylko właściciel go zmienia, więc nie ma konfliktów. Wpisy:

| Wpis | Treść |
|---|---|
| `Utwórz` | id przestrzeni, właściciel |
| `Dodaj` | klucz użytkownika, rola (edytor/czytelnik), klucz przestrzeni zaszyfrowany dla tego użytkownika |
| `Zmień rolę` | klucz użytkownika, nowa rola |
| `Dodaj węzeł` / `Usuń węzeł` | klucz i adres węzła przechowującego; **bez** klucza przestrzeni |
| `Usuń` | klucz użytkownika, **nowa epoka klucza**: nowy klucz przestrzeni zaszyfrowany osobno dla każdego pozostałego |

**Wiadomość** (jedna paczka edycji):

```text
nagłówek:   id przestrzeni, urządzenie autora + certyfikat, seq, epoka klucza, nonce
szyfrogram: XChaCha20-Poly1305(klucz przestrzeni[epoka], nagłówek jako AAD,
            { id notatki, aktualizacja Yrs })      ← nawet id notatki jest ukryte
podpis:     Ed25519(klucz urządzenia, nagłówek + szyfrogram)
```

Każde urządzenie przed zastosowaniem wiadomości sprawdza po kolei:

1. podpis zgadza się z kluczem urządzenia,
2. certyfikat urządzenia podpisał użytkownik i nie jest unieważniony,
3. ten użytkownik jest **teraz** w dzienniku jako edytor lub właściciel,
4. szyfrogram odszyfrowuje się kluczem z podanej epoki.

Jedna porażka = wiadomość odrzucona. Czytelnik ma klucz i może czytać, ale jego zmiany są odrzucane przez wszystkich, a w interfejsie edytor jest tylko do odczytu.

**Usunięty uczestnik wraca z offline** [decyzja, UWAGI pkt 2]: proponuję najprostszą bezpieczną regułę — po usunięciu nikt nie przyjmuje jego wiadomości, także tych napisanych wcześniej, ale dostarczonych po fakcie (czas na jego komputerze jest niewiarygodny). Jego lokalna praca zostaje u niego.

**Granica szyfrowania (PLAN §7):** wszystko, co opuszcza urządzenie, jest szyfrowane zawsze. Na dysku: w przestrzeni otwartej `.md` i `space.db` są jawne (chroni je szyfrowanie dysku), w zaszyfrowanej — nic nie jest jawne (§4.17).

### 4.11. Zaproszenie współpracownika

1. Właściciel klika „Zaproś”, wybiera rolę. Powstaje **bilet**: id przestrzeni, adres urządzenia właściciela, jednorazowy sekret, rola, ważność 24 h. Do skopiowania jako tekst (i jako kod QR).
2. Odbiorca wkleja bilet. Jego aplikacja łączy się z właścicielem i dowodzi znajomości sekretu (HMAC sekretu z kluczem odbiorcy — sam sekret nie leci przez sieć).
3. Obie aplikacje pokazują ten sam **kod bezpieczeństwa** (np. 6 cyfr wyliczonych z obu kluczy). Właściciel porównuje go z odbiorcą (telefon, czat) i zatwierdza. To chroni przed podstawieniem urządzenia.
4. Właściciel dopisuje wpis `Dodaj` z kluczem przestrzeni zaszyfrowanym dla odbiorcy.
5. Odbiorca dostaje dziennik uczestników i **paczkę startową** (aktualny stan wszystkich notatek + wektor wersji), a potem bieżące wiadomości. Aplikacja zapisuje pliki `.md` w wybranym folderze.

Gdy właściciel jest offline, prośba o dołączenie czeka na węźle (§4.18). Właściciel zatwierdza ją (z kodem bezpieczeństwa) po włączeniu aplikacji, a odbiorca pobiera wtedy wszystko z węzła — obie strony nie muszą być online jednocześnie, poza porównaniem kodu.

### 4.12. Usunięcie uczestnika

1. Właściciel dopisuje `Usuń` z nową epoką klucza dla pozostałych.
2. Od tej chwili nowe wiadomości są szyfrowane nowym kluczem; usunięty nie odczyta przyszłych zmian.
3. To, co już pobrał, zostaje u niego — tego nie da się cofnąć (PLAN §7).

### 4.13. Historia wersji

- **Wersja = pełny tekst notatki** (skompresowany), autor, czas, powód. Notatki to tekst, więc to tanie i proste; nie zależymy od wewnętrznej historii CRDT.
- Kiedy powstaje: po 2 min ciszy po serii edycji, przed włączeniem zmiany zewnętrznej, przed przywróceniem, przy rozwiązaniu konfliktu.
- **Porównanie:** zwykły diff dwóch tekstów.
- **Przywrócenie:** różnica obecny → stary tekst stosowana jako zwykła edycja CRDT. Powstaje nowa wersja, późniejsza historia zostaje (PLAN §8), a współpracownicy dostają przywrócenie jak każdą inną zmianę.
- Wersje są lokalne dla urządzenia (nie są synchronizowane) [decyzja] — każdy uczestnik ma własną historię tego, co widział.

### 4.14. Kompaktowanie (zamyka UWAGI pkt 6)

Dziennik wiadomości rośnie z każdą literą. Gdy wszystkie znane urządzenia potwierdziły (przez wektory wersji), że mają wiadomości do numeru N, rdzeń wpisuje je w `note_state` (stan Yrs z odśmiecaniem) i usuwa z `messages`. Urządzenie, które nie odezwało się przez 30 dni, przestaje blokować kompaktowanie — gdy wróci, dostaje paczkę startową jak nowy uczestnik.

### 4.15. Wyszukiwanie, linki, tagi

- **Szybkie otwieranie (Ctrl+P):** dopasowanie rozmyte po tytułach trzymanych w pamięci (10 000 tytułów to ułamek megabajta).
- **Wyszukiwanie w treści:** zapytanie FTS5 z rankingiem; indeks aktualizowany w tle po każdym zapisie.
- **Linki:** po zapisie `pulldown-cmark` wyciąga linki `[tekst](ścieżka.md)` oraz `[[wikilinki]]` (zgodność z Obsidianem) do tabeli `links`. Odnośniki zwrotne = zapytanie „kto linkuje do mnie”.
- **Tagi:** z nagłówka YAML i `#tagów` w treści.
- **Graf** (jak w Obsidianie): węzły = notatki (opcjonalnie tagi), krawędzie = tabela `links`. Globalny widok całej przestrzeni i lokalny (sąsiedzi otwartej notatki do głębokości N), filtr po folderze/tagu, kliknięcie otwiera notatkę. Rysowany na `<canvas>` z układem siłowym `d3-force`, który liczy się w Web Workerze (`ui/src/graphworker.ts`), żeby 10 000 notatek nie tworzyło 10 000 elementów DOM i żeby układ nie blokował strony. Decyzja z 2026-10-21.

### 4.16. Załączniki

Obrazy i pliki leżą normalnie w `assets/`, linkowane względnie. Do synchronizacji: plik jest szyfrowany kluczem przestrzeni, a zaszyfrowane bajty przesyłane przez `iroh-blobs` (weryfikacja skrótem BLAKE3 w trakcie przesyłu). W `meta` zapisuje się `ścieżka → skrót`. Duże pliki idą strumieniowo, bez blokowania.

**Podgląd plików (przeglądarka).** Okno w stylu Quick Look nad aplikacją pokazuje prawie każdy plik serwera: obrazy, PDF,
Office (także stare `.doc` i `.ppt`), kod, 3D, chmury punktów, DXF/DWG, audio i pierwszą klatkę wideo. Aplikacja
odszyfrowuje plik, a parsowanie i rysowanie odbywa się wyłącznie w ramce `/preview/` z `sandbox` i ostrą CSP (bez
pochodzenia, bez sieci, bez kluczy; nowa ramka dla każdego pliku). Biblioteki są w osobnej budowie Vite ładowanej na
żądanie, własne parsery w `crates/preview` (WASM). Szczegóły: [PODGLAD.md](PODGLAD.md), [PODGLAD-PLAN.md](PODGLAD-PLAN.md).

### 4.16a. Tabele z formułami

Tabela to zwykła tabela Markdown (GFM) w treści notatki — w Obsidianie dalej jest tabelą. Aplikacja dokłada adresy jak w Excelu i formuły.

```text
     A            B        C          D
1  | Zadanie    | Start      | Koniec     | Dni         |      ← wiersz nagłówka = wiersz 1
2  | Projekt    | 2026-10-01 | 2026-10-19 | =C2-B2      |      → 18
3  | Testy      | 19.10.2026 | =B3+14     | =C3-B3      |      → 02.11.2026, 14
4  | **Razem**  |            |            | =SUMA(D2:D3)|      → 32
```

- **Adresy:** kolumny A, B, C…, wiersze 1, 2, 3… (nagłówek to wiersz 1). Litery i numery pokazuje edytor na marginesie, gdy kursor jest w tabeli — **nie ma ich w pliku**.
- **Formuła** to treść komórki zaczynająca się od `=`. W pliku `.md` zapisana jest formuła (Obsidian pokaże `=C2-B2`), w aplikacji wynik; po wejściu kursorem w komórkę — formuła do edycji.
- **Wyniki nie są zapisywane** ani synchronizowane — liczy je każde urządzenie przy wyświetlaniu. CRDT scala więc tylko tekst formuł i nie ma konfliktów „dwóch wyników”.
- **Działania:** `+ - * / ^`, nawiasy, porównania `= <> < > <= >=`, `&` (łączenie tekstu), zakresy `B2:B9`.
- **Funkcje (wersja 1)** — nazwy polskie jak w Excelu PL i angielskie jako synonimy: `SUMA/SUM`, `ŚREDNIA/AVERAGE`, `MIN`, `MAX`, `ILE.LICZB/COUNT`, `ZAOKR/ROUND`, `JEŻELI/IF`, `DZIŚ/TODAY`, `DATA/DATE`, `DNI/DAYS`, `ROK/YEAR`, `MIESIĄC/MONTH`, `DZIEŃ/DAY` [decyzja: lista].
- **Daty:** rozpoznawane `2026-10-19` i `19.10.2026`. Data − data = liczba dni, data ± liczba = data. Wynik datowy w formacie komórek źródłowych.
- **Liczby:** przecinek i kropka dziesiętna (`3,5` i `3.5`); separator argumentów `;` jak w Excelu PL [decyzja].
- **Błędy** zamiast awarii: `#ADR!` (zły adres), `#DZIEL/0!`, `#NAZWA?`, `#ARG!`, `#CYKL!` (formuła zależy sama od siebie).
- **Silnik:** mały, własny moduł w `core` (parser + ewaluator, czysta funkcja „komórki → wyniki”, bez stanu). Ten sam kod liczy na komputerze i w przeglądarce (WASM, §4.19). Tabele są małe — przeliczenie całej tabeli po każdej zmianie, cel < 1 ms na 1000 komórek.
- **Edycja:** Tab/Shift+Tab — następna/poprzednia komórka, Enter — wiersz niżej, przyciski „dodaj wiersz/kolumnę”. Kolumny wyrównuje **wyświetlanie**, nie tekst: aplikacja nie przepisuje całej tabeli dla ładnych `|`, bo przy wspólnej edycji nadpisałoby to zmiany drugiej osoby w innych komórkach.
- **Później:** odwołania do innych tabel i notatek (np. `=Budżet!B4`), formatowanie walut.

### 4.16b. Kalendarz (rodzaj notatki)

Kalendarz to zwykła notatka `.md` oznaczona w nagłówku YAML `typ: kalendarz`. Interfejs pokazuje ją jako kalendarz w stylu Google Calendar (miesiąc / tydzień / dzień), a Ctrl+E i tryb źródłowy pokazują tekst. Każde wydarzenie to jedna linia listy, więc dwie osoby dodające wydarzenia jednocześnie łączą się bez konfliktu (CRDT łączy linie), a Obsidian widzi czytelną listę.

```markdown
---
typ: kalendarz
---
- 2026-10-22 10:00-11:00 Spotkanie zespołu 🔁 FREQ=WEEKLY;BYDAY=WE,FR ⛔ 2026-11-05 🎨 niebieski ^e7k2p
- 2026-10-24 Urodziny Ani 🔁 FREQ=YEARLY ^e1q9x
- 2026-10-30 18:00-2026-11-01 12:00 Wyjazd ^e4m0c
    Opis wydarzenia to wcięte linie pod wydarzeniem.
```

- **Początek:** `RRRR-MM-DD` (cały dzień) albo `RRRR-MM-DD GG:MM`. **Koniec** (opcjonalny) po `-`: `GG:MM` (ten sam dzień) albo `RRRR-MM-DD[ GG:MM]`. Bez końca: wydarzenie godzinne trwa 1 h, całodniowe 1 dzień.
- **Powtarzanie:** po `🔁` reguła RRULE z iCalendar (RFC 5545) — ta sama, której używa Google Calendar, więc przyszła synchronizacja z Google nie wymaga tłumaczenia. Obsługiwane: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `BYMONTH`, `BYDAY` (także `2TU`, `-1FR` w miesięcznych, `4TH` przy `YEARLY;BYMONTH=11`), `BYMONTHDAY`, `COUNT`, `UNTIL=RRRRMMDD`, `WKST=MO`. Wyjątki (usunięte wystąpienia) po `⛔` jako daty po przecinku. Każda inna część reguły (`BYSETPOS`, `BYWEEKNO`, nieznane klucze, błędne wartości) zostaje w linii dosłownie i jest zapisywana z powrotem, więc edycja nie przepisuje reguły. Takie wydarzenie (`ruleSupported: false`) pokazuje tylko pierwsze wystąpienie, a jego powtarzanie jest tylko do odczytu.
- **Przypomnienie** po `🔔`: liczba minut przed początkiem (1–10080), np. `🔔 15`. Zapisuje się po kolorze, przed `^id`. Niepoprawna wartość (`🔔 0`, `🔔 abc`) nie jest znacznikiem i zostaje w tytule, więc nic nie ginie. Przypomnienie to komunikat w otwartej aplikacji, tak jak w organizacjach: co minutę, tylko w przestrzeni, która nie jest organizacją (organizacje mają własne), raz na wystąpienie (`ui/src/calendar/reminders.ts`, `main.ts`). Aplikacja nie prosi o systemowe powiadomienia. Nowe wydarzenie z godziną ma domyślnie 15 minut, a całodniowe nie ma przypomnienia.
- **Kolor** po `🎨` (nazwa z palety interfejsu). **Id** `^e…` jak blok Obsidiana: interfejs zmienia i usuwa wydarzenie po id, nie po numerze linii. Wydarzenie bez `^id` dostaje w silniku tymczasowe id `#L<numer linii>`, którego nie zapisuje się w linii; interfejs nadaje prawdziwe id przy pierwszej edycji.
- **Tytuł zaczynający się od godziny** (`10:00 standup` całodniowe) zapisuje się z ukośnikiem: `10\:00 standup` (Obsidian pokazuje `10:00`), żeby wydarzenie nie wczytało się jako godzinne. Puste linie w opisie są częścią opisu, jeśli po nich idzie wcięta linia tekstu.
- **Zmiana jednego wystąpienia** powtarzanego wydarzenia: wyjątek `⛔` w serii + nowe pojedyncze wydarzenie. „To i następne”: `UNTIL` w starej serii + nowa seria.
- **Czas lokalny bez strefy** [skrót: do synchronizacji z Google, wtedy `TZID`].
- **Silnik:** moduł `calendar` w `core` (parsowanie linii, zapis linii, rozwijanie powtórzeń w zakresie dat), w przeglądarce przez WASM. Limity, żeby złośliwa reguła nie zawiesiła aplikacji: zapytanie najwyżej na 3700 dni, najwyżej 10 000 wystąpień, budżet pracy 1 000 000 jednostek na zapytanie. Budżet dzieli się równo między serie z regułą (każda dostaje co najmniej 10 000). Odpowiedź ma flagę `truncated`: `true`, gdy któryś limit przerwał rozwijanie albo wynik ucięto, i wtedy interfejs powinien to pokazać. Serie `COUNT` są przewijane bez liczenia od początku, gdy każdy okres ma tyle samo wystąpień (dzienne bez `BY*`, tygodniowe bez filtrów miesiąca, miesięczne i roczne bez `BY*`, z dniem startu do 28 i bez 29 lutego).
- **„Mój kalendarz”** (przycisk kalendarza na pasku po lewej) zbiera w jednym widoku wydarzenia ze wszystkich przestrzeni: kalendarz z „Moich notatek” (notatka `Kalendarz.md` w sejfie osobistym, widzi ją tylko jej właściciel), wydarzenia organizacji, które widzi ta osoba, i jej zadania z terminem (`ui/src/allspaces.ts`). „Utwórz” albo kliknięcie w pusty termin pyta, gdzie zapisać wydarzenie (`ui/src/calendar/target.ts`): „Moje notatki” albo organizacja lub wspólny sejf, w którym ta osoba ma rolę wyższą niż czytelnik. Każda opcja mówi, kto zobaczy wydarzenie. W otwartej przestrzeni od razu otwiera się okno wydarzenia: w „Moich notatkach” w notatce kalendarza (tworzonej przy pierwszym wydarzeniu), w organizacji na stronie Kalendarze. Inna przestrzeń najpierw się otwiera (strona przeładowuje się), a w `sessionStorage` czeka tylko data i godzina, nigdy tytuł. Po załadowaniu przestrzeni okno wydarzenia otwiera się samo. Wpis starszy niż 2 minuty albo z innej przestrzeni jest kasowany.
- **Import i eksport `.ics`** (iCalendar, RFC 5545) w kalendarzu notatki: przyciski „Importuj .ics” i „Eksportuj .ics” w nagłówku (`ui/src/calendar/ics.ts`). Eksport zapisuje czas lokalny bez strefy, tak jak notatka. Import przyjmuje daty całodniowe, czas lokalny, czas UTC (`Z`, przeliczany na lokalny) i `TZID`, przy czym strefa jest pomijana, a godzina czytana jako lokalna [skrót: do czasu, gdy wydarzenia zapamiętują strefę]. Koniec wydarzenia bierze z `DTEND` albo `DURATION`. Pomija wydarzenia anulowane, zadania i alarmy. `EXDATE` nie jest importowane [skrót]. Plik ma najwyżej 5 MiB i 5000 wydarzeń, a zepsute wydarzenie jest pomijane i liczone. Cały import to jeden krok cofania. W notatce tylko do odczytu nie ma importu.
- **Później:** synchronizacja z kontem Google (OAuth, Google Calendar API — tokeny tylko lokalnie, węzeł ich nie widzi).

### 4.17. Przestrzeń zaszyfrowana

Rodzaj przestrzeni wybiera się przy jej tworzeniu. Sieć, CRDT, dziennik wiadomości i uprawnienia działają identycznie w obu — różni się tylko to, co trafia na dysk.

**Klucze — dwa poziomy:**

```text
hasło ──Argon2id──▶ klucz z hasła ──┐
fraza odzyskiwania ─▶ klucz użytk. ─┼─▶ odszyfrowuje keyfile ─▶ klucz bazy (losowy, 32 B, tylko na tym urządzeniu)
systemowy magazyn haseł (opcja) ────┘                                  │
                                                                       ▼
                                           SQLCipher: space.db  +  XChaCha20: blobs/
```

- **Klucz bazy** jest lokalny dla urządzenia i nigdy nie opuszcza komputera. To nie jest klucz przestrzeni z §4.10 — tamten szyfruje wiadomości w sieci.
- Ten sam klucz bazy jest zaszyfrowany kilka razy (w `keyfile`): hasłem i frazą odzyskiwania, opcjonalnie trzymany w systemowym magazynie haseł („pamiętaj na tym komputerze”). Zmiana hasła = ponowne zaszyfrowanie jednego klucza, bez przepisywania bazy.
- Argon2id jest celowo wolny (~0,5 s), żeby zgadywanie hasła było drogie.

**Co jest szyfrowane:** cała baza SQLCipher — strony bazy i dziennik WAL — czyli treść, nazwy i ścieżki notatek, indeks wyszukiwania, linki, tagi, historia, kosz, dziennik wiadomości. Załączniki osobno w `blobs/`. Z zewnątrz widać tylko rozmiar plików i czas ostatniej zmiany.

**Odblokowanie i blokada:**

1. Start → ekran hasła (albo klucz z magazynu systemowego) → odszyfrowanie klucza bazy → otwarcie bazy. Dalej jak w §4.1.
2. Blokada: ręcznie, po N minutach bezczynności [decyzja: domyślnie 15] i przy blokadzie ekranu systemu. Zamyka bazę, zeruje klucze w pamięci (`zeroize`) i czyści stan edytora w WebView.
3. Zablokowana przestrzeń **dalej synchronizuje się?** Nie — bez klucza bazy nie da się zapisać przychodzących zmian. Synchronizacja wznawia się po odblokowaniu [decyzja].

**Czego nie ma w przestrzeni zaszyfrowanej** — bo nie ma plików `.md`: obserwatora folderu, zmian zewnętrznych i ekranu konfliktu z Obsidianem (§4.4), zapisu `.md` (§4.3), wykrywania przeniesień poza aplikacją. Kod jest prostszy, nie trudniejszy.

**Eksport i import:**
- **Eksport do `.md`** — świadoma czynność z ostrzeżeniem: „pliki w wybranym folderze będą jawne”.
- **Import z folderu `.md`** — tworzy notatki w sejfie; aplikacja proponuje usunięcie oryginałów, ale ostrzega, że na dyskach SSD usunięcie nie gwarantuje zniknięcia danych.
- **Zmiana przestrzeni otwartej na zaszyfrowaną** = import do nowej zaszyfrowanej przestrzeni.

**Przestrzeń współdzielona a szyfrowanie na dysku:** sposób przechowywania wybiera każde urządzenie dla siebie. Właściciel może w dzienniku uczestników ustawić „wymagaj przechowywania zaszyfrowanego” — oficjalna aplikacja wtedy nie pozwoli dołączyć jako przestrzeń otwarta. To zasada, a nie gwarancja kryptograficzna: kto ma klucz przestrzeni, może zawsze zapisać treść jawnie (np. zmodyfikowaną aplikacją albo zrzutem ekranu).

**Co zostaje poza ochroną** (trzeba to uczciwie pokazać w ustawieniach):
- treść w pamięci RAM, gdy przestrzeń jest odblokowana;
- plik wymiany i hibernacji systemu — tu pomaga tylko szyfrowanie dysku;
- schowek (skopiowany tekst);
- zrzuty pamięci po awarii — aplikacja je wyłącza (`PR_SET_DUMPABLE` na Linuxie, wyłączenie raportów WER dla procesu na Windows);
- WebView nie może trzymać treści w `localStorage` ani w pamięci podręcznej na dysku — tylko w pamięci.

### 4.18. Węzeł przechowujący

Problem: Ania edytuje i wyłącza laptopa, potem Bartek włącza swój. Bez trzeciego miejsca Bartek nie ma skąd wziąć zmian Ani. Węzeł to to trzecie miejsce: zawsze włączony, przechowuje **wyłącznie zaszyfrowane, podpisane wiadomości** i nie ma klucza przestrzeni.

```text
 Ania (wieczorem)                      węzeł (VPS / Raspberry Pi)                Bartek (rano)
 edycje ──▶ wiadomości ──wysyłka──▶  [ zaszyfrowane wiadomości ]  ──pobranie──▶ odszyfrowanie
 wyłącza laptopa                        nie umie ich odczytać                   pliki .md aktualne
```

**Co to jest:** osobny, mały program `notes-node` (Rust, ten sam kod protokołu co aplikacja), bez okna. Uruchamiany na VPS, Raspberry Pi albo domowym serwerze — jako pojedynczy plik wykonywalny z usługą systemd albo obraz Dockera. Jeden węzeł obsługuje wiele przestrzeni.

**Jak dołącza do przestrzeni:**
1. Na węźle: `notes-node init` → wypisuje bilet węzła (klucz publiczny + adres).
2. Właściciel w aplikacji: „Dodaj węzeł” → wkleja bilet → wpis `Dodaj węzeł` w dzienniku uczestników.
3. Wszystkie urządzenia uczestników poznają adres węzła z dziennika i łączą się z nim jak z każdym innym urządzeniem.

**Co robi węzeł:**
- przyjmuje wiadomości od urządzeń przestrzeni i oddaje brakujące (te same wektory wersji co w §4.7);
- **przekazuje nowe wiadomości na żywo** wszystkim połączonym urządzeniom, które ich nie mają — tak pracują razem osoby w różnych sieciach;
- **przed przyjęciem sprawdza podpis, certyfikat i rolę** (z dziennika uczestników) — wiadomości od obcych i od czytelników odrzuca, więc nikt spoza przestrzeni nie użyje go jako darmowego dysku ani go nie zaśmieci;
- przechowuje zaszyfrowane załączniki (§4.16) i dziennik uczestników;
- przechowuje prośby o dołączenie, gdy właściciel jest offline (§4.11);
- trzyma wiadomości, dopóki wszystkie urządzenia nie potwierdzą, że je mają; dla nowych i długo nieobecnych urządzeń trzyma **zaszyfrowaną migawkę** stanu przestrzeni — przygotowuje i podpisuje ją okresowo któreś z urządzeń uczestników (węzeł sam nie może, bo nie ma klucza);
- opcjonalnie (`--relay`) działa też jako własny serwer pośredniczący iroh — wtedy przestrzeń w ogóle nie zależy od zewnętrznych serwerów.

**Kiedy aplikacja rozmawia z węzłem:**
- **na żywo** — każda nowa wiadomość od razu do węzła, jeśli jest jakiś uczestnik online, którego nie widać w LAN (węzeł mu ją przekaże);
- przy starcie (pobranie tego, co inni zostawili),
- **co 5 minut** w trakcie pracy, jeśli są wiadomości, których węzeł nie potwierdził — to kopia zapasowa, gdy wszyscy online są w jednym LAN i rozmawiają bez serwera [decyzja: odstęp],
- przy zamykaniu — aplikacja kończy się dopiero po wysłaniu zaległych wiadomości (z limitem kilku sekund i komunikatem „Zmiany wyślą się przy następnym uruchomieniu”, gdy węzeł jest nieosiągalny).

Każde urządzenie wysyła węzłowi wszystko, czego mu brakuje — także wiadomości innych, które samo dostało; duplikaty węzeł odrzuca po `(urządzenie, seq)`. Ryzyko: gdy komputer padnie bez zamknięcia, na węźle brakuje najwyżej ostatnich 5 minut — ale zostały one na dysku tego komputera i u uczestników, z którymi był połączony.

**Czego węzeł nie może:**
- odczytać treści, nazw notatek ani załączników — wszystko jest zaszyfrowane kluczem przestrzeni, a id notatki jest wewnątrz szyfrogramu (§4.10);
- podrobić ani zmienić zmian — każda wiadomość jest podpisana przez urządzenie autora;
- dodać nikogo do przestrzeni — dziennik uczestników podpisuje tylko właściciel.

**Co węzeł widzi** (metadane): klucze publiczne uczestników i ich urządzeń, liczbę, rozmiar i czas wiadomości. Może też **wstrzymać** dostarczanie (np. awaria albo złośliwy operator) — nie zepsuje danych, ale opóźni synchronizację; wtedy urządzenia nadal synchronizują się bezpośrednio między sobą. Dlatego węzeł najlepiej stawia ktoś z uczestników.

**Bonus:** baza węzła to pełna, zaszyfrowana kopia przestrzeni poza komputerami uczestników — działa jak kopia zapasowa, z której da się odtworzyć dane frazą odzyskiwania (§4.9).

**Limity** (konfiguracja węzła): maksymalny rozmiar przestrzeni i załącznika, liczba przestrzeni. Węzeł nie jest wymagany — bez niego wszystko działa jak dotąd, tylko z opisanym ograniczeniem.

### 4.19. Wersja webowa

Pełna wersja w przeglądarce: ten sam rdzeń Rust skompilowany do WebAssembly i ten sam interfejs. Szczegóły i ograniczenia: [WEB.md](WEB.md).

---

## 5. Interfejs

Interfejs jest w `ui/` (TypeScript, bez frameworka, CodeMirror 6, Yjs). Stan na 2026-10-21: prototyp w przeglądarce na `MockBridge` (notatki w pamięci, po przeładowaniu wracają do przykładowego zestawu). Nie ma jeszcze powłoki Tauri.

| Element | Jak |
|---|---|
| Pasek boczny (ribbon) | szybki przełącznik (Ctrl+P), graf, kalendarz, paleta poleceń, moje zadania (przycisk i polecenie są, widoku zadań jeszcze nie) |
| Panel plików (lewy) | zakładki „Pliki” i „Szukaj” działają (Szukaj: notatki i tekst plików, OCR §3.6); „Zakładki” to na razie tekst zastępczy. Akcje: nowa notatka, nowy folder, sortowanie (A–Z, Z–A), zwiń i rozwiń wszystko; menu kontekstowe (zmiana nazwy, usuwanie, kopiowanie ścieżki, nowy kalendarz w folderze); przeciąganie do folderów. Drzewo jest wirtualizowane: rysuje tylko widoczne wiersze |
| Karty | każda karta trzyma stan edytora w pamięci, więc przełączenie to podmiana stanu. Karta grafu zastępuje obszar edycji, dopóki jest otwarta. Wstecz i dalej; Ctrl+Alt+W zamyka kartę |
| Tryby notatki | podgląd na żywo (domyślnie): znaki Markdown ukryte poza linią kursora. Tryb źródłowy (ustawienie „Domyślny tryb edycji” albo polecenie w palecie). Widok czytania (Ctrl+E): HTML z rdzenia. Notatka `typ: kalendarz` pokazuje kalendarz, a Ctrl+E przełącza na jej tekst |
| Pasek formatowania | nad edytorem, wyłączany w ustawieniach. Te same polecenia są w palecie |
| Tabele | wyniki formuł w komórkach i adresy kolumn i wierszy na marginesie |
| Paleta poleceń | Ctrl+Shift+P lub F1. Wszystkie polecenia są w jednej liście, z której korzystają też pasek boczny i skróty klawiszowe |
| Szybki przełącznik | Ctrl+P, dopasowanie po ścieżce notatki |
| Ustawienia | kategorie: Ogólne, Edytor, Pliki i linki, Wygląd, Skróty klawiszowe, Wbudowane wtyczki (włącznik grafu), O programie |
| Graf | globalny w karcie, lokalny w prawym panelu (głębokość 1–5). Panel ustawień grafu: filtry (tagi, tylko istniejące pliki, sieroty, szukanie po ścieżce), grupy kolorów, wyświetlanie, siły układu |
| Prawy panel | „Graf lokalny” działa. „Odnośniki zwrotne”, „Właściwości” i „Historia” pokazują na razie „Wkrótce”. Uczestnicy i kursory — po etapie 3–4 |
| Pasek stanu | „Zapisywanie…” / „Zapisano lokalnie” / „Błąd zapisu” i liczba słów. „Połączono z N osobami” / „Offline” — po etapie 4 |
| Kalendarz | widoki dzień, tydzień, miesiąc i harmonogram, przycisk „Dziś”, okno wydarzenia z powtarzaniem. Zapis idzie do tekstu notatki (§4.16b) |
| Klawiatura | Ctrl+P otwórz, Ctrl+Shift+P polecenia, Ctrl+Tab karty, Ctrl+Shift+Enter tryb skupienia, Ctrl+E czytanie i edycja, Ctrl+B / Ctrl+I / Ctrl+K formatowanie. Pełna lista w [README.md](../README.md) |
| Motywy | zmienne CSS: ciemny (domyślny), jasny i „systemowy” w ustawieniach |
| Podgląd plików | okno nad aplikacją: pasek (nazwa, typ, rozmiar, Pobierz, Otwórz, Zamknij, ‹ › z licznikiem), stany (postęp w MB, błąd, karta „Pobierz”, brak sieci); treść w odizolowanej ramce `/preview/` (§4.16, [PODGLAD.md](PODGLAD.md)). Dwuklik i spacja w „Pliki” i drzewie, dwuklik i menu na osadzeniu, polecenie „Podgląd pliku” |

**Komendy IPC** (interfejs → rdzeń) — docelowa lista: `open_space`, `list_tree`, `open_note` (zwraca pełny stan Yjs), `apply_update`, `close_note`, `search`, `backlinks`, `graph`, `versions`, `restore_version`, `rename`, `move`, `delete`, `restore_from_trash`, `resolve_conflict`, `create_invite`, `accept_invite`. Prototyp `MockBridge` obsługuje: `list_tree`, `space_name`, `create_note`, `create_folder`, `rename`, `rename_folder`, `delete`, `open_note`, `note_text`, `apply_update`.

**Zdarzenia** (rdzeń → interfejs) — docelowo: `remote_update`, `tree_changed`, `save_status`, `sync_status`, `conflict`, `awareness`. Prototyp wysyła `tree_changed`. Zdarzenia wewnątrz interfejsu idą przez `bus.ts` (np. `index:changed`, `ui:open-graph`).

---

## 6. Czego świadomie nie ma w wersji 1

- id w nagłówku YAML (zostaje mapa w `.notes-sync`),
- wielu właścicieli przestrzeni,
- synchronizacja historii wersji między uczestnikami,
- bazy, widoki tabelaryczne, własne typy (PLAN §5) — zwykłe tabele z formułami są (§4.16a).
