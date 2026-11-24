//! The message log of a space: replay on open, local appends, and messages received from other devices.
//! Every message goes through `Access::accept` before it is stored; what is stored are the exact bytes.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{OptionalExtension, params};
use yrs::updates::decoder::Decode;
use yrs::{Any, Map, MapRef, Observable, Out, TransactionMut, Update};

use super::lazy::now_ms;
use super::{DELETED, META_DOC, MetaMirror, NoteId, PATHS, PURGED, Space, apply, new_doc, random};
use crate::access::{Header, message_hash};
use crate::message::{self, SpaceKey};
use crate::{Error, Result};

/// What one `receive_batch` changed, so that the files and the meta are refreshed once for all of it.
#[derive(Default)]
struct Batch {
    meta: bool,
    touched: Vec<NoteId>,
}

/// Outcome of `Space::receive` for a message that passed every check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Received {
    /// Stored and applied.
    Applied,
    /// Already stored with the same bytes; nothing changed.
    Known,
}

impl Space {
    /// Takes a message from another device: decrypts it, checks the access rules and the payload, stores
    /// the exact bytes, then applies it (or leaves a cold note's message for its load). A message that
    /// fails a check is neither applied nor stored. Failing to write a `.md` file is logged, not returned.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<Received> {
        self.receive_batch(&[bytes])?
            .pop()
            .unwrap_or(Ok(Received::Known))
    }

    /// `receive` for many messages at once: one pass over the meta and the files for the whole batch, not
    /// one per message. Each message gets its own outcome, in order.
    pub fn receive_batch<B: AsRef<[u8]>>(&mut self, msgs: &[B]) -> Result<Vec<Result<Received>>> {
        let before = self.effective();
        let mut batch = Batch::default();
        let outcomes: Vec<Result<Received>> = msgs
            .iter()
            .map(|m| self.receive_one(m.as_ref(), &mut batch))
            .collect();
        if batch.meta {
            self.refresh_meta(before);
        }
        for id in batch.touched {
            self.refresh_note(&id);
        }
        Ok(outcomes)
    }

    fn receive_one(&mut self, bytes: &[u8], batch: &mut Batch) -> Result<Received> {
        // one (device, seq) has one message: the same bytes again change nothing, other bytes are a fork.
        // The header is only a lookup key here, so a message we already hold is not verified again.
        if let Some((device, seq)) = message::peek(bytes) {
            let stored: Option<Vec<u8>> = self
                .db
                .query_row(
                    "SELECT bytes FROM messages WHERE device = ?1 AND seq = ?2",
                    params![&device[..], seq as i64],
                    |r| r.get(0),
                )
                .optional()?;
            match stored {
                Some(old) if old == bytes => return Ok(Received::Known),
                Some(_) => {
                    return Err(Error::BadMessage {
                        seq,
                        reason: "same device and seq with other bytes",
                    });
                }
                None => {}
            }
        }
        let m = message::open(bytes, &self.space_id, |e| self.access.key(e))?;
        let h = m.header;
        self.access
            .accept(&h, &message_hash(bytes))
            .map_err(|reason| Error::Denied { seq: h.seq, reason })?;
        self.access.accept_document(&h, &m.doc)
            .map_err(|reason| Error::Denied { seq: h.seq, reason })?;
        Update::decode_v1(&m.payload).map_err(|_| Error::BadMessage {
            seq: h.seq,
            reason: "malformed update",
        })?;
        self.store(&h.device, h.seq, bytes, &m.doc, m.time_ms)?;
        // a device key reused by a new join (or a restored folder) must not reuse seqs of its own messages
        // shortcut: a join on the same computer that edits before its first sync can still take seqs the old messages use (a fork); fetch own messages first
        if h.device == self.device.verifying_key().to_bytes() {
            self.next_seq = self.next_seq.max(h.seq + 1);
        }
        if let Err(e) = self.apply_received(&m.doc, &m.payload, m.time_ms, &mut batch.touched) {
            // stored but not applicable: forget the row so the next open does not replay it
            self.forget(&h.device, h.seq)?;
            return Err(e);
        }
        if m.doc == META_DOC {
            batch.meta = true;
        }
        Ok(Received::Applied)
    }

    /// Applies one received update: meta always; a note's content when it is loaded or hot, and otherwise
    /// only its message is kept (the note is pending until it is loaded).
    fn apply_received(
        &mut self,
        doc: &str,
        payload: &[u8],
        time_ms: u64,
        touched: &mut Vec<NoteId>,
    ) -> Result<()> {
        if doc == META_DOC {
            return apply(&self.meta, payload);
        }
        if !self.notes.contains_key(doc) {
            if self.pending.contains(doc) {
                return Ok(());
            }
            if !self.is_hot_time(time_ms) {
                self.pending.insert(doc.to_string());
                return Ok(());
            }
        }
        apply(
            self.notes.entry(doc.to_string()).or_insert_with(new_doc),
            payload,
        )?;
        touched.push(doc.to_string());
        Ok(())
    }

    /// Per device, the highest seq such that `1..=seq` are all stored; a device with a gap before its
    /// first stored message is left out. Tells a peer what this device already has.
    pub fn version_vector(&self) -> Result<Vec<([u8; 32], u64)>> {
        let mut stmt = self
            .db
            .prepare("SELECT device, seq FROM messages ORDER BY device, seq")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)))?;
        let mut vv: Vec<([u8; 32], u64)> = Vec::new();
        for row in rows {
            let (device, seq) = row?;
            let device: [u8; 32] = device
                .try_into()
                .map_err(|_| Error::Layout("device key length"))?;
            if vv.last().is_none_or(|(d, _)| *d != device) {
                vv.push((device, 0));
            }
            if let Some((_, n)) = vv.last_mut().filter(|(_, n)| seq as u64 == *n + 1) {
                *n += 1;
            }
        }
        vv.retain(|(_, n)| *n > 0);
        Ok(vv)
    }

    /// Stored messages newer than `vv` (per device; 0 for a device it lacks), in device and seq order.
    /// Stops once `max_bytes` is reached and always returns at least one message when one is missing.
    pub fn messages_after(&self, vv: &[([u8; 32], u64)], max_bytes: usize) -> Result<Vec<Vec<u8>>> {
        let seen: HashMap<[u8; 32], u64> = vv.iter().copied().collect();
        let mut stmt = self
            .db
            .prepare("SELECT device, seq, bytes FROM messages ORDER BY device, seq")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        let mut total = 0;
        for row in rows {
            let (device, seq, bytes) = row?;
            let device: [u8; 32] = device
                .try_into()
                .map_err(|_| Error::Layout("device key length"))?;
            if seq as u64 <= seen.get(&device).copied().unwrap_or(0) {
                continue;
            }
            total += bytes.len();
            out.push(bytes);
            if total >= max_bytes {
                break;
            }
        }
        Ok(out)
    }

    /// Encrypts, signs and persists one local update. Committed before returning; `next_seq` advances only on success.
    /// The caller has already changed the documents in memory, so a refused or unstored update rebuilds them
    /// from the log: what the log does not hold must not stay visible.
    pub(super) fn append(&mut self, doc: &str, payload: &[u8]) -> Result<()> {
        self.append_audited(doc, payload, &[])
    }

    pub(super) fn append_audited(&mut self, doc: &str, payload: &[u8], audit: &[u8]) -> Result<()> {
        self.append_stored(doc, payload, audit).inspect_err(|_| {
            if let Err(e) = self.replay() {
                eprintln!("notes: could not rebuild the notes from the log: {e}");
            }
        })
    }

    fn append_stored(&mut self, doc: &str, payload: &[u8], audit: &[u8]) -> Result<()> {
        let (epoch, key) = self.access.current().ok_or(Error::NoCurrentKey)?;
        let device = self.device.verifying_key().to_bytes();
        let seq = self.next_seq;
        let space = SpaceKey {
            id: self.space_id,
            epoch,
            key: *key,
        };
        let bytes = if audit.is_empty() {
            message::seal(&self.device, &space, seq, random()?, doc, payload, now_ms())?
        } else {
            message::seal_audited(&self.device, &space, seq, random()?, doc, payload, now_ms(), audit)?
        };
        let hdr = Header {
            space: self.space_id,
            device,
            seq,
            epoch,
        };
        self.access
            .accept(&hdr, &message_hash(&bytes))
            .map_err(|reason| Error::Denied { seq, reason })?;
        self.access.accept_document(&hdr, doc)
            .map_err(|reason| Error::Denied { seq, reason })?;
        self.store(&device, seq, &bytes, doc, now_ms())?;
        self.next_seq += 1;
        Ok(())
    }

    /// Stores a message and its local index row (doc and authoring time) in one transaction.
    fn store(
        &mut self,
        device: &[u8; 32],
        seq: u64,
        bytes: &[u8],
        doc: &str,
        time_ms: u64,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO messages (device, seq, bytes) VALUES (?1, ?2, ?3)",
            params![&device[..], seq as i64, bytes],
        )?;
        tx.execute(
            "INSERT INTO doc_index (device, seq, doc, time_ms) VALUES (?1, ?2, ?3, ?4)",
            params![&device[..], seq as i64, doc, time_ms as i64],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn forget(&mut self, device: &[u8; 32], seq: u64) -> Result<()> {
        self.db.execute(
            "DELETE FROM messages WHERE device = ?1 AND seq = ?2",
            params![&device[..], seq as i64],
        )?;
        self.db.execute(
            "DELETE FROM doc_index WHERE device = ?1 AND seq = ?2",
            params![&device[..], seq as i64],
        )?;
        Ok(())
    }

    /// Starts an empty meta document with its mirror (see `observe_meta`).
    pub(super) fn observe_meta_fresh(&mut self) {
        self.meta = new_doc();
        self.observe_meta();
    }

    /// Keeps `self.mirror` in step with the meta maps. The observers run at every commit, local or
    /// remote, and read the new values from that transaction, so the mirror never lags behind the meta.
    pub(super) fn observe_meta(&mut self) {
        let mirror: Arc<std::sync::Mutex<MetaMirror>> = Arc::default();
        let paths: MapRef = self.meta.get_or_insert_map(PATHS);
        let deleted: MapRef = self.meta.get_or_insert_map(DELETED);
        let purged: MapRef = self.meta.get_or_insert_map(PURGED);
        mirror_keys(&paths, &mirror, |m, key, v| match v {
            Some(Out::Any(Any::String(p))) => {
                m.paths.insert(key.to_string(), p.to_string());
            }
            _ => {
                m.paths.remove(key);
            }
        });
        mirror_keys(&deleted, &mirror, |m, key, v| set_entry(&mut m.deleted, key, v.is_some()));
        mirror_keys(&purged, &mirror, |m, key, v| set_entry(&mut m.purged, key, v.is_some()));
        self.mirror = mirror;
    }

    /// Gives every note that has a path in meta (deleted ones included) a document, if it has none yet.
    pub(super) fn create_missing_note_docs(&mut self) {
        let m = self.mirror.lock().unwrap_or_else(|e| e.into_inner());
        for id in m.paths.keys() {
            if !self.notes.contains_key(id) && !self.pending.contains(id) {
                self.notes.insert(id.clone(), new_doc());
            }
        }
    }

    /// Brings the `.md` files in line after a note's content changed. Errors are logged, not returned.
    pub(super) fn refresh_note(&mut self, id: &str) {
        if let Ok(path) = self.path_of(id) {
            self.refresh_at(id, &path);
        }
    }

    /// After a meta update: removes the files of notes it made non-live (deleted), and writes the notes
    /// whose live path changed (new notes included). Only those, so a large space is not re-read per message.
    fn refresh_meta(&mut self, before: Arc<Vec<(NoteId, String)>>) {
        let after = self.effective();
        let before: HashMap<&str, &str> = before
            .iter()
            .map(|(i, p)| (i.as_str(), p.as_str()))
            .collect();
        let after_ids: HashMap<&str, &str> = after
            .iter()
            .map(|(i, p)| (i.as_str(), p.as_str()))
            .collect();
        let gone: Vec<NoteId> = before
            .keys()
            .filter(|id| !after_ids.contains_key(*id))
            .map(|id| id.to_string())
            .collect();
        let changed: Vec<(NoteId, String)> = after
            .iter()
            .filter(|(id, path)| before.get(id.as_str()) != Some(&path.as_str()))
            .cloned()
            .collect();
        drop(after_ids);
        for id in gone {
            if let Err(e) = self.remove_tracked(&id) {
                eprintln!("notes: could not remove the file of {id}: {e}");
            }
        }
        for (id, path) in changed {
            // a pending note's file is written when the note is loaded
            if !self.pending.contains(&id) {
                self.refresh_at(&id, &path);
            }
        }
    }

    /// Writes a live note's file when this device may: its own file, still as it was left, or a free path.
    // shortcut: a file edited outside the app is kept and not merged with the new text, upgrade with a conflict copy
    fn refresh_at(&mut self, id: &str, path: &str) {
        // a note not in memory has no text to write; its file comes when it is loaded
        if !self.notes.contains_key(id) {
            return;
        }
        let result = match self.tracked_file(id) {
            Ok(Some((old, hash))) if untouched(&self.root.join(&old), &hash) => {
                self.write_file_at(id, path)
            }
            Ok(Some(_)) => Ok(()),
            Ok(None) if !self.root.join(path).exists() => self.write_file_at(id, path),
            Ok(None) => Ok(()),
            Err(e) => Err(e),
        };
        if let Err(e) = result {
            eprintln!("notes: could not write {path}: {e}");
        }
    }
}

