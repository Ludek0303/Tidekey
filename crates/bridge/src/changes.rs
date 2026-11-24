//! Changes made to the space folder by other programs, applied to the notes, and what the UI must hear about
//! (ARCHITEKTURA §4.4, §4.6). A changed file waits 200 ms until it is quiet; a file that disappeared waits 2 s,
//! because a file that comes back with the same text under another name is a move, not a deletion.

use std::collections::HashMap;
use std::fs;

use notes_core::ExternalOutcome;

use crate::backend::Backend;
use crate::error::Result;
use crate::folders;

/// A file is read once it has not changed for this long.
pub const DEBOUNCE_MS: u64 = 200;
/// A vanished file is deleted (moved to the trash) only after this long.
pub const GONE_MS: u64 = 2_000;
/// Versions are saved after this long without edits.
pub const AUTOSAVE_QUIET_MS: u64 = 120_000;
/// Paths settled per tick, so that a burst (a checkout, a sync tool) is spread over many ticks and the UI stays
/// responsive while the backend lock is held.
pub const SETTLE_BATCH: usize = 200;

/// What the UI must do. Serialized as `{"name": ..., "payload": ...}`, the event name and its data.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "name", content = "payload", rename_all = "snake_case")]
pub enum Change {
    /// The tree of notes changed: reload it.
    TreeChanged,
    /// The note's full Yjs state: apply it to the open editor (it merges, so no cursor is lost).
    NoteUpdate { id: String, update: Vec<u8> },
    /// The note is in conflict: show the conflict screen.
    Conflict { id: String },
}

