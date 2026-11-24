//! GitHub projects in the browser (docs/GITHUB.md): the pure logic of notes-core as wasm functions. Inputs and
//! outputs are JSON strings, as in calendar.rs. Bad JSON gives `{"error": ...}`; the message never echoes the input.

use notes_core::github::{
    Merge3, git_blob_sha1, guarded_lines, is_markdown, merge3, normalize_repo_path, parse_repo_url,
    strip_permission_markers,
};
use notes_core::github_plan::{Action, SkipReason, TrackedFile, TreeEntry, plan};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

/// `{"owner","repo","gitRef","path"}` for a GitHub address, `None` for anything else.
#[wasm_bindgen]
pub fn github_parse_repo_url(s: &str) -> Option<String> {
    let r = parse_repo_url(s)?;
    Some(json!({"owner": r.owner, "repo": r.repo, "gitRef": r.git_ref, "path": r.path}).to_string())
}

/// The git blob id of the bytes, as the GitHub tree reports it.
#[wasm_bindgen]
pub fn github_blob_sha1(bytes: &[u8]) -> String {
    git_blob_sha1(bytes)
}

/// The path of a repository file inside the folder `root`, or `None` if it lies outside it.
#[wasm_bindgen]
pub fn github_normalize_path(path: &str, root: &str) -> Option<String> {
    normalize_repo_path(path, root)
}

#[wasm_bindgen]
pub fn github_is_markdown(path: &str) -> bool {
    is_markdown(path)
}

/// `{"clean": text}` or `{"conflict": true}`.
#[wasm_bindgen]
pub fn github_merge3(base: &str, ours: &str, theirs: &str) -> String {
    let v = match merge3(base, ours, theirs) {
        Merge3::Clean(text) => json!({"clean": text}),
        Merge3::Conflict => json!({"conflict": true}),
    };
    v.to_string()
}

/// `{"text": ..., "removed": n}`: the text without the permission markers GitHub must not set.
#[wasm_bindgen]
pub fn github_strip_markers(text: &str) -> String {
    let (text, removed) = strip_permission_markers(text);
    json!({"text": text, "removed": removed}).to_string()
}

#[wasm_bindgen]
pub fn github_guarded_lines(text: &str) -> String {
    json!(guarded_lines(text)).to_string()
}

/// `[{"at","delete","insert"}]`: the edits that turn `old` into `new`, applied in order.
#[wasm_bindgen]
pub fn text_edits(old: &str, new: &str) -> String {
    let edits: Vec<Value> = notes_core::text_edits(old, new)
        .into_iter()
        .map(|e| json!({"at": e.at, "delete": e.delete, "insert": e.insert}))
        .collect();
    Value::Array(edits).to_string()
}

/// The actions of a GitHub update. `tracked` is `[{noteId,path,blobSha,hasEdits}]`, `tree` is
/// `[{path,blobSha,size}]`, `ignored` is `[path]`. Returns `[action]` or `{"error": ...}`.
#[wasm_bindgen]
pub fn github_plan(tracked_json: &str, tree_json: &str, ignored_json: &str, trash: bool) -> String {
    match plan_json(tracked_json, tree_json, ignored_json, trash) {
        Ok(actions) => Value::Array(actions).to_string(),
        Err(error) => json!({"error": error}).to_string(),
    }
}

fn plan_json(tracked_json: &str, tree_json: &str, ignored_json: &str, trash: bool) -> Result<Vec<Value>, String> {
    let tracked = items(tracked_json, "tracked", |v| {
        Some(TrackedFile {
            note_id: v.get("noteId")?.as_str()?.to_string(),
            path: v.get("path")?.as_str()?.to_string(),
            blob_sha: v.get("blobSha")?.as_str()?.to_string(),
            has_edits: v.get("hasEdits")?.as_bool()?,
        })
    })?;
    let tree = items(tree_json, "tree", |v| {
        Some(TreeEntry {
            path: v.get("path")?.as_str()?.to_string(),
            blob_sha: v.get("blobSha")?.as_str()?.to_string(),
            size: v.get("size")?.as_u64()?,
        })
    })?;
    let ignored = items(ignored_json, "ignored", |v| v.as_str().map(str::to_string))?;
    Ok(plan(&tracked, &tree, &ignored, trash).iter().map(action_json).collect())
}

/// Parses a JSON array and reads each item with `read`. The error names the argument, not its content.
fn items<T>(text: &str, what: &str, read: impl Fn(&Value) -> Option<T>) -> Result<Vec<T>, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| format!("{what}: niepoprawny JSON"))?;
    let array = v.as_array().ok_or_else(|| format!("{what}: oczekiwano tablicy"))?;
    array
        .iter()
        .map(|item| read(item).ok_or_else(|| format!("{what}: niepoprawny wpis")))
        .collect()
}

