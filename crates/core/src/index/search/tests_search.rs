use super::{Kind, SearchIndex};

const LAYER: &str = "---\nschema: notes-filetext-v1\n---\n\n## Strona 1\nFAKTURA VAT nr 12/03\nSerwer dedykowany, miesięczny abonament.\n\n## Strona 2 · niska jakość\nTermin płatności 14 dni.\n";

fn index() -> SearchIndex {
    let mut idx = SearchIndex::new();
    idx.upsert_note("a", "Projekty/Żółw.md", "---\ntags: [zwierzeta/gady]\n---\n# Żółw\nOpieka nad żółwiem Gustawem.\n## Lampa\nUVB co sześć miesięcy.\n");
    idx.upsert_note("b", "Kuchnia/Kawa.md", "# Kawa\nFrench press, mielenie średnie, woda 93 stopnie.\n");
    idx.upsert_note("c", "Projekty/Budżet.md", "# Budżet\nBudżet projektu na II kwartał. Koszty serwera.\n");
    idx.upsert_file_text("f1", "Faktura.pdf", "application/pdf", LAYER).expect("layer");
    idx
}

#[test]
fn ranking_prefers_more_and_rarer_matches() {
    let page = index().search("serwera", 10, 0, None);
    assert_eq!(page.hits[0].doc_id, "c");
    assert_eq!(page.total, 2);
}

#[test]
fn inflection_and_diacritics_match_each_other() {
    let idx = index();
    for q in ["zolw", "ŻÓŁW", "żółwiem", "Gustawem"] {
        assert!(idx.search(q, 5, 0, None).hits.iter().any(|h| h.doc_id == "a"), "query {q}");
    }
    assert!(idx.search("budzet", 5, 0, None).hits.iter().any(|h| h.doc_id == "c"));
}

#[test]
fn trigram_fallback_finds_typos_and_weights_them() {
    let idx = index();
    let page = idx.search("frenchh", 5, 0, None);
    assert!(page.hits.iter().any(|h| h.doc_id == "b"), "{page:?}");
    let typo = idx.search("serwerr", 5, 0, None);
    assert!(typo.hits.iter().any(|h| h.doc_id == "c"));
    let exact = idx.search("french", 5, 0, None).hits[0].score;
    let fuzzy = page.hits[0].score;
    assert!(fuzzy < exact, "fuzzy {fuzzy} exact {exact}");
}

#[test]
fn short_words_get_no_fallback() {
    assert!(index().search("kot", 5, 0, None).hits.is_empty());
}

#[test]
fn phrase_requires_consecutive_tokens() {
    let idx = index();
    assert_eq!(idx.search("\"budżet projektu\"", 5, 0, None).total, 1);
    assert_eq!(idx.search("\"projektu budżet\"", 5, 0, None).total, 0);
}

#[test]
fn exclusion_drops_chunks_with_the_word() {
    let idx = index();
    let all = idx.search("serwer", 9, 0, None);
    let without = idx.search("serwer -dedykowany", 9, 0, None);
    assert!(all.hits.iter().any(|h| h.doc_id == "f1"));
    assert!(without.hits.iter().all(|h| h.doc_id != "f1"));
}

#[test]
fn tag_filter_includes_nested_tags() {
    let idx = index();
    let page = idx.search("tag:zwierzeta", 5, 0, None);
    assert_eq!(page.total, 2);
    assert!(page.hits.iter().all(|h| h.doc_id == "a"));
    assert_eq!(idx.search("tag:zwierzeta/gady", 5, 0, None).total, 2);
    assert_eq!(idx.search("tag:gady", 5, 0, None).total, 0);
}

#[test]
fn filters_by_kind_mime_and_name() {
    let idx = index();
    assert_eq!(idx.search("w:pliki", 9, 0, None).total, 2);
    assert_eq!(idx.search("w:notatki", 9, 0, None).total, 4);
    assert_eq!(idx.search("typ:pdf faktura", 9, 0, None).total, 1);
    assert_eq!(idx.search("typ:obraz faktura", 9, 0, None).total, 0);
    assert!(idx.search("file: faktura", 9, 0, None).hits.iter().all(|h| h.kind == Kind::File));
    assert_eq!(idx.search("path:Projekty/", 9, 0, None).total, 3);
    assert_eq!(idx.search("path:faktura", 9, 0, None).total, 2);
}

#[test]
fn file_hits_carry_pages_as_places() {
    let page = index().search("płatności", 5, 0, None);
    let hit = &page.hits[0];
    assert_eq!((hit.kind, hit.doc_id.as_str(), hit.place.as_str()), (Kind::File, "f1", "s.2"));
    assert_eq!(hit.title, "Faktura.pdf");
    assert_eq!(hit.chunk_id, "f:f1#s2");
}

#[test]
fn snippet_is_short_and_cut_at_words() {
    let long = format!("{} Tu jest szukany termin serwera. {}", "słowo ".repeat(120), "dalej ".repeat(120));
    let mut idx = SearchIndex::new();
    idx.upsert_note("x", "x.md", &long);
    let hit = idx.search("szukany", 1, 0, None).hits.remove(0);
    assert!(hit.snippet.chars().count() <= 200, "{}", hit.snippet.chars().count());
    assert!(hit.snippet.starts_with('…') && hit.snippet.ends_with('…'));
    assert!(hit.snippet.contains("szukany termin serwera."));
    let body = hit.snippet.trim_matches('…');
    assert!(body.split(' ').all(|w| w == "słowo" || w == "dalej" || w == "szukany" || w == "Tu" || w == "jest" || w == "termin" || w == "serwera." || w.is_empty()));
}

