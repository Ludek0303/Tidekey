# Plan implementacji: projekt połączony z GitHubem

Realizuje [GITHUB.md](GITHUB.md). Prowadzi Opus (projekt, kontrakty, przegląd, testy), kod piszą agenci Haiku, każdy w osobnym worktree gałęzi `buduj/github`.

## 1. Mapa: specyfikacja → kod (faza 0)

| Punkt | Gdzie w kodzie | Stan |
|---|---|---|
| Projekty `Projekty/<Nazwa>/`, „Nowy projekt” | `ui/src/projects.ts` (`askProjectName`), `ui/src/projectsview.ts:81`, `ui/src/orgviews.ts:159` (`newProject`) | jest |
| Chronione projekty, klucz projektu | `ui/src/protected.ts` (`ProtectedEntry`, `ProtectedPayload`), `ui/src/browserauth.ts` (`projectKeyFor`, `sealProtected`, `unfold`, `admitPayload`) | jest |
| Stan sejfu w webie | `ui/src/bridge.ts` `BrowserVaultSnapshot.state` (`notes`, `versions`, `records`, `protected`…); `schemaVersion: 1`, pola opcjonalne | jest |
| Scalanie migawek, `revision`, `conflict`, `relay` | `bridge.ts` `mergeBrowserSnapshot`, `browserauth.ts` (`persist`, `sendPut` z `baseRevision`, `takeRemote`, `"update"/"conflict"`) | jest |
| `merge3` (ARCHITEKTURA §4.4) | `crates/core/src/space_external.rs:91` — `diffy::merge` wywołane w miejscu, **nie ma** funkcji publicznej ani eksportu WASM | do zrobienia |
| Zastosowanie tekstu jako operacji CRDT | `crates/core/src/textdiff.rs` (desktop); w webie notatka to `Y.Doc` — różnica tekstu do zrobienia w TS (`applyTextDiff`) | częściowo |
| Ekran konfliktu | `ui/src/conflictview.ts` (`ConflictTexts`, `openConflict`) — w webie `conflict_texts` nie istnieje (MockBridge rzuca błąd), podpisy stron na sztywno | do uogólnienia |
| Historia wersji w webie | `state.versions` (`[id, {id,time_ms,reason,text}[]]`), `MockBridge` `save_version`/`list_versions` | jest |
| Magazyn plików, deterministyczne id | `ui/src/remotefiles.ts` (`RemoteFileStore`, `migrateAttachments`, `migrationId` = HMAC), klucze projektu `ProjectRef` | jest |
| Trasy serwera, role, błędy | `crates/node/src/vaults.rs` (`routes`, `member_role`, `VaultError` → `{error}`), `websync.rs` | jest |
| CSP | `crates/node/src/http.rs:26` (`connect-src 'self'`), `app/src-tauri/tauri.conf.json:21` | do zmiany (tylko web) |
| Bezpieczny renderer (T7a), zewnętrzne obrazki | `crates/core/src/render.rs` (`render_markdown_html` przez WASM), `ui/src/reading.ts`, `ui/src/attachments.ts` (`autoLoadImages`) | jest |
| Indeks zadań i wzmianek | `ui/src/noteindex.ts` (`edited(id, text)` → WASM `WasmIndex`), `ui/src/orgtasks.ts` | miejsce na filtr: `noteindex.edited` |
| Desktop (Tauri) z projektami | `app/src-tauri` + `crates/bridge` — przestrzenie organizacji istnieją, ale bez chronionych projektów i bez sejfów webowych | **w tej pracy desktop = tylko logika w `crates/core`** |
| SHA-1 | crate `sha1 0.10.7` (RustCrypto, MIT/Apache-2.0) już jest w `Cargo.lock` | nowa bezpośrednia zależność `notes-core`, bez nowego crate w budowie |
| CI | `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo check -p notes-core --target wasm32-unknown-unknown`, `cd ui && npm test`, `npx tsc --noEmit`, `npm run build` | — |

## 2. Gdzie kod różni się od założeń i jak to rozwiązuję

