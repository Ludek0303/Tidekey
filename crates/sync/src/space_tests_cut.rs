//! Cuts (revocation, equivocation, rollback), legacy migration, tampering and recovery from the phrase.

use super::super::*;
use crate::test_util::{
    NOW, Permissive, account, contains, db_files, db_path, deliver, invite, newest_by, owner_space,
};

use std::fs;
use std::path::Path;

use rusqlite::{Connection, params};

use crate::acl::Role;
use crate::invite::PendingInvites;
use crate::keystore::MemoryKeyStore;
use crate::space_owner::{change_role, revoke_device};

#[test]
fn revoked_device_is_cut_at_its_last_message() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "przed").unwrap();
    let mut invites = PendingInvites::default();
    let (mut joined, _ks_j, _) =
        invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    deliver(&owner.space, &mut joined.space);
    joined.space.insert_text(&id, 5, " j1").unwrap();
    deliver(&joined.space, &mut owner.space);

    revoke_device(&mut owner, &mut ks_o, joined.cert.device).unwrap();
    owner.space.insert_text(&id, 0, "po ").unwrap();
    joined.space.insert_text(&id, 0, "j2 ").unwrap();

    let j2 = newest_by(&joined.space, joined.cert.device);
    assert!(matches!(
        owner.space.receive(&j2),
        Err(notes_core::Error::Denied { .. })
    ));
    let new_epoch = newest_by(&owner.space, owner.cert.device);
    assert!(matches!(
        joined.space.receive(&new_epoch),
        Err(notes_core::Error::NoEpochKey(_))
    ));
    let text = owner.space.text(&id).unwrap();
    assert_eq!(text, "po przed j1");
    drop(owner);
    let mut owner = open_space(a.path(), &mut ks_o).unwrap();
    assert_eq!(owner.space.text(&id).unwrap(), text);
}

#[test]
fn same_device_and_seq_with_other_bytes_is_an_equivocation() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "a").unwrap();
    drop(owner);
    // a copy of the database; the original and the copy then each write one more message with the same seq
    fs::create_dir_all(b.path().join(".notes-sync")).unwrap();
    fs::copy(db_path(a.path()), db_path(b.path())).unwrap();
    let mut owner = open_space(a.path(), &mut ks_o).unwrap();
    let mut twin = open_space(b.path(), &mut ks_o).unwrap();
    owner.space.insert_text(&id, 0, "b").unwrap();
    twin.space.insert_text(&id, 0, "c").unwrap();
    let original = newest_by(&owner.space, owner.cert.device);
    let forked = newest_by(&twin.space, twin.cert.device);
    assert_ne!(original, forked);
    assert!(matches!(
        owner.space.receive(&forked),
        Err(notes_core::Error::BadMessage { .. })
    ));
    assert_eq!(
        owner.space.receive(&original).unwrap(),
        notes_core::Received::Known
    );
}

#[test]
fn shorter_log_than_the_stored_head_is_a_rollback() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let mut invites = PendingInvites::default();
    let (joined, _ks_j, phrase) =
        invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Reader);
    drop(joined);
    let user = UserKeys::from_phrase(&phrase).unwrap().public();
    change_role(&mut owner, &mut ks_o, user.sign, Role::Editor).unwrap();
    drop(owner);
    let conn = Connection::open(db_path(a.path())).unwrap();
    conn.execute("DELETE FROM acl WHERE idx = (SELECT MAX(idx) FROM acl)", [])
        .unwrap();
    drop(conn);
    assert!(matches!(
        open_space(a.path(), &mut ks_o).err(),
        Some(Error::Acl(_))
    ));
}

/// Turns a fresh space.db into the layout of the previous version: device secret, epoch-0 key and
/// plaintext note text in the old tables.
fn to_legacy(root: &Path, seed: &[u8; 32], key: &[u8; 32], note: &str) {
    let conn = Connection::open(db_path(root)).unwrap();
    conn.execute_batch(
        "ALTER TABLE space ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE space ADD COLUMN key BLOB;
         ALTER TABLE file_state ADD COLUMN text TEXT NOT NULL DEFAULT '';
         CREATE TABLE device (id INTEGER PRIMARY KEY CHECK (id = 0), secret BLOB NOT NULL);
         PRAGMA user_version = 0;",
    )
    .unwrap();
    conn.execute("UPDATE space SET key = ?1 WHERE id = 0", params![&key[..]])
        .unwrap();
    conn.execute(
        "INSERT INTO device (id, secret) VALUES (0, ?1)",
        params![&seed[..]],
    )
    .unwrap();
    conn.execute("UPDATE file_state SET text = ?1", params![note])
        .unwrap();
}

