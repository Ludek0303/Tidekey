//! Prioritized loading: on open, meta and the notes touched within `HOT_DAYS` are applied; every other note
//! stays pending (its messages stored, unchecked and unapplied) until it is read, edited, or drained by
//! `load_pending`. Authoring time and last use live in a local index (`doc_index`, `note_usage`).

use std::collections::{HashMap, HashSet};

use rusqlite::params;

use super::{META_DOC, NoteId, Space, apply, new_doc};
use crate::access::message_hash;
use crate::message;
use crate::{Error, Result};
use yrs::Doc;

/// One stored message as a replay reads it: device, seq, bytes, and the note it belongs to when indexed.
type ReplayRow = (Vec<u8>, i64, Vec<u8>, Option<NoteId>);

/// A note is hot when it was edited or opened within this many days.
pub const HOT_DAYS: i64 = 60;
pub(crate) const DAY_MS: i64 = 86_400_000;

#[cfg(test)]
thread_local! {
    /// Tests set the clock to make notes old or recent; see `now_ms`.
    pub static CLOCK: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Applies one stored update; one that the document refuses is recorded as rejected and skipped. The row
/// stays, so a later open can try again. No single message fails a note, the drain, or the open.
fn apply_or_reject(
    doc: &Doc,
    payload: &[u8],
    at: ([u8; 32], u64),
    rejected: &mut Vec<([u8; 32], u64, String)>,
) {
    if let Err(e) = apply(doc, payload) {
        rejected.push((at.0, at.1, format!("cannot apply: {e}")));
    }
}

/// Milliseconds since the Unix epoch, now (or the test clock).
pub(crate) fn now_ms() -> u64 {
    #[cfg(test)]
    if let Some(t) = CLOCK.with(|c| c.get()) {
        return t;
    }
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

impl Space {
    /// Rebuilds the meta and the hot notes from the stored messages. Meta is always replayed in full. A note
    /// outside the hot window is recorded as pending, and its messages are not checked until it is loaded.
    /// A database whose index is incomplete (an older layout) is replayed in full, which fills the index.
    pub(super) fn replay(&mut self) -> Result<()> {
        self.observe_meta_fresh();
        self.notes.clear();
        self.pending.clear();
        let indexed = self.index_complete()?;
        let hot = if indexed {
            Some(self.hot_docs()?)
        } else {
            None
        };
        let rows = self.replay_rows(indexed)?;
        let me = self.device.verifying_key().to_bytes();
        let mut next_seq = 1;
        let mut rejected = Vec::new();
        for (row_device, row_seq, bytes, indexed_doc) in rows {
            if row_device[..] == me[..] {
                next_seq = next_seq.max(row_seq as u64 + 1);
            }
            if let (Some(doc), Some(hot)) = (&indexed_doc, &hot)
                && doc != META_DOC
                && !hot.contains(doc)
            {
                self.pending.insert(doc.clone());
                continue;
            }
            // a message with an unknown epoch still has its signed header, so its seq stays reserved
            let m = match message::open(&bytes, &self.space_id, |e| self.access.key(e)) {
                Ok(m) => m,
                Err(Error::NoEpochKey(h)) => {
                    rejected.push((h.device, h.seq, format!("no key for epoch {}", h.epoch)));
                    continue;
                }
                Err(e) => return Err(e),
            };
            // the row key must match the signed header, or a row could be replayed under another (device, seq)
            if m.header.device[..] != row_device[..] || m.header.seq != row_seq as u64 {
                return Err(Error::BadMessage {
                    seq: m.header.seq,
                    reason: "row does not match header",
                });
            }
            if !indexed {
                self.index_row(&row_device, row_seq, &m.doc, m.time_ms)?;
            }
            if let Err(reason) = self.access.accept(&m.header, &message_hash(&bytes)) {
                rejected.push((m.header.device, m.header.seq, reason));
                continue;
            }
            if let Err(reason) = self.access.accept_document(&m.header, &m.doc) {
                rejected.push((m.header.device, m.header.seq, reason));
                continue;
            }
            let at = (m.header.device, m.header.seq);
            if m.doc == META_DOC {
                apply_or_reject(&self.meta, &m.payload, at, &mut rejected);
            } else {
                let doc = self.notes.entry(m.doc).or_insert_with(new_doc);
                apply_or_reject(doc, &m.payload, at, &mut rejected);
            }
        }
        self.create_missing_note_docs();
        self.next_seq = next_seq;
        self.rejected = rejected;
        Ok(())
    }

    /// Message rows for a replay, with their indexed doc when the index exists.
    fn replay_rows(&self, indexed: bool) -> Result<Vec<ReplayRow>> {
        // every stored row is read by its own key; a row the index does not match is checked in full
        let sql = if indexed {
            "SELECT m.device, m.seq, m.bytes, d.doc FROM messages m \
             LEFT JOIN doc_index d ON d.device = m.device AND d.seq = m.seq ORDER BY m.device, m.seq"
        } else {
            "SELECT device, seq, bytes, NULL FROM messages ORDER BY device, seq"
        };
        let mut stmt = self.db.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn index_row(&self, device: &[u8], seq: i64, doc: &str, time_ms: u64) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO doc_index (device, seq, doc, time_ms) VALUES (?1, ?2, ?3, ?4)",
            params![device, seq, doc, time_ms as i64],
        )?;
        Ok(())
    }

    /// True when the index has a row for every stored message.
    fn index_complete(&self) -> Result<bool> {
        let (messages, indexed): (i64, i64) = self.db.query_row(
            "SELECT (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM doc_index)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(messages == indexed)
    }

    /// Notes that are hot now: edited within the window (by their newest message), or used within it.
    fn hot_docs(&self) -> Result<HashSet<NoteId>> {
        let cutoff = now_ms() as i64 - HOT_DAYS * DAY_MS;
        let mut stmt = self.db.prepare(
            "SELECT doc FROM doc_index GROUP BY doc HAVING MAX(time_ms) >= ?1 \
             UNION SELECT doc FROM note_usage WHERE last_used_ms >= ?1",
        )?;
        let docs = stmt.query_map(params![cutoff], |r| r.get(0))?;
        Ok(docs.collect::<rusqlite::Result<_>>()?)
    }

    /// Whether a message's authoring time puts its note in the hot window.
    pub(super) fn is_hot_time(&self, time_ms: u64) -> bool {
        time_ms as i64 >= now_ms() as i64 - HOT_DAYS * DAY_MS
    }

    /// Applies a pending note's stored messages, checks them as `replay` does, and writes its file.
    /// A note that is not pending is left alone.
    pub(super) fn load_note(&mut self, id: &str) -> Result<()> {
        if !self.pending.remove(id) {
            // a note known from meta whose content never arrived is empty, and gets its document now
            // (only when no messages are stored for it: stored messages that were not loaded are not empty)
            let known = self
                .mirror
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .paths
                .contains_key(id);
            let indexed: bool = self.db.query_row(
                "SELECT EXISTS (SELECT 1 FROM doc_index WHERE doc = ?1)",
                params![id],
                |r| r.get(0),
            )?;
            if known && !indexed && !self.notes.contains_key(id) {
                self.notes.insert(id.to_string(), new_doc());
                self.refresh_note(id);
            }
            return Ok(());
        }
        match self.apply_stored_note(id) {
            Ok(doc) => {
                self.failed.remove(id);
                self.notes.insert(id.to_string(), doc);
                self.refresh_note(id);
                Ok(())
            }
            Err(e) => {
                // stays pending, so the file and the note are left as they were; the next open tries again
                self.pending.insert(id.to_string());
                self.failed.insert(id.to_string());
                Err(e)
            }
        }
    }

    fn apply_stored_note(&mut self, id: &str) -> Result<Doc> {
        let rows: Vec<(Vec<u8>, i64, Vec<u8>)> = {
            let mut stmt = self.db.prepare(
                "SELECT m.device, m.seq, m.bytes FROM doc_index d \
                 JOIN messages m ON m.device = d.device AND m.seq = d.seq \
                 WHERE d.doc = ?1 ORDER BY m.device, m.seq",
            )?;
            let rows = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let doc = new_doc();
        for (row_device, row_seq, bytes) in rows {
            let m = match message::open(&bytes, &self.space_id, |e| self.access.key(e)) {
                Ok(m) => m,
                Err(Error::NoEpochKey(h)) => {
                    self.rejected
                        .push((h.device, h.seq, format!("no key for epoch {}", h.epoch)));
                    continue;
                }
                // a row that does not match its own header, or a message of another note: refused, as in replay
                Err(e) => {
                    // a malformed device blob is listed as device zero: the row itself is what is refused
                    let device = <[u8; 32]>::try_from(row_device.as_slice()).unwrap_or([0; 32]);
                    self.rejected.push((device, row_seq as u64, e.to_string()));
                    continue;
                }
            };
            let at = (m.header.device, m.header.seq);
            if m.header.device[..] != row_device[..]
                || m.header.seq != row_seq as u64
                || m.doc != id
            {
                self.rejected.push((
                    at.0,
                    at.1,
                    "row does not match its header or note".to_string(),
                ));
                continue;
            }
            if let Err(reason) = self.access.accept(&m.header, &message_hash(&bytes)) {
                self.rejected.push((at.0, at.1, reason));
                continue;
            }
            if let Err(reason) = self.access.accept_document(&m.header, &m.doc) {
                self.rejected.push((at.0, at.1, reason));
                continue;
            }
            apply_or_reject(&doc, &m.payload, at, &mut self.rejected);
        }
        Ok(doc)
    }

    /// Notes whose content is not in memory yet: stored messages waiting to be applied, or known from meta
    /// with no content loaded. `load_pending` drains them.
    pub fn pending_count(&self) -> usize {
        self.unloaded().len()
    }

    fn unloaded(&self) -> Vec<NoteId> {
        let m = self.mirror.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<NoteId> = self.pending.difference(&self.failed).cloned().collect();
        ids.extend(
            m.paths
                .keys()
                .filter(|id| {
                    !self.notes.contains_key(*id)
                        && !self.pending.contains(*id)
                        && !self.failed.contains(*id)
                })
                .cloned(),
        );
        ids
    }

    /// Notes whose content is in memory.
    pub fn loaded_count(&self) -> usize {
        self.notes.len()
    }

    /// Loads up to `max_notes` pending notes, most recently edited first, and returns how many it loaded.
    /// A note that fails to load is logged and left out of the queue; the rest still load.
    // shortcut: nothing calls this yet; the app must call it in the background until it returns 0, or cold notes get their files only when opened
    pub fn load_pending(&mut self, max_notes: usize) -> Result<usize> {
        let times: HashMap<NoteId, i64> = {
            let mut stmt = self
                .db
                .prepare("SELECT doc, MAX(time_ms) FROM doc_index GROUP BY doc")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut ids = self.unloaded();
        ids.sort_by_key(|id| std::cmp::Reverse(times.get(id).copied().unwrap_or(0)));
        ids.truncate(max_notes);
        let mut loaded = 0;
        for id in &ids {
            match self.load_note(id) {
                Ok(()) => loaded += 1,
                Err(e) => eprintln!(
                    "notes: could not load {id}, it stays unloaded until the next open: {e}"
                ),
            }
        }
        Ok(loaded)
    }

    /// Records that a note was used now, so that it stays hot for the next open. Does not load it.
    pub fn touch(&mut self, id: &str, now_ms: u64) -> Result<()> {
        self.db.execute(
            "INSERT INTO note_usage (doc, last_used_ms) VALUES (?1, ?2) \
             ON CONFLICT(doc) DO UPDATE SET last_used_ms = MAX(last_used_ms, excluded.last_used_ms)",
            params![id, now_ms as i64],
        )?;
        Ok(())
    }
}
