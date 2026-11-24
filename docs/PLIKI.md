# Pliki na serwerze (załączniki), wersja 2

Kontrakt wspólny dla serwera (`crates/node/src/files.rs`, `crates/node/src/objstore.rs`), klienta przeglądarkowego
(`ui/src/remotefiles.ts`, `ui/src/filecrypto.ts`, `ui/src/browserauth.ts`), edytora (`ui/src/attachments.ts`,
`ui/src/slash.ts`) i zakładki „Pliki” (`ui/src/filesview.ts`). Interfejs UI: `ui/src/filestore.ts`. Zmieniaj obie
strony razem. Wersja 1 (AES-GCM po porcjach, magazyn tylko na dysku) nigdy nie była wdrożona; nie ma danych v1.

## 1. Odnośnik (osadzenie) w Markdown

```
![[plik:<fileId>#<embedId>]]                  zwykły plik (nazwa, ikona, rozmiar) albo obraz na szerokość kolumny
![[plik:<fileId>#<embedId>|320]]              obraz 320 px szerokości (40–4000), wysokość z proporcji
![[plik:<fileId>#<embedId>|320x200]]          obraz dokładnie 320 × 200 px (obie wartości 40–4000)
![[plik:<fileId>#<embedId>|320x200 center]]   j.w. z ułożeniem (spacja przed ułożeniem)
![[plik:<fileId>#<embedId>|wrap-right]]       samo ułożenie, rozmiar naturalny
```

Alias (część po `|`) to gramatyka `W`, `WxH`, `W ułożenie`, `WxH ułożenie` albo samo `ułożenie`, gdzie:
- `W`, `H`: liczby całkowite 1–4 cyfry w px, ograniczone do 40–4000 (poza zakresem są przycinane). `H` tylko z `W`.
- `ułożenie`: `left` (do lewej), `center` (środek), `right` (do prawej) jako blok; `wrap-left`, `wrap-right`
  (opływ) jako pływający obraz z tekstem obok. W edytorze (Live Preview) opływ pokazuje się jak wyrównanie do
  lewej/prawej, bo pływający widżet psuje układ wierszy CodeMirror; w widoku czytania jest prawdziwym floatem.
- `pozN` (N = 0..50, całkowite; poza zakresem przycinane) to położenie poziome obrazu, dodawane na końcu aliasu
  (`320 poz25`, `poz0`). 0: lewa krawędź obrazu przy lewej krawędzi notatki, 50: prawa przy prawej, 25: na środku.
  Położenie zastępuje ułożenie: przesunięcie obrazu myszą lub polem czyści ułożenie, a wybór ułożenia czyści położenie.
- Przy samym `W` wysokość wynika z proporcji; `WxH` ustawia obie wartości (obraz skaluje się w pudełku
  `object-fit: contain`, gdy okno jest węższe). Każda wartość zapisana w notatce jest kanoniczna: tak,
  jak formatuje ją `formatImageAlias` (`ui/src/filestore.ts`), który odczytuje też `parseImageAlias`.
- Każdy inny alias (np. `320 środek`, `320x`, `320center`) nie jest osadzeniem: wzór `embedPattern` go nie
  dopasowuje.

- `fileId`: 32 znaki hex (128 losowych bitów), nadawane przez klienta w chwili wyboru pliku (`newFileId()`).
- `embedId`: 8 znaków hex, nadawany przy wstawieniu (`newEmbedId()`). To stabilny identyfikator **tego użycia**
  pliku w tej notatce: plik (A) i jego osadzenie (B) są rozdzielone. Ten sam plik może mieć wiele osadzeń,
  każde z inną szerokością.
- Jedynym źródłem prawdy o położeniu osadzenia jest tekst notatki (dokument Yjs). Pozycja przesuwa się razem z
  tekstem (CRDT), więc nie zapisuje się numerów wierszy ani przesunięć. Spis użyć (indeks) jest zawsze wyliczany z
  odszyfrowanych notatek po stronie klienta i można go odbudować w każdej chwili. Serwer nie zna powiązań plik ↔
  notatka (nie dostaje treści notatek).
- Kopiowanie: wklejony tekst zawierający osadzenie, którego `embedId` już jest w notatce, dostaje nowy `embedId`
  (ten sam plik, nowe użycie). Przeniesienie tekstu (wytnij/wklej) zachowuje `embedId`.
