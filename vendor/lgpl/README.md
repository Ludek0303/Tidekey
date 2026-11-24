# Biblioteki na licencji LGPL

Biblioteki na licencji LGPL nie są wklejone do kodu aplikacji. Każda jest osobnym plikiem (`.js`, `.wasm`) bez zmian,
kopiowanym do `assets/` podglądu przy budowie (`ui/preview/vite-lgpl.ts`) i wczytywanym w czasie działania
(`ui/preview/src/lgpl.ts`). Dzięki temu użytkownik może podmienić bibliotekę własnym buildem (LGPL-3.0, sekcja 4 i 6).

## Zasady

1. Pliki w `vendor/lgpl/<pakiet>-<wersja>/` są kopiami z npm, **bajt w bajt**. Nie edytujemy ich.
2. `MANIFEST.json` podaje pakiet, wersję, licencję, adres źródeł i SHA-256 każdego pliku. Budowa podglądu sprawdza
   sumy i przerywa się, gdy plik nie zgadza się z manifestem (`lgpl: … nie zgadza się z MANIFEST.json`).
3. Tekst licencji (`LICENSE`) trafia do aplikacji jako `assets/lgpl-<pakiet>-<wersja>-LICENSE.txt`.
4. Poprawki w bibliotece wymagają publicznego forka (PODGLAD-PLAN §4). Nie wklejamy zmian do tych plików.

## Pakiety

| Pakiet | Wersja | Licencja | Źródło | Upstream | Plik w aplikacji | Używa |
|---|---|---|---|---|---|---|
| libheif-js | 1.23.5 | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js/tree/v1.23.5 | https://github.com/strukturag/libheif | `assets/lgpl-libheif-js-1.23.5-libheif.js`, `…-libheif.wasm`, `…-LICENSE.txt` | podgląd HEIC/HEIF (`viewers/heic.ts`), poza Safari |

Pliki pochodzą z `ui/node_modules/libheif-js/libheif-wasm/` (wersja `libheif-wasm`, nie `libheif`).

Sprawdzenie sum:

```bash
sha256sum vendor/lgpl/libheif-js-1.23.5/*
```

Wynik musi zgadzać się z `MANIFEST.json`.

## Jak podstawić własny build

1. Zbuduj bibliotekę ze źródeł (adres w tabeli). Potrzebne są pliki `libheif.js` i `libheif.wasm` w wariancie
   `libheif-wasm` oraz `LICENSE`.
2. Umieść je w nowym katalogu `vendor/lgpl/<pakiet>-<wersja>/`.
3. Zaktualizuj `MANIFEST.json`: wersję i SHA-256 każdego pliku (`sha256sum`).
4. W `ui/preview/src/lgpl.ts` zmień wersję w `LIBRARIES` na tę samą wartość co w manifeście. Build sprawdza tę zgodność.
5. Uruchom `npm run build:preview` i sprawdź, że `ls ui/dist/preview/assets | grep lgpl` pokazuje trzy pliki.
