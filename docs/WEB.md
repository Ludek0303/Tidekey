# Wersja webowa

Pełna aplikacja w przeglądarce, z tym samym szyfrowaniem end-to-end co wersja desktopowa. Uzupełnia [ARCHITEKTURA.md](ARCHITEKTURA.md) §4.19. Miejsca **[sprawdzić]** trzeba potwierdzić prototypem — biblioteki WASM szybko się zmieniają.

---

## Stan na 2026-10-21

**Istnieje:**
- `crates/web` (`notes-web`) eksportuje przez wasm-bindgen:
  - `evaluate_markdown_table(md, today_days)`: tabela GFM z wynikami formuł jako `EvaluatedTable` (`rows`, `cols`, `text(r, c)`, `kind(r, c)`, `is_formula(r, c)`); `null`, gdy tekst nie jest tabelą,
  - `render_markdown_html(md, today_days)`: bezpieczny HTML dla widoku czytania,
  - `WasmIndex`: `new`, `upsert`, `remove`, `rename`, `graph_json`, `backlinks_json`, `outgoing_json`, `tags_json`, `headings_json`,
  - `calendar_parse_json`, `calendar_expand_json`, `calendar_format_event_json` (kalendarz, ARCHITEKTURA §4.16b).
- Interfejs ładuje WASM w głównym wątku (`ui/src/formula.ts`, `ui/src/noteindex.ts`). Tylko układ grafu działa w Web Workerze (`ui/src/graphworker.ts`).
- Notatki trzyma `MockBridge` w pamięci przeglądarki (Yjs w JavaScript). Rdzeń `Space` (SQLite, pliki) nie jest magazynem w przeglądarce.
- CI sprawdza, że `notes-core` kompiluje się do `wasm32-unknown-unknown` (`cargo check`).

**Planowane (nie istnieje):**
- Rdzeń w Web Workerze za tym samym `call()`. Teraz formuły, indeks i kalendarz działają w głównym wątku, a dane są w pamięci.
- Magazyn SQLite w OPFS, zawsze zaszyfrowany, odblokowywany hasłem (§2, §3).
- Połączenie z węzłem przez WebSocket, eksport i import plików, Service Worker i podpisane wydania (§4).

---

## 1. Jedna baza kodu, dwa opakowania

```text
            ┌──────────── wspólny interfejs (TypeScript, CodeMirror 6, Yjs) ────────────┐
            │                         „most” (jedna funkcja call())                     │
            └───────────────┬───────────────────────────────────────┬──────────────────┘
                            │ IPC Tauri                             │ postMessage
               ┌────────────▼────────────┐             ┌────────────▼─────────────┐
               │ desktop: core + sync    │             │ web: core + sync jako    │
               │ (Rust, natywnie)        │             │ WASM w Web Workerze      │
               │ SQLite, pliki .md, LAN  │             │ SQLite w OPFS            │
               └────────────┬────────────┘             └────────────┬─────────────┘
                            └──────── węzeł (QUIC / WebSocket) ─────┘
```

- **Ten sam kod Rust** liczy wszystko: CRDT, szyfrowanie, podpisy, wyszukiwanie, formuły tabel. Nie ma drugiej implementacji w JavaScripcie, więc obie wersje zachowują się identycznie.
- **Rdzeń działa w Web Workerze**, nie w głównym wątku — pisanie nigdy nie czeka na szyfrowanie, zapis ani wyszukiwanie (jak IPC w wersji desktopowej).
- Interfejs zna tylko `call(komenda, dane)` i zdarzenia; desktop podpina pod to IPC Tauri, web — `postMessage`. Reszta UI jest wspólna.

## 2. Co działa inaczej niż na komputerze

