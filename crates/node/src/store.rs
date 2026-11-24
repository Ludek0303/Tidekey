//! Storage of the node (SIEC.md, DOCKER §7): `node.db` keeps each space's participants log,
//! device certificates and encrypted messages as bytes. The node has no key of any space, so the
//! rules in `policy` are its only check on what it stores.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use notes_sync::acl::AclEntry;
use notes_sync::acl_log::AclLog;
use notes_sync::acl_state::{AclHead, AclState};
use notes_sync::cert::{CertStore, DeviceCert};
use notes_sync::policy::{self, parse_header};
use notes_sync::proto::VersionVector;
use notes_sync::session::{AclBytes, Put, SyncStore};
use notes_sync::{Error, Result};
use rusqlite::{Connection, OptionalExtension, params};

/// Largest message the node accepts; a real edit is far below this.
pub const MAX_MESSAGE: usize = 1 << 20;
/// Bytes of the newest messages sent first in a backlog (one sync frame); the rest follow in (device, seq) order.
// shortcut: a link that always drops within the first frame re-sends the same newest messages and makes no progress; upgrade with ranges in Have
const FIRST_FRAME: usize = 1 << 20;

/// The one connection all spaces share.
pub type Db = Arc<Mutex<Connection>>;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS spaces (id BLOB PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS acl (space BLOB NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (space, idx));
CREATE TABLE IF NOT EXISTS certs (space BLOB NOT NULL, device BLOB NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (space, device));
CREATE TABLE IF NOT EXISTS messages (space BLOB NOT NULL, device BLOB NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (space, device, seq));
";

fn db_err(e: rusqlite::Error) -> Error {
    Error::Core(e.to_string())
}

/// Opens `node.db` in WAL mode with full fsync, creating the tables if needed.
pub fn open_db(path: &Path) -> Result<Db> {
    let conn = Connection::open(path).map_err(db_err)?;
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;{SCHEMA}"
    ))
    .map_err(db_err)?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// One space as the node keeps it. A space that is not persisted yet (its first log has not arrived)
/// leaves nothing in the database until `import_acl` stores that log.
pub struct NodeStore {
    db: Db,
    space: [u8; 16],
    state: Option<AclState>,
    certs: CertStore,
    /// Bytes of messages stored for this space, against `max_bytes`.
    bytes: u64,
    max_bytes: u64,
    /// Shared with the router, so that it can tell stored spaces without locking this store.
    persisted: Arc<AtomicBool>,
}

