//! Which space a peer gets on the node (SIEC.md, ARCHITEKTURA §4.8). A known space is served to any
//! peer that passes the session rules. An unknown space is created only for a peer that presents the
//! node token, and only while the node is below its space limit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use notes_sync::Result;
use notes_sync::net::{Hub, Router};
use notes_sync::proto::{Frame, PeerProof};
use notes_sync::session::{Local, SyncStore};

use crate::store::{Db, NodeStore};

/// One space in the registry. `persisted` is read here, so routing never waits for a session.
struct Entry {
    hub: Arc<Hub<NodeStore>>,
    persisted: Arc<AtomicBool>,
}

pub struct NodeRouter {
    db: Db,
    token: [u8; 32],
    max_spaces: usize,
    max_space_bytes: u64,
    /// Every space the node holds, plus spaces whose first log is still on its way.
    spaces: Mutex<HashMap<[u8; 16], Entry>>,
}

impl NodeRouter {
    pub fn open(db: Db, token: [u8; 32], max_spaces: usize, max_space_bytes: u64) -> Result<Self> {
        let spaces = NodeStore::load_all(&db, max_space_bytes)?
            .into_iter()
            .map(|store| {
                let entry = Entry {
                    persisted: store.persisted_flag(),
                    hub: Hub::new(store),
                };
                let space = entry.hub.store().space();
                (space, entry)
            })
            .collect();
        Ok(Self {
            db,
            token,
            max_spaces,
            max_space_bytes,
            spaces: Mutex::new(spaces),
        })
    }

    /// Number of spaces stored, plus unfinished ones being registered.
    pub fn space_count(&self) -> usize {
        self.registry().len()
    }

    fn registry(&self) -> std::sync::MutexGuard<'_, HashMap<[u8; 16], Entry>> {
        self.spaces.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Compares every byte, so the time taken does not show how much of the token matched.
fn same_token(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Router<NodeStore> for NodeRouter {
    fn route(&self, hello: &Frame, _remote: [u8; 32]) -> Option<(Arc<Hub<NodeStore>>, Local)> {
        let Frame::Hello {
            space,
            proof,
            token,
            ..
        } = hello
        else {
            return None;
        };
        // nodes never talk to nodes
        if matches!(proof, PeerProof::Node) {
            return None;
        }
        let token_ok = token.is_some_and(|t| same_token(&t, &self.token));
        let mut spaces = self.registry();
        // a space no session uses and that the node does not store yet leaves nothing behind
        spaces.retain(|_, e| Arc::strong_count(&e.hub) > 1 || e.persisted.load(Ordering::SeqCst));
        if let Some(entry) = spaces.get(space) {
            // a stored space never accepts the token; only the registration in flight does
            let token_ok = token_ok && !entry.persisted.load(Ordering::SeqCst);
            return Some((entry.hub.clone(), Local::Node { token_ok }));
        }
        if !token_ok || spaces.len() >= self.max_spaces {
            return None;
        }
        let store = NodeStore::fresh(self.db.clone(), *space, self.max_space_bytes);
        let entry = Entry {
            persisted: store.persisted_flag(),
            hub: Hub::new(store),
        };
        let hub = entry.hub.clone();
        spaces.insert(*space, entry);
        Some((hub, Local::Node { token_ok: true }))
    }
}
