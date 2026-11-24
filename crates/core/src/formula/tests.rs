use super::*;
use proptest::prelude::*;
use std::time::{Duration, Instant};

pub(super) const TODAY: i32 = 20_000;

pub(super) fn one(f: &str) -> Value {
    evaluate_table(&[vec![f.to_string()]], TODAY)[0][0].clone()
}

pub(super) fn show(f: &str) -> String {
    one(f).to_string()
}

pub(super) fn table(rows: &[&[&str]]) -> Vec<Vec<Value>> {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();
    evaluate_table(&cells, TODAY)
}

#[test]
fn example_table_from_spec() {
    let md = "| Zadanie | Start | Koniec | Dni |\n\
              |---|---|---|---|\n\
              | Projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |\n\
              | Testy | 19.10.2026 | =B3+14 | =C3-B3 |\n\
              | **Razem** | | | =SUMA(D2:D3) |";
    let cells = parse_table(md).expect("is a table");
    assert_eq!(cells.len(), 4);
    assert_eq!(cells[0][0], "Zadanie");
    let out = evaluate_table(&cells, TODAY);
    assert_eq!(out[1][3].to_string(), "18");
    assert_eq!(out[2][2].to_string(), "02.11.2026");
    assert_eq!(out[2][3].to_string(), "14");
    assert_eq!(out[3][3].to_string(), "32");
}

#[test]
fn parse_table_rejects_non_tables_and_keeps_ragged_rows() {
    assert_eq!(parse_table("just text"), None);
    assert_eq!(parse_table("| a | b |\nno delimiter"), None);
    let cells = parse_table("| a | b |\n|---|---|\n| 1 |").unwrap();
    assert_eq!(cells, vec![vec!["a", "b"], vec!["1"]]);
}

#[test]
fn literals_and_display() {
    assert_eq!(show("=3,5+1"), "4,5");
    assert_eq!(show("=3.5+1"), "4,5");
    assert_eq!(show("=-2.50*1"), "-2,5");
    assert_eq!(show("=0*-1"), "0");
    assert_eq!(
        table(&[&[
            "3,5",
            "-2.50",
            "2024-02-29",
            "19.10.2026",
            "2026-02-29",
            "1,2.3"
        ]])[0],
        vec![
            Value::Number(3.5),
            Value::Number(-2.5),
            Value::Date(date::from_ymd(2024, 2, 29).unwrap(), DateFmt::Iso),
            Value::Date(date::from_ymd(2026, 10, 19).unwrap(), DateFmt::Dotted),
            Value::Text("2026-02-29".into()),
            Value::Text("1,2.3".into()),
        ]
    );
    assert_eq!(table(&[&["  "]])[0][0], Value::Empty);
    assert_eq!(show("=1000000000000000+0,5"), "1000000000000000,5");
}

#[test]
fn operators_and_precedence() {
    assert_eq!(show("=1+2*3"), "7");
    assert_eq!(show("=(1+2)*3"), "9");
    // Left-associative, as in Excel: (2^3)^2.
    assert_eq!(show("=2^3^2"), "64");
    assert_eq!(show("=-2^2"), "4");
    assert_eq!(show("=10-4-3"), "3");
    assert_eq!(show("=\"ab\"&1,5"), "ab1,5");
    assert_eq!(show("=1<2"), "PRAWDA");
    assert_eq!(show("=1<>2"), "PRAWDA");
    assert_eq!(show("=1>=2"), "FAŁSZ");
    assert_eq!(show("=\"ABC\"=\"abc\""), "PRAWDA");
    assert_eq!(show("=1=\"1\""), "FAŁSZ");
    assert_eq!(show("=1<\"a\""), "#ARG!");
    assert_eq!(show("=\"a\"+1"), "#ARG!");
    assert_eq!(show("=1/0"), "#DZIEL/0!");
    assert_eq!(show("=1+(2/0)"), "#DZIEL/0!");
}

