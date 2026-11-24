use super::*;

use std::future::Future;
use std::net::SocketAddr;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::objstore::{LocalStore, ORPHAN_DIR, SeaweedStore};
use crate::vaults::VaultService;
use crate::websync::Envelope;

const PASSWORD: &str = "A long test password 1";
const SCOPE: &str = "5c0a1f0e2d3b4c5a6f7e8d9c0b1a2f3e";
const ID1: &str = "00112233445566778899aabbccddeeff";
const ID2: &str = "ffeeddccbbaa99887766554433221100";
const ID3: &str = "11112222333344445555666677778888";
const ID4: &str = "99999999999999999999999999999999";
const ID5: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID6: &str = "cccccccccccccccccccccccccccccccc";
const MIB_U: u64 = 1024 * 1024;

struct Fixture {
    dir: tempfile::TempDir,
    auth: Arc<AuthService>,
    vaults: Arc<VaultService>,
    files: Arc<FileService>,
    vault: String,
    owner: String,
    owner_token: String,
    editor: String,
    viewer: String,
    outsider: String,
}

fn key() -> Envelope {
    Envelope {
        schema: "notes-key-v1".into(),
        nonce: BASE64.encode([7u8; 12]),
        ciphertext: BASE64.encode([9u8; 48]),
        key_epoch: None,
    }
}

fn default_limits() -> Limits {
    Limits { file_max_plain: 100 * MIB_U, vault_quota: 1024 * MIB_U, trash_days: 30, stale_hours: 24, max_parallel: 4 }
}

/// A shared vault: `owner` (owner), `editor` and `viewer` joined by invite; `outsider` is in no vault.
fn fixture_with(limits: Limits, store: Option<Arc<dyn ObjectStore>>) -> Fixture {
    fixture_from(limits, |dir| {
        let store = store.unwrap_or_else(|| Arc::new(LocalStore::open(&dir.join("attachments")).unwrap()));
        Backends { current: crate::objstore::LOCAL, stores: vec![(crate::objstore::LOCAL, store)] }
    })
}

fn fixture_from(limits: Limits, backends: impl FnOnce(&Path) -> Backends) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let auth = Arc::new(AuthService::open(dir.path()).unwrap());
    let locks = Arc::new(VaultLocks::default());
    let vaults = Arc::new(VaultService::open(dir.path(), locks.clone()).unwrap());
    let sync = Arc::new(BrowserSync::open(dir.path(), vaults.clone(), locks).unwrap());
    let files = Arc::new(FileService::open_backends(dir.path(), sync, limits, backends(dir.path())).unwrap());
    let (owner, owner_token) = auth.register("owner@example.test", PASSWORD).unwrap();
    let editor = auth.register("editor@example.test", PASSWORD).unwrap().0.id;
    let viewer = auth.register("viewer@example.test", PASSWORD).unwrap().0.id;
    let outsider = auth.register("outsider@example.test", PASSWORD).unwrap().0.id;
    let vault = vaults.create(&owner.id, "Zespół", "organizacja", &key()).unwrap().info.id;
    for (user, role) in [(&editor, "editor"), (&viewer, "viewer")] {
        let invite = vaults.create_invite(&owner.id, &vault, role).unwrap();
        vaults.accept_invite(user, &invite.token, &key(), 1).unwrap();
    }
    Fixture { dir, auth, vaults, files, vault, owner: owner.id, owner_token, editor, viewer, outsider }
}

fn fixture() -> Fixture {
    fixture_with(default_limits(), None)
}

fn meta() -> Value {
    json!({ "schema": META_SCHEMA, "keyEpoch": 1, "nonce": "AAAAAAAAAAAAAAAA", "ciphertext": "AAAA" })
}

fn bytes(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// A ciphertext size of `k` full chunks: the head plus `k` secretstream chunks of `PLAIN_CHUNK` bytes each.
fn full(k: u64) -> u64 {
    HEAD + k * CIPHER_CHUNK
}

/// Runs one async call to the end.
fn block<T>(future: impl Future<Output = T>) -> T {
    // one runtime for the whole run: pooled HTTP connections belong to the runtime that opened them
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()).block_on(future)
}

fn complete_up(f: &Fixture, user: &str, id: &str) -> Result<FileRecord, FileError> {
    block(f.files.complete(user, &f.vault, id))
}

fn remove(f: &Fixture, user: &str, id: &str) -> Result<(), FileError> {
    block(f.files.delete(user, &f.vault, id))
}

fn purge_it(f: &Fixture, user: &str, id: &str) -> Result<(), FileError> {
    block(f.files.purge(user, &f.vault, id))
}

fn recon(f: &Fixture) -> Summary {
    block(f.files.reconcile()).unwrap()
}

fn recon_at(f: &Fixture, now: i64) -> Summary {
    block(f.files.reconcile_at(now)).unwrap()
}

/// The bytes of chunk `n` of a file of `size` bytes in `data`.
fn chunk_of(data: &[u8], n: u64) -> &[u8] {
    let size = data.len() as u64;
    &data[chunk_start(size, n) as usize..chunk_start(size, n + 1) as usize]
}

/// Creates, sends every chunk and completes, the way the browser does.
fn upload(f: &Fixture, user: &str, id: &str, data: &[u8]) -> FileRecord {
    let (_, created) = f.files.create(user, &f.vault, id, data.len() as u64, &meta(), None, None).unwrap();
    assert!(created);
    for n in 0..chunk_count(data.len() as u64) {
        assert_eq!(f.files.put_chunk(user, &f.vault, id, n, chunk_of(data, n)).unwrap(), n + 1);
    }
    complete_up(f, user, id).unwrap()
}

fn read_content(f: &Fixture, user: &str, id: &str) -> Vec<u8> {
    block(async {
        let content = f.files.open_content(user, &f.vault, id).await.unwrap();
        axum::body::to_bytes(content.body, usize::MAX).await.unwrap().to_vec()
    })
}

fn object(f: &Fixture, id: &str) -> PathBuf {
    f.dir.path().join("attachments").join(&f.vault).join(id)
}

fn part(f: &Fixture, id: &str) -> PathBuf {
    f.dir.path().join("attachments").join(PART_DIR).join(format!("{}.{id}", f.vault))
}

fn status(e: FileError) -> &'static str {
    match e {
        FileError::Invalid(_) => "400",
        FileError::Unauthorized => "401",
        FileError::Forbidden(_) => "403",
        FileError::NotFound(_) => "404",
        FileError::Conflict(_) | FileError::Behind(_) => "409",
        FileError::TooLarge(_) => "413",
        FileError::TooMany(_) => "429",
        FileError::Internal => "500",
    }
}

