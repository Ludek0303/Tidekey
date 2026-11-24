//! Shared organization vaults (web variant, docs/WEB-WSPOLDZIELENIE.md): membership, roles, invites and
//! their REST API. Tables live in `auth.db` next to `web_users`. The server stores each member's
//! `wrappedKey` opaquely and never sees the vault key.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{AuthService, AuthUser, FOREIGN_REQUEST, Refused, authorize};
use crate::files::FileService;
use crate::websync::{BrowserSync, Envelope};

const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES: usize = 16 * 1024;
const KEY_SCHEMA: &str = "notes-key-v1";
const SEALED_SCHEMA: &str = "notes-sealed-v1";
const SEALED_JSON_MAX_BYTES: usize = 8 * 1024;
const SIGNING_JWK_MAX_BYTES: usize = 1024;
const P256_COORD_CHARS: usize = 43;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS vaults (
        vault_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES web_users(user_id),
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_members (
        vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(vault_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS vault_members_user ON vault_members(user_id);
    CREATE TABLE IF NOT EXISTS vault_invites (
        invite_id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by TEXT
    );
    CREATE INDEX IF NOT EXISTS vault_invites_vault ON vault_invites(vault_id);
    CREATE TABLE IF NOT EXISTS user_signing_keys (
        user_id TEXT PRIMARY KEY REFERENCES web_users(user_id) ON DELETE CASCADE,
        public_jwk TEXT NOT NULL,
        wrapped_private TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_box_keys (
        user_id TEXT PRIMARY KEY REFERENCES web_users(user_id) ON DELETE CASCADE,
        public_jwk TEXT NOT NULL,
        wrapped_private TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_vault_keys (
        user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
        key_epoch INTEGER NOT NULL,
        wrapped_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, key_epoch)
    );
    -- every deleted vault, kept for good: the only proof finish_deletion acts on (rerun at each start)
    CREATE TABLE IF NOT EXISTS deleted_vaults (
        vault_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_assignments (
        vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(vault_id, user_id)
    );";

/// Columns added after the first release. `CREATE TABLE` above keeps the original shape, so these are added
/// with `ALTER TABLE` only when missing: `(table, column, definition)`.
const MIGRATIONS: [(&str, &str, &str); 8] = [
    ("vaults", "key_epoch", "INTEGER NOT NULL DEFAULT 1"),
    ("vaults", "needs_rotation", "INTEGER NOT NULL DEFAULT 0"),
    ("vault_members", "wrapped_key_epoch", "INTEGER NOT NULL DEFAULT 1"),
    ("vault_members", "pending_key", "TEXT"),
    ("vault_members", "pending_key_epoch", "INTEGER"),
    ("vault_members", "profile", "TEXT"),
    ("vault_invites", "max_uses", "INTEGER NOT NULL DEFAULT 1"),
    ("vault_invites", "uses", "INTEGER NOT NULL DEFAULT 0"),
];

/// Most people one invite link may admit.
const MAX_INVITE_USES: i64 = 50;

/// Members of one vault with their account names and public keys. Column 1 is the email (kept only for admins
/// and for the member themself, see `detail`). Columns 5 and 6: signing key and box key. Column 7: the card.
const MEMBERS_SQL_BY_VAULT: &str = "SELECT m.user_id,u.email,u.display_name,m.role,m.added_at,k.public_jwk,b.public_jwk,m.profile FROM vault_members m
     JOIN web_users u ON u.user_id=m.user_id
     LEFT JOIN user_signing_keys k ON k.user_id=m.user_id
     LEFT JOIN user_box_keys b ON b.user_id=m.user_id
     WHERE m.vault_id=?1 ORDER BY m.added_at,m.user_id";

/// Per-vault locks shared by `VaultService` and `BrowserSync`. A put's role check and commit run under the same
/// lock as a member removal or role change, so a removal that has returned is seen by every later put.
#[derive(Default)]
pub struct VaultLocks {
    inner: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl VaultLocks {
    /// Runs `work` while holding the lock of `vault_id`. The entry is dropped again once nobody else uses it.
    pub fn with<T>(&self, vault_id: &str, work: impl FnOnce() -> T) -> T {
        let lock = self.entry(vault_id);
        let result = {
            let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
            work()
        };
        drop(lock);
        self.release(vault_id);
        result
    }

    fn entry(&self, vault_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        map.entry(vault_id.to_string()).or_default().clone()
    }

    fn release(&self, vault_id: &str) {
        let mut map = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if map.get(vault_id).is_some_and(|lock| Arc::strong_count(lock) == 1) {
            map.remove(vault_id);
        }
    }
}

/// The two per-user key pair tables. Both hold a P-256 public JWK and a key wrapped with the account key.
#[derive(Clone, Copy)]
struct KeyTable {
    table: &'static str,
    missing: &'static str,
    conflict: &'static str,
}

const SIGNING_KEYS: KeyTable = KeyTable {
    table: "user_signing_keys",
    missing: "Nie ustawiono klucza podpisu.",
    conflict: "Dla tego konta zapisano już inny klucz podpisu.",
};

const BOX_KEYS: KeyTable = KeyTable {
    table: "user_box_keys",
    missing: "Nie ustawiono klucza szyfrowania.",
    conflict: "Dla tego konta zapisano już inny klucz szyfrowania.",
};

/// Roles in ascending order of power: `Role::Owner > Role::Admin > Role::Editor > Role::Viewer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Editor,
    Admin,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Admin => "admin",
            Self::Owner => "owner",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "viewer" => Some(Self::Viewer),
            "editor" => Some(Self::Editor),
            "admin" => Some(Self::Admin),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum VaultError {
    Invalid(&'static str),
    Unauthorized,
    Forbidden(&'static str),
    NotFound,
    Gone(&'static str),
    Conflict(&'static str),
    Missing(&'static str),
    Internal,
}

impl IntoResponse for VaultError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid(m) => (StatusCode::BAD_REQUEST, m),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Wymagane jest zalogowanie."),
            Self::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            Self::NotFound => (StatusCode::NOT_FOUND, "Nie znaleziono sejfu ani zaproszenia."),
            Self::Gone(m) => (StatusCode::GONE, m),
            Self::Conflict(m) => (StatusCode::CONFLICT, m),
            Self::Missing(m) => (StatusCode::NOT_FOUND, m),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "Nie udało się obsłużyć żądania."),
        };
        no_store((status, Json(json!({ "message": message }))).into_response())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub owner_user_id: String,
    pub key_epoch: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    #[serde(flatten)]
    pub info: VaultInfo,
    pub role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDetail {
    pub vault: VaultInfo,
    pub role: String,
    pub wrapped_key: Envelope,
    pub wrapped_key_epoch: i64,
    /// The new vault key sealed to this member's box key, when a rotation is waiting for them.
    pub pending_key: Option<PendingKey>,
    pub needs_rotation: bool,
    pub members: Vec<MemberView>,
    /// The owner's limits for Claude chats here (docs/MCP.md §6).
    pub agent_policy: crate::agents::Policy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingKey {
    pub key_epoch: i64,
    pub sealed_key: Value,
}

/// `email` is present only when the viewer is an admin or owner of the vault, or the member is the viewer
/// (absent otherwise, not null). `profile` is the member's encrypted card for this vault, or null (ciphertext under
/// the vault key; the last name lives there, see docs/WEB-WSPOLDZIELENIE.md "Encrypted last name").
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub name: String,
    pub role: String,
    pub added_at: i64,
    pub signing_key: Option<Value>,
    pub box_key: Option<Value>,
    pub profile: Option<Value>,
    /// The member's Claude chats with this vault (`GET /api/vaults/:id` only): `[{ agentId, cert, signature, revokedAt }]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairView {
    pub public_jwk: Value,
    pub wrapped_private: Envelope,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub id: String,
    pub role: String,
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub max_uses: i64,
    pub uses: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCreated {
    pub id: String,
    pub token: String,
    pub role: String,
    pub expires_at: i64,
    pub max_uses: i64,
}

/// What an invite link shows before joining: nothing about the inviter or the vault's members.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    pub vault: InviteVault,
    pub role: String,
    pub expires_at: i64,
    pub max_uses: i64,
    pub uses: i64,
}

#[derive(Debug, Serialize)]
pub struct InviteVault {
    pub id: String,
    pub name: String,
    pub kind: String,
}

struct InviteRow {
    vault_id: String,
    role: String,
    expires_at: i64,
    used_at: Option<i64>,
    max_uses: i64,
    uses: i64,
}

pub struct VaultService {
    db: Mutex<Connection>,
    locks: Arc<VaultLocks>,
}

impl VaultService {
    /// Opens the vault tables inside `auth.db` (open `AuthService` first: members reference `web_users`).
    /// `locks` must be the same instance that `BrowserSync` gets.
    pub fn open(data_dir: &Path, locks: Arc<VaultLocks>) -> Result<Self, VaultError> {
        let db = Connection::open(data_dir.join("auth.db")).map_err(db_err)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(db_err)?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(db_err)?;
        db.execute_batch(SCHEMA).map_err(db_err)?;
        crate::agents::create_tables(&db).map_err(db_err)?;
        for (table, column, definition) in MIGRATIONS {
            // Invites used before `uses` existed count as used once (only when the column is first added).
            if add_column_if_missing(&db, table, column, definition)? && column == "uses" {
                db.execute("UPDATE vault_invites SET uses=1 WHERE used_at IS NOT NULL", []).map_err(db_err)?;
            }
        }
        Ok(Self { db: Mutex::new(db), locks })
    }

    /// The vault's current key epoch (`NotFound` for unknown vaults).
    pub fn key_epoch(&self, vault_id: &str) -> Result<i64, VaultError> {
        let db = self.db()?;
        vault_key_epoch(&db, vault_id)
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, VaultError> {
        self.db.lock().map_err(|_| VaultError::Internal)
    }

    /// Whether `user_id` may keep their own notes (`web_users.personal`, docs/PANEL-ADMINA.md).
    pub fn personal_allowed(&self, user_id: &str) -> Result<bool, VaultError> {
        crate::auth::personal_allowed(&*self.db()?, user_id).map_err(db_err)
    }

    /// The server admin's assignments to this vault that a browser can complete now: only people with a box key.
    /// Owners and admins of the vault only.
    pub fn assignments(&self, actor_id: &str, vault_id: &str) -> Result<Vec<Value>, VaultError> {
        let db = self.db()?;
        require(&db, vault_id, actor_id, Role::Admin)?;
        let mut stmt = db.prepare(
            "SELECT a.user_id,u.email,u.display_name,a.role,b.public_jwk FROM vault_assignments a
             JOIN web_users u ON u.user_id=a.user_id JOIN user_box_keys b ON b.user_id=a.user_id
             WHERE a.vault_id=?1 ORDER BY a.created_at,a.user_id",
        ).map_err(db_err)?;
        let rows = stmt.query_map([vault_id], |r| Ok(json!({
            "userId": r.get::<_, String>(0)?,
            "email": r.get::<_, String>(1)?,
            "name": r.get::<_, String>(2)?,
            "role": r.get::<_, String>(3)?,
            "boxKey": json_column(r, 4)?,
        }))).map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// An owner or admin hands an assigned person the vault key, sealed to their box key for the current epoch. The
    /// person becomes a member with the assigned role; their `wrappedKey` waits as a pending key (epoch 0 marks it) until
    /// their browser opens it and stores its own copy (`PUT my-key`), as after a rotation.
    pub fn complete_assignment(&self, actor_id: &str, vault_id: &str, target_id: &str, sealed_key: &Value, key_epoch: i64) -> Result<VaultView, VaultError> {
        let sealed = sealed_key_json(sealed_key)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        require(&tx, vault_id, actor_id, Role::Admin)?;
        let role: String = tx.query_row("SELECT role FROM vault_assignments WHERE vault_id=?1 AND user_id=?2", params![vault_id, target_id], |r| r.get(0))
            .optional().map_err(db_err)?.ok_or(VaultError::Missing("Nie ma takiego przydziału."))?;
        let role = Role::parse(&role).ok_or(VaultError::Internal)?;
        let current = vault_key_epoch(&tx, vault_id)?;
        if current != key_epoch {
            return Err(VaultError::Conflict("Podany numer epoki klucza jest nieaktualny."));
        }
        tx.execute("DELETE FROM vault_assignments WHERE vault_id=?1 AND user_id=?2", params![vault_id, target_id]).map_err(db_err)?;
        if member_role(&tx, vault_id, target_id)?.is_some() {
            tx.commit().map_err(db_err)?;
            return Err(VaultError::Conflict("Ta osoba jest już członkiem tego sejfu."));
        }
        tx.execute(
            "INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,wrapped_key_epoch,pending_key,pending_key_epoch,added_at)
             VALUES (?1,?2,?3,?4,0,?4,?5,?6)",
            params![vault_id, target_id, role.as_str(), sealed, current, now_millis()],
        ).map_err(db_err)?;
        let info = vault_info(&tx, vault_id)?.ok_or(VaultError::NotFound)?;
        tx.commit().map_err(db_err)?;
        Ok(VaultView { info, role: role.as_str().to_string() })
    }

    /// Every vault deleted by delete_vault. Kept for good, so a snapshot or file database restored from an older
    /// backup loses that vault's data again at the next start.
    pub fn deleted_vault_ids(&self) -> Result<Vec<String>, VaultError> {
        let db = self.db()?;
        let mut q = db.prepare("SELECT vault_id FROM deleted_vaults").map_err(db_err)?;
        let rows = q.query_map([], |r| r.get(0)).map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)
    }


    /// The caller's role in a shared vault, or `None` for non-members (and unknown vaults).
    pub fn role_of(&self, user_id: &str, vault_id: &str) -> Result<Option<Role>, VaultError> {
        let db = self.db()?;
        member_role(&db, vault_id, user_id)
    }

    pub fn create(&self, user_id: &str, name: &str, kind: &str, wrapped_key: &Envelope) -> Result<VaultView, VaultError> {
        let name = clean_name(name)?;
        if !matches!(kind, "notatki" | "organizacja") {
            return Err(VaultError::Invalid("Nieznany rodzaj sejfu."));
        }
        let key_json = wrapped_key_json(wrapped_key)?;
        let vault_id = format!("v-{}", random_hex::<16>()?);
        let now = now_millis();
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        // each vault may hold up to 16 MiB on the server: a cap per account keeps one account from filling the disk
        let owned: i64 = tx.query_row("SELECT count(*) FROM vaults WHERE owner_user_id=?1", [user_id], |r| r.get(0)).map_err(db_err)?;
        if owned >= max_vaults() { return Err(VaultError::Forbidden("Osiągnięto limit sejfów na jedno konto.")); }
        tx.execute(
            "INSERT INTO vaults(vault_id,name,kind,owner_user_id,created_at) VALUES (?1,?2,?3,?4,?5)",
            params![vault_id, name, kind, user_id, now],
        ).map_err(db_err)?;
        tx.execute(
            "INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,'owner',?3,?4)",
            params![vault_id, user_id, key_json, now],
        ).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(VaultView {
            info: VaultInfo {
                id: vault_id,
                name,
                kind: kind.to_string(),
                owner_user_id: user_id.to_string(),
                key_epoch: 1,
            },
            role: Role::Owner.as_str().to_string(),
        })
    }

    pub fn list(&self, user_id: &str) -> Result<Vec<VaultView>, VaultError> {
        let db = self.db()?;
        let mut stmt = db.prepare(
            "SELECT v.vault_id,v.name,v.kind,v.owner_user_id,v.key_epoch,m.role FROM vault_members m
             JOIN vaults v ON v.vault_id=m.vault_id WHERE m.user_id=?1 ORDER BY v.created_at,v.vault_id",
        ).map_err(db_err)?;
        let rows = stmt.query_map([user_id], |r| {
            Ok(VaultView {
                info: VaultInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    owner_user_id: r.get(3)?,
                    key_epoch: r.get(4)?,
                },
                role: r.get(5)?,
            })
        }).map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    pub fn detail(&self, user_id: &str, vault_id: &str) -> Result<VaultDetail, VaultError> {
        let db = self.db()?;
        let role = member_role(&db, vault_id, user_id)?.ok_or(VaultError::NotFound)?;
        let vault = vault_info(&db, vault_id)?.ok_or(VaultError::NotFound)?;
        let (key_json, wrapped_key_epoch, pending_json, pending_epoch): (String, i64, Option<String>, Option<i64>) =
            db.query_row(
                "SELECT wrapped_key,wrapped_key_epoch,pending_key,pending_key_epoch FROM vault_members
                 WHERE vault_id=?1 AND user_id=?2",
                params![vault_id, user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ).map_err(db_err)?;
        let wrapped_key = serde_json::from_str(&key_json).map_err(db_err)?;
        // Only the caller's own pending key is returned, never anyone else's.
        let pending_key = match (pending_json, pending_epoch) {
            (Some(json), Some(key_epoch)) => Some(PendingKey {
                key_epoch,
                sealed_key: serde_json::from_str(&json).map_err(db_err)?,
            }),
            _ => None,
        };
        let needs_rotation: bool = db.query_row(
            "SELECT needs_rotation FROM vaults WHERE vault_id=?1",
            [vault_id],
            |r| r.get(0),
        ).map_err(db_err)?;
        let mut stmt = db.prepare(MEMBERS_SQL_BY_VAULT).map_err(db_err)?;
        let mut members = stmt.query_map([vault_id], member_from_row).map_err(db_err)?
            .collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        // Emails are for the vault's admins and for each member's own row. Other members see names only.
        if role < Role::Admin {
            for member in members.iter_mut().filter(|m| m.user_id != user_id) {
                member.email = None;
            }
        }
        for member in members.iter_mut() {
            member.agents = Some(crate::agents::member_agents(&db, vault_id, &member.user_id).map_err(db_err)?);
        }
        let agent_policy = crate::agents::policy(&db, vault_id).map_err(db_err)?;
        Ok(VaultDetail {
            vault,
            role: role.as_str().to_string(),
            wrapped_key,
            wrapped_key_epoch,
            pending_key,
            needs_rotation,
            members,
            agent_policy,
        })
    }

    /// Stores (or with `None` removes) the caller's own card for this vault. Any member may, viewers included.
    /// The shape is checked before the membership, which only changes the answer for a bad body, not for existence.
    pub fn set_my_profile(&self, user_id: &str, vault_id: &str, profile: Option<&Value>) -> Result<(), VaultError> {
        let text = profile.map(profile_json).transpose()?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        require(&tx, vault_id, user_id, Role::Viewer)?;
        tx.execute(
            "UPDATE vault_members SET profile=?1 WHERE vault_id=?2 AND user_id=?3",
            params![text, vault_id, user_id],
        ).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    /// The caller's own signing key, or `Missing` when none is stored yet.
    pub fn signing_key(&self, user_id: &str) -> Result<KeyPairView, VaultError> {
        self.key_pair(SIGNING_KEYS, user_id)
    }

    /// Stores the caller's signing key. Re-sending the stored public key is a no-op; a different key is a conflict.
    /// Returns the normalized public JWK.
    pub fn set_signing_key(&self, user_id: &str, public_jwk: &Value, wrapped_private: &Envelope) -> Result<Value, VaultError> {
        self.set_key_pair(SIGNING_KEYS, user_id, public_jwk, wrapped_private)
    }

    /// The caller's own box key (ECDH P-256, used for sealed boxes), or `Missing` when none is stored yet.
    pub fn box_key(&self, user_id: &str) -> Result<KeyPairView, VaultError> {
        self.key_pair(BOX_KEYS, user_id)
    }

    /// Same rules as `set_signing_key`.
    pub fn set_box_key(&self, user_id: &str, public_jwk: &Value, wrapped_private: &Envelope) -> Result<Value, VaultError> {
        self.set_key_pair(BOX_KEYS, user_id, public_jwk, wrapped_private)
    }

    fn key_pair(&self, kind: KeyTable, user_id: &str) -> Result<KeyPairView, VaultError> {
        let db = self.db()?;
        let (public_jwk, wrapped_private): (String, String) = db.query_row(
            &format!("SELECT public_jwk,wrapped_private FROM {} WHERE user_id=?1", kind.table),
            [user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(db_err)?.ok_or(VaultError::Missing(kind.missing))?;
        Ok(KeyPairView {
            public_jwk: serde_json::from_str(&public_jwk).map_err(db_err)?,
            wrapped_private: serde_json::from_str(&wrapped_private).map_err(db_err)?,
        })
    }

    fn set_key_pair(&self, kind: KeyTable, user_id: &str, public_jwk: &Value, wrapped_private: &Envelope) -> Result<Value, VaultError> {
        let (canonical, jwk) = canonical_public_jwk(public_jwk)?;
        validate_wrapped_key(wrapped_private)?;
        let wrapped_json = serde_json::to_string(wrapped_private).map_err(db_err)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let stored: Option<String> = tx.query_row(
            &format!("SELECT public_jwk FROM {} WHERE user_id=?1", kind.table),
            [user_id],
            |r| r.get(0),
        ).optional().map_err(db_err)?;
        match stored {
            Some(existing) if existing == canonical => return Ok(jwk),
            Some(_) => return Err(VaultError::Conflict(kind.conflict)),
            None => {}
        }
        tx.execute(
            &format!("INSERT INTO {}(user_id,public_jwk,wrapped_private,created_at) VALUES (?1,?2,?3,?4)", kind.table),
            params![user_id, canonical, wrapped_json, now_millis()],
        ).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(jwk)
    }

    /// The personal vault's own keys (docs/MCP.md §3.7), oldest first: each a random key wrapped with the personal key.
    /// Epoch 1 is the personal key itself and is never stored.
    /// Each with its `created_at` (ms), which the browser compares with the `revokedAt` of disconnected chats.
    pub fn personal_keys(&self, user_id: &str) -> Result<Vec<(i64, Envelope, i64)>, VaultError> {
        let db = self.db()?;
        let mut statement = db.prepare("SELECT key_epoch,wrapped_key,created_at FROM personal_vault_keys WHERE user_id=?1 ORDER BY key_epoch").map_err(db_err)?;
        let rows = statement.query_map([user_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).map_err(db_err)?;
        rows.map(|row| {
            let (epoch, json, created_at) = row.map_err(db_err)?;
            Ok((epoch, serde_json::from_str(&json).map_err(db_err)?, created_at))
        }).collect()
    }

    /// The personal vault's current key epoch: 1 (the personal key) until a key of its own is stored.
    pub fn personal_key_epoch(&self, user_id: &str) -> Result<i64, VaultError> {
        let db = self.db()?;
        db.query_row("SELECT COALESCE(MAX(key_epoch),1) FROM personal_vault_keys WHERE user_id=?1", [user_id], |r| r.get(0)).map_err(db_err)
    }

    /// Stores the personal vault's next key. Only the next epoch is taken, and a stored one is never replaced: the same
    /// key again is a no-op, another one a conflict (another device migrated first). Runs under the personal vault's lock,
    /// so a put that passed the epoch check has committed before the new epoch exists.
    pub fn add_personal_key(&self, user_id: &str, key_epoch: i64, wrapped_key: &Envelope) -> Result<i64, VaultError> {
        self.add_personal_key_with_agents(user_id, key_epoch, wrapped_key, &[])
    }

    /// `add_personal_key`, plus the new key sealed for each of the person's chats with the personal vault
    /// (`agentKeys`: exactly those chats, else a conflict).
    pub fn add_personal_key_with_agents(&self, user_id: &str, key_epoch: i64, wrapped_key: &Envelope, agent_keys: &[(String, Value)]) -> Result<i64, VaultError> {
        validate_wrapped_key(wrapped_key)?;
        let wrapped_json = serde_json::to_string(wrapped_key).map_err(db_err)?;
        self.locks.with(&format!("browser-{user_id}"), || {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
            let stored: Option<String> = tx.query_row(
                "SELECT wrapped_key FROM personal_vault_keys WHERE user_id=?1 AND key_epoch=?2", params![user_id, key_epoch], |r| r.get(0),
            ).optional().map_err(db_err)?;
            if let Some(existing) = stored {
                return if existing == wrapped_json { Ok(key_epoch) } else { Err(VaultError::Conflict("Ten klucz Moich notatek został już zmieniony na innym urządzeniu.")) };
            }
            let current: i64 = tx.query_row("SELECT COALESCE(MAX(key_epoch),1) FROM personal_vault_keys WHERE user_id=?1", [user_id], |r| r.get(0)).map_err(db_err)?;
            if key_epoch != current + 1 {
                return Err(VaultError::Conflict("Ten klucz Moich notatek został już zmieniony na innym urządzeniu."));
            }
            tx.execute(
                "INSERT INTO personal_vault_keys(user_id,key_epoch,wrapped_key,created_at) VALUES (?1,?2,?3,?4)",
                params![user_id, key_epoch, wrapped_json, now_millis()],
            ).map_err(db_err)?;
            crate::agents::store_rotated_keys(&tx, &format!("browser-{user_id}"), key_epoch, agent_keys)?;
            tx.commit().map_err(db_err)?;
            Ok(key_epoch)
        })
    }

    pub fn rename(&self, user_id: &str, vault_id: &str, name: &str) -> Result<VaultView, VaultError> {
        let name = clean_name(name)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let role = require(&tx, vault_id, user_id, Role::Admin)?;
        tx.execute("UPDATE vaults SET name=?1 WHERE vault_id=?2", params![name, vault_id]).map_err(db_err)?;
        let info = vault_info(&tx, vault_id)?.ok_or(VaultError::NotFound)?;
        tx.commit().map_err(db_err)?;
        Ok(VaultView { info, role: role.as_str().to_string() })
    }

    /// An owner deletes a shared vault for everyone: the vault, its members, invites, assignments and leases (by
    /// cascade) and its chats' rows. `typed_name` must be the vault's name, as the owner typed it to confirm. Returns
    /// the former members, whose open sockets the caller tells. The snapshot and the files go next (BrowserSync,
    /// FileService); without the vault row nobody can read or write them any more.
    pub fn delete_vault(&self, user_id: &str, vault_id: &str, typed_name: &str) -> Result<Vec<String>, VaultError> {
        self.locks.with(vault_id, || -> Result<Vec<String>, VaultError> {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
            require(&tx, vault_id, user_id, Role::Owner)?;
            let name = vault_info(&tx, vault_id)?.ok_or(VaultError::NotFound)?.name;
            if typed_name.trim() != name {
                return Err(VaultError::Invalid("Wpisz dokładną nazwę organizacji, aby ją usunąć."));
            }
            let members: Vec<String> = tx
                .prepare("SELECT user_id FROM vault_members WHERE vault_id=?1")
                .and_then(|mut q| q.query_map([vault_id], |r| r.get(0))?.collect())
                .map_err(db_err)?;
            // the chat tables name vaults without a foreign key (agents.rs); they exist once the agent service has opened
            for table in ["agent_keys", "agent_scopes", "agent_proposals", "agent_detached", "vault_agent_policy"] {
                let exists: bool = tx
                    .query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |r| r.get::<_, i64>(0))
                    .map_err(db_err)? > 0;
                if exists {
                    tx.execute(&format!("DELETE FROM {table} WHERE vault_id=?1"), [vault_id]).map_err(db_err)?;
                }
            }
            tx.execute("INSERT OR REPLACE INTO deleted_vaults(vault_id,deleted_at) VALUES (?1,?2)", params![vault_id, now_millis()]).map_err(db_err)?;
            tx.execute("DELETE FROM vaults WHERE vault_id=?1", [vault_id]).map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            Ok(members)
        })
    }

    pub fn create_invite(&self, user_id: &str, vault_id: &str, role_text: &str) -> Result<InviteCreated, VaultError> {
        self.create_invite_for(user_id, vault_id, role_text, 1)
    }

    /// `max_uses` is how many different people may join with the link (1..=`MAX_INVITE_USES`).
    pub fn create_invite_for(&self, user_id: &str, vault_id: &str, role_text: &str, max_uses: i64) -> Result<InviteCreated, VaultError> {
        let role = match Role::parse(role_text) {
            Some(role @ (Role::Admin | Role::Editor | Role::Viewer)) => role,
            _ => return Err(VaultError::Invalid("Nieznana rola.")),
        };
        if !(1..=MAX_INVITE_USES).contains(&max_uses) {
            return Err(VaultError::Invalid("Liczba osób musi być od 1 do 50."));
        }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let actor = require(&tx, vault_id, user_id, Role::Admin)?;
        if role == Role::Admin && actor < Role::Owner {
            return Err(VaultError::Forbidden("Tylko właściciel może zaprosić administratora."));
        }
        let token = random_hex::<32>()?;
        let invite_id = random_hex::<16>()?;
        let now = now_millis();
        let expires_at = now.saturating_add(INVITE_TTL_MS);
        tx.execute(
            "INSERT INTO vault_invites(invite_id,vault_id,token_hash,role,created_by,created_at,expires_at,max_uses)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![invite_id, vault_id, token_hash(&token), role.as_str(), user_id, now, expires_at, max_uses],
        ).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(InviteCreated { id: invite_id, token, role: role.as_str().to_string(), expires_at, max_uses })
    }

    pub fn list_invites(&self, user_id: &str, vault_id: &str) -> Result<Vec<InviteView>, VaultError> {
        let db = self.db()?;
        require(&db, vault_id, user_id, Role::Admin)?;
        // `used_at` is set only once `uses` reaches `max_uses`, so "unused" here means uses < max_uses.
        let mut stmt = db.prepare(
            "SELECT invite_id,role,created_by,created_at,expires_at,max_uses,uses FROM vault_invites
             WHERE vault_id=?1 AND used_at IS NULL AND expires_at>?2 ORDER BY created_at,invite_id",
        ).map_err(db_err)?;
        let rows = stmt.query_map(params![vault_id, now_millis()], |r| {
            Ok(InviteView {
                id: r.get(0)?, role: r.get(1)?, created_by: r.get(2)?, created_at: r.get(3)?, expires_at: r.get(4)?,
                max_uses: r.get(5)?, uses: r.get(6)?,
            })
        }).map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    pub fn revoke_invite(&self, user_id: &str, vault_id: &str, invite_id: &str) -> Result<(), VaultError> {
        let db = self.db()?;
        require(&db, vault_id, user_id, Role::Admin)?;
        let removed = db.execute(
            "DELETE FROM vault_invites WHERE invite_id=?1 AND vault_id=?2 AND used_at IS NULL",
            params![invite_id, vault_id],
        ).map_err(db_err)?;
        if removed == 0 {
            return Err(VaultError::NotFound);
        }
        Ok(())
    }

    /// Public to any logged-in user who holds the token. The fragment key never reaches this code.
    pub fn invite_preview(&self, token: &str) -> Result<InvitePreview, VaultError> {
        let db = self.db()?;
        let row = find_invite(&db, token)?.ok_or(VaultError::NotFound)?;
        check_usable(&row, now_millis())?;
        let role = Role::parse(&row.role).ok_or(VaultError::Internal)?;
        let vault = vault_info(&db, &row.vault_id)?.ok_or(VaultError::NotFound)?;
        let vault = InviteVault { id: vault.id, name: vault.name, kind: vault.kind };
        Ok(InvitePreview { vault, role: role.as_str().to_string(), expires_at: row.expires_at, max_uses: row.max_uses, uses: row.uses })
    }

    /// `key_epoch` is the vault epoch the client joined with; a rotation since the invite was made is refused.
    pub fn accept_invite(&self, user_id: &str, token: &str, wrapped_key: &Envelope, key_epoch: i64) -> Result<VaultView, VaultError> {
        let key_json = wrapped_key_json(wrapped_key)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        let row = find_invite(&tx, token)?.ok_or(VaultError::NotFound)?;
        let now = now_millis();
        check_usable(&row, now)?;
        let current_epoch = vault_key_epoch(&tx, &row.vault_id)?;
        if current_epoch != key_epoch {
            return Err(VaultError::Gone("Zaproszenie wygasło po zmianie klucza."));
        }
        if member_role(&tx, &row.vault_id, user_id)?.is_some() {
            return Err(VaultError::Conflict("Jesteś już członkiem tego sejfu."));
        }
        let role = Role::parse(&row.role).ok_or(VaultError::Internal)?;
        tx.execute(
            "INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,wrapped_key_epoch,added_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![row.vault_id, user_id, role.as_str(), key_json, current_epoch, now],
        ).map_err(db_err)?;
        // `used_at` marks the invite as exhausted (last join), which keeps the signup check in auth.rs correct.
        tx.execute(
            "UPDATE vault_invites SET uses=uses+1, used_by=?1,
                used_at=CASE WHEN uses+1>=max_uses THEN ?2 ELSE NULL END
             WHERE token_hash=?3",
            params![user_id, now, token_hash(token)],
        ).map_err(db_err)?;
        let info = vault_info(&tx, &row.vault_id)?.ok_or(VaultError::NotFound)?;
        tx.commit().map_err(db_err)?;
        Ok(VaultView { info, role: role.as_str().to_string() })
    }

    /// Admins may change only editors and viewers, and only to editor or viewer. Owners may set any role.
    /// Serialized with puts for this vault (see `VaultLocks`), so the role change is visible to every later put.
    pub fn set_member_role(&self, actor_id: &str, vault_id: &str, target_id: &str, role_text: &str) -> Result<MemberView, VaultError> {
        self.locks.with(vault_id, || -> Result<MemberView, VaultError> {
            let new_role = Role::parse(role_text).ok_or(VaultError::Invalid("Nieznana rola."))?;
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
            let actor = require(&tx, vault_id, actor_id, Role::Admin)?;
            let target = member_role(&tx, vault_id, target_id)?.ok_or(VaultError::NotFound)?;
            if actor < Role::Owner && (target > Role::Editor || new_role > Role::Editor) {
                return Err(VaultError::Forbidden("Administrator może zmieniać role tylko edytorów i czytelników."));
            }
            if target == Role::Owner && new_role != Role::Owner && owner_count(&tx, vault_id)? <= 1 {
                return Err(VaultError::Conflict("Sejf musi mieć co najmniej jednego właściciela."));
            }
            tx.execute(
                "UPDATE vault_members SET role=?1 WHERE vault_id=?2 AND user_id=?3",
                params![new_role.as_str(), vault_id, target_id],
            ).map_err(db_err)?;
            let member = member_view(&tx, vault_id, target_id)?;
            tx.commit().map_err(db_err)?;
            Ok(member)
        })
    }

    /// Members may leave on their own. Admins may remove editors and viewers; owners may remove anyone.
    /// Any removal sets `needsRotation`: the removed member still holds the current vault key.
    pub fn remove_member(&self, actor_id: &str, vault_id: &str, target_id: &str) -> Result<(), VaultError> {
        self.remove(Some(actor_id), vault_id, target_id)
    }

    /// The server admin removes a member (docs/PANEL-ADMINA.md): anyone but an owner, by the same steps.
    pub fn remove_member_by_server(&self, vault_id: &str, target_id: &str) -> Result<(), VaultError> {
        self.remove(None, vault_id, target_id)
    }

    fn remove(&self, actor_id: Option<&str>, vault_id: &str, target_id: &str) -> Result<(), VaultError> {
        self.locks.with(vault_id, || -> Result<(), VaultError> {
            let mut db = self.db()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
            let actor = match actor_id {
                Some(id) => member_role(&tx, vault_id, id)?.ok_or(VaultError::NotFound)?,
                None => Role::Admin,
            };
            let target = member_role(&tx, vault_id, target_id)?.ok_or(VaultError::NotFound)?;
            if actor_id.is_none() && target == Role::Owner {
                return Err(VaultError::Conflict("Właściciela sejfu nie można usunąć."));
            }
            if actor_id.is_some_and(|id| id != target_id) {
                if actor < Role::Admin {
                    return Err(VaultError::Forbidden("Brak uprawnień do tej operacji."));
                }
                if actor < Role::Owner && target > Role::Editor {
                    return Err(VaultError::Forbidden("Administrator może usuwać tylko edytorów i czytelników."));
                }
            }
            if target == Role::Owner && owner_count(&tx, vault_id)? <= 1 {
                return Err(VaultError::Conflict("Sejf musi mieć co najmniej jednego właściciela."));
            }
            tx.execute(
                "DELETE FROM vault_members WHERE vault_id=?1 AND user_id=?2",
                params![vault_id, target_id],
            ).map_err(db_err)?;
            // the member's chats lose the vault with them (their access is computed from this membership)
            tx.execute(
                "DELETE FROM agent_keys WHERE vault_id=?1 AND agent_id IN (SELECT agent_id FROM agents WHERE user_id=?2)",
                params![vault_id, target_id],
            ).map_err(db_err)?;
            // and for good: joining again never hands the vault back to an old chat (it needs a new cert from the person)
            tx.execute(
                "DELETE FROM agent_scopes WHERE vault_id=?1 AND agent_id IN (SELECT agent_id FROM agents WHERE user_id=?2)",
                params![vault_id, target_id],
            ).map_err(db_err)?;
            // their chats' proposals there too: no one else may read them, and a return must not bring them back
            tx.execute("DELETE FROM agent_proposals WHERE vault_id=?1 AND user_id=?2", params![vault_id, target_id]).map_err(db_err)?;
            tx.execute("UPDATE vaults SET needs_rotation=1 WHERE vault_id=?1", [vault_id]).map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            Ok(())
        })
    }

    /// Starts key epoch `key_epoch` (must be current + 1). `keys` seals the new vault key to each member and must
    /// cover exactly the current members. Unused invites are revoked, since their links carry the old key.
    pub fn rotate(&self, actor_id: &str, vault_id: &str, key_epoch: i64, keys: &[(String, Value)]) -> Result<VaultInfo, VaultError> {
        self.rotate_with_agents(actor_id, vault_id, key_epoch, keys, &[])
    }

    /// `rotate`, plus `agent_keys`: the new key sealed for every unrevoked chat of a remaining member whose cert has
    /// this vault (exactly those, else a conflict), stored for the chats under the new epoch.
    /// Under the vault lock, so a put that passed the epoch check has committed before the new epoch exists.
    pub fn rotate_with_agents(&self, actor_id: &str, vault_id: &str, key_epoch: i64, keys: &[(String, Value)], agent_keys: &[(String, Value)]) -> Result<VaultInfo, VaultError> {
        self.locks.with(vault_id, || self.rotate_locked(actor_id, vault_id, key_epoch, keys, agent_keys))
    }

    fn rotate_locked(&self, actor_id: &str, vault_id: &str, key_epoch: i64, keys: &[(String, Value)], agent_keys: &[(String, Value)]) -> Result<VaultInfo, VaultError> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        require(&tx, vault_id, actor_id, Role::Admin)?;
        let current = vault_key_epoch(&tx, vault_id)?;
        if current.checked_add(1) != Some(key_epoch) {
            return Err(VaultError::Conflict("Nieprawidłowy numer epoki klucza."));
        }
        let members: BTreeSet<String> = {
            let mut stmt = tx.prepare("SELECT user_id FROM vault_members WHERE vault_id=?1").map_err(db_err)?;
            let rows = stmt.query_map([vault_id], |r| r.get(0)).map_err(db_err)?;
            rows.collect::<Result<BTreeSet<String>, _>>().map_err(db_err)?
        };
        let listed: BTreeSet<&str> = keys.iter().map(|(user_id, _)| user_id.as_str()).collect();
        if listed.len() != keys.len() || listed.len() != members.len() || !members.iter().all(|m| listed.contains(m.as_str())) {
            return Err(VaultError::Conflict("Klucz trzeba przygotować dla dokładnie obecnych członków sejfu."));
        }
        let sealed = keys
            .iter()
            .map(|(user_id, sealed_key)| -> Result<(&str, String), VaultError> {
                Ok((user_id.as_str(), sealed_key_json(sealed_key)?))
            })
            .collect::<Result<Vec<_>, VaultError>>()?;
        for (user_id, json) in sealed {
            tx.execute(
                "UPDATE vault_members SET pending_key=?1, pending_key_epoch=?2 WHERE vault_id=?3 AND user_id=?4",
                params![json, key_epoch, vault_id, user_id],
            ).map_err(db_err)?;
        }
        crate::agents::store_rotated_keys(&tx, vault_id, key_epoch, agent_keys)?;
        tx.execute("DELETE FROM vault_invites WHERE vault_id=?1 AND used_at IS NULL", [vault_id]).map_err(db_err)?;
        tx.execute(
            "UPDATE vaults SET key_epoch=?1, needs_rotation=0 WHERE vault_id=?2",
            params![key_epoch, vault_id],
        ).map_err(db_err)?;
        let info = vault_info(&tx, vault_id)?.ok_or(VaultError::NotFound)?;
        tx.commit().map_err(db_err)?;
        Ok(info)
    }

    /// A member stores their copy of the vault key for `key_epoch`, which must be the current epoch.
    /// Clears their pending key. Returns the epoch.
    pub fn set_my_key(&self, user_id: &str, vault_id: &str, key_epoch: i64, wrapped_key: &Envelope) -> Result<i64, VaultError> {
        let key_json = wrapped_key_json(wrapped_key)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_err)?;
        require(&tx, vault_id, user_id, Role::Viewer)?;
        let current = vault_key_epoch(&tx, vault_id)?;
        if current != key_epoch {
            return Err(VaultError::Conflict("Podany numer epoki klucza jest nieaktualny."));
        }
        tx.execute(
            "UPDATE vault_members SET wrapped_key=?1, wrapped_key_epoch=?2, pending_key=NULL, pending_key_epoch=NULL
             WHERE vault_id=?3 AND user_id=?4",
            params![key_json, current, vault_id, user_id],
        ).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(current)
    }
}

fn db_err<E>(_: E) -> VaultError {
    VaultError::Internal
}

fn member_role(conn: &Connection, vault_id: &str, user_id: &str) -> Result<Option<Role>, VaultError> {
    let text: Option<String> = conn.query_row(
        "SELECT role FROM vault_members WHERE vault_id=?1 AND user_id=?2",
        params![vault_id, user_id],
        |r| r.get(0),
    ).optional().map_err(db_err)?;
    Ok(text.as_deref().and_then(Role::parse))
}

/// Returns the caller's role. Non-members get 404 (no existence leak); members below `min` get 403.
fn require(conn: &Connection, vault_id: &str, user_id: &str, min: Role) -> Result<Role, VaultError> {
    let role = member_role(conn, vault_id, user_id)?.ok_or(VaultError::NotFound)?;
    if role < min {
        return Err(VaultError::Forbidden("Brak uprawnień do tej operacji."));
    }
    Ok(role)
}

fn owner_count(conn: &Connection, vault_id: &str) -> Result<i64, VaultError> {
    conn.query_row(
        "SELECT COUNT(*) FROM vault_members WHERE vault_id=?1 AND role='owner'",
        [vault_id],
        |r| r.get(0),
    ).map_err(db_err)
}

fn vault_info(conn: &Connection, vault_id: &str) -> Result<Option<VaultInfo>, VaultError> {
    conn.query_row(
        "SELECT vault_id,name,kind,owner_user_id,key_epoch FROM vaults WHERE vault_id=?1",
        [vault_id],
        |r| Ok(VaultInfo {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            owner_user_id: r.get(3)?,
            key_epoch: r.get(4)?,
        }),
    ).optional().map_err(db_err)
}

/// The vault's current key epoch, or `NotFound` for an unknown vault.
fn vault_key_epoch(conn: &Connection, vault_id: &str) -> Result<i64, VaultError> {
    conn.query_row("SELECT key_epoch FROM vaults WHERE vault_id=?1", [vault_id], |r| r.get(0))
        .optional()
        .map_err(db_err)?
        .ok_or(VaultError::NotFound)
}

/// Used for the admin's own view after a role change, so the email is included.
fn member_view(conn: &Connection, vault_id: &str, user_id: &str) -> Result<MemberView, VaultError> {
    conn.query_row(
        "SELECT m.user_id,u.email,u.display_name,m.role,m.added_at,k.public_jwk,b.public_jwk,m.profile FROM vault_members m
         JOIN web_users u ON u.user_id=m.user_id
         LEFT JOIN user_signing_keys k ON k.user_id=m.user_id
         LEFT JOIN user_box_keys b ON b.user_id=m.user_id
         WHERE m.vault_id=?1 AND m.user_id=?2",
        params![vault_id, user_id],
        member_from_row,
    ).map_err(db_err)
}

/// Columns 5 and 6 are the member's stored signing and box public JWKs, column 7 their card (JSON text, or NULL).
fn member_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemberView> {
    Ok(MemberView {
        user_id: r.get(0)?,
        email: Some(r.get(1)?),
        name: r.get(2)?,
        role: r.get(3)?,
        added_at: r.get(4)?,
        signing_key: json_column(r, 5)?,
        box_key: json_column(r, 6)?,
        profile: json_column(r, 7)?,
        agents: None,
    })
}

/// A column holding JSON text, or NULL when unset.
fn json_column(r: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<Value>> {
    r.get::<_, Option<String>>(index)?
        .map(|text| serde_json::from_str(&text))
        .transpose()
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e)))
}

/// Adds `column` to `table` when an older database lacks it. `PRAGMA table_info` makes this safe to run on every start.
/// Adds the column unless the table has it already. True when it was added.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<bool, VaultError> {
    let names: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get(1)).map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)?
    };
    if names.iter().any(|name| name == column) {
        return Ok(false);
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}")).map_err(db_err)?;
    Ok(true)
}

/// Shape check for a sealed box (`notes-sealed-v1`). Returns the normalized JSON text, which keeps only the
/// known fields. The server cannot open the box.
fn sealed_key_json(value: &Value) -> Result<String, VaultError> {
    let bad = || VaultError::Invalid("Nieprawidłowy zaszyfrowany klucz.");
    let raw = serde_json::to_string(value).map_err(|_| bad())?;
    if raw.len() > SEALED_JSON_MAX_BYTES {
        return Err(bad());
    }
    let obj = value.as_object().ok_or_else(bad)?;
    if obj.get("schema").and_then(Value::as_str) != Some(SEALED_SCHEMA) {
        return Err(bad());
    }
    let (_, epk) = canonical_public_jwk(obj.get("epk").unwrap_or(&Value::Null)).map_err(|_| bad())?;
    let nonce = obj.get("nonce").and_then(Value::as_str).ok_or_else(bad)?;
    let ciphertext = obj.get("ciphertext").and_then(Value::as_str).ok_or_else(bad)?;
    let nonce_ok = canonical_base64(nonce).is_some_and(|bytes| bytes.len() == 12);
    let ciphertext_ok = ciphertext.len() <= 4096 && canonical_base64(ciphertext).is_some_and(|bytes| bytes.len() >= 16);
    if !nonce_ok || !ciphertext_ok {
        return Err(bad());
    }
    serde_json::to_string(&json!({
        "schema": SEALED_SCHEMA,
        "epk": epk,
        "nonce": nonce,
        "ciphertext": ciphertext,
    }))
    .map_err(|_| bad())
}

/// Decodes standard base64 only when re-encoding gives back the same text (no lax padding or alphabet).
pub(crate) fn canonical_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = BASE64.decode(text).ok()?;
    (BASE64.encode(&bytes) == text).then_some(bytes)
}

/// Checks a client-supplied public JWK and returns `(canonical JSON text, normalized JWK)`. Only kty/crv/x/y are kept.
pub(crate) fn canonical_public_jwk(value: &Value) -> Result<(String, Value), VaultError> {
    let bad = || VaultError::Invalid("Nieprawidłowy klucz podpisu.");
    let raw = serde_json::to_string(value).map_err(|_| bad())?;
    if raw.len() > SIGNING_JWK_MAX_BYTES {
        return Err(VaultError::Invalid("Klucz podpisu jest za duży."));
    }
    let obj = value.as_object().ok_or_else(bad)?;
    if obj.contains_key("d") {
        return Err(VaultError::Invalid("Klucz podpisu nie może zawierać części prywatnej."));
    }
    if obj.get("kty").and_then(Value::as_str) != Some("EC") || obj.get("crv").and_then(Value::as_str) != Some("P-256") {
        return Err(bad());
    }
    let coord = |name: &str| -> Result<&str, VaultError> {
        let text = obj.get(name).and_then(Value::as_str).ok_or_else(bad)?;
        let decoded = BASE64URL.decode(text).map_err(|_| bad())?;
        if text.len() != P256_COORD_CHARS || decoded.len() != 32 {
            return Err(bad());
        }
        Ok(text)
    };
    let jwk = json!({ "kty": "EC", "crv": "P-256", "x": coord("x")?, "y": coord("y")? });
    let canonical = serde_json::to_string(&jwk).map_err(|_| bad())?;
    Ok((canonical, jwk))
}

fn find_invite(conn: &Connection, token: &str) -> Result<Option<InviteRow>, VaultError> {
    if !valid_token(token) {
        return Ok(None);
    }
    conn.query_row(
        "SELECT vault_id,role,expires_at,used_at,max_uses,uses FROM vault_invites WHERE token_hash=?1",
        [token_hash(token)],
        |r| Ok(InviteRow {
            vault_id: r.get(0)?, role: r.get(1)?, expires_at: r.get(2)?, used_at: r.get(3)?,
            max_uses: r.get(4)?, uses: r.get(5)?,
        }),
    ).optional().map_err(db_err)
}

fn check_usable(row: &InviteRow, now: i64) -> Result<(), VaultError> {
    if row.used_at.is_some() {
        Err(VaultError::Gone("Zaproszenie zostało już użyte."))
    } else if row.expires_at <= now {
        Err(VaultError::Gone("Zaproszenie wygasło."))
    } else {
        Ok(())
    }
}

fn clean_name(name: &str) -> Result<String, VaultError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(VaultError::Invalid("Nazwa sejfu musi mieć od 1 do 120 znaków."));
    }
    Ok(name.to_string())
}

fn wrapped_key_json(key: &Envelope) -> Result<String, VaultError> {
    validate_wrapped_key(key)?;
    serde_json::to_string(key).map_err(db_err)
}

const PROFILE_SCHEMA: &str = "notes-profile-v1";
const PROFILE_CIPHERTEXT_MAX_BYTES: usize = 1024;

/// Shape check for a member's card (`notes-profile-v1`): exactly these four fields. Returns the normalized JSON text.
fn profile_json(value: &Value) -> Result<String, VaultError> {
    let bad = || VaultError::Invalid("Nieprawidłowe dane profilu.");
    let obj = value.as_object().ok_or_else(bad)?;
    let key_epoch = obj.get("keyEpoch").and_then(Value::as_i64).filter(|epoch| *epoch >= 1).ok_or_else(bad)?;
    let nonce = obj.get("nonce").and_then(Value::as_str).ok_or_else(bad)?;
    let ciphertext = obj.get("ciphertext").and_then(Value::as_str).ok_or_else(bad)?;
    if obj.len() != 4 || obj.get("schema").and_then(Value::as_str) != Some(PROFILE_SCHEMA) {
        return Err(bad());
    }
    let nonce_ok = canonical_base64(nonce).is_some_and(|bytes| bytes.len() == 12);
    let ciphertext_ok = canonical_base64(ciphertext).is_some_and(|bytes| (16..=PROFILE_CIPHERTEXT_MAX_BYTES).contains(&bytes.len()));
    if !nonce_ok || !ciphertext_ok {
        return Err(bad());
    }
    serde_json::to_string(&json!({
        "schema": PROFILE_SCHEMA,
        "keyEpoch": key_epoch,
        "nonce": nonce,
        "ciphertext": ciphertext,
    }))
    .map_err(db_err)
}

/// Shape check only: the server cannot decrypt the key.
pub(crate) fn validate_wrapped_key(key: &Envelope) -> Result<(), VaultError> {
    let bad = || VaultError::Invalid("Nieprawidłowy klucz sejfu.");
    if key.schema != KEY_SCHEMA || key.ciphertext.len() > 4096 {
        return Err(bad());
    }
    let nonce = BASE64.decode(&key.nonce).map_err(|_| bad())?;
    let ciphertext = BASE64.decode(&key.ciphertext).map_err(|_| bad())?;
    if nonce.len() != 12
        || ciphertext.len() < 16
        || BASE64.encode(&nonce) != key.nonce
        || BASE64.encode(&ciphertext) != key.ciphertext
    {
        return Err(bad());
    }
    Ok(())
}

fn random_hex<const N: usize>() -> Result<String, VaultError> {
    let bytes = notes_sync::random::<N>().map_err(|_| VaultError::Internal)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// `NOTES_MAX_VAULTS`: shared vaults one account may own (default 20).
fn max_vaults() -> i64 {
    std::env::var("NOTES_MAX_VAULTS").ok().and_then(|v| v.parse().ok()).unwrap_or(20)
}

fn token_hash(token: &str) -> String {
    blake3::hash(token.as_bytes()).to_hex().to_string()
}

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

/// Shared state for the vault REST handlers.
struct Api {
    auth: Arc<AuthService>,
    vaults: Arc<VaultService>,
    sync: Arc<BrowserSync>,
    files: Arc<FileService>,
}

pub fn routes(auth: Arc<AuthService>, vaults: Arc<VaultService>, sync: Arc<BrowserSync>, files: Arc<FileService>) -> Router {
    Router::new()
        .route("/api/me/signing-key", get(read_signing_key).put(write_signing_key))
        .route("/api/me/box-key", get(read_box_key).put(write_box_key))
        .route("/api/me/personal-key", get(read_personal_keys).put(write_personal_key))
        .route("/api/vaults", get(list_vaults).post(create_vault))
        .route("/api/vaults/{id}", get(get_vault).patch(rename_vault).delete(delete_vault))
        .route("/api/vaults/{id}/invites", get(list_invites).post(create_invite))
        .route("/api/vaults/{id}/invites/{invite_id}", delete(revoke_invite))
        .route("/api/vaults/{id}/members/{user_id}", patch(set_member_role).delete(remove_member))
        .route("/api/vaults/{id}/rotate", post(rotate_vault))
        .route("/api/vaults/{id}/my-key", put(write_my_key))
        .route("/api/vaults/{id}/my-profile", put(write_my_profile))
        .route("/api/vaults/{id}/assignments", get(list_assignments))
        .route("/api/vaults/{id}/assignments/{user_id}/complete", post(complete_assignment))
        .route("/api/invites/accept", post(accept_invite))
        .route("/api/invites/{token}", get(invite_preview))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Arc::new(Api { auth, vaults, sync, files }))
}

/// Runs `work` on the blocking pool after the session check. Mutations also need a same-origin request.
async fn run<T, F>(api: Arc<Api>, headers: HeaderMap, mutating: bool, work: F) -> Response
where
    T: IntoResponse,
    F: FnOnce(&Api, AuthUser) -> Result<T, VaultError> + Send + 'static,
{
    let user = match authorize(api.auth.clone(), headers, mutating).await {
        Ok(user) => user,
        Err(Refused::Origin) => return VaultError::Forbidden(FOREIGN_REQUEST).into_response(),
        Err(Refused::Session) => return VaultError::Unauthorized.into_response(),
        Err(Refused::Internal) => return VaultError::Internal.into_response(),
    };
    let result = tokio::task::spawn_blocking(move || work(api.as_ref(), user).map(IntoResponse::into_response)).await;
    match result {
        Ok(Ok(response)) => no_store(response),
        Ok(Err(e)) => e.into_response(),
        Err(_) => VaultError::Internal.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateVault {
    name: String,
    kind: String,
    wrapped_key: Envelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyPairBody {
    public_jwk: Value,
    wrapped_private: Envelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RotateBody {
    key_epoch: i64,
    keys: Vec<RotateKey>,
    #[serde(default)]
    agent_keys: Vec<AgentKey>,
}

/// A new vault key sealed for one chat (`notes-agent-sealed-v1`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentKey {
    agent_id: String,
    sealed_key: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonalKeyBody {
    key_epoch: i64,
    wrapped_key: Envelope,
    #[serde(default)]
    agent_keys: Vec<AgentKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RotateKey {
    user_id: String,
    sealed_key: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyKeyBody {
    key_epoch: i64,
    wrapped_key: Envelope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteBody {
    /// The vault key sealed to the person's box key (`notes-sealed-v1`).
    #[serde(alias = "wrappedKey")]
    sealed_key: Value,
    key_epoch: i64,
}

#[derive(Deserialize)]
struct ProfileBody {
    profile: Option<Value>,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

#[derive(Deserialize)]
struct RoleBody {
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteBody {
    role: String,
    max_uses: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptBody {
    token: String,
    wrapped_key: Envelope,
    key_epoch: i64,
}

async fn read_signing_key(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    run(api, headers, false, |api, user| {
        Ok(Json(api.vaults.signing_key(&user.id)?))
    }).await
}

async fn write_signing_key(State(api): State<Arc<Api>>, headers: HeaderMap, Json(input): Json<KeyPairBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let public_jwk = api.vaults.set_signing_key(&user.id, &input.public_jwk, &input.wrapped_private)?;
        Ok(Json(json!({ "publicJwk": public_jwk })))
    }).await
}

async fn read_box_key(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    run(api, headers, false, |api, user| {
        Ok(Json(api.vaults.box_key(&user.id)?))
    }).await
}

async fn write_box_key(State(api): State<Arc<Api>>, headers: HeaderMap, Json(input): Json<KeyPairBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let public_jwk = api.vaults.set_box_key(&user.id, &input.public_jwk, &input.wrapped_private)?;
        Ok(Json(json!({ "publicJwk": public_jwk })))
    }).await
}

async fn read_personal_keys(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    run(api, headers, false, |api, user| {
        let keys: Vec<Value> = api.vaults.personal_keys(&user.id)?.into_iter().map(|(epoch, key, created_at)| json!({ "keyEpoch": epoch, "wrappedKey": key, "createdAt": created_at })).collect();
        Ok(Json(json!({ "keys": keys })))
    }).await
}

async fn write_personal_key(State(api): State<Arc<Api>>, headers: HeaderMap, Json(input): Json<PersonalKeyBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let agent_keys: Vec<(String, Value)> = input.agent_keys.into_iter().map(|k| (k.agent_id, k.sealed_key)).collect();
        let key_epoch = api.vaults.add_personal_key_with_agents(&user.id, input.key_epoch, &input.wrapped_key, &agent_keys)?;
        api.sync.notify_personal_rekey(&user.id, key_epoch);
        crate::audit::event("personal_key_set", &[("by", &user.id), ("epoch", &key_epoch.to_string())]);
        Ok(Json(json!({ "keyEpoch": key_epoch })))
    }).await
}

async fn rotate_vault(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<RotateBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let keys: Vec<(String, Value)> = input.keys.into_iter().map(|k| (k.user_id, k.sealed_key)).collect();
        let agent_keys: Vec<(String, Value)> = input.agent_keys.into_iter().map(|k| (k.agent_id, k.sealed_key)).collect();
        let vault = api.vaults.rotate_with_agents(&user.id, &id, input.key_epoch, &keys, &agent_keys)?;
        api.sync.notify_rekey(&id, vault.key_epoch);
        crate::audit::event("key_rotated", &[("vault", &id), ("by", &user.id), ("epoch", &vault.key_epoch.to_string())]);
        Ok(Json(json!({ "vault": vault })))
    }).await
}

async fn write_my_key(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<MyKeyBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let key_epoch = api.vaults.set_my_key(&user.id, &id, input.key_epoch, &input.wrapped_key)?;
        Ok(Json(json!({ "keyEpoch": key_epoch })))
    }).await
}

async fn write_my_profile(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<ProfileBody>) -> Response {
    run(api, headers, true, move |api, user| {
        api.vaults.set_my_profile(&user.id, &id, input.profile.as_ref())?;
        Ok(StatusCode::NO_CONTENT)
    }).await
}

async fn list_assignments(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    run(api, headers, false, move |api, user| {
        Ok(Json(api.vaults.assignments(&user.id, &id)?))
    }).await
}

async fn complete_assignment(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, target)): AxumPath<(String, String)>, Json(input): Json<CompleteBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let vault = api.vaults.complete_assignment(&user.id, &id, &target, &input.sealed_key, input.key_epoch)?;
        api.sync.notify_access(&id, &target, Some(vault.role.clone()));
        crate::audit::event("assignment_completed", &[("vault", &id), ("by", &user.id), ("member", &target), ("role", &vault.role)]);
        Ok(Json(json!({ "vault": vault })))
    }).await
}

