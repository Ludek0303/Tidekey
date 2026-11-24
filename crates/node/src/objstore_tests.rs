use super::*;

use std::fs;

use std::future::Future;

fn block<T>(future: impl Future<Output = T>) -> T {
    // one runtime for the whole run: pooled HTTP connections belong to the runtime that opened them
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()).block_on(future)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("notes-objstore-{name}-{}", now_millis()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn body_bytes(body: Body) -> Vec<u8> {
    block(axum::body::to_bytes(body, usize::MAX)).unwrap().to_vec()
}

/// Puts, reads, sizes, lists, sets aside and deletes one object in a store.
fn exercise(store: &dyn ObjectStore, scratch: &Path, data: &[u8]) {
    const VAULT: &str = "vault1";
    const ID: &str = "00112233445566778899aabbccddeeff";
    let src = scratch.join("src-part");
    fs::write(&src, data).unwrap();
    let key = format!("{VAULT}/{ID}");

    assert_eq!(block(store.size(&key)).unwrap_err().kind(), io::ErrorKind::NotFound);
    block(store.put(&key, &src)).unwrap();
    assert!(src.exists(), "put leaves the source in place");
    assert_eq!(block(store.size(&key)).unwrap(), data.len() as u64);
    assert_eq!(body_bytes(block(store.get(&key)).unwrap()), data);
    assert_eq!(block(store.list(VAULT)).unwrap(), vec![(key.clone(), data.len() as u64)]);
    assert!(block(store.vaults()).unwrap().contains(&VAULT.to_string()));

    block(store.delete(&key)).unwrap();
    block(store.delete(&key)).unwrap(); // a missing object is fine
    assert_eq!(block(store.size(&key)).unwrap_err().kind(), io::ErrorKind::NotFound);
    assert!(block(store.list(VAULT)).unwrap().is_empty());
}

#[test]
fn local_store_round_trip_and_orphans_are_set_aside() {
    let dir = scratch("local");
    let store = LocalStore::open(&dir.join("attachments")).unwrap();
    exercise(&store, &dir, &bytes(3 * 1024 * 1024 + 5));

    let key = "vault1/ffeeddccbbaa99887766554433221100";
    fs::create_dir_all(dir.join("attachments/vault1")).unwrap();
    fs::write(dir.join("attachments/vault1/ffeeddccbbaa99887766554433221100"), b"stray").unwrap();
    block(store.orphan(key)).unwrap();
    assert!(!dir.join("attachments/vault1/ffeeddccbbaa99887766554433221100").exists());
    assert_eq!(fs::read_dir(dir.join("attachments").join(ORPHAN_DIR)).unwrap().count(), 1);
    fs::remove_dir_all(&dir).unwrap();
}

fn bytes(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i.wrapping_mul(31) % 253) as u8).collect()
}

#[test]
fn token_is_hs256_with_a_short_expiry() {
    let t = token(b"secret");
    let parts: Vec<&str> = t.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#));
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    let exp = claims["exp"].as_u64().unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    assert!(exp > now && exp <= now + TOKEN_TTL_SECS, "exp {exp} now {now}");
    // the signature is HMAC-SHA256 over "header.claims" with the key
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(b"secret").unwrap();
    mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    assert_eq!(parts[2], URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
}

/// Runs against the SeaweedFS filer in `NOTES_TEST_SEAWEEDFS_FILER` (with the token key in
/// `NOTES_TEST_SEAWEEDFS_JWT_KEY` when the filer checks tokens). Skipped when the filer is not named.
#[test]
fn seaweed_store_round_trip() {
    let Ok(filer) = std::env::var("NOTES_TEST_SEAWEEDFS_FILER") else {
        eprintln!("skipped: NOTES_TEST_SEAWEEDFS_FILER is not set");
        return;
    };
    let key = std::env::var("NOTES_TEST_SEAWEEDFS_JWT_KEY").ok().map(String::into_bytes);
    let dir = scratch("seaweed");
    let store = SeaweedStore::new(&filer, key.clone()).unwrap();
    // a vault name of its own, so runs do not see each other's objects
    let vault = format!("vt{}", now_millis());
    let data = bytes(3 * 1024 * 1024 + 5);
    let src = dir.join("src-part");
    fs::write(&src, &data).unwrap();
    let object = format!("{vault}/00112233445566778899aabbccddeeff");
    block(store.put(&object, &src)).unwrap();
    assert_eq!(block(store.size(&object)).unwrap(), data.len() as u64);
    assert_eq!(body_bytes(block(store.get(&object)).unwrap()), data);
    assert_eq!(block(store.list(&vault)).unwrap(), vec![(object.clone(), data.len() as u64)]);
    assert!(block(store.vaults()).unwrap().contains(&vault));
    block(store.delete(&object)).unwrap();
    assert_eq!(block(store.size(&object)).unwrap_err().kind(), io::ErrorKind::NotFound);
    assert!(block(store.list(&vault)).unwrap().is_empty());
    fs::remove_dir_all(&dir).unwrap();

    // with a token key set on the filer, a request without a token must be refused, not served
    if key.is_some() {
        let unsigned = SeaweedStore::new(&filer, None).unwrap();
        assert!(block(unsigned.size(&object)).is_err());
    }
}