#[test]
fn legacy_space_keeps_its_text_and_loses_its_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let (seed, key, sid) = ([5u8; 32], [6u8; 32], [8u8; 16]);
    {
        let mut sp = notes_core::Space::create(
            dir.path(),
            sid,
            SigningKey::from_bytes(&seed),
            Box::new(Permissive(key)),
        )
        .unwrap();
        let id = sp.create_note("stary.md").unwrap();
        sp.insert_text(&id, 0, "stary tekst").unwrap();
        sp.write_file(&id).unwrap();
    }
    to_legacy(dir.path(), &seed, &key, "stary tekst");
    let secrets = notes_core::Space::take_legacy_secrets(dir.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            *secrets.device_secret,
            secrets.space_id,
            *secrets.epoch0_key
        ),
        (seed, sid, key)
    );

    let (_, owner) = account();
    let mut ks = MemoryKeyStore::default();
    let mut opened = migrate_legacy(dir.path(), owner, &mut ks, NOW).unwrap();
    let (id, path) = opened.space.notes()[0].clone();
    assert_eq!(path, "stary.md");
    assert_eq!(opened.space.text(&id).unwrap(), "stary tekst");
    // the text stays in the messages' encryption only; space.db keeps it in its base copy, not as a secret
    for message in opened.space.messages().unwrap() {
        assert!(!contains(&message, "stary tekst".as_bytes()));
    }
    drop(opened);

    for bytes in db_files(dir.path()) {
        assert!(!contains(&bytes, &seed));
        assert!(!contains(&bytes, &key));
    }
    assert!(
        notes_core::Space::take_legacy_secrets(dir.path())
            .unwrap()
            .is_none()
    );
    let mut opened = open_space(dir.path(), &mut ks).unwrap();
    assert_eq!(opened.space.text(&id).unwrap(), "stary tekst");
}

#[test]
fn tampered_stored_message_still_fails_the_open() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, mut ks) = owner_space(dir.path());
    let id = sp.space.create_note("n.md").unwrap();
    sp.space.insert_text(&id, 0, "tekst").unwrap();
    drop(sp);
    let conn = Connection::open(db_path(dir.path())).unwrap();
    let mut bytes: Vec<u8> = conn
        .query_row(
            "SELECT bytes FROM messages ORDER BY device, seq LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    conn.execute(
        "UPDATE messages SET bytes = ?1 WHERE rowid = (SELECT MIN(rowid) FROM messages)",
        params![bytes],
    )
    .unwrap();
    drop(conn);
    assert!(matches!(
        open_space(dir.path(), &mut ks).err(),
        Some(Error::Core(_))
    ));
}

#[test]
fn device_without_the_current_key_needs_the_phrase_and_recovery_fixes_it() {
    let (a, b, c) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "x").unwrap();
    let mut invites = PendingInvites::default();
    let (joined, mut ks_j, phrase) =
        invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    let device = joined.cert.device;
    drop(joined);

    revoke_device(&mut owner, &mut ks_o, device).unwrap();
    owner.space.insert_text(&id, 1, "y").unwrap();
    let (entries, certs) = read_acl(a.path()).unwrap();

    // the revoked device learns the new log, but gets no key for the new epoch
    let mut stale = open_space(b.path(), &mut ks_j).unwrap();
    assert!(import_acl(&mut stale, &mut ks_j, entries.clone(), certs.clone()).is_err());
    drop(stale);
    assert!(matches!(
        open_space(b.path(), &mut ks_j).err(),
        Some(Error::NeedsPhrase)
    ));

    // a new device of the same user gets the epoch keys from the user-level envelopes
    let user = UserKeys::from_phrase(&phrase).unwrap();
    let mut ks_new = MemoryKeyStore::default();
    let mut fresh = recover_device(c.path(), user, entries, certs, &mut ks_new, NOW).unwrap();
    deliver(&owner.space, &mut fresh.space);
    assert_eq!(fresh.space.text(&id).unwrap(), "xy");
    assert!(fresh.space.rejected().is_empty());
}

