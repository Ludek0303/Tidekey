use super::*;

use notes_sync::identity::RecoveryPhrase;
use notes_sync::keystore::{KeyStore, MemoryKeyStore, Slot};
use yrs::{Doc, Text, Transact};

/// A Yjs v1 update that inserts `text` into an empty note, as the UI sends it.
fn update(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let content = doc.get_or_insert_text("content");
    let mut txn = doc.transact_mut();
    content.insert(&mut txn, 0, text);
    txn.encode_update_v1()
}

fn paths(b: &Backend) -> Vec<String> {
    b.list_tree()
        .unwrap()
        .notes
        .into_iter()
        .map(|n| n.path)
        .collect()
}

#[test]
fn text_written_through_the_bridge_survives_a_reopen_and_reaches_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, words) = Backend::create(dir.path(), &mut ks).unwrap();
    assert_eq!(words.len(), 24);
    let id = b.create_note("Plan.md").unwrap();
    b.apply_update(&id, &update("Zażółć gęślą jaźń")).unwrap();
    drop(b);

    let mut b = Backend::open(dir.path(), &mut ks).unwrap();
    assert_eq!(b.note_text(&id).unwrap(), "Zażółć gęślą jaźń");
    let file = fs::read_to_string(dir.path().join("Plan.md")).unwrap();
    assert_eq!(file, "Zażółć gęślą jaźń");
}

#[test]
fn existing_md_files_are_imported_once_and_left_as_they_are() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("sub/deep")).unwrap();
    fs::write(dir.path().join("Top.md"), "# Góra\n").unwrap();
    fs::write(dir.path().join("sub/deep/Nested.md"), "# Głęboko").unwrap();
    fs::write(dir.path().join("notes.txt"), "nie notatka").unwrap();
    fs::create_dir_all(dir.path().join(".hidden")).unwrap();
    fs::write(dir.path().join(".hidden/Secret.md"), "ukryte").unwrap();
    fs::write(dir.path().join("CON.md"), "nazwa zarezerwowana").unwrap();
    let mut ks = MemoryKeyStore::default();

    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    assert_eq!(paths(&b), vec!["Top.md", "sub/deep/Nested.md"]);
    let nested = b.list_tree().unwrap().notes[1].id.clone();
    assert_eq!(b.note_text(&nested).unwrap(), "# Głęboko");
    assert_eq!(
        fs::read_to_string(dir.path().join("Top.md")).unwrap(),
        "# Góra\n"
    );
    drop(b);

    let b = Backend::open(dir.path(), &mut ks).unwrap();
    assert_eq!(paths(&b), vec!["Top.md", "sub/deep/Nested.md"]);
    assert_eq!(b.list_tree().unwrap().folders, vec!["sub", "sub/deep"]);
}

#[test]
fn rename_delete_and_folder_commands() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("A/one.md").unwrap();
    assert_eq!(b.list_tree().unwrap().folders, vec!["A"]);

    b.rename_folder("A", "B").unwrap();
    assert_eq!(paths(&b), vec!["B/one.md"]);
    assert_eq!(b.list_tree().unwrap().folders, vec!["B"]);
    assert!(!dir.path().join("A").exists());

    b.rename(&id, "B/two.md").unwrap();
    assert_eq!(paths(&b), vec!["B/two.md"]);
    assert!(b.rename_folder("B", "B/inside").is_err());

    b.delete(&id).unwrap();
    assert!(paths(&b).is_empty());
    assert_eq!(b.list_tree().unwrap().folders, vec!["B"]);
}

#[test]
fn deleting_a_folder_deletes_nested_notes_and_files_but_never_an_outside_path() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    b.create_note("A/one.md").unwrap();
    b.create_note("A/deep/two.md").unwrap();
    b.create_note("keep.md").unwrap();
    fs::write(dir.path().join("A/attachment.bin"), b"x").unwrap();

    b.delete_folder("A").unwrap();

    assert_eq!(paths(&b), vec!["keep.md"]);
    assert!(!dir.path().join("A").exists());
    assert_eq!(b.delete_folder("../outside").unwrap_err().kind, "invalid_path");
}

