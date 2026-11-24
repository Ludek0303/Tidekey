//! Same-origin local accounts for the browser client. Account login is deliberately separate from
//! vault encryption keys: this module never receives a recovery phrase or note content.

use std::env;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::Router;
use axum::extract::State;
use axum::http::header::{COOKIE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::vaults::validate_wrapped_key;
use crate::websync::Envelope;

const SESSION_COOKIE: &str = "notes_session";
const SESSION_SECONDS: i64 = 60 * 60 * 24 * 30;
const LOGIN_WINDOW_SECONDS: i64 = 15 * 60;
const LOGIN_MAX_FAILURES: u32 = 10;
const MAX_BODY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: String,
    /// Legacy plaintext last name: only read so the client can migrate it, then cleared. Empty when none.
    pub last_name: String,
    /// The user's own encrypted profile (`notes-key-v1` under the personal key), or null.
    pub profile_secret: Option<Value>,
    /// The user's encrypted appearance/editor settings (`notes-key-v1` under the personal key), or null.
    pub preferences: Option<Value>,
    /// Whether the account may keep its own notes (`browser-<id>`): `allowed`, `requested` or `off` (docs/PANEL-ADMINA.md).
    pub personal: String,
}

#[derive(Clone)]
pub struct AuthService {
    inner: Arc<Inner>,
}

struct Inner {
    db: Mutex<Connection>,
    cookie_secure: bool,
    data_dir: std::path::PathBuf,
    /// Registrations per client in the current hour (in memory only: the client is a hash of its IP).
    signups: Mutex<std::collections::HashMap<String, (i64, u32)>>,
    signups_per_hour: u32,
    registration: Registration,
}

/// `NOTES_REGISTRATION`: who may create an account. `invite` (the default): only with an organization's invite link
/// or a registration code from the server admin (`signup_codes`). `open`: anyone. `closed`: nobody.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Registration { Open, Invite, Closed }

#[cfg(test)]
impl Inner {
    fn clone_for_test(other: &Inner) -> Inner {
        Inner {
            db: Mutex::new(Connection::open(other.data_dir.join("auth.db")).unwrap()), cookie_secure: other.cookie_secure,
            data_dir: other.data_dir.clone(), signups: Mutex::new(Default::default()), signups_per_hour: other.signups_per_hour,
            registration: other.registration,
        }
    }
}

impl Registration {
    /// An unknown value falls back to `invite`, never to an open server.
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("open") => Self::Open,
            Some("closed") => Self::Closed,
            _ => Self::Invite,
        }
    }

    fn from_env() -> Self {
        let value = env::var("NOTES_REGISTRATION").ok();
        // the unit tests make accounts freely; the invite and code paths have their own tests (parse covers the default)
        if cfg!(test) && value.is_none() { return Self::Open; }
        Self::parse(value.as_deref())
    }

    fn name(self) -> &'static str {
        match self { Self::Open => "open", Self::Invite => "invite", Self::Closed => "closed" }
    }
}

/// Characters of a registration code: no 0/O or 1/I, which are misread when the code is typed from a note.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 12;

/// A new registration code as shown to the admin (`ABCD-EFGH-JKLM`, 60 random bits) and the hash that is stored.
pub(crate) fn new_signup_code() -> Result<(String, String), AuthError> {
    let bytes = notes_sync::random::<CODE_LEN>().map_err(|_| AuthError::Internal)?;
    let plain: String = bytes.iter().map(|b| CODE_ALPHABET[usize::from(b & 31)] as char).collect();
    let shown = plain.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-");
    Ok((shown, signup_code_hash(&plain)))
}

/// The stored form of a code as typed: case, spaces and dashes do not matter.
pub(crate) fn signup_code_hash(code: &str) -> String {
    let normalized: String = code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect();
    blake3::hash(normalized.as_bytes()).to_hex().to_string()
}

const SIGNUP_WINDOW_SECONDS: i64 = 60 * 60;
// The Argon2 hash an unknown email is checked against, made once: both paths then do one verification, the same work.
static DUMMY_HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

