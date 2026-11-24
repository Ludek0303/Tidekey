use super::tests::{TODAY, one, show, table};
use super::*;
use std::time::{Duration, Instant};

#[test]
fn rounding_is_decimal_for_halves_and_clamped() {
    assert_eq!(show("=ZAOKR(1,005;2)"), "1,01");
    assert_eq!(show("=ZAOKR(2,675;2)"), "2,68");
    assert_eq!(show("=ZAOKR(-1,005;2)"), "-1,01");
    assert_eq!(show("=ZAOKR(5;-400)"), "0");
    assert_eq!(show("=ZAOKR(12345678901;300)"), "12345678901");
}

#[test]
fn text_results_are_capped_at_excel_limit() {
    // A1 = "x", A_k = A_{k-1} & A_{k-1}: A16 would be 32 768 characters.
    let mut cells: Vec<Vec<String>> = vec![vec!["x".to_string()]];
    for k in 2..=40 {
        cells.push(vec![format!("=A{0}&A{0}", k - 1)]);
    }
    let start = Instant::now();
    let out = evaluate_table(&cells, TODAY);
    assert!(start.elapsed() < Duration::from_secs(10));
    assert_eq!(out[9][0], Value::Text("x".repeat(512)));
    assert_eq!(out[15][0], Value::Error(FormulaError::Value));
    assert_eq!(out[39][0], Value::Error(FormulaError::Value));
}

#[test]
fn repeated_dependencies_are_counted_once() {
    // Every cell reads the whole 32x32 table 50 times and sits on a cycle.
    let formula = format!("=SUMA({})", vec!["A1:AF32"; 50].join(";"));
    let cells: Vec<Vec<String>> = (0..32).map(|_| vec![formula.clone(); 32]).collect();
    let start = Instant::now();
    let out = evaluate_table(&cells, TODAY);
    assert!(start.elapsed() < Duration::from_secs(10));
    // The work budget (2^22 cells) runs out after about 80 formulas: the rest are #ARG!,
    // and the earlier ones sit on cycles (#CYKL!). Nothing is a number, nothing is slow.
    assert!(out.iter().flatten().all(|v| matches!(v, Value::Error(_))));
}

#[test]
fn long_operator_chains_are_not_limited_by_depth() {
    let plus = format!("={}", vec!["1"; 500].join("+"));
    assert_eq!(show(&plus), "500");
    let cells: Vec<Vec<String>> = vec![vec![
        "2".to_string(),
        format!("={}", vec!["A1"; 300].join("+")),
    ]];
    assert_eq!(evaluate_table(&cells, TODAY)[0][1], Value::Number(600.0));
    let concat = format!("={}", vec!["\"a\""; 300].join("&"));
    assert_eq!(show(&concat), "a".repeat(300));
    assert_eq!(show("=1+2*3-4/2"), "5");
    assert_eq!(show("=2^3^2"), "64");
}

#[test]
fn text_copying_is_budgeted() {
    // Under the per-reference guard: each comparison copies and lowercases 64 000 bytes.
    let mut cells: Vec<Vec<String>> = vec![vec!["a".repeat(32_000)]];
    for _ in 0..1000 {
        cells.push(vec!["=(A1=A1)+(A1=A1)+(A1=A1)".to_string()]);
    }
    let start = Instant::now();
    let out = evaluate_table(&cells, TODAY);
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(out[999][0], Value::Error(FormulaError::Value));

    // Over the per-reference guard: every formula is #ARG! straight away.
    let mut long: Vec<Vec<String>> = vec![vec!["a".repeat(131_000)]];
    for _ in 0..1000 {
        long.push(vec!["=(A1=A1)+(A1=A1)+(A1=A1)".to_string()]);
    }
    let out = evaluate_table(&long, TODAY);
    assert!(
        out[1..]
            .iter()
            .all(|r| r[0] == Value::Error(FormulaError::Value))
    );
}

#[test]
fn oversized_table_keeps_literals_and_shows_arg_for_formulas() {
    // 3000 columns by 3000 rows is over the cell cap: nothing is evaluated.
    let mut cells: Vec<Vec<String>> = vec![vec!["h".to_string(); 3000]];
    for _ in 0..2999 {
        cells.push(vec!["=1+1".to_string()]);
    }
    let out = evaluate_table(&cells, TODAY);
    assert_eq!(out.len(), 3000);
    assert_eq!(out[0].len(), 3000);
    assert_eq!(out[0][0], Value::Text("h".to_string()));
    assert_eq!(out[5].len(), 1);
    assert_eq!(out[5][0], Value::Error(FormulaError::Value));
}

#[test]
fn deep_formulas_are_rejected_without_overflow() {
    // Token limit: both give #ARG!.
    let long_sum = format!("={}", vec!["1"; 5000].join("+"));
    assert_eq!(show(&long_sum), "#ARG!");
    let long_pow = format!("={}", vec!["2"; 5000].join("^"));
    assert_eq!(show(&long_pow), "#ARG!");
    // Chains add no depth: 1000 tokens of operators still fit the token limit.
    assert_eq!(show(&format!("={}", vec!["1"; 499].join("+"))), "499");
    // Tree depth limit (64) counts real nesting only.
    let nested = format!("={}1{}", "(1+".repeat(70), ")".repeat(70));
    assert_eq!(show(&nested), "#ARG!");
    // Parenthesis nesting limit.
    let parens = format!("={}1{}", "(".repeat(200), ")".repeat(200));
    assert_eq!(show(&parens), "#ARG!");
}

#[test]
fn single_reference_in_aggregate_skips_text() {
    let out = table(&[&["abc", "5", "=SUMA(A1;3)", "=ILE.LICZB(A1;B1)"]]);
    assert_eq!(out[0][2], Value::Number(3.0));
    assert_eq!(out[0][3], Value::Number(1.0));
}

#[test]
fn dollar_signs_in_addresses_are_ignored() {
    let t = table(&[&["1", "=SUMA($A$1:A$3)", "=$A1+A$2"], &["2"], &["3"]]);
    assert_eq!(t[0][1].to_string(), "6");
    assert_eq!(t[0][2].to_string(), "3");
    for bad in ["=A$", "=$$A1", "=A$$1", "=$1"] {
        assert!(matches!(one(bad), Value::Error(_)), "{bad} accepted");
    }
}