1. **Rekord `github-link` w chronionym projekcie.** Stan sejfu nie ma miejsca na dane projektu poza notatkami. Dodaję **opcjonalne** pole `state.github?: GithubLink[]` (projekty jawne) i **opcjonalne** pole `ProtectedPayload.github?: GithubLink[]` (projekty chronione — rekord jest wtedy szyfrowany kluczem projektu razem z notatkami). Rekord należy do projektu przez `projectPath`. Stare klienty ignorują nieznane pola (zasada „schemaVersion stays 1”). Scalanie rekordów: po `id`, wygrywa wyższe `rev` (licznik zwiększany przy każdym zapisie; remis → wyższe `lastAppliedAt`). Rekord z jawnego `state.github` należący do ścieżki chronionej jest odrzucany przy `unfold` (jak notatki).
2. **Archiwum blobów** (§6a): plik w magazynie plików projektu, id = `HMAC-SHA256(sekret sejfu, "github\0" + linkId + "\0" + blobSha)` — ta sama funkcja co `migrationId`. W chronionym projekcie plik jest szyfrowany kluczem projektu (istniejąca ścieżka `ProjectRef`). Rekord trzyma `files[noteId].blobSha`; baza scalania = blob z archiwum.
3. **Zadania i wzmianki tylko z dopisków** (§9): indeks w webie dostaje tekst przez `noteindex.edited`. Rekord trzyma dla każdego pliku `guarded: string[]` — skróty (8 znaków hex SHA-1) linii z wersji z GitHuba, które są zadaniem albo mają `@wzmiankę`. Przed indeksowaniem notatki z GitHuba takie linie są zastępowane pustymi (numery linii bez zmian). Linia dopisana w notatniku (nawet identyczna, ale w innym miejscu po edycji) nie ma swojego skrótu w `guarded`, chyba że jest dokładną kopią linii z GitHuba — wtedy liczy się tylko wtedy, gdy liczba wystąpień w notatce przekracza liczbę w wersji z GitHuba (liczenie krotności).
4. **Konflikt w webie**: w webie nie ma `conflict_texts`. Konflikt pliku z GitHuba trzyma się w rekordzie (`files[id].conflict = { blobSha, sha }`, tekst „ich” w archiwum). Ekran `conflictview.ts` dostaje opcjonalne podpisy stron i źródło tekstów (funkcję zamiast `bridge.call`), a rozwiązanie zapisuje wynik w notatce i ustawia nową bazę.
5. **„Wszystko albo nic”**: zmiany są liczone na kopiach (`Y.Doc` sklonowany z bieżącego stanu) po dogonieniu synchronizacji i pod blokadą; dopiero potem nakładane na żywe dokumenty w jednym kroku i wysyłane jednym `persist`. Konflikt rewizji przy `put` → klient scala stan serwera (zwykły mechanizm) i sprawdza `lastCommit` po scaleniu; ten sam commit zastosowany przez inne urządzenie nie wystąpi dzięki blokadzie (TTL 120 s, przedłużana co 60 s) i sprawdzeniu w krokach 3 i 8.
6. **Notatki z GitHuba nie są „notatką projektu”** (znaczniki uprawnień, §9): linie z kluczami `osoby:`, `grupy:`, `prowadzacy:`, `typ:` (frontmatter) i `!zaznacza:` w tekście z GitHuba są usuwane przed scaleniem (z bazy i z nowej wersji jednakowo), a status pokazuje, ile linii pominięto.

## 3. Kontrakty

### 3.1 Rust `notes-core::github` (czysta logika, bez sieci, kompiluje się do wasm32)

