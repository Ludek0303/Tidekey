//! Plan of a GitHub update (docs/GITHUB.md §4): compares the file list of the last applied
//! commit with the new tree. Pure function: no I/O, no tokens, no contents.

use std::collections::{BTreeSet, HashMap, VecDeque};

/// Limits from docs/GITHUB.md §6.
pub const MAX_FILES: usize = 2000;
pub const MAX_FILE_BYTES: u64 = 1_048_576;
pub const MAX_TOTAL_BYTES: u64 = 20 * 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedFile {
    pub note_id: String,
    pub path: String,
    pub blob_sha: String,
    pub has_edits: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub path: String,
    pub blob_sha: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    Ignored,
    TooLarge,
    LimitFiles,
    LimitTotal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Create { path: String, blob_sha: String },
    Update { note_id: String, path: String, blob_sha: String },
    Move { note_id: String, from: String, to: String, blob_sha: String },
    MarkDeleted { note_id: String },
    Trash { note_id: String },
    Skip { path: String, reason: SkipReason },
}

/// Work item for a file that has to be downloaded or kept, sorted by path before the limits apply.
enum Job<'a> {
    Create(&'a TreeEntry),
    Update(&'a TrackedFile, &'a TreeEntry),
    Move(&'a TrackedFile, &'a TreeEntry),
}

impl Job<'_> {
    fn entry(&self) -> &TreeEntry {
        match self {
            Job::Create(e) | Job::Update(_, e) | Job::Move(_, e) => e,
        }
    }
}

pub fn plan(tracked: &[TrackedFile], tree: &[TreeEntry], ignored: &[String], on_delete_trash: bool) -> Vec<Action> {
    // Sort and dedupe first, so the result does not depend on the input order.
    let mut tracked: Vec<&TrackedFile> = tracked.iter().collect();
    tracked.sort_by(|a, b| (&a.note_id, &a.path, &a.blob_sha, a.has_edits).cmp(&(&b.note_id, &b.path, &b.blob_sha, b.has_edits)));
    tracked.dedup_by(|a, b| a.note_id == b.note_id);
    tracked.sort_by(|a, b| (&a.path, &a.note_id).cmp(&(&b.path, &b.note_id)));

    let mut tree: Vec<&TreeEntry> = tree.iter().collect();
    tree.sort_by(|a, b| (&a.path, &a.blob_sha, a.size).cmp(&(&b.path, &b.blob_sha, b.size)));
    tree.dedup_by(|a, b| a.path == b.path);

    let tree_by_path: HashMap<&str, &TreeEntry> = tree.iter().map(|e| (e.path.as_str(), *e)).collect();
    let tracked_paths: BTreeSet<&str> = tracked.iter().map(|t| t.path.as_str()).collect();
    let ignored: BTreeSet<&str> = ignored.iter().map(String::as_str).collect();

    // Tracked files still at their path: unchanged (nothing) or updated; the rest lost their path.
    let mut kept = 0usize;
    let mut jobs: Vec<Job> = Vec::new();
    let mut missing: Vec<&TrackedFile> = Vec::new();
    for &t in &tracked {
        match tree_by_path.get(t.path.as_str()).copied() {
            Some(e) if e.blob_sha == t.blob_sha => kept += 1,
            Some(e) => jobs.push(Job::Update(t, e)),
            None => missing.push(t),
        }
    }

    // Untracked, non-ignored paths grouped by blob: the only possible move targets, in path order.
    // shortcut: a file moved and edited in one commit is seen as delete + create (blob differs); upgrade by comparing content from the archive (docs/GITHUB.md §6a).
    let mut free: HashMap<&str, VecDeque<&TreeEntry>> = HashMap::new();
    for &e in &tree {
        let p = e.path.as_str();
        if !tracked_paths.contains(p) && !ignored.contains(p) {
            free.entry(e.blob_sha.as_str()).or_default().push_back(e);
        }
    }
    let mut deleted: Vec<&TrackedFile> = Vec::new();
    let mut moved: BTreeSet<&str> = BTreeSet::new();
    for t in missing {
        match free.get_mut(t.blob_sha.as_str()).and_then(VecDeque::pop_front) {
            Some(e) => {
                moved.insert(e.path.as_str());
                jobs.push(Job::Move(t, e));
            }
            None => deleted.push(t),
        }
    }

    // Untracked paths that are not moves: new notes, unless ignored.
    let mut skips: Vec<(String, SkipReason)> = Vec::new();
    for &e in &tree {
        let p = e.path.as_str();
        if tracked_paths.contains(p) || moved.contains(p) {
            continue;
        }
        if ignored.contains(p) {
            skips.push((e.path.clone(), SkipReason::Ignored));
        } else {
            jobs.push(Job::Create(e));
        }
    }
    jobs.sort_by(|a, b| a.entry().path.cmp(&b.entry().path));

    // Limits: every file that stays tracked counts; new files and downloads are cut in path order.
    let mut files = kept + jobs.iter().filter(|j| !matches!(j, Job::Create(_))).count();
    let mut bytes: u64 = 0;
    let mut moves_out = Vec::new();
    let mut updates_out = Vec::new();
    let mut creates_out = Vec::new();
    for job in &jobs {
        let e = job.entry();
        if e.size > MAX_FILE_BYTES {
            skips.push((e.path.clone(), SkipReason::TooLarge));
            continue;
        }
        match job {
            Job::Create(_) => {
                if files >= MAX_FILES {
                    skips.push((e.path.clone(), SkipReason::LimitFiles));
                } else if bytes.saturating_add(e.size) > MAX_TOTAL_BYTES {
                    skips.push((e.path.clone(), SkipReason::LimitTotal));
                } else {
                    files += 1;
                    bytes = bytes.saturating_add(e.size);
                    creates_out.push(Action::Create { path: e.path.clone(), blob_sha: e.blob_sha.clone() });
                }
            }
            Job::Update(t, _) => {
                if bytes.saturating_add(e.size) > MAX_TOTAL_BYTES {
                    skips.push((e.path.clone(), SkipReason::LimitTotal));
                } else {
                    bytes = bytes.saturating_add(e.size);
                    updates_out.push(Action::Update { note_id: t.note_id.clone(), path: e.path.clone(), blob_sha: e.blob_sha.clone() });
                }
            }
            Job::Move(t, _) => moves_out.push(Action::Move {
                note_id: t.note_id.clone(),
                from: t.path.clone(),
                to: e.path.clone(),
                blob_sha: e.blob_sha.clone(),
            }),
        }
    }

    // A note whose path vanished and has no move target: its file stays, marked or trashed.
    let deleted_out = deleted.into_iter().map(|t| {
        let note_id = t.note_id.clone();
        if !t.has_edits && on_delete_trash {
            Action::Trash { note_id }
        } else {
            Action::MarkDeleted { note_id }
        }
    });

    skips.sort_by(|a, b| a.0.cmp(&b.0));
    let skips_out = skips.into_iter().map(|(path, reason)| Action::Skip { path, reason });

    moves_out
        .into_iter()
        .chain(updates_out)
        .chain(creates_out)
        .chain(deleted_out)
        .chain(skips_out)
        .collect()
}
