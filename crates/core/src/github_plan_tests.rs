use crate::github_plan::*;
use proptest::prelude::*;
use std::collections::BTreeSet;

const MIB: u64 = 1_048_576;

fn t(note: &str, path: &str, blob: &str, has_edits: bool) -> TrackedFile {
    TrackedFile { note_id: note.into(), path: path.into(), blob_sha: blob.into(), has_edits }
}

fn e(path: &str, blob: &str) -> TreeEntry {
    e_sized(path, blob, 10)
}

fn e_sized(path: &str, blob: &str, size: u64) -> TreeEntry {
    TreeEntry { path: path.into(), blob_sha: blob.into(), size }
}

fn create(path: &str, blob: &str) -> Action {
    Action::Create { path: path.into(), blob_sha: blob.into() }
}

fn update(note: &str, path: &str, blob: &str) -> Action {
    Action::Update { note_id: note.into(), path: path.into(), blob_sha: blob.into() }
}

fn mv(note: &str, from: &str, to: &str, blob: &str) -> Action {
    Action::Move { note_id: note.into(), from: from.into(), to: to.into(), blob_sha: blob.into() }
}

fn marked(note: &str) -> Action {
    Action::MarkDeleted { note_id: note.into() }
}

fn trashed(note: &str) -> Action {
    Action::Trash { note_id: note.into() }
}

fn skip(path: &str, reason: SkipReason) -> Action {
    Action::Skip { path: path.into(), reason }
}

fn none() -> Vec<String> {
    Vec::new()
}

// Table rows of docs/GITHUB.md §4.

#[test]
fn new_file_is_created() {
    let actions = plan(&[], &[e("a.md", "X")], &none(), false);
    assert_eq!(actions, vec![create("a.md", "X")]);
}

#[test]
fn changed_file_without_edits_is_updated() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("a.md", "Y")], &none(), false);
    assert_eq!(actions, vec![update("n1", "a.md", "Y")]);
}

#[test]
fn changed_file_with_edits_is_updated() {
    let actions = plan(&[t("n1", "a.md", "X", true)], &[e("a.md", "Y")], &none(), false);
    assert_eq!(actions, vec![update("n1", "a.md", "Y")]);
}

#[test]
fn unchanged_file_does_nothing() {
    let tracked = [t("n1", "a.md", "X", false), t("n2", "b.md", "Z", true)];
    let tree = [e("a.md", "X"), e("b.md", "Z")];
    assert!(plan(&tracked, &tree, &none(), true).is_empty());
}

#[test]
fn moved_file_without_edits_is_moved() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("b.md", "X")], &none(), false);
    assert_eq!(actions, vec![mv("n1", "a.md", "b.md", "X")]);
}

#[test]
fn moved_file_with_edits_is_moved() {
    let actions = plan(&[t("n1", "a.md", "X", true)], &[e("b.md", "X")], &none(), false);
    assert_eq!(actions, vec![mv("n1", "a.md", "b.md", "X")]);
}

#[test]
fn moved_and_changed_is_delete_plus_create() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("b.md", "Y")], &none(), false);
    assert_eq!(actions, vec![create("b.md", "Y"), marked("n1")]);
}

#[test]
fn moved_and_changed_with_trash_goes_to_trash() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("b.md", "Y")], &none(), true);
    assert_eq!(actions, vec![create("b.md", "Y"), trashed("n1")]);
}

#[test]
fn deleted_without_edits_is_marked_or_trashed() {
    let tracked = [t("n1", "a.md", "X", false)];
    assert_eq!(plan(&tracked, &[], &none(), false), vec![marked("n1")]);
    assert_eq!(plan(&tracked, &[], &none(), true), vec![trashed("n1")]);
}

#[test]
fn deleted_with_edits_is_always_marked() {
    let tracked = [t("n1", "a.md", "X", true)];
    assert_eq!(plan(&tracked, &[], &none(), true), vec![marked("n1")]);
    assert_eq!(plan(&tracked, &[], &none(), false), vec![marked("n1")]);
}

// Ignored paths apply to new files only.

