# Przestrzeń organizacji — zadania, osoby, projekty

Drugi rodzaj przestrzeni obok zwykłej przestrzeni notatek: praca zespołu jak w Basecampie — projekty i podprojekty, zadania przypisane do osób, terminy i powiadomienia. Wszystko dalej jest zwykłymi plikami `.md`, synchronizuje się i szyfruje tak samo jak notatki (ARCHITEKTURA, SZYFROWANIE). Miejsca **[decyzja]** są do potwierdzenia (UWAGI.md).

---

## 1. Rodzaje przestrzeni

Rodzaj wybiera się przy tworzeniu przestrzeni, obok wyboru „otwarta / zaszyfrowana” (ARCHITEKTURA §4.17):

| Rodzaj | Dla kogo | Co dodaje |
|---|---|---|
| **Notatki** | jedna osoba lub kilka osób piszących razem | to, co jest dziś: notatki, linki, graf, tabele |
| **Organizacja** | zespół, firma, projekt | wszystko z „Notatek” + zadania z osobami i terminami, widoki „kto co ma”, projekty, powiadomienia |

Rodzaj to wpis w dzienniku uczestników (`acl_log`, wpis `Utwórz`), więc każde urządzenie wie, jakie widoki pokazać. Przestrzeń „Notatki” można później zamienić na „Organizację” (nic się nie przepisuje — dochodzą tylko widoki) [decyzja].

## 2. Zadanie to linia w notatce

Zadanie jest zwykłą pozycją listy zadań w Markdownie, z kilkoma znacznikami. Dzięki temu „część notatki odpowiada zadaniu” w najprostszy sposób: zadanie stoi w tym miejscu notatki, którego dotyczy.

```markdown
## Kampania jesienna

Budżet ustalamy do końca miesiąca. Plakat w dwóch wersjach.

- [ ] Przygotować plakat @Ania 📅 2026-10-30 ^z-7f3a
- [ ] Zatwierdzić budżet @Bartek 📅 2026-10-25 ⏫ ^z-91c2
    - [ ] Zebrać oferty drukarni @Cezary ^z-a410
- [x] Wybrać hasło @Ania ✅ 2026-10-18 ^z-0b77
```

| Znacznik | Znaczenie | Zgodność z Obsidianem |
|---|---|---|
| `- [ ]` / `- [x]` | do zrobienia / zrobione | standard Markdown |
| `@Ania` | osoba przypisana (kilka `@` = kilka osób) | zwykły tekst |
| `📅 2026-10-30` | termin | format wtyczki Obsidian Tasks |
| `⏫` `🔼` `🔽` | priorytet | format Obsidian Tasks |
| `✅ 2026-10-18` | data wykonania (dopisywana automatycznie) | format Obsidian Tasks |
| `^z-7f3a` | stały identyfikator zadania | odnośnik do bloku w Obsidianie (`[[notatka#^z-7f3a]]`) |
| wcięcie | podzadanie (zadania nadrzędnego nie da się odhaczyć, dopóki wszystkie jego podzadania nie są zrobione) | standard Markdown |
| `!przypomnij:2h/30mx3` | przypomnienie: pierwsze 2 h przed terminem, potem co 30 min, 3 razy w sumie (`!przypomnij:1d` = raz, dzień przed) | zwykły tekst; jednostki m, h, d; 1–999; `x` 1–20, domyślnie 1; bez spacji |

- Identyfikator `^z-…` aplikacja dopisuje sama przy pierwszym zapisie zadania; dzięki niemu zadanie zachowuje historię i powiadomienia, nawet gdy ktoś przeniesie linię albo zmieni jej treść.
- Wpisanie `@` podpowiada uczestników przestrzeni; `📅` można wybrać z kalendarza (polecenie „Ustaw termin”).
- W podglądzie na żywo i w widoku czytania zadanie wyświetla się jako „karta”: awatar osoby, termin (na czerwono po terminie), przycisk „zrobione”.
- W przestrzeni „Notatki” te same linie działają jak zwykłe listy zadań — po prostu bez widoków zespołowych.

