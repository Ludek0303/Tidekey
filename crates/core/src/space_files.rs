//! The `.md` files of a space: writing a note's file, and removing files that are no longer ours.
//! Only a file this device recorded in `file_state` is ever removed, and only if it is unchanged.

use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::time::UNIX_EPOCH;

use rusqlite::{OptionalExtension, params};
use yrs::{Map, Transact};

use super::external::ExternalOutcome;
use super::{DELETED, NoteId, Space};
use crate::atomic::write_atomic;
use crate::space_meta;
use crate::{Error, Result};

impl Space {
    /// Writes the note's `.md` file. A file another program changed since the app last wrote it is never
    /// overwritten: that change is taken in first (merge or conflict), then the file is written. Returns the outcome
    /// of the change taken in, None when there was none, so that the caller can tell the editor.
    pub fn write_file(&mut self, id: &str) -> Result<Option<ExternalOutcome>> {
        self.load_note(id)?;
        let path = self.path_of(id)?;
        let outcome = match self.foreign_text(id, &path)? {
            Some(disk) => Some(self.external_change(&path, &disk)?),
            None => None,
        };
        self.write_file_at(id, &path)?;
        Ok(outcome)
    }

    /// The text of the note's file when another program changed it since the app last wrote it. None when the
    /// file is ours, or missing (then nothing is there to overwrite). A file that is not a regular file (a link, a
    /// folder) is never read: it could point anywhere, so the write is refused.
    pub(super) fn foreign_text(&self, id: &str, path: &str) -> Result<Option<String>> {
        let Some((tracked, hash)) = self.tracked_file(id)?.filter(|(p, _)| p == path) else {
            return Ok(None);
        };
        let abs = self.root.join(&tracked);
        match fs::symlink_metadata(&abs) {
            Ok(meta) if !meta.is_file() => {
                return Err(Error::NotPlainFile(tracked));
            }
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
            Ok(_) => {}
        }
        let bytes = fs::read(&abs)?;
        if blake3::hash(&bytes).as_bytes()[..] == hash[..] {
            return Ok(None);
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| Error::NotPlainFile(tracked))
    }

    /// Paths of the live notes whose file has a different size or mtime than the app recorded: the files
    /// another program changed while the app was closed. The caller reads and compares them.
    pub fn files_changed_on_disk(&self) -> Result<Vec<String>> {
        let live: HashSet<NoteId> = self.notes().into_iter().map(|(id, _)| id).collect();
        let mut stmt = self
            .db
            .prepare("SELECT note_id, path, mtime_ns, size FROM file_state")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        let mut changed = Vec::new();
        for row in rows {
            let (id, path, mtime_ns, size) = row?;
            if !live.contains(&id) {
                continue;
            }
            // a missing file is not reported: deleting it is the watcher's business, not a start-up guess
            let Ok(meta) = fs::metadata(self.root.join(&path)) else {
                continue;
            };
            let disk_mtime = meta
                .modified()?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as i64;
            if disk_mtime != mtime_ns || meta.len() as i64 != size {
                changed.push(path);
            }
        }
        changed.sort();
        Ok(changed)
    }

    /// `write_file` for a path already resolved by the caller (see `refresh_meta`).
    pub(super) fn write_file_at(&mut self, id: &str, path: &str) -> Result<()> {
        // a note in conflict keeps the file the other side wrote until the user resolves it
        if self.is_conflicted(id)? {
            return Ok(());
        }
        let text = self.loaded_text(id)?;
        let abs = self.root.join(path);
        // the file at the last written path is ours to remove only if no other live note uses it now
        let stale = self
            .tracked_file(id)?
            .filter(|(old, _)| old != path && !self.used_by_other(id, old));
        // case-only rename: old and new may be one file on a case-insensitive disk, so drop the old name first
        let case_only = stale
            .as_ref()
            .is_some_and(|(old, _)| space_meta::key(old) == space_meta::key(path));
        if let (Some((old, hash)), true) = (&stale, case_only) {
            self.remove_if_unchanged(old, hash)?;
        }
        write_atomic(&abs, text.as_bytes())?;
        // the save itself succeeded; a leftover old file must not fail it or skip the file_state update
        if let (Some((old, hash)), false) = (&stale, case_only) {
            self.remove_if_unchanged(old, hash)
                .unwrap_or_else(|e| eprintln!("notes: could not remove {old}: {e}"));
        }

        self.record_file(id, path, &text)
    }

