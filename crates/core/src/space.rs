use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ed25519_dalek::SigningKey;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, GetString, Map, Number, OffsetKind, Options, Out, ReadTxn, StateVector, Text,
    Transact, Update,
};

use crate::access::{Access, Header, message_hash};
use crate::space_meta;
use crate::{Error, Result};

pub use log::Received;

pub type NoteId = String;

#[path = "structured.rs"]
mod structured;
#[path = "task_audit.rs"]
mod task_audit;
pub use task_audit::{TaskEvent, TaskSnapshot};

const CONTENT: &str = "content";
const PATHS: &str = "paths";
const DELETED: &str = "deleted";
/// Notes removed for good: their id stays here (with the time) so no device can bring them back.
const PURGED: &str = "purged";
const META_DOC: &str = "";
/// Days a deleted note stays in the trash before `purge_trash` removes it for good (about six months).
pub const TRASH_DAYS: i64 = 183;

/// Oldest deletion time (ms) still in the trash at `now_ms`. Older notes are expired: `trash` hides them at once
/// and `purge_trash` removes them for good on open.
pub fn trash_cutoff(now_ms: i64) -> i64 {
    now_ms - TRASH_DAYS * lazy::DAY_MS
}

// Layout of space.db: only public data (space id, encrypted messages, public records, file cache).
// Secrets live in the key store and the participants log, never here. Old files: see legacy.rs.
pub(crate) const LAYOUT_VERSION: i64 = 1;
// shortcut: no migrations between layout versions yet; the only upgrade path is legacy.rs, add PRAGMA user_version steps before v2
const SCHEMA: [&str; 13] = [
    "CREATE TABLE IF NOT EXISTS space (id INTEGER PRIMARY KEY CHECK (id = 0), space_id BLOB NOT NULL);",
    "CREATE TABLE IF NOT EXISTS messages (device BLOB NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (device, seq));",
    "CREATE TABLE IF NOT EXISTS file_state (note_id TEXT PRIMARY KEY, hash BLOB NOT NULL, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS acl (idx INTEGER PRIMARY KEY, bytes BLOB NOT NULL);",
    "CREATE TABLE IF NOT EXISTS certs (device BLOB PRIMARY KEY, bytes BLOB NOT NULL);",
    "CREATE TABLE IF NOT EXISTS acl_head (id INTEGER PRIMARY KEY CHECK (id = 0), idx INTEGER NOT NULL, hash BLOB NOT NULL);",
    // local index, never synced: which note each message belongs to and when it was authored. Note ids are
    // already in clear in file_state, so they add nothing new to what this file reveals.
    "CREATE TABLE IF NOT EXISTS doc_index (device BLOB NOT NULL, seq INTEGER NOT NULL, doc TEXT NOT NULL, time_ms INTEGER NOT NULL, PRIMARY KEY (device, seq));",
    "CREATE INDEX IF NOT EXISTS doc_index_doc ON doc_index (doc);",
    "CREATE TABLE IF NOT EXISTS note_usage (doc TEXT PRIMARY KEY, last_used_ms INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS file_base (note_id TEXT PRIMARY KEY, text TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY, note TEXT NOT NULL, time_ms INTEGER NOT NULL, reason TEXT NOT NULL, text_zstd BLOB NOT NULL);",
    "CREATE INDEX IF NOT EXISTS versions_note ON versions (note);",
    "CREATE TABLE IF NOT EXISTS conflicts (note_id TEXT PRIMARY KEY, theirs TEXT NOT NULL);",
];

pub struct Space {
    root: PathBuf,
    db: Connection,
    device: SigningKey,
    space_id: [u8; 16],
    access: Box<dyn Access + Send>,
    next_seq: u64,
    rejected: Vec<([u8; 32], u64, String)>,
    meta: Doc,
    /// The meta maps as this device last saw them, kept by yrs observers so that no read scans the whole meta.
    mirror: Arc<Mutex<MetaMirror>>,
    notes: HashMap<NoteId, Doc>,
    /// Notes whose messages are stored but not applied (see `lazy`).
    pending: std::collections::HashSet<NoteId>,
    /// Pending notes whose last load failed: left out of `unloaded` until the next open.
    failed: std::collections::HashSet<NoteId>,
}

/// Meta entries: every note's stored path (deleted notes included), the set of deleted and of purged notes,
/// plus the resolved live paths, computed once until the next change.
#[derive(Default)]
pub(super) struct MetaMirror {
    pub paths: HashMap<NoteId, String>,
    pub deleted: std::collections::HashSet<NoteId>,
    pub purged: std::collections::HashSet<NoteId>,
    pub effective: Option<Arc<Vec<(NoteId, String)>>>,
}

