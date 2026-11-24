use super::*;

// Same vectors as ui/src/table.test.ts: cell splitting must match Lezer's GFM rule.

fn header(md: &str) -> Vec<String> {
    parse_table(md).expect("is a table")[0].clone()
}

#[test]
fn escaped_pipe_is_literal_inside_cell() {
    assert_eq!(header("| a\\|b | c |\n|---|---|"), vec!["a|b", "c"]);
}

#[test]
fn escaped_backslash_does_not_escape_the_pipe() {
    // `\\|`: the two backslashes are literal text and the pipe splits.
    assert_eq!(header("| x\\\\| y |\n|---|---|"), vec!["x\\\\", "y"]);
}

#[test]
fn pipe_in_code_span_still_splits() {
    assert_eq!(header("| `a|b` | c |\n|---|---|---|"), vec!["`a", "b`", "c"]);
}

#[test]
fn leading_and_trailing_pipes_are_optional() {
    assert_eq!(header("a | b\n--- | ---"), vec!["a", "b"]);
    assert_eq!(header("| a | b\n|---|---"), vec!["a", "b"]);
    assert_eq!(header("a | b |\n|---|---|"), vec!["a", "b"]);
}

#[test]
fn unicode_cells_split_on_characters() {
    assert_eq!(header("| Zażółć | gęś |\n|---|---|"), vec!["Zażółć", "gęś"]);
}

#[test]
fn escaped_backslash_formula_evaluates_in_column_c() {
    // Markdown text `| x\\| y | =1+1 |`: A = `x\\`, B = `y`, C = the formula.
    let cells = parse_table("| x\\\\| y | =1+1 |\n|---|---|---|\n| 1 | 2 | 3 |").unwrap();
    assert_eq!(cells[0], vec!["x\\\\", "y", "=1+1"]);
    let out = evaluate_table(&cells, 0);
    assert_eq!(out[0][2], Value::Number(2.0));
    assert_eq!(out[0][1], Value::Text("y".to_string()));
}
