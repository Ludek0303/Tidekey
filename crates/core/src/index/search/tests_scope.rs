//! Scope: with `Some(scope)`, nothing outside it may appear in any result. Each API's output is formatted with
//! `Debug` (every field included), and that text is searched for markers that exist only outside the scope.

use super::{EdgeKind, Scope, SearchIndex};

const FIN: &str = "11111111111111111111111111111111";
const FOUT: &str = "22222222222222222222222222222222";

/// Strings that occur only in out-of-scope notes and files (ids, titles, paths, names, tags, text, people).
const MARKERS: &[&str] = &[
    "XHID1", "XCHAIN", FOUT, "Sekret", "sekret", "Tajne", "tajn", "Tajn", "MARKTEXT", "Zosia", "zosia", "Ukryt", "ukryt",
    "Pomost", "pomost",
];

fn corpus() -> SearchIndex {
    let mut idx = SearchIndex::new();
    // In scope.
    idx.upsert_note(
        "s1",
        "Jawny/Plan.md",
        &format!("---\ntags: [jawny]\n---\n# Plan\nBudżet projektu na serwer. Patrz dalej w planie.\n![[plik:{FIN}]]\n- [ ] Dzwonić @ola\n"),
    );
    idx.upsert_note("s2", "Jawny/Druga.md", "Druga notatka o budżecie i serwerze.\n");
    idx.upsert_note("s3", "Jawny/Trasa.md", "Trasa przez most bez zmian.\n");
    idx.upsert_note("cel", "Wspolne/Celownik.md", "# Cel\nTekst celu, niezwiązany z niczym.\n");
    // Out of scope.
    idx.upsert_note(
        "XHID1",
        "Tajne/Sekretny.md",
        &format!("---\ntags: [tajne]\n---\n# Sekretny\nTajna treść MARKTEXT.\n![[plik:{FOUT}]]\n- [ ] Przygotować @Zosia zadanie\n"),
    );
    idx.upsert_note("XCHAIN", "Tajne/Pomost.md", "Pomost do ukrytego celu.\n");
    idx.upsert_file_text(FIN, "Faktura-jawna.pdf", "application/pdf", "---\nschema: notes-filetext-v1\n---\n## Strona 1\nFaktura jawna, serwer.\n").expect("layer");
    idx.upsert_file_text(FOUT, "Faktura-tajna.pdf", "application/pdf", "---\nschema: notes-filetext-v1\n---\n## Strona 1\nTajna faktura MARKTEXT2.\n").expect("layer");
    idx.set_links("s1", &["XHID1".to_string(), "s2".to_string()]);
    idx.set_links("s3", &["XCHAIN".to_string()]);
    idx.set_links("XCHAIN", &["cel".to_string()]);
    idx.set_people(&["Zosia".to_string()]);
    idx
}

fn scope() -> Scope {
    Scope {
        people: Default::default(),
        notes: ["s1", "s2", "s3", "cel"].iter().map(|s| s.to_string()).collect(),
        files: [FIN.to_string()].into_iter().collect(),
    }
}

fn assert_hidden(what: &str, output: &str) {
    for m in MARKERS {
        assert!(!output.contains(m), "{what} leaks {m:?}: {output}");
    }
}

#[test]
fn search_hides_out_of_scope_documents_operators_and_fallbacks() {
    let idx = corpus();
    let sc = scope();
    let queries = [
        "sekretny", "sekret", "sekretnyy", "tajna", "tajn", "MARKTEXT", "MARKTEXT2", "tag:tajne", "path:Tajne",
        "file: tajna", "typ:pdf faktura", "w:pliki faktura", "w:notatki pomost", "zosia", "zosiaa", "ukryty", "pomost",
        "pomoście", "celownik", "most", "\"tajna faktura\"", "tajnej -tajna", "budżet", "budzec", "serwer", "tag:jawny",
        "dzwonić", "faktura",
    ];
    let mut any_inside = 0;
    for q in queries {
        let page = idx.search(q, 50, 0, Some(&sc));
        any_inside += page.total;
        assert_hidden(&format!("search {q:?}"), &format!("{page:?}"));
    }
    assert!(any_inside > 0, "in-scope results exist");
    // Without a scope the same index does see the hidden documents.
    assert!(idx.search("MARKTEXT", 5, 0, None).total >= 1);
}

