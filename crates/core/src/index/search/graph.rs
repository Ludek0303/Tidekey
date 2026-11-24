//! The map (OCR §4.1, §5.1): nodes and edges between notes, files, tags, people and folders, neighbors, the
//! overview and file search. Every read takes an optional `Scope`. With `Some`, a note or file outside it does not
//! exist for the reader: it is not a node, an edge end, a count or a list entry.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use super::text::normalize;
use super::{Kind, SearchIndex};

/// Mentions kept per source node, after the scope is applied (OCR §4.1).
pub(super) const MENTIONS_PER_NODE: usize = 20;
/// Largest `limit` of `neighbors`.
const NEIGHBORS_MAX: usize = 100;

/// A person's name as the map keys it (`p:<name>`): trimmed, without a leading `@`, normalized like search.
pub fn normalize_name(name: &str) -> String {
    normalize(name.trim().trim_start_matches('@'))
}

/// What a reader may see: notes and files by id. Tags, folders and the people named in visible notes are visible
/// through the notes; `people` (normalized names) are the people the reader may know besides them — with a scope,
/// the index's own `set_people` list is not used (it may hold people of projects outside the scope).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    pub notes: HashSet<String>,
    pub files: HashSet<String>,
    pub people: HashSet<String>,
}

/// `None` is no scope (everything); `Some` shows only what the scope holds.
pub(super) fn visible(scope: Option<&Scope>, kind: Kind, id: &str) -> bool {
    match (scope, kind) {
        (None, _) => true,
        (Some(s), Kind::Note) => s.notes.contains(id),
        (Some(s), Kind::File) => s.files.contains(id),
    }
}