async fn list_vaults(State(api): State<Arc<Api>>, headers: HeaderMap) -> Response {
    run(api, headers, false, |api, user| {
        Ok(Json(json!({ "vaults": api.vaults.list(&user.id)? })))
    }).await
}

async fn create_vault(State(api): State<Arc<Api>>, headers: HeaderMap, Json(input): Json<CreateVault>) -> Response {
    run(api, headers, true, move |api, user| {
        // An account made from an invite link alone has no say of its own on this server until the server admin agrees
        // (the same consent as for its own notes, docs/PANEL-ADMINA.md): it joins organizations, it does not found them.
        if user.personal != "allowed" {
            return Err(VaultError::Forbidden("Zakładanie organizacji wymaga zgody administratora serwera. Poproś o nią w Ustawieniach → „Poproś o własne notatki”."));
        }
        let vault = api.vaults.create(&user.id, &input.name, &input.kind, &input.wrapped_key)?;
        crate::audit::event("vault_created", &[("vault", &vault.info.id), ("by", &user.id)]);
        Ok((StatusCode::CREATED, Json(json!({ "vault": vault }))))
    }).await
}

async fn get_vault(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    run(api, headers, false, move |api, user| {
        Ok(Json(api.vaults.detail(&user.id, &id)?))
    }).await
}

