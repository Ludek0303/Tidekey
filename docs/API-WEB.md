# API webowe — konta i sesje

Węzeł udostępnia API tej samej domeny co klient webowy. CORS nie jest włączony. Zmieniające stan żądania z nagłówkiem `Origin` są akceptowane wyłącznie, gdy host i schemat zgadzają się z bieżącą domeną. Za zaufanym reverse proxy używane są `X-Forwarded-Host` i `X-Forwarded-Proto`; bez proxy serwer sprawdza `Host`.

## Endpointy

- `POST /api/auth/register` — JSON `{ "email": "...", "password": "...", "invite"?: "<token linku zaproszenia>", "code"?: "<kod od administratora>" }`; hasło przy tworzeniu konta ma co najmniej 8 znaków, przynajmniej jedną wielką literę i przynajmniej jedną cyfrę, a najwyżej 1024 bajty. Tworzy konto i sesję. Zwraca `201 { "user": { "id": "...", "email": "..." } }`. Kto może założyć konto, ustala `NOTES_REGISTRATION` (niżej).
- `GET /api/source` — bez logowania; zwraca `{ "license": "AGPL-3.0-or-later", "version": "…", "commit": "…", "source": "…" }`: licencję serwera, jego wersję, commit i adres repozytorium z czasu budowania (`NOTES_COMMIT`, `NOTES_SOURCE_URL`; puste, gdy budowa ich nie miała). Ustawienia → O programie pokazują z tego link do kodu źródłowego serwera (AGPL §13, docs/LICENCJE.md).
- `GET /api/auth/me` — zwraca `{ "authenticated": true, "user": { "id": "...", "email": "..." } }` albo `{ "authenticated": false, "registration": "invite" | "open" | "closed" }` (strona logowania pokazuje wtedy pole kodu albo chowa „Utwórz konto”).
- `POST /api/auth/login` — ten sam JSON; zwraca `200 { "user": { "id": "...", "email": "..." } }`.
- `POST /api/auth/logout` — unieważnia sesję i zwraca `{ "authenticated": false }`.

### Rejestracja: link zaproszenia albo kod od administratora

`NOTES_REGISTRATION` (domyślnie `invite`; nieznana wartość też daje `invite`):

- `invite` — konto powstaje tylko z ważnym linkiem zaproszenia do organizacji (`invite`) albo z kodem rejestracyjnym (`code`). Bez nich `403 "Konto można założyć z linku zaproszenia do organizacji albo z kodem od administratora serwera."`.
- `open` — każdy może założyć konto (dawne zachowanie domyślne).
- `closed` — nikt (`403 "Rejestracja nowych kont jest wyłączona."`).

Kod rejestracyjny wydaje administrator serwera w panelu (`docs/PANEL-ADMINA.md`) albo poleceniem `notes-node signup-code`. Ma 12 znaków (`ABCD-EFGH-JKLM`, bez 0/O i 1/I, 60 losowych bitów), wielkość liter, spacje i myślniki przy wpisywaniu nie mają znaczenia. `auth.db` przechowuje tylko hash BLAKE3 kodu (`signup_codes`). Kod działa raz i do daty ważności (1–90 dni). Zużywa go ta sama transakcja, która zakłada konto, więc konto odrzucone (np. zajęty email) kodu nie zużywa. Zły, zużyty albo przeterminowany kod → `403 "Ten kod rejestracyjny jest nieprawidłowy, wygasł albo został już użyty. Poproś administratora o nowy."`. Próby z kodem liczą się do limitu `NOTES_REGISTER_PER_HOUR`, więc kodów nie da się zgadywać seriami. Konto z kodem dostaje własne notatki (`personal = allowed`), a konto z samego linku zaproszenia nie (`off`, zob. `docs/PANEL-ADMINA.md`).

Po rejestracji lub logowaniu serwer ustawia losowy, nieprzezroczysty cookie `notes_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, ważny 30 dni i z flagą `Secure` domyślnie. Klient wysyła żądania same-origin z poświadczeniami. Błędne dane logowania nie ujawniają, czy konto istnieje. Po 10 nieudanych próbach dla emaila w 15 minut logowanie jest tymczasowo ograniczane.

`AUTH_COOKIE_SECURE=false` wyłącza flagę `Secure` **wyłącznie do lokalnych testów po HTTP**. W produkcji pod HTTPS pozostaw wartość domyślną. Baza `auth.db` przechowuje hashe Argon2id haseł oraz hashe tokenów sesji, nigdy surowe tokeny. Katalog danych węzła ma prawa `0700` na Unix.

## Granica kryptograficzna

API uwierzytelnia konto webowe, ale **nie jest kluczem szyfrującym vault**. Nie przyjmuje frazy odzyskiwania, klucza ani treści notatek. Powiązanie konta z odzyskiwaniem lub odblokowaniem przestrzeni należy do klienta. To API nie jest zamiennikiem synchronizacji E2EE i nie powinno przyjmować jawnej treści notatek.

## Synchronizacja przeglądarki (WSS)

`GET /api/sync/ws` otwiera WebSocket dla zalogowanej sesji z cookie `notes_session`. Upgrade wymaga nagłówka `Origin` zgodnego z hostem i schematem tej samej domeny. Po połączeniu klient ma 8 sekund na wysłanie:

```json
{"type":"hello","vaultId":"browser-<userId>"}
```

`vaultId` jest ograniczony do znaków ASCII alfanumerycznych, kropki, podkreślenia i łącznika; rekordy są dodatkowo izolowane przez `user_id`, więc klient nie może odczytać innego konta. Serwer odpowiada bieżącym stanem:

```json
{"type":"snapshot","revision":0,"envelope":null}
```

Po zapisaniu snapshotu envelope ma postać `{"schema":"notes-encrypted-v1","nonce":"<base64>","ciphertext":"<base64>"}`. Nonce musi dekodować się do 12 bajtów, a ciphertext zawiera co najmniej 16 bajtów. Klient zapisuje optymistycznie względem revision:

```json
{"type":"put","baseRevision":0,"envelope":{"schema":"notes-encrypted-v1","nonce":"...","ciphertext":"..."}}
```

Zapis przy zgodnej revision zwraca `{"type":"ack","revision":1}` i rozsyła `{"type":"update","revision":1,"envelope":...}` do pozostałych połączeń tej samej sesji użytkownika i vaultu. Przy konflikcie klient dostaje `{"type":"conflict","revision":...,"envelope":...}` z najnowszym stanem. Maksymalny rozmiar wiadomości WebSocket to 16 MiB. Baza `browser-sync.db` przechowuje tylko zwalidowany JSON envelope, revision i identyfikatory konta/vaultu; envelope nie jest logowany ani odszyfrowywany przez serwer.

Ten kanał zapewnia transport i przechowywanie nieprzezroczystych envelope. Sam endpoint **nie dowodzi, że klient je poprawnie szyfruje**; klient musi zarządzać kluczami i nigdy nie wysyłać jawnych notatek.