- Usunięcie kotwicy = usunięcie tekstu osadzenia. Plik zostaje (kosz tylko z panelu „Pliki”).
- Scalanie offline: dwa osadzenia z tym samym `embedId` po scaleniu są nadal poprawne (różne miejsca); pierwszy
  edytujący klient nada drugiemu nowy `embedId` dopiero przy zmianie szerokości (nie przepisuje cudzego tekstu sam).
- Starsze formy działają: `![[plik:<fileId>]]`, `![[plik:<fileId>|W]]` (bez `embedId`) i `![[assets/nazwa]]`
  (pulpit: pliki w `assets/`; przeglądarka: wpisy `attachments` w snapshocie, po migracji z `fileId`).
- Odnośnik nigdy nie zawiera adresu URL do pobrania ani klucza.

## 2. Szyfrowanie (klient)

Biblioteka: `libsodium-wrappers` 0.8.4 (ISC), dołączona do aplikacji (bez CDN), ładowana dynamicznie przy pierwszym
użyciu. Algorytm: `crypto_secretstream_xchacha20poly1305`. Własnej kryptografii nie ma.

- Każdy plik (każda wersja = nowy `fileId`) ma własny losowy klucz 32 B (`crypto_secretstream_xchacha20poly1305_keygen`).
- Obiekt na serwerze (kontener v2):

```
"NOTESF2\n"                 8 B   magic + wersja formatu
header                       24 B  nagłówek secretstream
porcja 0..n-1                każda: tekst jawny 1 MiB (PLAIN_CHUNK = 1048576) + 17 B (ABYTES)
```

  Każda porcja ma ten sam AD:
  `notes-file-v2\0<vaultId>\0<fileId>\0<scope albo pusty>\0<version=1>`, co wiąże szyfrogram z sejfem, plikiem,
  zakresem i wersją (podmiana obiektu innego pliku nie przejdzie). Porcje 0..n-2 mają `TAG_MESSAGE` i dokładnie
  1 MiB tekstu, ostatnia `TAG_FINAL` i resztę (pusty plik = jedna porcja 17 B z `TAG_FINAL`).
  Odszyfrowanie odrzuca: zły magic, błąd uwierzytelnienia, `TAG_FINAL` przed ostatnią porcją, brak `TAG_FINAL`
  na końcu, inną długość porcji niż wynikająca z `size` z metadanych, dane po `TAG_FINAL`.
  Kolejność wymusza sam secretstream (stan), przestawione lub powielone porcje nie przejdą uwierzytelnienia.
- Rozmiary (serwer zna tylko te wzory): `chunks = max(1, ceil(size/PLAIN_CHUNK))`,
  `cipherSize = 32 + size + 17*chunks`. Porcja wysyłana nr 0 zawiera 32 B nagłówka kontenera + pierwszą porcję
  secretstream; każda inna dokładnie `CIPHER_CHUNK = 1048593` B, ostatnia resztę.
- Przerwane przesyłanie nie jest kontynuowane z zapisanego stanu secretstream: „Ponów” po przerwie anuluje stary
  rekord i przesyła plik od nowa z **nowym kluczem** i tym samym `fileId` (odnośnik w notatce się nie zmienia; stary
  szyfrogram nigdy nie był zatwierdzony). Ponowienie jednej porcji w obrębie sesji wysyła te same bajty szyfrogramu,
  bo stan szyfrowania jest wtedy w pamięci.
- Metadane (koperta `meta`, ≤ 4 KiB) szyfrowane istniejącym mechanizmem: AES-GCM kluczem sejfu (epoka
  `keyEpoch`) albo kluczem chronionego projektu (epoka `projectEpoch`), AAD = `notes-file-meta-v2\0<vaultId>\0<fileId>`:

```json
{ "schema": "notes-file-meta-v2", "keyEpoch": 3, "nonce": "<b64>", "ciphertext": "<b64>" }
{ "schema": "notes-file-meta-v2", "scope": "<32 hex>", "projectEpoch": 2, "nonce": "<b64>", "ciphertext": "<b64>" }
```

  Tekst jawny: `{"format":2,"version":1,"name","mime","size","project","key":"<b64>","createdAt","width"?,"height"?,
  "thumb"?: "<fileId miniatury>", "thumbOf"?: "<fileId oryginału>", "duration"?: <ms, film>}`.
