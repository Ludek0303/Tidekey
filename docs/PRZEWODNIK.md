# Przewodnik po Notatkach

Jak używać aplikacji: pierwsze kroki, funkcje, praca zespołowa, Claude, kopie zapasowe, skróty i znane ograniczenia.
Opis projektu, uruchomienie i licencja: [README](../README.md). Projekt jest wciąż rozwijany, więc część opisów może
wyprzedzać albo nie nadążać za aplikacją ([FUNKCJE.md](FUNKCJE.md) mówi, co jest gotowe).

## Trzy sposoby używania

| Wariant | Dla kogo | Gdzie są dane |
|---|---|---|
| **Strona w przeglądarce** (z serwerem `notes-node`) | zespoły, praca z wielu urządzeń | zaszyfrowane na serwerze; klucze tylko u użytkowników |
| **Aplikacja na komputer** (Tauri, Linux i Windows) | praca lokalna, pliki `.md` na dysku | folder na dysku, synchronizacja P2P między urządzeniami |
| **Demo** (`?demo=1`) | obejrzenie bez konta | tylko w pamięci karty; znika po zamknięciu |

Wszystkie trzy warianty używają tego samego interfejsu i tego samego rdzenia w Ruście. W przeglądarce rdzeń działa jako WebAssembly.

## Szyfrowanie: co widzi serwer

Klucz do notatek powstaje z **kodu odzyskiwania**, który dostajesz przy zakładaniu konta. Hasło służy tylko do logowania. Klucz sejfu organizacji jest zaszyfrowany osobno dla każdego członka.

| | Serwer widzi? |
|---|---|
| treść notatek, tytuły, ścieżki folderów, tagi, linki | ❌ |
| załączniki i ich nazwy | ❌ |
| nazwiska (szyfrowane kluczem sejfu) | ❌ |
| treść chronionych projektów (osobny klucz tylko dla ich członków) | ❌ |
| e-mail i imię konta, kto należy do którego sejfu i z jaką rolą | ✅ |
| kiedy i jak dużo ktoś zapisuje, adresy IP | ✅ |

Szczegóły: [SZYFROWANIE.md](SZYFROWANIE.md) oraz [WEB-WSPOLDZIELENIE.md](WEB-WSPOLDZIELENIE.md).

> ⚠️ **Zapisz kod odzyskiwania.** Bez niego i bez zalogowanego urządzenia nie da się odzyskać notatek. Administrator serwera może zresetować hasło, ale nie odszyfruje danych.

## Pierwsze kroki

1. **Załóż konto.** Podaj imię, e-mail i hasło (dwa razy; kropka obok pola pokazuje, czy hasło spełnia wymagania i czy oba się zgadzają). Potwierdź regulamin i ukończone 16 lat.
2. **Zapisz kod odzyskiwania** i potwierdź, że go masz.
3. Otwierają się **Moje notatki**, czyli prywatny sejf, który widzisz tylko Ty. Konto założone z linku zaproszenia otwiera od razu tę organizację, a „Moje notatki” dostaje dopiero po zgodzie administratora serwera (Ustawienia → Konto → „Poproś o własne notatki”).
4. **Załóż organizację:** kliknij nazwę przestrzeni na górze → „Nowa organizacja…”.
5. **Zaproś ludzi:** nazwa przestrzeni → „Członkowie i zaproszenia…” → „Utwórz link”. Jeden link może wpuścić od 1 do 50 osób. Klucz jest w części linku po `#`, której przeglądarka nie wysyła do serwera.
6. Przełączaj się między przestrzeniami kliknięciem w nazwę. Aplikacja wraca do notatki, na której ostatnio byłeś w danej przestrzeni.

Role w organizacji:

| Rola | Może |
|---|---|
| **właściciel** | wszystko, także usunąć organizację; widzi wszystkie projekty i notatki; tworzy nowe projekty oraz foldery i notatki w głównym folderze |
| **administrator** | zarządza członkami, rolami, uprawnieniami i kluczami; widzi wszystkie projekty i notatki; tworzy nowe projekty oraz foldery i notatki w głównym folderze |
| **edytor** | pisze i zmienia notatki, do których ma dostęp; tworzy foldery i notatki tylko w folderach udostępnionych mu |
| **czytelnik** | tylko czyta |

