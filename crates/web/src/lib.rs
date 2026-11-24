//! Browser bridge for the formula engine: a GFM table in, evaluated cells out.

mod calendar;
mod github;
mod index;

use notes_core::formula::{Value, evaluate_table, parse_table};
use notes_core::render::render_html;
use wasm_bindgen::prelude::*;

pub use calendar::{calendar_expand_json, calendar_format_event_json, calendar_parse_json};
pub use github::{
    github_blob_sha1, github_guarded_lines, github_is_markdown, github_merge3, github_normalize_path, github_parse_repo_url,
    github_plan, github_strip_markers, text_edits,
};
pub use index::WasmIndex;

/// Evaluated table, read cell by cell from JS. Cells are row-major; ragged rows are padded.
#[wasm_bindgen]
pub struct EvaluatedTable {
    rows: usize,
    cols: usize,
    cells: Vec<String>,
    kinds: Vec<u8>,
    formula: Vec<bool>,
}

#[wasm_bindgen]
impl EvaluatedTable {
    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn text(&self, r: usize, c: usize) -> String {
        self.index(r, c)
            .map(|i| self.cells[i].clone())
            .unwrap_or_default()
    }

    /// 0 empty, 1 number, 2 text, 3 bool, 4 date, 5 error.
    pub fn kind(&self, r: usize, c: usize) -> u8 {
        self.index(r, c).map_or(0, |i| self.kinds[i])
    }

    pub fn is_formula(&self, r: usize, c: usize) -> bool {
        self.index(r, c).is_some_and(|i| self.formula[i])
    }

    fn index(&self, r: usize, c: usize) -> Option<usize> {
        (r < self.rows && c < self.cols).then(|| r * self.cols + c)
    }
}

/// `None` if `md` is not a GFM table (header row plus delimiter row).
#[wasm_bindgen]
pub fn evaluate_markdown_table(md: &str, today_days: i32) -> Option<EvaluatedTable> {
    let source = parse_table(md)?;
    let values = evaluate_table(&source, today_days);
    let rows = values.len();
    let cols = values.iter().map(Vec::len).max().unwrap_or(0);
    let mut table = EvaluatedTable {
        rows,
        cols,
        cells: Vec::with_capacity(rows * cols),
        kinds: Vec::with_capacity(rows * cols),
        formula: Vec::with_capacity(rows * cols),
    };
    for (r, row) in values.iter().enumerate() {
        for c in 0..cols {
            match row.get(c) {
                Some(value) => {
                    table.cells.push(value.to_string());
                    table.kinds.push(kind_of(value));
                    table
                        .formula
                        .push(source[r].get(c).is_some_and(|s| s.starts_with('=')));
                }
                None => {
                    table.cells.push(String::new());
                    table.kinds.push(0);
                    table.formula.push(false);
                }
            }
        }
    }
    Some(table)
}

/// Reading view: Markdown note text to safe HTML, with table formula results (ARCHITEKTURA §5).
#[wasm_bindgen]
pub fn render_markdown_html(md: &str, today_days: i32) -> String {
    render_html(md, today_days)
}