/// True when the file is missing or still holds the text recorded when we last wrote it.
fn untouched(abs: &std::path::Path, hash: &[u8]) -> bool {
    match std::fs::read(abs) {
        Ok(bytes) => blake3::hash(&bytes).as_bytes()[..] == *hash,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
#[path = "space_log_tests.rs"]
mod tests;

/// Keeps `mirror` in step with one meta map: `apply` runs for each changed key with the key's value now.
fn mirror_keys(
    map: &MapRef,
    mirror: &Arc<std::sync::Mutex<MetaMirror>>,
    apply: impl Fn(&mut MetaMirror, &str, Option<Out>) + Send + Sync + 'static,
) {
    let (mirror, map_in_cb) = (mirror.clone(), map.clone());
    map.observe("mirror", move |txn: &TransactionMut, ev| {
        let mut m = mirror.lock().unwrap_or_else(|e| e.into_inner());
        for key in ev.keys(txn).keys() {
            apply(&mut m, key, map_in_cb.get(txn, key));
            m.effective = None;
        }
    });
}

/// Adds `key` to a mirrored set when `present`, removes it otherwise.
fn set_entry(set: &mut std::collections::HashSet<NoteId>, key: &str, present: bool) {
    if present {
        set.insert(key.to_string());
    } else {
        set.remove(key);
    }
}