#[test]
fn new_file_in_ignored_path_is_skipped() {
    let actions = plan(&[], &[e("ign/x.md", "X")], &["ign/x.md".to_string()], false);
    assert_eq!(actions, vec![skip("ign/x.md", SkipReason::Ignored)]);
}

#[test]
fn tracked_file_in_ignored_path_is_still_updated() {
    let actions = plan(&[t("n1", "ign.md", "X", false)], &[e("ign.md", "Y")], &["ign.md".to_string()], false);
    assert_eq!(actions, vec![update("n1", "ign.md", "Y")]);
}

// Move detection corner cases.

#[test]
fn copy_moves_once_and_other_copy_is_marked() {
    let tracked = [t("n1", "a.md", "X", false), t("n2", "b.md", "X", false)];
    let actions = plan(&tracked, &[e("c.md", "X")], &none(), false);
    assert_eq!(actions, vec![mv("n1", "a.md", "c.md", "X"), marked("n2")]);
}

#[test]
fn new_copy_of_present_file_is_created() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("a.md", "X"), e("b.md", "X")], &none(), false);
    assert_eq!(actions, vec![create("b.md", "X")]);
}

#[test]
fn move_candidates_are_taken_by_path() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("d.md", "X"), e("c.md", "X")], &none(), false);
    assert_eq!(actions, vec![mv("n1", "a.md", "c.md", "X"), create("d.md", "X")]);
}

#[test]
fn move_into_ignored_path_is_not_a_move() {
    let actions = plan(&[t("n1", "a.md", "X", false)], &[e("ign.md", "X")], &["ign.md".to_string()], false);
    assert_eq!(actions, vec![marked("n1"), skip("ign.md", SkipReason::Ignored)]);
}

// Empty sides.

#[test]
fn empty_tree_deletes_everything() {
    let tracked = [t("n1", "a.md", "X", false), t("n2", "b.md", "Y", true)];
    let actions = plan(&tracked, &[], &none(), true);
    assert_eq!(actions, vec![trashed("n1"), marked("n2")]);
}

#[test]
fn empty_tracked_creates_everything() {
    let actions = plan(&[], &[e("b.md", "Y"), e("a.md", "X")], &none(), false);
    assert_eq!(actions, vec![create("a.md", "X"), create("b.md", "Y")]);
}

// Limits.

#[test]
fn more_than_max_files_skips_extra_new_files() {
    let tree: Vec<TreeEntry> = (0..=MAX_FILES).map(|i| e(&format!("f{i:04}.md"), &format!("b{i}"))).collect();
    let actions = plan(&[], &tree, &none(), false);
    let creates = actions.iter().filter(|a| matches!(a, Action::Create { .. })).count();
    assert_eq!(creates, MAX_FILES);
    assert_eq!(actions.last(), Some(&skip(&format!("f{MAX_FILES:04}.md"), SkipReason::LimitFiles)));
}

#[test]
fn tracked_files_count_towards_max_files() {
    let tracked: Vec<TrackedFile> = (0..MAX_FILES - 1).map(|i| t(&format!("n{i}"), &format!("t{i:04}.md"), "B", false)).collect();
    let tree: Vec<TreeEntry> = (0..MAX_FILES - 1).map(|i| e(&format!("t{i:04}.md"), "B")).chain([e("z1.md", "Z"), e("z2.md", "Z")]).collect();
    let actions = plan(&tracked, &tree, &none(), false);
    assert_eq!(actions, vec![create("z1.md", "Z"), skip("z2.md", SkipReason::LimitFiles)]);
}

#[test]
fn file_over_max_bytes_is_skipped() {
    let actions = plan(&[], &[e_sized("big.md", "X", MIB + 1), e_sized("ok.md", "Y", MIB)], &none(), false);
    assert_eq!(actions, vec![create("ok.md", "Y"), skip("big.md", SkipReason::TooLarge)]);
}

#[test]
fn total_bytes_over_limit_skips_next_files() {
    // 21 files of 1 MiB: the first 20 fill the 20 MiB budget exactly, the last one does not fit.
    let tree: Vec<TreeEntry> = (0..21).map(|i| e_sized(&format!("p{i:02}.md"), &format!("P{i}"), MIB)).collect();
    let actions = plan(&[], &tree, &none(), false);
    assert_eq!(actions.len(), 21);
    assert_eq!(actions.last(), Some(&skip("p20.md", SkipReason::LimitTotal)));
    assert_eq!(actions.iter().filter(|a| matches!(a, Action::Create { .. })).count(), 20);
}

