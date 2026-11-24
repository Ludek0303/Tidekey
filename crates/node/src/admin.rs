//! Account administration from the server's command line (`notes-node users`, `notes-node delete-user`). Whoever can
//! run the binary against `/data` is the admin, so there is no admin login on the web. Safe while `serve` runs: both
//! wait on SQLite's lock, and the server reads sessions and memberships from the database on every request and put.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

pub struct UserRow {
    pub id: String,
    pub email: String,
    pub name: String,
    pub created_at: i64,
    pub sessions: i64,
    /// (vault name, role) of each shared vault the user is in.
    pub vaults: Vec<(String, String)>,
}

/// What deleting a user removes. `vaults`: the shared vaults they own alone, deleted with them.
/// `left`: the vaults they were a member of, flagged for a new key.
pub struct Deletion {
    pub id: String,
    pub email: String,
    pub vaults: Vec<(String, String)>,
    pub left: Vec<String>,
}

pub(crate) fn open(data: &Path, file: &str) -> Result<Connection, String> {
    let path = data.join(file);
    if !path.exists() {
        return Err(format!("brak {} — czy --data wskazuje katalog węzła?", path.display()));
    }
    let db = Connection::open(&path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    Ok(db)
}

pub fn list_users(data: &Path) -> Result<Vec<UserRow>, String> {
    let db = open(data, "auth.db")?;
    let mut users = db
        .prepare("SELECT u.user_id, u.email, u.display_name, u.created_at,
                    (SELECT count(*) FROM web_sessions s WHERE s.user_id = u.user_id)
                  FROM web_users u ORDER BY u.created_at")
        .and_then(|mut q| {
            q.query_map([], |r| Ok(UserRow { id: r.get(0)?, email: r.get(1)?, name: r.get(2)?, created_at: r.get(3)?, sessions: r.get(4)?, vaults: Vec::new() }))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())?;
    let mut q = db
        .prepare("SELECT v.name, m.role FROM vault_members m JOIN vaults v ON v.vault_id = m.vault_id WHERE m.user_id = ?1 ORDER BY v.name")
        .map_err(|e| e.to_string())?;
    for user in &mut users {
        user.vaults = q
            .query_map([&user.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())?;
    }
    Ok(users)
}

/// Deletes the user given by email or id, or with `apply` false only says what that would remove. Refused while the
/// user owns a shared vault that has other members: the owner is part of the vault's encryption and can't change.
pub fn delete_user(data: &Path, who: &str, apply: bool) -> Result<Deletion, String> {
    let mut db = open(data, "auth.db")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let (id, email): (String, String) = tx
        .query_row("SELECT user_id, email FROM web_users WHERE email = ?1 OR user_id = ?1", [who.trim().to_lowercase()], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("nie ma użytkownika {who}"))?;
    let rows = |sql: &str| -> Result<Vec<(String, String, i64)>, String> {
        tx.prepare(sql)
            .and_then(|mut q| q.query_map([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect())
            .map_err(|e| e.to_string())
    };
    // (vault id, name, other members); a vault they created, or one where they are the last owner
    let owned = rows("SELECT v.vault_id, v.name, (SELECT count(*) FROM vault_members o WHERE o.vault_id = v.vault_id AND o.user_id <> ?1)
                      FROM vaults v WHERE v.owner_user_id = ?1")?;
    let last_owner = rows("SELECT m.vault_id, v.name, (SELECT count(*) FROM vault_members o WHERE o.vault_id = m.vault_id AND o.user_id <> ?1)
                           FROM vault_members m JOIN vaults v ON v.vault_id = m.vault_id
                           WHERE m.user_id = ?1 AND m.role = 'owner' AND v.owner_user_id <> ?1
                             AND NOT EXISTS (SELECT 1 FROM vault_members o WHERE o.vault_id = m.vault_id AND o.user_id <> ?1 AND o.role = 'owner')")?;
    // The way out is named in each refusal, and the operator route is the same for both.
    const OPERATOR: &str = "Możesz też wysłać prośbę o usunięcie konta do operatora usługi (kontakt na stronie /prywatnosc).";
    if let Some((_, name, others)) = owned.iter().find(|v| v.2 > 0) {
        return Err(format!("Nie można usunąć konta: jest założycielem sejfu „{name}”, w którym są jeszcze inne osoby ({others}). Założyciel uczestniczy w szyfrowaniu sejfu, więc najpierw usuń z tego sejfu pozostałe osoby, a potem spróbuj ponownie. {OPERATOR}"));
    }
    if let Some((_, name, _)) = last_owner.iter().find(|v| v.2 > 0) {
        return Err(format!("Nie można usunąć konta: jesteś ostatnim właścicielem sejfu „{name}”. Przekaż rolę właściciela innej osobie albo usuń pozostałe osoby z sejfu, a potem spróbuj ponownie. {OPERATOR}"));
    }
    let gone: Vec<(String, String)> = owned.into_iter().map(|(v, n, _)| (v, n)).collect();
    let left: Vec<String> = rows("SELECT v.vault_id, v.name, 0 FROM vault_members m JOIN vaults v ON v.vault_id = m.vault_id
                                  WHERE m.user_id = ?1 AND v.owner_user_id <> ?1")?
        .into_iter()
        .map(|(_, n, _)| n)
        .collect();
    let deletion = Deletion { id: id.clone(), email: email.clone(), vaults: gone.clone(), left };
    if !apply {
        return Ok(deletion);
    }
    // the remaining members keep a key the deleted user had: the next admin who opens the vault replaces it
    tx.execute("UPDATE vaults SET needs_rotation = 1 WHERE vault_id IN (SELECT vault_id FROM vault_members WHERE user_id = ?1) AND owner_user_id <> ?1", [&id])
        .and_then(|_| tx.execute("DELETE FROM vault_invites WHERE created_by = ?1 AND used_at IS NULL", [&id]))
        // chat rows name vaults without a foreign key: those of the deleted vaults go with them (any former member's too)
        .and_then(|_| ["agent_keys", "agent_scopes", "agent_proposals", "agent_detached"].iter().try_fold(0, |n, table| {
            tx.execute(&format!("DELETE FROM {table} WHERE vault_id IN (SELECT vault_id FROM vaults WHERE owner_user_id = ?1)"), [&id]).map(|m| n + m)
        }))
        .and_then(|_| tx.execute("DELETE FROM vaults WHERE owner_user_id = ?1", [&id]))
        .and_then(|_| tx.execute("DELETE FROM web_users WHERE user_id = ?1", [&id]))
        .and_then(|_| tx.execute("DELETE FROM web_login_attempts WHERE email = ?1", [&email]))
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    // The account is gone; its ciphertext goes next. A failure here leaves only unreadable rows behind.
    if data.join("browser-sync.db").exists() {
        let sync = open(data, "browser-sync.db")?;
        sync.execute("DELETE FROM browser_sync_vaults WHERE user_id = ?1", [&id]).map_err(|e| e.to_string())?;
        for (vault, _) in &gone {
            sync.execute("DELETE FROM browser_sync_vaults WHERE user_id = '' AND vault_id = ?1", params![vault]).map_err(|e| e.to_string())?;
        }
    }
    Ok(deletion)
}

/// For a user who forgot their password: sets a random temporary one and ends their sessions. The notes stay
/// readable, since their key comes from the recovery code, not the password. Returns (id, email, temporary password).
pub fn reset_password(data: &Path, who: &str) -> Result<(String, String, String), String> {
    let db = open(data, "auth.db")?;
    let (id, email): (String, String) = db
        .query_row("SELECT user_id, email FROM web_users WHERE email = ?1 OR user_id = ?1", [who.trim().to_lowercase()], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("nie ma użytkownika {who}"))?;
    let random = notes_sync::random::<8>().map_err(|e| e.to_string())?;
    // the fixed parts meet the password rule (uppercase letter and digit); the 16 hex digits carry the randomness
    let password = format!("Notes-{}-1", random.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let hash = crate::auth::hash_password(&password).map_err(|_| "nie udało się utworzyć hasła".to_string())?;
    db.execute("UPDATE web_users SET password_hash = ?1 WHERE user_id = ?2", params![hash, id]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM web_sessions WHERE user_id = ?1", [&id]).map_err(|e| e.to_string())?;
    Ok((id, email, password))
}

/// A registration code as shown once. Only its hash is stored (`auth::signup_code_hash`).
pub struct SignupCode {
    pub id: String,
    pub code: String,
    pub label: String,
    pub expires_at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupCodeRow {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub used_by_email: Option<String>,
}

/// Makes a registration code valid for `days` (1..=90). Its text is returned here and nowhere else.
pub fn create_signup_code(data: &Path, label: &str, days: u32) -> Result<SignupCode, String> {
    if !(1..=90).contains(&days) {
        return Err("Ważność kodu: od 1 do 90 dni.".into());
    }
    let label = label.trim();
    if label.chars().count() > 80 {
        return Err("Opis kodu może mieć najwyżej 80 znaków.".into());
    }
    let db = open(data, "auth.db")?;
    let (code, hash) = crate::auth::new_signup_code().map_err(|_| "nie udało się utworzyć kodu".to_string())?;
    let id = crate::auth::hex(&notes_sync::random::<16>().map_err(|e| e.to_string())?);
    let now = crate::auth::now_seconds();
    let expires_at = now + i64::from(days) * 86_400;
    db.execute(
        "INSERT INTO signup_codes(code_id, code_hash, label, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, hash, label, now, expires_at],
    ).map_err(|e| e.to_string())?;
    Ok(SignupCode { id, code, label: label.to_string(), expires_at })
}

/// Newest first. Never carries the code or its hash.
pub fn list_signup_codes(data: &Path) -> Result<Vec<SignupCodeRow>, String> {
    let db = open(data, "auth.db")?;
    db.prepare("SELECT c.code_id, c.label, c.created_at, c.expires_at, c.used_at, u.email
                FROM signup_codes c LEFT JOIN web_users u ON u.user_id = c.used_by
                ORDER BY c.created_at DESC, c.rowid DESC")
        .and_then(|mut q| {
            q.query_map([], |r| Ok(SignupCodeRow { id: r.get(0)?, label: r.get(1)?, created_at: r.get(2)?, expires_at: r.get(3)?, used_at: r.get(4)?, used_by_email: r.get(5)? }))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())
}

/// Deletes an unused code. A used one stays, with the account it made. Returns whether a row was deleted.
pub fn revoke_signup_code(data: &Path, id: &str) -> Result<bool, String> {
    let db = open(data, "auth.db")?;
    let deleted = db.execute("DELETE FROM signup_codes WHERE code_id = ?1 AND used_at IS NULL", [id.trim()]).map_err(|e| e.to_string())?;
    Ok(deleted > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthService;
    use crate::vaults::{VaultLocks, VaultService};
    use std::sync::Arc;

    fn node() -> (tempfile::TempDir, AuthService, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthService::open(dir.path()).unwrap();
        VaultService::open(dir.path(), Arc::new(VaultLocks::default())).unwrap();
        let db = Connection::open(dir.path().join("auth.db")).unwrap();
        let sync = Connection::open(dir.path().join("browser-sync.db")).unwrap();
        sync.execute_batch("CREATE TABLE browser_sync_vaults (user_id TEXT NOT NULL, vault_id TEXT NOT NULL, revision INTEGER NOT NULL, envelope_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, vault_id));").unwrap();
        (dir, auth, db)
    }
    fn user(auth: &AuthService, email: &str) -> String { auth.register(email, "A long test password 1").unwrap().0.id }
    fn vault(db: &Connection, id: &str, owner: &str, members: &[(&str, &str)]) {
        db.execute("INSERT INTO vaults(vault_id, name, kind, owner_user_id, created_at) VALUES (?1, ?1, 'organizacja', ?2, 0)", params![id, owner]).unwrap();
        for (user, role) in members {
            db.execute("INSERT INTO vault_members(vault_id, user_id, role, wrapped_key, added_at) VALUES (?1, ?2, ?3, '{}', 0)", params![id, user, role]).unwrap();
        }
    }
    fn sync_rows(dir: &Path) -> i64 {
        Connection::open(dir.join("browser-sync.db")).unwrap().query_row("SELECT count(*) FROM browser_sync_vaults", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn lists_users_with_sessions_and_vaults() {
        let (dir, auth, db) = node();
        let anna = user(&auth, "anna@example.test");
        vault(&db, "v-1", &anna, &[(&anna, "owner")]);
        let users = list_users(dir.path()).unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!((users[0].email.as_str(), users[0].sessions), ("anna@example.test", 1));
        assert_eq!(users[0].vaults, vec![("v-1".to_string(), "owner".to_string())]);
    }

    #[test]
    fn a_dry_run_changes_nothing_and_a_bot_goes_with_its_own_vault_and_data() {
        let (dir, auth, db) = node();
        let anna = user(&auth, "anna@example.test");
        let bot = user(&auth, "bot@spam.example.test");
        vault(&db, "v-bot", &bot, &[(&bot, "owner")]);
        vault(&db, "v-anna", &anna, &[(&anna, "owner"), (&bot, "editor")]);
        let sync = Connection::open(dir.path().join("browser-sync.db")).unwrap();
        for (u, v) in [(bot.as_str(), format!("browser-{bot}")), ("", "v-bot".into()), ("", "v-anna".into())] {
            sync.execute("INSERT INTO browser_sync_vaults VALUES (?1, ?2, 1, '{}', 0)", params![u, v]).unwrap();
        }

        let plan = delete_user(dir.path(), "BOT@SPAM.example.test", false).unwrap();
        assert_eq!(plan.vaults, vec![("v-bot".to_string(), "v-bot".to_string())]);
        assert_eq!(plan.left, vec!["v-anna".to_string()]);
        assert_eq!(list_users(dir.path()).unwrap().len(), 2);

        delete_user(dir.path(), &bot, true).unwrap();
        let users = list_users(dir.path()).unwrap();
        assert_eq!(users.iter().map(|u| u.email.as_str()).collect::<Vec<_>>(), ["anna@example.test"]);
        assert_eq!(sync_rows(dir.path()), 1); // only Anna's shared vault is left
        let rotate: bool = db.query_row("SELECT needs_rotation FROM vaults WHERE vault_id = 'v-anna'", [], |r| r.get(0)).unwrap();
        assert!(rotate);
        let sessions: i64 = db.query_row("SELECT count(*) FROM web_sessions WHERE user_id = ?1", [&bot], |r| r.get(0)).unwrap();
        assert_eq!(sessions, 0);
    }

    #[test]
    fn a_reset_password_works_for_login_and_ends_the_old_sessions() {
        let (dir, auth, db) = node();
        let anna = user(&auth, "anna@example.test");
        let (_, email, password) = reset_password(dir.path(), "anna@example.test").unwrap();
        assert_eq!(email, "anna@example.test");
        let sessions: i64 = db.query_row("SELECT count(*) FROM web_sessions WHERE user_id = ?1", [&anna], |r| r.get(0)).unwrap();
        assert_eq!(sessions, 0);
        assert!(auth.login_for_test("anna@example.test", &password));
        assert!(!auth.login_for_test("anna@example.test", "A long test password 1"));
    }

    #[test]
    fn an_owner_of_a_vault_with_other_members_is_refused() {
        let (dir, auth, db) = node();
        let anna = user(&auth, "anna@example.test");
        let bartek = user(&auth, "bartek@example.test");
        vault(&db, "v-1", &anna, &[(&anna, "owner"), (&bartek, "editor")]);
        let err = delete_user(dir.path(), "anna@example.test", true).err().unwrap();
        assert!(err.contains("usuń z tego sejfu pozostałe osoby"), "{err}");
        assert_eq!(list_users(dir.path()).unwrap().len(), 2);
        assert!(delete_user(dir.path(), "nikt@example.test", true).is_err());
    }

    #[test]
    fn a_signup_code_is_made_listed_without_its_text_and_revoked_while_unused() {
        let (dir, _auth, db) = node();
        let made = create_signup_code(dir.path(), "  Ola  ", 7).unwrap();
        assert_eq!(made.label, "Ola");
        assert_eq!(made.code.len(), 14); // ABCD-EFGH-JKLM
        let stored: String = db.query_row("SELECT code_hash FROM signup_codes WHERE code_id = ?1", [&made.id], |r| r.get(0)).unwrap();
        assert_eq!(stored, crate::auth::signup_code_hash(&made.code));
        assert!(!stored.contains(&made.code));

        let rows = list_signup_codes(dir.path()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].id.as_str(), rows[0].label.as_str(), rows[0].used_at, rows[0].used_by_email.clone()), (made.id.as_str(), "Ola", None, None));
        let listed = serde_json::to_string(&rows[0]).unwrap();
        assert!(!listed.contains(&made.code) && !listed.contains(&stored) && !listed.contains("\"code\""), "{listed}");

        assert!(revoke_signup_code(dir.path(), &made.id).unwrap());
        assert!(!revoke_signup_code(dir.path(), &made.id).unwrap());
        assert!(list_signup_codes(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn a_signup_code_has_a_limited_number_of_days_and_a_short_label() {
        let (dir, _auth, _db) = node();
        assert!(create_signup_code(dir.path(), "", 0).is_err());
        assert!(create_signup_code(dir.path(), "", 91).is_err());
        assert!(create_signup_code(dir.path(), &"x".repeat(81), 7).is_err());
        assert!(create_signup_code(dir.path(), &"x".repeat(80), 90).is_ok());
        assert_eq!(list_signup_codes(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn a_used_signup_code_is_kept_and_names_the_account_that_used_it() {
        let (dir, auth, db) = node();
        let anna = user(&auth, "anna@example.test");
        let made = create_signup_code(dir.path(), "Anna", 7).unwrap();
        db.execute("UPDATE signup_codes SET used_at = 5, used_by = ?1 WHERE code_id = ?2", params![anna, made.id]).unwrap();

        assert!(!revoke_signup_code(dir.path(), &made.id).unwrap());
        let rows = list_signup_codes(dir.path()).unwrap();
        assert_eq!((rows[0].used_at, rows[0].used_by_email.as_deref()), (Some(5), Some("anna@example.test")));
    }
}