Główny folder (i bezpośrednio `Projekty/`) jest dla właściciela i administratora: edytor nie utworzy tam nowego projektu, folderu ani notatki, a przycisk „Nowy projekt” jest mu ukryty. Otwarty folder (bez ochrony) edytor może uzupełniać, chroniony tylko wtedy, gdy ma w nim prawo edycji.

## Funkcje

### Edytor
- **Podgląd na żywo:** znaczniki Markdown chowają się, gdy kursor jest poza linią. Do tego tryb źródłowy i tryb czytania (Ctrl+E).
- **Pasek formatowania** (pogrubienie, kursywa, przekreślenie, zakreślenie, nagłówki, listy, zadania, cytat, kod, link, tabela). W ustawieniach wybierasz jego miejsce: góra, dół, lewo lub prawo.
- **Menu `/`:** wpisz ukośnik, żeby wstawić zadanie, tabelę, nagłówek, blok kodu, plik lub spotkanie.
- **Wikilinki** `[[Notatka]]` i `[[Notatka|alias]]`, odnośniki zwrotne, tagi, wyróżnienia `> [!note]`.
- **Licznik słów i znaków** na dole po prawej. Przy zaznaczeniu liczy samo zaznaczenie.
- **Sprawdzanie pisowni i autokorekta** w wybranym języku (polski, angielski, niemiecki, ukraiński). Słownik pochodzi z przeglądarki lub systemu, a całość można wyłączyć w ustawieniach.
- **Historia wersji** każdej notatki z przywracaniem.
- **Dyktowanie** (w przeglądarce): przycisk mikrofonu na pasku albo Ctrl+Shift+D. Mówisz po polsku (lub w jednym z 24 innych języków europejskich), a tekst z interpunkcją i wielkimi literami pojawia się w miejscu kursora; jedno Ctrl+Z cofa jeden fragment. Mowa jest rozpoznawana w całości na urządzeniu (model Parakeet Ultra w Web Workerze, WebGPU albo WASM), dźwięk nie opuszcza przeglądarki i nie jest zapisywany. Model (ok. 670 MB albo 1,2 GB) pobiera się z serwera Notatek raz, po zgodzie; usuniesz go w Ustawieniach → Dyktowanie. Szczegóły: [DYKTOWANIE.md](DYKTOWANIE.md), wyniki: [POMIARY.md](POMIARY.md).

### Tabele jak w arkuszu
- Litery kolumn i numery wierszy, adres komórki (np. `B3`) w pasku nad tabelą, poruszanie się Tab, Shift+Tab i Enter.
- Kolumny i wiersze dodaje się plusem na linii między literami kolumn albo numerami wierszy (widać je po najechaniu na tabelę). Kliknięcie litery lub numeru otwiera „Usuń kolumnę” / „Usuń wiersz”.
- Shift+Enter dzieli komórkę na linie (w pliku zapisuje się jako `<br>`). Krótkie wartości bez spacji, np. daty i liczby, nie łamią się.
- Formuły z wynikami: `=SUMA(B2:B9)`, `=C2-B2`, `=JEŻELI(…)`, daty i więcej.
- **Pola wyboru w komórkach:** `[ ]` i `[x]`. Nagłówek kolumny z `!zaznacza:@Skarbnik` sprawia, że zaznaczać mogą tylko wskazane osoby oraz administratorzy, np. przy liście składek. Komórka z `@osoba` trafia tej osobie do powiadomień jako „Do zrobienia”.

