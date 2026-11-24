# Dane osobowe i RODO — stan, decyzje operatora, kwestie prawne

Ten dokument rozdziela trzy rzeczy: (A) co zrobiono w kodzie, (B) czego potrzebujemy od operatora serwisu,
(C) co wymaga oceny prawnej. Zmiany techniczne **nie** są certyfikacją zgodności z RODO. Polityka prywatności
(`ui/src/privacy.ts`) i regulamin pokazują baner „Dokument roboczy”, dopóki operator nie uzupełni pól w
`ui/src/legal.ts` (lista braków liczy `missingOperatorFields()`).

## A. Zmiany w kodzie (stan na 2026-10-29)

| Obszar | Zmiana | Pliki |
|---|---|---|
| Minimalizacja | Wymagane: e-mail, hasło, imię **lub** nazwa wyświetlana (może być pseudonim, jeden wyraz, dowolny alfabet). Nazwisko opcjonalne, osobne pole, można dodać/zmienić/usunąć. Usunięto wymóg dwóch wyrazów. | `crates/node/src/auth.rs`, `ui/src/browserauth.ts`, `ui/src/settings.ts` |
| Migracja | Kolumna `web_users.last_name TEXT NOT NULL DEFAULT ''` dodawana tylko gdy jej brak (ponowne uruchomienie bezpieczne). Istniejące `display_name` bez zmian; nazwy nie są dzielone na imię i nazwisko. Notatki nie są przepisywane. Nazwisko jest szyfrowane w przeglądarce: `web_users.profile_secret` i `vault_members.profile` (szyfrogramy, serwer nie zna klucza). Stara kolumna `last_name` jest tylko odczytywana do migracji i czyszczona przez klienta przy logowaniu. | `auth.rs`, `vaults.rs` |
| Tożsamość | Powiązania (role, członkostwa, sesje, autorstwo zdarzeń) używają `user_id`. Zadania przypisane `@nazwą` w treści po zmianie nazwy dalej są „moje” dzięki liście dawnych nazw (aliasów) w zaszyfrowanym snapshotcie sejfu. | `ui/src/bridge.ts`, `ui/src/orgtasks.ts`, `ui/src/mytasks.ts` |
| Widoczność | E-mail członka widzą tylko właściciel/administrator sejfu i sam członek; pozostali widzą nazwę, nazwisko (jeśli podane; szyfrowane kluczem sejfu, serwer go nie zna) i rolę. Brak publicznego katalogu i wyszukiwarki kont. | `crates/node/src/vaults.rs`, `ui/src/vaults.ts` |
| Dostęp do danych | `GET /api/auth/export` i przycisk „Pobierz moje dane”: konto, sesje (bez tokenów), członkostwa, utworzone zaproszenia; bez skrótów haseł, kluczy i danych innych osób. | `auth.rs`, `settings.ts` |
| Logi | Dziennik zdarzeń bez adresów e-mail (identyfikatory kont i sejfów). | `auth.rs`, `main.rs`, `vaults.rs` |
| IP | Skrót IP liczony z tajnym kluczem losowanym przy starcie (wcześniej zwykły blake3, możliwy do odwrócenia przez przeliczenie IPv4). Opisany jako pseudonimizacja, nie anonimizacja. | `auth.rs` |
| Klucz Moich notatek | Tabela `personal_vault_keys`: losowy klucz sejfu osobistego zaszyfrowany kluczem osobistym (serwer go nie odczyta), z numerem epoki i czasem utworzenia (docs/MCP.md §3.7). Usuwany razem z kontem; nie trafia do eksportu. | `vaults.rs`, `ui/src/browserauth.ts` |
| Urządzenie | „Wyloguj” albo „Wyloguj i usuń dane z tego urządzenia” (kopia sejfów i klucze tego konta w IndexedDB). | `ui/src/main.ts`, `ui/src/browserauth.ts` |
| Usunięcie konta | Gdy blokuje je rola jedynego właściciela organizacji, komunikat wskazuje: przekazanie roli, usunięcie członków albo żądanie do operatora. | `crates/node/src/admin.rs` |
| Dyktowanie (2026-11-16) | Mowa rozpoznawana wyłącznie w przeglądarce (Web Worker, model z własnego serwera). Dźwięk tylko w pamięci karty, kasowany po przepisaniu fragmentu; nie trafia na serwer, do IndexedDB/OPFS/Cache ani do historii wersji. Do notatki trafia tekst zwykłą zmianą Yjs (szyfrowaną jak pisanie). Mikrofon tylko po kliknięciu (`Permissions-Policy: microphone=(self)`), CSP `connect-src 'self' blob: https://api.github.com` blokuje inne hosty. Model mowy w OPFS po zgodzie, usuwalny w ustawieniach. Polityka prywatności (sekcja 8) opisuje to bez zmiany jej numeru wersji — decyzja operatora, czy to „istotna zmiana”. | `ui/src/voice/`, `crates/node/src/http.rs`, `ui/src/privacy.ts`, `docs/DYKTOWANIE.md` |
| Dokumenty | Polityka i regulamin opisują faktyczne działanie: pola wymagane/opcjonalne, akceptacja regulaminu ≠ zgoda, widoczność, retencja, dane lokalne, co widzi serwer i Cloudflare, ograniczenia usuwania. | `ui/src/privacy.ts`, `ui/src/legal.ts` |

