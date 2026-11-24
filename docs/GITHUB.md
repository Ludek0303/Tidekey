# Projekt połączony z GitHubem

Projekt (ORGANIZACJA §4) można połączyć z dowolnym repozytorium na GitHubie, nie tylko własnym. Aplikacja pobiera z niego `README` i wszystkie pliki Markdown i trzyma je jako notatki w projekcie: jest to kopia zapasowa tego, co jest na GitHubie. Gdy repozytorium się zmieni, notatki aktualizują się same, a w notatniku można do tych plików dopisywać własne rzeczy. Dopiski zostają przy kolejnych aktualizacjach.

Kierunek jest jeden: **GitHub → notatnik**. Notatnik niczego nie wysyła na GitHuba (wysyłanie: §12).

Uzupełnia [ARCHITEKTURA.md](ARCHITEKTURA.md) §4.4 (zmiany z zewnątrz, scalanie trójstronne) i §4.13 (wersje), [ORGANIZACJA.md](ORGANIZACJA.md) (projekty, zadania), [PLIKI.md](PLIKI.md) (magazyn plików) i [SZYFROWANIE.md](SZYFROWANIE.md). Miejsca **[decyzja]** są do potwierdzenia.

---

## 1. Zasada w czterech zdaniach

1. **GitHub to po prostu kolejny „zewnętrzny edytor”.** Nowa wersja pliku z GitHuba jest scalana z notatką tym samym scalaniem trójstronnym co zmiana z Obsidiana (ARCHITEKTURA §4.4): baza = poprzednia wersja z GitHuba, „zewnętrzny” = nowa wersja z GitHuba, „nasz” = obecny tekst notatki z dopiskami.
2. **Pobiera i scala urządzenie członka projektu, nie serwer.** Serwer nie zna klucza projektu, więc nie może zapisać niczego w zaszyfrowanej notatce. Nie wie też, z jakim repozytorium połączony jest projekt.
3. **Aktualizację stosuje jedno urządzenie naraz.** Dwa urządzenia, które scalą ten sam commit jednocześnie, wstawiłyby te same linie dwa razy (CRDT zachowuje oba wpisy). Dlatego przed scaleniem urządzenie bierze krótką blokadę na serwerze (§5).
4. **Tekst z GitHuba jest niezaufany.** Repozytorium może zmienić każdy, kto ma do niego dostęp, więc z tekstu z GitHuba nie powstają zadania, wzmianki `@osoba` ani zmiany uprawnień (§9).

## 2. Jak to wygląda dla użytkownika

1. **Projekty → Nowy projekt** ma pole „Połącz z GitHubem (opcjonalnie)”. Istniejący projekt: menu projektu → „Połącz z GitHubem…”.
2. Wklejasz adres. Rozumiane są: `https://github.com/właściciel/repo`, `właściciel/repo`, `…/tree/gałąź/podfolder`, `…/blob/gałąź/plik.md` (to ostatnie bierze cały podfolder pliku).
3. Aplikacja sprawdza repozytorium i pokazuje: domyślną gałąź, liczbę plików Markdown, łączny rozmiar, czy jest prywatne. Gdy GitHub odpowie 404: „Nie ma takiego repozytorium albo jest prywatne. Dla prywatnego dodaj token (§7).”
4. Ustawienia (wszystkie z sensownymi wartościami domyślnymi):

| Ustawienie | Domyślnie |
|---|---|
| Gałąź | domyślna gałąź repozytorium (śledzi jej zmianę) |
| Podfolder repozytorium | całe repozytorium |
| Folder w projekcie | `Projekty/<Nazwa>/GitHub/` [decyzja] |
| Pliki | `*.md`, `*.markdown` (także `README` bez rozszerzenia, `readme.md` w podfolderach) |
| Plik usunięty na GitHubie | **zostaje w notatniku** z oznaczeniem „Usunięty z GitHuba” (to kopia zapasowa) [decyzja]; opcja: do kosza |
| Dopisywanie | włączone; opcja: czysta kopia tylko do odczytu |
| Sprawdzanie zmian | co 5 min z tokenem, co 15 min bez tokenu (§6), tylko gdy aplikacja jest otwarta |