    /// Remembers the file of a note as it is on disk now, so that a later edit from outside is seen.
    pub(super) fn record_file(&self, id: &str, path: &str, text: &str) -> Result<()> {
        let abs = self.root.join(path);
        let mtime_ns = fs::metadata(&abs)?
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        let hash = blake3::hash(text.as_bytes());
        self.db.execute(
            "INSERT OR REPLACE INTO file_state (note_id, hash, mtime_ns, size, path) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, &hash.as_bytes()[..], mtime_ns, text.len() as i64, path],
        )?;
        self.db.execute(
            "INSERT OR REPLACE INTO file_base (note_id, text) VALUES (?1, ?2)",
            params![id, text],
        )?;
        Ok(())
    }

    /// Adopts a `.md` file that is already on disk: a note whose text is the file's text. The file is not
    /// rewritten; its state is recorded as it is. Used for the files of a folder opened for the first time.
    pub fn import_note(&mut self, rel_path: &str, text: &str) -> Result<NoteId> {
        if !space_meta::is_valid_path(rel_path) {
            return Err(Error::InvalidPath(rel_path.to_string()));
        }
        self.check_writable()?;
        if self
            .notes()
            .iter()
            .any(|(_, p)| space_meta::conflicts(p, rel_path))
        {
            return Err(Error::PathTaken(rel_path.to_string()));
        }
        let id = self.add_note(rel_path)?;
        if !text.is_empty() {
            self.insert_text(&id, 0, text)?;
        }
        self.record_file(&id, rel_path, text)?;
        Ok(id)
    }

    pub(super) fn tracked_file(&self, id: &str) -> Result<Option<(String, Vec<u8>)>> {
        let row = self
            .db
            .query_row(
                "SELECT path, hash FROM file_state WHERE note_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// Removes the note's last written file unless another live note now uses that path, then forgets
    /// the record. The record stays only when the removal failed, so the next open retries.
    pub(super) fn remove_tracked(&self, id: &str) -> Result<()> {
        let conflicted = self.is_conflicted(id)?;
        if let Some((path, hash)) = self
            .tracked_file(id)?
            .filter(|(p, _)| !self.used_by_other(id, p))
        {
            // a conflicted file holds the other side's text, which is saved as a version: it goes too
            if conflicted {
                self.remove_file_at(&path)?;
            } else {
                self.remove_if_unchanged(&path, &hash)?;
            }
        }
        self.db
            .execute("DELETE FROM file_state WHERE note_id = ?1", params![id])?;
        self.db
            .execute("DELETE FROM file_base WHERE note_id = ?1", params![id])?;
        self.db
            .execute("DELETE FROM conflicts WHERE note_id = ?1", params![id])?;
        Ok(())
    }

    fn remove_file_at(&self, rel: &str) -> Result<()> {
        match fs::remove_file(self.root.join(rel)) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    /// Removes a file only if it still holds the text we last wrote; a file the user edited is left alone.
    fn remove_if_unchanged(&self, rel: &str, hash: &[u8]) -> Result<()> {
        let abs = self.root.join(rel);
        match fs::read(&abs) {
            Ok(bytes) if blake3::hash(&bytes).as_bytes()[..] == *hash => {
                match fs::remove_file(&abs) {
                    Err(e) if e.kind() != ErrorKind::NotFound => Err(e.into()),
                    _ => Ok(()),
                }
            }
            Ok(_) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// True when a live note other than `id` now uses `path`.
    fn used_by_other(&self, id: &str, path: &str) -> bool {
        let key = space_meta::key(path);
        self.effective_paths()
            .iter()
            .any(|(other, p)| other.as_str() != id && space_meta::key(p) == key)
    }

    /// Finishes deletes that crashed after the log step but before the file was removed. Best effort:
    /// a failure is logged and retried on the next open, and never blocks opening the space.
    pub(super) fn sweep_deleted(&self) {
        let deleted: Vec<NoteId> = {
            let map = self.meta.get_or_insert_map(DELETED);
            let txn = self.meta.transact();
            map.iter(&txn).map(|(id, _)| id.to_string()).collect()
        };
        for id in deleted {
            if let Err(e) = self.remove_tracked(&id) {
                eprintln!("notes: could not finish deleting {id}: {e}");
            }
        }
    }
}
