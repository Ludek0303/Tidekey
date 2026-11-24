//! Encrypted file attachments (docs/PLIKI.md §3–4). The server keeps ciphertext it cannot read: it sees sizes,
//! states, the metadata envelope as opaque text, and blake3 of the ciphertext. Bytes are stored exactly as the
//! client sent them, one object per file in the store (`objstore`). Parts wait in `<data>/attachments/.part`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::audit;
use crate::auth::{AuthService, AuthUser, FOREIGN_REQUEST, Refused, authorize};
use crate::objstore::{self, Backends, LOCAL, ObjectStore, SwitchableStore};
use crate::vaults::{Role, VaultLocks, now_millis};
use crate::websync::BrowserSync;

#[path = "files_storage.rs"]
mod storage;
use storage::Storage;
pub use storage::{Progress, StorageStatus};

/// Plaintext bytes per secretstream chunk (`PLAIN_CHUNK` in PLIKI.md §2) and the tag that follows each one.
pub(crate) const PLAIN_CHUNK: u64 = 1_048_576;
const ABYTES: u64 = 17;
pub(crate) const CIPHER_CHUNK: u64 = PLAIN_CHUNK + ABYTES;
/// "NOTESF2\n" and the 24-byte secretstream header, in front of the first chunk.
const HEAD: u64 = 32;
const MIB: u64 = 1024 * 1024;
const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
const META_MAX_BYTES: usize = 4096;
const META_SCHEMA: &str = "notes-file-meta-v2";
const MAX_BODY_BYTES: usize = 64 * 1024;
/// Room for one chunk body (chunk 0 with the head is the largest) and nothing more.
const CHUNK_BODY_LIMIT: usize = (HEAD + CIPHER_CHUNK) as usize + 1024;
const MAX_SCOPE_MEMBERS: usize = 500;
const PART_DIR: &str = ".part";

const UPLOADING: &str = "uploading";
const READY: &str = "ready";
const TRASHED: &str = "trashed";
const MISSING: &str = "missing";