#[test]
fn errors() {
    assert_eq!(show("=FOO(1)"), "#NAZWA?");
    assert_eq!(show("=Z99"), "#ADR!");
    assert_eq!(show("=A0"), "#ADR!");
    assert_eq!(show("=SUMA(A1:Z99)"), "#ADR!");
    assert_eq!(show("="), "#ARG!");
    assert_eq!(show("=1+"), "#ARG!");
    assert_eq!(show("=(1"), "#ARG!");
    assert_eq!(show("=1 2"), "#ARG!");
    assert_eq!(show("=SUMA(1;)"), "#ARG!");
    assert_eq!(show("=\"abc"), "#ARG!");
    assert_eq!(show("=JEŻELI(\"x\";1;2)"), "#ARG!");
    assert_eq!(show("=SUMA(1;\"x\")"), "#ARG!");
}

#[test]
fn cycles() {
    assert_eq!(
        table(&[&["=B1", "=A1"]]),
        vec![vec![
            Value::Error(FormulaError::Cycle),
            Value::Error(FormulaError::Cycle)
        ]]
    );
    // B1 is outside a one-column table, so A1 only gets #ADR!.
    assert_eq!(
        table(&[&["=B1"], &["=A1"]])[0][0],
        Value::Error(FormulaError::Ref)
    );
    let out = table(&[&["=B1", "=A1", "=A1+1"]]);
    assert!(
        out[0]
            .iter()
            .all(|v| *v == Value::Error(FormulaError::Cycle))
    );
    assert_eq!(table(&[&["=A1"]])[0][0], Value::Error(FormulaError::Cycle));
    assert_eq!(
        table(&[&["=SUMA(A1:A2)"], &["1"]])[0][0],
        Value::Error(FormulaError::Cycle)
    );
}

#[test]
fn forward_references_and_empty_cells() {
    assert_eq!(table(&[&["=A2+1"], &["3"]])[0][0], Value::Number(4.0));
    assert_eq!(table(&[&["5"], &["=A1+B1", ""]])[1][0], Value::Number(5.0));
    assert_eq!(table(&[&["=A2+1"], &[""]])[0][0], Value::Number(1.0));
    assert_eq!(
        table(&[&["=A2+1"], &["=\"x\""]])[0][0],
        Value::Error(FormulaError::Value)
    );
}

#[test]
fn long_chain_does_not_overflow_the_stack() {
    let mut cells: Vec<Vec<String>> = vec![vec!["1".to_string()]];
    for k in 2..=10_000 {
        cells.push(vec![format!("=A{}+1", k - 1)]);
    }
    let out = evaluate_table(&cells, TODAY);
    assert_eq!(out[9_999][0], Value::Number(10_000.0));
}

#[test]
fn aggregates_on_ranges_and_values() {
    let out = table(&[
        &[
            "1",
            "=SUMA(A1:A3)",
            "=ŚREDNIA(A1:A2)",
            "=MIN(A1:A3)",
            "=MAX(A1:A2)",
            "=ILE.LICZB(A1:A3)",
        ],
        &["2"],
        &["x"],
    ]);
    assert_eq!(out[0][1].to_string(), "3");
    assert_eq!(out[0][2].to_string(), "1,5");
    assert_eq!(out[0][3].to_string(), "1");
    assert_eq!(out[0][4].to_string(), "2");
    assert_eq!(out[0][5].to_string(), "2");
    assert_eq!(show("=SUM(1;2;3)"), "6");
    assert_eq!(show("=sum(1;2)"), "3");
    assert_eq!(show("=suma(1;2)"), "3");
    assert_eq!(show("=AVERAGE(2;4)"), "3");
    assert_eq!(show("=average(2;5)"), "3,5");
    assert_eq!(show("=ŚREDNIA(2;4)"), "3");
    assert_eq!(show("=MIN(3;1;2)"), "1");
    assert_eq!(show("=max(3;1;2)"), "3");
    assert_eq!(show("=COUNT(1;2)"), "2");
    assert_eq!(show("=ILE.LICZB(1;DATA(2026;10;19))"), "2");
    assert_eq!(show("=SUMA(1/0)"), "#DZIEL/0!");
    assert_eq!(
        table(&[&["=ŚREDNIA(A2:A3)"], &[""], &[""]])[0][0].to_string(),
        "#DZIEL/0!"
    );
}

