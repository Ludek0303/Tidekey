//! The `notes-sync/1` state machine for one connection (ARCHITEKTURA §4.8). Sans-IO: the driver feeds
//! frames in and sends what comes out, so the same code runs over QUIC, in tests and in the browser.

use crate::Result;
use crate::acl_state::{AclHead, AclState};
use crate::cert::{CertStore, DeviceCert};
use crate::device::DeviceKeys;
use crate::policy::peer_allowed;
use crate::proto::{Frame, PROTOCOL, PeerProof, VersionVector, bind_sig, verify_bind};

/// Largest batch of messages sent in one `Msgs` frame.
const MAX_BATCH: usize = 1 << 20;

/// What the store did with one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Put {
    /// Stored and applied; the driver forwards it to the other connections.
    New,
    Known,
    Rejected(String),
}

/// Encoded participants log entries and device certificates.
pub type AclBytes = (Vec<Vec<u8>>, Vec<Vec<u8>>);

/// The space as this side of a connection sees it. `DeviceStore` for a device, `NodeStore` for a node.
pub trait SyncStore: Send {
    fn space(&self) -> [u8; 16];
    fn acl_head(&self) -> Option<AclHead>;
    /// Encoded log entries (index order) and device certificates.
    fn acl(&self) -> Result<AclBytes>;
    /// Stores a log that is longer than the known one (true). A log that brings nothing new is ignored
    /// (false); one that forks at the known head is an error.
    fn import_acl(&mut self, entries: &[Vec<u8>], certs: &[Vec<u8>]) -> Result<bool>;
    /// `None` only on a node that has no log yet.
    fn acl_state(&self) -> Option<&AclState>;
    fn certs(&self) -> &CertStore;
    fn version_vector(&self) -> Result<VersionVector>;
    fn after(&self, vv: &VersionVector, max_bytes: usize) -> Result<Vec<Vec<u8>>>;
    fn put(&mut self, msg: &[u8]) -> Result<Put>;
    /// `put` for a whole `Msgs` frame; a store can refresh its derived state once for all of them.
    fn put_batch(&mut self, msgs: &[Vec<u8>]) -> Result<Vec<Put>> {
        msgs.iter().map(|m| self.put(m)).collect()
    }
    /// Called by the hub when a panic poisoned the lock: rebuild whatever a half-done update left behind.
    fn recover(&mut self) {}
}

/// Who this side is on the connection.
// One session per connection; the size difference does not matter.
#[allow(clippy::large_enum_variant)]
pub enum Local {
    Device {
        keys: DeviceKeys,
        cert: DeviceCert,
        /// This device's transport key; the bind signature covers it.
        endpoint: [u8; 32],
        /// The storage node this device connects to, if the connection is to one.
        expected_node: Option<[u8; 32]>,
        /// The node ticket's token, sent only to `expected_node` so it can register a new space.
        token: Option<[u8; 32]>,
    },
    /// `token_ok`: the router matched the Hello token against the node token.
    Node { token_ok: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Peer {
    Device([u8; 32]),
    Node,
}

/// Result of one `on_frame` call: frames to send, messages to forward, and the reason to close.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub send: Vec<Frame>,
    pub new: Vec<Vec<u8>>,
    pub close: Option<String>,
}

pub struct Session {
    local: Local,
    remote: [u8; 32],
    space: [u8; 16],
    /// A node whose space had no log when the session started.
    fresh: bool,
    hello: bool,
    have_sent: bool,
    /// Haves received from the peer: its Hello one, and at most one more (a sync run asks again).
    haves: u8,
    peer: Option<Peer>,
    got_acl: bool,
    ready: bool,
    peer_synced: Option<VersionVector>,
    rejected: usize,
}

impl Session {
    /// `remote` is the transport public key of the peer. Returns the session and this side's `Hello`.
    pub fn new(local: Local, remote: [u8; 32], store: &dyn SyncStore) -> (Session, Frame) {
        let space = store.space();
        let (proof, token) = match &local {
            Local::Device {
                keys,
                cert,
                endpoint,
                expected_node,
                token,
            } => {
                let proof = PeerProof::Device {
                    cert: *cert,
                    bind: bind_sig(keys, space, *endpoint),
                };
                let token = token.filter(|_| *expected_node == Some(remote));
                (proof, token)
            }
            Local::Node { .. } => (PeerProof::Node, None),
        };
        let hello = Frame::Hello {
            protocol: PROTOCOL,
            space,
            proof,
            acl_head: store.acl_head(),
            token,
        };
        let fresh = matches!(local, Local::Node { .. }) && store.acl_state().is_none();
        let session = Session {
            local,
            remote,
            space,
            fresh,
            hello: false,
            have_sent: false,
            haves: 0,
            peer: None,
            got_acl: false,
            ready: false,
            peer_synced: None,
            rejected: 0,
        };
        (session, hello)
    }

