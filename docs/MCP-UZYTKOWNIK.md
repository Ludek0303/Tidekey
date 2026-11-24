# Notatki i Claude: instrukcja dla użytkownika

Jak połączyć Claude (Claude Desktop albo Claude Code) z Notatkami, żeby mógł czytać Twoje notatki i zadania, a jeśli
pozwolisz, proponować zmiany. Projekt i zasady bezpieczeństwa: `docs/MCP.md`.

> **Stan:** paczki `@notatki/mcp` i rozszerzenie `.mcpb` nie są jeszcze opublikowane. Do czasu wydania używa się wersji
> z repozytorium (na końcu tej instrukcji, „Wersja z repozytorium”).

## 1. Zanim zaczniesz

- Konto w Notatkach i zapisany kod odzyskiwania. **Kodu odzyskiwania ani hasła nigdy nie wpisujesz w Claude ani w
  MCP.** Jeśli coś o nie prosi, to nie jest nasza aplikacja.
- **W organizacji:** właściciel musi najpierw włączyć czaty (Ustawienia organizacji → Czaty). Bez tego połączysz
  Claude tylko z „Moimi notatkami”.
- Jedno z dwóch:
  - **Claude Desktop** (Windows, macOS): najprostszy wariant, rozszerzenie instalowane kliknięciem;
  - **Claude Code** (Linux, macOS, Windows): wariant w terminalu, wymaga Node 22 LTS.
- Komputer, na którym pracujesz sam, z blokadą ekranu i aktualnym systemem.

## 2. Claude Desktop (zalecane)

1. W Notatkach: **Ustawienia → Urządzenia → Połącz Claude → Claude Desktop → Pobierz rozszerzenie** (plik `.mcpb`).
   Pobieraj je tylko z aplikacji Notatki. Ekran pokazuje skrót (SHA-256) pliku; ten sam skrót jest na stronie
   aplikacji.
2. Otwórz pobrany plik. Claude Desktop pokaże okno instalacji rozszerzenia „Notatki”: sprawdź wydawcę i kliknij
   **Zainstaluj**. W polu „Adres serwera” wpisz adres swoich Notatek (np. `https://notatki.twojadomena.pl`).
3. W Notatkach kliknij **Rozpocznij parowanie**. Strona pokaże **kod parowania** (np. `K7QM-3XRP`, ważny 10 minut).
   Zostaw tę kartę otwartą.
4. Rozszerzenie w Claude Desktop poprosi o ten kod w osobnym okienku (nie w wiadomości do Claude). Wpisz go.
   **Nigdy nie podawaj kodu nikomu i nie wpisuj go w rozmowie z Claude.** Jeśli ktoś przysłał Ci link do parowania
   albo prosi o kod, to próba przejęcia Twoich notatek.
5. Przeglądarka pokaże, **kto się łączy**: nazwę Twojego komputera, system, sieć i **kod kontrolny** 6 cyfr, ten sam co
   w Claude. Jeśli coś się nie zgadza (inny komputer, obca sieć, inny kod), kliknij **Przerwij**. Jeśli wszystko się
   zgadza, wybierz:
   - **przestrzenie:** na starcie nic nie jest zaznaczone. Włącz „Moje notatki” albo konkretne organizacje (co
     najmniej jedną). Organizacja wyszarzona ma czaty wyłączone przez właściciela;
   - **dla każdej włączonej przestrzeni osobno:** całą albo tylko wybrane foldery, (jeśli organizacja pozwala)
     chronione projekty, **tryb zapisu** („Tylko odczyt” domyślnie albo „Propozycje do zatwierdzenia”), narzędzia i
     zadania („tylko moje” / „wszystkie”);
   - **długość sesji:** domyślnie 4 godziny.
   Przed połączeniem sprawdź podsumowanie „Ten czat widzi: …”. Każdy komputer (czat) ma własny zakres, więc laptop
   może widzieć tylko „Moje notatki”, a komputer w pracy tylko jedną organizację.
   Kliknij **Połącz**.
6. Wróć do Claude Desktop. W rozmowach z notatkami wyłącz inne konektory i wyszukiwanie w sieci (rozszerzenie
   przypomni o tym przy pierwszym użyciu).
7. Sprawdź: zapytaj „Do czego masz dostęp?” (Claude odpowie z `scope_info`), potem „Jakie mam zadania z terminem w
   tym tygodniu?”.

## 3. Claude Code

1. Zainstaluj Node 22 LTS i Claude Code.
2. W Notatkach: **Ustawienia → Urządzenia → Połącz Claude → Claude Code**. Ekran pokazuje dokładne polecenia z
   przypiętą wersją, np.:

   ```bash
   npm view @notatki/mcp@1.0.0 dist.integrity          # porównaj z wartością na ekranie
   npx --yes @notatki/mcp@1.0.0 pair https://notatki.twojadomena.pl
   ```

   Najpierw kliknij w Notatkach **Rozpocznij parowanie** (sekcja 2, punkt 3). Polecenie `pair` zapyta o kod parowania
   (wpisywany, nie widać go w historii terminala), potem otworzy przeglądarkę i pokaże kod kontrolny. Dalej jak w
   sekcji 2, punkt 5.
