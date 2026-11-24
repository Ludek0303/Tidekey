# Panel administratora serwera

Panel dla administratora serwera (osoby, która uruchamia `notes-node` na Radxie). To nie jest rola w organizacji: administrator serwera nie zna kluczy sejfów i nie czyta notatek.

## Dostęp

- Osobny nasłuch HTTP: `--admin-http ADDR` / `NOTES_ADMIN_HTTP` (np. `0.0.0.0:8081` w kontenerze). Bez tej opcji panelu nie ma.
- W `docker/compose.yml` port panelu jest wystawiony tylko na adres sieci lokalnej: `${NOTES_ADMIN_BIND:-127.0.0.1}:${NOTES_ADMIN_PORT:-8081}:8081`. Tunel na świat prowadzi tylko do portu aplikacji (8080), nigdy do panelu.
- Serwer odrzuca (403) żądania panelu z adresów spoza sieci prywatnych (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10). Nagłówków `X-Forwarded-For` nie bierze pod uwagę.
- Hasło: `NOTES_ADMIN_PASSWORD` (w `.env` jako `ADMIN_PASSWORD`; `scripts/wdrozenie.sh` generuje je przy pierwszym wdrożeniu i nigdy go nie wypisuje poza jednym komunikatem, gdzie je znaleźć). Bez hasła panel nie startuje.
- Logowanie: `POST /admin/api/login {password}` → ciasteczko `notes_admin` (HttpOnly, SameSite=Strict, Path=/admin, 8 h; bez `Secure`, bo panel działa po zwykłym HTTP w sieci lokalnej i przeglądarka nie zapisałaby ciasteczka `Secure`), sesja tylko w pamięci procesu. Limit: 5 błędnych prób na 15 min na adres IP. Porównanie hasła w stałym czasie. `POST /admin/api/logout`.
- Każde żądanie zmieniające stan wymaga nagłówka `X-Notes-Admin: 1` (ochrona przed CSRF z innych stron w sieci lokalnej) i sprawdza `Origin`, jeśli jest.
- Każda zmiana trafia do dziennika audytu (`audit::event`, `by=server-admin`).

## API (JSON, prefiks `/admin/api`)

| Metoda i ścieżka | Co robi |
|---|---|
| `GET /overview` | `{ disk: {totalBytes, freeBytes, dataBytes}, notesBytes, filesBytes, users, vaults: {organization, notes, personal}, storage: StorageStatus }` — `dataBytes` to rozmiar katalogu `/data`, `notesBytes` zaszyfrowane migawki, `filesBytes` załączniki (suma z `files.db`). `vaults.personal` to liczba kont z włączonymi własnymi notatkami (`personal = allowed`). `totalBytes`/`freeBytes` to rozmiar i wolne miejsce systemu plików z `/data` (`statvfs`; `null` poza Uniksem). `storage` jak w `GET /storage` |
| `GET /vaults` | `[{id, name, kind, owner: {id, email}, members: [{id, email, role}], snapshotBytes, filesBytes, quotaBytes, quotaDefault: bool}]` (bez sejfów osobistych) |
| `PATCH /vaults/{id}` | `{quotaMb: number \| null}` — limit plików sejfu (null = domyślny `NOTES_VAULT_FILES_MB`) |
| `DELETE /vaults/{id}/members/{userId}` | usuwa osobę z organizacji (jak `remove_member`: sejf dostaje flagę nowego klucza); właściciela nie da się usunąć |
| `GET /users` | `[{id, email, name, createdAt, sessions, personal: "allowed" \| "requested" \| "off", personalBytes, vaults: [{id, name, role}], assignments: [{vaultId, vaultName, role, createdAt}]}]` |
| `PATCH /users/{id}` | `{personal: "allowed" \| "off"}` — zgoda na własne notatki (odrzucenie prośby = `off`) |
| `GET /signup-codes` | `{codes: [{id, label, createdAt, expiresAt, usedAt, usedByEmail}]}` — kody rejestracyjne, najnowsze pierwsze; nigdy sam kod ani jego hash |
| `POST /signup-codes` | `{label, days}` (dni 1–90, opis do 80 znaków) → `{id, code, expiresAt}` — jedyny moment, w którym kod istnieje jawnie; panel pokazuje go raz z przyciskiem „Kopiuj” |
| `DELETE /signup-codes/{id}` | usuwa nieużyty kod; użyty albo nieistniejący → 404 |
| `DELETE /users/{id}?apply=1` | usuwa konto (jak `notes-node delete-user`); odpowiedź `{applied, vaults: [nazwa], left: [nazwa]}`, bez `apply` to tylko podgląd; właściciel sejfu z innymi członkami → 409 z komunikatem |
| `POST /users/{id}/assignments` | `{vaultId, role: "editor" \| "viewer" \| "admin"}` — przydział do sejfu współdzielonego; sejf osobisty → 400, osoba już jest członkiem → 409, ponowny przydział zmienia rolę |
| `DELETE /users/{id}/assignments/{vaultId}` | cofa przydział, który jeszcze nie został zrealizowany |
| `GET /storage` | `StorageStatus = {current: "local" \| "seaweedfs", available: [...], objects, bytes, migration: null \| {target, done, total, bytesDone, failed, startedAt, finishedAt, error}}` |
| `POST /storage/migrate` | `{target}` — przeniesienie wszystkich plików do drugiego magazynu (opis niżej); odpowiada `StorageStatus`. 409: migracja już trwa, cel jest obecnym magazynem albo nie jest skonfigurowany; nieznany cel → 400 |

