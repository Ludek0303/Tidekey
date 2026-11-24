# Wdrożenie rozbudowy organizacji

Wariant znajduje się w osobnym katalogu `variants/notes-organizations`. Oryginalna aplikacja została zachowana. Kopię utworzono 25.10.2026; jej niezależne archiwum sprzed zmian etapów B–F jest w `backups/notes-organizations-before-stages-b-f-2026-10-25.tar.gz`.

## Izolacja

- Osobny identyfikator Tauri: `pl.notes.organizations`.
- Osobna usługa systemowego magazynu kluczy: `notes-organizations`.
- Osobny adres podglądu: `http://localhost:5174`.
- Uruchom interfejs poleceniem `./start-web.sh`, a desktop poleceniem `./start-app.sh`.
- Nowa aplikacja nie pobiera kluczy z magazynu starej. Wybierz osobny katalog danych lub wcześniej zrób kopię istniejących danych.
- Przeglądarkowy MockBridge pokazuje przykładową organizację: osoby, grupy, trzy projekty z zadaniami, kalendarz z wydarzeniami i inwentarz. To dane demonstracyjne przechowywane w pamięci przeglądarki; odświeżenie przywraca zestaw początkowy.

## Ustawienia początkowe

Przyjęto: tylko właściciel przestrzeni zarządza grupami; trudność może pozostać nieoceniona; checkbox kończy zadanie bez akceptacji nadzorującego; zewnętrzny Markdown modułów wymaga kontrolowanego importu; prywatna zajętość z innych vaultów nie jest udostępniana.

## Zakres akceptacji

### Zaimplementowano

- Projekty i zadania w Markdown, w tym edycję z widoków zbiorczych, stabilne ID, kontrolę równoległej edycji oraz podpisaną historię przypisań, ukończeń i zmian pól. Zdarzenia są weryfikowane względem zmian CRDT; trudność w chwili ukończenia zostaje zachowana.
- Widoki zadań, nadzorowania, lokalne powiadomienia o zdarzeniach, role i grupy członków.
- Kalendarze, wydarzenia, RSVP, widok zbiorczy, dzienny/tygodniowy/miesięczny/agenda, dostępność zespołu oraz propozycje spotkań.
- Inwentarz z tabelą, kartą, wydawaniem/zwrotem, historią, CSV i wykrywaniem konfliktów.
- Każda nowa pozycja inwentarza wymaga kategorii oraz miejsca przechowywania; oba pola widać w tabeli, CSV i generowanym Markdown.
- Roczną mapę aktywności (liczba zadań lub punkty), graf delegowania/projektów z gałęziami zadań oraz 7-/31-dniową oś terminów i ukończeń.
- Strukturalne dane modułów CRDT z deterministyczną, pełną reprezentacją Markdown, podglądem i kontrolowanym importem.

### Ograniczenia bezpieczeństwa i zakresu

- Przestrzenie nadal mają bazowe role `Owner`, `Editor`, `Reader` (w UI: Administrator, Członek, Obserwator). Menedżer i szczegółowe granty do zasobów nie są wdrożone. Grupy służą organizacji i zaproszeniom; **nie ograniczają dostępu do dokumentów**.
- Nie wdrożono odrębnych kluczy E2EE dla projektów, folderów, kalendarzy ani inwentarzy, ani ich rotacji. Ukrywanie w UI nie zapewnia poufności. Poufne projekty należy na razie trzymać w osobnych vaultach.
- Globalne widoki agregują otwarte przestrzenie z bieżącym dostępem; to nie jest globalny katalog tożsamości pomiędzy vaultami.
- Markdown modułów jest generowany wewnątrz szyfrowanego magazynu CRDT, nie jako jawny plik na dysku. Jawny plik powstaje po świadomym eksporcie.
- Powiadomienia pojawiają się po synchronizacji, gdy aplikacja działa; nie ma push w tle. Propozycje dostępności nie rezerwują terminu.
- Reguły cykliczne obsługują obecnie cykl dzienny i tygodniowy.

### Weryfikacja

Końcowe `npx tsc --noEmit` i `cargo check --manifest-path app/src-tauri/Cargo.toml` zakończyły się powodzeniem. Wcześniejsza kontrola UI zakończyła się wynikiem **366 zaliczonych testów**. Scenariusz przeglądarkowy objął grupy, kalendarz, inwentarz, dostępność, historię zadań i raporty; wyniki oraz zrzuty są w `docs/organization-checks/`. Po ostatnich poprawkach nie uruchamiałem ponownie zestawu testów.
