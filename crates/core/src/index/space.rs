//! Space-wide index. Each link is resolved once and the result is kept, so backlinks are a
//! reverse-map lookup. A link only needs re-resolving when a note with the same basename
//! appears, disappears or moves, so `by_key` finds exactly those links.

use super::parse::parse_note;
use super::{Heading, Link, NoteIndex, Task};
use crate::NoteId;
use std::collections::{BTreeMap, BTreeSet, HashMap};

struct Entry {
    path: String,
    index: NoteIndex,
    /// Resolved note for each link, same order as `index.links`.
    resolved: Vec<Option<NoteId>>,
}

/// A link with the note it points to; `target` is `None` for a ghost link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLink {
    pub link: Link,
    pub target: Option<NoteId>,
}

/// Filters for [`SpaceIndex::tasks`]. `due_after` and `due_before` are inclusive and
/// exclude tasks without a due date. `path_prefix` is a folder, matched case-insensitively.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskQuery {
    pub assignee: Option<String>,
    pub done: Option<bool>,
    pub due_before: Option<i32>,
    pub due_after: Option<i32>,
    pub path_prefix: Option<String>,
}

#[derive(Default)]
pub struct SpaceIndex {
    notes: HashMap<NoteId, Entry>,
    /// Lowercase basename -> (name length, lowercase name without `.md`, note).
    /// Sorted, so the first match is the shortest path, then lexicographic.
    by_base: BTreeMap<String, BTreeSet<(usize, String, NoteId)>>,
    /// Basename key of a link target -> links (note, index) that use it.
    by_key: HashMap<String, BTreeSet<(NoteId, usize)>>,
    /// Note -> links (note, index) that resolve to it.
    inbound: HashMap<NoteId, BTreeSet<(NoteId, usize)>>,
}

/// Lowercase, without `.md` and leading/trailing `/`. Link targets and note paths both go through this.
fn name_of(path: &str) -> String {
    let lower = path.to_lowercase();
    lower
        .strip_suffix(".md")
        .unwrap_or(&lower)
        .trim_matches('/')
        .to_string()
}

