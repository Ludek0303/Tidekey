//! Changes made by other programs to the folder, checked against real files and the real watcher.

use std::fs;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notes_sync::keystore::MemoryKeyStore;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, Text, Transact, Update};

use crate::backend::Backend;
use crate::changes::{AUTOSAVE_QUIET_MS, Change, DEBOUNCE_MS, GONE_MS, SETTLE_BATCH};

fn update(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let content = doc.get_or_insert_text("content");
    let mut txn = doc.transact_mut();
    content.insert(&mut txn, 0, text);
    txn.encode_update_v1()
}

/// Ticks until `done` holds or ten seconds pass; the changes the UI would get are collected on the way.
fn until(
    b: &mut Backend,
    changes: &mut Vec<Change>,
    mut done: impl FnMut(&mut Backend) -> bool,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        b.tick().unwrap();
        changes.extend(b.take_changes());
        if done(b) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[test]
fn an_edit_in_another_program_reaches_the_note_and_the_editor() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("stara")).unwrap();
    let mut changes = Vec::new();
    fs::write(dir.path().join("a.md"), "nowa treść").unwrap();

    assert!(until(&mut b, &mut changes, |b| b.note_text(&id).unwrap()
        == "nowa treść"));
    assert!(
        changes
            .iter()
            .any(|c| matches!(c, Change::NoteUpdate { id: n, .. } if *n == id))
    );
}

#[test]
fn our_own_write_is_not_taken_back_as_an_external_change() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("moje")).unwrap();
    let mut changes = Vec::new();
    until(&mut b, &mut changes, |_| false);
    assert!(
        !changes
            .iter()
            .any(|c| matches!(c, Change::NoteUpdate { .. } | Change::Conflict { .. }))
    );
    assert_eq!(b.note_text(&id).unwrap(), "moje");
}

#[test]
fn a_renamed_file_keeps_its_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("przenoszona")).unwrap();
    fs::rename(dir.path().join("a.md"), dir.path().join("b.md")).unwrap();
    let mut changes = Vec::new();
    assert!(until(&mut b, &mut changes, |b| {
        b.list_tree()
            .unwrap()
            .notes
            .iter()
            .any(|n| n.path == "b.md" && n.id == id)
    }));
    assert_eq!(b.note_text(&id).unwrap(), "przenoszona");
    assert!(changes.iter().any(|c| matches!(c, Change::TreeChanged)));
}

#[test]
fn a_deleted_file_goes_to_the_trash_after_the_wait() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("usuwana")).unwrap();
    fs::remove_file(dir.path().join("a.md")).unwrap();
    let mut changes = Vec::new();
    assert!(until(&mut b, &mut changes, |b| !b
        .opened
        .space
        .trash()
        .is_empty()));
    assert_eq!(b.opened.space.trash()[0].0, id);
    assert!(b.list_tree().unwrap().notes.is_empty());
}

#[test]
fn a_new_file_becomes_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    fs::write(dir.path().join("nowy.md"), "z zewnątrz").unwrap();
    let mut changes = Vec::new();
    assert!(until(&mut b, &mut changes, |b| {
        b.list_tree()
            .unwrap()
            .notes
            .iter()
            .any(|n| n.path == "nowy.md")
    }));
    let id = b.list_tree().unwrap().notes[0].id.clone();
    assert_eq!(b.note_text(&id).unwrap(), "z zewnątrz");
}

#[test]
fn edits_from_both_sides_of_one_line_are_a_conflict_and_the_file_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("linia\n")).unwrap();
    // a change from a collaborator that is not written to the file yet
    b.opened.space.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    let mut changes = Vec::new();
    assert!(until(&mut b, &mut changes, |b| b.list_conflicts().unwrap()
        == vec![id.clone()]));
    assert!(
        changes
            .iter()
            .any(|c| matches!(c, Change::Conflict { id: n } if *n == id))
    );
    assert_eq!(b.list_conflicts().unwrap(), vec![id.clone()]);
    let texts = b.conflict_texts(&id).unwrap();
    assert_eq!(
        (texts.ours.as_str(), texts.theirs.as_str()),
        ("moja linia\n", "obca linia\n")
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.md")).unwrap(),
        "obca linia\n"
    );

    let seen = b.conflict_texts(&id).unwrap().theirs_hash;
    b.resolve_conflict(&id, "wybrane\n", &seen).unwrap();
    assert!(b.list_conflicts().unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(dir.path().join("a.md")).unwrap(),
        "wybrane\n"
    );
}

