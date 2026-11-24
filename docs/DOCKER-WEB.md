# Budowanie i uruchamianie wariantu webowego w Dockerze

Dockerfile buduje jeden obraz zawierający binarny `notes-node`, statyczny frontend i WASM silnika formuł. Dane węzła są trzymane w osobnym wolumenie `/data`.

## Wymagania

- Docker Engine z BuildKit oraz Docker Compose v2.
- Przy publicznym dostępie: domena skierowana na serwer i otwarte porty TCP 80/443. Caddy uzyskuje certyfikat automatycznie.
- Repozytorium zawiera wymagany `Cargo.lock` i `ui/package-lock.json`.

## Zbuduj obraz

W katalogu projektu (np. `/home/<user>/notes`):

```bash
docker build -f docker/Dockerfile -t notes-organizations-web:local .
```

Budowanie kompiluje Rustowy węzeł, moduł `notes-web` do WebAssembly i frontend Vite. Weryfikacja TypeScript jest częścią kroku budowania UI.

Można też zbudować obraz przez Compose:

```bash
docker compose -f docker/compose.yml build notes
```

Gotowy obraz jest także zapisany jako `docker/notes-organizations-web.tar`. Na innym serwerze załaduj go poleceniem:

```bash
docker load -i docker/notes-organizations-web.tar
```

### Kod źródłowy w „O programie” (AGPL)

Notatki są na licencji AGPL-3.0-or-later: użytkownicy serwera mają dostęp do kodu źródłowego wersji, która na nim
działa (docs/LICENCJE.md §1). W `.env` ustaw adres publicznego repozytorium:

```bash
NOTES_SOURCE_URL=https://github.com/<login>/<repozytorium>
```

`scripts/wdrozenie.sh` dodaje przy budowie `NOTES_COMMIT` (`git rev-parse HEAD` katalogu, z którego budujesz), a
Ustawienia → O programie i `GET /api/source` pokazują link `NOTES_SOURCE_URL/tree/<commit>`. Link działa tylko wtedy,
gdy ten commit jest w publicznym repozytorium, więc buduj serwer z klonu publicznego repozytorium (albo z gałęzi, której
commity są w nim opublikowane). Przy ręcznym `docker compose build` podaj `NOTES_COMMIT=$(git rev-parse HEAD)` w
środowisku.

## Modele dyktowania

Modele mowy leżą na dysku serwera, w osobnym wolumenie `voice-models`, a nie w obrazie. `notes-node` montuje go tylko
do odczytu jako `/data/models` i serwuje jako `/models/*` z tego samego originu co aplikacja. Przeglądarka pobiera więc
model tylko z tego serwera Notatek, nigdy z Hugging Face ani GitHuba. Nowy obraz nie zawiera modeli, a kopie
`notes-data` (`wdrozenie.sh`, `kopia.sh`) ich nie obejmują. Bez modeli serwer działa, przy starcie wypisuje
ostrzeżenie, a dyktowanie pokazuje błąd ładowania.

`scripts/wdrozenie.sh` wgrywa modele przy każdym wdrożeniu. Pliki, które już są, tylko sprawdza. Źródło wybiera tak:
1. katalog `models/` w katalogu projektu, jeśli go tam skopiowano (np. `scp -r models <serwer>:~/notes/`);
2. inaczej `VOICE_MODELS_FROM` z `.env`, czyli inny serwer Notatek, który ma już modele
   (np. `VOICE_MODELS_FROM=https://notatki.example.pl/models`);
3. inaczej oryginalne źródła (Hugging Face / GitHub), jednorazowo.

Każdy plik jest sprawdzany SHA-256 z `ui/src/voice/models.ts`, a zła suma przerywa wgrywanie. Wdrożenie nie jest
wtedy przerywane: serwer działa dalej, a skrypt wypisuje ostrzeżenie. Ręcznie:

```bash
docker compose --env-file .env -f docker/compose.yml --profile models run --rm voice-models --from https://notatki.example.pl/models
docker compose --env-file .env -f docker/compose.yml --profile models run --rm -v "$PWD/models:/src:ro" voice-models --from /src
```