5. **Importuj.** Notatki pojawiają się w drzewie. Struktura folderów z repozytorium jest zachowana, więc względne linki `[tekst](docs/instalacja.md)` działają.
6. Na ekranie projektu: `GitHub: właściciel/repo · main · abc1234 · 2 h temu` i przyciski **Sprawdź teraz**, **Otwórz na GitHubie**, **Ustawienia**, **Odłącz**.
7. W notatce z GitHuba nad edytorem jest pasek: `Z GitHuba: docs/instalacja.md · abc1234 — Twoje dopiski zostają przy aktualizacjach`. Przycisk **Moje dopiski** pokazuje różnicę między notatką a wersją z GitHuba, czyli tylko to, co dopisałeś.
8. **Odłącz:** notatki zostają jako zwykłe notatki projektu, przestają się aktualizować.

**Dowolny folder.** Połączyć można też zwykły folder, nie tylko projekt. Menu folderu w drzewie → „Połącz z GitHubem…” (dla folderu bez połączenia). Pole „Folder na pliki z GitHuba” zostaje puste, więc pliki trafiają prosto do tego folderu, obok Twoich notatek i podfolderów. Folder z połączeniem ma w menu „GitHub…” (te same przyciski co na ekranie projektu) i mały znacznik gałęzi w drzewie. Tryb wybierasz na początku okna połączenia i ustawień: **Połączone z GitHubem** (notatki się aktualizują, Twoje dopiski zostają) albo **Tylko odczyt** (wierna kopia, zmieniasz ją tylko na GitHubie). Notatkę, której nie chcesz już aktualizować, zostawiasz przyciskiem **Zostaw jako własną** na pasku nad notatką: przestaje się aktualizować, plik na GitHubie się nie zmienia, a jej ścieżka trafia do `ignored`, więc kolejna aktualizacja jej nie przywraca. Notatka użytkownika o tej samej nazwie co plik z GitHuba nie jest nadpisywana ani przejmowana: plik z GitHuba powstaje obok jako „nazwa (GitHub).md” (a gdy i ta nazwa jest zajęta, „nazwa (GitHub 2).md”).

## 3. Rekord połączenia

Leży w zaszyfrowanym stanie projektu (w chronionym projekcie zaszyfrowany kluczem projektu, ORGANIZACJA §7). Widzą go tylko członkowie projektu. Serwer go nie widzi.

```text
github-link {
  id               losowe 16 B (nazwa blokady na serwerze, §5)
  repo             "właściciel/repo"
  ref              null = domyślna gałąź | "main" | tag
  repoPath         "" | "docs"                     podfolder repozytorium
  target           "GitHub" | ""                   folder w projekcie ("" = pliki prosto w nim)
  include          ["**/*.md", "**/*.markdown", "**/README"]
  onDelete         "keep" | "trash"
  allowEdits       true
  lastCommit       sha ostatnio zastosowanego commitu
  lastAppliedAt, lastAppliedBy (użytkownik)
  files            { id notatki → { path w repo, blobSha ostatnio zastosowany } }
  ignored          [path w repo]                   notatki usunięte przez użytkownika (§4, „usuwam notatkę”)
  status           "ok" | "konflikt: N plików" | "limit GitHuba do 14:20" | "repozytorium niedostępne"
}
```

Plik jest śledzony **po id notatki**, nie po ścieżce. Zmiana nazwy albo przeniesienie notatki w notatniku nie zrywa połączenia.

## 4. Aktualizacja krok po kroku

1. **Czy coś się zmieniło?** `GET /repos/{repo}/commits/{ref}` z `Accept: application/vnd.github.sha` i `If-None-Match` (ETag z poprzedniego razu). `304` albo ten sam sha co `lastCommit` → koniec.
2. **Blokada.** Urządzenie bierze blokadę `github-link.id` na serwerze (§5). Nie dostało → koniec (ktoś inny właśnie aktualizuje).
3. **Najpierw dogoń synchronizację.** Urządzenie musi mieć aktualny stan projektu (w webie: najnowsza `revision`; na desktopie: brak zaległych wiadomości z węzła). Po pobraniu sprawdza `lastCommit` jeszcze raz: inne urządzenie mogło już zastosować ten commit.
4. **Lista plików.** `GET /repos/{repo}/git/trees/{sha}?recursive=1` → ścieżki i skróty `blobSha`. Odpowiedź z `truncated: true` (bardzo duże repozytorium) → „Repozytorium jest za duże, wybierz podfolder”.
5. **Co się zmieniło** = porównanie listy z `files` po `blobSha`:

| Na GitHubie | W notatniku | Działanie |
|---|---|---|
| nowy plik | — | nowa notatka; zajęta ścieżka → `nazwa (2).md` (ARCHITEKTURA §4.6) |
| zmieniony plik | bez dopisków (tekst = poprzednia wersja z GitHuba) | zastąp różnicą jako operacje CRDT |
| zmieniony plik | z dopiskami w innych miejscach | scal trójstronnie, dopiski zostają |
| zmieniony plik | dopisek w tym samym fragmencie, który zmienił GitHub | **konflikt** (§8) |
| ten sam `blobSha` pod nową ścieżką, stara zniknęła | — | przeniesienie notatki (dopiski zostają) |
| plik usunięty | bez dopisków | `onDelete`: oznacz „Usunięty z GitHuba” albo do kosza |
| plik usunięty | z dopiskami | zawsze zostaje, oznaczony „Usunięty z GitHuba”, przestaje być śledzony |
| plik niezmieniony | dowolnie | nic |
| ścieżka w `ignored` | — | pomiń |

6. **Pobranie treści** tylko zmienionych plików (§6). Każdy plik jest sprawdzany: `blobSha` musi się równać `sha1("blob <długość>\0" + bajty)` (tak git liczy skrót). Niezgodność → plik pominięty, błąd w statusie.
7. **Scalenie** każdej notatki funkcją `merge3(baza, nasz, zewnętrzny)` z `core` (ta sama co w §4.4, w webie przez WASM). Przed zmianą powstaje wersja notatki z powodem `GitHub abc1234: <pierwsza linia opisu commitu>` (ARCHITEKTURA §4.13).
8. **Zapis** w jednej zmianie stanu: treści notatek, nowe `files`, `lastCommit`, `lastAppliedAt/By`, archiwum (§6a). W webie to jeden zapis z `baseRevision`; konflikt rewizji → wróć do kroku 3.
9. Zwolnij blokadę.

Usunięcie notatki przez użytkownika: ścieżka trafia do `ignored`, plik nie wraca przy kolejnej aktualizacji. „Przywróć z GitHuba” w ustawieniach połączenia zdejmuje ścieżkę z `ignored`.

Force-push i przepisana historia na GitHubie niczego nie psują: porównujemy tylko listę plików ostatnio zastosowanego commitu z nową, nie historię.

## 5. Jedno urządzenie naraz (blokada)

Serwer nie zna treści, ale może trzymać krótkie, nieprzezroczyste blokady:

```text
POST   /api/vaults/:id/leases   { "name": "<hex github-link.id>", "ttlSeconds": 120 }
       → 200 { "granted": true, "until": "…", "holder": "<id urządzenia>" }
       → 200 { "granted": false, "until": "…" }
DELETE /api/vaults/:id/leases/:name
```

- Nazwa to losowe id połączenia, więc serwer nie wie, czego blokada dotyczy.
- Blokadę dostaje członek sejfu z rolą edytor+; przedłuża ją co 60 s w trakcie dłuższego importu.
- Desktop z węzłem: ta sama prośba jako wiadomość `notes-sync/1` do węzła.
- Desktop bez węzła (sama sieć LAN): aktualizuje tylko **urządzenie synchronizujące**, domyślnie to, które połączyło repozytorium; można je zmienić w ustawieniach połączenia.
- Zabezpieczenie na wypadek wygaśnięcia blokady w trakcie: krok 3 i 8 z §4 sprawdzają `lastCommit`, więc drugie urządzenie nie zastosuje tego samego commitu po raz drugi.

## 6. Pobieranie z GitHuba i limity

GitHub mocno ogranicza zapytania bez logowania: 60 na godzinę na adres IP (wspólny dla całego NAT-u), także dla `raw.githubusercontent.com`. Zapytanie warunkowe z odpowiedzią `304` nie zużywa limitu **tylko z tokenem**.