#[test]
fn versions_are_saved_after_two_minutes_without_edits() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("wersja")).unwrap();
    b.tick_at(now_ms() + AUTOSAVE_QUIET_MS - 1_000).unwrap();
    assert!(b.list_versions(&id).unwrap().is_empty());
    b.tick_at(now_ms() + AUTOSAVE_QUIET_MS + 1_000).unwrap();
    let versions = b.list_versions(&id).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].reason, "automatycznie");
    assert_eq!(b.version_text(versions[0].id).unwrap(), "wersja");
}

/// Types `text` at the end of the note, as the editor does: a Yjs update against the note's current state.
fn type_at_end(b: &mut Backend, id: &str, text: &str) {
    let state = b.open_note(id).unwrap();
    let doc = Doc::new();
    let content = doc.get_or_insert_text("content");
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let len = content.len(&txn);
        content.insert(&mut txn, len, text);
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    b.apply_update(id, &update).unwrap();
}

/// Every saved version of the note, joined.
fn all_versions(b: &Backend, id: &str) -> String {
    b.list_versions(id)
        .unwrap()
        .iter()
        .map(|v| b.version_text(v.id).unwrap())
        .collect()
}

/// Ticks for `ms` milliseconds, collecting the changes the UI would get.
fn tick_for(b: &mut Backend, changes: &mut Vec<Change>, ms: u64) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(ms) {
        b.tick().unwrap();
        changes.extend(b.take_changes());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn an_edit_made_while_closed_is_kept_when_typing_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("hello\n")).unwrap();
    drop(b);
    fs::write(dir.path().join("a.md"), "hello\nEXTERNAL while closed\n").unwrap();

    let mut b = Backend::open(dir.path(), &mut ks).unwrap();
    let mut changes = Vec::new();
    // before any typing: the start-up scan has taken the line in, and the editor was told
    tick_for(&mut b, &mut changes, 400);
    assert!(b.note_text(&id).unwrap().contains("EXTERNAL while closed"));
    assert!(
        changes
            .iter()
            .any(|c| matches!(c, Change::NoteUpdate { id: n, .. } if *n == id))
    );

    type_at_end(&mut b, &id, "typed\n");
    tick_for(&mut b, &mut changes, 600);
    let text = b.note_text(&id).unwrap();
    let file = fs::read_to_string(dir.path().join("a.md")).unwrap();
    assert!(text.contains("typed\n"), "the typed line is kept: {text:?}");
    assert!(
        text.contains("EXTERNAL while closed")
            || all_versions(&b, &id).contains("EXTERNAL while closed")
    );
    assert!(file.contains("EXTERNAL while closed") || text.contains("EXTERNAL while closed"));
}

#[test]
fn a_merge_made_while_typing_is_sent_to_the_editor_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("top\nmiddle\nbottom\n"))
        .unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 400);
    fs::write(dir.path().join("a.md"), "EXT top\nmiddle\nbottom\n").unwrap();
    b.take_changes();
    type_at_end(&mut b, &id, "typed\n");

    // the update the editor gets, applied to its own copy, is the merged text
    let direct = b.take_changes();
    let update = direct
        .iter()
        .find_map(|c| match c {
            Change::NoteUpdate { id: n, update } if *n == id => Some(update.clone()),
            _ => None,
        })
        .expect("a note_update right after the typing");
    let doc = Doc::new();
    let content = doc.get_or_insert_text("content");
    doc.transact_mut()
        .apply_update(Update::decode_v1(&update).unwrap())
        .unwrap();
    let merged = content.get_string(&doc.transact());
    assert_eq!(merged, "EXT top\nmiddle\nbottom\ntyped\n");
    assert_eq!(b.note_text(&id).unwrap(), merged);
}

#[test]
fn a_conflict_made_while_typing_is_announced_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("linia\n")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 400);
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    b.take_changes();
    type_at_end(&mut b, &id, "dalej\n");
    let direct = b.take_changes();
    assert!(
        direct
            .iter()
            .any(|c| matches!(c, Change::Conflict { id: n } if *n == id))
    );
}

#[test]
fn a_conflict_taken_in_by_a_restore_is_announced_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("jeden\n")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 400);
    let v1 = b
        .opened
        .space
        .save_version(&id, "ręcznie")
        .unwrap()
        .unwrap();
    type_at_end(&mut b, &id, "dwa\n");
    fs::write(dir.path().join("a.md"), "jeden\nINNY\n").unwrap();
    b.take_changes();
    b.restore_version(&id, v1).unwrap();
    assert!(
        b.take_changes()
            .iter()
            .any(|c| matches!(c, Change::Conflict { id: n } if *n == id))
    );
}

