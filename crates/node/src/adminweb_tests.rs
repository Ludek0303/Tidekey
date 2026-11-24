use super::*;

use axum::Extension;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::auth::AuthService;
use crate::files::Limits;
use crate::objstore::LocalStore;
use crate::vaults::VaultLocks;
use crate::websync::Envelope;

const SECRET: &str = "admin panel password";

struct Node {
    admin: SocketAddr,
    web: SocketAddr,
    dir: tempfile::TempDir,
    auth: Arc<AuthService>,
    vaults: Arc<VaultService>,
    sync: Arc<BrowserSync>,
    files: Arc<FileService>,
}

/// The panel on one port and the user API on another. `peer`: the address the panel believes it is called from.
async fn node_from(peer: Option<SocketAddr>) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let auth = Arc::new(AuthService::open(dir.path()).unwrap());
    let locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
    let sync = Arc::new(BrowserSync::open(dir.path(), vaults.clone(), locks).unwrap());
    let store = Arc::new(LocalStore::open(&dir.path().join("attachments")).unwrap());
    let files = Arc::new(FileService::open(dir.path(), sync.clone(), Limits::from_env(), store).unwrap());
    let panel = AdminWeb::new(dir.path(), SECRET, vaults.clone(), sync.clone(), files.clone()).unwrap();
    let mut admin_app = app(Arc::new(panel));
    if let Some(peer) = peer {
        admin_app = admin_app.layer(Extension(ConnectInfo(peer)));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let admin = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, admin_app.into_make_service_with_connect_info::<SocketAddr>()).await });
    let web_app = crate::auth::routes(auth.clone()).merge(crate::vaults::routes(auth.clone(), vaults.clone(), sync.clone(), files.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let web = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web_app).await });
    Node { admin, web, dir, auth, vaults, sync, files }
}

async fn node() -> Node { node_from(None).await }

/// One request: status, JSON body (null when none), and the Set-Cookie value if any.
async fn http(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: Value) -> (u16, Value, Option<String>) {
    let body = if body.is_null() { String::new() } else { body.to_string() };
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (name, value) in headers { head.push_str(&format!("{name}: {value}\r\n")); }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text[9..12].parse().unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let cookie = head.lines().find_map(|l| l.strip_prefix("set-cookie: ").map(str::to_string));
    (status, serde_json::from_str(body).unwrap_or(Value::Null), cookie)
}

const MUTATE: (&str, &str) = ("X-Notes-Admin", "1");

async fn login(n: &Node) -> String {
    let (status, _, cookie) = http(n.admin, "POST", "/admin/api/login", &[MUTATE], json!({ "password": SECRET })).await;
    assert_eq!(status, 200);
    let cookie = cookie.unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict") && cookie.contains("Path=/admin"), "{cookie}");
    cookie.split(';').next().unwrap().to_string()
}

async fn call(n: &Node, cookie: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let (status, body, _) = http(n.admin, method, path, &[("Cookie", cookie), MUTATE], body).await;
    (status, body)
}

fn key() -> Envelope {
    Envelope { schema: "notes-key-v1".into(), nonce: BASE64.encode([7u8; 12]), ciphertext: BASE64.encode([9u8; 48]), key_epoch: None }
}

fn jwk(seed: u8) -> Value {
    json!({ "kty": "EC", "crv": "P-256", "x": BASE64URL.encode([seed; 32]), "y": BASE64URL.encode([seed.wrapping_add(1); 32]) })
}

fn sealed(seed: u8) -> Value {
    json!({ "schema": "notes-sealed-v1", "epk": jwk(seed), "nonce": BASE64.encode([seed; 12]), "ciphertext": BASE64.encode([seed; 48]) })
}

fn user(n: &Node, email: &str) -> (String, String) {
    let (user, token) = n.auth.register(email, "A long test password 1").unwrap();
    (user.id, format!("notes_session={token}"))
}