### Schematy
- Blok ```` ```schemat ```` (albo „/schemat”) rysuje prostokąty z zaokrąglonymi rogami i strzałki jednostronne, dwustronne, linie i linie przerywane, w 8 kolorach, jak prosty Visio.
- Kliknięcie schematu otwiera okno: prostokąty i połączenia z etykietami, kierunek w prawo albo w dół, przeciąganie prostokątów po siatce, „Układ automatyczny”.
- W pliku zostaje czytelny tekst, np. `[a] Zamówienie | niebieski` i `a -> b : opłacone`, więc cofanie, synchronizacja i historia wersji działają jak przy pisaniu.

### Zdjęcia i pliki
- Przeciągnij plik do notatki albo wybierz „Dodaj plik” z menu `/`. Pliki są szyfrowane przed wysłaniem.
- **Pliki w folderach** (w przeglądarce): prawy przycisk na folderze → „Wgraj pliki…” albo upuszczenie plików na folder w drzewie. Plik leży w folderze obok notatek: klik otwiera podgląd albo pobiera, menu ma „Zmień nazwę”, „Kopiuj odnośnik do notatki” i „Usuń”. Pliki `.md` dalej importują się jako notatki. W chronionym projekcie plik dodaje się w notatce.
- Dokładny rozmiar i położenie zdjęcia: `![[zdjęcie.png|300]]`, `|300x200`, `|300 center`.
- Widok **Pliki** pokazuje wszystkie załączniki, zajęte miejsce i osobny kosz plików.
- **Podgląd plików** (w przeglądarce): dwuklik albo spacja na pliku, „Podgląd” w menu, polecenie „Podgląd pliku”. Okno
  pokazuje obrazy (także TIFF, PSD, HEIC), PDF, Word (DOCX; stare DOC jako sam tekst), Excel i ODS, CSV, PowerPoint
  (PPTX; stare PPT jako tekst i obrazy), tekst i kod z kolorowaniem, dźwięk, pierwszą klatkę filmu, modele 3D (OBJ, STL,
  PLY, glTF, FBX, 3DS, 3MF, AMF, DAE, WRL, OFF, IFC), chmury punktów (LAS, PCD, PLY), rysunki DXF i
  DWG, fonty i listę plików ZIP. Strzałki przechodzą do następnego pliku. Plik jest odszyfrowywany na urządzeniu i
  pokazywany w odizolowanej ramce bez dostępu do sieci i do kluczy; nic nie idzie do zewnętrznych usług.

### Graf
- Graf całej przestrzeni w karcie i lokalny graf notatki w prawym panelu.
- Filtry, kolory grup i ustawienia sił. Układ liczy się w tle (Web Worker), a węzły można przeciągać.

### Kalendarz
- Notatka z nagłówkiem `typ: kalendarz`, w której każde wydarzenie to jedna linia listy.
- Widoki dzień, tydzień, miesiąc i harmonogram. Powtarzanie jak w Google Calendar (codziennie, w dni robocze, co miesiąc, wyjątki).
- **Spotkanie z notatki:** `/spotkanie` albo polecenie „Utwórz spotkanie z tej notatki”. Wydarzenie dostaje link do notatki, a notatka linię `📅 [[Kalendarz]] Spotkanie: …`. W kalendarzu przycisk „Powiązana notatka” otwiera tę notatkę.
- **Mój kalendarz:** ikona kalendarza na wąskim pasku po lewej pokazuje jeden wspólny kalendarz: Twoje wydarzenia z notatek, wydarzenia ze wszystkich Twoich organizacji (tylko te, w których bierzesz udział, oraz ogólne dla całej organizacji) i Twoje zadania z terminem. Każda pozycja ma nazwę przestrzeni, a kliknięcie pozwala do niej przejść. W przeglądarce zbierane są przestrzenie otwarte już kiedyś na tym urządzeniu.

### Drzewo plików i obrazy
- Notatki i **foldery** przenosisz przeciąganiem w drzewie. Folder przenosi się z całą zawartością. Nie da się przenieść folderu do niego samego ani bez uprawnień do edycji.
- Obraz w notatce przesuwasz w poziomie: przeciągnij go albo wpisz „Pozycja (0–50)”. 0 to lewa krawędź obrazu przy lewej krawędzi notatki, 50 to prawa krawędź przy prawej, 25 to środek. Pozycja zapisuje się w linku obrazu jako `poz25`.

### Eksport i import
- **Pobranie:** zaznacz notatki lub foldery w drzewie (Ctrl lub Shift + klik) → „Pobierz (.zip)”. Archiwum zawiera pliki `.md` z załącznikami.
- **Wgranie:** przeciągnij pliki `.md` albo cały folder z komputera do drzewa notatek.

### Wygląd i ustawienia
- Motyw ciemny, jasny lub systemowy, 8 kolorów akcentu albo **własny kolor** z pełnej palety, rozmiar czcionki i szerokość tekstu.
- W wersji przeglądarkowej wygląd i ustawienia edytora są przypisane do konta: po zalogowaniu na innym urządzeniu masz ten sam motyw. Serwer przechowuje je zaszyfrowane kluczem konta.
- Krótkie słowa (1–3 litery, np. „w”, „na”) nie zostają na końcu wiersza, tylko przechodzą do następnego razem z kolejnym słowem. Plik `.md` się nie zmienia.
- Sprawdzanie pisowni korzysta ze słownika przeglądarki. Podkreślenia pojawią się, gdy przeglądarka ma słownik polski (w Chrome: Ustawienia → Języki → Sprawdzanie pisowni).
- Na telefonie dolny pasek, wysuwane menu i okna jako arkusze od dołu.

## Organizacja: praca zespołowa

Przestrzeń typu **organizacja** dodaje sekcje w lewym panelu: Praca (Przegląd, Projekty, Zadania, Pliki), Zespół (Powiadomienia, Aktywność, Osoby i grupy, Grafy) i Moduły (Kalendarze, Inwentarze, Dostępność). Lewy panel zawsze pokazuje też drzewo plików. Pełny opis jest w [ORGANIZACJA.md](ORGANIZACJA.md).

### Zadania
Zadanie to linia listy z dodatkowymi znacznikami:

```markdown
- [ ] Zebrać składki @Anna 📅 2026-11-30 !nadzor:@Jan !trudnosc:3 !przypomnij:1d/2hx3 ^z-7f3a
```

| Znacznik | Znaczenie |
|---|---|
| `@Anna` | wykonawca (może być kilka osób albo grupa) |
| `📅 2026-11-30` | termin |
| `!nadzor:@Jan` | nadzorujący |
| `!trudnosc:3` | trudność 0–10 |
| `!przypomnij:1d/2hx3` | przypomnienie: dzień przed terminem, potem co 2 godziny, łącznie 3 razy |
| `^z-7f3a` | stały identyfikator (nadawany automatycznie, potrzebny do historii zadania) |

- Kliknięcie zadania otwiera **panel zadania**: nazwa (zmieniana w polu „Nazwa”), wykonawca, grupa, termin, nadzór, trudność, przypomnienie i historia zmian. Pole „Więcej zadań dla tej samej osoby” dodaje kolejne zadania po jednym: wpisz tytuł i naciśnij Enter.
- Backspace w pustym zadaniu usuwa je w całości, bez resztek znaczników.
- **Powiadomienia:** przypisanie, zdjęcie z zadania, zmiana terminu, ukończenie. Kliknięcie prowadzi do notatki z zadaniem.

### Projekty
- **Projekt** to folder `Projekty/<Nazwa>/` z notatką projektu. Każdy projekt ma osobny ekran z podsumowaniem zadań, tablicą kanban i osią czasu.
- **Tablica kanban:** każdy nowy projekt dostaje notatkę `Tablica.md` (`typ: kanban`), która zbiera zadania ze wszystkich notatek swojego folderu i podfolderów. To te same zadania co w notatkach, tablica nie ma własnej kopii. Kolumny nazywasz sam („Kolumny…”, w notatce `kolumny: Pomysły, W toku, Gotowe`), a ostatnia oznacza „zrobione”. Przeciągnięcie karty (albo Alt+←/→) zapisuje kolumnę jako `!etap:W_toku` na linii zadania w jego notatce. „+ Dodaj zadanie” dopisuje zadanie do notatki tablicy. Ctrl+E pokazuje tekst notatki. Nową tablicę tworzy prawy przycisk na folderze („Nowa tablica kanban”) albo polecenie o tej nazwie.
- **Projekty są domyślnie prywatne.** Widzą je tylko przypisane osoby i grupy, prowadzący oraz właściciel i administratorzy. Ochrona jest kryptograficzna: projekt ma własny klucz, a osoba spoza projektu nie ma czym go odczytać.
- Przy przypisywaniu grupy od razu widać, które osoby z niej dochodzą („Jan — z grupy Zarząd”).
- Lista projektów i przyciski „Chroń projekt”, „Członkowie projektu”, „Zdejmij ochronę” są na stronie **Projekty**.
- Osoba bez dostępu nie widzi chronionego projektu ani folderu nigdzie: w drzewie, na liście projektów, w wyszukiwaniu, w Ctrl+P, w zadaniach i plikach. Nie może go też usunąć.

### Projekt połączony z GitHubem
- Projekt można połączyć z dowolnym repozytorium na GitHubie: menu projektu → „Połącz z GitHubem…” albo pole „Połącz z GitHubem (opcjonalnie)” w „Nowy projekt”. Wklejasz adres (`właściciel/repo`, `https://github.com/właściciel/repo`, `…/tree/gałąź/podfolder`), „Sprawdź”, „Importuj”.
- `README` i pliki Markdown trafiają jako notatki do `Projekty/<Nazwa>/GitHub/` (przy kilku repozytoriach `GitHub/<repo>/`). Notatki aktualizują się same (co 15 min, co 5 min z tokenem, gdy aplikacja jest otwarta) albo przyciskiem „Sprawdź teraz”.
- Do tych notatek można dopisywać: dopiski zostają przy aktualizacjach (scalanie trójstronne). Gdy GitHub i Ty zmienicie ten sam fragment, plik przestaje się aktualizować do czasu wybrania wersji na ekranie konfliktu. „Moje dopiski” pokazuje tylko to, co dopisałeś. Tryb „Tylko odczyt” wyłącza dopisywanie.
- Połączyć można też dowolny folder: menu folderu → „Połącz z GitHubem…”. Pliki trafiają prosto do folderu, obok Twoich notatek. Pojedynczą notatkę zostawisz jako własną przyciskiem „Zostaw jako własną” na pasku nad nią.
- Kierunek tylko GitHub → notatnik. Repozytoria publiczne działają bez logowania. Token (fine-grained, `Contents: Read-only`) jest osobisty, zaszyfrowany w ustawieniach konta; podnosi limity i jest potrzebny dla repozytoriów prywatnych.
- Serwer nie wie, z jakim repozytorium połączony jest projekt: rekord połączenia jest w zaszyfrowanym stanie projektu (w chronionym projekcie pod kluczem projektu). Z tekstu z GitHuba nie powstają zadania ani wzmianki `@osoba` — liczą się tylko dopiski. Szczegóły: [docs/GITHUB.md](GITHUB.md).