async fn rename_vault(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<NameBody>) -> Response {
    run(api, headers, true, move |api, user| {
        Ok(Json(json!({ "vault": api.vaults.rename(&user.id, &id, &input.name)? })))
    }).await
}

async fn delete_vault(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<NameBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let members = api.vaults.delete_vault(&user.id, &id, &input.name)?;
        crate::audit::event("vault_deleted", &[("vault", &id), ("by", &user.id), ("members", &members.len().to_string())]);
        // The vault is gone for everyone already; what fails or is cut short here is finished at the next start.
        finish_deletion(&api.sync, &api.files, &id);
        for member in &members { api.sync.notify_access(&id, member, None); }
        Ok(StatusCode::NO_CONTENT)
    }).await
}

/// The snapshot and the files of a deleted vault go. Only ids in `deleted_vaults` are passed here, so a vault table
/// restored from an older backup never makes live vaults look deleted. Runs after delete_vault and, for every
/// deleted vault, at each start (run.rs open_services); both steps are idempotent, so a failed one is simply rerun.
pub fn finish_deletion(sync: &BrowserSync, files: &FileService, vault_id: &str) {
    let snapshot = sync.drop_vault(vault_id);
    let file_rows = files.drop_vault(vault_id);
    if snapshot.is_err() || file_rows.is_err() {
        eprintln!("notes-node: dokończenie usunięcia sejfu nie powiodło się, ponowię przy następnym starcie");
    }
}