#[test]
fn sizes_follow_the_v2_container_rules() {
    // the head and one tag are the smallest container: an empty file
    assert!(!valid_size(HEAD + ABYTES - 1));
    assert!(valid_size(HEAD + ABYTES));
    assert_eq!(chunk_count(HEAD + ABYTES), 1);
    assert!(valid_size(full(1)));
    assert!(valid_size(full(2)));
    assert!(valid_size(full(2) + 100));
    // a last chunk must hold at least one byte of plaintext, and a full chunk cannot be followed by an empty one
    assert!(!valid_size(full(2) + 1));
    assert!(valid_size(HEAD + CIPHER_CHUNK + 18));
    assert!(!valid_size(HEAD + CIPHER_CHUNK + 17));
    assert_eq!(chunk_count(full(2) + 100), 3);
    assert_eq!((expected_len(full(2) + 100, 0), expected_len(full(2) + 100, 1), expected_len(full(2) + 100, 2)), (full(1), CIPHER_CHUNK, 100));
    // the largest plaintext of one chunk, and its ciphertext length
    assert_eq!(cipher_len(PLAIN_CHUNK), full(1));
    assert_eq!(cipher_len(0), HEAD + ABYTES);
}

#[test]
fn upload_of_two_full_chunks_and_a_bit_downloads_the_same_bytes() {
    let f = fixture();
    let data = bytes((full(2) + 100) as usize);
    let rec = upload(&f, &f.editor, ID1, &data);
    assert_eq!(rec.state, READY);
    assert_eq!((rec.size, rec.chunks, rec.received), (data.len() as u64, 3, 3));
    assert!(rec.completed_at.is_some());
    assert_eq!(read_content(&f, &f.viewer, ID1), data);
    // the store keeps exactly the bytes the client sent
    assert_eq!(fs::read(object(&f, ID1)).unwrap(), data);
    assert!(!part(&f, ID1).exists());
}

#[test]
fn empty_file_is_the_head_and_one_tag() {
    let f = fixture();
    let rec = upload(&f, &f.editor, ID1, &[0u8; 49]);
    assert_eq!((rec.chunks, rec.state.as_str()), (1, READY));
    assert_eq!(read_content(&f, &f.viewer, ID1), vec![0u8; 49]);
}

#[test]
fn creation_retry_is_idempotent_and_other_uses_of_the_id_conflict() {
    let f = fixture();
    let (_, created) = f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap();
    assert!(created);
    let (again, created) = f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap();
    assert!(!created);
    assert_eq!(again.id, ID1);
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID1, 101, &meta(), None, None).unwrap_err()), "409");
    assert_eq!(status(f.files.create(&f.owner, &f.vault, ID1, 100, &meta(), None, None).unwrap_err()), "409");
}

#[test]
fn impossible_sizes_are_rejected_at_creation() {
    let f = fixture();
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID1, 48, &meta(), None, None).unwrap_err()), "400");
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID1, full(2) + 1, &meta(), None, None).unwrap_err()), "400");
}

#[test]
fn chunk_retry_is_accepted_and_out_of_order_is_409() {
    let f = fixture();
    let data = bytes((full(2) + 100) as usize);
    f.files.create(&f.editor, &f.vault, ID1, data.len() as u64, &meta(), None, None).unwrap();
    match f.files.put_chunk(&f.editor, &f.vault, ID1, 1, chunk_of(&data, 1)).unwrap_err() {
        FileError::Behind(received) => assert_eq!(received, 0),
        other => panic!("expected Behind, got {other:?}"),
    }
    assert_eq!(f.files.put_chunk(&f.editor, &f.vault, ID1, 0, chunk_of(&data, 0)).unwrap(), 1);
    // a retry of chunk 0 changes nothing
    assert_eq!(f.files.put_chunk(&f.editor, &f.vault, ID1, 0, chunk_of(&data, 0)).unwrap(), 1);
    assert_eq!(fs::metadata(part(&f, ID1)).unwrap().len(), full(1));
    assert_eq!(f.files.put_chunk(&f.editor, &f.vault, ID1, 1, chunk_of(&data, 1)).unwrap(), 2);
    assert_eq!(f.files.put_chunk(&f.editor, &f.vault, ID1, 2, chunk_of(&data, 2)).unwrap(), 3);
    assert_eq!(complete_up(&f, &f.editor, ID1).unwrap().state, READY);
    // a retried complete returns the record
    assert_eq!(complete_up(&f, &f.editor, ID1).unwrap().state, READY);
    assert_eq!(read_content(&f, &f.owner, ID1), data);
}

#[test]
fn wrong_chunk_sizes_and_indexes_are_rejected() {
    let f = fixture();
    f.files.create(&f.editor, &f.vault, ID1, full(2), &meta(), None, None).unwrap();
    let short = vec![0u8; full(1) as usize - 1];
    assert_eq!(status(f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &short).unwrap_err()), "400");
    let full_second = vec![0u8; CIPHER_CHUNK as usize + 1];
    assert_eq!(status(f.files.put_chunk(&f.editor, &f.vault, ID1, 1, &full_second).unwrap_err()), "400");
    let extra = vec![0u8; CIPHER_CHUNK as usize];
    assert_eq!(status(f.files.put_chunk(&f.editor, &f.vault, ID1, 2, &extra).unwrap_err()), "400");
    assert_eq!(f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &vec![0u8; full(1) as usize]).unwrap(), 1);
    // the complete check: one chunk is still missing
    assert_eq!(status(complete_up(&f, &f.editor, ID1).unwrap_err()), "409");
}

#[test]
fn file_size_and_vault_quota_are_enforced_with_413() {
    // the largest file is two full chunks of plaintext; the vault holds three full chunks of ciphertext
    let f = fixture_with(
        Limits { file_max_plain: 2 * MIB_U, vault_quota: full(3), trash_days: 30, stale_hours: 24, max_parallel: 4 },
        None,
    );
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID1, full(2) + 100, &meta(), None, None).unwrap_err()), "413");
    f.files.create(&f.editor, &f.vault, ID1, full(2), &meta(), None, None).unwrap();
    // two full files are over the quota
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID2, full(2), &meta(), None, None).unwrap_err()), "413");
    // the quota counts the uploading file too; one chunk more still fits exactly
    f.files.create(&f.editor, &f.vault, ID2, CIPHER_CHUNK, &meta(), None, None).unwrap();
    assert_eq!(f.files.list(&f.editor, &f.vault).unwrap().used, full(3));
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID3, 49, &meta(), None, None).unwrap_err()), "413");
}

#[test]
fn uploads_in_progress_are_capped_per_person_and_retries_pass() {
    let f = fixture();
    for id in [ID1, ID2, ID3, ID4] {
        f.files.create(&f.editor, &f.vault, id, 100, &meta(), None, None).unwrap();
    }
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID5, 100, &meta(), None, None).unwrap_err()), "429");
    // the same creation again is a retry and is not counted
    let (_, created) = f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap();
    assert!(!created);
    // another person has an allowance of their own
    f.files.create(&f.owner, &f.vault, ID5, 100, &meta(), None, None).unwrap();
    // cancelling one frees a place; the same id may then start again with a new size
    remove(&f, &f.editor, ID1).unwrap();
    let (_, created) = f.files.create(&f.editor, &f.vault, ID6, 100, &meta(), None, None).unwrap();
    assert!(created);
    assert_eq!(status(f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap_err()), "429");
    remove(&f, &f.editor, ID2).unwrap();
    let (_, created) = f.files.create(&f.editor, &f.vault, ID1, 200, &meta(), None, None).unwrap();
    assert!(created);
}