/// Visibility of a node id (`n:`, `f:`), or of a node without a document (always visible).
pub(super) fn node_visible(scope: Option<&Scope>, node: &str) -> bool {
    if let Some(id) = node.strip_prefix("n:") {
        visible(scope, Kind::Note, id)
    } else if let Some(id) = node.strip_prefix("f:") {
        visible(scope, Kind::File, id)
    } else {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EdgeKind {
    /// `[[…]]` or `[text](…md)` from one note to another.
    Link,
    /// `![[plik:<id>…]]`, note to file.
    Embed,
    /// `#tag` or `tags:`, note to tag.
    Tag,
    /// A task with `@person`, or `osoby:` / `prowadzacy:` in the front matter, note to person.
    Assigned,
    /// Note to its folder.
    In,
    /// The text of a note or file contains another note's title or a person's name, with no link.
    Mention,
}

impl EdgeKind {
    pub fn name(self) -> &'static str {
        match self {
            EdgeKind::Link => "link",
            EdgeKind::Embed => "embed",
            EdgeKind::Tag => "tag",
            EdgeKind::Assigned => "assigned",
            EdgeKind::In => "in",
            EdgeKind::Mention => "mention",
        }
    }

    pub fn parse(s: &str) -> Option<EdgeKind> {
        Some(match s {
            "link" => EdgeKind::Link,
            "embed" => EdgeKind::Embed,
            "tag" => EdgeKind::Tag,
            "assigned" => EdgeKind::Assigned,
            "in" => EdgeKind::In,
            "mention" => EdgeKind::Mention,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Note,
    File,
    Tag,
    Person,
    Folder,
}

impl NodeKind {
    pub fn name(self) -> &'static str {
        match self {
            NodeKind::Note => "note",
            NodeKind::File => "file",
            NodeKind::Tag => "tag",
            NodeKind::Person => "person",
            NodeKind::Folder => "folder",
        }
    }
}

/// `n:<id>`, `f:<id>`, `t:<tag>`, `p:<name>` or `d:<path>`. The label is the note path, file name, tag, name or folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Neighbors {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Some neighbors were left out because of `limit`.
    pub truncated: bool,
}

/// Edges of some kinds and the nodes at their ends (`SearchIndex::edges`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeSet {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hub {
    pub id: String,
    pub title: String,
    pub degree: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapOverview {
    /// Folder path and the number of visible notes in it.
    pub folders: Vec<(String, usize)>,
    pub top_tags: Vec<(String, usize)>,
    pub people: Vec<(String, usize)>,
    pub hubs: Vec<Hub>,
    pub files_with_text: usize,
    pub files_total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    pub mime: String,
    /// "text", "none", "pending" or "error".
    pub text_state: String,
    pub pages: usize,
    /// Visible notes that embed the file.
    pub embedded_in: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePage {
    pub files: Vec<FileInfo>,
    /// All matching files, not only this page.
    pub total: usize,
}

/// State of a file that is not necessarily text-indexed (set with `set_file`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileMeta {
    pub name: String,
    pub mime: String,
    pub state: String,
}

#[derive(Default)]
pub(super) struct Graph {
    pub nodes: BTreeMap<String, Node>,
    pub edges: Vec<Edge>,
}

impl Graph {
    fn node(&mut self, id: &str, kind: NodeKind, label: &str) {
        self.nodes.entry(id.to_string()).or_insert_with(|| Node { id: id.to_string(), kind, label: label.to_string() });
    }

    fn edge(&mut self, from: &str, to: &str, kind: EdgeKind) {
        self.edges.push(Edge { from: from.to_string(), to: to.to_string(), kind });
    }
}

/// `![[plik:<32 hex>…]]` ids in a note, in order (OCR §4.1, mirrors `FILE_EMBED` in ui/src/filestore.ts).
pub(super) fn embedded_files(text: &str) -> Vec<String> {
    const PREFIX: &str = "![[plik:";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(PREFIX) {
        rest = &rest[at + PREFIX.len()..];
        let id = &rest[..rest.len().min(32)];
        let hex = id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if hex && matches!(rest.as_bytes().get(32), Some(b'#' | b'|' | b']')) {
            out.push(id.to_string());
        }
    }
    out
}

/// Names from `osoby:` and `prowadzacy:` (comma list, brackets and `@` allowed), normalized.
pub(super) fn people_in_props(props: &[(String, String)]) -> Vec<String> {
    props
        .iter()
        .filter(|(k, _)| k == "osoby" || k == "prowadzacy")
        .flat_map(|(_, v)| {
            v.trim().trim_start_matches('[').trim_end_matches(']').split(',').map(|s| normalize(s.trim().trim_start_matches('@').trim())).collect::<Vec<_>>()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

impl SearchIndex {
    /// Notes that `note_id` links to (its outgoing links, as the caller resolved them from the space index).
    pub fn set_links(&mut self, note_id: &str, targets: &[String]) {
        if targets.is_empty() {
            self.links.remove(note_id);
        } else {
            self.links.insert(note_id.to_string(), targets.to_vec());
        }
        self.invalidate();
    }

    /// Names that count as people even when no task mentions them (normalized, `@` dropped).
    pub fn set_people(&mut self, names: &[String]) {
        self.people = names.iter().map(|n| normalize_name(n)).filter(|n| !n.is_empty()).collect();
        self.invalidate();
    }

    /// Name, type and text state of a file. `state` is "text", "none", "pending" or "error" (anything else is "none").
    pub fn set_file(&mut self, file_id: &str, name: &str, mime: &str, state: &str) {
        let state = match state {
            "text" | "none" | "pending" | "error" => state,
            _ => "none",
        };
        let meta = FileMeta { name: name.to_string(), mime: mime.to_lowercase(), state: state.to_string() };
        self.file_meta.insert(file_id.to_string(), meta);
    }

    /// The graph of what `scope` shows. Mentions come from the cache, filtered and capped here.
    pub(super) fn build_graph(&self, scope: Option<&Scope>) -> Graph {
        let mut g = Graph::default();
        for (id, doc) in &self.notes {
            if !visible(scope, Kind::Note, id) {
                continue;
            }
            let n = format!("n:{id}");
            g.node(&n, NodeKind::Note, &doc.path);
            let folder = format!("d:{}", doc.folder);
            g.node(&folder, NodeKind::Folder, &doc.folder);
            g.edge(&n, &folder, EdgeKind::In);
            for t in &doc.tags {
                let tag = format!("t:{t}");
                g.node(&tag, NodeKind::Tag, t);
                g.edge(&n, &tag, EdgeKind::Tag);
            }
            for p in &doc.assignees {
                let person = format!("p:{p}");
                g.node(&person, NodeKind::Person, p);
                g.edge(&n, &person, EdgeKind::Assigned);
            }
            for f in &doc.embeds {
                if let (true, Some(meta)) = (visible(scope, Kind::File, f), self.file_meta.get(f)) {
                    let file = format!("f:{f}");
                    g.node(&file, NodeKind::File, &meta.name);
                    g.edge(&n, &file, EdgeKind::Embed);
                }
            }
            for t in self.links.get(id).into_iter().flatten() {
                if self.notes.contains_key(t) && visible(scope, Kind::Note, t) {
                    g.edge(&n, &format!("n:{t}"), EdgeKind::Link);
                }
            }
        }
        for (fid, meta) in &self.file_meta {
            if visible(scope, Kind::File, fid) {
                g.node(&format!("f:{fid}"), NodeKind::File, &meta.name);
            }
        }
        let cache = self.mentions();
        for (source, list) in cache.by_source.iter() {
            if !node_visible(scope, source) {
                continue;
            }
            let targets = list.iter().map(|m| cache.targets[m.target as usize].as_str());
            // a person counts only when the reader can know them: set with `set_people` or named in a note in the scope
            let listed = |p: &str| scope.map_or_else(|| self.people.contains(p), |s| s.people.contains(p));
            let known = |t: &str| t.strip_prefix("p:").is_none_or(|p| listed(p) || g.nodes.contains_key(t));
            let targets: Vec<&str> = targets.filter(|t| node_visible(scope, t) && known(t)).take(MENTIONS_PER_NODE).collect();
            for target in targets {
                if let Some(person) = target.strip_prefix("p:") {
                    g.node(target, NodeKind::Person, person);
                }
                g.edge(source, target, EdgeKind::Mention);
            }
        }
        g
    }

    /// Neighbors of a node within `depth` (at most 2) steps, along `types` (None = all kinds), at most `limit`
    /// (at most 100) nodes besides the start. `None` when the node does not exist or is outside the scope.
    pub fn neighbors(
        &self,
        id: &str,
        depth: usize,
        types: Option<&[EdgeKind]>,
        limit: usize,
        scope: Option<&Scope>,
    ) -> Option<Neighbors> {
        let g = self.build_graph(scope);
        // a bare note or file id (as hits and hubs give it) is that document's node
        let prefixed = ["n:", "f:", "t:", "p:", "d:"].iter().any(|p| id.starts_with(p));
        let id = if prefixed { id.to_string() } else { [format!("n:{id}"), format!("f:{id}")].into_iter().find(|n| g.nodes.contains_key(n))? };
        let id = id.as_str();
        if !g.nodes.contains_key(id) {
            return None;
        }
        let limit = limit.min(NEIGHBORS_MAX);
        let allowed = |k: EdgeKind| types.is_none_or(|t| t.contains(&k));
        let mut adj: BTreeMap<&str, Vec<&Edge>> = BTreeMap::new();
        for e in g.edges.iter().filter(|e| allowed(e.kind)) {
            adj.entry(e.from.as_str()).or_default().push(e);
            adj.entry(e.to.as_str()).or_default().push(e);
        }
        let mut seen: BTreeSet<String> = BTreeSet::from([id.to_string()]);
        let mut frontier = vec![id.to_string()];
        let mut truncated = false;
        for _ in 0..depth.min(2) {
            let mut next = Vec::new();
            for node in &frontier {
                for e in adj.get(node.as_str()).into_iter().flatten() {
                    let other = if e.from == *node { &e.to } else { &e.from };
                    if seen.contains(other) {
                        continue;
                    }
                    if seen.len() > limit {
                        truncated = true;
                        continue;
                    }
                    seen.insert(other.clone());
                    next.push(other.clone());
                }
            }
            frontier = next;
        }
        let nodes = seen.iter().filter_map(|n| g.nodes.get(n).cloned()).collect();
        let edges = g.edges.iter().filter(|e| allowed(e.kind) && seen.contains(&e.from) && seen.contains(&e.to)).cloned().collect();
        Some(Neighbors { nodes, edges, truncated })
    }

    /// The edges of `types` (None = all kinds) that `scope` shows, with the nodes at their ends (OCR §4.4, the graph
    /// view). Mentions are already filtered and capped by `build_graph`.
    pub fn edges(&self, types: Option<&[EdgeKind]>, scope: Option<&Scope>) -> EdgeSet {
        let g = self.build_graph(scope);
        let edges: Vec<Edge> = g.edges.into_iter().filter(|e| types.is_none_or(|t| t.contains(&e.kind))).collect();
        let ends: BTreeSet<&str> = edges.iter().flat_map(|e| [e.from.as_str(), e.to.as_str()]).collect();
        let nodes = ends.into_iter().filter_map(|n| g.nodes.get(n).cloned()).collect();
        EdgeSet { nodes, edges }
    }

    /// The overview of what `scope` shows: folders, the most used tags, people, the most connected notes and file
    /// counts.
    pub fn map_overview(&self, scope: Option<&Scope>) -> MapOverview {
        let g = self.build_graph(scope);
        let mut folders: BTreeMap<String, usize> = BTreeMap::new();
        for (id, doc) in &self.notes {
            if visible(scope, Kind::Note, id) {
                *folders.entry(doc.folder.clone()).or_default() += 1;
            }
        }
        let mut tags: BTreeMap<String, usize> = BTreeMap::new();
        let mut people_pairs: BTreeSet<(&str, &str)> = BTreeSet::new();
        let mut degree: BTreeMap<&str, usize> = BTreeMap::new();
        for e in &g.edges {
            match e.kind {
                EdgeKind::Tag => *tags.entry(e.to.clone()).or_default() += 1,
                EdgeKind::Assigned | EdgeKind::Mention if e.to.starts_with("p:") => {
                    people_pairs.insert((e.from.as_str(), e.to.as_str()));
                }
                _ => {}
            }
            for end in [e.from.as_str(), e.to.as_str()] {
                if g.nodes.get(end).is_some_and(|n| n.kind == NodeKind::Note) {
                    *degree.entry(end).or_default() += 1;
                }
            }
        }
        let mut people: BTreeMap<&str, usize> = BTreeMap::new();
        for (_, p) in &people_pairs {
            *people.entry(p).or_default() += 1;
        }
        let mut top_tags: Vec<(String, usize)> = tags
            .into_iter()
            .map(|(id, n)| (id.strip_prefix("t:").unwrap_or(&id).to_string(), n))
            .collect();
        top_tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top_tags.truncate(20);
        let mut top_people: Vec<(String, usize)> =
            people.into_iter().map(|(id, n)| (id.strip_prefix("p:").unwrap_or(id).to_string(), n)).collect();
        top_people.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top_people.truncate(20);
        let mut hubs: Vec<Hub> = degree
            .into_iter()
            .map(|(node, d)| {
                let id = node.strip_prefix("n:").unwrap_or(node).to_string();
                let title = g.nodes.get(node).map(|n| n.label.clone()).unwrap_or_default();
                Hub { id, title, degree: d }
            })
            .collect();
        hubs.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| a.id.cmp(&b.id)));
        hubs.truncate(10);
        let visible_files: Vec<&FileMeta> =
            self.file_meta.iter().filter(|(id, _)| visible(scope, Kind::File, id)).map(|(_, m)| m).collect();
        MapOverview {
            folders: folders.into_iter().collect(),
            top_tags,
            people: top_people,
            hubs,
            files_with_text: visible_files.iter().filter(|m| m.state == "text").count(),
            files_total: visible_files.len(),
        }
    }

    /// Files a reader may see, filtered by `q` (part of the normalized name), `typ` ("pdf", "obraz" for images, or a
    /// part of the mime type), and `folder` (a folder of an embedding note, by prefix). Sorted by name.
    pub fn find_files(
        &self,
        q: Option<&str>,
        typ: Option<&str>,
        folder: Option<&str>,
        limit: usize,
        offset: usize,
        scope: Option<&Scope>,
    ) -> FilePage {
        let mut embedded: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut folder_of: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        for (id, doc) in &self.notes {
            if !visible(scope, Kind::Note, id) {
                continue;
            }
            for f in &doc.embeds {
                embedded.entry(f.as_str()).or_default().push(id.as_str());
                folder_of.entry(f.as_str()).or_default().push(normalize(&doc.folder));
            }
        }
        let q = q.map(normalize).filter(|s| !s.is_empty());
        let folder = folder.map(normalize).filter(|s| !s.is_empty());
        let mut files: Vec<FileInfo> = self
            .file_meta
            .iter()
            .filter(|(id, _)| visible(scope, Kind::File, id))
            .filter(|(_, m)| q.as_ref().is_none_or(|q| normalize(&m.name).contains(q.as_str())))
            .filter(|(_, m)| typ.is_none_or(|t| mime_matches(&m.mime, t)))
            .filter(|(id, _)| {
                folder.as_ref().is_none_or(|f| folder_of.get(id.as_str()).is_some_and(|fs| fs.iter().any(|d| d.starts_with(f.as_str()))))
            })
            .map(|(id, m)| FileInfo {
                id: id.clone(),
                name: m.name.clone(),
                mime: m.mime.clone(),
                text_state: m.state.clone(),
                pages: self.files.get(id).map_or(0, |d| d.pages.len()),
                embedded_in: embedded.get(id.as_str()).into_iter().flatten().map(|s| s.to_string()).collect(),
            })
            .collect();
        files.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        let total = files.len();
        let files = files.into_iter().skip(offset).take(limit.min(super::query::MAX_PAGE)).collect();
        FilePage { files, total }
    }
}

/// `pdf` matches PDF files, `obraz` any image, anything else part of the mime type.
fn mime_matches(mime: &str, typ: &str) -> bool {
    match normalize(typ).as_str() {
        "pdf" => mime == "application/pdf",
        "obraz" => mime.starts_with("image/"),
        t => mime.contains(t),
    }
}