#[test]
fn restoring_an_older_space_db_is_refused_by_the_key_store_head() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let (owner, mut ks_o) = owner_space(a.path());
    drop(owner);
    // the folder as it was after creation, closed so that the copy is complete
    let old = fs::read(db_path(a.path())).unwrap();

    let mut owner = open_space(a.path(), &mut ks_o).unwrap();
    let mut invites = PendingInvites::default();
    let (joined, _ks_j, _) = invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    drop(joined);
    drop(owner);

    // a restored backup brings back the old log; the key store still remembers the newer head
    fs::write(db_path(a.path()), old).unwrap();
    let _ = fs::remove_file(db_path(a.path()).with_extension("db-wal"));
    assert!(matches!(
        open_space(a.path(), &mut ks_o).err(),
        Some(Error::Space(msg)) if msg.contains("starsza")
    ));
}

#[test]
fn migration_refuses_a_device_key_slot_that_belongs_to_another_space() {
    let dir = tempfile::tempdir().unwrap();
    let (seed, key, sid) = ([5u8; 32], [6u8; 32], [8u8; 16]);
    {
        let mut sp = notes_core::Space::create(
            dir.path(),
            sid,
            SigningKey::from_bytes(&seed),
            Box::new(Permissive(key)),
        )
        .unwrap();
        let id = sp.create_note("stary.md").unwrap();
        sp.insert_text(&id, 0, "stary tekst").unwrap();
        sp.write_file(&id).unwrap();
    }
    to_legacy(dir.path(), &seed, &key, "stary tekst");
    let (_, owner) = account();
    let mut ks = MemoryKeyStore::default();
    ks.set(Slot::DeviceSign, &[9; 32]).unwrap();
    let refused = migrate_legacy(dir.path(), owner, &mut ks, NOW).err();
    assert!(matches!(refused, Some(Error::Space(_))), "{refused:?}");
    // nothing was deleted: the old secrets are still there for a later try on another device
    assert!(
        notes_core::Space::take_legacy_secrets(dir.path())
            .unwrap()
            .is_some()
    );
    assert_eq!(*ks.get(Slot::DeviceSign).unwrap().unwrap(), vec![9; 32]);
}

#[test]
fn failed_import_leaves_the_rules_of_the_stored_log_in_force() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "x").unwrap();
    let mut invites = PendingInvites::default();
    let (joined, mut ks_j, _) = invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    let device = joined.cert.device;
    drop(joined);
    revoke_device(&mut owner, &mut ks_o, device).unwrap();
    let (entries, certs) = read_acl(a.path()).unwrap();
    let newest = entries.last().unwrap().index;

    let mut stale = open_space(b.path(), &mut ks_j).unwrap();
    deliver(&owner.space, &mut stale.space);
    assert!(import_acl(&mut stale, &mut ks_j, entries, certs).is_err());
    // the in-memory rules and log are the stored ones: the revoked device cannot write any more
    assert_eq!(stale.acl.head().index, newest);
    assert!(stale.space.insert_text(&id, 0, "z").is_err());
    assert_eq!(stale.space.text(&id).unwrap(), "x");
}

#[test]
fn log_that_brings_nothing_new_is_ignored_and_junk_certificates_are_not_kept() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let mut invites = PendingInvites::default();
    let (joined, mut ks_j, _) = invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    drop(joined);
    let (entries, certs) = read_acl(a.path()).unwrap();

    let mut same = open_space(b.path(), &mut ks_j).unwrap();
    assert!(!import_acl(&mut same, &mut ks_j, entries.clone(), certs.clone()).unwrap());

    // a longer log from the owner (one more member), with a certificate of a stranger attached
    let c = tempfile::tempdir().unwrap();
    let joined2 = invite(&mut owner, &mut ks_o, &mut invites, c.path(), Role::Reader);
    drop(joined2);
    let (_, stranger) = account();
    let junk_keys = DeviceKeys::generate().unwrap();
    let junk = DeviceCert::issue(&stranger, &junk_keys, NOW);
    let (longer, mut all_certs) = read_acl(a.path()).unwrap();
    all_certs.push(junk);
    assert!(import_acl(&mut same, &mut ks_j, longer, all_certs).unwrap());
    assert!(same.certs.get(&junk.device).is_none());
}