Wgrywa się model domyślny z wariantami GPU i CPU (ok. 1,8 GB). Inne zestawy: `--model all` (wszystkie modele, do
pomiarów), `--variant q4` (koder 4-bitowy), `--only-vad` (tylko detektor ciszy). Poza Dockerem jest to ten sam skrypt:
`node --experimental-strip-types scripts/fetch-voice-models.mjs --out DANE/models [--from …]`. Po odtworzeniu kopii
`notes-data` na nowym serwerze modele wgrywa się tak samo, bo nie ma ich w kopii.

`/models/*` jest dostępne bez logowania (jak reszta aplikacji), a jedno pobranie to do 1,2 GB. Za Cloudflare albo
Caddy warto ograniczyć liczbę pobrań z jednego adresu. Caddy nie kompresuje `/models/*` (pliki ONNX są już
skompresowane, a kompresja w locie psuje wznawianie przez Range).

## Uruchomienie lokalne

Domyślny Compose publikuje stronę tylko na `127.0.0.1:8080` i nie wystawia HTTP do sieci lokalnej ani Internetu. Ponieważ lokalny adres używa zwykłego HTTP, wyłącz flagę `Secure` ciasteczka tylko w tym lokalnym uruchomieniu:

```bash
AUTH_COOKIE_SECURE=false docker compose -f docker/compose.yml up -d --build notes
```

Otwórz `http://127.0.0.1:8080`. Dane węzła pozostają w wolumenie `notes-data` po odtworzeniu kontenera.

## Uruchomienie publiczne za HTTPS

Skopiuj przykładową konfigurację do `.env` w katalogu wariantu:

```bash
cp .env.example .env
```

Ustaw `SITE_ADDRESS=notes.example.org` i pozostaw `AUTH_COOKIE_SECURE=true` (wartość domyślna). Nie ustawiaj `AUTH_COOKIE_SECURE=false` dla publicznego wdrożenia.

Skieruj DNS domeny na serwer i uruchom również profil Caddy:

```bash
docker compose --profile tls -f docker/compose.yml up -d --build
```

Caddy przekazuje HTTP do węzła i obsługuje HTTPS. Frontend korzysta z same-origin API kont (`/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`). Baza kont `auth.db` i zaszyfrowany magazyn synchronizacji `browser-sync.db` znajdują się w `/data`. Klucz vaultu jest losowy, niezależny od hasła konta i odzyskiwany na nowym urządzeniu osobnym kodem. Przeglądarka szyfruje snapshot AES-GCM przed zapisem do IndexedDB i przed wysłaniem przez WebSocket; serwer przechowuje wyłącznie envelope oraz rewizję. WSS działa pod `/api/sync/ws` i jest chroniony sesją oraz kontrolą Origin.

Poza osobistym vaultem (`browser-<userId>`) węzeł obsługuje współdzielone sejfy organizacji: członków z rolami, zaproszenia, rotację klucza i chronione projekty (kontrakt: [WEB-WSPOLDZIELENIE.md](WEB-WSPOLDZIELENIE.md)). Serwer widzi tylko szyfrogramy i listę członków.

## Uruchomienie przez Cloudflare Tunnel

HTTPS zapewnia Cloudflare, więc Caddy ani otwarte porty na routerze nie są potrzebne.

1. W panelu Cloudflare: Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared). Skopiuj token.
2. W tunelu dodaj Public hostname, np. `notatki.twojadomena.pl`, z usługą `http://notes:8080`.
3. W `.env` ustaw `CLOUDFLARE_TUNNEL_TOKEN=<token>` i zostaw `AUTH_COOKIE_SECURE=true`.
4. Uruchom:

```bash
docker compose --env-file .env -f docker/compose.yml --profile cloudflare up -d --build
```

Strona działa pod `https://notatki.twojadomena.pl` z każdego komputera.

Jeśli `cloudflared` działa już na hoście jako usługa systemowa, profil `cloudflare` nie jest potrzebny. Public hostname tunelu wskazuje wtedy na `http://localhost:8080` i wystarczy uruchomić sam węzeł:

```bash
docker compose --env-file .env -f docker/compose.yml up -d --build notes
``` WebSocket `/api/sync/ws` przechodzi przez tunel bez dodatkowej konfiguracji.

