use super::chunks::{HARD, PIECE, note_sections, parse_layer, split_pieces, strip_front_matter};
use super::SearchError;

#[test]
fn front_matter_is_stripped_only_when_closed() {
    let (front, body) = strip_front_matter("---\ntags: [a]\n---\n# T\n");
    assert_eq!(front, Some("tags: [a]\n"));
    assert_eq!(body, "# T\n");
    assert_eq!(strip_front_matter("---\nno end\n"), (None, "---\nno end\n"));
    assert_eq!(strip_front_matter("# bez\n").1, "# bez\n");
}

#[test]
fn sections_follow_h1_to_h3_with_heading_paths() {
    let body = "intro\n# A\na1\n## B\nb1\n### C\nc1\n#### nie nagłówek\n## D\nd1\n#tag nie\n";
    let secs = note_sections(body);
    let places: Vec<&str> = secs.iter().map(|s| s.place.as_str()).collect();
    assert_eq!(places, ["", "A", "A > B", "A > B > C", "A > D"]);
    assert!(secs[3].text.contains("#### nie nagłówek"));
    assert!(secs[4].text.contains("#tag nie"));
    assert_eq!(secs[2].text, "## B\nb1\n");
}

#[test]
fn headings_in_code_fences_do_not_split() {
    let secs = note_sections("# A\n```\n# nie\n```\n## B\n");
    assert_eq!(secs.len(), 2);
    assert!(secs[0].text.contains("# nie"));
}

#[test]
fn short_text_is_one_piece() {
    assert_eq!(split_pieces("krótko\n\nakapit"), vec!["krótko\n\nakapit"]);
    assert!(split_pieces("  \n\n ").is_empty());
}

#[test]
fn long_text_splits_on_paragraphs_up_to_the_piece_size() {
    let para = "a".repeat(700);
    let text = format!("{para}\n\n{para}\n\n{para}");
    let pieces = split_pieces(&text);
    assert_eq!(pieces.len(), 2);
    assert_eq!(pieces[0], format!("{para}\n\n{para}"));
    assert_eq!(pieces[1], para);
    assert!(pieces.iter().all(|p| p.chars().count() <= PIECE));
}

#[test]
fn paragraph_under_hard_limit_is_never_cut() {
    let para = "b".repeat(2500);
    let pieces = split_pieces(&format!("x\n\n{para}"));
    assert!(pieces.iter().any(|p| p == &para));
}

#[test]
fn huge_paragraph_is_cut_on_lines() {
    let line = "c".repeat(900);
    let para = (0..5).map(|_| line.clone()).collect::<Vec<_>>().join("\n");
    assert!(para.chars().count() > HARD);
    let pieces = split_pieces(&para);
    assert!(pieces.len() >= 3);
    assert!(pieces.iter().all(|p| p.split('\n').all(|l| l.len() == 900)));
}

#[test]
fn layer_pages_and_flags() {
    let md = "---\nschema: notes-filetext-v1\nmethod: mixed\n---\n\n## Strona 1\nFAKTURA\n\\# zdanie\n\n## Strona 2 · niska jakość\n_(brak tekstu)_\n## Obraz\nparagon\n";
    let pages = parse_layer(md).expect("valid layer");
    assert_eq!(pages.len(), 3);
    assert_eq!((pages[0].num, pages[0].low), (1, false));
    assert_eq!(pages[0].text, "FAKTURA\n# zdanie");
    assert!(pages[1].low);
    assert_eq!(pages[1].text, "");
    assert!(pages[2].obraz);
    assert_eq!(pages[2].text, "paragon");
}

#[test]
fn malformed_layers_are_rejected() {
    let head = "---\nschema: notes-filetext-v1\n---\n";
    let cases = [
        "## Strona 1\nx\n".to_string(),
        "---\nschema: inny\n---\n## Strona 1\n".to_string(),
        format!("{head}tekst przed sekcją\n"),
        format!("{head}## Strona 0\n"),
        format!("{head}## Strona x\n"),
        format!("{head}## Strona 1 · dziwna flaga\n"),
        format!("{head}## Strona 1\n## Strona 1\n"),
        format!("{head}## Rozdział\n"),
        format!("{head}## Obraz\n## Obraz\n"),
        format!("{head}## Strona 99999999999999\n"),
    ];
    for md in cases {
        assert!(matches!(parse_layer(&md), Err(SearchError::Layer(_))), "accepted: {md:?}");
    }
}