#[test]
fn aggregates_with_dates() {
    assert_eq!(show("=MIN(DATA(2026;10;19);DATA(2026;10;1))"), "2026-10-01");
    assert_eq!(show("=MAX(DATA(2026;10;19);DATA(2026;10;1))"), "2026-10-19");
    assert_eq!(show("=MIN(1;DATA(2026;10;1))"), "1");
    assert_eq!(show("=SUMA(DATA(2026;10;1);2)"), "2");
}

#[test]
fn if_and_round() {
    assert_eq!(show("=JEŻELI(1>2;\"tak\";\"nie\")"), "nie");
    assert_eq!(show("=if(1<2; 10; 20)"), "10");
    assert_eq!(show("=IF(0;1;2)"), "2");
    assert_eq!(show("=IF(1;1;1/0)"), "1");
    assert_eq!(show("=ZAOKR(2,5;0)"), "3");
    assert_eq!(show("=zaokr(-2,5;0)"), "-3");
    assert_eq!(show("=ROUND(3,14159;2)"), "3,14");
    assert_eq!(show("=ROUND(1234;-2)"), "1200");
}

#[test]
fn dates_and_date_functions() {
    assert_eq!(show("=DATA(2026;10;19)"), "2026-10-19");
    assert_eq!(show("=date(2024;2;29)"), "2024-02-29");
    assert_eq!(show("=DATA(2026;2;29)"), "#ARG!");
    assert_eq!(show("=DATA(2026;13;1)"), "#ARG!");
    assert_eq!(one("=DZIŚ()"), Value::Date(TODAY, DateFmt::Iso));
    assert_eq!(one("=today()"), Value::Date(TODAY, DateFmt::Iso));
    assert_eq!(show("=DNI(DATA(2026;11;2);DATA(2026;10;19))"), "14");
    assert_eq!(show("=days(DATA(2026;10;19); DATA(2026;10;1))"), "18");
    assert_eq!(show("=ROK(DATA(2026;10;19))"), "2026");
    assert_eq!(show("=year(DATA(2026;10;19))"), "2026");
    assert_eq!(show("=MIESIĄC(DATA(2026;10;19))"), "10");
    assert_eq!(show("=month(DATA(2026;10;19))"), "10");
    assert_eq!(show("=DZIEŃ(DATA(2026;10;19))"), "19");
    assert_eq!(show("=day(DATA(2026;10;19))"), "19");
    assert_eq!(show("=DATA(2026;10;1)+18"), "2026-10-19");
    assert_eq!(show("=18+DATA(2026;10;1)"), "2026-10-19");
    assert_eq!(show("=DATA(2026;10;1)-1"), "2026-09-30");
    assert_eq!(show("=DATA(2026;10;1)*2"), "#ARG!");
    assert_eq!(show("=DATA(2026;10;1)+DATA(2026;10;1)"), "#ARG!");
    assert_eq!(show("=ROK(5)"), "#ARG!");
}

#[test]
fn unknown_names_are_name_errors() {
    assert_eq!(show("=SUMA(1)+foo"), "#NAZWA?");
    assert_eq!(show("=NIEZNANA(1;2)"), "#NAZWA?");
}

#[test]
#[ignore = "perf: run with --release --ignored"]
fn perf_1000_cells_under_1ms() {
    let mut cells: Vec<Vec<String>> = (1..=1000)
        .map(|n| vec![n.to_string(), format!("=A{n}*2")])
        .collect();
    cells.push(vec![String::new(), "=SUMA(B1:B1000)".to_string()]);
    // Best of five: a table is recalculated on every edit, so the warm run is the
    // real cost; the first run also pays for growing the heap on this VM.
    let mut best = Duration::MAX;
    for _ in 0..5 {
        let start = Instant::now();
        let out = evaluate_table(&cells, TODAY);
        best = best.min(start.elapsed());
        assert_eq!(out[1000][1], Value::Number(1_001_000.0));
    }
    assert!(best < Duration::from_millis(1), "took {best:?}");
}

proptest! {
    #[test]
    fn arbitrary_formula_text_never_panics(body in ".{0,120}") {
        let _ = evaluate_table(&[vec![format!("={body}")]], TODAY);
    }

    #[test]
    fn formula_like_text_never_panics(body in "[A-Z0-9ŚŻĄ;:()+*/^&<>=\" .,-]{0,60}") {
        let _ = evaluate_table(&[vec![format!("={body}")]], TODAY);
    }

    #[test]
    fn arbitrary_tables_never_panic(
        cells in prop::collection::vec(prop::collection::vec("(=[A-C][0-4][+*-]?[A-C]?[0-4]?|[ -~]{0,12})", 0..5), 0..6)
    ) {
        let _ = evaluate_table(&cells, TODAY);
    }

    #[test]
    fn arbitrary_markdown_never_panics(md in ".{0,200}") {
        let _ = parse_table(&md);
    }
}

