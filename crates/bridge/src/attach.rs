//! Attachments: files pasted or dropped into a note, kept in `assets/` of the space (§4.4 of the UI plan).
//! Names and paths are checked here, so that nothing outside the space, and nothing hidden, can be read or written.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{BridgeError, Result};
use crate::folders;

/// Largest attachment accepted.
pub const MAX_SIZE: usize = 50 * 1024 * 1024;
const DIR: &str = "assets";

/// Writes `bytes` as `assets/<name>`, with " (2)", " (3)"... before the extension when the name is taken. Returns
/// the relative path.
pub fn save(root: &Path, name: &str, bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_SIZE {
        return Err(BridgeError::new(
            "too_large",
            "Załącznik jest większy niż 50 MB.",
        ));
    }
    if !valid_name(name) {
        return Err(BridgeError::new(
            "invalid_path",
            format!("Nieprawidłowa nazwa pliku: {name}"),
        ));
    }
    let dir = root.join(DIR);
    fs::create_dir_all(&dir)?;
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut candidate = name.to_string();
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    notes_core::write_atomic(&dir.join(&candidate), bytes)?;
    Ok(format!("{DIR}/{candidate}"))
}

/// The bytes of `rel` (a path returned by `save`). Only plain paths under `assets/` are read.
pub fn read(root: &Path, rel: &str) -> Result<Vec<u8>> {
    let abs = safe_path(root, rel)?;
    let len = fs::metadata(&abs)?.len();
    if len > MAX_SIZE as u64 {
        return Err(BridgeError::new(
            "too_large",
            "Załącznik jest większy niż 50 MB.",
        ));
    }
    Ok(fs::read(abs)?)
}

fn safe_path(root: &Path, rel: &str) -> Result<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let plain = parts.first() == Some(&DIR)
        && parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && !p.starts_with('.') && !p.contains(['\\', ':']));
    if !plain || !folders::no_symlinks(root, rel) {
        return Err(BridgeError::new(
            "invalid_path",
            format!("Nieprawidłowa ścieżka: {rel}"),
        ));
    }
    Ok(root.join(rel))
}

/// A file name the core accepts as a note name (its reserved words and characters, no hidden names).
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\'])
        && notes_core::is_valid_path(&format!("{DIR}/{name}.md"))
}

#[cfg(test)]
#[path = "attach_tests.rs"]
mod tests;