#[test]
fn outline_and_read_refuse_out_of_scope_ids() {
    let idx = corpus();
    let sc = scope();
    let (fout, fout_page) = (format!("f:{FOUT}"), format!("f:{FOUT}#s1"));
    for id in ["XHID1", "n:XHID1", FOUT, fout.as_str(), "XCHAIN", "n:XCHAIN", "n:XHID1#1", fout_page.as_str()] {
        assert!(idx.outline(id, Some(&sc)).is_none(), "outline {id}");
        assert!(idx.read(id, None, 0, 0, Some(&sc)).is_none(), "read {id}");
        assert!(idx.read(id, Some((1, 1)), 0, 0, Some(&sc)).is_none(), "read pages {id}");
    }
    assert!(idx.outline("s1", Some(&sc)).is_some());
    assert!(idx.outline(&format!("f:{FIN}"), Some(&sc)).is_some());
    let inside = idx.read("n:s1#1", None, 0, 0, Some(&sc)).expect("in-scope chunk");
    assert_hidden("read in-scope chunk", &format!("{inside:?}"));
    assert!(idx.read("n:s1", None, 0, 0, Some(&sc)).is_some());
    assert_hidden("outline s1", &format!("{:?}", idx.outline("s1", Some(&sc))));
    assert_hidden("read s1 whole", &format!("{:?}", idx.read("s1", None, 0, 0, Some(&sc))));
}

#[test]
fn neighbors_do_not_reach_through_out_of_scope_notes() {
    let idx = corpus();
    let sc = scope();
    for depth in [1, 2] {
        let n = idx.neighbors("n:s1", depth, None, 100, Some(&sc)).expect("in-scope start");
        assert_hidden(&format!("neighbors s1 depth {depth}"), &format!("{n:?}"));
    }
    assert!(idx.neighbors("n:XHID1", 1, None, 30, Some(&sc)).is_none());
    assert!(idx.neighbors(&format!("f:{FOUT}"), 1, None, 30, Some(&sc)).is_none());
    assert!(idx.neighbors(FOUT, 1, None, 30, Some(&sc)).is_none());
    // the same ids exist without a scope, so the checks above test the scope, not a typo
    assert!(idx.neighbors(&format!("f:{FOUT}"), 1, None, 30, None).is_some());
    // cel is in scope but only reachable through the hidden XCHAIN, so from s3 it must not show up.
    let from_s3 = idx.neighbors("n:s3", 2, None, 100, Some(&sc)).expect("in-scope start");
    assert!(!from_s3.nodes.iter().any(|n| n.id == "n:cel"), "reached through an out-of-scope note: {from_s3:?}");
    assert_hidden("neighbors s3", &format!("{from_s3:?}"));
    // Unscoped, the chain is visible.
    let open = idx.neighbors("n:s3", 2, None, 100, None).expect("start");
    assert!(open.nodes.iter().any(|n| n.id == "n:cel"));
}

#[test]
fn map_overview_counts_only_what_is_visible() {
    let idx = corpus();
    let sc = scope();
    let m = idx.map_overview(Some(&sc));
    assert_hidden("map_overview", &format!("{m:?}"));
    assert_eq!(m.files_total, 1);
    assert_eq!(m.files_with_text, 1);
    assert!(m.folders.iter().all(|(p, _)| p == "Jawny" || p == "Wspolne"), "{:?}", m.folders);
    assert!(!m.people.iter().any(|(p, _)| p == "zosia"));
    assert!(!m.top_tags.iter().any(|(t, _)| t == "tajne"));
    // Unscoped, the hidden things are counted.
    let open = idx.map_overview(None);
    assert_eq!(open.files_total, 2);
    assert!(open.top_tags.iter().any(|(t, _)| t == "tajne"));
}