#[test]
fn outsiders_get_404_and_bad_ids_never_reach_the_disk() {
    let f = fixture();
    let rec = upload(&f, &f.editor, ID1, &bytes(100));
    assert_eq!(status(f.files.get(&f.outsider, &f.vault, ID1).unwrap_err()), "404");
    assert_eq!(status(f.files.list(&f.outsider, &f.vault).unwrap_err()), "404");
    assert_eq!(status(block(f.files.open_content(&f.outsider, &f.vault, ID1)).err().unwrap()), "404");
    assert_eq!(status(f.files.create(&f.outsider, &f.vault, ID2, 100, &meta(), None, None).unwrap_err()), "404");
    assert_eq!(status(f.files.get(&f.editor, "../attachments", ID1).unwrap_err()), "404");
    assert_eq!(status(f.files.get(&f.editor, &f.vault, "../../etc/passwd").unwrap_err()), "404");
    assert_eq!(status(f.files.create(&f.editor, &f.vault, "../../x", 100, &meta(), None, None).unwrap_err()), "400");
    assert_eq!(rec.id, ID1);
}

#[test]
fn viewers_read_but_cannot_write() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    assert_eq!(status(f.files.create(&f.viewer, &f.vault, ID2, 100, &meta(), None, None).unwrap_err()), "403");
    assert_eq!(status(remove(&f, &f.viewer, ID1).unwrap_err()), "403");
    assert_eq!(f.files.list(&f.viewer, &f.vault).unwrap().files.len(), 1);
    assert_eq!(f.files.get(&f.viewer, &f.vault, ID1).unwrap().state, READY);
}

#[test]
fn uploads_in_progress_are_visible_only_to_their_creator() {
    let f = fixture();
    f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap();
    assert!(f.files.list(&f.owner, &f.vault).unwrap().files.is_empty());
    assert_eq!(status(f.files.get(&f.owner, &f.vault, ID1).unwrap_err()), "404");
    assert_eq!(f.files.list(&f.editor, &f.vault).unwrap().files.len(), 1);
    assert_eq!(status(f.files.put_chunk(&f.owner, &f.vault, ID1, 0, &[0u8; 100]).unwrap_err()), "404");
}

#[test]
fn scoped_files_are_visible_only_to_the_scope_list() {
    let f = fixture();
    // the owner outranks the editor, but is not on the list
    f.files.set_scope(&f.editor, &f.vault, SCOPE, std::slice::from_ref(&f.editor)).unwrap();
    assert_eq!(status(f.files.create(&f.owner, &f.vault, ID2, 49, &meta(), Some(SCOPE), None).unwrap_err()), "404");
    let (scoped, _) = f.files.create(&f.editor, &f.vault, ID1, 49, &meta(), Some(SCOPE), None).unwrap();
    assert_eq!(scoped.scope.as_deref(), Some(SCOPE));
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &[0u8; 49]).unwrap();
    complete_up(&f, &f.editor, ID1).unwrap();

    // hidden from the owner (outranks the editor) and from the viewer (a lower role still gets 404, not 403)
    for hidden in [&f.owner, &f.viewer] {
        assert!(f.files.list(hidden, &f.vault).unwrap().files.is_empty());
        assert_eq!(status(f.files.get(hidden, &f.vault, ID1).unwrap_err()), "404");
        assert_eq!(status(block(f.files.open_content(hidden, &f.vault, ID1)).err().unwrap()), "404");
        assert_eq!(status(f.files.set_meta(hidden, &f.vault, ID1, &meta()).unwrap_err()), "404");
        assert_eq!(status(purge_it(&f, hidden, ID1).unwrap_err()), "404");
    }
    // and the owner cannot change the list once it exists
    assert_eq!(status(f.files.set_scope(&f.owner, &f.vault, SCOPE, std::slice::from_ref(&f.owner)).unwrap_err()), "404");
    assert_eq!(f.files.list(&f.editor, &f.vault).unwrap().files.len(), 1);
    assert_eq!(block(f.files.open_content(&f.editor, &f.vault, ID1)).unwrap().size, 49);
}

#[test]
fn a_removed_member_does_not_regain_scoped_files_on_reinvite() {
    let f = fixture();
    f.files.set_scope(&f.editor, &f.vault, SCOPE, &[f.editor.clone(), f.viewer.clone()]).unwrap();
    f.files.create(&f.editor, &f.vault, ID1, 49, &meta(), Some(SCOPE), None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &[0u8; 49]).unwrap();
    complete_up(&f, &f.editor, ID1).unwrap();
    assert_eq!(f.files.get(&f.viewer, &f.vault, ID1).unwrap().state, READY);
    // the steps the vault route takes when it removes a member
    f.vaults.remove_member(&f.owner, &f.vault, &f.viewer).unwrap();
    f.files.revoke_member(&f.vault, &f.viewer).unwrap();
    let invite = f.vaults.create_invite(&f.owner, &f.vault, "viewer").unwrap();
    f.vaults.accept_invite(&f.viewer, &invite.token, &key(), 1).unwrap();
    assert_eq!(status(f.files.get(&f.viewer, &f.vault, ID1).unwrap_err()), "404");
    assert!(f.files.list(&f.viewer, &f.vault).unwrap().files.is_empty());
}

#[test]
fn scope_lists_must_hold_vault_members_and_the_caller() {
    let f = fixture();
    assert_eq!(status(f.files.set_scope(&f.editor, &f.vault, SCOPE, std::slice::from_ref(&f.viewer)).unwrap_err()), "400");
    assert_eq!(status(f.files.set_scope(&f.editor, &f.vault, SCOPE, &[f.editor.clone(), f.outsider.clone()]).unwrap_err()), "400");
    assert_eq!(status(f.files.set_scope(&f.editor, &f.vault, "../scope", std::slice::from_ref(&f.editor)).unwrap_err()), "400");
    f.files.set_scope(&f.editor, &f.vault, SCOPE, &[f.editor.clone(), f.viewer.clone()]).unwrap();
    // the viewer is on the list now, so it can read a scoped file it did not create
    f.files.create(&f.editor, &f.vault, ID1, 49, &meta(), Some(SCOPE), None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &[0u8; 49]).unwrap();
    complete_up(&f, &f.editor, ID1).unwrap();
    assert_eq!(f.files.get(&f.viewer, &f.vault, ID1).unwrap().state, READY);
}

