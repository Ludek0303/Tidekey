//! The rows of the §4.4 table, moves and deletes made outside the app, and the version history.

use super::*;
use crate::space::tests::{create_test, open_test};
use crate::text_hash;
use std::path::Path;

/// A note with `text` on disk and in the CRDT; the file is the base of later merges.
fn note_with(root: &Path, path: &str, text: &str) -> (Space, NoteId) {
    let mut sp = create_test(root).unwrap();
    let id = sp.create_note(path).unwrap();
    sp.insert_text(&id, 0, text).unwrap();
    sp.write_file(&id).unwrap();
    (sp, id)
}

fn disk(root: &Path, path: &str) -> String {
    fs::read_to_string(root.join(path)).unwrap()
}

#[test]
fn own_write_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, _) = note_with(dir.path(), "a.md", "tekst");
    let text = disk(dir.path(), "a.md");
    assert_eq!(
        sp.external_change("a.md", &text).unwrap(),
        ExternalOutcome::Ignored
    );
}

#[test]
fn file_equal_to_the_crdt_text_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "stare");
    // an edit in the app that is not written yet; the file then gets the same text from outside
    sp.insert_text(&id, 0, "nowe ").unwrap();
    assert_eq!(
        sp.external_change("a.md", "nowe stare").unwrap(),
        ExternalOutcome::Unchanged
    );
    assert_eq!(sp.text(&id).unwrap(), "nowe stare");
}

#[test]
fn only_the_file_changed_is_applied_and_the_old_text_is_a_version() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "jeden\n");
    fs::write(dir.path().join("a.md"), "jeden\ndwa\n").unwrap();
    let outcome = sp.external_change("a.md", "jeden\ndwa\n").unwrap();
    assert_eq!(outcome, ExternalOutcome::Applied);
    assert_eq!(sp.text(&id).unwrap(), "jeden\ndwa\n");
    let versions = sp.versions(&id).unwrap();
    assert_eq!(versions[0].reason, "przed zmianą zewnętrzną");
    assert_eq!(sp.version_text(versions[0].id).unwrap(), "jeden\n");
}

#[test]
fn both_sides_changing_different_lines_is_merged_into_both() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "a\nb\nc\n");
    // the app changes line one, the other program changes line three
    sp.insert_text(&id, 0, "X").unwrap();
    fs::write(dir.path().join("a.md"), "a\nb\nC\n").unwrap();
    let outcome = sp.external_change("a.md", "a\nb\nC\n").unwrap();
    assert_eq!(outcome, ExternalOutcome::Merged);
    assert_eq!(sp.text(&id).unwrap(), "Xa\nb\nC\n");
    assert_eq!(disk(dir.path(), "a.md"), "Xa\nb\nC\n");
}

#[test]
fn both_sides_changing_the_same_line_is_a_conflict_that_overwrites_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    let outcome = sp.external_change("a.md", "obca linia\n").unwrap();
    assert_eq!(outcome, ExternalOutcome::Conflict);
    assert_eq!(sp.text(&id).unwrap(), "moja linia\n");
    assert_eq!(disk(dir.path(), "a.md"), "obca linia\n");
    assert_eq!(sp.conflicts().unwrap(), vec![id.clone()]);
    assert_eq!(
        sp.conflict_texts(&id).unwrap(),
        ("moja linia\n".into(), "obca linia\n".into())
    );
    assert!(
        sp.versions(&id)
            .unwrap()
            .iter()
            .any(|v| v.reason == "zmiana zewnętrzna – konflikt")
    );

    // while in conflict the app edits the CRDT but does not touch the file
    sp.insert_text(&id, 0, "x").unwrap();
    sp.write_file(&id).unwrap();
    assert_eq!(disk(dir.path(), "a.md"), "obca linia\n");

    sp.resolve_conflict(&id, "wybrane\n", &text_hash("obca linia\n"))
        .unwrap();
    assert!(sp.conflicts().unwrap().is_empty());
    assert_eq!(sp.text(&id).unwrap(), "wybrane\n");
    assert_eq!(disk(dir.path(), "a.md"), "wybrane\n");
}