## Administracja kont

Administratorem jest ten, kto ma dostęp do serwera. Polecenia działają przy uruchomionym węźle:

```bash
# lista kont: data rejestracji, email, imię i nazwisko, liczba sesji, id, sejfy z rolą
sudo docker exec notes-organizations-notes-1 /notes-node users --data /data

# podgląd: co zostanie usunięte (nic nie zmienia)
sudo docker exec notes-organizations-notes-1 /notes-node delete-user --data /data --user bot@example.com

# usunięcie konta (email albo id)
sudo docker exec notes-organizations-notes-1 /notes-node delete-user --data /data --user bot@example.com --confirm yes

# zapomniane hasło: ustawia hasło tymczasowe i wylogowuje wszędzie (notatki zostają, ich klucz to kod odzyskiwania)
sudo docker exec notes-organizations-notes-1 /notes-node reset-password --data /data --user ktos@example.com
```

Nowe konto powstaje domyślnie tylko z linku zaproszenia do organizacji albo z kodem rejestracyjnym (`NOTES_REGISTRATION=invite` w `docker/compose.yml`; `open` przywraca rejestrację dla każdego, `closed` ją wyłącza). Kod dla nowej osoby:

```bash
sudo docker exec notes-organizations-notes-1 /notes-node signup-code --data /data --label "Ola" --days 7
```

albo w panelu administratora, sekcja „Kody rejestracyjne” (`docs/PANEL-ADMINA.md`). Na świeżym serwerze pierwsze konto zakłada się właśnie z takiego kodu.

Użytkownik sam zmienia hasło i usuwa konto w Ustawieniach → Konto.

Usunięcie zabiera konto, sesje, klucze, osobisty sejf i sejfy, w których ta osoba była sama. Sejfy, do których należała, dostają flagę zmiany klucza: zrobi to następny administrator sejfu, który go otworzy. Konta, które założyło sejf z innymi członkami, nie da się usunąć. Założyciel jest częścią szyfrowania sejfu, więc najpierw trzeba usunąć z niego pozostałe osoby.

## Panel administratora

To samo co polecenia wyżej, w przeglądarce, plus zgoda na własne notatki, przydział osób do organizacji i limity plików sejfów (`docs/PANEL-ADMINA.md`). Panel ma osobny port 8081 i nigdy nie idzie przez tunel ani Caddy.

- `scripts/wdrozenie.sh` przy pierwszym wdrożeniu dopisuje do `.env` losowe `ADMIN_PASSWORD` i go nie wypisuje. Hasło jest tylko w `.env`. Bez niego kontener nie wystartuje.
- Domyślnie port jest wystawiony tylko na `127.0.0.1` (np. `ssh -L 8081:127.0.0.1:8081 <serwer>`, potem `http://127.0.0.1:8081/admin`). Żeby otworzyć panel z innego komputera w domu, ustaw w `.env` `NOTES_ADMIN_BIND` na adres Radxy w sieci lokalnej (np. `NOTES_ADMIN_BIND=192.168.1.50`) i wdroż ponownie. Nigdy `0.0.0.0` na maszynie z publicznym adresem: za Dockerem serwer może widzieć adres mostka zamiast klienta, więc sprawdzenie sieci prywatnej nie wystarczy.
- Serwer odrzuca żądania spoza sieci prywatnych, po 5 błędnych hasłach blokuje adres na 15 minut, a sesja trwa 8 godzin (do restartu kontenera). Każda zmiana trafia do logu jako `by=server-admin`.

## Czaty Claude (MCP)

Czat Claude to osobne urządzenie osoby z własnymi kluczami (docs/MCP.md). Serwer nie zna kluczy czatów ani treści.
Wyłącznik działa od razu, bez restartu, i nie dotyka pracy ludzi:

