//! The IPC commands: thin wrappers over the one open `notes_bridge::Backend`. Names and arguments match
//! the calls in `ui/src/bridge.ts`, so the UI is the same with `MockBridge` in the browser.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use notes_bridge::{
    Backend, BridgeError, Change, ConflictTexts, OsKeyStore, SearchHit, TrashItem, TreeListing, VersionItem,
};
use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::config;

type Reply<T> = Result<T, BridgeError>;

/// The recovery words. They are serialized from their wiping buffer, never copied out of it.
pub struct Words(Zeroizing<Vec<String>>);

impl serde::Serialize for Words {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&self.0[..], serializer)
    }
}

/// The open space, if any. Commands and the background thread share it. `generation` counts the spaces
/// installed, so the background thread of an earlier space stops.
#[derive(Default)]
pub struct AppState {
    pub(crate) backend: Mutex<Option<Backend>>,
    generation: AtomicU64,
    /// The folder of the open space.
    pub(crate) current: Mutex<Option<PathBuf>>,
    /// The folder the system dialog returned last: the folder commands accept no other.
    pub(crate) picked: Mutex<Option<PathBuf>>,
    /// The folder of a space created now, remembered only once its recovery phrase is confirmed.
    unconfirmed: Mutex<Option<PathBuf>>,
}

pub(crate) fn lock(state: &AppState) -> MutexGuard<'_, Option<Backend>> {
    // a panic in one command must not make every later command fail
    state.backend.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn lock_path(slot: &Mutex<Option<PathBuf>>) -> MutexGuard<'_, Option<PathBuf>> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `f` on the open space; `no_space` when none is open.
pub(crate) fn with_space<T>(state: &AppState, f: impl FnOnce(&mut Backend) -> Reply<T>) -> Reply<T> {
    let mut guard = lock(state);
    let space = guard
        .as_mut()
        .ok_or_else(|| BridgeError::new("no_space", "Nie otwarto przestrzeni."))?;
    f(space)
}