impl AuthService {
    /// Opens (or creates) the authentication database below the node's private data directory.
    /// Set `AUTH_COOKIE_SECURE=false` only for local HTTP development; deployments must use HTTPS.
    pub fn open(data_dir: &Path) -> Result<Self, AuthError> {
        fs::create_dir_all(data_dir).map_err(|_| AuthError::Internal)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
                .map_err(|_| AuthError::Internal)?;
        }
        let path = data_dir.join("auth.db");
        let db = Connection::open(&path).map_err(|_| AuthError::Internal)?;
        // The vault tables share this file through their own connection.
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_| AuthError::Internal)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|_| AuthError::Internal)?;
        }
        db.pragma_update(None, "journal_mode", "WAL").map_err(|_| AuthError::Internal)?;
        db.pragma_update(None, "synchronous", "FULL").map_err(|_| AuthError::Internal)?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(|_| AuthError::Internal)?;
        // Cleared values (a migrated plaintext last name, a deleted account) are overwritten, not left in free pages.
        db.pragma_update(None, "secure_delete", "ON").map_err(|_| AuthError::Internal)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS web_users (
                user_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL DEFAULT 'Użytkownik',
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS web_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions(expires_at);
            CREATE TABLE IF NOT EXISTS web_login_attempts (
                email TEXT PRIMARY KEY,
                window_start INTEGER NOT NULL,
                failures INTEGER NOT NULL
            );
            -- registration codes from the server admin (admin.rs makes them); only the hash of a code is kept
            CREATE TABLE IF NOT EXISTS signup_codes (
                code_id TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                used_at INTEGER,
                used_by TEXT
            );
            -- accounts made from an invite link: at most the link's max_uses (joining is counted apart, in vaults.rs)
            CREATE TABLE IF NOT EXISTS invite_signups (
                invite_id TEXT NOT NULL,
                user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(invite_id, user_id)
            );",
        ).map_err(|_| AuthError::Internal)?;
        if !column_exists(&db, "web_users", "display_name")? {
            db.execute(
                "ALTER TABLE web_users ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Użytkownik'",
                [],
            )
            .map_err(|_| AuthError::Internal)?;
        }
        // Existing rows keep their display name as it is; their last name stays empty (names are never split).
        if !column_exists(&db, "web_users", "last_name")? {
            db.execute("ALTER TABLE web_users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''", [])
                .map_err(|_| AuthError::Internal)?;
        }
        if !column_exists(&db, "web_users", "profile_secret")? {
            db.execute("ALTER TABLE web_users ADD COLUMN profile_secret TEXT", [])
                .map_err(|_| AuthError::Internal)?;
        }
        if !column_exists(&db, "web_users", "preferences")? {
            db.execute("ALTER TABLE web_users ADD COLUMN preferences TEXT", [])
                .map_err(|_| AuthError::Internal)?;
        }
        // Accounts from before the admin panel keep their own notes.
        if !column_exists(&db, "web_users", "personal")? {
            db.execute("ALTER TABLE web_users ADD COLUMN personal TEXT NOT NULL DEFAULT 'allowed'", [])
                .map_err(|_| AuthError::Internal)?;
        }
        let cookie_secure = https_deployment();
        DUMMY_HASH.get_or_init(|| hash_password("not-a-user-password").unwrap_or_default());
        let signups_per_hour = env::var("NOTES_REGISTER_PER_HOUR").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
        Ok(Self { inner: Arc::new(Inner {
            db: Mutex::new(db), cookie_secure, data_dir: data_dir.to_path_buf(),
            signups: Mutex::new(Default::default()), signups_per_hour, registration: Registration::from_env(),
        }) })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, AuthError> {
        self.inner.db.lock().map_err(|_| AuthError::Internal)
    }

    #[cfg(test)]
    pub(crate) fn login_for_test(&self, email: &str, password: &str) -> bool { self.login(email, password).is_ok() }

    #[cfg(test)]
    pub(crate) fn register(&self, email: &str, password: &str) -> Result<(AuthUser, String), AuthError> {
        self.register_named(email, password, "Użytkownik Notes", "", email, None, None)
    }

    pub(crate) fn registration(&self) -> &'static str { self.inner.registration.name() }

    /// `client`: a hash of the caller's IP (see `client_of`); `invite`: the token of the invite link it came with;
    /// `code`: a registration code from the server admin, used up by this account.
    #[allow(clippy::too_many_arguments)]
    fn register_named(&self, email: &str, password: &str, name: &str, last_name: &str, client: &str, invite: Option<&str>, code: Option<&str>) -> Result<(AuthUser, String), AuthError> {
        let code = code.map(str::trim).filter(|c| !c.is_empty());
        match self.inner.registration {
            Registration::Closed => return Err(AuthError::RegistrationClosed),
            // a code is checked (and used up) in the account's own transaction below
            Registration::Invite if code.is_none() && !invite.is_some_and(|t| self.invite_open(t)) => return Err(AuthError::InviteRequired),
            _ => {}
        }
        // before any code is looked at, so guessing codes is held to the signup limit
        self.count_signup(client)?;
        let email = normalize_email(email)?;
        let name = normalize_name(name)?;
        // The last name is encrypted in the browser: the server takes no plaintext one (see update_profile).
        if !last_name.is_empty() { return Err(AuthError::LastNameEncrypted); }
        validate_password(password, true)?;
        let password_hash = hash_password(password)?;
        let id = hex(&notes_sync::random::<16>().map_err(|_| AuthError::Internal)?);
        let now = now_seconds();
        let mut token = Zeroizing::new([0u8; 32]);
        *token = notes_sync::random::<32>().map_err(|_| AuthError::Internal)?;
        let token_text = hex(&token[..]);
        let token_hash = blake3::hash(&token[..]).to_hex().to_string();
        let mut db = self.db()?;
        let tx = db.transaction().map_err(|_| AuthError::Internal)?;
        if let Some(code) = code {
            let used = tx.execute(
                "UPDATE signup_codes SET used_at=?1, used_by=?2 WHERE code_hash=?3 AND used_at IS NULL AND expires_at>?1",
                params![now, id, signup_code_hash(code)],
            ).map_err(|_| AuthError::Internal)?;
            if used != 1 { return Err(AuthError::InvalidSignupCode); }
        }
        // Someone who came with an organization's invite gets no notes of their own until the server admin agrees;
        // a registration code is that agreement.
        let personal = if invite.is_some() && code.is_none() { "off" } else { "allowed" };
        let inserted = tx.execute(
            "INSERT INTO web_users(user_id,email,display_name,last_name,password_hash,created_at,personal) VALUES (?1,?2,?3,'',?4,?5,?6)",
            params![id, email, name, password_hash, now, personal],
        );
        match inserted {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE => return Err(AuthError::EmailTaken),
            Err(_) => return Err(AuthError::Internal),
        }
        // On an invite-only server one link makes at most its max_uses accounts, not one per visit.
        if let (Registration::Invite, None, Some(token)) = (self.inner.registration, code, invite) {
            let found: Option<(String, i64)> = tx.query_row(
                "SELECT invite_id, max_uses FROM vault_invites WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2",
                params![blake3::hash(token.as_bytes()).to_hex().to_string(), now.saturating_mul(1000)], |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional().map_err(|_| AuthError::Internal)?;
            let (invite_id, max_uses) = found.ok_or(AuthError::InviteRequired)?;
            let made: i64 = tx.query_row("SELECT count(*) FROM invite_signups WHERE invite_id=?1", [&invite_id], |r| r.get(0)).map_err(|_| AuthError::Internal)?;
            if made >= max_uses { return Err(AuthError::InviteUsedUp); }
            tx.execute("INSERT INTO invite_signups(invite_id,user_id,created_at) VALUES (?1,?2,?3)", params![invite_id, id, now]).map_err(|_| AuthError::Internal)?;
        }
        tx.execute(
            "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?1,?2,?3,?4)",
            params![token_hash, id, now, now.saturating_add(SESSION_SECONDS)],
        ).map_err(|_| AuthError::Internal)?;
        tx.commit().map_err(|_| AuthError::Internal)?;
        Ok((AuthUser { id, email, name, last_name: String::new(), profile_secret: None, preferences: None, personal: personal.into() }, token_text))
    }

    // An invite that can still be used (the vault tables live in this database too; see vaults.rs).
    fn invite_open(&self, token: &str) -> bool {
        let hash = blake3::hash(token.as_bytes()).to_hex().to_string();
        let now_ms = now_seconds().saturating_mul(1000);
        self.db().ok().and_then(|db| db.query_row(
            "SELECT 1 FROM vault_invites WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2",
            params![hash, now_ms], |_| Ok(()),
        ).optional().ok().flatten()).is_some()
    }

    // At most `signups_per_hour` accounts per client an hour: bots that sign up in bursts are stopped.
    fn count_signup(&self, client: &str) -> Result<(), AuthError> {
        if self.inner.signups_per_hour == 0 { return Ok(()); }
        let now = now_seconds();
        let mut signups = self.inner.signups.lock().map_err(|_| AuthError::Internal)?;
        signups.retain(|_, (start, _)| now < start.saturating_add(SIGNUP_WINDOW_SECONDS));
        let entry = signups.entry(client.to_string()).or_insert((now, 0));
        if entry.1 >= self.inner.signups_per_hour { return Err(AuthError::TooManySignups); }
        entry.1 += 1;
        Ok(())
    }

    // Failed logins are counted per email, whoever sends them: a distributed guesser hits the same cap (docs/API-WEB.md).
    fn login(&self, email: &str, password: &str) -> Result<(AuthUser, String), AuthError> {
        let email = normalize_email(email)?;
        validate_password(password, false)?;
        let now = now_seconds();
        let user = {
            let db = self.db()?;
            db.execute("DELETE FROM web_sessions WHERE expires_at <= ?1", [now]).map_err(|_| AuthError::Internal)?;
            let attempts: Option<(i64, u32)> = db.query_row(
                "SELECT window_start,failures FROM web_login_attempts WHERE email=?1",
                [&email], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(|_| AuthError::Internal)?;
            if attempts.is_some_and(|(start, count)| now < start.saturating_add(LOGIN_WINDOW_SECONDS) && count >= LOGIN_MAX_FAILURES) {
                return Err(AuthError::RateLimited);
            }
            let row: Option<UserRow> = db.query_row(
                "SELECT user_id,password_hash,display_name,last_name,profile_secret,preferences,personal FROM web_users WHERE email=?1",
                [&email], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            ).optional().map_err(|_| AuthError::Internal)?;
            row
        };
        // An unknown email is checked against a hash made once at start-up: the same single verification as a known one.
        let dummy = DUMMY_HASH.get().cloned().ok_or(AuthError::Internal)?;
        let (user_id, hash, name, last_name, profile, prefs, personal) = user.unwrap_or_else(|| (String::new(), dummy, String::new(), String::new(), None, None, String::new()));
        let parsed = PasswordHash::new(&hash).map_err(|_| AuthError::Internal)?;
        let valid = Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok() && !user_id.is_empty();
        if !valid {
            self.record_failure(&email, now)?;
            // The log never names an address: only the account id, or nothing for an unknown email.
            if user_id.is_empty() {
                crate::audit::event("login_failed", &[("known", "no")]);
            } else {
                crate::audit::event("login_failed", &[("user", &user_id)]);
            }
            return Err(AuthError::Unauthorized);
        }
        let mut token = Zeroizing::new([0u8; 32]);
        *token = notes_sync::random::<32>().map_err(|_| AuthError::Internal)?;
        let token_text = hex(&token[..]);
        let token_hash = blake3::hash(&token[..]).to_hex().to_string();
        let db = self.db()?;
        db.execute("DELETE FROM web_login_attempts WHERE email=?1", [&email]).map_err(|_| AuthError::Internal)?;
        db.execute(
            "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?1,?2,?3,?4)",
            params![token_hash, user_id, now, now.saturating_add(SESSION_SECONDS)],
        ).map_err(|_| AuthError::Internal)?;
        Ok((AuthUser { id: user_id, email, name, last_name, profile_secret: stored_json(profile), preferences: stored_json(prefs), personal }, token_text))
    }

    fn record_failure(&self, email: &str, now: i64) -> Result<(), AuthError> {
        let db = self.db()?;
        db.execute(
            "INSERT INTO web_login_attempts(email,window_start,failures) VALUES (?1,?2,1)
             ON CONFLICT(email) DO UPDATE SET
               window_start=CASE WHEN web_login_attempts.window_start + ?3 <= ?2 THEN ?2 ELSE web_login_attempts.window_start END,
               failures=CASE WHEN web_login_attempts.window_start + ?3 <= ?2 THEN 1 ELSE web_login_attempts.failures + 1 END",
            params![email, now, LOGIN_WINDOW_SECONDS],
        ).map_err(|_| AuthError::Internal)?;
        Ok(())
    }

    /// Resolves an opaque session cookie for a browser request or WebSocket upgrade.
    pub fn user_from_headers(&self, headers: &HeaderMap) -> Result<Option<AuthUser>, AuthError> {
        let Some(token) = cookie_value(headers, SESSION_COOKIE) else { return Ok(None); };
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) { return Ok(None); }
        let bytes = decode_hex(&token).ok_or(AuthError::Unauthorized)?;
        let hash = blake3::hash(&bytes).to_hex().to_string();
        let now = now_seconds();
        let db = self.db()?;
        let user = db.query_row(
            "SELECT u.user_id,u.email,u.display_name,u.last_name,u.profile_secret,u.preferences,u.personal FROM web_sessions s JOIN web_users u ON u.user_id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>?2",
            params![hash, now], user_row,
        ).optional().map_err(|_| AuthError::Internal)?;
        Ok(user)
    }

    /// Changes the fields that are given. `profile_secret` and `preferences`: `Some(None)` removes one. A last name may
    /// only be cleared (`""`): the plaintext column is legacy, names now live encrypted in `profile_secret`.
    fn update_profile(&self, user_id: &str, name: Option<&str>, last_name: Option<&str>, profile_secret: Option<Option<Value>>, preferences: Option<Option<Value>>) -> Result<AuthUser, AuthError> {
        if name.is_none() && last_name.is_none() && profile_secret.is_none() && preferences.is_none() { return Err(AuthError::NothingToUpdate); }
        let name = name.map(normalize_name).transpose()?;
        if last_name.is_some_and(|text| !text.is_empty()) { return Err(AuthError::LastNameEncrypted); }
        let secret = profile_secret.map(|value| value.map(envelope_json).transpose()).transpose()?;
        let prefs = preferences.map(|value| value.map(envelope_json).transpose()).transpose()?;
        let db = self.db()?;
        let changed = db
            .execute(
                "UPDATE web_users SET display_name=COALESCE(?1,display_name), last_name=COALESCE(?2,last_name),
                    profile_secret=CASE WHEN ?3 THEN ?4 ELSE profile_secret END,
                    preferences=CASE WHEN ?5 THEN ?6 ELSE preferences END WHERE user_id=?7",
                params![name, last_name.map(|_| ""), secret.is_some(), secret.flatten(), prefs.is_some(), prefs.flatten(), user_id],
            )
            .map_err(|_| AuthError::Internal)?;
        if changed != 1 {
            return Err(AuthError::Unauthorized);
        }
        db.query_row(
            "SELECT user_id,email,display_name,last_name,profile_secret,preferences,personal FROM web_users WHERE user_id=?1",
            [user_id],
            user_row,
        )
        .map_err(|_| AuthError::Internal)
    }

    /// The signed-in user's own account data (GDPR Art. 15/20). Timestamps are milliseconds since the epoch. Never
    /// includes hashes, session tokens, wrapped keys or anything about other users.
    fn export(&self, headers: &HeaderMap) -> Result<Value, AuthError> {
        let user = self.user_from_headers(headers)?.ok_or(AuthError::Unauthorized)?;
        let current = session_hash(headers);
        let now = now_seconds();
        let db = self.db()?;
        let (created_at, email, name, last_name, profile_secret, preferences): (i64, String, String, String, Option<String>, Option<String>) = db.query_row(
            "SELECT created_at,email,display_name,last_name,profile_secret,preferences FROM web_users WHERE user_id=?1",
            [&user.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).map_err(|_| AuthError::Internal)?;
        let sessions = db.prepare("SELECT token_hash,created_at,expires_at FROM web_sessions WHERE user_id=?1 AND expires_at>?2 ORDER BY created_at")
            .and_then(|mut q| q.query_map(params![user.id, now], |r| {
                let hash: String = r.get(0)?;
                Ok(json!({
                    "createdAt": r.get::<_, i64>(1)?.saturating_mul(1000),
                    "expiresAt": r.get::<_, i64>(2)?.saturating_mul(1000),
                    "current": current.as_deref() == Some(hash.as_str()),
                }))
            }).and_then(|rows| rows.collect::<Result<Vec<_>, _>>()))
            .map_err(|_| AuthError::Internal)?;
        let vaults = db.prepare("SELECT v.vault_id,v.name,v.kind,m.role,m.added_at,v.owner_user_id=?1 FROM vault_members m
                                 JOIN vaults v ON v.vault_id=m.vault_id WHERE m.user_id=?1 ORDER BY m.added_at,v.vault_id")
            .and_then(|mut q| q.query_map([&user.id], |r| Ok(json!({
                "vaultId": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "role": r.get::<_, String>(3)?,
                "addedAt": r.get::<_, i64>(4)?,
                "owner": r.get::<_, bool>(5)?,
            }))).and_then(|rows| rows.collect::<Result<Vec<_>, _>>()))
            .map_err(|_| AuthError::Internal)?;
        // Only the invite links this user created; the token itself is never stored, so it is never exported.
        // The caller's encrypted card in each vault they belong to (ciphertext under the vault key).
        let vault_profiles = db.prepare("SELECT vault_id,profile FROM vault_members WHERE user_id=?1 AND profile IS NOT NULL ORDER BY added_at,vault_id")
            .and_then(|mut q| q.query_map([&user.id], |r| Ok(json!({
                "vaultId": r.get::<_, String>(0)?,
                "profile": stored_json(r.get(1)?),
            }))).and_then(|rows| rows.collect::<Result<Vec<_>, _>>()))
            .map_err(|_| AuthError::Internal)?;
        let invites = db.prepare("SELECT vault_id,role,created_at,expires_at,used_at IS NOT NULL FROM vault_invites WHERE created_by=?1 ORDER BY created_at")
            .and_then(|mut q| q.query_map([&user.id], |r| Ok(json!({
                "vaultId": r.get::<_, String>(0)?,
                "role": r.get::<_, String>(1)?,
                "createdAt": r.get::<_, i64>(2)?,
                "expiresAt": r.get::<_, i64>(3)?,
                "used": r.get::<_, bool>(4)?,
            }))).and_then(|rows| rows.collect::<Result<Vec<_>, _>>()))
            .map_err(|_| AuthError::Internal)?;
        let (signing_key, box_key): (bool, bool) = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM user_signing_keys WHERE user_id=?1), EXISTS(SELECT 1 FROM user_box_keys WHERE user_id=?1)",
            [&user.id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| AuthError::Internal)?;
        Ok(json!({
            "exportedAt": now.saturating_mul(1000),
            "account": {
                "userId": user.id,
                "email": email,
                "name": name,
                "lastName": last_name,
                "profileSecret": stored_json(profile_secret),
                "preferences": stored_json(preferences),
                "createdAt": created_at.saturating_mul(1000),
            },
            "sessions": sessions,
            "vaults": vaults,
            "vaultProfiles": vault_profiles,
            "invitesCreated": invites,
            "keys": { "signingKey": signing_key, "boxKey": box_key },
            "note": "Treść notatek jest zaszyfrowana kluczem, którego serwer nie zna; eksport treści jest dostępny w aplikacji.",
        }))
    }

    /// The current password is checked first. Every other session ends, so a stolen session can't outlive the change.
    fn change_password(&self, headers: &HeaderMap, current: &str, password: &str) -> Result<(), AuthError> {
        let user = self.user_from_headers(headers)?.ok_or(AuthError::Unauthorized)?;
        self.check_password(&user.id, current)?;
        validate_password(password, true)?;
        let hash = hash_password(password)?;
        let keep = session_hash(headers).ok_or(AuthError::Unauthorized)?;
        let db = self.db()?;
        db.execute("UPDATE web_users SET password_hash=?1 WHERE user_id=?2", params![hash, user.id]).map_err(|_| AuthError::Internal)?;
        db.execute("DELETE FROM web_sessions WHERE user_id=?1 AND token_hash<>?2", params![user.id, keep]).map_err(|_| AuthError::Internal)?;
        Ok(())
    }

    /// Deletes the signed-in user after checking their password, by the same rules as `notes-node delete-user`.
    /// Outer `Err`: the request failed; inner `Err`: the deletion was refused, with the reason.
    fn delete_account(&self, headers: &HeaderMap, password: &str) -> Result<Result<(), String>, AuthError> {
        let user = self.user_from_headers(headers)?.ok_or(AuthError::Unauthorized)?;
        self.check_password(&user.id, password)?;
        Ok(crate::admin::delete_user(&self.inner.data_dir, &user.id, true).map(|_| ()))
    }

    fn check_password(&self, user_id: &str, password: &str) -> Result<(), AuthError> {
        validate_password(password, false)?;
        let hash: String = self.db()?
            .query_row("SELECT password_hash FROM web_users WHERE user_id=?1", [user_id], |r| r.get(0))
            .map_err(|_| AuthError::Unauthorized)?;
        let parsed = PasswordHash::new(&hash).map_err(|_| AuthError::Internal)?;
        Argon2::default().verify_password(password.as_bytes(), &parsed).map_err(|_| AuthError::WrongPassword)
    }

    /// `off` → `requested`; any other state stays as it is. Returns the state after the call.
    fn request_personal(&self, user_id: &str) -> Result<String, AuthError> {
        let db = self.db()?;
        db.execute("UPDATE web_users SET personal='requested' WHERE user_id=?1 AND personal='off'", [user_id]).map_err(|_| AuthError::Internal)?;
        db.query_row("SELECT personal FROM web_users WHERE user_id=?1", [user_id], |r| r.get(0)).map_err(|_| AuthError::Internal)
    }

    fn logout(&self, headers: &HeaderMap) -> Result<(), AuthError> {
        if let Some(hash) = session_hash(headers) {
            self.db()?.execute("DELETE FROM web_sessions WHERE token_hash=?1", [&hash]).map_err(|_| AuthError::Internal)?;
        }
        Ok(())
    }

    fn cookie(&self, token: &str) -> String {
        format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}{}", if self.inner.cookie_secure { "; Secure" } else { "" })
    }

    fn expired_cookie(&self) -> String {
        format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}", if self.inner.cookie_secure { "; Secure" } else { "" })
    }
}

