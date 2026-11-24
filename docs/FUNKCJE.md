# Funkcje jak w Obsidianie

Lista funkcji Obsidiana (wbudowane wtyczki i edytor, wersja 1.14.4 — nazwy z jego polskiego interfejsu) i co z nimi robimy. Piszemy je sami; Obsidian jest programem zamkniętym, nie kopiujemy kodu. Kolejność prac: [PLAN-BUDOWY.md](PLAN-BUDOWY.md). Stan: ✅ jest, 🔨 w budowie, — jeszcze nie.

## A. Wersja 1 — rdzeń doświadczenia Obsidiana

| Funkcja (nazwa w Obsidianie) | Co robi | Stan | Uwagi |
|---|---|---|---|
| Eksplorator plików | drzewo folderów i notatek, przeciąganie, zmiana nazwy | ✅ | drzewo, akcje (nowa notatka i folder, sortowanie, menu kontekstowe), przeciąganie; kosz tylko w rdzeniu, interfejs usuwa bez kosza |
| Szybki przełącznik (Ctrl+O/Ctrl+P) | otwieranie notatki po nazwie, tworzenie nowej z wpisanej nazwy | ✅ | Enter bez wyników albo Shift+Enter tworzy notatkę z wpisanej nazwy (także `folder/Nazwa`); istniejąca ścieżka się otwiera |
| Paleta poleceń (Ctrl+P w Obsidianie) | wszystkie polecenia z klawiatury | ✅ | u nas Ctrl+Shift+P i F1 (ARCHITEKTURA §5) |
| Tryb odczytu / Tryb edycji (Ctrl+E) | przełączanie widoku | ✅ | widok czytania z rdzenia; Ctrl+E przełącza też kalendarz i jego tekst |
| Podgląd na żywo | pisanie w ładnym widoku, znaki Markdown tylko przy kursorze | ✅ | przeniesione do wersji 1; tryb źródłowy w ustawieniach |
| Linki `[[…]]` | linki między notatkami, `[[notatka#nagłówek]]`, `[[notatka#^blok]]`, `[[notatka\|alias]]`, podpowiedzi przy pisaniu `[[` | 🔨 | `[[…]]` i `[[…\|alias]]` widoczne i klikane; indeks zna nagłówki i bloki; klikanie `#nagłówka` i `#^bloku`, podpowiedzi przy `[[` — nie |
| Osadzanie `![[…]]` | wstawienie notatki, fragmentu albo obrazu w treść | — | |
| Odnośniki zwrotne | kto linkuje do tej notatki (z kontekstem), także wzmianki bez linku | 🔨 | panel „Odnośniki zwrotne” w prawym panelu; wzmianek bez linku nie ma |
| Łącza wychodzące | dokąd linkuje ta notatka | 🔨 | w indeksie (`outgoing_json`), bez panelu |
| Widok grafu / Graf lokalny | mapa powiązań, filtry, grupy kolorów | 🔨 | globalny w karcie; filtry, grupy, wyświetlanie, siły; ARCHITEKTURA §4.15. Węzły plików (kwadrat, klik otwiera podgląd) i osób (romb), wzmianki bez linku, także z rozpoznanego tekstu plików; przełączniki „Pliki” (wł.), „Osoby”, „Wzmianki” (wył.) — [OCR.md](OCR.md) §4.4. Graf lokalny jeszcze nie (prawy panel ma tylko odnośniki i tagi) |
| Wyszukiwanie | pełnotekstowe z operatorami (`tag:`, `path:`, `file:`, `"fraza"`, `-wyklucz`), podświetlenie wyników | ✅ (przeglądarka) | panel „Szukaj”: notatki i rozpoznany tekst plików (BM25, literówki, bez polskich znaków), operatory `typ:pdf`, `typ:obraz`, `w:pliki`, `w:notatki`; wynik z pliku otwiera podgląd na zakładce „Tekst” na tej stronie z zaznaczonym słowem (`ui/src/ocr/appsearch.ts`, [OCR.md](OCR.md) §3.6); pulpit: FTS5 jeszcze nie |
| Tagi | `#tag`, `#tag/podtag`, panel tagów z licznikami | ✅ | panel „Tagi” w prawym panelu, filtr grafu |
| Właściwości | nagłówek YAML jako formularz (tekst, liczba, data, lista, pole wyboru) | — | panel „Właściwości” na razie tylko z napisem „Wkrótce” |
| Konspekt | spis nagłówków aktywnej notatki, przewijanie do sekcji | ✅ | panel „Konspekt” w prawym panelu; kreski nagłówków przy krawędzi edytora (`#` dłuższa, `##`, `###` krótsze): najechanie pokazuje nagłówek, kliknięcie przenosi, bieżąca sekcja podświetlona; strona w ustawieniach (po prawej, po lewej, wyłączone) |
| Liczba słów | na pasku stanu | ✅ | |
| Notatki dzienne | „Dzisiejsza notatka” z formatem daty, folderem i szablonem | ✅ | polecenie „Dzisiejsza notatka”: `RRRR-MM-DD.md` w folderze z ustawień, nowa notatka z szablonu z ustawień (`ui/src/templates.ts`) |
| Szablony | wstawianie szablonu, `{{date}}`, `{{time}}`, `{{title}}` | ✅ | polecenie „Wstaw szablon”: notatki z folderu szablonów (ustawienia, domyślnie „Szablony”), zmienne `{{title}}`, `{{date}}`, `{{time}}`, `{{date:RRRR-MM-DD}}` z tokenami YYYY MM DD HH mm |
| Zakładki | ulubione notatki, wyszukiwania i nagłówki | — | PLAN §5 „ulubione” |
| Podgląd strony | podgląd notatki po najechaniu na link (z Ctrl) | — | |
| Odzyskiwanie plików | kopie notatek co kilka minut, przywracanie | — | u nas: historia wersji (ARCHITEKTURA §4.13) |
| Edytor: wyróżnienia i bloki | `==zakreślenie==`, `%%komentarz%%`, przypisy `[^1]`, bloki „callout” `> [!note]`, listy zadań, bloki kodu z kolorowaniem | 🔨 | `==…==`, callouty (note, tip, warning, danger, info) i zadania ✅; `%%komentarz%%` i przypisy `[^1]` — nie |
| Zadania we własnych notatkach | W przestrzeni „notatki” zadania mają znaczniki (termin, priorytet, trudność), panel zadania po kliknięciu (bez osób, nadzoru, grup, przypomnień i historii) i widok „Zadania” w panelu bocznym | ✅ | jedna osoba: bez przypisań i kopii z innych przestrzeni; stałe identyfikatory `^z-` tylko w organizacji |
| Tabele | edycja tabel | ✅ + formuły jak w Excelu (u nas więcej niż w Obsidianie) | |
| Kalendarz (notatka typu kalendarz) | wydarzenia w notatce, widok dzień / tydzień / miesiąc / harmonogram, powtarzanie | ✅ | `typ: kalendarz` w nagłówku YAML, reguły RRULE jak w Google Calendar; ARCHITEKTURA §4.16b |
| „Mój kalendarz” i własny kalendarz | jeden widok wydarzeń ze wszystkich przestrzeni; nowe wydarzenie trafia do „Moich notatek” (widzi je tylko właściciel) albo do wybranej organizacji | ✅ | wybór przestrzeni przy „Utwórz”, ARCHITEKTURA §4.16b |
| Przypomnienia i `.ics` w kalendarzu | przypomnienie przed wydarzeniem (`🔔 15`), import i eksport plików `.ics` z Google Calendar, Outlooka i innych | ✅ | ARCHITEKTURA §4.16b |
| Załączniki | wklejanie i przeciąganie obrazów i plików do folderu załączników | — | ARCHITEKTURA §4.16 |
| Automatyczna aktualizacja linków | po zmianie nazwy notatki linki w innych notatkach się poprawiają | ✅ | zmiana nazwy lub przeniesienie notatki albo folderu przepisuje `[[linki]]` i `![[osadzenia]]` w notatkach, które do niej prowadzą (`index::rename_links`; kod i bloki kodu nietknięte, alias, nagłówek i blok zachowane). Linki Markdown `[tekst](plik.md)` i linki w nagłówku YAML — nie |
| Podział ekranu | kilka notatek obok siebie, przypięte karty | 🔨 | dwie notatki obok siebie: „Otwórz obok” w menu notatki i polecenie „Otwórz notatkę obok”, „Zamknij podział”; pasek formatowania, szablony i dyktowanie działają w panelu z kursorem. Przypiętych kart i więcej niż dwóch kolumn nie ma; panel obok pokazuje tekst (bez widoku kalendarza, tablicy i czytania); od 900 px szerokości |
| Skróty klawiszowe | własne przypisania w ustawieniach | 🔨 | lista skrótów w ustawieniach (tylko do odczytu); zmiany przypisań — nie |
| O programie i licencje | licencja aplikacji, kod źródłowy działającej wersji, licencje bibliotek | ✅ | Ustawienia → O programie: AGPL-3.0-or-later prostym językiem, link do treści licencji, link do kodu tej wersji strony (commit z budowania) i serwera (`GET /api/source`), „Pokaż licencje” (`THIRD_PARTY_NOTICES.txt`), biblioteki LGPL ze źródłami; informacja, że projekt jest rozwijany (LICENCJE.md) |
| Motywy | jasny/ciemny ✅, własne fragmenty CSS — | 🔨 | ciemny, jasny i systemowy w ustawieniach ✅; własne fragmenty CSS — nie |

