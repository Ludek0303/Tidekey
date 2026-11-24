# Sourced by scripts/wdrozenie.sh and scripts/kopia.sh: where the Notes data lives and how compose is called.
# With NOTES_LUSTRO in .env (scripts/lustro.sh) the data sits in folders on the two-disk mirror, else in Docker volumes.
COMPOSE="docker compose --env-file .env -f docker/compose.yml"
LUSTRO=$(grep -s '^NOTES_LUSTRO=' .env | tail -n1 | cut -d= -f2-)
if [ -n "$LUSTRO" ]; then
  COMPOSE="$COMPOSE -f docker/compose.lustro.yml"
  VOLUME="$LUSTRO/notes-data"
  SEAWEED="$LUSTRO/seaweed-data"
  [ -d "$VOLUME" ] || { echo "Lustro $LUSTRO nie jest zamontowane (brak $VOLUME). Sprawdź: sudo sh scripts/lustro.sh stan"; exit 1; }
else
  VOLUME=$(docker volume ls -q | grep 'notes-data$' | head -n1)
  [ -n "$VOLUME" ] || { echo "Nie znaleziono wolumenu *notes-data. Sprawdź: docker volume ls"; exit 1; }
  SEAWEED=$(docker volume ls -q | grep 'seaweed-data$' | head -n1 || true)
fi