### Uprawnienia notatek i folderów
- Przycisk „Kto widzi i edytuje” w nagłówku notatki albo „Uprawnienia…” w menu drzewa. Ustawiasz, kto widzi folder i kto może w nim edytować. Notatka nie ma własnych uprawnień: oba przyciski otwierają uprawnienia folderu, w którym leży (najbliższego chronionego folderu nad nią, a gdy takiego nie ma — jej własnego). Notatek w głównym folderze nie da się ograniczyć, widzą je wszyscy członkowie. Zmieniają te ustawienia właściciel, administrator, prowadzący projekt oraz edytor chronionego folderu nadrzędnego, gdy zakłada w nim podfolder, który nie ma jeszcze ochrony; pozostali widzą je w podglądzie, bez możliwości zapisu.
- Nowa blokada domyślnie daje dodanym osobom **tylko podgląd**. Edycję trzeba zaznaczyć („może edytować”). Właściciel, administratorzy i osoba zakładająca blokadę edytują zawsze. Osoba z samym podglądem nie zmieni, nie utworzy, nie przeniesie ani nie usunie notatek w zablokowanym miejscu.
- To samo jest w palecie poleceń jako „Kto widzi tę notatkę…”.

### Osoby i grupy
- Grupy mają kolor, a osoba dostaje kolor swojej **pierwszej** grupy.
- Kolejność grup to ich waga: przeciągasz bloczki albo używasz strzałek ← →. Kolejność czyta się wierszami, od lewej do prawej.
- W oknie grupy pole „Szukaj osoby” filtruje listę w trakcie pisania. Enter przy jednym wyniku zaznacza tę osobę.
- **Grafy** mieszczą się w oknie, a przypisania są zwijaną siatką kart.
- **Aktywność** (kto co dodał, przypisał, zamknął) domyślnie widzą właściciel i administratorzy. Administrator może to zmienić.