**Kto komu przypisał:** każda zmiana w dzienniku jest podpisana przez urządzenie autora (SZYFROWANIE §3), więc rdzeń wie, *kto* dopisał `@Ania` do zadania i *kiedy*. „Przypisane przez” nie wymaga osobnego pola — wynika z historii zmian.

## 3. Osoby

Osoby to uczestnicy przestrzeni z dziennika uczestników (ARCHITEKTURA §4.10). Organizacja dodaje im:

- **nazwę wyświetlaną** i kolor awatara (wpis w `acl_log`, zmienia ją sam uczestnik albo właściciel),
- **uchwyt** do `@` (np. `@Ania`), unikalny w przestrzeni — przy kolizji `@Ania.K`,
- opcjonalnie **zespoły** (`@marketing` = kilka osób) [decyzja: wersja 1 czy później].
- **kolejność grup** w „Osoby i grupy”: grupy przeciąga się albo przesuwa przyciskami „Przenieś wcześniej/dalej” (prawo edycji grup). Kolejność to waga: `order` (0 pierwsza) i `order_at` (nowszy wybór wygrywa przy scalaniu). Osoba dostaje kolor pierwszej swojej aktywnej, kolorowej grupy w tej kolejności; grupy bez `order` idą po nich w kolejności listy.

Osoba usunięta z przestrzeni zostaje w starych zadaniach jako „była uczestniczka”; jej otwarte zadania trafiają na listę „bez właściciela”.

## 4. Projekty i podprojekty

Projekt to **folder** z notatką główną o tej samej nazwie (jak w wielu sejfach Obsidiana):

```text
Marketing/                      ← projekt
├── Marketing.md                ← opis, cele, ludzie
├── Kampania jesienna/          ← podprojekt
│   ├── Kampania jesienna.md
│   └── Spotkanie 2026-10-19.md ← notatki z zadaniami
└── Strona WWW/
    └── Strona WWW.md
```

Folder bez notatki głównej też jest projektem (po prostu bez opisu). Właściwości w nagłówku YAML notatki głównej: `właściciel: @Ania`, `termin: 2026-12-31`, `status: aktywny | wstrzymany | zakończony`.

## 5. Widoki

| Widok | Co pokazuje |
|---|---|
| **Moje zadania** | zadania przypisane do mnie: po terminie / dziś / ten tydzień / później / bez terminu; kliknięcie otwiera notatkę w miejscu zadania |
| **Drzewo „kto co ma”** | osoby → projekty → zadania (z liczbami otwartych i spóźnionych); przełącznik „przypisane przez” (kto komu zlecił) |
| **Projekt** (osobny ekran z karty projektu) | podsumowanie zadań (otwarte, po terminie, na ten tydzień, bez przypisania, zrobione), tablica kanban (Nieprzypisane / Do zrobienia / Po terminie / Zrobione; przeciągnięcie albo przycisk zmienia tylko „zrobione”; własne kolumny ma notatka `Tablica.md` folderu, token `!etap:` na linii zadania), przebieg zadań na osi czasu od pierwszego zdarzenia do ukończenia lub terminu |
| **Kalendarz** | zadania na osi czasu według terminów, przeciągnięcie zmienia termin |
| **Aktywność** | ostatnie zmiany: kto dodał, przypisał, zamknął zadanie, kto pisał w których notatkach |

Wszystkie widoki to zapytania do indeksu zadań w rdzeniu (ten sam indeks co linki i tagi, ARCHITEKTURA §4.15) — budowane z notatek, nie przechowywane osobno, więc nie ma dwóch źródeł prawdy.

**Kto widzi aktywność.** Tylko właściciel i administratorzy. Członkowie nie widzą sekcji Aktywność ani jej treści; nie ma ustawienia, które by to zmieniało. Pole `activity_visibility` w rekordzie `org-settings` z wcześniejszych wersji jest ignorowane, a przy zapisie ustawień usuwane. **Granica:** to kwestia widoku, nie zabezpieczenia. Każdy członek z kluczem przestrzeni technicznie ma dane zdarzeń w swoim logu; interfejs ich po prostu nie pokazuje.

