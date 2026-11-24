#!/usr/bin/env bash
# Builds the formula engine (crates/web) into ui/src/wasm for the browser UI.
set -euo pipefail

cd "$(dirname "$0")/.."
wasm-pack build ../crates/web --target web --out-dir ../../ui/src/wasm --release
