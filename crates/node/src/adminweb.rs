//! The server admin's panel (docs/PANEL-ADMINA.md): its own HTTP listener (`--admin-http`), reachable only from
//! private networks, one password from `NOTES_ADMIN_PASSWORD`, sessions kept in memory. The admin sees accounts,
//! vaults and sizes, never a key or a note.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, DefaultBodyLimit, Path as AxumPath, Query, Request, State};
use axum::http::header::{HOST, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, delete, get, patch, post};
use axum::{Json, Router};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{hex, now_seconds};
use crate::files::{FileError, FileService};
use crate::vaults::{VaultError, VaultService};
use crate::websync::BrowserSync;

const COOKIE: &str = "notes_admin";
const SESSION_SECONDS: i64 = 8 * 60 * 60;
const FAILURE_WINDOW_SECONDS: i64 = 15 * 60;
const MAX_FAILURES: u32 = 5;
/// How long the size of `/data` is reused: walking every attachment on each overview is too slow.
const DATA_SIZE_TTL: Duration = Duration::from_secs(60);
const BY: (&str, &str) = ("by", "server-admin");
const PANEL: &str = include_str!("admin_panel.html");
// the panel is one self-contained page: its inline script and style, nothing from elsewhere, never framed
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
    connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

pub struct AdminWeb {
    data: PathBuf,
    password: blake3::Hash,
    /// blake3 of the session token → expiry (unix seconds). Only the hash is kept.
    sessions: Mutex<HashMap<blake3::Hash, i64>>,
    /// Failed logins per peer address: (window start, count).
    failures: Mutex<HashMap<IpAddr, (i64, u32)>>,
    vaults: Arc<VaultService>,
    sync: Arc<BrowserSync>,
    files: Arc<FileService>,
    data_size: Mutex<Option<(Instant, u64)>>,
}

impl AdminWeb {
    /// `password` comes from `NOTES_ADMIN_PASSWORD`; an empty one is refused, so the panel never starts open.
    pub fn new(data: &Path, password: &str, vaults: Arc<VaultService>, sync: Arc<BrowserSync>, files: Arc<FileService>) -> Result<Self, String> {
        if password.trim().is_empty() {
            return Err("panel administratora (--admin-http) wymaga hasła: ustaw NOTES_ADMIN_PASSWORD (w .env jako ADMIN_PASSWORD)".into());
        }
        Ok(Self {
            data: data.to_path_buf(), password: blake3::hash(password.as_bytes()),
            sessions: Mutex::default(), failures: Mutex::default(), vaults, sync, files, data_size: Mutex::default(),
        })
    }
}

#[derive(Debug)]
struct Fail(StatusCode, String);

fn fail(status: StatusCode, message: &str) -> Fail { Fail(status, message.to_string()) }
fn internal<E>(_: E) -> Fail { fail(StatusCode::INTERNAL_SERVER_ERROR, "Nie udało się obsłużyć żądania.") }

impl IntoResponse for Fail {
    fn into_response(self) -> Response { (self.0, Json(json!({ "error": self.1 }))).into_response() }
}

impl From<VaultError> for Fail {
    fn from(e: VaultError) -> Self {
        let response = e.into_response();
        let status = response.status();
        let message = match e {
            VaultError::Invalid(m) | VaultError::Forbidden(m) | VaultError::Gone(m) | VaultError::Conflict(m) | VaultError::Missing(m) => m,
            VaultError::NotFound => "Nie znaleziono.",
            _ => "Nie udało się obsłużyć żądania.",
        };
        fail(status, message)
    }
}

pub fn app(admin: Arc<AdminWeb>) -> Router {
    Router::new()
        .route("/", get(panel))
        .route("/admin", get(panel))
        .route("/admin/api/login", post(login))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/overview", get(overview))
        .route("/admin/api/vaults", get(vaults))
        .route("/admin/api/vaults/{id}", patch(set_quota))
        .route("/admin/api/vaults/{id}/members/{user_id}", delete(remove_member))
        .route("/admin/api/storage", get(storage))
        .route("/admin/api/storage/migrate", post(migrate))
        .route("/admin/api/users", get(users))
        .route("/admin/api/users/{id}", patch(set_personal).delete(delete_user))
        .route("/admin/api/users/{id}/assignments", post(assign))
        .route("/admin/api/users/{id}/assignments/{vault_id}", delete(unassign))
        .route("/admin/api/signup-codes", get(signup_codes).post(create_signup_code))
        .route("/admin/api/signup-codes/{id}", delete(revoke_signup_code))
        .route("/admin/api/{*rest}", any(|| async { fail(StatusCode::NOT_FOUND, "Nie ma takiego zasobu.") }))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(admin)
        .layer(axum::middleware::from_fn(private_peer_only))
        .layer(axum::middleware::map_response(headers))
}