**Raport osoby.** W Aktywności administrator wybiera osobę i zakres dat (domyślnie ostatnie 7 dni; przyciski „Ten tydzień”, „Ten miesiąc”, „Poprzedni miesiąc”) i pobiera plik `.md`. Raport zawiera zdarzenia zadań tej osoby z tych samych danych co widok: ukończone, przypisane, zmiany terminu i ponowne otwarcia, pogrupowane po dniach. Zdarzenia organizacji nie zapisują utworzenia zadania, komentarzy ani edycji notatek, więc raport ich nie podaje.

## 6. Powiadomienia

Liczone **na urządzeniu odbiorcy**, z jego kopii przestrzeni:

| Zdarzenie | Kto dostaje |
|---|---|
| przypisano mi zadanie | osoba przypisana |
| termin jutro / dziś / minął | osoba przypisana (godzina przypomnienia w ustawieniach) |
| ktoś zamknął zadanie, które przypisałem | osoba przypisująca |
| ktoś napisał `@mnie` w notatce | osoba wspomniana |

- Desktop (Linux, Windows): systemowe powiadomienia przez Tauri; aplikacja działa w zasobniku (PLAN-BUDOWY etap 4), więc przypomnienia przychodzą też przy zamkniętym oknie.
- Web: powiadomienia przeglądarki, gdy karta jest otwarta.
- Skrzynka powiadomień w aplikacji (dzwonek) z historią i „oznacz jako przeczytane” — stan przeczytania jest prywatny dla urządzeń danej osoby.

**Ograniczenie szyfrowania (uczciwie):** serwer (węzeł) nie umie czytać treści, więc **nie może sam wysłać e-maila ani powiadomienia z treścią zadania**. Powiadomienie pojawia się, gdy urządzenie osoby zsynchronizuje zmiany. Rozwiązanie na później: węzeł wysyła tylko pusty sygnał „masz nowe zmiany” (bez treści) do aplikacji mobilnej / przeglądarki, a treść odszyfrowuje dopiero urządzenie [decyzja: po wersji 1].

## 7. Uprawnienia w organizacji

Role z ARCHITEKTURA §4.10 wystarczą na start: **właściciel** (zarządza ludźmi), **edytor** (tworzy i przypisuje zadania, pisze notatki, tworzy foldery i notatki tylko w folderach udostępnionych mu), **czytelnik** (tylko widzi). Nowe projekty oraz foldery i notatki w głównym folderze i w `Projekty/` tworzy właściciel lub administrator. Ograniczenie „kto może przypisywać komu” albo uprawnienia per projekt — po wersji 1 [decyzja], bo każde z nich wymaga odrzucania wiadomości po treści, której węzeł nie widzi.

W wersji przeglądarkowej (współdzielony sejf) projekty są domyślnie prywatne: nowy projekt widzą tylko jego prowadzący (twórca), właściciel i administratorzy, a projekt sprzed tej zmiany zamyka urządzenie właściciela, administratora lub prowadzącego przy najbliższym otwarciu. Historia zadań projektu jest szyfrowana razem z nim. Jest też widoczność per projekt, folder i notatka: przypisanie osób lub grup do projektu albo „Uprawnienia…” w menu drzewa szyfruje go osobnym kluczem tylko dla wybranych osób; właściciel i administratorzy są dodawani zawsze. Nowa blokada zaczyna bez zaznaczonego „może edytować” (poza osobą, która ją zakłada, właścicielem i administratorami): wybrana osoba widzi, ale nie zmienia, dopóki nie zaznaczy tego pola. Chroniony folder może leżeć w chronionym folderze z innymi członkami: jego notatki są w osobnym zaszyfrowanym wpisie, a nadrzędny nie zawiera ich. Osoba bez dostępu nie widzi chronionego folderu ani notatki wcale; członek tylko podfolderu widzi nadrzędny jako pustą ścieżkę. Uprawnienia zmienia właściciel, administrator albo prowadzący projektu (również dla folderów w projekcie). Prowadzącego wyznacza właściciel lub administrator, a wyznaczenie jest podpisane; samo wpisanie `prowadzacy:`, `osoby:` czy `grupy:` w notatce projektu nie daje żadnych praw. Zarządzający widzi wtedy na karcie projektu „Zmiana osób projektu w notatce: zatwierdź” i dopiero zatwierdzenie dodaje osoby albo zmienia prowadzącego. Projekty sprzed tej zmiany nie mają wyznaczonego prowadzącego, dopóki właściciel lub administrator tego nie zatwierdzi; edytor chronionego folderu nadrzędnego może zabezpieczyć podfolder, który sam założył i który nie ma jeszcze ochrony (startuje od niego i właściciela z administratorami). Notatka nie ma własnych uprawnień: jej przycisk uprawnień otwiera folder, w którym leży. Pozostali widzą je w podglądzie. Prawo edycji egzekwuje klient — serwer go nie sprawdzi, a zmianę od osoby bez prawa inni widzą jako „niezweryfikowaną” (WEB-WSPOLDZIELENIE.md, „Protected projects”).