impl NodeStore {
    /// A space the node has not stored a log for yet.
    pub fn fresh(db: Db, space: [u8; 16], max_bytes: u64) -> Self {
        Self {
            db,
            space,
            state: None,
            certs: CertStore::default(),
            bytes: 0,
            max_bytes,
            persisted: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Every space in the database, replayed and checked.
    pub fn load_all(db: &Db, max_bytes: u64) -> Result<Vec<NodeStore>> {
        let ids: Vec<Vec<u8>> = {
            let conn = db.lock().unwrap_or_else(|e| e.into_inner());
            let mut stmt = conn.prepare("SELECT id FROM spaces").map_err(db_err)?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        ids.into_iter()
            .map(|id| {
                let space = id
                    .try_into()
                    .map_err(|_| Error::Core("space id length".to_string()))?;
                NodeStore::open(db.clone(), space, max_bytes)
            })
            .collect()
    }

    fn open(db: Db, space: [u8; 16], max_bytes: u64) -> Result<NodeStore> {
        let mut store = NodeStore {
            db,
            space,
            state: None,
            certs: CertStore::default(),
            bytes: 0,
            max_bytes,
            persisted: Arc::new(AtomicBool::new(true)),
        };
        let entries = {
            let conn = store.conn();
            let blobs = query_blobs(
                &conn,
                "SELECT bytes FROM acl WHERE space = ?1 ORDER BY idx",
                &space,
            )?;
            let certs = query_blobs(&conn, "SELECT bytes FROM certs WHERE space = ?1", &space)?;
            let bytes: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(length(bytes)), 0) FROM messages WHERE space = ?1",
                    params![&space[..]],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            (blobs, certs, bytes)
        };
        let (blobs, certs, bytes) = entries;
        let decoded = blobs
            .iter()
            .map(|b| AclEntry::from_bytes(b))
            .collect::<Result<Vec<_>>>()?;
        if !decoded.is_empty() {
            store.state = Some(AclLog::verify(&decoded)?);
        }
        for bytes in certs {
            store.certs.insert(DeviceCert::from_bytes(&bytes)?)?;
        }
        store.bytes = bytes as u64;
        Ok(store)
    }

    /// Whether the space is stored (its first log has been imported).
    /// Messages of the space that `vv` does not cover, to send in this order: the newest first up to
    /// `first_frame` bytes, then the rest ascending by (device, seq). A peer that receives the rest in order
    /// advances the contiguous prefix of every device, so a connection cut after any frame still leaves progress.
    pub fn backlog(&self, vv: &VersionVector, first_frame: usize) -> Result<Vec<Vec<u8>>> {
        let seen: std::collections::HashMap<[u8; 32], u64> = vv.iter().copied().collect();
        let conn = self.conn();
        let mut stmt = conn
            // rowid is the insertion order, so the newest rows are the ones a peer most likely lacks
            .prepare("SELECT device, seq, bytes FROM messages WHERE space = ?1 ORDER BY rowid DESC")
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![&self.space[..]], |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(db_err)?;
        let mut newest = Vec::new();
        let mut rest: Vec<([u8; 32], u64, Vec<u8>)> = Vec::new();
        let mut newest_bytes = 0;
        for row in rows {
            let (device, seq, bytes) = row.map_err(db_err)?;
            let device: [u8; 32] = device
                .try_into()
                .map_err(|_| Error::Core("device key length".to_string()))?;
            if seq as u64 <= seen.get(&device).copied().unwrap_or(0) {
                continue;
            }
            if newest_bytes < first_frame {
                newest_bytes += bytes.len();
                newest.push(bytes);
            } else {
                rest.push((device, seq as u64, bytes));
            }
        }
        rest.sort_by_key(|(device, seq, _)| (*device, *seq));
        newest.extend(rest.into_iter().map(|(_, _, bytes)| bytes));
        Ok(newest)
    }

    pub fn persisted(&self) -> bool {
        self.persisted.load(Ordering::SeqCst)
    }

    /// The flag behind `persisted`, for the router.
    pub fn persisted_flag(&self) -> Arc<AtomicBool> {
        self.persisted.clone()
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // a panic in another connection must not take the whole node down: the data is still consistent
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bytes of the message at `(device, seq)`, if the node has one.
    fn stored(&self, device: &[u8; 32], seq: u64) -> Result<Option<Vec<u8>>> {
        self.conn()
            .query_row(
                "SELECT bytes FROM messages WHERE space = ?1 AND device = ?2 AND seq = ?3",
                params![&self.space[..], &device[..], seq as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)
    }
}

fn query_blobs(conn: &Connection, sql: &str, space: &[u8; 16]) -> Result<Vec<Vec<u8>>> {
    let mut stmt = conn.prepare(sql).map_err(db_err)?;
    let rows = stmt
        .query_map(params![&space[..]], |r| r.get(0))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

impl SyncStore for NodeStore {
    fn space(&self) -> [u8; 16] {
        self.space
    }

    fn acl_head(&self) -> Option<AclHead> {
        self.state.as_ref().map(AclState::head)
    }

    fn acl(&self) -> Result<AclBytes> {
        let conn = self.conn();
        let entries = query_blobs(
            &conn,
            "SELECT bytes FROM acl WHERE space = ?1 ORDER BY idx",
            &self.space,
        )?;
        let certs = query_blobs(
            &conn,
            "SELECT bytes FROM certs WHERE space = ?1 ORDER BY device",
            &self.space,
        )?;
        Ok((entries, certs))
    }

    fn import_acl(&mut self, entries: &[Vec<u8>], certs: &[Vec<u8>]) -> Result<bool> {
        let entries = entries
            .iter()
            .map(|b| AclEntry::from_bytes(b))
            .collect::<Result<Vec<_>>>()?;
        let known = self.acl_head();
        // a log that brings nothing new is ignored, before any certificate is looked at
        if !AclLog::is_extension(known, &entries)? {
            return Ok(false);
        }
        let state = AclLog::verify_extension(known, &entries)?;
        if state.space != self.space {
            return Err(Error::Space("the log names another space"));
        }
        // only certificates of users the new log knows (members, leavers, revoked devices) are kept:
        // anyone may send bytes, and the node's disk must not fill with junk
        let mut store = self.certs.clone();
        let mut added = Vec::new();
        for bytes in certs {
            let Ok(cert) = DeviceCert::from_bytes(bytes) else {
                continue;
            };
            if state.keeps_cert(&store, &cert) && store.insert(cert).is_ok() {
                added.push(cert);
            }
        }
        // only the entries past the known head are new; they and the space row go in one transaction
        let stored = known.map_or(0, |h| h.index as usize + 1);
        {
            let mut conn = self.conn();
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute(
                "INSERT OR IGNORE INTO spaces (id, created) VALUES (?1, ?2)",
                params![&self.space[..], now()],
            )
            .map_err(db_err)?;
            for entry in entries.iter().skip(stored) {
                tx.execute(
                    "INSERT INTO acl (space, idx, bytes) VALUES (?1, ?2, ?3)",
                    params![&self.space[..], entry.index as i64, entry.to_bytes()],
                )
                .map_err(db_err)?;
            }
            for cert in &added {
                tx.execute(
                    "INSERT OR IGNORE INTO certs (space, device, bytes) VALUES (?1, ?2, ?3)",
                    params![&self.space[..], &cert.device[..], cert.to_bytes().to_vec()],
                )
                .map_err(db_err)?;
            }
            tx.commit().map_err(db_err)?;
        }
        self.state = Some(state);
        self.certs = store;
        self.persisted.store(true, Ordering::SeqCst);
        Ok(true)
    }

    fn acl_state(&self) -> Option<&AclState> {
        self.state.as_ref()
    }

    fn certs(&self) -> &CertStore {
        &self.certs
    }

    fn version_vector(&self) -> Result<VersionVector> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT device, seq FROM messages WHERE space = ?1 ORDER BY device, seq")
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![&self.space[..]], |r| {
                Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(db_err)?;
        // same rule as notes_core: a device counts only up to its first gap
        let mut vv: VersionVector = Vec::new();
        for row in rows {
            let (device, seq) = row.map_err(db_err)?;
            let device: [u8; 32] = device
                .try_into()
                .map_err(|_| Error::Core("device key length".to_string()))?;
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

    fn after(&self, vv: &VersionVector, max_bytes: usize) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let mut total = 0;
        for bytes in self.backlog(vv, FIRST_FRAME)? {
            total += bytes.len();
            out.push(bytes);
            if total >= max_bytes {
                break;
            }
        }
        Ok(out)
    }

    fn put(&mut self, msg: &[u8]) -> Result<Put> {
        if msg.len() > MAX_MESSAGE {
            return Ok(Put::Rejected("message too large".to_string()));
        }
        let Some(header) = parse_header(msg) else {
            return Ok(Put::Rejected("malformed message".to_string()));
        };
        // one (device, seq) has one message: the same bytes change nothing, other bytes are a fork
        if let Some(old) = self.stored(&header.device, header.seq)? {
            return Ok(if old == msg {
                Put::Known
            } else {
                Put::Rejected("fork: same device and seq, other bytes".to_string())
            });
        }
        let Some(state) = &self.state else {
            return Ok(Put::Rejected("space has no log yet".to_string()));
        };
        if let Err(reason) = policy::check_message(state, &self.certs, msg) {
            return Ok(Put::Rejected(reason.to_string()));
        }
        if self.bytes + msg.len() as u64 > self.max_bytes {
            return Ok(Put::Rejected("space full".to_string()));
        }
        self.conn()
            .execute(
                "INSERT INTO messages (space, device, seq, bytes) VALUES (?1, ?2, ?3, ?4)",
                params![&self.space[..], &header.device[..], header.seq as i64, msg],
            )
            .map_err(db_err)?;
        self.bytes += msg.len() as u64;
        Ok(Put::New)
    }
}
