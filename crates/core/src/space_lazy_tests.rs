//! Prioritized loading and batch receive: what is applied on open, what waits for a read, and the
//! perf numbers (release: `cargo test --release -p notes-core -- --ignored perf_`).

use super::super::lazy::{CLOCK, now_ms};
use super::*;

/// Receives every message of `n` notes (two messages each) into a fresh space; returns the time of
/// the receiving alone and the space.
fn receive_notes(n: usize) -> (std::time::Duration, Space) {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = Space::create(a.path(), SPACE_ID, device_of(3), Box::new(AcceptAll)).unwrap();
    for i in 0..n {
        let id = sa.create_note(&format!("notatka {i}.md")).unwrap();
        sa.insert_text(&id, 0, "treść notatki ").unwrap();
    }
    let msgs = sa.messages().unwrap();
    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    let started = std::time::Instant::now();
    for m in &msgs {
        sb.receive(m).unwrap();
    }
    let took = started.elapsed();
    (took, sb)
}

/// Correctness only, no timing: every note of a space received from scratch shows up with its text.
#[test]
fn receiving_two_hundred_notes_from_scratch_gives_every_note() {
    let (_, mut sb) = receive_notes(200);
    assert_eq!(sb.notes().len(), 200);
    let texts: Vec<String> = sb
        .notes()
        .iter()
        .map(|(id, _)| sb.text(id).unwrap())
        .collect();
    assert!(texts.iter().all(|t| t == "treść notatki "), "{texts:?}");
}

/// Timing: debug builds check each Ed25519 signature about 40 times slower than release, and the time
/// depends on the machine, so this is run on purpose: `cargo test --release -p notes-core -- --ignored`.
/// Release: 1000 notes take about 0.3 s (before the fix: 145 s).
#[test]
#[ignore]
fn perf_receiving_a_thousand_notes_from_scratch() {
    let (took, sb) = receive_notes(1000);
    eprintln!("receive 1000 notes: {took:?}");
    assert_eq!(sb.notes().len(), 1000);
}

/// Perf: run with `cargo test --release -p notes-core -- --ignored perf_receiving_ten_thousand`.
/// Release: about 41 s for 10 000 notes.
#[test]
#[ignore]
fn perf_receiving_ten_thousand_notes_from_scratch() {
    let (took, _) = receive_notes(10_000);
    eprintln!("receive 10000 notes: {took:?}");
}

/// Runs `f` with the clock set to `ms` (see `lazy::CLOCK`).
fn at_time<T>(ms: u64, f: impl FnOnce() -> T) -> T {
    CLOCK.with(|c| c.set(Some(ms)));
    let out = f();
    CLOCK.with(|c| c.set(None));
    out
}

const DAY: u64 = 86_400_000;

/// The clock now, and a time `days` before it.
fn days_ago(days: u64) -> u64 {
    now_ms() - days * DAY
}

#[test]
fn open_loads_hot_notes_and_leaves_cold_ones_pending() {
    let dir = tempfile::tempdir().unwrap();
    let (hot, cold) = {
        let mut sp = create_test(dir.path()).unwrap();
        let mut cold = Vec::new();
        for i in 0..3 {
            let id = at_time(days_ago(200), || {
                let id = sp.create_note(&format!("stara {i}.md")).unwrap();
                sp.insert_text(&id, 0, "dawno temu").unwrap();
                id
            });
            cold.push(id);
        }
        let hot: Vec<NoteId> = (0..2)
            .map(|i| {
                let id = sp.create_note(&format!("nowa {i}.md")).unwrap();
                sp.insert_text(&id, 0, "przed chwilą").unwrap();
                id
            })
            .collect();
        (hot, cold)
    };
    let mut sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.loaded_count(), 2);
    assert_eq!(sp.pending_count(), 3);
    assert_eq!(sp.notes().len(), 5);
    // reading a cold note loads it, and only it
    assert_eq!(sp.text(&cold[0]).unwrap(), "dawno temu");
    assert_eq!(sp.loaded_count(), 3);
    assert_eq!(sp.text(&hot[0]).unwrap(), "przed chwilą");
    // the background drain loads the rest, newest first, then reports nothing left
    assert_eq!(sp.load_pending(1).unwrap(), 1);
    assert_eq!(sp.load_pending(100).unwrap(), 1);
    assert_eq!(sp.load_pending(100).unwrap(), 0);
    assert_eq!(sp.loaded_count(), 5);
}

