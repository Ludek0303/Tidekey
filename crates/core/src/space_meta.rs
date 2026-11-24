use std::collections::HashSet;

use crate::space::NoteId;

/// Key for "same path" checks. Lowercase, so "a.md" and "A.md" collide on every platform.
/// shortcut: no NFC/NFD normalization, so names that differ only in Unicode form (macOS stores
/// decomposed names) are not seen as duplicates. Upgrade with a normalization crate if that shows up.
pub(crate) fn key(path: &str) -> String {
    path.to_lowercase()
}

/// Gives every live note a unique path. For equal keys the smallest id keeps its path; the others
/// get " (2)", " (3)"... in id order. Pure, so every device computes the same names.
pub(crate) fn resolve_duplicates(live: Vec<(NoteId, String)>) -> Vec<(NoteId, String)> {
    // the common case: no two live notes share a key, so nothing is renamed
    let mut seen = HashSet::with_capacity(live.len());
    if live.iter().all(|(_, path)| seen.insert(key(path))) {
        return live;
    }
    let mut sorted = live;
    sorted.sort();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(sorted.len());
    let mut losers = Vec::new();
    for (id, path) in sorted {
        if claimed.insert(key(&path)) {
            out.push((id, path));
        } else {
            losers.push((id, path));
        }
    }
    // winners are all claimed before any loser picks a name, so a loser never steals a winner's path
    for (id, path) in losers {
        let name = free_name(&path, |c| claimed.contains(&key(c)));
        claimed.insert(key(&name));
        out.push((id, name));
    }
    out
}

/// First "<stem> (n).md" next to `path` (n = 2, 3, ...) for which `is_taken` is false.
/// Works on '/'-separated strings only, so every platform produces the same name.
pub(crate) fn free_name<F: Fn(&str) -> bool>(path: &str, is_taken: F) -> String {
    let (dir, file) = match path.rsplit_once('/') {
        Some((d, f)) => (format!("{d}/"), f),
        None => (String::new(), path),
    };
    let stem = file.strip_suffix(".md").unwrap_or(file);
    (2..)
        .map(|n| format!("{dir}{stem} ({n}).md"))
        .find(|candidate| !is_taken(candidate))
        .expect("an unbounded counter always finds a free name")
}

/// Names Windows cannot create, with or without an extension (`CON.md` included), in any case.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Relative note path: '/'-separated plain segments, ends in ".md", never inside ".notes-sync".
/// A pure string check, so every platform refuses what Windows cannot store: reserved device names,
/// the characters <>:"|?* and control characters, and a segment ending in a dot or space.
// shortcut: a note whose stored path already breaks these rules is hidden from notes(), its file is left alone; before the first release, rename such notes on open to a safe name (free_name)
pub fn is_valid_path(rel: &str) -> bool {
    if rel.is_empty() || rel.starts_with('/') || rel.contains(['\\', ':', '\0']) {
        return false;
    }
    let segments: Vec<&str> = rel.split('/').collect();
    let plain = segments.iter().all(|s| plain_segment(s));
    let not_sync = !segments[0].eq_ignore_ascii_case(".notes-sync");
    let last = segments[segments.len() - 1];
    plain && not_sync && last.len() > ".md".len() && last.ends_with(".md")
}

fn plain_segment(seg: &str) -> bool {
    let reserved = {
        let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
        RESERVED.contains(&stem.as_str())
    };
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && !seg.ends_with(['.', ' '])
        && !seg.contains(['<', '>', ':', '"', '|', '?', '*', '\\'])
        && !seg.chars().any(char::is_control)
        && !reserved
}

/// True when one path lies inside the other (same path, or a directory of the other's name): a note
/// cannot be a file at `a.md` and a folder at `a.md/` in the same space.
pub(crate) fn conflicts(a: &str, b: &str) -> bool {
    let (a, b) = (key(a), key(b));
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}
