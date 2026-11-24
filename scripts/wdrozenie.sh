#!/bin/sh
# Wdrożenie: najpierw budowa nowego obrazu (stary serwer działa dalej), potem kopia wolumenów z danymi i przełączenie na nowy. Uruchom: sudo sh scripts/wdrozenie.sh
set -e
cd "$(dirname "$0")/.."
. scripts/dane.sh
# under sudo $HOME is root's: keep the copies in the calling user's ~/backups
BACKUPS="$(getent passwd "${SUDO_USER:-$USER}" | cut -d: -f6)/backups"
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$BACKUPS"
# the file store's signing key: generated once, kept only in .env (never printed)
if ! grep -q '^SEAWEEDFS_JWT_KEY=.\+' .env 2>/dev/null; then
  printf '\nSEAWEEDFS_JWT_KEY=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" >> .env
  echo "Dodano SEAWEEDFS_JWT_KEY do .env"
fi
# the admin panel's password: generated once, kept only in .env (never printed)
if ! grep -q '^ADMIN_PASSWORD=.\+' .env 2>/dev/null; then
  printf '\nADMIN_PASSWORD=%s\n' "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')" >> .env
  echo "Dodano ADMIN_PASSWORD do .env"
fi
echo "Hasło panelu administratora: zobacz ADMIN_PASSWORD w .env"
# the commit and the public repository of this build: "O programie" links to its source (docs/LICENCJE.md §1)
NOTES_COMMIT=$(git -c safe.directory="$PWD" rev-parse HEAD 2>/dev/null || true) # under sudo the checkout belongs to another user
export NOTES_COMMIT
if ! grep -q '^NOTES_SOURCE_URL=.\+' .env 2>/dev/null; then
  echo "Uwaga: brak NOTES_SOURCE_URL w .env: \"O programie\" nie pokaże linku do kodu źródłowego (docs/DOCKER-WEB.md)."
fi
# build while the old container still serves; a failed build stops here and leaves it running
$COMPOSE build notes
# speech models into their own volume, while the old server still runs (docs/DOCKER-WEB.md "Modele dyktowania"):
# from ./models when it was copied here, else from VOICE_MODELS_FROM in .env (another Notes server), else upstream once
if [ -d models ]; then
  set -- -v "$PWD/models:/src:ro" voice-models --from /src
else
  set -- voice-models
fi
$COMPOSE --profile models run --rm "$@" \
  || echo "UWAGA: modele dyktowania nie zostały wgrane; serwer działa, ale dyktowanie pokaże błąd. Ponów: sudo sh scripts/wdrozenie.sh"
# stop both, so the two copies are consistent with each other (files.db ↔ objects)
$COMPOSE stop notes
[ -n "$SEAWEED" ] && $COMPOSE stop seaweedfs
docker run --rm -v "$VOLUME":/data:ro -v "$BACKUPS":/b alpine tar czf "/b/notes-data-$STAMP.tgz" -C /data .
echo "Kopia danych: $BACKUPS/notes-data-$STAMP.tgz (wolumen $VOLUME)"
if [ -n "$SEAWEED" ]; then
  docker run --rm -v "$SEAWEED":/data:ro -v "$BACKUPS":/b alpine tar czf "/b/seaweed-data-$STAMP.tgz" -C /data .
  echo "Kopia magazynu plików: $BACKUPS/seaweed-data-$STAMP.tgz (wolumen $SEAWEED)"
fi
cp docker/compose.yml "$BACKUPS/compose-$STAMP.yml"
$COMPOSE up -d --no-build seaweedfs notes
sleep 8
$COMPOSE ps seaweedfs notes
curl -s http://127.0.0.1:8080/health && echo " <- serwer działa"
echo "Panel administratora: http://<adres-w-sieci-lokalnej>:${NOTES_ADMIN_PORT:-8081}/admin — z innych komputerów działa po ustawieniu w .env NOTES_ADMIN_BIND na adres tego komputera w sieci lokalnej (np. NOTES_ADMIN_BIND=192.168.1.50), potem ponownie: sudo sh scripts/wdrozenie.sh"