impl Space {
    /// New empty space. `access` decides which keys this device holds and which messages it accepts.
    pub fn create(
        root: &Path,
        space_id: [u8; 16],
        device: SigningKey,
        access: Box<dyn Access + Send>,
    ) -> Result<Space> {
        let path = db_path(root);
        if path.exists() {
            return Err(Error::AlreadyExists);
        }
        fs::create_dir_all(root.join(".notes-sync"))?;
        let db = open_db(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        let tx = db.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO space (id, space_id) VALUES (0, ?1)",
            params![&space_id[..]],
        )?;
        tx.execute_batch(&format!("PRAGMA user_version = {LAYOUT_VERSION};"))?;
        tx.commit()?;
        let mut sp = Space {
            root: root.to_path_buf(),
            db,
            device,
            space_id,
            access,
            next_seq: 1,
            rejected: Vec::new(),
            meta: new_doc(),
            mirror: Arc::default(),
            notes: HashMap::new(),
            pending: std::collections::HashSet::new(),
            failed: std::collections::HashSet::new(),
        };
        sp.observe_meta();
        Ok(sp)
    }

    /// Opens an existing space and replays its log. A message that fails signature or decryption
    /// fails the open; one the access rules reject is skipped and listed by `rejected`.
    pub fn open(root: &Path, device: SigningKey, access: Box<dyn Access + Send>) -> Result<Space> {
        let db = open_db(&db_path(root), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let space_id: Vec<u8> =
            db.query_row("SELECT space_id FROM space WHERE id = 0", [], |r| r.get(0))?;
        let space_id = space_id
            .try_into()
            .map_err(|_| Error::Layout("space id length"))?;
        let mut sp = Space {
            root: root.to_path_buf(),
            db,
            device,
            space_id,
            access,
            next_seq: 1,
            rejected: Vec::new(),
            meta: new_doc(),
            mirror: Arc::default(),
            notes: HashMap::new(),
            pending: std::collections::HashSet::new(),
            failed: std::collections::HashSet::new(),
        };
        sp.replay()?;
        sp.sweep_deleted();
        Ok(sp)
    }

    /// Rebuilds the in-memory notes and meta from the stored messages. Used after a panic left them half
    /// updated; the stored log is the truth.
    pub fn reload(&mut self) -> Result<()> {
        self.replay()
    }

    /// Replaces the access rules and keys, e.g. after the participants log grew.
    pub fn set_access(&mut self, access: Box<dyn Access + Send>) {
        self.access = access;
    }

    /// Messages skipped by the last open, as `(device, seq, reason)`.
    pub fn rejected(&self) -> Vec<([u8; 32], u64, String)> {
        self.rejected.clone()
    }

    /// Every stored message, as the exact bytes that travel over the network.
    pub fn messages(&self) -> Result<Vec<Vec<u8>>> {
        let mut stmt = self
            .db
            .prepare("SELECT bytes FROM messages ORDER BY device, seq")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Highest stored seq of a device and the BLAKE3 of that message; `(0, zeros)` when it has none.
    pub fn cutoff(&self, device: &[u8; 32]) -> Result<(u64, [u8; 32])> {
        let row: Option<(i64, Vec<u8>)> = self
            .db
            .query_row(
                "SELECT seq, bytes FROM messages WHERE device = ?1 ORDER BY seq DESC LIMIT 1",
                params![&device[..]],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((seq, bytes)) => (seq as u64, message_hash(&bytes)),
            None => (0, [0; 32]),
        })
    }

    pub fn create_note(&mut self, rel_path: &str) -> Result<NoteId> {
        validate_path(rel_path)?;
        self.check_writable()?;
        // an untracked file at this path is user data; never overwrite it
        if self
            .notes()
            .iter()
            .any(|(_, p)| space_meta::conflicts(p, rel_path))
            || self.root.join(rel_path).exists()
        {
            return Err(Error::PathTaken(rel_path.to_string()));
        }
        let id = self.add_note(rel_path)?;
        self.write_file(&id)?;
        Ok(id)
    }

    /// Logs a new note at `rel_path` with empty text. The caller has checked the path.
    pub(super) fn add_note(&mut self, rel_path: &str) -> Result<NoteId> {
        let id = hex::encode(random::<16>()?);
        let paths = self.meta.get_or_insert_map(PATHS);
        let update = {
            let mut txn = self.meta.transact_mut();
            paths.insert(&mut txn, id.as_str(), rel_path.to_string());
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)?;
        self.notes.insert(id.clone(), new_doc());
        Ok(id)
    }

    /// Live notes only, sorted by path.
    pub fn notes(&self) -> Vec<(NoteId, String)> {
        let mut out = self.effective_paths();
        out.sort_by(|a, b| a.1.cmp(&b.1));
        out
    }

    /// Deleted notes as (id, path, deleted_at_ms), newest first. Expired notes (see `trash_cutoff`) are left out
    /// even before `purge_trash` removes them.
    pub fn trash(&self) -> Vec<(NoteId, String, i64)> {
        let cutoff = trash_cutoff(lazy::now_ms() as i64);
        let deletions = self.unpurged_deletions();
        let paths = self.meta.get_or_insert_map(PATHS);
        let txn = self.meta.transact();
        let mut out: Vec<(NoteId, String, i64)> = deletions
            .into_iter()
            .filter(|(_, at)| *at >= cutoff)
            .filter_map(|(id, at)| match paths.get(&txn, &id) {
                Some(Out::Any(Any::String(p))) if space_meta::is_valid_path(&p) => Some((id, p.to_string(), at)),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        out
    }

    /// Deleted notes not yet purged, as (id, deleted_at_ms). The filter `trash` and `purge_trash` share.
    fn unpurged_deletions(&self) -> Vec<(NoteId, i64)> {
        // the maps are created before the read transaction: creating one needs a write
        let deleted = self.meta.get_or_insert_map(DELETED);
        let purged = self.meta.get_or_insert_map(PURGED);
        let txn = self.meta.transact();
        deleted
            .iter(&txn)
            .filter(|(id, _)| !purged.contains_key(&txn, id))
            .filter_map(|(id, v)| Some((id.to_string(), deleted_at(&v)?)))
            .collect()
    }

    pub fn rename_note(&mut self, id: &str, new_rel_path: &str) -> Result<()> {
        validate_path(new_rel_path)?;
        self.check_writable()?;
        let old = self.path_of(id)?;
        if old == new_rel_path {
            return Ok(());
        }
        let case_only = space_meta::key(&old) == space_meta::key(new_rel_path);
        let taken = self
            .notes()
            .iter()
            .any(|(other, p)| other.as_str() != id && space_meta::conflicts(p, new_rel_path));
        // checked before the log grows; a case-only change is the same file on a case-insensitive disk
        if taken || (!case_only && self.root.join(new_rel_path).exists()) {
            return Err(Error::PathTaken(new_rel_path.to_string()));
        }
        let update = {
            let paths = self.meta.get_or_insert_map(PATHS);
            let mut txn = self.meta.transact_mut();
            paths.insert(&mut txn, id, new_rel_path.to_string());
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)?;
        self.write_renamed(id, &old, new_rel_path)
    }

    pub fn delete_note(&mut self, id: &str, now_ms: i64) -> Result<()> {
        self.check_writable()?;
        self.mark_deleted(id, now_ms)?;
        // deleted once logged; a file that cannot be removed now is retried by sweep_deleted on open
        self.remove_tracked(id)
            .unwrap_or_else(|e| eprintln!("notes: could not remove file of {id}: {e}"));
        Ok(())
    }

    /// Log step of delete_note, on its own so a crash before the file removal can be simulated.
    fn mark_deleted(&mut self, id: &str, now_ms: i64) -> Result<()> {
        self.path_of(id)?;
        let update = {
            let deleted = self.meta.get_or_insert_map(DELETED);
            let mut txn = self.meta.transact_mut();
            deleted.insert(&mut txn, id, Any::Number(Number::Int(now_ms)));
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)
    }

    /// Returns the path the note was restored to. A path used by a live note or by an untracked file
    /// gets " (2)", " (3)"...
    pub fn restore_note(&mut self, id: &str) -> Result<String> {
        self.check_writable()?;
        let raw = self
            .trash()
            .into_iter()
            .find(|t| t.0 == id)
            .map(|t| t.1)
            .ok_or_else(|| Error::UnknownNote(id.to_string()))?;
        let live: Vec<String> = self.effective_paths().into_iter().map(|(_, p)| p).collect();
        let is_taken = |c: &str| {
            live.iter().any(|p| space_meta::conflicts(p, c)) || self.root.join(c).exists()
        };
        let path = if is_taken(&raw) {
            space_meta::free_name(&raw, is_taken)
        } else {
            raw
        };
        let update = {
            let paths = self.meta.get_or_insert_map(PATHS);
            let deleted = self.meta.get_or_insert_map(DELETED);
            let mut txn = self.meta.transact_mut();
            deleted.remove(&mut txn, id);
            paths.insert(&mut txn, id, path.clone());
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)?;
        // delete_note already removed the file; forget the old record so write_file cannot remove a file that is not ours
        self.db
            .execute("DELETE FROM file_state WHERE note_id = ?1", params![id])?;
        self.write_file(id)?;
        Ok(path)
    }

    /// Removes every trashed note deleted before `older_than_ms` for good. Returns how many.
    pub fn purge_trash(&mut self, older_than_ms: i64) -> Result<usize> {
        let old: Vec<NoteId> = self
            .unpurged_deletions()
            .into_iter()
            .filter(|(_, at)| *at < older_than_ms)
            .map(|(id, _)| id)
            .collect();
        if old.is_empty() {
            return Ok(0);
        }
        self.purge_all(&old)?;
        Ok(old.len())
    }

    /// Removes one trashed note for good ("Usuń na zawsze"). A live note is refused: delete it first.
    pub fn purge_note(&mut self, id: &str) -> Result<()> {
        if !self.trash().iter().any(|t| t.0 == id) {
            return Err(Error::UnknownNote(id.to_string()));
        }
        self.purge_all(&[id.to_string()])
    }

    /// What is removed: the note's path, its text in memory, its saved versions, and its local records (file,
    /// conflict, usage). The DELETED mark stays and PURGED is set, so every replica hides the id for good: a
    /// stale device's rename or edit does not bring it back. What stays is the note's encrypted messages in the log
    /// (signed history other devices hold too; a gap in a device's seqs would make them resend it).
    // shortcut: the purged note's messages stay as ciphertext in the log (messages, doc_index); key holders can read them, upgrade when the log can drop a doc (needs a log-level purge message)
    fn purge_all(&mut self, ids: &[NoteId]) -> Result<()> {
        self.check_writable()?;
        let mut done: Vec<&str> = Vec::with_capacity(ids.len());
        let mut failure = None;
        for id in ids {
            // the file goes first: if that fails nothing is purged and the next purge retries
            match self.remove_tracked(id) {
                Ok(()) => done.push(id),
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        if done.is_empty() {
            return failure.map_or(Ok(()), Err);
        }
        let update = {
            let paths = self.meta.get_or_insert_map(PATHS);
            let purged = self.meta.get_or_insert_map(PURGED);
            let now = Any::Number(Number::Int(lazy::now_ms() as i64));
            let mut txn = self.meta.transact_mut();
            for id in &done {
                paths.remove(&mut txn, id);
                purged.insert(&mut txn, *id, now.clone());
            }
            txn.encode_update_v1()
        };
        self.append(META_DOC, &update)?;
        let tx = self.db.unchecked_transaction()?;
        for id in &done {
            self.notes.remove(*id);
            self.pending.remove(*id);
            self.failed.remove(*id);
            tx.execute("DELETE FROM versions WHERE note = ?1", params![id])?;
            tx.execute("DELETE FROM note_usage WHERE doc = ?1", params![id])?;
        }
        tx.commit()?;
        failure.map_or(Ok(()), Err)
    }

    pub fn apply_local_update(&mut self, id: &str, update_v1: &[u8]) -> Result<()> {
        self.check_writable()?;
        self.load_note(id)?;
        apply(self.note_doc(id)?, update_v1)?;
        self.append(id, update_v1)
    }

    pub fn insert_text(&mut self, id: &str, index: u32, text: &str) -> Result<()> {
        self.check_writable()?;
        self.load_note(id)?;
        let update = {
            let doc = self.note_doc(id)?;
            let content = doc.get_or_insert_text(CONTENT);
            let mut txn = doc.transact_mut();
            let len = content.len(&txn);
            if index > len {
                return Err(Error::Crdt(format!(
                    "index {index} past end of text ({len})"
                )));
            }
            content.insert(&mut txn, index, text);
            txn.encode_update_v1()
        };
        self.append(id, &update)
    }

    pub fn text(&mut self, id: &str) -> Result<String> {
        self.load_note(id)?;
        self.loaded_text(id)
    }

    /// The text of a note already in memory; never loads (see `text`).
    pub(super) fn loaded_text(&self, id: &str) -> Result<String> {
        let doc = self.note_doc(id)?;
        let content = doc.get_or_insert_text(CONTENT);
        let txn = doc.transact();
        Ok(content.get_string(&txn))
    }

    pub fn state(&mut self, id: &str) -> Result<Vec<u8>> {
        self.load_note(id)?;
        let txn = self.note_doc(id)?.transact();
        Ok(txn.encode_state_as_update_v1(&StateVector::default()))
    }
    /// Refuses a local change before any document is touched: when there is no current key, or the rules
    /// refuse this device's next message. The check uses the header that message would have; the message
    /// hash is only compared for a cut seq, which a new message can never have.
    pub(super) fn check_writable(&self) -> Result<()> {
        let (epoch, _) = self.access.current().ok_or(Error::NoCurrentKey)?;
        let header = Header {
            space: self.space_id,
            device: self.device.verifying_key().to_bytes(),
            seq: self.next_seq,
            epoch,
        };
        self.access
            .accept(&header, &[0; 32])
            .map_err(|reason| Error::Denied {
                seq: self.next_seq,
                reason,
            })
    }

    fn note_doc(&self, id: &str) -> Result<&Doc> {
        self.notes
            .get(id)
            .ok_or_else(|| Error::UnknownNote(id.to_string()))
    }

    fn path_of(&self, id: &str) -> Result<String> {
        self.effective()
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, p)| p.clone())
            .ok_or_else(|| Error::UnknownNote(id.to_string()))
    }

    /// Live (id, path) pairs as stored in meta, before duplicate resolution. Invalid paths are skipped.
    /// The paths the user sees: equal meta paths are resolved the same way on every device. Cached
    /// until the meta changes, so a message that does not change meta costs no resolution.
    // shortcut: a meta change re-resolves every live path (O(n log n) per change, see the 10 000 notes test); keep duplicate names incremental when spaces pass ~10 000 notes
    fn effective(&self) -> Arc<Vec<(NoteId, String)>> {
        let mut m = self.mirror.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = &m.effective {
            return cached.clone();
        }
        let raw: Vec<(NoteId, String)> = m
            .paths
            .iter()
            .filter(|(id, p)| {
                !m.deleted.contains(*id) && !m.purged.contains(*id) && space_meta::is_valid_path(p)
            })
            .map(|(id, p)| (id.clone(), p.clone()))
            .collect();
        let resolved = Arc::new(space_meta::resolve_duplicates(raw));
        m.effective = Some(resolved.clone());
        resolved
    }

    fn effective_paths(&self) -> Vec<(NoteId, String)> {
        self.effective().to_vec()
    }
}

pub(crate) fn db_path(root: &Path) -> PathBuf {
    root.join(".notes-sync").join("space.db")
}

pub(crate) fn open_db(path: &Path, flags: OpenFlags) -> Result<Connection> {
    let db = Connection::open_with_flags(path, flags)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
    for stmt in SCHEMA {
        db.execute_batch(stmt)?;
    }
    Ok(db)
}

// Positions count UTF-16 units, like Yjs and CodeMirror; the default byte offsets panic inside multi-byte letters.
pub(crate) fn new_doc() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

pub(crate) fn random<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(buf)
}

pub(crate) fn apply(doc: &Doc, update_v1: &[u8]) -> Result<()> {
    let update = Update::decode_v1(update_v1).map_err(|e| Error::Crdt(e.to_string()))?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|e| Error::Crdt(e.to_string()))
}

fn validate_path(rel: &str) -> Result<()> {
    if space_meta::is_valid_path(rel) {
        Ok(())
    } else {
        Err(Error::InvalidPath(rel.to_string()))
    }
}

fn deleted_at(v: &Out) -> Option<i64> {
    match v {
        // yrs stores integers wider than i32 as floats, so both encodings must be read
        Out::Any(Any::Number(Number::Int(t))) => Some(*t),
        Out::Any(Any::Number(Number::Float(f))) => Some(*f as i64),
        _ => None,
    }
}

#[path = "space_files.rs"]
mod files;

#[path = "space_log.rs"]
mod log;

#[path = "space_external.rs"]
mod external;
#[path = "space_lazy.rs"]
mod lazy;
#[path = "space_versions.rs"]
mod versions;
#[path = "space_kind.rs"]
mod kind;
pub use kind::{KIND_NOTES, KIND_ORGANIZATION};
pub use external::ExternalOutcome;
pub use versions::{VersionInfo, text_hash};

#[cfg(test)]
#[path = "space_tests.rs"]
mod tests;
