use super::*;

use std::net::SocketAddr;

use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signer, SigningKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::files::{FileService, Limits};
use crate::objstore::LocalStore;
use crate::vaults::VaultService;

const PASSWORD: &str = "A long test password 1";
const IP: &str = "198.51.100.7";

struct Node {
    addr: SocketAddr,
    dir: tempfile::TempDir,
    auth: Arc<AuthService>,
    vaults: Arc<VaultService>,
    sync: Arc<BrowserSync>,
    agents: Arc<AgentService>,
    files: Arc<FileService>,
}

/// Every route of the web API on a local port, without `http::trust_forwarded`, so a test picks the client address.
async fn node_with(config: Config) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let auth = Arc::new(AuthService::open(dir.path()).unwrap());
    let locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
    let sync = Arc::new(BrowserSync::open(dir.path(), vaults.clone(), locks.clone()).unwrap());
    let store = Arc::new(LocalStore::open(&dir.path().join("attachments")).unwrap());
    let files = Arc::new(FileService::open(dir.path(), sync.clone(), Limits::from_env(), store).unwrap());
    let agents = Arc::new(AgentService::open(dir.path(), sync.clone(), locks, config).unwrap());
    let app = crate::auth::routes(auth.clone())
        .merge(crate::websync::routes(auth.clone(), sync.clone()))
        .merge(crate::vaults::routes(auth.clone(), vaults.clone(), sync.clone(), files.clone()))
        .merge(crate::files::routes(auth.clone(), files.clone()))
        .merge(routes(auth.clone(), agents.clone(), files.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    Node { addr, dir, auth, vaults, sync, agents, files }
}

async fn node() -> Node { node_with(Config::default()).await }

fn db(n: &Node) -> Connection { Connection::open(n.dir.path().join("auth.db")).unwrap() }

/// One HTTP/1.1 request on a fresh connection: the status and the JSON body (null when there is none).
async fn http(addr: SocketAddr, method: &str, path: &str, headers: &[(String, String)], body: &[u8]) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (name, value) in headers { head.push_str(&format!("{name}: {value}\r\n")); }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text[9..12].parse().unwrap();
    let body = text.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

struct Person { id: String, cookie: String }

fn person(n: &Node, email: &str) -> Person {
    let (user, token) = n.auth.register(email, PASSWORD).unwrap();
    Person { id: user.id, cookie: format!("notes_session={token}") }
}

impl Person {
    async fn call(&self, n: &Node, method: &str, path: &str, body: Value) -> (u16, Value) {
        let bytes = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
        http(n.addr, method, path, &[("Cookie".into(), self.cookie.clone())], &bytes).await
    }
}

/// A chat's MCP: its Ed25519 key from a fixed seed, its session token once paired, and where it calls from.
struct Mcp {
    key: SigningKey,
    box_key: String,
    token: Option<String>,
    version: String,
    ip: String,
}

impl Mcp {
    fn new(seed: u8) -> Self {
        Self { key: SigningKey::from_bytes(&[seed; 32]), box_key: B64U.encode([seed.wrapping_add(100); 32]), token: None, version: "1.0.0".into(), ip: IP.into() }
    }

    fn sign_key(&self) -> String { B64U.encode(self.key.verifying_key().to_bytes()) }

    fn sign(&self, text: &str) -> String { B64U.encode(self.key.sign(text.as_bytes()).to_bytes()) }

    /// The request headers, with the proof over `signed_version` (the sent version is `self.version`).
    fn headers(&self, method: &str, path: &str, body: &[u8], time: i64, nonce: &str, signed_version: &str) -> Vec<(String, String)> {
        let message = format!("notes-agent-req-v1\n{method}\n{path}\n{}\n{time}\n{nonce}\n{signed_version}", hex(&h(body)));
        let mut headers = vec![
            ("Notes-Agent-Time".to_string(), time.to_string()),
            ("Notes-Agent-Nonce".to_string(), nonce.to_string()),
            ("Notes-Agent-Version".to_string(), self.version.clone()),
            ("Notes-Agent-Proof".to_string(), self.sign(&message)),
            ("X-Forwarded-For".to_string(), self.ip.clone()),
        ];
        if let Some(token) = &self.token { headers.push(("Authorization".into(), format!("NotesAgent {token}"))); }
        headers
    }

    async fn call(&self, n: &Node, method: &str, path: &str, body: Value) -> (u16, Value) {
        let bytes = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
        let headers = self.headers(method, path, &bytes, now_millis(), &random_hex::<16>().unwrap(), &self.version);
        http(n.addr, method, path, &headers, &bytes).await
    }

    fn claim_body(&self, code: &str) -> Value {
        let normalized = normalize_code(code).unwrap_or_default();
        json!({
            "code": code, "signKey": self.sign_key(), "boxKey": self.box_key, "device": { "name": "laptop", "os": "linux" },
            "mcpVersion": self.version,
            "proof": self.sign(&format!("notes agent-claim v1\n{normalized}\n{}\n{}", self.sign_key(), self.box_key)),
        })
    }

    async fn claim(&self, n: &Node, code: &str) -> (u16, Value) {
        http(n.addr, "POST", "/api/agent-pair/claim", &[("X-Forwarded-For".into(), self.ip.clone())], self.claim_body(code).to_string().as_bytes()).await
    }
}

fn sealed_key(seed: u8) -> Value { json!({ "schema": SEALED_SCHEMA, "box": B64U.encode([seed; 120]) }) }
/// The person's own copy of a scope; marked so a test can look for it anywhere.
fn own_scope() -> Value { json!({ "schema": "notes-key-v1", "nonce": BASE64.encode([11u8; 12]), "ciphertext": BASE64.encode(b"OWN-SCOPE-MARKER-0123456789") }) }
fn sealed_scope() -> Value { json!({ "schema": SCOPE_SCHEMA, "box": B64U.encode([3u8; 200]) }) }

fn cert(user: &str, mcp: &Mcp, agent_id: &str, vaults: &[(&str, &str)]) -> Value {
    let now = now_millis();
    json!({
        "schema": CERT_SCHEMA, "agentId": agent_id, "userId": user, "signKey": mcp.sign_key(), "boxKey": mcp.box_key,
        "vaults": vaults.iter().map(|(v, mode)| json!({ "vaultId": v, "whole": true, "parts": [], "writeMode": mode })).collect::<Vec<_>>(),
        "createdAt": now, "expiresAt": now + 30 * DAY,
    })
}

fn epoch(n: &Node, user: &str, vault: &str) -> i64 {
    if is_shared_vault_id(vault) { n.vaults.key_epoch(vault).unwrap() } else { n.vaults.personal_key_epoch(user).unwrap() }
}

fn create_body(n: &Node, who: &Person, mcp: &Mcp, pairing: &str, vaults: &[(&str, &str)], hours: i64) -> Value {
    let agent_id = random_hex::<16>().unwrap();
    json!({
        "pairingId": pairing, "cert": cert(&who.id, mcp, &agent_id, vaults), "signature": "c2lnbmF0dXJl",
        "keys": vaults.iter().map(|(v, _)| json!({ "vaultId": v, "keyEpoch": epoch(n, &who.id, v), "sealedKey": sealed_key(1) })).collect::<Vec<_>>(),
        "scopes": vaults.iter().map(|(v, _)| json!({ "vaultId": v, "sealedScope": sealed_scope(), "ownScope": own_scope() })).collect::<Vec<_>>(),
        "sessionHours": hours,
    })
}

/// Starts a pairing in the app and claims its code from the MCP: (pairing id, pair token).
async fn start_and_claim(n: &Node, who: &Person, mcp: &Mcp) -> (String, String) {
    let (status, started) = who.call(n, "POST", "/api/me/agent-pairings", json!({})).await;
    assert_eq!(status, 201, "{started}");
    let (status, claimed) = mcp.claim(n, started["code"].as_str().unwrap()).await;
    assert_eq!(status, 200, "{claimed}");
    (started["pairingId"].as_str().unwrap().into(), claimed["pairToken"].as_str().unwrap().into())
}

/// The whole pairing: returns the chat's id and leaves its session token in `mcp`.
async fn pair(n: &Node, who: &Person, mcp: &mut Mcp, vaults: &[(&str, &str)]) -> String {
    let (pairing, pair_token) = start_and_claim(n, who, mcp).await;
    let (status, created) = who.call(n, "POST", "/api/me/agents", create_body(n, who, mcp, &pairing, vaults, 4)).await;
    assert_eq!(status, 201, "{created}");
    let (status, issued) = mcp.call(n, "GET", &format!("/api/agent-pair/{pair_token}"), Value::Null).await;
    assert_eq!(status, 200, "{issued}");
    mcp.token = Some(issued["sessionToken"].as_str().unwrap().into());
    created["agentId"].as_str().unwrap().into()
}

/// Anna owns "Klub" with chats on (direct writes allowed), Bartek is an editor there.
struct World { n: Node, anna: Person, bartek: Person, vault: String }

async fn world() -> World {
    let n = node().await;
    let anna = person(&n, "anna@example.test");
    let bartek = person(&n, "bartek@example.test");
    let vault = n.vaults.create(&anna.id, "Klub", "organizacja", &key()).unwrap().info.id;
    let invite = n.vaults.create_invite(&anna.id, &vault, "editor").unwrap();
    n.vaults.accept_invite(&bartek.id, &invite.token, &key(), 1).unwrap();
    let (status, _) = anna.call(&n, "PUT", &format!("/api/vaults/{vault}/agent-policy"),
        json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": false })).await;
    assert_eq!(status, 204);
    World { n, anna, bartek, vault }
}

fn key() -> Envelope {
    Envelope { schema: "notes-key-v1".into(), nonce: BASE64.encode([7u8; 12]), ciphertext: BASE64.encode([9u8; 48]), key_epoch: None }
}

fn snapshot(epoch: i64, byte: u8) -> Value {
    json!({ "schema": "notes-encrypted-v1", "nonce": BASE64.encode([byte; 12]), "ciphertext": BASE64.encode([byte; 40]), "keyEpoch": epoch })
}

fn proposal(mcp_agent: &str, user: &str) -> Value {
    json!({
        "schema": PROPOSAL_SCHEMA, "proposalId": "0123456789abcdef0123456789abcdef", "agentId": mcp_agent,
        "epk": { "kty": "EC", "crv": "P-256", "x": B64U.encode([4u8; 32]), "y": B64U.encode([5u8; 32]) },
        "nonce": BASE64.encode([6u8; 12]), "ciphertext": BASE64.encode([7u8; 64]),
        "signerUserId": user, "signerAgentId": mcp_agent, "alg": "ed25519", "signature": B64U.encode([8u8; 64]),
    })
}

#[test]
fn versions_compare_with_pre_releases_first() {
    assert_eq!(parse_version("1.2.3"), Some((1, 2, 3, true)));
    assert!(parse_version("1.0.0-beta.1").unwrap() < parse_version("1.0.0").unwrap());
    assert!(parse_version("1.0.0+build").unwrap() >= parse_version("1.0.0").unwrap());
    for bad in ["", "1.0", "1.0.0.0", "v1.0.0", "1..0", "1.0.0 "] { assert_eq!(parse_version(bad), None, "{bad}"); }
}

#[test]
fn pairing_codes_use_the_alphabet_and_normalize() {
    for _ in 0..50 {
        let code = new_code().unwrap();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
    }
    assert_eq!(normalize_code("k7qm-3xrp").as_deref(), Some("K7QM3XRP"));
    assert_eq!(normalize_code(" K7QM 3XRP "), Some("K7QM3XRP".into()));
    assert_eq!(normalize_code("K7QM-3XR0"), None, "0 is not in the alphabet");
}

#[tokio::test(flavor = "multi_thread")]
async fn version_endpoint_needs_no_session_and_shows_the_switch() {
    let n = node().await;
    let (status, v) = http(n.addr, "GET", "/api/version", &[], b"").await;
    assert_eq!(status, 200);
    assert_eq!(v["server"], env!("CARGO_PKG_VERSION"));
    assert_eq!((v["agentMin"].as_str(), v["agentLatest"].as_str(), v["agentsDisabled"].as_bool()), (Some("1.0.0"), Some("1.0.0"), Some(false)));
    let npm = v["update"]["npm"].as_str().unwrap();
    assert!(npm.starts_with("npx --yes @notatki/mcp@1.0.0 pair http") && npm.ends_with(&format!("://{}", n.addr)), "{npm}");
    assert_eq!(v["update"]["mcpb"], "");
    set_disabled(n.dir.path(), true).unwrap();
    assert_eq!(http(n.addr, "GET", "/api/version", &[], b"").await.1["agentsDisabled"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_chat_reads_and_writes_as_its_person_with_the_author_from_its_session() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(1);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;

    let (status, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["vaults"][0]["role"], "editor");
    assert_eq!(me["vaults"][0]["writeMode"], "direct");

    let path = format!("/api/agent/vaults/{}", w.vault);
    let (status, detail) = mcp.call(n, "GET", &path, Value::Null).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["agentKeys"], json!([{ "keyEpoch": 1, "sealedKey": sealed_key(1) }]));
    assert_eq!(detail["sealedScope"], sealed_scope());
    assert_eq!(detail["person"]["userId"], w.bartek.id.as_str());
    assert_eq!(detail["members"].as_array().unwrap().len(), 2);

    n.sync.put(&w.anna.id, &w.vault, 0, &serde_json::from_value(snapshot(1, 1)).unwrap()).unwrap();
    let (status, got) = mcp.call(n, "GET", &format!("{path}/snapshot"), Value::Null).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["revision"], 1);
    assert_eq!(got["author"], json!({ "userId": w.anna.id, "agentId": null }));

    // a client-given author is ignored: the stored one comes from the chat's session
    let body = json!({ "baseRevision": 1, "envelope": snapshot(1, 2), "author": { "userId": w.anna.id, "agentId": null } });
    let (status, put) = mcp.call(n, "POST", &format!("{path}/snapshot"), body).await;
    assert_eq!(status, 200, "{put}");
    assert_eq!(put["revision"], 2);
    let (_, _, author) = n.sync.stored(&w.anna.id, &w.vault).unwrap();
    assert_eq!(author, Some(Author { user_id: w.bartek.id.clone(), agent_id: Some(agent.clone()) }));

    // a stale base answers with the stored revision; an old key epoch is refused
    let (status, conflict) = mcp.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 1, "envelope": snapshot(1, 3) })).await;
    assert_eq!((status, conflict["code"].as_str(), conflict["revision"].as_i64()), (409, Some("conflict"), Some(2)));
    let mut no_epoch = snapshot(1, 3);
    no_epoch.as_object_mut().unwrap().remove("keyEpoch");
    let (status, stale) = mcp.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 2, "envelope": no_epoch })).await;
    assert_eq!((status, stale["code"].as_str()), (409, Some("stale-key")));

    // unchanged since R: no envelope and no full fetch counted; another full fetch within 5 minutes is refused
    let (status, same) = mcp.call(n, "GET", &format!("{path}/snapshot?since=2"), Value::Null).await;
    assert_eq!((status, same["envelope"].is_null()), (200, true));
    let (status, again) = mcp.call(n, "GET", &format!("{path}/snapshot"), Value::Null).await;
    assert_eq!((status, again["code"].as_str()), (429, Some("limit")));

    let (_, list) = w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await;
    let row = &list["agents"][0];
    assert_eq!((row["agentId"].as_str(), row["fetches"].as_i64(), row["writes"].as_i64()), (Some(agent.as_str()), Some(1), Some(1)));
    assert_eq!(row["knownIps"], json!([IP]));
    assert!(!list.to_string().contains(mcp.token.as_deref().unwrap()), "no token in the list");

    // the vault detail shows the chat to every member, and the owner's policy
    let (_, vault) = w.anna.call(n, "GET", &format!("/api/vaults/{}", w.vault), Value::Null).await;
    assert_eq!(vault["agentPolicy"], json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": false, "allowFileText": true }));
    let bartek_row = vault["members"].as_array().unwrap().iter().find(|m| m["userId"] == w.bartek.id.as_str()).unwrap().clone();
    assert_eq!(bartek_row["agents"][0]["agentId"], agent.as_str());
    assert!(bartek_row["agents"][0]["revokedAt"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_session_token_is_issued_once_and_only_after_the_person_finished() {
    let w = world().await;
    let n = &w.n;
    let mcp = Mcp::new(2);
    let (pairing, pair_token) = start_and_claim(n, &w.bartek, &mcp).await;
    let path = format!("/api/agent-pair/{pair_token}");
    let (status, waiting) = mcp.call(n, "GET", &path, Value::Null).await;
    assert_eq!((status, waiting["code"].as_str()), (404, Some("waiting")));
    // only the claimed key's proof is taken
    let (status, _) = Mcp::new(9).call(n, "GET", &path, Value::Null).await;
    assert_eq!(status, 401);
    let (_, state) = w.bartek.call(n, "GET", &format!("/api/me/agent-pairings/{pairing}"), Value::Null).await;
    assert_eq!((state["state"].as_str(), state["claim"]["signKey"].as_str()), (Some("claimed"), Some(mcp.sign_key().as_str())));
    assert_eq!(state["claim"]["ip"], IP);
    let (status, _) = w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 4)).await;
    assert_eq!(status, 201);
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.0, 200);
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.0, 410);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_token_opens_no_route_of_a_person() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(3);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    let v = &w.vault;
    let routes = [
        ("GET", "/api/me/agents".to_string(), Value::Null),
        ("POST", "/api/me/agent-pairings".into(), json!({})),
        ("DELETE", "/api/me/agents".into(), Value::Null),
        ("GET", "/api/me/signing-key".into(), Value::Null),
        ("GET", "/api/me/personal-key".into(), Value::Null),
        ("PATCH", "/api/auth/me".into(), json!({ "name": "X" })),
        ("GET", "/api/auth/export".into(), Value::Null),
        ("GET", "/api/vaults".into(), Value::Null),
        ("GET", format!("/api/vaults/{v}"), Value::Null),
        ("POST", format!("/api/vaults/{v}/invites"), json!({ "role": "editor" })),
        ("PATCH", format!("/api/vaults/{v}/members/{}", w.anna.id), json!({ "role": "viewer" })),
        ("POST", format!("/api/vaults/{v}/rotate"), json!({ "keyEpoch": 2, "keys": [] })),
        ("PUT", format!("/api/vaults/{v}/my-key"), json!({ "keyEpoch": 1, "wrappedKey": key() })),
        ("PUT", format!("/api/vaults/{v}/agent-policy"), json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": true })),
        ("GET", format!("/api/vaults/{v}/proposals"), Value::Null),
    ];
    for (method, path, body) in routes {
        let (status, reply) = mcp.call(n, method, &path, body).await;
        assert_eq!(status, 401, "{method} {path}: {reply}");
    }
    let (status, me) = mcp.call(n, "GET", "/api/auth/me", Value::Null).await;
    assert_eq!((status, me["authenticated"].as_bool()), (200, Some(false)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_without_a_valid_fresh_proof_is_refused() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(4);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let path = "/api/agent/me";
    let token = ("Authorization".to_string(), format!("NotesAgent {}", mcp.token.clone().unwrap()));
    let send = |headers: Vec<(String, String)>| async move { http(n.addr, "GET", path, &headers, b"").await };

    // the token alone does nothing
    let (status, reply) = send(vec![token.clone(), ("Notes-Agent-Version".into(), "1.0.0".into()), ("X-Forwarded-For".into(), IP.into())]).await;
    assert_eq!((status, reply["code"].as_str()), (401, Some("proof")));
    // the right token under another key's signature
    let mut other = Mcp::new(5);
    other.token = mcp.token.clone();
    assert_eq!(other.call(n, "GET", path, Value::Null).await.1["code"], "proof");
    // two minutes old
    let nonce = random_hex::<16>().unwrap();
    assert_eq!(send(mcp.headers("GET", path, b"", now_millis() - 2 * MINUTE, &nonce, "1.0.0")).await.0, 401);
    // the same nonce twice
    let headers = mcp.headers("GET", path, b"", now_millis(), &random_hex::<16>().unwrap(), "1.0.0");
    assert_eq!(send(headers.clone()).await.0, 200);
    assert_eq!(send(headers).await.1["code"], "proof");
    // another body or path than the one signed
    let headers = mcp.headers("GET", "/api/agent/vaults/x", b"", now_millis(), &random_hex::<16>().unwrap(), "1.0.0");
    assert_eq!(send(headers).await.0, 401);
    // a version header swapped on the way breaks the signature
    let mut swapped = mcp.headers("GET", path, b"", now_millis(), &random_hex::<16>().unwrap(), "1.0.0");
    swapped.iter_mut().find(|(k, _)| k == "Notes-Agent-Version").unwrap().1 = "9.9.9".into();
    assert_eq!(send(swapped).await.1["code"], "proof");
    // no version at all: 400; a version below the minimum, signed: 426
    let mut no_version = mcp.headers("GET", path, b"", now_millis(), &random_hex::<16>().unwrap(), "1.0.0");
    no_version.retain(|(k, _)| k != "Notes-Agent-Version");
    assert_eq!(send(no_version).await.0, 400);
    mcp.version = "0.9.0".into();
    let (status, old) = mcp.call(n, "GET", path, Value::Null).await;
    assert_eq!((status, old["code"].as_str()), (426, Some("version")));
    assert!(old["message"].as_str().unwrap().contains("npx --yes @notatki/mcp@1.0.0 pair"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_old_version_is_refused_at_the_claim_too() {
    let w = world().await;
    let (status, started) = w.bartek.call(&w.n, "POST", "/api/me/agent-pairings", json!({})).await;
    assert_eq!(status, 201);
    let mut mcp = Mcp::new(6);
    mcp.version = "0.9.9".into();
    let (status, reply) = mcp.claim(&w.n, started["code"].as_str().unwrap()).await;
    assert_eq!((status, reply["code"].as_str()), (426, Some("version")));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_operator_switch_stops_chats_and_pairing_but_not_people() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(7);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let (_, started) = w.anna.call(n, "POST", "/api/me/agent-pairings", json!({})).await;

    set_disabled(n.dir.path(), true).unwrap();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "disabled");
    assert_eq!(Mcp::new(8).claim(n, started["code"].as_str().unwrap()).await.0, 503);
    assert_eq!(w.anna.call(n, "POST", "/api/me/agent-pairings", json!({})).await.0, 503);
    assert_eq!(w.anna.call(n, "GET", &format!("/api/vaults/{}", w.vault), Value::Null).await.0, 200);
    assert_eq!(w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await.0, 200);

    set_disabled(n.dir.path(), false).unwrap();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200);

    let env = node_with(Config { disabled_by_env: true, ..Config::default() }).await;
    let anna = person(&env, "anna@example.test");
    assert_eq!(anna.call(&env, "POST", "/api/me/agent-pairings", json!({})).await.0, 503);
    assert_eq!(Mcp::new(1).call(&env, "GET", "/api/agent/me", Value::Null).await.0, 503);
    assert_eq!(anna.call(&env, "GET", "/api/vaults", Value::Null).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn revoke_all_ends_every_chat_and_marks_its_vaults() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(10);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    assert_eq!(revoke_all(n.dir.path(), false).unwrap(), 1, "a dry run counts");
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200);
    assert_eq!(revoke_all(n.dir.path(), true).unwrap(), 1);
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "session");
    let flagged: bool = db(n).query_row("SELECT needs_rotation FROM vaults WHERE vault_id=?1", [&w.vault], |r| r.get(0)).unwrap();
    assert!(flagged);
    let keys: i64 = db(n).query_row("SELECT count(*) FROM agent_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(keys, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_or_idle_session_gets_nothing_until_the_person_renews_it() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(11);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    db(n).execute("UPDATE agents SET session_expires_at=?2 WHERE agent_id=?1", params![agent, now_millis() - 1]).unwrap();
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["code"], "session");
    let (status, renewed) = w.bartek.call(n, "POST", &format!("/api/me/agents/{agent}/renew"), json!({ "hours": 8 })).await;
    assert_eq!(status, 200, "{renewed}");
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200);

    db(n).execute("UPDATE agents SET last_used_at=?2 WHERE agent_id=?1", params![agent, now_millis() - 2 * HOUR]).unwrap();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "session");
    assert_eq!(w.bartek.call(n, "POST", &format!("/api/me/agents/{agent}/renew"), json!({ "hours": 2 })).await.0, 400);
    assert_eq!(w.anna.call(n, "POST", &format!("/api/me/agents/{agent}/renew"), json!({ "hours": 1 })).await.0, 404, "only the chat's person");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_reads_only_the_vaults_of_its_cert_while_its_person_is_in_them() {
    let w = world().await;
    let n = &w.n;
    let other = n.vaults.create(&w.anna.id, "Inny", "organizacja", &key()).unwrap().info.id;
    let invite = n.vaults.create_invite(&w.anna.id, &other, "editor").unwrap();
    n.vaults.accept_invite(&w.bartek.id, &invite.token, &key(), 1).unwrap();
    let mut mcp = Mcp::new(12);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    let get = |vault: String| { let mcp = &mcp; async move { mcp.call(n, "GET", &format!("/api/agent/vaults/{vault}"), Value::Null).await } };
    assert_eq!(get(other.clone()).await.1["code"], "scope", "a vault of the person outside the cert");
    assert_eq!(get(format!("browser-{}", w.bartek.id)).await.0, 404, "the personal vault outside the cert");

    // a lower role: still reads, no longer writes
    n.vaults.set_member_role(&w.anna.id, &w.vault, &w.bartek.id, "viewer").unwrap();
    let path = format!("/api/agent/vaults/{}/snapshot", w.vault);
    let (status, reply) = mcp.call(n, "POST", &path, json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await;
    assert_eq!((status, reply["code"].as_str()), (403, Some("read-only")));
    assert_eq!(get(w.vault.clone()).await.1["role"], "viewer");

    // the person removed: the chat loses the vault in the same moment
    n.vaults.remove_member(&w.anna.id, &w.vault, &w.bartek.id).unwrap();
    assert_eq!(get(w.vault.clone()).await.1["code"], "scope");

    // chats switched off by the owner: a chat of the owner loses the vault too
    let mut owners = Mcp::new(13);
    pair(n, &w.anna, &mut owners, &[(&w.vault, "direct")]).await;
    assert_eq!(owners.call(n, "GET", "/api/agent/me", Value::Null).await.1["vaults"][0]["role"], "editor", "min(owner, editor)");
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": false, "maxHours": 8, "maxWriteMode": "proposals", "allowProtected": false })).await;
    assert_eq!(owners.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn write_modes_none_and_proposals_take_no_snapshot_and_the_policy_caps_the_mode() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(14);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "proposals")]).await;
    let path = format!("/api/agent/vaults/{}", w.vault);
    let (status, reply) = mcp.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await;
    assert_eq!((status, reply["code"].as_str()), (403, Some("read-only")));
    let (status, created) = mcp.call(n, "POST", &format!("{path}/proposals"), json!({ "proposal": proposal(&agent, &w.bartek.id) })).await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(mcp.call(n, "POST", &format!("{path}/proposals"), json!({ "proposal": proposal(&agent, &w.anna.id) })).await.0, 400, "signed as another person");

    let mut reader = Mcp::new(15);
    pair(n, &w.bartek, &mut reader, &[(&w.vault, "none")]).await;
    assert_eq!(reader.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await.0, 403);
    assert_eq!(reader.call(n, "POST", &format!("{path}/proposals"), json!({ "proposal": proposal("x", &w.bartek.id) })).await.0, 403);

    let mut writer = Mcp::new(16);
    pair(n, &w.bartek, &mut writer, &[(&w.vault, "direct")]).await;
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "proposals", "allowProtected": false })).await;
    assert_eq!(writer.call(n, "GET", &path, Value::Null).await.1["writeMode"], "proposals");
    assert_eq!(writer.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await.0, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn proposals_go_only_to_the_chats_person_who_alone_decides() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(17);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "proposals")]).await;
    let base = format!("/api/vaults/{}/proposals", w.vault);
    let (status, _) = mcp.call(n, "POST", &format!("/api/agent/vaults/{}/proposals", w.vault), json!({ "proposal": proposal(&agent, &w.bartek.id) })).await;
    assert_eq!(status, 201);
    assert_eq!(w.anna.call(n, "GET", &base, Value::Null).await.1["proposals"], json!([]), "the owner sees none");
    assert_eq!(mcp.call(n, "GET", &base, Value::Null).await.0, 401, "the chat itself sees none");
    let (_, mine) = w.bartek.call(n, "GET", &base, Value::Null).await;
    assert_eq!(mine["proposals"][0]["proposal"], proposal(&agent, &w.bartek.id));
    let pid = "0123456789abcdef0123456789abcdef";
    assert_eq!(w.anna.call(n, "POST", &format!("{base}/{pid}/decision"), json!({ "decision": "approved" })).await.0, 404);
    assert_eq!(w.bartek.call(n, "POST", &format!("{base}/{pid}/decision"), json!({ "decision": "approved" })).await.0, 204);
    assert_eq!(w.bartek.call(n, "POST", &format!("{base}/{pid}/decision"), json!({ "decision": "rejected" })).await.0, 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn chat_limits_answer_429_then_pause_and_leave_people_alone() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(18);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let mut statuses = Vec::new();
    for _ in 0..REQUESTS_PER_MINUTE + 3 { statuses.push(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0); }
    assert!(statuses[..REQUESTS_PER_MINUTE].iter().all(|s| *s == 200), "{statuses:?}");
    assert_eq!(&statuses[REQUESTS_PER_MINUTE..], [429, 429, 429]);
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "paused", "the third 429 pauses the chat");
    assert_eq!(w.bartek.call(n, "GET", &format!("/api/vaults/{}", w.vault), Value::Null).await.0, 200);
    let (_, list) = w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await;
    assert_eq!(list["agents"][0]["paused"], "limit");
    assert_eq!(w.bartek.call(n, "POST", &format!("/api/me/agents/{agent}/confirm"), Value::Null).await.0, 204);
    let (_, list) = w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await;
    assert!(list["agents"][0]["paused"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_address_pauses_the_chat_until_the_person_confirms_it() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(19);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    mcp.ip = "203.0.113.50".into();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "paused");
    mcp.ip = IP.into();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 403, "paused from every address");
    assert_eq!(w.bartek.call(n, "POST", &format!("/api/me/agents/{agent}/confirm"), Value::Null).await.0, 204);
    for ip in [IP, "203.0.113.50"] {
        mcp.ip = ip.into();
        assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200, "{ip}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_claim_burns_the_pairing_for_both() {
    let w = world().await;
    let n = &w.n;
    let (_, started) = w.bartek.call(n, "POST", "/api/me/agent-pairings", json!({})).await;
    let code = started["code"].as_str().unwrap();
    let pairing = started["pairingId"].as_str().unwrap();
    let mine = Mcp::new(20);
    let (status, claimed) = mine.claim(n, code).await;
    assert_eq!(status, 200);
    let mut thief = Mcp::new(21);
    thief.ip = "203.0.113.66".into();
    assert_eq!(thief.claim(n, code).await.1["code"], "burned");
    let (_, state) = w.bartek.call(n, "GET", &format!("/api/me/agent-pairings/{pairing}"), Value::Null).await;
    assert_eq!(state["state"], "burned");
    assert_eq!(w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &mine, pairing, &[(&w.vault, "none")], 4)).await.0, 409);
    let (status, _) = mine.call(n, "GET", &format!("/api/agent-pair/{}", claimed["pairToken"].as_str().unwrap()), Value::Null).await;
    assert_eq!(status, 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn five_wrong_codes_block_the_address_for_an_hour() {
    let w = world().await;
    let n = &w.n;
    let (_, started) = w.bartek.call(n, "POST", "/api/me/agent-pairings", json!({})).await;
    let mcp = Mcp::new(22);
    for _ in 0..BAD_CODES { assert_eq!(mcp.claim(n, "AAAA-AAAA").await.0, 404); }
    let (status, reply) = mcp.claim(n, started["code"].as_str().unwrap()).await;
    assert_eq!((status, reply["code"].as_str()), (429, Some("limit")));
    let mut elsewhere = Mcp::new(22);
    elsewhere.ip = "203.0.113.9".into();
    assert_eq!(elsewhere.claim(n, started["code"].as_str().unwrap()).await.0, 200, "another address is not blocked");
}

#[tokio::test(flavor = "multi_thread")]
async fn three_pairings_an_hour_per_person() {
    let w = world().await;
    for _ in 0..PAIRINGS_PER_HOUR { assert_eq!(w.anna.call(&w.n, "POST", "/api/me/agent-pairings", json!({})).await.0, 201); }
    assert_eq!(w.anna.call(&w.n, "POST", "/api/me/agent-pairings", json!({})).await.0, 429);
    assert_eq!(w.bartek.call(&w.n, "POST", "/api/me/agent-pairings", json!({})).await.0, 201);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_is_set_up_only_with_a_valid_scope() {
    let w = world().await;
    let n = &w.n;
    let outsider = n.vaults.create(&w.anna.id, "Zarząd", "organizacja", &key()).unwrap().info.id;
    let closed = n.vaults.create(&w.anna.id, "Zamknięta", "organizacja", &key()).unwrap().info.id;
    let invite = n.vaults.create_invite(&w.anna.id, &closed, "editor").unwrap();
    n.vaults.accept_invite(&w.bartek.id, &invite.token, &key(), 1).unwrap();
    let mcp = Mcp::new(23);
    let (pairing, _) = start_and_claim(n, &w.bartek, &mcp).await;
    let post = |body: Value| w.bartek.call(n, "POST", "/api/me/agents", body);
    let ok = || create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 4);

    let mut empty = ok();
    empty["cert"]["vaults"] = json!([]);
    assert_eq!(post(empty).await.0, 400, "no space chosen");
    assert_eq!(post(create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 2)).await.0, 400, "2 hours");
    let mut no_key = ok();
    no_key["keys"] = json!([]);
    assert_eq!(post(no_key).await.0, 400);
    let mut no_scope = ok();
    no_scope["scopes"] = json!([]);
    assert_eq!(post(no_scope).await.0, 400);
    let mut too_long = ok();
    too_long["cert"]["expiresAt"] = json!(now_millis() + 91 * DAY);
    assert_eq!(post(too_long).await.0, 400);
    let mut parts = ok();
    parts["cert"]["vaults"][0]["whole"] = json!(false);
    assert_eq!(post(parts).await.0, 400);
    let mut other_key = ok();
    other_key["cert"]["signKey"] = json!(Mcp::new(99).sign_key());
    assert_eq!(post(other_key).await.0, 409, "keys differ from the claim");
    assert_eq!(post(create_body(n, &w.bartek, &mcp, &pairing, &[(&outsider, "none")], 4)).await.0, 403, "not a member");
    assert_eq!(post(create_body(n, &w.bartek, &mcp, &pairing, &[(&closed, "none")], 4)).await.0, 403, "chats off there");
    assert_eq!(post(create_body(n, &w.bartek, &mcp, &pairing, &[(&format!("browser-{}", w.bartek.id), "none")], 4)).await.0, 400, "personal vault still under the personal key");
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": true, "maxHours": 8, "maxWriteMode": "direct", "allowProtected": false })).await;
    assert_eq!(post(create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 24)).await.0, 400, "above the policy");
    let good = ok();
    assert_eq!(post(good.clone()).await.0, 201);
    assert_eq!(post(good).await.0, 409, "the pairing is done");
}