### Kalendarze i inwentarz w organizacji
- W organizacji jest jeden kalendarz (strona **Kalendarze**). Wygląda i działa jak kalendarz z notatki. Członek widzi wydarzenia, w których bierze udział, które sam organizuje, oraz wydarzenia ogólne (bez wybranych uczestników); właściciel i administratorzy widzą wszystkie spotkania organizacji. To filtr widoku: dane wydarzeń są w zaszyfrowanej kopii, którą ma każdy członek.
- Przy tworzeniu wydarzenia uczestników wybierasz w dwóch częściach: **Grupy** (zaznaczenie grupy dodaje wszystkich jej członków) i **Osoby**.
- **Inwentarz:** przycisk „Utwórz notatkę z tabelą” tworzy notatkę `Inwentarze/<nazwa>.md` z tabelą wszystkich danych o częściach i kopią w formacie CSV. Notatka odświeża się po każdej zmianie w inwentarzu, więc zmiany wprowadza się w module, nie w notatce.

## Claude w Notatkach (MCP)

Claude (Claude Code albo Claude Desktop) może czytać Twoje notatki i zadania i proponować zmiany. Działa jako osobne
urządzenie z własnymi kluczami: nie zna Twojego hasła ani kodu odzyskiwania, a serwer dalej widzi tylko szyfrogramy.
Odszyfrowuje lokalnie, na komputerze, na którym działa. Pełna instrukcja: [MCP-UZYTKOWNIK.md](MCP-UZYTKOWNIK.md),
projekt i zasady bezpieczeństwa: [MCP.md](MCP.md).

