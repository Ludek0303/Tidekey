//! Router rules on their own, and the command line: `init`, `ticket`, `health`.

mod common;

use std::net::TcpListener;
use std::process::Command;

use common::*;
use notes_node::router::NodeRouter;
use notes_node::run::{Options, start};
use notes_node::store::{NodeStore, open_db};
use notes_sync::cert::DeviceCert;
use notes_sync::net::Router;
use notes_sync::proto::{Frame, PROTOCOL, PeerProof};
use notes_sync::session::Local;
use notes_sync::ticket::NodeTicket;

const TOKEN: [u8; 32] = [7; 32];

fn router(dir: &std::path::Path, max_spaces: usize) -> NodeRouter {
    let db = open_db(&dir.join("node.db")).unwrap();
    NodeRouter::open(db, TOKEN, max_spaces, 1 << 30).unwrap()
}

/// A device's Hello for `space`, with the given token. The bind signature is not checked by the router.
fn hello(space: [u8; 16], token: Option<[u8; 32]>) -> Frame {
    let dir = tempfile::tempdir().unwrap();
    let owner = Team::new(dir.path()).into_stores().pop().unwrap();
    let cert: DeviceCert = owner.opened.cert;
    Frame::Hello {
        protocol: PROTOCOL,
        space,
        proof: PeerProof::Device {
            cert,
            bind: [0; 64],
        },
        acl_head: None,
        token,
    }
}

#[test]
fn a_node_proof_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let router = router(dir.path(), 10);
    let node_hello = Frame::Hello {
        protocol: PROTOCOL,
        space: [1; 16],
        proof: PeerProof::Node,
        acl_head: None,
        token: Some(TOKEN),
    };
    assert!(router.route(&node_hello, [0; 32]).is_none());
}

#[test]
fn unknown_space_needs_the_right_token() {
    let dir = tempfile::tempdir().unwrap();
    let router = router(dir.path(), 10);
    assert!(router.route(&hello([1; 16], None), [0; 32]).is_none());
    assert!(
        router
            .route(&hello([1; 16], Some([8; 32])), [0; 32])
            .is_none()
    );
    let (_hub, local) = router.route(&hello([1; 16], Some(TOKEN)), [0; 32]).unwrap();
    assert!(matches!(local, Local::Node { token_ok: true }));
}

#[test]
fn registration_in_flight_counts_against_the_limit_until_it_ends() {
    let dir = tempfile::tempdir().unwrap();
    let router = router(dir.path(), 1);
    let (first, _) = router.route(&hello([1; 16], Some(TOKEN)), [0; 32]).unwrap();
    assert_eq!(router.space_count(), 1);
    // a second unknown space is refused while the first is still being registered
    assert!(
        router
            .route(&hello([2; 16], Some(TOKEN)), [0; 32])
            .is_none()
    );
    // the same space again is served to the registration in flight
    assert!(
        router
            .route(&hello([1; 16], Some(TOKEN)), [0; 32])
            .is_some()
    );
    drop(first);
    // once nothing holds it and nothing was stored, it leaves no trace
    assert!(
        router
            .route(&hello([2; 16], Some(TOKEN)), [0; 32])
            .is_some()
    );
    assert_eq!(router.space_count(), 1);
}

#[tokio::test]
async fn stored_space_is_served_without_the_token() {
    let (data, a) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let owner = device(Team::new(a.path()).into_stores().pop().unwrap()).await;
    let node = start(Options {
        data: data.path().to_path_buf(),
        quic: "127.0.0.1:0".parse().unwrap(),
        http: "127.0.0.1:0".parse().unwrap(),
        web: None,
        max_spaces: 10,
        max_space_mb: 16,
        max_conns: 256,
        relay: false,
        admin_http: None,
    })
    .await
    .unwrap();
    sync(&owner, &node.ticket()).await.unwrap();
    node.shutdown().await.unwrap();

    // after a restart the space is known: any device gets a token-less session, and the token is not accepted
    let db = open_db(&data.path().join("node.db")).unwrap();
    let router = NodeRouter::open(db, TOKEN, 10, 1 << 30).unwrap();
    let space = owner.hub.store().opened.acl.space;
    let (_, local) = router.route(&hello(space, Some(TOKEN)), [0; 32]).unwrap();
    assert!(matches!(local, Local::Node { token_ok: false }));
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_notes-node"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn init_is_idempotent_and_ticket_matches_it() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_str().unwrap();
    let first = run(&["init", "--data", data, "--public-addr", "203.0.113.5:7842"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let printed = String::from_utf8(first.stdout).unwrap();
    let ticket: NodeTicket = printed.trim().parse().unwrap();
    assert_eq!(ticket.addrs, vec!["203.0.113.5:7842".parse().unwrap()]);

    let again = run(&["init", "--data", data, "--public-addr", "203.0.113.5:7842"]);
    assert_eq!(String::from_utf8(again.stdout).unwrap(), printed);
    let ticket_out = run(&[
        "ticket",
        "--data",
        data,
        "--public-addr",
        "203.0.113.5:7842",
    ]);
    assert_eq!(String::from_utf8(ticket_out.stdout).unwrap(), printed);

    #[cfg(unix)]
    for file in ["node.key", "token"] {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join(file))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{file}");
    }
}

#[test]
fn bad_arguments_exit_with_two() {
    assert_eq!(run(&["serve"]).status.code(), Some(2));
    assert_eq!(run(&["frobnicate"]).status.code(), Some(2));
    assert_eq!(
        run(&["init", "--data", "/tmp/x", "--nope", "1"])
            .status
            .code(),
        Some(2)
    );
}

#[tokio::test]
async fn health_is_zero_for_a_running_node_and_one_otherwise() {
    let data = tempfile::tempdir().unwrap();
    let node = start(Options {
        data: data.path().to_path_buf(),
        quic: "127.0.0.1:0".parse().unwrap(),
        http: "127.0.0.1:0".parse().unwrap(),
        web: None,
        max_spaces: 10,
        max_space_mb: 16,
        max_conns: 256,
        relay: false,
        admin_http: None,
    })
    .await
    .unwrap();
    let addr = node.http_addr.to_string();
    let up = tokio::task::spawn_blocking(move || run(&["health", "--http", &addr]).status.code())
        .await
        .unwrap();
    assert_eq!(up, Some(0));
    node.shutdown().await.unwrap();

    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .to_string();
    let down =
        tokio::task::spawn_blocking(move || run(&["health", "--http", &closed]).status.code())
            .await
            .unwrap();
    assert_eq!(down, Some(1));
}

/// Raw HTTP GET; returns the whole response as text.
fn get(addr: &str, path: &str) -> String {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).unwrap();
    out
}