#[test]
fn find_files_hides_out_of_scope_files_and_embedding_notes() {
    let idx = corpus();
    let sc = scope();
    let all = idx.find_files(None, None, None, 50, 0, Some(&sc));
    assert_hidden("find_files", &format!("{all:?}"));
    assert_eq!(all.total, 1);
    assert_eq!(all.files[0].embedded_in, vec!["s1".to_string()]);
    assert_eq!(idx.find_files(Some("tajna"), None, None, 50, 0, Some(&sc)).total, 0);
    assert_eq!(idx.find_files(None, Some("pdf"), Some("Tajne"), 50, 0, Some(&sc)).total, 0);
    assert_eq!(idx.find_files(None, None, Some("Jawny"), 50, 0, Some(&sc)).total, 1);
    let open = idx.find_files(None, None, None, 50, 0, None);
    assert_eq!(open.total, 2);
}

#[test]
fn an_empty_scope_shows_nothing() {
    let idx = corpus();
    let empty = Scope::default();
    assert_eq!(idx.search("serwer", 10, 0, Some(&empty)).total, 0);
    assert!(idx.outline("s1", Some(&empty)).is_none());
    assert!(idx.neighbors("n:s1", 1, None, 10, Some(&empty)).is_none());
    let m = idx.map_overview(Some(&empty));
    assert_eq!((m.files_total, m.folders.len(), m.people.len(), m.top_tags.len()), (0, 0, 0, 0));
    assert_eq!(idx.find_files(None, None, None, 10, 0, Some(&empty)).total, 0);
}

#[test]
fn a_mention_leading_out_of_scope_is_dropped_and_not_counted() {
    let mut idx = SearchIndex::new();
    idx.upsert_note("p1", "Jawny/Opis.md", "Mamuta to Mamuta, a Mamuta jeszcze raz.\n");
    idx.upsert_note("zz", "Skryte/Mamuta.md", "Tekst.\n");
    let sc = Scope { notes: ["p1".to_string()].into_iter().collect(), files: Default::default(), people: Default::default() };
    let scoped = idx.map_overview(Some(&sc));
    let open = idx.map_overview(None);
    let deg = |m: &super::MapOverview, id: &str| m.hubs.iter().find(|h| h.id == id).map(|h| h.degree);
    assert_eq!(deg(&open, "p1"), Some(2), "folder edge and mention edge");
    assert_eq!(deg(&scoped, "p1"), Some(1), "only the folder edge is visible");
    assert_hidden("scoped mention", &format!("{scoped:?}"));
    assert!(idx.neighbors("n:p1", 1, None, 10, Some(&sc)).expect("start").nodes.iter().all(|n| n.id != "n:zz"));
}

fn only(notes: &[&str]) -> Scope {
    Scope { notes: notes.iter().map(|s| s.to_string()).collect(), files: Default::default(), people: Default::default() }
}

#[test]
fn scores_do_not_tell_how_much_text_lies_outside_the_scope() {
    let mut small = SearchIndex::new();
    small.upsert_note("a", "A.md", "Budżet serwera na przyszły rok.\n");
    small.upsert_note("b", "B.md", "Serwer w szafie.\n");
    let mut big = SearchIndex::new();
    big.upsert_note("a", "A.md", "Budżet serwera na przyszły rok.\n");
    big.upsert_note("b", "B.md", "Serwer w szafie.\n");
    for i in 0..50 {
        big.upsert_note(&format!("x{i}"), &format!("X/{i}.md"), "Długa ukryta treść o czymś zupełnie innym, bardzo długa i rozwlekła.\n");
    }
    let scores = |idx: &SearchIndex, scope: Option<&Scope>| -> Vec<(String, u32)> {
        idx.search("serwer", 10, 0, scope).hits.into_iter().map(|h| (h.doc_id, h.score.to_bits())).collect()
    };
    let scope = only(&["a", "b"]);
    assert_eq!(scores(&big, Some(&scope)), scores(&small, None));
}

