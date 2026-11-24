#!/usr/bin/env bash
# Builds the first public repository from a clean state: the files git tracks in REF (default: main), without
# history, as one commit with the author's GitHub "noreply" address (docs/LICENCJE.md, "Przed upublicznieniem").
# Nothing is pushed: the last lines print the commands to do that yourself.
#
#   bash scripts/nowe-repozytorium.sh <empty folder> "<Name Surname>" <id+login@users.noreply.github.com> [REF]
#
# PRIVATE_WORDS="word1|word2" (environment, never stored): extra strings that must not appear in any file, e.g. your
# server's domain or user name; the check stops on a match. Needs git; uses gitleaks and reuse when installed.
set -euo pipefail

OUT=${1:?podaj pusty katalog docelowy}
NAME=${2:?podaj imię i nazwisko autora}
EMAIL=${3:?podaj adres noreply z GitHuba (Settings → Emails)}
REF=${4:-main}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Local files that stay out of the public repository: Claude Code's personal settings and permissions.
PRIVATE=(.claude/settings.json .claude/proven-config.json .claude/.proven-config-version)

case "$EMAIL" in
  *@users.noreply.github.com) ;;
  *) echo "Adres $EMAIL nie jest adresem noreply GitHuba (…@users.noreply.github.com); przerywam." >&2; exit 1 ;;
esac
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "Katalog $OUT nie jest pusty; przerywam." >&2
  exit 1
fi
git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}" >/dev/null || { echo "Nie ma gałęzi ani commita $REF." >&2; exit 1; }

mkdir -p "$OUT"
# only what git tracks in REF: no untracked files, no build output, no .env
git -C "$ROOT" archive --format=tar "$REF" | tar -x -C "$OUT"
for f in "${PRIVATE[@]}"; do rm -f "$OUT/$f"; done
echo "Pliki z $REF: $(find "$OUT" -type f | wc -l)"

# checks on the new tree before anything is committed
fail=0
if find "$OUT" -name '.env' -o -name '.env.*' | grep -v '\.env\.example$' | grep -q .; then
  echo "Znaleziono plik .env:" >&2; find "$OUT" -name '.env' -o -name '.env.*' | grep -v '\.env\.example$' >&2; fail=1
fi
# this machine's user name and home folder, the e-mail of your git config, and Tailscale host names (read here, never
# stored in the script)
OWN="/home/$(id -un)/|$(printf '%s' "$HOME" | sed 's/[.[\*^$()+?{|]/\\&/g')/|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net"
MAIL=$(git -C "$ROOT" config user.email || true)
[ -n "$MAIL" ] && OWN="$OWN|$(printf '%s' "$MAIL" | sed 's/[.[\*^$()+?{|]/\\&/g')"
if grep -rInE "$OWN" "$OUT" | grep -q .; then
  echo "Twoje dane (użytkownik, katalog domowy, e-mail z git) albo nazwa hosta Tailscale:" >&2
  grep -rlE "$OWN" "$OUT" | head -20 >&2; fail=1
fi
if [ -n "${PRIVATE_WORDS:-}" ] && grep -rInE -i "$PRIVATE_WORDS" "$OUT" | grep -q .; then
  echo "Znaleziono słowa z PRIVATE_WORDS:" >&2; grep -rlE -i "$PRIVATE_WORDS" "$OUT" | head -20 >&2; fail=1
fi
if command -v gitleaks >/dev/null; then
  gitleaks dir --no-banner --redact -c "$OUT/.gitleaks.toml" "$OUT" || fail=1
else
  echo "gitleaks nie jest zainstalowany: skan sekretów pominięty (zrobi go CI po wypchnięciu)."
fi
if command -v reuse >/dev/null; then
  (cd "$OUT" && reuse lint >/dev/null) || { echo "reuse lint nie przechodzi." >&2; fail=1; }
fi
if [ "$fail" -ne 0 ]; then
  echo "Przerwane: popraw powyższe w $REF i uruchom skrypt ponownie (katalog $OUT zostaje do wglądu, bez commita)." >&2
  exit 1
fi

git -C "$OUT" init -q -b main
git -C "$OUT" -c user.name="$NAME" -c user.email="$EMAIL" add -A
git -C "$OUT" -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "Pierwsza wersja publiczna"
# future commits in this repository use the same identity
git -C "$OUT" config user.name "$NAME"
git -C "$OUT" config user.email "$EMAIL"
git -C "$OUT" log --format='Commit %h, autor: %an <%ae>' -1
cat <<EOF

Gotowe: $OUT (jeden commit, bez historii). Sprawdź pliki, potem:
  cd "$OUT"
  git remote add origin https://github.com/<login>/<repozytorium>.git
  git push -u origin main
Potem w ustawieniach repozytorium: Security → Private vulnerability reporting, ochrona gałęzi main,
i NOTES_SOURCE_URL w .env serwera (docs/DOCKER-WEB.md).
EOF