#[test]
fn created_folders_show_in_the_tree_and_hidden_or_taken_names_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    b.create_folder("Pusty").unwrap();
    assert_eq!(b.list_tree().unwrap().folders, vec!["Pusty"]);
    assert_eq!(b.create_folder("Pusty").unwrap_err().kind, "path_taken");
    assert_eq!(b.create_folder(".ukryty").unwrap_err().kind, "invalid_path");
    assert_eq!(
        b.create_folder(".notes-sync").unwrap_err().kind,
        "invalid_path"
    );

    // a folder name that climbs out of the space is refused, even when it would name a real directory
    let outside = dir.path().parent().unwrap().join("obcy");
    fs::create_dir_all(&outside).unwrap();
    assert_eq!(
        b.rename_folder("../obcy", "Przejęty").unwrap_err().kind,
        "invalid_path"
    );
    assert!(outside.is_dir());
    fs::remove_dir(&outside).unwrap();

    b.rename_folder("Pusty", "Pełny").unwrap();
    assert_eq!(b.list_tree().unwrap().folders, vec!["Pełny"]);
}

#[test]
fn the_recovery_phrase_restores_the_epoch_key_and_refuses_strangers() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, words) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("Klucz.md").unwrap();
    b.apply_update(&id, &update("tajne")).unwrap();
    let (space, epoch) = (b.opened.acl.space, b.opened.acl.epoch);
    drop(b);
    ks.delete(Slot::EpochKey { space, epoch }).unwrap();

    let stranger = RecoveryPhrase::generate().unwrap();
    assert_eq!(
        Backend::recover(dir.path(), &mut ks, stranger.as_str())
            .err()
            .unwrap()
            .kind,
        "not_member"
    );
    assert_eq!(
        Backend::recover(dir.path(), &mut ks, "nie to są słowa")
            .err()
            .unwrap()
            .kind,
        "bad_phrase"
    );
    assert!(ks.get(Slot::EpochKey { space, epoch }).unwrap().is_none());

    let mut b = Backend::recover(dir.path(), &mut ks, &words.join(" ")).unwrap();
    assert!(ks.get(Slot::EpochKey { space, epoch }).unwrap().is_some());
    assert_eq!(b.note_text(&id).unwrap(), "tajne");
}

#[test]
fn a_device_with_no_keys_is_told_to_recover_instead() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    drop(b);
    let mut empty = MemoryKeyStore::default();
    assert_eq!(
        Backend::open(dir.path(), &mut empty).err().unwrap().kind,
        "needs_phrase"
    );
}

#[test]
fn an_empty_key_store_recovers_an_existing_folder_from_the_phrase() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, words) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("Klucz.md").unwrap();
    b.apply_update(&id, &update("tajne")).unwrap();
    drop(b);

    let mut empty = MemoryKeyStore::default();
    let mut b = Backend::recover(dir.path(), &mut empty, &words.join(" ")).unwrap();
    assert_eq!(b.note_text(&id).unwrap(), "tajne");
    drop(b);
    // the recovered device keeps its keys: an ordinary open works from now on
    let mut b = Backend::open(dir.path(), &mut empty).unwrap();
    assert_eq!(b.note_text(&id).unwrap(), "tajne");
    assert_eq!(b.list_tree().unwrap().notes.len(), 1);
}

#[test]
fn a_wrong_phrase_or_a_stranger_leaves_the_empty_key_store_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let (space, epoch) = (b.opened.acl.space, b.opened.acl.epoch);
    drop(b);

    let mut empty = MemoryKeyStore::default();
    let stranger = RecoveryPhrase::generate().unwrap();
    assert_eq!(
        Backend::recover(dir.path(), &mut empty, stranger.as_str())
            .err()
            .unwrap()
            .kind,
        "not_member"
    );
    assert_eq!(
        Backend::recover(dir.path(), &mut empty, "nie to są słowa")
            .err()
            .unwrap()
            .kind,
        "bad_phrase"
    );
    assert!(empty.get(Slot::DeviceSign).unwrap().is_none());
    assert!(empty.get(Slot::DeviceBox).unwrap().is_none());
    assert!(
        empty
            .get(Slot::EpochKey { space, epoch })
            .unwrap()
            .is_none()
    );
    assert!(empty.get(Slot::AclHead { space }).unwrap().is_none());
}

