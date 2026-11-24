# Dyktowanie (mowa → tekst) — specyfikacja

Dokument opisuje funkcję dyktowania w aplikacji Notatki: co ma powstać, jakie są twarde zasady i jak sprawdzić, że jest gotowe. Prompt do czatu, który ma to zaimplementować, jest w pliku `PROMPT-DYKTOWANIE.md`.

## 1. Cel

Użytkownik klika przycisk mikrofonu w edytorze, mówi po polsku, a tekst z interpunkcją i wielkimi literami pojawia się w notatce w miejscu kursora.

## 2. Twarde zasady (nie do negocjacji)

1. **Dźwięk nigdy nie opuszcza urządzenia.** Rozpoznawanie mowy działa w całości w przeglądarce użytkownika. Na serwer trafia wyłącznie gotowy tekst, jako zwykła, zaszyfrowana zmiana notatki (Yjs + E2E), nieodróżnialna od pisania z klawiatury.
2. **Żadnych zewnętrznych usług.** Nie wolno używać Web Speech API (`SpeechRecognition`, także w trybie `processLocally`), API w chmurze (OpenAI, Google, Deepgram, Soniox itp.) ani CDN-ów (Hugging Face, jsDelivr, unpkg) w czasie działania aplikacji.
3. **Model hostujemy sami.** Pliki modelu, WASM i workerów są serwowane z naszego serwera (`notes-node` / Docker), z tego samego originu co aplikacja.
4. **Wymuszenie techniczne:** nagłówek CSP z `connect-src 'self'` (plus to, czego aplikacja już wymaga do synchronizacji), tak żeby przeglądarka sama blokowała każde połączenie gdzie indziej.
5. **Audio tylko w RAM.** Nie zapisujemy nagrań nigdzie (ani na serwerze, ani w IndexedDB/OPFS, ani w historii wersji). Bufor czyścimy po przepisaniu fragmentu.
6. **Licencje pozwalające na sprzedaż w subskrypcji.** Każda nowa zależność musi mieć licencję dopuszczającą użycie komercyjne. Wszystkie trafiają na ekran „Licencje” w aplikacji.

## 3. Wybrany model

| | |
|---|---|
| Model główny | **parakeet-ultra** (dotrenowany `nvidia/parakeet-tdt-0.6b-v3`), WER po polsku ok. 5,5% (FLEURS) |
| Model zapasowy | `nvidia/parakeet-tdt-0.6b-v3`, WER po polsku ok. 6,7% |
| Licencja | CC-BY-4.0 — użycie komercyjne dozwolone, wymagane podanie autorstwa (NVIDIA, Moondream) i informacja o zmianach |
| Funkcje | 25 języków europejskich, w tym polski; interpunkcja i wielkie litery w wyniku |
| Format | ONNX, uruchamiany przez `onnxruntime-web` (WebGPU, zapasowo WASM) |

**Uwagi o wariantach plików:**
- Koder w int8 na WebGPU daje błędne wyniki — nie używać na ścieżce WebGPU.
- Koder fp32 (~2,3 GB) jest za duży. Do wyboru: fp16 (~1,24 GB) albo q4 (jak w Discourse STT). Wybór na podstawie pomiaru jakości po polsku (sekcja 8).
- Dekoder/joiner: int8, uruchamiany na WASM.
- Ścieżka WASM (bez WebGPU) może używać kodera int8.
- Pobierać wyłącznie z oficjalnych źródeł na licencji CC-BY-4.0. Niektóre przepakowania (np. NexaAI NPU) mają licencję **NC** — zakazane.

## 4. Architektura

```
[przycisk mikrofonu w edytorze]
        │ getUserMedia (tylko po kliknięciu, HTTPS)
        ▼
AudioWorklet ── resampling do 16 kHz mono, Float32
        │
        ▼
Web Worker „voice-worker”
  ├─ Silero VAD (ONNX) ── dzieli mowę na fragmenty po pauzie
  └─ Parakeet (parakeet.js albo onnx-asr-web na onnxruntime-web)
        │ tekst fragmentu (+ ewentualnie wynik tymczasowy)
        ▼
Wątek UI: transakcja CodeMirror w miejscu kursora
        │
        ▼
istniejąca ścieżka: Yjs → szyfrowanie → synchronizacja
```

Wymagania:
- Cała inferencja w Web Workerze — UI nie może się zacinać.
- Moduł ładuje się leniwie (dynamic import): użytkownik, który nie używa dyktowania, nie pobiera ani bajtu modelu ani bibliotek.
- Jedno API w interfejsie, np. `voice.start()`, `voice.stop()`, zdarzenia `partial`, `final`, `status`, `error`, `progress`, tak żeby w przyszłości dało się podmienić silnik (np. natywny `sherpa-rs` w Tauri) bez zmian w edytorze.
- Wstawianie tekstu: jeden fragment = jedna transakcja CodeMirror (jedno „cofnij” cofa jeden fragment). Spacja/wielka litera na styku z istniejącym tekstem obsłużona sensownie.

## 5. Pobieranie i przechowywanie modelu