Pozostałe ograniczenia techniczne:
- Rejestracja na zajęty adres zwraca 409 „Konto z tym adresem email już istnieje.” — to pozwala sprawdzić, czy konto
  istnieje. Logowanie tego nie zdradza. Usunięcie wymaga decyzji o UX (np. potwierdzenie e-mailem, którego serwis nie wysyła).
- Roli „założyciela” sejfu nie da się przekazać (jest częścią szyfrowania), więc założyciel z innymi członkami musi ich
  usunąć albo złożyć żądanie do operatora.
- Wersja desktopowa (Tauri) nie zna aliasów nazw i nazwiska — dotyczy tylko wersji przeglądarkowej.
- Pole `borrower` w ewidencji (inwentarze) i `lead` w projekcie to wpisane nazwy, nie `user_id`.

Sprostowane twierdzenia ze starej polityki:
- „Klucze w IndexedDB zaszyfrowane kluczem z kodu odzyskiwania” — nieprawda dla klucza osobistego: jest
  zapisany jako nieeksportowalny `CryptoKey` (przeglądarka nie wyda go skryptom, ale można go użyć w tym profilu).
- „Ze skrótu IP nie da się odtworzyć adresu” — nieprawda dla skrótu bez klucza (przestrzeń IPv4 to 2³²).
- „Serwer zna tylko rozmiar i czas zapisu” — zna też konto i sejf zapisu, nazwy sejfów, członków, role, zaproszenia.
- „Cloudflare widzi tylko zaszyfrowaną treść” — widzi też dane logowania, nazwy i nazwy sejfów (TLS kończy się w Cloudflare).

## B. Informacje wymagane od operatora

Uzupełnij w `ui/src/legal.ts` (pole `null` = brak; strona pokazuje „(do uzupełnienia)”):

