use super::*;

use crate::access::{Access, Header, Key};
use crate::space::db_path;
use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

const SPACE_ID: [u8; 16] = [7; 16];
const KEY: [u8; 32] = [9; 32];

/// Accepts every message and holds one epoch-0 key.
struct AcceptAll;

impl Access for AcceptAll {
    fn current(&self) -> Option<(u32, Key)> {
        Some((0, Zeroizing::new(KEY)))
    }
    fn key(&self, epoch: u32) -> Option<Key> {
        (epoch == 0).then(|| Zeroizing::new(KEY))
    }
    fn accept(&self, _: &Header, _: &[u8; 32]) -> std::result::Result<(), String> {
        Ok(())
    }
}

/// A space with four messages from one device (seq 1..=4).
fn four_messages(root: &std::path::Path) -> (Space, [u8; 32]) {
    let device = SigningKey::from_bytes(&[1; 32]);
    let me = device.verifying_key().to_bytes();
    let mut sp = Space::create(root, SPACE_ID, device, Box::new(AcceptAll)).unwrap();
    let id = sp.create_note("n.md").unwrap();
    for i in 0..3 {
        sp.insert_text(&id, i, "a").unwrap();
    }
    assert_eq!(sp.messages().unwrap().len(), 4);
    (sp, me)
}

#[test]
fn version_vector_stops_at_a_gap() {
    let dir = tempfile::tempdir().unwrap();
    let (sp, me) = four_messages(dir.path());
    assert_eq!(sp.version_vector().unwrap(), vec![(me, 4)]);

    // remove seq 3 behind the API: seq 4 is stored but not contiguous
    let db = rusqlite::Connection::open(db_path(dir.path())).unwrap();
    db.execute("DELETE FROM messages WHERE seq = 3", [])
        .unwrap();
    assert_eq!(sp.version_vector().unwrap(), vec![(me, 2)]);
}

#[test]
fn messages_after_respects_the_vector_and_the_byte_limit() {
    let dir = tempfile::tempdir().unwrap();
    let (sp, me) = four_messages(dir.path());
    let all = sp.messages().unwrap();

    assert_eq!(sp.messages_after(&[], usize::MAX).unwrap(), all);
    assert_eq!(sp.messages_after(&[(me, 2)], usize::MAX).unwrap(), all[2..]);
    assert_eq!(
        sp.messages_after(&[(me, 4)], usize::MAX).unwrap(),
        Vec::<Vec<u8>>::new()
    );
    // a limit of zero still yields one message
    assert_eq!(sp.messages_after(&[], 0).unwrap(), all[..1]);
    let two = all[0].len() + all[1].len();
    assert_eq!(sp.messages_after(&[], two - 1).unwrap(), all[..2]);
}