**Jak to wygląda:**
1. W aplikacji: **Ustawienia → Urządzenia → Połącz Claude → Rozpocznij parowanie**. Strona pokazuje kod parowania
   (8 znaków, ważny 10 minut). Parowanie zawsze zaczynasz sam, w aplikacji; link do parowania od kogoś innego to oszustwo.
2. Na swoim komputerze: `notatki-mcp pair https://adres-notatek` (z repozytorium:
   `node ~/notes/mcp/dist/notatki-mcp.mjs pair …`). Wpisujesz kod; terminal pokazuje **kod kontrolny** i link.
3. W przeglądarce otwiera się strona **„Kto się łączy”**: nazwa komputera, system, sieć i ten sam kod kontrolny. Jeśli coś
   się nie zgadza, kliknij **Przerwij**.
4. Wybierasz, co Claude widzi: na starcie nic nie jest zaznaczone. Dla każdej przestrzeni osobno: „Moje notatki” albo
   konkretne organizacje, cała przestrzeń albo wybrane foldery, chronione projekty (jeśli organizacja pozwala), tryb
   zapisu i długość sesji (domyślnie 4 h). Na dole widać podsumowanie, np. „Ten czat widzi: Moje notatki (całe, tylko
   odczyt); Klub: Spotkania/ (propozycje)”. Kliknij **Połącz**.