## B. Po wersji 1

| Funkcja | Co robi | Uwagi |
|---|---|---|
| Tablica (Canvas) | nieskończona tablica z kartami i połączeniami | duży osobny edytor; format `.canvas` (JSON) zgodny z Obsidianem |
| Bazy danych (Bases) | widoki tabel/kart z filtrami i sortowaniem po właściwościach | PLAN §5 odkładał „bazy” — wracają tutaj |
| Diagramy Mermaid, wzory LaTeX | renderowanie w widoku | Mermaid tylko dla zaufanych przestrzeni (jak w Obsidianie) |
| Slajdy | prezentacja notatki, `---` dzieli slajdy | |
| Dyktafon | nagrywanie audio jako załącznik | |
| Kompozytor notatek | scalanie notatek, wydzielanie zaznaczenia do nowej | |
| Losowa notatka, Niepowtarzalna notatka | otwórz losową; nowa notatka z sygnaturą czasu | małe |
| Obszary robocze | zapisane układy paneli | |
| Eksport PDF | | |
| Tryb Vim | | |

## C. Czego nie robimy

| Funkcja | Dlaczego |
|---|---|
| Obsidian Sync, Obsidian Publish | mamy własną synchronizację P2P z szyfrowaniem i węzłem (SIEC, SZYFROWANIE) |
| Wtyczki społeczności | uruchamianie cudzego kodu z dostępem do kluczy przestrzeni — ryzyko bezpieczeństwa; ewentualnie dużo później w piaskownicy |
| Przeglądarka stron (Web viewer) | poza celem aplikacji do notatek |

