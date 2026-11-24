//! Authenticated browser sync over WSS. The node stores and relays opaque ciphertext only.
//! Personal vaults (`browser-<userId>`) are stored per user. Shared vaults (`v-<hex>`) are stored once per
//! vault, and their members are checked against the vault membership on every hello and every put.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::header::ORIGIN;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::time::{Duration, Instant, sleep_until, timeout};

use crate::auth::{AuthService, AuthUser};
use crate::vaults::{Role, VaultLocks, VaultService};

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(8);
const FORBIDDEN_MESSAGE: &str = "Brak dostępu do tego sejfu.";
const READ_ONLY_MESSAGE: &str = "Sejf jest tylko do odczytu.";
const SLOW_DOWN_MESSAGE: &str = "Zbyt wiele zmian naraz. Zwolnij na chwilę.";
const TOO_LARGE_MESSAGE: &str = "Zmiana na żywo jest za duża; trafi do sejfu z najbliższym zapisem.";
/// Live deltas are a few keystrokes each: a bigger one is refused (the snapshot carries it instead).
const MAX_RELAY_CHARS: usize = 256 * 1024;
/// A socket that sends nothing (not even the client's `ping`, every 25 s) for this long is dead: closed, room freed.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// One socket gets at most one full `update` per this interval; puts landing meanwhile reach it as the newest stored
/// state (each revision holds every one before it). Typing itself reaches the others at once as `relay` frames.
const UPDATE_EVERY: Duration = Duration::from_secs(2);
/// A protocol ping from the server: browsers answer it by themselves, so old clients without `ping` and proxies
/// (Cloudflare closes idle sockets after 100 s) see traffic too.
const SERVER_PING_EVERY: Duration = Duration::from_secs(30);

/// A token bucket per connection: `rate` frames a second on average, bursts up to `burst`. Typing sends ~10 deltas
/// a second and saves at most 5 puts; a flood beyond this would freeze the other members' browsers.
struct Bucket { tokens: f64, rate: f64, burst: f64, last: std::time::Instant }

impl Bucket {
    fn new(rate: f64, burst: f64) -> Self { Self { tokens: burst, rate, burst, last: std::time::Instant::now() } }
    fn take(&mut self) -> bool {
        let now = std::time::Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.rate).min(self.burst);
        self.last = now;
        if self.tokens < 1.0 { return false; }
        self.tokens -= 1.0;
        true
    }
}
pub(crate) const PERSONAL_OFF_MESSAGE: &str = "Własne notatki nie są włączone dla tego konta.";
const STALE_KEY_MESSAGE: &str = "Sejf ma nowszy klucz. Odśwież stronę.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub schema: String,
    pub nonce: String,
    pub ciphertext: String,
    /// Vault key epoch the snapshot was encrypted with. Required on puts to shared vaults; absent on old data.
    #[serde(rename = "keyEpoch", default, skip_serializing_if = "Option::is_none")]
    pub key_epoch: Option<i64>,
}

impl Envelope {
    fn validate(&self) -> Result<(), SyncError> {
        if self.schema != "notes-encrypted-v1"
            || self.nonce.len() > 64
            || self.ciphertext.len() > MAX_FRAME_BYTES
            || self.key_epoch.is_some_and(|epoch| epoch < 1)
        {
            return Err(SyncError::Invalid);
        }
        let nonce = BASE64.decode(&self.nonce).map_err(|_| SyncError::Invalid)?;
        let ciphertext = BASE64
            .decode(&self.ciphertext)
            .map_err(|_| SyncError::Invalid)?;
        if nonce.len() != 12
            || ciphertext.len() < 16
            || ciphertext.len() > MAX_FRAME_BYTES
            || BASE64.encode(&nonce) != self.nonce
            || BASE64.encode(&ciphertext) != self.ciphertext
        {
            return Err(SyncError::Invalid);
        }
        Ok(())
    }
}

/// Who wrote a stored revision, set by the server from the writing session (never sent by a client). `agent_id` is
/// the chat (docs/MCP.md §3.3), or `None` for a person's own client. Revisions stored before this field have none.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub user_id: String,
    pub agent_id: Option<String>,
}

