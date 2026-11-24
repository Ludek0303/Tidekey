# Kontener Docker — serwer dla wersji webowej, Linuxa i Windowsa

Jeden obraz `notes-node` uruchamiany na VPS albo w domu. Z nim łączą się wszystkie trzy wersje aplikacji. Uzupełnia [ARCHITEKTURA.md](ARCHITEKTURA.md) §4.18 (węzeł), [WEB.md](WEB.md) i [SIEC.md](SIEC.md) §5–6.

---

## 1. Co jest w kontenerze, a co nie

```text
                       ┌──────────────── docker compose ────────────────┐
 przeglądarka ─https──▶│ caddy :443/tcp ──▶ notes-node :8080 (HTTP/WS)  │
   (web)       wss     │  (TLS, Let's Encrypt)   ├─ pliki wersji webowej │
                       │                         ├─ WebSocket notes-sync/1
 Linux / Windows ─QUIC─┼────────────────────────▶└─ QUIC :7842/udp       │
   (Tauri)             │                     wolumen /data (szyfrogramy)│
                       └────────────────────────────────────────────────┘
```

| W kontenerze | Poza kontenerem |
|---|---|
| `notes-node`: przechowywanie i przekazywanie zaszyfrowanych wiadomości, migawki, załączniki, prośby o dołączenie (ARCHITEKTURA §4.18) | **aplikacje desktopowe** — to programy z oknem instalowane na komputerze (`.deb`/AppImage, `.msi`), nie usługi; budowane w CI (§5) |
| statyczne pliki wersji webowej (HTML, JS, WASM) — strona ładuje się z własnego serwera (WEB §4) | klucze przestrzeni, frazy, hasła — **nigdy** nie trafiają do obrazu ani na serwer |
| Caddy: HTTPS i automatyczny certyfikat (przeglądarka wymaga `wss://`) | klucz podpisujący wydania webowe — tylko w CI |

## 2. Obraz `notes-node` — budowa wieloetapowa

```text
etap 1  rust:<wersja>          cargo build --release -p notes-node            → /notes-node
etap 2  rust + wasm-pack       core + sync → WASM (wasm32-unknown-unknown)    → pkg/
etap 3  node:<wersja>          ui/: npm ci && vite build (z pkg/ z etapu 2)    → dist/
etap 4  gcr.io/distroless/cc   tylko /notes-node + /web (dist/)               → obraz końcowy
```

- **Obraz końcowy bez powłoki i menedżera pakietów** (distroless) — mała powierzchnia ataku, ~30–50 MB.
- Uruchamiany jako **użytkownik bez uprawnień** (`nonroot`), system plików tylko do odczytu, jedyny zapisywalny katalog to wolumen `/data`.
- Wersje obrazów bazowych przypięte skrótem (`@sha256:…`); aktualizuje je Dependabot.
- Obraz na `linux/amd64` i `linux/arm64` (VPS i Raspberry Pi) przez `docker buildx`.
- Zdrowie: `notes-node health` jako `HEALTHCHECK`.

## 3. `docker compose` — wdrożenie

Pliki w repozytorium: `docker/Dockerfile`, `docker/compose.yml`, `docker/Caddyfile`, `docker/.env.example`.

```yaml
# docker/compose.yml (szkic)
services:
  node:
    image: ghcr.io/<konto>/notes-node:<wersja>
    command: ["serve", "--data", "/data", "--http", "0.0.0.0:8080", "--quic", "0.0.0.0:7842"]
    volumes: ["node-data:/data"]
    ports: ["7842:7842/udp"]          # QUIC dla aplikacji desktopowych
    read_only: true
    restart: unless-stopped
  caddy:
    image: caddy:<wersja>
    ports: ["80:80", "443:443"]       # HTTPS dla przeglądarki + wss://
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"]
    restart: unless-stopped
volumes: { node-data: {}, caddy-data: {} }
```

Uruchomienie na serwerze:

```bash
cp .env.example .env              # DOMENA=notes.example.com (może być darmowa subdomena, np. DuckDNS)
docker compose up -d
docker compose exec node notes-node init   # wypisuje bilet węzła → w aplikacji „Dodaj węzeł”
```

| Port | Kto | Po co |
|---|---|---|
| 443/tcp | przeglądarka | strona + `wss://` (synchronizacja w wersji webowej); zapas dla desktopu, gdy UDP jest zablokowane |
| 80/tcp | Let's Encrypt | wydanie certyfikatu |
| 7842/udp | Linux, Windows | QUIC (iroh) — szybsza droga dla aplikacji desktopowych [decyzja: numer portu] |

`serve --max-conns N` (domyślnie 256) ogranicza liczbę równoczesnych połączeń QUIC; limit per adres IP to przyszła praca, a dziś atakujący z wieloma nowymi kluczami może zająć wszystkie miejsca na kilkadziesiąt sekund.

**Kopia zapasowa serwera** = kopia wolumenu `node-data`. Zawiera wyłącznie szyfrogramy (SZYFROWANIE §4), więc można ją trzymać gdziekolwiek.

## 4. Kontener testowy — wspólna sieć dla testów

`docker/compose.test.yml` stawia węzeł i dwóch-trzech **klientów bez okna** (ten sam `core` + `sync`, mały program testowy) w osobnych sieciach Dockera:

```text
 sieć „biuro”:  klient-A ◀── LAN ──▶ klient-B
                    │                   │
 sieć „internet”:   └──▶ węzeł ◀───────┘◀── klient-C (sieć „dom”)
```

Na nim działają testy etapu 4 i 5 z PLAN-BUDOWY: zbieżność, LAN bez serwera, różne sieci przez węzeł, wyłączenie węzła w trakcie, brak jawnej treści w `/data`. Uruchomienie: `docker compose -f docker/compose.test.yml run --rm tests`. Z tego samego polecenia korzysta pętla agentów (`/buduj`, §6).

## 5. Aplikacje na Linux i Windows — budowa w CI, nie w kontenerze

| Cel | Gdzie się buduje | Wynik |
|---|---|---|
| Linux | GitHub Actions `ubuntu-latest` (opcjonalnie w kontenerze budującym dla powtarzalności) | `.deb`, AppImage |
| Windows | GitHub Actions `windows-latest` — kompilacja Tauri na Windows z Linuxa jest eksperymentalna, więc natywny runner | `.msi` |
| Web | etap 2–3 obrazu z §2 | pliki w obrazie `notes-node` + podpis wydania |
| Serwer | `docker buildx` | `ghcr.io/<konto>/notes-node` (amd64, arm64) |

Jedno wydanie (tag `v*`) buduje wszystkie cztery naraz z tego samego commita, więc wersje klientów i serwera zawsze do siebie pasują. Protokół ma numer (`notes-sync/1`) — serwer odrzuca niezgodnego klienta z czytelnym komunikatem „zaktualizuj aplikację”.

## 6. Kiedy co powstaje

| Etap (PLAN-BUDOWY) | Docker |
|---|---|
| 2 | — (CI już sprawdza kompilację `core` do WASM) |
| 4 | `Dockerfile` (etap 1 + 4), `compose.yml` z samym węzłem i QUIC, `compose.test.yml` z klientami testowymi |
| 5 | etapy 2–3 obrazu (WASM + UI), Caddy, `wss://`, podpisane wydanie webowe |
| 6 | `buildx` amd64/arm64, publikacja w ghcr.io, wydanie z tagu budujące wszystkie cele |

## 7. Testy kontenera

- obraz startuje jako `nonroot` z `read_only: true` i przechodzi `HEALTHCHECK`;
- przeglądarka (Playwright) i dwa klienty desktopowe bez okna piszą jednocześnie przez kontener → identyczny tekst;
- `grep` po surowych plikach w wolumenie `/data` nie znajduje treści ani nazw notatek;
- `docker compose down && up` → nic nie ginie;
- skaner obrazu (`trivy`) bez krytycznych podatności.