#[test]
fn revoked_devices_do_not_count_against_the_active_limit() {
    let (phrase, user) = account();
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let opened = create_space(dir.path(), user, &mut ks, NOW).unwrap();
    // the owner's account is the member whose devices are issued here
    let user = UserKeys::from_phrase(&phrase).unwrap();
    let mut state = opened.acl.clone();
    let mut store = CertStore::default();
    for _ in 0..8 {
        let cert = DeviceCert::issue(&user, &DeviceKeys::generate().unwrap(), NOW);
        store.insert(cert).unwrap();
        state.revoked.insert(cert.device, (0, [0; 32]));
    }
    // eight revoked devices, then a new one: accepted
    let new = DeviceCert::issue(&user, &DeviceKeys::generate().unwrap(), NOW);
    assert!(state.keeps_cert(&store, &new));
    // thirty-two active devices are the most a user may have; the thirty-third is refused
    for _ in 0..32 {
        store
            .insert(DeviceCert::issue(
                &user,
                &DeviceKeys::generate().unwrap(),
                NOW,
            ))
            .unwrap();
    }
    assert!(!state.keeps_cert(&store, &new));
    // a certificate that is already stored is always kept
    let kept = store.certs_of(&user.public().sign)[0];
    assert!(state.keeps_cert(&store, &kept));
}

#[test]
fn recovery_refuses_a_revoked_device_key_and_one_certified_for_another_member() {
    use crate::keystore::{KeyStore, Slot};
    use crate::space_recover::recover_existing;

    let (a, b, c) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (mut owner, mut ks_o) = owner_space(a.path());
    let mut invites = PendingInvites::default();
    let (joined, mut ks_j, phrase) =
        invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    let device = joined.cert.device;
    drop(joined);
    let (other, _, other_phrase) =
        invite(&mut owner, &mut ks_o, &mut invites, c.path(), Role::Editor);
    drop(other);
    let (entries, certs) = read_acl(a.path()).unwrap();
    let mut stale = open_space(b.path(), &mut ks_j).unwrap();
    import_acl(&mut stale, &mut ks_j, entries, certs).unwrap();
    drop(stale);

    // another member's phrase typed on the joiner's device: its key is certified in b for the joiner
    let mut ks_copy = MemoryKeyStore::default();
    for slot in [Slot::DeviceSign, Slot::DeviceBox] {
        ks_copy
            .set(slot, &ks_j.get(slot).unwrap().unwrap())
            .unwrap();
    }
    let other_user = UserKeys::from_phrase(&other_phrase).unwrap();
    assert!(matches!(
        recover_existing(b.path(), other_user, &mut ks_copy, NOW).err(),
        Some(Error::DeviceUnusable)
    ));
    let epoch = Slot::EpochKey {
        space: owner.acl.space,
        epoch: owner.acl.epoch,
    };
    assert!(ks_copy.get(epoch).unwrap().is_none());

    // the joiner's device is revoked: its own phrase must not open a space that refuses every write
    revoke_device(&mut owner, &mut ks_o, device).unwrap();
    let (entries, certs) = read_acl(a.path()).unwrap();
    let mut stale = open_space(b.path(), &mut ks_j).unwrap();
    assert!(import_acl(&mut stale, &mut ks_j, entries, certs).is_err());
    drop(stale);
    let sign_before = ks_j.get(Slot::DeviceSign).unwrap().unwrap().to_vec();
    let user = UserKeys::from_phrase(&phrase).unwrap();
    assert!(matches!(
        recover_existing(b.path(), user, &mut ks_j, NOW).err(),
        Some(Error::DeviceUnusable)
    ));
    assert_eq!(
        ks_j.get(Slot::DeviceSign).unwrap().unwrap().to_vec(),
        sign_before
    );
}
