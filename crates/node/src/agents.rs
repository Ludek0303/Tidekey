//! Claude chats (docs/MCP.md §3, §5, §6, §10; wire contract: docs/WEB-WSPOLDZIELENIE.md "Claude chats"): pairing, chat
//! sessions with a proof of possession on every request, their scope, limits and proposals. Tables live in `auth.db`
//! next to the vault tables. The server never sees a chat's keys: it keeps the sealed boxes, the sealed scope and the
//! person's signed certificate as they come, and checks their shape only.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
use blake2::Digest as _;
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest as _;

use crate::files::{FileError, FileService, OUT_OF_CHAT_SCOPE};
use crate::auth::{AuthService, AuthUser, FOREIGN_REQUEST, Refused, authorize};
use crate::vaults::{Role, VaultError, VaultLocks, canonical_base64, canonical_public_jwk, now_millis};
use crate::websync::{Author, BrowserSync, Envelope, PutResult, SyncError, is_shared_vault_id};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
const PAIRING_TTL: i64 = 10 * MINUTE;
const PAIRINGS_PER_HOUR: i64 = 3;
const CLAIMS_PER_MINUTE: usize = 10;
const BAD_CODES: usize = 5;
const MEMORY_ADDRESSES: usize = 4096;
const PROOF_SKEW: i64 = MINUTE;
const NONCE_TTL: i64 = 5 * MINUTE;
const IDLE: i64 = HOUR;
const CERT_MAX: i64 = 90 * DAY;
const MAX_CHATS: i64 = 5;
const REQUESTS_PER_MINUTE: usize = 60;
const WRITES_PER_MINUTE: usize = 10;
const WRITES_PER_HOUR: usize = 100;
const STRIKES: usize = 3;
const FULL_FETCH_EVERY: i64 = 5 * MINUTE;
/// Text layers a chat may fetch per window beyond the vault's count (layers added during a pass).
const TEXT_READ_MARGIN: usize = 16;
const USAGE_KEPT: i64 = 30 * DAY;
const PROPOSAL_TTL: i64 = 30 * DAY;
const OPEN_PROPOSALS: i64 = 100;
const PROPOSAL_CIPHERTEXT_MAX: usize = 1 << 20;
const REVOKED_SHOWN: i64 = 90 * DAY;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SESSION_HOURS: [i64; 4] = [1, 4, 8, 24];
const WRITE_MODES: [&str; 4] = ["none", "proposals", "append", "direct"];
const PROPOSALS: usize = 1;
const APPEND: usize = 2;
const CERT_SCHEMA: &str = "notes-agent-cert-v1";
const SEALED_SCHEMA: &str = "notes-agent-sealed-v1";
const SCOPE_SCHEMA: &str = "notes-agent-sealed-scope-v1";
const PROPOSAL_SCHEMA: &str = "notes-proposal-v1";
const CERT_MAX_BYTES: usize = 16 * 1024;
const BODY_LIMIT: usize = 1024 * 1024;
const OWN_SCOPE_MAX: usize = 64 * 1024;
const SNAPSHOT_BODY_LIMIT: usize = 17 * 1024 * 1024;
const PROPOSAL_BODY_LIMIT: usize = 2 * 1024 * 1024;
/// The file whose presence turns chats off (`notes-node agents disable`), read on every request.
pub const DISABLED_FILE: &str = "agents-disabled";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS agent_pairings (
        pairing_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        request_ip TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        sign_key TEXT,
        box_key TEXT,
        device TEXT,
        mcp_version TEXT,
        claim_ip TEXT,
        claimed_at INTEGER,
        pair_token_hash TEXT UNIQUE,
        agent_id TEXT,
        issued_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_pairings_user ON agent_pairings(user_id, created_at);
    CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
        sign_key TEXT NOT NULL,
        box_key TEXT NOT NULL,
        device TEXT NOT NULL,
        mcp_version TEXT NOT NULL,
        cert_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        cert_expires_at INTEGER NOT NULL,
        session_hours INTEGER NOT NULL,
        session_hash TEXT UNIQUE,
        session_started_at INTEGER,
        session_expires_at INTEGER,
        last_used_at INTEGER,
        last_ip TEXT,
        known_ips TEXT NOT NULL,
        revoked_at INTEGER,
        paused TEXT,
        paused_ip TEXT
    );
    CREATE INDEX IF NOT EXISTS agents_user ON agents(user_id);
    CREATE TABLE IF NOT EXISTS agent_keys (
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL,
        key_epoch INTEGER NOT NULL,
        sealed_key TEXT NOT NULL,
        PRIMARY KEY(agent_id, vault_id, key_epoch)
    );
    CREATE TABLE IF NOT EXISTS agent_scopes (
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL,
        sealed_scope TEXT NOT NULL,
        own_scope TEXT NOT NULL,
        PRIMARY KEY(agent_id, vault_id)
    );
    CREATE INDEX IF NOT EXISTS agent_scopes_vault ON agent_scopes(vault_id);
    CREATE TABLE IF NOT EXISTS agent_usage (
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        ip TEXT NOT NULL,
        kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_usage_agent ON agent_usage(agent_id, at);
    CREATE TABLE IF NOT EXISTS agent_proposals (
        proposal_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        proposal_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_proposals_vault ON agent_proposals(vault_id, user_id);
    CREATE TABLE IF NOT EXISTS agent_detached (
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL,
        detached_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, vault_id)
    );
    CREATE TABLE IF NOT EXISTS vault_agent_policy (
        vault_id TEXT PRIMARY KEY REFERENCES vaults(vault_id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL,
        max_hours INTEGER NOT NULL,
        max_write_mode TEXT NOT NULL,
        allow_protected INTEGER NOT NULL
    );";

/// Creates the chat tables (called by `VaultService::open`, so they exist wherever the vault tables do).
pub(crate) fn create_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    // added with the text of files (docs/OCR.md §5.2): allowed unless the owner blocks it
    let has: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('vault_agent_policy') WHERE name='allow_file_text')", [], |r| r.get(0),
    )?;
    if !has {
        conn.execute("ALTER TABLE vault_agent_policy ADD COLUMN allow_file_text INTEGER NOT NULL DEFAULT 1", [])?;
    }
    Ok(())
}

/// Deletes chats revoked more than 90 days ago (no longer shown anywhere); their keys, scopes, usage and proposals
/// go with them by the foreign keys.
fn sweep_revoked(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM agents WHERE revoked_at IS NOT NULL AND revoked_at<=?1", [now - REVOKED_SHOWN])
}

/// The owner's limits for chats in a vault (`PUT /api/vaults/:id/agent-policy`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub enabled: bool,
    pub max_hours: i64,
    pub max_write_mode: String,
    pub allow_protected: bool,
    /// Chats may read the text recognized from files (docs/OCR.md §5.2); each chat still needs it in its certificate.
    #[serde(default = "yes")]
    pub allow_file_text: bool,
}

fn yes() -> bool { true }

impl Policy {
    fn personal() -> Self { Self { enabled: true, max_hours: 24, max_write_mode: "direct".into(), allow_protected: true, allow_file_text: true } }
    fn shared_default() -> Self {
        Self { enabled: false, max_hours: 8, max_write_mode: "proposals".into(), allow_protected: false, allow_file_text: true }
    }
    fn max_mode(&self) -> usize { mode_index(&self.max_write_mode).unwrap_or(0) }
}

/// The policy of a shared vault (the default until its owner sets one), or the fixed one of a personal vault.
pub(crate) fn policy(conn: &Connection, vault_id: &str) -> rusqlite::Result<Policy> {
    if !is_shared_vault_id(vault_id) {
        return Ok(Policy::personal());
    }
    Ok(conn.query_row(
        "SELECT enabled,max_hours,max_write_mode,allow_protected,allow_file_text FROM vault_agent_policy WHERE vault_id=?1",
        [vault_id],
        |r| Ok(Policy { enabled: r.get(0)?, max_hours: r.get(1)?, max_write_mode: r.get(2)?, allow_protected: r.get(3)?, allow_file_text: r.get(4)? }),
    ).optional()?.unwrap_or_else(Policy::shared_default))
}

/// `members[].agents` of `GET /api/vaults/:id`: the member's chats with this vault, not revoked or revoked in the last 90 days.
/// A chat an admin detached from this vault stays listed with `detachedAt` (also for 90 days), so its old events here
/// can still be checked; the members' apps treat it as revoked in this vault.
pub(crate) fn member_agents(conn: &Connection, vault_id: &str, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut q = conn.prepare(
        "SELECT a.agent_id,a.cert_json,a.signature,a.revoked_at,d.detached_at FROM agents a
         LEFT JOIN agent_detached d ON d.agent_id=a.agent_id AND d.vault_id=?1
         WHERE a.user_id=?2 AND (d.agent_id IS NOT NULL OR EXISTS(SELECT 1 FROM agent_scopes s WHERE s.agent_id=a.agent_id AND s.vault_id=?1))
           AND (a.revoked_at IS NULL OR a.revoked_at>?3) AND (d.detached_at IS NULL OR d.detached_at>?3)
         ORDER BY a.created_at,a.agent_id",
    )?;
    let rows = q.query_map(params![vault_id, user_id, now_millis() - REVOKED_SHOWN], |r| {
        Ok(json!({
            "agentId": r.get::<_, String>(0)?,
            "cert": serde_json::from_str::<Value>(&r.get::<_, String>(1)?).unwrap_or(Value::Null),
            "signature": r.get::<_, String>(2)?,
            "revokedAt": r.get::<_, Option<i64>>(3)?,
            "detachedAt": r.get::<_, Option<i64>>(4)?,
        }))
    })?;
    rows.collect()
}

/// The chats a new key of `vault_id` must be sealed for: unrevoked chats of its current members whose cert has it.
/// For a personal vault, the owner's own chats with it.
pub(crate) fn chats_needing_key(conn: &Connection, vault_id: &str) -> rusqlite::Result<BTreeSet<String>> {
    let sql = if is_shared_vault_id(vault_id) {
        "SELECT a.agent_id FROM agents a JOIN agent_scopes s ON s.agent_id=a.agent_id
         JOIN vault_members m ON m.vault_id=s.vault_id AND m.user_id=a.user_id
         WHERE s.vault_id=?1 AND a.revoked_at IS NULL"
    } else {
        "SELECT a.agent_id FROM agents a JOIN agent_scopes s ON s.agent_id=a.agent_id
         WHERE s.vault_id=?1 AND 'browser-'||a.user_id=?1 AND a.revoked_at IS NULL"
    };
    let mut q = conn.prepare(sql)?;
    let rows = q.query_map([vault_id], |r| r.get(0))?;
    rows.collect()
}

/// Checks the `agentKeys` of a rotation (or of a personal vault's new key) against `chats_needing_key` and stores them
/// for `key_epoch`. Exactly those chats, each once: anything else is a conflict.
pub(crate) fn store_rotated_keys(conn: &Connection, vault_id: &str, key_epoch: i64, given: &[(String, Value)]) -> Result<(), VaultError> {
    let needed = chats_needing_key(conn, vault_id).map_err(|_| VaultError::Internal)?;
    let listed: BTreeSet<&str> = given.iter().map(|(id, _)| id.as_str()).collect();
    if listed.len() != given.len() || listed.len() != needed.len() || !needed.iter().all(|id| listed.contains(id.as_str())) {
        return Err(VaultError::Conflict("Klucz trzeba przygotować także dla każdego połączonego czatu Claude członków tego sejfu."));
    }
    for (agent_id, sealed) in given {
        let text = sealed_json(sealed, SEALED_SCHEMA, 80, 1024).ok_or(VaultError::Invalid("Nieprawidłowy zaszyfrowany klucz czatu."))?;
        conn.execute(
            "INSERT OR REPLACE INTO agent_keys(agent_id,vault_id,key_epoch,sealed_key) VALUES (?1,?2,?3,?4)",
            params![agent_id, vault_id, key_epoch, text],
        ).map_err(|_| VaultError::Internal)?;
    }
    Ok(())
}

/// Revokes chats: the session ends now, `revoked_at` is set, every shared vault of their certs is marked for a new key,
/// their keys and open proposals are deleted. Already revoked ones are left as they are. Returns how many were revoked.
fn revoke_agents(conn: &Connection, agent_ids: &[String], now: i64) -> rusqlite::Result<usize> {
    let mut count = 0;
    for agent_id in agent_ids {
        let changed = conn.execute(
            "UPDATE agents SET session_hash=NULL, revoked_at=?2, paused=NULL, paused_ip=NULL WHERE agent_id=?1 AND revoked_at IS NULL",
            params![agent_id, now],
        )?;
        if changed == 0 { continue; }
        count += 1;
        conn.execute("UPDATE vaults SET needs_rotation=1 WHERE vault_id IN (SELECT vault_id FROM agent_scopes WHERE agent_id=?1)", [agent_id])?;
        conn.execute("DELETE FROM agent_keys WHERE agent_id=?1", [agent_id])?;
        conn.execute("DELETE FROM agent_proposals WHERE agent_id=?1 AND state='open'", [agent_id])?;
    }
    Ok(count)
}