/// The real TCP peer must be on a private network. Forwarded headers are never read: no proxy fronts this listener.
async fn private_peer_only(request: Request, next: Next) -> Response {
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(a)| a.ip());
    if !peer.is_some_and(crate::http::trusted_peer) {
        return fail(StatusCode::FORBIDDEN, "Panel administratora jest dostępny tylko z sieci lokalnej.").into_response();
    }
    next.run(request).await
}

async fn headers(mut response: Response) -> Response {
    let h = response.headers_mut();
    for (name, value) in [
        ("content-security-policy", CSP),
        ("x-frame-options", "DENY"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
    ] {
        h.insert(name, HeaderValue::from_static(value));
    }
    response
}

async fn panel() -> Html<&'static str> { Html(PANEL) }

/// State-changing requests carry `X-Notes-Admin: 1` (a cross-site form can't set it) and, when present, an `Origin`
/// equal to this listener's host.
// stricter than `auth::same_origin`: no proxy fronts this listener, so forwarded headers are never trusted, and the
// header is required because a missing `Origin` is not enough on a LAN page
fn check_mutation(headers: &HeaderMap) -> Result<(), Fail> {
    if headers.get("x-notes-admin").and_then(|v| v.to_str().ok()) != Some("1") {
        return Err(fail(StatusCode::FORBIDDEN, "Brak nagłówka X-Notes-Admin."));
    }
    if let Some(origin) = headers.get(ORIGIN) {
        let host = headers.get(HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
        let origin = origin.to_str().unwrap_or("");
        if host.is_empty() || (origin != format!("http://{host}") && origin != format!("https://{host}")) {
            return Err(fail(StatusCode::FORBIDDEN, crate::auth::FOREIGN_REQUEST));
        }
    }
    Ok(())
}

impl AdminWeb {
    fn signed_in(&self, headers: &HeaderMap) -> Result<(), Fail> {
        let token = crate::auth::cookie_value(headers, COOKIE).unwrap_or_default();
        let now = now_seconds();
        let mut sessions = self.sessions.lock().map_err(internal)?;
        sessions.retain(|_, expires| *expires > now);
        if token.is_empty() || !sessions.contains_key(&blake3::hash(token.as_bytes())) {
            return Err(fail(StatusCode::UNAUTHORIZED, "Zaloguj się do panelu administratora."));
        }
        Ok(())
    }

    /// Checks the password for `ip` (5 failures per 15 minutes) and opens a session. Returns the session token.
    fn login(&self, ip: IpAddr, password: &str) -> Result<String, Fail> {
        let now = now_seconds();
        let mut failures = self.failures.lock().map_err(internal)?;
        failures.retain(|_, (start, _)| now < *start + FAILURE_WINDOW_SECONDS);
        if failures.get(&ip).is_some_and(|(_, n)| *n >= MAX_FAILURES) {
            return Err(fail(StatusCode::TOO_MANY_REQUESTS, "Zbyt wiele nieudanych prób. Spróbuj ponownie za 15 minut."));
        }
        // blake3::Hash compares in constant time
        if blake3::hash(password.as_bytes()) != self.password {
            failures.entry(ip).or_insert((now, 0)).1 += 1;
            crate::audit::event("admin_login_failed", &[]);
            return Err(fail(StatusCode::UNAUTHORIZED, "Nieprawidłowe hasło."));
        }
        failures.remove(&ip);
        let token = hex(&notes_sync::random::<32>().map_err(internal)?);
        self.sessions.lock().map_err(internal)?.insert(blake3::hash(token.as_bytes()), now + SESSION_SECONDS);
        crate::audit::event("admin_login", &[BY]);
        Ok(token)
    }

    fn auth_db(&self) -> Result<Connection, Fail> { crate::admin::open(&self.data, "auth.db").map_err(internal) }
    fn sync_db(&self) -> Result<Connection, Fail> { crate::admin::open(&self.data, "browser-sync.db").map_err(internal) }

    fn overview(&self) -> Result<Value, Fail> {
        let db = self.auth_db()?;
        let count = |sql: &str| -> Result<i64, Fail> { db.query_row(sql, [], |r| r.get(0)).map_err(internal) };
        let sync = self.sync_db()?;
        let notes: i64 = sync.query_row("SELECT COALESCE(SUM(length(envelope_json)),0) FROM browser_sync_vaults", [], |r| r.get(0)).map_err(internal)?;
        // accounts allowed their own notes: the same gate as the personal vault itself
        let personal = count("SELECT count(*) FROM web_users WHERE personal='allowed'")?;
        let disk = disk_space(&self.data);
        Ok(json!({
            "disk": { "totalBytes": disk.map(|d| d.0), "freeBytes": disk.map(|d| d.1), "dataBytes": self.data_size()? },
            "notesBytes": notes,
            "filesBytes": self.files.total_bytes().map_err(internal)?,
            "users": count("SELECT count(*) FROM web_users")?,
            "vaults": {
                "organization": count("SELECT count(*) FROM vaults WHERE kind='organizacja'")?,
                "notes": count("SELECT count(*) FROM vaults WHERE kind='notatki'")?,
                "personal": personal,
            },
            "storage": self.storage()?,
        }))
    }

    fn storage(&self) -> Result<Value, Fail> {
        serde_json::to_value(self.files.storage_status().map_err(internal)?).map_err(internal)
    }

    fn migrate(&self, target: &str) -> Result<Value, Fail> {
        self.files.start_migration(target).map_err(|e| match e {
            FileError::Invalid(m) => fail(StatusCode::BAD_REQUEST, m),
            FileError::Conflict(m) => fail(StatusCode::CONFLICT, m),
            other => internal(other),
        })?;
        crate::audit::event("storage_migration_started", &[BY, ("target", target)]);
        self.storage()
    }

    /// `dir_size` of `/data`, reused for `DATA_SIZE_TTL`. Runs on the blocking pool, like every handler here.
    fn data_size(&self) -> Result<u64, Fail> {
        let mut cached = self.data_size.lock().map_err(internal)?;
        match *cached {
            Some((at, bytes)) if at.elapsed() < DATA_SIZE_TTL => Ok(bytes),
            _ => {
                let bytes = dir_size(&self.data);
                *cached = Some((Instant::now(), bytes));
                Ok(bytes)
            }
        }
    }

    fn vaults(&self) -> Result<Value, Fail> {
        let db = self.auth_db()?;
        let sync = self.sync_db()?;
        let rows: Vec<(String, String, String, String, String)> = db
            .prepare("SELECT v.vault_id,v.name,v.kind,v.owner_user_id,u.email FROM vaults v JOIN web_users u ON u.user_id=v.owner_user_id ORDER BY v.created_at,v.vault_id")
            .and_then(|mut q| q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect())
            .map_err(internal)?;
        let mut members = db.prepare("SELECT m.user_id,u.email,m.role FROM vault_members m JOIN web_users u ON u.user_id=m.user_id WHERE m.vault_id=?1 ORDER BY m.added_at,m.user_id").map_err(internal)?;
        let mut out = Vec::new();
        for (id, name, kind, owner, email) in rows {
            let list: Vec<Value> = members
                .query_map([&id], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "email": r.get::<_, String>(1)?, "role": r.get::<_, String>(2)? })))
                .and_then(|rows| rows.collect())
                .map_err(internal)?;
            let snapshot: i64 = sync.query_row("SELECT COALESCE(SUM(length(envelope_json)),0) FROM browser_sync_vaults WHERE user_id='' AND vault_id=?1", [&id], |r| r.get(0)).map_err(internal)?;
            let (files, quota, default) = self.files.vault_usage(&id).map_err(internal)?;
            out.push(json!({
                "id": id, "name": name, "kind": kind, "owner": { "id": owner, "email": email }, "members": list,
                "snapshotBytes": snapshot, "filesBytes": files, "quotaBytes": quota, "quotaDefault": default,
            }));
        }
        Ok(Value::Array(out))
    }

    fn vault_exists(&self, db: &Connection, id: &str) -> Result<(), Fail> {
        let found: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM vaults WHERE vault_id=?1)", [id], |r| r.get(0)).map_err(internal)?;
        if found { Ok(()) } else { Err(fail(StatusCode::NOT_FOUND, "Nie ma takiego sejfu.")) }
    }

    fn user_exists(&self, db: &Connection, id: &str) -> Result<(), Fail> {
        let found: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM web_users WHERE user_id=?1)", [id], |r| r.get(0)).map_err(internal)?;
        if found { Ok(()) } else { Err(fail(StatusCode::NOT_FOUND, "Nie ma takiego konta.")) }
    }

    fn set_quota(&self, id: &str, quota_mb: Option<u64>) -> Result<Value, Fail> {
        if quota_mb.is_some_and(|mb| !(1..=1 << 20).contains(&mb)) {
            return Err(fail(StatusCode::BAD_REQUEST, "Limit musi wynosić od 1 MB do 1 TB."));
        }
        self.vault_exists(&self.auth_db()?, id)?;
        self.files.set_vault_quota(id, quota_mb.map(|mb| mb * 1024 * 1024)).map_err(internal)?;
        let (_, quota, default) = self.files.vault_usage(id).map_err(internal)?;
        crate::audit::event("vault_quota_set", &[BY, ("vault", id), ("mb", &quota_mb.map_or("default".into(), |mb| mb.to_string()))]);
        Ok(json!({ "quotaBytes": quota, "quotaDefault": default }))
    }

    fn remove_member(&self, vault: &str, user: &str) -> Result<Value, Fail> {
        self.vaults.remove_member_by_server(vault, user).map_err(|e| match e {
            VaultError::NotFound => fail(StatusCode::NOT_FOUND, "Tej osoby nie ma w tym sejfie."),
            other => other.into(),
        })?;
        self.files.revoke_member(vault, user).map_err(internal)?;
        self.sync.notify_access(vault, user, None);
        crate::audit::event("member_removed", &[BY, ("vault", vault), ("member", user)]);
        Ok(json!({ "ok": true }))
    }

    fn users(&self) -> Result<Value, Fail> {
        let db = self.auth_db()?;
        let sync = self.sync_db()?;
        let now = now_seconds();
        let rows: Vec<(String, String, String, i64, i64, String)> = db
            .prepare("SELECT u.user_id,u.email,u.display_name,u.created_at,
                        (SELECT count(*) FROM web_sessions s WHERE s.user_id=u.user_id AND s.expires_at>?1), u.personal
                      FROM web_users u ORDER BY u.created_at,u.user_id")
            .and_then(|mut q| q.query_map([now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?.collect())
            .map_err(internal)?;
        let mut vaults = db.prepare("SELECT v.vault_id,v.name,m.role FROM vault_members m JOIN vaults v ON v.vault_id=m.vault_id WHERE m.user_id=?1 ORDER BY v.name").map_err(internal)?;
        let mut assigned = db.prepare("SELECT a.vault_id,v.name,a.role,a.created_at FROM vault_assignments a JOIN vaults v ON v.vault_id=a.vault_id WHERE a.user_id=?1 ORDER BY a.created_at").map_err(internal)?;
        let mut out = Vec::new();
        for (id, email, name, created, sessions, personal) in rows {
            let member: Vec<Value> = vaults
                .query_map([&id], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "role": r.get::<_, String>(2)? })))
                .and_then(|rows| rows.collect())
                .map_err(internal)?;
            let assignments: Vec<Value> = assigned
                .query_map([&id], |r| Ok(json!({ "vaultId": r.get::<_, String>(0)?, "vaultName": r.get::<_, String>(1)?, "role": r.get::<_, String>(2)?, "createdAt": r.get::<_, i64>(3)? })))
                .and_then(|rows| rows.collect())
                .map_err(internal)?;
            let bytes: i64 = sync.query_row("SELECT COALESCE(SUM(length(envelope_json)),0) FROM browser_sync_vaults WHERE user_id=?1 AND vault_id='browser-'||?1", [&id], |r| r.get(0)).map_err(internal)?;
            out.push(json!({
                "id": id, "email": email, "name": name, "createdAt": created.saturating_mul(1000), "sessions": sessions,
                "personal": personal, "personalBytes": bytes, "vaults": member, "assignments": assignments,
            }));
        }
        Ok(Value::Array(out))
    }

    fn set_personal(&self, id: &str, personal: &str) -> Result<Value, Fail> {
        if !matches!(personal, "allowed" | "off") {
            return Err(fail(StatusCode::BAD_REQUEST, "Dozwolone wartości: allowed albo off."));
        }
        let db = self.auth_db()?;
        if db.execute("UPDATE web_users SET personal=?1 WHERE user_id=?2", params![personal, id]).map_err(internal)? == 0 {
            return Err(fail(StatusCode::NOT_FOUND, "Nie ma takiego konta."));
        }
        if personal == "off" {
            // open tabs with Moje notatki lose them now, not at their next connection
            self.sync.notify_access(&format!("browser-{id}"), id, None);
        }
        crate::audit::event("personal_set", &[BY, ("user", id), ("personal", personal)]);
        Ok(json!({ "personal": personal }))
    }

    fn delete_user(&self, id: &str, apply: bool) -> Result<Value, Fail> {
        self.user_exists(&self.auth_db()?, id)?;
        let d = crate::admin::delete_user(&self.data, id, apply).map_err(|refused| Fail(StatusCode::CONFLICT, refused))?;
        if apply {
            crate::audit::event("account_deleted", &[BY, ("user", &d.id)]);
        }
        let vaults: Vec<&str> = d.vaults.iter().map(|(_, name)| name.as_str()).collect();
        Ok(json!({ "applied": apply, "vaults": vaults, "left": d.left }))
    }

    fn assign(&self, user: &str, vault: &str, role: &str) -> Result<Value, Fail> {
        if !matches!(role, "editor" | "viewer" | "admin") {
            return Err(fail(StatusCode::BAD_REQUEST, "Dozwolone role: editor, viewer albo admin."));
        }
        if vault.starts_with("browser-") {
            return Err(fail(StatusCode::BAD_REQUEST, "Do własnych notatek nie można nikogo przydzielić."));
        }
        let db = self.auth_db()?;
        self.user_exists(&db, user)?;
        self.vault_exists(&db, vault)?;
        let member: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM vault_members WHERE vault_id=?1 AND user_id=?2)", params![vault, user], |r| r.get(0)).map_err(internal)?;
        if member {
            return Err(fail(StatusCode::CONFLICT, "Ta osoba jest już członkiem tej organizacji."));
        }
        let now = crate::vaults::now_millis();
        db.execute(
            "INSERT INTO vault_assignments(vault_id,user_id,role,created_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(vault_id,user_id) DO UPDATE SET role=?3",
            params![vault, user, role, now],
        ).map_err(internal)?;
        crate::audit::event("assignment_created", &[BY, ("vault", vault), ("user", user), ("role", role)]);
        Ok(json!({ "vaultId": vault, "role": role }))
    }

    fn unassign(&self, user: &str, vault: &str) -> Result<Value, Fail> {
        let db = self.auth_db()?;
        if db.execute("DELETE FROM vault_assignments WHERE vault_id=?1 AND user_id=?2", params![vault, user]).map_err(internal)? == 0 {
            return Err(fail(StatusCode::NOT_FOUND, "Nie ma takiego przydziału."));
        }
        crate::audit::event("assignment_removed", &[BY, ("vault", vault), ("user", user)]);
        Ok(json!({ "ok": true }))
    }

    fn signup_codes(&self) -> Result<Value, Fail> {
        Ok(json!({ "codes": crate::admin::list_signup_codes(&self.data).map_err(internal)? }))
    }

    // the only place a code's text leaves the server: in this response, never in a log
    fn create_signup_code(&self, label: &str, days: u32) -> Result<Value, Fail> {
        let made = crate::admin::create_signup_code(&self.data, label, days).map_err(|m| fail(StatusCode::BAD_REQUEST, &m))?;
        crate::audit::event("signup_code_created", &[BY, ("code", &made.id)]);
        Ok(json!({ "id": made.id, "code": made.code, "expiresAt": made.expires_at }))
    }

    fn revoke_signup_code(&self, id: &str) -> Result<Value, Fail> {
        if !crate::admin::revoke_signup_code(&self.data, id).map_err(internal)? {
            return Err(fail(StatusCode::NOT_FOUND, "Nie ma takiego kodu albo został już użyty."));
        }
        crate::audit::event("signup_code_revoked", &[BY, ("code", id)]);
        Ok(Value::Null)
    }
}

