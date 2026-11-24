//! Transport tests on localhost with relays off and direct addresses.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use iroh::{Endpoint, EndpointAddr};

use super::*;
use crate::acl::Role;
use crate::cert::DeviceCert;
use crate::device::DeviceKeys;
use crate::session::Session;
use crate::space::device_keys;
use crate::space_store::DeviceStore;
use crate::test_util::{NOW, account, newest_by, team};
use crate::ticket::NodeTicket;

const WAIT: Duration = Duration::from_secs(5);

struct Dev {
    hub: Arc<Hub<DeviceStore>>,
    endpoint: Endpoint,
    identity: DeviceIdentity,
}

async fn device(store: DeviceStore) -> Dev {
    let keys = device_keys(&*store.ks).unwrap();
    let identity = DeviceIdentity::new(&keys, store.opened.cert);
    let endpoint = bind(identity.transport_secret(), None, false, false)
        .await
        .unwrap();
    Dev {
        hub: Hub::new(store),
        endpoint,
        identity,
    }
}

/// The endpoint reached over its IPv4 sockets on localhost.
fn loopback(endpoint: &Endpoint) -> EndpointAddr {
    endpoint
        .bound_sockets()
        .into_iter()
        .filter(SocketAddr::is_ipv4)
        .fold(EndpointAddr::new(endpoint.id()), |addr, sock| {
            addr.with_ip_addr(SocketAddr::from(([127, 0, 0, 1], sock.port())))
        })
}

fn ticket_of(endpoint: &Endpoint) -> NodeTicket {
    NodeTicket {
        node: *endpoint.id().as_bytes(),
        addrs: endpoint
            .bound_sockets()
            .into_iter()
            .filter(SocketAddr::is_ipv4)
            .map(|s| SocketAddr::from(([127, 0, 0, 1], s.port())))
            .collect(),
        token: [0; 32],
    }
}

/// Writes `text` at the start of note `id` on `dev` and publishes the new message.
fn edit(dev: &Dev, id: &str, text: &str) {
    let msg = {
        let mut st = dev.hub.store();
        st.opened.space.insert_text(id, 0, text).unwrap();
        newest_by(&st.opened.space, st.opened.cert.device)
    };
    dev.hub.publish(msg);
}

fn text_on(dev: &Dev, id: &str) -> String {
    dev.hub.store().opened.space.text(id).unwrap()
}

/// Polls until `done` holds or the wait runs out.
async fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::time::Instant::now() < deadline {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    done()
}

#[tokio::test]
async fn two_devices_sync_and_a_live_edit_arrives() {
    let dirs: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let roots: Vec<&std::path::Path> = dirs.iter().map(|d| d.path()).collect();
    let mut stores = team(&roots, &[Role::Editor]);
    let b_store = stores.pop().unwrap();
    let a_store = stores.pop().unwrap();
    let (a, b) = (device(a_store).await, device(b_store).await);

    let id = {
        let mut st = a.hub.store();
        let id = st.opened.space.create_note("n.md").unwrap();
        st.opened
            .space
            .insert_text(&id, 0, "od właściciela")
            .unwrap();
        id
    };
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(a.hub.clone(), a.identity.clone()));
    tokio::spawn(accept_loop(a.endpoint.clone(), router, 256));

    let _session = connect(
        &b.endpoint,
        loopback(&a.endpoint),
        b.hub.clone(),
        b.identity.local(None, None),
    )
    .await
    .unwrap();
    assert!(
        wait_until(|| b
            .hub
            .store()
            .opened
            .space
            .notes()
            .iter()
            .any(|(n, _)| *n == id)
            && text_on(&b, &id) == "od właściciela")
        .await
    );

    edit(&a, &id, "na żywo ");
    assert!(wait_until(|| text_on(&b, &id) == "na żywo od właściciela").await);
    assert_eq!(text_on(&a, &id), "na żywo od właściciela");
}