1. **Kto jest administratorem** danych kont: imię i nazwisko albo firma, adres, e-mail do spraw danych (`name`, `address`, `email`).
2. **Inspektor ochrony danych**: dane IOD albo potwierdzenie, że nie został wyznaczony (`dpo`).
3. **Charakter usługi**: publiczna (każdy może założyć konto) czy dla konkretnej organizacji? (`NOTES_REGISTRATION=invite|open|closed`; domyślnie `invite`: konto tylko z linku zaproszenia do organizacji albo z kodem od administratora).
4. **Role wobec treści organizacji** (`organizationRoles`): czy organizacje korzystające z serwisu są administratorami swoich treści, a operator ich podmiotem przetwarzającym (wtedy potrzebna umowa powierzenia, art. 28)? Sama własność serwera nie przesądza o roli.
5. **Kopie zapasowe** (`backups`): czy są robione, gdzie, jak długo przechowywane, kto ma dostęp.
6. **Cloudflare** (`transferBasis`): czy zaakceptowano DPA Cloudflare; na jakiej podstawie odbywa się transfer poza EOG (decyzja o adekwatności / standardowe klauzule umowne). Nie wpisujemy tego bez potwierdzenia.
7. **Hosting**: gdzie stoi serwer (własny sprzęt / dostawca), kto ma do niego dostęp fizyczny i administracyjny.
8. **Retencja do decyzji**: czy zapisy wygasłych zaproszeń kasować po N dniach; czy logi kontenera trzymać krócej niż limit 50 MB; okres kopii.
9. **Ocena uzasadnionego interesu** (limity logowania, dziennik bezpieczeństwa): test równowagi do udokumentowania przez operatora.
10. **Kontakt dla żądań** i osoba, która je realizuje (w tym procedura weryfikacji tożsamości).

## C. Kwestie wymagające oceny prawnej

- Rola operatora wobec treści organizacji (administrator / podmiot przetwarzający / współadministrowanie).
- Podstawa transferu do Cloudflare i treść umowy powierzenia.
- Czy wiek 16 lat (art. 8 RODO) jest właściwy dla tej usługi; nie potwierdziliśmy w oficjalnym źródle, czy polska ustawa go zmienia (strona ISAP niedostępna dla automatu).
- Czy regulamin (prawo konsumenckie, usługi drogą elektroniczną) spełnia wymogi poza RODO.
- Zakres prawa do przenoszenia danych (art. 20) dla treści szyfrowanych po stronie klienta, których operator nie może odczytać.
- Ocena, czy dane w zaszyfrowanych sejfach (operator nie ma klucza) i pseudonimy IP pozostają danymi osobowymi dla operatora — wytyczne EROD 01/2025 wskazują, że dane spseudonimizowane pozostają danymi osobowymi; szyfrowanie nie wyłącza stosowania RODO.

## D. Zestawienie retencji (faktyczne działanie kodu)

| Dane | Gdzie | Okres | Kto decyduje o zmianie |
|---|---|---|---|
| Konto (e-mail, nazwa, nazwisko zaszyfrowane, skrót hasła, data) | `auth.db` `web_users` | do usunięcia konta | użytkownik / operator |
| Sesje (skrót tokenu, daty) | `auth.db` `web_sessions` | do wylogowania, max 30 dni | kod |
| Nieudane logowania (e-mail + pseudonim IP) | `auth.db` | 15 min | kod |
| Limit rejestracji (pseudonim IP) | pamięć procesu | 1 h | kod |
| Sejfy, członkowie, role, klucze publiczne, zaszyfrowane klucze | `auth.db` | do usunięcia sejfu / członkostwa | właściciele sejfu |
| Zaproszenia | `auth.db` `vault_invites` | link 7 dni; wiersz do usunięcia sejfu | **operator (B.8)** |
| Treść sejfów (zaszyfrowana), kosz, historia | dane węzła | do usunięcia przez członków / sejfu | członkowie |
| Dziennik zdarzeń bezpieczeństwa | log kontenera | rotacja 5 × 10 MB | **operator** |
| Kopie zapasowe | poza aplikacją | **nieustalone (B.5)** | operator |
| Nagranie głosu przy dyktowaniu | pamięć karty przeglądarki | do przepisania fragmentu (sekundy); nigdzie nie zapisywane | kod |
| Model mowy (nie dane osobowe) | OPFS przeglądarki `voice-models` | do „Usuń pobrany model” lub wyczyszczenia danych witryny | użytkownik |
| Kopia lokalna i klucze | IndexedDB przeglądarki | do „Wyloguj i usuń dane…” lub wyczyszczenia danych witryny | użytkownik |

Żadne istniejące dane nie zostały usunięte w ramach tych zmian.

## E. Procedura obsługi naruszenia (wewnętrzna)