#[test]
fn trash_restore_and_purge_follow_the_roles() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    remove(&f, &f.editor, ID1).unwrap();
    let trashed = f.files.get(&f.editor, &f.vault, ID1).unwrap();
    assert_eq!(trashed.state, TRASHED);
    assert!(trashed.deleted_at.is_some());
    assert_eq!(status(remove(&f, &f.editor, ID1).unwrap_err()), "409");
    assert_eq!(status(purge_it(&f, &f.editor, ID1).unwrap_err()), "403");
    assert_eq!(f.files.restore(&f.editor, &f.vault, ID1).unwrap().state, READY);
    assert_eq!(status(f.files.restore(&f.editor, &f.vault, ID1).unwrap_err()), "409");

    remove(&f, &f.editor, ID1).unwrap();
    purge_it(&f, &f.owner, ID1).unwrap();
    assert!(!object(&f, ID1).exists());
    assert_eq!(status(f.files.get(&f.owner, &f.vault, ID1).unwrap_err()), "404");
}

#[test]
fn cancelling_an_upload_removes_its_part() {
    let f = fixture();
    f.files.create(&f.editor, &f.vault, ID1, full(2), &meta(), None, None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &vec![1u8; full(1) as usize]).unwrap();
    assert!(part(&f, ID1).exists());
    remove(&f, &f.editor, ID1).unwrap();
    assert!(!part(&f, ID1).exists());
    assert_eq!(status(f.files.get(&f.editor, &f.vault, ID1).unwrap_err()), "404");
}

#[test]
fn metadata_envelope_is_checked_and_replaced() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    assert_eq!(status(f.files.set_meta(&f.editor, &f.vault, ID1, &json!({"schema": "x"})).unwrap_err()), "400");
    // the v1 envelope is no longer accepted
    let v1 = json!({ "schema": "notes-file-meta-v1", "keyEpoch": 1, "nonce": "A", "ciphertext": "A" });
    assert_eq!(status(f.files.set_meta(&f.editor, &f.vault, ID1, &v1).unwrap_err()), "400");
    let big = json!({ "schema": META_SCHEMA, "nonce": "A", "ciphertext": "A", "pad": "x".repeat(5000) });
    assert_eq!(status(f.files.set_meta(&f.editor, &f.vault, ID1, &big).unwrap_err()), "400");
    let renamed = json!({ "schema": META_SCHEMA, "keyEpoch": 2, "nonce": "BBBB", "ciphertext": "BBBB" });
    let rec = f.files.set_meta(&f.editor, &f.vault, ID1, &renamed).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&rec.meta).unwrap(), renamed);
    // the meta may also come as the envelope text
    let text = Value::String(renamed.to_string());
    assert_eq!(f.files.set_meta(&f.editor, &f.vault, ID1, &text).unwrap().meta, renamed.to_string());
}

#[test]
fn reconcile_marks_missing_objects_and_moves_orphans_aside() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    fs::remove_file(object(&f, ID1)).unwrap();
    let orphan_dir = f.dir.path().join("attachments").join(&f.vault);
    fs::write(orphan_dir.join(ID2), b"left behind").unwrap();

    let summary = recon(&f);
    assert_eq!((summary.missing, summary.orphans), (1, 1));
    assert_eq!(f.files.get(&f.owner, &f.vault, ID1).unwrap().state, MISSING);
    assert_eq!(status(block(f.files.open_content(&f.owner, &f.vault, ID1)).err().unwrap()), "404");
    assert!(!orphan_dir.join(ID2).exists());
    let kept: Vec<_> = fs::read_dir(f.dir.path().join("attachments").join(ORPHAN_DIR)).unwrap().collect();
    assert_eq!(kept.len(), 1);
    // a second pass changes nothing
    assert_eq!(recon(&f), Summary::default());
}

#[test]
fn an_object_behind_an_uploading_row_is_kept_and_the_upload_completes() {
    let f = fixture();
    let data = bytes(100);
    f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &data).unwrap();
    // a crash after the object was put and before the row became ready
    fs::create_dir_all(object(&f, ID1).parent().unwrap()).unwrap();
    fs::copy(part(&f, ID1), object(&f, ID1)).unwrap();
    assert_eq!(recon(&f), Summary::default());
    assert_eq!(complete_up(&f, &f.editor, ID1).unwrap().state, READY);
    assert_eq!(read_content(&f, &f.owner, ID1), data);
}

#[test]
fn reconcile_drops_stale_uploads_and_expired_trash() {
    let f = fixture();
    f.files.create(&f.editor, &f.vault, ID1, full(2), &meta(), None, None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &vec![1u8; full(1) as usize]).unwrap();
    upload(&f, &f.editor, ID2, &bytes(100));
    remove(&f, &f.editor, ID2).unwrap();

    // a day later the upload is stale; the trash is not yet expired
    let day = now_millis() + 25 * HOUR_MS;
    let summary = recon_at(&f, day);
    assert_eq!((summary.stale_uploads, summary.trash_purged), (1, 0));
    assert!(!part(&f, ID1).exists());
    assert_eq!(status(f.files.get(&f.editor, &f.vault, ID1).unwrap_err()), "404");

    let later = now_millis() + 31 * DAY_MS;
    let summary = recon_at(&f, later);
    assert_eq!(summary.trash_purged, 1);
    assert!(!object(&f, ID2).exists());
    assert_eq!(status(f.files.get(&f.owner, &f.vault, ID2).unwrap_err()), "404");
}

#[test]
fn reconcile_truncates_oversized_parts_and_removes_stray_ones() {
    let f = fixture();
    f.files.create(&f.editor, &f.vault, ID1, full(2), &meta(), None, None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &vec![1u8; full(1) as usize]).unwrap();
    // garbage after the recorded chunk, as after a crash between write and the database update
    OpenOptions::new().append(true).open(part(&f, ID1)).unwrap().write_all(&[9u8; 100]).unwrap();
    fs::write(part(&f, ID2), b"no row").unwrap();

    let summary = recon(&f);
    assert_eq!((summary.parts_truncated, summary.parts_removed), (1, 1));
    assert_eq!(fs::metadata(part(&f, ID1)).unwrap().len(), full(1));
    assert!(!part(&f, ID2).exists());
    // the upload can carry on from where the database says
    assert_eq!(f.files.put_chunk(&f.editor, &f.vault, ID1, 1, &vec![2u8; CIPHER_CHUNK as usize]).unwrap(), 2);
}