#[tokio::test]
async fn sync_once_returns_when_the_peer_has_all_our_messages() {
    let dirs: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let roots: Vec<&std::path::Path> = dirs.iter().map(|d| d.path()).collect();
    let mut stores = team(&roots, &[Role::Editor]);
    let b_store = stores.pop().unwrap();
    let a_store = stores.pop().unwrap();
    let (a, b) = (device(a_store).await, device(b_store).await);
    let id = {
        let mut st = a.hub.store();
        let id = st.opened.space.create_note("n.md").unwrap();
        st.opened.space.insert_text(&id, 0, "A").unwrap();
        id
    };
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(a.hub.clone(), a.identity.clone()));
    tokio::spawn(accept_loop(a.endpoint.clone(), router, 256));

    // B edits while nothing is connected; the next sync brings it to A
    let ticket = ticket_of(&a.endpoint);
    let pulled = sync_once(
        &b.endpoint,
        &ticket,
        b.hub.clone(),
        b.identity.local(Some(ticket.node), Some(ticket.token)),
        WAIT,
    )
    .await;
    pulled.unwrap();
    assert_eq!(text_on(&b, &id), "A");
    edit(&b, &id, "B ");
    sync_once(
        &b.endpoint,
        &ticket,
        b.hub.clone(),
        b.identity.local(Some(ticket.node), Some(ticket.token)),
        WAIT,
    )
    .await
    .unwrap();
    assert_eq!(text_on(&a, &id), "B A");
}

#[tokio::test]
async fn stranger_endpoint_is_refused() {
    let dirs: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let roots: Vec<&std::path::Path> = dirs.iter().map(|d| d.path()).collect();
    let mut stores = team(&roots, &[Role::Editor]);
    let b_store = stores.pop().unwrap();
    let a_store = stores.pop().unwrap();
    let a = device(a_store).await;
    let id = {
        let mut st = a.hub.store();
        let id = st.opened.space.create_note("n.md").unwrap();
        st.opened.space.insert_text(&id, 0, "tylko A").unwrap();
        id
    };
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(a.hub.clone(), a.identity.clone()));
    tokio::spawn(accept_loop(a.endpoint.clone(), router, 256));

    // a device of another account, presenting this space
    let (_, outsider) = account();
    let keys = DeviceKeys::generate().unwrap();
    let identity = DeviceIdentity::new(&keys, DeviceCert::issue(&outsider, &keys, NOW));
    // the stranger's endpoint must use the transport key its identity signs, or the bind check fails first
    let endpoint = bind(identity.transport_secret(), None, false, false)
        .await
        .unwrap();
    let stranger_hub = Hub::new(b_store);
    let ticket = ticket_of(&a.endpoint);
    let refused = sync_once(
        &endpoint,
        &ticket,
        stranger_hub,
        identity.local(Some(ticket.node), None),
        WAIT,
    )
    .await;
    assert!(
        matches!(refused, Err(Error::Transport(ref r)) if r.contains("brak dostępu")),
        "{refused:?}"
    );
    assert_eq!(text_on(&a, &id), "tylko A");
}

/// Needs LAN multicast, so it is not run by default: `cargo test -p notes-sync --all-features -- --ignored`.
#[tokio::test]
#[ignore]
async fn devices_find_each_other_on_the_lan_by_id() {
    let dirs: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let roots: Vec<&std::path::Path> = dirs.iter().map(|d| d.path()).collect();
    let mut stores = team(&roots, &[Role::Editor]);
    let b_store = stores.pop().unwrap();
    let a_store = stores.pop().unwrap();
    let keys_a = device_keys(&*a_store.ks).unwrap();
    let a_id = DeviceIdentity::new(&keys_a, a_store.opened.cert);
    let a_ep = bind(a_id.transport_secret(), None, false, true)
        .await
        .unwrap();
    let a_hub = Hub::new(a_store);
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(a_hub.clone(), a_id.clone()));
    tokio::spawn(accept_loop(a_ep.clone(), router, 256));

    let b_keys = device_keys(&*b_store.ks).unwrap();
    let b_id = DeviceIdentity::new(&b_keys, b_store.opened.cert);
    let b_ep = bind(b_id.transport_secret(), None, false, true)
        .await
        .unwrap();
    let b_hub = Hub::new(b_store);
    let bare = EndpointAddr::new(a_ep.id());
    let mut found = false;
    for _ in 0..50 {
        if connect(&b_ep, bare.clone(), b_hub.clone(), b_id.local(None, None))
            .await
            .is_ok()
        {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(found);
}

#[tokio::test]
async fn a_store_poisoned_by_a_panic_is_rebuilt_before_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let owner = crate::test_util::team(&[dir.path()], &[]).pop().unwrap();
    let hub = Hub::new(owner);
    let id = {
        let mut st = hub.store();
        let id = st.opened.space.create_note("n.md").unwrap();
        st.opened.space.insert_text(&id, 0, "przed paniką").unwrap();
        id
    };
    // a panic while the store is locked poisons the lock
    let other = hub.clone();
    let panicked = std::thread::spawn(move || {
        let _guard = other.store();
        panic!("simulated panic inside a session");
    })
    .join();
    assert!(panicked.is_err());
    // the next use gets a rebuilt store, and the text is the one the log holds
    assert_eq!(hub.store().opened.space.text(&id).unwrap(), "przed paniką");
}