## D. Przenoszenie notatek do i z plików

| Funkcja | Co robi | Stan | Uwagi |
|---|---|---|---|
| Eksport wszystkich notatek | ZIP z notatkami w folderach i plikami załączników w `pliki/` (serwer) lub `assets/` (aplikacja); `![[plik:…]]` przepisane na `![[pliki/<nazwa>]]` | ✅ | przeglądarka: polecenie w palecie „Pobierz wszystkie notatki (.zip)”; ostrzeżenie przed pobraniem niezaszyfrowanej kopii; brakujące pliki w `BRAKUJACE-PLIKI.txt` (`transfer.ts`); rozpoznany tekst pliku obok niego jako `<nazwa>.tekst.md` (ustawienie „Dołącz rozpoznany tekst do kopii .zip”, domyślnie wł.) |
| Pobieranie zaznaczonych | Zaznaczone notatki i foldery (notatki w folderze wchodzą cało) jako ZIP z plikami tych notatek. Zaznaczanie: Ctrl/Cmd+klik przełącza wiersz, Shift+klik zaznacza zakres, Ctrl+A zaznacza widoczne, Esc czyści; na dotyku przycisk „Zaznacz” zamienia stuknięcia w przełączanie. Pasek pod drzewem: „Pobierz (.zip)” i „Wyczyść”. Menu kontekstowe: „Pobierz (.zip)” | ✅ | plik `notatki-RRRR-MM-DD.zip`, a przy jednym folderze `<nazwa folderu>.zip`; ta sama zgoda i ostrzeżenie co przy eksporcie; w drzewie są tylko notatki, do których masz dostęp (`exportNotes` w `transfer.ts`, `tree.ts`) |
| Import plików `.md` | Tworzy notatki z plików, bez nadpisywania (`nazwa (2).md`), usuwa BOM i zmienia CRLF na LF | ✅ | przeglądarka: przeciągnij pliki `.md` albo folder z komputera na drzewo plików; podświetlany jest folder, do którego trafią (dla korzenia całe drzewo); foldery zachowują strukturę. Pliki spoza `.md` są pomijane. Również polecenia w palecie „Wgraj pliki .md…” i „Wgraj folder z notatkami…”. W edytorze upuszczenie plików wstawia załączniki (`transfer.ts`, `tree.ts`) |
| Tabela do Excela | Przycisk w rogu tabeli (nad numerami wierszy, widoczny po najechaniu) pobiera `Tabela.xlsx`: wartości po obliczeniu formuł, nagłówek pogrubiony, liczby i daty jako liczby i daty Excela | ✅ | tylko wartości, bez formuł (`xlsx.ts`, `livepreview.ts`) |
| Wykresy | Blok ```` ```wykres ```` (słupkowy lub kołowy) rysowany w notatce i w widoku czytania; kliknięcie otwiera okno z typem, tytułem i wartościami; „/wykres” albo przycisk w rogu tabeli, który wstawia wykres połączony z tą tabelą | ✅ | `charts.ts`, `chartdialog.ts`; wykres z `tabela: powyżej` czyta najbliższą tabelę nad sobą (kolumna z `kolumna:`, domyślnie pierwsza z liczbami) i zmienia się razem z nią; bez tabeli albo kolumny z liczbami pokazuje komunikat; można go odłączyć i wpisać własne wartości; kołowy łączy pozycje od 8. w „Inne” |
| Schematy | Blok ```` ```schemat ```` z prostokątami o zaokrąglonych rogach i połączeniami (`->`, `<-`, `<->`, `--`, przerywane `..>` i `..`), w 8 kolorach; rysowany w notatce i w widoku czytania; kliknięcie otwiera okno z podglądem, w którym prostokąty przeciąga się po siatce; „/schemat” | ✅ | `diagram.ts`, `diagramdialog.ts`; układ automatyczny warstwami (w prawo albo w dół) albo pozycje `kol,wiersz` po przeciągnięciu; połączenie, które przecięłoby inny prostokąt, biegnie objazdem; wszystko zostaje tekstem w `.md` |
| Kanban z własnymi kolumnami | notatka-tablica (`typ: kanban`, `kolumny: …`) zbiera zadania z folderu i podfolderów; przeciąganie i Alt+←/→ zapisują `!etap:` na linii zadania; „+ Dodaj zadanie”; „Kolumny…” zmienia nazwy i przepisuje tokeny | ✅ | `kanban.ts`, `projectpage.ts`; token `!etap:` w rdzeniu (`index/parse.rs`); ostatnia kolumna = zrobione; strona projektu ma dalej 4 stałe kolumny |
| Pliki w folderach | dowolne pliki w zwykłych folderach drzewa: „Wgraj pliki…”, upuszczenie na folder, podgląd, zmiana nazwy, przeniesienie, odnośnik do notatki | ✅ (przeglądarka) | `folderfiles.ts`, `state.folderFiles` w snapshocie; nie w chronionych projektach; aplikacja na komputer jeszcze nie |
| Podgląd plików | okno podglądu (dwuklik, spacja, menu „Podgląd”, paleta): obrazy (JPG, PNG, GIF, WebP, AVIF, BMP, SVG jako obraz, TIFF, PSD, HEIC), PDF, DOCX, DOC (tekst), XLSX/XLS/XLSB/ODS, CSV, PPTX, PPT (tekst i obrazy), tekst i kod, audio, wideo (pierwsza klatka: mp4, webm, mov, mkv, avi), 3D (obj, stl, ply, glTF/GLB, fbx, 3ds, 3mf, amf, dae, wrl, off, IFC), chmury punktów (LAS ≤ 1.3, PCD, PLY), DXF, DWG, fonty, ZIP (lista); reszta (także 3DM, STEP, IGES, BREP): karta „Pobierz” | ✅ (przeglądarka) | odizolowana ramka `/preview/`, biblioteki ładowane na żądanie, `crates/preview` (WASM); [PODGLAD.md](PODGLAD.md); pulpit jeszcze nie |
| Podgląd dyktowania na żywo | szary tekst przy kursorze rośnie w trakcie mówienia, gotowy fragment go zastępuje | ✅ | `voice/partial.ts`, `voice/ghost.ts`; wyłącza się na wolnym sprzęcie |
| Podpowiedzi przycisków paska | dymek z nazwą i skrótem po najechaniu (0,35 s, przy przesuwaniu po pasku od razu) i przy fokusie klawiatury; mikrofon pokazuje swój stan | ✅ | `tooltip.ts`; zamiast natywnego `title` |
| Wklejanie z Excela | Komórki skopiowane z Excela, LibreOffice albo Arkuszy Google wklejają się jako tabela Markdown (pierwszy wiersz to nagłówek) | ✅ | `excelpaste.ts` |
| Foldery plików w notatce | `> [!pliki] Nazwa` pokazuje się jako ikonka folderu z nazwą; kliknięcie otwiera duże okno z plikami: wysyłanie, podfoldery (zagnieżdżone `> > [!pliki]`, do 5 poziomów), ścieżka, usuwanie podfolderu. Wstawianie: menu „/” → „Folder z plikami” albo pasek nad notatką | ✅ | pliki usuniętego folderu zostają w zakładce „Pliki” (`filefolders.ts`, `filefolders-view.ts`) |