fn kind_of(value: &Value) -> u8 {
    match value {
        Value::Empty => 0,
        Value::Number(_) => 1,
        Value::Text(_) => 2,
        Value::Bool(_) => 3,
        Value::Date(..) => 4,
        Value::Error(_) => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_tokens_are_utf16_offsets_in_the_line() {
        // `ł` and `ż` are one UTF-16 unit each; the emoji is two
        let line = "- [ ] Łódź ✅ 2026-10-20 @Żaneta";
        let v: serde_json::Value = serde_json::from_str(&task_line_tokens(line)).unwrap();
        assert_eq!(v["text"], "Łódź");
        assert_eq!(v["tokens"][0]["kind"], "done");
        assert_eq!(v["tokens"][0]["value"], 20_746);
        let from = v["tokens"][0]["from"].as_u64().unwrap() as usize;
        let to = v["tokens"][0]["to"].as_u64().unwrap() as usize;
        let units: Vec<u16> = line.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[from..to]).unwrap(), "✅ 2026-10-20");
        assert_eq!(task_line_tokens("zwykły tekst"), "null");
    }

    const EXAMPLE: &str = "| Zadanie | Start | Koniec | Dni |\n\
        |---|---|---|---|\n\
        | Projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |\n\
        | Testy | 19.10.2026 | =B3+14 | =C3-B3 |\n\
        | **Razem** | | | =SUMA(D2:D3) |";

    #[test]
    fn evaluates_example_table() {
        let t = evaluate_markdown_table(EXAMPLE, 0).unwrap();
        assert_eq!((t.rows(), t.cols()), (4, 4));
        assert_eq!(t.text(1, 3), "18");
        assert_eq!(t.text(2, 2), "02.11.2026");
        assert_eq!(t.text(2, 3), "14");
        assert_eq!(t.text(3, 3), "32");
        assert_eq!(t.kind(2, 2), 4);
        assert_eq!(t.kind(1, 3), 1);
        assert_eq!(t.kind(1, 0), 2);
        assert_eq!(t.kind(3, 1), 0);
        assert!(t.is_formula(1, 3));
        assert!(!t.is_formula(1, 1));
    }

    #[test]
    fn reports_error_and_bool_kinds() {
        let t = evaluate_markdown_table("| a | b |\n|---|---|\n| =1/0 | =1=1 |", 0).unwrap();
        assert_eq!(t.kind(1, 0), 5);
        assert_eq!(t.kind(1, 1), 3);
    }

    #[test]
    fn rejects_non_table() {
        assert!(evaluate_markdown_table("zwykły tekst", 0).is_none());
        assert!(evaluate_markdown_table("| a | b |", 0).is_none());
    }

    #[test]
    fn escaped_pipe_stays_one_cell() {
        let t = evaluate_markdown_table("| a | b |\n|---|---|\n| [[x\\|y]] | z |", 0).unwrap();
        assert_eq!((t.rows(), t.cols()), (2, 2));
        assert_eq!(t.text(1, 0), "[[x|y]]");
    }

    #[test]
    fn out_of_range_getters_do_not_panic() {
        let t = evaluate_markdown_table(EXAMPLE, 0).unwrap();
        assert_eq!(t.text(99, 0), "");
        assert_eq!(t.text(0, 99), "");
        assert_eq!(t.kind(99, 99), 0);
        assert!(!t.is_formula(99, 0));
    }
}

/// The task on one line, for the editor: `null` when the line is not a task, else
/// `{"text","id","tokens":[{"kind","from","to","value"}]}`. `from` and `to` are UTF-16 offsets in the line, as the
/// editor counts them. The values: a day number for `due` and `done`, `null` for an unreadable `difficulty`, and `{"before_min","every_min","count"}` or `null` for `reminder`, the column name for `stage`.
/// The note text with its links to a renamed note pointed at the new name (`notes_core::index::rename_links`);
/// `undefined` when no link changes.
#[wasm_bindgen]
pub fn rename_links(text: &str, old_path: &str, new_path: &str, new_basename_unique: bool) -> Option<String> {
    notes_core::index::rename_links(text, old_path, new_path, new_basename_unique)
}

#[wasm_bindgen]
pub fn task_line_tokens(line: &str) -> String {
    use notes_core::index::TokenKind;
    use serde_json::{Value, json};
    let Some(task) = notes_core::index::line_task(line) else {
        return "null".to_string();
    };
    let utf16 = |byte: usize| line[..byte].encode_utf16().count();
    let tokens: Vec<Value> = task
        .tokens
        .iter()
        .map(|t| {
            let (kind, value) = match &t.kind {
                TokenKind::Assignee(h) => ("assignee", json!(h)),
                TokenKind::Group(id) => ("group", json!(id)),
                TokenKind::Supervisor(h) => ("supervisor", json!(h)),
                TokenKind::Due(d) => ("due", json!(d)),
                TokenKind::Done(d) => ("done", json!(d)),
                TokenKind::Difficulty(d) => ("difficulty", json!(d)),
                TokenKind::Reminder(r) => ("reminder", json!(r)),
                TokenKind::Priority(p) => ("priority", json!(format!("{p:?}").to_lowercase())),
                TokenKind::Id(id) => ("id", json!(id)),
                TokenKind::Stage(stage) => ("stage", json!(stage)),
            };
            json!({"kind": kind, "from": utf16(t.start), "to": utf16(t.end), "value": value})
        })
        .collect();
    json!({"text": task.text, "id": task.id, "tokens": tokens}).to_string()
}