/// Writes one frame the way the wire does: `u32 LE length ‖ bytes`.
async fn send_frame(send: &mut iroh::endpoint::SendStream, frame: &crate::proto::Frame) {
    let bytes = frame.to_bytes();
    send.write_all(&(bytes.len() as u32).to_le_bytes())
        .await
        .unwrap();
    send.write_all(&bytes).await.unwrap();
}

#[tokio::test]
async fn a_peer_that_sends_a_hello_and_goes_silent_is_dropped() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut stores = crate::test_util::team(&[a.path(), b.path()], &[Role::Editor]);
    let editor = stores.pop().unwrap();
    let owner = device(stores.pop().unwrap()).await;
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(owner.hub.clone(), owner.identity.clone()));
    tokio::spawn(accept_loop(owner.endpoint.clone(), router, 256));

    // the editor's Hello, then nothing: the owner waits for a Have that never comes
    let identity = DeviceIdentity::new(&device_keys(&*editor.ks).unwrap(), editor.opened.cert);
    let client = bind(identity.transport_secret(), None, false, false)
        .await
        .unwrap();
    let (_, hello) = Session::new(
        identity.local(None, None),
        *owner.endpoint.id().as_bytes(),
        &editor,
    );
    let conn = client
        .connect(loopback(&owner.endpoint), ALPN)
        .await
        .unwrap();
    let (mut send, _recv) = conn.open_bi().await.unwrap();
    send_frame(&mut send, &hello).await;
    let closed = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
    assert!(closed.is_ok(), "the silent peer was not dropped");
}

#[tokio::test]
async fn a_fifth_connection_from_one_endpoint_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let owner = device(crate::test_util::team(&[dir.path()], &[]).pop().unwrap()).await;
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(owner.hub.clone(), owner.identity.clone()));
    tokio::spawn(accept_loop(owner.endpoint.clone(), router, 256));

    let client = bind([9; 32], None, false, false).await.unwrap();
    let target = loopback(&owner.endpoint);
    // four connections that open a stream and stay quiet hold their slots
    let mut held = Vec::new();
    for _ in 0..4 {
        let conn = client.connect(target.clone(), ALPN).await.unwrap();
        let (mut send, _recv) = conn.open_bi().await.unwrap();
        send.write_all(&[0]).await.unwrap();
        held.push((conn, send));
    }
    let fifth = client.connect(target, ALPN).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(1), fifth.closed()).await;
    assert!(closed.is_ok(), "the fifth connection was kept");
    assert!(held.iter().all(|(c, _)| c.close_reason().is_none()));
}

#[tokio::test]
async fn a_first_frame_above_the_hello_size_closes_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let owner = device(crate::test_util::team(&[dir.path()], &[]).pop().unwrap()).await;
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(owner.hub.clone(), owner.identity.clone()));
    tokio::spawn(accept_loop(owner.endpoint.clone(), router, 256));
    let client = bind([8; 32], None, false, false).await.unwrap();
    let conn = client
        .connect(loopback(&owner.endpoint), ALPN)
        .await
        .unwrap();
    let (mut send, _recv) = conn.open_bi().await.unwrap();
    // a length claiming 1 MiB: far above a Hello, so the server refuses before reading any of it
    send.write_all(&(1024u32 * 1024).to_le_bytes())
        .await
        .unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(3), conn.closed()).await;
    assert!(closed.is_ok(), "an oversized first frame was kept");
}

#[tokio::test]
async fn a_connection_that_never_sends_a_hello_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    let owner = device(crate::test_util::team(&[dir.path()], &[]).pop().unwrap()).await;
    let router: Arc<dyn Router<DeviceStore>> =
        Arc::new(SingleHub::new(owner.hub.clone(), owner.identity.clone()));
    tokio::spawn(accept_loop(owner.endpoint.clone(), router, 256));
    let client = bind([7; 32], None, false, false).await.unwrap();
    let conn = client
        .connect(loopback(&owner.endpoint), ALPN)
        .await
        .unwrap();
    let (mut send, _recv) = conn.open_bi().await.unwrap();
    send.write_all(&[0]).await.unwrap();
    // FIRST_FRAME_WAIT is two seconds in tests
    let closed = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
    assert!(closed.is_ok(), "a connection with no Hello was kept");
}
