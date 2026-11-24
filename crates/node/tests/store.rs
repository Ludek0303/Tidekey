//! What the node keeps from an `Acl`: junk certificates never reach its disk, and a log that brings
//! nothing new is ignored.

mod common;

use common::*;
use notes_node::store::{NodeStore, open_db};
use notes_sync::acl::Role;
use notes_sync::cert::DeviceCert;
use notes_sync::device::DeviceKeys;
use notes_sync::session::SyncStore;
use notes_sync::space::read_acl;

#[test]
fn junk_certificates_are_not_kept_and_a_known_log_is_ignored() {
    let (data, a, b) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let mut stores = Team::new(a.path())
        .invite(b.path(), Role::Editor)
        .into_stores();
    let _editor = stores.pop();
    let owner = stores.pop().unwrap();
    let (entries, certs) = read_acl(a.path()).unwrap();
    let entry_bytes: Vec<Vec<u8>> = entries.iter().map(|e| e.to_bytes()).collect();
    let mut cert_bytes: Vec<Vec<u8>> = certs.iter().map(|c| c.to_bytes().to_vec()).collect();

    let db = open_db(&data.path().join("node.db")).unwrap();
    let mut node = NodeStore::fresh(db.clone(), owner.opened.acl.space, 1 << 30);
    // a stranger's certificates (of a user the log does not know) ride along with the real log
    let (_, stranger) = account();
    for _ in 0..50 {
        let keys = DeviceKeys::generate().unwrap();
        cert_bytes.push(DeviceCert::issue(&stranger, &keys, NOW).to_bytes().to_vec());
    }
    assert!(node.import_acl(&entry_bytes, &cert_bytes).unwrap());
    let stored: i64 = rusqlite::Connection::open(data.path().join("node.db"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM certs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        stored as usize,
        certs.len(),
        "only the members' certificates are kept"
    );

    // the same log again (or a shorter one) brings nothing new: ignored, nothing stored
    assert!(!node.import_acl(&entry_bytes, &cert_bytes).unwrap());
    assert!(!node.import_acl(&entry_bytes[..1], &cert_bytes).unwrap());
    let stored_after: i64 = rusqlite::Connection::open(data.path().join("node.db"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM certs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored_after, stored);
}

#[test]
fn the_node_sends_the_newest_received_message_first() {
    let (data, a) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let owner = Team::new(a.path()).into_stores().pop().unwrap();
    let (log, certs) = read_acl(a.path()).unwrap();
    let entries: Vec<Vec<u8>> = log.iter().map(|e| e.to_bytes()).collect();
    let certs: Vec<Vec<u8>> = certs.iter().map(|c| c.to_bytes().to_vec()).collect();
    let db = open_db(&data.path().join("node.db")).unwrap();
    let mut node = NodeStore::fresh(db, owner.opened.acl.space, 1 << 30);
    node.import_acl(&entries, &certs).unwrap();
    // three messages of the owner, in the order they arrive
    let mut sent = owner.opened;
    let id = sent.space.create_note("a.md").unwrap();
    sent.space.insert_text(&id, 0, "pierwsza").unwrap();
    sent.space.insert_text(&id, 8, " druga").unwrap();
    let msgs = sent.space.messages().unwrap();
    for m in &msgs {
        node.put(m).unwrap();
    }
    let after = node.after(&Vec::new(), usize::MAX).unwrap();
    let newest_first: Vec<Vec<u8>> = msgs.iter().rev().cloned().collect();
    assert_eq!(after, newest_first);
}

#[test]
fn a_backlog_cut_after_every_two_frames_is_resumed_until_complete() {
    let (data, a) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let owner = Team::new(a.path()).into_stores().pop().unwrap();
    let (log, certs) = read_acl(a.path()).unwrap();
    let entries: Vec<Vec<u8>> = log.iter().map(|e| e.to_bytes()).collect();
    let certs: Vec<Vec<u8>> = certs.iter().map(|c| c.to_bytes().to_vec()).collect();
    let db = open_db(&data.path().join("node.db")).unwrap();
    let mut node = NodeStore::fresh(db, owner.opened.acl.space, 1 << 30);
    node.import_acl(&entries, &certs).unwrap();
    let mut sent = owner.opened;
    let id = sent.space.create_note("a.md").unwrap();
    for i in 0..6 {
        sent.space.insert_text(&id, i, "x").unwrap();
    }
    let msgs = sent.space.messages().unwrap();
    for m in &msgs {
        node.put(m).unwrap();
    }
    // the receiver keeps every message it got, gaps included; its version vector is the contiguous prefix
    let mut held: std::collections::HashMap<[u8; 32], std::collections::BTreeSet<u64>> = Default::default();
    let mut attempts = 0;
    loop {
        let vv: Vec<([u8; 32], u64)> = held
            .iter()
            .map(|(d, seqs)| {
                let first = *seqs.iter().next().unwrap();
                let prefix = (first..).take_while(|s| seqs.contains(s)).last().unwrap();
                (*d, prefix)
            })
            .collect();
        // one message per frame here; the connection is cut after the second frame
        let frames = node.backlog(&vv, 1).unwrap();
        if frames.iter().all(|f| {
            let h = notes_sync::policy::parse_header(f).unwrap();
            held.get(&h.device).is_some_and(|s| s.contains(&h.seq))
        }) {
            break;
        }
        attempts += 1;
        for f in frames.iter().take(2) {
            let h = notes_sync::policy::parse_header(f).unwrap();
            held.entry(h.device).or_default().insert(h.seq);
        }
        assert!(attempts <= msgs.len(), "no progress after {attempts} attempts");
    }
    let total: usize = held.values().map(|s| s.len()).sum();
    assert_eq!(total, msgs.len());
}
