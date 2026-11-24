//! The node end to end: devices sync through it over QUIC, it refuses what it must, and it survives a restart.

mod common;

use std::path::Path;

use common::*;
use notes_node::run::{Options, start};
use notes_sync::acl::Role;
use notes_sync::net::{bind, connect};

fn options(data: &Path, max_spaces: usize) -> Options {
    Options {
        data: data.to_path_buf(),
        quic: "127.0.0.1:0".parse().unwrap(),
        http: "127.0.0.1:0".parse().unwrap(),
        web: None,
        max_spaces,
        max_space_mb: 16,
        max_conns: 256,
        relay: false,
        admin_http: None,
    }
}

/// The owner writes a note and syncs it to the node; returns the note id.
async fn register(owner: &Device, ticket: &notes_sync::ticket::NodeTicket, text: &str) -> String {
    let id = {
        let mut st = owner.hub.store();
        let id = st.opened.space.create_note("n.md").unwrap();
        st.opened.space.insert_text(&id, 0, text).unwrap();
        id
    };
    sync(owner, ticket).await.unwrap();
    id
}

#[tokio::test]
async fn editor_gets_the_text_from_the_node_after_the_owner_left() {
    let (data, a, b) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let mut stores = Team::new(a.path())
        .invite(b.path(), Role::Editor)
        .into_stores();
    let editor = stores.pop().unwrap();
    let owner = device(stores.pop().unwrap()).await;
    let node = start(options(data.path(), 10)).await.unwrap();
    let ticket = node.ticket();

    let id = register(&owner, &ticket, "tajny tekst").await;
    assert!(rows(data.path(), "messages") > 0);
    assert_eq!(rows(data.path(), "spaces"), 1);
    owner.endpoint.close().await;

    let editor = device(editor).await;
    sync(&editor, &ticket).await.unwrap();
    assert_eq!(text_of(&editor, &id), "tajny tekst");
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn two_devices_write_live_through_the_node() {
    let (data, a, b) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let mut stores = Team::new(a.path())
        .invite(b.path(), Role::Editor)
        .into_stores();
    let editor = device(stores.pop().unwrap()).await;
    let owner = device(stores.pop().unwrap()).await;
    let node = start(options(data.path(), 10)).await.unwrap();
    let ticket = node.ticket();

    let id = register(&owner, &ticket, "start ").await;
    sync(&editor, &ticket).await.unwrap();
    let _owner_link = connect(
        &owner.endpoint,
        node_addr(&ticket),
        owner.hub.clone(),
        owner.identity.local(Some(ticket.node), Some(ticket.token)),
    )
    .await
    .unwrap();
    let _editor_link = connect(
        &editor.endpoint,
        node_addr(&ticket),
        editor.hub.clone(),
        editor.identity.local(Some(ticket.node), Some(ticket.token)),
    )
    .await
    .unwrap();

    edit(&owner, &id, "A ");
    assert!(wait_until(|| text_of(&editor, &id) == "A start ").await);
    edit(&editor, &id, "B ");
    assert!(wait_until(|| text_of(&owner, &id) == "B A start ").await);

    // the node holds every message both devices wrote, and nothing else
    let mine = owner.hub.store().opened.space.messages().unwrap().len() as i64;
    assert!(wait_until(|| rows(data.path(), "messages") == mine).await);
    assert_eq!(text_of(&editor, &id), text_of(&owner, &id));
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn node_refuses_a_reader_and_a_stranger() {
    let (data, a, b, c) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let mut stores = Team::new(a.path())
        .invite(b.path(), Role::Editor)
        .invite(c.path(), Role::Reader)
        .into_stores();
    let reader = device(stores.pop().unwrap()).await;
    let editor = stores.pop().unwrap();
    let owner = device(stores.pop().unwrap()).await;
    let node = start(options(data.path(), 10)).await.unwrap();
    let ticket = node.ticket();
    let id = register(&owner, &ticket, "tylko czytaj").await;
    let editor_dev = device(editor).await;
    sync(&editor_dev, &ticket).await.unwrap();

    // the reader device ignores the rules and writes with the epoch-0 key
    let reader_device = reader.hub.store().opened.cert.device;
    let key = epoch0(&owner.hub.store());
    reader
        .hub
        .store()
        .opened
        .space
        .set_access(Box::new(Permissive(key)));
    sync(&reader, &ticket).await.unwrap();
    let before = rows(data.path(), "messages");
    let _link = connect(
        &reader.endpoint,
        node_addr(&ticket),
        reader.hub.clone(),
        reader.identity.local(Some(ticket.node), Some(ticket.token)),
    )
    .await
    .unwrap();
    {
        let mut st = reader.hub.store();
        st.opened.space.insert_text(&id, 0, "czytelnik ").unwrap();
    }
    let msg = newest_message(&reader.hub.store().opened.space, reader_device);
    reader.hub.publish(msg.clone());
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(messages_by(data.path(), reader_device), 0);
    assert_eq!(rows(data.path(), "messages"), before);
    // the same message, put into the node's store directly, is refused by the rules
    let db = notes_node::store::open_db(&data.path().join("node.db")).unwrap();
    let mut stored = notes_node::store::NodeStore::load_all(&db, 1 << 30)
        .unwrap()
        .remove(0);
    let put = notes_sync::session::SyncStore::put(&mut stored, &msg).unwrap();
    assert!(
        matches!(put, notes_sync::session::Put::Rejected(ref r) if r.contains("cannot write")),
        "{put:?}"
    );

    // a device of another account, presenting this space's id, is refused at the Have
    let (_, outsider) = account();
    let keys = notes_sync::device::DeviceKeys::generate().unwrap();
    let cert = notes_sync::cert::DeviceCert::issue(&outsider, &keys, NOW);
    let identity = notes_sync::net::DeviceIdentity::new(&keys, cert);
    let endpoint = bind(identity.transport_secret(), None, false, false)
        .await
        .unwrap();
    let refused = notes_sync::net::sync_once(
        &endpoint,
        &ticket,
        reader.hub.clone(),
        identity.local(Some(ticket.node), Some(ticket.token)),
        WAIT,
    )
    .await;
    assert!(
        matches!(&refused, Err(notes_sync::Error::Transport(r)) if r.contains("brak dostępu")),
        "{refused:?}"
    );
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn unknown_space_needs_the_node_token() {
    let (data, a) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let owner = device(Team::new(a.path()).into_stores().pop().unwrap()).await;
    let node = start(options(data.path(), 10)).await.unwrap();
    let ticket = node.ticket();
    {
        let mut st = owner.hub.store();
        let id = st.opened.space.create_note("n.md").unwrap();
        st.opened.space.insert_text(&id, 0, "x").unwrap();
    }

    // no token at all, and a wrong one: the node registers nothing
    let no_token = owner.identity.local(Some(ticket.node), None);
    let refused =
        notes_sync::net::sync_once(&owner.endpoint, &ticket, owner.hub.clone(), no_token, WAIT)
            .await;
    assert!(
        matches!(&refused, Err(notes_sync::Error::Transport(r)) if r.contains("nieznana")),
        "{refused:?}"
    );
    let mut wrong = ticket.clone();
    wrong.token = [9; 32];
    let refused = sync(&owner, &wrong).await;
    assert!(
        matches!(&refused, Err(notes_sync::Error::Transport(r)) if r.contains("nieznana")),
        "{refused:?}"
    );
    assert_eq!(rows(data.path(), "spaces"), 0);
    assert_eq!(rows(data.path(), "messages"), 0);

    // the right token registers the space
    sync(&owner, &ticket).await.unwrap();
    assert_eq!(rows(data.path(), "spaces"), 1);
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn max_spaces_refuses_a_second_registration() {
    let (data, a, b) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let first = device(Team::new(a.path()).into_stores().pop().unwrap()).await;
    let second = device(Team::new(b.path()).into_stores().pop().unwrap()).await;
    let node = start(options(data.path(), 1)).await.unwrap();
    let ticket = node.ticket();
    sync(&first, &ticket).await.unwrap();
    let refused = sync(&second, &ticket).await;
    assert!(
        matches!(&refused, Err(notes_sync::Error::Transport(r)) if r.contains("nieznana")),
        "{refused:?}"
    );
    assert_eq!(rows(data.path(), "spaces"), 1);
    node.shutdown().await.unwrap();
}

#[tokio::test]
async fn node_db_holds_no_note_text_or_name() {
    let (data, a) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let owner = device(Team::new(a.path()).into_stores().pop().unwrap()).await;
    let node = start(options(data.path(), 10)).await.unwrap();
    let ticket = node.ticket();
    register(&owner, &ticket, "tajny tekst").await;
    node.shutdown().await.unwrap();

    // the database must exist and hold the messages, or the check below proves nothing
    assert!(rows(data.path(), "messages") > 0);
    let mut checked = 0;
    for name in ["node.db", "node.db-wal"] {
        let Ok(bytes) = std::fs::read(data.path().join(name)) else {
            continue;
        };
        checked += 1;
        for secret in [&b"tajny"[..], b"n.md"] {
            assert!(
                !bytes.windows(secret.len()).any(|w| w == secret),
                "{name} holds {secret:?}"
            );
        }
    }
    assert!(checked >= 1, "node.db was not found");
}

#[tokio::test]
async fn node_restart_keeps_spaces_messages_and_identity() {
    let (data, a, b) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let mut stores = Team::new(a.path())
        .invite(b.path(), Role::Editor)
        .into_stores();
    let editor = device(stores.pop().unwrap()).await;
    let owner = device(stores.pop().unwrap()).await;
    let node = start(options(data.path(), 10)).await.unwrap();
    let ticket = node.ticket();
    let id = register(&owner, &ticket, "przed restartem").await;
    let node_id = ticket.node;
    node.shutdown().await.unwrap();

    let node = start(options(data.path(), 10)).await.unwrap();
    let again = node.ticket();
    assert_eq!(again.node, node_id);
    assert_eq!(again.token, ticket.token);
    sync(&editor, &again).await.unwrap();
    assert_eq!(text_of(&editor, &id), "przed restartem");
    node.shutdown().await.unwrap();
}
