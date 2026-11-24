#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/ui"
export PATH="$HOME/.cargo/bin:$PATH"
if [ ! -d node_modules ]; then npm ci; fi
if [ ! -f src/wasm/notes_web.js ]; then npm run wasm; fi
exec npm run dev
