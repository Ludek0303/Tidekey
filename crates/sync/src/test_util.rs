//! Helpers shared by the sync tests: an owner space, invites, and message delivery between spaces.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

use notes_core::Space;
use notes_core::access::{Access, Header, Key};
use zeroize::Zeroizing;

use crate::acl::Role;
use crate::identity::{RecoveryPhrase, UserKeys};
use crate::invite::{JoinCommit, PendingInvites, Ticket};
use crate::keystore::MemoryKeyStore;
use crate::proto::Frame;
use crate::session::{Local, Session, Step};
use crate::space::device_keys;
use crate::space::{Opened, create_space, device_cert, join_space, read_acl};
use crate::space_owner::approve_join;
use crate::space_store::DeviceStore;

pub(crate) const NOW: u64 = 1_800_000_000;

/// Accepts everything and holds one epoch-0 key. Stands in for a device that ignores the rules.
pub(crate) struct Permissive(pub [u8; 32]);

impl Access for Permissive {
    fn current(&self) -> Option<(u32, Key)> {
        Some((0, Zeroizing::new(self.0)))
    }
    fn key(&self, epoch: u32) -> Option<Key> {
        (epoch == 0).then(|| Zeroizing::new(self.0))
    }
    fn accept(&self, _: &Header, _: &[u8; 32]) -> std::result::Result<(), String> {
        Ok(())
    }
}

pub(crate) fn account() -> (RecoveryPhrase, UserKeys) {
    let phrase = RecoveryPhrase::generate().unwrap();
    let keys = UserKeys::from_phrase(&phrase).unwrap();
    (phrase, keys)
}

/// A new space owned by a fresh account on this device.
pub(crate) fn owner_space(root: &Path) -> (Opened, MemoryKeyStore) {
    let mut ks = MemoryKeyStore::default();
    let (_, owner) = account();
    let opened = create_space(root, owner, &mut ks, NOW).unwrap();
    (opened, ks)
}

/// Full invite of a new device of a fresh account: commit, reveal, typed code, approval, join.
/// Returns the joined space, its key store and the phrase of the joining account.
pub(crate) fn invite(
    owner: &mut Opened,
    ks_o: &mut MemoryKeyStore,
    invites: &mut PendingInvites,
    root: &Path,
    role: Role,
) -> (Opened, MemoryKeyStore, RecoveryPhrase) {
    let mut ks = MemoryKeyStore::default();
    let (phrase, joiner) = account();
    let public = joiner.public();
    let ticket = Ticket::new(owner.acl.space, owner.acl.owner, NOW + 600).unwrap();
    invites.issue(ticket.clone(), NOW);
    let cert = device_cert(&mut ks, &joiner, NOW).unwrap();
    let (commit, state) = JoinCommit::create(&ticket, &public, &cert).unwrap();
    let challenge = invites.receive_commit(&commit, NOW).unwrap();
    let (reveal, code) = state.reveal(&challenge);
    assert_eq!(invites.check_reveal(&reveal, NOW).unwrap(), code);
    approve_join(owner, ks_o, invites, &reveal, role, NOW, &code).unwrap();
    let (entries, certs) = read_acl(&owner.root).unwrap();
    let joined = join_space(root, &mut ks, &ticket, entries, certs).unwrap();
    (joined, ks, phrase)
}

/// Hands every message of `from` to `to`, which must accept each one (applied or already known).
pub(crate) fn deliver(from: &Space, to: &mut Space) {
    for m in from.messages().unwrap() {
        to.receive(&m).unwrap();
    }
}

pub(crate) fn db_files(root: &Path) -> Vec<Vec<u8>> {
    let dir = root.join(".notes-sync");
    ["space.db", "space.db-wal"]
        .iter()
        .filter_map(|name| fs::read(dir.join(name)).ok())
        .collect()
}

pub(crate) fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

pub(crate) fn db_path(root: &Path) -> PathBuf {
    root.join(".notes-sync").join("space.db")
}

/// Sequence number and device of a stored message, read from its plain header.
pub(crate) fn seq_of(msg: &[u8]) -> u64 {
    u64::from_le_bytes(msg[49..57].try_into().unwrap())
}

/// The newest message a device wrote in this space.
pub(crate) fn newest_by(space: &Space, device: [u8; 32]) -> Vec<u8> {
    space
        .messages()
        .unwrap()
        .into_iter()
        .filter(|m| m[17..49] == device)
        .max_by_key(|m| seq_of(m))
        .unwrap()
}

/// This device's side of a connection, reached at transport key `endpoint`.
pub(crate) fn local_of(store: &DeviceStore, endpoint: [u8; 32]) -> Local {
    Local::Device {
        keys: device_keys(&*store.ks).unwrap(),
        cert: store.opened.cert,
        endpoint,
        expected_node: None,
        token: None,
    }
}

pub(crate) fn endpoint(device: usize) -> [u8; 32] {
    [device as u8 + 100; 32]
}