- Model pobierany dopiero po pierwszym włączeniu dyktowania, z ekranem zgody: rozmiar pobrania, informacja, że dźwięk zostaje na urządzeniu.
- Pasek postępu, możliwość anulowania, wznawianie po przerwaniu, jeśli się da.
- Pliki w Cache Storage albo OPFS, wersjonowane po URL (nowa wersja modelu = nowy URL, nigdy nadpisywanie w miejscu).
- Sprawdzanie sumy SHA-256 po pobraniu.
- W ustawieniach: „Usuń pobrany model” i informacja, ile miejsca zajmuje.

## 6. Interfejs

- Przycisk mikrofonu na pasku edytora + skrót klawiszowy (do ustalenia, nie kolidujący z istniejącymi).
- Stany: nieaktywny / pobieranie modelu (z %) / ładowanie / nasłuch / przetwarzanie / błąd.
- Wyraźny wskaźnik, że mikrofon jest włączony.
- Komunikaty błędów po polsku: brak zgody na mikrofon, brak WebGPU (działa wolniej na WASM), za mało pamięci, przeglądarka nieobsługiwana.
- Wybór języka: domyślnie polski; Parakeet wykrywa język sam, ale ustawienie zostawić na przyszłość.
- Tryb demo (`?demo=1`): dyktowanie dostępne, ale z tym samym lokalnym modelem.

## 7. Serwer i wdrożenie

- `notes-node` / Docker serwuje pliki modelu jako statyczne zasoby z długim cache (`immutable`) i poprawnym `Content-Type`.
- Nagłówki: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (potrzebne do wielowątkowego WASM) — sprawdzić, czy nie psują istniejących funkcji.
- CSP z `connect-src 'self'` i `worker-src 'self' blob:` (jeśli potrzebne), bez `unsafe-eval`, jeśli się da (`wasm-unsafe-eval` dopuszczalne).
- Pliki modelu leżą na dysku serwera (`<data>/models`, w Dockerze osobny wolumen `voice-models` tylko do odczytu), nie w obrazie. Użytkownik pobiera je tylko z serwera Notatek, na którym pracuje. Skrypt wgrywający sprawdza sumy SHA-256 z repozytorium i bierze pliki z innego serwera Notatek albo z lokalnego katalogu (`--from`). Z oryginalnych źródeł pobiera tylko wtedy, gdy modeli nie ma jeszcze nigdzie (zmiana 2026-11-16, decyzja właściciela).

## 8. Testy i kryteria ukończenia

Funkcja jest gotowa, gdy:
- [ ] W Chrome/Edge z WebGPU dyktowanie po polsku działa, tekst z interpunkcją trafia do notatki w miejscu kursora.
- [ ] Bez WebGPU działa ścieżka WASM (wolniej) albo pojawia się jasny komunikat.
- [ ] W DevTools → Network podczas dyktowania **nie ma żadnych żądań** poza własnym originem; próba połączenia z innym hostem jest blokowana przez CSP (test automatyczny lub opisany ręczny).
- [ ] Audio nie jest zapisywane nigdzie (przegląd kodu + sprawdzenie IndexedDB/OPFS/Cache po sesji).
- [ ] UI nie zacina się podczas przetwarzania (inferencja w Workerze).
- [ ] Cofanie (Ctrl+Z) cofa jeden fragment dyktowania; współpraca na żywo i historia wersji działają jak przy pisaniu.
- [ ] Pomiar jakości: skrypt liczący WER/CER na zestawie nagrań testowych (właściciel dostarczy ok. 10–15 min własnego dyktowania + ręczną transkrypcję). Porównać fp16 vs q4 i Parakeet v3 vs parakeet-ultra; wyniki zapisać w `docs/POMIARY.md`.
- [ ] Pomiar szybkości: czas od końca fragmentu do pojawienia się tekstu (RTF) na sprzęcie właściciela, wynik w `docs/POMIARY.md`.
- [ ] Ekran „Licencje” zawiera: Parakeet / parakeet-ultra (CC-BY-4.0, z autorstwem i informacją o zmianach), onnxruntime-web (MIT), Silero VAD (MIT), bibliotekę ASR (licencja zweryfikowana w repozytorium).
- [ ] Zaktualizowane dokumenty: `README.md` (opis funkcji), `RODO.md` (głos przetwarzany wyłącznie lokalnie, nie zapisywany), `PLAN-BUDOWY.md` (nowy etap), `UWAGI.md` (otwarte decyzje).

## 9. Poza zakresem (na później)

- Natywne dyktowanie w Tauri przez `sherpa-rs` (ten sam model, bez przeglądarki) — za tym samym interfejsem `voice`.
- Aplikacja mobilna.
- Komendy głosowe („nowy akapit”, „kropka”).
- Słownik własnych słów / dotrenowanie modelu na polskich danych.
- Jakiekolwiek przetwarzanie w chmurze — wymagałoby osobnej decyzji właściciela.

## 10. Otwarte decyzje (do potwierdzenia przez właściciela)