#[test]
fn a_cold_note_loads_through_open_note_and_tick_drains_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("Zimna.md").unwrap();
    b.apply_update(&id, &update("zimna")).unwrap();
    drop(b);
    // made cold: last edited and last opened at the epoch, which is outside the hot window
    let db = rusqlite::Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    db.execute_batch("UPDATE doc_index SET time_ms = 0; UPDATE note_usage SET last_used_ms = 0;")
        .unwrap();
    drop(db);

    let mut b = Backend::open(dir.path(), &mut ks).unwrap();
    assert_eq!(b.opened.space.pending_count(), 1);
    assert!(!b.open_note(&id).unwrap().is_empty());
    assert_eq!(b.note_text(&id).unwrap(), "zimna");
    assert_eq!(b.tick().unwrap(), 0);
}

/// A key store whose epoch key writes can be made to fail, to stop a recovery in the middle.
#[derive(Default)]
struct FlakyKs {
    inner: MemoryKeyStore,
    fail_epoch: bool,
    fail_box: bool,
}

impl KeyStore for FlakyKs {
    fn get(&self, slot: Slot) -> notes_sync::Result<Option<zeroize::Zeroizing<Vec<u8>>>> {
        self.inner.get(slot)
    }
    fn set(&mut self, slot: Slot, value: &[u8]) -> notes_sync::Result<()> {
        if (self.fail_epoch && matches!(slot, Slot::EpochKey { .. }))
            || (self.fail_box && slot == Slot::DeviceBox)
        {
            return Err(notes_sync::Error::Store("injected failure".to_string()));
        }
        self.inner.set(slot, value)
    }
    fn delete(&mut self, slot: Slot) -> notes_sync::Result<()> {
        self.inner.delete(slot)
    }
}

#[test]
fn recovering_one_space_keeps_the_device_key_of_the_other_spaces() {
    let (da, db) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut ks = MemoryKeyStore::default();
    let (mut a, wa) = Backend::create(da.path(), &mut ks).unwrap();
    let ida = a.create_note("a.md").unwrap();
    a.apply_update(&ida, &update("A")).unwrap();
    let key_a = Slot::EpochKey {
        space: a.opened.acl.space,
        epoch: a.opened.acl.epoch,
    };
    drop(a);
    let (mut b, wb) = Backend::create(db.path(), &mut ks).unwrap();
    let idb = b.create_note("b.md").unwrap();
    b.apply_update(&idb, &update("B")).unwrap();
    let key_b = Slot::EpochKey {
        space: b.opened.acl.space,
        epoch: b.opened.acl.epoch,
    };
    drop(b);

    // A's epoch key is gone from this device: recover A, then B must still open, and the other way round
    ks.delete(key_a).unwrap();
    let mut a = Backend::recover(da.path(), &mut ks, &wa.join(" ")).unwrap();
    assert_eq!(a.note_text(&ida).unwrap(), "A");
    drop(a);
    let mut b = Backend::open(db.path(), &mut ks).unwrap();
    assert_eq!(b.note_text(&idb).unwrap(), "B");
    drop(b);
    ks.delete(key_b).unwrap();
    let mut b = Backend::recover(db.path(), &mut ks, &wb.join(" ")).unwrap();
    assert_eq!(b.note_text(&idb).unwrap(), "B");
    drop(b);
    assert!(Backend::open(da.path(), &mut ks).is_ok());
}