/// An owner (`roots[0]`) and one device per later root, each invited with the matching role, in order.
/// Later devices join a log that is already longer, so the earlier ones are behind.
pub(crate) fn team(roots: &[&Path], roles: &[Role]) -> Vec<DeviceStore> {
    let (mut owner, mut ks_o) = owner_space(roots[0]);
    let mut invites = PendingInvites::default();
    let mut joined = Vec::new();
    for (root, role) in roots[1..].iter().zip(roles) {
        let (opened, ks, _) = invite(&mut owner, &mut ks_o, &mut invites, root, *role);
        joined.push(DeviceStore {
            opened,
            ks: Box::new(ks),
        });
    }
    let mut stores = vec![DeviceStore {
        opened: owner,
        ks: Box::new(ks_o),
    }];
    stores.extend(joined);
    stores
}

/// Devices of one space, their stores, and the links between them. Each link has two ends; frames wait
/// in a FIFO per end, so they arrive in order. Messages a store takes are relayed as `Live` frames to the
/// device's other links, the way the hub does in the app.
pub(crate) struct Net {
    pub stores: Vec<DeviceStore>,
    pub links: Vec<Link>,
    /// Close reasons of sessions that refused something.
    pub failures: Vec<String>,
}

pub(crate) struct Link {
    pub dev: [usize; 2],
    pub sess: [Session; 2],
    pub inbox: [VecDeque<Frame>; 2],
    pub open: bool,
}

impl Net {
    pub fn new(stores: Vec<DeviceStore>) -> Net {
        Net {
            stores,
            links: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Opens a link between devices `a` and `b`; both Hello frames wait in the inboxes.
    pub fn connect(&mut self, a: usize, b: usize) -> usize {
        let (sa, ha) = Session::new(
            local_of(&self.stores[a], endpoint(a)),
            endpoint(b),
            &self.stores[a],
        );
        let (sb, hb) = Session::new(
            local_of(&self.stores[b], endpoint(b)),
            endpoint(a),
            &self.stores[b],
        );
        self.links.push(Link {
            dev: [a, b],
            sess: [sa, sb],
            inbox: [VecDeque::from([hb]), VecDeque::from([ha])],
            open: true,
        });
        self.links.len() - 1
    }

    pub fn open_between(&self, a: usize, b: usize) -> bool {
        self.links
            .iter()
            .any(|l| l.open && (l.dev == [a, b] || l.dev == [b, a]))
    }

    pub fn close(&mut self, l: usize) {
        let link = &mut self.links[l];
        link.open = false;
        link.inbox = [VecDeque::new(), VecDeque::new()];
    }

    /// Ends `(link, end)` with frames waiting.
    pub fn pending(&self) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        for (l, link) in self.links.iter().enumerate() {
            for e in 0..2 {
                if link.open && !link.inbox[e].is_empty() {
                    out.push((l, e));
                }
            }
        }
        out
    }

    /// Hands the next frame waiting for end `e` of link `l` to its session.
    pub fn deliver(&mut self, l: usize, e: usize) -> Option<Step> {
        let frame = self.links[l].inbox[e].pop_front()?;
        Some(self.feed(l, e, frame))
    }

    /// Hands `frame` to end `e` of link `l`, as if it came from the wire.
    pub fn feed(&mut self, l: usize, e: usize, frame: Frame) -> Step {
        let dev = self.links[l].dev[e];
        let step = self.links[l].sess[e]
            .on_frame(frame, &mut self.stores[dev])
            .unwrap();
        if let Some(reason) = &step.close {
            self.failures.push(reason.clone());
            self.close(l);
            return step;
        }
        self.links[l].inbox[1 - e].extend(step.send.iter().cloned());
        for msg in &step.new {
            self.relay(dev, l, msg);
        }
        step
    }

    /// Inserts text on device `d` and sends the new message to its links, as the hub does.
    pub fn edit(&mut self, d: usize, id: &str, at: u32, text: &str) {
        self.stores[d]
            .opened
            .space
            .insert_text(id, at, text)
            .unwrap();
        let own = self.stores[d].opened.cert.device;
        let msg = newest_by(&self.stores[d].opened.space, own);
        self.relay(d, usize::MAX, &msg);
    }

    /// Delivers pending frames until none are left.
    pub fn settle(&mut self) {
        while let Some(&(l, e)) = self.pending().first() {
            self.deliver(l, e);
        }
    }

    fn relay(&mut self, dev: usize, from: usize, msg: &[u8]) {
        for k in 0..self.links.len() {
            if k == from || !self.links[k].open {
                continue;
            }
            let Some(end) = self.links[k].dev.iter().position(|d| *d == dev) else {
                continue;
            };
            if let Some(frame) = self.links[k].sess[end].live(msg, &self.stores[dev]) {
                self.links[k].inbox[1 - end].push_back(frame);
            }
        }
    }

    /// Text of one note on every device, in device order.
    pub fn texts(&mut self, id: &str) -> Vec<String> {
        self.stores
            .iter_mut()
            .map(|s| s.opened.space.text(id).unwrap())
            .collect()
    }
}
