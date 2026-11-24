use super::query::parse;
use super::Kind;

fn terms(q: &str) -> Vec<(String, bool)> {
    parse(q, false).terms
}

#[test]
fn last_plain_word_is_prefix_matched_if_long_enough() {
    assert_eq!(terms("kawa buda"), vec![("kawa".into(), false), ("buda".into(), true)]);
    assert_eq!(terms("kawa a"), vec![("kawa".into(), false), ("a".into(), false)]);
}

#[test]
fn phrases_and_exclusions() {
    let q = parse("\"budżet projektu\" -dedykowany -\"stary serwer\"", false);
    assert_eq!(q.phrases, vec![vec!["budzet".to_string(), "projektu".to_string()]]);
    assert_eq!(q.excluded, vec![vec!["dedykowany".to_string()], vec!["stary".to_string(), "serwer".to_string()]]);
    assert!(q.terms.iter().any(|(t, p)| t == "budzet" && !p));
}

#[test]
fn unclosed_quote_is_a_phrase_to_the_end() {
    let q = parse("\"termin platnosci", false);
    assert_eq!(q.phrases, vec![vec!["termin".to_string(), "platnosci".to_string()]]);
}

#[test]
fn tag_path_file_and_kind_operators() {
    let q = parse("tag:Projekt/Triton path:Projekty/ file: typ:pdf w:pliki", false).filter;
    assert_eq!(q.tags, vec!["projekt/triton"]);
    assert_eq!(q.paths, vec!["projekty/"]);
    assert!(q.pdf && !q.image);
    assert_eq!(q.kinds, vec![Kind::File, Kind::File]);
    assert!(q.names.is_empty());
    let f = parse("file:umowa typ:obraz w:notatki", false).filter;
    assert_eq!(f.names, vec!["umowa"]);
    assert!(f.image);
    assert_eq!(f.kinds, vec![Kind::File, Kind::Note]);
}

#[test]
fn unknown_operators_are_plain_words() {
    let q = parse("typ:xyz data:2026 w:cos tag: ", false);
    assert!(q.filter.is_empty());
    let words: Vec<&str> = q.terms.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(words, ["typ", "xyz", "data", "2026", "w", "cos", "tag"]);
}

#[test]
fn negated_operator_is_a_plain_exclusion() {
    let q = parse("-tag:x", false);
    assert!(q.filter.is_empty());
    assert_eq!(q.excluded, vec![vec!["tag".to_string(), "x".to_string()]]);
}

#[test]
fn long_queries_are_cut() {
    let long = "a ".repeat(1500);
    assert!(parse(&long, false).terms.len() <= 500);
}