#[test]
fn a_device_key_the_folder_does_not_certify_needs_the_phrase_and_then_recovers() {
    let (da, dc) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut ks = MemoryKeyStore::default();
    drop(Backend::create(da.path(), &mut ks).unwrap());
    // a folder made on another device: its certificates do not name this device's key
    let mut other = MemoryKeyStore::default();
    let (mut c, wc) = Backend::create(dc.path(), &mut other).unwrap();
    let idc = c.create_note("c.md").unwrap();
    c.apply_update(&idc, &update("C")).unwrap();
    drop(c);

    assert_eq!(
        Backend::open(dc.path(), &mut ks).err().unwrap().kind,
        "needs_phrase"
    );
    let mut c = Backend::recover(dc.path(), &mut ks, &wc.join(" ")).unwrap();
    assert_eq!(c.note_text(&idc).unwrap(), "C");
    drop(c);
    assert!(Backend::open(da.path(), &mut ks).is_ok());
    assert!(Backend::open(dc.path(), &mut ks).is_ok());
}

#[test]
fn a_recovery_stopped_by_the_key_store_is_repaired_by_the_next_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, words) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("tekst")).unwrap();
    drop(b);
    let phrase = words.join(" ");

    let mut flaky = FlakyKs {
        fail_epoch: true,
        ..FlakyKs::default()
    };
    assert!(Backend::recover(dir.path(), &mut flaky, &phrase).is_err());
    // the device key was stored before the failure; the folder has no certificate for it yet
    let stored = flaky.inner.get(Slot::DeviceSign).unwrap().unwrap().to_vec();
    assert_eq!(
        Backend::open(dir.path(), &mut flaky.inner)
            .err()
            .unwrap()
            .kind,
        "needs_phrase"
    );

    flaky.fail_epoch = false;
    let mut b = Backend::recover(dir.path(), &mut flaky, &phrase).unwrap();
    // the stored device key is reused, not replaced
    assert_eq!(
        flaky.inner.get(Slot::DeviceSign).unwrap().unwrap().to_vec(),
        stored
    );
    assert_eq!(b.note_text(&id).unwrap(), "tekst");
    drop(b);
    assert!(Backend::open(dir.path(), &mut flaky.inner).is_ok());
}

#[test]
fn a_half_stored_device_key_is_made_again_by_the_next_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, words) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("tekst")).unwrap();
    drop(b);
    let phrase = words.join(" ");

    // the store fails between the two halves of a new device key
    let mut flaky = FlakyKs {
        fail_box: true,
        ..FlakyKs::default()
    };
    assert!(Backend::recover(dir.path(), &mut flaky, &phrase).is_err());
    assert!(flaky.inner.get(Slot::DeviceSign).unwrap().is_some());
    assert!(flaky.inner.get(Slot::DeviceBox).unwrap().is_none());
    assert_eq!(
        Backend::open(dir.path(), &mut flaky.inner)
            .err()
            .unwrap()
            .kind,
        "needs_phrase"
    );

    flaky.fail_box = false;
    let mut b = Backend::recover(dir.path(), &mut flaky, &phrase).unwrap();
    assert_eq!(b.note_text(&id).unwrap(), "tekst");
    drop(b);
    assert!(Backend::open(dir.path(), &mut flaky.inner).is_ok());
}

#[test]
fn opening_a_space_purges_trash_older_than_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let old = b.create_note("Stary.md").unwrap();
    let young = b.create_note("Młody.md").unwrap();
    let too_old = now_ms() as i64 - (notes_core::TRASH_DAYS + 1) * 86_400_000;
    b.opened.space.delete_note(&old, too_old).unwrap();
    b.delete(&young).unwrap();
    // the expired note is already out of the trash, before any purge
    assert_eq!(b.list_trash().unwrap().len(), 1);
    drop(b);

    let mut b = Backend::open(dir.path(), &mut ks).unwrap();
    let trash = b.list_trash().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].id, young);
    assert_eq!(trash[0].path, "Młody.md");
    assert_eq!(b.restore_note(&young).unwrap(), "Młody.md");
    assert_eq!(paths(&b), vec!["Młody.md"]);
}