#[tokio::test]
async fn web_files_are_served_with_index_as_the_fallback() {
    let data = tempfile::tempdir().unwrap();
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<p>aplikacja</p>").unwrap();
    std::fs::write(web.path().join("app.js"), "console.log(1)").unwrap();
    let node = start(Options {
        data: data.path().to_path_buf(),
        quic: "127.0.0.1:0".parse().unwrap(),
        http: "127.0.0.1:0".parse().unwrap(),
        web: Some(web.path().to_path_buf()),
        max_spaces: 10,
        max_space_mb: 16,
        max_conns: 256,
        relay: false,
        admin_http: None,
    })
    .await
    .unwrap();
    let addr = node.http_addr.to_string();
    let (a1, a2, a3) = tokio::task::spawn_blocking(move || {
        (
            get(&addr, "/app.js"),
            get(&addr, "/notatka/123"),
            get(&addr, "/health"),
        )
    })
    .await
    .unwrap();
    assert!(a1.contains("console.log(1)"), "{a1}");
    assert!(
        a2.starts_with("HTTP/1.1 200") && a2.contains("aplikacja"),
        "{a2}"
    );
    assert!(a3.ends_with("ok"), "{a3}");
    node.shutdown().await.unwrap();
}

#[test]
fn a_stranger_with_no_log_gets_only_a_reject_from_the_node() {
    use notes_sync::device::DeviceKeys;
    use notes_sync::net::DeviceIdentity;
    use notes_sync::proto::Frame;
    use notes_sync::session::{Local, Session, SyncStore};

    let (data, a) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let owner = Team::new(a.path()).into_stores().pop().unwrap();
    // the node stores this space: the owner's log, as its first registration brought it
    let db = open_db(&data.path().join("node.db")).unwrap();
    let mut node = NodeStore::fresh(db, owner.opened.acl.space, 1 << 30);
    let (log, certs) = notes_sync::space::read_acl(a.path()).unwrap();
    let entries: Vec<Vec<u8>> = log.iter().map(|e| e.to_bytes()).collect();
    let cert_bytes: Vec<Vec<u8>> = certs.iter().map(|c| c.to_bytes().to_vec()).collect();
    assert!(node.import_acl(&entries, &cert_bytes).unwrap());

    // a device of another account, presenting the space, claims no log at all
    let (_, outsider) = account();
    let keys = DeviceKeys::generate().unwrap();
    let identity = DeviceIdentity::new(&keys, DeviceCert::issue(&outsider, &keys, NOW));
    let (_, hello) = Session::new(identity.local(None, None), [7; 32], &owner);
    let hello = without_head(hello);

    // the node answers with a Reject and nothing else: no log, no Have
    let (mut node_side, _) = Session::new(Local::Node { token_ok: false }, [7; 32], &node);
    let step = node_side.on_frame(hello, &mut node).unwrap();
    assert!(step.close.is_some());
    assert!(
        matches!(step.send.as_slice(), [Frame::Reject(_)]),
        "{:?}",
        step.send
    );
}

/// The same Hello with no log head.
fn without_head(hello: Frame) -> Frame {
    let Frame::Hello {
        protocol,
        space,
        proof,
        token,
        ..
    } = hello
    else {
        panic!("not a Hello");
    };
    Frame::Hello {
        protocol,
        space,
        proof,
        acl_head: None,
        token,
    }
}

/// A crash can leave `node.key.tmp` behind with the wrong mode; the next write must still make a 0600 key.
#[cfg(unix)]
#[test]
fn a_leftover_temp_file_does_not_leave_a_loose_key() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let tmp = dir.path().join("node.key.tmp");
    std::fs::write(&tmp, b"stale").unwrap();
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();
    let first = notes_node::keys::init(dir.path()).unwrap();
    let key = dir.path().join("node.key");
    assert_eq!(
        std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!tmp.exists());
    // idempotent: the same keys again
    let again = notes_node::keys::init(dir.path()).unwrap();
    assert_eq!(*first.secret, *again.secret);
}