async fn list_invites(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>) -> Response {
    run(api, headers, false, move |api, user| {
        Ok(Json(json!({ "invites": api.vaults.list_invites(&user.id, &id)? })))
    }).await
}

async fn create_invite(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(id): AxumPath<String>, Json(input): Json<InviteBody>) -> Response {
    run(api, headers, true, move |api, user| {
        // Anything that is not an integer (a string, a float) becomes 0 and the service refuses it.
        let max_uses = match input.max_uses {
            None | Some(Value::Null) => 1,
            Some(value) => value.as_i64().unwrap_or(0),
        };
        let invite = api.vaults.create_invite_for(&user.id, &id, &input.role, max_uses)?;
        crate::audit::event("invite_created", &[("vault", &id), ("by", &user.id), ("role", &input.role)]);
        Ok((StatusCode::CREATED, Json(json!({ "invite": invite }))))
    }).await
}

async fn revoke_invite(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, invite_id)): AxumPath<(String, String)>) -> Response {
    run(api, headers, true, move |api, user| {
        api.vaults.revoke_invite(&user.id, &id, &invite_id)?;
        crate::audit::event("invite_revoked", &[("vault", &id), ("by", &user.id)]);
        Ok(StatusCode::NO_CONTENT)
    }).await
}

async fn invite_preview(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath(token): AxumPath<String>) -> Response {
    run(api, headers, false, move |api, _user| {
        Ok(Json(api.vaults.invite_preview(&token)?))
    }).await
}