- Miniatury zdjęć i filmów: klient tworzy (canvas, ≤ 480 px dłuższy bok, JPEG/WebP; film: pierwsza klatka wyciągnięta w
  ukrytej ramce podglądu, PODGLAD.md §2.2, a długość trafia do `duration`) i wysyła jako osobny plik z
  `thumbOf` w metadanych i jawnym polem `parent` w rekordzie; oryginał ma `thumb`. Serwer zna więc powiązanie
  miniatury ze zdjęciem (nie jej treść) i sam prowadzi je razem: kosz, przywracanie, anulowanie i trwałe usunięcie
  oryginału dotyczą też miniatury. Miniatura, której zdjęcie nigdy nie powstało, znika po `NOTES_UPLOAD_STALE_HOURS`.
  Panel „Pliki” ich nie pokazuje.
- Serwer liczy blake3 **szyfrogramu** (spójność magazynu); skrótów tekstu jawnego nie ma nigdzie.
- Klucze nie trafiają do linków, logów, komunikatów błędów ani na serwer w jawnej postaci.
- Rotacja klucza sejfu/projektu: klient z nowym kluczem przepakowuje koperty starszych epok (`PATCH meta`).
  Klucz pliku się nie zmienia, więc rotacja chroni **nowe** pliki przed osobą usuniętą, ale nie cofa dostępu
  do plików, których klucz lub treść ta osoba już poznała. Serwer od razu przestaje wydawać szyfrogram i koperty
  osobie bez członkostwa.

### Zakres chronionego projektu (`scope`)

`scope = hex(SHA-256("notes-scope-v1\0" + vaultId + "\0" + ścieżkaProjektu))[0..32]`. Przed pierwszym plikiem
w chronionym projekcie klient ustawia listę osób zakresu (`PUT file-scopes`) = członkowie projektu. Serwer
wydaje pliki zakresu wyłącznie osobom z listy; rola w organizacji (nawet właściciel/administrator) nie wystarcza.

## 3. API serwera

Wszystkie ścieżki wymagają sesji; zmiany wymagają zgodnego Origin. `{v}` to id sejfu. Uprawnienia przez
`BrowserSync::access_role`. Znajomość `id` niczego nie daje: brak dostępu = 404.

| Metoda i ścieżka | Kto | Działanie |
|---|---|---|
| `POST /api/vaults/{v}/files` `{id,size,meta,scope?,parent?}` | edytor+ (i członek `scope`) | Zakłada przesyłanie i **rezerwuje** `size` w limicie przestrzeni. 201 nowy; 200 gdy ten sam użytkownik ponawia to samo `id` i `size`; 409 gdy `id` zajęte inaczej; 413 limit pliku/przestrzeni; 429 gdy użytkownik ma już `NOTES_MAX_PARALLEL_UPLOADS` otwartych przesyłań. |
| `PUT /api/vaults/{v}/files/{id}/chunks/{n}` | twórca | Porcja `n`: `n == received` zapis; `n < received` 200 bez zapisu; `n > received` 409 `{received}`. Długość wg §2. |
| `POST /api/vaults/{v}/files/{id}/complete` | twórca | Sprawdza długość, liczy blake3, zapisuje obiekt w magazynie, odczytuje z powrotem długość, dopiero wtedy stan `ready` (atomowe zatwierdzenie). |
| `GET /api/vaults/{v}/files` | widz+ | `{files, used, quota, trashDays}` bez cudzych zakresów i cudzych nieukończonych. |
| `GET /api/vaults/{v}/files/{id}` | widz+ (zakres) | Rekord. |
| `GET /api/vaults/{v}/files/{id}/content` | widz+ (zakres) | Strumień szyfrogramu; `application/octet-stream`, `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `Content-Security-Policy: sandbox; default-src 'none'`. |
| `PATCH /api/vaults/{v}/files/{id}` `{meta}` | edytor+ (zakres) | Nowa koperta. |
| `DELETE /api/vaults/{v}/files/{id}` | edytor+ (zakres) | `uploading` → anulowanie; `ready` → kosz. |
| `POST …/{id}/restore` | edytor+ (zakres) | Z kosza. |
| `POST …/{id}/purge` | admin+ (zakres) | Trwałe usunięcie z kosza. |
| `PUT /api/vaults/{v}/file-scopes/{scope}` `{members}` | edytor+; istniejący zakres — tylko jego członek | Lista osób zakresu. |

Rekord: `{id, state: uploading|ready|trashed|missing, size, chunks, received, scope, meta, createdBy, createdAt,
completedAt, deletedAt, parent}`; `size`/`used` to bajty szyfrogramu.

## 4. Magazyn i baza (serwer)

- Katalog: `<data>/files.db` (SQLite, WAL), tabele `files`, `file_scopes`. SQLite pozostaje źródłem prawdy o
  stanie plików; magazyn obiektów trzyma tylko szyfrogramy.
- Magazyn obiektów (`objstore.rs`, cecha `ObjectStore`): `put(key, plik części)`, `get(key)` (strumień),
  `size(key)`, `delete(key)`, `list(sejf)` (klucze z rozmiarami). Klucz obiektu: `<vaultId>/<fileId>`.
  - `LocalStore` (domyślny, gdy `NOTES_SEAWEEDFS_FILER` nie ustawiono): `<data>/attachments/<vault>/<id>`.
  - `SeaweedStore`: filer SeaweedFS przez HTTP (`NOTES_SEAWEEDFS_FILER`, np. `http://seaweedfs:8888`),
    ścieżka `/notes-files/<vault>/<id>`. Gdy ustawiono `NOTES_SEAWEEDFS_JWT_KEY` (ten sam sekret co
    `WEED_JWT_FILER_SIGNING_KEY` i `WEED_JWT_FILER_SIGNING_READ_KEY` po stronie SeaweedFS), każde żądanie ma
    `Authorization: Bearer` z JWT HS256 ważnym 60 s. Sekret jest tylko w `.env` serwera, nigdy w przeglądarce.
  - SeaweedFS działa w sieci Dockera `internal: true`, bez opublikowanych portów, bez S3/SFTP/IAM/WebDAV.
