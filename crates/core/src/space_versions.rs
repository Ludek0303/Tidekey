//! Local version history of notes and the conflict record (ARCHITEKTURA §4.4). Both live in space.db only:
//! they are never part of a message, so they are never synced.

use rusqlite::{OptionalExtension, params};
use yrs::Transact;

use super::lazy::now_ms;
use super::{ExternalOutcome, NoteId, Space};
use crate::{Error, Result, textdiff};

/// The hash of a text as the conflict screen refers to it (`resolve_conflict`'s `seen_theirs`).
pub fn text_hash(text: &str) -> String {
    hex::encode(blake3::hash(text.as_bytes()).as_bytes())
}

/// One saved version of a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionInfo {
    pub id: i64,
    pub time_ms: i64,
    pub reason: String,
}

impl Space {
    /// Saves the note's current text as a version, unless it equals the newest version. Returns the new id.
    pub fn save_version(&mut self, id: &str, reason: &str) -> Result<Option<i64>> {
        let text = self.text(id)?;
        self.store_version(id, &text, reason)
    }

    /// `save_version` for a text that is not the note's own (the external text of a conflict).
    pub(super) fn store_version(&self, id: &str, text: &str, reason: &str) -> Result<Option<i64>> {
        // zstd is deterministic, so equal texts give equal blobs and the newest one can be compared as bytes
        let blob = zstd::encode_all(text.as_bytes(), 0)?;
        let newest: Option<Vec<u8>> = self
            .db
            .query_row(
                "SELECT text_zstd FROM versions WHERE note = ?1 ORDER BY id DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if newest.as_deref() == Some(blob.as_slice()) {
            return Ok(None);
        }
        self.db.execute(
            "INSERT INTO versions (note, time_ms, reason, text_zstd) VALUES (?1, ?2, ?3, ?4)",
            params![id, now_ms() as i64, reason, blob],
        )?;
        Ok(Some(self.db.last_insert_rowid()))
    }

    /// The versions of a note, newest first.
    pub fn versions(&self, id: &str) -> Result<Vec<VersionInfo>> {
        let mut stmt = self
            .db
            .prepare("SELECT id, time_ms, reason FROM versions WHERE note = ?1 ORDER BY id DESC")?;
        let rows = stmt.query_map(params![id], |r| {
            Ok(VersionInfo {
                id: r.get(0)?,
                time_ms: r.get(1)?,
                reason: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn version_text(&self, vid: i64) -> Result<String> {
        let blob: Vec<u8> = self
            .db
            .query_row(
                "SELECT text_zstd FROM versions WHERE id = ?1",
                params![vid],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::UnknownVersion(vid))?;
        String::from_utf8(zstd::decode_all(&blob[..])?)
            .map_err(|_| Error::Layout("version text is not UTF-8"))
    }

    /// Restores an old version as edits. The current text is saved first, and the restored text is saved as a
    /// version of its own, so every later version stays in the history. Returns what the write took in from a file
    /// another program changed meanwhile, as `write_file` does.
    pub fn restore_version(&mut self, id: &str, vid: i64) -> Result<Option<ExternalOutcome>> {
        let old = self.version_text(vid)?;
        self.save_version(id, "przed przywróceniem")?;
        self.apply_text_diff(id, &old)?;
        self.store_version(id, &old, "przywrócono")?;
        self.write_file(id)
    }

    /// Makes the note's text `new` with CRDT edits that touch only what differs, as one message.
    pub(super) fn apply_text_diff(&mut self, id: &str, new: &str) -> Result<()> {
        self.check_writable()?;
        if self.text(id)? == new {
            return Ok(());
        }
        let update = {
            let doc = self.note_doc(id)?;
            let content = doc.get_or_insert_text("content");
            let mut txn = doc.transact_mut();
            textdiff::apply(&content, &mut txn, new);
            txn.encode_update_v1()
        };
        self.append(id, &update)
    }

    /// The text the other side left in the file, while the note is in conflict.
    pub fn conflict_theirs(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT theirs FROM conflicts WHERE note_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Notes in conflict: their file is not written until the conflict is resolved.
    pub fn conflicts(&self) -> Result<Vec<NoteId>> {
        let mut stmt = self
            .db
            .prepare("SELECT note_id FROM conflicts ORDER BY note_id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub(super) fn set_conflict(&self, id: &str, theirs: &str) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO conflicts (note_id, theirs) VALUES (?1, ?2)",
            params![id, theirs],
        )?;
        Ok(())
    }

    pub(super) fn is_conflicted(&self, id: &str) -> Result<bool> {
        Ok(self.conflict_theirs(id)?.is_some())
    }

    /// Sets the note's text to `text` (the user's choice), clears the conflict and writes the file. The text
    /// the note had before is saved as a version first. `seen_theirs` is `text_hash` of the file text the user
    /// chose against: when the file has changed since, nothing is done and the user chooses again.
    pub fn resolve_conflict(&mut self, id: &str, text: &str, seen_theirs: &str) -> Result<()> {
        let stored = self
            .conflict_theirs(id)?
            .ok_or_else(|| Error::NotInConflict(id.to_string()))?;
        // an edit of the file the view has not seen yet is taken in first: it becomes the conflict's other side
        let path = self.path_of(id)?;
        if let Some(disk) = self.foreign_text(id, &path)?
            && disk != stored
        {
            self.external_change(&path, &disk)?;
        }
        let theirs = self.conflict_theirs(id)?.unwrap_or(stored);
        if text_hash(&theirs) != seen_theirs {
            return Err(Error::ConflictChanged(id.to_string()));
        }
        self.save_version(id, "przed rozwiązaniem konfliktu")?;
        self.apply_text_diff(id, text)?;
        self.db
            .execute("DELETE FROM conflicts WHERE note_id = ?1", params![id])?;
        // unguarded: the file holds the other side's text, which the user has just chosen against
        self.write_file_at_current(id)
    }

    /// The CRDT text of a note, for the conflict view: `(ours, theirs)`.
    pub fn conflict_texts(&mut self, id: &str) -> Result<(String, String)> {
        let ours = self.text(id)?;
        let theirs = self
            .conflict_theirs(id)?
            .ok_or_else(|| Error::UnknownNote(id.to_string()))?;
        Ok((ours, theirs))
    }
}