#[test]
fn chunk_route_takes_a_full_chunk_and_streams_it_back() {
    let f = fixture();
    let app = crate::http::app_with_api(None, None, routes(f.auth.clone(), f.files.clone()));
    let runtime_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    runtime_listener.set_nonblocking(true).unwrap();
    let addr = runtime_listener.local_addr().unwrap();
    let cookie = format!("notes_session={}", f.owner_token);
    let vault = f.vault.clone();

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let listener = tokio::net::TcpListener::from_std(runtime_listener).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });

        let body = json!({ "id": ID1, "size": 100, "meta": meta() }).to_string();
        let (head, _) = http(addr, "POST", &format!("/api/vaults/{vault}/files"), &cookie, "application/json", body.as_bytes()).await;
        assert!(head.starts_with("HTTP/1.1 201"), "{head}");

        let chunk = bytes(100);
        let (head, reply) = http(addr, "PUT", &format!("/api/vaults/{vault}/files/{ID1}/chunks/0"), &cookie, "application/octet-stream", &chunk).await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head} {}", String::from_utf8_lossy(&reply));
        let (head, reply) = http(addr, "POST", &format!("/api/vaults/{vault}/files/{ID1}/complete"), &cookie, "application/json", b"").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head} {}", String::from_utf8_lossy(&reply));

        let (head, reply) = http(addr, "GET", &format!("/api/vaults/{vault}/files/{ID1}/content"), &cookie, "", b"").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.to_ascii_lowercase().contains("content-length: 100"), "{head}");
        assert_eq!(reply, chunk);
    });
}

#[test]
fn content_response_carries_the_sandbox_headers() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    let content = block(f.files.open_content(&f.viewer, &f.vault, ID1)).unwrap();
    let response = content.into_response();
    let headers = response.headers();
    assert_eq!(headers[CONTENT_LENGTH], "100");
    assert_eq!(headers[CONTENT_TYPE], "application/octet-stream");
    assert_eq!(headers[CONTENT_DISPOSITION], "attachment");
    assert_eq!(headers[CACHE_CONTROL], "private, no-store");
    assert_eq!(headers[CONTENT_SECURITY_POLICY], "sandbox; default-src 'none'");
    let body = block(axum::body::to_bytes(response.into_body(), usize::MAX)).unwrap();
    assert_eq!(body.as_ref(), bytes(100).as_slice());
}

/// A store with the same backend as the server: SeaweedFS when `NOTES_TEST_SEAWEEDFS_FILER` is set, else `None`.
fn seaweed_store() -> Option<Arc<dyn ObjectStore>> {
    let filer = std::env::var("NOTES_TEST_SEAWEEDFS_FILER").ok()?;
    let key = std::env::var("NOTES_TEST_SEAWEEDFS_JWT_KEY").ok().map(String::into_bytes);
    Some(Arc::new(SeaweedStore::new(&filer, key).unwrap()))
}

#[test]
fn upload_through_seaweedfs_round_trips_and_reconciles() {
    let Some(store) = seaweed_store() else {
        eprintln!("skipped: NOTES_TEST_SEAWEEDFS_FILER is not set");
        return;
    };
    let f = fixture_with(default_limits(), Some(store.clone()));
    let data = bytes((full(2) + 100) as usize);
    let rec = upload(&f, &f.editor, ID1, &data);
    assert_eq!(rec.state, READY);
    assert_eq!(read_content(&f, &f.viewer, ID1), data);
    // the store, not the local disk, holds the object
    assert!(!object(&f, ID1).exists());
    let key = object_key(&f.vault, ID1);
    assert_eq!(block(store.size(&key)).unwrap(), data.len() as u64);
    // a reconciliation pass finds nothing wrong about this file (the filer may hold other vaults' folders too)
    let summary = recon(&f);
    assert_eq!((summary.missing, summary.parts_removed), (0, 0));
    assert_eq!(block(store.size(&key)).unwrap(), data.len() as u64);
    // a trashed file stays readable, and purging removes the object
    remove(&f, &f.editor, ID1).unwrap();
    assert_eq!(read_content(&f, &f.viewer, ID1), data);
    purge_it(&f, &f.owner, ID1).unwrap();
    assert_eq!(block(store.size(&key)).unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

/// One HTTP/1.1 request on a fresh connection: the head and the body of the reply.
async fn http(addr: SocketAddr, method: &str, path: &str, cookie: &str, content_type: &str, body: &[u8]) -> (String, Vec<u8>) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nOrigin: http://{addr}\r\nCookie: {cookie}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").map_or(out.len(), |i| i + 4);
    (String::from_utf8_lossy(&out[..split]).into_owned(), out[split..].to_vec())
}

/// Sends a thumbnail of `parent` as its own file.
fn upload_thumb(f: &Fixture, id: &str, parent: &str) {
    let data = bytes(full(1) as usize);
    f.files.create(&f.editor, &f.vault, id, data.len() as u64, &meta(), None, Some(parent)).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, id, 0, &data).unwrap();
    complete_up(f, &f.editor, id).unwrap();
}

#[test]
fn a_thumbnail_follows_its_image() {
    let f = fixture();
    let data = bytes(full(1) as usize);
    upload_thumb(&f, ID2, ID1);
    upload(&f, &f.editor, ID1, &data);
    let state = |id| f.files.get(&f.editor, &f.vault, id).unwrap().state;

    remove(&f, &f.editor, ID1).unwrap();
    assert_eq!((state(ID1), state(ID2)), (TRASHED.to_string(), TRASHED.to_string()));
    f.files.restore(&f.editor, &f.vault, ID1).unwrap();
    assert_eq!((state(ID1), state(ID2)), (READY.to_string(), READY.to_string()));

    remove(&f, &f.editor, ID1).unwrap();
    purge_it(&f, &f.owner, ID1).unwrap();
    assert!(f.files.list(&f.editor, &f.vault).unwrap().files.is_empty());
    assert!(!object(&f, ID2).exists());
}

#[test]
fn cancelling_an_upload_drops_its_thumbnail() {
    let f = fixture();
    upload_thumb(&f, ID2, ID1);
    f.files.create(&f.editor, &f.vault, ID1, full(1), &meta(), None, None).unwrap();
    remove(&f, &f.editor, ID1).unwrap();
    assert!(f.files.list(&f.editor, &f.vault).unwrap().files.is_empty());
    assert!(!object(&f, ID2).exists());
}

#[test]
fn a_thumbnail_whose_image_never_came_is_swept_after_the_stale_window() {
    let f = fixture();
    upload_thumb(&f, ID2, ID1);
    recon(&f);
    assert_eq!(f.files.list(&f.editor, &f.vault).unwrap().files.len(), 1);
    recon_at(&f, now_millis() + 25 * HOUR_MS);
    assert!(f.files.list(&f.editor, &f.vault).unwrap().files.is_empty());
    assert!(!object(&f, ID2).exists());
}

/// A store that wraps another: `put` waits for a permit from `gate` (when set), `get` flips a byte (when `corrupt`).
struct Wrapped {
    inner: Arc<dyn ObjectStore>,
    gate: Option<Arc<tokio::sync::Semaphore>>,
    corrupt: bool,
}