3. Podłącz MCP do Claude Code (wersja przypięta, bez `@latest`):

   ```bash
   claude mcp add --scope user notatki -- npx --yes @notatki/mcp@1.0.0
   ```

4. Utwórz folder, w którym rozmawiasz z Claude o notatkach, i wgraj do niego `.claude/settings.json` z ekranu
   „Połącz Claude” (blokada narzędzi sieciowych i pytanie przy każdej zmianie). Uruchamiaj `claude` w tym folderze.
5. Sprawdź: `/mcp` pokazuje „notatki: połączony”; zapytaj o zadania na ten tydzień.

## 4. Na co dzień

| Sytuacja | Co zrobić |
|---|---|
| Claude mówi „Sesja czatu wygasła” | Notatki → Ustawienia → Urządzenia → czat → **Przedłuż** (albo powiadomienie w aplikacji) |
| Claude mówi „Propozycja czeka na zatwierdzenie” | Notatki → dzwonek lub **Propozycje Claude**: przejrzyj różnice, **Zatwierdź** albo **Odrzuć** |
| Chcesz cofnąć to, co zrobił Claude | Urządzenia → czat → **Cofnij zmiany czatu** |
| „Czat wstrzymany: nowy adres IP” | jeśli to Ty (inna sieć, VPN) → **Potwierdź**; jeśli nie → **Odłącz** |
| „Poza zakresem tego czatu” | Claude nie ma dostępu do tej notatki; poszerz zakres w Urządzenia → czat → **Zakres** (jeśli chcesz) |
| „Czaty wyłączone w tej organizacji” | poproś właściciela organizacji o włączenie |
| „Certyfikat czatu wygasł” (po 90 dniach) | sparuj czat od nowa (sekcja 2, punkty 3–5, albo `pair` w Claude Code) |
| „Ta wersja Notatki MCP jest za stara” | zaktualizuj poleceniem z komunikatu albo pobierz nowe rozszerzenie z Ustawienia → Urządzenia |
| „Czaty są chwilowo wyłączone przez operatora serwera” | nic nie rób; operator naprawia problem bezpieczeństwa, czat wróci sam albo poprosi o ponowne parowanie |
| Dostałeś link do parowania albo ktoś prosi o kod | nic nie klikaj i nie podawaj kodu; to próba przejęcia notatek |
| Chcesz, żeby Claude mógł zapisywać | Urządzenia → czat → **Zakres** → tryb zapisu (w granicach ustawionych przez organizację) |

## 5. Zgubiony lub sprzedany komputer, koniec pracy

- **Zgubiony komputer albo podejrzenie włamania:** z innego urządzenia Notatki → Ustawienia → Urządzenia →
  **Odłącz wszystkie czaty**, a potem **Cofnij zmiany czatu** z ostatnich 24 godzin.
- **Odinstalowanie:** najpierw **Odłącz** w Notatkach, potem usuń rozszerzenie w Claude Desktop albo
  `claude mcp remove notatki` i `npx @notatki/mcp@1.0.0 forget` (usuwa klucze czatu z pęku kluczy systemu).
- Kilka komputerów = kilka osobnych czatów (każdy parujesz osobno, najwyżej 5).

## 6. Bezpieczeństwo w sześciu zdaniach (do pokazania na ekranie „Połącz Claude”)

1. Claude widzi tylko to, co mu udostępnisz, i nigdy więcej niż Ty.
2. To, co Claude przeczyta, trafia do rozmowy z Claude (Anthropic); nie udostępniaj więcej, niż potrzeba.
3. Domyślnie Claude tylko czyta; zmiany może jedynie proponować, a zatwierdzasz je Ty.
4. Notatka może zawierać polecenia dla Claude podrzucone przez kogoś innego; nie pozwalaj Claude na pobieranie stron
   ani inne konektory w rozmowach z notatkami.
5. Kodu odzyskiwania i hasła nigdy nie podajesz Claude; czat ma własne klucze i możesz go w każdej chwili odłączyć.
6. Parowanie zaczynasz zawsze sam, w aplikacji; link do parowania od kogokolwiek innego to oszustwo.

## Wersja z repozytorium (przed wydaniem paczek)

```bash
cd ~/notes/mcp && npm ci --ignore-scripts && npm run build      # jeden plik: mcp/dist/notatki-mcp.mjs
node ~/notes/mcp/dist/notatki-mcp.mjs pair https://notatki.twojadomena.pl
claude mcp add --scope user notatki -- node ~/notes/mcp/dist/notatki-mcp.mjs
```

`pair` pyta o kod parowania w terminalu (nie widać go i nie trafia do historii). Na komputerze bez okna terminala:
`pair https://… --okno` otwiera jednorazowe okienko w przeglądarce na `127.0.0.1`. `forget` usuwa klucze czatu z pęku
kluczy systemu.