#[test]
fn touching_a_cold_note_keeps_it_hot_at_the_next_open() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut sp = create_test(dir.path()).unwrap();
        let id = at_time(days_ago(200), || {
            let id = sp.create_note("stara.md").unwrap();
            sp.insert_text(&id, 0, "wraca").unwrap();
            id
        });
        sp.touch(&id, now_ms()).unwrap();
    }
    let sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.pending_count(), 0);
    assert_eq!(sp.loaded_count(), 1);
}

#[test]
fn a_cold_note_received_is_only_stored_until_it_is_read() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    let id = at_time(days_ago(300), || {
        let id = sa.create_note("archiwum.md").unwrap();
        sa.insert_text(&id, 0, "stare notatki").unwrap();
        id
    });
    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in sa.messages().unwrap() {
        sb.receive(&m).unwrap();
    }
    assert_eq!(sb.pending_count(), 1);
    assert!(
        !b.path().join("archiwum.md").exists(),
        "a pending note has no file yet"
    );
    assert_eq!(sb.text(&id).unwrap(), "stare notatki");
    assert_eq!(
        fs::read_to_string(b.path().join("archiwum.md")).unwrap(),
        "stare notatki"
    );
    assert_eq!(sb.pending_count(), 0);
}

/// Cold-heavy space received from scratch: one batch, then drained by `load_pending`, must give the same
/// texts as receiving the same messages one by one and loading them all at once (the eager path).
#[test]
fn batch_receive_with_pending_notes_gives_the_same_texts_as_eager_loading() {
    let a = tempfile::tempdir().unwrap();
    let mut sa = create_test(a.path()).unwrap();
    let mut ids = Vec::new();
    for i in 0..30 {
        let days = if i % 3 == 0 { 5 } else { 200 + i };
        let id = at_time(days_ago(days), || {
            let id = sa.create_note(&format!("n{i}.md")).unwrap();
            sa.insert_text(&id, 0, &format!("tekst {i}")).unwrap();
            id
        });
        ids.push(id);
    }
    let msgs = sa.messages().unwrap();
    let expected: Vec<String> = ids.iter().map(|id| sa.text(id).unwrap()).collect();

    let lazy_dir = tempfile::tempdir().unwrap();
    let mut lazy = Space::create(lazy_dir.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    let outcomes = lazy.receive_batch(&msgs).unwrap();
    assert!(outcomes.iter().all(|o| matches!(o, Ok(Received::Applied))));
    assert!(lazy.pending_count() > 0);
    while lazy.load_pending(7).unwrap() > 0 {}
    let lazy_texts: Vec<String> = ids.iter().map(|id| lazy.text(id).unwrap()).collect();

    let eager_dir = tempfile::tempdir().unwrap();
    let mut eager =
        Space::create(eager_dir.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in &msgs {
        eager.receive(m).unwrap();
    }
    let eager_texts: Vec<String> = ids.iter().map(|id| eager.text(id).unwrap()).collect();
    assert_eq!(lazy_texts, expected);
    assert_eq!(eager_texts, expected);
}

#[test]
fn a_database_without_the_index_is_replayed_in_full_and_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let mut sp = create_test(dir.path()).unwrap();
        let id = sp.create_note("n.md").unwrap();
        sp.insert_text(&id, 0, "indeks").unwrap();
        id
    };
    let conn = Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    conn.execute("DELETE FROM doc_index", []).unwrap();
    drop(conn);
    let mut sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.pending_count(), 0);
    assert_eq!(sp.text(&id).unwrap(), "indeks");
    let conn = Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    let indexed: i64 = conn
        .query_row("SELECT COUNT(*) FROM doc_index", [], |r| r.get(0))
        .unwrap();
    assert_eq!(indexed, 2);
}