#[test]
fn a_settled_note_is_not_queued_again_by_its_own_reads() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("stabilny\n")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 600);
    // two seconds of quiet: every sample must find nothing queued, however often the file was read
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(2) {
        b.tick().unwrap();
        b.take_changes();
        assert!(b.changed.is_empty(), "queued again: {:?}", b.changed);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
#[test]
fn a_folder_link_is_never_walked() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    fs::write(outside.path().join("x.md"), "obcy").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("ln")).unwrap();
    b.queue("ln".to_string(), true, now_ms()).unwrap();
    assert!(!b.changed.keys().any(|k| k.starts_with("ln/")));
}

#[test]
fn an_external_write_followed_at_once_by_typing_is_never_silently_lost() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("line1\n")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 400);
    // written by another program, and the user types before any tick has read it
    fs::write(dir.path().join("a.md"), "line1\nEXTERNAL fast\n").unwrap();
    type_at_end(&mut b, &id, "typed\n");
    tick_for(&mut b, &mut changes, 600);

    let text = b.note_text(&id).unwrap();
    let file = fs::read_to_string(dir.path().join("a.md")).unwrap();
    assert!(text.contains("typed\n"));
    let kept = text.contains("EXTERNAL fast") || all_versions(&b, &id).contains("EXTERNAL fast");
    assert!(
        kept,
        "the external line survives in the note or a version: {text:?}"
    );
    assert!(file.contains("EXTERNAL fast") || text.contains("EXTERNAL fast"));
}

#[test]
fn a_folder_moved_outside_keeps_the_ids_of_its_notes() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    b.create_folder("d").unwrap();
    let id = b.create_note("d/x.md").unwrap();
    b.apply_update(&id, &update("x body\n")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 400);
    fs::rename(dir.path().join("d"), dir.path().join("e")).unwrap();
    assert!(until(&mut b, &mut changes, |b| b
        .list_tree()
        .unwrap()
        .notes
        .iter()
        .any(|n| n.path == "e/x.md" && n.id == id)));
    // past the wait for vanished files: nothing went to the trash
    tick_for(&mut b, &mut changes, GONE_MS + 500);
    assert!(b.opened.space.trash().is_empty());
    assert_eq!(b.note_text(&id).unwrap(), "x body\n");
    drop(b);
    let mut b = Backend::open(dir.path(), &mut ks).unwrap();
    assert!(
        b.list_tree()
            .unwrap()
            .notes
            .iter()
            .any(|n| n.path == "e/x.md" && n.id == id)
    );
    assert_eq!(b.note_text(&id).unwrap(), "x body\n");
}

#[test]
fn one_tick_settles_a_bounded_number_of_paths() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let now = now_ms();
    for i in 0..2_000 {
        b.changed.insert(format!("plik{i}.md"), now - DEBOUNCE_MS);
    }
    b.tick_at(now).unwrap();
    assert_eq!(b.changed.len(), 2_000 - SETTLE_BATCH);
}

#[cfg(unix)]
#[test]
fn a_symlink_dropped_into_the_folder_is_never_read() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    fs::write(outside.path().join("sekret.md"), "tajne").unwrap();
    std::os::unix::fs::symlink(outside.path().join("sekret.md"), dir.path().join("link.md"))
        .unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("ln")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 800);
    assert!(b.list_tree().unwrap().notes.is_empty());
    assert!(b.create_folder("ln/nowy").is_err());
}

#[test]
fn conflict_refusals_have_their_own_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("linia\n")).unwrap();
    let mut changes = Vec::new();
    tick_for(&mut b, &mut changes, 400);
    // a change in the app that is not written yet, and a change in the file on the same line
    b.opened.space.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    let mut changes = Vec::new();
    assert!(until(&mut b, &mut changes, |b| b.list_conflicts().unwrap()
        == vec![id.clone()]));
    let seen = b.conflict_texts(&id).unwrap().theirs_hash;
    assert_eq!(
        b.resolve_conflict(&id, "x", "nie ten hash")
            .err()
            .unwrap()
            .kind,
        "conflict_changed"
    );
    b.resolve_conflict(&id, "x", &seen).unwrap();
    assert_eq!(
        b.resolve_conflict(&id, "y", &seen).err().unwrap().kind,
        "not_in_conflict"
    );
}