| | Bez tokenu | Z tokenem (§7) |
|---|---|---|
| Limit | 60/h na IP | 5000/h na konto |
| Sprawdzanie zmian | co 15 min (4/h na repozytorium) | co 5 min, `304` za darmo |
| Pierwszy import (web) | lista + 1 zapytanie na plik → najwyżej ~50 plików na godzinę; większe repozytorium importuje się w częściach, z paskiem postępu | bez praktycznego limitu |
| Pierwszy import (desktop) | 1 zapytanie: archiwum `GET /repos/{repo}/tarball/{sha}` | to samo |

- **Web:** tylko `api.github.com` (obsługuje CORS): `commits/{ref}`, `git/trees/{sha}`, `git/blobs/{blobSha}` z `Accept: application/vnd.github.raw`. Do polityki CSP dochodzi `connect-src https://api.github.com`, nic więcej.
- **Desktop:** te same zapytania z rdzenia Rust (`reqwest`), przy imporcie i dużych zmianach archiwum tar zamiast pojedynczych plików.
- Odpowiedź `403`/`429` → czekaj do `x-ratelimit-reset` (albo `retry-after`), status „Limit GitHuba do 14:20”, bez ponawiania w pętli.
- **Limity aplikacji** [decyzja]: najwyżej 2000 plików, 1 MB na plik, 20 MB łącznie na połączenie. Większe pliki pomijane z listą w statusie. W webie pamiętaj o limicie 16 MiB na wiadomość WebSocket (API-WEB): duży import zapisuje się w kilku zapisach.

### 6a. Archiwum wersji z GitHuba

To ma być kopia zapasowa, więc każda pobrana wersja pliku zostaje w projekcie, nawet gdy na GitHubie zniknie albo repozytorium zostanie usunięte:

- treść każdego pobranego blobu trafia do magazynu plików projektu (PLIKI.md), zaszyfrowana jak każdy załącznik;
- id pliku = `HMAC(sekret, "github\0" + github-link.id + "\0" + blobSha)` — ta sama sztuczka co przy migracji załączników (PLIKI §5): ten sam blob z dwóch urządzeń daje ten sam plik, bez duplikatów;
- ostatnio zastosowany blob każdego pliku to **baza scalania** z §4 krok 7. Dzięki temu aktualizację może przejąć dowolne urządzenie, nie tylko to, które ją ostatnio robiło;
- „Historia z GitHuba” w notatce: lista commitów, które zmieniły ten plik, z podglądem i przywróceniem jak zwykłe wersje.

## 7. Repozytoria prywatne i tokeny

- Publiczne repozytorium działa bez niczego. Token tylko podnosi limity.
- Prywatne wymaga tokenu: **fine-grained personal access token**, wybrane repozytoria, uprawnienie `Contents: Read-only` i nic więcej. Aplikacja pokazuje dokładną instrukcję z linkiem do ustawień GitHuba.
- **Token jest osobisty**, nie należy do projektu: na desktopie leży w systemowym magazynie haseł, w webie w osobistej, zaszyfrowanej części konta. Nie trafia do wspólnego stanu projektu, na serwer ani do kopii zapasowej węzła.
- Członek projektu bez tokenu widzi notatki z prywatnego repozytorium (są w projekcie), ale jego urządzenie ich nie aktualizuje. Aktualizuje urządzenie kogoś, kto ma token.
- Opcja „Udostępnij token członkom projektu” [decyzja: czy w ogóle]: token zaszyfrowany kluczem projektu, z ostrzeżeniem „każdy członek projektu może go odczytać i użyć poza aplikacją”.
- Później: logowanie przez GitHub (OAuth device flow) zamiast wklejania tokenu. W webie wymaga pośrednictwa serwera, bo `github.com/login/device` nie obsługuje CORS.

## 8. Konflikt

Gdy GitHub i użytkownik zmienili ten sam fragment:

- nic nie jest nadpisywane: notatka zostaje z dopiskami, nowa wersja z GitHuba zapisuje się jako wersja i w archiwum;
- ten plik przestaje się aktualizować, status połączenia pokazuje „Konflikt: 1 plik”;
- ekran porównania jest ten sam co dla Obsidiana (ARCHITEKTURA §4.4), z podpisami „GitHub (abc1234)” i „Notatnik”. Wybierasz całość albo fragmenty; wynik staje się nową bazą i plik znowu się aktualizuje.