## E. Projekt połączony z GitHubem

| Funkcja | Co robi | Stan | Uwagi |
|---|---|---|---|
| Połączenie projektu z repozytorium | `README` i pliki Markdown z dowolnego repozytorium GitHub jako notatki projektu, aktualizowane samoczynnie, z dopiskami zachowanymi przy aktualizacjach | ✅ web | `ui/src/github/`, `crates/core/src/github*.rs`, blokady `crates/node/src/leases.rs`; desktop: tylko logika w `notes-core` (GITHUB.md, „Odchylenia przy implementacji”) |
| Dowolny folder, tryby i „Zostaw jako własną” | Połączenie zwykłego folderu (menu folderu → „Połącz z GitHubem…”), pliki prosto w folderze obok własnych notatek; tryb „Połączone z GitHubem” albo „Tylko odczyt”; pojedyncza notatka zostawiona jako własna | ✅ web | `ui/src/explorer.ts`, `ui/src/github/connect-view.ts`, `notebar.ts`, `browser-service.ts`; GITHUB.md §2 |

## Zasada bezpieczeństwa dla wszystkich funkcji

Treść notatek może pochodzić od współautora, więc wszystko, co renderuje treść (widok czytania, podgląd, osadzanie, Mermaid, podgląd po najechaniu), przechodzi przez renderer w rdzeniu, który neutralizuje surowy HTML i niebezpieczne linki (zadanie T7a).