#[test]
fn moved_file_does_not_count_towards_total_bytes() {
    let mut tree: Vec<TreeEntry> = (0..20).map(|i| e_sized(&format!("p{i:02}.md"), &format!("P{i}"), MIB)).collect();
    tree.push(e_sized("zz.md", "M", MIB));
    let actions = plan(&[t("n1", "old.md", "M", false)], &tree, &none(), false);
    assert_eq!(actions.len(), 21);
    assert!(actions.iter().all(|a| !matches!(a, Action::Skip { .. })), "{actions:?}");
}

#[test]
fn too_large_move_stays_tracked_and_is_skipped() {
    let actions = plan(&[t("n1", "old.md", "M", false)], &[e_sized("new.md", "M", MIB + 1)], &none(), false);
    assert_eq!(actions, vec![skip("new.md", SkipReason::TooLarge)]);
}

// Output order does not depend on input order.

#[test]
fn result_is_independent_of_input_order() {
    let tracked = vec![
        t("n1", "a.md", "X", false),
        t("n2", "b.md", "Y", true),
        t("n3", "c.md", "Z", false),
        t("n4", "d.md", "W", false),
    ];
    let tree = vec![e("a.md", "X2"), e("e.md", "X"), e("f.md", "Q"), e("g.md", "Q"), e("ign/h.md", "R")];
    let ignored = vec!["ign/h.md".to_string()];
    let base = plan(&tracked, &tree, &ignored, true);

    let mut tracked_rev = tracked.clone();
    tracked_rev.reverse();
    let mut tree_rot = tree.clone();
    tree_rot.rotate_left(2);
    assert_eq!(plan(&tracked_rev, &tree_rot, &ignored, true), base);
    assert_eq!(base.len(), 8, "{base:?}");
}

fn note_of(action: &Action) -> Option<&str> {
    match action {
        Action::Update { note_id, .. }
        | Action::Move { note_id, .. }
        | Action::MarkDeleted { note_id }
        | Action::Trash { note_id } => Some(note_id.as_str()),
        Action::Create { .. } | Action::Skip { .. } => None,
    }
}

proptest! {
    #[test]
    fn plan_is_safe_and_order_independent(
        tracked_spec in prop::collection::vec((0u8..8, 0u8..6, 0u8..4, any::<bool>()), 0..20),
        tree_spec in prop::collection::vec((0u8..8, 0u8..4, 0u64..3_000_000), 0..20),
        ignored_spec in prop::collection::vec(0u8..8, 0..3),
        trash in any::<bool>(),
    ) {
        let tracked: Vec<TrackedFile> = tracked_spec
            .iter()
            .map(|(n, p, b, h)| t(&format!("n{n}"), &format!("p{p}.md"), &format!("b{b}"), *h))
            .collect();
        let tree: Vec<TreeEntry> = tree_spec
            .iter()
            .map(|(p, b, size)| e_sized(&format!("p{p}.md"), &format!("b{b}"), *size))
            .collect();
        let ignored: Vec<String> = ignored_spec.iter().map(|p| format!("p{p}.md")).collect();

        let actions = plan(&tracked, &tree, &ignored, trash);

        let mut notes = BTreeSet::new();
        let mut created = BTreeSet::new();
        for action in &actions {
            if let Some(id) = note_of(action) {
                prop_assert!(notes.insert(id), "note twice: {:?}", actions);
            }
            if let Action::Create { path, .. } = action {
                prop_assert!(created.insert(path.as_str()), "path created twice: {:?}", actions);
            }
        }

        let mut tracked_rev = tracked.clone();
        tracked_rev.reverse();
        let mut tree_rev = tree.clone();
        tree_rev.reverse();
        let mut ignored_rev = ignored.clone();
        ignored_rev.reverse();
        prop_assert_eq!(plan(&tracked_rev, &tree_rev, &ignored_rev, trash), actions);
    }
}