#[test]
fn calendar_leap_years_and_invalid_dates() {
    assert_eq!(show("=DATA(2000;2;29)"), "2000-02-29");
    assert_eq!(show("=DATA(2100;2;29)"), "#ARG!");
    assert_eq!(show("=DATA(2026;4;31)"), "#ARG!");
    assert_eq!(show("=DATA(1900;2;29)"), "#ARG!");
    assert_eq!(show("=DATA(1900;2;28)+1"), "1900-03-01");
    assert_eq!(show("=DNI(DATA(1900;3;1);DATA(1900;2;28))"), "1");
    assert_eq!(show("=DNI(DATA(1960;3;1);DATA(1960;2;28))"), "2");
    assert_eq!(
        one("29.02.2024"),
        Value::Date(date::from_ymd(2024, 2, 29).unwrap(), DateFmt::Dotted)
    );
    assert_eq!(one("29.02.2026"), Value::Text("29.02.2026".into()));
    assert_eq!(one("31.04.2026"), Value::Text("31.04.2026".into()));
    assert_eq!(one("1900-02-29"), Value::Text("1900-02-29".into()));
    assert_eq!(
        one("1900-03-01"),
        Value::Date(date::from_ymd(1900, 3, 1).unwrap(), DateFmt::Iso)
    );
    assert_eq!(
        table(&[&["31.12.2025", "=A1+1"]])[0][1].to_string(),
        "01.01.2026"
    );
}

#[test]
fn dates_before_1970_use_negative_day_numbers() {
    assert_eq!(show("=DATA(1969;12;31)"), "1969-12-31");
    assert_eq!(show("=DATA(1969;12;31)-DATA(1970;1;1)"), "-1");
    assert_eq!(show("=DATA(1969;12;31)+1"), "1970-01-01");
    assert_eq!(show("=ROK(DATA(1969;12;31))"), "1969");
    assert_eq!(show("=MIESIĄC(DATA(1969;12;31))"), "12");
    assert_eq!(show("=DZIEŃ(DATA(1969;12;31))"), "31");
    assert_eq!(show("=DATA(1900;1;1)"), "1900-01-01");
    assert_eq!(show("=DZIEŃ(DATA(1900;1;1))"), "1");
    assert_eq!(show("=DNI(DATA(1970;1;1);DATA(1969;12;31))"), "1");
}

#[test]
fn date_result_keeps_format_of_date_operand() {
    let out = table(&[
        &[
            "19.10.2026",
            "=A1+1",
            "=A1-DATA(2026;10;1)",
            "=1+A1",
            "=A1-A2",
        ],
        &["2026-10-19", "=A2+1", "=A2-1"],
    ]);
    assert_eq!(out[0][1].to_string(), "20.10.2026");
    assert_eq!(out[0][2].to_string(), "18");
    assert_eq!(out[0][3].to_string(), "20.10.2026");
    assert_eq!(out[0][4].to_string(), "0");
    assert_eq!(out[1][1].to_string(), "2026-10-20");
    assert_eq!(out[1][2].to_string(), "2026-10-18");
}

#[test]
fn date_parts_read_both_notations() {
    let out = table(&[
        &["19.10.2026", "=ROK(A1)", "=MIESIĄC(A1)", "=DZIEŃ(A1)"],
        &["2026-10-19", "=ROK(A2)", "=MIESIĄC(A2)", "=DZIEŃ(A2)"],
    ]);
    let parts = |row: &Vec<Value>| row[1..].iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(parts(&out[0]), ["2026", "10", "19"]);
    assert_eq!(parts(&out[1]), ["2026", "10", "19"]);
}

