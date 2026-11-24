//! The folders of the known spaces and of the last opened one, kept in the app config folder. The file holds paths
//! only, no keys.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use notes_core::KIND_NOTES;
use serde::{Deserialize, Serialize};

const FILE: &str = "config.json";

#[derive(Default, Serialize, Deserialize)]
struct Config {
    last_space: Option<PathBuf>,
    /// Newest first. Files from before the list hold only `last_space`, which `read` adds here.
    #[serde(default)]
    spaces: Vec<PathBuf>,
    /// The type of each listed space, so the list shows it without opening the space.
    #[serde(default)]
    kinds: BTreeMap<PathBuf, String>,
    /// The handle the user has in each space ("Kim jestem"), a device-local preference.
    #[serde(default)]
    handles: BTreeMap<PathBuf, String>,
}

/// The stored config, or an empty one when there is none or it cannot be read.
fn read(dir: &Path) -> Config {
    let mut config: Config = fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if let Some(last) = &config.last_space
        && !config.spaces.contains(last)
    {
        config.spaces.insert(0, last.clone());
    }
    config
}

/// Written like every other file: temp file, fsync, rename.
fn write(dir: &Path, config: &Config) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(config)?;
    notes_core::write_atomic(&dir.join(FILE), &bytes)
}

/// The remembered folder, or None when there is none or the file cannot be read.
pub fn last_space(dir: &Path) -> Option<PathBuf> {
    read(dir).last_space
}

/// Every known space folder, newest first.
pub fn spaces(dir: &Path) -> Vec<PathBuf> {
    read(dir).spaces
}

/// The cached type of a listed space; `notatki` when none is cached.
pub fn kind(dir: &Path, space: &Path) -> String {
    read(dir)
        .kinds
        .get(space)
        .cloned()
        .unwrap_or_else(|| KIND_NOTES.to_string())
}

/// Caches the type of `space`, as the space itself stores it.
pub fn set_kind(dir: &Path, space: &Path, kind: &str) -> std::io::Result<()> {
    let mut config = read(dir);
    config.kinds.insert(space.to_path_buf(), kind.to_string());
    write(dir, &config)
}

/// The handle the user has in `space`, if one is set.
pub fn handle(dir: &Path, space: &Path) -> Option<String> {
    read(dir).handles.get(space).cloned()
}

pub fn set_handle(dir: &Path, space: &Path, handle: &str) -> std::io::Result<()> {
    let mut config = read(dir);
    config.handles.insert(space.to_path_buf(), handle.to_string());
    write(dir, &config)
}

/// Adds `space` to the known spaces and remembers it for the next start.
pub fn remember(dir: &Path, space: &Path) -> std::io::Result<()> {
    let mut config = read(dir);
    config.spaces.retain(|p| p != space);
    config.spaces.insert(0, space.to_path_buf());
    config.last_space = Some(space.to_path_buf());
    write(dir, &config)
}

/// Removes `space` from the known spaces. The folder itself is never touched.
pub fn forget(dir: &Path, space: &Path) -> std::io::Result<()> {
    let mut config = read(dir);
    config.spaces.retain(|p| p != space);
    config.kinds.remove(space);
    config.handles.remove(space);
    if config.last_space.as_deref() == Some(space) {
        config.last_space = None;
    }
    write(dir, &config)
}

/// Forgets the last opened space, so that the next start shows the space manager.
pub fn clear_last(dir: &Path) -> std::io::Result<()> {
    let mut config = read(dir);
    config.last_space = None;
    write(dir, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_from_before_the_list_still_loads_its_space() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), r#"{"last_space":"/home/uzytkownik/A"}"#).unwrap();
        assert_eq!(last_space(dir.path()), Some(PathBuf::from("/home/uzytkownik/A")));
        assert_eq!(spaces(dir.path()), vec![PathBuf::from("/home/uzytkownik/A")]);
    }

    #[test]
    fn the_type_of_a_listed_space_is_cached_and_forgotten_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (Path::new("/spaces/a"), Path::new("/spaces/b"));
        remember(dir.path(), a).unwrap();
        remember(dir.path(), b).unwrap();
        assert_eq!(kind(dir.path(), a), KIND_NOTES);
        set_kind(dir.path(), a, "organizacja").unwrap();
        assert_eq!(kind(dir.path(), a), "organizacja");
        assert_eq!(kind(dir.path(), b), KIND_NOTES);
        forget(dir.path(), a).unwrap();
        remember(dir.path(), a).unwrap();
        assert_eq!(kind(dir.path(), a), KIND_NOTES);
    }

    #[test]
    fn remember_forget_and_clear_keep_the_list_right() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (Path::new("/spaces/a"), Path::new("/spaces/b"));
        remember(dir.path(), a).unwrap();
        remember(dir.path(), b).unwrap();
        remember(dir.path(), a).unwrap();
        assert_eq!(spaces(dir.path()), vec![a.to_path_buf(), b.to_path_buf()]);
        assert_eq!(last_space(dir.path()), Some(a.to_path_buf()));

        forget(dir.path(), a).unwrap();
        assert_eq!(spaces(dir.path()), vec![b.to_path_buf()]);
        assert_eq!(last_space(dir.path()), None);

        remember(dir.path(), a).unwrap();
        clear_last(dir.path()).unwrap();
        assert_eq!(spaces(dir.path()), vec![a.to_path_buf(), b.to_path_buf()]);
        assert_eq!(last_space(dir.path()), None);
    }
}
