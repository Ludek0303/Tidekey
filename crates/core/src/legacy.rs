//! Migration from the layout before the identity stage (SZYFROWANIE §8 krok B). Old space.db files
//! hold the device secret and the epoch-0 key. `take_legacy_secrets` reads them, the caller moves them
//! into the key store and the participants log, then `finish_legacy_migration` deletes them and
//! rebuilds the file so their bytes are gone.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use zeroize::Zeroizing;

use crate::space::{LAYOUT_VERSION, db_path};
use crate::{Error, Result, Space};

/// Secrets of an old-layout space.db.
pub struct LegacySecrets {
    pub device_secret: Zeroizing<[u8; 32]>,
    pub space_id: [u8; 16],
    pub epoch0_key: Zeroizing<[u8; 32]>,
}

impl Space {
    /// Reads the secrets of an old-layout space.db. `None` when there is no space or it is already migrated.
    pub fn take_legacy_secrets(root: &Path) -> Result<Option<LegacySecrets>> {
        let Some(db) = open_legacy(root)? else {
            return Ok(None);
        };
        let secret = Zeroizing::new(db.query_row(
            "SELECT secret FROM device WHERE id = 0",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        )?);
        let (space_id, epoch, key) = db.query_row(
            "SELECT space_id, epoch, key FROM space WHERE id = 0",
            [],
            |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, i64>(1)?,
                    Zeroizing::new(r.get::<_, Vec<u8>>(2)?),
                ))
            },
        )?;
        if epoch != 0 {
            return Err(Error::Layout("legacy space key is not epoch 0"));
        }
        Ok(Some(LegacySecrets {
            device_secret: Zeroizing::new(fixed(&secret)?),
            space_id: fixed(&space_id)?,
            epoch0_key: Zeroizing::new(fixed(&key)?),
        }))
    }

    /// Deletes the old secrets and the plaintext note copies, then rebuilds the file (VACUUM) and
    /// truncates the WAL so the old bytes are gone. Call only after the keys are stored elsewhere.
    pub fn finish_legacy_migration(root: &Path) -> Result<()> {
        let Some(db) = open_legacy(root)? else {
            return Ok(());
        };
        db.execute_batch(&format!(
            "BEGIN;
             DROP TABLE device;
             ALTER TABLE space DROP COLUMN key;
             ALTER TABLE file_state DROP COLUMN text;
             PRAGMA user_version = {LAYOUT_VERSION};
             COMMIT;
             VACUUM;
             PRAGMA wal_checkpoint(TRUNCATE);"
        ))?;
        Ok(())
    }
}

/// Connection to a space.db in the old layout; `None` when there is no file or it is already migrated.
fn open_legacy(root: &Path) -> Result<Option<Connection>> {
    let path = db_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let has_device: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'device'",
        [],
        |r| r.get(0),
    )?;
    Ok((version == 0 && has_device == 1).then_some(db))
}

fn fixed<const N: usize>(bytes: &[u8]) -> Result<[u8; N]> {
    bytes
        .try_into()
        .map_err(|_| Error::Layout("legacy field length"))
}
