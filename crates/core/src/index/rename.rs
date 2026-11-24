//! Rewrites the wikilinks of one note after a note or a folder was renamed (Obsidian's "update links").
//! Only the target of a link changes: aliases, headings, blocks and the `!` of an embed stay as written.

use super::parse::wikilink_targets;

/// The text with the links to the note at `old_path` pointed at its new name, or `None` when no link changes.
/// Paths are vault-relative and may end in `.md`. A link written with a path gets the new path. A basename link gets
/// the new basename when `new_basename_unique`, else the new path, since a bare name would then reach another note.
pub fn rename_links(text: &str, old_path: &str, new_path: &str, new_basename_unique: bool) -> Option<String> {
    let old = key(old_path);
    let old_base = old.rsplit('/').next().unwrap_or(old.as_str());
    let new = clean(new_path);
    let new_base = new.rsplit('/').next().unwrap_or(new);
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (at, range) in wikilink_targets(text) {
        // `\[[` is an escaped bracket, not a link (an odd run of backslashes before it)
        let escaped = text.as_bytes()[..at].iter().rev().take_while(|&&b| b == b'\\').count() % 2 == 1;
        let target = &text[range.clone()];
        let name = key(target);
        let bare = !target.contains('/');
        if escaped || !(name == old || (bare && name == old_base)) {
            continue;
        }
        let to = if bare && new_basename_unique { new_base } else { new };
        out.push_str(&text[last..range.start]);
        out.push_str(to);
        out.push_str(md_suffix(target));
        last = range.end;
    }
    out.push_str(&text[last..]);
    (out != text).then_some(out)
}

/// The path without surrounding `/` and without `.md` (any case). The case is kept.
fn clean(path: &str) -> &str {
    let p = path.trim_matches('/');
    if p.len() >= 3 && p.get(p.len() - 3..).is_some_and(|end| end.eq_ignore_ascii_case(".md")) {
        &p[..p.len() - 3]
    } else {
        p
    }
}

/// Lowercase form of `clean`, which is how link targets and note paths are compared.
fn key(path: &str) -> String {
    clean(path).to_lowercase()
}

/// `.md` when the link or path ended in it, so the rewrite keeps the same form.
fn md_suffix(path: &str) -> &'static str {
    if clean(path).len() != path.trim_matches('/').len() { ".md" } else { "" }
}