Błędy: `{error: "tekst po polsku"}` z kodem 400/401/403/404/409/429. Udane zmiany bez innej treści odpowiadają `{ok: true}`. `PATCH /vaults/{id}` odpowiada `{quotaBytes, quotaDefault}`, a `PATCH /users/{id}` odpowiada `{personal}`. Limit sejfu wynosi od 1 MB do 1 TB i jest zapisany w `files.db` (`vault_quotas`).

## Własne notatki („Moje notatki”)

- Kolumna `web_users.personal`: `allowed` | `requested` | `off`. Konta istniejące przed tą zmianą: `allowed`.
- Rejestracja z linkiem zaproszenia do organizacji (`POST /api/auth/register` z `invite`) daje `off`; rejestracja z kodem od administratora (`code`) albo otwarta (`NOTES_REGISTRATION=open`, bez zaproszenia) daje `allowed`.

## Kody rejestracyjne

Domyślnie (`NOTES_REGISTRATION=invite`) konto zakłada się tylko z linku zaproszenia do organizacji albo z kodem od administratora serwera (`docs/API-WEB.md`). Kody wydaje się w sekcji „Kody rejestracyjne” panelu albo z wiersza poleceń:

```bash
notes-node signup-code --data /data --label "Ola z działu" --days 7   # wypisuje kod raz
notes-node signup-codes --data /data                                  # lista: opis, ważność, stan (bez kodów)
```

Kod działa raz. Audyt zapisuje tylko id kodu (`signup_code_created`, `signup_code_revoked`), nigdy kod ani opis.
- Przy `off`/`requested` serwer nie wydaje ani nie przyjmuje sejfu osobistego (`browser-<userId>`). Synchronizacja idzie przez WebSocket, więc zamiast HTTP 403 `hello` dostaje ramkę `{type: "error", code: "personal-off", message: "Własne notatki nie są włączone dla tego konta."}` i gniazdo się zamyka. `put` i pliki tego sejfu są odrzucane jak dla obcego sejfu, a czat Claude go nie widzi. Wyłączenie (`PATCH … off`) od razu odcina otwarte karty ramką `access` z `role: null`. Istniejąca zawartość sejfu osobistego nie jest usuwana przy wyłączeniu.
- `GET /api/auth/me` zwraca `user.personal` (także odpowiedzi `login`/`register`). `POST /api/me/personal-request` ustawia `requested` (tylko z `off`) i odpowiada `{personal}` ze stanem po wywołaniu.
- Ta sama zgoda pozwala zakładać organizacje: przy `off`/`requested` `POST /api/vaults` odpowiada 403, a menu przestrzeni nie pokazuje „Nowa organizacja…”. Konto z samego linku zaproszenia dołącza do organizacji, ale nie zakłada własnych, dopóki administrator serwera się nie zgodzi.
- Aplikacja: przy `off` nie pokazuje „Moje notatki”; po wejściu z linku zaproszenia otwiera organizację. W ustawieniach jest „Poproś o własne notatki”, przy `requested` napis „Czeka na zgodę administratora serwera”.

## Przydział do organizacji

Serwer nie zna kluczy sejfów, więc przydział realizuje przeglądarka właściciela albo administratora organizacji:

- Tabela `vault_assignments(vault_id, user_id, role, created_at)`.
- `GET /api/vaults/{id}/assignments` (właściciel/administrator organizacji) → `[{userId, email, name, role, boxKey}]` — `boxKey` to publiczny klucz szyfrowania osoby (z `user_box_keys`); przydziały osób bez klucza (nigdy się nie zalogowały) są pomijane.
- `POST /api/vaults/{id}/assignments/{userId}/complete {sealedKey, keyEpoch}` (pole przyjmowane też jako `wrappedKey`) → osoba staje się członkiem z przydzieloną rolą, a przydział znika. `sealedKey` to klucz sejfu zapieczętowany kluczem `boxKey` osoby (`notes-sealed-v1`, jak `keys[].sealedKey` przy zmianie klucza), bo przeglądarka właściciela nie zna klucza osobistego tej osoby. `keyEpoch` musi być bieżącą epoką (inaczej 409). Brak przydziału → 404, osoba już jest członkiem → 409. Odpowiedź: `{vault}`.
- Członkostwo powstaje z `wrappedKeyEpoch: 0` i `pendingKey: {keyEpoch, sealedKey}`. Przeglądarka tej osoby przy `wrappedKeyEpoch === 0` (albo zawsze, gdy jest `pendingKey`) najpierw otwiera `pendingKey` swoim kluczem pudełka, zapisuje własną kopię (`PUT /api/vaults/{id}/my-key`) i dopiero wtedy jej używa. `wrappedKey` w takim członkostwie nie jest kluczem `notes-key-v1` i nie wolno go odwijać.
- Przeglądarka właściciela/administratora po otwarciu organizacji pobiera przydziały, dla każdego pieczętuje klucz sejfu kluczem `boxKey` osoby i wysyła `complete`. Osoba widzi organizację przy następnym odświeżeniu listy sejfów.

## Magazyn plików

- `current` zapisany w `<data>/storage.json` (`{"backend": "local" | "seaweedfs"}`); bez pliku: jak dotąd z env (`NOTES_SEAWEEDFS_FILER` ustawiony → seaweedfs). Plik wskazujący `seaweedfs` bez ustawionego `NOTES_SEAWEEDFS_FILER` zatrzymuje start węzła (zamiast pokazać wszystkie pliki jako brakujące).
- `available` zawiera `seaweedfs` tylko, gdy `NOTES_SEAWEEDFS_FILER` jest ustawiony; `local` jest zawsze. Przy ustawionym filerze węzeł otwiera oba magazyny.
- `objects` i `bytes`: wiersze `files.db` w stanie `ready` i `trashed` (te mają obiekt w magazynie) i suma ich rozmiarów.
- Obiekty to całe szyfrogramy plików, jeden na plik (`<sejf>/<id>`). Porcje przesyłań w toku leżą zawsze lokalnie w `attachments/.part` i nie są przenoszone; plik, którego przesyłanie skończy się w trakcie migracji, trafia do starego magazynu i jest przenoszony przed przełączeniem.
- Migracja: jedna naraz, w tle. Dla każdego wiersza `files.db` (każdy stan, także kosz): pobierz obiekt ze starego magazynu (brak obiektu, np. przesyłanie w toku, nie jest błędem: liczy się jako zrobiony), zapisz go w `attachments/.migrate`, wstaw do celu → odczytaj z celu i porównaj długość i skrót SHA-256 → powtarzaj, dopóki pojawiają się nowe wiersze. Nowe wysyłki w trakcie migracji idą do starego magazynu. Przełączenie: migracja bierze wyłączny dostęp do magazynu (czeka na trwające wysyłki, pobrania, usuwanie i uzgadnianie; nowe czekają chwilę), przenosi to, co doszło od ostatniego przebiegu, zapisuje `storage.json` atomowo (plik tymczasowy, fsync, zmiana nazwy) i podmienia magazyn. Dopiero potem usuwa stare kopie (błąd usunięcia tylko w logu).
- Błąd któregokolwiek obiektu albo zapisu `storage.json`: migracja się zatrzymuje (`error`, `failed`, `finishedAt`), `current` się nie zmienia, nic nie jest usuwane (kopie już wstawione do celu zostają tam i zostaną nadpisane przy następnej próbie). Postęp w `GET /storage`, tylko w pamięci. Restart w trakcie: postęp przepada, migrację zaczyna się od nowa. Restart po zapisie `storage.json`, ale przed usunięciem starych kopii, zostawia je w starym magazynie (nieużywane).
- Plik usunięty w trakcie migracji może zostawić kopię w celu bez wiersza; uzgadnianie odkłada ją jak każdy obiekt bez wpisu.
- Dziennik audytu: `storage_migration_started` (`by=server-admin`), `storage_migrated`, `storage_migration_failed`.