impl Backend {
    /// The UI's pending changes, oldest first.
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.changes)
    }

    /// Applies the file changes that have settled, the deletions that waited long enough, and the autosave of
    /// versions. Called by `tick`.
    pub(crate) fn apply_watch(&mut self, now: u64) -> Result<()> {
        for (rel, created) in self.watch.touched(&self.root) {
            self.queue(rel, created, now)?;
        }
        let due = self.due(now);
        let expired: Vec<String> = self
            .gone
            .iter()
            .filter(|(_, at)| now >= **at)
            .map(|(rel, _)| rel.clone())
            .collect();
        if !due.is_empty() || !expired.is_empty() {
            // one path -> id map per tick; the paths that change during the tick are kept in step with it
            let mut by_path: HashMap<String, String> = self
                .opened
                .space
                .notes()
                .into_iter()
                .map(|(id, path)| (path, id))
                .collect();
            for rel in due {
                self.changed.remove(&rel);
                self.settle(&rel, now, &mut by_path)?;
            }
            for rel in expired {
                self.expire(&rel, &mut by_path)?;
            }
        }
        self.autosave_versions(now)
    }

    /// Records what a watcher event says about `rel`: a changed note file, every note file under a folder that was
    /// created or renamed (a walk, so a moved folder keeps its notes), or the notes under a folder that vanished.
    fn queue(&mut self, rel: String, created: bool, now: u64) -> Result<()> {
        let abs = self.root.join(&rel);
        // a link to a folder is not walked: its files are outside the space
        if fs::symlink_metadata(&abs).is_ok_and(|m| m.is_dir()) {
            if created {
                for file in folders::scan_under(&self.root, &rel)?.files {
                    self.changed.insert(file, now);
                }
            }
            return Ok(());
        }
        if !abs.exists() {
            // a folder that vanished takes its notes' files with it: each of them is looked at as well
            let prefix = format!("{rel}/");
            for (_, path) in self.opened.space.notes() {
                if path.starts_with(&prefix) {
                    self.changed.insert(path, now);
                }
            }
        }
        if rel.ends_with(".md") && notes_core::is_valid_path(&rel) {
            self.changed.insert(rel, now);
        }
        Ok(())
    }

    /// The paths whose debounce has passed, at most `SETTLE_BATCH`. Vanished paths come first, so that a moved
    /// note's new path finds the note it came from.
    fn due(&self, now: u64) -> Vec<String> {
        let mut due: Vec<String> = self
            .changed
            .iter()
            .filter(|(_, at)| now >= **at + DEBOUNCE_MS)
            .map(|(rel, _)| rel.clone())
            .collect();
        due.sort_by_key(|rel| self.root.join(rel).exists());
        due.truncate(SETTLE_BATCH);
        due
    }

    /// Looks at one path after it has been quiet: an edited note, a new file, a file that moved, or a file that
    /// vanished.
    fn settle(&mut self, rel: &str, now: u64, by_path: &mut HashMap<String, String>) -> Result<()> {
        let note = by_path.get(rel).cloned();
        if !self.root.join(rel).exists() {
            if let Some(id) = note {
                self.vanish(&id, rel, now)?;
            }
            return Ok(());
        }
        self.gone.remove(rel);
        // a symlink or a folder is never read: it could point anywhere
        if !folders::is_plain_file(&self.root, rel) {
            return Ok(());
        }
        let Ok(text) = fs::read_to_string(self.root.join(rel)) else {
            eprintln!("notes: {rel} is not UTF-8 text, it was not read");
            return Ok(());
        };
        if let Some(id) = note {
            let outcome = self.opened.space.external_change(rel, &text)?;
            return self.report(Some(id), outcome);
        }
        // a new path: if a note whose file is gone holds this very text, the file was moved
        if let Some((id, from)) = self.moved_from(&text, rel, by_path) {
            let outcome = self.opened.space.external_move(&from, rel)?;
            self.gone.remove(&from);
            by_path.remove(&from);
            by_path.insert(rel.to_string(), id.clone());
            self.changes.push(Change::TreeChanged);
            return self.report(Some(id), outcome);
        }
        let outcome = self.opened.space.external_change(rel, &text)?;
        if let ExternalOutcome::Created(id) = &outcome {
            by_path.insert(rel.to_string(), id.clone());
        }
        self.report(None, outcome)
    }

    /// A note whose file is gone: it waits `GONE_MS` for its file to come back under another name. Its text is
    /// remembered by hash, so a new file with that text finds it without a scan of every note.
    fn vanish(&mut self, id: &str, rel: &str, now: u64) -> Result<()> {
        if self.gone.contains_key(rel) {
            return Ok(());
        }
        let text = self.opened.space.text(id)?;
        self.vanished
            .entry(notes_core::text_hash(&text))
            .or_default()
            .push((id.to_string(), rel.to_string()));
        self.gone.insert(rel.to_string(), now + GONE_MS);
        Ok(())
    }

    /// The note that was at a vanished path and has this text, with that path. The entry is taken out.
    fn moved_from(
        &mut self,
        text: &str,
        to: &str,
        by_path: &HashMap<String, String>,
    ) -> Option<(String, String)> {
        let entries = self.vanished.get_mut(&notes_core::text_hash(text))?;
        let at = entries.iter().position(|(id, from)| {
            from != to && by_path.get(from) == Some(id) && !self.root.join(from).exists()
        })?;
        Some(entries.swap_remove(at))
    }

    /// A vanished file whose wait is over: its note goes to the trash, unless the file came back.
    fn expire(&mut self, rel: &str, by_path: &mut HashMap<String, String>) -> Result<()> {
        self.gone.remove(rel);
        if self.root.join(rel).exists() {
            return Ok(());
        }
        if let Some(id) = by_path.remove(rel) {
            self.opened.space.external_delete(rel)?;
            self.search.remove(&id)?;
            self.changes.push(Change::TreeChanged);
        }
        self.vanished.retain(|_, entries| {
            entries.retain(|(id, from)| by_path.get(from) == Some(id));
            !entries.is_empty()
        });
        Ok(())
    }

    /// Tells the UI and the index what an external change did to a note.
    pub(crate) fn report(&mut self, id: Option<String>, outcome: ExternalOutcome) -> Result<()> {
        match outcome {
            ExternalOutcome::Created(id) => {
                self.search.mark(&id);
                self.changes.push(Change::TreeChanged);
            }
            ExternalOutcome::Applied | ExternalOutcome::Merged => {
                if let Some(id) = id {
                    self.search.mark(&id);
                    self.note_update(&id)?;
                }
            }
            ExternalOutcome::Conflict => {
                if let Some(id) = id {
                    self.changes.push(Change::Conflict { id });
                }
            }
            ExternalOutcome::Ignored | ExternalOutcome::Unchanged => {}
        }
        Ok(())
    }

    /// Queues the full Yjs state of a note for the UI.
    pub(crate) fn note_update(&mut self, id: &str) -> Result<()> {
        let update = self.opened.space.state(id)?;
        self.changes.push(Change::NoteUpdate {
            id: id.to_string(),
            update,
        });
        Ok(())
    }

    /// Saves a version of every note edited since the last quiet period of `AUTOSAVE_QUIET_MS`.
    fn autosave_versions(&mut self, now: u64) -> Result<()> {
        let Some(last) = self.last_edit else {
            return Ok(());
        };
        if now < last + AUTOSAVE_QUIET_MS {
            return Ok(());
        }
        for id in std::mem::take(&mut self.edited) {
            self.opened.space.save_version(&id, "automatycznie")?;
        }
        self.last_edit = None;
        Ok(())
    }
}

#[cfg(test)]
#[path = "changes_tests.rs"]
mod tests;