## 7a. Tabele z polami do zaznaczenia

Komórka tabeli Markdown, która zaczyna się od `[ ]`, `[x]` albo `[X]`, jest polem do zaznaczenia (np. „składka zapłacona”). Może zawierać też `@osoba` (kto ma to zrobić) i `📅 RRRR-MM-DD` (termin). Nagłówek kolumny może mieć jeden lub więcej tokenów `!zaznacza:@kto`: wtedy zaznaczać w tej kolumnie mogą tylko wskazane osoby, członkowie grupy o tej nazwie, właściciel i administratorzy. Bez `!zaznacza:` zaznacza każdy, kto może edytować notatkę.

```
| Członek | Składka !zaznacza:@skarbnik | Ankieta |
|---|:-:|---|
| Ania @Ania | [x] @Ania 📅 2026-11-30 | [ ] |
```

W podglądzie na żywo klik przełącza `[ ]`↔`[x]` jako zwykła zmiana notatki (Ctrl+Z ją cofa). Pole, którego nie wolno zaznaczyć, jest wyłączone z podpowiedzią „Zaznaczyć może: …”. Osoba wskazana `@` w niezaznaczonym polu dostaje pozycję „Do zrobienia w tabelach” w powiadomieniach.

**Ograniczenie (uczciwie):** uprawnienie do kolumny egzekwuje tylko aplikacja: w interfejsie i przy zmianach zrobionych w edytorze tej aplikacji. Członek z prawem edycji notatki, który zmieni surowy tekst w innym programie, może zmienić pole, bo zapis nie sprawdza zawartości tabeli. Twarde zabezpieczenie: ogranicz, kto może edytować notatkę (Uprawnienia…).

## 8. Kolejność budowy

1. **Etap 2 (jedna osoba):** parser zadań w rdzeniu (znaczniki z §2, identyfikatory `^z-…`), indeks zadań razem z indeksem linków i tagów, widok „Moje zadania” i „Projekt”, karty zadań w podglądzie, lokalne przypomnienia o terminach.
2. **Etap 3 (tożsamość):** rodzaj przestrzeni i nazwy wyświetlane w `acl_log`, podpowiedzi `@`.
3. **Etap 4 (P2P):** „przypisane przez” z podpisanej historii, drzewo „kto co ma”, powiadomienia o przypisaniu i zamknięciu, aktywność.
4. **Po wersji 1:** zespoły `@marketing`, uprawnienia per projekt, powiadomienia push przez węzeł bez treści, aplikacja mobilna.

## 9. Testy, które muszą istnieć

- zadanie przeniesione w inne miejsce notatki (albo do innej notatki) zachowuje identyfikator, przypisanie i historię;
- dwie osoby jednocześnie zmieniają termin tego samego zadania → u obu ten sam wynik (CRDT), a w aktywności widać obie zmiany;
- plik `.md` z zadaniami otwarty w Obsidianie wygląda jak zwykła lista zadań; zadanie odhaczone w Obsidianie jest zrobione w aplikacji;
- powiadomienie o przypisaniu przychodzi tylko do osoby przypisanej i tylko raz (także po ponownej synchronizacji z węzła);
- w bazie węzła nie ma treści zadań, nazw osób ani terminów (SZYFROWANIE §9).
