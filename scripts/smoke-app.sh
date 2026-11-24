#!/usr/bin/env bash
# Opens the real desktop window once and checks that its page loaded the WASM module (the window's CSP must allow
# it; a browser test cannot see that). Exit 0: the window reported success. Uses a fresh config folder, so no space
# of the user is opened. Needs a display, or xvfb-run when there is none.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

(cd ui && npm run build >/dev/null)
cargo build --manifest-path app/src-tauri/Cargo.toml --features tauri/custom-protocol >/dev/null
bin="${CARGO_TARGET_DIR:-app/src-tauri/target}/debug/notes-app"

run=()
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  if command -v xvfb-run >/dev/null; then run=(xvfb-run -a); else echo "smoke: no display and no xvfb-run" >&2; exit 2; fi
fi

home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
out="$(NOTES_SMOKE=1 XDG_CONFIG_HOME="$home/config" XDG_DATA_HOME="$home/data" XDG_CACHE_HOME="$home/cache" \
  timeout 120 "${run[@]}" "$bin" 2>&1)" && code=0 || code=$?
echo "$out" | grep '^SMOKE' || echo "smoke: the window reported nothing (exit $code)"
exit "$code"
