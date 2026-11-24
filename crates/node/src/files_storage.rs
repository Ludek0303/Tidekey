//! Moving every file object to the other store (PANEL-ADMINA.md "Magazyn plików"): copy, read back and compare
//! length and SHA-256, switch only when all objects are across, then drop the old copies. One migration at a time;
//! its progress lives in memory only, so a restart starts it over (copies in the target are overwritten).

use std::io;
use std::pin::Pin;

use axum::body::HttpBody;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::*;

/// Where an object waits between the two stores, under `<data>/attachments` (stores skip dot folders).
const MIGRATE_DIR: &str = ".migrate";

/// What `GET /admin/api/storage` answers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub current: &'static str,
    pub available: Vec<&'static str>,
    /// Rows whose object should be in the store (`ready` and `trashed`) and their bytes.
    pub objects: u64,
    pub bytes: u64,
    pub migration: Option<Progress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub target: &'static str,
    /// Objects handled; ones with no object in the old store (an upload not completed yet) count as done.
    pub done: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub failed: u64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

pub(super) struct Storage {
    pub(super) current: &'static str,
    pub(super) migration: Option<Progress>,
}

impl FileService {
    fn storage_state(&self) -> MutexGuard<'_, Storage> {
        self.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn progress(&self, change: impl FnOnce(&mut Progress)) {
        if let Some(p) = self.storage_state().migration.as_mut() {
            change(p);
        }
    }

    pub fn storage_status(&self) -> Result<StorageStatus, FileError> {
        let (objects, bytes): (i64, i64) = self
            .db()?
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(size),0) FROM files WHERE state IN (?1,?2)",
                params![READY, TRASHED],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        let state = self.storage_state();
        Ok(StorageStatus {
            current: state.current,
            available: self.stores.iter().map(|(name, _)| *name).collect(),
            objects: objects as u64,
            bytes: bytes as u64,
            migration: state.migration.clone(),
        })
    }

    /// Starts moving every object to `target` in the background. 409 while one runs, for the current store, and for
    /// a store this node is not configured with.
    pub fn start_migration(self: &Arc<Self>, target: &str) -> Result<(), FileError> {
        let target = match target {
            objstore::LOCAL => objstore::LOCAL,
            objstore::SEAWEEDFS => objstore::SEAWEEDFS,
            _ => return Err(FileError::Invalid("Nieznany magazyn. Dozwolone: local albo seaweedfs.")),
        };
        let mut state = self.storage_state();
        if state.migration.as_ref().is_some_and(|p| p.finished_at.is_none()) {
            return Err(FileError::Conflict("Migracja magazynu już trwa."));
        }
        if state.current == target {
            return Err(FileError::Conflict("Pliki są już w tym magazynie."));
        }
        if !self.stores.iter().any(|(name, _)| *name == target) {
            return Err(FileError::Conflict("Ten magazyn nie jest skonfigurowany."));
        }
        state.migration = Some(Progress {
            target,
            done: 0,
            total: 0,
            bytes_done: 0,
            failed: 0,
            started_at: now_millis(),
            finished_at: None,
            error: None,
        });
        drop(state);
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let result = me.migrate(target).await;
            if let Err(e) = &result {
                eprintln!("notes-node files: migracja magazynu przerwana");
                audit::event("storage_migration_failed", &[("target", target)]);
                me.progress(|p| p.error = Some(e.clone()));
            }
            me.progress(|p| p.finished_at = Some(now_millis()));
        });
        Ok(())
    }

    async fn migrate(self: &Arc<Self>, target: &'static str) -> Result<(), String> {
        let from = self.store.current().await.clone();
        let to = self.stores.iter().find(|(name, _)| *name == target).map(|(_, s)| s.clone()).ok_or("Brak magazynu docelowego.")?;
        let tmp = self.root.join(MIGRATE_DIR);
        tokio::fs::create_dir_all(&tmp).await.map_err(|_| "Nie udało się utworzyć folderu roboczego migracji.")?;
        let mut seen = HashSet::new();
        let mut copied = HashSet::new();
        // objects that arrive meanwhile (uploads still go to the old store) are picked up by the next round
        loop {
            let fresh: Vec<String> = self.object_keys().await?.into_iter().filter(|k| !seen.contains(k)).collect();
            if fresh.is_empty() {
                break;
            }
            self.progress(|p| p.total += fresh.len() as u64);
            for key in fresh {
                seen.insert(key.clone());
                self.copy_counted(&*from, &*to, &key, &tmp, true, &mut copied).await?;
            }
        }
        // The switch: with the write side held no store call is in flight, so a last round catches what the loop
        // could not (an upload completed between the last listing and now, or one still a part back then).
        let mut current = self.store.switch().await;
        for key in self.object_keys().await? {
            if !copied.contains(&key) {
                let new = seen.insert(key.clone());
                if new {
                    self.progress(|p| p.total += 1);
                }
                self.copy_counted(&*from, &*to, &key, &tmp, new, &mut copied).await?;
            }
        }
        let data = self.data.clone();
        tokio::task::spawn_blocking(move || objstore::save_backend(&data, target))
            .await
            .map_err(|_| "Nie udało się zapisać storage.json.")?
            .map_err(|_| "Nie udało się zapisać storage.json.")?;
        *current = to;
        self.storage_state().current = target;
        drop(current);
        audit::event("storage_migrated", &[("target", target), ("objects", &copied.len().to_string())]);
        // the new store is current from here: a failed removal only leaves a stray old copy
        for key in &copied {
            if let Err(e) = from.delete(key).await {
                eprintln!("notes-node files: usuwanie starej kopii nie powiodło się ({:?})", e.kind());
            }
        }
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        Ok(())
    }

    /// Every row's store key, whatever its state: an upload may already have its object.
    async fn object_keys(self: &Arc<Self>) -> Result<Vec<String>, String> {
        self.blocking(|s| {
            let db = s.db()?;
            let mut stmt = db.prepare("SELECT vault_id, file_id FROM files ORDER BY vault_id, file_id").map_err(db_err)?;
            let rows = stmt.query_map([], |r| Ok(object_key(&r.get::<_, String>(0)?, &r.get::<_, String>(1)?))).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<String>>>().map_err(db_err)
        })
        .await
        .map_err(|_| "Nie udało się odczytać files.db.".to_string())
    }

    /// `copy_verified` with the progress kept; `new`: the key was not counted as done before.
    async fn copy_counted(
        &self,
        from: &dyn ObjectStore,
        to: &dyn ObjectStore,
        key: &str,
        tmp: &Path,
        new: bool,
        copied: &mut HashSet<String>,
    ) -> Result<(), String> {
        match copy_verified(from, to, key, &tmp.join(key.replace('/', "."))).await {
            Ok(len) => {
                if len.is_some() {
                    copied.insert(key.to_string());
                }
                self.progress(|p| {
                    p.done += u64::from(new);
                    p.bytes_done += len.unwrap_or(0);
                });
                Ok(())
            }
            Err(e) => {
                self.progress(|p| p.failed += 1);
                Err(format!("Obiekt {key}: {e}"))
            }
        }
    }
}