pub fn routes(service: Arc<AuthService>) -> Router {
    Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me).patch(update_profile).delete(delete_account))
        .route("/api/auth/export", get(export))
        .route("/api/auth/password", post(change_password))
        .route("/api/me/personal-request", post(request_personal))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(service)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials { email: String, password: String, name: Option<String>, last_name: Option<String>, invite: Option<String>, code: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileInput {
    name: Option<String>,
    last_name: Option<String>,
    #[serde(default, deserialize_with = "present_or_null")]
    profile_secret: Option<Option<Value>>,
    #[serde(default, deserialize_with = "present_or_null")]
    preferences: Option<Option<Value>>,
}

/// Tells an absent `profileSecret` (`None`) from `null` (`Some(None)`, which removes it).
fn present_or_null<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Option<Option<Value>>, D::Error> {
    Option::<Value>::deserialize(de).map(Some)
}
#[derive(Deserialize)]
struct PasswordInput { current: String, password: String }
#[derive(Deserialize)]
struct DeleteInput { password: String }
#[derive(Serialize)]
struct UserReply { user: AuthUser }
#[derive(Serialize)]
struct MeReply {
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<AuthUser>,
    /// For the sign-in page of a signed-out visitor: `open`, `invite` or `closed` (see `Registration`).
    #[serde(skip_serializing_if = "Option::is_none")]
    registration: Option<&'static str>,
}
#[derive(Serialize)]
struct ErrorReply { error: &'static str }

async fn register(State(auth): State<Arc<AuthService>>, headers: HeaderMap, axum::Json(input): axum::Json<Credentials>) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    let auth_for_work = auth.clone();
    let client = client_of(&headers);
    let result = tokio::task::spawn_blocking(move || auth_for_work.register_named(&input.email, &input.password, input.name.as_deref().unwrap_or(""), input.last_name.as_deref().unwrap_or(""), &client, input.invite.as_deref(), input.code.as_deref())).await;
    match result {
        Ok(Ok((user, token))) => { crate::audit::event("register", &[("user", &user.id)]); auth_response(StatusCode::CREATED, UserReply { user }, auth.cookie(&token)) }
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn login(State(auth): State<Arc<AuthService>>, headers: HeaderMap, axum::Json(input): axum::Json<Credentials>) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    let auth_for_work = auth.clone();
    let result = tokio::task::spawn_blocking(move || auth_for_work.login(&input.email, &input.password)).await;
    match result {
        Ok(Ok((user, token))) => { crate::audit::event("login", &[("user", &user.id)]); auth_response(StatusCode::OK, UserReply { user }, auth.cookie(&token)) }
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn logout(State(auth): State<Arc<AuthService>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    let auth_for_work = auth.clone();
    let h = headers.clone();
    match tokio::task::spawn_blocking(move || auth_for_work.logout(&h)).await {
        Ok(Ok(())) => auth_response(StatusCode::OK, MeReply { authenticated: false, user: None, registration: None }, auth.expired_cookie()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn me(State(auth): State<Arc<AuthService>>, headers: HeaderMap) -> Response {
    let auth_for_work = auth.clone();
    match tokio::task::spawn_blocking(move || auth_for_work.user_from_headers(&headers)).await {
        Ok(Ok(Some(user))) => no_store(axum::Json(MeReply { authenticated: true, user: Some(user), registration: None }).into_response()),
        Ok(Ok(None)) => no_store(axum::Json(MeReply { authenticated: false, user: None, registration: Some(auth.registration()) }).into_response()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn update_profile(State(auth): State<Arc<AuthService>>, headers: HeaderMap, axum::Json(input): axum::Json<ProfileInput>) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    let auth_for_work = auth.clone();
    let result = tokio::task::spawn_blocking(move || {
        let user = auth_for_work.user_from_headers(&headers)?.ok_or(AuthError::Unauthorized)?;
        auth_for_work.update_profile(&user.id, input.name.as_deref(), input.last_name.as_deref(), input.profile_secret, input.preferences)
    }).await;
    match result {
        Ok(Ok(user)) => no_store(axum::Json(UserReply { user }).into_response()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn request_personal(State(auth): State<Arc<AuthService>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    let result = tokio::task::spawn_blocking(move || {
        let user = auth.user_from_headers(&headers)?.ok_or(AuthError::Unauthorized)?;
        let state = auth.request_personal(&user.id)?;
        Ok::<_, AuthError>((user.id, state))
    }).await;
    match result {
        Ok(Ok((user, personal))) => { crate::audit::event("personal_requested", &[("user", &user)]); no_store(axum::Json(json!({ "personal": personal })).into_response()) }
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

/// Whether the account may keep its own notes (`web_users.personal = 'allowed'`). False for an unknown account.
pub(crate) fn personal_allowed(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT personal='allowed' FROM web_users WHERE user_id=?1", [user_id], |r| r.get(0)).optional().map(|v| v.unwrap_or(false))
}

async fn export(State(auth): State<Arc<AuthService>>, headers: HeaderMap) -> Response {
    match tokio::task::spawn_blocking(move || auth.export(&headers)).await {
        Ok(Ok(body)) => no_store(axum::Json(body).into_response()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn change_password(State(auth): State<Arc<AuthService>>, headers: HeaderMap, axum::Json(input): axum::Json<PasswordInput>) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    match tokio::task::spawn_blocking(move || auth.change_password(&headers, &input.current, &input.password)).await {
        Ok(Ok(())) => { crate::audit::event("password_changed", &[]); no_store(StatusCode::NO_CONTENT.into_response()) }
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

async fn delete_account(State(auth): State<Arc<AuthService>>, headers: HeaderMap, axum::Json(input): axum::Json<DeleteInput>) -> Response {
    if !same_origin(&headers) { return AuthError::Forbidden.into_response(); }
    let auth_for_work = auth.clone();
    match tokio::task::spawn_blocking(move || auth_for_work.delete_account(&headers, &input.password)).await {
        Ok(Ok(Ok(()))) => { crate::audit::event("account_deleted", &[("by", "self")]); auth_response(StatusCode::OK, MeReply { authenticated: false, user: None, registration: None }, auth.expired_cookie()) }
        Ok(Ok(Err(refused))) => no_store((StatusCode::CONFLICT, axum::Json(serde_json::json!({ "error": refused }))).into_response()),
        Ok(Err(e)) => e.into_response(),
        Err(_) => AuthError::Internal.into_response(),
    }
}

fn auth_response<T: Serialize>(status: StatusCode, body: T, cookie: String) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) { response.headers_mut().insert(SET_COOKIE, value); }
    no_store(response)
}

pub(crate) const FOREIGN_REQUEST: &str = "Żądanie spoza tej witryny zostało odrzucone.";

/// Why `authorize` turned a request away.
pub(crate) enum Refused { Origin, Session, Internal }

/// The check in front of every vault and file route: same origin for mutations, then a live session.
pub(crate) async fn authorize(auth: Arc<AuthService>, headers: HeaderMap, mutating: bool) -> Result<AuthUser, Refused> {
    if mutating && !same_origin(&headers) {
        return Err(Refused::Origin);
    }
    match tokio::task::spawn_blocking(move || auth.user_from_headers(&headers)).await {
        Ok(Ok(Some(user))) => Ok(user),
        Ok(Ok(None)) => Err(Refused::Session),
        _ => Err(Refused::Internal),
    }
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

#[derive(Debug, Clone, Copy)]
pub enum AuthError { Invalid, InvalidName, LastNameEncrypted, InvalidProfileSecret, NothingToUpdate, WeakPassword, WrongPassword, EmailTaken, Unauthorized, RateLimited, TooManySignups, RegistrationClosed, InviteRequired, InviteUsedUp, InvalidSignupCode, Forbidden, Internal }

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "Nieprawidłowy email lub hasło."),
            Self::InvalidName => (StatusCode::BAD_REQUEST, "Podaj imię lub nazwę wyświetlaną (do 64 znaków)."),
            Self::LastNameEncrypted => (StatusCode::BAD_REQUEST, "Nazwisko jest teraz szyfrowane w przeglądarce. Odśwież stronę i spróbuj ponownie."),
            Self::InvalidProfileSecret => (StatusCode::BAD_REQUEST, "Nieprawidłowe zaszyfrowane dane profilu."),
            Self::NothingToUpdate => (StatusCode::BAD_REQUEST, "Podaj imię lub nazwisko do zmiany."),
            Self::WeakPassword => (StatusCode::BAD_REQUEST, "Hasło musi mieć co najmniej 8 znaków, wielką literę i cyfrę."),
            Self::WrongPassword => (StatusCode::FORBIDDEN, "Hasło jest nieprawidłowe."),
            Self::EmailTaken => (StatusCode::CONFLICT, "Konto z tym adresem email już istnieje."),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Nieprawidłowy email lub hasło."),
            Self::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "Zbyt wiele prób logowania. Spróbuj ponownie za kilka minut."),
            Self::TooManySignups => (StatusCode::TOO_MANY_REQUESTS, "Zbyt wiele nowych kont z tej sieci. Spróbuj ponownie za godzinę."),
            Self::RegistrationClosed => (StatusCode::FORBIDDEN, "Rejestracja nowych kont jest wyłączona."),
            Self::InviteRequired => (StatusCode::FORBIDDEN, "Konto można założyć z linku zaproszenia do organizacji albo z kodem od administratora serwera."),
            Self::InviteUsedUp => (StatusCode::FORBIDDEN, "Z tego linku zaproszenia założono już tyle kont, na ile pozwala. Poproś o nowy link albo o kod od administratora serwera."),
            Self::InvalidSignupCode => (StatusCode::FORBIDDEN, "Ten kod rejestracyjny jest nieprawidłowy, wygasł albo został już użyty. Poproś administratora o nowy."),
            Self::Forbidden => (StatusCode::FORBIDDEN, "Żądanie spoza tej witryny zostało odrzucone."),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "Nie udało się obsłużyć żądania."),
        };
        let mut response = (status, axum::Json(ErrorReply { error: message })).into_response();
        response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
        response
    }
}

fn normalize_email(email: &str) -> Result<String, AuthError> {
    let email = email.trim().to_ascii_lowercase();
    if email.len() > 254 || email.bytes().any(|b| b <= 0x20 || b >= 0x7f) { return Err(AuthError::Invalid); }
    let Some((local, domain)) = email.split_once('@') else { return Err(AuthError::Invalid); };
    if local.is_empty() || domain.len() < 3 || domain.starts_with('.') || domain.ends_with('.') || !domain.contains('.') || domain.contains('@') {
        return Err(AuthError::Invalid);
    }
    Ok(email)
}

/// A `web_users` login row: id, password hash, display name, legacy last name, profile secret, preferences, personal.
type UserRow = (String, String, String, String, Option<String>, Option<String>, String);

/// The display name: required, 1–64 characters. A single word or a pseudonym is fine.
fn normalize_name(name: &str) -> Result<String, AuthError> {
    clean_name_text(name).filter(|text| !text.is_empty()).ok_or(AuthError::InvalidName)
}

/// Checks a client's `notes-key-v1` envelope (profile secret or preferences) with the vault-key validator and returns it as compact JSON.
/// The validator caps the ciphertext at 4 KiB, which bounds the preferences blob too.
fn envelope_json(value: Value) -> Result<String, AuthError> {
    let envelope: Envelope = serde_json::from_value(value).map_err(|_| AuthError::InvalidProfileSecret)?;
    if envelope.key_epoch.is_some() {
        return Err(AuthError::InvalidProfileSecret);
    }
    validate_wrapped_key(&envelope).map_err(|_| AuthError::InvalidProfileSecret)?;
    serde_json::to_string(&envelope).map_err(|_| AuthError::Internal)
}

/// A `web_users` row as `AuthUser`: id, email, display name, legacy last name, profile secret, preferences, personal.
fn user_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthUser> {
    Ok(AuthUser {
        id: row.get(0)?,
        email: row.get(1)?,
        name: row.get(2)?,
        last_name: row.get(3)?,
        profile_secret: stored_json(row.get(4)?),
        preferences: stored_json(row.get(5)?),
        personal: row.get(6)?,
    })
}

/// A JSON column written by this module. Unparsable text (never written by us) reads as absent.
fn stored_json(text: Option<String>) -> Option<Value> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

/// Trims and collapses inner whitespace, then checks the characters and length. `Some("")` for blank input.
/// Existing names stored before these rules are never passed through here: only new input is checked.
fn clean_name_text(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Some(text);
    }
    let allowed = text.chars().all(|c| c.is_alphanumeric() || is_mark(c) || matches!(c, ' ' | '-' | '\'' | '\u{2019}' | '.' | '_'));
    (allowed && text.chars().count() <= 64 && text.chars().any(char::is_alphanumeric)).then_some(text)
}

/// Combining marks, which `char::is_alphanumeric` rejects. std has no general-category test.
// shortcut: approximate block ranges (Indic, Thai, Arabic, Hebrew, combining diacritics), not the Unicode Mn/Mc tables; upgrade with a Unicode category crate if a script is refused.
fn is_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05C7 | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670
        | 0x0900..=0x0DFF | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E
        | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0x3099..=0x309A | 0xFE20..=0xFE2F)
}

fn column_exists(db: &Connection, table: &str, column: &str) -> Result<bool, AuthError> {
    let mut stmt = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| AuthError::Internal)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| AuthError::Internal)?;
    for name in rows {
        if name.map_err(|_| AuthError::Internal)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the node is served over HTTPS (the default; `AUTH_COOKIE_SECURE=false` only for local HTTP development).
pub(crate) fn https_deployment() -> bool {
    env::var("AUTH_COOKIE_SECURE").map(|v| !matches!(v.as_str(), "0" | "false" | "no")).unwrap_or(true)
}

/// An Argon2 hash with a fresh salt, as stored in `web_users.password_hash`.
pub(crate) fn hash_password(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::encode_b64(&notes_sync::random::<16>().map_err(|_| AuthError::Internal)?).map_err(|_| AuthError::Internal)?;
    Ok(Argon2::default().hash_password(password.as_bytes(), &salt).map_err(|_| AuthError::Internal)?.to_string())
}

/// Who is calling, for the signup limit: a short keyed hash of the client address. `http::trust_forwarded` has already
/// made the forwarded headers honest (they are believed only from a trusted proxy), so this reads them as they are.
/// Only the hash is kept, never the address.
pub(crate) fn client_of(headers: &HeaderMap) -> String {
    let ip = headers.get("cf-connecting-ip").or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).map(str::trim).unwrap_or("direct");
    blake3::keyed_hash(client_secret(), ip.as_bytes()).to_hex()[..16].to_string()
}

/// The key for `client_of`, drawn once per process and never stored. Without it an IPv4 address cannot be recovered
/// from its hash, and hashes from before a restart cannot be linked to new ones. Pseudonymous for the limits, not anonymous.
fn client_secret() -> &'static [u8; 32] {
    static SECRET: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
    SECRET.get_or_init(|| notes_sync::random::<32>().expect("OS randomness is unavailable"))
}

/// The stored hash of the request's session token, if it carries a well-formed one.
fn session_hash(headers: &HeaderMap) -> Option<String> {
    let token = cookie_value(headers, SESSION_COOKIE).filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))?;
    Some(blake3::hash(&decode_hex(&token)?).to_hex().to_string())
}

fn validate_password(password: &str, creating: bool) -> Result<(), AuthError> {
    if password.len() > 1024 || password.is_empty() { return Err(AuthError::Invalid); }
    if creating && (password.chars().count() < 8 || !password.chars().any(char::is_uppercase) || !password.chars().any(|c| c.is_ascii_digit())) {
        return Err(AuthError::WeakPassword);
    }
    Ok(())
}

pub(crate) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie = headers.get(COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

/// The request's origin matches its host. Only `X-Forwarded-Host`/`-Proto` from a trusted proxy count (`http::trust_forwarded`).
/// A request without `Origin` (a non-browser client) is accepted, as before; SameSite=Lax on the session cookie covers browsers.
pub(crate) fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else { return true; };
    let host = headers.get("x-forwarded-host").or_else(|| headers.get("host")).and_then(|v| v.to_str().ok());
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("http");
    if let Some(host) = host { origin == format!("{proto}://{host}") || origin == format!("https://{host}") && proto == "https" } else { false }
}

pub(crate) fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(i64::MAX)
}

pub(crate) fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) { return None; }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i+2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;

    fn test_auth() -> (AuthService, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthService::open(dir.path()).unwrap();
        (auth, dir)
    }

    #[test]
    fn register_cookie_me_logout_and_duplicate_email() {
        let (auth, _dir) = test_auth();
        let (user, token) = auth.register("Me@example.com", "Long test password1").unwrap();
        assert_eq!(user.email, "me@example.com");
        assert_eq!(user.name, "Użytkownik Notes");
        assert!(auth.register("me@example.com", "Another long password2").is_err());
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(&format!("{SESSION_COOKIE}={token}")).unwrap());
        assert_eq!(auth.user_from_headers(&headers).unwrap(), Some(user));
        auth.logout(&headers).unwrap();
        assert_eq!(auth.user_from_headers(&headers).unwrap(), None);
    }

    fn session(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(&format!("{SESSION_COOKIE}={token}")).unwrap());
        headers
    }

    #[test]
    fn wrong_passwords_lock_the_email_whatever_the_client() {
        let (auth, _dir) = test_auth();
        auth.register("me@example.com", "Long test password1").unwrap();
        // the same email from ten different clients is still one email: the eleventh try is refused (429), even right
        for _ in 0..LOGIN_MAX_FAILURES { let _ = auth.login("me@example.com", "wrong one"); }
        assert!(matches!(auth.login("me@example.com", "Long test password1"), Err(AuthError::RateLimited)));
    }

    #[test]
    fn signups_are_limited_per_client_and_registration_can_need_an_invite() {
        let (auth, dir) = test_auth();
        let limit = auth.inner.signups_per_hour;
        for i in 0..limit { auth.register_named(&format!("u{i}@example.com"), "Long test password1", "Jan Kowalski", "", "bot", None, None).unwrap(); }
        assert!(matches!(auth.register_named("one@example.com", "Long test password1", "Jan Kowalski", "", "bot", None, None), Err(AuthError::TooManySignups)));
        assert!(auth.register_named("two@example.com", "Long test password1", "Jan Kowalski", "", "someone", None, None).is_ok());

        crate::vaults::VaultService::open(dir.path(), Arc::new(crate::vaults::VaultLocks::default())).unwrap();
        let invite_only = AuthService { inner: Arc::new(Inner { registration: Registration::Invite, ..Inner::clone_for_test(&auth.inner) }) };
        assert!(matches!(invite_only.register_named("x@example.com", "Long test password1", "Jan Kowalski", "", "c", None, None), Err(AuthError::InviteRequired)));
        assert!(matches!(invite_only.register_named("x@example.com", "Long test password1", "Jan Kowalski", "", "c", Some("nope"), None), Err(AuthError::InviteRequired)));
        let token = "a".repeat(64);
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        db.execute("INSERT INTO vaults(vault_id,name,kind,owner_user_id,created_at) SELECT 'v-1','V','organizacja',user_id,0 FROM web_users LIMIT 1", []).unwrap();
        db.execute("INSERT INTO vault_invites(invite_id,vault_id,token_hash,role,created_by,created_at,expires_at) VALUES ('i','v-1',?1,'editor','x',0,?2)",
            params![blake3::hash(token.as_bytes()).to_hex().to_string(), i64::MAX]).unwrap();
        assert!(invite_only.register_named("x@example.com", "Long test password1", "Jan Kowalski", "", "c", Some(&token), None).is_ok());
        // the link admits one person (max_uses 1): a second account from it is refused, a failed one used nothing
        assert!(matches!(invite_only.register_named("y@example.com", "Long test password1", "Jan Kowalski", "", "c", Some(&token), None), Err(AuthError::InviteUsedUp)));
        db.execute("UPDATE vault_invites SET max_uses=2 WHERE invite_id='i'", []).unwrap();
        assert!(matches!(invite_only.register_named("x@example.com", "Long test password1", "Jan Kowalski", "", "c", Some(&token), None), Err(AuthError::EmailTaken)));
        assert!(invite_only.register_named("y@example.com", "Long test password1", "Jan Kowalski", "", "c", Some(&token), None).is_ok());
        assert!(matches!(invite_only.register_named("z@example.com", "Long test password1", "Jan Kowalski", "", "c", Some(&token), None), Err(AuthError::InviteUsedUp)));
    }

    #[test]
    fn the_default_registration_needs_an_invite_or_a_code() {
        assert_eq!(Registration::parse(None), Registration::Invite);
        assert_eq!(Registration::parse(Some("otwarta")), Registration::Invite);
        assert_eq!(Registration::parse(Some("open")), Registration::Open);
        assert_eq!(Registration::parse(Some("closed")), Registration::Closed);
    }

    #[test]
    fn a_registration_code_opens_one_account_with_its_own_notes() {
        let (auth, dir) = test_auth();
        let invite_only = AuthService { inner: Arc::new(Inner { registration: Registration::Invite, ..Inner::clone_for_test(&auth.inner) }) };
        let (shown, hash) = new_signup_code().unwrap();
        assert_eq!(shown.len(), 14);
        assert!(shown.chars().all(|c| c == '-' || CODE_ALPHABET.contains(&(c as u8))));
        // case, spaces and dashes are ignored when it is typed
        assert_eq!(signup_code_hash(&format!(" {} ", shown.to_lowercase().replace('-', " "))), hash);
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        let add = |id: &str, hash: &str, expires: i64| {
            db.execute("INSERT INTO signup_codes(code_id,code_hash,created_at,expires_at) VALUES (?1,?2,0,?3)", params![id, hash, expires]).unwrap();
        };
        add("c1", &hash, i64::MAX);
        let (old_shown, old) = new_signup_code().unwrap();
        add("c2", &old, 1);

        let reg = |email: &str, code: Option<&str>| invite_only.register_named(email, "Long test password1", "Jan", "", "c", None, code);
        assert!(matches!(reg("a@example.com", Some("ZZZZ-ZZZZ-ZZZZ")), Err(AuthError::InvalidSignupCode)));
        assert!(matches!(reg("a@example.com", Some("   ")), Err(AuthError::InviteRequired)));
        assert!(matches!(reg("a@example.com", Some(&old_shown)), Err(AuthError::InvalidSignupCode)), "expired");
        assert!(matches!(reg("a@example.com", Some(&hash)), Err(AuthError::InvalidSignupCode)), "the stored hash is not a code");
        let (user, _) = reg("a@example.com", Some(&shown)).unwrap();
        assert_eq!(user.personal, "allowed");
        let used_by: String = db.query_row("SELECT used_by FROM signup_codes WHERE code_id='c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(used_by, user.id);
        // used once only, and a failed account (taken email) does not use it up
        assert!(matches!(reg("b@example.com", Some(&shown)), Err(AuthError::InvalidSignupCode)));
        let (fresh, fresh_hash) = new_signup_code().unwrap();
        add("c3", &fresh_hash, i64::MAX);
        assert!(matches!(reg("a@example.com", Some(&fresh)), Err(AuthError::EmailTaken)));
        let unused: Option<i64> = db.query_row("SELECT used_at FROM signup_codes WHERE code_id='c3'", [], |r| r.get(0)).unwrap();
        assert_eq!(unused, None);
        assert!(reg("c@example.com", Some(&fresh)).is_ok());
    }

    #[test]
    fn password_change_checks_the_old_one_and_ends_the_other_sessions() {
        let (auth, _dir) = test_auth();
        let (_, here) = auth.register("me@example.com", "Long test password1").unwrap();
        let (_, other) = auth.login("me@example.com", "Long test password1").unwrap();
        assert!(matches!(auth.change_password(&session(&here), "wrong one", "New password 2"), Err(AuthError::WrongPassword)));
        assert!(matches!(auth.change_password(&session(&here), "Long test password1", "weak"), Err(AuthError::WeakPassword)));
        auth.change_password(&session(&here), "Long test password1", "New password 2").unwrap();
        assert!(auth.user_from_headers(&session(&here)).unwrap().is_some());
        assert!(auth.user_from_headers(&session(&other)).unwrap().is_none());
        assert!(auth.login("me@example.com", "Long test password1").is_err());
        assert!(auth.login("me@example.com", "New password 2").is_ok());
    }

    #[test]
    fn deleting_ones_own_account_needs_the_password() {
        let (auth, dir) = test_auth();
        crate::vaults::VaultService::open(dir.path(), Arc::new(crate::vaults::VaultLocks::default())).unwrap();
        let (_, token) = auth.register("me@example.com", "Long test password1").unwrap();
        assert!(matches!(auth.delete_account(&session(&token), "wrong one"), Err(AuthError::WrongPassword)));
        assert_eq!(auth.delete_account(&session(&token), "Long test password1").unwrap(), Ok(()));
        assert!(auth.user_from_headers(&session(&token)).unwrap().is_none());
        assert!(auth.login("me@example.com", "Long test password1").is_err());
    }

    #[test]
    fn account_name_is_saved_changed_and_added_to_an_old_database() {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE web_users (
                user_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        drop(db);

        let auth = AuthService::open(dir.path()).unwrap();
        let (user, _) = auth
            .register_named("anna@example.test", "Long test password1", "Anna", "", "test", None, None)
            .unwrap();
        assert_eq!((user.name.as_str(), user.last_name.as_str()), ("Anna", ""));
        assert_eq!(auth.update_profile(&user.id, Some("Anna Maria"), None, None, None).unwrap().name, "Anna Maria");
        assert!(matches!(auth.update_profile(&user.id, Some("  "), None, None, None), Err(AuthError::InvalidName)));
    }

    fn envelope(seed: u8) -> Value {
        json!({
            "schema": "notes-key-v1",
            "nonce": BASE64.encode([seed; 12]),
            "ciphertext": BASE64.encode([seed; 48]),
        })
    }

    #[test]
    fn plaintext_last_name_is_refused_and_only_clearing_the_legacy_column_is_allowed() {
        let (auth, dir) = test_auth();
        let (user, _) = auth.register_named("ola@example.test", "Long test password1", "Olena", "", "test", None, None).unwrap();
        assert_eq!(user.last_name, "");
        assert!(matches!(auth.register_named("ola2@example.test", "Long test password1", "Olena", "Kowalska", "test", None, None), Err(AuthError::LastNameEncrypted)));
        assert!(matches!(auth.update_profile(&user.id, None, Some("Ковальчук"), None, None), Err(AuthError::LastNameEncrypted)));
        assert!(matches!(auth.update_profile(&user.id, None, None, None, None), Err(AuthError::NothingToUpdate)));
        // a legacy plaintext value from before this rule is cleared by "" and nothing else
        Connection::open(dir.path().join("auth.db")).unwrap()
            .execute("UPDATE web_users SET last_name='Nowak' WHERE user_id=?1", [&user.id]).unwrap();
        assert_eq!(auth.user_from_headers(&session(&auth.login("ola@example.test", "Long test password1").unwrap().1)).unwrap().unwrap().last_name, "Nowak");
        assert_eq!(auth.update_profile(&user.id, None, Some(""), None, None).unwrap().last_name, "");
    }

    #[test]
    fn profile_secret_round_trips_through_me_and_can_be_replaced_or_removed() {
        let (auth, _dir) = test_auth();
        let (user, token) = auth.register("me@example.test", "Long test password1").unwrap();
        assert_eq!(user.profile_secret, None);
        let saved = auth.update_profile(&user.id, None, None, Some(Some(envelope(1))), None).unwrap();
        assert_eq!(saved.profile_secret, Some(envelope(1)));
        assert_eq!(auth.user_from_headers(&session(&token)).unwrap().unwrap().profile_secret, Some(envelope(1)));
        let (_, other) = auth.login("me@example.test", "Long test password1").unwrap();
        assert_eq!(auth.user_from_headers(&session(&other)).unwrap().unwrap().profile_secret, Some(envelope(1)));
        // a name change leaves the secret alone; a newer envelope replaces it
        assert_eq!(auth.update_profile(&user.id, Some("Ola"), None, None, None).unwrap().profile_secret, Some(envelope(1)));
        assert_eq!(auth.update_profile(&user.id, None, None, Some(Some(envelope(2))), None).unwrap().profile_secret, Some(envelope(2)));
        assert_eq!(auth.update_profile(&user.id, None, None, Some(None), None).unwrap().profile_secret, None);
        assert_eq!(auth.user_from_headers(&session(&token)).unwrap().unwrap().profile_secret, None);
    }

    #[test]
    fn invalid_profile_secrets_are_rejected_and_nothing_is_stored() {
        let (auth, _dir) = test_auth();
        let (user, _) = auth.register("me@example.test", "Long test password1").unwrap();
        let mut wrong_schema = envelope(1);
        wrong_schema["schema"] = json!("notes-profile-v1");
        let mut with_epoch = envelope(1);
        with_epoch["keyEpoch"] = json!(1);
        let mut short_nonce = envelope(1);
        short_nonce["nonce"] = json!(BASE64.encode([1u8; 8]));
        let mut huge = envelope(1);
        huge["ciphertext"] = json!(BASE64.encode(vec![1u8; 4097]));
        for bad in [wrong_schema, with_epoch, short_nonce, huge, json!("text"), json!({})] {
            assert!(matches!(auth.update_profile(&user.id, None, None, Some(Some(bad)), None), Err(AuthError::InvalidProfileSecret)));
        }
        assert_eq!(auth.update_profile(&user.id, Some("Ola"), None, None, None).unwrap().profile_secret, None);
    }

    #[test]
    fn preferences_round_trip_are_exported_removed_and_size_limited() {
        let (auth, dir) = test_auth();
        // the export reads the vault tables too, so they must exist
        crate::vaults::VaultService::open(dir.path(), Arc::new(crate::vaults::VaultLocks::default())).unwrap();
        let (user, token) = auth.register("me@example.test", "Long test password1").unwrap();
        assert_eq!(user.preferences, None);
        let saved = auth.update_profile(&user.id, None, None, None, Some(Some(envelope(3)))).unwrap();
        assert_eq!(saved.preferences, Some(envelope(3)));
        assert_eq!(auth.user_from_headers(&session(&token)).unwrap().unwrap().preferences, Some(envelope(3)));
        // a name change or a profile secret leaves the preferences alone
        assert_eq!(auth.update_profile(&user.id, Some("Ola"), None, Some(Some(envelope(1))), None).unwrap().preferences, Some(envelope(3)));
        assert_eq!(auth.export(&session(&token)).unwrap()["account"]["preferences"], json!(envelope(3)));
        let (_, other) = auth.login("me@example.test", "Long test password1").unwrap();
        assert_eq!(auth.user_from_headers(&session(&other)).unwrap().unwrap().preferences, Some(envelope(3)));
        assert_eq!(auth.update_profile(&user.id, None, None, None, Some(None)).unwrap().preferences, None);
        assert_eq!(auth.export(&session(&token)).unwrap()["account"]["preferences"], Value::Null);
        // over the 4 KiB ciphertext cap, a wrong schema or a plaintext object is refused and nothing is stored
        let mut huge = envelope(1);
        huge["ciphertext"] = json!(BASE64.encode(vec![1u8; 4097]));
        let mut wrong_schema = envelope(1);
        wrong_schema["schema"] = json!("notes-profile-v1");
        for bad in [huge, wrong_schema, json!({ "theme": "light" })] {
            assert!(matches!(auth.update_profile(&user.id, None, None, None, Some(Some(bad))), Err(AuthError::InvalidProfileSecret)));
        }
        assert_eq!(auth.user_from_headers(&session(&token)).unwrap().unwrap().preferences, None);
        let absent: ProfileInput = serde_json::from_value(json!({ "name": "Ola" })).unwrap();
        assert!(absent.preferences.is_none());
        let null: ProfileInput = serde_json::from_value(json!({ "preferences": null })).unwrap();
        assert_eq!(null.preferences, Some(None));
    }

    #[test]
    fn the_profile_secret_field_distinguishes_absent_from_null() {
        let absent: ProfileInput = serde_json::from_value(json!({ "name": "Ola" })).unwrap();
        assert!(absent.profile_secret.is_none());
        let null: ProfileInput = serde_json::from_value(json!({ "profileSecret": null })).unwrap();
        assert_eq!(null.profile_secret, Some(None));
    }

    #[test]
    fn display_name_rules_allow_pseudonyms_and_other_scripts_but_not_markup() {
        for ok in ["Jan", "Kot_42", "Łucja", "Олена", "Γιώργος", "Anna-Maria O'Neil", "Jean\u{2019}s", "J.", "1", "संजय", "Jan   Kowalski"] {
            assert!(normalize_name(ok).is_ok(), "{ok}");
        }
        assert_eq!(normalize_name("  Jan   Kowalski ").unwrap(), "Jan Kowalski");
        assert!(normalize_name(&"a".repeat(64)).is_ok());
        let too_long = "a".repeat(65);
        for bad in ["", "   ", "-", too_long.as_str(), "<b>x", "a&b", "a\"b", "a/b", "a\\b", "jan@example", "tab\u{7}x", "x\u{0}"] {
            assert!(matches!(normalize_name(bad), Err(AuthError::InvalidName)), "{bad:?}");
        }
    }

    #[test]
    fn an_old_database_keeps_its_rows_and_names_and_the_migration_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        // The shape before `last_name`.
        db.execute_batch(
            "CREATE TABLE web_users (
                user_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL DEFAULT 'Użytkownik',
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        db.execute(
            "INSERT INTO web_users(user_id,email,display_name,password_hash,created_at) VALUES ('old-1','old@example.test','Jan','x',0)",
            [],
        )
        .unwrap();
        drop(db);

        for _ in 0..2 {
            AuthService::open(dir.path()).unwrap();
        }
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        let row: (String, String) = db
            .query_row("SELECT display_name,last_name FROM web_users WHERE user_id='old-1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(row, ("Jan".to_string(), String::new()));
    }

    #[test]
    fn export_has_no_secrets_and_no_other_users_data() {
        let (auth, dir) = test_auth();
        crate::vaults::VaultService::open(dir.path(), Arc::new(crate::vaults::VaultLocks::default())).unwrap();
        let (me, token) = auth.register_named("me@example.test", "Long test password1", "Jan", "", "test", None, None).unwrap();
        let (other, _) = auth.register_named("bob@example.test", "Long test password1", "Bob", "", "test", None, None).unwrap();
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        // a legacy plaintext last name and an encrypted profile, as they can be stored
        db.execute("UPDATE web_users SET last_name='Kowalski', profile_secret=?2 WHERE user_id=?1", params![me.id, envelope(3).to_string()]).unwrap();
        db.execute("INSERT INTO vaults(vault_id,name,kind,owner_user_id,created_at) VALUES ('v-2','Inny','organizacja',?1,0)", [&other.id]).unwrap();
        db.execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at,profile) VALUES ('v-2',?1,'owner','WRAPPED-OTHER-VAULT',0,?2)",
            params![other.id, json!({"schema":"notes-profile-v1","keyEpoch":1,"nonce":"x","ciphertext":"y"}).to_string()]).unwrap();
        db.execute("INSERT INTO vaults(vault_id,name,kind,owner_user_id,created_at) VALUES ('v-1','Zespół','organizacja',?1,0)", [&me.id]).unwrap();
        db.execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at,profile) VALUES ('v-1',?1,'owner','WRAPPED-SECRET',0,?2)",
            params![me.id, json!({"schema":"notes-profile-v1","keyEpoch":1,"nonce":"n","ciphertext":"c"}).to_string()]).unwrap();
        db.execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES ('v-1',?1,'editor','WRAPPED-OTHER',0)", [&other.id]).unwrap();
        db.execute("INSERT INTO vault_invites(invite_id,vault_id,token_hash,role,created_by,created_at,expires_at) VALUES ('i-1','v-1','INVITE-HASH-SECRET','viewer',?1,0,0)", [&me.id]).unwrap();
        let password_hash: String = db.query_row("SELECT password_hash FROM web_users WHERE user_id=?1", [&me.id], |r| r.get(0)).unwrap();
        let session_hash: String = db.query_row("SELECT token_hash FROM web_sessions WHERE user_id=?1", [&me.id], |r| r.get(0)).unwrap();

        let export = auth.export(&session(&token)).unwrap();
        let text = export.to_string();
        for secret in [password_hash.as_str(), session_hash.as_str(), token.as_str(), "WRAPPED-SECRET", "WRAPPED-OTHER", "INVITE-HASH-SECRET", "bob@example.test"] {
            assert!(!text.contains(secret), "export leaks {secret}");
        }
        assert_eq!(export["account"]["email"], "me@example.test");
        assert_eq!(export["account"]["lastName"], "Kowalski");
        assert_eq!(export["account"]["profileSecret"], envelope(3));
        assert_eq!(export["vaultProfiles"][0]["vaultId"], "v-1");
        assert_eq!(export["vaultProfiles"][0]["profile"]["ciphertext"], "c");
        assert_eq!(export["vaultProfiles"].as_array().unwrap().len(), 1);
        assert_eq!(export["sessions"][0]["current"], true);
        assert_eq!(export["vaults"][0]["owner"], true);
        assert_eq!(export["invitesCreated"][0]["used"], false);
        assert_eq!(export["keys"], json!({ "signingKey": false, "boxKey": false }));
        assert!(auth.export(&HeaderMap::new()).is_err());
    }

    #[test]
    fn client_hashes_are_keyed_not_plain_blake3() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.7"));
        let client = client_of(&headers);
        assert_eq!(client, client_of(&headers));
        assert_eq!(client.len(), 16);
        assert_ne!(client, blake3::hash(b"203.0.113.7").to_hex()[..16]);
    }

    #[tokio::test]
    async fn audit_lines_never_contain_an_email() {
        let (auth, _dir) = test_auth();
        let auth = Arc::new(auth);
        let form = |email: &str, password: &str| Credentials {
            email: email.into(), password: password.into(), name: Some("Jan".into()), last_name: None, invite: None, code: None,
        };
        register(State(auth.clone()), HeaderMap::new(), axum::Json(form("audit@example.test", "Long test password1"))).await;
        login(State(auth.clone()), HeaderMap::new(), axum::Json(form("audit@example.test", "wrong password"))).await;
        login(State(auth.clone()), HeaderMap::new(), axum::Json(form("nobody@example.test", "wrong password"))).await;
        let lines = crate::audit::CAPTURED.lock().unwrap().clone();
        assert!(lines.iter().any(|l| l.contains("event=register user=")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("event=login_failed user=")), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("event=login_failed known=no")), "{lines:?}");
        assert!(lines.iter().all(|l| !l.contains('@')), "{lines:?}");
    }

    #[test]
    fn login_rejects_bad_credentials_and_returns_opaque_session() {
        let (auth, _dir) = test_auth();
        auth.register("me@example.com", "Long test password1").unwrap();
        assert!(matches!(auth.login("me@example.com", "wrong password"), Err(AuthError::Unauthorized)));
        let (user, token) = auth.login("ME@example.com", "Long test password1").unwrap();
        assert_eq!(user.email, "me@example.com");
        assert_eq!(token.len(), 64);
        assert!(!token.contains("password"));
    }

    #[test]
    fn registration_takes_a_name_and_a_strong_eight_character_password() {
        let (auth, _dir) = test_auth();
        assert!(matches!(auth.register_named("jan@example.test", "Password1", "", "", "test", None, None), Err(AuthError::InvalidName)));
        assert!(matches!(auth.register_named("jan@example.test", "Password1", "Jan", "Kowalski", "test", None, None), Err(AuthError::LastNameEncrypted)));
        assert!(matches!(auth.register_named("jan@example.test", "password1", "Jan Kowalski", "", "test", None, None), Err(AuthError::WeakPassword)));
        assert!(matches!(auth.register_named("jan@example.test", "Password", "Jan Kowalski", "", "test", None, None), Err(AuthError::WeakPassword)));
        assert!(matches!(auth.register_named("jan@example.test", "Pass1", "Jan Kowalski", "", "test", None, None), Err(AuthError::WeakPassword)));
        assert!(auth.register_named("jan@example.test", "Haslo123", "Jan Kowalski", "", "test", None, None).is_ok());
    }

    #[test]
    fn same_origin_rejects_cross_site_mutations() {
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, HeaderValue::from_static("https://attacker.example"));
        headers.insert("host", HeaderValue::from_static("notes.example"));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert!(!same_origin(&headers));
        headers.insert(ORIGIN, HeaderValue::from_static("https://notes.example"));
        assert!(same_origin(&headers));
    }
}