/// Perf (release): `cargo test --release -p notes-core -- --ignored perf_open_and_first_sync_ten_thousand`.
/// 10 000 notes: one in ten edited recently (hot), the rest 200 days ago (cold).
#[test]
#[ignore]
fn perf_open_and_first_sync_ten_thousand() {
    let a = tempfile::tempdir().unwrap();
    let mut sa = create_test(a.path()).unwrap();
    for i in 0..10_000 {
        let days = if i % 10 == 0 { 1 } else { 200 };
        at_time(days_ago(days), || {
            let id = sa.create_note(&format!("notatka {i}.md")).unwrap();
            sa.insert_text(&id, 0, "treść notatki, trochę tekstu")
                .unwrap();
        });
    }
    let msgs = sa.messages().unwrap();
    drop(sa);
    let started = std::time::Instant::now();
    let mut opened = open_test(a.path()).unwrap();
    eprintln!(
        "open 10000 notes (1000 hot): {:?}; loaded {}, pending {}, listed {}",
        started.elapsed(),
        opened.loaded_count(),
        opened.pending_count(),
        opened.notes().len()
    );
    let started = std::time::Instant::now();
    while opened.load_pending(500).unwrap() > 0 {}
    eprintln!(
        "drain pending notes: {:?}; loaded {}",
        started.elapsed(),
        opened.loaded_count()
    );
    let b = tempfile::tempdir().unwrap();
    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    let started = std::time::Instant::now();
    for chunk in msgs.chunks(1000) {
        sb.receive_batch(chunk).unwrap();
    }
    eprintln!(
        "first sync (20000 messages in batches of 1000): {:?}; loaded {}, pending {}",
        started.elapsed(),
        sb.loaded_count(),
        sb.pending_count()
    );
}

/// Two updates of one device for one note: the first writes "s" at (client 7, clock 0); the second puts
/// a nested type under that same id. Both decode, but the document refuses the second.
fn updates_that_decode_but_the_second_cannot_apply() -> (Vec<u8>, Vec<u8>) {
    use yrs::{Array, ArrayPrelim, Doc, Text, Transact};
    let string = Doc::with_client_id(7);
    let text = string.get_or_insert_text("content");
    let mut t = string.transact_mut();
    text.insert(&mut t, 0, "s");
    let first = t.encode_update_v1();
    drop(t);
    let nested = Doc::with_client_id(7);
    let root = nested.get_or_insert_array("other");
    let mut t = nested.transact_mut();
    let inner = root.insert(&mut t, 0, ArrayPrelim::default());
    inner.push_back(&mut t, "x");
    (first, t.encode_update_v1())
}

/// One update that decodes but cannot be applied (see above) must not fail its note, the drain or the open:
/// it is listed as rejected, its row stays, and the rest of the note loads.
#[test]
fn an_update_the_document_refuses_is_rejected_and_the_rest_of_the_note_loads() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    let (id, id2) = at_time(days_ago(300), || {
        (
            sa.create_note("stara.md").unwrap(),
            sa.create_note("stara druga.md").unwrap(),
        )
    });
    let (first, second) = updates_that_decode_but_the_second_cannot_apply();
    let key = crate::message::SpaceKey {
        id: SPACE_ID,
        epoch: 0,
        key: KEY,
    };
    let mut msgs = sa.messages().unwrap();
    for (doc, seqs) in [(&id, [100, 101]), (&id2, [200, 201])] {
        msgs.push(crate::message::seal(&device(), &key, seqs[0], [1; 24], doc, &first, 0).unwrap());
        msgs.push(
            crate::message::seal(&device(), &key, seqs[1], [2; 24], doc, &second, 0).unwrap(),
        );
    }
    let mut sb = Space::create(b.path(), SPACE_ID, device_of(4), Box::new(AcceptAll)).unwrap();
    for m in &msgs {
        sb.receive(m).unwrap();
    }
    assert_eq!(sb.pending_count(), 2);
    assert_eq!(sb.text(&id).unwrap(), "s");
    let refused = |sp: &Space, seq: u64| {
        sp.rejected()
            .iter()
            .any(|(_, s, reason)| *s == seq && reason.contains("cannot apply"))
    };
    assert!(refused(&sb, 101));
    // the drain does not stop at a note with a refused update, and the row is still stored
    assert_eq!(sb.load_pending(100).unwrap(), 1);
    assert_eq!(sb.pending_count(), 0);
    assert_eq!(sb.text(&id2).unwrap(), "s");
    assert!(refused(&sb, 201));
    assert_eq!(sb.messages().unwrap().len(), msgs.len());
    // a touched note is hot at the next open: replay applies it, refuses the same update, and opens
    sb.touch(&id, now_ms()).unwrap();
    drop(sb);
    let mut sb = Space::open(b.path(), device_of(4), Box::new(AcceptAll)).unwrap();
    assert_eq!(sb.text(&id).unwrap(), "s");
    assert!(refused(&sb, 101));
}

