//! Public records kept beside the message log for the sync layer: the participants log, device
//! certificates and the head of the log. Core stores them as opaque bytes and never reads them.
//! None of them holds a secret.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::space::{db_path, open_db};
use crate::{Error, Result};

pub struct Records {
    db: Connection,
}

impl Records {
    /// Opens the records of an existing space.
    pub fn open(root: &Path) -> Result<Records> {
        let db = open_db(&db_path(root), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        Ok(Records { db })
    }

    pub fn space_id(&self) -> Result<[u8; 16]> {
        let id: Vec<u8> =
            self.db
                .query_row("SELECT space_id FROM space WHERE id = 0", [], |r| r.get(0))?;
        id.try_into().map_err(|_| Error::Layout("space id length"))
    }

    /// Encoded participants-log entries, in index order.
    pub fn acl_entries(&self) -> Result<Vec<Vec<u8>>> {
        let mut stmt = self.db.prepare("SELECT bytes FROM acl ORDER BY idx")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Encoded device certificates.
    pub fn certs(&self) -> Result<Vec<Vec<u8>>> {
        let mut stmt = self.db.prepare("SELECT bytes FROM certs ORDER BY device")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// `(index, hash)` of the last participants-log entry this device has seen.
    pub fn acl_head(&self) -> Result<Option<(u64, [u8; 32])>> {
        let row: Option<(i64, Vec<u8>)> = self
            .db
            .query_row("SELECT idx, hash FROM acl_head WHERE id = 0", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        row.map(|(idx, hash)| {
            let hash = hash
                .try_into()
                .map_err(|_| Error::Layout("head hash length"))?;
            Ok((idx as u64, hash))
        })
        .transpose()
    }

    /// Stores new log entries, certificates and the new head in one transaction.
    pub fn put_acl(
        &mut self,
        entries: &[(u64, Vec<u8>)],
        certs: &[([u8; 32], Vec<u8>)],
        head: (u64, [u8; 32]),
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        for (idx, bytes) in entries {
            tx.execute(
                "INSERT INTO acl (idx, bytes) VALUES (?1, ?2)",
                params![*idx as i64, bytes],
            )?;
        }
        for (device, bytes) in certs {
            tx.execute(
                "INSERT OR REPLACE INTO certs (device, bytes) VALUES (?1, ?2)",
                params![&device[..], bytes],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO acl_head (id, idx, hash) VALUES (0, ?1, ?2)",
            params![head.0 as i64, &head.1[..]],
        )?;
        tx.commit()?;
        Ok(())
    }
}
