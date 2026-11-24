//! The sync socket end to end, over a real WebSocket: keepalive, a reconnect that holds the revision, and the
//! coalescing of full updates (docs/WEB-WSPOLDZIELENIE.md "Połączenie").

use super::*;

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const PASSWORD: &str = "A long test password 1";

struct Node { addr: SocketAddr, vault: String, owner: String, editor: String, owner_id: String, sync: Arc<BrowserSync>, _dir: tempfile::TempDir }

fn envelope(byte: u8) -> Value {
    json!({ "schema": "notes-encrypted-v1", "nonce": BASE64.encode([byte; 12]), "ciphertext": BASE64.encode([byte; 32]), "keyEpoch": 1 })
}

fn key() -> Envelope {
    Envelope { schema: "notes-key-v1".into(), nonce: BASE64.encode([7u8; 12]), ciphertext: BASE64.encode([9u8; 48]), key_epoch: None }
}

async fn node() -> Node {
    let dir = tempfile::tempdir().unwrap();
    let auth = Arc::new(AuthService::open(dir.path()).unwrap());
    let locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
    let sync = Arc::new(BrowserSync::open(dir.path(), vaults.clone(), locks).unwrap());
    let (owner, owner_token) = auth.register("owner@example.test", PASSWORD).unwrap();
    let (editor, editor_token) = auth.register("editor@example.test", PASSWORD).unwrap();
    let vault = vaults.create(&owner.id, "Zespół", "organizacja", &key()).unwrap().info.id;
    let invite = vaults.create_invite(&owner.id, &vault, "editor").unwrap();
    vaults.accept_invite(&editor.id, &invite.token, &key(), 1).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = routes(auth, sync.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    Node { addr, vault, owner: owner_token, editor: editor_token, owner_id: owner.id, sync, _dir: dir }
}

fn nonce(byte: u8) -> String { BASE64.encode([byte; 12]) }

async fn open(n: &Node, token: &str, held: Option<(u64, String)>) -> (Ws, Value) {
    let mut request = format!("ws://{}/api/sync/ws", n.addr).into_client_request().unwrap();
    request.headers_mut().insert("Cookie", format!("notes_session={token}").parse().unwrap());
    request.headers_mut().insert("Origin", format!("http://{}", n.addr).parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let mut hello = json!({ "type": "hello", "vaultId": n.vault });
    if let Some((r, nonce)) = held { hello["revision"] = json!(r); hello["nonce"] = json!(nonce); }
    send(&mut ws, hello).await;
    let snapshot = next(&mut ws).await;
    (ws, snapshot)
}

async fn send(ws: &mut Ws, frame: Value) { ws.send(tungstenite::Message::Text(frame.to_string().into())).await.unwrap(); }

async fn next(ws: &mut Ws) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("no frame within 5 s").unwrap().unwrap() {
            tungstenite::Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            _ => continue,
        }
    }
}

/// Frames that arrive within `window`, in order.
async fn frames_within(ws: &mut Ws, window: Duration) -> Vec<Value> {
    let mut out = Vec::new();
    let end = tokio::time::Instant::now() + window;
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(end, ws.next()).await {
        if let tungstenite::Message::Text(t) = msg { out.push(serde_json::from_str(&t).unwrap()); }
    }
    out
}

#[tokio::test]
async fn a_ping_gets_a_pong() {
    let n = node().await;
    let (mut ws, snapshot) = open(&n, &n.owner, None).await;
    assert_eq!(snapshot["type"], "snapshot");
    send(&mut ws, json!({ "type": "ping" })).await;
    assert_eq!(next(&mut ws).await, json!({ "type": "pong" }));
}

#[tokio::test]
async fn a_reconnect_holding_the_revision_gets_no_envelope_and_a_stale_one_gets_the_vault() {
    let n = node().await;
    let (mut ws, _) = open(&n, &n.owner, None).await;
    send(&mut ws, json!({ "type": "put", "baseRevision": 0, "envelope": envelope(1) })).await;
    assert_eq!(next(&mut ws).await["type"], "ack");

    let (_, same) = open(&n, &n.editor, Some((1, nonce(1)))).await;
    assert_eq!((same["revision"].as_u64(), same["unchanged"].as_bool(), same["envelope"].is_null()), (Some(1), Some(true), true));

    let (_, stale) = open(&n, &n.editor, Some((0, nonce(1)))).await;
    assert_eq!(stale["envelope"], envelope(1));
    assert!(stale.get("unchanged").is_none(), "{stale}");

    // the same revision number with other content (a restored database): the whole vault
    let (_, other) = open(&n, &n.editor, Some((1, nonce(9)))).await;
    assert_eq!(other["envelope"], envelope(1));

    // a first open (no revision) is never told "unchanged"
    let (_, first) = open(&n, &n.editor, None).await;
    assert_eq!(first["envelope"], envelope(1));
}

