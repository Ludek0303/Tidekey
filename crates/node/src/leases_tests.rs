use super::*;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::Connection;

use crate::auth::AuthService;
use crate::vaults::{VaultLocks, VaultService};
use crate::websync::Envelope;

const PASSWORD: &str = "A long test password 1";
const NOW: i64 = 1_700_000_000_000;
const NAME: &str = "0123456789abcdef0123456789abcdef";

struct Fixture {
    auth: AuthService,
    vaults: VaultService,
    leases: LeaseService,
    dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let auth = AuthService::open(dir.path()).unwrap();
    let vaults = VaultService::open(dir.path(), Arc::new(VaultLocks::default())).unwrap();
    let leases = LeaseService::open(dir.path()).unwrap();
    Fixture { auth, vaults, leases, dir }
}

fn user(auth: &AuthService, email: &str) -> String {
    auth.register(email, PASSWORD).unwrap().0.id
}

fn key() -> Envelope {
    Envelope {
        schema: "notes-key-v1".into(),
        nonce: BASE64.encode([7u8; 12]),
        ciphertext: BASE64.encode([9u8; 48]),
        key_epoch: None,
    }
}

/// A vault owned by `owner`, with `guest` joined in `role` (through a real invite).
fn shared_vault(f: &Fixture, owner: &str, guest: &str, role: &str) -> String {
    let vault = f.vaults.create(owner, "Projekt", "notatki", &key()).unwrap().info.id;
    let invite = f.vaults.create_invite(owner, &vault, role).unwrap();
    f.vaults.accept_invite(guest, &invite.token, &key(), 1).unwrap();
    vault
}

fn who<'a>(user_id: &'a str, session: &'a str) -> Who<'a> {
    Who { user_id, session }
}

fn status(error: LeaseError) -> StatusCode {
    error.into_response().status()
}

#[test]
fn editor_and_owner_get_the_lease() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let editor = user(&f.auth, "editor@example.test");
    let vault = shared_vault(&f, &owner, &editor, "editor");

    let view = f.leases.acquire(&who(&editor, "laptop"), &vault, NAME, 60, NOW).unwrap();
    assert!(view.granted);
    assert_eq!(view.until, NOW + 60_000);

    let other = f.leases.acquire(&who(&owner, "desktop"), &vault, &"f".repeat(32), 30, NOW).unwrap();
    assert!(other.granted);
    assert_eq!(other.until, NOW + 30_000);
}

#[test]
fn another_device_is_refused_until_the_lease_ends() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let editor = user(&f.auth, "editor@example.test");
    let vault = shared_vault(&f, &owner, &editor, "editor");
    f.leases.acquire(&who(&editor, "laptop"), &vault, NAME, 60, NOW).unwrap();

    // The same person on another device, and the owner, both get the holder's `until`.
    let phone = f.leases.acquire(&who(&editor, "phone"), &vault, NAME, 60, NOW + 59_999).unwrap();
    assert!(!phone.granted);
    assert_eq!(phone.until, NOW + 60_000);
    let owner_view = f.leases.acquire(&who(&owner, "desktop"), &vault, NAME, 60, NOW).unwrap();
    assert!(!owner_view.granted);
    assert_eq!(owner_view.until, NOW + 60_000);
}

#[test]
fn holder_extends_its_own_lease() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let vault = f.vaults.create(&owner, "Projekt", "notatki", &key()).unwrap().info.id;
    f.leases.acquire(&who(&owner, "laptop"), &vault, NAME, 60, NOW).unwrap();

    let view = f.leases.acquire(&who(&owner, "laptop"), &vault, NAME, 60, NOW + 30_000).unwrap();
    assert!(view.granted);
    assert_eq!(view.until, NOW + 90_000);
}

#[test]
fn expired_lease_is_taken_over_and_the_old_row_is_gone() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let editor = user(&f.auth, "editor@example.test");
    let vault = shared_vault(&f, &owner, &editor, "editor");
    f.leases.acquire(&who(&owner, "laptop"), &vault, NAME, 1, NOW).unwrap();

    let taken = f.leases.acquire(&who(&editor, "phone"), &vault, NAME, 60, NOW + 1_000).unwrap();
    assert!(taken.granted);
    assert_eq!(taken.until, NOW + 61_000);
    let refused = f.leases.acquire(&who(&owner, "laptop"), &vault, NAME, 60, NOW + 1_000).unwrap();
    assert!(!refused.granted);
    assert_eq!(refused.until, NOW + 61_000);
}

#[test]
fn viewers_get_403_and_outsiders_get_404() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let viewer = user(&f.auth, "viewer@example.test");
    let stranger = user(&f.auth, "stranger@example.test");
    let vault = shared_vault(&f, &owner, &viewer, "viewer");

    assert_eq!(status(f.leases.acquire(&who(&viewer, "laptop"), &vault, NAME, 60, NOW).unwrap_err()), StatusCode::FORBIDDEN);
    assert_eq!(status(f.leases.release(&who(&viewer, "laptop"), &vault, NAME).unwrap_err()), StatusCode::FORBIDDEN);
    assert_eq!(status(f.leases.acquire(&who(&stranger, "laptop"), &vault, NAME, 60, NOW).unwrap_err()), StatusCode::NOT_FOUND);
    assert_eq!(status(f.leases.release(&who(&stranger, "laptop"), &vault, NAME).unwrap_err()), StatusCode::NOT_FOUND);
    // Unknown vaults look the same as vaults the caller is not in.
    assert_eq!(status(f.leases.acquire(&who(&owner, "laptop"), "missing", NAME, 60, NOW).unwrap_err()), StatusCode::NOT_FOUND);
}

