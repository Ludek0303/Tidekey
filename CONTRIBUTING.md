# Zgłaszanie zmian

Dziękujemy za zainteresowanie projektem. **Projekt jest wciąż rozwijany i na razie nie przyjmujemy zmian w kodzie
(pull requestów).** Mile widziane są zgłoszenia błędów i pomysły (issues).

Powód: Notatki są na licencji AGPL-3.0-or-later, a autor chce zachować możliwość udzielania także osobnej licencji
komercyjnej. Przyjmowanie cudzego kodu wymagałoby wtedy umowy licencyjnej z autorem zmiany (CLA). Gdy projekt zacznie
przyjmować zmiany, ten plik opisze, jak podpisać CLA.

## Zgłoszenie błędu albo pomysłu

- Opisz, co robisz, czego się spodziewasz i co się dzieje, oraz wersję (Ustawienia → O programie).
- Nie wklejaj treści notatek, kodów odzyskiwania, haseł ani kluczy.
- Luki bezpieczeństwa zgłaszaj prywatnie: [SECURITY.md](SECURITY.md).

## Dla osób, które budują projekt u siebie

- Budowanie i testy: [README.md](README.md) („Uruchomienie dla programisty”, „Testy”) i [CLAUDE.md](CLAUDE.md).
- Dokumentacja i komunikaty w aplikacji są po polsku, kod i komentarze w kodzie po angielsku.
- **Zależności:** dozwolone są tylko licencje z listy w `deny.toml` i w zadaniu `licencje` w
  `.github/workflows/ci.yml` (MIT, Apache-2.0, BSD, ISC, Zlib i podobne). Nie dodajemy zależności na GPL ani AGPL, na
  licencjach „non-commercial” ani „source-available” (BUSL, SSPL, Elastic, Commons Clause), ani kodu bez licencji.
  LGPL i MPL-2.0 tylko imiennie i tylko w trybie opisanym w [docs/PODGLAD.md](docs/PODGLAD.md) §1.
- Nowa zależność albo nowy plik od innego autora: kroki w [docs/LICENCJE.md](docs/LICENCJE.md) („Nowa zależność”),
  potem `node scripts/licencje/generate.mjs` i zmieniony `THIRD_PARTY_NOTICES.txt` w tym samym commicie. CI sprawdza
  `cargo deny`, listę licencji npm, `reuse lint` i aktualność not.