- Przesyłanie porcji: na dysku w `<data>/attachments/.part/<vault>.<id>` (dopisanie, `fsync`, potem
  `received += 1`). `complete`: długość, blake3, `put` do magazynu, `len` zgodne, stan `ready`, usunięcie części.
  Awaria między `put` a `ready` zostawia obiekt bez rekordu `ready`: uzgadnianie go sprząta lub zatwierdza.
- Uzgadnianie (start, co godzinę, `notes-node files-check --data D`): `ready` bez obiektu → `missing`;
  obiekt bez rekordu → przeniesiony do `orphans/` (lokalnie) / zostawiony i zalogowany (SeaweedFS), nie kasowany;
  `.part` bez rekordu → usunięty; `uploading` starsze niż `NOTES_UPLOAD_STALE_HOURS` → usunięte (z rezerwacją);
  kosz starszy niż `NOTES_FILE_TRASH_DAYS` → usunięty.
- Limity: `NOTES_FILE_MAX_MB` (100), `NOTES_VAULT_FILES_MB` (2048; kosz i rezerwacje się wliczają),
  `NOTES_FILE_TRASH_DAYS` (30), `NOTES_UPLOAD_STALE_HOURS` (24), `NOTES_MAX_PARALLEL_UPLOADS` (4 na osobę).
- Audyt: `file_uploaded`, `file_trashed`, `file_restored`, `file_purged`, `file_scope_set` z id sejfu, id pliku i
  rozmiarem — nigdy nazwy, treści ani klucza.
- Replikacja SeaweedFS nie jest kopią zapasową. Kopia = wolumen `notes-data` + wolumen `seaweed-data`
  (`scripts/wdrozenie.sh`).

## 5. Migracja załączników ze snapshotów (przeglądarka)

Wpis snapshotu `attachments: [{key, bytesBase64, fileId?}]`.

1. Klient z rolą edytor+ dla każdego wpisu z treścią i bez `fileId`: `id = hex(HMAC-SHA256(sekret, "migrate\0" +
   key + "\0" + sha256(bajty)))[0..32]` (to samo id przy ponowieniu i na innym kliencie), przesyła plik, **czyta go
   z powrotem i porównuje bajty**.
2. Dopiero wtedy zapisuje wpis jako `{key, bytesBase64: "", fileId}`.
3. Scalanie: wpis z `fileId` wygrywa z wpisem z treścią dla tego samego `key`; starszy klient, który wprowadzi
   treść z powrotem, zostanie zmigrowany ponownie do tego samego id (bez duplikatu).

## 6. Pobieranie na żądanie

- Treści plików nie ma w snapshotach ani w WebSocket. Logowanie, synchronizacja, indeksowanie i lista plików
  pobierają tylko rekordy i koperty (`GET …/files`), nigdy `…/content`.
- Zwykły plik: pobierany po „Otwórz”/„Pobierz”. Zdjęcie: gdy osadzenie jest widoczne (IntersectionObserver), a przy
  wyłączonym ustawieniu „Automatycznie wczytuj obrazy” dopiero po „Wyświetl obraz”. Najpierw miniatura, pełny
  obraz w podglądzie.