#[test]
fn a_person_known_only_from_a_note_outside_the_scope_is_not_shown() {
    let mut idx = SearchIndex::new();
    idx.upsert_note("jawna", "Jawna.md", "Rozmowa z Bartoszem o wyjeździe, Bartosz dzwonił.\n");
    idx.upsert_note("ukryta", "Ukryta.md", "- [ ] Zadanie @Bartosz\n");
    let scope = only(&["jawna"]);
    let out = format!("{:?}{:?}", idx.map_overview(Some(&scope)), idx.neighbors("n:jawna", 2, None, 100, Some(&scope)));
    assert!(!out.to_lowercase().contains("bartosz"), "{out}");
    // without a scope the same person is a mention target
    assert!(format!("{:?}", idx.neighbors("n:jawna", 1, None, 100, None)).to_lowercase().contains("p:bartosz"));
}

#[test]
fn a_bare_id_of_a_hidden_note_and_a_visible_file_is_the_file() {
    let id = "33333333333333333333333333333333";
    let mut idx = SearchIndex::new();
    idx.upsert_note(id, "Tajne/Ta.md", "Ukryta notatka.\n");
    idx.upsert_file_text(id, "Jawny.pdf", "application/pdf", "---\nschema: notes-filetext-v1\n---\n## Strona 1\nJawny plik.\n").expect("layer");
    let sc = Scope { files: [id.to_string()].into_iter().collect(), ..Default::default() };
    let outline = format!("{:?}", idx.outline(id, Some(&sc)).expect("the file"));
    assert!(outline.contains("s.1") || outline.contains("#s1"), "{outline}");
    assert!(!format!("{:?}", idx.read(id, None, 0, 0, Some(&sc))).contains("Ukryta"));
}

#[test]
fn a_long_query_of_nonsense_words_stays_cheap() {
    let mut idx = SearchIndex::new();
    for i in 0..2000 {
        idx.upsert_note(&format!("n{i}"), &format!("N/{i}.md"), &format!("słowo{i} inne{} kolejne{} jeszcze{}\n", i * 7, i * 13, i * 31));
    }
    let words: Vec<String> = (0..200).map(|i| format!("qxzv{i:03}")).collect();
    let query = words.join(" ");
    let start = std::time::Instant::now();
    idx.search(&query, 10, 0, None);
    idx.search(&"qxzvw ".repeat(150), 10, 0, None);
    let took = start.elapsed();
    // 4 fuzzy terms at most: in debug builds still well under a second
    assert!(took < std::time::Duration::from_secs(if cfg!(debug_assertions) { 5 } else { 1 }), "{took:?}");
}

#[test]
fn search_and_read_pages_are_capped() {
    let mut idx = SearchIndex::new();
    for i in 0..80 {
        idx.upsert_note(&format!("n{i}"), &format!("N/{i}.md"), "wspólne słowo\n");
    }
    let page = idx.search("wspólne", 1000, 0, None);
    assert_eq!((page.hits.len(), page.total), (50, 80));
    idx.upsert_note("long", "L.md", &"abc ".repeat(20_000));
    let read = format!("{:?}", idx.read("long", None, 0, 1_000_000, None).expect("read"));
    assert!(read.len() < 25_000, "{}", read.len());
}