/// Bytes of the regular files below `dir`; symbolic links are not followed.
fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| match entry.file_type() {
        Ok(t) if t.is_dir() => dir_size(&entry.path()),
        Ok(t) if t.is_file() => entry.metadata().map_or(0, |m| m.len()),
        _ => 0,
    }).sum()
}

/// (total, free for an unprivileged writer) bytes of the file system holding `dir`.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // the field types differ between platforms
fn disk_space(dir: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is a valid NUL-terminated string and `stat` a writable statvfs the call fills in
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let unit = stat.f_frsize as u64;
    Some((stat.f_blocks as u64 * unit, stat.f_bavail as u64 * unit))
}

#[cfg(not(unix))]
fn disk_space(_: &Path) -> Option<(u64, u64)> { None }

/// Session check (and for mutations the CSRF check) first, then `work` on the blocking pool.
async fn run<F>(admin: Arc<AdminWeb>, headers: HeaderMap, mutating: bool, work: F) -> Response
where
    F: FnOnce(&AdminWeb) -> Result<Value, Fail> + Send + 'static,
{
    let checked = (if mutating { check_mutation(&headers) } else { Ok(()) }).and_then(|_| admin.signed_in(&headers));
    if let Err(e) = checked {
        return e.into_response();
    }
    match tokio::task::spawn_blocking(move || work(&admin)).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(e) => internal(e).into_response(),
    }
}

