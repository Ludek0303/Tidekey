# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Local-first, Obsidian-style Markdown notes app (`.md` files, `[[wikilinks]]`, graph, tags, live preview) with a Rust core, a TypeScript UI, a Tauri 2 desktop shell, and a `notes-node` server for the web variant. Docs, UI strings and the README are in Polish; code and code comments are in English.


## Commands

Requirements: Node 22, Rust via `rustup`, `wasm-pack` (`cargo install wasm-pack --locked`). Scripts expect `~/.cargo/bin` on `PATH`.

```bash
# Rust (root workspace: core, sync, web, node, bridge)
cargo test --workspace
cargo test -p notes-core space_tests          # one crate, tests filtered by name
cargo clippy --workspace -- -D warnings
cargo check -p notes-core --target wasm32-unknown-unknown   # core must stay wasm-compatible

# UI (run in ui/)
npm ci
npm run wasm        # wasm-pack builds crates/web into ui/src/wasm (gitignored)
npm run dev         # vite on port 5174 (strict); ./start-web.sh does npm ci + wasm + dev
npm test            # pretest rebuilds WASM, then vitest run
npx vitest run src/editor.test.ts   # one test file (needs ui/src/wasm already built)
npm run build       # wasm + tsc --noEmit + vite build

# Desktop app: not a workspace member (needs WebKit), its own Cargo workspace
cargo run --manifest-path app/src-tauri/Cargo.toml      # or ./start-app.sh
scripts/smoke-app.sh   # builds UI + app, opens the real window once and checks WASM loaded (needs a display or xvfb-run)

# Web variant in Docker (see docs/DOCKER-WEB.md)
docker compose -f docker/compose.yml build notes
```

Browser UI URLs: `?demo=1` uses the in-memory `MockBridge` (no login), `?big=10000` generates 10,000 mock notes for a performance check. Without `demo`, the browser build asks to log in against `notes-node`. Without built WASM the editor still runs, but formulas and the link index are off.

`scripts/test-organizations.cjs` is a Playwright check of the organization views against the browser demo (`PLAYWRIGHT_PATH=... node scripts/test-organizations.cjs`). It writes screenshots to `docs/organization-checks/`.

## Architecture

Crate layering, bottom to top:

- `crates/core` (`notes-core`): the data model. Each edit is a signed and encrypted message (XChaCha20-Poly1305 + Ed25519) appended to a space's log. Opening a space verifies and replays the log. Note content is a Yrs CRDT document, and the `.md` file on disk is a projection of it, written atomically (temp file, fsync, rename; retried on Windows file locks). Also holds the index (links, backlinks, tags, headings, tasks), the table formula engine (`formula/`), the calendar with RRULE (`calendar/`), Markdown rendering, the trash and version history. Must compile for `wasm32-unknown-unknown`.
- `crates/sync` (`notes-sync`): identity, BIP39 recovery, device certificates, ACLs, invites, keystore, and the P2P protocol. Transport (iroh, tokio) sits behind the `net` feature, and the OS keyring behind `os-keyring`, so the browser build stays transport-free.
- `crates/bridge` (`notes-bridge`): the backend the desktop app calls. It wraps core + sync with a file watcher (`notify`), search (SQLite), attachments, change tracking, and organization records.
- `crates/web` (`notes-web`): wasm-bindgen exports of core (formulas, render, index, calendar) for the UI.
- `crates/node` (`notes-node`): a storage/relay node and web backend. For the browser variant it also handles accounts (`auth.rs`), shared vaults with roles and invites (`vaults.rs`), and encrypted snapshot sync over WebSocket (`websync.rs`). The contract between server and client is `docs/WEB-WSPOLDZIELENIE.md`; change both sides together (axum + iroh). Its CLI commands are `init`, `ticket`, `serve`, `health`. It serves the built UI from `--web DIR`. The Docker image is distroless and runs this binary.
- `app/src-tauri` (`notes-app`): Tauri 2 commands over `notes-bridge`. Its CSP has to allow `wasm-unsafe-eval`. Check CSP changes with `smoke-app.sh`, because browser tests can't catch them.