```rust
pub struct RepoRef { pub owner: String, pub repo: String, pub git_ref: Option<String>, pub path: String }
pub fn parse_repo_url(input: &str) -> Option<RepoRef>;           // https://github.com/o/r, o/r, …/tree/<ref>/<dir>, …/blob/<ref>/<plik> (→ jego folder)
pub fn git_blob_sha1(bytes: &[u8]) -> String;                    // hex sha1("blob <len>\0" + bytes)
pub fn normalize_repo_path(path: &str, repo_path: &str) -> Option<String>; // względem podfolderu; None dla .., /, \, :, sterujących, pustych segmentów
pub fn is_markdown(path: &str) -> bool;                          // *.md, *.markdown, README (dowolny folder, bez rozszerzenia, bez wielkości liter)
pub enum Merge3 { Clean(String), Conflict }
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Merge3;   // diffy::merge; space_external.rs przechodzi na tę funkcję
pub fn strip_permission_markers(text: &str) -> (String, usize);  // usuwa linie znaczników uprawnień, zwraca liczbę usuniętych
pub fn guarded_lines(text: &str) -> Vec<String>;                 // 8-znakowe hex sha1 linii-zadań i linii z @wzmianką (z krotnością)
pub struct TrackedFile { pub note_id: String, pub path: String, pub blob_sha: String, pub has_edits: bool }
pub struct TreeEntry { pub path: String, pub blob_sha: String, pub size: u64 }
pub enum Action {
  Create { path: String, blob_sha: String },
  Update { note_id: String, path: String, blob_sha: String },     // has_edits rozstrzyga scalenie w kroku 7
  Move { note_id: String, from: String, to: String, blob_sha: String },
  MarkDeleted { note_id: String },                                // onDelete keep albo plik z dopiskami
  Trash { note_id: String },                                      // onDelete trash i bez dopisków
  Skip { path: String, reason: SkipReason },                      // ignored, za duży, zła ścieżka, limit
}
pub enum SkipReason { Ignored, TooLarge, BadPath, LimitFiles, LimitTotal }
pub fn plan(tracked: &[TrackedFile], tree: &[TreeEntry], ignored: &[String], on_delete_trash: bool) -> Vec<Action>;
// limity: 2000 plików, 1 MiB na plik, 20 MiB łącznie — stałe w module
```

### 3.2 WASM `crates/web` (`notes-web`)

`github_parse_repo_url(s) -> JSON|null`, `github_blob_sha1(bytes) -> String`, `github_normalize_path(p, root) -> Option<String>`, `github_is_markdown(p) -> bool`, `github_merge3(base, ours, theirs) -> JSON {"clean": text} | {"conflict": true}`, `github_strip_markers(text) -> JSON {text, removed}`, `github_guarded_lines(text) -> JSON [..]`, `github_plan(trackedJson, treeJson, ignoredJson, trash) -> JSON [Action]` (Action jako `{"kind": "create"|"update"|"move"|"markDeleted"|"trash"|"skip", ...}` w camelCase).

### 3.3 TypeScript — rekord w stanie sejfu

```ts
export interface GithubFile { path: string; blobSha: string; guarded: string[]; deleted?: boolean; conflict?: { blobSha: string; commit: string } }
export interface GithubLink {
  id: string;               // 32 hex (losowe 16 B) = nazwa blokady
  projectPath: string;      // "Projekty/Alfa"
  repo: string;             // "właściciel/repo"
  ref: string | null;       // null = domyślna gałąź
  repoPath: string;         // "" | "docs"
  target: string;           // "GitHub" albo "GitHub/<repo>" — względem projectPath
  include: string[];        // ["**/*.md", "**/*.markdown", "**/README"]
  onDelete: "keep" | "trash";
  allowEdits: boolean;
  lastCommit: string | null;
  lastAppliedAt: number | null; lastAppliedBy: string | null;
  files: Record<string, GithubFile>;  // noteId → …
  ignored: string[];
  status: string;           // tekst dla ludzi: "ok", "Konflikt: 1 plik", "Limit GitHuba do 14:20", "Repozytorium niedostępne"
  rev: number;              // rośnie przy każdym zapisie; scalanie po id: wyższy rev wygrywa
}
// state.github?: GithubLink[]       (projekty jawne)
// ProtectedPayload.github?: GithubLink[]   (projekty chronione)
```

### 3.4 Klient GitHuba (`ui/src/github/api.ts`)

