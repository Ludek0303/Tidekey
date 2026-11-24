use super::*;

use crate::backend::Backend;
use notes_sync::keystore::MemoryKeyStore;
use yrs::{Doc, Text, Transact};

fn update(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let content = doc.get_or_insert_text("content");
    let mut txn = doc.transact_mut();
    content.insert(&mut txn, 0, text);
    txn.encode_update_v1()
}

#[test]
fn match_expression_quotes_each_word_and_drops_punctuation() {
    assert_eq!(
        match_expr("zolw pływa").as_deref(),
        Some("(\"zolw\"* OR \"zołw\"*) AND (\"pływa\"*)")
    );
    assert_eq!(
        match_expr("a\"b OR *").as_deref(),
        Some("(\"a\"\"b\"*) AND (\"OR\"*)")
    );
    assert_eq!(match_expr("  !!  "), None);
    assert_eq!(match_expr(""), None);
}

#[test]
fn polish_words_are_found_with_and_without_diacritics() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("Staw.md").unwrap();
    b.apply_update(&id, &update("Żółw pływa po stawie"))
        .unwrap();
    b.tick().unwrap();

    for query in ["zolw", "ŻÓŁW", "plywa stawie", "żółw"] {
        let hits = b.search(query, 10).unwrap();
        assert_eq!(hits.len(), 1, "query {query}");
        assert_eq!(hits[0].id, id);
        assert_eq!(hits[0].path, "Staw.md");
    }
    assert!(b.search("kot", 10).unwrap().is_empty());
    assert!(b.search("\"", 10).unwrap().is_empty());
    assert!(b.search("OR NEAR *", 10).unwrap().is_empty());
}

#[test]
fn snippet_marks_the_hit_with_control_characters() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("dwa słowa tutaj")).unwrap();
    b.tick().unwrap();
    let hit = b.search("słowa", 5).unwrap().remove(0);
    assert!(
        hit.snippet
            .contains(&format!("{MARK_START}słowa{MARK_END}")),
        "{:?}",
        hit.snippet
    );
}

#[test]
fn deleted_notes_leave_the_index_and_the_index_is_rebuilt_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    let id = b.create_note("a.md").unwrap();
    b.apply_update(&id, &update("tekst do wyszukania")).unwrap();
    b.delete(&id).unwrap();
    assert!(b.search("wyszukania", 5).unwrap().is_empty());
    let kept = b.create_note("b.md").unwrap();
    b.apply_update(&kept, &update("zostaje")).unwrap();
    drop(b);

    // an index that is gone (an older space) is rebuilt on open
    let db = rusqlite::Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    db.execute_batch("DROP TABLE fts;").unwrap();
    drop(db);
    let mut b = Backend::open(dir.path(), &mut ks).unwrap();
    b.tick().unwrap();
    let hits = b.search("zostaje", 5).unwrap();
    assert_eq!(
        hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>(),
        vec![kept]
    );
}

/// Ignored: the performance check of the search over 10 000 notes (run with `--release`).
#[test]
#[ignore]
fn ten_thousand_notes_are_searched_in_under_100_ms() {
    let dir = tempfile::tempdir().unwrap();
    let mut ks = MemoryKeyStore::default();
    let (mut b, _) = Backend::create(dir.path(), &mut ks).unwrap();
    for i in 0..10_000 {
        let id = b.create_note(&format!("N {i}.md")).unwrap();
        b.opened
            .space
            .insert_text(&id, 0, &format!("notatka numer {i} żółw"))
            .unwrap();
    }
    while b.tick().unwrap() > 0 {}
    while b.opened.space.pending_count() > 0 || !b.search.dirty.is_empty() {
        b.tick().unwrap();
    }
    let start = std::time::Instant::now();
    assert_eq!(b.search("zolw numer 4242", 10).unwrap().len(), 1);
    assert!(start.elapsed().as_millis() < 100, "{:?}", start.elapsed());
}
