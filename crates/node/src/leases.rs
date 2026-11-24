//! Short, opaque leases on a vault (docs/GITHUB.md §5): one device at a time updates a GitHub project.
//! The server does not know what a lease guards. Names are random 32-character hex strings, and neither
//! names nor holders are logged. The tables `vault_leases` (shared vaults) and `personal_leases` (Moje notatki) live in `auth.db` next to the vault tables.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::header::COOKIE;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post};
use axum::{Json, Router};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{AuthService, AuthUser, FOREIGN_REQUEST, Refused, authorize};
use crate::vaults::{Role, now_millis};

const MAX_TTL_SECONDS: i64 = 300;
const MAX_LEASES_PER_VAULT: i64 = 50;
const MAX_BODY_BYTES: usize = 1024;
/// Same name as in `auth.rs`, which keeps the cookie private.
const SESSION_COOKIE: &str = "notes_session";
const BAD_NAME: &str = "Nazwa blokady musi mieć 32 znaki szesnastkowe (0-9, a-f).";
const BAD_TTL: &str = "Czas blokady musi wynosić od 1 do 300 sekund.";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS vault_leases (
        vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        holder TEXT NOT NULL,
        until INTEGER NOT NULL,
        PRIMARY KEY(vault_id, name)
    );
    CREATE TABLE IF NOT EXISTS personal_leases (
        vault_id TEXT NOT NULL,
        name TEXT NOT NULL,
        holder TEXT NOT NULL,
        until INTEGER NOT NULL,
        PRIMARY KEY(vault_id, name)
    );";

// A personal vault (`browser-<user>`) has no row in `vaults`, so its leases sit in a table without that foreign key.
// shortcut: a deleted account's expired personal leases stay as rows until that id takes a lease again; sweep them in delete-user if it matters
fn table(vault_id: &str) -> &'static str {
    if vault_id.starts_with("browser-") { "personal_leases" } else { "vault_leases" }
}

#[derive(Debug, Clone, Copy)]
pub enum LeaseError {
    Invalid(&'static str),
    Unauthorized,
    Forbidden(&'static str),
    NotFound,
    TooMany,
    Internal,
}

impl IntoResponse for LeaseError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid(m) => (StatusCode::BAD_REQUEST, m),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Wymagane jest zalogowanie."),
            Self::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            Self::NotFound => (StatusCode::NOT_FOUND, "Nie znaleziono sejfu."),
            Self::TooMany => (StatusCode::TOO_MANY_REQUESTS, "W tym sejfie jest za dużo blokad. Spróbuj ponownie za chwilę."),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "Nie udało się obsłużyć żądania."),
        };
        no_store((status, Json(json!({ "error": message }))).into_response())
    }
}

/// `granted` and the time the lease ends: ours when granted, the holder's otherwise.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseView {
    pub granted: bool,
    pub until: i64,
}

/// Who asks: the user and the device's session. Only the same pair may extend or release a lease.
pub struct Who<'a> {
    pub user_id: &'a str,
    pub session: &'a str,
}

pub struct LeaseService {
    db: Mutex<Connection>,
}

impl LeaseService {
    /// Opens `vault_leases` inside `auth.db` (open `VaultService` first: leases reference `vaults`).
    pub fn open(data_dir: &Path) -> Result<Self, LeaseError> {
        let db = Connection::open(data_dir.join("auth.db")).map_err(internal)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(internal)?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(internal)?;
        db.execute_batch(SCHEMA).map_err(internal)?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, LeaseError> {
        self.db.lock().map_err(|_| LeaseError::Internal)
    }

    /// Takes the lease, extends it for the same holder, or reports the current holder's end time.
    pub fn acquire(&self, who: &Who, vault_id: &str, name: &str, ttl_seconds: i64, now: i64) -> Result<LeaseView, LeaseError> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(internal)?;
        let outcome = check_vault(&tx, vault_id, who.user_id).and_then(|()| acquire_in(&tx, who, vault_id, name, ttl_seconds, now));
        // Committed even when refused, so expired rows of the vault are dropped on every POST.
        tx.commit().map_err(internal)?;
        outcome
    }

    /// Frees the lease only when `who` holds it. Anything else is a silent no-op.
    pub fn release(&self, who: &Who, vault_id: &str, name: &str) -> Result<(), LeaseError> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(internal)?;
        let outcome = check_vault(&tx, vault_id, who.user_id).and_then(|()| {
            tx.execute(
                &format!("DELETE FROM {} WHERE vault_id=?1 AND name=?2 AND holder=?3", table(vault_id)),
                params![vault_id, name, holder_of(who)],
            ).map_err(internal)?;
            Ok(())
        });
        tx.commit().map_err(internal)?;
        outcome
    }
}

fn internal<E>(_: E) -> LeaseError {
    LeaseError::Internal
}

fn holder_of(who: &Who) -> String {
    format!("{}:{}", who.user_id, who.session)
}

/// A shared vault: the caller must be an editor or better (outsiders get 404, viewers 403). A personal vault: only its
/// owner, while their own notes are allowed (docs/PANEL-ADMINA.md); anyone else gets 404.
fn check_vault(conn: &Connection, vault_id: &str, user_id: &str) -> Result<(), LeaseError> {
    if vault_id.starts_with("browser-") {
        let own = vault_id == format!("browser-{user_id}") && crate::auth::personal_allowed(conn, user_id).map_err(internal)?;
        return if own { Ok(()) } else { Err(LeaseError::NotFound) };
    }
    let text: Option<String> = conn.query_row(
        "SELECT role FROM vault_members WHERE vault_id=?1 AND user_id=?2",
        params![vault_id, user_id],
        |r| r.get(0),
    ).optional().map_err(internal)?;
    match text.as_deref().and_then(Role::parse) {
        None => Err(LeaseError::NotFound),
        Some(role) if role < Role::Editor => Err(LeaseError::Forbidden("Brak uprawnień do tej operacji.")),
        Some(_) => Ok(()),
    }
}