impl Author {
    pub fn person(user_id: &str) -> Self { Self { user_id: user_id.to_string(), agent_id: None } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ServerFrame {
    Snapshot {
        revision: u64,
        envelope: Option<Envelope>,
        author: Option<Author>,
        /// The client's hello named this revision: it holds the state already, so no envelope is sent.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        unchanged: bool,
    },
    Ack {
        revision: u64,
        author: Option<Author>,
    },
    Conflict {
        revision: u64,
        envelope: Option<Envelope>,
        author: Option<Author>,
    },
    Update {
        revision: u64,
        envelope: Envelope,
        author: Option<Author>,
    },
    Error {
        code: String,
        message: String,
    },
    /// `role: None` means access to the vault was revoked and the socket is closed after this frame.
    Access {
        role: Option<String>,
    },
    /// The vault moved to a new key epoch: fetch your pending key, then continue with the new epoch.
    Rekey {
        key_epoch: i64,
    },
    /// A member's live edit, passed on to the others as it came. Never stored: the next put carries it for good.
    Relay {
        envelope: Envelope,
    },
    /// The answer to a client's `ping`: keeps proxies (Cloudflare closes idle sockets) and lets the client see a dead link.
    Pong,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientFrame {
    /// `revision` and `nonce`: the revision the client holds with nothing unsent, and its envelope's nonce (a
    /// reconnect); omitted on a first open. Both must match the stored ones: a restored database repeats revisions.
    Hello { vault_id: String, #[serde(default)] revision: Option<u64>, #[serde(default)] nonce: Option<String> },
    Ping,
    Put {
        base_revision: u64,
        envelope: Envelope,
    },
    Relay {
        envelope: Envelope,
    },
}

#[derive(Clone)]
struct Published {
    source: u64,
    /// `Some(user)` addresses the frame to that user's sockets only (used for access changes).
    target: Option<String>,
    frame: ServerFrame,
}

pub struct BrowserSync {
    db: Mutex<Connection>,
    vaults: Arc<VaultService>,
    /// Shared with `VaultService`: serializes a put's role check and commit with removals and role changes.
    locks: Arc<VaultLocks>,
    rooms: Mutex<HashMap<(String, String), broadcast::Sender<Published>>>,
    next_connection: AtomicU64,
    /// Tests only: runs once inside a put, after its checks and before its commit, to force an interleaving.
    #[cfg(test)]
    pub(crate) before_commit: TestHook,
}

/// A one-shot callback a test puts between two steps of a request.
#[cfg(test)]
pub(crate) type TestHook = Mutex<Option<Box<dyn FnOnce() + Send>>>;

/// Takes the hook out (so it runs once and outside its own lock) and runs it.
#[cfg(test)]
pub(crate) fn run_hook(hook: &TestHook) {
    let work = hook.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    if let Some(work) = work { work(); }
}

/// Shared vault ids: `v-` + 32 lowercase hex, generated by `VaultService`.
pub fn is_shared_vault_id(id: &str) -> bool {
    id.len() == 34
        && id.starts_with("v-")
        && id.bytes().skip(2).all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn personal_vault_id(user_id: &str) -> String {
    format!("browser-{user_id}")
}

/// Shared vaults use the empty owner key, so every member reads and writes one revision sequence.
fn storage_owner<'a>(user_id: &'a str, vault_id: &str) -> &'a str {
    if is_shared_vault_id(vault_id) { "" } else { user_id }
}

impl BrowserSync {
    /// `locks` must be the same instance that `VaultService` was opened with.
    pub fn open(data_dir: &Path, vaults: Arc<VaultService>, locks: Arc<VaultLocks>) -> Result<Self, SyncError> {
        fs::create_dir_all(data_dir).map_err(|_| SyncError::Internal)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
                .map_err(|_| SyncError::Internal)?;
        }
        let db_path = data_dir.join("browser-sync.db");
        let db = Connection::open(&db_path).map_err(|_| SyncError::Internal)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&db_path, fs::Permissions::from_mode(0o600))
                .map_err(|_| SyncError::Internal)?;
        }
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| SyncError::Internal)?;
        db.pragma_update(None, "synchronous", "FULL")
            .map_err(|_| SyncError::Internal)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS browser_sync_vaults (
                user_id TEXT NOT NULL,
                vault_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                envelope_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(user_id, vault_id)
            );",
        )
        .map_err(|_| SyncError::Internal)?;
        let has_author: bool = db
            .query_row("SELECT count(*) FROM pragma_table_info('browser_sync_vaults') WHERE name='author_json'", [], |r| r.get::<_, i64>(0))
            .map_err(|_| SyncError::Internal)? > 0;
        if !has_author {
            db.execute_batch("ALTER TABLE browser_sync_vaults ADD COLUMN author_json TEXT").map_err(|_| SyncError::Internal)?;
        }
        Ok(Self {
            db: Mutex::new(db),
            vaults,
            locks,
            rooms: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(1),
            #[cfg(test)]
            before_commit: Mutex::default(),
        })
    }

    /// The caller's role for `vault_id`: owner of the personal vault, a member of a shared vault, or `None`.
    /// May `user_id` pass a live edit to the vault's other sockets? `Ok(false)`: a viewer, read-only.
    fn may_relay(&self, user_id: &str, vault_id: &str, envelope: &Envelope) -> Result<bool, SyncError> {
        envelope.validate()?;
        match self.access_role(user_id, vault_id)? {
            None => Err(SyncError::Forbidden),
            Some(role) => Ok(role >= Role::Editor),
        }
    }

    pub fn access_role(&self, user_id: &str, vault_id: &str) -> Result<Option<Role>, SyncError> {
        if vault_id == personal_vault_id(user_id) {
            // an account without its own notes is neither given nor sent the personal vault (docs/PANEL-ADMINA.md)
            let allowed = self.vaults.personal_allowed(user_id).map_err(|_| SyncError::Internal)?;
            return Ok(allowed.then_some(Role::Owner));
        }
        if !is_shared_vault_id(vault_id) {
            return Ok(None);
        }
        self.vaults
            .role_of(user_id, vault_id)
            .map_err(|_| SyncError::Internal)
    }

    fn room_key(user_id: &str, vault_id: &str) -> (String, String) {
        (storage_owner(user_id, vault_id).to_string(), vault_id.to_string())
    }

    fn subscribe(
        &self,
        user_id: &str,
        vault_id: &str,
    ) -> Result<broadcast::Receiver<Published>, SyncError> {
        let mut rooms = self.rooms.lock().map_err(|_| SyncError::Internal)?;
        let sender = rooms
            .entry(Self::room_key(user_id, vault_id))
            .or_insert_with(|| broadcast::channel(64).0);
        Ok(sender.subscribe())
    }

    /// Drops the room once its last socket has gone.
    fn release_room(&self, user_id: &str, vault_id: &str) {
        if let Ok(mut rooms) = self.rooms.lock() {
            let key = Self::room_key(user_id, vault_id);
            if rooms.get(&key).is_some_and(|sender| sender.receiver_count() == 0) {
                rooms.remove(&key);
            }
        }
    }

    fn publish(&self, user_id: &str, vault_id: &str, event: Published) {
        if let Ok(rooms) = self.rooms.lock()
            && let Some(sender) = rooms.get(&Self::room_key(user_id, vault_id))
        {
            let _ = sender.send(event);
        }
    }

    /// Removes a deleted shared vault's encrypted snapshot (shared vaults are stored under the empty user id).
    pub fn drop_vault(&self, vault_id: &str) -> Result<(), SyncError> {
        if !is_shared_vault_id(vault_id) { return Err(SyncError::Forbidden); }
        let db = self.db.lock().map_err(|_| SyncError::Internal)?;
        db.execute("DELETE FROM browser_sync_vaults WHERE user_id='' AND vault_id=?1", [vault_id]).map_err(|_| SyncError::Internal)?;
        Ok(())
    }

    /// Tells the user's open sockets about a role change (`Some(role)`) or a removal (`None`).
    pub fn notify_access(&self, vault_id: &str, user_id: &str, role: Option<String>) {
        self.publish(user_id, vault_id, Published {
            source: 0,
            target: Some(user_id.to_string()),
            frame: ServerFrame::Access { role },
        });
    }

    /// Tells every socket in a shared vault room about a new key epoch.
    /// A personal vault got a key of its own: the owner's other open tabs take it (their room is keyed by the user).
    pub fn notify_personal_rekey(&self, user_id: &str, key_epoch: i64) {
        self.publish(user_id, &personal_vault_id(user_id), Published { source: 0, target: None, frame: ServerFrame::Rekey { key_epoch } });
    }

    pub fn notify_rekey(&self, vault_id: &str, key_epoch: i64) {
        // Shared rooms ignore the user id (see `storage_owner`).
        self.publish("", vault_id, Published {
            source: 0,
            target: None,
            frame: ServerFrame::Rekey { key_epoch },
        });
    }

    #[cfg(test)]
    fn snapshot(&self, user_id: &str, vault_id: &str) -> Result<(u64, Option<Envelope>), SyncError> {
        self.stored(user_id, vault_id).map(|(revision, envelope, _)| (revision, envelope))
    }

    /// The stored revision of `vault_id` as `user_id` sees it, with its envelope and author (`(0, None, None)` when empty).
    pub(crate) fn stored(&self, user_id: &str, vault_id: &str) -> Result<(u64, Option<Envelope>, Option<Author>), SyncError> {
        let db = self.db.lock().map_err(|_| SyncError::Internal)?;
        let row: Option<(i64, String, Option<String>)> = db
            .query_row(
                "SELECT revision,envelope_json,author_json FROM browser_sync_vaults WHERE user_id=?1 AND vault_id=?2",
                params![storage_owner(user_id, vault_id), vault_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| SyncError::Internal)?;
        match row {
            None => Ok((0, None, None)),
            Some((revision, json, author)) => {
                let envelope: Envelope = serde_json::from_str(&json).map_err(|_| SyncError::Internal)?;
                envelope.validate()?;
                let revision = u64::try_from(revision).map_err(|_| SyncError::Internal)?;
                Ok((revision, Some(envelope), author_from(author)))
            }
        }
    }

    /// The current revision number and its author only (0 when empty), without reading the envelope out.
    pub(crate) fn revision(&self, user_id: &str, vault_id: &str) -> Result<(u64, Option<Author>), SyncError> {
        let db = self.db.lock().map_err(|_| SyncError::Internal)?;
        let row: Option<(i64, Option<String>)> = db
            .query_row(
                "SELECT revision,author_json FROM browser_sync_vaults WHERE user_id=?1 AND vault_id=?2",
                params![storage_owner(user_id, vault_id), vault_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| SyncError::Internal)?;
        let (revision, author) = row.unwrap_or((0, None));
        Ok((u64::try_from(revision).map_err(|_| SyncError::Internal)?, author_from(author)))
    }

    /// Sends an accepted put to the vault's open sockets, as the socket loop does for a person's put.
    pub(crate) fn publish_update(&self, user_id: &str, vault_id: &str, revision: u64, envelope: Envelope, author: Author) {
        self.publish(user_id, vault_id, Published {
            source: 0,
            target: None,
            frame: ServerFrame::Update { revision, envelope, author: Some(author) },
        });
    }

    /// Authorizes a put against the caller's current role (it may change while connected).
    /// Viewers get `ReadOnly`; non-members get `Err(Forbidden)`; stale key epochs get `StaleKey`.
    /// The role check and the commit run under the vault lock, so a removal that has returned is seen here.
    pub fn put(
        &self,
        user_id: &str,
        vault_id: &str,
        base_revision: u64,
        envelope: &Envelope,
    ) -> Result<PutResult, SyncError> {
        self.put_checked(&Author::person(user_id), vault_id, base_revision, envelope, || Ok(true))
    }

    /// A put by `author` (a person, or a person's chat). `may_write` runs under the vault lock after the person's role
    /// check, for a chat's own limits: `Ok(false)` answers `ReadOnly`, `Err(Forbidden)` as for a non-member.
    pub(crate) fn put_checked(
        &self,
        author: &Author,
        vault_id: &str,
        base_revision: u64,
        envelope: &Envelope,
        may_write: impl FnOnce() -> Result<bool, SyncError>,
    ) -> Result<PutResult, SyncError> {
        let user_id = author.user_id.as_str();
        self.locks.with(vault_id, || -> Result<PutResult, SyncError> {
            match self.access_role(user_id, vault_id)? {
                None => Err(SyncError::Forbidden),
                Some(role) if role < Role::Editor => Ok(PutResult::ReadOnly),
                Some(_) if !may_write()? => Ok(PutResult::ReadOnly),
                Some(_) => {
                    if is_shared_vault_id(vault_id) {
                        let current = self.vaults.key_epoch(vault_id).map_err(|_| SyncError::Internal)?;
                        if envelope.key_epoch.is_none_or(|epoch| epoch < current) {
                            return Ok(PutResult::StaleKey);
                        }
                    } else {
                        // A personal vault with a key of its own (docs/MCP.md §3.7) takes no more puts under the personal key.
                        let current = self.vaults.personal_key_epoch(user_id).map_err(|_| SyncError::Internal)?;
                        if current > 1 && envelope.key_epoch.unwrap_or(1) < current {
                            return Ok(PutResult::StaleKey);
                        }
                    }
                    #[cfg(test)]
                    run_hook(&self.before_commit);
                    self.store_put(user_id, vault_id, base_revision, envelope, author)
                }
            }
        })
    }

    fn store_put(
        &self,
        user_id: &str,
        vault_id: &str,
        base_revision: u64,
        envelope: &Envelope,
        author: &Author,
    ) -> Result<PutResult, SyncError> {
        envelope.validate()?;
        let frame_size = serde_json::to_vec(envelope).map_err(|_| SyncError::Invalid)?.len();
        if frame_size > MAX_FRAME_BYTES || base_revision > i64::MAX as u64 {
            return Err(SyncError::Invalid);
        }
        let owner = storage_owner(user_id, vault_id);
        let mut db = self.db.lock().map_err(|_| SyncError::Internal)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SyncError::Internal)?;
        let current: Option<(i64, String, Option<String>)> = tx
            .query_row(
                "SELECT revision,envelope_json,author_json FROM browser_sync_vaults WHERE user_id=?1 AND vault_id=?2",
                params![owner, vault_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| SyncError::Internal)?;
        let current_revision = current.as_ref().map_or(0, |row| row.0);
        if current_revision < 0 {
            return Err(SyncError::Internal);
        }
        if current_revision as u64 != base_revision {
            let (envelope, stored_author) = match current {
                Some((_, json, author)) => (Some(serde_json::from_str(&json).map_err(|_| SyncError::Internal)?), author_from(author)),
                None => (None, None),
            };
            return Ok(PutResult::Conflict {
                revision: current_revision as u64,
                envelope,
                author: stored_author,
            });
        }
        let next_revision = current_revision.checked_add(1).ok_or(SyncError::Internal)?;
        let json = serde_json::to_string(envelope).map_err(|_| SyncError::Invalid)?;
        let updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_secs()).ok())
            .unwrap_or(i64::MAX);
        let author_json = serde_json::to_string(author).map_err(|_| SyncError::Internal)?;
        tx.execute(
            "INSERT INTO browser_sync_vaults(user_id,vault_id,revision,envelope_json,updated_at,author_json)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(user_id,vault_id) DO UPDATE SET revision=excluded.revision,envelope_json=excluded.envelope_json,updated_at=excluded.updated_at,author_json=excluded.author_json",
            params![owner, vault_id, next_revision, json, updated_at, author_json],
        )
        .map_err(|_| SyncError::Internal)?;
        tx.commit().map_err(|_| SyncError::Internal)?;
        Ok(PutResult::Accepted(next_revision as u64))
    }

    fn next_connection_id(&self) -> u64 {
        self.next_connection.fetch_add(1, Ordering::Relaxed)
    }
}