```bash
# wyłącz wszystkie czaty (każde żądanie czatu dostaje 503 „Czaty są chwilowo wyłączone przez operatora serwera.”)
sudo docker exec notes-organizations-notes-1 /notes-node agents disable --data /data
# włącz z powrotem
sudo docker exec notes-organizations-notes-1 /notes-node agents enable --data /data
# unieważnij wszystkie czaty (każdy trzeba sparować od nowa; sejfy z kluczami czatów dostają flagę zmiany klucza)
sudo docker exec notes-organizations-notes-1 /notes-node agents revoke-all --data /data --confirm yes
```

Przy znanej luce w MCP (docs/MCP.md §17): (1) `agents disable`, jeśli luka pozwala czytać lub zmieniać dane;
(2) poprawka i podpisane wydanie; (3) `NOTES_AGENT_MIN_VERSION` w `.env` podniesione do wersji z poprawką i restart;
(4) `agents enable`; (5) `agents revoke-all --confirm yes`, jeśli klucze czatów mogły wyciec; (6) informacja dla
klientów. Aplikacja pokazuje użytkownikom baner, gdy czaty są wyłączone.

## Pliki (załączniki)

Pliki są szyfrowane w przeglądarce (libsodium secretstream), a serwer przechowuje same szyfrogramy (kontrakt,
klucze, ograniczenia i wycofanie: [PLIKI.md](PLIKI.md)). Limity ustawia `.env`: `NOTES_FILE_MAX_MB` (domyślnie 100),
`NOTES_VAULT_FILES_MB` (2048, kosz i rezerwacje wliczają się), `NOTES_FILE_TRASH_DAYS` (30),
`NOTES_UPLOAD_STALE_HOURS` (24) i `NOTES_MAX_PARALLEL_UPLOADS` (4). Uzgadnianie magazynu z bazą działa przy starcie
i co godzinę.

Gdzie co leży:

- `notes-data` (`/data`): `files.db` (stany, rozmiary, zakresy, zaszyfrowane metadane z kluczem pliku) oraz
  `attachments/.part/` (przesyłania w toku),
- `seaweed-data`: usługa `seaweedfs` (SeaweedFS 4.48, obraz przypięty skrótem) z gotowymi szyfrogramami pod
  `/notes-files/<sejf>/<id>`. Usługa jest tylko w sieci `storage` (`internal: true`), bez opublikowanych portów,
  bez S3/SFTP/WebDAV, i przyjmuje wyłącznie żądania podpisane sekretem `SEAWEEDFS_JWT_KEY` z `.env`.

Bez `NOTES_SEAWEEDFS_FILER` (np. przy uruchomieniu poza Dockerem) węzeł trzyma gotowe pliki na dysku w
`/data/attachments/<sejf>/<id>`.