/// `notes-node agents disable|enable`: the switch file, seen by a running server on its next chat request.
pub fn set_disabled(data: &Path, disabled: bool) -> Result<(), String> {
    if !data.join("auth.db").exists() {
        return Err(format!("brak {} — czy --data wskazuje katalog węzła?", data.join("auth.db").display()));
    }
    let file = data.join(DISABLED_FILE);
    if disabled {
        std::fs::write(&file, b"").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// `notes-node agents revoke-all`: how many chats are not revoked; with `apply`, revokes them all.
pub fn revoke_all(data: &Path, apply: bool) -> Result<usize, String> {
    let path = data.join("auth.db");
    if !path.exists() {
        return Err(format!("brak {} — czy --data wskazuje katalog węzła?", path.display()));
    }
    let mut db = Connection::open(&path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    create_tables(&db).map_err(|e| e.to_string())?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let ids: Vec<String> = tx.prepare("SELECT agent_id FROM agents WHERE revoked_at IS NULL")
        .and_then(|mut q| q.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| e.to_string())?;
    if !apply {
        return Ok(ids.len());
    }
    let count = revoke_agents(&tx, &ids, now_millis()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Operator settings, read once at start: `NOTES_AGENT_MIN_VERSION` (default 1.0.0), `NOTES_AGENT_LATEST_VERSION`
/// (default the minimum) and `NOTES_AGENTS_DISABLED=1`.
#[derive(Clone, Debug)]
pub struct Config {
    pub min_version: String,
    pub latest_version: String,
    pub disabled_by_env: bool,
}

impl Config {
    pub fn from_env() -> Self {
        // an empty value (a variable passed through Docker Compose but not set) means the default
        let set = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let min_version = set("NOTES_AGENT_MIN_VERSION").unwrap_or_else(|| "1.0.0".into());
        let latest_version = set("NOTES_AGENT_LATEST_VERSION").unwrap_or_else(|| min_version.clone());
        let disabled_by_env = std::env::var("NOTES_AGENTS_DISABLED").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
        Self { min_version, latest_version, disabled_by_env }
    }
}

impl Default for Config {
    fn default() -> Self { Self { min_version: "1.0.0".into(), latest_version: "1.0.0".into(), disabled_by_env: false } }
}

/// `(major, minor, patch, release)`: a pre-release sorts before its release.
type Version = (u64, u64, u64, bool);

fn parse_version(text: &str) -> Option<Version> {
    if text.is_empty() || text.len() > 32 || !text.bytes().all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b)) {
        return None;
    }
    let end = text.find(['-', '+']).unwrap_or(text.len());
    let numbers: Vec<u64> = text[..end].split('.')
        .map(|p| (!p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit())).then(|| p.parse().ok()).flatten())
        .collect::<Option<_>>()?;
    match numbers[..] {
        [major, minor, patch] => Some((major, minor, patch, !text[end..].starts_with('-'))),
        _ => None,
    }
}

/// In-memory counters. They are lost on restart, which only resets the windows.
// shortcut: per-process memory, one node only; move to the database if the node ever runs as several processes.
#[derive(Default)]
struct Memory {
    nonces: HashMap<String, i64>,
    requests: HashMap<String, Vec<i64>>,
    writes: HashMap<String, Vec<i64>>,
    strikes: HashMap<String, Vec<i64>>,
    fetches: HashMap<(String, String), i64>,
    /// Times of the text layers fetched per chat and vault in the last FULL_FETCH_EVERY (a sliding window).
    text_reads: HashMap<(String, String), Vec<i64>>,
    claims: HashMap<String, Vec<i64>>,
    bad_codes: HashMap<String, Vec<i64>>,
}

/// Keeps the times inside the window, then says whether `max` more are allowed and records one when they are.
fn take(times: &mut Vec<i64>, now: i64, window: i64, max: usize) -> bool {
    times.retain(|t| now - *t < window);
    if times.len() >= max { return false; }
    times.push(now);
    true
}

/// A refused request. Chats get `{ code, message }`; people get the vault routes' `{ message }`.
#[derive(Debug)]
pub(crate) enum Fail {
    Chat(StatusCode, &'static str, String),
    Person(VaultError),
    Conflict(u64, Option<Envelope>),
}

impl From<VaultError> for Fail {
    fn from(e: VaultError) -> Self { Fail::Person(e) }
}

fn db_err<E>(_: E) -> Fail { Fail::Person(VaultError::Internal) }

fn fail(status: StatusCode, code: &'static str, message: &str) -> Fail { Fail::Chat(status, code, message.to_string()) }

fn session_fail() -> Fail { fail(StatusCode::UNAUTHORIZED, "session", "Sesja czatu wygasła. Przedłuż ją w aplikacji Notatki.") }
fn proof_fail() -> Fail { fail(StatusCode::UNAUTHORIZED, "proof", "Nieprawidłowy podpis żądania czatu.") }
fn paused_fail() -> Fail { fail(StatusCode::FORBIDDEN, "paused", "Czat jest wstrzymany. Potwierdź go w aplikacji Notatki (Ustawienia → Urządzenia).") }
fn scope_fail() -> Fail { fail(StatusCode::NOT_FOUND, "scope", "Nie znaleziono sejfu.") }
fn file_text_fail() -> Fail { fail(StatusCode::FORBIDDEN, "file-text", "Ten czat nie ma uprawnienia „Tekst z plików” w tym sejfie.") }
/// Anything a chat may not read among the files: one answer, so it learns nothing about what exists.
fn file_fail(e: FileError) -> Fail {
    match e {
        FileError::Internal => db_err(()),
        FileError::Unauthorized => session_fail(),
        FileError::TooMany(_) => limit_fail(),
        _ => fail(StatusCode::NOT_FOUND, "scope", OUT_OF_CHAT_SCOPE),
    }
}
fn read_only_fail() -> Fail { fail(StatusCode::FORBIDDEN, "read-only", "Ten czat ma w tym sejfie tylko odczyt.") }
fn limit_fail() -> Fail { fail(StatusCode::TOO_MANY_REQUESTS, "limit", "Za dużo żądań czatu. Spróbuj ponownie za chwilę.") }
fn invalid_fail() -> Fail { fail(StatusCode::BAD_REQUEST, "invalid", "Nieprawidłowe dane żądania.") }
fn disabled_fail() -> Fail { fail(StatusCode::SERVICE_UNAVAILABLE, "disabled", "Czaty są chwilowo wyłączone przez operatora serwera.") }
fn pairing_fail() -> Fail { fail(StatusCode::NOT_FOUND, "pairing", "Nie ma takiego kodu parowania albo wygasł.") }
fn burned_fail() -> Fail { fail(StatusCode::CONFLICT, "burned", "Ten kod parowania zgłoszono dwa razy, więc parowanie przerwano. Rozpocznij je od nowa w aplikacji.") }
fn gone_fail() -> Fail { fail(StatusCode::GONE, "gone", "Ten token parowania został już użyty albo wygasł.") }

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        let mut response = match self {
            Fail::Chat(status, code, message) => (status, Json(json!({ "code": code, "message": message }))).into_response(),
            Fail::Person(e) => return e.into_response(),
            Fail::Conflict(revision, envelope) => (StatusCode::CONFLICT, Json(json!({
                "code": "conflict", "message": "Sejf zmienił się w międzyczasie.", "revision": revision, "envelope": envelope,
            }))).into_response(),
        };
        response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
        response
    }
}

/// The parts of a chat request the proof covers.
struct Signed<'a> {
    method: &'a Method,
    uri: &'a Uri,
    headers: &'a HeaderMap,
    body: &'a [u8],
}

/// A chat whose request passed every check.
struct Chat {
    agent_id: String,
    user_id: String,
    ip: String,
}

/// A chat's row, as the vault checks need it.
struct AgentRow {
    agent_id: String,
    user_id: String,
    cert: Value,
    signature: String,
    cert_expires_at: i64,
    session_started_at: Option<i64>,
    session_expires_at: Option<i64>,
    revoked_at: Option<i64>,
}

const AGENT_COLUMNS: &str = "agent_id,user_id,cert_json,signature,cert_expires_at,session_started_at,session_expires_at,revoked_at";

fn agent_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRow> {
    Ok(AgentRow {
        agent_id: r.get(0)?,
        user_id: r.get(1)?,
        cert: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
        signature: r.get(3)?,
        cert_expires_at: r.get(4)?,
        session_started_at: r.get(5)?,
        session_expires_at: r.get(6)?,
        revoked_at: r.get(7)?,
    })
}

fn load_agent(conn: &Connection, agent_id: &str) -> rusqlite::Result<Option<AgentRow>> {
    conn.query_row(&format!("SELECT {AGENT_COLUMNS} FROM agents WHERE agent_id=?1"), [agent_id], agent_row).optional()
}

/// What a chat may do in one vault right now.
struct Access {
    role: Role,
    write: usize,
    /// The certificate has "Tekst z plików" for this vault and its policy allows it.
    file_text: bool,
}

fn personal_id(user_id: &str) -> String { format!("browser-{user_id}") }

fn mode_index(mode: &str) -> Option<usize> { WRITE_MODES.iter().position(|m| *m == mode) }

/// The cert lets the chat read the text of files in `vault_id` (docs/OCR.md §5.2): only an explicit `true`.
fn cert_file_text(cert: &Value, vault_id: &str) -> bool {
    cert.get("vaults").and_then(Value::as_array).is_some_and(|list| {
        list.iter().any(|v| v.get("vaultId").and_then(Value::as_str) == Some(vault_id) && v.get("fileText") == Some(&Value::Bool(true)))
    })
}

/// The cert's write mode for `vault_id`, when the cert has that vault.
fn cert_mode(cert: &Value, vault_id: &str) -> Option<usize> {
    cert.get("vaults")?.as_array()?.iter()
        .find(|v| v.get("vaultId").and_then(Value::as_str) == Some(vault_id))
        .and_then(|v| mode_index(v.get("writeMode")?.as_str()?))
}

fn cert_vaults(cert: &Value) -> Vec<String> {
    cert.get("vaults").and_then(Value::as_array).map(|list| {
        list.iter().filter_map(|v| v.get("vaultId").and_then(Value::as_str).map(str::to_string)).collect()
    }).unwrap_or_default()
}

fn member_role(conn: &Connection, vault_id: &str, user_id: &str) -> rusqlite::Result<Option<Role>> {
    let text: Option<String> = conn.query_row(
        "SELECT role FROM vault_members WHERE vault_id=?1 AND user_id=?2", params![vault_id, user_id], |r| r.get(0),
    ).optional()?;
    Ok(text.as_deref().and_then(Role::parse))
}

fn personal_epoch(conn: &Connection, user_id: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COALESCE(MAX(key_epoch),1) FROM personal_vault_keys WHERE user_id=?1", [user_id], |r| r.get(0))
}

/// The personal vault is open to chats: own notes allowed, and moved off the personal key (docs/MCP.md §3.7).
fn personal_open(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    Ok(crate::auth::personal_allowed(conn, user_id)? && personal_epoch(conn, user_id)? >= 2)
}

fn vault_epoch(conn: &Connection, vault_id: &str, user_id: &str) -> rusqlite::Result<i64> {
    if is_shared_vault_id(vault_id) {
        conn.query_row("SELECT key_epoch FROM vaults WHERE vault_id=?1", [vault_id], |r| r.get(0))
    } else {
        personal_epoch(conn, user_id)
    }
}

/// The chat's access to `vault_id`, or `None` exactly as for a non-member: the vault is outside the cert, the person
/// left it, chats are off there, the cert or session expired, the session is older than the policy allows, the chat
/// is revoked. Role = min(person's role, editor); the write mode is the cert's, cut to the policy's.
fn vault_access(conn: &Connection, agent: &AgentRow, vault_id: &str, now: i64) -> rusqlite::Result<Option<Access>> {
    if agent.revoked_at.is_some() || agent.cert_expires_at <= now || agent.session_expires_at.is_none_or(|e| e <= now) {
        return Ok(None);
    }
    let Some(mode) = cert_mode(&agent.cert, vault_id) else { return Ok(None); };
    // the scope row goes when the person leaves the vault: a later return does not bring the old chat back
    let scoped: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_scopes WHERE agent_id=?1 AND vault_id=?2)",
        params![agent.agent_id, vault_id], |r| r.get(0))?;
    if !scoped { return Ok(None); }
    let role = if vault_id == personal_id(&agent.user_id) {
        if !personal_open(conn, &agent.user_id)? { return Ok(None); }
        Role::Editor
    } else if is_shared_vault_id(vault_id) {
        match member_role(conn, vault_id, &agent.user_id)? {
            Some(role) => role.min(Role::Editor),
            None => return Ok(None),
        }
    } else {
        return Ok(None);
    };
    let policy = policy(conn, vault_id)?;
    if !policy.enabled || agent.session_started_at.unwrap_or(0).saturating_add(policy.max_hours * HOUR) <= now {
        return Ok(None);
    }
    let write = if role < Role::Editor { 0 } else { mode.min(policy.max_mode()) };
    let file_text = policy.allow_file_text && cert_file_text(&agent.cert, vault_id);
    Ok(Some(Access { role, write, file_text }))
}

