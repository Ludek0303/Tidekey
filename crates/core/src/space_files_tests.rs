use super::super::*;
use super::{AcceptAll, SPACE_ID, create_test, device_of, open_test, seeded};

/// Now, on the clock the space reads: a deletion at this time is in the trash.
fn recent() -> i64 {
    super::super::lazy::now_ms() as i64
}

#[test]
fn rename_moves_file_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.rename_note(&id, "b/Nowy.md").unwrap();
    assert!(!dir.path().join("a/Plan.md").exists());
    assert_eq!(
        fs::read_to_string(dir.path().join("b/Nowy.md")).unwrap(),
        "hello"
    );
    drop(sp);
    let sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.notes(), vec![(id, "b/Nowy.md".to_string())]);
}

#[test]
fn move_into_new_folder_creates_it() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.rename_note(&id, "new/deep/Plan.md").unwrap();
    assert!(dir.path().join("new/deep").is_dir());
    assert_eq!(
        fs::read_to_string(dir.path().join("new/deep/Plan.md")).unwrap(),
        "hello"
    );
}

#[test]
fn rename_errors() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let a = sp.create_note("a.md").unwrap();
    sp.create_note("b.md").unwrap();
    assert!(matches!(
        sp.rename_note(&a, "b.md"),
        Err(Error::PathTaken(_))
    ));
    assert!(matches!(
        sp.rename_note(&a, "../x.md"),
        Err(Error::InvalidPath(_))
    ));
    assert!(matches!(
        sp.rename_note("nope", "c.md"),
        Err(Error::UnknownNote(_))
    ));
    sp.rename_note(&a, "a.md").unwrap();
    assert_eq!(sp.notes().len(), 2);
}

#[test]
fn delete_hides_note_and_lists_trash() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    let other = sp.create_note("c.md").unwrap();
    let (at_id, at_other) = (recent() - 2_000, recent());
    sp.delete_note(&id, at_id).unwrap();
    sp.delete_note(&other, at_other).unwrap();
    assert!(!dir.path().join("a/Plan.md").exists());
    assert!(sp.notes().is_empty());
    let expected = vec![
        (other.clone(), "c.md".to_string(), at_other),
        (id.clone(), "a/Plan.md".to_string(), at_id),
    ];
    assert!(matches!(
        sp.delete_note(&id, 3000),
        Err(Error::UnknownNote(_))
    ));
    drop(sp);
    let sp = open_test(dir.path()).unwrap();
    assert!(sp.notes().is_empty());
    assert_eq!(sp.trash(), expected);
}

#[test]
fn restore_brings_back_file_and_text() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.delete_note(&id, recent()).unwrap();
    assert_eq!(sp.restore_note(&id).unwrap(), "a/Plan.md");
    assert_eq!(
        fs::read_to_string(dir.path().join("a/Plan.md")).unwrap(),
        "hello"
    );
    assert!(sp.trash().is_empty());
    assert!(matches!(sp.restore_note(&id), Err(Error::UnknownNote(_))));
}

#[test]
fn restore_on_taken_path_gets_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.delete_note(&id, recent()).unwrap();
    let reused = sp.create_note("a/Plan.md").unwrap();
    assert_eq!(sp.restore_note(&id).unwrap(), "a/Plan (2).md");
    assert_eq!(
        fs::read_to_string(dir.path().join("a/Plan (2).md")).unwrap(),
        "hello"
    );
    drop(sp);
    let sp = open_test(dir.path()).unwrap();
    let mut notes = sp.notes();
    notes.sort();
    let mut expected = vec![
        (id, "a/Plan (2).md".to_string()),
        (reused, "a/Plan.md".to_string()),
    ];
    expected.sort();
    assert_eq!(notes, expected);
}

#[test]
fn polish_names_work() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let id = sp.create_note("Zażółć/Gęślą.md").unwrap();
    sp.insert_text(&id, 0, "źdźbło").unwrap();
    sp.write_file(&id).unwrap();
    sp.rename_note(&id, "Zażółć/Łódź.md").unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("Zażółć/Łódź.md")).unwrap(),
        "źdźbło"
    );
    sp.delete_note(&id, recent()).unwrap();
    assert_eq!(sp.trash()[0].1, "Zażółć/Łódź.md");
}

