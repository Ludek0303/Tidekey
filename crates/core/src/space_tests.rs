use super::*;
use crate::access::{Header, Key};
use zeroize::Zeroizing;

#[path = "space_files_tests.rs"]
mod files;

const SPACE_ID: [u8; 16] = [7; 16];
const KEY: [u8; 32] = [9; 32];

/// Accepts every message and holds one epoch-0 key; for tests that do not model participants.
struct AcceptAll;

impl Access for AcceptAll {
    fn current(&self) -> Option<(u32, Key)> {
        Some((0, Zeroizing::new(KEY)))
    }
    fn key(&self, epoch: u32) -> Option<Key> {
        (epoch == 0).then(|| Zeroizing::new(KEY))
    }
    fn accept(&self, _: &Header, _: &[u8; 32]) -> std::result::Result<(), String> {
        Ok(())
    }
}

fn device() -> SigningKey {
    SigningKey::from_bytes(&[1; 32])
}

pub(super) fn create_test(root: &Path) -> Result<Space> {
    Space::create(root, SPACE_ID, device(), Box::new(AcceptAll))
}

pub(super) fn open_test(root: &Path) -> Result<Space> {
    Space::open(root, device(), Box::new(AcceptAll))
}

pub(super) fn seeded(root: &Path) -> NoteId {
    let mut sp = create_test(root).unwrap();
    let id = sp.create_note("a/Plan.md").unwrap();
    sp.insert_text(&id, 0, "hello").unwrap();
    sp.write_file(&id).unwrap();
    id
}

#[test]
fn create_writes_file() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    assert_eq!(
        fs::read_to_string(dir.path().join("a/Plan.md")).unwrap(),
        "hello"
    );
    assert_eq!(id.len(), 32);
}

#[test]
fn reopen_replays_state() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let mut sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.text(&id).unwrap(), "hello");
    assert_eq!(sp.notes(), vec![(id, "a/Plan.md".to_string())]);
}

#[test]
fn tampered_signature_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let conn = Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    let mut bytes: Vec<u8> = conn
        .query_row(
            "SELECT bytes FROM messages ORDER BY device, seq LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    *bytes.last_mut().unwrap() ^= 0xff;
    conn.execute(
        "UPDATE messages SET bytes = ?1 WHERE rowid = (SELECT MIN(rowid) FROM messages)",
        params![bytes],
    )
    .unwrap();
    drop(conn);
    assert!(matches!(
        open_test(dir.path()),
        Err(Error::BadSignature { .. })
    ));
}

#[test]
fn log_holds_no_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let id = seeded(dir.path());
    let conn = Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    let mut stmt = conn.prepare("SELECT bytes FROM messages").unwrap();
    let rows: Vec<Vec<u8>> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        for needle in [&b"hello"[..], b"Plan.md", id.as_bytes()] {
            assert!(!row.windows(needle.len()).any(|w| w == needle));
        }
    }
}

#[test]
fn swapped_rows_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    seeded(dir.path());
    let conn = Connection::open(dir.path().join(".notes-sync/space.db")).unwrap();
    conn.execute("UPDATE messages SET seq = seq + 100", [])
        .unwrap();
    drop(conn);
    assert!(matches!(
        open_test(dir.path()),
        Err(Error::BadMessage {
            reason: "row does not match header",
            ..
        })
    ));
}

#[test]
fn invalid_and_taken_paths_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    for bad in [
        "../x.md",
        "/abs.md",
        "x.txt",
        "",
        ".notes-sync/x.md",
        ".NOTES-SYNC/x.md",
        "a\\b.md",
        "C:x.md",
        "a//b.md",
        "./x.md",
        "a/../x.md",
    ] {
        assert!(
            matches!(sp.create_note(bad), Err(Error::InvalidPath(_))),
            "{bad} accepted"
        );
    }
    sp.create_note("dup.md").unwrap();
    assert!(matches!(sp.create_note("dup.md"), Err(Error::PathTaken(_))));
}

#[test]
fn state_and_remote_update_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let id = sp.create_note("n.md").unwrap();
    sp.insert_text(&id, 0, "hello").unwrap();

    let state = sp.state(&id).unwrap();
    let fresh = Doc::new();
    apply(&fresh, &state).unwrap();
    assert_eq!(
        fresh
            .get_or_insert_text(CONTENT)
            .get_string(&fresh.transact()),
        "hello"
    );

    let client = Doc::new();
    apply(&client, &state).unwrap();
    let update = {
        let text = client.get_or_insert_text(CONTENT);
        let mut txn = client.transact_mut();
        text.insert(&mut txn, 5, " world");
        txn.encode_update_v1()
    };
    sp.apply_local_update(&id, &update).unwrap();
    assert_eq!(sp.text(&id).unwrap(), "hello world");
    drop(sp);

    let mut sp = open_test(dir.path()).unwrap();
    assert_eq!(sp.text(&id).unwrap(), "hello world");
}