```ts
export interface GithubAuth { token: string | null }
export type GithubResult<T> = { ok: true; value: T; etag?: string } | { ok: false; kind: "notModified" | "notFound" | "rateLimited" | "network" | "invalid"; resetAt?: number };
getRepo(repo, auth): Promise<GithubResult<{ defaultBranch: string; private: boolean }>>
getCommitSha(repo, ref, etag, auth): Promise<GithubResult<string>>        // Accept: application/vnd.github.sha, If-None-Match
getCommitMessage(repo, sha, auth): Promise<GithubResult<string>>
getTree(repo, sha, auth): Promise<GithubResult<{ entries: TreeEntry[]; truncated: boolean }>>
getBlob(repo, blobSha, auth): Promise<GithubResult<Uint8Array>>         // Accept: application/vnd.github.raw; zwracany tylko, gdy git_blob_sha1(bytes) === blobSha
```
Tylko `https://api.github.com`. Token wyłącznie w nagłówku `Authorization: Bearer`. `403`/`429` z `x-ratelimit-remaining: 0` albo `retry-after` → `rateLimited` z `resetAt`. Testy na nagranych odpowiedziach w `ui/src/github/fixtures/`.

### 3.5 Serwer: blokady (kontrakt w WEB-WSPOLDZIELENIE.md)

```text
POST   /api/vaults/:id/leases  {"name": "<32 hex>", "ttlSeconds": 1..300}
       → 200 {"granted": true, "until": <ms>}  |  200 {"granted": false, "until": <ms>}
       ten sam posiadacz (użytkownik + sesja) przedłuża swoją blokadę
DELETE /api/vaults/:id/leases/:name   → 204 (tylko posiadacz; brak blokady też 204)
```
Rola edytor+ (przeglądający → 403). Tabela `vault_leases(vault_id, name, holder_session, until)`, wygasłe usuwane przy odczycie. Nazwy blokad nie trafiają do logów ani audytu. Limit: 50 blokad na sejf.

### 3.6 Token (§7)

Osobisty, w zaszyfrowanych ustawieniach konta (`/api/me/preferences` — istniejący zaszyfrowany kluczem osobistym obiekt), pole `githubToken`. Nigdy w stanie sejfu, w URL, w logach ani w komunikatach.

### 3.7 Nowe teksty interfejsu (po polsku)

„Połącz z GitHubem (opcjonalnie)”, „Połącz z GitHubem…”, „Adres repozytorium”, „Sprawdź”, „Importuj”, „Sprawdź teraz”, „Otwórz na GitHubie”, „Ustawienia”, „Odłącz”, „Przywróć z GitHuba”, „Z GitHuba: {ścieżka} · {sha7} — Twoje dopiski zostają przy aktualizacjach”, „Moje dopiski”, „Usunięty z GitHuba”, „Nie ma takiego repozytorium albo jest prywatne. Dla prywatnego dodaj token.”, „Repozytorium jest za duże, wybierz podfolder.”, „Limit GitHuba do {HH:MM}”, „Repozytorium niedostępne”, „Konflikt: {n} {plik/pliki/plików}”, „GitHub ({sha7})”, „Notatnik”, „Token GitHuba”, „Wyświetl obraz”.

## 4. Zadania dla agentów (fale)

- **Fala 1 (równolegle):** H1 `core::github` (bez `plan`) + `merge3` + testy i proptest; H2 `core::github::plan` + testy wszystkich wierszy tabeli §4; H3 serwer: blokady + testy; H4 klient API GitHuba w TS na nagranych odpowiedziach.
- **Fala 2:** H5 eksport WASM (`crates/web`) + `ui/src/github/core.ts` (owijki); H6 rekord `GithubLink` w stanie: typy, scalanie po `rev`, pole w `ProtectedPayload` (plik krytyczny `protected.ts` → **Opus**); H7 `applyTextDiff` dla `Y.Doc` (zmiana jako operacje CRDT).
- **Fala 3:** H8 przebieg aktualizacji §4 kroki 1–9 (`ui/src/github/update.ts`) z blokadą, archiwum, wersjami; H9 harmonogram + status; integracja w `browserauth.ts` (krytyczny → **Opus**).
- **Fala 4:** H10 okno połączenia + „Nowy projekt” + menu projektu; H11 pasek w notatce + „Moje dopiski” + status na ekranie projektu; H12 konflikt (uogólnienie `conflictview.ts`).
- **Fala 5:** H13 ochrony §9 (filtr w `noteindex`, obrazki zewnętrzne, CSP w `http.rs` — krytyczny → **Opus**); H14 token (ustawienia, instrukcja, repozytoria prywatne).
- **Faza 3:** testy końcowe w przeglądarce (lokalny serwer, nagrany GitHub przez `page.route`).