fn foreign_path(sp: &mut Space, id: &str, path: &str) {
    let peer = new_doc();
    let update = {
        let paths = peer.get_or_insert_map(PATHS);
        let mut txn = peer.transact_mut();
        paths.insert(&mut txn, id, path.to_string());
        txn.encode_update_v1()
    };
    apply(&sp.meta, &update).unwrap();
}

#[test]
fn duplicate_live_paths_resolve_deterministically() {
    for other in ["0".repeat(32), "f".repeat(32)] {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        let a = sp.create_note("a.md").unwrap();
        foreign_path(&mut sp, &other, "a.md");
        let (keep, shift) = if a < other { (a, other) } else { (other, a) };
        let mut expected = vec![
            (keep, "a.md".to_string()),
            (shift.clone(), "a (2).md".to_string()),
        ];
        expected.sort_by(|x, y| x.1.cmp(&y.1));
        sp.notes.entry(shift.clone()).or_insert_with(new_doc);
        assert_eq!(sp.notes(), expected);
        sp.write_file(&shift).unwrap();
        assert!(dir.path().join("a (2).md").exists());
    }
}

#[test]
fn case_variants_are_duplicates() {
    for other in ["0".repeat(32), "f".repeat(32)] {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        let a = sp.create_note("a.md").unwrap();
        foreign_path(&mut sp, &other, "A.md");
        let (keep_path, shift_path) = if a < other {
            ("a.md", "A (2).md")
        } else {
            ("A.md", "a (2).md")
        };
        let (keep, shift) = if a < other { (a, other) } else { (other, a) };
        let mut expected = vec![
            (keep, keep_path.to_string()),
            (shift, shift_path.to_string()),
        ];
        expected.sort_by(|x, y| x.1.cmp(&y.1));
        assert_eq!(sp.notes(), expected);
    }
}

#[test]
fn case_only_rename_works() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.rename_note(&id, "a/PLAN.md").unwrap();
    assert_eq!(sp.notes(), vec![(id, "a/PLAN.md".to_string())]);
    assert_eq!(
        fs::read_to_string(dir.path().join("a/PLAN.md")).unwrap(),
        "hello"
    );
}

#[test]
fn rename_onto_untracked_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let a = sp.create_note("a.md").unwrap();
    fs::write(dir.path().join("u.md"), "mine").unwrap();
    assert!(matches!(
        sp.rename_note(&a, "u.md"),
        Err(Error::PathTaken(_))
    ));
    assert_eq!(fs::read_to_string(dir.path().join("u.md")).unwrap(), "mine");
}

#[test]
fn invalid_meta_paths_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let ok = sp.create_note("ok.md").unwrap();
    let bad = ["0".repeat(32), "1".repeat(32), "2".repeat(32)];
    for (id, path) in bad
        .iter()
        .zip(["/etc/x.md", "../t4-escape.md", "a\\..\\x.md"])
    {
        foreign_path(&mut sp, id, path);
        sp.notes.insert(id.clone(), new_doc());
    }
    assert_eq!(sp.notes(), vec![(ok, "ok.md".to_string())]);
    for id in &bad {
        assert!(matches!(
            sp.rename_note(id, "z.md"),
            Err(Error::UnknownNote(_))
        ));
        assert!(matches!(sp.delete_note(id, recent()), Err(Error::UnknownNote(_))));
        assert!(matches!(sp.write_file(id), Err(Error::UnknownNote(_))));
    }
    assert!(!dir.path().parent().unwrap().join("t4-escape.md").exists());
    assert!(sp.trash().is_empty());
}

