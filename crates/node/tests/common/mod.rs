//! Shared helpers for the node tests: spaces built from the public sync API, devices, and polling.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use iroh::{Endpoint, EndpointAddr, EndpointId};
use notes_core::access::{Access, Header, Key};
use notes_sync::acl::Role;
use notes_sync::cert::DeviceCert;
use notes_sync::device::DeviceKeys;
use notes_sync::identity::{RecoveryPhrase, UserKeys};
use notes_sync::invite::{JoinCommit, PendingInvites, Ticket};
use notes_sync::keystore::{MemoryKeyStore, Slot};
use notes_sync::net::{DeviceIdentity, Hub, bind};
use notes_sync::space::{Opened, create_space, device_cert, join_space, read_acl};
use notes_sync::space_owner::approve_join;
use notes_sync::space_store::DeviceStore;
use notes_sync::ticket::NodeTicket;

pub const NOW: u64 = 1_800_000_000;
pub const WAIT: Duration = Duration::from_secs(10);

/// Accepts every message and holds one epoch-0 key: a device that ignores the rules.
pub struct Permissive(pub [u8; 32]);

impl Access for Permissive {
    fn current(&self) -> Option<(u32, Key)> {
        Some((0, Key::new(self.0)))
    }
    fn key(&self, epoch: u32) -> Option<Key> {
        (epoch == 0).then(|| Key::new(self.0))
    }
    fn accept(&self, _: &Header, _: &[u8; 32]) -> Result<(), String> {
        Ok(())
    }
}

pub fn account() -> (RecoveryPhrase, UserKeys) {
    let phrase = RecoveryPhrase::generate().unwrap();
    let keys = UserKeys::from_phrase(&phrase).unwrap();
    (phrase, keys)
}

/// Owner and invited devices of one space. The owner keeps its keys in a `MemoryKeyStore` while
/// inviting; `into_stores` hands them out as device stores, owner first.
pub struct Team {
    owner: Opened,
    ks_owner: MemoryKeyStore,
    invites: PendingInvites,
    owner_root: PathBuf,
    joined: Vec<DeviceStore>,
}

impl Team {
    pub fn new(owner_root: &Path) -> Team {
        let mut ks = MemoryKeyStore::default();
        let (_, user) = account();
        let owner = create_space(owner_root, user, &mut ks, NOW).unwrap();
        Team {
            owner,
            ks_owner: ks,
            invites: PendingInvites::default(),
            owner_root: owner_root.to_path_buf(),
            joined: Vec::new(),
        }
    }

    /// Invites a new device of a fresh account, joining at `root`.
    pub fn invite(mut self, root: &Path, role: Role) -> Self {
        let mut ks = MemoryKeyStore::default();
        let (_, joiner) = account();
        let public = joiner.public();
        let ticket = Ticket::new(self.owner.acl.space, self.owner.acl.owner, NOW + 600).unwrap();
        self.invites.issue(ticket.clone(), NOW);
        let cert = device_cert(&mut ks, &joiner, NOW).unwrap();
        let (commit, state) = JoinCommit::create(&ticket, &public, &cert).unwrap();
        let challenge = self.invites.receive_commit(&commit, NOW).unwrap();
        let (reveal, code) = state.reveal(&challenge);
        approve_join(
            &mut self.owner,
            &mut self.ks_owner,
            &mut self.invites,
            &reveal,
            role,
            NOW,
            &code,
        )
        .unwrap();
        let (entries, certs) = read_acl(&self.owner_root).unwrap();
        let joined = join_space(root, &mut ks, &ticket, entries, certs).unwrap();
        self.joined.push(DeviceStore {
            opened: joined,
            ks: Box::new(ks),
        });
        self
    }

    pub fn into_stores(self) -> Vec<DeviceStore> {
        let mut stores = vec![DeviceStore {
            opened: self.owner,
            ks: Box::new(self.ks_owner),
        }];
        stores.extend(self.joined);
        stores
    }
}

/// A device: its store in a hub, its endpoint, and its identity.
pub struct Device {
    pub hub: Arc<Hub<DeviceStore>>,
    pub endpoint: Endpoint,
    pub identity: DeviceIdentity,
}

pub fn device_keys(store: &DeviceStore) -> DeviceKeys {
    let sign: [u8; 32] = store.ks.get(Slot::DeviceSign).unwrap().unwrap()[..]
        .try_into()
        .unwrap();
    let boxk: [u8; 32] = store.ks.get(Slot::DeviceBox).unwrap().unwrap()[..]
        .try_into()
        .unwrap();
    DeviceKeys::from_seeds(&sign, &boxk)
}

pub async fn device(store: DeviceStore) -> Device {
    let identity = DeviceIdentity::new(&device_keys(&store), store.opened.cert);
    let endpoint = bind(identity.transport_secret(), None, false, false)
        .await
        .unwrap();
    Device {
        hub: Hub::new(store),
        endpoint,
        identity,
    }
}

/// The epoch-0 key of a space, as the owner's key store holds it.
pub fn epoch0(store: &DeviceStore) -> [u8; 32] {
    let space = store.opened.acl.space;
    store
        .ks
        .get(Slot::EpochKey { space, epoch: 0 })
        .unwrap()
        .unwrap()[..]
        .try_into()
        .unwrap()
}

/// The node's address for a dial: its id plus the sockets from the ticket.
pub fn node_addr(ticket: &NodeTicket) -> EndpointAddr {
    ticket.addrs.iter().fold(
        EndpointAddr::new(EndpointId::from_bytes(&ticket.node).unwrap()),
        |addr, sock| addr.with_ip_addr(*sock),
    )
}

/// Runs `sync_once` for a device against a node ticket.
pub async fn sync(dev: &Device, ticket: &NodeTicket) -> notes_sync::Result<()> {
    let local = dev.identity.local(Some(ticket.node), Some(ticket.token));
    notes_sync::net::sync_once(&dev.endpoint, ticket, dev.hub.clone(), local, WAIT).await
}

/// Polls until `done` holds or the wait runs out.
pub async fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::time::Instant::now() < deadline {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    done()
}

pub fn text_of(dev: &Device, id: &str) -> String {
    dev.hub.store().opened.space.text(id).unwrap()
}

/// Writes `text` at the start of note `id` and publishes the new message to the device's links.
pub fn edit(dev: &Device, id: &str, text: &str) {
    let msg = {
        let mut st = dev.hub.store();
        st.opened.space.insert_text(id, 0, text).unwrap();
        newest_message(&st.opened.space, st.opened.cert.device)
    };
    dev.hub.publish(msg);
}

/// The newest message a device wrote, read from its stored messages.
pub fn newest_message(space: &notes_core::Space, device: [u8; 32]) -> Vec<u8> {
    space
        .messages()
        .unwrap()
        .into_iter()
        .filter(|m| m[17..49] == device)
        .max_by_key(|m| u64::from_le_bytes(m[49..57].try_into().unwrap()))
        .unwrap()
}

/// Rows of a table in the node's `node.db`.
pub fn rows(data: &Path, table: &str) -> i64 {
    let conn = rusqlite::Connection::open(data.join("node.db")).unwrap();
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// Rows of `messages` written by one device.
pub fn messages_by(data: &Path, device: [u8; 32]) -> i64 {
    let conn = rusqlite::Connection::open(data.join("node.db")).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE device = ?1",
        [&device[..]],
        |r| r.get(0),
    )
    .unwrap()
}

pub fn cert_of(store: &DeviceStore) -> DeviceCert {
    store.opened.cert
}