#[tokio::test]
async fn puts_in_quick_succession_reach_another_member_as_the_first_and_then_only_the_newest() {
    let n = node().await;
    let (mut writer, _) = open(&n, &n.owner, None).await;
    let (mut reader, _) = open(&n, &n.editor, None).await;
    for (base, byte) in [(0u64, 1u8), (1, 2), (2, 3), (3, 4)] {
        send(&mut writer, json!({ "type": "put", "baseRevision": base, "envelope": envelope(byte) })).await;
        assert_eq!(next(&mut writer).await["type"], "ack");
    }
    let got = frames_within(&mut reader, UPDATE_EVERY + Duration::from_millis(1500)).await;
    let updates: Vec<(u64, Value)> = got.iter().filter(|f| f["type"] == "update").map(|f| (f["revision"].as_u64().unwrap(), f["envelope"].clone())).collect();
    assert_eq!(updates, vec![(1, envelope(1)), (4, envelope(4))], "{got:?}");
    // the writer never gets its own revisions back as updates
    assert!(frames_within(&mut writer, Duration::from_millis(300)).await.iter().all(|f| f["type"] != "update"));
}

#[tokio::test]
async fn a_conflict_counts_as_sent_so_the_same_revision_does_not_follow_as_an_update() {
    let n = node().await;
    let (mut a, _) = open(&n, &n.owner, None).await;
    let (mut b, _) = open(&n, &n.editor, None).await;
    send(&mut a, json!({ "type": "put", "baseRevision": 0, "envelope": envelope(1) })).await;
    assert_eq!(next(&mut a).await["type"], "ack");
    assert_eq!(next(&mut b).await["revision"], 1); // the first update goes at once
    send(&mut a, json!({ "type": "put", "baseRevision": 1, "envelope": envelope(2) })).await;
    assert_eq!(next(&mut a).await["type"], "ack");
    // b, still on revision 1, puts before revision 2 reaches it: the conflict carries revision 2
    send(&mut b, json!({ "type": "put", "baseRevision": 1, "envelope": envelope(9) })).await;
    let conflict = next(&mut b).await;
    assert_eq!((conflict["type"].as_str(), conflict["revision"].as_u64()), (Some("conflict"), Some(2)));
    let later = frames_within(&mut b, UPDATE_EVERY + Duration::from_millis(800)).await;
    assert!(later.iter().all(|f| f["type"] != "update"), "{later:?}");
}

#[tokio::test]
async fn a_chats_revision_is_never_folded_into_another_and_what_was_held_back_goes_first() {
    let n = node().await;
    let (mut writer, _) = open(&n, &n.owner, None).await;
    let (mut reader, _) = open(&n, &n.editor, None).await;
    for (base, byte) in [(0u64, 1u8), (1, 2)] {
        send(&mut writer, json!({ "type": "put", "baseRevision": base, "envelope": envelope(byte) })).await;
        assert_eq!(next(&mut writer).await["type"], "ack");
    }
    // revision 2 is held back (within UPDATE_EVERY of revision 1); a chat writes revision 3
    let chat: Envelope = serde_json::from_value(envelope(3)).unwrap();
    assert!(matches!(n.sync.put(&n.owner_id, &n.vault, 2, &chat).unwrap(), PutResult::Accepted(3)));
    n.sync.publish_update(&n.owner_id, &n.vault, 3, chat, Author { user_id: n.owner_id.clone(), agent_id: Some("chat-1".into()) });
    let got = frames_within(&mut reader, Duration::from_millis(800)).await;
    let revisions: Vec<(u64, Value)> = got.iter().filter(|f| f["type"] == "update").map(|f| (f["revision"].as_u64().unwrap(), f["author"]["agentId"].clone())).collect();
    assert_eq!(revisions, vec![(1, Value::Null), (2, Value::Null), (3, json!("chat-1"))], "{got:?}");
}
