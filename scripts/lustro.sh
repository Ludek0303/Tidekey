#!/bin/sh
# Dane serwera Notes na dwóch dyskach naraz: lustro Btrfs RAID1 (docs/DOCKER-WEB.md "Dwa dyski (lustro)").
#   sudo sh scripts/lustro.sh zaloz /dev/sdX /dev/sdY   formatuje oba dyski, przenosi dane Notes na lustro
#   sudo sh scripts/lustro.sh stan                      stan lustra: dyski, błędy, ostatnie sprawdzenie
# Każdy blok danych leży na obu dyskach. Btrfs ma sumy kontrolne: uszkodzony blok czyta z drugiej kopii i naprawia.
set -eu
cd "$(dirname "$0")/.."
MNT=/srv/notes-lustro
LABEL=notes-lustro
COMPOSE="docker compose --env-file .env -f docker/compose.yml"

die() { echo "BŁĄD: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "uruchom przez sudo: sudo sh scripts/lustro.sh ${1:-stan}"
for tool in btrfs mkfs.btrfs wipefs lsblk findmnt blkid systemd-escape; do
  command -v "$tool" >/dev/null || die "brak programu $tool. Zainstaluj: sudo apt install btrfs-progs util-linux"
done

stan() {
  if ! findmnt -n "$MNT" >/dev/null; then
    echo "Lustro NIE jest zamontowane w $MNT. Serwer Notes nie wystartuje (tak ma być: nie zacznie pusty)."
    echo "Dyski z etykietą $LABEL:"; blkid -t LABEL="$LABEL" -o device || true
    echo "Gdy brakuje jednego dysku: docs/DOCKER-WEB.md \"Awaria jednego dysku\"."
    exit 1
  fi
  btrfs filesystem show "$MNT"
  btrfs filesystem usage -T "$MNT" | sed -n '1,12p'
  echo "--- błędy odczytu/zapisu/sum kontrolnych (powinny być zera):"
  btrfs device stats "$MNT"
  echo "--- ostatnie sprawdzenie (scrub):"
  btrfs scrub status "$MNT" || true
}

zaloz() {
  [ $# -eq 2 ] || die "podaj dwa dyski, np.: sudo sh scripts/lustro.sh zaloz /dev/sda /dev/sdb (lista: lsblk -d -o NAME,SIZE,MODEL,TRAN)"
  A=$1 B=$2
  [ "$A" != "$B" ] || die "to ten sam dysk dwa razy: $A"
  ! grep -q '^NOTES_LUSTRO=' .env 2>/dev/null || die "lustro jest już ustawione w .env (NOTES_LUSTRO). Stan: sudo sh scripts/lustro.sh stan"
  findmnt -n "$MNT" >/dev/null && die "w $MNT jest już coś zamontowane"
  for d in "$A" "$B"; do
    [ -b "$d" ] || die "$d nie jest urządzeniem blokowym"
    [ "$(lsblk -dno TYPE "$d")" = disk ] || die "$d nie jest całym dyskiem (podaj np. /dev/sda, nie /dev/sda1)"
    # a disk with anything mounted (the system disk, a USB drive in use) is never touched
    if lsblk -nro MOUNTPOINT "$d" | grep -q .; then die "na $d jest coś zamontowane: $(lsblk -nro MOUNTPOINT "$d" | tr '\n' ' ')"; fi
  done
  lsblk -o NAME,SIZE,MODEL,TRAN,FSTYPE,LABEL "$A" "$B"
  echo
  echo "WSZYSTKO na $A i $B zostanie skasowane. Lustro ma pojemność mniejszego z dysków."
  printf 'Aby kontynuować, wpisz dokładnie: SKASUJ %s %s\n> ' "$A" "$B"
  read -r answer
  [ "$answer" = "SKASUJ $A $B" ] || die "przerwano, nic nie zmieniono"

  VOLUME=$(docker volume ls -q | grep 'notes-data$' | head -n1 || true)
  SEAWEED=$(docker volume ls -q | grep 'seaweed-data$' | head -n1 || true)

  wipefs -a "$A" "$B" >/dev/null
  mkfs.btrfs -f -L "$LABEL" -m raid1 -d raid1 "$A" "$B" >/dev/null
  btrfs device scan >/dev/null
  UUID=$(blkid -s UUID -o value "$A")
  [ -n "$UUID" ] || die "nie odczytano UUID nowego lustra"
  mkdir -p "$MNT"
  STAMP=$(date +%Y%m%d-%H%M)
  cp /etc/fstab "/etc/fstab.przed-lustrem-$STAMP"
  # nofail: a missing USB disk never stops the boot; the Notes services then do not start (compose.lustro.yml)
  printf 'UUID=%s %s btrfs defaults,noatime,nofail,x-systemd.device-timeout=30s 0 0\n' "$UUID" "$MNT" >> /etc/fstab
  systemctl daemon-reload
  mount "$MNT"
  findmnt -n "$MNT" >/dev/null || die "lustro nie zamontowało się w $MNT (fstab ma kopię: /etc/fstab.przed-lustrem-$STAMP)"

  # Docker waits for the mirror at boot, so containers never start before the disks are mounted
  UNIT=$(systemd-escape -p --suffix=mount "$MNT")
  mkdir -p /etc/systemd/system/docker.service.d
  printf '[Unit]\nWants=%s\nAfter=%s\n' "$UNIT" "$UNIT" > /etc/systemd/system/docker.service.d/notes-lustro.conf
  systemctl daemon-reload

  # a scrub every month reads both copies and repairs the bad one; the daily check logs disk errors to the system log
  cat > /etc/cron.d/notes-lustro <<EOF
# scripts/lustro.sh: sprawdzanie lustra danych Notes
0 3 1 * * root btrfs scrub start -B -q $MNT || logger -t notes-lustro "scrub lustra $MNT nie powiódł się"
30 6 * * * root btrfs device stats --check $MNT >/dev/null || logger -t notes-lustro "błędy dysku w lustrze $MNT: sudo sh scripts/lustro.sh stan"
EOF

  # the data moves while the services are stopped; whatever happens, they come back (on the old volumes if not done)
  trap '$COMPOSE start seaweedfs notes >/dev/null 2>&1 || true' EXIT
  $COMPOSE stop notes seaweedfs >/dev/null 2>&1 || true
  mkdir -p "$MNT/notes-data" "$MNT/seaweed-data"
  # the image's /data belongs to the nonroot user (65532); SeaweedFS runs as 1000 (docker/compose.yml)
  chown 65532:65532 "$MNT/notes-data"
  chown 1000:1000 "$MNT/seaweed-data"
  copy() { # volume, folder on the mirror
    docker run --rm -v "$1":/from:ro -v "$2":/to alpine sh -c 'cp -a /from/. /to/'
    n_from=$(docker run --rm -v "$1":/d:ro alpine sh -c 'find /d | wc -l')
    n_to=$(docker run --rm -v "$2":/d:ro alpine sh -c 'find /d | wc -l')
    [ "$n_from" = "$n_to" ] || die "kopia $1 jest niepełna ($n_from → $n_to plików); dane zostały w wolumenie, .env bez zmian"
    echo "Przeniesiono $1 → $2 ($n_to plików)"
  }
  [ -n "$VOLUME" ] && copy "$VOLUME" "$MNT/notes-data"
  [ -n "$SEAWEED" ] && copy "$SEAWEED" "$MNT/seaweed-data"

  printf '\n# dane Notes na lustrze Btrfs RAID1 (scripts/lustro.sh)\nNOTES_LUSTRO=%s\n' "$MNT" >> .env
  trap - EXIT
  $COMPOSE -f docker/compose.lustro.yml up -d --no-build seaweedfs notes
  sleep 8
  curl -s http://127.0.0.1:8080/health && echo " <- serwer działa na lustrze"
  echo
  stan
  echo
  echo "Gotowe. Stare wolumeny Dockera zostały nietknięte ($VOLUME ${SEAWEED:-}). Gdy wszystko działa, możesz je usunąć:"
  echo "  sudo docker volume rm $VOLUME ${SEAWEED:-}"
  echo "Lustro to nie kopia zapasowa: scripts/kopia.sh dalej robi kopie do ~/backups."
}

case "${1:-}" in
  zaloz) shift; zaloz "$@" ;;
  stan) stan ;;
  *) die "użycie: sudo sh scripts/lustro.sh zaloz /dev/sdX /dev/sdY | stan" ;;
esac