#[async_trait::async_trait]
impl ObjectStore for Wrapped {
    async fn put(&self, key: &str, src: &Path) -> std::io::Result<()> {
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        self.inner.put(key, src).await
    }
    async fn get(&self, key: &str) -> std::io::Result<Body> {
        let body = self.inner.get(key).await?;
        if !self.corrupt {
            return Ok(body);
        }
        let mut bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap().to_vec();
        bytes[0] ^= 1;
        Ok(Body::from(bytes))
    }
    async fn size(&self, key: &str) -> std::io::Result<u64> { self.inner.size(key).await }
    async fn delete(&self, key: &str) -> std::io::Result<()> { self.inner.delete(key).await }
    async fn list(&self, vault: &str) -> std::io::Result<Vec<(String, u64)>> { self.inner.list(vault).await }
    async fn vaults(&self) -> std::io::Result<Vec<String>> { self.inner.vaults().await }
    async fn orphan(&self, key: &str) -> std::io::Result<()> { self.inner.orphan(key).await }
}

/// The local store and a second "seaweedfs" one (another local folder, `<data>/second`) wrapped as `second`
/// says, chosen through `storage.json` like at startup.
fn two_stores(dir: &Path, gate: Option<Arc<tokio::sync::Semaphore>>, corrupt: bool) -> Backends {
    let local: Arc<dyn ObjectStore> = Arc::new(LocalStore::open(&dir.join("attachments")).unwrap());
    let inner: Arc<dyn ObjectStore> = Arc::new(LocalStore::open(&dir.join("second")).unwrap());
    let second: Arc<dyn ObjectStore> = Arc::new(Wrapped { inner, gate, corrupt });
    let mut backends = crate::objstore::backends(dir, local, Some(second)).unwrap();
    if !dir.join(crate::objstore::STORAGE_FILE).exists() {
        backends.current = crate::objstore::LOCAL; // as if the filer were configured after the files were made
    }
    backends
}

fn wait_for_migration(f: &Fixture) -> Progress {
    // generous: debug builds under a full parallel test run are slow
    for _ in 0..6000 {
        let progress = f.files.storage_status().unwrap().migration.unwrap();
        if progress.finished_at.is_some() {
            return progress;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("migration did not finish");
}

fn start(f: &Fixture, target: &str) -> Result<(), FileError> {
    let files = f.files.clone();
    let target = target.to_string();
    block(async move { files.start_migration(&target) })
}

fn in_second(f: &Fixture, id: &str) -> PathBuf {
    f.dir.path().join("second").join(&f.vault).join(id)
}

#[test]
fn migration_moves_every_object_and_back_with_uploads_during_it() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let g = gate.clone();
    let f = fixture_from(default_limits(), move |dir| two_stores(dir, Some(g), false));
    let first = bytes((full(1) + 100) as usize);
    upload(&f, &f.editor, ID1, &first);
    upload(&f, &f.editor, ID2, &bytes(50));
    remove(&f, &f.editor, ID2).unwrap(); // trashed files move too
    // an upload still in progress: its part stays on the local disk, there is no object yet
    f.files.create(&f.editor, &f.vault, ID3, 100, &meta(), None, None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID3, 0, &bytes(100)).unwrap();

    start(&f, "seaweedfs").unwrap();
    assert!(matches!(start(&f, "seaweedfs"), Err(FileError::Conflict(_))), "one at a time");
    // the copy is held at its first put: the old store keeps serving, and new uploads go there
    assert_eq!(read_content(&f, &f.viewer, ID1), first);
    let during = bytes(70);
    upload(&f, &f.editor, ID4, &during);
    assert!(object(&f, ID4).exists());
    complete_up(&f, &f.editor, ID3).unwrap(); // the upload that was a part completes into the old store too
    gate.add_permits(1000);

    let progress = wait_for_migration(&f);
    assert_eq!(progress.error, None);
    assert_eq!((progress.done, progress.total, progress.failed), (4, 4, 0));
    let status = f.files.storage_status().unwrap();
    assert_eq!((status.current, status.objects), ("seaweedfs", 4));
    assert_eq!(progress.bytes_done, status.bytes);
    for id in [ID1, ID2, ID3, ID4] {
        assert!(in_second(&f, id).exists(), "{id} is in the new store");
        assert!(!object(&f, id).exists(), "{id} left the old store");
    }
    assert!(!f.dir.path().join("attachments/.migrate").exists());
    assert_eq!(read_content(&f, &f.viewer, ID1), first);
    assert_eq!(read_content(&f, &f.viewer, ID4), during);
    // after the switch, uploads go to the new store
    upload(&f, &f.editor, ID5, &bytes(60));
    assert!(in_second(&f, ID5).exists() && !object(&f, ID5).exists());
    assert_eq!(recon(&f).missing, 0);

    // the choice survives a restart
    let saved: Value = serde_json::from_slice(&fs::read(f.dir.path().join("storage.json")).unwrap()).unwrap();
    assert_eq!(saved, json!({ "backend": "seaweedfs" }));
    assert_eq!(two_stores(f.dir.path(), None, false).current, "seaweedfs");

    // and back
    start(&f, "local").unwrap();
    assert_eq!(wait_for_migration(&f).error, None);
    assert_eq!(f.files.storage_status().unwrap().current, "local");
    for id in [ID1, ID2, ID3, ID4, ID5] {
        assert!(object(&f, id).exists() && !in_second(&f, id).exists(), "{id} is back");
    }
    assert_eq!(read_content(&f, &f.viewer, ID5), bytes(60));
    assert_eq!(two_stores(f.dir.path(), None, false).current, "local");
}

#[test]
fn a_copy_that_reads_back_wrong_stops_the_migration_and_keeps_everything() {
    let f = fixture_from(default_limits(), |dir| two_stores(dir, None, true));
    let data = bytes(90);
    upload(&f, &f.editor, ID1, &data);
    start(&f, "seaweedfs").unwrap();
    let progress = wait_for_migration(&f);
    assert!(progress.error.as_deref().unwrap().contains("SHA-256"), "{:?}", progress.error);
    assert_eq!(progress.failed, 1);
    assert_eq!(f.files.storage_status().unwrap().current, "local");
    assert!(!f.dir.path().join("storage.json").exists());
    assert!(object(&f, ID1).exists(), "nothing is deleted");
    assert_eq!(read_content(&f, &f.viewer, ID1), data);
    // a stopped migration can be started again
    assert!(start(&f, "seaweedfs").is_ok());
    wait_for_migration(&f);
}

#[test]
fn storage_json_naming_an_unconfigured_store_refuses_to_start() {
    let dir = tempfile::tempdir().unwrap();
    crate::objstore::save_backend(dir.path(), "seaweedfs").unwrap();
    let local: Arc<dyn ObjectStore> = Arc::new(LocalStore::open(&dir.path().join("attachments")).unwrap());
    assert!(crate::objstore::backends(dir.path(), local.clone(), None).is_err());
    crate::objstore::save_backend(dir.path(), "local").unwrap();
    assert_eq!(crate::objstore::backends(dir.path(), local, None).unwrap().current, "local");
}

#[test]
fn a_deleted_vaults_files_go_with_the_next_reconciliation() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    upload(&f, &f.editor, ID2, &bytes(100));
    remove(&f, &f.editor, ID2).unwrap();
    assert!(object(&f, ID1).exists());
    f.vaults.delete_vault(&f.owner, &f.vault, "Zespół").unwrap();
    f.files.drop_vault(&f.vault).unwrap();
    let summary = recon(&f);
    assert_eq!(summary.trash_purged, 2);
    assert!(!object(&f, ID1).exists() && !object(&f, ID2).exists());
    assert_eq!(status(f.files.get(&f.owner, &f.vault, ID1).unwrap_err()), "404");
}