5. Podłącz MCP do Claude (`claude mcp add --scope user notatki -- node ~/notes/mcp/dist/notatki-mcp.mjs`) i pytaj
   zwyczajnie: „Do czego masz dostęp?”, „Jakie mam zadania po terminie?”, „Przygotuj notatkę ze spotkania”.

**Tryby zapisu:**
- **Tylko odczyt** (domyślnie): Claude czyta, szuka, zbiera zadania.
- **Propozycje do zatwierdzenia:** zmiany Claude czekają w **Urządzenia → Propozycje Claude**. Widzisz różnicę przed i
  po; dopiero **Zatwierdź** zmienia notatkę. Licznik propozycji jest przy sekcji Urządzenia.
- **Dopisywanie:** Claude tworzy notatki i dopisuje na końcu, niczego nie zmienia ani nie usuwa.
- **Bezpośrednio:** zmienia jak edytor. Każdą zmianę cofniesz przyciskiem **Cofnij zmiany czatu** (zmiany ludzi zostają).

**Na co dzień** (Ustawienia → Urządzenia): lista czatów z zakresem, ostatnim użyciem i adresem IP; **Zakres**, **Przedłuż**
(sesja wygasa też po godzinie bezczynności), **Propozycje Claude**, **Cofnij zmiany czatu**, **Odłącz** i **Odłącz
wszystkie czaty**. Czat z nowego adresu IP jest wstrzymany, dopóki go nie potwierdzisz. W Aktywności zmiany czatu są
podpisane „(przez Claude)”.

**W organizacji** czaty są domyślnie wyłączone. Właściciel włącza je w **Członkowie i zaproszenia… → Czaty Claude** i
ustala najszerszy tryb zapisu, najdłuższą sesję i to, czy czat może widzieć chronione projekty. Administratorzy widzą
czaty członków i mogą odłączyć czat od organizacji.

**Ważne:** to, co Claude przeczyta, trafia do rozmowy z Claude (do Anthropic). Szyfrowanie end-to-end chroni przed
serwerem, nie przed tym, komu sam pokażesz treść, więc udostępniaj tylko potrzebne foldery. Notatka może zawierać
polecenia podrzucone przez kogoś innego: w rozmowach z notatkami nie włączaj pobierania stron ani innych konektorów
(gotowe ustawienia Claude Code: `mcp/claude-settings.json`). Czat nigdy nie zmienia osób, ról, uprawnień ani swojego
zakresu.

## Bezpieczeństwo danych: kosz i kopie

- **Kosz:** usunięta notatka lub folder trafia do kosza (🗑 nad drzewem) i można ją przywrócić. Po **6 miesiącach** kosz czyści się sam. Notatki z chronionego projektu leżą w koszu nadal zaszyfrowane. Usunięcie całego chronionego projektu jest ostateczne i okno potwierdzenia mówi to wprost.
- **Potwierdzenie przez wpisanie nazwy:** żeby usunąć notatkę lub folder, trzeba wpisać jego nazwę.
- **Kopia zapasowa użytkownika:** Ustawienia → Kopia zapasowa → „Pobierz kopię zapasową”. Pobiera `.zip` ze wszystkimi notatkami i załącznikami; aplikacja przypomina o nim co tydzień albo co miesiąc. Kopia jest **niezaszyfrowana**, więc przechowuj ją bezpiecznie.
- **Kopia serwera:** `scripts/kopia.sh` robi spójną kopię danych serwera (zaszyfrowanych) do `~/backups` i trzyma 14 ostatnich. Nadaje się do crona, opis jest w [DOCKER-WEB.md](DOCKER-WEB.md).

## Skróty klawiszowe

