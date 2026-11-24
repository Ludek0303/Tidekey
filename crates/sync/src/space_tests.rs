use super::*;

use crate::acl::Role;
use crate::identity::UserKeys;
use crate::invite::PendingInvites;
use crate::space_owner::remove_member;
use crate::test_util::{Permissive, contains, db_files, deliver, invite, newest_by, owner_space};

#[path = "space_tests_cut.rs"]
mod cut;

#[test]
fn space_db_and_wal_hold_no_secret_and_messages_hold_no_note_text() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, ks) = owner_space(dir.path());
    let id = sp.space.create_note("n.md").unwrap();
    sp.space.insert_text(&id, 0, "tajny tekst").unwrap();
    sp.space.write_file(&id).unwrap();
    let device = ks.get(Slot::DeviceSign).unwrap().unwrap();
    let epoch0 = ks
        .get(Slot::EpochKey {
            space: sp.acl.space,
            epoch: 0,
        })
        .unwrap()
        .unwrap();
    let files = db_files(dir.path());
    assert!(!files.is_empty());
    for bytes in &files {
        assert!(!contains(bytes, &device));
        assert!(!contains(bytes, &epoch0));
    }
    // note text is kept in space.db only where the open space needs it (versions, the base of a merge);
    // what travels and what is kept as messages stays encrypted
    for message in sp.space.messages().unwrap() {
        assert!(!contains(&message, b"tajny"));
    }
}

#[test]
fn reopen_after_restart_restores_the_same_text() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, mut ks) = owner_space(dir.path());
    let id = sp.space.create_note("n.md").unwrap();
    sp.space.insert_text(&id, 0, "zażółć 😀").unwrap();
    drop(sp);
    let mut sp = open_space(dir.path(), &mut ks).unwrap();
    assert_eq!(sp.space.text(&id).unwrap(), "zażółć 😀");
    assert!(sp.space.rejected().is_empty());
}

#[test]
fn invited_editor_sees_the_same_text_and_its_edits_reach_the_owner() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "od właściciela").unwrap();
    let mut invites = PendingInvites::default();
    let (mut joined, _ks_j, _) =
        invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);

    deliver(&owner.space, &mut joined.space);
    assert_eq!(joined.space.text(&id).unwrap(), "od właściciela");

    joined.space.insert_text(&id, 0, "edytor: ").unwrap();
    deliver(&joined.space, &mut owner.space);
    assert_eq!(owner.space.text(&id).unwrap(), "edytor: od właściciela");
    assert_eq!(
        joined.space.text(&id).unwrap(),
        owner.space.text(&id).unwrap()
    );
}

#[test]
fn reader_cannot_write_and_its_messages_are_refused() {
    let (a, b, c) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "tylko czytaj").unwrap();
    let mut invites = PendingInvites::default();
    let (mut reader, ks_r, _) = invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Reader);
    deliver(&owner.space, &mut reader.space);
    assert!(matches!(
        reader.space.insert_text(&id, 0, "x"),
        Err(notes_core::Error::Denied { .. })
    ));

    // a reader device that ignores the rules writes anyway; the owner must refuse it
    let sk = signing_key(&device_keys(&ks_r).unwrap());
    let epoch0 = secret32(
        &ks_o
            .get(Slot::EpochKey {
                space: owner.acl.space,
                epoch: 0,
            })
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let mut forged =
        notes_core::Space::create(c.path(), owner.acl.space, sk, Box::new(Permissive(epoch0)))
            .unwrap();
    let nid = forged.create_note("x.md").unwrap();
    forged.insert_text(&nid, 0, "czytelnik").unwrap();
    let before = owner.space.messages().unwrap().len();
    for m in forged.messages().unwrap() {
        assert!(matches!(
            owner.space.receive(&m),
            Err(notes_core::Error::Denied { .. })
        ));
    }
    assert_eq!(owner.space.messages().unwrap().len(), before);
    assert_eq!(owner.space.text(&id).unwrap(), "tylko czytaj");
}

#[test]
fn removed_member_is_cut_at_its_last_message() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut owner, mut ks_o) = owner_space(a.path());
    let id = owner.space.create_note("n.md").unwrap();
    owner.space.insert_text(&id, 0, "przed").unwrap();
    let mut invites = PendingInvites::default();
    let (mut joined, _ks_j, phrase) =
        invite(&mut owner, &mut ks_o, &mut invites, b.path(), Role::Editor);
    let user = UserKeys::from_phrase(&phrase).unwrap().public();
    deliver(&owner.space, &mut joined.space);
    joined.space.insert_text(&id, 5, " j1").unwrap();
    deliver(&joined.space, &mut owner.space);

    remove_member(&mut owner, &mut ks_o, user.sign).unwrap();
    owner.space.insert_text(&id, 0, "po ").unwrap();
    joined.space.insert_text(&id, 0, "j2 ").unwrap();

    // the removed member's message after the cut is refused, even though it uses the old epoch key
    let j2 = newest_by(&joined.space, joined.cert.device);
    assert!(matches!(
        owner.space.receive(&j2),
        Err(notes_core::Error::Denied { .. })
    ));
    // and it cannot read the new epoch
    let new_epoch = newest_by(&owner.space, owner.cert.device);
    assert!(matches!(
        joined.space.receive(&new_epoch),
        Err(notes_core::Error::NoEpochKey(_))
    ));

    // the history up to the cut still replays to the same text
    let text = owner.space.text(&id).unwrap();
    assert_eq!(text, "po przed j1");
    drop(owner);
    let mut owner = open_space(a.path(), &mut ks_o).unwrap();
    assert_eq!(owner.space.text(&id).unwrap(), text);
    assert!(owner.space.rejected().is_empty());
}