#[derive(Deserialize)]
struct SignupCodeBody { label: String, days: u32 }
#[derive(Deserialize)]
struct LoginBody { password: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaBody { quota_mb: Option<u64> }
#[derive(Deserialize)]
struct MigrateBody { target: String }
#[derive(Deserialize)]
struct PersonalBody { personal: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignBody { vault_id: String, role: String }

async fn login(State(admin): State<Arc<AdminWeb>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(input): Json<LoginBody>) -> Response {
    if let Err(e) = check_mutation(&headers) {
        return e.into_response();
    }
    match admin.login(peer.ip(), &input.password) {
        Ok(token) => {
            let mut response = Json(json!({ "ok": true })).into_response();
            // never Secure: the panel is plain HTTP on the local network, where a Secure cookie would not be kept
            let cookie = format!("{COOKIE}={token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}");
            if let Ok(value) = HeaderValue::from_str(&cookie) { response.headers_mut().insert(SET_COOKIE, value); }
            response
        }
        Err(e) => e.into_response(),
    }
}

async fn logout(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap) -> Response {
    if let Err(e) = check_mutation(&headers) {
        return e.into_response();
    }
    if let Some(token) = crate::auth::cookie_value(&headers, COOKIE)
        && let Ok(mut sessions) = admin.sessions.lock()
    {
        sessions.remove(&blake3::hash(token.as_bytes()));
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(SET_COOKIE, HeaderValue::from_static("notes_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0"));
    response
}

async fn overview(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap) -> Response {
    run(admin, headers, false, |a| a.overview()).await
}

async fn vaults(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap) -> Response {
    run(admin, headers, false, |a| a.vaults()).await
}

async fn set_quota(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<QuotaBody>) -> Response {
    run(admin, headers, true, move |a| a.set_quota(&id, input.quota_mb)).await
}

async fn remove_member(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath((id, user)): AxumPath<(String, String)>) -> Response {
    run(admin, headers, true, move |a| a.remove_member(&id, &user)).await
}

async fn storage(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap) -> Response {
    run(admin, headers, false, |a| a.storage()).await
}

async fn migrate(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, Json(input): Json<MigrateBody>) -> Response {
    run(admin, headers, true, move |a| a.migrate(&input.target)).await
}

async fn users(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap) -> Response {
    run(admin, headers, false, |a| a.users()).await
}

async fn set_personal(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<PersonalBody>) -> Response {
    run(admin, headers, true, move |a| a.set_personal(&id, &input.personal)).await
}

async fn delete_user(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Query(query): Query<HashMap<String, String>>) -> Response {
    let apply = query.get("apply").is_some_and(|v| v == "1");
    run(admin, headers, true, move |a| a.delete_user(&id, apply)).await
}

async fn assign(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<AssignBody>) -> Response {
    run(admin, headers, true, move |a| a.assign(&id, &input.vault_id, &input.role)).await
}

async fn unassign(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath((id, vault)): AxumPath<(String, String)>) -> Response {
    run(admin, headers, true, move |a| a.unassign(&id, &vault)).await
}

async fn signup_codes(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap) -> Response {
    run(admin, headers, false, |a| a.signup_codes()).await
}

async fn create_signup_code(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, Json(input): Json<SignupCodeBody>) -> Response {
    run(admin, headers, true, move |a| a.create_signup_code(&input.label, input.days)).await
}

async fn revoke_signup_code(State(admin): State<Arc<AdminWeb>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    let response = run(admin, headers, true, move |a| a.revoke_signup_code(&id)).await;
    if response.status().is_success() { StatusCode::NO_CONTENT.into_response() } else { response }
}


#[cfg(test)]
#[path = "adminweb_tests.rs"]
mod tests;