UI (`ui/src`, plain TypeScript, no framework; CodeMirror 6 + Yjs; graph layout runs in a Web Worker and draws on `<canvas>`):

- `bridge.ts` defines the `Bridge` interface (`call(cmd, args)` / `on(event)`), the only channel between the UI and the backend. `tauribridge.ts`'s `chooseBridge` picks the implementation: `MockBridge` (tests, `?demo=1`, `?big=`), the authenticated browser bridge (`browserauth.ts`, talking to `notes-node`), or `TauriBridge`. Note bytes cross the bridge as Yjs v1 updates. At the Tauri IPC edge, `Uint8Array` has to be converted to and from `number[]`.
- Browser variant: `browserauth.ts` (login, recovery-code personal key, `BrowserBridge` = one vault synced as an AES-GCM snapshot, merged with tombstones and last-writer-wins paths), `vaults.ts` (vault list, keys wrapped per member, invite links carrying the key in `#k=`, members and roles UI), `signing.ts` (ECDSA P-256 signatures on organization events, "niezweryfikowane" badges), `notifications.ts`.
- Local e2e for the browser variant: `cargo build -p notes-node`, `npx vite build --outDir <dir>`, then `notes-node init --data D` and `AUTH_COOKIE_SECURE=false NOTES_REGISTRATION=open notes-node serve --data D --http 127.0.0.1:8090 --quic 127.0.0.1:0 --web <dir> --relay off`. Without `NOTES_REGISTRATION=open`, sign-up needs an invite link or a code from `notes-node signup-code --data D`.
- Building WASM on this machine needs a clang for wasm32. There's no system clang, so set `CC_wasm32_unknown_unknown=~/.local/lib/zigcc/clang AR_wasm32_unknown_unknown=~/.local/lib/zigcc/llvm-ar` (zig-based wrappers).
- When you add a backend command, implement it in every bridge: the mock in `bridge.ts`, the Tauri command in `app/src-tauri/src/commands.rs` (and related files), and the node side where relevant.
- `main.ts` wires everything together. Modules talk to each other through `bus.ts` events. Tests (`*.test.ts`) sit next to their sources and run in jsdom.
- Spaces have a kind (`space_kind`). The "organization" kind adds tasks, people, projects and records (`org*.ts`, `taskhistory.ts`, `records.ts`; `docs/ORGANIZACJA.md`). Task metadata is stored as inline tokens on Markdown list lines (`@person`, `📅 date`, `!nadzor:@x`, `!trudnosc:n`, `^z-id`). Calendar events are list lines in a note with `typ: kalendarz` frontmatter. Structured data stays plain text in `.md`, so undo, sync and Obsidian compatibility keep working.

## Conventions

- `docs/ARCHITEKTURA.md` is the design source of truth. Code cites it as `ARCHITEKTURA §x.y`, so keep those references accurate when you change behavior. `docs/PLAN-BUDOWY.md` lists the build stages and the tests each stage requires. `docs/UWAGI.md` records open questions and decisions.
- Rust tests usually live in sibling files (`space.rs` → `space_tests.rs`, `formula/tests*.rs`), wired in with `#[cfg(test)] mod ...;`. Property tests use `proptest`.
- Comments starting with `shortcut:` mark deliberate simplifications that a later stage will replace.
- `docs/graphify-out/` is generated output, not documentation.
- Licence: the project is AGPL-3.0-or-later (`LICENSE`); `docs/LICENCJE.md` is the source of truth for third-party
  components. Dependencies stay permissive only (no GPL/AGPL, no "non-commercial" or source-available licences, no
  code without a licence; LGPL/MPL only by name, as in `docs/PODGLAD.md` §1). A new dependency or third-party file
  must pass `cargo deny check` and the npm licence check (CI job `licencje`), and must reach `THIRD_PARTY_NOTICES.txt`:
  automatically (crates, bundled npm packages) or through `scripts/licencje/manifest.json` (files the tools do not
  see). Then run `node scripts/licencje/generate.mjs` (after `npm run build` in `ui/` and `mcp/`) and commit the file.