async fn accept_invite(State(api): State<Arc<Api>>, headers: HeaderMap, Json(input): Json<AcceptBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let vault = api.vaults.accept_invite(&user.id, &input.token, &input.wrapped_key, input.key_epoch)?;
        crate::audit::event("invite_accepted", &[("vault", &vault.info.id), ("user", &user.id)]);
        Ok(Json(json!({ "vault": vault })))
    }).await
}

async fn set_member_role(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, target)): AxumPath<(String, String)>, Json(input): Json<RoleBody>) -> Response {
    run(api, headers, true, move |api, user| {
        let member = api.vaults.set_member_role(&user.id, &id, &target, &input.role)?;
        api.sync.notify_access(&id, &target, Some(member.role.clone()));
        crate::audit::event("role_changed", &[("vault", &id), ("by", &user.id), ("member", &target), ("role", &member.role)]);
        Ok(Json(json!({ "member": member })))
    }).await
}

async fn remove_member(State(api): State<Arc<Api>>, headers: HeaderMap, AxumPath((id, target)): AxumPath<(String, String)>) -> Response {
    run(api, headers, true, move |api, user| {
        api.vaults.remove_member(&user.id, &id, &target)?;
        api.files.revoke_member(&id, &target).map_err(|_| VaultError::Internal)?;
        api.sync.notify_access(&id, &target, None);
        crate::audit::event("member_removed", &[("vault", &id), ("by", &user.id), ("member", &target)]);
        Ok(StatusCode::NO_CONTENT)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_services() -> (Arc<AuthService>, Arc<VaultService>, Arc<BrowserSync>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let auth = Arc::new(AuthService::open(dir.path()).unwrap());
        let locks = Arc::new(VaultLocks::default());
        let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
        let sync = Arc::new(BrowserSync::open(dir.path(), vaults.clone(), locks).unwrap());
        (auth, vaults, sync, dir)
    }

    fn user(auth: &AuthService, email: &str) -> String {
        auth.register(email, "A long test password 1").unwrap().0.id
    }

    fn key() -> Envelope {
        Envelope {
            schema: KEY_SCHEMA.into(),
            nonce: BASE64.encode([7u8; 12]),
            ciphertext: BASE64.encode([9u8; 48]),
            key_epoch: None,
        }
    }

    /// A well-formed sealed box whose ciphertext differs per `seed`.
    fn sealed(seed: u8) -> Value {
        json!({
            "schema": SEALED_SCHEMA,
            "epk": jwk(seed),
            "nonce": BASE64.encode([seed; 12]),
            "ciphertext": BASE64.encode([seed; 48]),
        })
    }

    fn status(error: VaultError) -> StatusCode {
        error.into_response().status()
    }

    fn jwk(seed: u8) -> Value {
        json!({
            "kty": "EC",
            "crv": "P-256",
            "x": BASE64URL.encode([seed; 32]),
            "y": BASE64URL.encode([seed.wrapping_add(1); 32]),
        })
    }

    #[test]
    fn signing_key_is_stored_once_and_shown_to_members() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
        vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap();

        assert_eq!(status(vaults.signing_key(&owner).unwrap_err()), StatusCode::NOT_FOUND);
        assert_eq!(vaults.set_signing_key(&owner, &jwk(1), &key()).unwrap(), jwk(1));
        let stored = vaults.signing_key(&owner).unwrap();
        assert_eq!(stored.public_jwk, jwk(1));
        assert_eq!(stored.wrapped_private, key());

        let detail = vaults.detail(&guest, &vault).unwrap();
        let owner_view = detail.members.iter().find(|m| m.user_id == owner).unwrap();
        assert_eq!(owner_view.signing_key, Some(jwk(1)));
        let guest_view = detail.members.iter().find(|m| m.user_id == guest).unwrap();
        assert_eq!(guest_view.signing_key, None);
        let wire = serde_json::to_value(&detail).unwrap();
        // both joined within the same millisecond, so their order comes from the random ids: look them up by id
        let member = |id: &str| wire["members"].as_array().unwrap().iter().find(|m| m["userId"] == id).unwrap().clone();
        assert_eq!(member(&owner)["signingKey"], jwk(1));
        assert!(member(&guest)["signingKey"].is_null());
    }

    #[test]
    fn same_signing_key_is_idempotent_and_a_different_one_conflicts() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        vaults.set_signing_key(&owner, &jwk(1), &key()).unwrap();
        let mut with_extras = jwk(1);
        with_extras["kid"] = json!("device-1");
        assert_eq!(vaults.set_signing_key(&owner, &with_extras, &key()).unwrap(), jwk(1));
        assert_eq!(status(vaults.set_signing_key(&owner, &jwk(2), &key()).unwrap_err()), StatusCode::CONFLICT);
        assert_eq!(vaults.signing_key(&owner).unwrap().public_jwk, jwk(1));
    }

    #[test]
    fn invalid_signing_keys_are_rejected_and_not_stored() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let mut with_private = jwk(1);
        with_private["d"] = json!(BASE64URL.encode([3u8; 32]));
        let wrong_curve = json!({ "kty": "EC", "crv": "P-384", "x": jwk(1)["x"], "y": jwk(1)["y"] });
        let mut oversized = jwk(1);
        oversized["pad"] = json!("x".repeat(SIGNING_JWK_MAX_BYTES));
        let short_coord = json!({ "kty": "EC", "crv": "P-256", "x": "A".repeat(42), "y": jwk(1)["y"] });
        let padded_coord = json!({ "kty": "EC", "crv": "P-256", "x": format!("{}=", "A".repeat(42)), "y": jwk(1)["y"] });
        let not_object = json!("EC");
        for bad in [with_private, wrong_curve, oversized, short_coord, padded_coord, not_object] {
            assert_eq!(status(vaults.set_signing_key(&owner, &bad, &key()).unwrap_err()), StatusCode::BAD_REQUEST);
        }
        let bad_wrapped = Envelope { schema: "inny".into(), ..key() };
        assert_eq!(status(vaults.set_signing_key(&owner, &jwk(1), &bad_wrapped).unwrap_err()), StatusCode::BAD_REQUEST);
        assert_eq!(status(vaults.signing_key(&owner).unwrap_err()), StatusCode::NOT_FOUND);
    }

    #[test]
    fn create_list_and_detail_for_owner() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let view = vaults.create(&owner, "  Zespół  ", "organizacja", &key()).unwrap();
        assert!(view.info.id.starts_with("v-"));
        assert_eq!(view.info.id.len(), 34);
        assert!(view.info.id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(view.info.name, "Zespół");
        assert_eq!(view.role, "owner");
        assert_eq!(vaults.list(&owner).unwrap().len(), 1);
        let detail = vaults.detail(&owner, &view.info.id).unwrap();
        assert_eq!(detail.wrapped_key, key());
        assert_eq!(detail.members.len(), 1);
        assert_eq!(detail.members[0].email.as_deref(), Some("owner@example.test"));
        assert!(matches!(vaults.create(&owner, "x", "inne", &key()), Err(VaultError::Invalid(_))));
        let bad_key = Envelope { nonce: BASE64.encode([1u8; 8]), ..key() };
        assert!(matches!(vaults.create(&owner, "x", "notatki", &bad_key), Err(VaultError::Invalid(_))));
    }

    #[test]
    fn member_emails_are_shown_to_admins_and_to_the_member_only() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let editor = user(&auth, "editor@example.test");
        let admin = user(&auth, "admin@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        vaults.create_invite(&owner, &vault, "editor").unwrap();
        for (who, role) in [(&editor, "editor"), (&admin, "admin")] {
            let db = vaults.db().unwrap();
            db.execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,?3,?4,0)",
                params![vault, who, role, serde_json::to_string(&key()).unwrap()]).unwrap();
        }
        let emails = |viewer: &str| -> Vec<Option<String>> {
            vaults.detail(viewer, &vault).unwrap().members.into_iter().map(|m| m.email).collect()
        };
        // a plain editor sees the co-members as names only, and their own email
        let seen_by_editor = emails(&editor);
        assert_eq!(seen_by_editor.iter().filter(|e| e.is_some()).collect::<Vec<_>>(), [&Some("editor@example.test".to_string())]);
        // an admin and the owner see every email
        assert!(emails(&admin).iter().all(Option::is_some));
        assert!(emails(&owner).iter().all(Option::is_some));
        // the JSON omits the key rather than sending null
        let view = vaults.detail(&editor, &vault).unwrap();
        let json = serde_json::to_value(&view.members).unwrap();
        let owner_row = json.as_array().unwrap().iter().find(|m| m["userId"] == owner.as_str()).unwrap();
        assert!(owner_row.get("email").is_none());
        // no last name in the member list; the card is null until the member saves one
        assert!(owner_row.get("lastName").is_none());
        assert_eq!(owner_row["profile"], Value::Null);
    }

    #[test]
    fn member_cards_are_shown_to_every_member_and_each_member_writes_only_their_own() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let viewer = user(&auth, "viewer@example.test");
        let outsider = user(&auth, "outsider@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        vaults.accept_invite(&viewer, &invite.token, &key(), 1).unwrap();
        let profile_of = |vaults: &VaultService, viewer_of: &str, vault: &str, member: &str| {
            vaults.detail(viewer_of, vault).unwrap().members.into_iter().find(|m| m.user_id == member).unwrap().profile
        };
        let card = |seed: u8| json!({
            "schema": PROFILE_SCHEMA,
            "keyEpoch": 1,
            "nonce": BASE64.encode([seed; 12]),
            "ciphertext": BASE64.encode([seed; 40]),
        });

        // a viewer may write their own card; the owner sees it, and the list has no lastName
        vaults.set_my_profile(&viewer, &vault, Some(&card(4))).unwrap();
        let detail = vaults.detail(&owner, &vault).unwrap();
        let viewer_row = detail.members.iter().find(|m| m.user_id == viewer).unwrap();
        assert_eq!(viewer_row.profile, Some(card(4)));
        assert_eq!(detail.members.iter().find(|m| m.user_id == owner).unwrap().profile, None);
        let wire = serde_json::to_value(&detail).unwrap();
        assert!(wire["members"].as_array().unwrap().iter().all(|m| m.get("lastName").is_none() && m.get("profile").is_some()));
        let viewer_wire = wire["members"].as_array().unwrap().iter().find(|m| m["userId"] == viewer.as_str()).unwrap();
        assert_eq!(viewer_wire["profile"], card(4));

        // a card replaces the old one; null removes it
        vaults.set_my_profile(&viewer, &vault, Some(&card(5))).unwrap();
        assert_eq!(profile_of(&vaults, &owner, &vault, &viewer), Some(card(5)));
        vaults.set_my_profile(&viewer, &vault, None).unwrap();
        assert_eq!(profile_of(&vaults, &owner, &vault, &viewer), None);

        // non-members get 404, bad envelopes 400 (and nothing is stored)
        assert_eq!(status(vaults.set_my_profile(&outsider, &vault, Some(&card(6))).unwrap_err()), StatusCode::NOT_FOUND);
        assert_eq!(status(vaults.set_my_profile(&outsider, "v-missing", None).unwrap_err()), StatusCode::NOT_FOUND);
        let mut wrong_schema = card(7);
        wrong_schema["schema"] = json!("notes-key-v1");
        let mut extra = card(7);
        extra["lastName"] = json!("Kowalska");
        let mut epoch_zero = card(7);
        epoch_zero["keyEpoch"] = json!(0);
        let mut huge = card(7);
        huge["ciphertext"] = json!(BASE64.encode(vec![7u8; 1025]));
        let mut short_nonce = card(7);
        short_nonce["nonce"] = json!(BASE64.encode([7u8; 11]));
        for bad in [wrong_schema, extra, epoch_zero, huge, short_nonce, json!("x")] {
            assert_eq!(status(vaults.set_my_profile(&viewer, &vault, Some(&bad)).unwrap_err()), StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(profile_of(&vaults, &owner, &vault, &viewer), None);
    }

    #[test]
    fn invite_preview_names_the_vault_and_nothing_about_its_members() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        let text = serde_json::to_string(&vaults.invite_preview(&invite.token).unwrap()).unwrap();
        assert!(!text.contains("owner@example.test") && !text.contains("ownerUserId") && !text.contains(&owner));
        assert!(text.contains("\"name\":\"Zespół\""));
    }

    #[test]
    fn invite_accept_makes_both_members_see_the_vault() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
        assert_eq!(invite.token.len(), 64);
        assert_eq!(invite.role, "editor");
        assert!(invite.expires_at > now_millis() + INVITE_TTL_MS - 60_000);
        assert_eq!(vaults.list_invites(&owner, &vault).unwrap().len(), 1);

        let preview = vaults.invite_preview(&invite.token).unwrap();
        assert_eq!(preview.vault.id, vault);
        assert_eq!(preview.role, "editor");

        let joined = vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap();
        assert_eq!(joined.role, "editor");
        assert_eq!(vaults.list(&guest).unwrap()[0].info.id, vault);
        assert_eq!(vaults.detail(&owner, &vault).unwrap().members.len(), 2);
        assert_eq!(vaults.detail(&guest, &vault).unwrap().members.len(), 2);
        assert!(vaults.list_invites(&owner, &vault).unwrap().is_empty());

        assert_eq!(status(vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap_err()), StatusCode::GONE);
        let again = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        assert_eq!(status(vaults.accept_invite(&guest, &again.token, &key(), 1).unwrap_err()), StatusCode::CONFLICT);
        let stranger = user(&auth, "stranger@example.test");
        assert_eq!(status(vaults.accept_invite(&stranger, &invite.token, &key(), 1).unwrap_err()), StatusCode::GONE);
        assert_eq!(status(vaults.invite_preview(&invite.token).unwrap_err()), StatusCode::GONE);
        assert_eq!(status(vaults.invite_preview(&"0".repeat(64)).unwrap_err()), StatusCode::NOT_FOUND);
        assert_eq!(status(vaults.invite_preview("nie-token").unwrap_err()), StatusCode::NOT_FOUND);
    }

    #[test]
    fn expired_and_revoked_invites_are_gone() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        let expired = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        vaults.db().unwrap().execute("UPDATE vault_invites SET expires_at=0", []).unwrap();
        assert_eq!(status(vaults.accept_invite(&guest, &expired.token, &key(), 1).unwrap_err()), StatusCode::GONE);

        let revoked = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        let listed = vaults.list_invites(&owner, &vault).unwrap();
        assert_eq!(listed.len(), 1);
        vaults.revoke_invite(&owner, &vault, &listed[0].id).unwrap();
        assert_eq!(status(vaults.accept_invite(&guest, &revoked.token, &key(), 1).unwrap_err()), StatusCode::NOT_FOUND);
    }

    #[test]
    fn admins_cannot_invite_admins_or_touch_owners() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let admin = user(&auth, "admin@example.test");
        let editor = user(&auth, "editor@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "admin").unwrap();
        vaults.accept_invite(&admin, &invite.token, &key(), 1).unwrap();
        let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
        vaults.accept_invite(&editor, &invite.token, &key(), 1).unwrap();

        assert_eq!(status(vaults.create_invite(&admin, &vault, "admin").unwrap_err()), StatusCode::FORBIDDEN);
        assert!(vaults.create_invite(&admin, &vault, "viewer").is_ok());
        assert_eq!(status(vaults.create_invite(&editor, &vault, "viewer").unwrap_err()), StatusCode::FORBIDDEN);

        assert_eq!(status(vaults.remove_member(&admin, &vault, &owner).unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status(vaults.set_member_role(&admin, &vault, &owner, "viewer").unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status(vaults.set_member_role(&admin, &vault, &editor, "admin").unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status(vaults.set_member_role(&admin, &vault, &admin, "viewer").unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(vaults.set_member_role(&admin, &vault, &editor, "viewer").unwrap().role, "viewer");
        assert_eq!(status(vaults.remove_member(&editor, &vault, &admin).unwrap_err()), StatusCode::FORBIDDEN);
        assert!(vaults.remove_member(&admin, &vault, &editor).is_ok());
        assert_eq!(status(vaults.detail(&editor, &vault).unwrap_err()), StatusCode::NOT_FOUND);
    }

    #[test]
    fn last_owner_cannot_be_removed_or_demoted() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let second = user(&auth, "second@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        assert_eq!(status(vaults.set_member_role(&owner, &vault, &owner, "admin").unwrap_err()), StatusCode::CONFLICT);
        assert_eq!(status(vaults.remove_member(&owner, &vault, &owner).unwrap_err()), StatusCode::CONFLICT);

        let invite = vaults.create_invite(&owner, &vault, "admin").unwrap();
        vaults.accept_invite(&second, &invite.token, &key(), 1).unwrap();
        assert_eq!(vaults.set_member_role(&owner, &vault, &second, "owner").unwrap().role, "owner");
        assert!(vaults.set_member_role(&second, &vault, &owner, "admin").is_ok());
        assert_eq!(status(vaults.set_member_role(&second, &vault, &second, "admin").unwrap_err()), StatusCode::CONFLICT);
        assert_eq!(status(vaults.remove_member(&second, &vault, &second).unwrap_err()), StatusCode::CONFLICT);
    }

    #[test]
    fn removed_member_and_outsiders_get_not_found() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let outsider = user(&auth, "outsider@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap();
        assert_eq!(vaults.role_of(&guest, &vault).unwrap(), Some(Role::Viewer));
        assert_eq!(status(vaults.detail(&outsider, &vault).unwrap_err()), StatusCode::NOT_FOUND);
        assert_eq!(status(vaults.rename(&outsider, &vault, "x").unwrap_err()), StatusCode::NOT_FOUND);

        vaults.remove_member(&owner, &vault, &guest).unwrap();
        assert_eq!(vaults.role_of(&guest, &vault).unwrap(), None);
        assert_eq!(status(vaults.detail(&guest, &vault).unwrap_err()), StatusCode::NOT_FOUND);
        assert!(vaults.list(&guest).unwrap().is_empty());
        assert_eq!(status(vaults.remove_member(&owner, &vault, &guest).unwrap_err()), StatusCode::NOT_FOUND);
    }

    #[test]
    fn rename_requires_admin() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let viewer = user(&auth, "viewer@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        vaults.accept_invite(&viewer, &invite.token, &key(), 1).unwrap();
        assert_eq!(status(vaults.rename(&viewer, &vault, "Nowa").unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(vaults.rename(&owner, &vault, "Nowa").unwrap().info.name, "Nowa");
    }

    #[test]
    fn box_key_is_stored_once_and_shown_to_members() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
        vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap();

        assert_eq!(status(vaults.box_key(&owner).unwrap_err()), StatusCode::NOT_FOUND);
        assert_eq!(vaults.set_box_key(&owner, &jwk(1), &key()).unwrap(), jwk(1));
        assert_eq!(vaults.set_box_key(&owner, &jwk(1), &key()).unwrap(), jwk(1));
        assert_eq!(status(vaults.set_box_key(&owner, &jwk(2), &key()).unwrap_err()), StatusCode::CONFLICT);
        assert_eq!(vaults.box_key(&owner).unwrap().public_jwk, jwk(1));
        let mut with_private = jwk(3);
        with_private["d"] = json!(BASE64URL.encode([3u8; 32]));
        assert_eq!(status(vaults.set_box_key(&guest, &with_private, &key()).unwrap_err()), StatusCode::BAD_REQUEST);
        assert_eq!(status(vaults.box_key(&guest).unwrap_err()), StatusCode::NOT_FOUND);
        // Box keys and signing keys are separate tables.
        assert_eq!(status(vaults.signing_key(&owner).unwrap_err()), StatusCode::NOT_FOUND);

        let wire = serde_json::to_value(vaults.detail(&guest, &vault).unwrap()).unwrap();
        // both joined within the same millisecond, so their order comes from the random ids: look them up by id
        let member = |id: &str| wire["members"].as_array().unwrap().iter().find(|m| m["userId"] == id).unwrap().clone();
        assert_eq!(member(&owner)["boxKey"], jwk(1));
        assert!(member(&guest)["boxKey"].is_null());
    }

    #[test]
    fn sealed_boxes_are_shape_checked_and_normalized() {
        let normalized: Value = serde_json::from_str(&sealed_key_json(&sealed(1)).unwrap()).unwrap();
        assert_eq!(normalized, sealed(1));
        let mut extra = sealed(1);
        extra["unexpected"] = json!("dropped");
        let normalized: Value = serde_json::from_str(&sealed_key_json(&extra).unwrap()).unwrap();
        assert!(normalized.get("unexpected").is_none());

        let mut wrong_schema = sealed(1);
        wrong_schema["schema"] = json!(KEY_SCHEMA);
        let mut private_epk = sealed(1);
        private_epk["epk"]["d"] = json!(BASE64URL.encode([1u8; 32]));
        let mut short_nonce = sealed(1);
        short_nonce["nonce"] = json!(BASE64.encode([1u8; 8]));
        let mut no_epk = sealed(1);
        no_epk.as_object_mut().unwrap().remove("epk");
        let mut tiny_ciphertext = sealed(1);
        tiny_ciphertext["ciphertext"] = json!(BASE64.encode([1u8; 8]));
        let mut oversized = sealed(1);
        oversized["ciphertext"] = json!(BASE64.encode(vec![1u8; 6000]));
        for bad in [wrong_schema, private_epk, short_nonce, no_epk, tiny_ciphertext, oversized, json!("sealed")] {
            assert_eq!(status(sealed_key_json(&bad).unwrap_err()), StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn rotation_seals_a_new_key_for_each_member_and_clears_the_flags() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let editor = user(&auth, "editor@example.test");
        let leaver = user(&auth, "leaver@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        for member in [&editor, &leaver] {
            let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
            vaults.accept_invite(member, &invite.token, &key(), 1).unwrap();
        }
        vaults.remove_member(&owner, &vault, &leaver).unwrap();
        assert!(vaults.detail(&owner, &vault).unwrap().needs_rotation);
        vaults.create_invite(&owner, &vault, "viewer").unwrap();
        assert_eq!(vaults.list_invites(&owner, &vault).unwrap().len(), 1);

        let keys = [(owner.clone(), sealed(1)), (editor.clone(), sealed(2))];
        let info = vaults.rotate(&owner, &vault, 2, &keys).unwrap();
        assert_eq!(info.key_epoch, 2);
        assert!(vaults.list_invites(&owner, &vault).unwrap().is_empty());

        let owner_detail = vaults.detail(&owner, &vault).unwrap();
        assert_eq!(owner_detail.vault.key_epoch, 2);
        assert!(!owner_detail.needs_rotation);
        assert_eq!(owner_detail.wrapped_key_epoch, 1);
        let pending = owner_detail.pending_key.unwrap();
        assert_eq!((pending.key_epoch, pending.sealed_key), (2, sealed(1)));

        let editor_detail = vaults.detail(&editor, &vault).unwrap();
        assert_eq!(editor_detail.pending_key.as_ref().unwrap().sealed_key, sealed(2));
        // The owner's sealed key never reaches the editor.
        let editor_wire = serde_json::to_string(&editor_detail).unwrap();
        assert!(!editor_wire.contains(&BASE64.encode([1u8; 48])));
    }

    #[test]
    fn rotation_must_cover_exactly_the_current_members_and_only_admins_may_rotate() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let editor = user(&auth, "editor@example.test");
        let viewer = user(&auth, "viewer@example.test");
        let stranger = user(&auth, "stranger@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        for (member, role) in [(&editor, "editor"), (&viewer, "viewer")] {
            let invite = vaults.create_invite(&owner, &vault, role).unwrap();
            vaults.accept_invite(member, &invite.token, &key(), 1).unwrap();
        }
        let all = [(owner.clone(), sealed(1)), (editor.clone(), sealed(2)), (viewer.clone(), sealed(3))];

        assert_eq!(status(vaults.rotate(&editor, &vault, 2, &all).unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status(vaults.rotate(&viewer, &vault, 2, &all).unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status(vaults.rotate(&owner, &vault, 3, &all).unwrap_err()), StatusCode::CONFLICT);
        let missing_viewer = [(owner.clone(), sealed(1)), (editor.clone(), sealed(2))];
        assert_eq!(status(vaults.rotate(&owner, &vault, 2, &missing_viewer).unwrap_err()), StatusCode::CONFLICT);
        let with_stranger = [all[0].clone(), all[1].clone(), (stranger, sealed(4))];
        assert_eq!(status(vaults.rotate(&owner, &vault, 2, &with_stranger).unwrap_err()), StatusCode::CONFLICT);
        let duplicated = [all[0].clone(), all[0].clone(), all[1].clone(), all[2].clone()];
        assert_eq!(status(vaults.rotate(&owner, &vault, 2, &duplicated).unwrap_err()), StatusCode::CONFLICT);
        let malformed = [(owner.clone(), json!("nie-pudełko")), all[1].clone(), all[2].clone()];
        assert_eq!(status(vaults.rotate(&owner, &vault, 2, &malformed).unwrap_err()), StatusCode::BAD_REQUEST);
        assert_eq!(vaults.detail(&owner, &vault).unwrap().vault.key_epoch, 1);

        assert_eq!(vaults.rotate(&owner, &vault, 2, &all).unwrap().key_epoch, 2);
        assert_eq!(status(vaults.rotate(&owner, &vault, 2, &all).unwrap_err()), StatusCode::CONFLICT);
    }

    #[test]
    fn my_key_must_match_the_current_epoch_and_clears_the_pending_key() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let editor = user(&auth, "editor@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
        vaults.accept_invite(&editor, &invite.token, &key(), 1).unwrap();
        vaults.rotate(&owner, &vault, 2, &[(owner.clone(), sealed(1)), (editor.clone(), sealed(2))]).unwrap();

        assert_eq!(status(vaults.set_my_key(&editor, &vault, 1, &key()).unwrap_err()), StatusCode::CONFLICT);
        assert!(vaults.detail(&editor, &vault).unwrap().pending_key.is_some());
        assert_eq!(vaults.set_my_key(&editor, &vault, 2, &key()).unwrap(), 2);
        let detail = vaults.detail(&editor, &vault).unwrap();
        assert!(detail.pending_key.is_none());
        assert_eq!(detail.wrapped_key_epoch, 2);
    }

    #[test]
    fn removal_and_leaving_set_needs_rotation() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let editor = user(&auth, "editor@example.test");
        let viewer = user(&auth, "viewer@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        for (member, role) in [(&editor, "editor"), (&viewer, "viewer")] {
            let invite = vaults.create_invite(&owner, &vault, role).unwrap();
            vaults.accept_invite(member, &invite.token, &key(), 1).unwrap();
        }
        assert!(!vaults.detail(&owner, &vault).unwrap().needs_rotation);
        vaults.remove_member(&owner, &vault, &viewer).unwrap();
        assert!(vaults.detail(&owner, &vault).unwrap().needs_rotation);

        vaults.rotate(&owner, &vault, 2, &[(owner.clone(), sealed(1)), (editor.clone(), sealed(2))]).unwrap();
        assert!(!vaults.detail(&owner, &vault).unwrap().needs_rotation);
        vaults.remove_member(&editor, &vault, &editor).unwrap();
        assert!(vaults.detail(&owner, &vault).unwrap().needs_rotation);
    }

    #[test]
    fn invites_from_another_key_epoch_are_gone() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let late = user(&auth, "late@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "editor").unwrap();
        assert_eq!(status(vaults.accept_invite(&guest, &invite.token, &key(), 2).unwrap_err()), StatusCode::GONE);
        vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap();

        vaults.rotate(&owner, &vault, 2, &[(owner.clone(), sealed(1)), (guest.clone(), sealed(2))]).unwrap();
        let fresh = vaults.create_invite(&owner, &vault, "viewer").unwrap();
        let err = vaults.accept_invite(&late, &fresh.token, &key(), 1).unwrap_err();
        assert!(matches!(err, VaultError::Gone("Zaproszenie wygasło po zmianie klucza.")));
        vaults.accept_invite(&late, &fresh.token, &key(), 2).unwrap();
        assert_eq!(vaults.detail(&late, &vault).unwrap().wrapped_key_epoch, 2);
    }

    #[test]
    fn databases_from_before_key_epochs_are_migrated_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthService::open(dir.path()).unwrap();
        let owner = auth.register("owner@example.test", "A long test password 1").unwrap().0.id;
        let vault_id = format!("v-{}1", "0".repeat(31));
        {
            // The layout before epochs: the same tables without the columns added later.
            let old = Connection::open(dir.path().join("auth.db")).unwrap();
            old.execute_batch(SCHEMA).unwrap();
            old.execute(
                "INSERT INTO vaults(vault_id,name,kind,owner_user_id,created_at) VALUES (?1,'Stary','notatki',?2,0)",
                params![vault_id, owner],
            ).unwrap();
            old.execute(
                "INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,'owner',?3,0)",
                params![vault_id, owner, serde_json::to_string(&key()).unwrap()],
            ).unwrap();
        }
        let locks = Arc::new(VaultLocks::default());
        let vaults = VaultService::open(dir.path(), locks.clone()).unwrap();
        assert_eq!(vaults.key_epoch(&vault_id).unwrap(), 1);
        let detail = vaults.detail(&owner, &vault_id).unwrap();
        assert_eq!(detail.wrapped_key_epoch, 1);
        assert!(!detail.needs_rotation);
        drop(vaults);
        // Opening again runs the same checks without failing.
        assert_eq!(VaultService::open(dir.path(), locks).unwrap().key_epoch(&vault_id).unwrap(), 1);
    }

    #[test]
    fn multi_use_invite_admits_each_person_once_until_used_up() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        let invite = vaults.create_invite_for(&owner, &vault, "viewer", 3).unwrap();
        assert_eq!(invite.max_uses, 3);
        let guests: Vec<String> = (0..4).map(|i| user(&auth, &format!("guest{i}@example.test"))).collect();

        vaults.accept_invite(&guests[0], &invite.token, &key(), 1).unwrap();
        // The same person cannot use the link twice.
        assert_eq!(status(vaults.accept_invite(&guests[0], &invite.token, &key(), 1).unwrap_err()), StatusCode::CONFLICT);
        let listed = vaults.list_invites(&owner, &vault).unwrap();
        assert_eq!((listed[0].max_uses, listed[0].uses), (3, 1));
        let preview = vaults.invite_preview(&invite.token).unwrap();
        assert_eq!((preview.max_uses, preview.uses), (3, 1));

        vaults.accept_invite(&guests[1], &invite.token, &key(), 1).unwrap();
        vaults.accept_invite(&guests[2], &invite.token, &key(), 1).unwrap();
        assert_eq!(status(vaults.accept_invite(&guests[3], &invite.token, &key(), 1).unwrap_err()), StatusCode::GONE);
        assert!(vaults.list_invites(&owner, &vault).unwrap().is_empty());
        assert_eq!(status(vaults.invite_preview(&invite.token).unwrap_err()), StatusCode::GONE);
        assert_eq!(vaults.detail(&owner, &vault).unwrap().members.len(), 4);
    }

    #[test]
    fn invite_max_uses_must_be_between_one_and_fifty() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let vault = vaults.create(&owner, "Zespół", "notatki", &key()).unwrap().info.id;
        for bad in [0, 51, -1] {
            assert_eq!(status(vaults.create_invite_for(&owner, &vault, "viewer", bad).unwrap_err()), StatusCode::BAD_REQUEST);
        }
        assert_eq!(vaults.create_invite_for(&owner, &vault, "viewer", 50).unwrap().max_uses, 50);
        assert_eq!(vaults.list_invites(&owner, &vault).unwrap().len(), 1);
    }

    #[test]
    fn rotation_revokes_a_partly_used_multi_use_invite() {
        let (auth, vaults, _sync, _dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let guest = user(&auth, "guest@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite_for(&owner, &vault, "viewer", 5).unwrap();
        vaults.accept_invite(&guest, &invite.token, &key(), 1).unwrap();
        assert_eq!(vaults.list_invites(&owner, &vault).unwrap().len(), 1);
        vaults.rotate(&owner, &vault, 2, &[(owner.clone(), sealed(1)), (guest.clone(), sealed(2))]).unwrap();
        assert!(vaults.list_invites(&owner, &vault).unwrap().is_empty());
        assert_eq!(status(vaults.invite_preview(&invite.token).unwrap_err()), StatusCode::NOT_FOUND);
    }

    #[test]
    fn invites_used_before_uses_existed_count_as_used_once() {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthService::open(dir.path()).unwrap();
        let owner = auth.register("owner@example.test", "A long test password 1").unwrap().0.id;
        let vault_id = format!("v-{}1", "0".repeat(31));
        {
            // A database from before `max_uses`/`uses`: one used invite, one unused.
            let old = Connection::open(dir.path().join("auth.db")).unwrap();
            old.execute_batch(SCHEMA).unwrap();
            old.execute(
                "INSERT INTO vaults(vault_id,name,kind,owner_user_id,created_at) VALUES (?1,'Stary','notatki',?2,0)",
                params![vault_id, owner],
            ).unwrap();
            old.execute(
                "INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,'owner',?3,0)",
                params![vault_id, owner, serde_json::to_string(&key()).unwrap()],
            ).unwrap();
            old.execute(
                "INSERT INTO vault_invites(invite_id,vault_id,token_hash,role,created_by,created_at,expires_at,used_at,used_by)
                 VALUES ('used',?1,'h1','viewer',?2,0,?3,1,?2)",
                params![vault_id, owner, now_millis() + INVITE_TTL_MS],
            ).unwrap();
            old.execute(
                "INSERT INTO vault_invites(invite_id,vault_id,token_hash,role,created_by,created_at,expires_at)
                 VALUES ('open',?1,'h2','viewer',?2,0,?3)",
                params![vault_id, owner, now_millis() + INVITE_TTL_MS],
            ).unwrap();
        }
        let vaults = VaultService::open(dir.path(), Arc::new(VaultLocks::default())).unwrap();
        let listed = vaults.list_invites(&owner, &vault_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].id.as_str(), listed[0].max_uses, listed[0].uses), ("open", 1, 0));
        let used: i64 = vaults.db().unwrap().query_row("SELECT uses FROM vault_invites WHERE invite_id='used'", [], |r| r.get(0)).unwrap();
        assert_eq!(used, 1);
    }

    // docs/MCP.md §3.7: the personal vault's own key, and no more puts under the personal key once it exists.
    #[test]
    fn personal_vault_keys_take_only_the_next_epoch_and_stop_puts_under_older_keys() {
        let (auth, vaults, sync, _dir) = test_services();
        let anna = user(&auth, "anna@example.test");
        let other = user(&auth, "olek@example.test");
        let personal = format!("browser-{anna}");
        let snapshot = |epoch: Option<i64>| Envelope { schema: "notes-encrypted-v1".into(), nonce: BASE64.encode([1u8; 12]), ciphertext: BASE64.encode([2u8; 32]), key_epoch: epoch };

        assert_eq!(vaults.personal_key_epoch(&anna).unwrap(), 1);
        assert!(vaults.personal_keys(&anna).unwrap().is_empty());
        assert!(matches!(sync.put(&anna, &personal, 0, &snapshot(None)).unwrap(), crate::websync::PutResult::Accepted(1)));

        assert!(matches!(vaults.add_personal_key(&anna, 3, &key()), Err(VaultError::Conflict(_))));
        assert_eq!(vaults.add_personal_key(&anna, 2, &key()).unwrap(), 2);
        assert_eq!(vaults.add_personal_key(&anna, 2, &key()).unwrap(), 2, "the same key again is a no-op");
        let mut other_key = key();
        other_key.ciphertext = BASE64.encode([8u8; 48]);
        assert!(matches!(vaults.add_personal_key(&anna, 2, &other_key), Err(VaultError::Conflict(_))), "a stored key is never replaced");
        assert!(matches!(vaults.add_personal_key(&anna, 2, &Envelope { schema: "x".into(), ..key() }), Err(VaultError::Invalid(_))));
        assert_eq!(vaults.personal_key_epoch(&anna).unwrap(), 2);
        let stored = vaults.personal_keys(&anna).unwrap();
        assert_eq!(stored.iter().map(|(e, k, _)| (*e, k.clone())).collect::<Vec<_>>(), vec![(2, key())]);
        assert!(stored[0].2 > 0, "each key carries its creation time");
        assert_eq!(vaults.personal_key_epoch(&other).unwrap(), 1, "another account is untouched");

        assert!(matches!(sync.put(&anna, &personal, 1, &snapshot(None)).unwrap(), crate::websync::PutResult::StaleKey));
        assert!(matches!(sync.put(&anna, &personal, 1, &snapshot(Some(1))).unwrap(), crate::websync::PutResult::StaleKey));
        assert!(matches!(sync.put(&anna, &personal, 1, &snapshot(Some(2))).unwrap(), crate::websync::PutResult::Accepted(2)));
        assert!(matches!(sync.put(&other, &format!("browser-{other}"), 0, &snapshot(None)).unwrap(), crate::websync::PutResult::Accepted(1)));

        let db = vaults.db().unwrap();
        db.execute("DELETE FROM web_users WHERE user_id=?1", [&anna]).unwrap();
        let left: i64 = db.query_row("SELECT count(*) FROM personal_vault_keys WHERE user_id=?1", [&anna], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "the keys go with the account");

    }

    #[test]
    fn only_an_owner_deletes_an_organization_by_typing_its_name() {
        let (auth, vaults, sync, dir) = test_services();
        let owner = user(&auth, "owner@example.test");
        let admin = user(&auth, "admin@example.test");
        let outsider = user(&auth, "outsider@example.test");
        let vault = vaults.create(&owner, "Zespół", "organizacja", &key()).unwrap().info.id;
        let invite = vaults.create_invite(&owner, &vault, "admin").unwrap();
        vaults.accept_invite(&admin, &invite.token, &key(), 1).unwrap();
        vaults.create_invite(&owner, &vault, "editor").unwrap();
        let snapshot = Envelope { schema: "notes-encrypted-v1".into(), nonce: BASE64.encode([1u8; 12]), ciphertext: BASE64.encode([2u8; 32]), key_epoch: Some(1) };
        assert!(matches!(sync.put(&owner, &vault, 0, &snapshot).unwrap(), crate::websync::PutResult::Accepted(1)));

        assert_eq!(status(vaults.delete_vault(&admin, &vault, "Zespół").unwrap_err()), StatusCode::FORBIDDEN);
        assert_eq!(status(vaults.delete_vault(&outsider, &vault, "Zespół").unwrap_err()), StatusCode::NOT_FOUND);
        assert_eq!(status(vaults.delete_vault(&owner, &vault, "zespół").unwrap_err()), StatusCode::BAD_REQUEST);
        assert_eq!(status(vaults.delete_vault(&owner, &format!("browser-{owner}"), "Moje notatki").unwrap_err()), StatusCode::NOT_FOUND);

        let mut members = vaults.delete_vault(&owner, &vault, " Zespół ").unwrap();
        members.sort();
        let mut expected = vec![owner.clone(), admin.clone()];
        expected.sort();
        assert_eq!(members, expected);
        sync.drop_vault(&vault).unwrap();
        assert!(vaults.list(&owner).unwrap().is_empty());
        assert!(vaults.list(&admin).unwrap().is_empty());
        assert_eq!(vaults.role_of(&admin, &vault).unwrap(), None);
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        for table in ["vault_members", "vault_invites"] {
            let left: i64 = db.query_row(&format!("SELECT count(*) FROM {table} WHERE vault_id=?1"), [&vault], |r| r.get(0)).unwrap();
            assert_eq!(left, 0, "{table}");
        }
        let sync_db = Connection::open(dir.path().join("browser-sync.db")).unwrap();
        let left: i64 = sync_db.query_row("SELECT count(*) FROM browser_sync_vaults WHERE vault_id=?1", [&vault], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        assert!(sync.put(&owner, &vault, 1, &snapshot).is_err(), "no writes into a deleted vault");
        assert!(sync.drop_vault(&format!("browser-{owner}")).is_err(), "a personal vault is not dropped this way");
    }
}