/// Base64url (no padding) of exactly `len` bytes, canonical.
fn b64u_exact(text: &str, len: usize) -> Option<Vec<u8>> {
    let bytes = B64U.decode(text).ok()?;
    (bytes.len() == len && B64U.encode(&bytes) == text).then_some(bytes)
}

/// Shape check of `{ schema, box }` (a sealed key or scope); returns the normalized JSON text.
fn sealed_json(value: &Value, schema: &str, min: usize, max: usize) -> Option<String> {
    let obj = value.as_object()?;
    let sealed = obj.get("box")?.as_str()?;
    if obj.len() != 2 || obj.get("schema")?.as_str()? != schema || sealed.len() > max.div_ceil(3) * 4 + 4 {
        return None;
    }
    let bytes = B64U.decode(sealed).ok()?;
    if !(min..=max).contains(&bytes.len()) || B64U.encode(&bytes) != sealed { return None; }
    serde_json::to_string(&json!({ "schema": schema, "box": sealed })).ok()
}

fn is_hex32(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_token(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

fn random_hex<const N: usize>() -> Result<String, Fail> {
    Ok(hex(&notes_sync::random::<N>().map_err(db_err)?))
}

fn token_hash(token: &str) -> String { blake3::hash(token.as_bytes()).to_hex().to_string() }

/// `H(x)` of the contract: BLAKE2b-256.
fn h(bytes: &[u8]) -> [u8; 32] { blake2::Blake2b::<blake2::digest::consts::U32>::digest(bytes).into() }

fn normalize_code(code: &str) -> Option<String> {
    let code: String = code.chars().filter(|c| *c != '-' && !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    (code.len() == 8 && code.bytes().all(|b| CODE_ALPHABET.contains(&b))).then_some(code)
}

fn code_hash(code: &str) -> String { hex(&sha2::Sha256::digest(code.as_bytes())) }

/// 8 symbols of the code alphabet, each uniform (bytes ≥ 248 are drawn again).
fn new_code() -> Result<String, Fail> {
    let mut code = String::new();
    while code.len() < 8 {
        for b in notes_sync::random::<16>().map_err(db_err)? {
            if code.len() < 8 && usize::from(b) < CODE_ALPHABET.len() * 8 {
                code.push(char::from(CODE_ALPHABET[usize::from(b) % CODE_ALPHABET.len()]));
            }
        }
    }
    Ok(code)
}

fn verify(sign_key: &str, message: &[u8], signature: &str) -> bool {
    let (Some(key), Some(sig)) = (b64u_exact(sign_key, 32), b64u_exact(signature, 64)) else { return false; };
    let (Ok(key), Ok(sig)) = (<[u8; 32]>::try_from(key), <[u8; 64]>::try_from(sig)) else { return false; };
    VerifyingKey::from_bytes(&key).is_ok_and(|key| key.verify_strict(message, &Signature::from_bytes(&sig)).is_ok())
}

/// The client address `http::trust_forwarded` settled (the peer, or the client behind a trusted proxy).
fn client_ip(headers: &HeaderMap) -> String {
    headers.get("cf-connecting-ip").or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).map(str::trim)
        .filter(|ip| !ip.is_empty() && ip.len() <= 64)
        .unwrap_or("direct").to_string()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// The server's own address for the update command, as the request reached it.
fn origin(headers: &HeaderMap) -> String {
    let host = header(headers, "x-forwarded-host").or_else(|| header(headers, "host")).unwrap_or("localhost");
    let proto = header(headers, "x-forwarded-proto").unwrap_or(if crate::auth::https_deployment() { "https" } else { "http" });
    format!("{proto}://{host}")
}

fn string_field<'a>(obj: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a str> {
    obj.get(name).and_then(Value::as_str)
}

/// The checked parts of a certificate and its keys and scopes.
struct CertIn {
    agent_id: String,
    sign_key: String,
    box_key: String,
    vaults: Vec<String>,
    expires_at: i64,
    cert_json: String,
    keys: Vec<(String, i64, String)>,
    /// (vault, sealed scope for the chat, the person's own copy)
    scopes: Vec<(String, String, String)>,
    max_hours: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyIn {
    vault_id: String,
    key_epoch: i64,
    sealed_key: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeIn {
    vault_id: String,
    sealed_scope: Value,
    /// The person's own copy (`notes-key-v1` under the personal key); never given to the chat.
    own_scope: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    pairing_id: String,
    #[serde(flatten)]
    scope: ScopeBody,
    session_hours: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeBody {
    cert: Value,
    signature: String,
    keys: Vec<KeyIn>,
    scopes: Vec<ScopeIn>,
}

#[derive(Deserialize)]
struct HoursBody {
    hours: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBody {
    enabled: bool,
    max_hours: i64,
    max_write_mode: String,
    allow_protected: bool,
    /// Left out by clients from before it: the stored value stays.
    #[serde(default)]
    allow_file_text: Option<bool>,
}

#[derive(Deserialize)]
struct DecisionBody {
    decision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimBody {
    code: String,
    sign_key: String,
    box_key: String,
    device: Device,
    mcp_version: String,
    proof: String,
}

#[derive(Deserialize, Serialize)]
struct Device {
    name: String,
    os: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotBody {
    base_revision: u64,
    envelope: Envelope,
}

#[derive(Deserialize)]
struct ProposalBody {
    proposal: Value,
}

pub struct AgentService {
    db: Mutex<Connection>,
    data_dir: PathBuf,
    config: Config,
    min_version: Version,
    sync: Arc<BrowserSync>,
    locks: Arc<VaultLocks>,
    memory: Mutex<Memory>,
    /// Tests only: runs once in `add_proposal` between its first access check and its write transaction.
    #[cfg(test)]
    pub(crate) before_proposal: crate::websync::TestHook,
}

impl AgentService {
    /// Opens the chat tables in `auth.db` (after `AuthService` and `VaultService`). `locks` must be the instance
    /// `BrowserSync` and `VaultService` share.
    pub fn open(data_dir: &Path, sync: Arc<BrowserSync>, locks: Arc<VaultLocks>, config: Config) -> Result<Self, String> {
        let db = Connection::open(data_dir.join("auth.db")).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        create_tables(&db).map_err(|e| e.to_string())?;
        sweep_revoked(&db, now_millis()).map_err(|e| e.to_string())?;
        // An unreadable minimum refuses every chat rather than letting old versions in.
        let min_version = parse_version(&config.min_version).unwrap_or_else(|| {
            eprintln!("notes-node: NOTES_AGENT_MIN_VERSION is not a version; every chat is refused until it is fixed");
            (u64::MAX, u64::MAX, u64::MAX, true)
        });
        Ok(Self { db: Mutex::new(db), data_dir: data_dir.to_path_buf(), config, min_version, sync, locks, memory: Mutex::default(),
            #[cfg(test)]
            before_proposal: Mutex::default() })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, Fail> {
        self.db.lock().map_err(db_err)
    }

    fn memory(&self) -> MutexGuard<'_, Memory> {
        self.memory.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The operator switch: `NOTES_AGENTS_DISABLED=1`, or the file `<data>/agents-disabled` (seen without a restart).
    pub fn disabled(&self) -> bool {
        self.config.disabled_by_env || self.data_dir.join(DISABLED_FILE).exists()
    }

    fn update_command(&self, headers: &HeaderMap) -> String {
        format!("npx --yes @notatki/mcp@{} pair {}", self.config.latest_version, origin(headers))
    }

    fn version_reply(&self, headers: &HeaderMap) -> Value {
        json!({
            "server": env!("CARGO_PKG_VERSION"),
            "agentMin": self.config.min_version,
            "agentLatest": self.config.latest_version,
            "agentsDisabled": self.disabled(),
            "update": { "npm": self.update_command(headers), "mcpb": "" },
        })
    }

    /// A chat's version against the minimum, then the operator switch (in the contract's order).
    fn gate(&self, version: Option<&str>, headers: &HeaderMap) -> Result<(), Fail> {
        let version = version.ok_or_else(|| fail(StatusCode::BAD_REQUEST, "invalid", "Brak nagłówka wersji Notatki MCP."))?;
        let version = parse_version(version).ok_or_else(|| fail(StatusCode::BAD_REQUEST, "invalid", "Nieprawidłowa wersja Notatki MCP."))?;
        if version < self.min_version {
            return Err(Fail::Chat(StatusCode::UPGRADE_REQUIRED, "version", format!(
                "Ta wersja Notatki MCP jest za stara i ma znane problemy bezpieczeństwa. Zaktualizuj: {}.", self.update_command(headers),
            )));
        }
        if self.disabled() { return Err(disabled_fail()); }
        Ok(())
    }

    /// The Ed25519 proof under `sign_key`, the time window and a nonce not seen in the last 5 minutes.
    fn check_proof(&self, request: &Signed<'_>, sign_key: &str, now: i64) -> Result<(), Fail> {
        let headers = request.headers;
        let (Some(time), Some(nonce), Some(version), Some(proof)) = (
            header(headers, "notes-agent-time"), header(headers, "notes-agent-nonce"),
            header(headers, "notes-agent-version"), header(headers, "notes-agent-proof"),
        ) else { return Err(proof_fail()); };
        let at: i64 = time.parse().map_err(|_| proof_fail())?;
        // abs_diff: a time near i64::MIN or MAX must not overflow
        if time != at.to_string() || now.abs_diff(at) > PROOF_SKEW.unsigned_abs() || !is_hex32(nonce) {
            return Err(proof_fail());
        }
        let path = request.uri.path_and_query().map_or(request.uri.path(), |p| p.as_str());
        let message = format!(
            "notes-agent-req-v1\n{}\n{path}\n{}\n{time}\n{nonce}\n{version}", request.method.as_str(), hex(&h(request.body)),
        );
        if !verify(sign_key, message.as_bytes(), proof) { return Err(proof_fail()); }
        let mut memory = self.memory();
        memory.nonces.retain(|_, seen| now - *seen < NONCE_TTL);
        if memory.nonces.insert(nonce.to_string(), now).is_some() { return Err(proof_fail()); }
        Ok(())
    }

    /// A 429 for the chat; the third within an hour pauses it until the person confirms.
    fn strike(&self, agent_id: &str, now: i64) -> Fail {
        let paused = {
            let mut memory = self.memory();
            let strikes = memory.strikes.entry(agent_id.to_string()).or_default();
            strikes.retain(|t| now - *t < HOUR);
            strikes.push(now);
            strikes.len() >= STRIKES
        };
        if paused && let Ok(db) = self.db() {
            let _ = db.execute("UPDATE agents SET paused='limit' WHERE agent_id=?1 AND paused IS NULL", [agent_id]);
            crate::audit::event("agent_paused", &[("agent", agent_id), ("reason", "limit")]);
        }
        limit_fail()
    }

    /// Every check of a chat request but the vault: version, switch, token, proof, session, pause, IP, rate.
    fn authenticate(&self, request: &Signed<'_>, ip: &str) -> Result<Chat, Fail> {
        self.gate(header(request.headers, "notes-agent-version"), request.headers)?;
        let token = header(request.headers, "authorization").and_then(|v| v.strip_prefix("NotesAgent "))
            .filter(|t| is_token(t)).ok_or_else(session_fail)?;
        let now = now_millis();
        type Row = (String, String, String, Option<i64>, Option<i64>, String, Option<String>);
        let row: Option<Row> = self.db()?.query_row(
            "SELECT agent_id,user_id,sign_key,session_expires_at,COALESCE(last_used_at,session_started_at),known_ips,paused FROM agents
             WHERE session_hash=?1 AND revoked_at IS NULL",
            [token_hash(token)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        ).optional().map_err(db_err)?;
        let (agent_id, user_id, sign_key, expires, last_used, known_ips, paused) = row.ok_or_else(session_fail)?;
        self.check_proof(request, &sign_key, now)?;
        if expires.is_none_or(|e| e <= now) || last_used.is_none_or(|t| t.saturating_add(IDLE) <= now) {
            return Err(session_fail());
        }
        if paused.is_some() { return Err(paused_fail()); }
        let known: Vec<String> = serde_json::from_str(&known_ips).unwrap_or_default();
        if !known.iter().any(|k| k == ip) {
            self.db()?.execute(
                "UPDATE agents SET paused='ip', paused_ip=?2, last_ip=?2 WHERE agent_id=?1", params![agent_id, ip],
            ).map_err(db_err)?;
            crate::audit::event("agent_paused", &[("agent", &agent_id), ("reason", "ip")]);
            return Err(paused_fail());
        }
        let allowed = take(self.memory().requests.entry(agent_id.clone()).or_default(), now, MINUTE, REQUESTS_PER_MINUTE);
        if !allowed { return Err(self.strike(&agent_id, now)); }
        self.db()?.execute("UPDATE agents SET last_used_at=?2, last_ip=?3 WHERE agent_id=?1", params![agent_id, now, ip]).map_err(db_err)?;
        Ok(Chat { agent_id, user_id, ip: ip.to_string() })
    }

    /// 10 writes or proposals a minute and 100 an hour per chat.
    fn count_write(&self, agent_id: &str, now: i64) -> Result<(), Fail> {
        let allowed = {
            let mut memory = self.memory();
            let times = memory.writes.entry(agent_id.to_string()).or_default();
            times.retain(|t| now - *t < HOUR);
            let last_minute = times.iter().filter(|t| now - **t < MINUTE).count();
            let ok = last_minute < WRITES_PER_MINUTE && times.len() < WRITES_PER_HOUR;
            if ok { times.push(now); }
            ok
        };
        if allowed { Ok(()) } else { Err(self.strike(agent_id, now)) }
    }

    fn record(&self, conn: &Connection, chat: &Chat, kind: &str, now: i64) -> Result<(), Fail> {
        conn.execute("INSERT INTO agent_usage(agent_id,at,ip,kind) VALUES (?1,?2,?3,?4)", params![chat.agent_id, now, chat.ip, kind]).map_err(db_err)?;
        conn.execute("DELETE FROM agent_usage WHERE at<=?1", [now - USAGE_KEPT]).map_err(db_err)?;
        Ok(())
    }

    /// The chat's row and its access to `vault_id`; `scope` (404) when it has none.
    fn chat_vault(&self, conn: &Connection, chat: &Chat, vault_id: &str, now: i64) -> Result<(AgentRow, Access), Fail> {
        let agent = load_agent(conn, &chat.agent_id).map_err(db_err)?.ok_or_else(session_fail)?;
        let access = vault_access(conn, &agent, vault_id, now).map_err(db_err)?.ok_or_else(scope_fail)?;
        Ok((agent, access))
    }

    // ---- pairing (person) ----

    fn start_pairing(&self, user: &AuthUser, ip: &str) -> Result<Value, Fail> {
        if self.disabled() { return Err(disabled_fail()); }
        let now = now_millis();
        let db = self.db()?;
        // a done pairing is needed only until its token is fetched (before `expires_at`), so it goes too
        db.execute("DELETE FROM agent_pairings WHERE expires_at<=?1", [now - DAY]).map_err(db_err)?;
        sweep_revoked(&db, now).map_err(db_err)?;
        let recent: i64 = db.query_row(
            "SELECT count(*) FROM agent_pairings WHERE user_id=?1 AND created_at>?2", params![user.id, now - HOUR], |r| r.get(0),
        ).map_err(db_err)?;
        if recent >= PAIRINGS_PER_HOUR {
            return Err(fail(StatusCode::TOO_MANY_REQUESTS, "limit", "Za dużo parowań w ciągu godziny. Spróbuj ponownie później."));
        }
        let pairing_id = random_hex::<16>()?;
        let expires_at = now + PAIRING_TTL;
        for _ in 0..3 {
            let code = new_code()?;
            let inserted = db.execute(
                "INSERT INTO agent_pairings(pairing_id,user_id,code_hash,state,request_ip,created_at,expires_at) VALUES (?1,?2,?3,'waiting',?4,?5,?6)",
                params![pairing_id, user.id, code_hash(&code), ip, now, expires_at],
            );
            match inserted {
                Ok(_) => {
                    crate::audit::event("agent_pairing_started", &[("user", &user.id), ("pairing", &pairing_id)]);
                    return Ok(json!({ "pairingId": pairing_id, "code": format!("{}-{}", &code[..4], &code[4..]), "expiresAt": expires_at }));
                }
                // the same code as a live pairing (about one in 10^12): draw another
                Err(rusqlite::Error::SqliteFailure(e, _)) if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE => continue,
                Err(_) => return Err(db_err(())),
            }
        }
        Err(db_err(()))
    }

    fn pairing_state(&self, user: &AuthUser, pairing_id: &str) -> Result<Value, Fail> {
        let db = self.db()?;
        type Row = (String, String, i64, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>);
        let row: Row = db.query_row(
            "SELECT state,request_ip,expires_at,sign_key,box_key,device,mcp_version,claim_ip,claimed_at FROM agent_pairings
             WHERE pairing_id=?1 AND user_id=?2",
            params![pairing_id, user.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        ).optional().map_err(db_err)?.ok_or(VaultError::NotFound)?;
        let (state, request_ip, expires_at, sign_key, box_key, device, mcp_version, claim_ip, claimed_at) = row;
        let state = if matches!(state.as_str(), "waiting" | "claimed") && expires_at <= now_millis() { "expired".to_string() } else { state };
        let claim = match (sign_key, box_key) {
            (Some(sign_key), Some(box_key)) => json!({
                "signKey": sign_key, "boxKey": box_key,
                "device": device.and_then(|d| serde_json::from_str::<Value>(&d).ok()),
                "mcpVersion": mcp_version, "ip": claim_ip, "claimedAt": claimed_at,
            }),
            _ => Value::Null,
        };
        Ok(json!({ "state": state, "claim": claim, "requestIp": request_ip }))
    }

    fn cancel_pairing(&self, user: &AuthUser, pairing_id: &str) -> Result<(), Fail> {
        let db = self.db()?;
        let found = db.execute(
            "UPDATE agent_pairings SET state=CASE WHEN state IN ('waiting','claimed') THEN 'burned' ELSE state END
             WHERE pairing_id=?1 AND user_id=?2",
            params![pairing_id, user.id],
        ).map_err(db_err)?;
        if found == 0 { return Err(VaultError::NotFound.into()); }
        Ok(())
    }

    // ---- pairing (chat) ----

    fn claim(&self, headers: &HeaderMap, body: &[u8], ip: &str) -> Result<Value, Fail> {
        let now = now_millis();
        {
            let mut memory = self.memory();
            // claims need no session, so each new address would add an entry for good: drop the stale ones
            if memory.claims.len() + memory.bad_codes.len() > MEMORY_ADDRESSES {
                memory.claims.retain(|_, times| times.iter().any(|t| now - *t < MINUTE));
                memory.bad_codes.retain(|_, times| times.iter().any(|t| now - *t < HOUR));
            }
            let bad = memory.bad_codes.entry(ip.to_string()).or_default();
            bad.retain(|t| now - *t < HOUR);
            let blocked = bad.len() >= BAD_CODES;
            if blocked || !take(memory.claims.entry(ip.to_string()).or_default(), now, MINUTE, CLAIMS_PER_MINUTE) {
                return Err(fail(StatusCode::TOO_MANY_REQUESTS, "limit", "Za dużo prób parowania z tej sieci. Spróbuj ponownie później."));
            }
        }
        let input: ClaimBody = serde_json::from_slice(body).map_err(|_| invalid_fail())?;
        // the claim carries its version in the body; a header, when sent, must say the same
        if header(headers, "notes-agent-version").is_some_and(|v| v != input.mcp_version) { return Err(invalid_fail()); }
        self.gate(Some(&input.mcp_version), headers)?;
        let device_ok = |s: &str| !s.trim().is_empty() && s.chars().count() <= 64 && !s.chars().any(char::is_control);
        if b64u_exact(&input.sign_key, 32).is_none() || b64u_exact(&input.box_key, 32).is_none()
            || !device_ok(&input.device.name) || !device_ok(&input.device.os) {
            return Err(invalid_fail());
        }
        let bad_code = || {
            self.memory().bad_codes.entry(ip.to_string()).or_default().push(now);
            pairing_fail()
        };
        let Some(code) = normalize_code(&input.code) else { return Err(bad_code()); };
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let row: Option<(String, String, String, i64)> = tx.query_row(
            "SELECT pairing_id,user_id,state,expires_at FROM agent_pairings WHERE code_hash=?1", [code_hash(&code)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional().map_err(db_err)?;
        let Some((pairing_id, user_id, state, expires_at)) = row else { drop(tx); drop(db); return Err(bad_code()); };
        if state == "waiting" && expires_at <= now { drop(tx); drop(db); return Err(bad_code()); }
        let message = format!("notes agent-claim v1\n{code}\n{}\n{}", input.sign_key, input.box_key);
        if !verify(&input.sign_key, message.as_bytes(), &input.proof) { return Err(proof_fail()); }
        match state.as_str() {
            "waiting" => {}
            "claimed" => {
                // a second claim: someone else saw the code, so neither claim goes through
                tx.execute("UPDATE agent_pairings SET state='burned' WHERE pairing_id=?1", [&pairing_id]).map_err(db_err)?;
                tx.commit().map_err(db_err)?;
                crate::audit::event("agent_pairing_burned", &[("user", &user_id), ("pairing", &pairing_id)]);
                return Err(burned_fail());
            }
            _ => return Err(burned_fail()),
        }
        let pair_token = random_hex::<32>()?;
        let device = serde_json::to_string(&input.device).map_err(db_err)?;
        tx.execute(
            "UPDATE agent_pairings SET state='claimed', sign_key=?2, box_key=?3, device=?4, mcp_version=?5, claim_ip=?6, claimed_at=?7,
                pair_token_hash=?8, expires_at=?9 WHERE pairing_id=?1",
            params![pairing_id, input.sign_key, input.box_key, device, input.mcp_version, ip, now, token_hash(&pair_token), now + PAIRING_TTL],
        ).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        crate::audit::event("agent_pairing_claimed", &[("user", &user_id), ("pairing", &pairing_id)]);
        Ok(json!({ "pairingId": pairing_id, "pairToken": pair_token }))
    }

    /// `GET /api/agent-pair/:pairToken`: the session token, once, after the person finished pairing.
    fn issue(&self, request: &Signed<'_>, pair_token: &str, ip: &str) -> Result<Value, Fail> {
        self.gate(header(request.headers, "notes-agent-version"), request.headers)?;
        if !is_token(pair_token) { return Err(pairing_fail()); }
        let now = now_millis();
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        type Row = (String, String, String, i64, Option<String>, Option<i64>);
        let row: Option<Row> = tx.query_row(
            "SELECT pairing_id,state,sign_key,expires_at,agent_id,issued_at FROM agent_pairings WHERE pair_token_hash=?1",
            [token_hash(pair_token)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional().map_err(db_err)?;
        let (pairing_id, state, sign_key, expires_at, agent_id, issued_at) = row.ok_or_else(pairing_fail)?;
        self.check_proof(request, &sign_key, now)?;
        match state.as_str() {
            "burned" => return Err(burned_fail()),
            "claimed" if expires_at > now => return Err(fail(StatusCode::NOT_FOUND, "waiting", "Czekam na potwierdzenie w aplikacji Notatki.")),
            "done" if issued_at.is_none() && expires_at > now => {}
            _ => return Err(gone_fail()),
        }
        let agent_id = agent_id.ok_or_else(gone_fail)?;
        let (hours, known_ips): (i64, String) = tx.query_row(
            "SELECT session_hours,known_ips FROM agents WHERE agent_id=?1 AND revoked_at IS NULL", [&agent_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(db_err)?.ok_or_else(gone_fail)?;
        let session_token = random_hex::<32>()?;
        let session_expires_at = now + hours * HOUR;
        // the token is fetched from another address than the claim: it is issued, but the chat starts paused
        let known: Vec<String> = serde_json::from_str(&known_ips).unwrap_or_default();
        let new_ip = !known.iter().any(|k| k == ip);
        tx.execute(
            "UPDATE agents SET session_hash=?2, session_started_at=?3, session_expires_at=?4, last_used_at=?3, last_ip=?5,
                paused=CASE WHEN ?6 THEN 'ip' ELSE paused END, paused_ip=CASE WHEN ?6 THEN ?5 ELSE paused_ip END WHERE agent_id=?1",
            params![agent_id, token_hash(&session_token), now, session_expires_at, ip, new_ip],
        ).map_err(db_err)?;
        tx.execute("UPDATE agent_pairings SET issued_at=?2 WHERE pairing_id=?1", params![pairing_id, now]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(json!({ "sessionToken": session_token, "agentId": agent_id, "expiresAt": session_expires_at }))
    }

    // ---- chats (person) ----

    /// The cert, keys and scopes of `POST /api/me/agents` and `PUT /api/me/agents/:id`, checked against the person's
    /// vaults and the policies. `stored`: keys already held for this chat (an update keeps them).
    /// `stored_created`: the stored cert's `createdAt` on an update, which a new cert keeps (90 days from pairing, never more).
    fn check_cert(&self, conn: &Connection, user: &AuthUser, input: &ScopeBody, stored: &[(String, i64)], stored_created: Option<i64>) -> Result<CertIn, Fail> {
        let (cert, signature, keys, scopes) = (&input.cert, input.signature.as_str(), &input.keys, &input.scopes);
        let bad = |m: &'static str| Fail::Person(VaultError::Invalid(m));
        let now = now_millis();
        let cert_json = serde_json::to_string(cert).map_err(db_err)?;
        let obj = cert.as_object().ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        const CERT_FIELDS: [&str; 10] = ["schema", "agentId", "userId", "signKey", "boxKey", "vaults", "createdAt", "expiresAt", "signerUserId", "signature"];
        // the app's signature fields may ride along; the signer, when named, is the cert's person
        if obj.keys().any(|k| !CERT_FIELDS.contains(&k.as_str()))
            || obj.get("signerUserId").is_some_and(|v| v.as_str() != Some(user.id.as_str()))
            || obj.get("signature").is_some_and(|v| !v.is_string()) {
            return Err(bad("Nieprawidłowy certyfikat czatu."));
        }
        if cert_json.len() > CERT_MAX_BYTES || string_field(obj, "schema") != Some(CERT_SCHEMA)
            || signature.is_empty() || signature.len() > 512 {
            return Err(bad("Nieprawidłowy certyfikat czatu."));
        }
        let agent_id = string_field(obj, "agentId").filter(|id| is_hex32(id)).ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        if string_field(obj, "userId") != Some(user.id.as_str()) {
            return Err(bad("Certyfikat czatu wystawiono dla innego konta."));
        }
        let sign_key = string_field(obj, "signKey").filter(|k| b64u_exact(k, 32).is_some()).ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        let box_key = string_field(obj, "boxKey").filter(|k| b64u_exact(k, 32).is_some()).ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        let created_at = obj.get("createdAt").and_then(Value::as_i64).ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        let expires_at = obj.get("expiresAt").and_then(Value::as_i64).ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        if stored_created.is_some_and(|stored| stored != created_at) {
            return Err(bad("Nowy zakres nie może zmienić daty wystawienia certyfikatu czatu."));
        }
        if expires_at > created_at.saturating_add(CERT_MAX) || expires_at <= now || created_at > now + 5 * MINUTE {
            return Err(bad("Certyfikat czatu może być ważny najwyżej 90 dni."));
        }
        let list = obj.get("vaults").and_then(Value::as_array).ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
        if list.is_empty() {
            return Err(bad("Wybierz co najmniej jedną przestrzeń dla czatu."));
        }
        let mut vaults: Vec<String> = Vec::new();
        let mut max_hours = 24;
        for entry in list {
            let e = entry.as_object().ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
            let vault_id = string_field(e, "vaultId").ok_or(bad("Nieprawidłowy certyfikat czatu."))?;
            // version 1: every vault whole, no compartments
            let whole = e.get("whole") == Some(&Value::Bool(true)) && e.get("parts").and_then(Value::as_array).is_some_and(Vec::is_empty);
            let mode_ok = string_field(e, "writeMode").and_then(mode_index).is_some();
            // `fileText` (docs/OCR.md §5.2) is optional: a certificate from before it has the four fields, and is off
            let file_text = match e.get("fileText") {
                None => Some(false),
                Some(Value::Bool(b)) => Some(*b),
                Some(_) => None,
            };
            let fields_ok = file_text.is_some() && e.len() == if e.contains_key("fileText") { 5 } else { 4 };
            if !fields_ok || !whole || !mode_ok || vaults.iter().any(|v| v == vault_id) || vaults.len() >= 64 {
                return Err(bad("Nieprawidłowy certyfikat czatu."));
            }
            let detached: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_detached WHERE agent_id=?1 AND vault_id=?2)",
                params![agent_id, vault_id], |r| r.get(0)).map_err(db_err)?;
            if detached {
                return Err(VaultError::Forbidden("Administrator odłączył ten czat od tej organizacji. Połącz nowy czat, jeśli ma do niej wrócić.").into());
            }
            if vault_id == personal_id(&user.id) {
                if !personal_open(conn, &user.id).map_err(db_err)? {
                    return Err(if crate::auth::personal_allowed(conn, &user.id).map_err(db_err)? {
                        bad("Najpierw trzeba przenieść Moje notatki na osobny klucz.")
                    } else {
                        VaultError::Forbidden(crate::websync::PERSONAL_OFF_MESSAGE).into()
                    });
                }
            } else if is_shared_vault_id(vault_id) && member_role(conn, vault_id, &user.id).map_err(db_err)?.is_some() {
                if !policy(conn, vault_id).map_err(db_err)?.enabled {
                    return Err(VaultError::Forbidden("W tej organizacji czaty Claude są wyłączone.").into());
                }
            } else {
                return Err(VaultError::Forbidden("Nie jesteś członkiem jednej z wybranych przestrzeni.").into());
            }
            let policy = policy(conn, vault_id).map_err(db_err)?;
            if string_field(e, "writeMode").and_then(mode_index).unwrap_or(0) > policy.max_mode() {
                return Err(bad("Tryb zapisu czatu jest szerszy, niż pozwala organizacja."));
            }
            if file_text == Some(true) && !policy.allow_file_text {
                return Err(bad("Organizacja nie pozwala czatom czytać tekstu z plików."));
            }
            max_hours = max_hours.min(policy.max_hours);
            vaults.push(vault_id.to_string());
        }
        let mut checked_keys = Vec::new();
        for key in keys {
            let current = if vaults.contains(&key.vault_id) { vault_epoch(conn, &key.vault_id, &user.id).map_err(db_err)? } else { 0 };
            let sealed = sealed_json(&key.sealed_key, SEALED_SCHEMA, 80, 1024);
            if !(1..=current).contains(&key.key_epoch) || checked_keys.iter().any(|(v, e, _): &(String, i64, String)| *v == key.vault_id && *e == key.key_epoch) {
                return Err(bad("Klucz czatu podano dla przestrzeni spoza certyfikatu albo nieznanej epoki."));
            }
            checked_keys.push((key.vault_id.clone(), key.key_epoch, sealed.ok_or(bad("Nieprawidłowy zaszyfrowany klucz czatu."))?));
        }
        for vault_id in &vaults {
            let current = vault_epoch(conn, vault_id, &user.id).map_err(db_err)?;
            let has = checked_keys.iter().any(|(v, e, _)| v == vault_id && *e == current) || stored.iter().any(|(v, e)| v == vault_id && *e == current);
            if !has { return Err(bad("Brakuje klucza czatu dla jednej z przestrzeni.")); }
        }
        let mut checked_scopes = Vec::new();
        for scope in scopes {
            let sealed = sealed_json(&scope.sealed_scope, SCOPE_SCHEMA, 48, 48 * 1024).ok_or(bad("Nieprawidłowy zakres czatu."))?;
            let own = own_scope_json(&scope.own_scope).ok_or(bad("Nieprawidłowy zakres czatu."))?;
            if !vaults.contains(&scope.vault_id) || checked_scopes.iter().any(|(v, _, _): &(String, String, String)| *v == scope.vault_id) {
                return Err(bad("Nieprawidłowy zakres czatu."));
            }
            checked_scopes.push((scope.vault_id.clone(), sealed, own));
        }
        if checked_scopes.len() != vaults.len() { return Err(bad("Brakuje zakresu czatu dla jednej z przestrzeni.")); }
        Ok(CertIn {
            agent_id: agent_id.to_string(), sign_key: sign_key.to_string(), box_key: box_key.to_string(), vaults, expires_at,
            cert_json, keys: checked_keys, scopes: checked_scopes, max_hours,
        })
    }

    fn create_agent(&self, user: &AuthUser, input: CreateBody) -> Result<String, Fail> {
        if self.disabled() { return Err(disabled_fail()); }
        let now = now_millis();
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        type Row = (String, i64, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);
        let pairing: Option<Row> = tx.query_row(
            "SELECT state,expires_at,sign_key,box_key,device,mcp_version,claim_ip FROM agent_pairings WHERE pairing_id=?1 AND user_id=?2",
            params![input.pairing_id, user.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        ).optional().map_err(db_err)?;
        let not_claimed = || Fail::Person(VaultError::Conflict("To parowanie nie czeka już na potwierdzenie. Rozpocznij je od nowa."));
        let (state, expires_at, sign_key, box_key, device, mcp_version, claim_ip) = pairing.ok_or_else(not_claimed)?;
        if state != "claimed" || expires_at <= now { return Err(not_claimed()); }
        let (Some(sign_key), Some(box_key), Some(device), Some(mcp_version), Some(claim_ip)) = (sign_key, box_key, device, mcp_version, claim_ip) else {
            return Err(not_claimed());
        };
        let cert = self.check_cert(&tx, user, &input.scope, &[], None)?;
        if cert.sign_key != sign_key || cert.box_key != box_key {
            return Err(VaultError::Conflict("Klucze czatu w certyfikacie różnią się od zgłoszonych przy parowaniu.").into());
        }
        if !SESSION_HOURS.contains(&input.session_hours) || input.session_hours > cert.max_hours {
            return Err(VaultError::Invalid("Długość sesji czatu jest niedozwolona.").into());
        }
        let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE agent_id=?1)", [&cert.agent_id], |r| r.get(0)).map_err(db_err)?;
        if used { return Err(VaultError::Conflict("Ten identyfikator czatu jest już użyty.").into()); }
        let active: i64 = tx.query_row("SELECT count(*) FROM agents WHERE user_id=?1 AND revoked_at IS NULL", [&user.id], |r| r.get(0)).map_err(db_err)?;
        if active >= MAX_CHATS { return Err(VaultError::Conflict("Możesz mieć najwyżej 5 połączonych czatów. Odłącz któryś.").into()); }
        let known = serde_json::to_string(&[&claim_ip]).map_err(db_err)?;
        tx.execute(
            "INSERT INTO agents(agent_id,user_id,sign_key,box_key,device,mcp_version,cert_json,signature,created_at,cert_expires_at,session_hours,known_ips)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![cert.agent_id, user.id, sign_key, box_key, device, mcp_version, cert.cert_json, input.scope.signature, now, cert.expires_at, input.session_hours, known],
        ).map_err(db_err)?;
        Self::store_scope(&tx, &cert)?;
        tx.execute("UPDATE agent_pairings SET state='done', agent_id=?2 WHERE pairing_id=?1", params![input.pairing_id, cert.agent_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        crate::audit::event("agent_paired", &[("user", &user.id), ("agent", &cert.agent_id), ("vaults", &cert.vaults.len().to_string())]);
        Ok(cert.agent_id)
    }

    fn store_scope(conn: &Connection, cert: &CertIn) -> Result<(), Fail> {
        for (vault_id, epoch, sealed) in &cert.keys {
            conn.execute("INSERT OR REPLACE INTO agent_keys(agent_id,vault_id,key_epoch,sealed_key) VALUES (?1,?2,?3,?4)",
                params![cert.agent_id, vault_id, epoch, sealed]).map_err(db_err)?;
        }
        for (vault_id, sealed, own) in &cert.scopes {
            conn.execute("INSERT OR REPLACE INTO agent_scopes(agent_id,vault_id,sealed_scope,own_scope) VALUES (?1,?2,?3,?4)",
                params![cert.agent_id, vault_id, sealed, own]).map_err(db_err)?;
        }
        Ok(())
    }

    /// The person's own chat, not revoked; 404 otherwise.
    fn own_agent(conn: &Connection, user: &AuthUser, agent_id: &str) -> Result<AgentRow, Fail> {
        load_agent(conn, agent_id).map_err(db_err)?
            .filter(|a| a.user_id == user.id && a.revoked_at.is_none())
            .ok_or(Fail::Person(VaultError::Missing("Nie ma takiego czatu.")))
    }

    fn update_scope(&self, user: &AuthUser, agent_id: &str, input: ScopeBody) -> Result<(), Fail> {
        // no new keys for chats while the operator has them off
        if self.disabled() { return Err(disabled_fail()); }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let agent = Self::own_agent(&tx, user, agent_id)?;
        let (sign_key, box_key): (String, String) = tx.query_row(
            "SELECT sign_key,box_key FROM agents WHERE agent_id=?1", [agent_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(db_err)?;
        let stored: Vec<(String, i64)> = tx.prepare("SELECT vault_id,key_epoch FROM agent_keys WHERE agent_id=?1")
            .and_then(|mut q| q.query_map([agent_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()).map_err(db_err)?;
        let stored_created = agent.cert.get("createdAt").and_then(Value::as_i64).ok_or_else(|| db_err(()))?;
        let cert = self.check_cert(&tx, user, &input, &stored, Some(stored_created))?;
        if cert.agent_id != agent_id || cert.sign_key != sign_key || cert.box_key != box_key {
            return Err(VaultError::Conflict("Nowy zakres musi mieć te same klucze czatu.").into());
        }
        let dropped: Vec<String> = cert_vaults(&agent.cert).into_iter().filter(|v| !cert.vaults.contains(v)).collect();
        for vault_id in &dropped {
            // the chat still holds this vault's key: the next admin who opens it makes a new one
            tx.execute("UPDATE vaults SET needs_rotation=1 WHERE vault_id=?1", [vault_id]).map_err(db_err)?;
            tx.execute("DELETE FROM agent_keys WHERE agent_id=?1 AND vault_id=?2", params![agent_id, vault_id]).map_err(db_err)?;
            tx.execute("DELETE FROM agent_scopes WHERE agent_id=?1 AND vault_id=?2", params![agent_id, vault_id]).map_err(db_err)?;
            tx.execute("DELETE FROM agent_proposals WHERE agent_id=?1 AND vault_id=?2 AND state='open'", params![agent_id, vault_id]).map_err(db_err)?;
        }
        tx.execute(
            "UPDATE agents SET cert_json=?2, signature=?3, cert_expires_at=?4 WHERE agent_id=?1",
            params![agent_id, cert.cert_json, input.signature, cert.expires_at],
        ).map_err(db_err)?;
        Self::store_scope(&tx, &cert)?;
        tx.commit().map_err(db_err)?;
        drop(db);
        // a put that passed its check under the old scope has committed once each lock is free
        for vault_id in &dropped { self.locks.with(vault_id, || ()); }
        crate::audit::event("agent_scope_changed", &[("user", &user.id), ("agent", agent_id), ("dropped", &dropped.len().to_string())]);
        Ok(())
    }

    fn list_agents(&self, user: &AuthUser) -> Result<Value, Fail> {
        let now = now_millis();
        let db = self.db()?;
        let mut q = db.prepare(
            "SELECT a.agent_id,a.device,a.mcp_version,a.cert_json,a.signature,a.created_at,a.session_expires_at,a.last_used_at,a.last_ip,
                    a.revoked_at,a.paused,a.known_ips,
                    (SELECT count(*) FROM agent_usage u WHERE u.agent_id=a.agent_id AND u.kind='fetch' AND u.at>?2),
                    (SELECT count(*) FROM agent_usage u WHERE u.agent_id=a.agent_id AND u.kind='write' AND u.at>?2)
             FROM agents a WHERE a.user_id=?1 AND (a.revoked_at IS NULL OR a.revoked_at>?3) ORDER BY a.created_at,a.agent_id",
        ).map_err(db_err)?;
        let rows = q.query_map(params![user.id, now - USAGE_KEPT, now - REVOKED_SHOWN], |r| {
            let json_text = |i: usize| -> rusqlite::Result<Value> { Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or(Value::Null)) };
            Ok(json!({
                "agentId": r.get::<_, String>(0)?,
                "device": json_text(1)?,
                "mcpVersion": r.get::<_, String>(2)?,
                "cert": json_text(3)?,
                "signature": r.get::<_, String>(4)?,
                "createdAt": r.get::<_, i64>(5)?,
                "sessionExpiresAt": r.get::<_, Option<i64>>(6)?,
                "lastUsedAt": r.get::<_, Option<i64>>(7)?,
                "lastIp": r.get::<_, Option<String>>(8)?,
                "revokedAt": r.get::<_, Option<i64>>(9)?,
                "paused": r.get::<_, Option<String>>(10)?,
                "knownIps": json_text(11)?,
                "fetches": r.get::<_, i64>(12)?,
                "writes": r.get::<_, i64>(13)?,
            }))
        }).map_err(db_err)?;
        let mut agents = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        let mut scopes = db.prepare("SELECT vault_id,own_scope FROM agent_scopes WHERE agent_id=?1 ORDER BY vault_id").map_err(db_err)?;
        for agent in &mut agents {
            let id = agent["agentId"].as_str().unwrap_or_default().to_string();
            let list: Vec<Value> = scopes.query_map([&id], |r| Ok(json!({
                "vaultId": r.get::<_, String>(0)?,
                "ownScope": serde_json::from_str::<Value>(&r.get::<_, String>(1)?).unwrap_or(Value::Null),
            }))).and_then(|rows| rows.collect()).map_err(db_err)?;
            agent["scopes"] = Value::Array(list);
        }
        Ok(json!({ "agents": agents }))
    }

    fn renew(&self, user: &AuthUser, agent_id: &str, hours: i64) -> Result<Value, Fail> {
        let now = now_millis();
        let db = self.db()?;
        let agent = Self::own_agent(&db, user, agent_id)?;
        let mut max_hours = 24;
        for vault_id in cert_vaults(&agent.cert) { max_hours = max_hours.min(policy(&db, &vault_id).map_err(db_err)?.max_hours); }
        if !SESSION_HOURS.contains(&hours) || hours > max_hours {
            return Err(VaultError::Invalid("Długość sesji czatu jest niedozwolona.").into());
        }
        let expires_at = now + hours * HOUR;
        let changed = db.execute(
            "UPDATE agents SET session_started_at=?2, session_expires_at=?3, last_used_at=?2 WHERE agent_id=?1 AND session_hash IS NOT NULL",
            params![agent_id, now, expires_at],
        ).map_err(db_err)?;
        if changed == 0 { return Err(VaultError::Conflict("Ten czat nie ma jeszcze sesji.").into()); }
        crate::audit::event("agent_renewed", &[("user", &user.id), ("agent", agent_id), ("hours", &hours.to_string())]);
        Ok(json!({ "sessionExpiresAt": expires_at }))
    }

    fn confirm(&self, user: &AuthUser, agent_id: &str) -> Result<(), Fail> {
        let db = self.db()?;
        Self::own_agent(&db, user, agent_id)?;
        let (known, paused_ip): (String, Option<String>) = db.query_row(
            "SELECT known_ips,paused_ip FROM agents WHERE agent_id=?1", [agent_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(db_err)?;
        let mut known: Vec<String> = serde_json::from_str(&known).unwrap_or_default();
        if let Some(ip) = paused_ip && !known.contains(&ip) {
            known.push(ip);
        }
        db.execute(
            "UPDATE agents SET paused=NULL, paused_ip=NULL, known_ips=?2 WHERE agent_id=?1",
            params![agent_id, serde_json::to_string(&known).map_err(db_err)?],
        ).map_err(db_err)?;
        self.memory().strikes.remove(agent_id);
        crate::audit::event("agent_confirmed", &[("user", &user.id), ("agent", agent_id)]);
        Ok(())
    }

    /// Revokes `ids`, then waits for each of their vaults' locks, so no put of theirs commits after this returns.
    fn revoke(&self, ids: Vec<String>, by: &str) -> Result<(), Fail> {
        let vaults: BTreeSet<String> = {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
            let mut vaults = BTreeSet::new();
            for id in &ids {
                let rows: Vec<String> = tx.prepare("SELECT vault_id FROM agent_scopes WHERE agent_id=?1")
                    .and_then(|mut q| q.query_map([id], |r| r.get(0))?.collect()).map_err(db_err)?;
                vaults.extend(rows);
            }
            revoke_agents(&tx, &ids, now_millis()).map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            vaults
        };
        for vault_id in &vaults { self.locks.with(vault_id, || ()); }
        for id in &ids { crate::audit::event("agent_revoked", &[("agent", id), ("by", by)]); }
        Ok(())
    }

    fn revoke_own(&self, user: &AuthUser, agent_id: Option<&str>) -> Result<(), Fail> {
        let ids: Vec<String> = {
            let db = self.db()?;
            match agent_id {
                Some(id) => vec![Self::own_agent(&db, user, id)?.agent_id],
                None => db.prepare("SELECT agent_id FROM agents WHERE user_id=?1 AND revoked_at IS NULL")
                    .and_then(|mut q| q.query_map([&user.id], |r| r.get(0))?.collect()).map_err(db_err)?,
            }
        };
        self.revoke(ids, &user.id)
    }

    /// An admin of the vault detaches a member's chat from this vault only: its keys, scope and open proposals here go,
    /// the vault is marked for a new key, and the chat keeps its other vaults and its session. For good: a new cert
    /// cannot bring this vault back to this chat. Under the vault lock, so a put of the chat that passed its check has
    /// committed before this returns, and none commits after.
    fn revoke_in_vault(&self, user: &AuthUser, vault_id: &str, agent_id: &str) -> Result<(), Fail> {
        self.locks.with(vault_id, || {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
            let role = member_role(&tx, vault_id, &user.id).map_err(db_err)?.ok_or(VaultError::NotFound)?;
            if role < Role::Admin { return Err(VaultError::Forbidden("Brak uprawnień do tej operacji.").into()); }
            let found: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM agents a JOIN agent_scopes s ON s.agent_id=a.agent_id
                   JOIN vault_members m ON m.vault_id=s.vault_id AND m.user_id=a.user_id
                 WHERE a.agent_id=?1 AND s.vault_id=?2 AND a.revoked_at IS NULL)",
                params![agent_id, vault_id], |r| r.get(0),
            ).map_err(db_err)?;
            if !found { return Err(VaultError::Missing("Nie ma takiego czatu.").into()); }
            for table in ["agent_keys", "agent_scopes"] {
                tx.execute(&format!("DELETE FROM {table} WHERE agent_id=?1 AND vault_id=?2"), params![agent_id, vault_id]).map_err(db_err)?;
            }
            tx.execute("DELETE FROM agent_proposals WHERE agent_id=?1 AND vault_id=?2 AND state='open'", params![agent_id, vault_id]).map_err(db_err)?;
            tx.execute("INSERT OR REPLACE INTO agent_detached(agent_id,vault_id,detached_at) VALUES (?1,?2,?3)",
                params![agent_id, vault_id, now_millis()]).map_err(db_err)?;
            tx.execute("UPDATE vaults SET needs_rotation=1 WHERE vault_id=?1", [vault_id]).map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            crate::audit::event("agent_detached", &[("agent", agent_id), ("vault", vault_id), ("by", &user.id)]);
            Ok(())
        })
    }

    fn set_policy(&self, user: &AuthUser, vault_id: &str, input: PolicyBody) -> Result<(), Fail> {
        if !SESSION_HOURS.contains(&input.max_hours) || mode_index(&input.max_write_mode).is_none() {
            return Err(VaultError::Invalid("Nieprawidłowe ustawienia czatów.").into());
        }
        // under the vault lock: a chat's put checked against the old policy has committed before the new one applies
        self.locks.with(vault_id, || {
            let db = self.db()?;
            let role = member_role(&db, vault_id, &user.id).map_err(db_err)?.ok_or(VaultError::NotFound)?;
            if role < Role::Owner { return Err(VaultError::Forbidden("Ustawienia czatów zmienia właściciel.").into()); }
            let file_text = match input.allow_file_text {
                Some(v) => v,
                None => policy(&db, vault_id).map_err(db_err)?.allow_file_text,
            };
            db.execute(
                "INSERT INTO vault_agent_policy(vault_id,enabled,max_hours,max_write_mode,allow_protected,allow_file_text) VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(vault_id) DO UPDATE SET enabled=excluded.enabled, max_hours=excluded.max_hours,
                   max_write_mode=excluded.max_write_mode, allow_protected=excluded.allow_protected, allow_file_text=excluded.allow_file_text",
                params![vault_id, input.enabled, input.max_hours, input.max_write_mode, input.allow_protected, file_text],
            ).map_err(db_err)?;
            crate::audit::event("agent_policy_set", &[("vault", vault_id), ("by", &user.id), ("enabled", if input.enabled { "yes" } else { "no" })]);
            Ok(())
        })
    }

    /// The person may see proposals in `vault_id`: a member, or their own personal vault.
    fn person_in(conn: &Connection, user: &AuthUser, vault_id: &str) -> Result<(), Fail> {
        if vault_id == personal_id(&user.id) || member_role(conn, vault_id, &user.id).map_err(db_err)?.is_some() {
            Ok(())
        } else {
            Err(VaultError::NotFound.into())
        }
    }

    fn list_proposals(&self, user: &AuthUser, vault_id: &str) -> Result<Value, Fail> {
        let now = now_millis();
        let db = self.db()?;
        Self::person_in(&db, user, vault_id)?;
        let mut q = db.prepare(
            "SELECT p.proposal_id,p.agent_id,p.created_at,p.expires_at,p.state,p.proposal_json FROM agent_proposals p
             JOIN agents a ON a.agent_id=p.agent_id
             WHERE p.vault_id=?1 AND p.user_id=?2 AND a.user_id=?2 AND p.expires_at>?3 ORDER BY p.created_at,p.proposal_id",
        ).map_err(db_err)?;
        let rows = q.query_map(params![vault_id, user.id, now], |r| Ok(json!({
            "proposalId": r.get::<_, String>(0)?,
            "agentId": r.get::<_, String>(1)?,
            "createdAt": r.get::<_, i64>(2)?,
            "expiresAt": r.get::<_, i64>(3)?,
            "state": r.get::<_, String>(4)?,
            "proposal": serde_json::from_str::<Value>(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
        }))).map_err(db_err)?;
        let proposals = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        Ok(json!({ "proposals": proposals }))
    }

    fn decide(&self, user: &AuthUser, vault_id: &str, proposal_id: &str, decision: &str) -> Result<(), Fail> {
        if !matches!(decision, "approved" | "rejected") { return Err(VaultError::Invalid("Nieznana decyzja.").into()); }
        let db = self.db()?;
        Self::person_in(&db, user, vault_id)?;
        let state: String = db.query_row(
            "SELECT state FROM agent_proposals WHERE proposal_id=?1 AND vault_id=?2 AND user_id=?3 AND expires_at>?4",
            params![proposal_id, vault_id, user.id, now_millis()], |r| r.get(0),
        ).optional().map_err(db_err)?.ok_or(VaultError::Missing("Nie ma takiej propozycji."))?;
        if state != "open" { return Err(VaultError::Conflict("O tej propozycji już zdecydowano.").into()); }
        db.execute("UPDATE agent_proposals SET state=?2 WHERE proposal_id=?1", params![proposal_id, decision]).map_err(db_err)?;
        Ok(())
    }

    // ---- chat requests ----

    fn vault_entry(&self, conn: &Connection, agent: &AgentRow, vault_id: &str) -> Result<Value, Fail> {
        if vault_id == personal_id(&agent.user_id) {
            if !personal_open(conn, &agent.user_id).map_err(db_err)? {
                return Err(VaultError::NotFound.into());
            }
            let epoch = personal_epoch(conn, &agent.user_id).map_err(db_err)?;
            return Ok(json!({ "id": vault_id, "name": "Moje notatki", "kind": "notatki", "ownerUserId": agent.user_id, "keyEpoch": epoch }));
        }
        conn.query_row(
            "SELECT vault_id,name,kind,owner_user_id,key_epoch FROM vaults WHERE vault_id=?1", [vault_id],
            |r| Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?,
                           "ownerUserId": r.get::<_, String>(3)?, "keyEpoch": r.get::<_, i64>(4)? })),
        ).map_err(db_err)
    }

    fn agent_me(&self, chat: &Chat) -> Result<Value, Fail> {
        let now = now_millis();
        let db = self.db()?;
        let agent = load_agent(&db, &chat.agent_id).map_err(db_err)?.ok_or_else(session_fail)?;
        let mut vaults = Vec::new();
        for vault_id in cert_vaults(&agent.cert) {
            if let Some(access) = vault_access(&db, &agent, &vault_id, now).map_err(db_err)? {
                let entry = self.vault_entry(&db, &agent, &vault_id)?;
                let scope: String = db.query_row("SELECT sealed_scope FROM agent_scopes WHERE agent_id=?1 AND vault_id=?2",
                    params![agent.agent_id, vault_id], |r| r.get(0)).map_err(db_err)?;
                vaults.push(json!({ "vaultId": vault_id, "name": entry["name"], "kind": entry["kind"],
                                    "role": access.role.as_str(), "writeMode": WRITE_MODES[access.write],
                                    "scopeHash": hex(&sha2::Sha256::digest(scope.as_bytes())) }));
            }
        }
        Ok(json!({ "agentId": agent.agent_id, "userId": agent.user_id, "cert": agent.cert, "signature": agent.signature,
                   "sessionExpiresAt": agent.session_expires_at, "vaults": vaults }))
    }

    fn agent_vault(&self, chat: &Chat, vault_id: &str) -> Result<Value, Fail> {
        let now = now_millis();
        let db = self.db()?;
        let (agent, access) = self.chat_vault(&db, chat, vault_id, now)?;
        let vault = self.vault_entry(&db, &agent, vault_id)?;
        let keys: Vec<Value> = db.prepare("SELECT key_epoch,sealed_key FROM agent_keys WHERE agent_id=?1 AND vault_id=?2 ORDER BY key_epoch")
            .and_then(|mut q| q.query_map(params![agent.agent_id, vault_id], |r| Ok(json!({
                "keyEpoch": r.get::<_, i64>(0)?,
                "sealedKey": serde_json::from_str::<Value>(&r.get::<_, String>(1)?).unwrap_or(Value::Null),
            })))?.collect()).map_err(db_err)?;
        let scope: Option<String> = db.query_row("SELECT sealed_scope FROM agent_scopes WHERE agent_id=?1 AND vault_id=?2",
            params![agent.agent_id, vault_id], |r| r.get(0)).optional().map_err(db_err)?;
        let public = |table: &str, user: &str| -> Result<Value, Fail> {
            let text: Option<String> = db.query_row(&format!("SELECT public_jwk FROM {table} WHERE user_id=?1"), [user], |r| r.get(0))
                .optional().map_err(db_err)?;
            Ok(text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null))
        };
        let person = json!({ "userId": agent.user_id, "signingKey": public("user_signing_keys", &agent.user_id)?, "boxKey": public("user_box_keys", &agent.user_id)? });
        let members: Vec<Value> = if is_shared_vault_id(vault_id) {
            db.prepare("SELECT m.user_id,u.display_name,m.role,k.public_jwk FROM vault_members m JOIN web_users u ON u.user_id=m.user_id
                        LEFT JOIN user_signing_keys k ON k.user_id=m.user_id WHERE m.vault_id=?1 ORDER BY m.added_at,m.user_id")
                .and_then(|mut q| q.query_map([vault_id], |r| Ok(json!({
                    "userId": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "role": r.get::<_, String>(2)?,
                    "signingKey": r.get::<_, Option<String>>(3)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()),
                })))?.collect()).map_err(db_err)?
        } else {
            let name: String = db.query_row("SELECT display_name FROM web_users WHERE user_id=?1", [&agent.user_id], |r| r.get(0)).map_err(db_err)?;
            vec![json!({ "userId": agent.user_id, "name": name, "role": "owner", "signingKey": person["signingKey"] })]
        };
        Ok(json!({
            "vault": vault, "role": access.role.as_str(), "writeMode": WRITE_MODES[access.write], "agentKeys": keys,
            "fileText": access.file_text,
            "allowProtected": policy(&db, vault_id).map_err(db_err)?.allow_protected,
            "sealedScope": scope.and_then(|s| serde_json::from_str::<Value>(&s).ok()), "person": person, "members": members,
        }))
    }

    fn get_snapshot(&self, chat: &Chat, vault_id: &str, uri: &Uri) -> Result<Value, Fail> {
        let now = now_millis();
        {
            let db = self.db()?;
            self.chat_vault(&db, chat, vault_id, now)?;
        }
        let since: Option<u64> = uri.query().and_then(|q| q.split('&').find_map(|p| p.strip_prefix("since="))).and_then(|v| v.parse().ok());
        if let Some(since) = since {
            let (revision, author) = self.sync.revision(&chat.user_id, vault_id).map_err(db_err)?;
            if revision == since {
                return Ok(json!({ "revision": revision, "envelope": Value::Null, "author": author }));
            }
        }
        let key = (chat.agent_id.clone(), vault_id.to_string());
        let allowed = {
            let mut memory = self.memory();
            match memory.fetches.get(&key) {
                Some(last) if now - *last < FULL_FETCH_EVERY => false,
                _ => { memory.fetches.insert(key, now); true }
            }
        };
        if !allowed { return Err(self.strike(&chat.agent_id, now)); }
        let (revision, envelope, author) = self.sync.stored(&chat.user_id, vault_id).map_err(db_err)?;
        self.record(&*self.db()?, chat, "fetch", now)?;
        Ok(json!({ "revision": revision, "envelope": envelope, "author": author }))
    }

    /// The chat may read the text of files in `vault_id` (docs/OCR.md §5.2, §5.3): the vault is in its certificate and
    /// session, the certificate has "Tekst z plików" there and the vault's policy allows it.
    fn file_text_access(&self, chat: &Chat, vault_id: &str) -> Result<(), Fail> {
        let db = self.db()?;
        let (_, access) = self.chat_vault(&db, chat, vault_id, now_millis())?;
        if !access.file_text { return Err(file_text_fail()); }
        Ok(())
    }

    /// One text layer fetched, in the usage log: at most one full pass (the vault's layers and a small margin) per
    /// FULL_FETCH_EVERY, like a full fetch of the vault; more is a strike.
    fn count_text_read(&self, chat: &Chat, vault_id: &str, layers: usize) -> Result<(), Fail> {
        let now = now_millis();
        let allowed = {
            let mut memory = self.memory();
            let times = memory.text_reads.entry((chat.agent_id.clone(), vault_id.to_string())).or_default();
            take(times, now, FULL_FETCH_EVERY, layers.saturating_add(TEXT_READ_MARGIN))
        };
        if !allowed { return Err(self.strike(&chat.agent_id, now)); }
        self.record(&*self.db()?, chat, "file_text", now)
    }

    fn put_snapshot(&self, chat: &Chat, vault_id: &str, body: &[u8]) -> Result<Value, Fail> {
        let now = now_millis();
        {
            let db = self.db()?;
            let (_, access) = self.chat_vault(&db, chat, vault_id, now)?;
            if access.write < APPEND { return Err(read_only_fail()); }
        }
        self.count_write(&chat.agent_id, now)?;
        // any `author` in the body is ignored: the author is this session's
        let input: SnapshotBody = serde_json::from_slice(body).map_err(|_| invalid_fail())?;
        let author = Author { user_id: chat.user_id.clone(), agent_id: Some(chat.agent_id.clone()) };
        let result = self.sync.put_checked(&author, vault_id, input.base_revision, &input.envelope, || {
            let db = self.db.lock().map_err(|_| SyncError::Internal)?;
            let agent = load_agent(&db, &chat.agent_id).map_err(|_| SyncError::Internal)?.ok_or(SyncError::Forbidden)?;
            match vault_access(&db, &agent, vault_id, now_millis()).map_err(|_| SyncError::Internal)? {
                Some(access) => Ok(access.write >= APPEND),
                None => Err(SyncError::Forbidden),
            }
        });
        match result {
            Ok(PutResult::Accepted(revision)) => {
                self.sync.publish_update(&chat.user_id, vault_id, revision, input.envelope, author);
                self.record(&*self.db()?, chat, "write", now)?;
                Ok(json!({ "revision": revision }))
            }
            Ok(PutResult::Conflict { revision, envelope, .. }) => Err(Fail::Conflict(revision, envelope)),
            Ok(PutResult::ReadOnly) => Err(read_only_fail()),
            Ok(PutResult::StaleKey) => Err(fail(StatusCode::CONFLICT, "stale-key", "Sejf ma nowszy klucz. Pobierz klucz ponownie.")),
            Err(SyncError::Forbidden) => Err(scope_fail()),
            Err(SyncError::Invalid) => Err(invalid_fail()),
            Err(SyncError::Internal) => Err(db_err(())),
        }
    }

    fn add_proposal(&self, chat: &Chat, vault_id: &str, body: &[u8]) -> Result<Value, Fail> {
        let now = now_millis();
        {
            let db = self.db()?;
            let (_, access) = self.chat_vault(&db, chat, vault_id, now)?;
            if access.write < PROPOSALS { return Err(read_only_fail()); }
        }
        self.count_write(&chat.agent_id, now)?;
        let input: ProposalBody = serde_json::from_slice(body).map_err(|_| invalid_fail())?;
        let (proposal_id, text) = proposal_json(&input.proposal, &chat.agent_id, &chat.user_id).ok_or_else(invalid_fail)?;
        #[cfg(test)]
        crate::websync::run_hook(&self.before_proposal);
        let mut db = self.db()?;
        // checked again in the same write transaction as the insert: a revoke, removal or lower role that committed
        // in between (also from another connection, e.g. `agents revoke-all`) leaves no open proposal behind
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let (_, access) = self.chat_vault(&tx, chat, vault_id, now_millis())?;
        if access.write < PROPOSALS { return Err(read_only_fail()); }
        let db = tx;
        db.execute("DELETE FROM agent_proposals WHERE expires_at<=?1", [now]).map_err(db_err)?;
        let open: i64 = db.query_row("SELECT count(*) FROM agent_proposals WHERE agent_id=?1 AND state='open'", [&chat.agent_id], |r| r.get(0)).map_err(db_err)?;
        if open >= OPEN_PROPOSALS {
            return Err(fail(StatusCode::TOO_MANY_REQUESTS, "limit", "Ten czat ma już 100 propozycji czekających na decyzję."));
        }
        let inserted = db.execute(
            "INSERT INTO agent_proposals(proposal_id,agent_id,user_id,vault_id,created_at,expires_at,state,proposal_json) VALUES (?1,?2,?3,?4,?5,?6,'open',?7)",
            params![proposal_id, chat.agent_id, chat.user_id, vault_id, now, now + PROPOSAL_TTL, text],
        );
        match inserted {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY => {
                return Err(fail(StatusCode::CONFLICT, "conflict", "Taka propozycja już jest."));
            }
            Err(_) => return Err(db_err(())),
        }
        self.record(&db, chat, "write", now)?;
        db.commit().map_err(db_err)?;
        Ok(json!({ "proposalId": proposal_id }))
    }
}

/// Shape check of a scope's own copy: a `notes-key-v1` envelope `{ schema, nonce, ciphertext }`, ciphertext ≤ 64 KiB.
fn own_scope_json(value: &Value) -> Option<String> {
    let obj = value.as_object()?;
    let nonce = string_field(obj, "nonce").filter(|n| canonical_base64(n).is_some_and(|b| b.len() == 12))?;
    let ciphertext = string_field(obj, "ciphertext")
        .filter(|c| c.len() <= OWN_SCOPE_MAX && canonical_base64(c).is_some_and(|b| b.len() >= 16))?;
    if obj.len() != 3 || string_field(obj, "schema") != Some("notes-key-v1") { return None; }
    serde_json::to_string(&json!({ "schema": "notes-key-v1", "nonce": nonce, "ciphertext": ciphertext })).ok()
}

/// Shape check of a `notes-proposal-v1` from `agent_id` of `user_id`: exactly its fields. Returns (id, normalized JSON).
fn proposal_json(value: &Value, agent_id: &str, user_id: &str) -> Option<(String, String)> {
    let obj = value.as_object()?;
    let id = string_field(obj, "proposalId").filter(|id| is_hex32(id))?;
    let (_, epk) = canonical_public_jwk(obj.get("epk")?).ok()?;
    let nonce = string_field(obj, "nonce").filter(|n| canonical_base64(n).is_some_and(|b| b.len() == 12))?;
    let ciphertext = string_field(obj, "ciphertext")
        .filter(|c| c.len() <= PROPOSAL_CIPHERTEXT_MAX.div_ceil(3) * 4 && canonical_base64(c).is_some_and(|b| (16..=PROPOSAL_CIPHERTEXT_MAX).contains(&b.len())))?;
    let signature = string_field(obj, "signature").filter(|s| b64u_exact(s, 64).is_some())?;
    let fields_ok = obj.len() == 10 && string_field(obj, "schema") == Some(PROPOSAL_SCHEMA)
        && string_field(obj, "agentId") == Some(agent_id) && string_field(obj, "signerAgentId") == Some(agent_id)
        && string_field(obj, "signerUserId") == Some(user_id) && string_field(obj, "alg") == Some("ed25519");
    if !fields_ok { return None; }
    let text = serde_json::to_string(&json!({
        "schema": PROPOSAL_SCHEMA, "proposalId": id, "agentId": agent_id, "epk": epk, "nonce": nonce, "ciphertext": ciphertext,
        "signerUserId": user_id, "signerAgentId": agent_id, "alg": "ed25519", "signature": signature,
    })).ok()?;
    Some((id.to_string(), text))
}

struct Api {
    auth: Arc<AuthService>,
    agents: Arc<AgentService>,
    files: Arc<FileService>,
}

pub fn routes(auth: Arc<AuthService>, agents: Arc<AgentService>, files: Arc<FileService>) -> Router {
    Router::new()
        .route("/api/version", get(version))
        .route("/api/me/agent-pairings", post(start_pairing))
        .route("/api/me/agent-pairings/{id}", get(pairing_state).delete(cancel_pairing))
        .route("/api/me/agents", get(list_agents).post(create_agent).delete(revoke_all_mine))
        .route("/api/me/agents/{id}", put(update_scope).delete(revoke_mine))
        .route("/api/me/agents/{id}/renew", post(renew))
        .route("/api/me/agents/{id}/confirm", post(confirm))
        .route("/api/vaults/{id}/agents/{agent_id}", delete(revoke_in_vault))
        .route("/api/vaults/{id}/agent-policy", put(set_policy))
        .route("/api/vaults/{id}/proposals", get(list_proposals))
        .route("/api/vaults/{id}/proposals/{pid}/decision", post(decide))
        .route("/api/agent-pair/claim", post(claim))
        .route("/api/agent-pair/{token}", get(issue))
        .route("/api/agent/me", get(agent_me))
        .route("/api/agent/vaults/{id}", get(agent_vault))
        .route("/api/agent/vaults/{id}/snapshot", get(get_snapshot).post(put_snapshot).layer(DefaultBodyLimit::max(SNAPSHOT_BODY_LIMIT)))
        .route("/api/agent/vaults/{id}/proposals", post(add_proposal).layer(DefaultBodyLimit::max(PROPOSAL_BODY_LIMIT)))
        // the text of files (docs/OCR.md §5.3): envelopes of originals and text layers, and the content of text layers only
        .route("/api/agent/vaults/{id}/files", get(agent_files))
        .route("/api/agent/vaults/{id}/files/{file}/content", get(agent_file_content))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(Arc::new(Api { auth, agents, files }))
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

/// A person's route: the cookie session (same origin for mutations), never a chat token.
async fn person<T, F>(api: Arc<Api>, headers: HeaderMap, mutating: bool, work: F) -> Response
where
    T: IntoResponse,
    F: FnOnce(&AgentService, AuthUser, String) -> Result<T, Fail> + Send + 'static,
{
    let ip = client_ip(&headers);
    let user = match authorize(api.auth.clone(), headers, mutating).await {
        Ok(user) => user,
        Err(Refused::Origin) => return VaultError::Forbidden(FOREIGN_REQUEST).into_response(),
        Err(Refused::Session) => return VaultError::Unauthorized.into_response(),
        Err(Refused::Internal) => return VaultError::Internal.into_response(),
    };
    match tokio::task::spawn_blocking(move || work(&api.agents, user, ip).map(IntoResponse::into_response)).await {
        Ok(Ok(response)) => no_store(response),
        Ok(Err(e)) => e.into_response(),
        Err(_) => VaultError::Internal.into_response(),
    }
}

/// A chat's route: every check of `authenticate`, then `work`.
async fn chat_request<T, F>(api: Arc<Api>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes, work: F) -> Response
where
    T: IntoResponse,
    F: FnOnce(&AgentService, Chat, &Uri, &[u8]) -> Result<T, Fail> + Send + 'static,
{
    let ip = client_ip(&headers);
    let result = tokio::task::spawn_blocking(move || {
        let request = Signed { method: &method, uri: &uri, headers: &headers, body: &body };
        let chat = api.agents.authenticate(&request, &ip)?;
        work(&api.agents, chat, &uri, &body).map(IntoResponse::into_response)
    }).await;
    match result {
        Ok(Ok(response)) => no_store(response),
        Ok(Err(e)) => e.into_response(),
        Err(_) => VaultError::Internal.into_response(),
    }
}

async fn version(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    no_store(Json(api.agents.version_reply(&headers)).into_response())
}

async fn start_pairing(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    person(api, headers, true, |agents, user, ip| Ok((StatusCode::CREATED, Json(agents.start_pairing(&user, &ip)?)))).await
}

async fn pairing_state(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    person(api, headers, false, move |agents, user, _| Ok(Json(agents.pairing_state(&user, &id)?))).await
}

async fn cancel_pairing(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.cancel_pairing(&user, &id)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn list_agents(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    person(api, headers, false, |agents, user, _| Ok(Json(agents.list_agents(&user)?))).await
}

async fn create_agent(State(api): State<Arc<Api>>, headers: HeaderMap, Json(input): Json<CreateBody>) -> Response {
    person(api, headers, true, move |agents, user, _| {
        Ok((StatusCode::CREATED, Json(json!({ "agentId": agents.create_agent(&user, input)? }))))
    }).await
}

async fn revoke_all_mine(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    person(api, headers, true, |agents, user, _| { agents.revoke_own(&user, None)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn update_scope(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<ScopeBody>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.update_scope(&user, &id, input)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn revoke_mine(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.revoke_own(&user, Some(&id))?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn renew(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<HoursBody>) -> Response {
    person(api, headers, true, move |agents, user, _| Ok(Json(agents.renew(&user, &id, input.hours)?))).await
}

async fn confirm(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.confirm(&user, &id)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn revoke_in_vault(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, agent_id)): AxumPath<(String, String)>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.revoke_in_vault(&user, &id, &agent_id)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn set_policy(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<PolicyBody>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.set_policy(&user, &id, input)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn list_proposals(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    person(api, headers, false, move |agents, user, _| Ok(Json(agents.list_proposals(&user, &id)?))).await
}

async fn decide(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, pid)): AxumPath<(String, String)>, Json(input): Json<DecisionBody>) -> Response {
    person(api, headers, true, move |agents, user, _| { agents.decide(&user, &id, &pid, &input.decision)?; Ok(StatusCode::NO_CONTENT) }).await
}

async fn claim(State(api): State<Arc<Api>>, headers: HeaderMap, body: Bytes) -> Response {
    let ip = client_ip(&headers);
    match tokio::task::spawn_blocking(move || api.agents.claim(&headers, &body, &ip)).await {
        Ok(Ok(reply)) => no_store(Json(reply).into_response()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => VaultError::Internal.into_response(),
    }
}

async fn issue(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath(token): AxumPath<String>, body: Bytes) -> Response {
    let ip = client_ip(&headers);
    let result = tokio::task::spawn_blocking(move || {
        api.agents.issue(&Signed { method: &method, uri: &uri, headers: &headers, body: &body }, &token, &ip)
    }).await;
    match result {
        Ok(Ok(reply)) => no_store(Json(reply).into_response()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => VaultError::Internal.into_response(),
    }
}

async fn agent_me(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    chat_request(api, method, uri, headers, body, |agents, chat, _, _| Ok(Json(agents.agent_me(&chat)?))).await
}

async fn agent_vault(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath(id): AxumPath<String>, body: Bytes) -> Response {
    chat_request(api, method, uri, headers, body, move |agents, chat, _, _| Ok(Json(agents.agent_vault(&chat, &id)?))).await
}

async fn get_snapshot(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath(id): AxumPath<String>, body: Bytes) -> Response {
    chat_request(api, method, uri, headers, body, move |agents, chat, uri, _| Ok(Json(agents.get_snapshot(&chat, &id, uri)?))).await
}

async fn put_snapshot(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath(id): AxumPath<String>, body: Bytes) -> Response {
    chat_request(api, method, uri, headers, body, move |agents, chat, _, body| Ok(Json(agents.put_snapshot(&chat, &id, body)?))).await
}

async fn add_proposal(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath(id): AxumPath<String>, body: Bytes) -> Response {
    chat_request(api, method, uri, headers, body, move |agents, chat, _, body| {
        Ok((StatusCode::CREATED, Json(agents.add_proposal(&chat, &id, body)?)))
    }).await
}

async fn agent_files(State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath(id): AxumPath<String>, body: Bytes) -> Response {
    let files = api.files.clone();
    chat_request(api, method, uri, headers, body, move |agents, chat, _, _| {
        agents.file_text_access(&chat, &id)?;
        let list = files.agent_listing(&chat.user_id, &id).map_err(file_fail)?;
        Ok(Json(json!({ "files": list })))
    }).await
}

/// The ciphertext of one text layer. The request is authenticated, allowed and counted before anything about the file
/// is looked at, so asking for an original costs the same as reading a layer and tells nothing.
async fn agent_file_content(
    State(api): State<Arc<Api>>, method: Method, uri: Uri, headers: HeaderMap, AxumPath((id, file)): AxumPath<(String, String)>, body: Bytes,
) -> Response {
    let ip = client_ip(&headers);
    let (agents, files) = (api.agents.clone(), api.files.clone());
    let vault = id.clone();
    let checked = tokio::task::spawn_blocking(move || -> Result<Chat, Fail> {
        let request = Signed { method: &method, uri: &uri, headers: &headers, body: &body };
        let chat = agents.authenticate(&request, &ip)?;
        agents.file_text_access(&chat, &vault)?;
        let layers = files.text_layer_count(&chat.user_id, &vault).map_err(file_fail)?;
        agents.count_text_read(&chat, &vault, layers)?;
        Ok(chat)
    }).await;
    let chat = match checked {
        Ok(Ok(chat)) => chat,
        Ok(Err(e)) => return e.into_response(),
        Err(_) => return VaultError::Internal.into_response(),
    };
    match api.files.open_text_content(&chat.user_id, &id, &file).await {
        Ok(content) => no_store(content.into_response()),
        Err(e) => file_fail(e).into_response(),
    }
}

#[cfg(test)]
#[path = "agents_tests.rs"]
mod agents_tests;