/// The people rule: `Scope.people` only selects among the mention targets, and those come from `set_people` and
/// from task assignees. A name that only appears in plain text, with neither, is not a target.
#[test]
fn scope_people_alone_does_not_make_a_text_name_a_mention_target() {
    let mut idx = SearchIndex::new();
    idx.upsert_note("a", "Jawna/A.md", "Rozmowa z Bartosz o serwerze.\n");
    let sc = Scope {
        notes: ["a".to_string()].into_iter().collect(),
        people: ["bartosz".to_string()].into_iter().collect(),
        ..Default::default()
    };
    let has_target = |idx: &SearchIndex| {
        idx.neighbors("n:a", 1, Some(&[EdgeKind::Mention][..]), 100, Some(&sc)).expect("start").nodes.iter().any(|n| n.id == "p:bartosz")
    };
    assert!(!has_target(&idx), "Scope.people alone must not make a text-only name a mention target");
    assert!(idx.map_overview(Some(&sc)).people.is_empty());
    // with set_people, the same scope selects the name
    idx.set_people(&["Bartosz".to_string()]);
    assert!(has_target(&idx), "set_people and Scope.people together select the name");
}

mod differential {
    //! A scoped call on the whole index must equal the same call on an index of only the visible documents. Both
    //! sides get the same `Scope` and the same `set_people` list, so the people rule matches. Then nothing outside
    //! the scope shows: not in content, order, score, count, or as a start node.
    use std::collections::{BTreeMap, HashSet};

    use proptest::prelude::*;
    use proptest::test_runner::TestCaseError;

    use super::super::{EdgeKind, Scope, SearchIndex};

    const WORDS: &[&str] = &["budżet", "serwer", "faktura", "umowa", "projekt", "kowalski", "plan", "rachunek", "spotkanie", "zadanie"];
    /// Names in tasks and body text, and the `set_people` list. `person(k)` maps 0 to no name.
    const PEOPLE: [&str; 2] = ["Bartosz", "Kasia"];
    /// Name and mime type of the three files. The first two have a text layer; the third is known by name only.
    const FILES: [(&str, &str); 3] = [("Faktura-jawna.pdf", "application/pdf"), ("Umowa-tajna.pdf", "application/pdf"), ("Skan.png", "image/png")];

    #[derive(Debug, Clone)]
    struct Note {
        words: Vec<usize>,
        visible: bool,
        /// Shared tag `wspolny`.
        tag: bool,
        /// Person in a task (`- [ ] … @name`); 0 for none.
        task: usize,
        /// Person in body text; 0 for none.
        body: usize,
        /// File embedded with `![[plik:…]]`: 0 for none, else the file index plus one.
        embed: usize,
        /// Plain-text mention of the next note's title.
        mention: bool,
    }

    fn note() -> impl Strategy<Value = Note> {
        (
            proptest::collection::vec(0usize..WORDS.len(), 1..8),
            any::<bool>(),
            any::<bool>(),
            0usize..3,
            0usize..3,
            0usize..4,
            any::<bool>(),
        )
            .prop_map(|(words, visible, tag, task, body, embed, mention)| Note { words, visible, tag, task, body, embed, mention })
    }

