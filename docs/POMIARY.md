# Pomiary

## Dyktowanie (DYKTOWANIE §8)

Narzędzie: `scripts/measure-dictation.cjs` (Playwright) uruchamia w Chromium stronę `ui/measure.html` (tylko serwer
dev, nie trafia do builda). Każdy plik przechodzi tę samą drogę co w edytorze: resampling do 16 kHz → Silero VAD →
fragmenty → Parakeet → sklejanie `joinFragment`. WER i CER liczy `ui/src/voice/wer.ts`.

```bash
cd ui && npm run dev            # serwer z /models i COOP/COEP
PLAYWRIGHT_PATH=/ścieżka/do/playwright node scripts/measure-dictation.cjs --set pomiary/<zestaw>
```

Zestaw to katalog par `nazwa.wav` (PCM16 albo float32, dowolna częstotliwość) + `nazwa.txt` (transkrypcja z
interpunkcją). Katalog `pomiary/` jest poza gitem.

Jak czytać kolumny:
- **WER** to błędy na słowach po normalizacji (małe litery, bez interpunkcji).
- **CER** to błędy na znakach.
- **WER z interpunkcją** liczy też przecinki, kropki i wielkie litery.
- **RTF** to czas przetwarzania podzielony przez długość nagrania. Mniej znaczy szybciej; 0,17 oznacza, że minuta mowy
  liczy się 10 s.
- **Opóźnienie fragmentu** to czas samego rozpoznania fragmentu. W edytorze dochodzi do niego 0,6 s ciszy, po której
  VAD uznaje fragment za skończony.

### 2026-11-16, wstępnie: FLEURS pl (50 wypowiedzi, 517,7 s)

To nie jest pomiar docelowy. Zestaw to pierwsze 50 wypowiedzi z części testowej FLEURS `pl_pl` (Google, CC-BY-4.0,
czytane zdania z Wikipedii). Nagrania właściciela (10–15 min dyktowania z ręczną transkrypcją) jeszcze nie są
dostępne.

Sprzęt: Chromium 141 bez okna, Linux, 16 wątków CPU (ONNX Runtime używa 4), NVIDIA RTX 3060. WebGPU jest dostępne,
ale bez `shader-f16`.

| Model | Koder (pobranie) | Backend | WER | CER | WER z interpunkcją | RTF | Opóźnienie fragmentu (mediana / p95) | Ładowanie |
|---|---|---|---|---|---|---|---|---|
| Parakeet Ultra | int8 (650 MB) | WASM | **9,3%** | 2,5% | **11,7%** | 0,165 | 1,41 s / 2,24 s | 1,9 s |
| Parakeet Ultra | 4-bit w4a8 (383 MB) | WASM | 9,3% | 2,6% | 12,4% | 0,178 | 1,59 s / 2,30 s | 2,3 s |
| Parakeet Ultra | 4-bit w4a8 (383 MB) | WebGPU | 9,3% | 2,6% | 12,4% | 0,179 | 1,60 s / 2,31 s | 1,6 s |
| Parakeet Ultra | fp16 (1,2 GB) | WebGPU | nie działa tutaj: brak `shader-f16` | | | | | |
| Parakeet TDT 0.6B v3 | int8 (652 MB) | WASM | 15,8% | 5,2% | 19,2% | 0,092 | 0,79 s / 1,22 s | 3,1 s |
| Parakeet TDT 0.6B v3 | fp16 (1,2 GB) | WebGPU | nie działa tutaj: brak `shader-f16` | | | | | |

Wnioski:
- **Ultra jest wyraźnie lepszy od v3** (9,3% wobec 15,8% WER), ale około 1,8 razy wolniejszy.
- **Koder 4-bitowy ma ten sam WER co int8**, przy pobraniu o 40% mniejszym, i działa także na WebGPU bez
  `shader-f16`. Na tym sprzęcie WebGPU nie przyspiesza go względem WASM. Jest kandydatem na wariant domyślny;
  decyzja zapadnie po nagraniach właściciela (UWAGI).
- **Pierwszy pomiar dał 12,1% / 18,1% WER.** Przyczyną był błąd w `parakeet.js` 1.4.4: detokenizer gubił spację
  przed słowem zaczynającym się polską literą („jestłatwo”). Poprawka jest w `ui/src/voice/detok.ts` (z testem);
  tabela pokazuje wyniki po niej.
- **Do 5,54% podawanych przez Moondream dla polskiego FLEURS brakuje z kilku powodów:**
  - mały zestaw,
  - kwantyzacja int8 i 4-bit (Moondream liczy w pełnej precyzji na GPU),
  - cięcie przez VAD,
  - inna normalizacja tekstu (np. „sto” zamiast „100”),
  - pomyłki językowe: model czasem pisze po polsku czeską lub słowacką pisownią („požom”, „vzkazuje”, „jonov
    vodoru”), bo v3 nie przyjmuje wskazówki języka.
- **Opóźnienie od końca wypowiedzi do tekstu** wynosi około 0,6 s ciszy plus 1,4 s rozpoznania (mediana) dla Ultra
  int8 na 4 wątkach.

Pełne wyniki z hipotezami dla każdego pliku: `pomiary/wyniki-po-poprawce.json` (poza gitem).

### Do zrobienia

- [ ] Nagrania właściciela: WER/CER fp16 vs 4-bit, Parakeet v3 vs Ultra, na jego sprzęcie i w jego przeglądarce.
- [ ] RTF na WebGPU z `shader-f16` (np. Chrome na Windows lub macOS).