#[test]
fn display_has_no_float_noise() {
    assert_eq!(show("=0,1+0,2"), "0,3");
    assert_eq!(show("=0,1*3"), "0,3");
    assert_eq!(show("=1/3"), "0,3333333333");
    assert_eq!(show("=-0,25"), "-0,25");
    assert_eq!(show("=0,0000000001*1"), "0,0000000001");
    assert_eq!(show("=-0,00000000001*1"), "0");
    assert_eq!(show("=999999999999999,5+0"), "999999999999999,5");
    assert_eq!(show("=999999999999999+1"), "1000000000000000");
    assert_eq!(show("=2^53+1"), "9007199254740992");
    assert_eq!(show("=10^20"), "100000000000000000000");
}

#[test]
fn parse_table_gfm_variants() {
    let cells = parse_table("a | b\n--- | ---\n1 | 2").unwrap();
    assert_eq!(cells, vec![vec!["a", "b"], vec!["1", "2"]]);
    let cells = parse_table("| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |").unwrap();
    assert_eq!(cells, vec![vec!["a", "b", "c"], vec!["1", "2", "3"]]);
    assert_eq!(parse_table("| a | b |"), None);
    assert_eq!(parse_table("Lista | x\n- punkt"), None);
    let cells = parse_table("| a | b |\n|---|---|\n| 1 | 2 | 3 |").unwrap();
    // Rows are cut to the header's column count.
    assert_eq!(cells[1], vec!["1", "2"]);
    let out = evaluate_table(&cells, TODAY);
    assert_eq!(out[1].len(), 2);
}

#[test]
fn escaped_pipe_inside_wikilink_stays_one_cell() {
    // GFM: `\|` is a literal pipe inside a cell, so this row has two cells.
    let md = "| Link | Opis |\n|---|---|\n| [[Plan\\|alias]] | 2 |";
    let cells = parse_table(md).expect("is a table");
    assert_eq!(cells[1].len(), 2);
    assert_eq!(cells[1][1], "2");
}

#[test]
fn references_lowercase_and_aa_columns() {
    assert_eq!(table(&[&["2", "3", "=a1+B1"]])[0][2], Value::Number(5.0));
    let mut row = vec![String::new(); 26];
    row.push("7".to_string());
    let out = evaluate_table(
        &[row, vec!["=AA1*2".to_string(), "=AB1".to_string()]],
        TODAY,
    );
    assert_eq!(out[1][0], Value::Number(14.0));
    assert_eq!(out[1][1], Value::Error(FormulaError::Ref));
}

#[test]
fn reversed_range_is_normalised() {
    let mut cells: Vec<Vec<String>> = (0..9)
        .map(|r| {
            vec![
                String::new(),
                if r == 0 {
                    String::new()
                } else {
                    (r + 1).to_string()
                },
                String::new(),
            ]
        })
        .collect();
    cells[0][2] = "=SUMA(B9:B2)".to_string();
    cells[1][2] = "=SUMA(B2:B9)".to_string();
    let out = evaluate_table(&cells, TODAY);
    assert_eq!(out[0][2].to_string(), "44");
    assert_eq!(out[1][2].to_string(), "44");
}

#[test]
fn header_text_in_arithmetic_is_arg_error() {
    assert_eq!(
        table(&[&["Nazwa", "=A1+1"]])[0][1],
        Value::Error(FormulaError::Value)
    );
}

#[test]
fn errors_propagate_through_ranges() {
    let out = table(&[&["1"], &["=1/0"], &["=SUMA(A1:A2)"], &["=A2+1"]]);
    assert_eq!(out[2][0], Value::Error(FormulaError::Div0));
    assert_eq!(out[3][0], Value::Error(FormulaError::Div0));
    let out = table(&[&["x"], &["2"], &["=SUMA(A1:A2)"]]);
    assert_eq!(out[2][0], Value::Number(2.0));
}

#[test]
fn concat_and_comparison_precedence() {
    assert_eq!(show("=-2^2"), "4");
    assert_eq!(show("=2^-1"), "0,5");
    assert_eq!(show("=\"a\"&1+1"), "a2");
    assert_eq!(show("=1+2=3"), "PRAWDA");
    assert_eq!(show("=\"x\"&(1=1)"), "xPRAWDA");
    // `&` binds tighter than `<`, so this compares "x1" with 2: mixed types.
    assert_eq!(show("=\"x\"&1<2"), "#ARG!");
}
