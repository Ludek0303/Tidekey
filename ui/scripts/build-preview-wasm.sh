#!/usr/bin/env bash
# Builds the preview parsers (crates/preview) for the preview frame: one module without DWG (video keyframes, .doc,
# .ppt) and one with it, because acadrust is most of the size and only a DWG needs it (docs/PODGLAD-PLAN.md §4.5).
set -euo pipefail

cd "$(dirname "$0")/.."
wasm-pack build ../crates/preview --target web --out-dir ../../ui/preview/wasm --release -- --no-default-features
wasm-pack build ../crates/preview --target web --out-dir ../../ui/preview/wasm-dwg --out-name notes_preview_dwg --release