#[test]
fn polish_and_emoji_offsets() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let id = sp.create_note("p.md").unwrap();
    sp.insert_text(&id, 0, "zażółć 😀").unwrap();
    sp.insert_text(&id, 3, "X").unwrap();
    // 'z','a','ż','X','ó','ł','ć',' ' = 8 units, emoji = 2 units
    sp.insert_text(&id, 10, "!").unwrap();
    assert_eq!(sp.text(&id).unwrap(), "zażXółć 😀!");
    assert!(sp.insert_text(&id, 12, "?").is_err());
}

/// Accepts nothing: every local append and every received message is denied.
struct DenyAll;

impl Access for DenyAll {
    fn current(&self) -> Option<(u32, Key)> {
        Some((0, Zeroizing::new(KEY)))
    }
    fn key(&self, epoch: u32) -> Option<Key> {
        (epoch == 0).then(|| Zeroizing::new(KEY))
    }
    fn accept(&self, _: &Header, _: &[u8; 32]) -> std::result::Result<(), String> {
        Err("denied".to_string())
    }
}

#[test]
fn receive_applies_once_and_denied_messages_are_not_stored() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    let id = sa.create_note("n.md").unwrap();
    sa.insert_text(&id, 0, "hi").unwrap();
    let msgs = sa.messages().unwrap();

    let mut denied = Space::create(b.path(), SPACE_ID, device(), Box::new(DenyAll)).unwrap();
    assert!(matches!(
        denied.receive(&msgs[0]),
        Err(Error::Denied { .. })
    ));
    assert!(denied.messages().unwrap().is_empty());
    drop(denied);

    let mut sb = Space::open(b.path(), device(), Box::new(AcceptAll)).unwrap();
    for m in &msgs {
        assert_eq!(sb.receive(m).unwrap(), Received::Applied);
    }
    assert_eq!(sb.receive(&msgs[0]).unwrap(), Received::Known);
    assert_eq!(sb.text(&id).unwrap(), "hi");
    drop(sb);

    // a later open with stricter rules skips the messages instead of failing
    let sb = Space::open(b.path(), device(), Box::new(DenyAll)).unwrap();
    assert_eq!(sb.rejected().len(), msgs.len());
    assert!(sb.notes().is_empty());
}

#[test]
fn received_update_keeps_a_file_the_user_edited() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    let id = sa.create_note("n.md").unwrap();
    sa.insert_text(&id, 0, "one").unwrap();
    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in sa.messages().unwrap() {
        sb.receive(&m).unwrap();
    }
    assert_eq!(fs::read_to_string(b.path().join("n.md")).unwrap(), "one");

    fs::write(b.path().join("n.md"), "edited outside").unwrap();
    sa.insert_text(&id, 3, " two").unwrap();
    let newest = sa.messages().unwrap().pop().unwrap();
    sb.receive(&newest).unwrap();
    assert_eq!(sb.text(&id).unwrap(), "one two");
    assert_eq!(
        fs::read_to_string(b.path().join("n.md")).unwrap(),
        "edited outside"
    );
}

/// Accepts everything except messages from one device: the rules of a reader that is this device.
struct DenyDevice([u8; 32]);

impl Access for DenyDevice {
    fn current(&self) -> Option<(u32, Key)> {
        Some((0, Zeroizing::new(KEY)))
    }
    fn key(&self, epoch: u32) -> Option<Key> {
        (epoch == 0).then(|| Zeroizing::new(KEY))
    }
    fn accept(&self, h: &Header, _: &[u8; 32]) -> std::result::Result<(), String> {
        if h.device == self.0 {
            Err("reader".to_string())
        } else {
            Ok(())
        }
    }
}

fn device_of(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

#[test]
fn denied_local_edit_leaves_the_text_unchanged() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut owner = Space::create(a.path(), SPACE_ID, device_of(2), Box::new(AcceptAll)).unwrap();
    let id = owner.create_note("n.md").unwrap();
    owner.insert_text(&id, 0, "hi").unwrap();

    let mut reader = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in owner.messages().unwrap() {
        reader.receive(&m).unwrap();
    }
    reader.set_access(Box::new(DenyDevice(device().verifying_key().to_bytes())));
    assert!(matches!(
        reader.insert_text(&id, 0, "DENIED "),
        Err(Error::Denied { .. })
    ));
    assert_eq!(reader.text(&id).unwrap(), "hi");
    assert!(matches!(
        reader.create_note("x.md"),
        Err(Error::Denied { .. })
    ));
    assert_eq!(reader.notes().len(), 1);
}

