# Plan aplikacji do notatek Markdown

## 1. Cel produktu

Aplikacja łączy wygodną organizację wiedzy inspirowaną Anytype z prostymi plikami `.md`, które można otworzyć także w Obsidianie lub dowolnym edytorze tekstu.

Kilka osób może równocześnie edytować tę samą notatkę. Urządzenia synchronizują zmiany przez sieć P2P, a dane opuszczające urządzenie są szyfrowane end-to-end.

Pierwsza wersja powstaje na Linux i Windows oraz jako **w pełni funkcjonalna wersja webowa** (ten sam rdzeń w Ruście skompilowany do WebAssembly). Aplikacje mobilne mogą być rozważone później. Priorytetami są szybkość (rdzeń w Ruście), niezawodny zapis i czytelne pliki na dysku.

## 2. Podstawowe pojęcia

- **Przestrzeń** — folder z notatkami, załącznikami i ustawieniami współpracy. Może być prywatna lub współdzielona.
- **Notatka** — pojedynczy plik `.md` o stałym identyfikatorze. Zmiana nazwy lub położenia pliku nie zmienia tożsamości notatki.
- **Uczestnik** — osoba zaproszona do przestrzeni jako właściciel, edytor lub czytelnik.
- **Wersja** — zapisany stan notatki, który można obejrzeć, porównać i przywrócić.
- **Urządzenie** — instalacja aplikacji mająca własne klucze i lokalną kopię przestrzeni.

## 3. Jak ma wyglądać aplikacja

Układ głównego okna jest inspirowany Obsidianem: wąski pasek narzędzi, drzewo plików, karty otwartych notatek, duży edytor i opcjonalny panel po prawej. Aplikacja ma własne ikony i kolory.

```text
┌────┬─────────────────────┬────────────────────────────────┬──────────────────┐
│    │ Moja przestrzeń      │ Plan.md       Spotkanie.md     │ Odnośniki        │
│ N  ├─────────────────────┤────────────────────────────────┤ Właściwości      │
│ A  │ Szukaj notatek       │ # Plan aplikacji               │ Historia         │
│ R  │ + Nowa notatka       │                                │                  │
│ Z  │                     │ Treść notatki w edytorze       │ Wspomnienia: 3   │
│ Ę  │ ▾ Projekty          │ Markdown z podglądem.          │                  │
│ D  │   Plan.md           │                                │ Uczestnicy: 2    │
│ Z  │   Spotkanie.md      │                                │                  │
│ I  │   Pomysły.md        │                                │                  │
│ A  │                     │                                │                  │
├────┴─────────────────────┴────────────────────────────────┴──────────────────┤
│ Zapisano lokalnie · Połączono z 2 osobami · 328 słów                    ⚙  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Elementy okna

- **Lewy pasek narzędzi:** przejście do notatek, wyszukiwania, ulubionych, współpracy i ustawień.
- **Lewy panel:** foldery i pliki. Obsługuje zmianę nazwy, przeciąganie, sortowanie oraz menu kontekstowe.
- **Górny pasek kart:** szybkie przełączanie notatek; opcjonalnie podział edytora na dwie kolumny.
- **Środek:** edytor, który nie rozprasza podczas pisania. Szerokość tekstu można ograniczyć dla wygodnego czytania.
- **Prawy panel:** odnośniki do bieżącej notatki, właściwości, uczestnicy i historia. Można go ukryć.
- **Dolny pasek stanu:** stan zapisu, stan synchronizacji, liczba uczestników i liczba słów.

Domyślny motyw jest ciemny: grafitowe tło, trochę jaśniejsze panele, jasny tekst i oszczędny fioletowy akcent. Dostępny jest również motyw jasny. Panele można zmieniać rozmiarem. Tryb skupienia ukrywa panele i zostawia sam edytor.

Interfejs powinien działać w całości z klawiatury. Szybkie otwieranie notatki, wyszukiwanie i polecenia mają mieć skróty klawiaturowe.

## 4. Najważniejsze ekrany i przebieg pracy

### Pierwsze uruchomienie

Użytkownik wybiera jedną z trzech czynności:

1. Utwórz nową przestrzeń w wybranym folderze — otwartą (czytelne `.md`) albo zaszyfrowaną (wszystko szyfrowane, odblokowanie hasłem).
2. Otwórz istniejący folder z plikami `.md`.
3. Dołącz do przestrzeni przez zaproszenie.

Przy pierwszym uruchomieniu aplikacja tworzy tożsamość urządzenia i pokazuje sposób odzyskania dostępu. Użytkownik otrzymuje jasną informację, że utrata wszystkich urządzeń i klucza odzyskiwania może uniemożliwić odszyfrowanie danych współdzielonych.

### Codzienna praca

Po otwarciu przestrzeni użytkownik widzi ostatnio używaną notatkę. Może przeglądać foldery, wyszukać tekst, otworzyć kilka kart, dodać tag albo stworzyć link do innej notatki. Zapis jest automatyczny.

### Zaproszenie współpracownika

Właściciel tworzy zaproszenie i wybiera uprawnienie: odczyt lub edycja. Odbiorca dołącza na swoim komputerze. Aplikacje potwierdzają tożsamość urządzeń i przekazują klucz przestrzeni w postaci zaszyfrowanej dla odbiorcy.

### Praca offline

Bez internetu można czytać i edytować lokalne notatki. Zmiany czekają na urządzeniu. Po odzyskaniu połączenia aplikacja wymienia brakujące zmiany z pozostałymi uczestnikami i aktualizuje pliki `.md`.

### Konflikt z innym edytorem

Aplikacja obserwuje folder. Jeżeli plik zmieni się np. w Obsidianie, porównuje nową treść z ostatnim znanym stanem. Bezpieczne zmiany włącza automatycznie. Gdy dwie zmiany dotyczą tego samego fragmentu i nie ma pewnego wyniku, zachowuje obie wersje i pokazuje ekran porównania. Nie nadpisuje po cichu pracy użytkownika.

## 5. Funkcje notatek

Pierwsza wersja obsługuje:

- Markdown: nagłówki, listy, zadania, cytaty, kod, tabele, obrazy i linki;
- tabele z adresami komórek jak w Excelu (kolumny A, B, C…, wiersze 1, 2, 3…) i podstawowymi formułami: dodawanie, odejmowanie, suma, średnia, działania na datach;
- edycję z podglądem oraz przełączenie na surowy Markdown;
- foldery, tagi, ulubione i wyszukiwanie po tytule oraz treści;
- linki między notatkami (także `[[wikilinki]]` jak w Obsidianie), listę odnośników zwrotnych i **graf** powiązań (globalny i lokalny dla otwartej notatki);
- automatyczny zapis i historię wersji;
- kosz na usunięte notatki;
- wspólną edycję, kursory uczestników i stan połączenia.

Drugi rodzaj przestrzeni — **organizacja** (projekty, zadania przypisane do osób, terminy, powiadomienia, jak w Basecampie): [ORGANIZACJA.md](ORGANIZACJA.md).

Pełna lista funkcji wzorowanych na Obsidianie, z podziałem na wersję 1 i późniejsze: [FUNKCJE.md](FUNKCJE.md).

Bardziej rozbudowane bazy, widoki tabelaryczne i własne typy obiektów można dodać po ustabilizowaniu zapisu oraz synchronizacji.

## 6. Format danych na dysku

Przykładowa przestrzeń:

```text
Moje notatki/
├── Projekty/
│   ├── Plan.md
│   └── Spotkanie.md
├── Pomysły.md
├── assets/
│   └── szkic.png
└── .notes-sync/
    ├── dane synchronizacji
    ├── lokalny indeks
    └── historia wersji