/// A stored author column; unreadable text (never written by this module) reads as none.
fn author_from(text: Option<String>) -> Option<Author> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

pub enum PutResult {
    Accepted(u64),
    Conflict {
        revision: u64,
        envelope: Option<Envelope>,
        author: Option<Author>,
    },
    ReadOnly,
    /// The put's `keyEpoch` is missing or older than the vault's.
    StaleKey,
}

#[derive(Clone)]
struct ApiState {
    auth: Arc<AuthService>,
    sync: Arc<BrowserSync>,
}

pub fn routes(auth: Arc<AuthService>, sync: Arc<BrowserSync>) -> Router {
    Router::new()
        .route("/api/sync/ws", get(upgrade))
        .with_state(Arc::new(ApiState { auth, sync }))
}

async fn upgrade(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let auth = state.auth.clone();
    let user = match tokio::task::spawn_blocking(move || user_for_upgrade(&auth, &headers)).await {
        Ok(Ok(Some(user))) => user,
        Ok(Ok(None)) => return (StatusCode::UNAUTHORIZED, "authentication required").into_response(),
        Ok(Err(e)) => return e.into_response(),
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response(),
    };
    let sync = state.sync.clone();
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, user, sync))
}

async fn serve_socket(mut socket: WebSocket, user: AuthUser, sync: Arc<BrowserSync>) {
    let first = match timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= 4096 => text,
        Ok(Some(Ok(Message::Text(_)))) => { eprintln!("browser sync rejected oversized hello frame"); let _ = socket.send(Message::Close(None)).await; return; }
        Ok(Some(Ok(Message::Binary(_)))) => { eprintln!("browser sync expected text hello frame, received binary"); let _ = socket.send(Message::Close(None)).await; return; }
        Ok(Some(Ok(Message::Ping(_)))) => { eprintln!("browser sync expected hello frame, received ping"); let _ = socket.send(Message::Close(None)).await; return; }
        Ok(Some(Ok(Message::Pong(_)))) => { eprintln!("browser sync expected hello frame, received pong"); let _ = socket.send(Message::Close(None)).await; return; }
        Ok(Some(Ok(Message::Close(_)))) => { eprintln!("browser sync client closed before hello"); return; }
        Ok(Some(Err(error))) => { eprintln!("browser sync socket error before hello: {error:?}"); return; }
        Ok(None) => { eprintln!("browser sync socket ended before hello"); return; }
        Err(_) => { eprintln!("browser sync hello timeout"); let _ = socket.send(Message::Close(None)).await; return; }
    };
    let hello: ClientFrame = match serde_json::from_str(first.as_str()) {
        Ok(frame @ ClientFrame::Hello { .. }) => frame,
        Err(error) => {
            eprintln!("browser sync rejected hello JSON: {error}");
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        _ => {
            eprintln!("browser sync rejected non-hello first frame");
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    let (vault_id, held) = match hello {
        ClientFrame::Hello { vault_id, revision, nonce } if valid_vault_id(&vault_id) => (vault_id, revision.zip(nonce)),
        _ => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    // Subscribe before the membership check: a removal after this point is delivered to the room,
    // and a removal before it is seen by the check.
    let mut events = match sync.subscribe(&user.id, &vault_id) {
        Ok(events) => events,
        Err(_) => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    if !matches!(sync.access_role(&user.id, &vault_id), Ok(Some(_))) {
        drop(events);
        sync.release_room(&user.id, &vault_id);
        let (code, message) = if vault_id == personal_vault_id(&user.id) { ("personal-off", PERSONAL_OFF_MESSAGE) } else { ("forbidden", FORBIDDEN_MESSAGE) };
        let _ = send_error(&mut socket, code, message).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    let (revision, envelope, author) = match sync.stored(&user.id, &vault_id) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            drop(events);
            sync.release_room(&user.id, &vault_id);
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    // a reconnect that already holds this revision gets no envelope: a whole vault per dropped socket made reconnects slow
    let unchanged = envelope.as_ref().is_some_and(|e| held.as_ref() == Some(&(revision, e.nonce.clone())));
    let envelope = if unchanged { None } else { envelope };
    if send_frame(&mut socket, ServerFrame::Snapshot { revision, envelope, author, unchanged }).await.is_err() {
        drop(events);
        sync.release_room(&user.id, &vault_id);
        return;
    }
    let connection_id = sync.next_connection_id();
    let (mut relays, mut puts, mut pings) = (Bucket::new(60.0, 120.0), Bucket::new(10.0, 20.0), Bucket::new(1.0, 5.0));
    // the newest revision this socket has been given (snapshot, ack, conflict, update): an older update is never sent
    let mut sent = revision;
    let mut last_update: Option<Instant> = None;
    // the newest update held back by UPDATE_EVERY; a newer one replaces it (each revision holds every earlier one)
    let mut deferred: Option<ServerFrame> = None;
    let mut idle_until = Instant::now() + IDLE_TIMEOUT;
    let mut next_ping = Instant::now() + SERVER_PING_EVERY;
    loop {
        let flush_at = last_update.map_or_else(Instant::now, |t| t + UPDATE_EVERY);
        tokio::select! {
            _ = sleep_until(idle_until) => break,
            _ = sleep_until(next_ping) => {
                next_ping = Instant::now() + SERVER_PING_EVERY;
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            _ = sleep_until(flush_at), if deferred.is_some() => {
                last_update = Some(Instant::now());
                if let Some(frame @ ServerFrame::Update { revision, .. }) = deferred.take()
                    && revision > sent
                {
                    sent = revision;
                    if send_frame(&mut socket, frame).await.is_err() { break; }
                }
            }
            incoming = socket.recv() => {
                idle_until = Instant::now() + IDLE_TIMEOUT;
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    // protocol pings and pongs only keep the socket alive
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    _ => break,
                };
                if text.len() > MAX_FRAME_BYTES { break; }
                let Ok(frame) = serde_json::from_str::<ClientFrame>(text.as_str()) else { break; };
                match frame {
                    ClientFrame::Ping => {
                        if pings.take() && send_frame(&mut socket, ServerFrame::Pong).await.is_err() { break; }
                    }
                    ClientFrame::Put { .. } if !puts.take() => {
                        if send_error(&mut socket, "slow-down", SLOW_DOWN_MESSAGE).await.is_err() { break; }
                    }
                    ClientFrame::Relay { envelope } if envelope.ciphertext.len() > MAX_RELAY_CHARS => {
                        if send_error(&mut socket, "too-large", TOO_LARGE_MESSAGE).await.is_err() { break; }
                    }
                    // an over-limit delta is dropped without a reply: the sender's next snapshot carries the same text
                    ClientFrame::Relay { .. } if !relays.take() => {}
                    ClientFrame::Put { base_revision, envelope } => {
                        match sync.put(&user.id, &vault_id, base_revision, &envelope) {
                            Ok(PutResult::Accepted(revision)) => {
                                sent = sent.max(revision);
                                let author = Some(Author::person(&user.id));
                                if send_frame(&mut socket, ServerFrame::Ack { revision, author: author.clone() }).await.is_err() { break; }
                                sync.publish(&user.id, &vault_id, Published {
                                    source: connection_id,
                                    target: None,
                                    frame: ServerFrame::Update { revision, envelope, author },
                                });
                            }
                            Ok(PutResult::Conflict { revision, envelope, author }) => {
                                sent = sent.max(revision);
                                if send_frame(&mut socket, ServerFrame::Conflict { revision, envelope, author }).await.is_err() { break; }
                            }
                            Ok(PutResult::ReadOnly) => {
                                if send_error(&mut socket, "read-only", READ_ONLY_MESSAGE).await.is_err() { break; }
                            }
                            Ok(PutResult::StaleKey) => {
                                if send_error(&mut socket, "stale-key", STALE_KEY_MESSAGE).await.is_err() { break; }
                            }
                            Err(SyncError::Forbidden) => {
                                let _ = send_error(&mut socket, "forbidden", FORBIDDEN_MESSAGE).await;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    ClientFrame::Relay { envelope } => match sync.may_relay(&user.id, &vault_id, &envelope) {
                        Ok(true) => sync.publish(&user.id, &vault_id, Published { source: connection_id, target: None, frame: ServerFrame::Relay { envelope } }),
                        Ok(false) => { if send_error(&mut socket, "read-only", READ_ONLY_MESSAGE).await.is_err() { break; } }
                        Err(SyncError::Forbidden) => { let _ = send_error(&mut socket, "forbidden", FORBIDDEN_MESSAGE).await; break; }
                        Err(_) => break,
                    },
                    ClientFrame::Hello { .. } => break,
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if event.source == connection_id || event.target.as_deref().is_some_and(|t| t != user.id) {
                            continue;
                        }
                        let revoked = matches!(event.frame, ServerFrame::Access { role: None });
                        if let ServerFrame::Update { revision, author, .. } = &event.frame {
                            let (revision, by_chat) = (*revision, author.as_ref().is_some_and(|a| a.agent_id.is_some()));
                            if revision <= sent { continue; }
                            // A chat's revision is never folded into another: the client checks a chat's changes against
                            // the revision just before it (docs/MCP.md §7.1). What was held back goes first.
                            if by_chat {
                                if let Some(frame @ ServerFrame::Update { revision: held, .. }) = deferred.take()
                                    && held > sent
                                    && held < revision
                                    && send_frame(&mut socket, frame).await.is_err()
                                {
                                    break;
                                }
                            } else if last_update.is_some_and(|t| t.elapsed() < UPDATE_EVERY) {
                                // within UPDATE_EVERY of the last one: this newest frame goes when the interval ends
                                deferred = Some(event.frame);
                                continue;
                            }
                            sent = revision;
                            last_update = Some(Instant::now());
                        }
                        if send_frame(&mut socket, event.frame).await.is_err() || revoked { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Missed events may include a revocation, so re-check before resending the snapshot.
                        if !matches!(sync.access_role(&user.id, &vault_id), Ok(Some(_))) {
                            let _ = send_frame(&mut socket, ServerFrame::Access { role: None }).await;
                            break;
                        }
                        match sync.stored(&user.id, &vault_id) {
                            Ok((revision, envelope, author)) => {
                                sent = sent.max(revision);
                                if send_frame(&mut socket, ServerFrame::Snapshot { revision, envelope, author, unchanged: false }).await.is_err() { break; }
                            }
                            Err(_) => break,
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    drop(events);
    sync.release_room(&user.id, &vault_id);
    let _ = socket.send(Message::Close(None)).await;
}

async fn send_frame(socket: &mut WebSocket, frame: ServerFrame) -> Result<(), ()> {
    let text = serde_json::to_string(&frame).map_err(|_| ())?;
    if text.len() > MAX_FRAME_BYTES { return Err(()); }
    socket.send(Message::Text(text.into())).await.map_err(|_| ())
}

async fn send_error(socket: &mut WebSocket, code: &str, message: &str) -> Result<(), ()> {
    send_frame(socket, ServerFrame::Error { code: code.to_string(), message: message.to_string() }).await
}

fn valid_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && id != "."
        && id != ".."
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else { return false; };
    let Some(host) = headers.get("x-forwarded-host").or_else(|| headers.get("host")).and_then(|v| v.to_str().ok()) else { return false; };
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("http");
    (proto == "http" || proto == "https") && origin == format!("{proto}://{host}")
}

fn user_for_upgrade(auth: &AuthService, headers: &HeaderMap) -> Result<Option<AuthUser>, crate::auth::AuthError> {
    if !same_origin(headers) {
        return Err(crate::auth::AuthError::Forbidden);
    }
    auth.user_from_headers(headers)
}

#[derive(Debug)]
pub enum SyncError { Invalid, Internal, Forbidden }

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, header::COOKIE};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
    use crate::vaults::VaultError;
    use std::sync::atomic::AtomicBool;

    /// A snapshot at vault key epoch 1, the epoch the fixture's vaults start at.
    fn envelope(byte: u8) -> Envelope {
        Envelope {
            schema: "notes-encrypted-v1".into(),
            nonce: BASE64.encode([byte; 12]),
            ciphertext: BASE64.encode([byte; 32]),
            key_epoch: Some(1),
        }
    }

    fn key() -> crate::websync::Envelope {
        Envelope {
            schema: "notes-key-v1".into(),
            nonce: BASE64.encode([7u8; 12]),
            ciphertext: BASE64.encode([9u8; 48]),
            key_epoch: None,
        }
    }

    fn sealed(byte: u8) -> serde_json::Value {
        serde_json::json!({
            "schema": "notes-sealed-v1",
            "epk": {
                "kty": "EC",
                "crv": "P-256",
                "x": BASE64URL.encode([byte; 32]),
                "y": BASE64URL.encode([byte.wrapping_add(1); 32]),
            },
            "nonce": BASE64.encode([byte; 12]),
            "ciphertext": BASE64.encode([byte; 48]),
        })
    }

    /// Auth, vault and sync stores in one temporary data directory, plus three registered users.
    struct Fixture {
        auth: Arc<AuthService>,
        vaults: Arc<VaultService>,
        sync: BrowserSync,
        owner: String,
        editor: String,
        viewer: String,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let auth = Arc::new(AuthService::open(dir.path()).unwrap());
        let locks = Arc::new(VaultLocks::default());
        let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
        let sync = BrowserSync::open(dir.path(), vaults.clone(), locks).unwrap();
        let owner = auth.register("owner@example.test", "A long test password 1").unwrap().0.id;
        let editor = auth.register("editor@example.test", "A long test password 1").unwrap().0.id;
        let viewer = auth.register("viewer@example.test", "A long test password 1").unwrap().0.id;
        Fixture { auth, vaults, sync, owner, editor, viewer, _dir: dir }
    }

    /// Creates a shared vault owned by `f.owner` with `f.editor` and `f.viewer` joined.
    fn shared_vault(f: &Fixture) -> String {
        let vault = f.vaults.create(&f.owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        for (user, role) in [(&f.editor, "editor"), (&f.viewer, "viewer")] {
            let invite = f.vaults.create_invite(&f.owner, &vault, role).unwrap();
            f.vaults.accept_invite(user, &invite.token, &key(), 1).unwrap();
        }
        vault
    }

    #[test]
    fn storage_is_scoped_by_account_and_vault_and_uses_compare_and_swap() {
        let dir = tempfile::tempdir().unwrap();
        let locks = Arc::new(VaultLocks::default());
        let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
        let sync = BrowserSync::open(dir.path(), vaults, locks).unwrap();
        assert!(matches!(sync.store_put("user-a", "browser-a", 0, &envelope(1), &Author::person("user-a")).unwrap(), PutResult::Accepted(1)));
        assert!(matches!(sync.store_put("user-a", "browser-a", 0, &envelope(2), &Author::person("user-a")).unwrap(), PutResult::Conflict { revision: 1, .. }));
        assert!(matches!(sync.store_put("user-b", "browser-a", 0, &envelope(3), &Author::person("user-b")).unwrap(), PutResult::Accepted(1)));
        assert_eq!(sync.snapshot("user-a", "browser-a").unwrap(), (1, Some(envelope(1))));
        assert_eq!(sync.snapshot("user-a", "browser-b").unwrap(), (0, None));
    }

    #[test]
    fn validates_envelope_and_vault_ids() {
        let invalid = Envelope { nonce: BASE64.encode([1; 10]), ..envelope(1) };
        assert!(invalid.validate().is_err());
        assert!(valid_vault_id("browser-user_01.v1"));
        assert!(!valid_vault_id("../other"));
        assert!(!valid_vault_id(""));
        assert!(is_shared_vault_id(&format!("v-{}", "a".repeat(32))));
        assert!(!is_shared_vault_id(&format!("v-{}", "A".repeat(32))));
        assert!(!is_shared_vault_id(&format!("v-{}", "a".repeat(31))));
    }

    #[test]
    fn websocket_frames_use_camel_case_fields() {
        let hello: ClientFrame = serde_json::from_str(r#"{"type":"hello","vaultId":"browser-a"}"#).unwrap();
        assert!(matches!(hello, ClientFrame::Hello { vault_id, revision: None, nonce: None } if vault_id == "browser-a"));
        let put: ClientFrame = serde_json::from_str(r#"{"type":"put","baseRevision":4,"envelope":{"schema":"notes-encrypted-v1","nonce":"AQEBAQEBAQEBAQEB","ciphertext":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}}"#).unwrap();
        assert!(matches!(put, ClientFrame::Put { base_revision: 4, .. }));
        let error = serde_json::to_string(&ServerFrame::Error { code: "read-only".into(), message: "m".into() }).unwrap();
        assert_eq!(error, r#"{"type":"error","code":"read-only","message":"m"}"#);
        let access = serde_json::to_string(&ServerFrame::Access { role: None }).unwrap();
        assert_eq!(access, r#"{"type":"access","role":null}"#);
    }

    #[test]
    fn websocket_origin_is_required_and_exact() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("notes.example"));
        assert!(!same_origin(&headers));
        headers.insert(ORIGIN, HeaderValue::from_static("https://attacker.example"));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert!(!same_origin(&headers));
        headers.insert(ORIGIN, HeaderValue::from_static("https://notes.example"));
        assert!(same_origin(&headers));
    }

    #[test]
    fn upgrade_requires_same_origin_and_an_authenticated_session() {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthService::open(dir.path()).unwrap();
        let (user, token) = auth.register("sync@example.test", "Sync test password 1").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("notes.example"));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.insert(ORIGIN, HeaderValue::from_static("https://attacker.example"));
        assert!(matches!(user_for_upgrade(&auth, &headers), Err(crate::auth::AuthError::Forbidden)));

        headers.insert(ORIGIN, HeaderValue::from_static("https://notes.example"));
        assert!(matches!(user_for_upgrade(&auth, &headers), Ok(None)));
        headers.insert(COOKIE, HeaderValue::from_str(&format!("notes_session={token}")).unwrap());
        assert_eq!(user_for_upgrade(&auth, &headers).unwrap(), Some(user));
    }

    #[test]
    fn a_bucket_allows_a_burst_then_its_rate() {
        let mut b = Bucket::new(10.0, 3.0);
        assert_eq!((0..5).map(|_| b.take()).collect::<Vec<_>>(), [true, true, true, false, false]);
        std::thread::sleep(std::time::Duration::from_millis(120)); // one token back at 10 a second
        assert!(b.take());
        assert!(!b.take());
    }

    #[test]
    fn live_edits_pass_for_writers_only_and_are_never_stored() {
        let f = fixture();
        let vault = shared_vault(&f);
        assert!(f.sync.may_relay(&f.editor, &vault, &envelope(1)).unwrap());
        assert!(!f.sync.may_relay(&f.viewer, &vault, &envelope(1)).unwrap());
        assert!(matches!(f.sync.may_relay("stranger", &vault, &envelope(1)), Err(SyncError::Forbidden)));
        assert!(f.sync.snapshot(&f.editor, &vault).unwrap().1.is_none()); // nothing was stored
        let frame = serde_json::to_string(&ServerFrame::Relay { envelope: envelope(1) }).unwrap();
        assert!(frame.starts_with(r#"{"type":"relay","envelope":"#), "{frame}");
        assert!(matches!(serde_json::from_str::<ClientFrame>(&frame).unwrap(), ClientFrame::Relay { .. }));
    }

    /// The role is read on every relay frame (no per-socket cache): a removal, a downgrade or personal-off made by any
    /// path, also one that tells no socket (an account deletion, the CLI), stops the next delta.
    #[test]
    fn live_edits_stop_right_after_a_removal_a_downgrade_or_personal_off() {
        let f = fixture();
        let vault = shared_vault(&f);
        assert!(f.sync.may_relay(&f.editor, &vault, &envelope(1)).unwrap());
        f.vaults.set_member_role(&f.owner, &vault, &f.editor, "viewer").unwrap();
        assert!(!f.sync.may_relay(&f.editor, &vault, &envelope(1)).unwrap());
        f.vaults.remove_member(&f.owner, &vault, &f.editor).unwrap();
        assert!(matches!(f.sync.may_relay(&f.editor, &vault, &envelope(1)), Err(SyncError::Forbidden)));

        let personal = format!("browser-{}", f.owner);
        assert!(f.sync.may_relay(&f.owner, &personal, &envelope(1)).unwrap());
        // the admin panel writes through a connection of its own
        rusqlite::Connection::open(f._dir.path().join("auth.db")).unwrap()
            .execute("UPDATE web_users SET personal='off' WHERE user_id=?1", [&f.owner]).unwrap();
        assert!(matches!(f.sync.may_relay(&f.owner, &personal, &envelope(1)), Err(SyncError::Forbidden)));
    }

    #[test]
    fn personal_vault_is_owned_by_its_user_only() {
        let f = fixture();
        let personal = format!("browser-{}", f.owner);
        assert_eq!(f.sync.access_role(&f.owner, &personal).unwrap(), Some(Role::Owner));
        assert_eq!(f.sync.access_role(&f.editor, &personal).unwrap(), None);
        assert_eq!(f.sync.access_role(&f.owner, "browser-someone-else").unwrap(), None);
    }

    #[test]
    fn shared_vault_is_one_revision_sequence_for_all_members() {
        let f = fixture();
        let vault = shared_vault(&f);
        assert!(matches!(f.sync.put(&f.editor, &vault, 0, &envelope(1)).unwrap(), PutResult::Accepted(1)));
        assert!(matches!(f.sync.put(&f.owner, &vault, 0, &envelope(2)).unwrap(), PutResult::Conflict { revision: 1, .. }));
        assert!(matches!(f.sync.put(&f.owner, &vault, 1, &envelope(3)).unwrap(), PutResult::Accepted(2)));
        assert_eq!(f.sync.snapshot(&f.viewer, &vault).unwrap(), (2, Some(envelope(3))));
    }

    #[test]
    fn viewer_put_is_read_only_and_editor_put_is_published_to_other_members() {
        let f = fixture();
        let vault = shared_vault(&f);
        assert!(matches!(f.sync.put(&f.viewer, &vault, 0, &envelope(1)).unwrap(), PutResult::ReadOnly));
        assert_eq!(f.sync.snapshot(&f.owner, &vault).unwrap(), (0, None));

        let mut owner_events = f.sync.subscribe(&f.owner, &vault).unwrap();
        let mut viewer_events = f.sync.subscribe(&f.viewer, &vault).unwrap();
        let PutResult::Accepted(revision) = f.sync.put(&f.editor, &vault, 0, &envelope(2)).unwrap() else {
            panic!("editor put must be accepted");
        };
        // Mirrors the socket loop: the accepted put is published to the room under the editor's connection id.
        f.sync.publish(&f.editor, &vault, Published {
            source: 1,
            target: None,
            frame: ServerFrame::Update { revision, envelope: envelope(2), author: Some(Author::person(&f.editor)) },
        });
        assert!(matches!(owner_events.try_recv(), Ok(Published { source: 1, frame: ServerFrame::Update { revision: 1, .. }, .. })));
        assert!(matches!(viewer_events.try_recv(), Ok(Published { source: 1, frame: ServerFrame::Update { revision: 1, .. }, .. })));
    }

    #[test]
    fn non_member_is_forbidden_and_personal_vault_stays_per_user() {
        let f = fixture();
        let vault = shared_vault(&f);
        let outsider = f.auth.register("outsider@example.test", "A long test password 1").unwrap().0.id;
        assert_eq!(f.sync.access_role(&outsider, &vault).unwrap(), None);
        assert!(matches!(f.sync.put(&outsider, &vault, 0, &envelope(1)), Err(SyncError::Forbidden)));
        assert!(matches!(f.sync.put(&f.owner, "v-ffffffffffffffffffffffffffffffff", 0, &envelope(1)), Err(SyncError::Forbidden)));
        let personal = format!("browser-{}", f.owner);
        assert!(matches!(f.sync.put(&f.owner, &personal, 0, &envelope(1)).unwrap(), PutResult::Accepted(1)));
        assert_eq!(f.sync.snapshot(&f.editor, &personal).unwrap(), (0, None));
    }

    #[test]
    fn downgrade_and_removal_are_seen_on_the_next_put_and_notified_to_that_user_only() {
        let f = fixture();
        let vault = shared_vault(&f);
        let mut editor_events = f.sync.subscribe(&f.editor, &vault).unwrap();
        let mut owner_events = f.sync.subscribe(&f.owner, &vault).unwrap();

        f.vaults.set_member_role(&f.owner, &vault, &f.editor, "viewer").unwrap();
        f.sync.notify_access(&vault, &f.editor, Some("viewer".into()));
        assert!(matches!(f.sync.put(&f.editor, &vault, 0, &envelope(1)).unwrap(), PutResult::ReadOnly));
        assert!(matches!(
            editor_events.try_recv(),
            Ok(Published { target: Some(ref t), frame: ServerFrame::Access { role: Some(ref r) }, .. }) if t == &f.editor && r == "viewer"
        ));
        // The room carries the event for everyone; the socket loop drops it for other users.
        assert!(owner_events.try_recv().is_ok_and(|e| e.target.as_deref() == Some(f.editor.as_str())));

        f.vaults.remove_member(&f.owner, &vault, &f.editor).unwrap();
        f.sync.notify_access(&vault, &f.editor, None);
        assert!(matches!(f.sync.put(&f.editor, &vault, 0, &envelope(1)), Err(SyncError::Forbidden)));
        assert!(matches!(
            editor_events.try_recv(),
            Ok(Published { frame: ServerFrame::Access { role: None }, .. })
        ));
        assert!(matches!(f.sync.access_role(&f.editor, &vault), Ok(None)));
        assert!(matches!(f.vaults.detail(&f.editor, &vault), Err(VaultError::NotFound)));
    }

    #[test]
    fn shared_puts_need_the_current_key_epoch_and_personal_vaults_do_not() {
        let f = fixture();
        let vault = shared_vault(&f);
        let mut without_epoch = envelope(1);
        without_epoch.key_epoch = None;
        assert!(matches!(f.sync.put(&f.editor, &vault, 0, &without_epoch).unwrap(), PutResult::StaleKey));
        assert!(matches!(f.sync.put(&f.editor, &vault, 0, &envelope(1)).unwrap(), PutResult::Accepted(1)));

        f.vaults
            .rotate(&f.owner, &vault, 2, &[(f.owner.clone(), sealed(1)), (f.editor.clone(), sealed(2)), (f.viewer.clone(), sealed(3))])
            .unwrap();
        assert!(matches!(f.sync.put(&f.editor, &vault, 1, &envelope(2)).unwrap(), PutResult::StaleKey));
        assert!(matches!(f.sync.put(&f.viewer, &vault, 1, &envelope(2)).unwrap(), PutResult::ReadOnly));
        let mut current = envelope(2);
        current.key_epoch = Some(2);
        assert!(matches!(f.sync.put(&f.editor, &vault, 1, &current).unwrap(), PutResult::Accepted(2)));

        let personal = format!("browser-{}", f.owner);
        without_epoch.key_epoch = None;
        assert!(matches!(f.sync.put(&f.owner, &personal, 0, &without_epoch).unwrap(), PutResult::Accepted(1)));
    }

    #[test]
    fn rekey_and_stale_key_frames_and_optional_key_epoch_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&ServerFrame::Rekey { key_epoch: 2 }).unwrap(),
            r#"{"type":"rekey","keyEpoch":2}"#,
        );
        let without = serde_json::to_string(&Envelope { key_epoch: None, ..envelope(1) }).unwrap();
        assert!(!without.contains("keyEpoch"));
        let epoch_envelope = Envelope { key_epoch: Some(3), ..envelope(1) };
        let wire = serde_json::to_value(&epoch_envelope).unwrap();
        assert_eq!(wire["keyEpoch"], 3);
        let parsed: Envelope = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed, epoch_envelope);
    }

    #[test]
    fn a_put_started_after_a_removal_returned_is_refused_under_concurrent_puts() {
        let f = fixture();
        let vault = shared_vault(&f);
        let removed = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                let mut revision = 0;
                for i in 0..300u32 {
                    // Read the flag before the put. Once the removal has returned, no put may pass the role check.
                    let removed_before = removed.load(Ordering::SeqCst);
                    match f.sync.put(&f.editor, &vault, revision, &envelope((i % 250) as u8)) {
                        Ok(PutResult::Accepted(next)) => {
                            assert!(!removed_before, "put accepted after removal returned");
                            revision = next;
                        }
                        Ok(PutResult::Conflict { revision: current, .. }) => {
                            assert!(!removed_before, "put passed the role check after removal returned");
                            revision = current;
                        }
                        Err(SyncError::Forbidden) => {}
                        _ => panic!("unexpected put result"),
                    }
                }
            });
            std::thread::sleep(std::time::Duration::from_millis(2));
            f.vaults.remove_member(&f.owner, &vault, &f.editor).unwrap();
            removed.store(true, Ordering::SeqCst);
            writer.join().unwrap();
        });
        assert!(matches!(f.sync.put(&f.editor, &vault, 0, &envelope(1)), Err(SyncError::Forbidden)));
    }
}

#[cfg(test)]
#[path = "websync_ws_tests.rs"]
mod ws_tests;
