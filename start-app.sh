#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
exec cargo run --manifest-path app/src-tauri/Cargo.toml