fn acquire_in(conn: &Connection, who: &Who, vault_id: &str, name: &str, ttl_seconds: i64, now: i64) -> Result<LeaseView, LeaseError> {
    let t = table(vault_id);
    conn.execute(format!("DELETE FROM {t} WHERE vault_id=?1 AND until<=?2").as_str(), params![vault_id, now]).map_err(internal)?;
    let current: Option<(String, i64)> = conn.query_row(
        format!("SELECT holder,until FROM {t} WHERE vault_id=?1 AND name=?2").as_str(),
        params![vault_id, name],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(internal)?;
    let until = now.saturating_add(ttl_seconds.saturating_mul(1000));
    match current {
        Some((holder, held_until)) if holder != holder_of(who) => Ok(LeaseView { granted: false, until: held_until }),
        Some(_) => {
            conn.execute(
                format!("UPDATE {t} SET until=?1 WHERE vault_id=?2 AND name=?3").as_str(),
                params![until, vault_id, name],
            ).map_err(internal)?;
            Ok(LeaseView { granted: true, until })
        }
        None => {
            let count: i64 = conn.query_row(
                format!("SELECT COUNT(*) FROM {t} WHERE vault_id=?1").as_str(),
                [vault_id],
                |r| r.get(0),
            ).map_err(internal)?;
            if count >= MAX_LEASES_PER_VAULT {
                return Err(LeaseError::TooMany);
            }
            conn.execute(
                format!("INSERT INTO {t}(vault_id,name,holder,until) VALUES (?1,?2,?3,?4)").as_str(),
                params![vault_id, name, holder_of(who), until],
            ).map_err(internal)?;
            Ok(LeaseView { granted: true, until })
        }
    }
}

/// A lease name is exactly 32 lowercase hex characters.
fn valid_name(name: &str) -> Result<(), LeaseError> {
    if name.len() == 32 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err(LeaseError::Invalid(BAD_NAME))
    }
}

/// Checks a request's name and ttl. A value of the wrong type is a 400 too, never a framework 422.
fn lease_request<'a>(name: &'a Value, ttl: &Value) -> Result<(&'a str, i64), LeaseError> {
    let name = name.as_str().ok_or(LeaseError::Invalid(BAD_NAME))?;
    valid_name(name)?;
    let ttl = ttl
        .as_i64()
        .filter(|t| (1..=MAX_TTL_SECONDS).contains(t))
        .ok_or(LeaseError::Invalid(BAD_TTL))?;
    Ok((name, ttl))
}

/// The device's identity: a hash of its session token, so the raw token never reaches the table.
fn session_key(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(COOKIE)?.to_str().ok()?;
    let token = cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == SESSION_COOKIE).then_some(value)
    })?;
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| blake3::hash(token.as_bytes()).to_hex().to_string())
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

struct Api {
    auth: Arc<AuthService>,
    leases: Arc<LeaseService>,
}

pub fn routes(auth: Arc<AuthService>, leases: Arc<LeaseService>) -> Router {
    Router::new()
        .route("/api/vaults/{id}/leases", post(take_lease))
        .route("/api/vaults/{id}/leases/{name}", delete(release_lease))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Arc::new(Api { auth, leases }))
}

/// Session check, then `work` on the blocking pool. Both routes change state, so both need a same-origin request.
async fn run<F>(api: Arc<Api>, headers: HeaderMap, work: F) -> Response
where
    F: FnOnce(&LeaseService, &AuthUser, &str) -> Result<Response, LeaseError> + Send + 'static,
{
    let Some(session) = session_key(&headers) else {
        return LeaseError::Unauthorized.into_response();
    };
    let user = match authorize(api.auth.clone(), headers, true).await {
        Ok(user) => user,
        Err(Refused::Origin) => return LeaseError::Forbidden(FOREIGN_REQUEST).into_response(),
        Err(Refused::Session) => return LeaseError::Unauthorized.into_response(),
        Err(Refused::Internal) => return LeaseError::Internal.into_response(),
    };
    let result = tokio::task::spawn_blocking(move || work(api.leases.as_ref(), &user, &session)).await;
    match result {
        Ok(Ok(response)) => no_store(response),
        Ok(Err(e)) => e.into_response(),
        Err(_) => LeaseError::Internal.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseBody {
    #[serde(default)]
    name: Value,
    #[serde(default)]
    ttl_seconds: Value,
}

async fn take_lease(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<LeaseBody>) -> Response {
    run(api, headers, move |leases, user, session| {
        let (name, ttl) = lease_request(&input.name, &input.ttl_seconds)?;
        let view = leases.acquire(&Who { user_id: &user.id, session }, &id, name, ttl, now_millis())?;
        Ok(Json(view).into_response())
    }).await
}

async fn release_lease(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, name)): AxumPath<(String, String)>) -> Response {
    run(api, headers, move |leases, user, session| {
        valid_name(&name)?;
        leases.release(&Who { user_id: &user.id, session }, &id, &name)?;
        Ok(StatusCode::NO_CONTENT.into_response())
    }).await
}

#[cfg(test)]
#[path = "leases_tests.rs"]
mod leases_tests;