#[test]
fn a_new_file_becomes_a_new_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    fs::write(dir.path().join("nowy.md"), "z zewnątrz 🐢").unwrap();
    let ExternalOutcome::Created(id) = sp.external_change("nowy.md", "z zewnątrz 🐢").unwrap()
    else {
        panic!("expected a new note");
    };
    assert_eq!(sp.text(&id).unwrap(), "z zewnątrz 🐢");
    assert!(sp.notes().iter().any(|(n, p)| *n == id && p == "nowy.md"));
}

#[test]
fn a_file_deleted_outside_goes_to_the_trash() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "tekst");
    fs::remove_file(dir.path().join("a.md")).unwrap();
    sp.external_delete("a.md").unwrap();
    assert!(sp.notes().is_empty());
    assert_eq!(sp.trash()[0].0, id);
}

#[test]
fn a_file_moved_outside_keeps_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "przeniesiony");
    fs::rename(dir.path().join("a.md"), dir.path().join("b.md")).unwrap();
    assert_eq!(
        sp.external_move("a.md", "b.md").unwrap(),
        ExternalOutcome::Ignored
    );
    assert_eq!(sp.notes(), vec![(id.clone(), "b.md".to_string())]);
    assert_eq!(sp.text(&id).unwrap(), "przeniesiony");
    // the record now follows the new path, so a later edit of the moved file is seen
    fs::write(dir.path().join("b.md"), "przeniesiony\ndalej\n").unwrap();
    assert_eq!(
        sp.external_change("b.md", "przeniesiony\ndalej\n").unwrap(),
        ExternalOutcome::Applied
    );
}

#[test]
fn restore_creates_a_version_and_keeps_the_later_history() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "wersja 1");
    let v1 = sp.save_version(&id, "ręcznie").unwrap().unwrap();
    assert_eq!(
        sp.save_version(&id, "ręcznie").unwrap(),
        None,
        "identical to the newest version"
    );
    sp.insert_text(&id, 8, " i 2").unwrap();
    sp.save_version(&id, "ręcznie").unwrap();
    let before = sp.versions(&id).unwrap().len();

    sp.restore_version(&id, v1).unwrap();
    assert_eq!(sp.text(&id).unwrap(), "wersja 1");
    assert_eq!(disk(dir.path(), "a.md"), "wersja 1");
    let after = sp.versions(&id).unwrap();
    assert!(after.len() > before);
    assert_eq!(after[0].reason, "przywrócono");
    assert_eq!(
        sp.version_text(after.last().unwrap().id).unwrap(),
        "wersja 1"
    );
}

#[test]
fn versions_are_per_note_and_text_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "ąę🐢");
    let vid = sp.save_version(&id, "test").unwrap().unwrap();
    drop(sp);
    let sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.version_text(vid).unwrap(), "ąę🐢");
    assert!(sp.versions("other").unwrap().is_empty());
}

#[test]
fn every_external_edit_during_a_conflict_is_kept_as_a_version() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    sp.external_change("a.md", "obca linia\n").unwrap();
    // the other program writes again while the conflict waits
    fs::write(dir.path().join("a.md"), "trzecia wersja\n").unwrap();
    assert_eq!(
        sp.external_change("a.md", "trzecia wersja\n").unwrap(),
        ExternalOutcome::Conflict
    );
    assert_eq!(sp.conflict_texts(&id).unwrap().1, "trzecia wersja\n");
    let kept: Vec<String> = sp
        .versions(&id)
        .unwrap()
        .iter()
        .map(|v| sp.version_text(v.id).unwrap())
        .collect();
    assert!(kept.iter().any(|t| t == "obca linia\n"));
    assert!(kept.iter().any(|t| t == "trzecia wersja\n"));
}

#[test]
fn resolve_refuses_a_stale_theirs_text() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    sp.external_change("a.md", "obca linia\n").unwrap();
    let seen = text_hash("obca linia\n");
    fs::write(dir.path().join("a.md"), "nowsza obca linia\n").unwrap();
    sp.external_change("a.md", "nowsza obca linia\n").unwrap();
    assert!(matches!(
        sp.resolve_conflict(&id, "moja linia\n", &seen),
        Err(crate::Error::ConflictChanged(_))
    ));
    assert_eq!(sp.text(&id).unwrap(), "moja linia\n");
    assert_eq!(sp.conflicts().unwrap(), vec![id.clone()]);
}