#[test]
fn shifted_loser_removes_its_old_name() {
    for other in ["0".repeat(32), "f".repeat(32)] {
        let dir = tempfile::tempdir().unwrap();
        let mut sp = create_test(dir.path()).unwrap();
        let a = sp.create_note("a.md").unwrap();
        sp.insert_text(&a, 0, "x").unwrap();
        sp.write_file(&a).unwrap();
        foreign_path(&mut sp, &other, "a.md");
        sp.notes.entry(other.clone()).or_insert_with(new_doc);
        sp.insert_text(&other, 0, "y").unwrap();
        sp.write_file(&other).unwrap();
        sp.write_file(&a).unwrap();
        assert!(dir.path().join("a (2).md").exists());

        let (keep, shift, keep_text, shift_text) = if a < other {
            (a, other, "x", "y")
        } else {
            (other, a, "y", "x")
        };
        sp.rename_note(&keep, "c.md").unwrap();
        sp.write_file(&shift).unwrap();
        assert!(!dir.path().join("a (2).md").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("a.md")).unwrap(),
            shift_text
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("c.md")).unwrap(),
            keep_text
        );
    }
}

#[test]
fn user_edited_old_file_is_kept_on_rename() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    fs::write(dir.path().join("a/Plan.md"), "edited").unwrap();
    sp.rename_note(&id, "b/Plan.md").unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("a/Plan.md")).unwrap(),
        "edited"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("b/Plan.md")).unwrap(),
        "hello"
    );
}

#[test]
fn crash_after_delete_log_is_repaired_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.mark_deleted(&id, recent()).unwrap();
    drop(sp);
    assert!(dir.path().join("a/Plan.md").exists());
    let sp = open_test(dir.path()).unwrap();
    assert!(!dir.path().join("a/Plan.md").exists());
    assert_eq!(sp.trash().len(), 1);
}

#[test]
fn restore_never_overwrites_untracked_file() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.delete_note(&id, recent()).unwrap();
    fs::create_dir_all(dir.path().join("a")).unwrap();
    fs::write(dir.path().join("a/Plan.md"), "mine").unwrap();
    assert_eq!(sp.restore_note(&id).unwrap(), "a/Plan (2).md");
    assert_eq!(
        fs::read_to_string(dir.path().join("a/Plan.md")).unwrap(),
        "mine"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a/Plan (2).md")).unwrap(),
        "hello"
    );
}

#[test]
fn free_name_uses_forward_slashes() {
    assert_eq!(
        crate::space_meta::free_name("Projekty/Plan.md", |_| false),
        "Projekty/Plan (2).md"
    );
    assert_eq!(
        crate::space_meta::free_name("Plan.md", |c| c == "Plan (2).md"),
        "Plan (3).md"
    );
}

#[test]
fn create_refuses_untracked_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    fs::write(dir.path().join("x.md"), "mine").unwrap();
    assert!(matches!(sp.create_note("x.md"), Err(Error::PathTaken(_))));
    assert_eq!(fs::read_to_string(dir.path().join("x.md")).unwrap(), "mine");
}

#[test]
fn untracked_file_at_deleted_path_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let id = sp.create_note("Untitled.md").unwrap();
    sp.write_file(&id).unwrap();
    sp.delete_note(&id, recent()).unwrap();
    fs::write(dir.path().join("Untitled.md"), "").unwrap();
    drop(sp);
    open_test(dir.path()).unwrap();
    assert!(dir.path().join("Untitled.md").exists());
}

#[test]
fn failed_sweep_does_not_block_open() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.mark_deleted(&id, recent()).unwrap();
    drop(sp);
    fs::remove_file(dir.path().join("a/Plan.md")).unwrap();
    fs::create_dir(dir.path().join("a/Plan.md")).unwrap();
    let sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.trash().len(), 1);
}

#[test]
fn deleting_loser_keeps_winner_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let a = sp.create_note("a.md").unwrap();
    sp.insert_text(&a, 0, "x").unwrap();
    sp.write_file(&a).unwrap();
    // "0...0" sorts below any random id, so the foreign note wins and `a` becomes the loser
    let winner = "0".repeat(32);
    assert!(a > winner);
    foreign_path(&mut sp, &winner, "a.md");
    sp.delete_note(&a, recent()).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "x");
}