#[tokio::test]
async fn a_wrong_password_a_missing_header_and_a_public_peer_are_refused() {
    let n = node().await;
    assert_eq!(http(n.admin, "POST", "/admin/api/login", &[MUTATE], json!({ "password": "nope" })).await.0, 401);
    assert_eq!(http(n.admin, "POST", "/admin/api/login", &[], json!({ "password": SECRET })).await.0, 403);
    assert_eq!(http(n.admin, "POST", "/admin/api/login", &[MUTATE, ("Origin", "http://evil.example")], json!({ "password": SECRET })).await.0, 403);
    assert_eq!(http(n.admin, "GET", "/admin/api/overview", &[], Value::Null).await.0, 401);
    let cookie = login(&n).await;
    // a mutation without the header is refused even with a session
    let (status, _, _) = http(n.admin, "PATCH", "/admin/api/users/x", &[("Cookie", &cookie)], json!({ "personal": "off" })).await;
    assert_eq!(status, 403);
    let (status, page, _) = http(n.admin, "GET", "/admin", &[], Value::Null).await;
    assert_eq!((status, page), (200, Value::Null)); // HTML, not JSON
    // logout ends the session
    assert_eq!(call(&n, &cookie, "POST", "/admin/api/logout", Value::Null).await.0, 200);
    assert_eq!(call(&n, &cookie, "GET", "/admin/api/overview", Value::Null).await.0, 401);

    let public = node_from(Some("203.0.113.9:4000".parse().unwrap())).await;
    let (status, body, _) = http(public.admin, "POST", "/admin/api/login", &[MUTATE], json!({ "password": SECRET })).await;
    assert_eq!(status, 403);
    assert!(body["error"].as_str().unwrap().contains("sieci lokalnej"));
    assert_eq!(http(public.admin, "GET", "/admin", &[], Value::Null).await.0, 403);
    let lan = node_from(Some("192.168.1.20:4000".parse().unwrap())).await;
    login(&lan).await;
}

#[tokio::test]
async fn five_failures_lock_the_address_for_a_while() {
    let n = node().await;
    for _ in 0..MAX_FAILURES {
        assert_eq!(http(n.admin, "POST", "/admin/api/login", &[MUTATE], json!({ "password": "wrong" })).await.0, 401);
    }
    assert_eq!(http(n.admin, "POST", "/admin/api/login", &[MUTATE], json!({ "password": SECRET })).await.0, 429);
}

#[test]
fn the_panel_does_not_start_without_a_password() {
    let dir = tempfile::tempdir().unwrap();
    let _auth = AuthService::open(dir.path()).unwrap();
    let locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
    let sync = Arc::new(BrowserSync::open(dir.path(), vaults.clone(), locks).unwrap());
    let store = Arc::new(LocalStore::open(&dir.path().join("attachments")).unwrap());
    let files = Arc::new(FileService::open(dir.path(), sync.clone(), Limits::from_env(), store).unwrap());
    let err = AdminWeb::new(dir.path(), " ", vaults, sync, files).err().unwrap();
    assert!(err.contains("NOTES_ADMIN_PASSWORD"));
}

#[tokio::test]
async fn overview_vaults_quota_and_member_removal() {
    let n = node().await;
    let (anna, _) = user(&n, "anna@example.test");
    let (bartek, _) = user(&n, "bartek@example.test");
    let vault = n.vaults.create(&anna, "Firma", "organizacja", &key()).unwrap().info.id;
    n.auth_db().execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,'editor','{}',0)", params![vault, bartek]).unwrap();
    let cookie = login(&n).await;

    let (status, overview) = call(&n, &cookie, "GET", "/admin/api/overview", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(overview["users"], 2);
    assert_eq!(overview["vaults"]["organization"], 1);
    assert!(overview["disk"]["dataBytes"].as_u64().unwrap() > 0);
    assert_eq!(overview["storage"]["current"], "local");
    #[cfg(unix)]
    assert!(overview["disk"]["totalBytes"].as_u64().unwrap() >= overview["disk"]["freeBytes"].as_u64().unwrap());

    let (_, list) = call(&n, &cookie, "GET", "/admin/api/vaults", Value::Null).await;
    assert_eq!(list[0]["owner"]["email"], "anna@example.test");
    assert_eq!(list[0]["members"].as_array().unwrap().len(), 2);
    assert_eq!(list[0]["quotaDefault"], true);

    let path = format!("/admin/api/vaults/{vault}");
    assert_eq!(call(&n, &cookie, "PATCH", &path, json!({ "quotaMb": 0 })).await.0, 400);
    assert_eq!(call(&n, &cookie, "PATCH", "/admin/api/vaults/v-nope", json!({ "quotaMb": 5 })).await.0, 404);
    let (status, quota) = call(&n, &cookie, "PATCH", &path, json!({ "quotaMb": 5 })).await;
    assert_eq!((status, quota["quotaBytes"].as_u64(), quota["quotaDefault"].as_bool()), (200, Some(5 << 20), Some(false)));
    // the file routes use it
    assert_eq!(n.files.list(&anna, &vault).unwrap().quota, 5 << 20);
    call(&n, &cookie, "PATCH", &path, json!({ "quotaMb": null })).await;
    assert!(n.files.vault_usage(&vault).unwrap().2);

    assert_eq!(call(&n, &cookie, "DELETE", &format!("{path}/members/{anna}"), Value::Null).await.0, 409);
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{path}/members/{bartek}"), Value::Null).await.0, 200);
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{path}/members/{bartek}"), Value::Null).await.0, 404);
    let rotate: bool = n.auth_db().query_row("SELECT needs_rotation FROM vaults WHERE vault_id=?1", [&vault], |r| r.get(0)).unwrap();
    assert!(rotate);
    assert!(crate::audit::CAPTURED.lock().unwrap().iter().any(|l| l.contains("event=member_removed by=server-admin")));
}

