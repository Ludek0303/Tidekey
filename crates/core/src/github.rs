//! GitHub projects (docs/GITHUB.md): reading addresses, checking files and merging texts. Pure logic, no network.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

/// A repository address taken from a URL or `owner/repo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
    pub git_ref: Option<String>,
    pub path: String,
}

/// Reads `https://github.com/o/r`, `o/r`, `.../tree/ref/dir` and `.../blob/ref/dir/file.md`.
/// Returns `None` for anything else, including other hosts.
pub fn parse_repo_url(input: &str) -> Option<RepoRef> {
    let s = input.trim().split(['?', '#']).next()?;
    let (scheme_given, rest) = match s.split_once("://") {
        Some((scheme, rest)) => {
            if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
                return None;
            }
            (true, rest)
        }
        None => (false, s),
    };
    let (first, after_first) = rest.split_once('/')?;
    let body = if first.eq_ignore_ascii_case("github.com") || first.eq_ignore_ascii_case("www.github.com") {
        after_first
    } else if scheme_given || first.contains('.') {
        // another host; a bare `owner` never contains a dot on GitHub
        return None;
    } else {
        rest
    };
    let segs: Vec<&str> = body.trim_end_matches('/').split('/').collect();
    if segs.iter().any(|seg| seg.is_empty()) {
        return None;
    }
    let owner = *segs.first()?;
    let repo_raw = *segs.get(1)?;
    let repo = repo_raw.strip_suffix(".git").unwrap_or(repo_raw);
    if !valid_name(owner) || owner.starts_with('.') || !valid_name(repo) {
        return None;
    }
    let (git_ref, dirs): (Option<&str>, &[&str]) = match segs.get(2..).unwrap_or(&[]) {
        [] => (None, &[]),
        ["tree", r, dirs @ ..] => (Some(*r), dirs),
        ["blob", r, dirs @ .., _file] => (Some(*r), dirs),
        _ => return None,
    };
    if let Some(r) = git_ref
        && !safe_segment(r)
    {
        return None;
    }
    let path = clean_path(&dirs.join("/"))?.join("/");
    Some(RepoRef {
        owner: owner.to_string(),
        repo: repo.to_string(),
        git_ref: git_ref.map(str::to_string),
        path,
    })
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A path segment that may be used: no `..`, no `.git` prefix, no `\`, `:` or control characters.
fn safe_segment(seg: &str) -> bool {
    !seg.contains("..")
        && !seg.starts_with(".git")
        && !seg.chars().any(|c| c == '\\' || c == ':' || c.is_control())
}

/// Splits a relative path into safe segments; empty and `.` segments are dropped.
/// `None` for absolute paths or any unsafe segment.
fn clean_path(path: &str) -> Option<Vec<&str>> {
    if path.starts_with('/') {
        return None;
    }
    let mut out = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            _ if !safe_segment(seg) => return None,
            _ => out.push(seg),
        }
    }
    Some(out)
}

/// The git blob id of `bytes`: sha1 over `blob <len>\0` and the content.
pub fn git_blob_sha1(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// The path of a repository file relative to the target folder `repo_path`, or `None` when it lies outside
/// that folder, is not allowed, or is the folder itself.
pub fn normalize_repo_path(path: &str, repo_path: &str) -> Option<String> {
    let base = clean_path(repo_path)?;
    let segs = clean_path(path)?;
    if segs.get(..base.len()) != Some(base.as_slice()) {
        return None;
    }
    let rest = segs.get(base.len()..)?;
    if rest.is_empty() {
        return None;
    }
    Some(rest.join("/"))
}

/// Files that are synced as notes: `.md`, `.markdown` and `README` without an extension.
pub fn is_markdown(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("").to_lowercase();
    name == "readme" || name.ends_with(".md") || name.ends_with(".markdown")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Merge3 {
    Clean(String),
    Conflict,
}

/// Three-way merge of `base`, `ours` (the note) and `theirs` (the GitHub text), line by line.
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Merge3 {
    match diffy::merge(base, ours, theirs) {
        Ok(merged) => Merge3::Clean(merged),
        Err(_) => Merge3::Conflict,
    }
}

const PERMISSION_KEYS: [&str; 5] = ["osoby:", "grupy:", "prowadzacy:", "prowadzący:", "typ:"];
const PERMISSION_MARKER: &str = "!zaznacza:";

fn line_body(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

/// Removes permission markers that GitHub text must not set: the keys of the frontmatter (with their list
/// continuations) and `!zaznacza:` lines. Returns the text and how many lines were removed.
pub fn strip_permission_markers(text: &str) -> (String, usize) {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    // frontmatter: `---` on the first line (after a BOM) and a closing `---`; 0 when there is none
    let front_end = match lines.first() {
        Some(first) if line_body(first).trim_start_matches('\u{feff}').trim_end() == "---" => lines
            .iter()
            .skip(1)
            .position(|l| line_body(l).trim_end() == "---")
            .map_or(0, |p| p + 1),
        _ => 0,
    };
    let mut out = String::with_capacity(text.len());
    let mut removed = 0;
    let mut in_list = false;
    for (i, line) in lines.iter().enumerate() {
        let body = line_body(line);
        let remove = if i > 0 && i < front_end {
            let trimmed = body.trim_start();
            let lower = trimmed.to_lowercase();
            if PERMISSION_KEYS.iter().any(|k| lower.starts_with(k)) {
                in_list = true;
                true
            } else if in_list && trimmed.starts_with('-') {
                true
            } else {
                in_list = false;
                body.contains(PERMISSION_MARKER)
            }
        } else {
            body.contains(PERMISSION_MARKER)
        };
        if remove {
            removed += 1;
        } else {
            out.push_str(line);
        }
    }
    (out, removed)
}

/// Hashes (first 8 hex characters of sha1) of the lines that are tasks or mention `@name`. The caller compares
/// them with the same lines from the GitHub text, so only the lines the user added count.
pub fn guarded_lines(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| is_task(line) || has_mention(line))
        .map(|line| {
            hex::encode(Sha1::digest(line.trim_end().as_bytes()))
                .chars()
                .take(8)
                .collect()
        })
        .collect()
}

/// A list item with a checkbox: `- [ ]`, `* [x]`, `1. [ ]`, optionally indented.
fn is_task(line: &str) -> bool {
    let t = line.trim_start();
    let after_marker = if let Some(r) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
        r
    } else {
        let digits = t.trim_start_matches(|c: char| c.is_ascii_digit());
        match digits.strip_prefix(". ") {
            Some(r) if digits.len() < t.len() => r,
            _ => return false,
        }
    };
    let mut chars = after_marker.trim_start().chars();
    chars.next() == Some('[')
        && chars.next().is_some()
        && chars.next() == Some(']')
        && chars.next().is_none_or(char::is_whitespace)
}

/// An `@name` mention: a letter after the `@`, and no letter, digit or `._-+%` before it (so `a@example.test` is not one).
fn has_mention(line: &str) -> bool {
    line.char_indices().any(|(i, c)| {
        c == '@'
            && line
                .get(i + 1..)
                .and_then(|rest| rest.chars().next())
                .is_some_and(char::is_alphabetic)
            && line
                .get(..i)
                .and_then(|before| before.chars().next_back())
                .is_none_or(|p| !(p.is_alphanumeric() || "._-+%".contains(p)))
    })
}