#[test]
fn purge_trash_removes_only_notes_deleted_before_the_cutoff() {
    let dir = tempfile::tempdir().unwrap();
    let old = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    let young = sp.create_note("c.md").unwrap();
    sp.insert_text(&young, 0, "młoda").unwrap();
    let cutoff = trash_cutoff(recent());
    sp.delete_note(&old, cutoff - 1_000).unwrap();
    sp.delete_note(&young, cutoff + 1_000).unwrap();
    assert_eq!(sp.purge_trash(cutoff).unwrap(), 1);
    assert_eq!(sp.trash().len(), 1);
    assert_eq!(sp.trash()[0].0, young);
    assert!(matches!(sp.restore_note(&old), Err(Error::UnknownNote(_))));
    drop(sp);
    let mut sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.trash().len(), 1);
    assert_eq!(sp.restore_note(&young).unwrap(), "c.md");
    assert_eq!(sp.text(&young).unwrap(), "młoda");
    assert_eq!(sp.notes(), vec![(young, "c.md".to_string())]);
}

#[test]
fn trash_hides_expired_notes_before_purge_trash_runs() {
    let dir = tempfile::tempdir().unwrap();
    let old = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    let young = sp.create_note("c.md").unwrap();
    let now = super::super::lazy::now_ms() as i64;
    sp.delete_note(&old, trash_cutoff(now) - 1).unwrap();
    sp.delete_note(&young, now).unwrap();
    // the expired note is gone from the trash although nothing has purged it yet
    assert_eq!(sp.trash().len(), 1);
    assert_eq!(sp.trash()[0].0, young);
    assert!(matches!(sp.restore_note(&old), Err(Error::UnknownNote(_))));
    assert_eq!(sp.purge_trash(trash_cutoff(now)).unwrap(), 1);
}

#[test]
fn purge_note_removes_one_trashed_note_and_its_versions() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.save_version(&id, "ręcznie").unwrap();
    assert!(matches!(sp.purge_note(&id), Err(Error::UnknownNote(_))));
    sp.delete_note(&id, recent()).unwrap();
    sp.purge_note(&id).unwrap();
    assert!(sp.trash().is_empty());
    assert!(sp.versions(&id).unwrap().is_empty());
    assert!(!dir.path().join("a/Plan.md").exists());
    assert!(matches!(sp.restore_note(&id), Err(Error::UnknownNote(_))));
    drop(sp);
    let sp = open_test(dir.path()).unwrap();
    assert!(sp.trash().is_empty());
    assert!(sp.notes().is_empty());
}

#[test]
fn a_restored_note_keeps_its_text_and_versions() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    sp.save_version(&id, "ręcznie").unwrap();
    sp.delete_note(&id, recent()).unwrap();
    assert_eq!(sp.restore_note(&id).unwrap(), "a/Plan.md");
    assert_eq!(sp.text(&id).unwrap(), "hello");
    assert_eq!(sp.versions(&id).unwrap().len(), 1);
}

#[test]
fn a_purged_note_does_not_come_back_from_a_stale_replica() {
    let (a_dir, b_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut a = Space::create(a_dir.path(), SPACE_ID, device_of(1), Box::new(AcceptAll)).unwrap();
    let id = a.create_note("a.md").unwrap();
    a.insert_text(&id, 0, "tajne").unwrap();
    let mut stale =
        Space::create(b_dir.path(), SPACE_ID, device_of(2), Box::new(AcceptAll)).unwrap();
    stale.receive_batch(&a.messages().unwrap()).unwrap();
    a.delete_note(&id, recent()).unwrap();
    a.purge_note(&id).unwrap();
    assert_eq!(a.purge_trash(i64::MAX).unwrap(), 0);
    // the stale replica has not seen the purge: it renames and edits the note
    stale.rename_note(&id, "b.md").unwrap();
    stale.insert_text(&id, 0, "znowu ").unwrap();
    a.receive_batch(&stale.messages().unwrap()).unwrap();
    assert!(a.notes().is_empty());
    assert!(a.trash().is_empty());
    assert!(matches!(a.restore_note(&id), Err(Error::UnknownNote(_))));
    drop(a);
    let a = open_test(a_dir.path()).unwrap();
    assert!(a.notes().is_empty());
    // once the stale replica gets the purge, it agrees
    stale.receive_batch(&a.messages().unwrap()).unwrap();
    assert!(stale.notes().is_empty());
    assert!(stale.trash().is_empty());
}