#[test]
fn resolve_refuses_a_note_that_is_not_in_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let (mut plain, id) = note_with(dir.path(), "b.md", "zwykła\n");
    let before = plain.text(&id).unwrap();
    assert!(matches!(
        plain.resolve_conflict(&id, "podmiana\n", &text_hash(&before)),
        Err(crate::Error::NotInConflict(_))
    ));
    assert_eq!(plain.text(&id).unwrap(), before);
}

#[test]
fn deleting_a_conflicted_note_leaves_no_conflict_and_no_untracked_file() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    sp.external_change("a.md", "obca linia\n").unwrap();
    sp.delete_note(&id, super::super::lazy::now_ms() as i64).unwrap();
    assert!(sp.conflicts().unwrap().is_empty());
    assert!(!dir.path().join("a.md").exists());
    assert!(
        sp.versions(&id)
            .unwrap()
            .iter()
            .any(|v| v.reason == "zmiana zewnętrzna – konflikt")
    );
}

#[test]
fn renaming_a_conflicted_note_moves_its_file_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    sp.external_change("a.md", "obca linia\n").unwrap();
    sp.rename_note(&id, "b.md").unwrap();
    assert!(!dir.path().join("a.md").exists());
    assert_eq!(disk(dir.path(), "b.md"), "obca linia\n");
    assert_eq!(sp.conflicts().unwrap(), vec![id.clone()]);
    assert_eq!(sp.notes(), vec![(id.clone(), "b.md".to_string())]);
}

#[test]
fn a_symlink_is_never_read_as_a_moved_note() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, _) = note_with(dir.path(), "a.md", "tekst");
    fs::write(dir.path().join("cel.txt"), "sekret").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("cel.txt"), dir.path().join("link.md")).unwrap();
        fs::remove_file(dir.path().join("a.md")).unwrap();
        assert!(sp.external_move("a.md", "link.md").is_err());
        assert_eq!(sp.notes()[0].1, "a.md");
    }
}

#[test]
fn writing_a_note_never_overwrites_a_file_changed_outside() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    sp.write_file(&id).unwrap();
    assert_eq!(disk(dir.path(), "a.md"), "obca linia\n");
    assert_eq!(sp.conflicts().unwrap(), vec![id.clone()]);
}

#[test]
fn writing_a_note_takes_in_a_change_on_another_line_first() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "a\nb\nc\n");
    sp.insert_text(&id, 0, "X").unwrap();
    fs::write(dir.path().join("a.md"), "a\nb\nC dłuższa\n").unwrap();
    sp.write_file(&id).unwrap();
    assert_eq!(sp.text(&id).unwrap(), "Xa\nb\nC dłuższa\n");
    assert_eq!(disk(dir.path(), "a.md"), "Xa\nb\nC dłuższa\n");
}

#[test]
fn files_changed_while_closed_are_listed_by_size_or_mtime() {
    let dir = tempfile::tempdir().unwrap();
    let (sp, _) = note_with(dir.path(), "a.md", "stare\n");
    assert!(sp.files_changed_on_disk().unwrap().is_empty());
    fs::write(dir.path().join("a.md"), "stare\nnowe\n").unwrap();
    assert_eq!(
        sp.files_changed_on_disk().unwrap(),
        vec!["a.md".to_string()]
    );
    fs::remove_file(dir.path().join("a.md")).unwrap();
    assert!(
        sp.files_changed_on_disk().unwrap().is_empty(),
        "a missing file is not reported"
    );
}

#[test]
fn write_file_reports_the_change_it_took_in() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "a\nb\nc\n");
    assert_eq!(sp.write_file(&id).unwrap(), None);
    sp.insert_text(&id, 0, "X").unwrap();
    fs::write(dir.path().join("a.md"), "a\nb\nC dłuższa\n").unwrap();
    assert_eq!(sp.write_file(&id).unwrap(), Some(ExternalOutcome::Merged));
}