    fn person(k: usize) -> Option<&'static str> {
        k.checked_sub(1).and_then(|i| PEOPLE.get(i).copied())
    }

    /// The word only this note has: `jawny<i>` when visible, `tajny<i>` when hidden.
    fn unique(i: usize, visible: bool) -> String {
        if visible { format!("jawny{i}") } else { format!("tajny{i}") }
    }

    /// Edited forms of a unique word (ASCII, 6 letters): one substitution (edit distance), a 4-letter prefix, and one
    /// inserted letter (trigram similarity 0.5).
    fn variants(w: &str) -> [String; 3] {
        [format!("{}q{}", &w[..1], &w[2..]), w[..4].to_string(), format!("{}y{}", &w[..5], &w[5..])]
    }

    fn layer(file: usize, word: &str) -> String {
        if file == 0 {
            format!("---\nschema: notes-filetext-v1\n---\n## Strona 1\nFaktura jawna {word}.\n## Strona 2\nDrugi jawny akapit.\n")
        } else {
            format!("---\nschema: notes-filetext-v1\n---\n## Strona 1\nUmowa wzorcowa {word}.\n## Strona 2\nZałącznik drugi.\n")
        }
    }

    /// Path and text of note `i` of `n`.
    fn note_doc(i: usize, n: usize, note: &Note, file_ids: &[String]) -> (String, String) {
        let uniq = unique(i, note.visible);
        let words: Vec<&str> = note.words.iter().map(|w| WORDS[*w]).collect();
        let mut tags = Vec::new();
        if note.tag {
            tags.push("wspolny");
        }
        if !note.visible {
            tags.push("tajnyt");
        }
        let mut text = if tags.is_empty() { String::new() } else { format!("---\ntags: [{}]\n---\n", tags.join(", ")) };
        text.push_str(&format!("# Sekcja {i}\n{} ogolny {uniq}\n", words.join(" ")));
        if let Some(p) = person(note.body) {
            text.push_str(&format!("Rozmowa z {p} o serwerze.\n"));
        }
        if let Some(p) = person(note.task) {
            text.push_str(&format!("- [ ] Dzwonić @{p}\n"));
        }
        if note.mention {
            text.push_str(&format!("Patrz Notatka{}.\n", (i + 1) % n));
        }
        let rev: Vec<&str> = words.iter().rev().copied().collect();
        text.push_str(&format!("## Dalej\n{} {uniq}\n", rev.join(" ")));
        if let Some(f) = note.embed.checked_sub(1) {
            text.push_str(&format!("![[plik:{}]]\n", file_ids[f]));
        }
        (format!("F{}/Notatka{i}.md", i % 3), text)
    }

    fn search_queries(notes: &[Note], word: &str) -> Vec<String> {
        let mut out: Vec<String> = [
            "ogolny", "faktura", "tajna", "jawna", "tajny", "bartosz", "kasia", "bartosz ogolny", "tag:wspolny", "tag:tajnyt",
            "typ:pdf faktura", "file: faktura", "w:pliki serwer", "w:notatki ogolny", "path:F1 ogolny", "tajnej -tajna",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        out.push(format!("ogolny {word}"));
        out.push(format!("\"ogolny {word}\""));
        out.push(format!("{word} -ogolny"));
        for (i, note) in notes.iter().enumerate() {
            let uniq = unique(i, note.visible);
            out.extend(variants(&uniq));
            out.push(uniq);
        }
        out
    }

    fn same<T: std::fmt::Debug + PartialEq>(what: &str, full: T, part: T) -> Result<(), TestCaseError> {
        if full == part {
            Ok(())
        } else {
            Err(TestCaseError::fail(format!("{what}\nscoped full: {full:?}\nvisible only: {part:?}")))
        }
    }

    /// Neighbors and the overview. `unscoped` also compares the visible-only index with no scope, which is the same
    /// as a scope holding every `set_people` name.
    fn graph_checks(full: &SearchIndex, part: &SearchIndex, sc: &Scope, starts: &[String], unscoped: bool) -> Result<(), TestCaseError> {
        let types: [Option<&[EdgeKind]>; 2] = [None, Some(&[EdgeKind::Mention, EdgeKind::Tag][..])];
        for start in starts {
            for depth in [1, 2] {
                for ty in types {
                    let what = format!("neighbors {start} depth {depth} types {ty:?}");
                    same(&what, full.neighbors(start, depth, ty, 100, Some(sc)), part.neighbors(start, depth, ty, 100, Some(sc)))?;
                    if unscoped {
                        same(&what, full.neighbors(start, depth, ty, 100, Some(sc)), part.neighbors(start, depth, ty, 100, None))?;
                    }
                }
            }
            for ty in types {
                same(&format!("edges {ty:?}"), full.edges(ty, Some(sc)), part.edges(ty, Some(sc)))?;
                if unscoped {
                    same(&format!("edges {ty:?} unscoped"), full.edges(ty, Some(sc)), part.edges(ty, None))?;
                }
            }
            let what = format!("neighbors {start} limit 2");
            same(&what, full.neighbors(start, 2, None, 2, Some(sc)), part.neighbors(start, 2, None, 2, Some(sc)))?;
        }
        same("map_overview", full.map_overview(Some(sc)), part.map_overview(Some(sc)))?;
        if unscoped {
            same("map_overview unscoped", full.map_overview(Some(sc)), part.map_overview(None))?;
        }
        Ok(())
    }

    fn check_all(notes: &[Note], links: &[(usize, usize)], file_visible: [bool; 3], file_word: usize, people_mask: u8) -> Result<(), TestCaseError> {
        let n = notes.len();
        let file_ids: Vec<String> = ["a", "b", "c"].iter().map(|c| c.repeat(32)).collect();
        let mut full = SearchIndex::new();
        let mut part = SearchIndex::new();
        let mut vis = Scope::default();
        for (i, note) in notes.iter().enumerate() {
            let id = format!("n{i}");
            let (path, text) = note_doc(i, n, note, &file_ids);
            full.upsert_note(&id, &path, &text);
            if note.visible {
                part.upsert_note(&id, &path, &text);
                vis.notes.insert(id);
            }
        }
        let word = WORDS[file_word];
        for (f, (name, mime)) in FILES.iter().enumerate() {
            let id = &file_ids[f];
            let text_layer = f < 2;
            let state = if text_layer { "text" } else { "pending" };
            full.set_file(id, name, mime, state);
            if text_layer {
                full.upsert_file_text(id, name, mime, &layer(f, word)).map_err(|e| TestCaseError::fail(e.to_string()))?;
            }
            if file_visible[f] {
                vis.files.insert(id.clone());
                part.set_file(id, name, mime, state);
                if text_layer {
                    part.upsert_file_text(id, name, mime, &layer(f, word)).map_err(|e| TestCaseError::fail(e.to_string()))?;
                }
            }
        }
        let mut by_source: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for &(a, b) in links {
            by_source.entry(format!("n{}", a % n)).or_default().push(format!("n{}", b % n));
        }
        for (src, targets) in &by_source {
            full.set_links(src, targets);
            if vis.notes.contains(src) {
                let kept: Vec<String> = targets.iter().filter(|t| vis.notes.contains(*t)).cloned().collect();
                part.set_links(src, &kept);
            }
        }
        let names: Vec<String> = PEOPLE.iter().map(|p| p.to_string()).collect();
        full.set_people(&names);
        part.set_people(&names);

        // Scope.people: the bit mask over PEOPLE (0..4); the full set equals the set_people list.
        let chosen: HashSet<String> =
            PEOPLE.iter().enumerate().filter(|(k, _)| (people_mask >> *k) & 1 == 1).map(|(_, p)| p.to_lowercase()).collect();
        let both = people_mask == 3;
        let sc = Scope { people: chosen, ..vis.clone() };
        let no_people = Scope { people: HashSet::new(), ..vis.clone() };

        // search: every query, with several pages (an offset, a small limit, and limit 0)
        for q in search_queries(notes, word) {
            for (limit, offset) in [(50, 0), (2, 1), (1, 3), (0, 0)] {
                let what = format!("search {q:?} limit {limit} offset {offset}");
                same(&what, full.search(&q, limit, offset, Some(&sc)), part.search(&q, limit, offset, Some(&sc)))?;
                if both {
                    same(&what, full.search(&q, limit, offset, Some(&sc)), part.search(&q, limit, offset, None))?;
                }
            }
        }
        // hidden-only words find nothing in scope (and do find something unscoped, so the check is not vacuous);
        // a visible word finds its own note
        for (i, note) in notes.iter().enumerate() {
            let uniq = unique(i, note.visible);
            if note.visible {
                prop_assert!(full.search(&uniq, 50, 0, Some(&sc)).total >= 1, "visible word {uniq:?} lost");
                continue;
            }
            for q in std::iter::once(uniq.clone()).chain(variants(&uniq)) {
                let inside = full.search(&q, 50, 0, Some(&sc)).total;
                prop_assert_eq!(inside, 0, "hidden word {:?} found in scope", q);
                prop_assert!(full.search(&q, 50, 0, None).total >= 1, "unscoped search misses {:?}", q);
            }
        }

        // nodes: notes by id and bare id, chunks, tags, folders, people, files; depth 1 and 2, all kinds and Mention+Tag
        let mut starts: Vec<String> = Vec::new();
        for i in 0..n {
            starts.push(format!("n:n{i}"));
            starts.push(format!("n{i}"));
        }
        starts.extend(["t:wspolny", "t:tajnyt", "d:F0", "d:F1", "d:F2", "p:bartosz", "p:kasia"].iter().map(|s| s.to_string()));
        for id in &file_ids {
            starts.push(format!("f:{id}"));
            starts.push(id.clone());
        }
        graph_checks(&full, &part, &sc, &starts, both)?;
        graph_checks(&full, &part, &no_people, &starts, false)?;

        // outline and read: notes, chunks and files, whole and by page
        let mut reads = starts.clone();
        for i in 0..n {
            reads.push(format!("n:n{i}#1"));
            reads.push(format!("n:n{i}#2"));
        }
        for id in &file_ids {
            reads.push(format!("f:{id}#s1"));
            reads.push(format!("f:{id}#s2"));
            reads.push(format!("f:{id}#obraz"));
        }
        for id in &reads {
            same(&format!("outline {id}"), full.outline(id, Some(&sc)), part.outline(id, Some(&sc)))?;
            same(&format!("read {id}"), full.read(id, None, 0, 0, Some(&sc)), part.read(id, None, 0, 0, Some(&sc)))?;
            same(&format!("read {id} pages 1..1"), full.read(id, Some((1, 1)), 0, 0, Some(&sc)), part.read(id, Some((1, 1)), 0, 0, Some(&sc)))?;
            same(&format!("read {id} pages 2..2 window"), full.read(id, Some((2, 2)), 1, 5, Some(&sc)), part.read(id, Some((2, 2)), 1, 5, Some(&sc)))?;
            same(&format!("read {id} window"), full.read(id, None, 3, 7, Some(&sc)), part.read(id, None, 3, 7, Some(&sc)))?;
        }

        // files: name, type, folder filters, pages and a limit of 0
        type FindArgs = (Option<&'static str>, Option<&'static str>, Option<&'static str>, usize, usize);
        let finds: [FindArgs; 9] = [
            (None, None, None, 50, 0),
            (Some("faktura"), None, None, 50, 0),
            (Some("tajna"), None, None, 50, 0),
            (Some("a"), None, None, 1, 1),
            (None, Some("pdf"), None, 50, 0),
            (None, Some("obraz"), None, 50, 0),
            (None, None, Some("F1"), 50, 0),
            (None, None, Some("F0"), 1, 0),
            (None, None, None, 0, 0),
        ];
        for (q, typ, folder, limit, offset) in finds {
            let what = format!("find_files {q:?} {typ:?} {folder:?} limit {limit} offset {offset}");
            same(&what, full.find_files(q, typ, folder, limit, offset, Some(&sc)), part.find_files(q, typ, folder, limit, offset, Some(&sc)))?;
            if both {
                same(&what, full.find_files(q, typ, folder, limit, offset, Some(&sc)), part.find_files(q, typ, folder, limit, offset, None))?;
            }
        }
        Ok(())
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]
        #[test]
        fn scoped_equals_an_index_of_the_visible_part(
            notes in proptest::collection::vec(note(), 1..9),
            links in proptest::collection::vec((0usize..9, 0usize..9), 0..10),
            file_visible in proptest::array::uniform3(any::<bool>()),
            file_word in 0usize..WORDS.len(),
            people_mask in 0u8..4,
        ) {
            check_all(&notes, &links, file_visible, file_word, people_mask)?;
        }
    }
}