    pub fn on_frame(&mut self, frame: Frame, store: &mut dyn SyncStore) -> Result<Step> {
        match frame {
            // a peer may refuse before its Hello arrives (an unknown space, say); keep its reason
            Frame::Reject(reason) => Ok(Step {
                send: vec![],
                new: vec![],
                close: Some(reason),
            }),
            Frame::Hello {
                protocol,
                space,
                proof,
                acl_head,
                ..
            } if !self.hello => self.on_hello(protocol, space, proof, acl_head, store),
            Frame::Hello { .. } => Ok(close("drugi Hello")),
            _ if !self.hello => Ok(close("ramka przed Hello")),
            Frame::Acl { entries, certs } => self.on_acl(&entries, &certs, store),
            Frame::Have(vv) => self.on_have(&vv, store),
            Frame::Msgs(msgs) => self.on_msgs(&msgs, store),
            Frame::Live(msg) => self.on_msgs(&[msg], store),
            Frame::Synced(vv) if self.ready => {
                self.peer_synced = Some(vv);
                Ok(Step::default())
            }
            Frame::Synced(_) => Ok(close("Synced przed Have")),
        }
    }

    /// A message to push to the peer; `None` until the handshake is done, and once the peer is no longer
    /// allowed. The driver closes a connection whose peer lost access (see `allowed`).
    pub fn live(&self, msg: &[u8], store: &dyn SyncStore) -> Option<Frame> {
        (self.ready && self.allowed(store)).then(|| Frame::Live(msg.to_vec()))
    }

    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn peer_device(&self) -> Option<[u8; 32]> {
        match self.peer {
            Some(Peer::Device(device)) => Some(device),
            _ => None,
        }
    }

    /// The last `Synced` the peer sent.
    pub fn peer_synced(&self) -> Option<&VersionVector> {
        self.peer_synced.as_ref()
    }

    /// Messages the store refused on this connection.
    pub fn rejected(&self) -> usize {
        self.rejected
    }

    fn on_hello(
        &mut self,
        protocol: u16,
        space: [u8; 16],
        proof: PeerProof,
        head: Option<AclHead>,
        store: &mut dyn SyncStore,
    ) -> Result<Step> {
        if protocol != PROTOCOL {
            return Ok(close(&format!(
                "zaktualizuj aplikację: protokół notes-sync/{PROTOCOL}"
            )));
        }
        if space != self.space {
            return Ok(close("inna przestrzeń"));
        }
        let peer = match (proof, &self.local) {
            (PeerProof::Device { cert, bind }, _) => {
                if cert.verify().is_err() || !verify_bind(&cert, space, self.remote, &bind) {
                    return Ok(close("podpis urządzenia nie zgadza się z połączeniem"));
                }
                Peer::Device(cert.device)
            }
            (
                PeerProof::Node,
                Local::Device {
                    expected_node: Some(node),
                    ..
                },
            ) if *node == self.remote => Peer::Node,
            (PeerProof::Node, _) => return Ok(close("nieoczekiwany węzeł")),
        };
        self.hello = true;
        self.peer = Some(peer);

        let ours = store.acl_head();
        match (ours, head) {
            (Some(a), Some(b)) if a.index == b.index && a.hash != b.hash => {
                return Ok(close("rozwidlenie rejestru uczestników"));
            }
            // the peer knows a longer log: nothing goes out before its Acl arrives and is checked
            (None, Some(_)) => return Ok(Step::default()),
            (Some(a), Some(b)) if b.index > a.index => return Ok(Step::default()),
            _ => {}
        }
        // the peer is no longer than us: its certificate must be ours to share (SZYFROWANIE §8a)
        if !self.allowed(store) {
            return Ok(close("brak dostępu do przestrzeni"));
        }
        let mut send = Vec::new();
        if ours.is_some_and(|a| head.is_none_or(|b| a.index > b.index)) {
            let (entries, certs) = store.acl()?;
            send.push(Frame::Acl { entries, certs });
        }
        send.push(Frame::Have(store.version_vector()?));
        self.have_sent = true;
        Ok(Step {
            send,
            new: vec![],
            close: None,
        })
    }