#[test]
fn resolve_takes_in_an_unseen_edit_before_it_compares_the_seen_text() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    sp.insert_text(&id, 0, "moja ").unwrap();
    fs::write(dir.path().join("a.md"), "obca linia\n").unwrap();
    sp.external_change("a.md", "obca linia\n").unwrap();
    let seen = text_hash("obca linia\n");
    // another program writes again; the app has not looked at the file yet
    fs::write(dir.path().join("a.md"), "THEIRS3 unseen\n").unwrap();
    assert!(matches!(
        sp.resolve_conflict(&id, "moja linia\n", &seen),
        Err(crate::Error::ConflictChanged(_))
    ));
    assert_eq!(disk(dir.path(), "a.md"), "THEIRS3 unseen\n");
    assert_eq!(sp.conflict_texts(&id).unwrap().1, "THEIRS3 unseen\n");
    assert!(
        sp.versions(&id)
            .unwrap()
            .iter()
            .any(|v| sp.version_text(v.id).unwrap() == "THEIRS3 unseen\n")
    );
    assert_eq!(sp.conflicts().unwrap(), vec![id.clone()]);

    // the view is opened again with the new text, and that choice goes through
    let seen = text_hash("THEIRS3 unseen\n");
    sp.resolve_conflict(&id, "moja linia\n", &seen).unwrap();
    assert_eq!(disk(dir.path(), "a.md"), "moja linia\n");
    assert!(sp.conflicts().unwrap().is_empty());
}

#[test]
fn a_note_file_replaced_by_a_link_is_never_read() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "linia\n");
    fs::write(outside.path().join("sekret"), "sekret\n").unwrap();
    #[cfg(unix)]
    {
        fs::remove_file(dir.path().join("a.md")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("sekret"), dir.path().join("a.md")).unwrap();
        sp.insert_text(&id, 0, "moja ").unwrap();
        assert!(sp.write_file(&id).is_err());
        assert!(!sp.text(&id).unwrap().contains("sekret"));
        assert!(
            !sp.versions(&id)
                .unwrap()
                .iter()
                .any(|v| sp.version_text(v.id).unwrap().contains("sekret"))
        );
    }
}

#[test]
fn a_restore_reports_an_unseen_external_edit_it_takes_in() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "jeden\n");
    let v1 = sp.save_version(&id, "ręcznie").unwrap().unwrap();
    sp.insert_text(&id, 6, "dwa\n").unwrap();
    sp.write_file(&id).unwrap();
    // another program rewrites the same line; the watcher has not seen it yet
    fs::write(dir.path().join("a.md"), "jeden\nINNY\n").unwrap();

    let outcome = sp.restore_version(&id, v1).unwrap();
    assert_eq!(outcome, Some(ExternalOutcome::Conflict));
    assert_eq!(sp.conflicts().unwrap(), vec![id.clone()]);
    assert!(
        sp.versions(&id)
            .unwrap()
            .iter()
            .any(|v| sp.version_text(v.id).unwrap().contains("INNY"))
    );
}

#[cfg(unix)]
#[test]
fn a_note_file_turned_into_a_link_is_refused_with_its_own_error() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "tekst");
    fs::write(dir.path().join("secret.txt"), "sekret").unwrap();
    fs::remove_file(dir.path().join("a.md")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.txt"), dir.path().join("a.md")).unwrap();
    sp.insert_text(&id, 0, "x").unwrap();
    assert!(matches!(sp.write_file(&id), Err(Error::NotPlainFile(p)) if p == "a.md"));
    assert_eq!(
        fs::read_to_string(dir.path().join("secret.txt")).unwrap(),
        "sekret"
    );
}

#[test]
fn a_note_file_rewritten_as_binary_is_refused_and_kept() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sp, id) = note_with(dir.path(), "a.md", "tekst");
    fs::write(dir.path().join("a.md"), [0xff, 0xfe, 0x00]).unwrap();
    sp.insert_text(&id, 0, "x").unwrap();
    assert!(matches!(sp.write_file(&id), Err(Error::NotPlainFile(p)) if p == "a.md"));
    assert_eq!(
        fs::read(dir.path().join("a.md")).unwrap(),
        [0xff, 0xfe, 0x00]
    );
}