1. **Zgłoszenie wewnętrzne**: każdy, kto zauważy incydent, od razu informuje operatora (kontakt z sekcji B.1); zapis: czas wykrycia, kto, co zauważył.
2. **Zabezpieczenie**: odciąć dostęp napastnika (rotacja haseł, `delete-user`/`reset-password`, zablokowanie rejestracji `NOTES_REGISTRATION=closed`), nie kasować dowodów — zrobić kopię `auth.db`, logów kontenera (`docker compose logs notes`) i wolumenu przed zmianami.
3. **Ocena**: jakie dane (konta? zaszyfrowana treść bez kluczy? klucze?), ile osób, czy możliwe jest ryzyko dla praw i wolności; udokumentować ocenę (art. 33 ust. 5 RODO wymaga dokumentowania wszystkich naruszeń).
4. **Decyzja o zawiadomieniach**: jeśli naruszenie może skutkować ryzykiem — zgłoszenie do Prezesa UODO bez zbędnej zwłoki, w miarę możliwości w 72 godziny od stwierdzenia (art. 33 ust. 1, formularz na biznes.gov.pl); jeśli wysokie ryzyko — zawiadomienie osób (art. 34). Decyzję podejmuje administrator danych.
5. Ta procedura **nie upoważnia** nikogo (w tym narzędzi automatycznych) do samodzielnego zgłaszania czegokolwiek organom ani użytkownikom.

## F. Kopia i wycofanie przy wdrożeniu

Migracja dodaje kolumnę (`ALTER TABLE ... ADD COLUMN`) i jest idempotentna. Przed wdrożeniem (w swoim terminalu):

```
sudo docker compose --env-file .env -f docker/compose.yml stop notes
sudo docker run --rm -v notes-organizations_notes-data:/data -v ~/backups:/b alpine tar czf /b/notes-data-$(date +%Y%m%d-%H%M).tgz -C /data .
sudo docker compose --env-file .env -f docker/compose.yml up -d --build notes
```

Wycofanie: przywrócić kod z `~/backups/notes-20261029-pre-rodo.tgz`, przebudować obraz. Stary kod ignoruje nową
kolumnę `last_name`, więc dane nie wymagają cofania; w razie potrzeby rozpakować kopię wolumenu z powrotem.

## G. Źródła oficjalne użyte do oceny

- EROD, Wytyczne 05/2020 w sprawie zgody (4 maja 2020), pkt 26–31: zgoda nie może być „wiązana” z akceptacją
  regulaminu; jeśli dane są niezbędne do wykonania umowy, właściwą podstawą jest umowa, nie zgoda.
  https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en
- EROD, Wytyczne 2/2019 dot. art. 6 ust. 1 lit. b (16 października 2019) — strona dokumentu sprawdzona; treść
  akapitów o „obiektywnej niezbędności” nie została odczytana automatycznie.
  https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22019-processing-personal-data-under-article-61b_en
- EROD, Wytyczne 01/2025 o pseudonimizacji (wersja do konsultacji publicznej), streszczenie: dane spseudonimizowane
  pozostają danymi osobowymi (motyw 26 RODO). https://www.edpb.europa.eu/public-consultations/guidelines-012025-on-pseudonymisation_en
- UODO, wytyczne dot. zgłaszania naruszeń (pkt 22, 29–31: art. 33 ust. 1 i ust. 5 RODO, 72 godziny) oraz strona
  zgłoszeń https://uodo.gov.pl/pl/492/2278, wytyczne 9/2022 https://uodo.gov.pl/pl/537/2902.
- Tekst RODO na EUR-Lex (https://eur-lex.europa.eu/legal-content/PL/TXT/?uri=CELEX:32016R0679) — **nie udało się
  pobrać automatycznie** (pusta odpowiedź serwera); odwołania do artykułów w tym dokumencie należy sprawdzić w tekście
  rozporządzenia. Nie zweryfikowano też decyzji o adekwatności UE–USA ani polskiej ustawy (ISAP).
