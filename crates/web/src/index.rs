//! Note index for the browser: `SpaceIndex` behind wasm-bindgen. Results are JSON strings,
//! so JS gets plain objects and arrays with proper escaping.

use std::collections::HashMap;

use std::collections::HashSet;

use notes_core::index::{EdgeKind, Kind, NoteIndex, NodeKind, Priority, Scope, SearchIndex, SpaceIndex};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

/// A front matter property (`typ`, `status`) of a note, if it has one.
fn prop<'a>(index: &'a NoteIndex, key: &str) -> Option<&'a str> {
    index.props.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// The note's file name without `.md`.
fn stem(path: &str) -> &str {
    let file = path.rsplit('/').next().unwrap_or(path);
    file.strip_suffix(".md").unwrap_or(file)
}

/// A project note is `typ: projekt`. Its folder's note (`Projekty/Triton/Triton.md`) is found by walking up the
/// folders of `path`, nearest first; the note itself counts first.
fn project_path(path: &str, is_project: impl Fn(&str) -> bool) -> Option<String> {
    if is_project(path) {
        return Some(path.to_string());
    }
    let mut dir = path;
    while let Some(i) = dir.rfind('/') {
        dir = &dir[..i];
        let candidate = format!("{dir}/{}.md", stem(dir));
        if is_project(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[wasm_bindgen]
#[derive(Default)]
pub struct WasmIndex {
    inner: SpaceIndex,
}

#[wasm_bindgen]
impl WasmIndex {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmIndex {
        WasmIndex::default()
    }

    pub fn upsert(&mut self, id: String, path: &str, text: &str) {
        self.inner.upsert(id, path, text);
    }

    pub fn remove(&mut self, id: &str) {
        self.inner.remove(&id.to_string());
    }

    pub fn rename(&mut self, id: &str, path: &str) {
        self.inner.rename(&id.to_string(), path);
    }

    /// `{"nodes":[{"id","path","tags"}],"edges":[[src,dst]],"ghosts":[{"name","from"}]}`
    pub fn graph_json(&self) -> String {
        let (ids, edges) = self.inner.graph();
        let nodes: Vec<Value> = ids
            .iter()
            .filter_map(|id| {
                let (path, index) = self.inner.note(id)?;
                Some(json!({"id": id, "path": path, "tags": index.tags}))
            })
            .collect();
        let ghosts: Vec<Value> = self
            .inner
            .unresolved()
            .into_iter()
            .map(|(name, from)| json!({"name": name, "from": from}))
            .collect();
        json!({"nodes": nodes, "edges": edges, "ghosts": ghosts}).to_string()
    }

    /// `[{"from","path","line","target","alias","heading","block","embed"}]`
    pub fn backlinks_json(&self, id: &str) -> String {
        let rows: Vec<Value> = self
            .inner
            .backlinks(&id.to_string())
            .into_iter()
            .map(|(src, link)| {
                let path = self.inner.note(&src).map_or("", |(p, _)| p);
                json!({
                    "from": src,
                    "path": path,
                    "line": link.line,
                    "target": link.target,
                    "alias": link.alias,
                    "heading": link.heading,
                    "block": link.block,
                    "embed": link.embed,
                })
            })
            .collect();
        Value::Array(rows).to_string()
    }

    /// Same fields as `backlinks_json`, with `to` (target note id or `null` for a ghost) instead of `from`.
    pub fn outgoing_json(&self, id: &str) -> String {
        let rows: Vec<Value> = self
            .inner
            .outgoing(&id.to_string())
            .into_iter()
            .map(|r| {
                json!({
                    "to": r.target,
                    "target": r.link.target,
                    "alias": r.link.alias,
                    "heading": r.link.heading,
                    "block": r.link.block,
                    "embed": r.link.embed,
                    "line": r.link.line,
                })
            })
            .collect();
        Value::Array(rows).to_string()
    }

    /// `[{"tag","count"}]`, sorted by tag.
    pub fn tags_json(&self) -> String {
        let rows: Vec<Value> = self
            .inner
            .tags()
            .into_iter()
            .map(|(tag, count)| json!({"tag": tag, "count": count}))
            .collect();
        Value::Array(rows).to_string()
    }

    /// `{"tasks":[{"note","path","line","depth","done","text","assignees","supervisor","difficulty","due","done_on","priority","block","reminder","stage","project","project_note"}],"warnings":[{"note","path","line","message"}]}`
    /// Days are days since 1970-01-01; `null` when missing. An unrated task has `difficulty` `null`. `reminder` is
    /// `{"before_min","every_min","count"}` or `null`. `project` is the
    /// name of the nearest project note (`project_note` its id), else the name of the task's own note.
    pub fn tasks_json(&self) -> String {
        let ids = self.inner.note_ids();
        let projects = self.project_ids();
        let is_project = |p: &str| projects.contains_key(p);
        let mut tasks = Vec::new();
        let mut warnings = Vec::new();
        for id in &ids {
            let Some((path, index)) = self.inner.note(id) else {
                continue;
            };
            let project = project_path(path, is_project);
            let project_name = project.as_deref().map_or(stem(path), stem).to_string();
            let project_note = project.as_ref().and_then(|p| projects.get(p));
            for t in &index.tasks {
                let priority = t.priority.map(|p| match p {
                    Priority::High => "high",
                    Priority::Medium => "medium",
                    Priority::Low => "low",
                });
                tasks.push(json!({
                    "note": id,
                    "path": path,
                    "line": t.line,
                    "depth": t.depth,
                    "done": t.done,
                    "text": t.text,
                    "assignees": t.assignees,
                    "group_ids": t.groups,
                    "supervisor": t.supervisor,
                    "difficulty": t.difficulty,
                    "due": t.due,
                    "done_on": t.done_on,
                    "priority": priority,
                    "block": t.id,
                    "reminder": t.reminder,
                    "stage": t.stage,
                    "project": project_name,
                    "project_note": project_note,
                }));
            }
            for w in &index.warnings {
                warnings.push(json!({"note": id, "path": path, "line": w.line, "message": w.message}));
            }
        }
        json!({"tasks": tasks, "warnings": warnings}).to_string()
    }

    /// `[{"note","path","name","status","lead"}]`: the project notes (`typ: projekt`), sorted by path.
    /// `status` and `lead` are `null` when the front matter does not give them.
    pub fn projects_json(&self) -> String {
        let ids = self.inner.note_ids();
        let rows: Vec<Value> = ids
            .iter()
            .filter_map(|id| {
                let (path, index) = self.inner.note(id)?;
                (prop(index, "typ") == Some("projekt")).then(|| {
                    json!({
                        "note": id,
                        "path": path,
                        "name": stem(path),
                        "folder": own_folder(path),
                        "status": prop(index, "status"),
                        "lead": prop(index, "prowadzacy"),
                        // assigned in the project note: `osoby: Anna Nowak, Bartek Lis`, `grupy: <group ids>`
                        "people": list_prop(index, "osoby"),
                        "groups": list_prop(index, "grupy"),
                    })
                })
            })
            .collect();
        Value::Array(rows).to_string()
    }

    /// Project note path -> note id, for the notes whose front matter says `typ: projekt`.
    fn project_ids(&self) -> HashMap<String, String> {
        let ids = self.inner.note_ids();
        ids.into_iter()
            .filter_map(|id| {
                let (path, index) = self.inner.note(&id)?;
                (prop(index, "typ") == Some("projekt")).then(|| (path.to_string(), id))
            })
            .collect()
    }

    /// `[{"level","text","line"}]`
    pub fn headings_json(&self, id: &str) -> String {
        let rows: Vec<Value> = self
            .inner
            .headings(&id.to_string())
            .iter()
            .map(|h| json!({"level": h.level, "text": h.text, "line": h.line}))
            .collect();
        Value::Array(rows).to_string()
    }
}

/// A comma-separated front matter value as a list; empty for a missing key.
fn list_prop(index: &NoteIndex, key: &str) -> Vec<String> {
    prop(index, key).map(|v| v.split(',').map(str::trim).filter(|x| !x.is_empty()).map(String::from).collect()).unwrap_or_default()
}

/// The folder a project owns: `Projekty/X` for `Projekty/X/X.md`. None for a project note beside others
/// (`Projekty/X.md`), whose parent folder is not the project's alone.
fn own_folder(path: &str) -> Option<&str> {
    let (folder, file) = path.rsplit_once('/')?;
    (file.strip_suffix(".md")? == folder.rsplit('/').next()?).then_some(folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).expect("valid JSON")
    }

    #[test]
    fn tasks_carry_supervisor_difficulty_and_warnings() {
        let mut idx = WasmIndex::new();
        idx.upsert(
            "p".into(),
            "Projekty/Triton/Triton.md",
            "- [ ] Schemat @Jan 📅 2026-11-05 !grupa:team-123 !nadzor:@Stanisław !trudnosc:8 !przypomnij:2h/30mx3 !etap:W_toku ^z-7f3a\n- [ ] Zły !trudnosc:12\n",
        );
        let tasks = parse(&idx.tasks_json());
        assert_eq!(tasks["tasks"][0]["supervisor"], "Stanisław");
        assert_eq!(tasks["tasks"][0]["reminder"], json!({"before_min": 120, "every_min": 30, "count": 3}));
        assert_eq!(tasks["tasks"][1]["reminder"], Value::Null);
        assert_eq!(tasks["tasks"][1]["stage"], Value::Null);
        assert_eq!(tasks["tasks"][0]["difficulty"], 8);
        assert_eq!(tasks["tasks"][0]["group_ids"][0], "team-123");
        assert_eq!(tasks["tasks"][0]["block"], "z-7f3a");
        assert_eq!(tasks["tasks"][0]["path"], "Projekty/Triton/Triton.md");
        assert_eq!(tasks["tasks"][1]["difficulty"], Value::Null);
        assert_eq!(tasks["warnings"][0]["line"], 2);
    }

    #[test]
    fn a_project_owns_its_folder_only_when_it_has_one() {
        assert_eq!(own_folder("Projekty/Triton/Triton.md"), Some("Projekty/Triton"));
        assert_eq!(own_folder("Projekty/Triton.md"), None);
        assert_eq!(own_folder("Triton.md"), None);
        assert_eq!(own_folder("Projekty/Triton/Plan.md"), None);
    }

    #[test]
    fn tasks_belong_to_the_nearest_project_note_and_projects_are_listed() {
        let mut idx = WasmIndex::new();
        idx.upsert(
            "p".into(),
            "Projekty/Triton/Triton.md",
            "---\ntyp: projekt\nstatus: aktywny\nprowadzacy: Stanisław\nosoby: Anna Nowak, Jan\n---\n# Triton\n- [ ] Plan\n",
        );
        idx.upsert("t".into(), "Projekty/Triton/Schemat.md", "- [x] Schemat ✅ 2026-10-20\n");
        idx.upsert("loose".into(), "Dziennik/2026.md", "- [ ] Luźne\n");
        let tasks = parse(&idx.tasks_json());
        let by_note = |note: &str| tasks["tasks"].as_array().unwrap().iter().find(|t| t["note"] == note).cloned().unwrap();
        assert_eq!(by_note("p")["project"], "Triton");
        assert_eq!(by_note("p")["project_note"], "p");
        assert_eq!(by_note("t")["project"], "Triton");
        assert_eq!(by_note("t")["project_note"], "p");
        assert_eq!(by_note("loose")["project"], "2026");
        assert_eq!(by_note("loose")["project_note"], Value::Null);
        let projects = parse(&idx.projects_json());
        assert_eq!(projects, json!([{"note": "p", "path": "Projekty/Triton/Triton.md", "name": "Triton", "folder": "Projekty/Triton", "status": "aktywny", "lead": "Stanisław", "people": ["Anna Nowak", "Jan"], "groups": []}]));
    }

    #[test]
    fn two_linked_notes_form_an_edge_with_backlink() {
        let mut idx = WasmIndex::new();
        idx.upsert("a".into(), "A.md", "Patrz [[B]]");
        idx.upsert("b".into(), "B.md", "");
        let graph = parse(&idx.graph_json());
        assert_eq!(
            graph["nodes"][0],
            json!({"id": "a", "path": "A.md", "tags": []})
        );
        assert_eq!(graph["nodes"][1]["id"], "b");
        assert_eq!(graph["edges"], json!([["a", "b"]]));
        assert_eq!(graph["ghosts"], json!([]));

        let back = parse(&idx.backlinks_json("b"));
        assert_eq!(back[0]["from"], "a");
        assert_eq!(back[0]["path"], "A.md");
        assert_eq!(back[0]["line"], 1);
        assert_eq!(back[0]["target"], "B");

        let out = parse(&idx.outgoing_json("a"));
        assert_eq!(out[0]["to"], "b");
        assert_eq!(out[0]["alias"], Value::Null);
    }

    #[test]
    fn ghost_link_is_listed_without_edge() {
        let mut idx = WasmIndex::new();
        idx.upsert("a".into(), "A.md", "[[Nigdzie|alias]]");
        let graph = parse(&idx.graph_json());
        assert_eq!(graph["edges"], json!([]));
        assert_eq!(graph["ghosts"], json!([{"name": "Nigdzie", "from": ["a"]}]));
        let out = parse(&idx.outgoing_json("a"));
        assert_eq!(out[0]["to"], Value::Null);
        assert_eq!(out[0]["alias"], "alias");
    }

    #[test]
    fn rename_keeps_edges() {
        let mut idx = WasmIndex::new();
        idx.upsert("a".into(), "A.md", "[[B]]");
        idx.upsert("b".into(), "B.md", "");
        idx.rename("b", "Dir/B.md");
        let graph = parse(&idx.graph_json());
        assert_eq!(graph["edges"], json!([["a", "b"]]));
        assert_eq!(graph["nodes"][1]["path"], "Dir/B.md");
    }

    #[test]
    fn remove_drops_edges_and_creates_ghost() {
        let mut idx = WasmIndex::new();
        idx.upsert("a".into(), "A.md", "[[B]]");
        idx.upsert("b".into(), "B.md", "");
        idx.remove("b");
        let graph = parse(&idx.graph_json());
        assert_eq!(graph["edges"], json!([]));
        assert_eq!(graph["ghosts"], json!([{"name": "B", "from": ["a"]}]));
        assert_eq!(parse(&idx.backlinks_json("b")), json!([]));
    }

    #[test]
    fn quotes_backslashes_and_newlines_are_escaped() {
        let mut idx = WasmIndex::new();
        let path = "Dir \"q\"\\x\nż.md";
        idx.upsert("a".into(), path, "#tytuł \n[[Cel]]");
        let graph = parse(&idx.graph_json());
        assert_eq!(graph["nodes"][0]["path"], path);
        let tags = parse(&idx.tags_json());
        assert_eq!(tags, json!([{"tag": "tytuł", "count": 1}]));
        assert!(idx.graph_json().contains("\\\"q\\\"\\\\x\\nż"));
    }

    #[test]
    fn yaml_tag_with_quote_and_backslash_is_escaped() {
        let mut idx = WasmIndex::new();
        idx.upsert("a".into(), "A.md", "---\ntags: ['a\"b\\c']\n---\n");
        let tags = parse(&idx.tags_json());
        assert_eq!(tags, json!([{"tag": "a\"b\\c", "count": 1}]));
        assert_eq!(
            parse(&idx.graph_json())["nodes"][0]["tags"],
            json!(["a\"b\\c"])
        );
    }

    #[test]
    fn headings_and_tags_json() {
        let mut idx = WasmIndex::new();
        idx.upsert("a".into(), "A.md", "# Tytuł \"x\"\n#t/u\n");
        let heads = parse(&idx.headings_json("a"));
        assert_eq!(
            heads,
            json!([{"level": 1, "text": "Tytuł \"x\"", "line": 1}])
        );
        let tags = parse(&idx.tags_json());
        assert_eq!(
            tags,
            json!([{"tag": "t", "count": 1}, {"tag": "t/u", "count": 1}])
        );
    }
}

/// The scope a read sees. Only the explicit "*" is no scope (everything, the app's own use). Anything else is a
/// scope, and "" or a malformed one is an empty scope: nothing visible, never everything (a caller that forgot the
/// scope, or failed to build it, fails closed).
fn parse_scope(scope_json: &str) -> Option<Scope> {
    if scope_json == "*" {
        return None;
    }
    let Ok(v) = serde_json::from_str::<Value>(scope_json) else {
        return Some(Scope::default());
    };
    let ids = |key: &str| -> HashSet<String> {
        v.get(key).and_then(Value::as_array).map_or_else(HashSet::new, |a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
    };
    let people = ids("people").iter().map(|p| notes_core::index::normalize_name(p)).collect();
    Some(Scope { notes: ids("notes"), files: ids("files"), people })
}

/// The edge kinds of a comma list; "" is no filter (all kinds).
fn edge_types(types_csv: &str) -> Option<Vec<EdgeKind>> {
    if types_csv.trim().is_empty() {
        None
    } else {
        Some(types_csv.split(',').filter_map(|t| EdgeKind::parse(t.trim())).collect())
    }
}

/// `Some` for a filter given as text; "" means no filter.
fn non_empty(s: &str) -> Option<&str> {
    (!s.is_empty()).then_some(s)
}

fn node_kind_name(kind: NodeKind) -> &'static str {
    kind.name()
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Note => "note",
        Kind::File => "file",
    }
}

/// Search over note chunks and file text layers (OCR §4.6). JSON field names are camelCase.
#[wasm_bindgen]
#[derive(Default)]
pub struct WasmSearch {
    inner: SearchIndex,
}

#[wasm_bindgen]
impl WasmSearch {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmSearch {
        WasmSearch::default()
    }

    pub fn upsert_note(&mut self, id: &str, path: &str, text: &str) {
        self.inner.upsert_note(id, path, text);
    }

    pub fn remove_note(&mut self, id: &str) {
        self.inner.remove_note(id);
    }

    /// False when the text layer does not follow OCR §3.1; nothing is indexed then.
    pub fn upsert_file_text(&mut self, file_id: &str, name: &str, mime: &str, markdown: &str) -> bool {
        self.inner.upsert_file_text(file_id, name, mime, markdown).is_ok()
    }

    pub fn remove_file(&mut self, file_id: &str) {
        self.inner.remove_file(file_id);
    }

    /// Outgoing links of a note, a JSON array of note ids (resolved by the caller). False when it is not JSON.
    pub fn set_links(&mut self, note_id: &str, targets_json: &str) -> bool {
        let Ok(targets) = serde_json::from_str::<Vec<String>>(targets_json) else { return false };
        self.inner.set_links(note_id, &targets);
        true
    }

    /// Names of people, a JSON array. False when it is not JSON.
    pub fn set_people(&mut self, names_json: &str) -> bool {
        let Ok(names) = serde_json::from_str::<Vec<String>>(names_json) else { return false };
        self.inner.set_people(&names);
        true
    }

    /// Name, mime and text state ("text", "none", "pending", "error") of a file, for `find_files`.
    pub fn set_file(&mut self, file_id: &str, name: &str, mime: &str, state: &str) {
        self.inner.set_file(file_id, name, mime, state);
    }

    /// `{"hits":[{"chunkId","kind","docId","title","place","snippet","score","tokensApprox","docTokensApprox"}],"total"}`
    pub fn search_json(&self, query: &str, limit: usize, offset: usize, scope_json: &str) -> String {
        let page = self.inner.search(query, limit, offset, parse_scope(scope_json).as_ref());
        let hits: Vec<Value> = page
            .hits
            .iter()
            .map(|h| {
                json!({
                    "chunkId": h.chunk_id,
                    "kind": kind_name(h.kind),
                    "docId": h.doc_id,
                    "title": h.title,
                    "place": h.place,
                    "snippet": h.snippet,
                    "score": h.score,
                    "tokensApprox": h.tokens_approx,
                    "docTokensApprox": h.doc_tokens_approx,
                })
            })
            .collect();
        json!({"hits": hits, "total": page.total}).to_string()
    }

    /// `[{"chunkId","place","tokensApprox","firstLine","lowQuality"}]`, or `null` for an unknown id.
    pub fn outline_json(&self, id: &str, scope_json: &str) -> String {
        match self.inner.outline(id, parse_scope(scope_json).as_ref()) {
            None => "null".to_string(),
            Some(items) => {
                let items: Vec<Value> = items
                    .iter()
                    .map(|i| {
                        json!({
                            "chunkId": i.chunk_id,
                            "place": i.place,
                            "tokensApprox": i.tokens_approx,
                            "firstLine": i.first_line,
                            "lowQuality": i.low_quality,
                        })
                    })
                    .collect();
                Value::Array(items).to_string()
            }
        }
    }

    /// Pages are set with `from_page` (and `to_page`, default the same page); both absent means no page range.
    /// `{"id","title","place","text","totalChars","more"}`, or `null` when the id is unknown.
    pub fn read_json(
        &self,
        id: &str,
        from_page: Option<u32>,
        to_page: Option<u32>,
        offset: usize,
        limit: usize,
        scope_json: &str,
    ) -> String {
        let pages = from_page.map(|f| (f, to_page.unwrap_or(f)));
        match self.inner.read(id, pages, offset, limit, parse_scope(scope_json).as_ref()) {
            None => "null".to_string(),
            Some(r) => json!({
                "id": r.id,
                "title": r.title,
                "place": r.place,
                "text": r.text,
                "totalChars": r.total_chars,
                "more": r.more,
            })
            .to_string(),
        }
    }

    /// Neighbors of a node (`n:`, `f:`, `t:`, `p:`, `d:`). `types_csv` is a list of link, embed, tag, assigned, in,
    /// mention, or "" for all. `{"nodes":[{"id","kind","label"}],"edges":[{"from","to","kind"}],"truncated"}`, or
    /// `null` for a node that does not exist or is outside the scope.
    pub fn neighbors_json(&self, id: &str, depth: usize, types_csv: &str, limit: usize, scope_json: &str) -> String {
        let types = edge_types(types_csv);
        match self.inner.neighbors(id, depth, types.as_deref(), limit, parse_scope(scope_json).as_ref()) {
            None => "null".to_string(),
            Some(n) => json!({
                "nodes": n.nodes.iter().map(|x| json!({"id": x.id, "kind": node_kind_name(x.kind), "label": x.label})).collect::<Vec<Value>>(),
                "edges": n.edges.iter().map(|e| json!({"from": e.from, "to": e.to, "kind": e.kind.name()})).collect::<Vec<Value>>(),
                "truncated": n.truncated,
            })
            .to_string(),
        }
    }

    /// The edges of the kinds in `types_csv` (as `neighbors_json`, "" for all) and the nodes at their ends, for the
    /// graph view (OCR §4.4). `{"nodes":[{"id","kind","label"}],"edges":[{"from","to","kind"}]}`, within `scope_json`.
    pub fn edges_json(&self, types_csv: &str, scope_json: &str) -> String {
        let types = edge_types(types_csv);
        let e = self.inner.edges(types.as_deref(), parse_scope(scope_json).as_ref());
        json!({
            "nodes": e.nodes.iter().map(|x| json!({"id": x.id, "kind": node_kind_name(x.kind), "label": x.label})).collect::<Vec<Value>>(),
            "edges": e.edges.iter().map(|e| json!({"from": e.from, "to": e.to, "kind": e.kind.name()})).collect::<Vec<Value>>(),
        })
        .to_string()
    }

    /// `{"folders":[{"path","notes"}],"topTags":[{"tag","n"}],"people":[{"name","n"}],"hubs":[{"id","title","degree"}],
    /// "filesWithText","filesTotal"}`
    pub fn map_json(&self, scope_json: &str) -> String {
        let m = self.inner.map_overview(parse_scope(scope_json).as_ref());
        json!({
            "folders": m.folders.iter().map(|(p, n)| json!({"path": p, "notes": n})).collect::<Vec<Value>>(),
            "topTags": m.top_tags.iter().map(|(t, n)| json!({"tag": t, "n": n})).collect::<Vec<Value>>(),
            "people": m.people.iter().map(|(p, n)| json!({"name": p, "n": n})).collect::<Vec<Value>>(),
            "hubs": m.hubs.iter().map(|h| json!({"id": h.id, "title": h.title, "degree": h.degree})).collect::<Vec<Value>>(),
            "filesWithText": m.files_with_text,
            "filesTotal": m.files_total,
        })
        .to_string()
    }

    /// Empty `q`, `typ` or `folder` means no filter. `{"files":[{"id","name","mime","textState","pages","embeddedIn"}],"total"}`
    pub fn find_files_json(&self, q: &str, typ: &str, folder: &str, limit: usize, offset: usize, scope_json: &str) -> String {
        let page = self.inner.find_files(non_empty(q), non_empty(typ), non_empty(folder), limit, offset, parse_scope(scope_json).as_ref());
        let files: Vec<Value> = page
            .files
            .iter()
            .map(|f| {
                json!({
                    "id": f.id,
                    "name": f.name,
                    "mime": f.mime,
                    "textState": f.text_state,
                    "pages": f.pages,
                    "embeddedIn": f.embedded_in,
                })
            })
            .collect();
        json!({"files": files, "total": page.total}).to_string()
    }
}
