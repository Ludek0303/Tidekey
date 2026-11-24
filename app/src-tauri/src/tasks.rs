//! The device-side task data of organization spaces: the handle the user has in each space ("Kim jestem"), and
//! a copy of their tasks per space, which "Moje zadania" shows for the spaces that are not open.

use std::fs;
use std::path::{Path, PathBuf};

use notes_bridge::{Backend, BridgeError, OsKeyStore};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};

use crate::commands::{AppState, lock_path};
use crate::config;
use crate::spaces::has_space;

type Reply<T> = Result<T, BridgeError>;

const CACHE_DIR: &str = "task-cache";
// a copy of one space's tasks is a list of rows; a megabyte holds thousands of them
const MAX_CACHE_BYTES: usize = 1 << 20;

fn config_dir(app: &AppHandle) -> Reply<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| BridgeError::new("error", format!("Nie ma folderu ustawień: {e}")))
}

/// A handle as the task rows write it: letters and digits, `.`, `_` and `-`, at most 64 characters.
pub fn valid_handle(handle: &str) -> bool {
    let n = handle.chars().count();
    (1..=64).contains(&n) && handle.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The cache file of a space: named by the hash of its folder, so no file name comes from the webview.
fn cache_file(dir: &Path, space: &Path) -> PathBuf {
    let hash = blake3::hash(space.as_os_str().as_encoded_bytes());
    dir.join(CACHE_DIR).join(format!("{}.json", hash.to_hex()))
}

/// Refuses a copy that is too big for what the list shows. The webview's text is never trusted for its size.
fn check_cache_size(saved: &Value) -> Reply<()> {
    let size = serde_json::to_vec(saved).map(|b| b.len()).unwrap_or(usize::MAX);
    if size > MAX_CACHE_BYTES {
        return Err(BridgeError::new("invalid_cache", "Kopia zadań jest za duża."));
    }
    Ok(())
}

/// Writes the tasks of `space` for the spaces that are not open.
// shortcut: the copy is plaintext in the app config folder, fine while no space is encrypted at rest; encrypt it before the space keys reach that folder
pub fn write_cache(dir: &Path, space: &Path, saved: &Value) -> std::io::Result<()> {
    fs::create_dir_all(dir.join(CACHE_DIR))?;
    let bytes = serde_json::to_vec(&json!({ "space": space, "saved": saved }))?;
    notes_core::write_atomic(&cache_file(dir, space), &bytes)
}

/// The copy of `space`, or None when there is none or it cannot be read.
pub fn read_cache(dir: &Path, space: &Path) -> Option<Value> {
    let bytes = fs::read(cache_file(dir, space)).ok()?;
    let mut value: Value = serde_json::from_slice(&bytes).ok()?;
    Some(value.get_mut("saved")?.take())
}

/// Deletes the copy of `space`. A space without one is not an error.
pub fn remove_cache(dir: &Path, space: &Path) -> std::io::Result<()> {
    match fs::remove_file(cache_file(dir, space)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The handle of the open space, or None when none is set.
#[tauri::command]
pub fn my_handle(app: AppHandle, state: State<'_, AppState>) -> Reply<Option<String>> {
    let space = open_space(&state)?;
    Ok(config::handle(&config_dir(&app)?, &space))
}

/// Sets the handle of the open space on this device. The webview's text is checked here.
#[tauri::command]
pub fn set_my_handle(app: AppHandle, state: State<'_, AppState>, handle: String) -> Reply<()> {
    let space = open_space(&state)?;
    if !valid_handle(&handle) {
        return Err(BridgeError::new("invalid_handle", "Nieprawidłowa nazwa osoby (np. Jan): użyj liter, cyfr, kropki, _ lub -."));
    }
    config::set_handle(&config_dir(&app)?, &space, &handle)?;
    Ok(())
}

/// Writes the tasks of the open space for "Moje zadania" in the other spaces. `saved` is `{updated, rows}`.
#[tauri::command]
pub fn save_task_cache(app: AppHandle, state: State<'_, AppState>, saved: Value) -> Reply<()> {
    let space = open_space(&state)?;
    if !saved.get("rows").is_some_and(Value::is_array) {
        return Err(BridgeError::new("invalid_cache", "Brak listy zadań."));
    }
    check_cache_size(&saved)?;
    write_cache(&config_dir(&app)?, &space, &saved)?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct TaskCache {
    path: String,
    name: String,
    saved: Value,
}

/// The copies of the tasks of the listed spaces other than the open one, newest list order.
#[tauri::command]
pub fn task_caches(app: AppHandle, state: State<'_, AppState>) -> Reply<Vec<TaskCache>> {
    let dir = config_dir(&app)?;
    let current = lock_path(&state.current).clone();
    let listed = config::spaces(&dir);
    let mut keys = OsKeyStore;
    // A task cache is only a display optimization. Check each vault's current membership and keys
    // before returning it, so a removed member cannot keep seeing stale tasks from another vault.
    let authorized: std::collections::HashSet<_> = listed
        .iter()
        .filter(|path| current.as_deref() != Some(path.as_path()))
        .filter(|path| has_space(path))
        .filter(|path| {
            Backend::open(path, &mut keys)
                .map(|backend| backend.space_kind() == notes_core::KIND_ORGANIZATION)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    Ok(copies_of(&dir, &listed, current.as_deref(), &authorized))
}

/// The copies of the listed spaces other than the open one. A space whose folder is gone has no copy shown.
fn copies_of(
    dir: &Path,
    listed: &[PathBuf],
    current: Option<&Path>,
    authorized: &std::collections::HashSet<PathBuf>,
) -> Vec<TaskCache> {
    listed
        .iter()
        .filter(|p| current != Some(p.as_path()) && has_space(p))
        .filter(|p| authorized.contains(*p))
        .filter_map(|p| {
            let saved = read_cache(dir, p)?;
            let name = p.file_name()?.to_string_lossy().into_owned();
            Some(TaskCache { path: p.to_string_lossy().into_owned(), name, saved })
        })
        .collect()
}

fn open_space(state: &AppState) -> Reply<PathBuf> {
    lock_path(&state.current)
        .clone()
        .ok_or_else(|| BridgeError::new("no_space", "Nie otwarto przestrzeni."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_names_of_people_without_spaces_or_at_signs() {
        assert!(valid_handle("Jan"));
        assert!(valid_handle("Łukasz.K"));
        assert!(valid_handle("anna-maria_1"));
        for bad in ["", "a b", "@Jan", "../x", "a/b", &"x".repeat(65)] {
            assert!(!valid_handle(bad), "{bad}");
        }
    }

    #[test]
    fn a_copy_over_a_megabyte_is_refused() {
        assert!(check_cache_size(&json!({"rows": []})).is_ok());
        let big = json!({"rows": "x".repeat(MAX_CACHE_BYTES)});
        assert_eq!(check_cache_size(&big).unwrap_err().kind, "invalid_cache");
    }

    #[test]
    fn copies_skip_the_open_space_and_folders_that_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let (a, gone) = (dir.path().join("a"), dir.path().join("gone"));
        fs::create_dir_all(a.join(".notes-sync")).unwrap();
        fs::write(a.join(".notes-sync").join("space.db"), b"").unwrap();
        let saved = json!({"updated": "2026-10-25", "me": "Jan", "rows": []});
        write_cache(dir.path(), &a, &saved).unwrap();
        write_cache(dir.path(), &gone, &saved).unwrap();
        let listed = [a.clone(), gone.clone()];
        let authorized = std::collections::HashSet::from([a.clone()]);
        let copies = copies_of(dir.path(), &listed, None, &authorized);
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].name, "a");
        assert!(copies_of(dir.path(), &listed, Some(&a), &authorized).is_empty());
        let denied = std::collections::HashSet::new();
        assert!(copies_of(dir.path(), &listed, None, &denied).is_empty());
    }

    #[test]
    fn a_cache_is_written_read_and_removed_per_space() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (Path::new("/spaces/triton"), Path::new("/spaces/plan"));
        let saved = json!({"updated": "2026-10-25", "rows": [{"text": "Schemat"}]});
        write_cache(dir.path(), a, &saved).unwrap();
        assert_eq!(read_cache(dir.path(), a), Some(saved));
        assert_eq!(read_cache(dir.path(), b), None);
        remove_cache(dir.path(), a).unwrap();
        remove_cache(dir.path(), a).unwrap();
        assert_eq!(read_cache(dir.path(), a), None);
    }
}