/// Copies one object and reads it back from `to`. `None`: the old store has no such object (nothing to move).
async fn copy_verified(from: &dyn ObjectStore, to: &dyn ObjectStore, key: &str, tmp: &Path) -> io::Result<Option<u64>> {
    let mut body = match from.get(key).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    let mut file = tokio::fs::File::create(tmp).await?;
    let mut hasher = Sha256::new();
    let mut len = 0u64;
    while let Some(bytes) = next_data(&mut body).await? {
        hasher.update(&bytes);
        len += bytes.len() as u64;
        file.write_all(&bytes).await?;
    }
    file.sync_all().await?;
    drop(file);
    let put = to.put(key, tmp).await;
    let _ = tokio::fs::remove_file(tmp).await;
    put?;
    let mut back = to.get(key).await?;
    let mut check = Sha256::new();
    let mut back_len = 0u64;
    while let Some(bytes) = next_data(&mut back).await? {
        check.update(&bytes);
        back_len += bytes.len() as u64;
    }
    if back_len != len || check.finalize() != hasher.finalize() {
        return Err(io::Error::other("kopia w nowym magazynie różni się od oryginału (długość albo SHA-256)"));
    }
    Ok(Some(len))
}

async fn next_data(body: &mut Body) -> io::Result<Option<Bytes>> {
    loop {
        match std::future::poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx)).await {
            None => return Ok(None),
            Some(Err(_)) => return Err(io::Error::other("odczyt z magazynu się przerwał")),
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    return Ok(Some(data));
                }
            }
        }
    }
}