- Bez trwałych kopii lokalnych: obiekty Blob/URL są zwalniane po zamknięciu podglądu lub zniknięciu osadzenia;
  pamięć podręczna w karcie ma limit. Brak sieci → „Plik jest niedostępny bez połączenia”.
- **Okno podglądu** (2026-11-18, [PODGLAD.md](PODGLAD.md), [PODGLAD-PLAN.md](PODGLAD-PLAN.md)): dwuklik, spacja, „Podgląd”
  w menu i polecenie palety otwierają okno nad aplikacją. Aplikacja odszyfrowuje plik (z postępem w MB, przerwanie przy
  zamknięciu) i przekazuje same bajty, nazwę i typ do odizolowanej ramki `/preview/` (`sandbox`, bez pochodzenia, bez
  sieci, bez kluczy); tam działają przeglądarki formatów. HTML nigdy nie jest renderowany (pokazany jako kod), SVG
  tylko jako obraz.
- **Film**: okno pokazuje pierwszą klatkę. Miniatura powstaje przy wysyłaniu (jak zdjęcia), więc podgląd pobiera tylko
  ją. Film wysłany wcześniej: odszyfrowane jest najwyżej 16 MiB początku (`FileStore.readHead`, pobieranie przerywane po
  ostatniej potrzebnej porcji), a udana klatka zostaje wysłana jako miniatura (rola edytor+, `setThumbnail`).
- „Otwórz” działa jak dotąd: obraz w oknie, PDF w nowej karcie (`noopener`, typ wymuszony na `application/pdf`),
  audio/wideo w `<audio>`/`<video>` z blob (cały plik odszyfrowany najpierw), tekst jako czysty tekst. Reszta: pobranie.
  Bez losowego dostępu / przewijania dużych filmów.

## 7. Zakładka „Pliki”

Lista z `FileStore.list()`; użycia liczone po stronie klienta z notatek, które użytkownik może odszyfrować.
Wyszukiwanie, filtr typu i projektu, zajęte miejsce, dodawanie, otwieranie, pobieranie, zmiana nazwy, wstawienie
istniejącego pliku do aktywnej notatki (nowy `embedId`, bez ponownego przesyłania), lista użyć z przejściem do
osadzenia, kosz i przywracanie. Usunięcie odnośnika nie usuwa pliku.

**Pliki w folderach (2026-11-17).** Plik serwera może też leżeć w zwykłym folderze drzewa, bez osadzenia w notatce.
Jego miejsce trzyma snapshot sejfu (`state.folderFiles`, WEB-WSPOLDZIELENIE), a bajty i nazwa są jak każdego pliku
tutaj. Usunięcie z folderu przenosi plik do kosza tylko wtedy, gdy żadna notatka go nie osadza. Konto, które nie
odczyta wszystkich chronionych notatek, nigdy nie przenosi go do kosza: tylko zdejmuje z folderu. W chronionym projekcie
plików w folderach nie ma, bo wpis w snapshocie widzi każdy członek. Tam plik dodaje się w notatce.

## 8. Klucze — gdzie są i czego nie chronią

| Co | Gdzie | Postać |
|---|---|---|
| Treść pliku, miniatura | SeaweedFS (wolumen `seaweed-data`), `/notes-files/<sejf>/<id>` | szyfrogram v2 (secretstream) |
| Nazwa, typ, rozmiar, projekt, **klucz pliku** | `files.db` → kolumna `meta` (wolumen `notes-data`) | koperta AES-GCM kluczem sejfu/projektu |
| Stan, rozmiar szyfrogramu, blake3 szyfrogramu, twórca, daty, zakres | `files.db` | jawne (potrzebne serwerowi) |
| Klucz sejfu / projektu | serwer: tylko zaszyfrowane kopie dla członków; przeglądarka: IndexedDB `notes-browser-local-v1`, zaszyfrowane kluczem osobistym | — |
| Klucz osobisty | IndexedDB, nieeksportowalny `CryptoKey`; kopia tylko w kodzie odzyskiwania użytkownika | — |
| Sekret JWT magazynu | `.env` serwera (`SEAWEEDFS_JWT_KEY`) | jawny, tylko na serwerze |
| Powiązania plik ↔ notatka | nigdzie na serwerze; liczone w przeglądarce z odszyfrowanych notatek | — |

