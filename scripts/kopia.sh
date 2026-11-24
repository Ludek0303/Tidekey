#!/bin/sh
# Kopia serwera (cron): zatrzymuje notes i seaweedfs, kopiuje ich wolumeny do ~/backups, uruchamia usługi ponownie
# i zostawia KEEP ostatnich kopii. Uruchom: sudo sh scripts/kopia.sh   (KEEP=14 domyślnie)
set -eu
cd "$(dirname "$0")/.."
KEEP="${KEEP:-14}"
case "$KEEP" in ''|*[!0-9]*) echo "KEEP musi być liczbą: $KEEP"; exit 1 ;; esac
umask 077
. scripts/dane.sh
# under sudo $HOME is root's: keep the copies in the calling user's ~/backups
BACKUPS="$(getent passwd "${SUDO_USER:-${USER:-root}}" | cut -d: -f6)/backups"
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$BACKUPS"

# always bring the services back, also when a copy fails halfway
restart() {
  $COMPOSE start seaweedfs notes >/dev/null
  echo "Usługi uruchomione ponownie."
}
trap restart EXIT

# stop both, so the two copies are consistent with each other (files.db ↔ objects), as scripts/wdrozenie.sh does
$COMPOSE stop notes
[ -n "$SEAWEED" ] && $COMPOSE stop seaweedfs

# the copy is written as .part and renamed only when tar has finished, so a broken copy never looks complete
copy() { # volume, name prefix
  docker run --rm -v "$1":/data:ro -v "$BACKUPS":/b alpine tar czf "/b/$2-$STAMP.tgz.part" -C /data .
  chmod 600 "$BACKUPS/$2-$STAMP.tgz.part"
  mv "$BACKUPS/$2-$STAMP.tgz.part" "$BACKUPS/$2-$STAMP.tgz"
  echo "Kopia: $BACKUPS/$2-$STAMP.tgz (wolumen $1)"
}
copy "$VOLUME" notes-data
[ -n "$SEAWEED" ] && copy "$SEAWEED" seaweed-data

restart
trap - EXIT

# keep the newest KEEP copies of each kind; names carry YYYYMMDD-HHMM, so sorting by name sorts by time
prune() { # name prefix
  ls -1 "$BACKUPS" | grep -E "^$1-[0-9]{8}-[0-9]{4}\.tgz$" | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f -- "$BACKUPS/$old"
    echo "Usunięto starą kopię: $old"
  done
}
prune notes-data
prune seaweed-data
echo "Gotowe. Zostawiono do $KEEP kopii każdego rodzaju w $BACKUPS."