fn base_of(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// `target` joined to the folder `dir`, with `.` and `..` resolved. `None` if it climbs above the root.
fn join_relative(dir: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

fn link_key(target: &str) -> String {
    base_of(&name_of(target)).to_string()
}

impl SpaceIndex {
    /// Adds or replaces a note. Its links and name are re-indexed; only the links that
    /// depend on the changed basename are re-resolved.
    pub fn upsert(&mut self, id: NoteId, path: &str, text: &str) {
        let index = parse_note(text);
        let old = self.notes.remove(&id);
        let mut bases = Vec::new();
        if let Some(old) = &old {
            self.unlink(&id, old);
            if old.path != path {
                self.unname(&id, &old.path);
                bases.push(base_of(&name_of(&old.path)).to_string());
            }
        }
        if old.as_ref().is_none_or(|o| o.path != path) {
            self.name(&id, path);
            bases.push(base_of(&name_of(path)).to_string());
        }
        for (i, link) in index.links.iter().enumerate() {
            self.by_key
                .entry(link_key(&link.target))
                .or_default()
                .insert((id.clone(), i));
        }
        let resolved = vec![None; index.links.len()];
        self.notes.insert(
            id.clone(),
            Entry {
                path: path.to_string(),
                index,
                resolved,
            },
        );
        for i in 0..self.notes[&id].resolved.len() {
            self.resolve_link(&id, i);
        }
        for base in bases {
            self.reresolve(&base);
        }
    }

    pub fn remove(&mut self, id: &NoteId) {
        let Some(old) = self.notes.remove(id) else {
            return;
        };
        self.unlink(id, &old);
        self.unname(id, &old.path);
        // Links that pointed here now point nowhere; their key is this note's basename.
        self.inbound.remove(id);
        self.reresolve(base_of(&name_of(&old.path)));
    }

    /// Moves a note to a new path. Links to the old and new basename are re-resolved.
    pub fn rename(&mut self, id: &NoteId, new_path: &str) {
        let Some(entry) = self.notes.get_mut(id) else {
            return;
        };
        if entry.path == new_path {
            return;
        }
        let old_path = std::mem::replace(&mut entry.path, new_path.to_string());
        let count = entry.index.links.len();
        self.unname(id, &old_path);
        self.name(id, new_path);
        self.reresolve(base_of(&name_of(&old_path)));
        self.reresolve(base_of(&name_of(new_path)));
        // Relative links depend on the note's own folder.
        for i in 0..count {
            self.resolve_link(id, i);
        }
    }

    /// Outgoing links of a note in source order. Empty for an unknown note.
    pub fn outgoing(&self, id: &NoteId) -> Vec<ResolvedLink> {
        let Some(entry) = self.notes.get(id) else {
            return Vec::new();
        };
        entry
            .index
            .links
            .iter()
            .zip(&entry.resolved)
            .map(|(link, target)| ResolvedLink {
                link: link.clone(),
                target: target.clone(),
            })
            .collect()
    }

    /// Links that resolve to `id`, ordered by source note and position.
    pub fn backlinks(&self, id: &NoteId) -> Vec<(NoteId, Link)> {
        let Some(set) = self.inbound.get(id) else {
            return Vec::new();
        };
        set.iter()
            .filter_map(|(src, i)| {
                Some((
                    src.clone(),
                    self.notes.get(src)?.index.links.get(*i)?.clone(),
                ))
            })
            .collect()
    }

    /// Ghost links: target name (lowercase, without `.md`, the smallest spelling seen) with the notes that use it.
    pub fn unresolved(&self) -> Vec<(String, Vec<NoteId>)> {
        let mut groups: BTreeMap<String, (String, BTreeSet<NoteId>)> = BTreeMap::new();
        for (id, entry) in &self.notes {
            for (link, target) in entry.index.links.iter().zip(&entry.resolved) {
                if target.is_none() {
                    let g = groups
                        .entry(name_of(&link.target))
                        .or_insert_with(|| (String::new(), BTreeSet::new()));
                    if g.0.is_empty() || link.target < g.0 {
                        g.0 = link.target.clone();
                    }
                    g.1.insert(id.clone());
                }
            }
        }
        groups
            .into_iter()
            .map(|(_, (target, ids))| (target, ids.into_iter().collect()))
            .collect()
    }

    /// Tags with the number of notes carrying them. `a/b` also counts for `a`. Sorted by name.
    pub fn tags(&self) -> Vec<(String, usize)> {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for entry in self.notes.values() {
            let mut expanded = BTreeSet::new();
            for tag in &entry.index.tags {
                for (i, c) in tag.char_indices() {
                    if c == '/' {
                        expanded.insert(tag[..i].to_string());
                    }
                }
                expanded.insert(tag.clone());
            }
            for tag in expanded {
                *counts.entry(tag).or_default() += 1;
            }
        }
        counts.into_iter().collect()
    }

    /// Notes with `tag` or a child of it (`a` includes `a/b`), sorted.
    pub fn notes_with_tag(&self, tag: &str) -> Vec<NoteId> {
        let tag = tag.trim_matches(|c| c == '#' || c == '/').to_lowercase();
        let mut ids: Vec<NoteId> = self
            .notes
            .iter()
            .filter(|(_, e)| {
                e.index.tags.iter().any(|t| {
                    t == &tag
                        || t.strip_prefix(tag.as_str())
                            .is_some_and(|r| r.starts_with('/'))
                })
            })
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Path and parsed index of a note, `None` if it is not indexed.
    pub fn note(&self, id: &NoteId) -> Option<(&str, &NoteIndex)> {
        self.notes.get(id).map(|e| (e.path.as_str(), &e.index))
    }

    pub fn headings(&self, id: &NoteId) -> &[Heading] {
        match self.notes.get(id) {
            Some(e) => &e.index.headings,
            None => &[],
        }
    }

    /// Every note id, sorted. Cheaper than `graph`, which also resolves the links.
    pub fn note_ids(&self) -> Vec<NoteId> {
        let mut ids: Vec<NoteId> = self.notes.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// All notes (sorted) and the resolved links between them, without duplicates or self-loops.
    pub fn graph(&self) -> (Vec<NoteId>, Vec<(NoteId, NoteId)>) {
        let mut nodes: Vec<NoteId> = self.notes.keys().cloned().collect();
        nodes.sort();
        let mut edges = BTreeSet::new();
        for (src, entry) in &self.notes {
            for dst in entry.resolved.iter().flatten() {
                if dst != src {
                    edges.insert((src.clone(), dst.clone()));
                }
            }
        }
        (nodes, edges.into_iter().collect())
    }

    /// Tasks matching `q`, sorted by due date (none last), path and line.
    pub fn tasks(&self, q: &TaskQuery) -> Vec<(NoteId, Task)> {
        let assignee = q.assignee.as_ref().map(|a| a.to_lowercase());
        let prefix = q
            .path_prefix
            .as_deref()
            .map(|p| p.trim_end_matches('/').to_lowercase())
            .filter(|p| !p.is_empty());
        let mut out = Vec::new();
        for (id, entry) in &self.notes {
            if let Some(p) = &prefix {
                let inside = entry
                    .path
                    .to_lowercase()
                    .strip_prefix(p.as_str())
                    .is_some_and(|r| r.starts_with('/'));
                if !inside {
                    continue;
                }
            }
            for task in &entry.index.tasks {
                if assignee
                    .as_ref()
                    .is_some_and(|a| !task.assignees.iter().any(|x| x.to_lowercase() == *a))
                {
                    continue;
                }
                if q.done.is_some_and(|d| d != task.done) {
                    continue;
                }
                if q.due_before
                    .is_some_and(|b| !task.due.is_some_and(|d| d <= b))
                {
                    continue;
                }
                if q.due_after
                    .is_some_and(|a| !task.due.is_some_and(|d| d >= a))
                {
                    continue;
                }
                out.push((
                    task.due,
                    entry.path.as_str(),
                    task.line,
                    id.clone(),
                    task.clone(),
                ));
            }
        }
        out.sort_by(|a, b| (a.0.is_none(), a.0, a.1, a.2).cmp(&(b.0.is_none(), b.0, b.1, b.2)));
        out.into_iter()
            .map(|(_, _, _, id, task)| (id, task))
            .collect()
    }

    /// Removes the note's links from the link maps and clears what it resolved to.
    fn unlink(&mut self, id: &NoteId, old: &Entry) {
        for (i, link) in old.index.links.iter().enumerate() {
            let key = link_key(&link.target);
            if let Some(set) = self.by_key.get_mut(&key) {
                set.remove(&(id.clone(), i));
                if set.is_empty() {
                    self.by_key.remove(&key);
                }
            }
        }
        for (i, target) in old.resolved.iter().enumerate() {
            if let Some(set) = target.as_ref().and_then(|t| self.inbound.get_mut(t)) {
                set.remove(&(id.clone(), i));
            }
        }
    }

    fn name(&mut self, id: &NoteId, path: &str) {
        let name = name_of(path);
        let base = base_of(&name).to_string();
        self.by_base
            .entry(base)
            .or_default()
            .insert((name.len(), name, id.clone()));
    }

    fn unname(&mut self, id: &NoteId, path: &str) {
        let name = name_of(path);
        let base = base_of(&name).to_string();
        if let Some(set) = self.by_base.get_mut(&base) {
            set.remove(&(name.len(), name, id.clone()));
            if set.is_empty() {
                self.by_base.remove(&base);
            }
        }
    }

    /// First note whose name is `target` or ends with `/target`, in shortest-path order.
    fn resolve(&self, target: &str) -> Option<NoteId> {
        let name = name_of(target);
        if name.is_empty() {
            return None;
        }
        let base = base_of(&name);
        let set = self.by_base.get(base)?;
        set.iter()
            .find(|(_, n, _)| {
                *n == name
                    || (n.len() > name.len()
                        && n.ends_with(name.as_str())
                        && n.as_bytes()[n.len() - name.len() - 1] == b'/')
            })
            .map(|(_, _, id)| id.clone())
    }

    /// `[text](x.md)` links first try the exact path from the note's folder. A target written
    /// with `./` or `../` stops there (a ghost rather than an unrelated note); any other target
    /// then tries the vault-root path (Obsidian's "absolute path in vault"), then basename/suffix.
    /// Climbing above the root with `..` is a ghost.
    fn resolve_from(&self, src_path: &str, link: &Link) -> Option<NoteId> {
        if !link.md {
            return self.resolve(&link.target);
        }
        let dir = src_path.rfind('/').map_or("", |i| &src_path[..i]);
        let joined = join_relative(dir, &link.target)?;
        if let Some(id) = self.exact(&name_of(&joined)) {
            return Some(id);
        }
        if link.target.starts_with("./") || link.target.starts_with("../") {
            return None;
        }
        self.exact(&name_of(&link.target))
            .or_else(|| self.resolve(&link.target))
    }

    /// The note whose name is exactly `name`, shortest path first.
    fn exact(&self, name: &str) -> Option<NoteId> {
        let set = self.by_base.get(base_of(name))?;
        set.iter()
            .find(|(_, n, _)| n == name)
            .map(|(_, _, id)| id.clone())
    }

    fn resolve_link(&mut self, src: &NoteId, i: usize) {
        let Some(entry) = self.notes.get(src) else {
            return;
        };
        let new = self.resolve_from(&entry.path, &entry.index.links[i]);
        let old = entry.resolved[i].clone();
        if old == new {
            return;
        }
        if let Some(set) = old.as_ref().and_then(|o| self.inbound.get_mut(o)) {
            set.remove(&(src.clone(), i));
        }
        if let Some(n) = &new {
            self.inbound
                .entry(n.clone())
                .or_default()
                .insert((src.clone(), i));
        }
        if let Some(entry) = self.notes.get_mut(src) {
            entry.resolved[i] = new;
        }
    }

    /// Re-resolves every link whose basename key is `base`.
    fn reresolve(&mut self, base: &str) {
        let Some(links) = self.by_key.get(base).cloned() else {
            return;
        };
        for (src, i) in links {
            self.resolve_link(&src, i);
        }
    }
}