#[tokio::test]
async fn users_personal_and_deletion() {
    let n = node().await;
    let (anna, _) = user(&n, "anna@example.test");
    let (bot, _) = user(&n, "bot@example.test");
    let (cezary, _) = user(&n, "cezary@example.test");
    let vault = n.vaults.create(&anna, "Firma", "organizacja", &key()).unwrap().info.id;
    n.auth_db().execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,'editor','{}',0)", params![vault, cezary]).unwrap();
    let cookie = login(&n).await;

    let (_, users) = call(&n, &cookie, "GET", "/admin/api/users", Value::Null).await;
    let row = users.as_array().unwrap().iter().find(|u| u["id"] == anna).unwrap().clone();
    assert_eq!((row["personal"].as_str(), row["sessions"].as_i64()), (Some("allowed"), Some(1)));
    assert_eq!(row["vaults"][0]["role"], "owner");

    assert_eq!(call(&n, &cookie, "PATCH", &format!("/admin/api/users/{bot}"), json!({ "personal": "requested" })).await.0, 400);
    assert_eq!(call(&n, &cookie, "PATCH", "/admin/api/users/nobody", json!({ "personal": "off" })).await.0, 404);
    assert_eq!(call(&n, &cookie, "PATCH", &format!("/admin/api/users/{bot}"), json!({ "personal": "off" })).await.0, 200);
    assert_eq!(n.sync.access_role(&bot, &format!("browser-{bot}")).unwrap(), None);

    let (status, plan) = call(&n, &cookie, "DELETE", &format!("/admin/api/users/{bot}"), Value::Null).await;
    assert_eq!((status, plan["applied"].as_bool()), (200, Some(false)));
    let (status, refused) = call(&n, &cookie, "DELETE", &format!("/admin/api/users/{anna}?apply=1"), Value::Null).await;
    assert_eq!(status, 409);
    assert!(refused["error"].as_str().unwrap().contains("Nie można usunąć konta"));
    assert_eq!(call(&n, &cookie, "DELETE", &format!("/admin/api/users/{bot}?apply=1"), Value::Null).await.0, 200);
    assert_eq!(call(&n, &cookie, "DELETE", &format!("/admin/api/users/{bot}?apply=1"), Value::Null).await.0, 404);
    let (_, users) = call(&n, &cookie, "GET", "/admin/api/users", Value::Null).await;
    assert_eq!(users.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn an_invited_account_has_no_own_notes_until_allowed() {
    let n = node().await;
    // registration with an invite (open mode: any invite token marks it) gives `off`
    let body = json!({ "email": "nowa@example.test", "password": "A long test password 1", "name": "Nowa", "invite": "a".repeat(64) });
    let (status, reply, cookie) = http(n.web, "POST", "/api/auth/register", &[], body).await;
    assert_eq!((status, reply["user"]["personal"].as_str()), (201, Some("off")));
    let session = cookie.unwrap().split(';').next().unwrap().to_string();
    let id = reply["user"]["id"].as_str().unwrap().to_string();
    let personal = format!("browser-{id}");
    assert_eq!(n.sync.access_role(&id, &personal).unwrap(), None);
    assert!(n.sync.put(&id, &personal, 0, &key()).is_err());

    let (status, reply, _) = http(n.web, "POST", "/api/me/personal-request", &[("Cookie", &session)], Value::Null).await;
    assert_eq!((status, reply["personal"].as_str()), (200, Some("requested")));
    let (_, me, _) = http(n.web, "GET", "/api/auth/me", &[("Cookie", &session)], Value::Null).await;
    assert_eq!(me["user"]["personal"], "requested");

    let cookie = login(&n).await;
    call(&n, &cookie, "PATCH", &format!("/admin/api/users/{id}"), json!({ "personal": "allowed" })).await;
    assert_eq!(n.sync.access_role(&id, &personal).unwrap(), Some(crate::vaults::Role::Owner));
    // asking again changes nothing once allowed
    let (_, reply, _) = http(n.web, "POST", "/api/me/personal-request", &[("Cookie", &session)], Value::Null).await;
    assert_eq!(reply["personal"], "allowed");
    // an open registration keeps its own notes
    let (_, reply, _) = http(n.web, "POST", "/api/auth/register", &[], json!({ "email": "sam@example.test", "password": "A long test password 1", "name": "Sam" })).await;
    assert_eq!(reply["user"]["personal"], "allowed");
}

#[tokio::test]
async fn an_assignment_is_completed_by_the_owners_browser() {
    let n = node().await;
    let (anna, anna_cookie) = user(&n, "anna@example.test");
    let (bartek, bartek_cookie) = user(&n, "bartek@example.test");
    let (cezary, cezary_cookie) = user(&n, "cezary@example.test");
    let vault = n.vaults.create(&anna, "Firma", "organizacja", &key()).unwrap().info.id;
    n.auth_db().execute("INSERT INTO vault_members(vault_id,user_id,role,wrapped_key,added_at) VALUES (?1,?2,'editor','{}',0)", params![vault, cezary]).unwrap();
    let cookie = login(&n).await;
    let assign = |who: &str| format!("/admin/api/users/{who}/assignments");

    assert_eq!(call(&n, &cookie, "POST", &assign(&bartek), json!({ "vaultId": format!("browser-{anna}"), "role": "editor" })).await.0, 400);
    assert_eq!(call(&n, &cookie, "POST", &assign(&bartek), json!({ "vaultId": vault, "role": "owner" })).await.0, 400);
    assert_eq!(call(&n, &cookie, "POST", &assign(&cezary), json!({ "vaultId": vault, "role": "viewer" })).await.0, 409);
    assert_eq!(call(&n, &cookie, "POST", &assign(&bartek), json!({ "vaultId": vault, "role": "editor" })).await.0, 200);
    let (_, users) = call(&n, &cookie, "GET", "/admin/api/users", Value::Null).await;
    let row = users.as_array().unwrap().iter().find(|u| u["id"] == bartek).unwrap().clone();
    assert_eq!((row["assignments"][0]["vaultName"].as_str(), row["assignments"][0]["role"].as_str()), (Some("Firma"), Some("editor")));

    // the owner's browser sees it only once the person has a box key; an editor sees nothing
    let list = format!("/api/vaults/{vault}/assignments");
    let (status, rows, _) = http(n.web, "GET", &list, &[("Cookie", &anna_cookie)], Value::Null).await;
    assert_eq!((status, rows.as_array().map(Vec::len)), (200, Some(0)));
    n.vaults.set_box_key(&bartek, &jwk(3), &key()).unwrap();
    let (_, rows, _) = http(n.web, "GET", &list, &[("Cookie", &anna_cookie)], Value::Null).await;
    assert_eq!((rows[0]["userId"].as_str(), rows[0]["role"].as_str()), (Some(bartek.as_str()), Some("editor")));
    assert_eq!(rows[0]["boxKey"], jwk(3));
    assert_eq!(http(n.web, "GET", &list, &[("Cookie", &cezary_cookie)], Value::Null).await.0, 403);

    let complete = format!("/api/vaults/{vault}/assignments/{bartek}/complete");
    assert_eq!(http(n.web, "POST", &complete, &[("Cookie", &anna_cookie)], json!({ "sealedKey": sealed(5), "keyEpoch": 2 })).await.0, 409);
    assert_eq!(http(n.web, "POST", &complete, &[("Cookie", &cezary_cookie)], json!({ "sealedKey": sealed(5), "keyEpoch": 1 })).await.0, 403);
    let (status, reply, _) = http(n.web, "POST", &complete, &[("Cookie", &anna_cookie)], json!({ "sealedKey": sealed(5), "keyEpoch": 1 })).await;
    assert_eq!((status, reply["vault"]["role"].as_str()), (200, Some("editor")));
    // the person opens the pending key, as after a rotation
    let detail = n.vaults.detail(&bartek, &vault).unwrap();
    assert_eq!((detail.wrapped_key_epoch, detail.pending_key.as_ref().map(|p| p.key_epoch)), (0, Some(1)));
    assert_eq!(detail.pending_key.unwrap().sealed_key, sealed(5));
    let (_, mine, _) = http(n.web, "GET", "/api/vaults", &[("Cookie", &bartek_cookie)], Value::Null).await;
    assert_eq!(mine["vaults"][0]["id"], vault);
    // the assignment is gone, and can't be withdrawn any more
    assert_eq!(http(n.web, "POST", &complete, &[("Cookie", &anna_cookie)], json!({ "sealedKey": sealed(5), "keyEpoch": 1 })).await.0, 404);
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{}/{vault}", assign(&bartek)), Value::Null).await.0, 404);

    // withdrawing one that waits
    let (dorota, _) = user(&n, "dorota@example.test");
    call(&n, &cookie, "POST", &assign(&dorota), json!({ "vaultId": vault, "role": "viewer" })).await;
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{}/{vault}", assign(&dorota)), Value::Null).await.0, 200);
}

#[tokio::test]
async fn storage_status_and_refused_migrations() {
    let n = node().await;
    let cookie = login(&n).await;
    let (status, storage) = call(&n, &cookie, "GET", "/admin/api/storage", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(storage, json!({ "current": "local", "available": ["local"], "objects": 0, "bytes": 0, "migration": null }));
    let migrate = "/admin/api/storage/migrate";
    assert_eq!(call(&n, &cookie, "POST", migrate, json!({ "target": "local" })).await.0, 409); // already there
    assert_eq!(call(&n, &cookie, "POST", migrate, json!({ "target": "seaweedfs" })).await.0, 409); // not configured
    assert_eq!(call(&n, &cookie, "POST", migrate, json!({ "target": "s3" })).await.0, 400);
    let (status, _, _) = http(n.admin, "POST", migrate, &[("Cookie", &cookie)], json!({ "target": "seaweedfs" })).await;
    assert_eq!(status, 403); // no X-Notes-Admin
    assert_eq!(http(n.admin, "GET", "/admin/api/storage", &[], Value::Null).await.0, 401);
}

#[tokio::test]
async fn signup_codes_are_made_listed_and_revoked_by_the_admin_only() {
    let n = node().await;
    let (anna, _) = user(&n, "anna@example.test");
    let cookie = login(&n).await;
    let path = "/admin/api/signup-codes";
    assert_eq!(http(n.admin, "GET", path, &[], Value::Null).await.0, 401);
    assert_eq!(http(n.admin, "POST", path, &[MUTATE], json!({ "label": "x", "days": 7 })).await.0, 401);
    let (status, _, _) = http(n.admin, "POST", path, &[("Cookie", &cookie)], json!({ "label": "x", "days": 7 })).await;
    assert_eq!(status, 403); // no X-Notes-Admin

    assert_eq!(call(&n, &cookie, "POST", path, json!({ "label": "", "days": 91 })).await.0, 400);
    let (status, made) = call(&n, &cookie, "POST", path, json!({ "label": " Ola ", "days": 7 })).await;
    assert_eq!(status, 200);
    let (code, id) = (made["code"].as_str().unwrap().to_string(), made["id"].as_str().unwrap().to_string());
    assert!(made["expiresAt"].as_i64().unwrap() > 0);
    let (_, made_used) = call(&n, &cookie, "POST", path, json!({ "label": "Bartek", "days": 1 })).await;
    let used = made_used["id"].as_str().unwrap().to_string();
    n.auth_db().execute("UPDATE signup_codes SET used_at = 5, used_by = ?1 WHERE code_id = ?2", params![anna, used]).unwrap();

    let (status, list) = call(&n, &cookie, "GET", path, Value::Null).await;
    assert_eq!(status, 200);
    let codes = list["codes"].as_array().unwrap();
    assert_eq!(codes.len(), 2);
    assert!(codes.iter().all(|c| c.get("code").is_none() && c.get("codeHash").is_none()), "{list}");
    assert!(!list.to_string().contains(&code));
    let row = codes.iter().find(|c| c["id"] == id).unwrap();
    assert_eq!((row["label"].as_str(), row["usedAt"].is_null()), (Some("Ola"), true));
    assert_eq!(codes.iter().find(|c| c["id"] == used).unwrap()["usedByEmail"], "anna@example.test");

    // a used code is kept; an unused one goes, and a second revoke finds nothing
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{path}/{used}"), Value::Null).await.0, 404);
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{path}/{id}"), Value::Null).await.0, 204);
    assert_eq!(call(&n, &cookie, "DELETE", &format!("{path}/{id}"), Value::Null).await.0, 404);
    let (_, list) = call(&n, &cookie, "GET", path, Value::Null).await;
    assert_eq!(list["codes"].as_array().unwrap().len(), 1);
}

impl Node {
    fn auth_db(&self) -> Connection { Connection::open(self.dir.path().join("auth.db")).unwrap() }
}