#[test]
fn a_deletion_cut_short_is_finished_at_the_next_start_and_only_a_deletion() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    let snapshot = crate::websync::Envelope { schema: "notes-encrypted-v1".into(), nonce: "AQEBAQEBAQEBAQEB".into(), ciphertext: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=".into(), key_epoch: Some(1) };
    assert!(f.files.sync.put(&f.owner, &f.vault, 0, &snapshot).is_ok());
    // a vault whose row vanished WITHOUT a deletion (auth.db restored from an older backup): its data must stay
    let restored = f.vaults.create(&f.owner, "Inna", "organizacja", &key()).unwrap().info.id;
    assert!(f.files.sync.put(&f.owner, &restored, 0, &snapshot).is_ok());
    let data = bytes(100);
    f.files.create(&f.owner, &restored, ID2, data.len() as u64, &meta(), None, None).unwrap();
    f.files.put_chunk(&f.owner, &restored, ID2, 0, &data).unwrap();
    block(f.files.complete(&f.owner, &restored, ID2)).unwrap();
    let personal = format!("browser-{}", f.owner);
    assert!(f.files.sync.put(&f.owner, &personal, 0, &snapshot).is_ok());
    let auth_db = rusqlite::Connection::open(f.dir.path().join("auth.db")).unwrap();
    auth_db.execute("DELETE FROM vaults WHERE vault_id=?1", [&restored]).unwrap();
    // the node stopped right after the vault row went (delete_vault), before the snapshot and the files
    f.vaults.delete_vault(&f.owner, &f.vault, "Zespół").unwrap();
    // a listed id whose drop fails (not a shared vault id): the start goes on
    auth_db.execute("INSERT INTO deleted_vaults(vault_id,deleted_at) VALUES ('browser-x',0)", []).unwrap();

    // the next start
    let started = crate::run::open_services(f.dir.path()).unwrap();
    let left = |vault: &str| -> i64 {
        rusqlite::Connection::open(f.dir.path().join("browser-sync.db")).unwrap()
            .query_row("SELECT count(*) FROM browser_sync_vaults WHERE vault_id=?1", [vault], |r| r.get(0)).unwrap()
    };
    assert_eq!((left(&f.vault), left(&restored), left(&personal)), (0, 1, 1));
    let state = |vault: &str, id: &str| -> String {
        rusqlite::Connection::open(f.dir.path().join("files.db")).unwrap()
            .query_row("SELECT state FROM files WHERE vault_id=?1 AND file_id=?2", [vault, id], |r| r.get(0)).unwrap()
    };
    assert_eq!((state(&f.vault, ID1), state(&restored, ID2)), (TRASHED.to_string(), READY.to_string()));
    drop(started);
    recon(&f);
    assert!(!object(&f, ID1).exists());
    assert_eq!(state(&restored, ID2), READY, "the restored vault's file stays, its object too");
}

#[test]
fn deleting_an_organization_and_founding_one_over_http() {
    let f = fixture();
    let sync = f.files.sync.clone();
    let app = crate::http::app_with_api(None, None, crate::vaults::routes(f.auth.clone(), f.vaults.clone(), sync, f.files.clone()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let owner = format!("notes_session={}", f.owner_token);
    // an account from an invite link alone (personal "off") joins organizations but founds none
    let (guest, guest_token) = f.auth.register("guest@example.test", PASSWORD).unwrap();
    rusqlite::Connection::open(f.dir.path().join("auth.db")).unwrap()
        .execute("UPDATE web_users SET personal='off' WHERE user_id=?1", [&guest.id]).unwrap();
    let guest = format!("notes_session={guest_token}");
    let vault = f.vault.clone();
    let new_vault = json!({ "name": "Nowa", "kind": "organizacja", "wrappedKey": key() }).to_string();

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let status = |head: &str| head.split(' ').nth(1).unwrap_or_default().to_string();

        let (head, _) = http(addr, "POST", "/api/vaults", &guest, "application/json", new_vault.as_bytes()).await;
        assert_eq!(status(&head), "403", "{head}");
        let (head, _) = http(addr, "POST", "/api/vaults", &owner, "application/json", new_vault.as_bytes()).await;
        assert_eq!(status(&head), "201", "{head}");

        let path = format!("/api/vaults/{vault}");
        let (head, _) = http(addr, "DELETE", &path, &owner, "application/json", br#"{"name":"zespol"}"#).await;
        assert_eq!(status(&head), "400", "a wrong name: {head}");
        let (head, _) = http(addr, "DELETE", &path, &guest, "application/json", "{\"name\":\"Zespół\"}".as_bytes()).await;
        assert_eq!(status(&head), "404", "not a member: {head}");
        let (head, _) = http(addr, "DELETE", &path, &owner, "application/json", "{\"name\":\"Zespół\"}".as_bytes()).await;
        assert_eq!(status(&head), "204", "{head}");
        let (head, _) = http(addr, "GET", &path, &owner, "", b"").await;
        assert_eq!(status(&head), "404", "{head}");
    });
    // the handler finished the deletion: the vault is listed as deleted and its snapshot is gone
    let listed: i64 = rusqlite::Connection::open(f.dir.path().join("auth.db")).unwrap()
        .query_row("SELECT count(*) FROM deleted_vaults WHERE vault_id=?1", [&f.vault], |r| r.get(0)).unwrap();
    let snapshots: i64 = rusqlite::Connection::open(f.dir.path().join("browser-sync.db")).unwrap()
        .query_row("SELECT count(*) FROM browser_sync_vaults WHERE vault_id=?1", [&f.vault], |r| r.get(0)).unwrap();
    assert_eq!((listed, snapshots), (1, 0));
}

/// Creates a text layer of `parent` (docs/OCR.md §3.2) and sends its one chunk.
fn upload_text(f: &Fixture, user: &str, id: &str, parent: &str, scope: Option<&str>) -> Result<FileRecord, FileError> {
    let data = bytes(100);
    f.files.create_kind(user, &f.vault, id, data.len() as u64, &meta(), scope, Some(parent), Some(KIND_TEXT))?;
    f.files.put_chunk(user, &f.vault, id, 0, &data)?;
    complete_up(f, user, id)
}

#[test]
fn a_text_layer_is_a_hidden_child_that_follows_its_original() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    let text = upload_text(&f, &f.editor, ID2, ID1, None).unwrap();
    assert_eq!((text.kind.as_deref(), text.parent.as_deref()), (Some(KIND_TEXT), Some(ID1)));
    // old clients never see it on the list; new ones ask for it
    let ids = |with: bool| f.files.list_kinds(&f.viewer, &f.vault, with).unwrap().files.into_iter().map(|r| r.id).collect::<Vec<_>>();
    assert_eq!(ids(false), vec![ID1.to_string()]);
    assert_eq!(f.files.list(&f.viewer, &f.vault).unwrap().files.len(), 1);
    assert!(ids(true).contains(&ID2.to_string()));
    assert_eq!(block(f.files.open_content(&f.viewer, &f.vault, ID2)).unwrap().size, text.size);
    // a retry of the same creation is not a new file (the client's 200 = done)
    let (again, created) = f.files.create_kind(&f.editor, &f.vault, ID2, text.size, &meta(), None, Some(ID1), Some(KIND_TEXT)).unwrap();
    assert!(!created);
    assert_eq!(again.kind.as_deref(), Some(KIND_TEXT));
    // trash and restore of the original take the text along; a purge removes it
    remove(&f, &f.editor, ID1).unwrap();
    assert_eq!(f.files.get(&f.editor, &f.vault, ID2).unwrap().state, TRASHED);
    f.files.restore(&f.editor, &f.vault, ID1).unwrap();
    assert_eq!(f.files.get(&f.editor, &f.vault, ID2).unwrap().state, READY);
    remove(&f, &f.editor, ID1).unwrap();
    purge_it(&f, &f.owner, ID1).unwrap();
    assert_eq!(status(f.files.get(&f.owner, &f.vault, ID2).unwrap_err()), "404");
}