#[tokio::test(flavor = "multi_thread")]
async fn at_most_five_chats_per_person() {
    let w = world().await;
    for seed in 30..35 {
        pair(&w.n, &w.bartek, &mut Mcp::new(seed), &[(&w.vault, "none")]).await;
        // past the three-pairings-an-hour limit, which is not what this test is about
        db(&w.n).execute("UPDATE agent_pairings SET created_at=0", []).unwrap();
    }
    let mcp = Mcp::new(35);
    let (pairing, _) = start_and_claim(&w.n, &w.anna, &mcp).await;
    assert_eq!(w.anna.call(&w.n, "POST", "/api/me/agents", create_body(&w.n, &w.anna, &mcp, &pairing, &[(&w.vault, "none")], 4)).await.0, 201, "per person");
    let (pairing, _) = start_and_claim(&w.n, &w.bartek, &mcp).await;
    let mcp2 = Mcp::new(35);
    assert_eq!(w.bartek.call(&w.n, "POST", "/api/me/agents", create_body(&w.n, &w.bartek, &mcp2, &pairing, &[(&w.vault, "none")], 4)).await.0, 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_the_account_deletes_its_chats() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(40);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    crate::admin::delete_user(n.dir.path(), &w.bartek.id, true).unwrap();
    let count = |table: &str| -> i64 { db(n).query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap() };
    for table in ["agents", "agent_keys", "agent_scopes", "agent_pairings", "agent_usage"] { assert_eq!(count(table), 0, "{table}"); }
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn rotation_needs_a_key_for_each_chat_and_a_revoked_one_needs_none() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(41);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    let members = [(w.anna.id.clone(), sealed_p256(1)), (w.bartek.id.clone(), sealed_p256(2))];
    assert!(matches!(n.vaults.rotate(&w.anna.id, &w.vault, 2, &members), Err(VaultError::Conflict(_))));
    assert!(matches!(n.vaults.rotate_with_agents(&w.anna.id, &w.vault, 2, &members, &[("f".repeat(32), sealed_key(2))]), Err(VaultError::Conflict(_))));
    n.vaults.rotate_with_agents(&w.anna.id, &w.vault, 2, &members, &[(agent.clone(), sealed_key(2))]).unwrap();
    let (_, detail) = mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await;
    assert_eq!(detail["agentKeys"], json!([{ "keyEpoch": 1, "sealedKey": sealed_key(1) }, { "keyEpoch": 2, "sealedKey": sealed_key(2) }]));

    assert_eq!(w.bartek.call(n, "DELETE", &format!("/api/me/agents/{agent}"), Value::Null).await.0, 204);
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "session");
    let flagged: bool = db(n).query_row("SELECT needs_rotation FROM vaults WHERE vault_id=?1", [&w.vault], |r| r.get(0)).unwrap();
    assert!(flagged);
    let (_, vault) = w.anna.call(n, "GET", &format!("/api/vaults/{}", w.vault), Value::Null).await;
    let bartek_row = vault["members"].as_array().unwrap().iter().find(|m| m["userId"] == w.bartek.id.as_str()).unwrap().clone();
    assert!(bartek_row["agents"][0]["revokedAt"].is_i64(), "a revoked chat stays listed with revokedAt");
    let members3 = [(w.anna.id.clone(), sealed_p256(3)), (w.bartek.id.clone(), sealed_p256(4))];
    n.vaults.rotate(&w.anna.id, &w.vault, 3, &members3).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_personal_vault_takes_a_chat_after_its_own_key_and_a_new_key_needs_the_chats_copy() {
    let w = world().await;
    let n = &w.n;
    let personal = format!("browser-{}", w.bartek.id);
    n.vaults.add_personal_key(&w.bartek.id, 2, &key()).unwrap();
    let mut mcp = Mcp::new(42);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&personal, "direct")]).await;
    let (status, detail) = mcp.call(n, "GET", &format!("/api/agent/vaults/{personal}"), Value::Null).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!((detail["vault"]["keyEpoch"].as_i64(), detail["writeMode"].as_str()), (Some(2), Some("direct")));
    let (status, put) = mcp.call(n, "POST", &format!("/api/agent/vaults/{personal}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(2, 1) })).await;
    assert_eq!(status, 200, "{put}");
    assert_eq!(n.sync.stored(&w.bartek.id, &personal).unwrap().2.unwrap().agent_id.as_deref(), Some(agent.as_str()));
    // another person's personal vault is never a chat's
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/browser-{}", w.anna.id), Value::Null).await.0, 404);

    let mut next = key();
    next.ciphertext = BASE64.encode([5u8; 48]);
    assert!(matches!(n.vaults.add_personal_key(&w.bartek.id, 3, &next), Err(VaultError::Conflict(_))));
    let (status, _) = w.bartek.call(n, "PUT", "/api/me/personal-key", json!({ "keyEpoch": 3, "wrappedKey": next, "agentKeys": [{ "agentId": agent, "sealedKey": sealed_key(3) }] })).await;
    assert_eq!(status, 200);
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{personal}"), Value::Null).await.1["agentKeys"].as_array().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn narrowing_the_scope_drops_the_vault_key_and_marks_it_for_rotation() {
    let w = world().await;
    let n = &w.n;
    let second = n.vaults.create(&w.bartek.id, "Drugi", "organizacja", &key()).unwrap().info.id;
    w.bartek.call(n, "PUT", &format!("/api/vaults/{second}/agent-policy"), json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": false })).await;
    let mut mcp = Mcp::new(43);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none"), (&second, "none")]).await;
    let mut narrower_cert = stored_cert(n, &agent);
    narrower_cert["vaults"] = json!([{ "vaultId": second, "whole": true, "parts": [], "writeMode": "none" }]);
    let narrower = json!({
        "cert": narrower_cert, "signature": "bmV3",
        "keys": [], "scopes": [{ "vaultId": second, "sealedScope": sealed_scope(), "ownScope": own_scope() }],
    });
    let (status, reply) = w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), narrower).await;
    assert_eq!(status, 204, "{reply}");
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.0, 404);
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{second}"), Value::Null).await.0, 200);
    let flagged: bool = db(n).query_row("SELECT needs_rotation FROM vaults WHERE vault_id=?1", [&w.vault], |r| r.get(0)).unwrap();
    assert!(flagged);
    let keys: i64 = db(n).query_row("SELECT count(*) FROM agent_keys WHERE vault_id=?1", [&w.vault], |r| r.get(0)).unwrap();
    assert_eq!(keys, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_vault_admin_disconnects_a_members_chat_and_only_the_owner_sets_the_policy() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(44);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let policy = json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": true });
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), policy).await.0, 403);
    assert_eq!(w.bartek.call(n, "DELETE", &format!("/api/vaults/{}/agents/{agent}", w.vault), Value::Null).await.0, 403, "an editor is no admin");
    assert_eq!(w.anna.call(n, "DELETE", &format!("/api/vaults/{}/agents/{agent}", w.vault), Value::Null).await.0, 204);
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["code"], "scope");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_audit_log_names_ids_only() {
    let w = world().await;
    let mut mcp = Mcp::new(45);
    pair(&w.n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let token = mcp.token.clone().unwrap();
    let lines = crate::audit::CAPTURED.lock().unwrap().clone();
    assert!(lines.iter().any(|l| l.contains("event=agent_paired")));
    assert!(lines.iter().all(|l| !l.contains(&token) && !l.contains(IP) && !l.contains(&mcp.sign_key())));
}

#[test]
fn revisions_stored_before_authors_read_as_none() {
    let dir = tempfile::tempdir().unwrap();
    let old = Connection::open(dir.path().join("browser-sync.db")).unwrap();
    old.execute_batch("CREATE TABLE browser_sync_vaults (user_id TEXT NOT NULL, vault_id TEXT NOT NULL, revision INTEGER NOT NULL,
        envelope_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, vault_id));").unwrap();
    let envelope = serde_json::to_string(&snapshot(1, 1)).unwrap();
    old.execute("INSERT INTO browser_sync_vaults VALUES ('u','browser-u',3,?1,0)", [envelope]).unwrap();
    drop(old);
    let _auth = AuthService::open(dir.path()).unwrap();
    let locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
    let sync = BrowserSync::open(dir.path(), vaults, locks).unwrap();
    let (revision, envelope, author) = sync.stored("u", "browser-u").unwrap();
    assert_eq!((revision, envelope.is_some(), author), (3, true, None));
}