| | Desktop | Web |
|---|---|---|
| Pliki `.md` na dysku, obserwator folderu, zmiany z Obsidiana | ✅ (przestrzeń otwarta) | ❌ — jak przestrzeń zaszyfrowana; eksport `.md` (zip) i import plików na żądanie |
| Przechowywanie | SQLite (SQLCipher w zaszyfrowanej) | SQLite w OPFS (prywatny magazyn przeglądarki), **zawsze zaszyfrowane** jak przestrzeń zaszyfrowana (ARCHITEKTURA §4.17) |
| Synchronizacja w LAN bez serwera | ✅ | ❌ — przeglądarka nie ma mDNS ani UDP; zawsze przez węzeł |
| Synchronizacja przez węzeł | QUIC (iroh) | WebSocket przez TLS, ten sam protokół `notes-sync/1` |
| Edycja wspólna, kursory, historia, wyszukiwanie, graf, tabele z formułami | ✅ | ✅ |
| Praca offline | ✅ | ✅ po pierwszym wczytaniu (Service Worker trzyma pliki aplikacji) |

Przeglądarka to po prostu **kolejne urządzenie** uczestnika: ma własny klucz urządzenia i certyfikat (ARCHITEKTURA §4.9). Dodaje się ją frazą odzyskiwania albo zaproszeniem samego siebie; unieważnia jak zgubiony laptop.

## 3. Klucze w przeglądarce

- Klucz urządzenia i klucz bazy są zaszyfrowane hasłem (Argon2id, jak `keyfile` w §4.17) i leżą w OPFS. Bez hasła zawartość OPFS jest nieczytelna.
- Po odblokowaniu klucze żyją tylko w pamięci workera; blokada po bezczynności i przy zamknięciu karty je kasuje.
- „Zapamiętaj na tym komputerze” — opcja, domyślnie wyłączona (komputery współdzielone).

## 4. Najważniejsze ryzyko: kto dostarcza kod strony

W aplikacji desktopowej kod instalujesz raz. W przeglądarce **kod jest pobierany przy każdym wejściu** — kto kontroluje serwer, z którego ładuje się strona, może podsunąć zmieniony kod, który wyśle klucze. To ograniczenie każdego szyfrowania end-to-end w przeglądarce, nie tylko tej aplikacji.

Co robimy:
- strona ładuje się z **własnego węzła** uczestników (ten sam, który przechowuje szyfrogramy) — nie z obcego serwera [decyzja];
- pliki aplikacji są **wydaniami podpisanymi** kluczem projektu; Service Worker po pierwszym wczytaniu sprawdza podpis każdej aktualizacji i odrzuca niepodpisane;
- surowa polityka CSP: żadnych skryptów z zewnątrz, żadnego `eval`;
- uczciwa informacja w ustawieniach: „wersja desktopowa jest bezpieczniejsza; web ufa serwerowi, z którego ładuje się strona”.

Szyfrogramów na węźle to nie zmienia — dalej są nieczytelne bez klucza. Ryzyko dotyczy tylko podmiany kodu strony.

## 5. Co to zmienia już teraz (etap 2)

- `core` nie może zależeć od niczego, co nie kompiluje się do `wasm32-unknown-unknown`. Do CI dochodzi `cargo check -p notes-core --target wasm32-unknown-unknown` — błędy wychodzą od razu, nie w etapie 5.
- Do sprawdzenia w prototypie **[sprawdzić]**: `rusqlite` z SQLite w WASM i OPFS; `getrandom` w przeglądarce (feature `wasm_js`); iroh w przeglądarce (tylko przez relay) albo zwykły WebSocket do węzła. Jeśli SQLite w WASM zawiedzie, magazyn w przeglądarce dostaje osobną implementację za tym samym interfejsem w `core`.
- Węzeł potrzebuje domeny i certyfikatu TLS, bo przeglądarka łączy się tylko przez `wss://` (SIEC §5, wariant C). Darmowa subdomena + Let's Encrypt wystarczą.

## 6. Szybkość

Te same cele co desktop (PLAN §9), mierzone w Chrome i Firefox:
- pierwsze wczytanie strony < 3 s (pliki WASM skompresowane, potem z pamięci Service Workera); kolejne uruchomienia < 2 s;
- pisanie bez opóźnień — edytor w głównym wątku, rdzeń w workerze;
- wyszukiwanie < 100 ms przy 10 000 notatek (FTS5 w SQLite WASM).