Ograniczenia (świadome):
- Klucz osobisty w IndexedDB nie jest chroniony dodatkowym hasłem. Zwykłe „Wyloguj” go zostawia (żeby nie trzeba było
  kodu odzyskiwania); „Wyloguj i usuń dane z tego urządzenia” go usuwa. Ktoś z dostępem do odblokowanego profilu
  przeglądarki może otworzyć notatki i pliki przez aplikację. Odzyskiwanie dostępu działa jak dotąd (kod 64 hex).
- Rotacja klucza sejfu/projektu chroni nowe pliki. Osoba, która wcześniej miała dostęp, mogła zapisać klucz pliku
  albo treść — tego nie da się cofnąć (tak samo jak przy notatkach). Serwer od razu przestaje jej wydawać szyfrogram.
- Serwer zna dokładny rozmiar oryginału (wynika z rozmiaru szyfrogramu), czas, autora i sejf każdego pliku oraz
  powiązanie miniatury ze zdjęciem.
- `used` w liście plików liczy też pliki zakresów i nieukończone przesyłania innych osób (suma, bez szczegółów).
- Zakres chronionego projektu jest skrótem ścieżki: członek sejfu, który zgadnie ścieżkę nowego projektu, może
  pierwszy założyć jego listę osób i zablokować dodawanie plików do tego projektu (dostępność, nie poufność — klucz
  projektu nadal chroni treść). Planowana poprawka: losowy identyfikator zakresu przechowywany w zaszyfrowanym sejfie.
- Dwie karty przesyłające ten sam `fileId` jednocześnie mogą wymieszać porcje; serwer zatwierdzi plik, którego klient
  nie odszyfruje (komunikat „uszkodzony”). Edytor nadaje losowe id, więc dotyczy to praktycznie tylko migracji.
  Planowana poprawka: token przesyłania wymagany przy każdej porcji.
- Edytor (4 przesyłania × do 100 MB) może na 24 h zarezerwować miejsce w limicie sejfu.
- „Otwórz” dla filmu odszyfrowuje go w całości przed odtworzeniem (bez przewijania strumieniowego); okno podglądu pokazuje
  tylko pierwszą klatkę.
- Podgląd starego filmu (bez miniatury) przerywa pobieranie po 16 MiB odszyfrowanych danych, ale serwer nie obsługuje
  `Range`, więc przeglądarka może zdążyć pobrać kilka MiB więcej (PODGLAD.md §6).
- Okno podglądu jest tylko w przeglądarce; pulpit otwiera pliki jak dotąd.
- Pulpit (Tauri) nadal trzyma załączniki lokalnie w `assets/` (bez serwera); synchronizacji pulpit–serwer nie ma.

## 9. Wdrożenie, kopia zapasowa i wycofanie

- Wdrożenie: `cd ~/notes && sudo sh scripts/wdrozenie.sh`. Skrypt: dopisuje `SEAWEEDFS_JWT_KEY` do `.env`, gdy go nie
  ma; zatrzymuje `notes` i `seaweedfs` (spójna para `files.db` ↔ obiekty); robi kopie `~/backups/notes-data-<data>.tgz`,
  `~/backups/seaweed-data-<data>.tgz` i `~/backups/compose-<data>.yml`; buduje i uruchamia obie usługi; sprawdza `/health`.
- Pierwsze uruchomienie: wolumen `seaweed-data` jest pusty, `files.db` powstaje przy starcie. Istniejące notatki,
  konta i sejfy się nie zmieniają. Stare załączniki ze snapshotów migruje pierwszy klient z rolą edytor+ (§5).
- Wycofanie do wersji bez plików: zatrzymać `notes` i `seaweedfs`, przywrócić kod z `~/backups/notes-20261030-pre-files2.tgz`,
  przywrócić wolumen `notes-data` z kopii sprzed wdrożenia (`docker run --rm -v <wolumen>:/data -v ~/backups:/b alpine
  sh -c 'rm -rf /data/* && tar xzf /b/notes-data-<data>.tgz -C /data'`), zbudować i uruchomić `notes`.
  Uwaga: po migracji (§5) snapshoty mają wpisy `{key, bytesBase64: "", fileId}` — stara wersja pokaże takie załączniki
  jako puste. Dlatego przy wycofaniu po migracji trzeba przywrócić `notes-data` z kopii sprzed wdrożenia (zmiany
  notatek zrobione po wdrożeniu przepadną) albo zostać przy nowej wersji.
- Replikacja SeaweedFS nie jest kopią zapasową; kopie robi skrypt wdrożenia (albo osobny cron z tymi samymi poleceniami).