#[test]
fn a_personal_vault_has_leases_for_its_owner_only() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let stranger = user(&f.auth, "stranger@example.test");
    let personal = format!("browser-{owner}");
    f.leases.acquire(&who(&owner, "laptop"), &personal, NAME, 60, NOW).unwrap();
    f.leases.release(&who(&owner, "laptop"), &personal, NAME).unwrap();
    assert_eq!(status(f.leases.acquire(&who(&stranger, "laptop"), &personal, NAME, 60, NOW).unwrap_err()), StatusCode::NOT_FOUND);
    assert_eq!(status(f.leases.release(&who(&stranger, "laptop"), &personal, NAME).unwrap_err()), StatusCode::NOT_FOUND);
}

#[test]
fn bad_names_and_ttls_are_400() {
    let ok = |name: Value, ttl: Value| lease_request(&name, &ttl).is_ok();
    assert!(ok(json!(NAME), json!(60)));
    assert!(ok(json!(NAME), json!(1)));
    assert!(ok(json!(NAME), json!(300)));
    for name in [json!(""), json!("0123"), json!(NAME.to_uppercase()), json!(format!("{NAME}0")), json!(format!("{}g", &NAME[1..])), json!(null), json!(42)] {
        assert_eq!(status(lease_request(&name, &json!(60)).unwrap_err()), StatusCode::BAD_REQUEST, "{name}");
    }
    for ttl in [json!(0), json!(-5), json!(301), json!("60"), json!(1.5), json!(null)] {
        assert_eq!(status(lease_request(&json!(NAME), &ttl).unwrap_err()), StatusCode::BAD_REQUEST, "{ttl}");
    }
}

#[test]
fn release_by_another_device_changes_nothing() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let editor = user(&f.auth, "editor@example.test");
    let vault = shared_vault(&f, &owner, &editor, "editor");
    f.leases.acquire(&who(&editor, "laptop"), &vault, NAME, 60, NOW).unwrap();

    f.leases.release(&who(&editor, "phone"), &vault, NAME).unwrap();
    f.leases.release(&who(&owner, "desktop"), &vault, NAME).unwrap();
    f.leases.release(&who(&owner, "desktop"), &vault, &"e".repeat(32)).unwrap();

    let view = f.leases.acquire(&who(&owner, "desktop"), &vault, NAME, 60, NOW).unwrap();
    assert!(!view.granted);
    assert_eq!(view.until, NOW + 60_000);
}

#[test]
fn release_by_holder_frees_the_lease() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let editor = user(&f.auth, "editor@example.test");
    let vault = shared_vault(&f, &owner, &editor, "editor");
    f.leases.acquire(&who(&editor, "laptop"), &vault, NAME, 60, NOW).unwrap();

    f.leases.release(&who(&editor, "laptop"), &vault, NAME).unwrap();
    let view = f.leases.acquire(&who(&owner, "desktop"), &vault, NAME, 60, NOW).unwrap();
    assert!(view.granted);
}

#[test]
fn fifty_one_leases_per_vault_is_429() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let vault = f.vaults.create(&owner, "Projekt", "notatki", &key()).unwrap().info.id;
    let names: Vec<String> = (0..=MAX_LEASES_PER_VAULT + 1).map(|i| format!("{i:032x}")).collect();
    for name in &names[..MAX_LEASES_PER_VAULT as usize] {
        assert!(f.leases.acquire(&who(&owner, "laptop"), &vault, name, 60, NOW).unwrap().granted);
    }
    // Renewing one of the 50 is not a new lease.
    assert!(f.leases.acquire(&who(&owner, "laptop"), &vault, &names[0], 60, NOW).unwrap().granted);
    let full = f.leases.acquire(&who(&owner, "laptop"), &vault, &names[50], 60, NOW).unwrap_err();
    assert_eq!(status(full), StatusCode::TOO_MANY_REQUESTS);

    // Released leases make room again, and expired ones stop counting.
    f.leases.release(&who(&owner, "laptop"), &vault, &names[1]).unwrap();
    assert!(f.leases.acquire(&who(&owner, "laptop"), &vault, &names[50], 60, NOW).unwrap().granted);
    let later = NOW + 61_000;
    assert!(f.leases.acquire(&who(&owner, "phone"), &vault, &names[51], 60, later).unwrap().granted);
}

#[test]
fn deleting_a_vault_deletes_its_leases() {
    let f = fixture();
    let owner = user(&f.auth, "owner@example.test");
    let vault = f.vaults.create(&owner, "Projekt", "notatki", &key()).unwrap().info.id;
    f.leases.acquire(&who(&owner, "laptop"), &vault, NAME, 60, NOW).unwrap();

    let db = Connection::open(f.dir.path().join("auth.db")).unwrap();
    db.pragma_update(None, "foreign_keys", "ON").unwrap();
    db.execute("DELETE FROM vaults WHERE vault_id=?1", [&vault]).unwrap();
    let left: i64 = db.query_row("SELECT COUNT(*) FROM vault_leases", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}
