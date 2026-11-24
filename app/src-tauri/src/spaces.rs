//! The known spaces: the list the welcome screen and the switcher show, and the commands that open, forget and
//! close them. A space is opened only from that list, so the webview names no other folder.

use std::fs;
use std::path::{Path, PathBuf};

use notes_bridge::{Backend, BridgeError, OsKeyStore};
use tauri::{AppHandle, Manager, State};

use crate::commands::{AppState, lock_path, open_then, remember, start_background};
use crate::config;
use crate::tasks;

type Reply<T> = Result<T, BridgeError>;

/// One space of the list. `current` marks the open one; `exists` is false when its folder or database is gone.
#[derive(serde::Serialize)]
pub struct SpaceItem {
    path: String,
    name: String,
    kind: String,
    current: bool,
    exists: bool,
}

fn config_dir(app: &AppHandle) -> Reply<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| BridgeError::new("error", format!("Nie ma folderu ustawień: {e}")))
}

pub(crate) fn has_space(path: &Path) -> bool {
    path.join(".notes-sync").join("space.db").exists()
}

/// The listed space that `asked` names. Both sides are compared canonicalized; any other folder is refused.
pub(crate) fn known_among(spaces: &[PathBuf], asked: &Path) -> Reply<PathBuf> {
    let refused = || BridgeError::new("folder_refused", "Tej przestrzeni nie ma na liście przestrzeni.");
    let asked = fs::canonicalize(asked).map_err(|_| refused())?;
    spaces
        .iter()
        .find(|p| fs::canonicalize(p).ok().as_ref() == Some(&asked))
        .cloned()
        .ok_or_else(refused)
}

