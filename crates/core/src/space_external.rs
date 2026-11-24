//! Changes made to `.md` files by other programs (ARCHITEKTURA §4.4, §4.6). Three texts are compared: the base
//! (what the app last wrote, `file_base`), the file on disk, and the CRDT text.

use std::fs;

use rusqlite::params;
use yrs::{Map, Transact};

use super::{META_DOC, NoteId, PATHS, Space};
use crate::github::{Merge3, merge3};
use crate::{Error, Result, space_meta};

/// What `external_change` did with the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalOutcome {
    /// The app wrote this text itself, or the file is as the app left it.
    Ignored,
    /// The file equals the CRDT text; only the record was updated.
    Unchanged,
    /// Only the file changed; its text became the note's (the old text is a version).
    Applied,
    /// Both sides changed different lines; the merged text is in the note and in the file.
    Merged,
    /// Both sides changed the same lines: nothing is written, the note waits for `resolve_conflict`.
    Conflict,
    /// A new file: a new note with its text.
    Created(NoteId),
}

impl Space {
    /// The note whose file is `rel_path`.
    fn note_at(&self, rel_path: &str) -> Option<NoteId> {
        let key = space_meta::key(rel_path);
        self.notes()
            .into_iter()
            .find(|(_, p)| space_meta::key(p) == key)
            .map(|(id, _)| id)
    }

    /// The text the app last wrote to the note's file.
    pub(super) fn base_text(&self, id: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .db
            .query_row(
                "SELECT text FROM file_base WHERE note_id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Reacts to the file `rel_path` now holding `disk` (the caller read it once the writer was done).
    pub fn external_change(&mut self, rel_path: &str, disk: &str) -> Result<ExternalOutcome> {
        let Some(id) = self.note_at(rel_path) else {
            return Ok(ExternalOutcome::Created(self.import_note(rel_path, disk)?));
        };
        let disk_hash = blake3::hash(disk.as_bytes());
        if self
            .tracked_file(&id)?
            .is_some_and(|(_, hash)| hash == disk_hash.as_bytes()[..])
        {
            // our own write; the path may still have changed, so the record is refreshed
            self.record_file(&id, rel_path, disk)?;
            return Ok(ExternalOutcome::Ignored);
        }
        if self.is_conflicted(&id)? {
            // every external text is kept, so a later edit of the file never replaces the one the user looked at
            self.store_version(&id, disk, "zmiana zewnętrzna – konflikt")?;
            self.set_conflict(&id, disk)?;
            return Ok(ExternalOutcome::Conflict);
        }
        let ours = self.text(&id)?;
        if ours == disk {
            self.record_file(&id, rel_path, disk)?;
            return Ok(ExternalOutcome::Unchanged);
        }
        // no base recorded (an older space): the file is taken as the new state, the old text is kept as a version
        let base = self.base_text(&id)?.unwrap_or_else(|| ours.clone());
        if base == ours {
            self.save_version(&id, "przed zmianą zewnętrzną")?;
            self.apply_text_diff(&id, disk)?;
            self.record_file(&id, rel_path, disk)?;
            return Ok(ExternalOutcome::Applied);
        }
        // the writes below are unguarded: the file's text was taken in above, and write_file would take it again
        if base == disk {
            // the file is still the base: only the app changed it, so the file catches up
            self.write_file_at_current(&id)?;
            return Ok(ExternalOutcome::Ignored);
        }
        match merge3(&base, &ours, disk) {
            Merge3::Clean(merged) => {
                self.save_version(&id, "przed zmianą zewnętrzną")?;
                self.apply_text_diff(&id, &merged)?;
                self.write_file_at_current(&id)?;
                Ok(ExternalOutcome::Merged)
            }
            Merge3::Conflict => {
                // nothing is overwritten: the disk keeps its text, the CRDT keeps ours, and the external text is a version
                self.store_version(&id, disk, "zmiana zewnętrzna – konflikt")?;
                self.set_conflict(&id, disk)?;
                Ok(ExternalOutcome::Conflict)
            }
        }
    }

    /// Writes a note after its rename. A conflicted note's file moves with it instead: it holds the other side's
    /// text, which the user has not chosen against yet, so it is neither overwritten nor left as an untracked copy.
    pub(super) fn write_renamed(&mut self, id: &str, from: &str, to: &str) -> Result<()> {
        if self.is_conflicted(id)? {
            return self.move_conflicted_file(id, from, to);
        }
        self.write_file(id).map(|_| ())
    }

    fn move_conflicted_file(&self, id: &str, from: &str, to: &str) -> Result<()> {
        if self.root.join(from).exists() {
            fs::rename(self.root.join(from), self.root.join(to))?;
        }
        self.db.execute(
            "UPDATE file_state SET path = ?2 WHERE note_id = ?1",
            params![id, to],
        )?;
        Ok(())
    }

    /// Writes the note's file as it is now, without taking in a change made outside (see `write_file`).
    pub(super) fn write_file_at_current(&mut self, id: &str) -> Result<()> {
        let path = self.path_of(id)?;
        self.write_file_at(id, &path)
    }

    /// A file deleted outside the app: its note goes to the trash.
    pub fn external_delete(&mut self, rel_path: &str) -> Result<()> {
        match self.note_at(rel_path) {
            Some(id) => self.delete_note(&id, super::lazy::now_ms() as i64),
            None => Ok(()),
        }
    }

    /// A file moved outside the app: its note keeps its id and gets the new path. The text follows the file.
    pub fn external_move(&mut self, from: &str, to: &str) -> Result<ExternalOutcome> {
        if !space_meta::is_valid_path(to) {
            return Err(Error::InvalidPath(to.to_string()));
        }
        self.check_writable()?;
        let abs = self.root.join(to);
        // a symlink or other non-file is never read: it could point anywhere
        if !fs::symlink_metadata(&abs)?.is_file() {
            return Err(Error::InvalidPath(to.to_string()));
        }
        let disk = fs::read_to_string(abs)?;
        let Some(id) = self.note_at(from) else {
            return self.external_change(to, &disk);
        };
        if self.note_at(to).is_some() {
            return Err(Error::PathTaken(to.to_string()));
        }
        let update = {
            let paths = self.meta.get_or_insert_map(PATHS);
            let mut txn = self.meta.transact_mut();
            paths.insert(&mut txn, id.as_str(), to.to_string());
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)?;
        self.external_change(to, &disk)
    }
}

#[cfg(test)]
#[path = "space_external_tests.rs"]
mod tests;