#[test]
fn a_text_layer_needs_a_ready_original_with_its_scope_and_an_editor() {
    let f = fixture();
    let make = |user: &str, id: &str, parent: Option<&str>, scope: Option<&str>, kind: Option<&str>| {
        f.files.create_kind(user, &f.vault, id, 100, &meta(), scope, parent, kind).map(|_| ())
    };
    // no parent, an unknown kind, a missing original
    assert_eq!(status(make(&f.editor, ID2, None, None, Some(KIND_TEXT)).unwrap_err()), "400");
    assert_eq!(status(make(&f.editor, ID2, Some(ID1), None, Some("notes")).unwrap_err()), "400");
    assert_eq!(status(make(&f.editor, ID2, Some(ID1), None, Some(KIND_TEXT)).unwrap_err()), "400");
    // an original still uploading
    f.files.create(&f.editor, &f.vault, ID1, 100, &meta(), None, None).unwrap();
    assert_eq!(status(make(&f.editor, ID2, Some(ID1), None, Some(KIND_TEXT)).unwrap_err()), "400");
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &bytes(100)).unwrap();
    complete_up(&f, &f.editor, ID1).unwrap();
    // a different scope than the original's, a viewer, a thumbnail's thumbnail
    f.files.set_scope(&f.editor, &f.vault, SCOPE, std::slice::from_ref(&f.editor)).unwrap();
    assert_eq!(status(make(&f.editor, ID2, Some(ID1), Some(SCOPE), Some(KIND_TEXT)).unwrap_err()), "400");
    assert_eq!(status(make(&f.viewer, ID2, Some(ID1), None, Some(KIND_TEXT)).unwrap_err()), "403");
    upload_text(&f, &f.editor, ID2, ID1, None).unwrap();
    assert_eq!(status(make(&f.editor, ID3, Some(ID2), None, Some(KIND_TEXT)).unwrap_err()), "400");
    // thumbnails are sent before their image: no parent check, as before the field
    make(&f.editor, ID4, Some(ID5), None, Some(KIND_THUMB)).unwrap();
}

#[test]
fn a_scoped_original_gives_its_text_layer_the_same_audience() {
    let f = fixture();
    f.files.set_scope(&f.editor, &f.vault, SCOPE, std::slice::from_ref(&f.editor)).unwrap();
    f.files.create(&f.editor, &f.vault, ID1, 49, &meta(), Some(SCOPE), None).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID1, 0, &[0u8; 49]).unwrap();
    complete_up(&f, &f.editor, ID1).unwrap();
    upload_text(&f, &f.editor, ID2, ID1, Some(SCOPE)).unwrap();
    for hidden in [&f.owner, &f.viewer] {
        assert!(f.files.list_kinds(hidden, &f.vault, true).unwrap().files.is_empty());
        assert_eq!(status(block(f.files.open_content(hidden, &f.vault, ID2)).err().unwrap()), "404");
    }
}

#[test]
fn a_text_layer_does_not_finish_after_its_original_went_to_the_trash() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    let data = bytes(100);
    f.files.create_kind(&f.editor, &f.vault, ID2, data.len() as u64, &meta(), None, Some(ID1), Some(KIND_TEXT)).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID2, 0, &data).unwrap();
    remove(&f, &f.editor, ID1).unwrap();
    assert_eq!(status(complete_up(&f, &f.editor, ID2).unwrap_err()), "409");
}

#[test]
fn a_text_layer_does_not_finish_when_its_original_is_trashed_while_it_is_stored() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    let data = bytes(100);
    f.files.create_kind(&f.editor, &f.vault, ID2, data.len() as u64, &meta(), None, Some(ID1), Some(KIND_TEXT)).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID2, 0, &data).unwrap();
    // the check passes, then the original goes to the trash before the row is marked ready
    let Ok(Completion::Store { checksum, .. }) = f.files.complete_check(&f.editor, &f.vault, ID2) else { panic!("check") };
    remove(&f, &f.editor, ID1).unwrap();
    assert_eq!(status(f.files.complete_finish(&f.editor, &f.vault, ID2, &checksum).unwrap_err()), "409");
}

#[test]
fn a_lone_text_layer_is_not_restored_while_its_original_is_in_the_trash() {
    let f = fixture();
    upload(&f, &f.editor, ID1, &bytes(100));
    let data = bytes(100);
    f.files.create_kind(&f.editor, &f.vault, ID2, data.len() as u64, &meta(), None, Some(ID1), Some(KIND_TEXT)).unwrap();
    f.files.put_chunk(&f.editor, &f.vault, ID2, 0, &data).unwrap();
    complete_up(&f, &f.editor, ID2).unwrap();
    remove(&f, &f.editor, ID1).unwrap();
    assert_eq!(status(f.files.restore(&f.editor, &f.vault, ID2).unwrap_err()), "409");
    // the original's restore brings the layer back with it
    f.files.restore(&f.editor, &f.vault, ID1).unwrap();
    assert_eq!(f.files.get(&f.editor, &f.vault, ID2).unwrap().state, READY);
}

#[test]
fn the_no_content_message_is_the_one_the_client_matches() {
    // ui/src/remotefiles.ts NO_CONTENT: a text layer whose object is gone counts as damaged there
    assert_eq!(super::NO_CONTENT, "Treść pliku nie istnieje na serwerze.");
}