const NO_VAULT: &str = "Nie znaleziono sejfu ani zaproszenia.";
const NO_FILE: &str = "Nie ma takiego pliku.";
const NO_SCOPE: &str = "Nie ma takiego zakresu.";
const NOT_UPLOADING: &str = "Ten plik nie jest w trakcie przesyłania.";
const NOT_TRASHED: &str = "Plik nie jest w koszu.";
const NOT_READY: &str = "Plik nie jest jeszcze gotowy.";
const NO_CONTENT: &str = "Treść pliku nie istnieje na serwerze.";
const ONLY_CREATOR: &str = "Tylko osoba, która zaczęła przesyłanie, może to zrobić.";
const BEHIND: &str = "Brakuje wcześniejszych porcji. Wysyłaj porcje po kolei.";
const BROKEN: &str = "Plik tymczasowy jest niekompletny. Anuluj przesyłanie i wyślij plik ponownie.";
const NO_ACCESS: &str = "Brak uprawnień do tej operacji.";
const TOO_MANY_UPLOADS: &str = "Masz już za dużo plików w trakcie przesyłania. Poczekaj, aż się skończą, albo anuluj część z nich.";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS files (
        vault_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        state TEXT NOT NULL,
        size INTEGER NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        scope TEXT,
        meta TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        deleted_at INTEGER,
        checksum TEXT,
        parent TEXT,
        PRIMARY KEY(vault_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS file_scopes (
        vault_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY(vault_id, scope, user_id)
    );
    CREATE TABLE IF NOT EXISTS vault_quotas (
        vault_id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL
    );";

const COLUMNS: &str = "file_id,state,size,received,scope,meta,created_by,created_at,completed_at,deleted_at,parent,kind";

/// Kinds of a child file (`parent` set): a thumbnail, or the text layer of a PDF or image (docs/OCR.md §3.2). A child
/// without a kind (written before the field) is a thumbnail.
pub const KIND_THUMB: &str = "thumb";
pub const KIND_TEXT: &str = "text";
const ORIGINAL_GONE: &str = "Plik, z którego jest ten tekst, nie jest już dostępny.";
/// What a chat hears about any file it may not read (docs/OCR.md §5.2): not whether it exists.
pub const OUT_OF_CHAT_SCOPE: &str = "Poza zakresem tego czatu.";

/// The records a chat's listing keeps: an original (no parent, no kind) or a text layer.
fn agent_kind(r: &FileRecord) -> Option<()> {
    match (r.parent.as_deref(), r.kind.as_deref()) {
        (None, None) => Some(()),
        (Some(_), Some(KIND_TEXT)) => Some(()),
        _ => None,
    }
}

/// A text layer (`kind = text`) is ready only while its original is: else its text would outlive the file it was read
/// from (docs/OCR.md §3.2). Other rows pass.
fn text_original_ready(db: &Connection, vault: &str, row: &FileRecord) -> Result<(), FileError> {
    if row.kind.as_deref() != Some(KIND_TEXT) {
        return Ok(());
    }
    let original = row.parent.as_deref().map(|p| find(db, vault, p)).transpose()?.flatten();
    if original.is_none_or(|o| o.state != READY) {
        return Err(FileError::Conflict(ORIGINAL_GONE));
    }
    Ok(())
}

/// Size limits from the environment (`NOTES_FILE_MAX_MB` …). Tests build it directly.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Largest file, in plaintext bytes.
    pub file_max_plain: u64,
    /// Ciphertext bytes one vault may hold, trash and uploads in progress included.
    pub vault_quota: u64,
    pub trash_days: i64,
    pub stale_hours: i64,
    /// Uploads in progress one person may have in one vault.
    pub max_parallel: u64,
}

impl Limits {
    pub fn from_env() -> Self {
        Self {
            file_max_plain: env_or("NOTES_FILE_MAX_MB", 100).saturating_mul(MIB),
            vault_quota: env_or("NOTES_VAULT_FILES_MB", 2048).saturating_mul(MIB),
            trash_days: env_or("NOTES_FILE_TRASH_DAYS", 30) as i64,
            stale_hours: env_or("NOTES_UPLOAD_STALE_HOURS", 24) as i64,
            max_parallel: env_or("NOTES_MAX_PARALLEL_UPLOADS", 4),
        }
    }
}

fn env_or(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Ciphertext length of a plaintext of `plain` bytes: the head, one tag per chunk, an empty file included.
fn cipher_len(plain: u64) -> u64 {
    HEAD + plain + plain.div_ceil(PLAIN_CHUNK).max(1) * ABYTES
}

/// Chunks in a ciphertext of `size` bytes. Only meaningful for sizes that pass `valid_size`.
fn chunk_count(size: u64) -> u64 {
    size.saturating_sub(HEAD).div_ceil(CIPHER_CHUNK).max(1)
}

/// Whether `size` can be the ciphertext of some plaintext (PLIKI.md §2): the chunk count and the plaintext length
/// must agree, so `chunks = max(1, ceil(plain/PLAIN_CHUNK))` and `size = 32 + plain + 17 * chunks`.
fn valid_size(size: u64) -> bool {
    if size < HEAD + ABYTES {
        return false;
    }
    let chunks = chunk_count(size);
    let Some(plain) = (size - HEAD).checked_sub(ABYTES * chunks) else {
        return false;
    };
    let min = if chunks == 1 { 0 } else { (chunks - 1).saturating_mul(PLAIN_CHUNK).saturating_add(1) };
    (min..=chunks.saturating_mul(PLAIN_CHUNK)).contains(&plain)
}

/// Length chunk `n` must have: chunk 0 carries the head, every other chunk is `CIPHER_CHUNK` but the last, which
/// takes the rest.
fn expected_len(size: u64, n: u64) -> u64 {
    let chunks = chunk_count(size);
    if chunks == 1 {
        size
    } else if n == 0 {
        HEAD + CIPHER_CHUNK
    } else if n + 1 < chunks {
        CIPHER_CHUNK
    } else {
        size - (HEAD + (chunks - 1) * CIPHER_CHUNK)
    }
}

/// Offset of chunk `n` in the object, which is also how many bytes of the part precede it.
fn chunk_start(size: u64, n: u64) -> u64 {
    if n == 0 { 0 } else { (HEAD + n * CIPHER_CHUNK).min(size) }
}

#[derive(Debug)]
pub enum FileError {
    Invalid(&'static str),
    Unauthorized,
    Forbidden(&'static str),
    NotFound(&'static str),
    Conflict(&'static str),
    /// Chunk out of order: carries how many chunks the server has.
    Behind(u64),
    TooLarge(&'static str),
    TooMany(&'static str),
    Internal,
}

impl IntoResponse for FileError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid(m) => (StatusCode::BAD_REQUEST, m),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Wymagane jest zalogowanie."),
            Self::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Self::Conflict(m) => (StatusCode::CONFLICT, m),
            Self::Behind(_) => (StatusCode::CONFLICT, BEHIND),
            Self::TooLarge(m) => (StatusCode::PAYLOAD_TOO_LARGE, m),
            Self::TooMany(m) => (StatusCode::TOO_MANY_REQUESTS, m),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "Nie udało się obsłużyć żądania."),
        };
        let body = match self {
            Self::Behind(received) => json!({ "message": message, "received": received }),
            _ => json!({ "message": message }),
        };
        no_store((status, Json(body)).into_response())
    }
}

fn db_err(_: rusqlite::Error) -> FileError {
    FileError::Internal
}

fn io_err(e: std::io::Error) -> FileError {
    // The kind only: paths and contents stay out of the log.
    eprintln!("notes-node files: błąd dysku ({:?})", e.kind());
    FileError::Internal
}

fn store_err(e: std::io::Error) -> FileError {
    eprintln!("notes-node files: błąd magazynu ({:?})", e.kind());
    FileError::Internal
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().entry(CACHE_CONTROL).or_insert(HeaderValue::from_static("no-store"));
    response
}

/// Vault ids and user ids: letters, digits, `-`, `_`. Never `.` or `/`, so they are safe as path components.
fn valid_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= 128 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// File and scope ids: 32 lowercase hex characters (128 random bits, PLIKI.md §1).
fn valid_hex32(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_vault(vault: &str) -> Result<(), FileError> {
    if valid_name(vault) { Ok(()) } else { Err(FileError::NotFound(NO_VAULT)) }
}

/// Members below `min` get 403. Checked after the file is looked up, so a hidden file stays 404 for everyone.
fn need(role: Role, min: Role) -> Result<(), FileError> {
    if role >= min { Ok(()) } else { Err(FileError::Forbidden(NO_ACCESS)) }
}

fn check_file(id: &str) -> Result<(), FileError> {
    if valid_hex32(id) { Ok(()) } else { Err(FileError::NotFound(NO_FILE)) }
}

/// The store key of a file: `<vault>/<id>`.
fn object_key(vault: &str, id: &str) -> String {
    format!("{vault}/{id}")
}

/// The metadata envelope as stored: text, at most 4 KiB. A JSON string is taken as the envelope text itself.
fn meta_text(meta: &Value) -> Result<String, FileError> {
    let text = match meta {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text.len() > META_MAX_BYTES {
        return Err(FileError::Invalid("Metadane pliku są za duże (limit 4 KiB)."));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|_| FileError::Invalid("Nieprawidłowa koperta metadanych."))?;
    if parsed["schema"] != META_SCHEMA || !parsed["nonce"].is_string() || !parsed["ciphertext"].is_string() {
        return Err(FileError::Invalid("Nieprawidłowa koperta metadanych."));
    }
    Ok(text)
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<FileRecord> {
    let size = r.get::<_, i64>(2)? as u64;
    Ok(FileRecord {
        id: r.get(0)?,
        state: r.get(1)?,
        size,
        chunks: chunk_count(size),
        received: r.get::<_, i64>(3)? as u64,
        scope: r.get(4)?,
        meta: r.get(5)?,
        created_by: r.get(6)?,
        created_at: r.get(7)?,
        completed_at: r.get(8)?,
        deleted_at: r.get(9)?,
        parent: r.get(10)?,
        kind: r.get(11)?,
    })
}

/// The wire shape of a file (PLIKI.md §3). `size` and `used` count ciphertext bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub id: String,
    pub state: String,
    pub size: u64,
    pub chunks: u64,
    pub received: u64,
    pub scope: Option<String>,
    pub meta: String,
    pub created_by: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub deleted_at: Option<i64>,
    /// The image a thumbnail belongs to: it follows that file into the trash and out of it.
    pub parent: Option<String>,
    /// `thumb` or `text` for a child (docs/OCR.md §3.2); absent on files and on thumbnails from before the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub files: Vec<FileRecord>,
    pub used: u64,
    pub quota: u64,
    pub trash_days: i64,
}

/// A stored object opened for streaming. Its bytes are the client's ciphertext, untouched.
pub struct Content {
    pub body: Body,
    pub size: u64,
}

impl IntoResponse for Content {
    fn into_response(self) -> Response {
        let mut response = self.body.into_response();
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from(self.size));
        headers.insert(CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
        headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'"));
        response
    }
}

/// What reconciliation changed. Counts only: the log line never names files.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub missing: u64,
    pub orphans: u64,
    pub parts_removed: u64,
    pub parts_truncated: u64,
    pub stale_uploads: u64,
    pub trash_purged: u64,
}

impl fmt::Display for Summary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "missing={} orphans={} parts_removed={} parts_truncated={} stale_uploads={} trash_purged={}",
            self.missing, self.orphans, self.parts_removed, self.parts_truncated, self.stale_uploads, self.trash_purged
        )
    }
}

/// What `sweep` kept (rows) and removed (ids, and whether the upload was stale).
type Swept = (Vec<FileRecord>, Vec<(String, bool)>);

/// `complete` decided what to do under the lock; the store step runs outside it.
enum Completion {
    Done(FileRecord),
    Store { size: u64, checksum: String },
}

pub struct FileService {
    db: Mutex<Connection>,
    /// `<data>/attachments`: where parts wait while they are uploaded.
    root: PathBuf,
    data: PathBuf,
    /// The current store; a migration switches it (`files_storage.rs`).
    store: SwitchableStore,
    /// Every store this node can use, by name (`objstore::LOCAL`, `objstore::SEAWEEDFS`).
    stores: Vec<(&'static str, Arc<dyn ObjectStore>)>,
    storage: Mutex<Storage>,
    sync: Arc<BrowserSync>,
    limits: Limits,
    // shortcut: these per-vault locks are not the ones BrowserSync and VaultService share, so a removal can race with
    // a chunk that already passed its role check (milliseconds). Upgrade by passing VaultLocks in, as websync does.
    locks: VaultLocks,
}

impl FileService {
    /// Opens `<data>/files.db` and creates the `.part` folder. `sync` answers the role questions, `store` keeps
    /// the ciphertext (as the only, local store).
    pub fn open(data_dir: &Path, sync: Arc<BrowserSync>, limits: Limits, store: Arc<dyn ObjectStore>) -> Result<Self, FileError> {
        Self::open_backends(data_dir, sync, limits, Backends { current: LOCAL, stores: vec![(LOCAL, store)] })
    }

    /// `open` with every store the node can use; the admin panel can move the files between them.
    pub fn open_backends(data_dir: &Path, sync: Arc<BrowserSync>, limits: Limits, backends: Backends) -> Result<Self, FileError> {
        let db = Connection::open(data_dir.join("files.db")).map_err(db_err)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(db_err)?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(db_err)?;
        db.execute_batch(SCHEMA).map_err(db_err)?;
        if db.prepare("SELECT parent FROM files LIMIT 0").is_err() {
            db.execute_batch("ALTER TABLE files ADD COLUMN parent TEXT").map_err(db_err)?;
        }
        if db.prepare("SELECT kind FROM files LIMIT 0").is_err() {
            db.execute_batch("ALTER TABLE files ADD COLUMN kind TEXT").map_err(db_err)?;
        }
        let root = data_dir.join("attachments");
        fs::create_dir_all(root.join(PART_DIR)).map_err(io_err)?;
        let store = backends.stores.iter().find(|(name, _)| *name == backends.current).ok_or(FileError::Internal)?.1.clone();
        Ok(Self {
            db: Mutex::new(db),
            root,
            data: data_dir.to_path_buf(),
            store: SwitchableStore::new(store),
            stores: backends.stores,
            storage: Mutex::new(Storage { current: backends.current, migration: None }),
            sync,
            limits,
            locks: VaultLocks::default(),
        })
    }

    /// The vault's file quota and whether it is the default (`Limits::vault_quota`) rather than the server admin's own.
    fn quota(&self, db: &Connection, vault: &str) -> Result<(u64, bool), FileError> {
        let own: Option<i64> = db.query_row("SELECT bytes FROM vault_quotas WHERE vault_id=?1", [vault], |r| r.get(0)).optional().map_err(db_err)?;
        Ok(own.map_or((self.limits.vault_quota, true), |b| (b as u64, false)))
    }

    /// For the admin panel: (bytes held, quota, quota is the default) of one vault.
    pub fn vault_usage(&self, vault: &str) -> Result<(u64, u64, bool), FileError> {
        let db = self.db()?;
        let (quota, default) = self.quota(&db, vault)?;
        Ok((used_bytes(&db, vault)?, quota, default))
    }

    /// Bytes of every file row, all vaults together.
    pub fn total_bytes(&self) -> Result<u64, FileError> {
        let total: i64 = self.db()?.query_row("SELECT COALESCE(SUM(size),0) FROM files", [], |r| r.get(0)).map_err(db_err)?;
        Ok(total as u64)
    }

    /// The server admin's quota for one vault; `None` goes back to the default.
    pub fn set_vault_quota(&self, vault: &str, bytes: Option<u64>) -> Result<(), FileError> {
        let db = self.db()?;
        match bytes {
            Some(b) => db.execute("INSERT INTO vault_quotas(vault_id,bytes) VALUES (?1,?2) ON CONFLICT(vault_id) DO UPDATE SET bytes=?2", params![vault, b as i64]),
            None => db.execute("DELETE FROM vault_quotas WHERE vault_id=?1", [vault]),
        }.map_err(db_err)?;
        Ok(())
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, FileError> {
        self.db.lock().map_err(|_| FileError::Internal)
    }

    // the vault is in the name: ids are unique per vault only, and a member who saw an id must not reach another
    // vault's upload with it
    fn part_path(&self, vault: &str, id: &str) -> PathBuf {
        self.root.join(PART_DIR).join(format!("{vault}.{id}"))
    }

    /// Runs `work` on the blocking pool. The database, the vault locks and the disk are synchronous.
    async fn blocking<T, F>(self: &Arc<Self>, work: F) -> Result<T, FileError>
    where
        T: Send + 'static,
        F: FnOnce(&FileService) -> Result<T, FileError> + Send + 'static,
    {
        let me = Arc::clone(self);
        match tokio::task::spawn_blocking(move || work(&me)).await {
            Ok(result) => result,
            Err(_) => Err(FileError::Internal),
        }
    }

    /// The caller's role in the vault. Non-members and unknown vaults get 404.
    fn role(&self, user: &str, vault: &str) -> Result<Role, FileError> {
        check_vault(vault)?;
        match self.sync.access_role(user, vault) {
            Ok(Some(role)) => Ok(role),
            Ok(None) => Err(FileError::NotFound(NO_VAULT)),
            Err(_) => Err(FileError::Internal),
        }
    }

    fn access(&self, user: &str, vault: &str, min: Role) -> Result<(), FileError> {
        need(self.role(user, vault)?, min)
    }

    /// Starts an upload. `(record, true)` for a new file, `(record, false)` for a retry of the same creation.
    /// The size is reserved against the vault quota at once.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        user: &str,
        vault: &str,
        id: &str,
        size: u64,
        meta: &Value,
        scope: Option<&str>,
        parent: Option<&str>,
    ) -> Result<(FileRecord, bool), FileError> {
        self.create_kind(user, vault, id, size, meta, scope, parent, None)
    }

    /// `create` with the child's kind. `kind` needs a `parent`. A text layer (`text`) is made after its original:
    /// that file must exist in this vault, not be an upload in progress, and share its scope, so the text never
    /// reaches anyone the original does not (docs/OCR.md §1 pkt 3). A thumbnail is sent before its image, so its
    /// parent is not checked (as before the field).
    #[allow(clippy::too_many_arguments)]
    pub fn create_kind(
        &self,
        user: &str,
        vault: &str,
        id: &str,
        size: u64,
        meta: &Value,
        scope: Option<&str>,
        parent: Option<&str>,
        kind: Option<&str>,
    ) -> Result<(FileRecord, bool), FileError> {
        check_vault(vault)?;
        if !valid_hex32(id) || scope.is_some_and(|s| !valid_hex32(s)) || parent.is_some_and(|p| !valid_hex32(p)) {
            return Err(FileError::Invalid("Nieprawidłowy identyfikator pliku."));
        }
        match kind {
            None => {}
            Some(KIND_THUMB | KIND_TEXT) if parent.is_some() => {}
            Some(_) => return Err(FileError::Invalid("Nieprawidłowy rodzaj pliku.")),
        }
        if !valid_size(size) {
            return Err(FileError::Invalid("Nieprawidłowy rozmiar pliku."));
        }
        if size > cipher_len(self.limits.file_max_plain) {
            return Err(FileError::TooLarge("Plik jest za duży. Limit ustala administrator serwera."));
        }
        let meta = meta_text(meta)?;
        self.locks.with(vault, || {
            need(self.role(user, vault)?, Role::Editor)?;
            let db = self.db()?;
            if let Some(scope) = scope
                && !in_scope(&db, vault, scope, user)?
            {
                return Err(FileError::NotFound(NO_SCOPE));
            }
            if kind == Some(KIND_TEXT) {
                let original = parent.and_then(|p| find(&db, vault, p).transpose()).transpose()?;
                match original {
                    Some(o) if o.parent.is_none() && o.state == READY && o.scope.as_deref() == scope => {}
                    _ => return Err(FileError::Invalid("Warstwa tekstu musi należeć do gotowego pliku z tym samym zakresem.")),
                }
            }
            // A retry of the same creation (same user, same id and size) is not a new file.
            if let Some(row) = find(&db, vault, id)? {
                return if row.created_by == user && row.size == size {
                    Ok((row, false))
                } else {
                    Err(FileError::Conflict("Ten identyfikator pliku jest już zajęty."))
                };
            }
            if uploading_count(&db, vault, user)? >= self.limits.max_parallel {
                return Err(FileError::TooMany(TOO_MANY_UPLOADS));
            }
            if used_bytes(&db, vault)? + size > self.quota(&db, vault)?.0 {
                return Err(FileError::TooLarge("Brakuje miejsca na pliki w tym sejfie."));
            }
            let now = now_millis();
            db.execute(
                "INSERT INTO files (vault_id,file_id,state,size,received,scope,meta,created_by,created_at,parent,kind)
                 VALUES (?1,?2,?3,?4,0,?5,?6,?7,?8,?9,?10)",
                params![vault, id, UPLOADING, size as i64, scope, meta, user, now, parent, kind],
            )
            .map_err(db_err)?;
            let row = FileRecord {
                id: id.to_string(),
                state: UPLOADING.to_string(),
                size,
                chunks: chunk_count(size),
                received: 0,
                scope: scope.map(str::to_string),
                meta,
                created_by: user.to_string(),
                created_at: now,
                completed_at: None,
                deleted_at: None,
                parent: parent.map(str::to_string),
                kind: kind.map(str::to_string),
            };
            Ok((row, true))
        })
    }

    /// Appends chunk `n` of an upload. Returns the number of chunks the server now has.
    pub fn put_chunk(&self, user: &str, vault: &str, id: &str, n: u64, body: &[u8]) -> Result<u64, FileError> {
        check_file(id)?;
        self.locks.with(vault, || {
            let role = self.role(user, vault)?;
            let row = {
                let db = self.db()?;
                load(&db, vault, id, user)?
            };
            need(role, Role::Editor)?;
            if row.created_by != user {
                return Err(FileError::Forbidden(ONLY_CREATOR));
            }
            if row.state != UPLOADING {
                return Err(FileError::Conflict(NOT_UPLOADING));
            }
            if n >= chunk_count(row.size) {
                return Err(FileError::Invalid("Nieprawidłowy numer porcji."));
            }
            if body.len() as u64 != expected_len(row.size, n) {
                return Err(FileError::Invalid("Porcja ma nieprawidłowy rozmiar."));
            }
            if n < row.received {
                return Ok(row.received); // a retry of a chunk already stored
            }
            if n > row.received {
                return Err(FileError::Behind(row.received));
            }
            self.append(vault, id, chunk_start(row.size, n), body)?;
            let db = self.db()?;
            db.execute(
                "UPDATE files SET received=?1 WHERE vault_id=?2 AND file_id=?3 AND state=?4",
                params![n as i64 + 1, vault, id, UPLOADING],
            )
            .map_err(db_err)?;
            Ok(n + 1)
        })
    }

    /// Writes a chunk at `keep` in the part, after cutting off anything past the last recorded chunk.
    fn append(&self, vault: &str, id: &str, keep: u64, body: &[u8]) -> Result<(), FileError> {
        let path = self.part_path(vault, id);
        let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(io_err)?;
        let len = file.metadata().map_err(io_err)?.len();
        if len < keep {
            return Err(FileError::Conflict(BROKEN));
        }
        if len > keep {
            file.set_len(keep).map_err(io_err)?;
        }
        file.write_all(body).map_err(io_err)?;
        file.sync_all().map_err(io_err)?;
        if keep == 0 {
            sync_dir(&self.root.join(PART_DIR))?; // the new name must survive a crash too
        }
        Ok(())
    }

    /// Completes an upload: checks the parts, hashes the ciphertext, puts the object in the store, checks its size
    /// there, and only then marks the file `ready`. A crash in between leaves an object with an `uploading` row,
    /// which reconciliation handles.
    pub async fn complete(self: &Arc<Self>, user: &str, vault: &str, id: &str) -> Result<FileRecord, FileError> {
        check_file(id)?;
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        let (size, checksum) = match self.blocking(move |s| s.complete_check(&u, &v, &i)).await? {
            Completion::Done(record) => return Ok(record),
            Completion::Store { size, checksum } => (size, checksum),
        };
        let key = object_key(vault, id);
        {
            // one store for the whole sequence: a switch in between would check the size in the other one
            let store = self.store.current().await;
            store.put(&key, &self.part_path(vault, id)).await.map_err(store_err)?;
            let stored = store.size(&key).await.map_err(store_err)?;
            if stored != size {
                eprintln!("notes-node files: obiekt ma inną długość niż plik");
                let _ = store.delete(&key).await;
                return Err(FileError::Internal);
            }
        }
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        // ORIGINAL_GONE leaves the row uploading: the client's cancel or the stale-upload sweep removes it and its object
        // (deleting the object here would race with a retried complete of the same upload)
        self.blocking(move |s| s.complete_finish(&u, &v, &i, &checksum)).await
    }

    /// The checks of `complete` and the checksum of the part, under the vault lock.
    fn complete_check(&self, user: &str, vault: &str, id: &str) -> Result<Completion, FileError> {
        self.locks.with(vault, || {
            let role = self.role(user, vault)?;
            let row = {
                let db = self.db()?;
                load(&db, vault, id, user)?
            };
            need(role, Role::Editor)?;
            if row.created_by != user {
                return Err(FileError::Forbidden(ONLY_CREATOR));
            }
            if row.state == READY {
                return Ok(Completion::Done(row)); // a retry after the response was lost
            }
            if row.state != UPLOADING {
                return Err(FileError::Conflict(NOT_UPLOADING));
            }
            if row.received != chunk_count(row.size) {
                return Err(FileError::Behind(row.received));
            }
            text_original_ready(&*self.db()?, vault, &row)?;
            let part = self.part_path(vault, id);
            let len = fs::metadata(&part).map_err(|_| FileError::Conflict(BROKEN))?.len();
            if len < row.size {
                return Err(FileError::Conflict(BROKEN));
            }
            if len > row.size {
                OpenOptions::new().write(true).open(&part).and_then(|f| f.set_len(row.size)).map_err(io_err)?;
            }
            File::open(&part).and_then(|f| f.sync_all()).map_err(io_err)?;
            let mut hasher = blake3::Hasher::new();
            hasher.update_reader(&mut File::open(&part).map_err(io_err)?).map_err(io_err)?;
            Ok(Completion::Store { size: row.size, checksum: hasher.finalize().to_hex().to_string() })
        })
    }

    /// Marks the file `ready` once its object is in the store, and drops the part.
    fn complete_finish(&self, user: &str, vault: &str, id: &str, checksum: &str) -> Result<FileRecord, FileError> {
        self.locks.with(vault, || {
            let db = self.db()?;
            let row = load(&db, vault, id, user)?;
            if row.state == READY {
                return Ok(row);
            }
            if row.state != UPLOADING {
                return Err(FileError::Conflict(NOT_UPLOADING));
            }
            // checked again here: the original may have gone to the trash while the object was being stored
            text_original_ready(&db, vault, &row)?;
            db.execute(
                "UPDATE files SET state=?1, completed_at=?2, checksum=?3 WHERE vault_id=?4 AND file_id=?5 AND state=?6",
                params![READY, now_millis(), checksum, vault, id, UPLOADING],
            )
            .map_err(db_err)?;
            remove_quietly(&self.part_path(vault, id));
            audit::event("file_uploaded", &[("vault", vault), ("file", id), ("size", &row.size.to_string())]);
            find(&db, vault, id)?.ok_or(FileError::Internal)
        })
    }

    /// The vault's files without text layers: clients from before them would show those as files.
    pub fn list(&self, user: &str, vault: &str) -> Result<Listing, FileError> {
        self.list_kinds(user, vault, false)
    }

    /// `list`, with the text layers (`kind = text`) when `with_text`.
    pub fn list_kinds(&self, user: &str, vault: &str, with_text: bool) -> Result<Listing, FileError> {
        self.access(user, vault, Role::Viewer)?;
        let db = self.db()?;
        let rows = {
            let mut stmt = db
                .prepare(&format!("SELECT {COLUMNS} FROM files WHERE vault_id=?1 ORDER BY created_at DESC, file_id"))
                .map_err(db_err)?;
            let rows = stmt.query_map(params![vault], row_from).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<FileRecord>>>().map_err(db_err)?
        };
        let scopes = user_scopes(&db, vault, user)?;
        let seen = |row: &FileRecord| {
            (row.state != UPLOADING || row.created_by == user)
                && row.scope.as_ref().is_none_or(|s| scopes.contains(s))
                && (with_text || row.kind.as_deref() != Some(KIND_TEXT))
        };
        Ok(Listing {
            files: rows.into_iter().filter(seen).collect(),
            used: used_bytes(&db, vault)?,
            quota: self.quota(&db, vault)?.0,
            trash_days: self.limits.trash_days,
        })
    }

    pub fn get(&self, user: &str, vault: &str, id: &str) -> Result<FileRecord, FileError> {
        check_file(id)?;
        self.access(user, vault, Role::Viewer)?;
        let db = self.db()?;
        load(&db, vault, id, user)
    }

    /// Streams the stored ciphertext of a `ready` or `trashed` file.
    pub async fn open_content(self: &Arc<Self>, user: &str, vault: &str, id: &str) -> Result<Content, FileError> {
        check_file(id)?;
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        let size = self.blocking(move |s| s.content_size(&u, &v, &i)).await?;
        let body = self.store.get(&object_key(vault, id)).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => FileError::NotFound(NO_CONTENT),
            _ => store_err(e),
        })?;
        Ok(Content { body, size })
    }

    /// What a Claude chat may see of the vault's files (docs/OCR.md §5.3, §5.4): the envelopes of the ready originals
    /// (to open their keys and see where they are embedded) and the ready text layers. Never thumbnails, uploads or the
    /// trash; still only what `user` may see (protected projects by scope).
    pub fn agent_listing(&self, user: &str, vault: &str) -> Result<Vec<FileRecord>, FileError> {
        let listing = self.list_kinds(user, vault, true)?;
        let rows: Vec<FileRecord> = listing.files.into_iter().filter(|r| r.state == READY && agent_kind(r).is_some()).collect();
        // a layer is listed only with its ready original
        let originals: std::collections::HashSet<String> = rows.iter().filter(|r| r.parent.is_none()).map(|r| r.id.clone()).collect();
        Ok(rows.into_iter().filter(|r| r.parent.as_ref().is_none_or(|p| originals.contains(p))).collect())
    }

    /// The text layers `user` can see in the vault (the listing's): the most a chat may fetch in one window. Counted
    /// over what the person sees, so the budget tells nothing about layers of projects they are not in.
    pub fn text_layer_count(&self, user: &str, vault: &str) -> Result<usize, FileError> {
        Ok(self.agent_listing(user, vault)?.iter().filter(|r| r.kind.as_deref() == Some(KIND_TEXT)).count())
    }

    /// The ciphertext of a text layer for a Claude chat (docs/OCR.md §5.3): only a ready `kind = text` record whose
    /// original is ready in this vault and visible to `user`. An original, a thumbnail or anything else is 404 for the
    /// chat, with the same message whether it exists or not.
    pub async fn open_text_content(self: &Arc<Self>, user: &str, vault: &str, id: &str) -> Result<Content, FileError> {
        check_file(id)?;
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        // the check and the opening of the object in one step under the vault lock, so a trash in between cannot let a
        // trashed original's text out
        let (size, body) = {
            let me = self.clone();
            let size = self.blocking(move |s| s.locks.with(&v, || s.text_layer_check(&u, &v, &i))).await?;
            let body = me.store.get(&object_key(vault, id)).await.map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => FileError::NotFound(OUT_OF_CHAT_SCOPE),
                _ => store_err(e),
            })?;
            (size, body)
        };
        // checked again after the object was opened: trashed or purged meanwhile, nothing is sent
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        self.blocking(move |s| s.text_layer_check(&u, &v, &i)).await?;
        Ok(Content { body, size })
    }

    /// A ready text layer whose original is ready and visible to `user`: its size; anything else the same 404.
    fn text_layer_check(&self, user: &str, vault: &str, id: &str) -> Result<u64, FileError> {
        self.access(user, vault, Role::Viewer)?;
        let db = self.db()?;
        let gone = || FileError::NotFound(OUT_OF_CHAT_SCOPE);
        let row = load(&db, vault, id, user).map_err(|_| gone())?;
        if row.kind.as_deref() != Some(KIND_TEXT) || row.state != READY {
            return Err(gone());
        }
        let parent = row.parent.as_deref().ok_or_else(gone)?;
        let original = load(&db, vault, parent, user).map_err(|_| gone())?;
        if original.state != READY || original.parent.is_some() || original.kind.is_some() {
            return Err(gone());
        }
        Ok(row.size)
    }

    fn content_size(&self, user: &str, vault: &str, id: &str) -> Result<u64, FileError> {
        self.access(user, vault, Role::Viewer)?;
        let row = {
            let db = self.db()?;
            load(&db, vault, id, user)?
        };
        match row.state.as_str() {
            UPLOADING => Err(FileError::Conflict(NOT_READY)),
            MISSING => Err(FileError::NotFound(NO_CONTENT)),
            _ => Ok(row.size),
        }
    }

    /// Replaces the metadata envelope (rename, or re-wrap after a key rotation).
    pub fn set_meta(&self, user: &str, vault: &str, id: &str, meta: &Value) -> Result<FileRecord, FileError> {
        check_file(id)?;
        let meta = meta_text(meta)?;
        self.locks.with(vault, || {
            let role = self.role(user, vault)?;
            let db = self.db()?;
            let row = load(&db, vault, id, user)?;
            need(role, Role::Editor)?;
            if row.state == UPLOADING {
                return Err(FileError::Conflict(NOT_UPLOADING));
            }
            db.execute("UPDATE files SET meta=?1 WHERE vault_id=?2 AND file_id=?3", params![meta, vault, id])
                .map_err(db_err)?;
            find(&db, vault, id)?.ok_or(FileError::Internal)
        })
    }

    /// `uploading`: cancel (row and part removed, then the store's object if any). `ready`: to the trash.
    /// `missing`: the row is dropped. The file's thumbnail (`parent`) always goes the same way.
    pub async fn delete(self: &Arc<Self>, user: &str, vault: &str, id: &str) -> Result<(), FileError> {
        check_file(id)?;
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        let objects = self.blocking(move |s| s.delete_locked(&u, &v, &i)).await?;
        for object in objects {
            // a crash before this leaves an object without a row, which reconciliation sets aside
            if let Err(e) = self.store.delete(&object_key(vault, &object)).await {
                eprintln!("notes-node files: usuwanie obiektu nie powiodło się ({:?})", e.kind());
            }
        }
        Ok(())
    }

    /// The row-level part of `delete`. Returns the ids whose objects should go too.
    fn delete_locked(&self, user: &str, vault: &str, id: &str) -> Result<Vec<String>, FileError> {
        self.locks.with(vault, || {
            let role = self.role(user, vault)?;
            let db = self.db()?;
            let row = load(&db, vault, id, user)?;
            need(role, Role::Editor)?;
            match row.state.as_str() {
                READY => {
                    db.execute(
                        "UPDATE files SET state=?1, deleted_at=?2 WHERE vault_id=?3 AND (file_id=?4 OR parent=?4) AND state=?5",
                        params![TRASHED, now_millis(), vault, id, READY],
                    )
                    .map_err(db_err)?;
                    audit::event("file_trashed", &[("vault", vault), ("file", id), ("size", &row.size.to_string())]);
                    Ok(Vec::new())
                }
                TRASHED => Err(FileError::Conflict("Plik jest już w koszu.")),
                state => {
                    let family = family(&db, vault, id)?;
                    for member in &family {
                        delete_row(&db, vault, member)?;
                        remove_quietly(&self.part_path(vault, member));
                    }
                    if state != UPLOADING {
                        audit::event("file_purged", &[("vault", vault), ("file", id), ("size", &row.size.to_string())]);
                    }
                    Ok(family)
                }
            }
        })
    }

    pub fn restore(&self, user: &str, vault: &str, id: &str) -> Result<FileRecord, FileError> {
        check_file(id)?;
        self.locks.with(vault, || {
            let role = self.role(user, vault)?;
            let db = self.db()?;
            let row = load(&db, vault, id, user)?;
            need(role, Role::Editor)?;
            if row.state != TRASHED {
                return Err(FileError::Conflict(NOT_TRASHED));
            }
            // a lone text layer comes back only with its original: it holds that file's text
            text_original_ready(&db, vault, &row)?;
            db.execute(
                "UPDATE files SET state=?1, deleted_at=NULL WHERE vault_id=?2 AND (file_id=?3 OR parent=?3) AND state=?4",
                params![READY, vault, id, TRASHED],
            )
            .map_err(db_err)?;
            audit::event("file_restored", &[("vault", vault), ("file", id), ("size", &row.size.to_string())]);
            find(&db, vault, id)?.ok_or(FileError::Internal)
        })
    }

    /// Permanent removal of a file and its thumbnail from the trash. The rows go in the same locked step as the check,
    /// so a restore cannot slip in between. If deleting an object then fails, it is an orphan: reconciliation logs it,
    /// and no live file ever loses its content.
    pub async fn purge(self: &Arc<Self>, user: &str, vault: &str, id: &str) -> Result<(), FileError> {
        check_file(id)?;
        let (u, v, i) = (user.to_string(), vault.to_string(), id.to_string());
        let (size, family) = self.blocking(move |s| s.purge_check(&u, &v, &i)).await?;
        audit::event("file_purged", &[("vault", vault), ("file", id), ("size", &size.to_string())]);
        for member in family {
            self.store.delete(&object_key(vault, &member)).await.map_err(store_err)?;
        }
        Ok(())
    }

    fn purge_check(&self, user: &str, vault: &str, id: &str) -> Result<(u64, Vec<String>), FileError> {
        self.locks.with(vault, || {
            let role = self.role(user, vault)?;
            let db = self.db()?;
            let row = load(&db, vault, id, user)?;
            need(role, Role::Admin)?;
            if row.state != TRASHED {
                return Err(FileError::Conflict(NOT_TRASHED));
            }
            let family = family(&db, vault, id)?;
            for member in &family {
                delete_row(&db, vault, member)?;
            }
            Ok((row.size, family))
        })
    }

    /// Replaces the people who may see a scope. The caller must be on the list, and once the scope exists only its
    /// members may change it (anyone else gets 404, as for its files).
    pub fn set_scope(&self, user: &str, vault: &str, scope: &str, members: &[String]) -> Result<(), FileError> {
        check_vault(vault)?;
        if !valid_hex32(scope) {
            return Err(FileError::Invalid("Nieprawidłowy zakres."));
        }
        let members: BTreeSet<&str> = members.iter().map(String::as_str).collect();
        if members.is_empty() || members.len() > MAX_SCOPE_MEMBERS {
            return Err(FileError::Invalid("Lista osób zakresu jest pusta albo za długa."));
        }
        if !members.contains(user) {
            return Err(FileError::Invalid("Na liście zakresu musisz być też Ty."));
        }
        self.locks.with(vault, || {
            self.access(user, vault, Role::Editor)?;
            for member in &members {
                if !valid_name(member) {
                    return Err(FileError::Invalid("Nieprawidłowe konto na liście zakresu."));
                }
                match self.sync.access_role(member, vault) {
                    Ok(Some(_)) => {}
                    Ok(None) => return Err(FileError::Invalid("Ktoś z listy nie należy do tego sejfu.")),
                    Err(_) => return Err(FileError::Internal),
                }
            }
            let mut db = self.db()?;
            let existing: Vec<String> = {
                let mut stmt = db
                    .prepare("SELECT user_id FROM file_scopes WHERE vault_id=?1 AND scope=?2")
                    .map_err(db_err)?;
                let rows = stmt.query_map(params![vault, scope], |r| r.get(0)).map_err(db_err)?;
                rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
            };
            if !existing.is_empty() && !existing.iter().any(|u| u == user) {
                return Err(FileError::NotFound(NO_SCOPE));
            }
            let tx = db.transaction().map_err(db_err)?;
            tx.execute("DELETE FROM file_scopes WHERE vault_id=?1 AND scope=?2", params![vault, scope]).map_err(db_err)?;
            for member in &members {
                tx.execute("INSERT INTO file_scopes (vault_id,scope,user_id) VALUES (?1,?2,?3)", params![vault, scope, member])
                    .map_err(db_err)?;
            }
            tx.commit().map_err(db_err)?;
            audit::event("file_scope_set", &[("vault", vault), ("scope", scope), ("members", &members.len().to_string())]);
            Ok(())
        })
    }

    /// A deleted vault's files: every row becomes trash that expired long ago, so the next reconciliation pass
    /// removes the rows and their objects; scopes and the quota go now.
    pub fn drop_vault(&self, vault: &str) -> Result<(), FileError> {
        self.locks.with(vault, || {
            let db = self.db()?;
            db.execute("UPDATE files SET state=?2, deleted_at=0 WHERE vault_id=?1", params![vault, TRASHED]).map_err(db_err)?;
            db.execute("DELETE FROM file_scopes WHERE vault_id=?1", params![vault]).map_err(db_err)?;
            db.execute("DELETE FROM vault_quotas WHERE vault_id=?1", params![vault]).map_err(db_err)?;
            Ok(())
        })
    }

    /// Drops `user`'s scope memberships in `vault`, so a re-invite does not bring the old scopes back. The vault
    /// tables live in auth.db and these in files.db, so this runs after the removal, not in its transaction.
    pub fn revoke_member(&self, vault: &str, user: &str) -> Result<(), FileError> {
        self.db()?.execute("DELETE FROM file_scopes WHERE vault_id=?1 AND user_id=?2", params![vault, user]).map_err(db_err)?;
        Ok(())
    }

    /// Reconciles the store with the database now (PLIKI.md §4). Also run at startup, hourly, and by `files-check`.
    pub async fn reconcile(self: &Arc<Self>) -> Result<Summary, FileError> {
        self.reconcile_at(now_millis()).await
    }

    /// `reconcile` with the clock given, so tests can age uploads and trash. A store error stops the pass: an
    /// unreachable store must never look like missing files.
    pub async fn reconcile_at(self: &Arc<Self>, now: i64) -> Result<Summary, FileError> {
        let mut summary = Summary::default();
        // held for the whole pass: a switch in the middle would compare rows with a store being emptied. The inner
        // store is passed down, because taking the read side again while a switch waits would deadlock.
        let store = self.store.current().await;
        let db_vaults = self.blocking(|s| s.db_vault_names()).await?;
        let store_vaults = store.vaults().await.map_err(store_err)?;
        let vaults: BTreeSet<String> = db_vaults.into_iter().chain(store_vaults).filter(|v| valid_name(v)).collect();
        for vault in vaults {
            self.reconcile_vault(&**store, &vault, now, &mut summary).await?;
        }
        summary.parts_removed += self.blocking(|s| s.remove_stray_parts()).await?;
        Ok(summary)
    }

    async fn reconcile_vault(self: &Arc<Self>, store: &dyn ObjectStore, vault: &str, now: i64, s: &mut Summary) -> Result<(), FileError> {
        // Abandoned uploads and expired trash go first, so the later steps see what is left.
        let v = vault.to_string();
        let (kept, gone) = self.blocking(move |f| f.sweep(&v, now)).await?;
        for (id, stale) in gone {
            if let Err(e) = store.delete(&object_key(vault, &id)).await {
                eprintln!("notes-node files: usuwanie obiektu nie powiodło się ({:?})", e.kind());
            }
            if stale { s.stale_uploads += 1 } else { s.trash_purged += 1 }
        }

        // Rows that should have an object: compare with the store. A store error aborts the pass, so an outage
        // never marks files missing.
        let listed = store.list(vault).await.map_err(store_err)?;
        let sizes: HashMap<&str, u64> = listed.iter().map(|(key, len)| (key.rsplit('/').next().unwrap_or_default(), *len)).collect();
        let mut changes = Vec::new();
        for row in kept.iter().filter(|r| r.state == READY || r.state == MISSING) {
            match sizes.get(row.id.as_str()) {
                Some(len) if row.state == MISSING && *len == row.size => changes.push((row.id.clone(), MISSING, READY)),
                None if row.state == READY => {
                    changes.push((row.id.clone(), READY, MISSING));
                    s.missing += 1;
                }
                _ => {}
            }
        }
        let v = vault.to_string();
        s.parts_truncated += self.blocking(move |f| f.apply_states(&v, changes, kept)).await?;

        // Objects with no row are set aside, never deleted. The rows are read after the listing: an upload that
        // starts meanwhile has its row before its object, so it cannot be mistaken for an orphan.
        let v = vault.to_string();
        let known: HashSet<String> = self.blocking(move |f| f.row_ids(&v)).await?;
        for (key, _) in &listed {
            let id = key.rsplit('/').next().unwrap_or_default();
            if !known.contains(id) {
                store.orphan(key).await.map_err(store_err)?;
                s.orphans += 1;
            }
        }
        Ok(())
    }

    /// Vaults with rows.
    fn db_vault_names(&self) -> Result<BTreeSet<String>, FileError> {
        let db = self.db()?;
        let mut stmt = db.prepare("SELECT DISTINCT vault_id FROM files").map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
        rows.collect::<rusqlite::Result<BTreeSet<String>>>().map_err(db_err)
    }

    /// Ids of all rows in a vault.
    fn row_ids(&self, vault: &str) -> Result<HashSet<String>, FileError> {
        let db = self.db()?;
        let mut stmt = db.prepare("SELECT file_id FROM files WHERE vault_id=?1").map_err(db_err)?;
        let rows = stmt.query_map(params![vault], |r| r.get::<_, String>(0)).map_err(db_err)?;
        rows.collect::<rusqlite::Result<HashSet<String>>>().map_err(db_err)
    }

    /// Drops abandoned uploads and expired trash from the database and the parts. Returns the rows that stay, and
    /// the ids of those removed, with whether each was a stale upload (the object goes next, outside the lock).
    fn sweep(&self, vault: &str, now: i64) -> Result<Swept, FileError> {
        let trash_cutoff = now - self.limits.trash_days * DAY_MS;
        let stale_cutoff = now - self.limits.stale_hours * HOUR_MS;
        self.locks.with(vault, || {
            let db = self.db()?;
            let rows = {
                let mut stmt = db
                    .prepare(&format!("SELECT {COLUMNS} FROM files WHERE vault_id=?1"))
                    .map_err(db_err)?;
                let rows = stmt.query_map(params![vault], row_from).map_err(db_err)?;
                rows.collect::<rusqlite::Result<Vec<FileRecord>>>().map_err(db_err)?
            };
            let ids: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();
            let mut kept = Vec::new();
            let mut gone = Vec::new();
            for row in rows {
                // a thumbnail whose image never got a record is an abandoned upload too
                let unclaimed = row.parent.as_ref().is_some_and(|p| !ids.contains(p));
                let stale = (row.state == UPLOADING || unclaimed) && row.created_at < stale_cutoff;
                let expired = row.state == TRASHED && row.deleted_at.is_some_and(|t| t < trash_cutoff);
                if !stale && !expired {
                    kept.push(row);
                    continue;
                }
                delete_row(&db, vault, &row.id)?;
                remove_quietly(&self.part_path(vault, &row.id));
                if !stale {
                    audit::event("file_purged", &[("vault", vault), ("file", &row.id), ("by", "retention")]);
                }
                gone.push((row.id, stale));
            }
            Ok((kept, gone))
        })
    }

    /// Applies the state changes reconciliation found, and trims uploads' parts to the chunks their rows record.
    /// Returns how many parts were cut back.
    fn apply_states(&self, vault: &str, changes: Vec<(String, &str, &str)>, kept: Vec<FileRecord>) -> Result<u64, FileError> {
        self.locks.with(vault, || {
            let db = self.db()?;
            for (id, from, to) in &changes {
                db.execute(
                    "UPDATE files SET state=?1 WHERE vault_id=?2 AND file_id=?3 AND state=?4",
                    params![to, vault, id, from],
                )
                .map_err(db_err)?;
            }
            let mut truncated = 0;
            for row in kept.iter().filter(|r| r.state == UPLOADING) {
                if trim_part(&self.part_path(vault, &row.id), chunk_start(row.size, row.received))? {
                    truncated += 1;
                }
            }
            Ok(truncated)
        })
    }

    /// Parts with no uploading row behind them are removed.
    fn remove_stray_parts(&self) -> Result<u64, FileError> {
        let Ok(entries) = fs::read_dir(self.root.join(PART_DIR)) else {
            return Ok(0);
        };
        let live: HashSet<String> = {
            let db = self.db()?;
            let mut stmt = db.prepare("SELECT vault_id || '.' || file_id FROM files WHERE state=?1").map_err(db_err)?;
            let rows = stmt.query_map(params![UPLOADING], |r| r.get(0)).map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        let mut removed = 0;
        for entry in entries {
            let name = entry.map_err(io_err)?.file_name().to_string_lossy().into_owned();
            if !live.contains(&name) {
                remove_quietly(&self.root.join(PART_DIR).join(&name));
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// Runs reconciliation every hour; the first run is at startup.
pub fn spawn_reconcile(files: Arc<FileService>) {
    tokio::spawn(async move {
        let mut hourly = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            hourly.tick().await;
            match files.reconcile().await {
                Ok(summary) => eprintln!("notes-node files: reconcile {summary}"),
                Err(_) => eprintln!("notes-node files: reconcile failed"),
            }
        }
    });
}

fn find(conn: &Connection, vault: &str, id: &str) -> Result<Option<FileRecord>, FileError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM files WHERE vault_id=?1 AND file_id=?2"),
        params![vault, id],
        row_from,
    )
    .optional()
    .map_err(db_err)
}

fn in_scope(conn: &Connection, vault: &str, scope: &str, user: &str) -> Result<bool, FileError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM file_scopes WHERE vault_id=?1 AND scope=?2 AND user_id=?3)",
        params![vault, scope, user],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// The scopes `user` belongs to in this vault.