## 5. Testy akceptacyjne

GITHUB.md §11 w całości oraz: dwa klienty zaczynają ten sam commit jednocześnie → bez duplikatów; dopisek przetrwa 20 commitów; usunięty plik z dopiskami zostaje (i w archiwum); 404 → „Repozytorium niedostępne”, notatki i archiwum nietknięte; zły `blobSha` nie trafia do notatki; `- [ ] @Ania` z GitHuba nie tworzy zadania, dopisane tworzy; w bazie i ruchu serwera brak nazwy repozytorium i treści; druga osoba dostaje gotowe notatki i robi najwyżej jedno zapytanie o commit; `403`/`429` z `x-ratelimit-reset` → status i czekanie bez pętli; przeniesienie + zmiana w jednym commicie; CRLF, BOM, brak końcowego `\n`, polskie znaki w ścieżkach; `truncated: true`; zmiana domyślnej gałęzi; force-push; `conflict` przy `put`; ścieżki `../`, `\`, `:`; limity 2000 / 1 MiB / 20 MiB.

## 6. Decyzje podczas implementacji

- **Gałąź bazowa:** `buduj/github` powstaje z `szybsza-synchronizacja`, a nie z `main`. `main` (e37bdd9) nie zawiera czterech gotowych, jeszcze nie scalonych gałęzi (przeciąganie, panel administratora, foldery plików, szybsza synchronizacja), które zmieniają te same pliki (`browserauth.ts`, `bridge.ts`, `vaults.rs`, `websync.rs`, `projects.ts`). Praca od `main` dawałaby pewne konflikty w plikach krytycznych. Łańcuch gałęzi zostaje liniowy, więc scalenie do `main` to jedno `--ff-only`.
- **Worktree agentów:** ustawienie projektu tworzy worktree od `origin/main`, więc kolejne fale nie widziałyby poprzednich. Worktree zakłada prowadzący z bieżącego `buduj/github` (`git worktree add .claude/worktrees/<zadanie>`), a agent wchodzi do niego narzędziem `EnterWorktree`.
- **Pliki krytyczne** (`.claude/critical-files.txt`: `protected.ts`, `browserauth.ts`, `vaults.rs`, `websync.rs`, `http.rs`): kod w nich pisze Opus, Haiku dopisuje tylko testy obok. Blokady na serwerze idą do nowego pliku `crates/node/src/leases.rs` (Haiku), a w `vaults.rs` zmienia się tylko jedna linia rejestracji tras (Opus).
- **`plan()`**: przeniesienie na ścieżkę z `ignored` to usunięcie starej notatki i pominięcie nowej ścieżki; plik pominięty z powodu limitu zostaje śledzony ze starą treścią; limit sumy liczony zachłannie po ścieżkach.
- **Adresy**: gałąź z `/` w nazwie (`…/tree/feature/x/docs`) — pierwszy segment to gałąź, reszta to podfolder; frontmatter bez zamykającego `---` nie jest frontmatterem (aplikacja i tak nie czyta z niego uprawnień).
- **Odłącz** = znacznik `removed` z wyższym `rev` (zwykłe usunięcie wracałoby od innych urządzeń).
- **Projekt chroniony**: rekordu nie da się przenieść do chronionego projektu ani z niego (`LINK_MOVE_TEXT`); jawna kopia rekordu o `id` znanym z chronionej ścieżki jest odrzucana (`id` to nazwa blokady na serwerze, więc może być znane).
- **Konflikt**: plik w konflikcie nie jest pobierany ani scalany, dopóki konflikt nie zostanie rozwiązany.
- **Brak archiwum bazy** przy aktualizacji pliku z dopiskami → konflikt zamiast zgadywania bazy.
- **Czysta kopia** (`allowEdits: false`): aktualizacja zawsze ustawia tekst z GitHuba; poprzedni tekst trafia do historii wersji.
- **Worktree agentów**: narzędzie `EnterWorktree` nie działa z sesji agenta uruchomionej w katalogu głównym repozytorium, więc agenci pracowali w worktree przez ścieżki bezwzględne; każdy z osobnym `CARGO_TARGET_DIR`, bo wspólny katalog budowania dawał nieaktualny WASM.