Wskazówka w interfejsie (pod paskiem notatki z GitHuba): dopiski na końcu pliku, w osobnym akapicie albo w callout `> [!note] Moje` prawie nigdy nie tworzą konfliktów. Najbezpieczniej trzymać obszerne notatki obok, w zwykłych notatkach projektu, z linkiem do pliku z GitHuba.

## 9. Bezpieczeństwo

Treść z GitHuba może napisać ktoś spoza organizacji (dowolny autor publicznego repozytorium albo ktoś, kto je przejmie). Dlatego:

| Zagrożenie | Ochrona |
|---|---|
| złośliwy HTML, skrypty, linki `javascript:` w README | ten sam renderer w rdzeniu co dla treści od współautorów (FUNKCJE, „Zasada bezpieczeństwa”, zadanie T7a) |
| obrazki z zewnętrznych serwerów (odznaki `shields.io`, piksele śledzące) w README | zewnętrzne obrazki nie ładują się same, tylko po kliknięciu „Wyświetl obraz” (jak przy wyłączonym „Automatycznie wczytuj obrazy”, PLIKI §6) |
| `- [ ] @Ania` w repozytorium tworzy zadanie w organizacji i powiadomienie; `@nazwa` na GitHubie to ktoś inny niż `@nazwa` w organizacji | w notatkach z GitHuba zadania i wzmianki liczą się **tylko z linii, których nie ma w wersji z GitHuba**, czyli z dopisków członków |
| znaczniki uprawnień w tekście (`osoby:`, `grupy:`, `prowadzacy:`, `!zaznacza:`, `typ:`) | folder `GitHub/` nigdy nie jest notatką projektu; aktualizacja z GitHuba, która dodaje lub zmienia te znaczniki, jest stosowana z wyłączeniem tych linii i oznaczana w statusie (jak w MCP.md, „Uprawnienia zapisane w treści notatek”) |
| plik o nazwie `../../Inne/x.md` albo ścieżki z `\`, `:` | ścieżki normalizowane i ograniczone do folderu `target`; niedozwolone pomijane |
| podmieniona treść w drodze | TLS + sprawdzenie `blobSha` (§4 krok 6) |
| ogromne repozytorium jako atak na pamięć | limity z §6 sprawdzane przed pobraniem |

**Kto co wie:**

| | Wie, że projekt śledzi repozytorium X? |
|---|---|
| serwer / węzeł | ❌ — widzi tylko nieprzezroczystą nazwę blokady i zaszyfrowane zapisy |
| GitHub | ✅ — widzi adres IP urządzenia, które pobiera, i (z tokenem) konto |
| członkowie projektu | ✅ |
| osoby spoza chronionego projektu | ❌ |

W aktywności organizacji aktualizacja jest pokazana jako „GitHub abc1234 (zastosował: Jan)”.

## 10. Desktop: przestrzeń otwarta i Obsidian

Notatki z GitHuba to zwykłe notatki, więc w przestrzeni otwartej mają pliki `.md` na dysku. Edycja w Obsidianie przechodzi przez §4.4 (do CRDT), a aktualizacja z GitHuba scala się na CRDT. Obie drogi korzystają z tego samego `merge3`, więc nie ma osobnego przypadku.

Uwaga do pokazania przy połączeniu: nie łącz tego samego folderu z gitem równocześnie (`git pull` w folderze przestrzeni). Aplikacja zobaczyłaby zmiany z gita jako zmiany z zewnątrz i scalała je drugi raz z GitHubem.

## 11. Kolejność budowy

Każdy krok osobno testowalny.

1. **`core`: `merge3` jako funkcja publiczna** (już istnieje dla §4.4) + eksport w `crates/web` przez WASM. Testy: dopisek na końcu + zmiana na początku → oba zostają; ten sam fragment → konflikt z obiema wersjami.
2. **Klient GitHuba** (TypeScript dla webu, Rust dla desktopu): parsowanie adresu, `repos`, `commits/{ref}` z ETag, `git/trees`, `git/blobs`, tarball (desktop), sprawdzanie `blobSha`, obsługa limitów. Testy na nagranych odpowiedziach, bez sieci.
3. **Rekord `github-link`** w stanie projektu + plan zmian (§4 tabela) jako czysta funkcja `plan(files, nowaLista) → [akcje]`. Testy dla każdego wiersza tabeli, także przeniesienie i `ignored`.
4. **Blokady na serwerze** (`/api/vaults/:id/leases`, tabela `leases(vault, name, holder, until)`), później to samo w węźle.
5. **Zastosowanie aktualizacji** (§4 kroki 3–9) z wersjami w historii. Test kluczowy: dwa klienty w jednym procesie zaczynają aktualizację tego samego commitu jednocześnie → tekst bez duplikatów.
6. **Archiwum** w magazynie plików z deterministycznym id (§6a) i „Historia z GitHuba”.
7. **Interfejs:** pole w „Nowy projekt”, okno połączenia, pasek w notatce, „Moje dopiski”, status na ekranie projektu, ekran konfliktu z podpisami GitHuba.
8. **Ochrony z §9:** zadania i wzmianki tylko z dopisków, znaczniki uprawnień, zewnętrzne obrazki, ścieżki.
9. **Tokeny** (§7): magazyn osobisty, instrukcja tworzenia tokenu, repozytoria prywatne.

Testy, które muszą istnieć oprócz powyższych:
- dopisek przetrwa 20 kolejnych commitów zmieniających inne części pliku;
- plik usunięty na GitHubie z dopiskami zostaje w notatniku i w archiwum;
- usunięte repozytorium (404) → status „Repozytorium niedostępne”, notatki i archiwum nietknięte;
- treść z niezgodnym `blobSha` nie trafia do notatki;
- `- [ ] @Ania` z GitHuba nie tworzy zadania, ta sama linia dopisana w notatniku tworzy;
- w bazie serwera i w ruchu do serwera nie ma nazwy repozytorium ani treści plików.

## 11a. Odchylenia przy implementacji (2026-11-14)

Wersja webowa jest zrobiona w całości; plan i mapa kodu: [GITHUB-PLAN.md](GITHUB-PLAN.md).

- **Gdzie leży rekord.** `state.github` w jawnych projektach i `ProtectedPayload.github` w chronionych (pod kluczem projektu); pola opcjonalne, stare klienty je pomijają. Scalanie po `id`, wygrywa wyższy `rev`. „Odłącz” zostawia znacznik `removed` z wyższym `rev`, więc rekord nie wraca od innych urządzeń. Rekord ma też pola `etag`, `defaultBranch`, `pendingCommit` (import w częściach) i dla każdego pliku `guarded` (skróty linii z zadaniami i wzmiankami z wersji z GitHuba).
- **Konflikt** w webie: stan konfliktu jest w rekordzie (`files[id].conflict`), tekst GitHuba w archiwum. Ekran konfliktu jest wspólny z Obsidianem (`conflictview.ts`), przyciski „Zostaw wersję z notatnika” / „Weź wersję z GitHuba”.
- **Historia z GitHuba** (§6a): każda zmiana z GitHuba jest zwykłą wersją notatki z powodem `GitHub <sha7>: <opis commitu>`, z podglądem i przywróceniem jak inne wersje. Osobnej listy „tylko commity GitHuba” nie ma.
- **Archiwum**: pliki w magazynie plików nazywają się `GitHub <sha7> <nazwa pliku>` i są widoczne w widoku „Pliki”. Bez magazynu plików (serwer bez niego) archiwum trzyma się tylko w pamięci sesji, a status to mówi.
- **Zewnętrzne obrazki** (§9): polityka CSP aplikacji nie wpuszcza żadnych obrazków z zewnętrznych serwerów (`img-src 'self' data: blob:`), więc w notatkach z GitHuba nie ładują się wcale — także po kliknięciu. To ostrzejsze niż w §9. Jedyna zmiana CSP: `connect-src 'self' https://api.github.com`.
- **Zadania i wzmianki z dopisków** (§9): filtr działa w indeksie notatek (zadania, „Moje zadania”, powiadomienia o zadaniach). Pola wyboru w tabelach (`[ ]` w komórkach) nie są filtrowane.
- **Tryb „Tylko odczyt”** (dawniej „Czysta kopia tylko do odczytu”) jest pilnowany w przeglądarce (zmiana notatki spoza przebiegu aktualizacji jest odrzucana). Serwer nie zna treści, więc nie może tego sprawdzić.
- **Ścieżki**: pliki z folderów zaczynających się od `.git` (także `.github/`) są pomijane. Plik przeniesiony i zmieniony w jednym commicie to usunięcie i nowa notatka (dopiski zostają w starej, oznaczonej „Usunięty z GitHuba”). `ignored` dotyczy tylko nowych plików.
- **Import w częściach** bez tokenu: przy limicie GitHuba to, co już pobrane, zostaje zapisane („Import w częściach: 50 z 120 plików · Limit GitHuba do 14:20”), reszta dochodzi po resecie limitu.
- **Blokada** (§5): odpowiedź nie zawiera pola `holder`; posiadaczem jest sesja (użytkownik + skrót tokenu sesji), więc to samo konto na innym urządzeniu też czeka. Nazwa blokady nie trafia do logów.
- **Aktywność organizacji** nie pokazuje wpisu „GitHub abc1234 (zastosował: Jan)” — aktywność liczy tylko zdarzenia zadań. Kto i kiedy zastosował ostatnią aktualizację, jest w rekordzie (`lastAppliedBy`, `lastAppliedAt`) i na stronie projektu.
- **Token** leży w zaszyfrowanej kopercie ustawień konta (`preferences`, pole `githubToken`) pod kluczem osobistym; w eksporcie konta jest tylko jako szyfrogram.
- **Desktop**: w tej wersji tylko logika w `notes-core` (`github.rs`, `github_plan.rs`, `merge3`, `text_edits`). Klient GitHuba w Ruście, archiwum tar i blokady w węźle (`notes-sync/1`) — później.