/// `write_file` loads a cold note first, so the file it writes has the note's text.
#[test]
fn write_file_loads_a_cold_note_first() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    let id = at_time(days_ago(300), || {
        let id = sa.create_note("archiwum.md").unwrap();
        sa.insert_text(&id, 0, "stare notatki").unwrap();
        id
    });
    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in sa.messages().unwrap() {
        sb.receive(&m).unwrap();
    }
    sb.write_file(&id).unwrap();
    assert_eq!(
        fs::read_to_string(b.path().join("archiwum.md")).unwrap(),
        "stare notatki"
    );
}

/// A note known only from meta (no content message) is drained too: it gets its empty file.
#[test]
fn a_cold_note_known_only_from_meta_gets_its_file_when_drained() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    at_time(days_ago(300), || sa.create_note("pusta.md").unwrap());
    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in sa.messages().unwrap() {
        sb.receive(&m).unwrap();
    }
    assert!(!b.path().join("pusta.md").exists());
    assert_eq!(sb.load_pending(10).unwrap(), 1);
    assert_eq!(fs::read_to_string(b.path().join("pusta.md")).unwrap(), "");
    assert_eq!(sb.pending_count(), 0);
}

/// A cold note whose load fails keeps its tracked file: the failed load never writes an empty note over it,
/// and the drain leaves it alone until the next open.
#[test]
fn a_failed_load_never_overwrites_a_tracked_file_with_empty_text() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    let id = at_time(days_ago(300), || {
        let id = sa.create_note("archiwum.md").unwrap();
        sa.insert_text(&id, 0, "stare notatki").unwrap();
        id
    });
    let mut sb = Space::create(b.path(), SPACE_ID, device_of(4), Box::new(AcceptAll)).unwrap();
    for m in sa.messages().unwrap() {
        sb.receive(&m).unwrap();
    }
    // the first load writes the file; the note is cold again at the next open
    assert_eq!(sb.text(&id).unwrap(), "stare notatki");
    drop(sb);
    let mut sb = Space::open(b.path(), device_of(4), Box::new(AcceptAll)).unwrap();
    assert_eq!(sb.pending_count(), 1);
    // break the note's stored messages after open, so that loading it fails
    let db = rusqlite::Connection::open(b.path().join(".notes-sync").join("space.db")).unwrap();
    db.execute(
        "UPDATE messages SET bytes = 1 WHERE (device, seq) IN (SELECT device, seq FROM doc_index WHERE doc = ?1)",
        [&id],
    )
    .unwrap();
    drop(db);
    assert_eq!(sb.load_pending(10).unwrap(), 0);
    assert_eq!(sb.pending_count(), 0);
    assert!(sb.text(&id).is_err());
    assert_eq!(sb.load_pending(10).unwrap(), 0);
    assert_eq!(
        fs::read_to_string(b.path().join("archiwum.md")).unwrap(),
        "stare notatki"
    );
}