| Skrót | Działanie |
|---|---|
| Ctrl+P | szybkie otwieranie notatki |
| Ctrl+Shift+P, F1 | paleta poleceń |
| `/` w notatce | menu wstawiania |
| Ctrl+E | tryb czytania i edycji (w kalendarzu: kalendarz ↔ tekst) |
| Ctrl+Shift+Enter | tryb skupienia |
| Ctrl+Tab / Ctrl+Shift+Tab | następna / poprzednia karta |
| Ctrl+Alt+W | zamknij kartę |
| Ctrl+B / Ctrl+I / Ctrl+Shift+X | pogrubienie / kursywa / przekreślenie |
| Ctrl+K | link `[[…]]` |
| Ctrl+Shift+D | dyktowanie (w przeglądarce) |
| Tab / Shift+Tab / Enter | w tabeli: następna / poprzednia komórka / wiersz niżej |
| Ctrl+klik | otwórz link |
| Enter, F2, Delete | drzewo: otwórz, zmień nazwę, usuń |
| Ctrl/Shift + klik | drzewo: zaznacz kilka notatek |
| Esc | zamknij okno, menu albo graf |
| t, j/n, k/p, d/w/m/a, c | kalendarz: dziś, następny/poprzedni okres, widok, nowe wydarzenie |

Na macOS zamiast Ctrl działa Cmd.

## Znane ograniczenia

- **Przypomnienia** działają tylko przy otwartej aplikacji, bez powiadomień systemowych. Termin zadania to sam dzień, więc przypomnienie liczy się od godziny 9:00.
- **Zasada „kto zaznacza” w kolumnach tabel** jest pilnowana przez aplikację, a nie przez szyfrowanie. Twardą blokadę daje ograniczenie, kto edytuje notatkę.
- **Kosz w aplikacji na komputer:** po wyczyszczeniu zaszyfrowana historia notatki zostaje w dzienniku zmian; odczytać ją może tylko ktoś z kluczem.
- **Utrata kodu odzyskiwania** i wszystkich zalogowanych urządzeń oznacza utratę dostępu do notatek.
- Spotkanie z notatki trafia do pierwszego kalendarza w przestrzeni; nie ma jeszcze wyboru kalendarza.
- **CSV inwentarza** jest blokiem w notatce z tabelą, a nie osobnym plikiem.
- **Chronionego projektu** (jego folderu) nie można przenosić ani zmieniać mu nazwy (ich szyfrowanie jest związane ze ścieżką). Folder wewnątrz projektu można przemianować, ale nie wynieść z projektu.
- **Chroniony folder w chronionym folderze** ma własnych członków i własny klucz. Jego członek, który nie należy do folderu nadrzędnego, widzi go tylko jako pustą ścieżkę do swojego folderu; treść nadrzędnego zostaje w nim niewidoczna. Folder nadrzędny chroń przed podfolderem, a nie po nim, jeśli ma być zamknięty dla innych.
- **Nazwy chronionych folderów i lista ich członków** są ukryte w aplikacji, ale zapisane w zaszyfrowanej kopii sejfu, którą może odszyfrować każdy członek organizacji. Treść notatek ma osobny klucz i tego nie dotyczy.
- **Dyktowanie** działa tylko w przeglądarce (w aplikacji na komputer jeszcze nie). Pauza dłuższa niż ok. 0,6 s kończy fragment, więc zdanie przerwane w połowie może dostać kropkę. Nazwa własna wypowiedziana po pauzie w środku zdania traci wielką literę.
- **Mój kalendarz** pomija treść chronionych projektów i przestrzenie nieotwarte jeszcze na danym urządzeniu.
- **Podgląd plików:** tylko w przeglądarce. Stare `.doc` bez formatowania, `.ppt` bez układu slajdów, PPTX z
  pptx-browser bywa niewierny (kolory tekstu, efekty). LAS 1.4, 3DM (Rhino) oraz STEP, IGES i BREP — karta „Pobierz”
  (ich biblioteki wymagają `eval`, którego ramka podglądu nie dopuszcza). Filmy H.264/H.265 i
  dźwięk AAC zależą od kodeków przeglądarki (Chromium bez kodeków własnościowych i część Linuksów: karta „Pierwszej
  klatki nie da się pokazać”). Podgląd starego filmu bez miniatury pobiera ok. 16–24 MiB.