#[test]
fn own_messages_received_back_do_not_block_the_next_edit() {
    // the same device key again (a join on the same computer): its old seqs arrive from the folder it left
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut first = create_test(a.path()).unwrap();
    let id = first.create_note("n.md").unwrap();
    first.insert_text(&id, 0, "stare").unwrap();
    first.insert_text(&id, 5, " tekst").unwrap();

    let mut again = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in first.messages().unwrap() {
        again.receive(&m).unwrap();
    }
    again.create_note("nowa.md").unwrap();
    again.insert_text(&id, 0, "> ").unwrap();
    let mine: Vec<Vec<u8>> = again.messages().unwrap();
    let seqs: Vec<u64> = mine.iter().map(|m| seq_of(m)).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
}

#[test]
fn invalid_and_conflicting_paths_are_refused_for_windows_too() {
    for bad in [
        "CON.md",
        "con.notes.md",
        "aux/x.md",
        "LPT9.md",
        "COM1/x.md",
        "a<b.md",
        "a>b.md",
        "a|b.md",
        "a?b.md",
        "a*b.md",
        "a\"b.md",
        "tab\tname.md",
        "dot./x.md",
        "trailing .md ",
        "x. /y.md",
        "x/y.md.",
        "bad\u{7f}.md",
    ] {
        assert!(!space_meta::is_valid_path(bad), "{bad:?} should be refused");
    }
    for good in [
        "Notatka.md",
        "con-ferencja.md",
        "a/b c/d.md",
        "COMX.md",
        "ż ź/ą.md",
    ] {
        assert!(
            space_meta::is_valid_path(good),
            "{good:?} should be accepted"
        );
    }

    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    sp.create_note("x.md").unwrap();
    assert!(matches!(
        sp.create_note("x.md/y.md"),
        Err(Error::PathTaken(_))
    ));
    let folder = sp.create_note("dir/y.md").unwrap();
    assert!(matches!(sp.create_note("dir"), Err(Error::InvalidPath(_))));
    assert!(matches!(
        sp.rename_note(&folder, "x.md/z.md"),
        Err(Error::PathTaken(_))
    ));
}

#[test]
fn remote_path_that_cannot_be_written_is_stored_and_not_an_error() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut sa = create_test(a.path()).unwrap();
    sa.create_note("x.md").unwrap();
    // an older client (or a crafted message) puts a note under "x.md/" into the meta: bypass the local check
    let id2 = "f".repeat(32);
    let update = {
        let paths = sa.meta.get_or_insert_map(PATHS);
        let mut txn = sa.meta.transact_mut();
        paths.insert(&mut txn, id2.as_str(), "x.md/y.md".to_string());
        txn.encode_update_v1()
    };
    sa.append(META_DOC, &update).unwrap();

    let mut sb = Space::create(b.path(), SPACE_ID, device(), Box::new(AcceptAll)).unwrap();
    for m in sa.messages().unwrap() {
        assert_eq!(sb.receive(&m).unwrap(), Received::Applied);
    }
    assert_eq!(sb.notes().len(), 2);
    // later messages keep arriving
    let id = sa.notes()[0].0.clone();
    sa.insert_text(&id, 0, "dalej").unwrap();
    let newest = sa.messages().unwrap().pop().unwrap();
    assert_eq!(sb.receive(&newest).unwrap(), Received::Applied);
    assert_eq!(sb.text(&id).unwrap(), "dalej");
}

fn seq_of(msg: &[u8]) -> u64 {
    u64::from_le_bytes(msg[49..57].try_into().unwrap())
}

#[test]
fn signed_message_with_a_malformed_update_is_refused_and_not_stored() {
    let dir = tempfile::tempdir().unwrap();
    let mut sp = create_test(dir.path()).unwrap();
    let id = sp.create_note("n.md").unwrap();
    sp.insert_text(&id, 0, "ok").unwrap();
    let before = sp.messages().unwrap().len();
    // valid signature and encryption, but the payload is not a Yrs update
    let junk = crate::message::seal(
        &device(),
        &crate::message::SpaceKey {
            id: SPACE_ID,
            epoch: 0,
            key: KEY,
        },
        9,
        [1; 24],
        "n.md",
        b"\xff\xff not an update",
        0,
    )
    .unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let mut other = Space::create(
        other_dir.path(),
        SPACE_ID,
        device_of(4),
        Box::new(AcceptAll),
    )
    .unwrap();
    assert!(matches!(
        other.receive(&junk),
        Err(Error::BadMessage { .. })
    ));
    assert!(other.messages().unwrap().is_empty());
    assert_eq!(sp.messages().unwrap().len(), before);
    assert_eq!(sp.text(&id).unwrap(), "ok");
}

#[path = "space_lazy_tests.rs"]
mod lazy_tests;