1. Wariant kodera: fp16 (~1,24 GB, pewny na WebGPU) czy q4 (mniejszy, jakość do zmierzenia).
2. Biblioteka: `parakeet.js` czy `onnx-asr-web` — po weryfikacji licencji i jakości obu.
3. Skrót klawiszowy dla mikrofonu.
4. Czy pokazywać tekst tymczasowy (szary) w trakcie mówienia, czy tylko gotowe fragmenty.

## 11. Stan wdrożenia (2026-11-16)

Decyzje z §10:
1. **Koder.** fp16 na WebGPU, gdy przeglądarka ma `shader-f16`, a w każdym innym przypadku int8 na WASM. 4-bit ma na
   FLEURS ten sam WER co int8, przy mniejszym pobraniu. Ostateczny wybór po nagraniach właściciela (POMIARY.md).
2. **Biblioteka:** `parakeet.js` 1.4.4 (MIT). Pakiet ma błąd detokenizera dla polskich liter, poprawiony w
   `ui/src/voice/detok.ts`.
3. **Skrót:** Ctrl+Shift+D.
4. **Tekst w trakcie mówienia:** od 2026-11-17 (decyzja właściciela) szary podgląd przy kursorze. Worker rozpoznaje
   trwający fragment co `max(0,7 s; 2 × czas ostatniego rozpoznania)`, gdy trwa on co najmniej 0,8 s. Podgląd nie
   wchodzi do notatki (dekoracja CodeMirror, nie ma go w Yjs, cofaniu ani zapisie). Gotowy fragment zastępuje go jedną
   transakcją, jak wcześniej. Gdy jedno rozpoznanie trwa ponad 2,5 s (wolny sprzęt), podgląd wyłącza się do końca sesji,
   a przy fragmencie dłuższym niż 20 s znika do jego końca (`voice/partial.ts`, `voice/ghost.ts`).

Źródło modeli: NVIDIA i Moondream nie publikują plików ONNX. Używamy konwersji na CC-BY-4.0 przypiętych do commitu i
SHA-256 (`ui/src/voice/models.ts`): Olicorne dla Ultra, istupakov i ysdede dla v3. Z tych źródeł pobiera się je raz.
Kolejne serwery biorą je z serwera projektu (`--from https://…/models`), a przeglądarka zawsze z własnego serwera.

Kod:

| Część | Pliki |
|---|---|
| API, wstawianie tekstu, przycisk | `ui/src/voice/{types,insert,controller}.ts`, `ui/src/toolbar.ts` |
| Mikrofon | `ui/src/voice/{capture,capture-worklet,resample}.ts` |
| Worker, VAD, silnik, podgląd na żywo | `ui/src/voice/{worker,vad,engine,detok,partial,ghost}.ts` |
| Model: pobieranie, OPFS, SHA-256 | `ui/src/voice/{models,modelstore,sha256}.ts` |
| Ustawienia i licencje | `ui/src/settings.ts`, `ui/licenses/voice-models.txt` |
| Serwer | `crates/node/src/http.rs` (`/models/*` z `<data>/models`), `crates/node/src/run.rs` |
| Wgrywanie modeli na serwer | `scripts/fetch-voice-models.mjs` (`--from URL\|DIR`), zadanie `voice-models` w `docker/compose.yml`, `docker/Caddyfile` |
| Pomiary i test e2e | `scripts/measure-dictation.cjs`, `ui/measure.html`, `scripts/test-dictation.cjs` |

Kryteria z §8:
- [ ] **Chrome/Edge z WebGPU (fp16).** Nie sprawdzone: Chromium na tym komputerze (Linux, NVIDIA) nie zgłasza
  `shader-f16`. Ścieżka WebGPU działa z koderem 4-bitowym.
- [x] **Ścieżka WASM** działa (e2e i pomiar), a bez WebGPU użytkownik dostaje komunikat, że będzie wolniej.
- [x] **Brak żądań poza originem, a CSP blokuje inne hosty:** `scripts/test-dictation.cjs` na `notes-node`.
- [x] **Audio nigdzie nie jest zapisywane.** Przegląd kodu potwierdza, że ramki idą tylko przez pamięć. Po sesji Cache
  Storage i IndexedDB są puste, a w OPFS jest tylko `voice-models`, czyli model (e2e).
- [x] **UI się nie zacina:** inferencja i VAD działają w Web Workerze.
- [x] **Ctrl+Z cofa jeden fragment** (`insert.test.ts`, e2e). Tekst trafia do notatki zwykłą transakcją CodeMirror,
  więc współpraca i historia wersji działają tak jak przy pisaniu.
- [ ] **WER/CER na nagraniach właściciela.** Narzędzie jest gotowe, wstępny pomiar zrobiony na FLEURS.
- [ ] **RTF na sprzęcie właściciela.** Jest pomiar na tym komputerze (POMIARY.md).
- [x] **Ekran „Licencje”:** Ustawienia → O programie oraz `THIRD-PARTY-NOTICES.txt`.
- [x] **Zaktualizowane dokumenty:** README, RODO, PLAN-BUDOWY (etap 7), UWAGI, DOCKER-WEB, POMIARY.