#[test]
fn read_returns_chunk_note_and_file_ranges() {
    let idx = index();
    let chunk = idx.read("n:a#2", None, 0, 0, None).expect("chunk");
    assert_eq!(chunk.place, "Żółw > Lampa");
    assert!(chunk.text.starts_with("## Lampa"));
    let note = idx.read("a", None, 0, 0, None).expect("note");
    assert_eq!(note.title, "Projekty/Żółw.md");
    assert_eq!(idx.read("n:a", None, 0, 0, None).map(|r| r.text), Some(note.text.clone()));
    let part = idx.read("a", None, 4, 6, None).expect("slice");
    assert_eq!(part.text.chars().count(), 6);
    assert!(part.more);
    let tail = idx.read("a", None, note.total_chars, 10, None).expect("end");
    assert_eq!(tail.text, "");
    assert!(!tail.more);
    let pages = idx.read("f1", Some((2, 2)), 0, 0, None).expect("page 2");
    assert!(pages.text.starts_with("## Strona 2 · niska jakość\nTermin"));
    assert!(idx.read("f1", Some((5, 6)), 0, 0, None).is_none());
    assert!(idx.read("a", Some((1, 1)), 0, 0, None).is_none());
    assert!(idx.read("nie-ma", None, 0, 0, None).is_none());
}

#[test]
fn read_default_limit_is_twenty_thousand_characters() {
    let mut idx = SearchIndex::new();
    idx.upsert_note("big", "big.md", &"ą".repeat(30_000));
    let r = idx.read("big", None, 0, 0, None).expect("note");
    assert_eq!(r.text.chars().count(), 20_000);
    assert!(r.more);
    assert!(r.total_chars >= 30_000, "joined chunks keep the text, with separators between pieces");
}

#[test]
fn outline_for_notes_and_files() {
    let idx = index();
    let note = idx.outline("a", None).expect("note outline");
    let places: Vec<&str> = note.iter().map(|i| i.place.as_str()).collect();
    assert_eq!(places, ["Żółw", "Żółw > Lampa"]);
    assert!(note.iter().all(|i| i.first_line.is_none() && !i.low_quality && i.tokens_approx > 0));
    let file = idx.outline("f1", None).expect("file outline");
    assert_eq!(file.len(), 2);
    assert_eq!(file[0].first_line.as_deref(), Some("FAKTURA VAT nr 12/03"));
    assert!(!file[0].low_quality);
    assert!(file[1].low_quality);
    assert_eq!(file[1].chunk_id, "f:f1#s2");
    assert!(idx.outline("brak", None).is_none());
}

#[test]
fn malformed_layer_is_refused_and_old_version_stays() {
    let mut idx = index();
    let before = idx.search("płatności", 5, 0, None).total;
    assert!(idx.upsert_file_text("f1", "x.pdf", "application/pdf", "## Strona 1\nbez nagłówka\n").is_err());
    assert_eq!(idx.search("płatności", 5, 0, None).total, before);
    assert!(idx.upsert_file_text("f2", "y.pdf", "application/pdf", "zwykły tekst").is_err());
    assert!(idx.outline("f2", None).is_none());
}

#[test]
fn removed_documents_never_come_back() {
    let mut idx = index();
    idx.remove_note("a");
    idx.remove_file("f1");
    for q in ["zolw", "gustawem", "tag:zwierzeta", "w:pliki", "faktura", "płatności", "serwer", "w:notatki"] {
        let page = idx.search(q, 20, 0, None);
        assert!(page.hits.iter().all(|h| h.doc_id != "a" && h.doc_id != "f1"), "query {q}");
    }
    assert!(idx.outline("a", None).is_none());
    assert!(idx.read("n:a#1", None, 0, 0, None).is_none());
}

#[test]
fn reindexing_a_note_replaces_its_chunks() {
    let mut idx = index();
    idx.upsert_note("b", "Kuchnia/Kawa.md", "# Herbata\nZielona.\n");
    assert!(idx.search("french", 5, 0, None).hits.is_empty());
    assert!(idx.read("n:b#2", None, 0, 0, None).is_none());
    assert_eq!(idx.outline("b", None).map(|o| o.len()), Some(1));
}

#[test]
fn ranking_is_deterministic_and_paged() {
    let idx = index();
    let all = idx.search("projektu serwera zolw", 20, 0, None);
    let again = idx.search("projektu serwera zolw", 20, 0, None);
    assert_eq!(all, again);
    let second = idx.search("projektu serwera zolw", 1, 1, None);
    assert_eq!(second.hits.len(), 1);
    assert_eq!(second.hits[0], all.hits[1]);
}

#[test]
fn empty_and_huge_queries() {
    let idx = index();
    assert_eq!(idx.search("", 5, 0, None).total, 0);
    assert_eq!(idx.search("   -x ", 5, 0, None).total, 0);
    let big = "zolw ".repeat(400);
    assert!(idx.search(&big, 5, 0, None).total >= 1);
}

#[test]
fn texts_over_two_megabytes_are_indexed_up_to_the_cap() {
    let mut idx = SearchIndex::new();
    let tail = format!("{}\n\nkoniecznik", "x ".repeat(1_100_000));
    idx.upsert_note("long", "long.md", &tail);
    assert!(idx.search("koniecznik", 5, 0, None).hits.is_empty());
    idx.upsert_note("short", "short.md", "na początku koniec");
    assert!(idx.search("koniec", 5, 0, None).total >= 1);
}

#[test]
fn filter_only_query_lists_matching_chunks_with_zero_score() {
    let idx = index();
    let page = idx.search("tag:zwierzeta", 9, 0, None);
    assert!(page.hits.iter().all(|h| h.score == 0.0));
}
