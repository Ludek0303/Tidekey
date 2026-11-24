//! One space on this device or node: its store, shared by all connections, and the broadcast that
//! carries new messages to the connections that did not receive them (the hub of ARCHITEKTURA §4.8).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::broadcast;

use super::DeviceIdentity;
use crate::proto::Frame;
use crate::session::{Local, SyncStore};

/// Origin of messages this device stored itself (`Hub::publish`): every connection gets them.
const LOCAL: u64 = u64::MAX;
const CAPACITY: usize = 1024;

pub struct Hub<S> {
    store: Mutex<S>,
    news: broadcast::Sender<(u64, Vec<u8>)>,
    next_conn: AtomicU64,
}

impl<S: SyncStore> Hub<S> {
    pub fn new(store: S) -> Arc<Self> {
        let (news, _) = broadcast::channel(CAPACITY);
        Arc::new(Hub {
            store: Mutex::new(store),
            news,
            next_conn: AtomicU64::new(0),
        })
    }

    /// The store, locked. Edits go through it; call `publish` after the lock is released.
    pub fn store(&self) -> MutexGuard<'_, S> {
        match self.store.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                // a panic inside a session left the store half-updated: rebuild it before anything reads it
                let mut guard = poisoned.into_inner();
                guard.recover();
                self.store.clear_poison();
                guard
            }
        }
    }

    /// Sends a message this device just stored (the bytes `Space` appended) to every connection.
    pub fn publish(&self, msg: Vec<u8>) {
        self.publish_from(LOCAL, msg);
    }

    pub(super) fn publish_from(&self, conn: u64, msg: Vec<u8>) {
        // no receiver means no open connection; the messages wait in the store for the next sync
        let _ = self.news.send((conn, msg));
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<(u64, Vec<u8>)> {
        self.news.subscribe()
    }

    pub(super) fn next_conn(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }
}

/// Decides, from a peer's first frame, which hub it joins and what role this side plays.
pub trait Router<S>: Send + Sync {
    fn route(&self, hello: &Frame, remote: [u8; 32]) -> Option<(Arc<Hub<S>>, Local)>;
}

/// A device serving a single space. Peers of another space are refused.
pub struct SingleHub<S> {
    hub: Arc<Hub<S>>,
    identity: DeviceIdentity,
}

impl<S> SingleHub<S> {
    pub fn new(hub: Arc<Hub<S>>, identity: DeviceIdentity) -> Self {
        Self { hub, identity }
    }
}

impl<S: SyncStore> Router<S> for SingleHub<S> {
    fn route(&self, hello: &Frame, _remote: [u8; 32]) -> Option<(Arc<Hub<S>>, Local)> {
        let Frame::Hello { space, .. } = hello else {
            return None;
        };
        if *space != self.hub.store().space() {
            return None;
        }
        Some((self.hub.clone(), self.identity.local(None, None)))
    }
}