- **Moje notatki (2026-11-15).** Połączenie z GitHubem działa też w sejfie osobistym. Serwer daje blokady (§5) w sejfie `browser-<id>` tylko jego właścicielowi i tylko gdy ma on włączone własne notatki; każdy inny dostaje 404. Sejf osobisty nie ma surowego klucza sejfu, więc identyfikatory kopii archiwalnych liczy sekret wyprowadzony z klucza osobistego (AES-GCM na 32 bajtach zer ze stałym, nieużywanym nigdzie indziej nonce; `personalArchiveSecret` w `browserauth.ts`). Jest taki sam na każdym urządzeniu właściciela, a serwer go nie zna.

## 12. Później

- **Wysyłanie dopisków na GitHuba** (pull request albo commit) — wymaga tokenu z prawem zapisu i decyzji, co z plikami, w których ktoś coś dopisał. Na razie świadomie nie.
- **Załączniki z repozytorium:** obrazki, do których linkują pliki Markdown (`![](img/schemat.png)`), pobierane do magazynu plików.
- **Strażnik na serwerze** (opcja dla repozytoriów publicznych): serwer sprawdza sha gałęzi także wtedy, gdy nikt nie ma otwartej aplikacji, i wysyła pusty sygnał „jest nowa wersja”. Cena: serwer wie, które repozytorium śledzi projekt. Sama treść nadal pobierana i scalana na urządzeniu.
- Inne serwisy (GitLab, Gitea, Codeberg) — ten sam schemat, inny klient API.
- Webhook dla własnych repozytoriów zamiast sprawdzania co 5 min (wymaga strażnika na serwerze).

## 13. Decyzje (2026-11-14)

- [x] Repozytoria publiczne bez logowania i bez tokenu; token opcjonalny (limity), wymagany tylko dla prywatnych
- [x] Aktualizację stosuje jedno urządzenie, inni dostają gotowe notatki przez zwykłą synchronizację
- [x] Folder w projekcie: `Projekty/<Nazwa>/GitHub/`, z możliwością zmiany przy łączeniu
- [x] Plik usunięty na GitHubie: domyślnie zostaje z oznaczeniem, opcja „do kosza”
- [x] Limity: 2000 plików, 1 MB na plik, 20 MB łącznie na połączenie
- [x] Odstępy sprawdzania: 5 min z tokenem, 15 min bez
- [x] Udostępnianie tokenu członkom projektu: nie w wersji 1
- [x] Wiele repozytoriów w jednym projekcie: tak, każde w osobnym podfolderze `GitHub/<repo>/`

Prompt do implementacji (Opus 5.5 planuje i przegląda, agenci Haiku 5.5 piszą kod): [PROMPT-GITHUB.md](PROMPT-GITHUB.md).