```

Treść strony pozostaje standardowym Markdown. Proste właściwości można umieścić w nagłówku YAML:

```md
---
id: 7f4c0e2a
title: Plan
tags: [projekt, pomysł]
---

# Plan

Pierwszy szkic notatki.
```

Linki do plików i obrazów powinny używać względnych ścieżek, aby działały również poza aplikacją. Ukryty folder `.notes-sync` przechowuje dane potrzebne do synchronizacji i historii. Bez niego bieżące pliki `.md` nadal muszą być czytelne.

Zmiana nazwy, przeniesienie i usunięcie pliku są osobnymi zdarzeniami synchronizacji. Usunięcie jest zapamiętywane, żeby stara kopia offline nie odtworzyła przypadkiem skasowanej notatki.

## 7. Szyfrowanie i synchronizacja P2P

Każde urządzenie ma własną tożsamość kryptograficzną. Przestrzeń ma klucz szyfrujący znany wyłącznie jej uczestnikom. Treść notatek, załączniki i zmiany są szyfrowane na urządzeniu przed wysłaniem. Odbiorca odszyfrowuje je u siebie.

Urządzenia znajdujące się w tej samej sieci odnajdują się i wymieniają dane bezpośrednio. Przez internet również próbują połączyć się bezpośrednio. Gdy sieć na to nie pozwala, pośrednik może przekazać zaszyfrowane pakiety, ale nie posiada klucza do ich odczytu.

Jeżeli wszystkie pozostałe urządzenia są wyłączone, zmiany trafiają do **węzła przechowującego**: małego programu uruchamianego na VPS, Raspberry Pi albo domowym serwerze, który przechowuje wyłącznie zaszyfrowane zmiany i nie ma klucza do ich odczytu. Dzięki niemu druga osoba dostaje zmiany, nawet gdy autor ma już wyłączony komputer. Węzeł jest częścią pierwszej wersji, ale nie jest wymagany — bez niego zmiany czekają lokalnie, aż oba komputery będą online.

Kilka osób może równocześnie pisać w jednej notatce. Aplikacja wymienia małe operacje edycji i łączy je w spójną treść. Samo przesyłanie całych plików `.md` nie wystarcza do takiej współpracy.

Po usunięciu uczestnika klucz przestrzeni jest zmieniany dla przyszłych zmian. Wcześniej pobranych danych nie da się usunąć z jego komputera.

**Granica szyfrowania:** szyfrowanie end-to-end chroni synchronizację i dane przechowywane u pośrednika. To, co leży na dysku, zależy od rodzaju przestrzeni wybranego przy jej tworzeniu:

- **Przestrzeń otwarta** — pliki `.md` są czytelne na dysku i działają w innych edytorach. Przed dostępem do dysku chroni je tylko szyfrowanie dysku systemowego.
- **Przestrzeń zaszyfrowana** — na dysku nie ma żadnej jawnej treści: notatki, nazwy, załączniki, indeks, historia i kosz są zaszyfrowane. Przestrzeń odblokowuje się hasłem. Obsidian jej nie otworzy; pliki `.md` powstają tylko przez świadomy eksport.

## 8. Historia i bezpieczeństwo zapisu

Aplikacja zapisuje wersje po serii edycji, przed włączeniem zmian zewnętrznych i przed przywróceniem wcześniejszego stanu. Wersja ma datę oraz autora. Przywrócenie tworzy nową wersję; nie usuwa późniejszej historii.

Zmiana musi zostać bezpiecznie zapisana lokalnie, zanim interfejs pokaże, że została zachowana. Zapis pliku `.md` powinien być odporny na przerwanie pracy aplikacji. Historia pozwala naprawić pomyłki, ale nie zastępuje osobnej kopii bezpieczeństwa całego folderu.

## 9. Szybkość i płynność

Aplikacja nie wczytuje wszystkich plików przy każdym uruchomieniu. Korzysta z lokalnego indeksu, otwiera treść dopiero wtedy, gdy jest potrzebna, i aktualizuje wyszukiwanie stopniowo. Szyfrowanie, synchronizacja i skanowanie plików nie mogą zatrzymywać edytora.

Wstępne cele do pomiaru na ustalonym komputerze testowym z przestrzenią liczącą 10 000 notatek:

- uruchomienie aplikacji w mniej niż 2 sekundy;
- przełączenie między wcześniej otwartymi notatkami w mniej niż 50 ms;
- wynik lokalnego wyszukiwania w mniej niż 100 ms;
- płynne pisanie i przewijanie podczas synchronizacji.

To cele projektowe, nie wyniki już wykonanych pomiarów. Dobór biblioteki interfejsu powinien nastąpić po prototypie na Linuxie i Windowsie. Kandydatem na wspólny silnik danych jest Rust; Yrs może łączyć równoczesne zmiany, a SQLite FTS5 obsługiwać lokalne wyszukiwanie.

## 10. Etapy budowy

1. **Prototyp interfejsu i pomiary:** główne okno, drzewo plików, karty, edytor oraz sprawdzenie szybkości na Linuxie i Windowsie.
2. **Notatki lokalne:** import i zapis `.md`, wyszukiwanie, linki, załączniki, historia i wykrywanie zmian zewnętrznych.
3. **Tożsamość i zaproszenia:** klucze urządzeń, role uczestników oraz odzyskiwanie dostępu.
4. **Współpraca P2P:** szyfrowanie, równoczesna edycja, praca offline, ponowna synchronizacja i węzeł przechowujący.
5. **Wersja webowa:** rdzeń jako WebAssembly, przechowywanie w przeglądarce, synchronizacja przez węzeł.
6. **Dopracowanie:** testy konfliktów, odzyskiwanie po awarii, dostępność interfejsu i pomiary wydajności.

## 11. Kryteria ukończenia pierwszej wersji

- Aplikacja działa na Linuxie i Windowsie oraz w przeglądarce (Chrome, Firefox, Safari — aktualne wersje).
- W tabeli działają adresy komórek i formuły z ARCHITEKTURA §4.16a; plik `.md` z tabelą otwiera się poprawnie w Obsidianie.
- Dwie osoby mogą jednocześnie edytować jedną notatkę bez utraty tekstu.
- Zmiany offline synchronizują się po powrocie połączenia.
- Z węzłem przechowującym: osoba B dostaje zmiany osoby A, nawet gdy A wyłączyła komputer przed włączeniem komputera B.
- Notatka jest czytelnym plikiem `.md` i otwiera się w zwykłym edytorze.
- Zmiana wykonana w zewnętrznym edytorze nie zostaje cicho nadpisana.
- Można porównać i przywrócić starszą wersję.
- Osoba bez uprawnień nie może odczytać ani zmienić współdzielonej przestrzeni.
- Pośrednik synchronizacji nie otrzymuje kluczy ani jawnej treści notatek.
- W przestrzeni zaszyfrowanej na dysku nie ma jawnej treści, nazw notatek ani załączników.
- Cele szybkości zostały sprawdzone pomiarami na obu systemach.

## Materiały odniesienia

- Obsidian, eksplorator plików: https://obsidian.md/help/plugins/file-explorer
- Obsidian, odnośniki zwrotne: https://obsidian.md/help/plugins/backlinks
- Anytype, protokół any-sync: https://github.com/anyproto/any-sync
- Yrs, łączenie zmian w Rust: https://docs.rs/yrs/latest/yrs/
- SQLite FTS5, wyszukiwanie pełnotekstowe: https://www.sqlite.org/fts5.html