Magazyn można zmienić w panelu administratora (zakładka „Magazyn plików”, [PANEL-ADMINA.md](PANEL-ADMINA.md#magazyn-plików)):
migracja przenosi wszystkie pliki i zapisuje wybór w `/data/storage.json`. Ten plik ma pierwszeństwo przed
`NOTES_SEAWEEDFS_FILER`; jeśli wskazuje `seaweedfs`, a filer nie jest ustawiony, węzeł nie wystartuje. Po migracji
na dysk lokalny kopia zapasowa `seaweed-data` przestaje zawierać pliki, a `notes-data` zaczyna.

Kopia zapasowa: `files.db` i `seaweed-data` muszą pochodzić z tej samej chwili. `scripts/wdrozenie.sh` zatrzymuje obie
usługi i robi obie kopie do `~/backups` (cyklicznie: `scripts/kopia.sh`, [niżej](#kopie-zapasowe-serwera-cron)). Replikacja SeaweedFS nie jest kopią zapasową. Brakujące obiekty przy starcie
zostaną oznaczone jako `missing`; obiekty bez wpisu są tylko zgłaszane w logu, nigdy kasowane.

Ręczne uzgodnienie (przy zatrzymanym kontenerze, żeby nie wyścigać się z zapisem):

```bash
sudo docker compose --env-file .env -f docker/compose.yml stop notes
sudo docker compose --env-file .env -f docker/compose.yml run --rm --entrypoint /notes-node notes files-check --data /data
sudo docker compose --env-file .env -f docker/compose.yml start notes
```

Wynik to same liczby (`missing`, `orphans`, `parts_removed`, `parts_truncated`, `stale_uploads`, `trash_purged`).

## Kopie zapasowe serwera (cron)

`scripts/kopia.sh` kopiuje wolumeny `notes-data` i `seaweed-data` do `~/backups` (pod `sudo` katalog domowy
użytkownika, który uruchomił `sudo`). Robi to samo co `scripts/wdrozenie.sh`: zatrzymuje `notes` i `seaweedfs`,
żeby `files.db` i obiekty pochodziły z tej samej chwili, tworzy `notes-data-RRRRMMDD-GGMM.tgz` i
`seaweed-data-RRRRMMDD-GGMM.tgz` (najpierw jako `.part`, potem zmiana nazwy), uruchamia usługi ponownie, także gdy
kopia się nie uda, i zostawia tylko `KEEP` najnowszych kopii każdego rodzaju (domyślnie 14). Usuwa wyłącznie pliki
`notes-data-*.tgz` i `seaweed-data-*.tgz` z tego katalogu. Pliki kopii mają prawa 600.

```bash
cd /home/<user>/notes
sudo sh scripts/kopia.sh
sudo KEEP=30 sh scripts/kopia.sh     # 30 kopii zamiast 14 (sudo czyści środowisko, więc KEEP idzie przed sh)
```

Usługi są wyłączone na czas kopiowania (zwykle sekundy do minut, zależnie od rozmiaru załączników), dlatego
cron ustaw na noc. Kopie zawierają klucze węzła, bazy kont i szyfrogramy: trzymaj `~/backups` tylko dla
administratora.

Cron (`sudo` w crontabie użytkownika wymaga hasła, więc albo wpis w `sudo crontab -e`, wtedy kopie trafiają do
`/root/backups`, albo `NOPASSWD` dla tego polecenia; katalog logu trzeba utworzyć):

```cron
0 3 * * * cd /home/<user>/notes && sudo sh scripts/kopia.sh >> /home/<user>/backups/kopia.log 2>&1
```

Przywracanie (wybierz parę kopii z tej samej chwili, `notes-data-STAMP.tgz` i `seaweed-data-STAMP.tgz`). Polecenia
czyszczą wolumeny, więc uruchamiaj je tylko przy zatrzymanych usługach i po sprawdzeniu nazw wolumenów
(`docker volume ls`; nazwy poniżej wynikają z `name: notes-organizations` w `docker/compose.yml`):

```bash
cd /home/<user>/notes
sudo docker compose --env-file .env -f docker/compose.yml stop notes seaweedfs
for vol in notes-data seaweed-data; do
  sudo docker run --rm -v notes-organizations_$vol:/data alpine find /data -mindepth 1 -delete
done
sudo docker run --rm -v notes-organizations_notes-data:/data -v /home/<user>/backups:/b:ro alpine \
  tar xzf /b/notes-data-STAMP.tgz -C /data
sudo docker run --rm -v notes-organizations_seaweed-data:/data -v /home/<user>/backups:/b:ro alpine \
  tar xzf /b/seaweed-data-STAMP.tgz -C /data
sudo docker compose --env-file .env -f docker/compose.yml start seaweedfs notes
sudo docker compose --env-file .env -f docker/compose.yml ps
```

Przy przywracaniu klucz `SEAWEEDFS_JWT_KEY` w `.env` musi być ten sam, co w chwili kopii; inaczej `notes` nie
połączy się z magazynem plików.

## Dwa dyski (lustro)

Dane serwera (bazy kont i sejfów, zaszyfrowane migawki notatek, załączniki) mogą leżeć na dwóch dyskach naraz, np. dwóch dyskach USB podłączonych do Radxy. `scripts/lustro.sh` zakłada na nich lustro Btrfs RAID1: każdy blok jest zapisany na obu dyskach. Btrfs ma sumy kontrolne, więc uszkodzony blok czyta z drugiej kopii i go naprawia. Pojemność lustra to pojemność mniejszego dysku. Modele dyktowania zostają w wolumenie `voice-models`, bo da się je pobrać ponownie.

Założenie (oba dyski zostaną **sformatowane**):

```bash
lsblk -d -o NAME,SIZE,MODEL,TRAN          # znajdź dwa dyski USB, np. sda i sdb
sudo apt install btrfs-progs              # jeśli nie ma
sudo sh scripts/lustro.sh zaloz /dev/sda /dev/sdb
```

Skrypt odmawia, gdy dysk nie jest całym dyskiem, gdy coś na nim jest zamontowane (np. dysk systemowy) albo gdy lustro już jest. Przed formatowaniem pokazuje dyski i wymaga wpisania `SKASUJ /dev/sda /dev/sdb`. Potem:

1. formatuje oba dyski jako jedno lustro z etykietą `notes-lustro` i montuje je w `/srv/notes-lustro` (wpis w `/etc/fstab` z `nofail`, kopia poprzedniego `fstab` obok),
2. ustawia Dockera tak, żeby przy starcie systemu czekał na lustro,
3. zatrzymuje Notes i SeaweedFS, kopiuje wolumeny `notes-data` i `seaweed-data` do `/srv/notes-lustro/notes-data` i `/srv/notes-lustro/seaweed-data`, porównuje liczbę plików,
4. dopisuje do `.env` `NOTES_LUSTRO=/srv/notes-lustro` i uruchamia usługi na lustrze (`docker/compose.lustro.yml`),
5. dodaje do `/etc/cron.d/notes-lustro` comiesięczne sprawdzenie obu kopii (`btrfs scrub`) i codzienne sprawdzenie błędów dysków (wpis `notes-lustro` w logu systemowym, `journalctl -t notes-lustro`).

Stare wolumeny zostają nietknięte. Gdy serwer działa, można je usunąć poleceniem, które skrypt wypisuje na końcu. Od tej chwili `scripts/wdrozenie.sh` i `scripts/kopia.sh` same biorą dane z lustra (`scripts/dane.sh`). Ręcznie: `docker compose --env-file .env -f docker/compose.yml -f docker/compose.lustro.yml …`.

Stan lustra: `sudo sh scripts/lustro.sh stan` (dyski, zajętość, liczniki błędów, ostatni scrub).

**Lustro to nie kopia zapasowa.** Usunięcie albo zaszyfrowanie danych przez pomyłkę czy atak trafia na oba dyski naraz. `scripts/kopia.sh` dalej robi kopie do `~/backups`.

### Awaria jednego dysku

Btrfs nie montuje lustra z jednym dyskiem bez wyraźnej zgody. Serwer Notes wtedy nie startuje, zamiast po cichu działać bez drugiej kopii (`create_host_path: false` w `docker/compose.lustro.yml`). Żeby działać dalej na jednym dysku, do czasu wymiany:

```bash
sudo mount -o degraded LABEL=notes-lustro /srv/notes-lustro
sudo docker compose --env-file .env -f docker/compose.yml -f docker/compose.lustro.yml up -d seaweedfs notes
```

Wymiana na nowy dysk (np. `/dev/sdc`, co najmniej tej samej pojemności; `ID` brakującego dysku z `sudo btrfs filesystem show /srv/notes-lustro`):

```bash
sudo btrfs replace start <ID> /dev/sdc /srv/notes-lustro
sudo btrfs replace status /srv/notes-lustro      # czekaj na „finished”
sudo btrfs balance start -dconvert=raid1,soft -mconvert=raid1,soft /srv/notes-lustro   # bloki zapisane w trybie degraded wracają na oba dyski
sudo sh scripts/lustro.sh stan
```

## Porty i wolumeny

| Port | Transport | Przeznaczenie |
|---|---|---|
| 8080 | TCP | HTTP węzła i statyczna strona; domyślnie dostępne tylko lokalnie |
| 8081 | TCP | Panel administratora (`NOTES_ADMIN_BIND`, domyślnie tylko lokalnie); nigdy przez tunel |
| 80 | TCP | Caddy / walidacja certyfikatu — tylko profil `tls` |
| 443 | TCP/UDP | HTTPS/HTTP/3 przez Caddy — tylko profil `tls` |
| 7842 | UDP | QUIC `notes-node`; proces nasłuchuje wewnątrz kontenera, lecz Compose nie publikuje tego portu dla wdrożenia web-only |

Wolumen `notes-data` (`/data`) zawiera klucze węzła, bazę przechowywanych wiadomości, `auth.db` (konta i sesje) oraz `browser-sync.db` (zaszyfrowane snapshoty przeglądarki). Trzeba go uwzględnić w kopiach zapasowych i ograniczyć dostęp do kopii. `node.key`, `token`, bazy i kopie wolumenu są wrażliwe.

## Aktualizacja obrazu bez utraty vaultów

Kontener nie przechowuje trwałych danych. Compose montuje nazwany wolumen
`notes-organizations_notes-data` jako `/data`; przy odtworzeniu kontenera nowy obraz dostaje ten sam
wolumen. Przed aktualizacją zatrzymaj zapis i zrób spójną kopię:

```bash
mkdir -p backups
docker compose --env-file .env -f docker/compose.yml stop notes
docker run --rm \
  -v notes-organizations_notes-data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.20 \
  tar -czf /backup/notes-data-before-update.tar.gz -C /source .
docker compose --env-file .env -f docker/compose.yml up -d notes
```

Zbuduj obraz, a dopiero po udanym buildzie odtwórz samą usługę aplikacji:

```bash
docker compose --env-file .env -f docker/compose.yml build notes
docker compose --env-file .env -f docker/compose.yml up -d --no-deps notes
docker compose --env-file .env -f docker/compose.yml ps
docker compose --env-file .env -f docker/compose.yml logs --tail=100 notes
```

Nie używaj `docker compose down -v` ani `docker volume rm notes-organizations_notes-data`. Zwykłe
`docker compose down` usuwa kontenery i sieć, ale zachowuje nazwany wolumen. Nazwa projektu jest
ustalona w Compose jako `notes-organizations`, dlatego uruchomienie tego pliku ponownie podłącza ten
sam wolumen.

## Konfiguracja

| Zmienna | Domyślna | Znaczenie |
|---|---|---|
| `NOTES_IMAGE` | `notes-organizations-web:local` | Nazwa obrazu dla Compose |
| `NOTES_BIND` | `127.0.0.1` | Adres hosta dla portu HTTP w lokalnym profilu |
| `NOTES_HTTP_PORT` | `8080` | Port HTTP hosta |
| `SITE_ADDRESS` | `notes.example.org` z `.env.example` | Domena dla profilu Caddy `tls` |
| `AUTH_COOKIE_SECURE` | `true` | Flaga `Secure` ciasteczka sesji; `false` wyłącznie do lokalnego HTTP |
| `NOTES_FILE_MAX_MB` | `100` | Największy plik w MB (tekst jawny) |
| `NOTES_VAULT_FILES_MB` | `2048` | Limit plików na jeden sejf w MB (kosz wlicza się) |
| `NOTES_FILE_TRASH_DAYS` | `30` | Dni w koszu, po których plik jest usuwany trwale |
| `NOTES_UPLOAD_STALE_HOURS` | `24` | Godziny, po których niedokończone przesyłanie jest usuwane |
| `NOTES_AGENTS_DISABLED` | puste | `1` wyłącza wszystkie czaty Claude (jak `notes-node agents disable`) |
| `NOTES_AGENT_MIN_VERSION` | `1.0.0` | Najstarsza wersja MCP, którą serwer przyjmuje (starsza dostaje 426 i polecenie aktualizacji) |
| `NOTES_AGENT_LATEST_VERSION` | jak minimalna | Najnowsza wersja MCP podawana w `GET /api/version` |

## Aktualne ograniczenia

- Szyfrowanie w przeglądarce (WebCrypto) działa tylko na `localhost` albo przez HTTPS. Pod adresem `http://<IP>:8080` z innego komputera nie da się odblokować sejfu. Dla wielu osób na różnych komputerach potrzebny jest profil `tls` (Caddy) z domeną albo `tls internal` w sieci lokalnej.
- Odzyskiwanie zależy od kodu recovery zapisanego przez użytkownika. Utrata urządzenia i kodu oznacza utratę dostępu do danych.
- Przed publicznym wdrożeniem: test odtworzenia z kodu recovery na nowym profilu i test kopii zapasowej wolumenu `/data`.