/// A well-formed `notes-sealed-v1` box for a member (P-256), as rotations take.
fn sealed_p256(seed: u8) -> Value {
    json!({
        "schema": "notes-sealed-v1",
        "epk": { "kty": "EC", "crv": "P-256", "x": B64U.encode([seed; 32]), "y": B64U.encode([seed.wrapping_add(1); 32]) },
        "nonce": BASE64.encode([seed; 12]),
        "ciphertext": BASE64.encode([seed; 48]),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn the_persons_own_scope_copy_goes_back_to_the_person_and_never_to_the_chat() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(46);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    let (_, list) = w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await;
    assert_eq!(list["agents"][0]["scopes"], json!([{ "vaultId": w.vault, "ownScope": own_scope() }]));
    let marker = own_scope()["ciphertext"].as_str().unwrap().to_string();
    n.sync.put(&w.anna.id, &w.vault, 0, &serde_json::from_value(snapshot(1, 1)).unwrap()).unwrap();
    for path in ["/api/agent/me".to_string(), format!("/api/agent/vaults/{}", w.vault), format!("/api/agent/vaults/{}/snapshot", w.vault)] {
        let (status, reply) = mcp.call(n, "GET", &path, Value::Null).await;
        assert_eq!(status, 200, "{path}: {reply}");
        assert!(!reply.to_string().contains(&marker), "{path} carries the own scope");
    }
    // a scope without its own copy, or with a bad one, is refused
    let (pairing, _) = start_and_claim(n, &w.anna, &Mcp::new(47)).await;
    let mut body = create_body(n, &w.anna, &Mcp::new(47), &pairing, &[(&w.vault, "none")], 4);
    body["scopes"][0].as_object_mut().unwrap().remove("ownScope");
    assert_eq!(w.anna.call(n, "POST", "/api/me/agents", body.clone()).await.0, 422);
    body["scopes"][0]["ownScope"] = json!({ "schema": "notes-key-v1", "nonce": "AAAA", "ciphertext": "AAAA" });
    assert_eq!(w.anna.call(n, "POST", "/api/me/agents", body).await.0, 400);
    let _ = agent;
}


/// The cert stored for a chat, as the person's app holds it.
fn stored_cert(n: &Node, agent: &str) -> Value {
    let text: String = db(n).query_row("SELECT cert_json FROM agents WHERE agent_id=?1", [agent], |r| r.get(0)).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cert_wider_than_the_policy_is_refused_when_paired_and_when_changed() {
    let w = world().await;
    let n = &w.n;
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "proposals", "allowProtected": false })).await;
    let mcp = Mcp::new(50);
    let (pairing, _) = start_and_claim(n, &w.bartek, &mcp).await;
    let (status, reply) = w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "direct")], 4)).await;
    assert_eq!(status, 400, "{reply}");
    let (status, created) = w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "proposals")], 4)).await;
    assert_eq!(status, 201, "{created}");
    let agent = created["agentId"].as_str().unwrap();
    let mut wider = stored_cert(n, agent);
    wider["vaults"][0]["writeMode"] = json!("append");
    let body = json!({ "cert": wider, "signature": "bmV3", "keys": [], "scopes": [{ "vaultId": w.vault, "sealedScope": sealed_scope(), "ownScope": own_scope() }] });
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scope_change_keeps_the_certs_date_so_it_never_outlives_90_days_from_pairing() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(51);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let created = stored_cert(n, &agent)["createdAt"].as_i64().unwrap();
    let path = format!("/api/me/agents/{agent}");
    let put = |cert: Value| {
        let body = json!({ "cert": cert, "signature": "bmV3", "keys": [], "scopes": [{ "vaultId": w.vault, "sealedScope": sealed_scope(), "ownScope": own_scope() }] });
        w.bartek.call(n, "PUT", &path, body)
    };
    let mut later = stored_cert(n, &agent);
    later["createdAt"] = json!(created + MINUTE);
    later["expiresAt"] = json!(created + MINUTE + 90 * DAY);
    assert_eq!(put(later).await.0, 400, "a new createdAt would extend the cert");
    let mut too_long = stored_cert(n, &agent);
    too_long["expiresAt"] = json!(created + 90 * DAY + 1);
    assert_eq!(put(too_long).await.0, 400);
    let mut same = stored_cert(n, &agent);
    same["expiresAt"] = json!(created + 90 * DAY);
    assert_eq!(put(same).await.0, 204);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_who_returns_does_not_bring_an_old_chat_back() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(52);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    n.vaults.remove_member(&w.anna.id, &w.vault, &w.bartek.id).unwrap();
    let scopes: i64 = db(n).query_row("SELECT count(*) FROM agent_scopes WHERE agent_id=?1", [&agent], |r| r.get(0)).unwrap();
    assert_eq!(scopes, 0);
    let invite = n.vaults.create_invite(&w.anna.id, &w.vault, "editor").unwrap();
    n.vaults.accept_invite(&w.bartek.id, &invite.token, &key(), 1).unwrap();
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["code"], "scope");
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["vaults"], json!([]));
    // the rotation after the removal needs no key for the old chat
    let members = [(w.anna.id.clone(), sealed_p256(1)), (w.bartek.id.clone(), sealed_p256(2))];
    n.vaults.rotate(&w.anna.id, &w.vault, 2, &members).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_sees_the_protected_projects_setting_and_a_hash_of_its_scope() {
    let w = world().await;
    let n = &w.n;
    let personal = format!("browser-{}", w.bartek.id);
    n.vaults.add_personal_key(&w.bartek.id, 2, &key()).unwrap();
    let mut mcp = Mcp::new(53);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none"), (&personal, "none")]).await;
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["allowProtected"], false);
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{personal}"), Value::Null).await.1["allowProtected"], true);
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": true })).await;
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["allowProtected"], true);

    let hash_of = |me: &Value, vault: &str| me["vaults"].as_array().unwrap().iter().find(|v| v["vaultId"] == vault).unwrap()["scopeHash"].as_str().unwrap().to_string();
    let (_, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
    let expected = hex(&sha2::Sha256::digest(serde_json::to_string(&sealed_scope()).unwrap().as_bytes()));
    assert_eq!(hash_of(&me, &w.vault), expected);
    let other_scope = json!({ "schema": SCOPE_SCHEMA, "box": B64U.encode([9u8; 200]) });
    let body = json!({ "cert": stored_cert(n, &agent), "signature": "bmV3", "keys": [], "scopes": [
        { "vaultId": w.vault, "sealedScope": other_scope, "ownScope": own_scope() },
        { "vaultId": personal, "sealedScope": sealed_scope(), "ownScope": own_scope() },
    ] });
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body).await.0, 204);
    let (_, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
    assert_ne!(hash_of(&me, &w.vault), expected, "a new scope shows as a new hash");
    assert_eq!(hash_of(&me, &personal), expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn personal_keys_carry_their_creation_time() {
    let w = world().await;
    let before = now_millis();
    w.n.vaults.add_personal_key(&w.bartek.id, 2, &key()).unwrap();
    let (status, keys) = w.bartek.call(&w.n, "GET", "/api/me/personal-key", Value::Null).await;
    assert_eq!(status, 200);
    let created = keys["keys"][0]["createdAt"].as_i64().unwrap();
    assert!(created >= before && created <= now_millis(), "{keys}");
}

// ---- review of the chat server (docs/MCP.md §12) ----

fn count(n: &Node, sql: &str) -> i64 { db(n).query_row(sql, [], |r| r.get(0)).unwrap() }

/// Moves Bartek's "Moje notatki" onto a key of its own (epoch 2), so a chat may have it.
fn migrate_personal(n: &Node, who: &Person) -> String {
    n.vaults.add_personal_key(&who.id, 2, &key()).unwrap();
    format!("browser-{}", who.id)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_proof_time_at_the_ends_of_i64_is_refused_without_a_crash() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(60);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    for time in [i64::MIN, i64::MIN + 1, i64::MAX, -1] {
        let headers = mcp.headers("GET", "/api/agent/me", b"", time, &random_hex::<16>().unwrap(), "1.0.0");
        let (status, reply) = http(n.addr, "GET", "/api/agent/me", &headers, b"").await;
        assert_eq!((status, reply["code"].as_str()), (401, Some("proof")), "{time}");
    }
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200, "the server is still up");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cert_past_its_expiry_closes_every_vault_in_the_middle_of_a_session() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(61);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    let path = format!("/api/agent/vaults/{}", w.vault);
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.0, 200);
    db(n).execute("UPDATE agents SET cert_expires_at=?2 WHERE agent_id=?1", params![agent, now_millis() - 1]).unwrap();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["vaults"], json!([]));
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.1["code"], "scope");
    assert_eq!(mcp.call(n, "GET", &format!("{path}/snapshot"), Value::Null).await.1["code"], "scope");
    assert_eq!(mcp.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await.1["code"], "scope");
    assert_eq!(mcp.call(n, "POST", &format!("{path}/proposals"), json!({ "proposal": proposal(&agent, &w.bartek.id) })).await.1["code"], "scope");
    assert_eq!(n.sync.stored(&w.anna.id, &w.vault).unwrap().0, 0, "nothing written");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lower_max_hours_cuts_a_running_session_and_renewal_stays_within_it() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(62);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let path = format!("/api/agent/vaults/{}", w.vault);
    // started 2 hours ago, still inside its 4 hours
    let now = now_millis();
    db(n).execute("UPDATE agents SET session_started_at=?2, last_used_at=?3 WHERE agent_id=?1", params![agent, now - 2 * HOUR, now]).unwrap();
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.0, 200);
    let (status, _) = w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault),
        json!({ "enabled": true, "maxHours": 1, "maxWriteMode": "direct", "allowProtected": false })).await;
    assert_eq!(status, 204);
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.1["code"], "scope", "cut at once by the owner's new maximum");
    let renew = format!("/api/me/agents/{agent}/renew");
    assert_eq!(w.bartek.call(n, "POST", &renew, json!({ "hours": 4 })).await.0, 400, "above the new maximum");
    assert_eq!(w.bartek.call(n, "POST", &renew, json!({ "hours": 1 })).await.0, 200);
    assert_eq!(mcp.call(n, "GET", &path, Value::Null).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_person_lowered_to_viewer_loses_the_writes_and_proposals_of_their_chats() {
    let w = world().await;
    let n = &w.n;
    let mut writer = Mcp::new(63);
    pair(n, &w.bartek, &mut writer, &[(&w.vault, "direct")]).await;
    let mut proposer = Mcp::new(64);
    let proposer_id = pair(n, &w.bartek, &mut proposer, &[(&w.vault, "proposals")]).await;
    let path = format!("/api/agent/vaults/{}", w.vault);
    n.vaults.set_member_role(&w.anna.id, &w.vault, &w.bartek.id, "viewer").unwrap();

    assert_eq!(writer.call(n, "POST", &format!("{path}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await.1["code"], "read-only");
    assert_eq!(writer.call(n, "GET", &path, Value::Null).await.1["writeMode"], "none");
    let (status, reply) = proposer.call(n, "POST", &format!("{path}/proposals"), json!({ "proposal": proposal(&proposer_id, &w.bartek.id) })).await;
    assert_eq!((status, reply["code"].as_str()), (403, Some("read-only")));
    assert_eq!(count(n, "SELECT count(*) FROM agent_proposals"), 0);
    // reading goes on, as for the person
    assert_eq!(proposer.call(n, "GET", &path, Value::Null).await.1["role"], "viewer");
    // the role back: the cert's modes come back with it
    n.vaults.set_member_role(&w.anna.id, &w.vault, &w.bartek.id, "editor").unwrap();
    assert_eq!(writer.call(n, "GET", &path, Value::Null).await.1["writeMode"], "direct");
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_member_and_deleting_the_vault_leave_no_chat_rows_behind() {
    let w = world().await;
    let n = &w.n;
    let mut bartek_chat = Mcp::new(65);
    let bartek_agent = pair(n, &w.bartek, &mut bartek_chat, &[(&w.vault, "proposals")]).await;
    let mut anna_chat = Mcp::new(66);
    let anna_agent = pair(n, &w.anna, &mut anna_chat, &[(&w.vault, "proposals")]).await;
    let path = format!("/api/agent/vaults/{}/proposals", w.vault);
    assert_eq!(bartek_chat.call(n, "POST", &path, json!({ "proposal": proposal(&bartek_agent, &w.bartek.id) })).await.0, 201);
    let mut other = proposal(&anna_agent, &w.anna.id);
    other["proposalId"] = json!("fedcba9876543210fedcba9876543210");
    assert_eq!(anna_chat.call(n, "POST", &path, json!({ "proposal": other })).await.0, 201);

    // the removed member's chats lose their proposals there too, not only keys and scope
    n.vaults.remove_member(&w.anna.id, &w.vault, &w.bartek.id).unwrap();
    let left = |n: &Node, table: &str| count(n, &format!("SELECT count(*) FROM {table} WHERE vault_id='{}'", w.vault));
    assert_eq!(count(n, &format!("SELECT count(*) FROM agent_proposals WHERE user_id='{}'", w.bartek.id)), 0);
    assert_eq!(left(n, "agent_proposals"), 1);

    // a stray row (as left by an older server) for a former member goes with the vault as well
    db(n).execute("INSERT INTO agent_proposals VALUES ('00000000000000000000000000000001',?1,?2,?3,0,?4,'open','{}')",
        params![bartek_agent, w.bartek.id, w.vault, now_millis() + DAY]).unwrap();
    crate::admin::delete_user(n.dir.path(), &w.anna.id, true).unwrap();
    for table in ["agent_keys", "agent_scopes", "agent_proposals", "vault_agent_policy"] { assert_eq!(left(n, table), 0, "{table}"); }
    assert_eq!(anna_chat.call(n, "GET", "/api/agent/me", Value::Null).await.0, 401);
    assert_eq!(bartek_chat.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_chats_of_one_person_with_disjoint_scopes_never_reach_each_others_vault() {
    let w = world().await;
    let n = &w.n;
    let personal = migrate_personal(n, &w.bartek);
    let mut club = Mcp::new(67);
    let club_id = pair(n, &w.bartek, &mut club, &[(&w.vault, "direct")]).await;
    let mut notes = Mcp::new(68);
    let notes_id = pair(n, &w.bartek, &mut notes, &[(&personal, "direct")]).await;
    n.sync.put(&w.anna.id, &w.vault, 0, &serde_json::from_value(snapshot(1, 1)).unwrap()).unwrap();
    n.sync.put(&w.bartek.id, &personal, 0, &serde_json::from_value(snapshot(2, 1)).unwrap()).unwrap();

    for (mcp, agent, foreign) in [(&club, &club_id, &personal), (&notes, &notes_id, &w.vault)] {
        let base = format!("/api/agent/vaults/{foreign}");
        assert_eq!(mcp.call(n, "GET", &base, Value::Null).await.1["code"], "scope", "{foreign}");
        assert_eq!(mcp.call(n, "GET", &format!("{base}/snapshot"), Value::Null).await.1["code"], "scope");
        assert_eq!(mcp.call(n, "GET", &format!("{base}/snapshot?since=0"), Value::Null).await.1["code"], "scope");
        assert_eq!(mcp.call(n, "POST", &format!("{base}/snapshot"), json!({ "baseRevision": 1, "envelope": snapshot(2, 9) })).await.1["code"], "scope");
        assert_eq!(mcp.call(n, "POST", &format!("{base}/proposals"), json!({ "proposal": proposal(agent, &w.bartek.id) })).await.1["code"], "scope");
        let (_, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
        assert_eq!(me["vaults"].as_array().unwrap().len(), 1);
        assert_ne!(me["vaults"][0]["vaultId"], foreign.as_str());
    }
    // the chat without "Moje notatki" gets 404 there, after the migration too
    assert_eq!(club.call(n, "GET", &format!("/api/agent/vaults/{personal}"), Value::Null).await.0, 404);
    assert_eq!(n.sync.stored(&w.anna.id, &w.vault).unwrap().0, 1);
    assert_eq!(n.sync.stored(&w.bartek.id, &personal).unwrap().0, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn different_write_modes_in_two_vaults_of_one_chat_work_independently() {
    let w = world().await;
    let n = &w.n;
    let personal = migrate_personal(n, &w.bartek);
    let mut mcp = Mcp::new(69);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct"), (&personal, "proposals")]).await;
    let club = format!("/api/agent/vaults/{}", w.vault);
    let notes = format!("/api/agent/vaults/{personal}");
    assert_eq!(mcp.call(n, "POST", &format!("{club}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await.0, 200);
    assert_eq!(mcp.call(n, "POST", &format!("{notes}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(2, 1) })).await.1["code"], "read-only");
    assert_eq!(mcp.call(n, "POST", &format!("{notes}/proposals"), json!({ "proposal": proposal(&agent, &w.bartek.id) })).await.0, 201);
    let (_, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
    let mode = |vault: &str| me["vaults"].as_array().unwrap().iter().find(|v| v["vaultId"] == vault).unwrap()["writeMode"].clone();
    assert_eq!((mode(&w.vault), mode(&personal)), (json!("direct"), json!("proposals")));

    // the other way round in a second chat: none in the club, direct in the notes
    let mut other = Mcp::new(70);
    let other_id = pair(n, &w.bartek, &mut other, &[(&w.vault, "none"), (&personal, "direct")]).await;
    assert_eq!(other.call(n, "POST", &format!("{club}/snapshot"), json!({ "baseRevision": 1, "envelope": snapshot(1, 2) })).await.1["code"], "read-only");
    assert_eq!(other.call(n, "POST", &format!("{club}/proposals"), json!({ "proposal": proposal(&other_id, &w.bartek.id) })).await.1["code"], "read-only");
    assert_eq!(other.call(n, "POST", &format!("{notes}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(2, 1) })).await.0, 200);
    // the owner's cap in one vault leaves the other alone
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "none", "allowProtected": false })).await;
    assert_eq!(mcp.call(n, "POST", &format!("{club}/snapshot"), json!({ "baseRevision": 1, "envelope": snapshot(1, 3) })).await.1["code"], "read-only");
    assert_eq!(other.call(n, "POST", &format!("{notes}/snapshot"), json!({ "baseRevision": 1, "envelope": snapshot(2, 2) })).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn chats_switched_off_by_the_owner_stop_an_already_paired_chat_at_once() {
    let w = world().await;
    let n = &w.n;
    let personal = migrate_personal(n, &w.bartek);
    let mut mcp = Mcp::new(71);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct"), (&personal, "none")]).await;
    let club = format!("/api/agent/vaults/{}", w.vault);
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault), json!({ "enabled": false, "maxHours": 8, "maxWriteMode": "direct", "allowProtected": false })).await;
    let (_, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
    assert_eq!(me["vaults"].as_array().unwrap().iter().map(|v| v["vaultId"].clone()).collect::<Vec<_>>(), [json!(personal)]);
    for (method, path, body) in [
        ("GET", club.clone(), Value::Null),
        ("GET", format!("{club}/snapshot?since=0"), Value::Null),
        ("POST", format!("{club}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })),
        ("POST", format!("{club}/proposals"), json!({ "proposal": proposal(&agent, &w.bartek.id) })),
    ] {
        assert_eq!(mcp.call(n, method, &path, body).await.1["code"], "scope", "{method} {path}");
    }
    // and its scope cannot be renewed onto the switched-off vault
    let body = json!({ "cert": stored_cert(n, &agent), "signature": "bmV3", "keys": [], "scopes": [
        { "vaultId": w.vault, "sealedScope": sealed_scope(), "ownScope": own_scope() },
        { "vaultId": personal, "sealedScope": sealed_scope(), "ownScope": own_scope() },
    ] });
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body).await.0, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicates_and_garbage_in_request_bodies_are_refused() {
    let w = world().await;
    let n = &w.n;
    let personal = migrate_personal(n, &w.bartek);
    let mcp = Mcp::new(72);
    let (pairing, _) = start_and_claim(n, &w.bartek, &mcp).await;
    let post = |body: Value| w.bartek.call(n, "POST", "/api/me/agents", body);
    let ok = || create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none"), (&personal, "none")], 4);
    let changed = |edit: &dyn Fn(&mut Value)| { let mut body = ok(); edit(&mut body); body };

    let cases: Vec<(&str, Value, u16)> = vec![
        ("the same vault twice in the cert", changed(&|b| { let v = b["cert"]["vaults"][0].clone(); b["cert"]["vaults"][1] = v; }), 400),
        ("the same key twice", changed(&|b| { let k = b["keys"][0].clone(); b["keys"].as_array_mut().unwrap().push(k); }), 400),
        ("the same scope twice", changed(&|b| { let s = b["scopes"][0].clone(); b["scopes"][1] = s; }), 400),
        ("a scope for a vault outside the cert", changed(&|b| { b["scopes"][1]["vaultId"] = json!("v-elsewhere"); }), 400),
        ("an unknown field in a cert vault", changed(&|b| { b["cert"]["vaults"][0]["admin"] = json!(true); }), 400),
        ("an unknown write mode", changed(&|b| { b["cert"]["vaults"][0]["writeMode"] = json!("all"); }), 400),
        ("a vault id that is no string", changed(&|b| { b["cert"]["vaults"][0]["vaultId"] = json!(7); }), 400),
        ("a cert that is no object", changed(&|b| { b["cert"] = json!("cert"); }), 400),
        ("a fractional time", changed(&|b| { b["cert"]["expiresAt"] = json!(1.5); }), 400),
        ("a future epoch", changed(&|b| { b["keys"][0]["keyEpoch"] = json!(i64::MAX); }), 400),
        ("epoch 0", changed(&|b| { b["keys"][0]["keyEpoch"] = json!(0); }), 400),
        ("a sealed key of another schema", changed(&|b| { b["keys"][0]["sealedKey"]["schema"] = json!("notes-sealed-v1"); }), 400),
        ("a sealed key with an extra field", changed(&|b| { b["keys"][0]["sealedKey"]["epk"] = json!("x"); }), 400),
        ("a huge sealed scope", changed(&|b| { b["scopes"][0]["sealedScope"]["box"] = json!(B64U.encode(vec![1u8; 49 * 1024])); }), 400),
        ("an agent id that is no hex", changed(&|b| { b["cert"]["agentId"] = json!("../../etc"); }), 400),
        ("a huge cert", changed(&|b| { b["cert"]["pad"] = json!("x".repeat(CERT_MAX_BYTES)); }), 400),
        ("hours as text", changed(&|b| { b["sessionHours"] = json!("4"); }), 422),
        ("an epoch as text", changed(&|b| { b["keys"][0]["keyEpoch"] = json!("1"); }), 422),
        ("keys that are no list", changed(&|b| { b["keys"] = json!({}); }), 422),
    ];
    for (what, body, expected) in cases {
        let (status, reply) = post(body).await;
        assert_eq!(status, expected, "{what}: {reply}");
    }
    assert_eq!(post(ok()).await.0, 201, "the pairing is still usable after all that");

    // the claim: each from its own address, so the per-address limits play no part
    let (_, started) = w.anna.call(n, "POST", "/api/me/agent-pairings", json!({})).await;
    let code = started["code"].as_str().unwrap();
    let claimer = Mcp::new(73);
    let claims: Vec<(&str, Value)> = vec![
        ("a long device name", { let mut b = claimer.claim_body(code); b["device"]["name"] = json!("x".repeat(65)); b }),
        ("a control character", { let mut b = claimer.claim_body(code); b["device"]["os"] = json!("linux\n"); b }),
        ("a short sign key", { let mut b = claimer.claim_body(code); b["signKey"] = json!(B64U.encode([1u8; 31])); b }),
        ("padded base64", { let mut b = claimer.claim_body(code); b["boxKey"] = json!(format!("{}=", B64U.encode([1u8; 32]))); b }),
        ("a code that is no string", { let mut b = claimer.claim_body(code); b["code"] = json!(12345678); b }),
        ("a device that is no object", { let mut b = claimer.claim_body(code); b["device"] = json!("laptop"); b }),
    ];
    for (i, (what, body)) in claims.into_iter().enumerate() {
        let ip = format!("203.0.113.{}", 100 + i);
        let (status, reply) = http(n.addr, "POST", "/api/agent-pair/claim", &[("X-Forwarded-For".into(), ip)], body.to_string().as_bytes()).await;
        assert_eq!((status, reply["code"].as_str()), (400, Some("invalid")), "{what}");
    }
    let (status, reply) = http(n.addr, "POST", "/api/agent-pair/claim", &[("X-Forwarded-For".into(), "203.0.113.120".into())], b"{not json").await;
    assert_eq!((status, reply["code"].as_str()), (400, Some("invalid")));
    assert_eq!(claimer.claim(n, code).await.0, 200, "garbage neither burns nor uses up the code");

    // chat bodies
    let mut chat = Mcp::new(74);
    let agent = pair(n, &w.bartek, &mut chat, &[(&w.vault, "direct")]).await;
    let base = format!("/api/agent/vaults/{}", w.vault);
    let mut extra = proposal(&agent, &w.bartek.id);
    extra["note"] = json!("hi");
    let mut short_sig = proposal(&agent, &w.bartek.id);
    short_sig["signature"] = json!(B64U.encode([8u8; 63]));
    for body in [json!({ "proposal": extra }), json!({ "proposal": short_sig }), json!({ "proposal": "x" }), json!([])] {
        assert_eq!(chat.call(n, "POST", &format!("{base}/proposals"), body.clone()).await.1["code"], "invalid", "{body}");
    }
    for body in [json!({ "baseRevision": -1, "envelope": snapshot(1, 1) }), json!({ "baseRevision": 0 }), json!({ "baseRevision": 0, "envelope": { "schema": "x" } })] {
        assert_eq!(chat.call(n, "POST", &format!("{base}/snapshot"), body.clone()).await.1["code"], "invalid", "{body}");
    }
    assert_eq!(n.sync.stored(&w.anna.id, &w.vault).unwrap().0, 0);

    // the owner's policy and a rotation that names a chat twice
    let policy = format!("/api/vaults/{}/agent-policy", w.vault);
    for body in [
        json!({ "enabled": true, "maxHours": 2, "maxWriteMode": "direct", "allowProtected": false }),
        json!({ "enabled": true, "maxHours": 8, "maxWriteMode": "everything", "allowProtected": false }),
    ] {
        assert_eq!(w.anna.call(n, "PUT", &policy, body).await.0, 400);
    }
    assert_eq!(w.anna.call(n, "PUT", &policy, json!({ "enabled": "yes", "maxHours": 8, "maxWriteMode": "direct", "allowProtected": false })).await.0, 422);
    let members = [(w.anna.id.clone(), sealed_p256(1)), (w.bartek.id.clone(), sealed_p256(2))];
    let ids: Vec<String> = db(n).prepare("SELECT agent_id FROM agents").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    let mut twice: Vec<(String, Value)> = ids.iter().map(|id| (id.clone(), sealed_key(2))).collect();
    twice.push((agent.clone(), sealed_key(3)));
    assert!(matches!(n.vaults.rotate_with_agents(&w.anna.id, &w.vault, 2, &members, &twice), Err(VaultError::Conflict(_))));
    let once: Vec<(String, Value)> = ids.iter().map(|id| (id.clone(), sealed_key(2))).collect();
    n.vaults.rotate_with_agents(&w.anna.id, &w.vault, 2, &members, &once).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_fetched_from_another_address_starts_the_chat_paused() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(75);
    let (pairing, pair_token) = start_and_claim(n, &w.bartek, &mcp).await;
    let (status, created) = w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 4)).await;
    assert_eq!(status, 201);
    let agent = created["agentId"].as_str().unwrap().to_string();
    mcp.ip = "203.0.113.77".into();
    let (status, issued) = mcp.call(n, "GET", &format!("/api/agent-pair/{pair_token}"), Value::Null).await;
    assert_eq!(status, 200, "{issued}");
    mcp.token = Some(issued["sessionToken"].as_str().unwrap().into());
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "paused");
    mcp.ip = IP.into();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.1["code"], "paused", "not even from the claim's address");
    let (_, list) = w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await;
    assert_eq!((list["agents"][0]["paused"].as_str(), list["agents"][0]["lastIp"].as_str()), (Some("ip"), Some("203.0.113.77")));
    assert_eq!(w.bartek.call(n, "POST", &format!("/api/me/agents/{agent}/confirm"), Value::Null).await.0, 204);
    mcp.ip = "203.0.113.77".into();
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn revoke_all_from_the_command_line_stops_a_running_servers_chats_at_once() {
    let w = world().await;
    let n = &w.n;
    let mut writer = Mcp::new(76);
    let writer_id = pair(n, &w.bartek, &mut writer, &[(&w.vault, "direct")]).await;
    let mut proposer = Mcp::new(77);
    let proposer_id = pair(n, &w.anna, &mut proposer, &[(&w.vault, "proposals")]).await;
    let base = format!("/api/agent/vaults/{}", w.vault);
    assert_eq!(proposer.call(n, "POST", &format!("{base}/proposals"), json!({ "proposal": proposal(&proposer_id, &w.anna.id) })).await.0, 201);
    // a chat whose token was not fetched yet
    let late = Mcp::new(78);
    let (pairing, pair_token) = start_and_claim(n, &w.bartek, &late).await;
    assert_eq!(w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &late, &pairing, &[(&w.vault, "none")], 4)).await.0, 201);

    // the command opens auth.db on its own connection while the server keeps running
    assert_eq!(revoke_all(n.dir.path(), true).unwrap(), 3);
    assert_eq!(writer.call(n, "POST", &format!("{base}/snapshot"), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await.1["code"], "session");
    assert_eq!(proposer.call(n, "GET", &base, Value::Null).await.1["code"], "session");
    assert_eq!(late.call(n, "GET", &format!("/api/agent-pair/{pair_token}"), Value::Null).await.0, 410);
    assert_eq!(count(n, "SELECT count(*) FROM agent_proposals WHERE state='open'"), 0);
    assert_eq!(count(n, "SELECT count(*) FROM agents WHERE revoked_at IS NULL OR session_hash IS NOT NULL"), 0);
    assert_eq!(n.sync.stored(&w.anna.id, &w.vault).unwrap().0, 0);
    // the person cannot renew a revoked chat back to life
    assert_eq!(w.bartek.call(n, "POST", &format!("/api/me/agents/{writer_id}/renew"), json!({ "hours": 4 })).await.0, 404);
    assert_eq!(revoke_all(n.dir.path(), true).unwrap(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn old_pairings_are_swept_also_once_done() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(79);
    pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    w.bartek.call(n, "POST", "/api/me/agent-pairings", json!({})).await;
    db(n).execute("UPDATE agent_pairings SET created_at=0, expires_at=?1", [now_millis() - 2 * DAY]).unwrap();
    assert_eq!(w.anna.call(n, "POST", "/api/me/agent-pairings", json!({})).await.0, 201);
    assert_eq!(count(n, "SELECT count(*) FROM agent_pairings"), 1, "only the new one");
    assert_eq!(mcp.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200, "the paired chat does not need its pairing");
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_counters_do_not_keep_an_entry_for_every_address_ever_seen() {
    let n = node().await;
    let locks = Arc::new(VaultLocks::default());
    let agents = AgentService::open(n.dir.path(), n.sync.clone(), locks, Config::default()).unwrap();
    for i in 0..MEMORY_ADDRESSES + 500 {
        // a wrong code from each address: an entry in both maps
        let body = json!({ "code": "AAAA-AAAA", "signKey": B64U.encode([1u8; 32]), "boxKey": B64U.encode([2u8; 32]),
            "device": { "name": "x", "os": "y" }, "mcpVersion": "1.0.0", "proof": B64U.encode([3u8; 64]) });
        assert!(agents.claim(&HeaderMap::new(), body.to_string().as_bytes(), &format!("ip-{i}")).is_err());
    }
    // still inside their windows: kept
    assert!(agents.memory().claims.len() > MEMORY_ADDRESSES);
    {
        let mut guard = agents.memory();
        let memory = &mut *guard;
        for times in memory.claims.values_mut().chain(memory.bad_codes.values_mut()) {
            for t in times.iter_mut() { *t -= 2 * HOUR; }
        }
    }
    let _ = agents.claim(&HeaderMap::new(), b"{}", "ip-new");
    let memory = agents.memory();
    assert!(memory.claims.len() <= 1 && memory.bad_codes.len() <= 1, "{} {}", memory.claims.len(), memory.bad_codes.len());
}

// ---- forced interleavings (test hooks) and the admin's detach ----

/// A proposal whose first check passed while, before its write, the chat was revoked, its person removed or lowered.
#[tokio::test(flavor = "multi_thread")]
async fn a_proposal_racing_a_revoke_a_removal_or_a_lower_role_leaves_nothing_open() {
    type Change = Box<dyn Fn(&Node, &World) -> Box<dyn FnOnce() + Send> + Send + Sync>;
    let changes: Vec<(&str, Change, &str)> = vec![
        ("revoke-all", Box::new(|n: &Node, _: &World| { let dir = n.dir.path().to_path_buf(); Box::new(move || { revoke_all(&dir, true).unwrap(); }) }), "scope"),
        ("removal", Box::new(|n: &Node, w: &World| {
            let (vaults, vault, anna, bartek) = (n.vaults.clone(), w.vault.clone(), w.anna.id.clone(), w.bartek.id.clone());
            Box::new(move || vaults.remove_member(&anna, &vault, &bartek).unwrap())
        }), "scope"),
        ("viewer", Box::new(|n: &Node, w: &World| {
            let (vaults, vault, anna, bartek) = (n.vaults.clone(), w.vault.clone(), w.anna.id.clone(), w.bartek.id.clone());
            Box::new(move || { vaults.set_member_role(&anna, &vault, &bartek, "viewer").unwrap(); })
        }), "read-only"),
    ];
    for (what, change, code) in changes {
        let w = world().await;
        let n = &w.n;
        let mut mcp = Mcp::new(80);
        let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "proposals")]).await;
        *n.agents.before_proposal.lock().unwrap() = Some(change(n, &w));
        let (status, reply) = mcp.call(n, "POST", &format!("/api/agent/vaults/{}/proposals", w.vault), json!({ "proposal": proposal(&agent, &w.bartek.id) })).await;
        assert!(n.agents.before_proposal.lock().unwrap().is_none(), "{what}: the hook ran");
        assert_eq!(reply["code"].as_str(), Some(code), "{what}: {status} {reply}");
        assert_eq!(count(n, "SELECT count(*) FROM agent_proposals"), 0, "{what}");
    }
}

/// A put that passed its epoch check is between its check and its commit while an admin rotates: the rotation waits
/// for the put, so no put of the old epoch is stored after the new epoch exists.
#[tokio::test(flavor = "multi_thread")]
async fn a_rotation_waits_for_a_put_that_passed_its_epoch_check() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(81);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "direct")]).await;
    let finished_during_put = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rotation = Arc::new(Mutex::new(None));
    {
        let (vaults, vault, anna, bartek, agent) = (n.vaults.clone(), w.vault.clone(), w.anna.id.clone(), w.bartek.id.clone(), agent.clone());
        let (finished, rotation) = (finished_during_put.clone(), rotation.clone());
        *n.sync.before_commit.lock().unwrap() = Some(Box::new(move || {
            let (done, wait) = std::sync::mpsc::channel();
            let handle = std::thread::spawn(move || {
                let members = [(anna, sealed_p256(1)), (bartek, sealed_p256(2))];
                let result = vaults.rotate_with_agents(&members[0].0, &vault, 2, &members, &[(agent, sealed_key(2))]).map(|v| v.key_epoch);
                let _ = done.send(());
                result
            });
            // the old code rotated at once, under the put's feet; now the rotation is held until the put commits
            finished.store(wait.recv_timeout(Duration::from_millis(500)).is_ok(), std::sync::atomic::Ordering::SeqCst);
            *rotation.lock().unwrap() = Some(handle);
        }));
    }
    let (status, put) = mcp.call(n, "POST", &format!("/api/agent/vaults/{}/snapshot", w.vault), json!({ "baseRevision": 0, "envelope": snapshot(1, 1) })).await;
    assert_eq!(status, 200, "{put}");
    assert!(!finished_during_put.load(std::sync::atomic::Ordering::SeqCst), "the rotation finished while an old-epoch put was not yet stored");
    let handle = rotation.lock().unwrap().take().expect("the hook ran");
    assert_eq!(handle.join().unwrap().unwrap(), 2);
    // after the rotation the old epoch is refused
    let (status, stale) = mcp.call(n, "POST", &format!("/api/agent/vaults/{}/snapshot", w.vault), json!({ "baseRevision": 1, "envelope": snapshot(1, 2) })).await;
    assert_eq!((status, stale["code"].as_str()), (409, Some("stale-key")));
    assert_eq!(n.sync.stored(&w.anna.id, &w.vault).unwrap().0, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_admin_detaches_a_chat_from_the_organization_only() {
    let w = world().await;
    let n = &w.n;
    let personal = migrate_personal(n, &w.bartek);
    let mut mcp = Mcp::new(82);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "proposals"), (&personal, "proposals")]).await;
    let club = format!("/api/agent/vaults/{}", w.vault);
    let notes = format!("/api/agent/vaults/{personal}");
    assert_eq!(mcp.call(n, "POST", &format!("{club}/proposals"), json!({ "proposal": proposal(&agent, &w.bartek.id) })).await.0, 201);
    let mut kept = proposal(&agent, &w.bartek.id);
    kept["proposalId"] = json!("fedcba9876543210fedcba9876543210");
    assert_eq!(mcp.call(n, "POST", &format!("{notes}/proposals"), json!({ "proposal": kept })).await.0, 201);
    db(n).execute("UPDATE vaults SET needs_rotation=0 WHERE vault_id=?1", [&w.vault]).unwrap();

    let detach = format!("/api/vaults/{}/agents/{agent}", w.vault);
    assert_eq!(w.anna.call(n, "DELETE", &detach, Value::Null).await.0, 204);
    // this vault is gone for the chat, the other one and the session stay
    assert_eq!(mcp.call(n, "GET", &club, Value::Null).await.1["code"], "scope");
    assert_eq!(mcp.call(n, "GET", &notes, Value::Null).await.0, 200);
    let (_, me) = mcp.call(n, "GET", "/api/agent/me", Value::Null).await;
    assert_eq!(me["vaults"].as_array().unwrap().iter().map(|v| v["vaultId"].clone()).collect::<Vec<_>>(), [json!(personal)]);
    let rows = |sql: &str| count(n, &sql.replace("$V", &w.vault).replace("$P", &personal));
    assert_eq!(rows("SELECT count(*) FROM agent_keys WHERE vault_id='$V'"), 0);
    assert_eq!(rows("SELECT count(*) FROM agent_scopes WHERE vault_id='$V'"), 0);
    assert_eq!(rows("SELECT count(*) FROM agent_proposals WHERE vault_id='$V'"), 0);
    assert_eq!(rows("SELECT count(*) FROM agent_proposals WHERE vault_id='$P'"), 1);
    assert_eq!(rows("SELECT count(*) FROM agents WHERE revoked_at IS NULL AND session_hash IS NOT NULL"), 1);
    assert_eq!(rows("SELECT needs_rotation FROM vaults WHERE vault_id='$V'"), 1);
    // members still see the chat in this vault, as revoked from now on (for its old signatures)
    let (_, vault) = w.anna.call(n, "GET", &format!("/api/vaults/{}", w.vault), Value::Null).await;
    let bartek_row = vault["members"].as_array().unwrap().iter().find(|m| m["userId"] == w.bartek.id.as_str()).unwrap().clone();
    assert_eq!(bartek_row["agents"][0]["agentId"], agent.as_str());
    assert!(bartek_row["agents"][0]["detachedAt"].is_i64(), "{bartek_row}");
    assert!(bartek_row["agents"][0]["revokedAt"].is_null());
    // still listed after the whole chat is revoked later, with both times
    let listed = || async {
        let (_, vault) = w.anna.call(n, "GET", &format!("/api/vaults/{}", w.vault), Value::Null).await;
        vault["members"].as_array().unwrap().iter().find(|m| m["userId"] == w.bartek.id.as_str()).unwrap()["agents"].clone()
    };
    let (_, list) = w.bartek.call(n, "GET", "/api/me/agents", Value::Null).await;
    assert!(list["agents"][0]["revokedAt"].is_null(), "the chat itself is not revoked");
    // the rotation needs no key for it, a second detach finds nothing, and a new cert cannot bring the vault back
    let members = [(w.anna.id.clone(), sealed_p256(1)), (w.bartek.id.clone(), sealed_p256(2))];
    n.vaults.rotate(&w.anna.id, &w.vault, 2, &members).unwrap();
    assert_eq!(w.anna.call(n, "DELETE", &detach, Value::Null).await.0, 404);
    let body = json!({ "cert": stored_cert(n, &agent), "signature": "bmV3",
        "keys": [{ "vaultId": w.vault, "keyEpoch": 2, "sealedKey": sealed_key(2) }],
        "scopes": [
            { "vaultId": w.vault, "sealedScope": sealed_scope(), "ownScope": own_scope() },
            { "vaultId": personal, "sealedScope": sealed_scope(), "ownScope": own_scope() },
        ] });
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body).await.0, 403);
    assert_eq!(mcp.call(n, "GET", &club, Value::Null).await.0, 404);
    // the person still disconnects the whole chat
    assert_eq!(w.bartek.call(n, "DELETE", &format!("/api/me/agents/{agent}"), Value::Null).await.0, 204);
    assert_eq!(mcp.call(n, "GET", &notes, Value::Null).await.1["code"], "session");
    let after = listed().await;
    assert!(after[0]["detachedAt"].is_i64() && after[0]["revokedAt"].is_i64(), "{after}");
    // shown for 90 days from the detach
    db(n).execute("UPDATE agent_detached SET detached_at=?1", [now_millis() - REVOKED_SHOWN - 1]).unwrap();
    assert_eq!(listed().await, json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_operator_switch_also_stops_setting_up_and_changing_a_chat() {
    let w = world().await;
    let n = &w.n;
    let mut mcp = Mcp::new(83);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "none")]).await;
    let other = Mcp::new(84);
    let (pairing, _) = start_and_claim(n, &w.bartek, &other).await;
    set_disabled(n.dir.path(), true).unwrap();
    let body = json!({ "cert": stored_cert(n, &agent), "signature": "bmV3", "keys": [],
        "scopes": [{ "vaultId": w.vault, "sealedScope": sealed_scope(), "ownScope": own_scope() }] });
    let (status, reply) = w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body.clone()).await;
    assert_eq!((status, reply["code"].as_str()), (503, Some("disabled")));
    let (status, reply) = w.bartek.call(n, "POST", "/api/me/agents", create_body(n, &w.bartek, &other, &pairing, &[(&w.vault, "none")], 4)).await;
    assert_eq!((status, reply["code"].as_str()), (503, Some("disabled")));
    set_disabled(n.dir.path(), false).unwrap();
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body).await.0, 204);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cert_takes_only_the_contracts_fields() {
    let w = world().await;
    let n = &w.n;
    let mcp = Mcp::new(85);
    let (pairing, _) = start_and_claim(n, &w.bartek, &mcp).await;
    let post = |body: Value| w.bartek.call(n, "POST", "/api/me/agents", body);
    let with = |field: &str, value: Value| {
        let mut body = create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 4);
        body["cert"][field] = value;
        body
    };
    assert_eq!(post(with("admin", json!(true))).await.0, 400, "an unknown field");
    assert_eq!(post(with("revokedAt", Value::Null)).await.0, 400, "a field of the server's own");
    assert_eq!(post(with("signerUserId", json!(w.anna.id))).await.0, 400, "signed by someone else");
    assert_eq!(post(with("signature", json!(5))).await.0, 400);
    let mut vault_field = create_body(n, &w.bartek, &mcp, &pairing, &[(&w.vault, "none")], 4);
    vault_field["cert"]["vaults"][0].as_object_mut().unwrap().remove("parts");
    vault_field["cert"]["vaults"][0]["role"] = json!("owner");
    assert_eq!(post(vault_field).await.0, 400, "an unknown field in vaults[]");
    let mut signed = with("signerUserId", json!(w.bartek.id));
    signed["cert"]["signature"] = json!("c2ln");
    assert_eq!(post(signed).await.0, 201, "the app's own signature fields");
}

#[tokio::test(flavor = "multi_thread")]
async fn chats_revoked_over_90_days_ago_are_deleted_with_their_rows() {
    let w = world().await;
    let n = &w.n;
    let mut old = Mcp::new(86);
    let old_id = pair(n, &w.bartek, &mut old, &[(&w.vault, "proposals")]).await;
    let mut recent = Mcp::new(87);
    let recent_id = pair(n, &w.bartek, &mut recent, &[(&w.vault, "none")]).await;
    let mut alive = Mcp::new(88);
    let alive_id = pair(n, &w.bartek, &mut alive, &[(&w.vault, "none")]).await;
    db(n).execute("UPDATE agent_pairings SET created_at=0", []).unwrap();
    assert_eq!(old.call(n, "POST", &format!("/api/agent/vaults/{}/proposals", w.vault), json!({ "proposal": proposal(&old_id, &w.bartek.id) })).await.0, 201);
    db(n).execute("UPDATE agent_proposals SET state='approved'", []).unwrap();
    for id in [&old_id, &recent_id] { assert_eq!(w.bartek.call(n, "DELETE", &format!("/api/me/agents/{id}"), Value::Null).await.0, 204); }
    db(n).execute("UPDATE agents SET revoked_at=?2 WHERE agent_id=?1", params![old_id, now_millis() - REVOKED_SHOWN - 1]).unwrap();

    assert_eq!(w.anna.call(n, "POST", "/api/me/agent-pairings", json!({})).await.0, 201);
    let ids: Vec<String> = db(n).prepare("SELECT agent_id FROM agents ORDER BY created_at").unwrap()
        .query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(ids, [recent_id.clone(), alive_id.clone()]);
    for table in ["agent_keys", "agent_scopes", "agent_proposals", "agent_usage"] {
        assert_eq!(count(n, &format!("SELECT count(*) FROM {table} WHERE agent_id='{old_id}'")), 0, "{table}");
    }
    // also when the service opens
    db(n).execute("UPDATE agents SET revoked_at=?2 WHERE agent_id=?1", params![recent_id, now_millis() - REVOKED_SHOWN - 1]).unwrap();
    AgentService::open(n.dir.path(), n.sync.clone(), Arc::new(VaultLocks::default()), Config::default()).unwrap();
    assert_eq!(count(n, "SELECT count(*) FROM agents"), 1);
    assert_eq!(alive.call(n, "GET", "/api/agent/me", Value::Null).await.0, 200);
}

// ---- the text of files (docs/OCR.md §5.2, §5.3) ----

const ORIGINAL: &str = "0123456789abcdef0123456789abcd01";
const LAYER: &str = "0123456789abcdef0123456789abcd02";
const THUMB: &str = "0123456789abcdef0123456789abcd03";
const LAYER_BYTES: &[u8] = b"CIPHERTEXT-OF-A-TEXT-LAYER";

fn file_meta() -> Value { json!({ "schema": "notes-file-meta-v2", "keyEpoch": 1, "nonce": "AAAAAAAAAAAAAAAA", "ciphertext": "AAAA" }) }

async fn put_file(n: &Node, user: &str, vault: &str, id: &str, parent: Option<&str>, kind: Option<&str>, data: &[u8]) {
    let data = &padded(data);
    n.files.create_kind(user, vault, id, data.len() as u64, &file_meta(), None, parent, kind).unwrap();
    n.files.put_chunk(user, vault, id, 0, data).unwrap();
    n.files.complete(user, vault, id).await.unwrap();
}

/// `data` padded to 100 bytes, a valid ciphertext size (the container's smallest sizes are refused).
fn padded(data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    out.resize(100, b'.');
    out
}

/// The raw body of a chat's GET (the content route answers bytes, not JSON).
async fn chat_bytes(n: &Node, mcp: &Mcp, path: &str) -> (u16, Vec<u8>) {
    let headers = mcp.headers("GET", path, &[], now_millis(), &random_hex::<16>().unwrap(), &mcp.version);
    let mut stream = tokio::net::TcpStream::connect(n.addr).await.unwrap();
    let mut head = format!("GET {path} HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n", n.addr);
    for (name, value) in &headers { head.push_str(&format!("{name}: {value}\r\n")); }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let status = String::from_utf8_lossy(&out[9..12]).parse().unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").map_or(out.len(), |i| i + 4);
    (status, out[at..].to_vec())
}

/// Turns "Tekst z plików" on or off in the chat's certificate (a scope change by its person).
async fn set_file_text(n: &Node, who: &Person, agent: &str, vault: &str, on: Value) -> u16 {
    let mut cert = stored_cert(n, agent);
    cert["vaults"][0]["fileText"] = on;
    let body = json!({ "cert": cert, "signature": "bmV3", "keys": [], "scopes": [{ "vaultId": vault, "sealedScope": sealed_scope(), "ownScope": own_scope() }] });
    who.call(n, "PUT", &format!("/api/me/agents/{agent}"), body).await.0
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_reads_text_layers_only_with_the_file_text_permission_and_never_an_original() {
    let w = world().await;
    let n = &w.n;
    put_file(n, &w.anna.id, &w.vault, ORIGINAL, None, None, b"%PDF-ORIGINAL-BYTES").await;
    put_file(n, &w.anna.id, &w.vault, LAYER, Some(ORIGINAL), Some("text"), LAYER_BYTES).await;
    put_file(n, &w.anna.id, &w.vault, THUMB, Some(ORIGINAL), Some("thumb"), b"THUMB").await;
    let mut mcp = Mcp::new(70);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "proposals")]).await;
    let files = format!("/api/agent/vaults/{}/files", w.vault);
    let content = |id: &str| format!("{files}/{id}/content");

    // a certificate from before the permission (no fileText): off
    let (status, refused) = mcp.call(n, "GET", &files, Value::Null).await;
    assert_eq!((status, refused["code"].as_str()), (403, Some("file-text")), "{refused}");
    assert_eq!(chat_bytes(n, &mcp, &content(LAYER)).await.0, 403);
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["fileText"], false);

    // fileText only inside a vault entry: at the top level, or next to an unknown field, the cert is refused
    let mut top = stored_cert(n, &agent);
    top["fileText"] = json!(true);
    let body = |cert: Value| json!({ "cert": cert, "signature": "bmV3", "keys": [], "scopes": [{ "vaultId": w.vault, "sealedScope": sealed_scope(), "ownScope": own_scope() }] });
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body(top)).await.0, 400);
    let mut extra = stored_cert(n, &agent);
    extra["vaults"][0]["fileText"] = json!(true);
    extra["vaults"][0]["more"] = json!(1);
    assert_eq!(w.bartek.call(n, "PUT", &format!("/api/me/agents/{agent}"), body(extra)).await.0, 400);
    assert_eq!(set_file_text(n, &w.bartek, &agent, &w.vault, json!(false)).await, 204);
    assert_eq!(mcp.call(n, "GET", &files, Value::Null).await.0, 403);
    // a malformed value is refused; true turns it on
    assert_eq!(set_file_text(n, &w.bartek, &agent, &w.vault, json!("yes")).await, 400);
    assert_eq!(set_file_text(n, &w.bartek, &agent, &w.vault, json!(true)).await, 204);
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{}", w.vault), Value::Null).await.1["fileText"], true);
    let (status, listed) = mcp.call(n, "GET", &files, Value::Null).await;
    assert_eq!(status, 200, "{listed}");
    let mut ids: Vec<&str> = listed["files"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
    ids.sort_unstable();
    assert_eq!(ids, [ORIGINAL, LAYER], "originals' envelopes and text layers, never a thumbnail");
    assert_eq!(chat_bytes(n, &mcp, &content(LAYER)).await, (200, padded(LAYER_BYTES)));

    // an original, a thumbnail and a file that does not exist: the same 404, nothing of their bytes
    let missing = "0123456789abcdef0123456789abcdff";
    let answers: Vec<(u16, Vec<u8>)> = vec![
        chat_bytes(n, &mcp, &content(ORIGINAL)).await,
        chat_bytes(n, &mcp, &content(THUMB)).await,
        chat_bytes(n, &mcp, &content(missing)).await,
    ];
    for (status, body) in &answers {
        assert_eq!(*status, 404);
        assert_eq!(body, &answers[2].1);
        assert!(!String::from_utf8_lossy(body).contains("PDF-ORIGINAL"));
    }
    assert!(String::from_utf8_lossy(&answers[0].1).contains(crate::files::OUT_OF_CHAT_SCOPE));

    // an upload in progress (anyone's) and another vault's files are not listed; a vault outside the cert is 404
    let uploading = "0123456789abcdef0123456789abcd04";
    n.files.create_kind(&w.bartek.id, &w.vault, uploading, 100, &file_meta(), None, Some(ORIGINAL), Some("text")).unwrap();
    let other = n.vaults.create(&w.anna.id, "Inna", "organizacja", &key()).unwrap().info.id;
    put_file(n, &w.anna.id, &other, ORIGINAL, None, None, b"%PDF-INNY").await;
    let (_, listed) = mcp.call(n, "GET", &files, Value::Null).await;
    assert_eq!(listed["files"].as_array().unwrap().len(), 2, "{listed}");
    assert_eq!(mcp.call(n, "GET", &format!("/api/agent/vaults/{other}/files"), Value::Null).await.0, 404);
    assert_eq!(chat_bytes(n, &mcp, &format!("/api/agent/vaults/{other}/files/{ORIGINAL}/content")).await.0, 404);

    // the original in the trash: its text is neither served nor listed
    n.files.delete(&w.anna.id, &w.vault, ORIGINAL).await.unwrap();
    assert_eq!(chat_bytes(n, &mcp, &content(LAYER)).await.0, 404);
    assert_eq!(mcp.call(n, "GET", &files, Value::Null).await.1["files"], json!([]));
    n.files.restore(&w.anna.id, &w.vault, ORIGINAL).unwrap();
    assert_eq!(chat_bytes(n, &mcp, &content(LAYER)).await.0, 200);

    // the owner blocks it: the chat loses it at once, and a certificate asking for it is refused
    let (status, _) = w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault),
        json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": false, "allowFileText": false })).await;
    assert_eq!(status, 204);
    assert_eq!(mcp.call(n, "GET", &files, Value::Null).await.0, 403);
    assert_eq!(chat_bytes(n, &mcp, &content(LAYER)).await.0, 403);
    assert_eq!(set_file_text(n, &w.bartek, &agent, &w.vault, json!(true)).await, 400);
    // a policy update from a client that does not know the field keeps the block
    w.anna.call(n, "PUT", &format!("/api/vaults/{}/agent-policy", w.vault),
        json!({ "enabled": true, "maxHours": 24, "maxWriteMode": "direct", "allowProtected": false })).await;
    assert!(!policy(&db(n), &w.vault).unwrap().allow_file_text);
    assert!(count(n, "SELECT COUNT(*) FROM agent_usage WHERE kind='file_text'") >= 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn text_layers_are_fetched_at_most_one_full_pass_per_window() {
    let w = world().await;
    let n = &w.n;
    put_file(n, &w.anna.id, &w.vault, ORIGINAL, None, None, b"%PDF").await;
    put_file(n, &w.anna.id, &w.vault, LAYER, Some(ORIGINAL), Some("text"), LAYER_BYTES).await;
    let mut mcp = Mcp::new(71);
    let agent = pair(n, &w.bartek, &mut mcp, &[(&w.vault, "proposals")]).await;
    assert_eq!(set_file_text(n, &w.bartek, &agent, &w.vault, json!(true)).await, 204);
    let path = format!("/api/agent/vaults/{}/files/{LAYER}/content", w.vault);
    // one layer in the vault: 1 + the margin, then a strike; asking for an original counts too
    for _ in 0..TEXT_READ_MARGIN {
        assert_eq!(chat_bytes(n, &mcp, &path).await.0, 200);
    }
    assert_eq!(chat_bytes(n, &mcp, &format!("/api/agent/vaults/{}/files/{ORIGINAL}/content", w.vault)).await.0, 404);
    assert_eq!(chat_bytes(n, &mcp, &path).await.0, 429);
}
