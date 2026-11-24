#!/usr/bin/env bash
# Two independent builds of mcp/ in clean temp dirs (docs/MCP.md §17). Fails if dist/notatki-mcp.mjs differs.
# Needs ui/src/wasm (npm run wasm in ui/) and ui/node_modules (npm ci in ui/): build.mjs bundles ui/src and resolves
# its imports there. Each build runs `npm ci --ignore-scripts` for mcp/, so it needs network or an npm cache.
set -euo pipefail

mcp="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "$mcp/.." && pwd)/ui/src"
[ -f "$src/wasm/notes_web.js" ] || { echo "Brak $src/wasm: najpierw npm run wasm w ui/" >&2; exit 2; }
[ -d "$(dirname "$src")/node_modules" ] || { echo "Brak ui/node_modules: najpierw npm ci --ignore-scripts w ui/" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

hash() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

build() { # $1: build name
  local dir="$tmp/$1"
  mkdir -p "$dir/mcp" "$dir/ui"
  # copy mcp/ without local state; build.mjs reads ../ui/src (sources and wasm-pack output)
  (cd "$mcp" && tar --exclude=./node_modules --exclude=./dist --exclude=./release -cf - .) | tar -xf - -C "$dir/mcp"
  cp -r "$src" "$dir/ui/src"
  cp "$(dirname "$src")/package.json" "$dir/ui/" # "type": "module" there decides how the bundle wraps CJS deps
  ln -s "$(dirname "$src")/node_modules" "$dir/ui/node_modules" # same resolution as the local build; not part of the output
  (cd "$dir/mcp" && npm ci --ignore-scripts --no-audit --no-fund >&2 && npm run build --silent >&2)
  hash "$dir/mcp/dist/notatki-mcp.mjs"
}

a="$(build a)"
b="$(build b)"
echo "build a: $a"
echo "build b: $b"
if [ "$a" != "$b" ]; then
  echo "BUDOWA NIEPOWTARZALNA: skróty się różnią" >&2
  exit 1
fi
echo "Budowa powtarzalna: OK"