    fn on_acl(
        &mut self,
        entries: &[Vec<u8>],
        certs: &[Vec<u8>],
        store: &mut dyn SyncStore,
    ) -> Result<Step> {
        let imported = match store.import_acl(entries, certs) {
            Ok(imported) => imported,
            Err(e) => return Ok(close(&format!("rejestr uczestników: {e}"))),
        };
        self.got_acl |= imported;
        // checked against the log now in force, whether or not this Acl was new
        if !self.allowed(store) {
            self.ready = false;
            return Ok(close("brak dostępu do przestrzeni"));
        }
        let mut send = Vec::new();
        if !self.have_sent {
            // we waited for the peer's log, so our own Have goes out now
            send.push(Frame::Have(store.version_vector()?));
            self.have_sent = true;
        }
        Ok(Step {
            send,
            new: vec![],
            close: None,
        })
    }

    fn on_have(&mut self, vv: &VersionVector, store: &mut dyn SyncStore) -> Result<Step> {
        self.haves = self.haves.saturating_add(1);
        // each Have makes the peer build and send a backlog under the store lock: two per connection at most
        if self.haves > 2 {
            return Ok(close("za dużo wymian Have"));
        }
        if let Local::Node { token_ok } = self.local
            && self.fresh
            && !(token_ok && self.got_acl)
        {
            return Ok(close("nieznana przestrzeń"));
        }
        if !self.allowed(store) {
            return Ok(close("brak dostępu do przestrzeni"));
        }
        self.ready = true;

        // the store sends newest first, and its order can leave gaps, so the backlog is taken once, whole,
        // and cut into frames; a per-device threshold could not say which seqs were already sent
        // shortcut: the whole backlog for one Have is built in memory, upgrade with a streaming cursor when a space has more than ~100 MB of messages
        let mut send = Vec::new();
        let mut batch: Vec<Vec<u8>> = Vec::new();
        let mut size = 0;
        for m in store.after(vv, usize::MAX)? {
            if !batch.is_empty() && size + m.len() > MAX_BATCH {
                send.push(Frame::Msgs(std::mem::take(&mut batch)));
                size = 0;
            }
            size += m.len();
            batch.push(m);
        }
        if !batch.is_empty() {
            send.push(Frame::Msgs(batch));
        }
        send.push(Frame::Synced(store.version_vector()?));
        Ok(Step {
            send,
            new: vec![],
            close: None,
        })
    }

    fn on_msgs(&mut self, msgs: &[Vec<u8>], store: &mut dyn SyncStore) -> Result<Step> {
        if !self.ready {
            return Ok(close("wiadomości przed Have"));
        }
        // access may have been revoked since the last frame, even if no log arrived on this connection
        if !self.allowed(store) {
            return Ok(close("brak dostępu do przestrzeni"));
        }
        let mut new = Vec::new();
        for (m, put) in msgs.iter().zip(store.put_batch(msgs)?) {
            match put {
                Put::New => new.push(m.clone()),
                Put::Known => {}
                Put::Rejected(_) => self.rejected += 1,
            }
        }
        Ok(Step {
            send: vec![],
            new,
            close: None,
        })
    }

    /// Whether the peer may take part in this space, by the store's current rules.
    pub fn allowed(&self, store: &dyn SyncStore) -> bool {
        match self.peer {
            Some(Peer::Node) => true,
            Some(Peer::Device(device)) => store
                .acl_state()
                .is_some_and(|st| peer_allowed(st, store.certs(), &device)),
            None => false,
        }
    }
}

fn close(reason: &str) -> Step {
    Step {
        send: vec![Frame::Reject(reason.to_string())],
        new: vec![],
        close: Some(reason.to_string()),
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