fn user_scopes(conn: &Connection, vault: &str, user: &str) -> Result<HashSet<String>, FileError> {
    let mut stmt = conn.prepare("SELECT scope FROM file_scopes WHERE vault_id=?1 AND user_id=?2").map_err(db_err)?;
    let rows = stmt.query_map(params![vault, user], |r| r.get(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

/// May `user` see this row? Uploads only by their creator; scoped files only by the scope's members.
fn visible(conn: &Connection, vault: &str, row: &FileRecord, user: &str) -> Result<bool, FileError> {
    if row.state == UPLOADING && row.created_by != user {
        return Ok(false);
    }
    match &row.scope {
        Some(scope) => in_scope(conn, vault, scope, user),
        None => Ok(true),
    }
}

/// The row if it exists and the caller may see it; 404 otherwise, so a hidden file looks absent.
fn load(conn: &Connection, vault: &str, id: &str, user: &str) -> Result<FileRecord, FileError> {
    let row = find(conn, vault, id)?.ok_or(FileError::NotFound(NO_FILE))?;
    if visible(conn, vault, &row, user)? { Ok(row) } else { Err(FileError::NotFound(NO_FILE)) }
}

/// Rows of this user's uploads in progress in this vault.
fn uploading_count(conn: &Connection, vault: &str, user: &str) -> Result<u64, FileError> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE vault_id=?1 AND created_by=?2 AND state=?3",
            params![vault, user, UPLOADING],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    Ok(n as u64)
}

/// Ciphertext bytes the vault holds or has reserved: every row counts, uploads in progress and trash included.
fn used_bytes(conn: &Connection, vault: &str) -> Result<u64, FileError> {
    let used: i64 = conn
        .query_row("SELECT COALESCE(SUM(size),0) FROM files WHERE vault_id=?1", params![vault], |r| r.get(0))
        .map_err(db_err)?;
    Ok(used as u64)
}

/// The file and the files that hang on it (its thumbnail).
fn family(conn: &Connection, vault: &str, id: &str) -> Result<Vec<String>, FileError> {
    let mut stmt = conn.prepare("SELECT file_id FROM files WHERE vault_id=?1 AND (file_id=?2 OR parent=?2)").map_err(db_err)?;
    let rows = stmt.query_map(params![vault, id], |r| r.get(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

fn delete_row(conn: &Connection, vault: &str, id: &str) -> Result<(), FileError> {
    conn.execute("DELETE FROM files WHERE vault_id=?1 AND file_id=?2", params![vault, id]).map_err(db_err)?;
    Ok(())
}

/// Cuts a part back to `keep` bytes if it is longer. Returns whether anything was cut.
fn trim_part(path: &Path, keep: u64) -> Result<bool, FileError> {
    let Ok(meta) = fs::metadata(path) else {
        return Ok(false);
    };
    if meta.len() <= keep {
        return Ok(false);
    }
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|f| {
            f.set_len(keep)?;
            f.sync_all()
        })
        .map_err(io_err)?;
    Ok(true)
}

/// Deletion of a file that may already be gone: a missing file is not an error.
fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

fn sync_dir(path: &Path) -> Result<(), FileError> {
    File::open(path).and_then(|d| d.sync_all()).map_err(io_err)
}

/// Shared state for the file REST handlers.
struct Api {
    auth: Arc<AuthService>,
    files: Arc<FileService>,
}

pub fn routes(auth: Arc<AuthService>, files: Arc<FileService>) -> Router {
    Router::new()
        .route("/api/vaults/{id}/files", get(list_files).post(create_file))
        .route("/api/vaults/{id}/files/{file}", get(get_file).patch(patch_file).delete(delete_file))
        // the only route that takes a chunk-sized body; the global 1 MiB limit stays for everything else
        .route(
            "/api/vaults/{id}/files/{file}/chunks/{n}",
            put(put_chunk).layer(DefaultBodyLimit::max(CHUNK_BODY_LIMIT)),
        )
        .route("/api/vaults/{id}/files/{file}/complete", post(complete_file))
        .route("/api/vaults/{id}/files/{file}/content", get(file_content))
        .route("/api/vaults/{id}/files/{file}/restore", post(restore_file))
        .route("/api/vaults/{id}/files/{file}/purge", post(purge_file))
        .route("/api/vaults/{id}/file-scopes/{scope}", put(set_scope))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Arc::new(Api { auth, files }))
}

/// Same-origin check for mutations, then the session check, then `work` with the files and the caller.
async fn run<T, F, Fut>(api: Arc<Api>, headers: HeaderMap, mutating: bool, work: F) -> Response
where
    T: IntoResponse,
    F: FnOnce(Arc<FileService>, AuthUser) -> Fut,
    Fut: Future<Output = Result<T, FileError>>,
{
    let user = match authorize(api.auth.clone(), headers, mutating).await {
        Ok(user) => user,
        Err(Refused::Origin) => return FileError::Forbidden(FOREIGN_REQUEST).into_response(),
        Err(Refused::Session) => return FileError::Unauthorized.into_response(),
        Err(Refused::Internal) => return FileError::Internal.into_response(),
    };
    match work(api.files.clone(), user).await {
        Ok(value) => no_store(value.into_response()),
        Err(e) => e.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    id: String,
    size: u64,
    meta: Value,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

/// `GET …/files?kinds=text` also lists the text layers (docs/OCR.md §3.2).
#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    kinds: Option<String>,
}

#[derive(Deserialize)]
struct MetaBody {
    meta: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeBody {
    members: Vec<String>,
}

async fn list_files(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(vault): AxumPath<String>, Query(query): Query<ListQuery>) -> Response {
    let with_text = query.kinds.as_deref().is_some_and(|k| k.split(',').any(|k| k == KIND_TEXT));
    run(api, headers, false, move |files, user| async move {
        files.blocking(move |f| f.list_kinds(&user.id, &vault, with_text)).await.map(Json)
    })
    .await
}

async fn create_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath(vault): AxumPath<String>,
    Json(input): Json<CreateBody>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        let (record, created) = files
            .blocking(move |f| f.create_kind(&user.id, &vault, &input.id, input.size, &input.meta, input.scope.as_deref(), input.parent.as_deref(), input.kind.as_deref()))
            .await?;
        let status = if created { StatusCode::CREATED } else { StatusCode::OK };
        Ok((status, Json(record)))
    })
    .await
}

async fn get_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
) -> Response {
    run(api, headers, false, move |files, user| async move {
        files.blocking(move |f| f.get(&user.id, &vault, &file)).await.map(Json)
    })
    .await
}

async fn patch_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
    Json(input): Json<MetaBody>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        files.blocking(move |f| f.set_meta(&user.id, &vault, &file, &input.meta)).await.map(Json)
    })
    .await
}

async fn delete_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        files.delete(&user.id, &vault, &file).await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn put_chunk(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file, n)): AxumPath<(String, String, u64)>,
    body: Bytes,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        let received = files.blocking(move |f| f.put_chunk(&user.id, &vault, &file, n, &body)).await?;
        Ok(Json(json!({ "received": received })))
    })
    .await
}

async fn complete_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        files.complete(&user.id, &vault, &file).await.map(Json)
    })
    .await
}

async fn file_content(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
) -> Response {
    run(api, headers, false, move |files, user| async move { files.open_content(&user.id, &vault, &file).await }).await
}

async fn restore_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        files.blocking(move |f| f.restore(&user.id, &vault, &file)).await.map(Json)
    })
    .await
}

async fn purge_file(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, file)): AxumPath<(String, String)>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        files.purge(&user.id, &vault, &file).await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

async fn set_scope(
    State(api): State<Arc<Api>>,
    headers: HeaderMap,
    AxumPath((vault, scope)): AxumPath<(String, String)>,
    Json(input): Json<ScopeBody>,
) -> Response {
    run(api, headers, true, move |files, user| async move {
        files.blocking(move |f| f.set_scope(&user.id, &vault, &scope, &input.members)).await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