fn action_json(action: &Action) -> Value {
    match action {
        Action::Create { path, blob_sha } => json!({"kind": "create", "path": path, "blobSha": blob_sha}),
        Action::Update { note_id, path, blob_sha } => {
            json!({"kind": "update", "noteId": note_id, "path": path, "blobSha": blob_sha})
        }
        Action::Move { note_id, from, to, blob_sha } => {
            json!({"kind": "move", "noteId": note_id, "from": from, "to": to, "blobSha": blob_sha})
        }
        Action::MarkDeleted { note_id } => json!({"kind": "markDeleted", "noteId": note_id}),
        Action::Trash { note_id } => json!({"kind": "trash", "noteId": note_id}),
        Action::Skip { path, reason } => json!({"kind": "skip", "path": path, "reason": reason_name(reason)}),
    }
}

fn reason_name(reason: &SkipReason) -> &'static str {
    match reason {
        SkipReason::Ignored => "ignored",
        SkipReason::TooLarge => "tooLarge",
        SkipReason::LimitFiles => "limitFiles",
        SkipReason::LimitTotal => "limitTotal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn repo_urls_give_owner_repo_ref_and_path() {
        let v = parsed(&github_parse_repo_url("https://github.com/acme/notes/tree/main/docs").unwrap());
        assert_eq!(v, json!({"owner": "acme", "repo": "notes", "gitRef": "main", "path": "docs"}));
        let plain = parsed(&github_parse_repo_url("acme/notes").unwrap());
        assert_eq!(plain["gitRef"], Value::Null);
        assert_eq!(github_parse_repo_url("https://gitlab.com/acme/notes"), None);
        assert_eq!(github_parse_repo_url("../../etc"), None);
        assert_eq!(github_parse_repo_url(""), None);
    }

    #[test]
    fn blob_sha_is_the_git_blob_id() {
        assert_eq!(github_blob_sha1(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn paths_stay_inside_the_root() {
        assert_eq!(github_normalize_path("docs/Zażółć.md", "docs"), Some("Zażółć.md".into()));
        assert_eq!(github_normalize_path("docs/../x.md", "docs"), None);
        assert_eq!(github_normalize_path("/docs/a.md", "docs"), None);
        assert_eq!(github_normalize_path("other/a.md", "docs"), None);
        assert!(github_is_markdown("README"));
        assert!(github_is_markdown("notatki/Ż.MD"));
        assert!(!github_is_markdown("obraz.png"));
    }

    #[test]
    fn merge_gives_clean_text_or_conflict() {
        assert_eq!(parsed(&github_merge3("x\n", "y\n", "x\n")), json!({"clean": "y\n"}));
        assert_eq!(parsed(&github_merge3("x\n", "a\n", "b\n")), json!({"conflict": true}));
    }

    #[test]
    fn markers_are_removed_and_counted() {
        let v = parsed(&github_strip_markers("---\ntytul: X\nosoby:\n  - Anna\n---\n!zaznacza:x\ntekst\n"));
        assert_eq!(v, json!({"text": "---\ntytul: X\n---\ntekst\n", "removed": 3}));
    }

    #[test]
    fn guarded_lines_are_the_tasks_and_mentions() {
        let v = parsed(&github_guarded_lines("- [ ] zadanie @Anna\nzwykły\n- [x] ok"));
        assert_eq!(v.as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn text_edits_json_has_the_documented_shape() {
        assert_eq!(parsed(&text_edits("abc", "ac")), json!([{"at": 1, "delete": 1, "insert": ""}]));
        assert_eq!(text_edits("same", "same"), "[]");
    }

    #[test]
    fn plan_json_lists_actions_in_camel_case() {
        let tracked = r#"[{"noteId":"n1","path":"a.md","blobSha":"X","hasEdits":false},
                          {"noteId":"n2","path":"gone.md","blobSha":"Y","hasEdits":false}]"#;
        let tree = r#"[{"path":"b.md","blobSha":"X","size":5},{"path":"new.md","blobSha":"Z","size":2000000}]"#;
        let v = parsed(&github_plan(tracked, tree, "[]", true));
        assert_eq!(
            v,
            json!([
                {"kind": "move", "noteId": "n1", "from": "a.md", "to": "b.md", "blobSha": "X"},
                {"kind": "trash", "noteId": "n2"},
                {"kind": "skip", "path": "new.md", "reason": "tooLarge"},
            ])
        );
        let ignored = parsed(&github_plan("[]", r#"[{"path":"i.md","blobSha":"Q","size":1}]"#, r#"["i.md"]"#, false));
        assert_eq!(ignored, json!([{"kind": "skip", "path": "i.md", "reason": "ignored"}]));
    }

    #[test]
    fn plan_json_reports_bad_input_as_error() {
        for (tracked, tree, ignored) in [
            ("nie json", "[]", "[]"),
            ("{}", "[]", "[]"),
            (r#"[{"noteId":"n1"}]"#, "[]", "[]"),
            ("[]", r#"[{"path":"a.md","blobSha":"X","size":-1}]"#, "[]"),
            ("[]", "[]", r#"[1]"#),
        ] {
            let v = parsed(&github_plan(tracked, tree, ignored, false));
            assert!(v.get("error").and_then(Value::as_str).is_some(), "{v}");
        }
    }
}