impl AppState {
    /// Makes `open` (folder and space) the open one, or none. The space it replaces is dropped here, and the
    /// background work of every earlier space stops. Returns the generation of the new background work.
    pub(crate) fn replace(&self, open: Option<(PathBuf, Backend)>) -> u64 {
        let (path, space) = open.unzip();
        *lock(self) = space;
        *lock_path(&self.current) = path;
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Makes `space` the open one and starts the background work for it.
pub(crate) fn install(app: &AppHandle, state: &AppState, path: PathBuf, space: Backend) {
    let generation = state.replace(Some((path, space)));
    start_background(app, state, generation);
}

/// Starts the background work of the space that was just made open, and keeps its type in config.json, where the
/// space list reads it without opening the space.
pub(crate) fn start_background(app: &AppHandle, state: &AppState, generation: u64) {
    let current = lock_path(&state.current).clone();
    if let (Some(path), Ok(kind)) = (current, with_space(state, |s| Ok(s.space_kind()))) {
        cache_kind(app, &path, kind);
    }
    let app = app.clone();
    std::thread::spawn(move || run_in_background(app, generation));
}

/// Opens the space at `path` with `open`, and only then makes it the open one: the open space is replaced (and
/// dropped) once the new one exists, so a failed open leaves the current space usable. Returns the generation of
/// the new space's background work, and what `open` made besides the space.
pub(crate) fn open_then<T>(
    state: &AppState,
    path: PathBuf,
    open: impl FnOnce(&Path) -> Reply<(Backend, T)>,
) -> Reply<(u64, T)> {
    let (space, extra) = open(&path)?;
    Ok((state.replace(Some((path, space))), extra))
}

/// `open_then` for a folder made for a new space: when the creation fails, the empty folder is removed, so the
/// name can be used again. Only folders made by `new_folder` go through here, never a folder the user picked.
pub(crate) fn create_in_new_folder<T>(
    state: &AppState,
    folder: PathBuf,
    create: impl FnOnce(&Path) -> Reply<(Backend, T)>,
) -> Reply<(u64, T)> {
    open_then(state, folder.clone(), create).inspect_err(|_| {
        let _ = fs::remove_dir(&folder);
    })
}

/// Remembers `path` as the space to open at the next start.
pub(crate) fn remember(app: &AppHandle, path: &Path) {
    if let Ok(dir) = app.path().app_config_dir()
        && let Err(e) = config::remember(&dir, path)
    {
        eprintln!("notes: could not remember the space folder: {e}");
    }
}

/// Keeps the type of a space in config.json, so the space list shows it without opening the space.
pub(crate) fn cache_kind(app: &AppHandle, path: &Path, kind: &str) {
    if let Ok(dir) = app.path().app_config_dir()
        && let Err(e) = config::set_kind(&dir, path, kind)
    {
        eprintln!("notes: could not remember the space type: {e}");
    }
}

/// The folder a command works on: the one `pick_folder` returned last. Any other path is refused.
fn picked_folder(state: &AppState, path: &str) -> Reply<PathBuf> {
    match lock_path(&state.picked).as_deref() {
        Some(picked) if picked == Path::new(path) => Ok(picked.to_path_buf()),
        _ => Err(BridgeError::new(
            "folder_not_picked",
            "Najpierw wybierz folder w oknie wyboru.",
        )),
    }
}

/// The root of a disk and the home folder are never a space: a space takes every `.md` file under its folder.
fn refuse_broad(app: &AppHandle, path: &Path) -> Reply<()> {
    let home = app
        .path()
        .home_dir()
        .ok()
        .and_then(|h| fs::canonicalize(h).ok());
    if path.parent().is_none() || home.as_deref() == Some(path) {
        return Err(BridgeError::new(
            "folder_refused",
            "Przestrzeni nie można założyć w katalogu głównym ani w folderze domowym. Wybierz osobny folder.",
        ));
    }
    Ok(())
}

/// Every 100 ms: the space's background work (file changes, search index, cold notes, autosave), then the
/// changes it made are sent to the UI. Stops when another space is installed.
fn run_in_background(app: AppHandle, generation: u64) {
    loop {
        std::thread::sleep(Duration::from_millis(100));
        let state = app.state::<AppState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            break;
        }
        match with_space(&state, |space| {
            space.tick()?;
            Ok(space.take_changes())
        }) {
            Ok(changes) => changes.into_iter().for_each(|c| emit_change(&app, c)),
            Err(e) => eprintln!("notes: background work failed: {}", e.message),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct NoteUpdate<'a> {
    id: &'a str,
    update: &'a [u8],
}

#[derive(Clone, serde::Serialize)]
struct NoteRef<'a> {
    id: &'a str,
}

/// The event names and payloads of `ui/src/tauribridge.ts`.
fn emit_change(app: &AppHandle, change: Change) {
    let _ = match change {
        Change::TreeChanged => app.emit("tree_changed", ()),
        Change::NoteUpdate { id, update } => app.emit(
            "note_update",
            NoteUpdate {
                id: &id,
                update: &update,
            },
        ),
        Change::Conflict { id } => app.emit("conflict", NoteRef { id: &id }),
    };
}

/// The tree changed by a command: the UI reloads it, as it does after the mock bridge's changes.
fn tree_changed(app: &AppHandle) {
    let _ = app.emit("tree_changed", ());
}

fn config_space(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    config::last_space(&dir)
}

/// "open" when a space is open, "needs_phrase" when the remembered space needs the recovery phrase on this
/// device, "none" when there is nothing to open. The remembered space is opened here, if it can be.
#[tauri::command]
pub fn space_status(app: AppHandle, state: State<'_, AppState>) -> Reply<&'static str> {
    if lock(&state).is_some() {
        return Ok("open");
    }
    let Some(path) = config_space(&app) else {
        return Ok("none");
    };
    if !path.join(".notes-sync").join("space.db").exists() {
        return Ok("none");
    }
    match Backend::open(&path, &mut OsKeyStore) {
        Ok(space) => {
            install(&app, &state, path, space);
            Ok("open")
        }
        Err(e) if e.kind == "needs_phrase" => Ok("needs_phrase"),
        Err(e) => Err(e),
    }
}

/// Asks for a folder with the system dialog. The folder is the only one the folder commands accept next.
/// None when the dialog was cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, state: State<'_, AppState>) -> Reply<Option<String>> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Wybierz folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let Some(path) = picked.as_path() else {
        return Err(BridgeError::new(
            "folder_refused",
            "Ten wybór nie jest folderem na dysku.",
        ));
    };
    let path = fs::canonicalize(path)?;
    refuse_broad(&app, &path)?;
    let shown = path.to_string_lossy().into_owned();
    *lock_path(&state.picked) = Some(path);
    Ok(Some(shown))
}

/// The folder a new space gets: `name` inside the picked folder, created now. The name comes from the webview,
/// so it is checked with the rules of a note's path segment.
fn new_folder(parent: &Path, name: &str) -> Reply<PathBuf> {
    let refused = || {
        BridgeError::new(
            "invalid_path",
            "Nazwa przestrzeni jest pusta albo zawiera znaki, których nie wolno użyć w nazwie folderu.",
        )
    };
    // a trailing dot or space is dropped by Windows, so the folder would not have the name the list keeps
    let dots = name == "." || name == "..";
    let trailing = name.ends_with(['.', ' ']);
    if dots || trailing || name.trim().is_empty() || name.contains('/') || !notes_core::is_valid_path(&format!("{name}.md")) {
        return Err(refused());
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(BridgeError::new("folder_refused", "Folder o tej nazwie już istnieje."));
    }
    fs::create_dir(&dir)?;
    Ok(dir)
}

/// Creates a new space named `name` in `path` (the picked folder) with a new identity. Returns the recovery words,
/// shown once. The folder is remembered by `confirm_phrase`.
#[tauri::command]
pub fn create_space(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Reply<Words> {
    let path = new_folder(&picked_folder(&state, &path)?, &name)?;
    let (generation, words) = create_in_new_folder(&state, path.clone(), |p| {
        Backend::create(p, &mut OsKeyStore).map(|(space, words)| (space, Words(words)))
    })?;
    start_background(&app, &state, generation);
    *lock_path(&state.unconfirmed) = Some(path);
    Ok(words)
}

/// Opens the space in `path` (the picked folder), or creates one there when the folder holds none (its files
/// become notes). Returns the recovery words only when a space was created.
#[tauri::command]
pub fn open_space(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Reply<Option<Words>> {
    let path = picked_folder(&state, &path)?;
    if path.join(".notes-sync").join("space.db").exists() {
        let (generation, ()) = open_then(&state, path.clone(), |p| Backend::open(p, &mut OsKeyStore).map(|s| (s, ())))?;
        start_background(&app, &state, generation);
        remember(&app, &path);
        return Ok(None);
    }
    let (generation, words) = open_then(&state, path.clone(), |p| {
        Backend::create(p, &mut OsKeyStore).map(|(space, words)| (space, Words(words)))
    })?;
    start_background(&app, &state, generation);
    *lock_path(&state.unconfirmed) = Some(path);
    Ok(Some(words))
}

/// Opens the space in `path` with the recovery phrase, on a device whose keys were lost.
#[tauri::command]
pub fn recover_space(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    words: String,
) -> Reply<()> {
    let path = picked_folder(&state, &path)?;
    let (generation, ()) = open_then(&state, path.clone(), |p| {
        Backend::recover(p, &mut OsKeyStore, &words).map(|s| (s, ()))
    })?;
    start_background(&app, &state, generation);
    remember(&app, &path);
    Ok(())
}

/// The user confirmed that the recovery phrase is saved: the folder of the new space is remembered now.
#[tauri::command]
pub fn confirm_phrase(app: AppHandle, state: State<'_, AppState>) -> Reply<()> {
    if let Some(path) = lock_path(&state.unconfirmed).take() {
        remember(&app, &path);
    }
    Ok(())
}

#[tauri::command]
pub fn space_name(state: State<'_, AppState>) -> Reply<String> {
    with_space(&state, |s| Ok(s.space_name()))
}

/// The type of the open space: `notatki` or `organizacja`.
#[tauri::command]
pub fn space_kind(state: State<'_, AppState>) -> Reply<String> {
    with_space(&state, |s| Ok(s.space_kind().to_string()))
}

/// Sets the type of the open space. Only notatki to organizacja is allowed; the core refuses the rest.
#[tauri::command]
pub fn set_space_kind(app: AppHandle, state: State<'_, AppState>, kind: String) -> Reply<String> {
    let kind = with_space(&state, |s| {
        s.set_space_kind(&kind)?;
        Ok(s.space_kind())
    })?;
    if let Some(path) = lock_path(&state.current).clone() {
        cache_kind(&app, &path, kind);
    }
    Ok(kind.to_string())
}

#[tauri::command]
pub fn list_tree(state: State<'_, AppState>) -> Reply<TreeListing> {
    with_space(&state, |s| s.list_tree())
}

#[tauri::command]
pub fn create_note(app: AppHandle, state: State<'_, AppState>, path: String) -> Reply<String> {
    let id = with_space(&state, |s| s.create_note(&path))?;
    tree_changed(&app);
    Ok(id)
}

#[tauri::command]
pub fn create_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Reply<()> {
    with_space(&state, |s| s.create_folder(&path))?;
    tree_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn rename(app: AppHandle, state: State<'_, AppState>, id: String, path: String) -> Reply<()> {
    with_space(&state, |s| s.rename(&id, &path))?;
    tree_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn rename_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Reply<()> {
    with_space(&state, |s| s.rename_folder(&from, &to))?;
    tree_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Reply<()> {
    with_space(&state, |s| s.delete(&id))?;
    tree_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Reply<()> {
    with_space(&state, |s| s.delete_folder(&path))?;
    tree_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> Reply<Vec<TrashItem>> {
    with_space(&state, |s| s.list_trash())
}

#[tauri::command]
pub fn restore_note(app: AppHandle, state: State<'_, AppState>, id: String) -> Reply<String> {
    let path = with_space(&state, |s| s.restore_note(&id))?;
    tree_changed(&app);
    Ok(path)
}

#[tauri::command]
pub fn purge_note(state: State<'_, AppState>, id: String) -> Reply<()> {
    with_space(&state, |s| s.purge_note(&id))
}

#[tauri::command]
pub fn open_note(state: State<'_, AppState>, id: String) -> Reply<Vec<u8>> {
    with_space(&state, |s| s.open_note(&id))
}

#[tauri::command]
pub fn note_text(state: State<'_, AppState>, id: String) -> Reply<String> {
    with_space(&state, |s| s.note_text(&id))
}

#[tauri::command]
pub fn apply_update(state: State<'_, AppState>, id: String, update: Vec<u8>) -> Reply<()> {
    with_space(&state, |s| s.apply_update(&id, &update))
}

#[tauri::command]
pub fn search(state: State<'_, AppState>, query: String, limit: usize) -> Reply<Vec<SearchHit>> {
    with_space(&state, |s| s.search(&query, limit))
}

#[tauri::command]
pub fn list_versions(state: State<'_, AppState>, id: String) -> Reply<Vec<VersionItem>> {
    with_space(&state, |s| s.list_versions(&id))
}

#[tauri::command]
pub fn version_text(state: State<'_, AppState>, vid: i64) -> Reply<String> {
    with_space(&state, |s| s.version_text(vid))
}

#[tauri::command]
pub fn restore_version(state: State<'_, AppState>, id: String, vid: i64) -> Reply<()> {
    with_space(&state, |s| s.restore_version(&id, vid))
}

#[tauri::command]
pub fn list_conflicts(state: State<'_, AppState>) -> Reply<Vec<String>> {
    with_space(&state, |s| s.list_conflicts())
}

#[tauri::command]
pub fn conflict_texts(state: State<'_, AppState>, id: String) -> Reply<ConflictTexts> {
    with_space(&state, |s| s.conflict_texts(&id))
}

/// `seen` is the `theirsHash` of the conflict view the user chose in.
#[tauri::command]
pub fn resolve_conflict(
    state: State<'_, AppState>,
    id: String,
    text: String,
    seen: String,
) -> Reply<()> {
    with_space(&state, |s| s.resolve_conflict(&id, &text, &seen))
}

/// The file's bytes are the raw request body; its name comes in the `x-file-name` header, percent-encoded by the UI.
#[tauri::command]
pub fn save_attachment(request: Request<'_>, state: State<'_, AppState>) -> Reply<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(BridgeError::new("error", "Brak danych pliku."));
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or_else(|| BridgeError::new("invalid_path", "Brak nazwy pliku."))?;
    with_space(&state, |s| s.save_attachment(&name, bytes))
}

/// The attachment's bytes, sent raw (an `ArrayBuffer` in the UI).
#[tauri::command]
pub fn read_attachment(state: State<'_, AppState>, rel: String) -> Reply<Response> {
    with_space(&state, |s| s.read_attachment(&rel)).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_space_gets_a_plain_folder_name_and_no_existing_folder() {
        let parent = tempfile::tempdir().unwrap();
        let dir = new_folder(parent.path(), "Projekt Triton").unwrap();
        assert_eq!(dir, parent.path().join("Projekt Triton"));
        assert!(dir.is_dir());
        assert_eq!(new_folder(parent.path(), "Projekt Triton").unwrap_err().kind, "folder_refused");
        for bad in ["", "  ", "..", ".", "a/b", "../x", "a\\b", "c:x", "con", "x\u{0}y", "Triton.", "Triton "] {
            assert_eq!(new_folder(parent.path(), bad).unwrap_err().kind, "invalid_path", "{bad:?}");
        }
    }

    #[test]
    fn a_failed_open_keeps_the_open_space_usable() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ks = notes_bridge::MemoryKeyStore::default();
        let state = AppState::default();
        open_then(&state, a.path().to_path_buf(), |p| Backend::create(p, &mut ks).map(|(s, _)| (s, ()))).unwrap();
        let failed = open_then::<()>(&state, b.path().to_path_buf(), |_| Err(BridgeError::new("error", "zablokowana")));
        assert_eq!(failed.unwrap_err().kind, "error");
        assert_eq!(lock_path(&state.current).as_deref(), Some(a.path()));
        assert!(with_space(&state, |s| s.list_tree()).is_ok());
    }

    #[test]
    fn a_successful_open_replaces_the_open_space() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ks = notes_bridge::MemoryKeyStore::default();
        let state = AppState::default();
        open_then(&state, a.path().to_path_buf(), |p| Backend::create(p, &mut ks).map(|(s, _)| (s, ()))).unwrap();
        open_then(&state, b.path().to_path_buf(), |p| Backend::create(p, &mut ks).map(|(s, _)| (s, ()))).unwrap();
        assert_eq!(lock_path(&state.current).as_deref(), Some(b.path()));
    }

    #[test]
    fn a_folder_left_empty_by_a_failed_create_is_removed() {
        let parent = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let folder = new_folder(parent.path(), "Plan").unwrap();
        let failed = create_in_new_folder::<()>(&state, folder.clone(), |_| Err(BridgeError::new("error", "zablokowana")));
        assert!(failed.is_err());
        assert!(!folder.exists());
    }

    #[test]
    fn recovery_words_go_out_as_a_plain_list() {
        let words = Words(Zeroizing::new(vec!["ala".to_string(), "ma".to_string()]));
        assert_eq!(serde_json::to_string(&words).unwrap(), r#"["ala","ma"]"#);
    }

    #[test]
    fn folder_commands_accept_only_the_folder_the_dialog_returned_last() {
        let state = AppState::default();
        assert_eq!(
            picked_folder(&state, "/tmp/a").err().unwrap().kind,
            "folder_not_picked"
        );
        *lock_path(&state.picked) = Some(PathBuf::from("/tmp/a"));
        assert_eq!(
            picked_folder(&state, "/tmp/a").unwrap(),
            PathBuf::from("/tmp/a")
        );
        assert_eq!(
            picked_folder(&state, "/home/uzytkownik").err().unwrap().kind,
            "folder_not_picked"
        );
        assert!(picked_folder(&state, "/tmp/a").is_ok());
    }
}
