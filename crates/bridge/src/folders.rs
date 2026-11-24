//! What is on disk under the space root: the walk that finds `.md` files and folders, and the folder rules.

use std::fs;
use std::io;
use std::path::Path;

/// Files and folders under the root, as '/'-separated paths relative to it. Hidden entries (names starting
/// with a dot, `.notes-sync` included) are left out with everything under them.
#[derive(Default)]
pub struct Scan {
    pub files: Vec<String>,
    pub dirs: Vec<String>,
}

pub fn scan(root: &Path) -> io::Result<Scan> {
    scan_under(root, "")
}

/// `scan` of the folder `rel` under the root (`""` is the root itself). Paths in the result are relative to the root.
pub fn scan_under(root: &Path, rel: &str) -> io::Result<Scan> {
    let mut out = Scan::default();
    walk(root, &root.join(rel), &mut out)?;
    out.files.sort();
    out.dirs.sort();
    Ok(out)
}

/// True when no component of `rel` under `root` is a symlink. Components that do not exist yet are fine.
pub fn no_symlinks(root: &Path, rel: &str) -> bool {
    let mut abs = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        abs.push(part);
        match fs::symlink_metadata(&abs) {
            Ok(meta) if meta.file_type().is_symlink() => return false,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    true
}

/// True when `rel` is a regular file under the root, reached without any symlink on the way.
pub fn is_plain_file(root: &Path, rel: &str) -> bool {
    no_symlinks(root, rel) && root.join(rel).is_file()
}

fn walk(root: &Path, dir: &Path, out: &mut Scan) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            if let Some(rel) = rel_of(root, &path) {
                out.dirs.push(rel);
            }
            walk(root, &path, out)?;
        } else if file_type.is_file()
            && name.ends_with(".md")
            && let Some(rel) = rel_of(root, &path)
        {
            out.files.push(rel);
        }
    }
    Ok(())
}

/// `path` as a relative path under `root`, with `/` separators; None for names that are not UTF-8.
pub fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = rel.iter().map(|s| s.to_str()).collect();
    Some(parts?.join("/"))
}

/// A folder is valid when a note inside it would be: the core's path rules apply to every segment.
/// Hidden folders are refused, since they would never show in the tree.
pub fn valid(path: &str) -> bool {
    !path.split('/').any(|s| s.starts_with('.'))
        && notes_core::is_valid_path(&format!("{path}/_.md"))
}

/// Removes `dir` and the folders under it that are empty, deepest first. Folders that still hold a file stay.
pub fn remove_empty_dirs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            remove_empty_dirs(&entry.path());
        }
    }
    // a folder that is not empty, or that cannot be removed now, is left as it is
    let _ = fs::remove_dir(dir);
}
