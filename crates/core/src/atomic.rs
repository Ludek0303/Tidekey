use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::path::Path;

/// Writes `bytes` to `path` via a temp file in the same directory, fsynced, then renamed over `path`.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let mut suffix = [0u8; 4];
    getrandom::fill(&mut suffix).map_err(|e| io::Error::other(e.to_string()))?;
    let tmp = dir.join(format!(".{name}.tmp-{}", hex::encode(suffix)));

    let result = write_and_rename(&tmp, path, bytes).and_then(|()| sync_dir(dir));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_and_rename(tmp: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create_new(tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    rename_replace(tmp, path)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn rename_replace(from: &Path, to: &Path) -> io::Result<()> {
    // Windows reports PermissionDenied while another process (AV, indexer) holds the target open.
    let mut result = fs::rename(from, to);
    for ms in [50u64, 100, 200, 400, 800] {
        if !matches!(&result, Err(e) if e.kind() == ErrorKind::PermissionDenied) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(ms));
        result = fs::rename(from, to);
    }
    result
}

#[cfg(not(windows))]
fn rename_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/note.md");
        write_atomic(&path, b"first").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");
    }

    #[test]
    fn overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_atomic(&path, b"a").unwrap();
        write_atomic(&path, b"b").unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }
}