/// Whether two paths name the same folder: equal text, or equal once both exist and are canonicalized.
fn same_folder(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// The listed folder that `asked` names, compared with `same_folder`. A folder that no longer exists is still
/// found by its text, so it can be removed from the list.
fn listed_match(spaces: &[PathBuf], asked: &Path) -> Option<PathBuf> {
    spaces.iter().find(|p| same_folder(p, asked)).cloned()
}

/// The open space cannot leave the list: it would stay open with no way back to it.
fn not_open(state: &AppState, path: &Path) -> Reply<()> {
    if lock_path(&state.current).as_deref().is_some_and(|open| same_folder(open, path)) {
        return Err(BridgeError::new(
            "space_open",
            "Nie można usunąć z listy przestrzeni, która jest otwarta. Najpierw ją zamknij.",
        ));
    }
    Ok(())
}

/// The known spaces, newest first.
#[tauri::command]
pub fn list_spaces(app: AppHandle, state: State<'_, AppState>) -> Reply<Vec<SpaceItem>> {
    let current = lock_path(&state.current).clone();
    let dir = config_dir(&app)?;
    Ok(config::spaces(&dir)
        .into_iter()
        .map(|p| SpaceItem {
            name: p.file_name().unwrap_or(p.as_os_str()).to_string_lossy().into_owned(),
            kind: config::kind(&dir, &p),
            exists: has_space(&p),
            current: current.as_deref() == Some(p.as_path()),
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

/// Opens a listed space and remembers it. "needs_phrase" when this device has no keys for it: the folder is then
/// accepted by `recover_space`, and the next start shows the space manager instead of the old space.
#[tauri::command]
pub fn open_known_space(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Reply<&'static str> {
    let spaces = config::spaces(&config_dir(&app)?);
    let path = known_among(&spaces, Path::new(&path))?;
    if !has_space(&path) {
        return Err(BridgeError::new(
            "folder_refused",
            "Tej przestrzeni nie ma już w tym folderze.",
        ));
    }
    // the new space opens first: a failed open leaves the open space as it was
    match open_then(&state, path.clone(), |p| Backend::open(p, &mut OsKeyStore).map(|s| (s, ()))) {
        Ok((generation, ())) => {
            start_background(&app, &state, generation);
            remember(&app, &path);
            Ok("open")
        }
        Err(e) if e.kind == "needs_phrase" => {
            // no keys here: the space is not open, and its copy of the tasks goes too
            state.replace(None);
            let dir = config_dir(&app)?;
            config::clear_last(&dir)?;
            tasks::remove_cache(&dir, &path)?;
            *lock_path(&state.picked) = Some(path);
            Ok("needs_phrase")
        }
        Err(e) => Err(e),
    }
}

/// Closes the open space and forgets it as the one to open at the next start, so the space manager shows next.
#[tauri::command]
pub fn close_space(app: AppHandle, state: State<'_, AppState>) -> Reply<()> {
    state.replace(None);
    config::clear_last(&config_dir(&app)?)?;
    Ok(())
}

/// Removes a space from the list. Its folder is never touched.
#[tauri::command]
pub fn forget_space(app: AppHandle, state: State<'_, AppState>, path: String) -> Reply<()> {
    let dir = config_dir(&app)?;
    let refused = || BridgeError::new("folder_refused", "Tej przestrzeni nie ma na liście przestrzeni.");
    let listed = listed_match(&config::spaces(&dir), Path::new(&path)).ok_or_else(refused)?;
    not_open(&state, &listed)?;
    config::forget(&dir, &listed)?;
    tasks::remove_cache(&dir, &listed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notes_bridge::MemoryKeyStore;

    /// Opens a new space in `dir` and makes it the open one.
    fn open_at(state: &AppState, dir: &Path, ks: &mut MemoryKeyStore) -> u64 {
        let (space, _) = Backend::create(dir, ks).unwrap();
        state.replace(Some((dir.to_path_buf(), space)))
    }

    #[test]
    fn only_a_listed_folder_is_known() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let listed = vec![a.path().to_path_buf()];
        assert_eq!(known_among(&listed, a.path()).unwrap(), a.path());
        assert_eq!(known_among(&listed, b.path()).unwrap_err().kind, "folder_refused");
        assert_eq!(known_among(&[], a.path()).unwrap_err().kind, "folder_refused");
        let gone = a.path().join("nie ma");
        assert_eq!(known_among(std::slice::from_ref(&gone), &gone).unwrap_err().kind, "folder_refused");
    }

    #[test]
    fn forgetting_compares_folders_not_text() {
        let a = tempfile::tempdir().unwrap();
        let listed = vec![a.path().to_path_buf()];
        let alias = a.path().join(".").join("..").join(a.path().file_name().unwrap());
        assert_eq!(listed_match(&listed, &alias), Some(a.path().to_path_buf()));
        assert_eq!(listed_match(&listed, &a.path().join("..")), None);
        let gone = a.path().join("nie ma");
        assert_eq!(listed_match(std::slice::from_ref(&gone), &gone), Some(gone.clone()));
    }

    #[test]
    fn the_open_space_cannot_be_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::default();
        assert!(not_open(&state, dir.path()).is_ok());
        open_at(&state, dir.path(), &mut MemoryKeyStore::default());
        assert_eq!(not_open(&state, dir.path()).unwrap_err().kind, "space_open");
        let alias = dir.path().join(".").join("..").join(dir.path().file_name().unwrap());
        assert_eq!(not_open(&state, &alias).unwrap_err().kind, "space_open");
    }

    #[test]
    fn opening_another_space_drops_the_open_one() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ks = MemoryKeyStore::default();
        let state = AppState::default();
        let first = open_at(&state, a.path(), &mut ks);
        let second = open_at(&state, b.path(), &mut ks);
        assert!(second > first);
        assert_eq!(lock_path(&state.current).as_deref(), Some(b.path()));
        assert!(crate::commands::with_space(&state, |s| s.list_tree()).is_ok());
        state.replace(None);
        assert!(crate::commands::with_space(&state, |s| s.list_tree()).is_err());
    }
}
